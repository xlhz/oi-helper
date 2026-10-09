#pragma once
#include <string>
#include "oi/types.h"

namespace oi {

struct CompileOptions {
    std::string standard = "c++14";
    std::string optimize = "O2";
};

struct CompileResult {
    bool success = false;
    std::string message;
    std::string exePath;
};

// 定位 g++: PATH 优先, 回退 D:\mingw64\bin\g++.exe; 找不到返回空
std::string findGpp();

// 把 g++ 所在目录前置到 PATH, 使子进程能加载 MinGW 运行库
void prependToolchainPath(const std::string& gppPath);

struct ProcResult {
    bool started = false;
    int exitCode = -1;
};

// 直接以 CreateProcess 运行命令(不经 cmd), stdout/stderr 可重定向到文件(空则丢弃)
ProcResult runProcess(const std::string& cmdLine, const std::string& workDir,
                      const std::string& stdoutFile, const std::string& stderrFile);

// 编译源码到 exePath; 失败时 message 为 stderr 摘要
CompileResult compileSource(const std::string& srcFile, const std::string& exePath,
                            const CompileOptions& opts);

}  // namespace oi
