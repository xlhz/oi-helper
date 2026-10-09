#pragma once
#include <memory>
#include <string>
#include <vector>

namespace oi {

struct RunLimits {
    int timeLimitMs = 1000;
    int memoryLimitMb = 256;
    int processLimit = 1;
};

struct RunInput {
    std::string exePath;
    std::string workDir;
    std::string stdinFile;   // 空则接 NUL
    std::string stdoutFile;  // 空则接 NUL
    std::string stderrFile;  // 空则接 NUL
    RunLimits limits;
};

struct RunResult {
    bool started = false;
    int exitCode = -1;
    long long timeMs = 0;
    long long memoryKb = 0;
    bool timeout = false;
    bool memoryExceeded = false;
    std::string error;
};

// 运行器抽象基类: 后续可插入 WSL+isolate 实现
class Runner {
public:
    virtual ~Runner() = default;
    virtual std::string name() const = 0;       // mingw / wsl
    virtual std::string isolation() const = 0;  // jobobject / isolate / none
    virtual RunResult run(const RunInput& input) = 0;
};

// 按 env(auto|wsl|mingw) 创建运行器; env 不可用时降级并置 degraded=true
std::unique_ptr<Runner> createRunner(const std::string& env, bool& degraded);

// 双进程交叉管道运行(交互题/通信题): A.stdout<->B.stdin, B.stdout<->A.stdin
struct DualRunInput {
    std::string exeA;
    std::string exeB;
    std::string workDir;
    std::vector<std::string> argsA;  // 追加到 A 命令行
    std::vector<std::string> argsB;  // 追加到 B 命令行
    bool pipeAstdin = true;          // true: A.stdin <- B.stdout; false: 用 stdinFileA
    bool pipeAstdout = true;         // true: A.stdout -> B.stdin; false: 用 stdoutFileA
    std::string stdinFileA;          // pipeAstdin=false 时使用; 空则 NUL
    std::string stdoutFileA;         // pipeAstdout=false 时使用; 空则 NUL
    std::string stderrFileA;
    std::string stderrFileB;
    RunLimits limits;
};

struct DualRunResult {
    bool started = false;
    int exitCodeA = -1;
    int exitCodeB = -1;
    long long timeMs = 0;
    long long memoryKb = 0;
    bool timeout = false;
    bool memoryExceeded = false;
    std::string error;
};

DualRunResult runDual(const DualRunInput& input);

}  // namespace oi
