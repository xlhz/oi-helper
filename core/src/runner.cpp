#include "oi/runner.h"

#include <algorithm>
#include <atomic>
#include <cctype>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include "oi/compiler.h"

#ifdef _WIN32
#include <windows.h>
#include <psapi.h>
#endif

namespace fs = std::filesystem;

namespace oi {

#ifdef _WIN32

namespace {

std::wstring toWide(const std::string& s) {
    if (s.empty()) return std::wstring();
    int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()), nullptr, 0);
    std::wstring w(static_cast<size_t>(n), 0);
    MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()), &w[0], n);
    return w;
}

long long filetimeToMs(const FILETIME& ft) {
    ULARGE_INTEGER u;
    u.LowPart = ft.dwLowDateTime;
    u.HighPart = ft.dwHighDateTime;
    return static_cast<long long>(u.QuadPart / 10000ULL);
}

// Windows Job Object 受限模式运行器
class WindowsJobObjectRunner : public Runner {
public:
    std::string name() const override { return "mingw"; }
    std::string isolation() const override { return "jobobject"; }
    RunResult run(const RunInput& input) override;
};

RunResult WindowsJobObjectRunner::run(const RunInput& input) {
    RunResult res;
    HANDLE job = CreateJobObjectW(nullptr, nullptr);
    if (!job) {
        res.error = "CreateJobObject 失败";
        return res;
    }
    long long memLimitKb = static_cast<long long>(input.limits.memoryLimitMb) * 1024;
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION jeli;
    ZeroMemory(&jeli, sizeof(jeli));
    jeli.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE |
                                            JOB_OBJECT_LIMIT_PROCESS_MEMORY |
                                            JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
    // 安全上限设为 4 倍, 正常超限由监控线程判定, 避免单次大分配被瞬间拒绝
    jeli.ProcessMemoryLimit = static_cast<SIZE_T>(memLimitKb) * 1024ULL * 4ULL;
    jeli.BasicLimitInformation.ActiveProcessLimit = static_cast<DWORD>(input.limits.processLimit);
    SetInformationJobObject(job, JobObjectExtendedLimitInformation, &jeli, sizeof(jeli));

    SECURITY_ATTRIBUTES sa;
    ZeroMemory(&sa, sizeof(sa));
    sa.nLength = sizeof(sa);
    sa.bInheritHandle = TRUE;
    auto openFile = [&](const std::string& p, DWORD access, DWORD creation) -> HANDLE {
        std::wstring w = toWide(p);
        return CreateFileW(w.c_str(), access, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, creation,
                           FILE_ATTRIBUTE_NORMAL, nullptr);
    };
    HANDLE hIn = input.stdinFile.empty() ? openFile("NUL", GENERIC_READ, OPEN_EXISTING)
                                         : openFile(input.stdinFile, GENERIC_READ, OPEN_EXISTING);
    HANDLE hOut = input.stdoutFile.empty()
                      ? openFile("NUL", GENERIC_WRITE, OPEN_EXISTING)
                      : openFile(input.stdoutFile, GENERIC_WRITE, CREATE_ALWAYS);
    HANDLE hErr = input.stderrFile.empty()
                      ? openFile("NUL", GENERIC_WRITE, OPEN_EXISTING)
                      : openFile(input.stderrFile, GENERIC_WRITE, CREATE_ALWAYS);
    if (hIn == INVALID_HANDLE_VALUE || hOut == INVALID_HANDLE_VALUE ||
        hErr == INVALID_HANDLE_VALUE) {
        res.error = "重定向文件打开失败";
        if (hIn != INVALID_HANDLE_VALUE) CloseHandle(hIn);
        if (hOut != INVALID_HANDLE_VALUE) CloseHandle(hOut);
        if (hErr != INVALID_HANDLE_VALUE) CloseHandle(hErr);
        CloseHandle(job);
        return res;
    }

    STARTUPINFOW si;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = hIn;
    si.hStdOutput = hOut;
    si.hStdError = hErr;

    std::wstring cmd = L"\"" + toWide(input.exePath) + L"\"";
    std::vector<wchar_t> cmdBuf(cmd.begin(), cmd.end());
    cmdBuf.push_back(0);
    std::wstring wdir = toWide(input.workDir);
    PROCESS_INFORMATION pi;
    ZeroMemory(&pi, sizeof(pi));
    BOOL ok = CreateProcessW(nullptr, cmdBuf.data(), nullptr, nullptr, TRUE,
                             CREATE_SUSPENDED | CREATE_NO_WINDOW, nullptr,
                             wdir.empty() ? nullptr : wdir.c_str(), &si, &pi);
    if (!ok) {
        res.error = "CreateProcess 失败, error=" + std::to_string(GetLastError());
        CloseHandle(hIn);
        CloseHandle(hOut);
        CloseHandle(hErr);
        CloseHandle(job);
        return res;
    }

    AssignProcessToJobObject(job, pi.hProcess);

    std::atomic<bool> memExceeded{false};
    std::atomic<bool> stop{false};
    std::atomic<long long> peakKb{0};
    // 轮询实际占用, 超过题目内存上限即终止
    std::thread monitor([&]() {
        PROCESS_MEMORY_COUNTERS pmc;
        while (!stop.load()) {
            ZeroMemory(&pmc, sizeof(pmc));
            if (GetProcessMemoryInfo(pi.hProcess, &pmc, sizeof(pmc))) {
                long long commitKb = static_cast<long long>(pmc.PagefileUsage / 1024ULL);
                long long wsKb = static_cast<long long>(pmc.WorkingSetSize / 1024ULL);
                long long cur = std::max(commitKb, wsKb);
                long long prev = peakKb.load();
                while (cur > prev && !peakKb.compare_exchange_weak(prev, cur)) {
                }
                if (cur > memLimitKb) {
                    memExceeded.store(true);
                    TerminateJobObject(job, 1);
                    break;
                }
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(3));
        }
    });

    // 进程启动本身有固定开销(MinGW 冷启动可达 1s), 故 wall 等待放宽为 时限 + 启动宽限,
    // 超时以 CPU 时间为主判定并容忍少量启动开销, 避免把冷启动误判为 TLE.
    const long long startupGraceMs = 3000;
    const long long cpuToleranceMs = 200;
    auto wallStart = std::chrono::steady_clock::now();
    ResumeThread(pi.hThread);
    DWORD wait = WaitForSingleObject(
        pi.hProcess,
        static_cast<DWORD>(static_cast<long long>(input.limits.timeLimitMs) + startupGraceMs));
    auto wallEnd = std::chrono::steady_clock::now();
    long long wallMs =
        std::chrono::duration_cast<std::chrono::milliseconds>(wallEnd - wallStart).count();

    stop.store(true);
    monitor.join();

    FILETIME ct, et, kt, ut;
    long long cpuMs = 0;
    if (GetProcessTimes(pi.hProcess, &ct, &et, &kt, &ut)) {
        cpuMs = filetimeToMs(kt) + filetimeToMs(ut);
    }

    DWORD exitCode = 0;
    if (wait == WAIT_TIMEOUT) {
        res.timeout = true;
        res.timeMs = input.limits.timeLimitMs;
        TerminateJobObject(job, 1);
        WaitForSingleObject(pi.hProcess, 1000);
    } else {
        GetExitCodeProcess(pi.hProcess, &exitCode);
        res.exitCode = static_cast<int>(exitCode);
        long long measured = cpuMs > 0 ? cpuMs : wallMs;
        res.timeMs = measured;
        if (measured > static_cast<long long>(input.limits.timeLimitMs) + cpuToleranceMs) {
            res.timeout = true;
            res.timeMs = input.limits.timeLimitMs;
        }
    }

    // 峰值内存: 取监控峰值 / Job Object 峰值 / 进程峰值计数器的最大者
    PROCESS_MEMORY_COUNTERS pmcPeak;
    ZeroMemory(&pmcPeak, sizeof(pmcPeak));
    if (GetProcessMemoryInfo(pi.hProcess, &pmcPeak, sizeof(pmcPeak))) {
        long long peakCommit = static_cast<long long>(pmcPeak.PeakPagefileUsage / 1024ULL);
        long long peakWs = static_cast<long long>(pmcPeak.PeakWorkingSetSize / 1024ULL);
        peakKb.store(std::max(peakKb.load(), std::max(peakCommit, peakWs)));
    }
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION info;
    ZeroMemory(&info, sizeof(info));
    DWORD retLen = 0;
    if (QueryInformationJobObject(job, JobObjectExtendedLimitInformation, &info, sizeof(info),
                                  &retLen)) {
        long long jobPeak = static_cast<long long>(info.PeakProcessMemoryUsed / 1024ULL);
        peakKb.store(std::max(peakKb.load(), jobPeak));
    }
    res.memoryKb = peakKb.load();
    if (res.memoryKb > memLimitKb) memExceeded.store(true);
    res.memoryExceeded = memExceeded.load();
    res.started = true;

    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    CloseHandle(hIn);
    CloseHandle(hOut);
    CloseHandle(hErr);
    CloseHandle(job);
    return res;
}

std::wstring buildCmdLine(const std::string& exe, const std::vector<std::string>& args) {
    std::wstring cmd = L"\"" + toWide(exe) + L"\"";
    for (const auto& a : args) {
        cmd += L" \"";
        cmd += toWide(a);
        cmd += L"\"";
    }
    return cmd;
}

std::string readAllText(const std::string& path) {
    std::ifstream in(path, std::ios::binary);
    if (!in) return "";
    std::ostringstream ss;
    ss << in.rdbuf();
    return ss.str();
}

// 双进程交叉管道运行. 交叉管道: A.stdout->B.stdin, B.stdout->A.stdin.
// 用 A 创建前/ B 创建前切换句柄继承标志的方式, 保证各子进程只继承自己需要的管道端.
DualRunResult runDualImpl(const DualRunInput& input) {
    DualRunResult res;
    auto closeIf = [](HANDLE& h) {
        if (h && h != INVALID_HANDLE_VALUE) {
            CloseHandle(h);
            h = nullptr;
        }
    };
    HANDLE job = CreateJobObjectW(nullptr, nullptr);
    if (!job) {
        res.error = "CreateJobObject 失败";
        return res;
    }
    long long memLimitKb = static_cast<long long>(input.limits.memoryLimitMb) * 1024;
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION jeli;
    ZeroMemory(&jeli, sizeof(jeli));
    jeli.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE |
                                            JOB_OBJECT_LIMIT_PROCESS_MEMORY |
                                            JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
    jeli.ProcessMemoryLimit = static_cast<SIZE_T>(memLimitKb) * 1024ULL * 4ULL;
    jeli.BasicLimitInformation.ActiveProcessLimit = 2;
    SetInformationJobObject(job, JobObjectExtendedLimitInformation, &jeli, sizeof(jeli));

    SECURITY_ATTRIBUTES sa;
    ZeroMemory(&sa, sizeof(sa));
    sa.nLength = sizeof(sa);
    sa.bInheritHandle = TRUE;
    auto openFile = [&](const std::string& p, DWORD access, DWORD creation) -> HANDLE {
        std::wstring w = toWide(p);
        return CreateFileW(w.c_str(), access, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, creation,
                           FILE_ATTRIBUTE_NORMAL, nullptr);
    };
    auto setInherit = [](HANDLE h, bool inherit) {
        if (h && h != INVALID_HANDLE_VALUE)
            SetHandleInformation(h, HANDLE_FLAG_INHERIT, inherit ? HANDLE_FLAG_INHERIT : 0);
    };

    const bool needPipe1 = input.pipeAstdout;  // A.stdout -> B.stdin
    const bool needPipe2 = input.pipeAstdin;   // B.stdout -> A.stdin
    HANDLE r1 = nullptr, w1 = nullptr, r2 = nullptr, w2 = nullptr;
    HANDLE aIn = nullptr, aOut = nullptr, aErr = nullptr;
    HANDLE bIn = nullptr, bOut = nullptr, bErr = nullptr;
    PROCESS_INFORMATION piA, piB;
    ZeroMemory(&piA, sizeof(piA));
    ZeroMemory(&piB, sizeof(piB));

    auto fail = [&](const std::string& msg) {
        res.error = msg;
        if (piA.hProcess) TerminateProcess(piA.hProcess, 1);
        if (piB.hProcess) TerminateProcess(piB.hProcess, 1);
        closeIf(piA.hThread);
        closeIf(piA.hProcess);
        closeIf(piB.hThread);
        closeIf(piB.hProcess);
        closeIf(aIn);
        closeIf(aOut);
        closeIf(aErr);
        closeIf(bIn);
        closeIf(bOut);
        closeIf(bErr);
        closeIf(r1);
        closeIf(w1);
        closeIf(r2);
        closeIf(w2);
        CloseHandle(job);
        return res;
    };

    if (needPipe1 && !CreatePipe(&r1, &w1, &sa, 0)) return fail("创建管道失败");
    if (needPipe2 && !CreatePipe(&r2, &w2, &sa, 0)) return fail("创建管道失败");

    // A 的句柄(取值后置空管道变量, 避免与 fail 清理重复关闭)
    if (input.pipeAstdin) {
        aIn = r2;
        r2 = nullptr;
    } else {
        aIn = input.stdinFileA.empty() ? openFile("NUL", GENERIC_READ, OPEN_EXISTING)
                                       : openFile(input.stdinFileA, GENERIC_READ, OPEN_EXISTING);
    }
    if (input.pipeAstdout) {
        aOut = w1;
        w1 = nullptr;
    } else {
        aOut = input.stdoutFileA.empty() ? openFile("NUL", GENERIC_WRITE, OPEN_EXISTING)
                                         : openFile(input.stdoutFileA, GENERIC_WRITE, CREATE_ALWAYS);
    }
    aErr = input.stderrFileA.empty() ? openFile("NUL", GENERIC_WRITE, OPEN_EXISTING)
                                     : openFile(input.stderrFileA, GENERIC_WRITE, CREATE_ALWAYS);
    if (aIn == INVALID_HANDLE_VALUE || aOut == INVALID_HANDLE_VALUE ||
        aErr == INVALID_HANDLE_VALUE)
        return fail("A 重定向文件打开失败");

    // A 只继承自己需要的句柄
    setInherit(r1, false);
    setInherit(w2, false);
    setInherit(aIn, true);
    setInherit(aOut, true);

    STARTUPINFOW siA;
    ZeroMemory(&siA, sizeof(siA));
    siA.cb = sizeof(siA);
    siA.dwFlags = STARTF_USESTDHANDLES;
    siA.hStdInput = aIn;
    siA.hStdOutput = aOut;
    siA.hStdError = aErr;
    std::wstring cmdA = buildCmdLine(input.exeA, input.argsA);
    std::vector<wchar_t> bufA(cmdA.begin(), cmdA.end());
    bufA.push_back(0);
    std::wstring wdir = toWide(input.workDir);
    if (!CreateProcessW(nullptr, bufA.data(), nullptr, nullptr, TRUE,
                        CREATE_SUSPENDED | CREATE_NO_WINDOW, nullptr,
                        wdir.empty() ? nullptr : wdir.c_str(), &siA, &piA))
        return fail("启动进程 A 失败, error=" + std::to_string(GetLastError()));

    // B 的句柄
    if (needPipe1) {
        bIn = r1;
        r1 = nullptr;
    } else {
        bIn = openFile("NUL", GENERIC_READ, OPEN_EXISTING);
    }
    if (needPipe2) {
        bOut = w2;
        w2 = nullptr;
    } else {
        bOut = openFile("NUL", GENERIC_WRITE, OPEN_EXISTING);
    }
    bErr = input.stderrFileB.empty() ? openFile("NUL", GENERIC_WRITE, OPEN_EXISTING)
                                     : openFile(input.stderrFileB, GENERIC_WRITE, CREATE_ALWAYS);
    if (bIn == INVALID_HANDLE_VALUE || bOut == INVALID_HANDLE_VALUE ||
        bErr == INVALID_HANDLE_VALUE)
        return fail("B 重定向文件打开失败");

    // B 只继承自己需要的句柄(A 已持有其副本)
    setInherit(aOut, false);
    setInherit(aIn, false);
    setInherit(bIn, true);
    setInherit(bOut, true);

    STARTUPINFOW siB;
    ZeroMemory(&siB, sizeof(siB));
    siB.cb = sizeof(siB);
    siB.dwFlags = STARTF_USESTDHANDLES;
    siB.hStdInput = bIn;
    siB.hStdOutput = bOut;
    siB.hStdError = bErr;
    std::wstring cmdB = buildCmdLine(input.exeB, input.argsB);
    std::vector<wchar_t> bufB(cmdB.begin(), cmdB.end());
    bufB.push_back(0);
    if (!CreateProcessW(nullptr, bufB.data(), nullptr, nullptr, TRUE,
                        CREATE_SUSPENDED | CREATE_NO_WINDOW, nullptr,
                        wdir.empty() ? nullptr : wdir.c_str(), &siB, &piB))
        return fail("启动进程 B 失败, error=" + std::to_string(GetLastError()));

    AssignProcessToJobObject(job, piA.hProcess);
    AssignProcessToJobObject(job, piB.hProcess);

    // 关闭父进程持有的管道/文件端, 使 EOF 能正确传播
    closeIf(aIn);
    closeIf(aOut);
    closeIf(aErr);
    closeIf(bIn);
    closeIf(bOut);
    closeIf(bErr);

    std::atomic<bool> memExceeded{false};
    std::atomic<bool> stop{false};
    std::atomic<long long> peakKb{0};
    auto sample = [&](HANDLE h) {
        PROCESS_MEMORY_COUNTERS pmc;
        ZeroMemory(&pmc, sizeof(pmc));
        if (GetProcessMemoryInfo(h, &pmc, sizeof(pmc))) {
            long long commitKb = static_cast<long long>(pmc.PagefileUsage / 1024ULL);
            long long wsKb = static_cast<long long>(pmc.WorkingSetSize / 1024ULL);
            long long cur = std::max(commitKb, wsKb);
            long long prev = peakKb.load();
            while (cur > prev && !peakKb.compare_exchange_weak(prev, cur)) {
            }
            if (cur > memLimitKb) {
                memExceeded.store(true);
                TerminateJobObject(job, 1);
            }
        }
    };
    std::thread monitor([&]() {
        while (!stop.load()) {
            sample(piA.hProcess);
            sample(piB.hProcess);
            if (memExceeded.load()) break;
            std::this_thread::sleep_for(std::chrono::milliseconds(3));
        }
    });

    const long long startupGraceMs = 3000;
    const long long cpuToleranceMs = 200;
    HANDLE procs[2] = {piA.hProcess, piB.hProcess};
    auto wallStart = std::chrono::steady_clock::now();
    ResumeThread(piA.hThread);
    ResumeThread(piB.hThread);
    DWORD wait = WaitForMultipleObjects(
        2, procs, TRUE,
        static_cast<DWORD>(static_cast<long long>(input.limits.timeLimitMs) + startupGraceMs));
    auto wallEnd = std::chrono::steady_clock::now();
    long long wallMs =
        std::chrono::duration_cast<std::chrono::milliseconds>(wallEnd - wallStart).count();

    stop.store(true);
    monitor.join();

    FILETIME ct, et, kt, ut;
    long long cpuA = 0, cpuB = 0;
    if (GetProcessTimes(piA.hProcess, &ct, &et, &kt, &ut)) cpuA = filetimeToMs(kt) + filetimeToMs(ut);
    if (GetProcessTimes(piB.hProcess, &ct, &et, &kt, &ut)) cpuB = filetimeToMs(kt) + filetimeToMs(ut);
    long long cpuMs = std::max(cpuA, cpuB);

    DWORD ecA = 0, ecB = 0;
    GetExitCodeProcess(piA.hProcess, &ecA);
    GetExitCodeProcess(piB.hProcess, &ecB);
    res.exitCodeA = static_cast<int>(ecA);
    res.exitCodeB = static_cast<int>(ecB);

    if (wait == WAIT_TIMEOUT) {
        res.timeout = true;
        res.timeMs = input.limits.timeLimitMs;
        TerminateJobObject(job, 1);
        WaitForSingleObject(piA.hProcess, 1000);
        WaitForSingleObject(piB.hProcess, 1000);
    } else {
        long long measured = cpuMs > 0 ? cpuMs : wallMs;
        res.timeMs = measured;
        if (measured > static_cast<long long>(input.limits.timeLimitMs) + cpuToleranceMs) {
            res.timeout = true;
            res.timeMs = input.limits.timeLimitMs;
        }
    }

    auto peakOf = [&](HANDLE h) {
        PROCESS_MEMORY_COUNTERS pmc;
        ZeroMemory(&pmc, sizeof(pmc));
        if (GetProcessMemoryInfo(h, &pmc, sizeof(pmc))) {
            long long p = std::max(static_cast<long long>(pmc.PeakPagefileUsage / 1024ULL),
                                   static_cast<long long>(pmc.PeakWorkingSetSize / 1024ULL));
            long long prev = peakKb.load();
            while (p > prev && !peakKb.compare_exchange_weak(prev, p)) {
            }
        }
    };
    peakOf(piA.hProcess);
    peakOf(piB.hProcess);
    res.memoryKb = peakKb.load();
    if (res.memoryKb > memLimitKb) memExceeded.store(true);
    res.memoryExceeded = memExceeded.load();
    res.started = true;

    closeIf(piA.hThread);
    closeIf(piA.hProcess);
    closeIf(piB.hThread);
    closeIf(piB.hProcess);
    CloseHandle(job);
    return res;
}

// 判断 wsl 内 isolate 是否可用(结果缓存).
// 探测带 3 秒超时: 本机 wsl.exe 无响应时不能无限等待, 超时或启动失败一律判定为不可用.
bool wslIsolateAvailable() {
    static int cached = -1;
    if (cached >= 0) return cached == 1;
    const DWORD kTimeoutMs = 3000;
    bool avail = false;
    STARTUPINFOW si;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    PROCESS_INFORMATION pi;
    ZeroMemory(&pi, sizeof(pi));
    std::wstring cmd = L"wsl.exe -e which isolate";
    std::vector<wchar_t> buf(cmd.begin(), cmd.end());
    buf.push_back(0);
    if (CreateProcessW(nullptr, buf.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr,
                       nullptr, &si, &pi)) {
        DWORD wait = WaitForSingleObject(pi.hProcess, kTimeoutMs);
        if (wait == WAIT_OBJECT_0) {
            DWORD ec = 1;
            GetExitCodeProcess(pi.hProcess, &ec);
            avail = (ec == 0);
        } else {
            TerminateProcess(pi.hProcess, 1);
            WaitForSingleObject(pi.hProcess, 1000);
        }
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
    }
    cached = avail ? 1 : 0;
    return avail;
}

// D:\a\b -> /mnt/d/a/b
std::string toWslPath(const std::string& p) {
    std::string r = p;
    if (r.size() >= 2 && r[1] == ':') {
        std::string drive = r.substr(0, 1);
        std::transform(drive.begin(), drive.end(), drive.begin(),
                       [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
        std::string rest = r.substr(2);
        std::replace(rest.begin(), rest.end(), '\\', '/');
        return "/mnt/" + drive + rest;
    }
    std::replace(r.begin(), r.end(), '\\', '/');
    return r;
}

// 简化版 WSL+isolate 运行器: 通过 wsl.exe 调用 isolate 的 init/run/cleanup.
// 说明: 本机通常未安装 isolate, 该路径未实测; 失败时返回错误由上层降级/判 RE.
class WslIsolateRunner : public Runner {
public:
    std::string name() const override { return "wsl"; }
    std::string isolation() const override { return "isolate"; }
    RunResult run(const RunInput& input) override {
        RunResult res;
        std::string wd = input.workDir;
        std::string wdWsl = toWslPath(wd);
        std::string exeWsl = toWslPath(input.exePath);
        std::string metaWin = (fs::path(wd) / "__meta").string();
        std::string outWin = (fs::path(wd) / "__out").string();
        std::string errWin = (fs::path(wd) / "__err").string();

        std::error_code ec;
        // 输入文件复制到工作目录, 供 isolate 使用
        if (!input.stdinFile.empty()) {
            std::string inWin = (fs::path(wd) / "__in").string();
            fs::copy_file(input.stdinFile, inWin, fs::copy_options::overwrite_existing, ec);
        }
        double timeSec = input.limits.timeLimitMs / 1000.0;
        long long memKb = static_cast<long long>(input.limits.memoryLimitMb) * 1024;
        std::string script =
            "set -e\n"
            "cd '" + wdWsl + "'\n"
            "box=$(isolate --box-id=0 --init)\n"
            "cp '" + exeWsl + "' \"$box/sol\"\n"
            "[ -f __in ] && cp __in \"$box/in\" || true\n"
            "isolate --box-id=0 --run --time=" + std::to_string(timeSec) +
            " --wall-time=" + std::to_string(timeSec + 3.0) + " --mem=" + std::to_string(memKb) +
            " --processes=1 --meta='" + toWslPath(metaWin) +
            "' --stdin=in --stdout=out --stderr=err -- ./sol\n"
            "rc=$?\n"
            "cp \"$box/out\" __out 2>/dev/null || true\n"
            "cp \"$box/err\" __err 2>/dev/null || true\n"
            "isolate --box-id=0 --cleanup\n"
            "exit $rc\n";
        std::string scriptPath = (fs::path(wd) / "run.sh").string();
        {
            std::ofstream ofs(scriptPath, std::ios::binary | std::ios::trunc);
            ofs << script;
        }
        std::string logPath = (fs::path(wd) / "isolate.log").string();
        std::string cmd = "wsl.exe -e bash \"" + toWslPath(scriptPath) + "\"";
        ProcResult pr = runProcess(cmd, wd, "", logPath);
        res.started = pr.started;
        res.exitCode = pr.exitCode;
        if (!pr.started) {
            res.error = "无法启动 wsl.exe";
            return res;
        }
        // 解析 isolate meta
        std::string meta = readAllText(metaWin);
        std::istringstream lines(meta);
        std::string line;
        while (std::getline(lines, line)) {
            auto val = [&](const std::string& key) -> std::string {
                if (line.rfind(key, 0) == 0) return line.substr(key.size());
                return "";
            };
            std::string t = val("time:");
            std::string m = val("max-rss:");
            if (!t.empty()) res.timeMs = static_cast<long long>(std::stod(t) * 1000.0 + 0.5);
            if (!m.empty()) res.memoryKb = std::stoll(m);
        }
        // 回填 stdout/stderr
        if (!input.stdoutFile.empty() && fs::exists(outWin, ec))
            fs::copy_file(outWin, input.stdoutFile, fs::copy_options::overwrite_existing, ec);
        if (!input.stderrFile.empty() && fs::exists(errWin, ec))
            fs::copy_file(errWin, input.stderrFile, fs::copy_options::overwrite_existing, ec);
        return res;
    }
};

}  // namespace

DualRunResult runDual(const DualRunInput& input) { return runDualImpl(input); }

#endif  // _WIN32

std::unique_ptr<Runner> createRunner(const std::string& env, bool& degraded) {
    degraded = false;
#ifdef _WIN32
    if (env == "wsl") {
        if (wslIsolateAvailable()) return std::unique_ptr<Runner>(new WslIsolateRunner());
        degraded = true;  // 请求 wsl+isolate 但不可用, 降级到 Windows Job Object
        return std::unique_ptr<Runner>(new WindowsJobObjectRunner());
    }
    if (env == "mingw") return std::unique_ptr<Runner>(new WindowsJobObjectRunner());
    // auto: 优先 WSL+isolate, 探测带超时, 不可用则降级 mingw
    if (wslIsolateAvailable()) return std::unique_ptr<Runner>(new WslIsolateRunner());
    return std::unique_ptr<Runner>(new WindowsJobObjectRunner());
#else
    (void)env;
    degraded = true;
    return nullptr;
#endif
}

}  // namespace oi
