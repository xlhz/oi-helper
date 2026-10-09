#pragma once
#include <string>

namespace oi {

struct CompareResult {
    bool equal = false;
    std::string message;
};

// CCF 规则逐行比对: 忽略行末空格/制表符、文末空行、CR
CompareResult compareDiff(const std::string& participantFile, const std::string& answerFile);

// 浮点比对: 逐 token, 数值按 |a-b|<=eps 视为相等; 非数值 token 精确比较
CompareResult compareFloat(const std::string& participantFile, const std::string& answerFile,
                           double eps);

}  // namespace oi
