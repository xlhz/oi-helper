#include "oi/judge.h"

#include <algorithm>
#include <atomic>
#include <cctype>
#include <cmath>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <random>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include "oi/checker.h"
#include "oi/comparator.h"
#include "oi/compiler.h"
#include "oi/freopen_scan.h"
#include "oi/runner.h"

namespace fs = std::filesystem;

namespace oi {

namespace {

struct JudgeContext {
    const JudgeTask* task = nullptr;
    Runner* runner = nullptr;
    std::string exePath;
    fs::path runRoot;
    FreopenConfig fr;
    std::string checkerExe;
    std::string checkerError;
};

struct EnvSetup {
    std::unique_ptr<Runner> runner;
    std::string envName = "mingw";
    std::string isolation = "jobobject";
    bool degraded = false;
};

EnvSetup setupEnv(const JudgeTask& task) {
    EnvSetup s;
    s.runner = createRunner(task.env, s.degraded);
    if (s.runner) {
        s.envName = s.runner->name();
        s.isolation = s.runner->isolation();
    }
    return s;
}

bool readFile(const std::string& path, std::string& out) {
    std::ifstream in(path, std::ios::binary);
    if (!in) return false;
    std::ostringstream ss;
    ss << in.rdbuf();
    out = ss.str();
    return true;
}

bool writeFile(const std::string& path, const std::string& content) {
    std::error_code ec;
    fs::create_directories(fs::path(path).parent_path(), ec);
    std::ofstream out(path, std::ios::binary | std::ios::trunc);
    if (!out) return false;
    out.write(content.data(), static_cast<std::streamsize>(content.size()));
    return static_cast<bool>(out);
}

// 临时目录名只用 ASCII: 题目名可能含中文, 直接拼进路径会因编码不一致导致子进程
// 与比对阶段解析到不同目录, 故把非 ASCII 与非法字符统一替换为下划线
std::string sanitizeName(const std::string& name) {
    std::string s = name;
    for (char& c : s) {
        unsigned char u = static_cast<unsigned char>(c);
        if (u >= 0x80 || u < 0x20 || c == '\\' || c == '/' || c == ':' || c == '*' || c == '?' ||
            c == '"' || c == '<' || c == '>' || c == '|') {
            c = '_';
        }
    }
    if (s.empty()) s = "problem";
    return s;
}

fs::path makeRunRoot(const std::string& name) {
    static std::atomic<unsigned> counter{0};
    std::random_device rd;
    std::string tag = std::to_string(static_cast<unsigned long long>(std::time(nullptr))) + "-" +
                      std::to_string(rd() % 100000) + "-" + std::to_string(counter++);
    fs::path p = fs::temp_directory_path() / ("oi-judge-" + sanitizeName(name) + "-" + tag);
    std::error_code ec;
    fs::create_directories(p, ec);
    return p;
}

// 把测试点输入写到目标路径, 返回 false 表示源文件缺失等错误
bool prepareInput(const std::string& src, const std::string& dst, std::string& err) {
    std::error_code ec;
    fs::create_directories(fs::path(dst).parent_path(), ec);
    if (src.empty()) {
        return writeFile(dst, "");
    }
    if (!fs::exists(src, ec)) {
        err = "测试点输入文件不存在: " + src;
        return false;
    }
    fs::copy_file(src, dst, fs::copy_options::overwrite_existing, ec);
    if (ec) {
        err = "复制输入失败: " + ec.message();
        return false;
    }
    return true;
}

std::string trimSummary(std::string s, size_t limit = 500) {
    while (!s.empty() && (s.back() == '\n' || s.back() == '\r' || s.back() == ' ')) s.pop_back();
    if (s.size() > limit) s = s.substr(0, limit) + "...";
    return s;
}

// 读取文件开头至多 limit 字节, 读不到返回空串
std::string readHead(const std::string& path, size_t limit) {
    std::ifstream in(path, std::ios::binary);
    if (!in) return "";
    std::string s;
    s.resize(limit);
    in.read(&s[0], static_cast<std::streamsize>(limit));
    s.resize(static_cast<size_t>(in.gcount()));
    return s;
}

// 依据退出码与 stderr 文本推断运行时错误类型
std::string diagnoseRe(const RunResult& rr, const std::string& se) {
    unsigned ec = static_cast<unsigned>(rr.exitCode);
    if (ec == 0xC0000005u) return "数组越界或空指针访问";
    if (ec == 0xC00000FDu) return "栈溢出, 递归过深或局部数组过大";
    if (ec == 0xC0000094u) return "整数除零";
    if (ec == 0xC000008Eu) return "浮点除零";
    if (ec == 0xC000001Du) return "非法指令";
    if (se.find("terminate called") != std::string::npos ||
        se.find("std::bad_alloc") != std::string::npos) {
        return "未捕获异常导致终止";
    }
    std::string low = se;
    for (char& c : low) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    if (low.find("no such file") != std::string::npos ||
        low.find("cannot open") != std::string::npos ||
        low.find("permission denied") != std::string::npos || low.find("fopen") != std::string::npos) {
        return "文件读写错误, 请检查 freopen 文件名与路径";
    }
    return "";
}

void applyRunStatus(const RunResult& rr, TestResult& tr) {
    tr.timeMs = rr.timeMs;
    tr.memoryKb = rr.memoryKb;
    if (!rr.started) {
        tr.status = Status::RE;
        tr.message = rr.error.empty() ? "程序启动失败" : rr.error;
        return;
    }
    if (rr.timeout) {
        tr.status = Status::TLE;
        tr.message = "超过时间限制";
        return;
    }
    if (rr.memoryExceeded) {
        tr.status = Status::MLE;
        tr.message = "超过内存限制";
        return;
    }
    if (rr.exitCode != 0) {
        tr.status = Status::RE;
        tr.message = "运行时错误, 退出码 " + std::to_string(rr.exitCode);
        return;
    }
    tr.status = Status::AC;  // 待比对覆盖
}

TestResult runSingleTest(const TestCase& tc, JudgeContext& ctx) {
    TestResult tr;
    tr.id = tc.id;
    tr.maxScore = 100;
    const JudgeTask& task = *ctx.task;

    fs::path wd = ctx.runRoot / ("t" + std::to_string(tc.id));
    std::error_code ec;
    fs::create_directories(wd, ec);

    std::string inSrc = tc.inputFile.empty()
                            ? ""
                            : (fs::path(task.problem.dir) / tc.inputFile).string();
    std::string ansFile = tc.outputFile.empty()
                              ? ""
                              : (fs::path(task.problem.dir) / tc.outputFile).string();

    RunInput ri;
    ri.exePath = ctx.exePath;
    ri.workDir = wd.string();
    ri.limits.timeLimitMs = task.problem.timeLimit;
    ri.limits.memoryLimitMb = task.problem.memoryLimit;
    ri.stderrFile = (wd / "stderr.txt").string();

    std::string participantFile;
    bool inputOk = true;
    std::string inputErr;

    if (ctx.fr.enabled && !ctx.fr.in.empty()) {
        std::string dst = (wd / ctx.fr.in).string();
        inputOk = prepareInput(inSrc, dst, inputErr);
        ri.stdinFile = "";
    } else {
        std::string dst = (wd / "stdin.txt").string();
        inputOk = prepareInput(inSrc, dst, inputErr);
        ri.stdinFile = dst;
    }
    if (!inputOk) {
        tr.status = Status::RE;
        tr.message = inputErr;
        return tr;
    }

    if (ctx.fr.enabled && !ctx.fr.out.empty()) {
        std::string outDst = (wd / ctx.fr.out).string();
        fs::remove(outDst, ec);
        ri.stdoutFile = "";
        participantFile = outDst;
    } else {
        std::string outDst = (wd / "stdout.txt").string();
        fs::remove(outDst, ec);
        ri.stdoutFile = outDst;
        participantFile = outDst;
    }

    RunResult rr = ctx.runner->run(ri);
    applyRunStatus(rr, tr);
    if (tr.status != Status::AC) {
        if (tr.status == Status::RE) {
            tr.stderrText = readHead(ri.stderrFile, 2000);
            std::string diag = diagnoseRe(rr, tr.stderrText);
            if (!diag.empty()) tr.message += " (" + diag + ")";
        }
        return tr;
    }

    CompareResult cr;
    if (task.problem.checker == "testlib") {
        if (!ctx.checkerError.empty()) {
            tr.status = Status::WA;
            tr.message = ctx.checkerError;
            return tr;
        }
        cr = runTestlibChecker(ctx.checkerExe, inSrc, participantFile, ansFile, wd.string());
    } else if (task.problem.checker == "float") {
        cr = compareFloat(participantFile, ansFile, task.problem.eps);
    } else {
        cr = compareDiff(participantFile, ansFile);
    }
    tr.status = cr.equal ? Status::AC : Status::WA;
    tr.message = cr.message;
    if (!cr.equal) {
        tr.diffLine = cr.line;
        tr.actual = readHead(participantFile, 4000);
        tr.expected = readHead(ansFile, 4000);
    }
    return tr;
}

Status worstStatus(const std::vector<TestResult>& tests) {
    bool allAC = true;
    for (const auto& t : tests) {
        if (t.status != Status::AC) allAC = false;
    }
    if (allAC) return Status::AC;
    auto has = [&](Status s) {
        for (const auto& t : tests) {
            if (t.status == s) return true;
        }
        return false;
    };
    if (has(Status::TLE)) return Status::TLE;
    if (has(Status::MLE)) return Status::MLE;
    if (has(Status::RE)) return Status::RE;
    return Status::WA;
}

void computeScores(JudgeResult& res, const ProblemConfig& cfg) {
    for (auto& t : res.tests) {
        t.maxScore = 100;
        t.score = t.status == Status::AC ? 100 : 0;
    }
    // ICPC 赛制: 无部分分, 全部测试点 AC 才通过
    if (cfg.format == "icpc") {
        res.subtasks.clear();
        res.maxScore = 100;
        bool allAC = true;
        for (const auto& t : res.tests) {
            if (t.status != Status::AC) allAC = false;
        }
        res.totalScore = allAC ? 100 : 0;
        return;
    }
    if (!cfg.subtasks.empty()) {
        int total = 0, maxTotal = 0;
        for (const auto& st : cfg.subtasks) {
            SubtaskResult sr;
            sr.id = st.id;
            sr.maxScore = st.score;
            sr.tests = st.tests;
            bool allAC = true;
            for (int tid : st.tests) {
                const TestResult* found = nullptr;
                for (const auto& t : res.tests) {
                    if (t.id == tid) { found = &t; break; }
                }
                if (!found || found->status != Status::AC) { allAC = false; break; }
            }
            sr.score = allAC ? st.score : 0;
            total += sr.score;
            maxTotal += sr.maxScore;
            res.subtasks.push_back(sr);
        }
        res.totalScore = total;
        res.maxScore = maxTotal;
    } else {
        int ac = 0;
        for (const auto& t : res.tests) {
            if (t.status == Status::AC) ++ac;
        }
        res.maxScore = 100;
        int n = static_cast<int>(res.tests.size());
        res.totalScore = n > 0 ? static_cast<int>(std::llround(ac * 100.0 / n)) : 0;
    }
}

// 并行执行测试点; fn 返回单点结果
template <typename F>
void runTestsParallel(const std::vector<TestCase>& tests, int jobs,
                      std::vector<TestResult>& out, F fn) {
    size_t n = tests.size();
    out.assign(n, TestResult{});
    std::atomic<size_t> next{0};
    int j = jobs < 1 ? 1 : jobs;
    if (j > static_cast<int>(n)) j = n > 0 ? static_cast<int>(n) : 1;
    auto worker = [&]() {
        while (true) {
            size_t i = next.fetch_add(1);
            if (i >= n) break;
            out[i] = fn(tests[i]);
        }
    };
    if (j <= 1) {
        worker();
    } else {
        std::vector<std::thread> ths;
        for (int i = 0; i < j; ++i) ths.emplace_back(worker);
        for (auto& t : ths) t.join();
    }
}

// 所有测试点标记为同一状态
void markAll(JudgeResult& res, const JudgeTask& task, Status st, const std::string& msg) {
    for (const auto& tc : task.problem.tests) {
        TestResult tr;
        tr.id = tc.id;
        tr.status = st;
        tr.maxScore = 100;
        tr.message = msg;
        res.tests.push_back(tr);
    }
    computeScores(res, task.problem);
    res.status = st;
}

// type=traditional: 编译并运行, 比对输出
JudgeResult runTraditional(const JudgeTask& task) {
    JudgeResult res;
    res.problem = task.problem.name;

    EnvSetup es = setupEnv(task);
    res.env = es.envName;
    res.isolation = es.isolation;
    res.isolationDegraded = es.degraded;
    Runner* runner = es.runner.get();

    fs::path runRoot = makeRunRoot(task.problem.name.empty() ? "problem" : task.problem.name);
    std::string buildDir = (runRoot / "build").string();
    std::string exePath = (fs::path(buildDir) / "solution.exe").string();

    CompileOptions co;
    co.standard = task.problem.standard;
    co.optimize = task.problem.optimize;
    CompileResult cr = compileSource(task.srcFile, exePath, co);
    if (!cr.success) {
        res.compileMessage = cr.message;
        markAll(res, task, Status::CE, "");
        std::error_code ec;
        fs::remove_all(runRoot, ec);
        return res;
    }

    JudgeContext ctx;
    ctx.task = &task;
    ctx.runner = runner;
    ctx.exePath = exePath;
    ctx.runRoot = runRoot;
    if (task.problem.freopen.enabled) {
        ctx.fr = task.problem.freopen;
    } else {
        FreopenScan sc = scanFreopen(task.srcFile);
        if (sc.hasIn || sc.hasOut) {
            ctx.fr.enabled = true;
            ctx.fr.in = sc.inName;
            ctx.fr.out = sc.outName;
        }
    }

    if (task.problem.checker == "testlib") {
        std::string checkerSrc = (fs::path(task.problem.dir) / task.problem.checkerFile).string();
        std::string checkerExe = (fs::path(buildDir) / "checker.exe").string();
        CheckerCompileResult cc = compileChecker(checkerSrc, checkerExe, "");
        if (cc.success) {
            ctx.checkerExe = checkerExe;
        } else {
            ctx.checkerError = "checker 编译失败: " + cc.message;
        }
    }

    std::vector<TestResult> results;
    runTestsParallel(task.problem.tests, task.jobs, results,
                     [&](const TestCase& tc) { return runSingleTest(tc, ctx); });

    for (auto& r : results) res.tests.push_back(std::move(r));
    std::sort(res.tests.begin(), res.tests.end(),
              [](const TestResult& a, const TestResult& b) { return a.id < b.id; });

    computeScores(res, task.problem);
    res.status = worstStatus(res.tests);

    std::error_code ec;
    fs::remove_all(runRoot, ec);
    return res;
}

// 用统一 checker 比对提交文件与标准答案
CompareResult compareWithChecker(const JudgeTask& task, const std::string& checkerExe,
                                 const std::string& checkerError, const std::string& inSrc,
                                 const std::string& participantFile, const std::string& ansFile,
                                 const std::string& wd) {
    CompareResult cr;
    if (task.problem.checker == "testlib") {
        if (!checkerError.empty()) {
            cr.message = checkerError;
            return cr;
        }
        return runTestlibChecker(checkerExe, inSrc, participantFile, ansFile, wd);
    }
    if (task.problem.checker == "float") {
        return compareFloat(participantFile, ansFile, task.problem.eps);
    }
    return compareDiff(participantFile, ansFile);
}

// type=output-only: 不编译不运行, 直接比对提交文件
JudgeResult runOutputOnly(const JudgeTask& task) {
    JudgeResult res;
    res.problem = task.problem.name;
    EnvSetup es = setupEnv(task);
    res.env = es.envName;
    res.isolation = es.isolation;
    res.isolationDegraded = es.degraded;

    if (task.srcFile.empty()) {
        res.compileMessage = "output-only 题型需要通过 --src 指定提交文件";
        markAll(res, task, Status::RE, res.compileMessage);
        return res;
    }
    std::error_code ec;
    if (!fs::exists(task.srcFile, ec)) {
        res.compileMessage = "提交文件不存在: " + task.srcFile;
        markAll(res, task, Status::RE, res.compileMessage);
        return res;
    }

    fs::path runRoot = makeRunRoot(task.problem.name.empty() ? "problem" : task.problem.name);
    std::string checkerExe, checkerError;
    if (task.problem.checker == "testlib") {
        std::string checkerSrc = (fs::path(task.problem.dir) / task.problem.checkerFile).string();
        std::string ce = (runRoot / "build" / "checker.exe").string();
        CheckerCompileResult cc = compileChecker(checkerSrc, ce, "");
        if (cc.success) {
            checkerExe = ce;
        } else {
            checkerError = "checker 编译失败: " + cc.message;
        }
    }

    std::vector<TestResult> results;
    runTestsParallel(task.problem.tests, task.jobs, results, [&](const TestCase& tc) {
        TestResult tr;
        tr.id = tc.id;
        tr.maxScore = 100;
        std::string ansFile =
            tc.outputFile.empty() ? "" : (fs::path(task.problem.dir) / tc.outputFile).string();
        std::string inSrc =
            tc.inputFile.empty() ? "" : (fs::path(task.problem.dir) / tc.inputFile).string();
        if (ansFile.empty()) {
            tr.status = Status::RE;
            tr.message = "测试点缺少 out 标准答案";
            return tr;
        }
        fs::create_directories(runRoot, ec);
        CompareResult cr = compareWithChecker(task, checkerExe, checkerError, inSrc, task.srcFile,
                                              ansFile, runRoot.string());
        tr.status = cr.equal ? Status::AC : Status::WA;
        tr.message = cr.message;
        return tr;
    });

    for (auto& r : results) res.tests.push_back(std::move(r));
    std::sort(res.tests.begin(), res.tests.end(),
              [](const TestResult& a, const TestResult& b) { return a.id < b.id; });
    computeScores(res, task.problem);
    res.status = worstStatus(res.tests);
    fs::remove_all(runRoot, ec);
    return res;
}

// type=interactive: 选手程序与 interactor 交叉管道交互
JudgeResult runInteractive(const JudgeTask& task) {
    JudgeResult res;
    res.problem = task.problem.name;
    EnvSetup es = setupEnv(task);
    res.env = es.envName;
    res.isolation = es.isolation;
    res.isolationDegraded = es.degraded;

    if (task.problem.interactor.empty()) {
        res.compileMessage = "interactive 题型缺少 interactor 字段";
        markAll(res, task, Status::RE, res.compileMessage);
        return res;
    }

    fs::path runRoot = makeRunRoot(task.problem.name.empty() ? "problem" : task.problem.name);
    std::string buildDir = (runRoot / "build").string();
    std::string solExe = (fs::path(buildDir) / "solution.exe").string();
    std::string itrExe = (fs::path(buildDir) / "interactor.exe").string();

    CompileOptions co;
    co.standard = task.problem.standard;
    co.optimize = task.problem.optimize;
    CompileResult c1 = compileSource(task.srcFile, solExe, co);
    if (!c1.success) {
        res.compileMessage = "选手程序编译失败: " + c1.message;
        markAll(res, task, Status::CE, "");
        std::error_code ec;
        fs::remove_all(runRoot, ec);
        return res;
    }
    std::string itrSrc = (fs::path(task.problem.dir) / task.problem.interactor).string();
    CompileResult c2 = compileSource(itrSrc, itrExe, co);
    if (!c2.success) {
        res.compileMessage = "interactor 编译失败: " + c2.message;
        markAll(res, task, Status::CE, "");
        std::error_code ec;
        fs::remove_all(runRoot, ec);
        return res;
    }

    std::vector<TestResult> results;
    runTestsParallel(task.problem.tests, task.jobs, results, [&](const TestCase& tc) {
        TestResult tr;
        tr.id = tc.id;
        tr.maxScore = 100;
        fs::path wd = runRoot / ("t" + std::to_string(tc.id));
        std::error_code ec;
        fs::create_directories(wd, ec);
        std::string inSrc =
            tc.inputFile.empty() ? "" : (fs::path(task.problem.dir) / tc.inputFile).string();
        std::string inputPath = (wd / "input.txt").string();
        std::string inputErr;
        if (!prepareInput(inSrc, inputPath, inputErr)) {
            tr.status = Status::RE;
            tr.message = inputErr;
            return tr;
        }
        DualRunInput di;
        di.exeA = solExe;
        di.exeB = itrExe;
        di.workDir = wd.string();
        di.argsB = {inputPath};  // interactor 第 1 个参数: 测试输入文件
        di.pipeAstdin = true;    // 选手 stdin <- interactor stdout
        di.pipeAstdout = true;   // 选手 stdout -> interactor stdin
        di.stderrFileA = (wd / "participant.err").string();
        di.stderrFileB = (wd / "interactor.err").string();
        di.limits.timeLimitMs = task.problem.timeLimit;
        di.limits.memoryLimitMb = task.problem.memoryLimit;
        DualRunResult dr = runDual(di);
        tr.timeMs = dr.timeMs;
        tr.memoryKb = dr.memoryKb;
        if (!dr.started) {
            tr.status = Status::RE;
            tr.message = dr.error.empty() ? "进程启动失败" : dr.error;
            return tr;
        }
        if (dr.timeout) {
            tr.status = Status::TLE;
            tr.message = "超过时间限制";
            return tr;
        }
        if (dr.memoryExceeded) {
            tr.status = Status::MLE;
            tr.message = "超过内存限制";
            return tr;
        }
        std::string itrErr;
        readFile((wd / "interactor.err").string(), itrErr);
        if (dr.exitCodeA != 0) {
            tr.status = Status::RE;
            tr.message = "选手程序退出码 " + std::to_string(dr.exitCodeA);
            return tr;
        }
        if (dr.exitCodeB != 0) {
            tr.status = Status::WA;
            std::string msg = trimSummary(itrErr);
            tr.message = msg.empty() ? ("interactor 退出码 " + std::to_string(dr.exitCodeB)) : msg;
            return tr;
        }
        tr.status = Status::AC;
        tr.message = trimSummary(itrErr);
        return tr;
    });

    for (auto& r : results) res.tests.push_back(std::move(r));
    std::sort(res.tests.begin(), res.tests.end(),
              [](const TestResult& a, const TestResult& b) { return a.id < b.id; });
    computeScores(res, task.problem);
    res.status = worstStatus(res.tests);
    std::error_code ec;
    fs::remove_all(runRoot, ec);
    return res;
}

// type=communication: 交叉管道连接的通信题(简化版, 仅支持 2 个源文件)
JudgeResult runCommunication(const JudgeTask& task) {
    JudgeResult res;
    res.problem = task.problem.name;
    EnvSetup es = setupEnv(task);
    res.env = es.envName;
    res.isolation = es.isolation;
    res.isolationDegraded = es.degraded;

    std::vector<std::string> sources = task.problem.sources;
    if (sources.size() < 2) {
        res.compileMessage = "communication 题型需要 sources 至少 2 个源文件";
        markAll(res, task, Status::RE, res.compileMessage);
        return res;
    }
    // 简化点: 仅支持 2 个源文件的交叉管道; 多余源文件顺序运行会引入不确定交互, 故直接报错.
    if (sources.size() != 2) {
        res.compileMessage = "communication 简化实现仅支持 2 个源文件, 实际 " +
                             std::to_string(sources.size()) + " 个";
        markAll(res, task, Status::RE, res.compileMessage);
        return res;
    }

    fs::path runRoot = makeRunRoot(task.problem.name.empty() ? "problem" : task.problem.name);
    std::string buildDir = (runRoot / "build").string();
    CompileOptions co;
    co.standard = task.problem.standard;
    co.optimize = task.problem.optimize;
    std::string exeA = (fs::path(buildDir) / "proc1.exe").string();
    std::string exeB = (fs::path(buildDir) / "proc2.exe").string();
    CompileResult c1 = compileSource((fs::path(task.problem.dir) / sources[0]).string(), exeA, co);
    if (!c1.success) {
        res.compileMessage = "源文件 1 编译失败: " + c1.message;
        markAll(res, task, Status::CE, "");
        std::error_code ec;
        fs::remove_all(runRoot, ec);
        return res;
    }
    CompileResult c2 = compileSource((fs::path(task.problem.dir) / sources[1]).string(), exeB, co);
    if (!c2.success) {
        res.compileMessage = "源文件 2 编译失败: " + c2.message;
        markAll(res, task, Status::CE, "");
        std::error_code ec;
        fs::remove_all(runRoot, ec);
        return res;
    }

    std::string checkerExe, checkerError;
    if (task.problem.checker == "testlib") {
        std::string checkerSrc = (fs::path(task.problem.dir) / task.problem.checkerFile).string();
        std::string ce = (fs::path(buildDir) / "checker.exe").string();
        CheckerCompileResult cc = compileChecker(checkerSrc, ce, "");
        if (cc.success) {
            checkerExe = ce;
        } else {
            checkerError = "checker 编译失败: " + cc.message;
        }
    }

    std::vector<TestResult> results;
    runTestsParallel(task.problem.tests, task.jobs, results, [&](const TestCase& tc) {
        TestResult tr;
        tr.id = tc.id;
        tr.maxScore = 100;
        fs::path wd = runRoot / ("t" + std::to_string(tc.id));
        std::error_code ec;
        fs::create_directories(wd, ec);
        std::string inSrc =
            tc.inputFile.empty() ? "" : (fs::path(task.problem.dir) / tc.inputFile).string();
        std::string inputPath = (wd / "input.txt").string();
        std::string inputErr;
        if (!prepareInput(inSrc, inputPath, inputErr)) {
            tr.status = Status::RE;
            tr.message = inputErr;
            return tr;
        }
        std::string outPath = (wd / "answer.txt").string();
        fs::remove(outPath, ec);
        DualRunInput di;
        di.exeA = exeA;
        di.exeB = exeB;
        di.workDir = wd.string();
        // 简化: 进程 1 的 stdin/stdout 均用于交叉管道, 故输入/输出经命令行文件参数传递.
        di.argsA = {inputPath, outPath};
        di.pipeAstdin = true;
        di.pipeAstdout = true;
        di.stderrFileA = (wd / "proc1.err").string();
        di.stderrFileB = (wd / "proc2.err").string();
        di.limits.timeLimitMs = task.problem.timeLimit;
        di.limits.memoryLimitMb = task.problem.memoryLimit;
        DualRunResult dr = runDual(di);
        tr.timeMs = dr.timeMs;
        tr.memoryKb = dr.memoryKb;
        if (!dr.started) {
            tr.status = Status::RE;
            tr.message = dr.error.empty() ? "进程启动失败" : dr.error;
            return tr;
        }
        if (dr.timeout) {
            tr.status = Status::TLE;
            tr.message = "超过时间限制";
            return tr;
        }
        if (dr.memoryExceeded) {
            tr.status = Status::MLE;
            tr.message = "超过内存限制";
            return tr;
        }
        if (dr.exitCodeA != 0) {
            tr.status = Status::RE;
            tr.message = "进程 1 退出码 " + std::to_string(dr.exitCodeA);
            return tr;
        }
        if (dr.exitCodeB != 0) {
            tr.status = Status::RE;
            tr.message = "进程 2 退出码 " + std::to_string(dr.exitCodeB);
            return tr;
        }
        std::string ansFile =
            tc.outputFile.empty() ? "" : (fs::path(task.problem.dir) / tc.outputFile).string();
        if (ansFile.empty()) {
            tr.status = Status::RE;
            tr.message = "测试点缺少 out 标准答案";
            return tr;
        }
        CompareResult cr =
            compareWithChecker(task, checkerExe, checkerError, inSrc, outPath, ansFile, wd.string());
        tr.status = cr.equal ? Status::AC : Status::WA;
        tr.message = cr.message;
        return tr;
    });

    for (auto& r : results) res.tests.push_back(std::move(r));
    std::sort(res.tests.begin(), res.tests.end(),
              [](const TestResult& a, const TestResult& b) { return a.id < b.id; });
    computeScores(res, task.problem);
    res.status = worstStatus(res.tests);
    std::error_code ec;
    fs::remove_all(runRoot, ec);
    return res;
}

}  // namespace

Json buildResultJson(const JudgeResult& res) {
    Json root = Json::makeObject();
    root["problem"] = Json::makeString(res.problem);
    root["format"] = Json::makeString(res.format);
    root["solved"] = Json::makeBool(res.status == Status::AC);
    root["env"] = Json::makeString(res.env);
    root["isolation"] = Json::makeString(res.isolation);
    root["isolationDegraded"] = Json::makeBool(res.isolationDegraded);
    root["compileMessage"] = Json::makeString(res.compileMessage);

    Json subtasks = Json::makeArray();
    for (const auto& st : res.subtasks) {
        Json node = Json::makeObject();
        node["id"] = Json::makeInt(st.id);
        node["score"] = Json::makeInt(st.score);
        node["maxScore"] = Json::makeInt(st.maxScore);
        Json arr = Json::makeArray();
        for (int t : st.tests) arr.arrVal.push_back(Json::makeInt(t));
        node["tests"] = arr;
        subtasks.arrVal.push_back(node);
    }
    root["subtasks"] = subtasks;

    Json tests = Json::makeArray();
    for (const auto& t : res.tests) {
        Json node = Json::makeObject();
        node["id"] = Json::makeInt(t.id);
        node["status"] = Json::makeString(statusToString(t.status));
        node["timeMs"] = Json::makeInt(t.timeMs);
        node["memoryKb"] = Json::makeInt(t.memoryKb);
        node["score"] = Json::makeInt(t.score);
        node["maxScore"] = Json::makeInt(t.maxScore);
        node["message"] = Json::makeString(t.message);
        node["stderr"] = Json::makeString(t.stderrText);
        node["actual"] = Json::makeString(t.actual);
        node["expected"] = Json::makeString(t.expected);
        node["diffLine"] = Json::makeInt(t.diffLine);
        tests.arrVal.push_back(node);
    }
    root["tests"] = tests;
    root["totalScore"] = Json::makeInt(res.totalScore);
    root["maxScore"] = Json::makeInt(res.maxScore);
    root["status"] = Json::makeString(statusToString(res.status));
    return root;
}

JudgeResult runJudge(const JudgeTask& task) {
    JudgeResult res;
    switch (task.problem.type) {
        case ProblemType::Traditional:
            res = runTraditional(task);
            break;
        case ProblemType::OutputOnly:
            res = runOutputOnly(task);
            break;
        case ProblemType::Interactive:
            res = runInteractive(task);
            break;
        case ProblemType::Communication:
            res = runCommunication(task);
            break;
        default:
            res.problem = task.problem.name;
            res.compileMessage = "未知题型";
            res.unimplemented = true;
            break;
    }
    res.format = task.problem.format;
    return res;
}

}  // namespace oi
