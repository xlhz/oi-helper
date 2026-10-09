#include "oi/compiler.h"

#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#endif

namespace fs = std::filesystem;

namespace oi {

namespace {

#ifdef _WIN32
std::wstring toWide(const std::string& s) {
    if (s.empty()) return std::wstring();
    int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()), nullptr, 0);
    std::wstring w(static_cast<size_t>(n), 0);
    MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()), &w[0], n);
    return w;
}
#endif

bool fileExists(const std::string& p) {
    std::error_code ec;
    return fs::is_regular_file(p, ec);
}

bool readFile(const std::string& path, std::string& out) {
    std::ifstream in(path, std::ios::binary);
    if (!in) return false;
    std::ostringstream ss;
    ss << in.rdbuf();
    out = ss.str();
    return true;
}

std::string normalizeOpt(const std::string& o) {
    if (o.empty()) return "-O2";
    return o[0] == '-' ? o : ("-" + o);
}

void trimTrailingNewlines(std::string& s) {
    while (!s.empty() && (s.back() == '\n' || s.back() == '\r' || s.back() == ' ')) s.pop_back();
}

std::string summarize(const std::string& log) {
    if (log.size() <= 4000) return log;
    return log.substr(0, 4000) + "\n...(输出已截断)";
}

}  // namespace

std::string findGpp() {
    if (const char* e = std::getenv("OI_GPP")) {
        if (fileExists(e)) return e;
    }
#ifdef _WIN32
    if (fileExists("D:\\mingw64\\bin\\g++.exe")) return "D:\\mingw64\\bin\\g++.exe";
#endif
    if (const char* path = std::getenv("PATH")) {
        std::string ps(path);
        size_t start = 0;
        while (true) {
            size_t sep = ps.find(';', start);
            std::string dir = ps.substr(start, sep == std::string::npos ? std::string::npos : sep - start);
            if (!dir.empty()) {
                for (const char* nm : {"g++.exe", "g++"}) {
                    std::string cand = (fs::path(dir) / nm).string();
                    if (fileExists(cand)) return cand;
                }
            }
            if (sep == std::string::npos) break;
            start = sep + 1;
        }
    }
    return "";
}

void prependToolchainPath(const std::string& gppPath) {
#ifdef _WIN32
    fs::path bin = fs::path(gppPath).parent_path();
    if (bin.empty()) return;
    std::wstring wbin = bin.wstring();
    DWORD n = GetEnvironmentVariableW(L"PATH", nullptr, 0);
    std::wstring cur;
    if (n > 0) {
        std::vector<wchar_t> buf(n);
        GetEnvironmentVariableW(L"PATH", buf.data(), n);
        cur = buf.data();
    }
    std::wstring np = wbin + L";" + cur;
    SetEnvironmentVariableW(L"PATH", np.c_str());
#else
    (void)gppPath;
#endif
}

ProcResult runProcess(const std::string& cmdLine, const std::string& workDir,
                      const std::string& stdoutFile, const std::string& stderrFile) {
    ProcResult r;
#ifdef _WIN32
    SECURITY_ATTRIBUTES sa;
    ZeroMemory(&sa, sizeof(sa));
    sa.nLength = sizeof(sa);
    sa.bInheritHandle = TRUE;
    auto openFile = [&](const std::string& p, DWORD access, DWORD creation) -> HANDLE {
        std::wstring w = toWide(p);
        return CreateFileW(w.c_str(), access, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, creation,
                           FILE_ATTRIBUTE_NORMAL, nullptr);
    };
    HANDLE hIn = openFile("NUL", GENERIC_READ, OPEN_EXISTING);
    HANDLE hOut = stdoutFile.empty() ? openFile("NUL", GENERIC_WRITE, OPEN_EXISTING)
                                     : openFile(stdoutFile, GENERIC_WRITE, CREATE_ALWAYS);
    HANDLE hErr = stderrFile.empty() ? openFile("NUL", GENERIC_WRITE, OPEN_EXISTING)
                                     : openFile(stderrFile, GENERIC_WRITE, CREATE_ALWAYS);
    if (hIn == INVALID_HANDLE_VALUE || hOut == INVALID_HANDLE_VALUE ||
        hErr == INVALID_HANDLE_VALUE) {
        if (hIn != INVALID_HANDLE_VALUE) CloseHandle(hIn);
        if (hOut != INVALID_HANDLE_VALUE) CloseHandle(hOut);
        if (hErr != INVALID_HANDLE_VALUE) CloseHandle(hErr);
        return r;
    }
    STARTUPINFOW si;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = hIn;
    si.hStdOutput = hOut;
    si.hStdError = hErr;

    std::wstring wcmd = toWide(cmdLine);
    std::vector<wchar_t> buf(wcmd.begin(), wcmd.end());
    buf.push_back(0);
    std::wstring wdir = toWide(workDir);
    PROCESS_INFORMATION pi;
    ZeroMemory(&pi, sizeof(pi));
    BOOL ok = CreateProcessW(nullptr, buf.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW,
                             nullptr, wdir.empty() ? nullptr : wdir.c_str(), &si, &pi);
    if (ok) {
        WaitForSingleObject(pi.hProcess, INFINITE);
        DWORD ec = 0;
        GetExitCodeProcess(pi.hProcess, &ec);
        r.started = true;
        r.exitCode = static_cast<int>(ec);
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
    }
    CloseHandle(hIn);
    CloseHandle(hOut);
    CloseHandle(hErr);
#else
    std::string cmd = cmdLine;
    if (!stdoutFile.empty()) cmd += " > \"" + stdoutFile + "\"";
    if (!stderrFile.empty()) cmd += " 2> \"" + stderrFile + "\"";
    int rc = std::system(cmd.c_str());
    r.started = true;
    r.exitCode = rc;
    (void)workDir;
#endif
    return r;
}

CompileResult compileSource(const std::string& srcFile, const std::string& exePath,
                            const CompileOptions& opts) {
    CompileResult r;
    std::string gpp = findGpp();
    if (gpp.empty()) {
        r.message = "未找到 g++ 编译器 (已尝试 OI_GPP、D:\\mingw64\\bin、PATH)";
        return r;
    }
    std::error_code ec;
    fs::create_directories(fs::path(exePath).parent_path(), ec);
    std::string logPath = exePath + ".log";
    std::string cmdLine = "\"" + gpp + "\" " + normalizeOpt(opts.optimize) + " -std=" +
                          opts.standard + " -DONLINE_JUDGE \"" + srcFile + "\" -o \"" + exePath +
                          "\"";
    ProcResult pr = runProcess(cmdLine, "", "", logPath);
    std::string log;
    readFile(logPath, log);
    if (pr.started && pr.exitCode == 0 && fileExists(exePath)) {
        r.success = true;
        r.exePath = exePath;
    } else {
        trimTrailingNewlines(log);
        if (log.empty()) {
            r.message = pr.started ? ("编译失败, 退出码 " + std::to_string(pr.exitCode))
                                   : "无法启动编译器";
        } else {
            r.message = summarize(log);
        }
    }
    return r;
}

}  // namespace oi
