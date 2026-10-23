#pragma once
#include <string>
#include <vector>

namespace oi {

// 判定状态
enum class Status { AC, WA, TLE, MLE, RE, CE };

std::string statusToString(Status s);

// 题型
enum class ProblemType { Traditional, Interactive, OutputOnly, Communication };

std::string problemTypeToString(ProblemType t);
ProblemType problemTypeFromString(const std::string& s);

// 单个测试点
struct TestCase {
    int id = 0;
    std::string inputFile;
    std::string outputFile;
};

// 子任务
struct Subtask {
    int id = 0;
    int score = 0;
    std::vector<int> tests;
};

// freopen 配置
struct FreopenConfig {
    bool enabled = false;
    std::string in;
    std::string out;
};

// 题目配置
struct ProblemConfig {
    std::string name;
    std::string dir;   // 题目目录
    ProblemType type = ProblemType::Traditional;
    int timeLimit = 1000;   // ms
    int memoryLimit = 256;  // MB
    std::string standard = "c++14";
    std::string optimize = "O2";
    std::string format = "oi";  // 赛制: oi|icpc
    std::string checker = "diff";
    double eps = 1e-6;
    FreopenConfig freopen;
    std::vector<TestCase> tests;
    std::vector<Subtask> subtasks;
    std::string checkerFile = "checker.cpp";
    std::string interactor;            // interactive: 相对题目目录的 .cpp
    std::vector<std::string> sources;  // communication: 相对题目目录的多个 .cpp
};

// 一次评测请求
struct JudgeTask {
    ProblemConfig problem;
    std::string srcFile;
    int jobs = 1;
    std::string env = "auto";
    std::string jsonPath = "result.json";
    bool pretty = false;
    bool singleFile = false;
};

// 单测试点结果
struct TestResult {
    int id = 0;
    Status status = Status::AC;
    long long timeMs = 0;
    long long memoryKb = 0;
    int score = 0;
    int maxScore = 0;
    std::string message;
    std::string stderrText;  // RE 时程序标准错误(截断)
    std::string actual;      // WA 时选手实际输出(截断)
    std::string expected;    // WA 时标准答案(截断)
    int diffLine = 0;        // 首个不同行号, 0 表示未知
};

// 子任务结果
struct SubtaskResult {
    int id = 0;
    int score = 0;
    int maxScore = 0;
    std::vector<int> tests;
};

// 汇总结果
struct JudgeResult {
    std::string problem;
    std::string format = "oi";  // 赛制: oi|icpc
    std::string env;
    std::string isolation;
    bool isolationDegraded = false;
    std::string compileMessage;
    std::vector<SubtaskResult> subtasks;
    std::vector<TestResult> tests;
    int totalScore = 0;
    int maxScore = 0;
    Status status = Status::AC;
    bool unimplemented = false;  // 题型未实现, 不序列化
};

}  // namespace oi
