#include "oi/checker.h"

#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>

#include "oi/compiler.h"

namespace fs = std::filesystem;

namespace oi {

namespace {

bool fileExists(const std::string& p) {
    std::error_code ec;
    return fs::is_regular_file(p, ec);
}

std::string readAll(const std::string& path) {
    std::ifstream in(path, std::ios::binary);
    if (!in) return "";
    std::ostringstream ss;
    ss << in.rdbuf();
    return ss.str();
}

std::string resolveTestlibDir(const std::string& checkerSrc) {
    std::vector<std::string> candidates;
    if (const char* e = std::getenv("OI_TESTLIB")) candidates.push_back(e);
    candidates.push_back("testlib");
    candidates.push_back("../testlib");
    candidates.push_back("../../testlib");
    fs::path srcDir = fs::path(checkerSrc).parent_path();
    candidates.push_back((srcDir / ".." / "testlib").string());
    candidates.push_back((srcDir / ".." / ".." / "testlib").string());
    for (const auto& c : candidates) {
        if (c.empty()) continue;
        if (fileExists((fs::path(c) / "testlib.h").string())) return c;
    }
    return "";
}

}  // namespace

CheckerCompileResult compileChecker(const std::string& checkerSrc, const std::string& exePath,
                                    const std::string& includeDir) {
    CheckerCompileResult r;
    std::string dir = includeDir.empty() ? resolveTestlibDir(checkerSrc) : includeDir;
    if (dir.empty() || !fileExists((fs::path(dir) / "testlib.h").string())) {
        r.message = "未找到 testlib.h (可用 OI_TESTLIB 指定目录)";
        return r;
    }
    std::string gpp = findGpp();
    if (gpp.empty()) {
        r.message = "未找到 g++ 编译器";
        return r;
    }
    std::error_code ec;
    fs::create_directories(fs::path(exePath).parent_path(), ec);
    std::string logPath = exePath + ".log";
    std::string cmdLine = "\"" + gpp + "\" -O2 -std=c++17 -I\"" + dir + "\" \"" + checkerSrc +
                          "\" -o \"" + exePath + "\"";
    ProcResult pr = runProcess(cmdLine, "", "", logPath);
    if (pr.started && pr.exitCode == 0 && fileExists(exePath)) {
        r.success = true;
        r.exePath = exePath;
    } else {
        r.message = readAll(logPath);
    }
    return r;
}

CompareResult runTestlibChecker(const std::string& checkerExe, const std::string& inputFile,
                                const std::string& participantFile, const std::string& answerFile,
                                const std::string& workDir) {
    CompareResult r;
    std::error_code ec;
    std::string errPath = (fs::path(workDir) / "checker.err").string();
    std::string inAbs = fs::absolute(inputFile, ec).string();
    std::string outAbs = fs::absolute(participantFile, ec).string();
    std::string ansAbs = fs::absolute(answerFile, ec).string();
    std::string cmdLine = "\"" + checkerExe + "\" \"" + inAbs + "\" \"" + outAbs + "\" \"" +
                          ansAbs + "\"";
    ProcResult pr = runProcess(cmdLine, workDir, "", errPath);
    std::string err = readAll(errPath);
    while (!err.empty() && (err.back() == '\n' || err.back() == '\r')) err.pop_back();
    r.message = err;
    r.equal = pr.started && pr.exitCode == 0;
    if (!r.equal && err.empty()) {
        r.message = pr.started ? ("checker 退出码 " + std::to_string(pr.exitCode))
                               : "无法启动 checker";
    }
    return r;
}

}  // namespace oi
