#pragma once
#include <string>
#include "oi/comparator.h"

namespace oi {

// 编译题目目录下的 checker.cpp (需 testlib.h); 失败时 message 为 stderr 摘要
struct CheckerCompileResult {
    bool success = false;
    std::string exePath;
    std::string message;
};

CheckerCompileResult compileChecker(const std::string& checkerSrc, const std::string& exePath,
                                    const std::string& includeDir);

// 以三文件参数调用 checker: 退出码 0 视为 AC, 非 0 视为 WA, stderr 存入 message
CompareResult runTestlibChecker(const std::string& checkerExe, const std::string& inputFile,
                                const std::string& participantFile, const std::string& answerFile,
                                const std::string& workDir);

}  // namespace oi
