#pragma once
#include <string>
#include "oi/types.h"

namespace oi {

// 从题目目录加载 problem.json; 缺省字段填默认值; tests 缺省时自动配对扫描
ProblemConfig loadProblem(const std::string& dir, std::string& err);

// 纯扫描: 自动配对 dir 下的 1.in/1.ans(兼容 1.out)、name1.in/name1.ans 等
std::vector<TestCase> scanTests(const std::string& dir, const std::string& name);

}  // namespace oi
