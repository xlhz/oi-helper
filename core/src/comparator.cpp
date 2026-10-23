#include "oi/comparator.h"

#include <cmath>
#include <cstdlib>
#include <fstream>
#include <sstream>
#include <vector>

namespace oi {

namespace {

std::vector<std::string> readLines(const std::string& path, bool& opened) {
    std::ifstream in(path, std::ios::binary);
    if (!in) {
        opened = false;
        return {};
    }
    opened = true;
    std::ostringstream ss;
    ss << in.rdbuf();
    std::string data = ss.str();
    std::vector<std::string> lines;
    std::string cur;
    for (char c : data) {
        if (c == '\n') {
            if (!cur.empty() && cur.back() == '\r') cur.pop_back();
            // 去掉行末空格/制表符
            while (!cur.empty() && (cur.back() == ' ' || cur.back() == '\t')) cur.pop_back();
            lines.push_back(cur);
            cur.clear();
        } else {
            cur.push_back(c);
        }
    }
    if (!cur.empty()) {
        while (!cur.empty() && (cur.back() == ' ' || cur.back() == '\t')) cur.pop_back();
        lines.push_back(cur);
    }
    // 去掉文末空行
    while (!lines.empty() && lines.back().empty()) lines.pop_back();
    return lines;
}

std::vector<std::string> tokenize(const std::string& line) {
    std::vector<std::string> toks;
    std::istringstream iss(line);
    std::string t;
    while (iss >> t) toks.push_back(t);
    return toks;
}

bool parseNumber(const std::string& t, double& v) {
    if (t.empty()) return false;
    char* endp = nullptr;
    v = std::strtod(t.c_str(), &endp);
    return endp != nullptr && *endp == '\0';
}

std::string lineMessage(size_t lineNo, const std::string& pa, const std::string& ans) {
    return "第 " + std::to_string(lineNo) + " 行不同: 选手=\"" + pa + "\" 期望=\"" + ans + "\"";
}

}  // namespace

CompareResult compareDiff(const std::string& participantFile, const std::string& answerFile) {
    CompareResult r;
    bool pOpen = false, aOpen = false;
    std::vector<std::string> pa = readLines(participantFile, pOpen);
    std::vector<std::string> ans = readLines(answerFile, aOpen);
    if (!aOpen) {
        r.message = "无法读取标准答案文件";
        return r;
    }
    if (!pOpen) {
        r.message = "无法读取选手输出文件";
        return r;
    }
    size_t n = std::min(pa.size(), ans.size());
    for (size_t i = 0; i < n; ++i) {
        if (pa[i] != ans[i]) {
            r.message = lineMessage(i + 1, pa[i], ans[i]);
            r.line = static_cast<int>(i + 1);
            return r;
        }
    }
    if (pa.size() != ans.size()) {
        r.message = "行数不同: 选手=" + std::to_string(pa.size()) + " 期望=" +
                    std::to_string(ans.size());
        r.line = static_cast<int>(n + 1);
        return r;
    }
    r.equal = true;
    return r;
}

CompareResult compareFloat(const std::string& participantFile, const std::string& answerFile,
                           double eps) {
    CompareResult r;
    bool pOpen = false, aOpen = false;
    std::vector<std::string> pa = readLines(participantFile, pOpen);
    std::vector<std::string> ans = readLines(answerFile, aOpen);
    if (!aOpen) {
        r.message = "无法读取标准答案文件";
        return r;
    }
    if (!pOpen) {
        r.message = "无法读取选手输出文件";
        return r;
    }
    if (pa.size() != ans.size()) {
        r.message = "行数不同: 选手=" + std::to_string(pa.size()) + " 期望=" +
                    std::to_string(ans.size());
        r.line = static_cast<int>(std::min(pa.size(), ans.size()) + 1);
        return r;
    }
    for (size_t i = 0; i < pa.size(); ++i) {
        std::vector<std::string> tp = tokenize(pa[i]);
        std::vector<std::string> ta = tokenize(ans[i]);
        if (tp.size() != ta.size()) {
            r.message = "第 " + std::to_string(i + 1) + " 行 token 数不同";
            r.line = static_cast<int>(i + 1);
            return r;
        }
        for (size_t j = 0; j < tp.size(); ++j) {
            double x = 0, y = 0;
            bool nx = parseNumber(tp[j], x);
            bool ny = parseNumber(ta[j], y);
            bool eq;
            if (nx && ny) {
                eq = std::fabs(x - y) <= eps;
            } else {
                eq = (tp[j] == ta[j]);
            }
            if (!eq) {
                r.message = "第 " + std::to_string(i + 1) + " 行第 " + std::to_string(j + 1) +
                            " 个 token 不同: 选手=\"" + tp[j] + "\" 期望=\"" + ta[j] + "\"";
                r.line = static_cast<int>(i + 1);
                return r;
            }
        }
    }
    r.equal = true;
    return r;
}

}  // namespace oi
