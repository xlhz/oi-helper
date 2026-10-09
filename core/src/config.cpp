#include "oi/config.h"

#include <algorithm>
#include <cctype>
#include <filesystem>
#include <fstream>
#include <sstream>

#include "oi/json.h"

namespace fs = std::filesystem;

namespace oi {

namespace {

bool readFile(const std::string& path, std::string& out) {
    std::ifstream in(path, std::ios::binary);
    if (!in) return false;
    std::ostringstream ss;
    ss << in.rdbuf();
    out = ss.str();
    return true;
}

// 提取字符串末尾的连续数字, 无则返回 -1
long long trailingNumber(const std::string& base) {
    size_t end = base.size();
    size_t start = end;
    while (start > 0 && std::isdigit(static_cast<unsigned char>(base[start - 1]))) --start;
    if (start == end) return -1;
    try {
        return std::stoll(base.substr(start, end - start));
    } catch (...) {
        return -1;
    }
}

}  // namespace

std::vector<TestCase> scanTests(const std::string& dir, const std::string& name) {
    std::vector<TestCase> result;
    std::error_code ec;
    if (!fs::is_directory(dir, ec)) return result;

    struct Entry {
        std::string base;
        std::string ext;
        long long num;
    };
    std::vector<Entry> entries;
    for (const auto& de : fs::directory_iterator(dir, ec)) {
        if (!de.is_regular_file()) continue;
        std::string fname = de.path().filename().string();
        if (fname.size() <= 3 || fname.substr(fname.size() - 3) != ".in") continue;
        std::string base = fname.substr(0, fname.size() - 3);
        // 只接受纯数字或 <name><数字> 形式
        if (base.empty()) continue;
        std::string stem = base;
        if (!name.empty() && stem.rfind(name, 0) == 0) {
            stem = stem.substr(name.size());
            if (stem.empty() || !std::isdigit(static_cast<unsigned char>(stem[0]))) continue;
        }
        // 样例输出优先 .ans, 兼容旧的 .out
        std::string ext;
        if (fs::exists(de.path().parent_path() / (base + ".ans"), ec)) {
            ext = ".ans";
        } else if (fs::exists(de.path().parent_path() / (base + ".out"), ec)) {
            ext = ".out";
        } else {
            continue;
        }
        entries.push_back({base, ext, trailingNumber(base)});
    }
    std::sort(entries.begin(), entries.end(), [](const Entry& a, const Entry& b) {
        if (a.num != b.num) {
            if (a.num < 0) return false;
            if (b.num < 0) return true;
            return a.num < b.num;
        }
        return a.base < b.base;
    });
    int id = 1;
    for (const auto& e : entries) {
        TestCase tc;
        tc.id = id++;
        tc.inputFile = e.base + ".in";
        tc.outputFile = e.base + e.ext;
        result.push_back(tc);
    }
    return result;
}

ProblemConfig loadProblem(const std::string& dir, std::string& err) {
    ProblemConfig cfg;
    cfg.dir = dir;
    fs::path dirPath(dir);
    cfg.name = dirPath.filename().string();
    if (cfg.name.empty()) cfg.name = "problem";
    // 去掉末尾分隔符造成的空名
    if (cfg.name == "." || cfg.name == "/" || cfg.name == "\\") cfg.name = "problem";

    std::string jsonPath = (dirPath / "problem.json").string();
    std::string text;
    if (!readFile(jsonPath, text)) {
        err = "无法读取 " + jsonPath;
        return cfg;
    }
    Json root;
    std::string perr;
    if (!Json::parse(text, root, perr)) {
        err = "problem.json 解析失败: " + perr;
        return cfg;
    }

    if (root.contains("name")) cfg.name = root["name"].getString(cfg.name);
    if (root.contains("type")) cfg.type = problemTypeFromString(root["type"].getString("traditional"));
    cfg.format = root["format"].getString("oi");
    if (cfg.format != "oi" && cfg.format != "icpc") cfg.format = "oi";
    cfg.timeLimit = static_cast<int>(root["timeLimit"].getInt(1000));
    cfg.memoryLimit = static_cast<int>(root["memoryLimit"].getInt(256));
    cfg.standard = root["standard"].getString("c++14");
    cfg.optimize = root["optimize"].getString("O2");
    cfg.checker = root["checker"].getString("diff");
    cfg.eps = root["eps"].getDouble(1e-6);
    if (root.contains("checkerFile")) cfg.checkerFile = root["checkerFile"].getString("checker.cpp");
    cfg.interactor = root["interactor"].getString("");
    if (root.contains("sources") && root["sources"].type == Json::Type::Array) {
        for (const auto& s : root["sources"].items()) {
            std::string name = s.getString("");
            if (!name.empty()) cfg.sources.push_back(name);
        }
    }

    if (root.contains("freopen")) {
        const Json& fr = root["freopen"];
        if (fr.contains("in") || fr.contains("out")) {
            cfg.freopen.enabled = true;
            cfg.freopen.in = fr["in"].getString("");
            cfg.freopen.out = fr["out"].getString("");
        }
    }

    if (root.contains("tests") && root["tests"].type == Json::Type::Array) {
        int autoId = 1;
        for (const auto& t : root["tests"].items()) {
            TestCase tc;
            tc.id = static_cast<int>(t["id"].getInt(autoId++));
            tc.inputFile = t["in"].getString("");
            tc.outputFile = t["out"].getString("");
            // output-only 可能只有 out 无 in; interactive in/out 均可能为空
            if (!tc.inputFile.empty() || !tc.outputFile.empty()) cfg.tests.push_back(tc);
        }
    }
    if (cfg.tests.empty()) {
        cfg.tests = scanTests(dir, cfg.name);
    }

    if (root.contains("subtasks") && root["subtasks"].type == Json::Type::Array) {
        for (const auto& s : root["subtasks"].items()) {
            Subtask st;
            st.id = static_cast<int>(s["id"].getInt(0));
            st.score = static_cast<int>(s["score"].getInt(0));
            if (s.contains("tests") && s["tests"].type == Json::Type::Array) {
                for (const auto& idv : s["tests"].items()) {
                    st.tests.push_back(static_cast<int>(idv.getInt(0)));
                }
            }
            cfg.subtasks.push_back(st);
        }
    }
    return cfg;
}

}  // namespace oi
