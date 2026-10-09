#include "oi/cli.h"

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>
#include <vector>

#include "oi/compiler.h"
#include "oi/config.h"
#include "oi/fetcher.h"
#include "oi/judge.h"
#include "oi/json.h"
#include "oi/server.h"

namespace fs = std::filesystem;

namespace oi {

namespace {

const char* kVersion = "0.1.0";

void printHelp() {
    std::cout <<
        "oi-judge - OI 评测核心\n"
        "用法: oi-judge [options]\n"
        "  --problem <dir>   评测题目目录(读取 problem.json)\n"
        "  --src <file>      单个源文件(与 --in/--out 搭配)\n"
        "  --in <file>       测试点输入, 可重复; 与 --out 按顺序配对\n"
        "  --out <file>      测试点预期输出, 可重复\n"
        "  --time <ms>       时限, 默认 1000\n"
        "  --memory <mb>     内存限制, 默认 256\n"
        "  --jobs <n>        并行度, 默认 1\n"
        "  --standard <std>  c++11|c++14|c++17|c++20, 默认 c++14\n"
        "  --optimize <o>    O0|O1|O2, 默认 O2\n"
        "  --env <e>         auto|wsl|mingw, 默认 auto\n"
        "  --checker <c>     diff|float|testlib, 默认 diff\n"
        "  --format <f>      oi|icpc, 默认 oi\n"
        "  --eps <x>         浮点误差, 默认 1e-6\n"
        "  --json <file>     结果输出路径, 默认 result.json\n"
        "  --pretty          JSON 美化\n"
        "  --serve <port>    启动本地 HTTP 评测服务(阻塞), 监听 POST /judge\n"
        "  --fetch <url>     抓取题目页(xmoj 或洛谷)并生成题目目录\n"
        "  --fetch-out <dir> 抓取输出基础目录, 默认当前工作目录\n"
        "  --fetch-user <u>  xmoj 登录用户名\n"
        "  --fetch-pass <p>  xmoj 登录密码\n"
        "  --fetch-cookie <c> 洛谷 Cookie(需登录题目时使用)\n"
        "  --fetch-inline    不落盘, 仅回传样例内容(JSON)\n"
        "  --fetch-contest <url> 抓取新版竞赛题目(/web/contest/{cid}/{num}), 回传 JSON\n"
        "  --fetch-extra <url> 下载竞赛「更多样例」压缩包并解压, 回传 JSON\n"
        "  --fetch-extra-out <dir> 「更多样例」解压目录\n"
        "  --fetch-original <url> 抓取原题(洛谷/CF/AtCoder/Hydro)题面与样例, 回传 JSON\n"
        "  --submit <url>    提交源码到 xmoj(题目页 URL), 需 --fetch-user/--fetch-pass\n"
        "  --submit-original <url> 直连提交源码到原题(洛谷/CF/AtCoder/Hydro), 需 --fetch-cookie\n"
        "  --submit-result <sid> 查询某个提交的评测结果\n"
        "  --result-oj <oj>  结果查询站点: xmoj(默认, 需 --fetch-user/--fetch-pass)|luogu(需 --fetch-cookie)|hydro(需 --fetch 传题目页地址)\n"
        "  --submit-file <f> 待提交的源码文件\n"
        "  --submit-lang <l> cpp|pas, 默认 cpp\n"
        "  --submit-captcha <c> 图形验证码(洛谷需要时)\n"
        "  --version / --help\n";
}

int toInt(const std::string& s, int def) {
    try {
        return std::stoi(s);
    } catch (...) {
        return def;
    }
}

double toDouble(const std::string& s, double def) {
    try {
        return std::stod(s);
    } catch (...) {
        return def;
    }
}

std::string stemOf(const std::string& path) {
    return fs::path(path).stem().string();
}

// 题目模式下未显式给 --src 时, 在题目目录里找默认选手源码
std::string findDefaultSource(const std::string& dir, const std::string& name) {
    const std::string preferred[] = {"a.cpp", "solution.cpp", "main.cpp", name + ".cpp"};
    for (const auto& p : preferred) {
        std::string cand = (fs::path(dir) / p).string();
        std::error_code ec;
        if (fs::is_regular_file(cand, ec)) return cand;
    }
    std::error_code ec;
    std::vector<std::string> found;
    for (const auto& de : fs::directory_iterator(dir, ec)) {
        if (!de.is_regular_file()) continue;
        std::string fn = de.path().filename().string();
        if (fn.size() > 4 && fn.substr(fn.size() - 4) == ".cpp" && fn != "checker.cpp" &&
            fn != "interactor.cpp") {
            found.push_back(de.path().string());
        }
    }
    std::sort(found.begin(), found.end());
    return found.empty() ? "" : found.front();
}

}  // namespace

int runCli(int argc, char** argv) {
    CliOptions opt;
    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        auto valueOf = [&](std::string& out) -> bool {
            if (i + 1 >= argc) return false;
            out = argv[++i];
            return true;
        };
        std::string v;
        if (a == "--help" || a == "-h") {
            opt.showHelp = true;
        } else if (a == "--version") {
            opt.showVersion = true;
        } else if (a == "--pretty") {
            opt.pretty = true;
        } else if (a == "--problem" && valueOf(v)) {
            opt.problemDir = v;
        } else if (a == "--src" && valueOf(v)) {
            opt.srcFile = v;
        } else if (a == "--in" && valueOf(v)) {
            opt.inFiles.push_back(v);
        } else if (a == "--out" && valueOf(v)) {
            opt.outFiles.push_back(v);
        } else if (a == "--time" && valueOf(v)) {
            opt.timeMs = toInt(v, 1000);
            opt.timeProvided = true;
        } else if (a == "--memory" && valueOf(v)) {
            opt.memoryMb = toInt(v, 256);
            opt.memoryProvided = true;
        } else if (a == "--jobs" && valueOf(v)) {
            opt.jobs = toInt(v, 1);
        } else if (a == "--standard" && valueOf(v)) {
            opt.standard = v;
            opt.standardProvided = true;
        } else if (a == "--optimize" && valueOf(v)) {
            opt.optimize = v;
            opt.optimizeProvided = true;
        } else if (a == "--env" && valueOf(v)) {
            opt.env = v;
            opt.envProvided = true;
        } else if (a == "--checker" && valueOf(v)) {
            opt.checker = v;
            opt.checkerProvided = true;
        } else if (a == "--format" && valueOf(v)) {
            opt.format = v;
            opt.formatProvided = true;
        } else if (a == "--eps" && valueOf(v)) {
            opt.eps = toDouble(v, 1e-6);
            opt.epsProvided = true;
        } else if (a == "--json" && valueOf(v)) {
            opt.jsonPath = v;
        } else if (a == "--serve" && valueOf(v)) {
            opt.servePort = toInt(v, 0);
        } else if (a == "--fetch" && valueOf(v)) {
            opt.fetchUrl = v;
        } else if (a == "--fetch-out" && valueOf(v)) {
            opt.fetchOut = v;
        } else if (a == "--fetch-user" && valueOf(v)) {
            opt.fetchUser = v;
        } else if (a == "--fetch-pass" && valueOf(v)) {
            opt.fetchPass = v;
        } else if (a == "--fetch-cookie" && valueOf(v)) {
            // 用户常直接粘贴多行 "cookie: k=v", 统一规范化后再用
            opt.fetchCookie = normalizeCookie(v);
        } else if (a == "--fetch-inline") {
            opt.fetchInline = true;
        } else if (a == "--fetch-contest" && valueOf(v)) {
            opt.fetchContest = v;
        } else if (a == "--fetch-extra" && valueOf(v)) {
            opt.fetchExtra = v;
        } else if (a == "--fetch-extra-out" && valueOf(v)) {
            opt.fetchExtraOut = v;
        } else if (a == "--fetch-winhttp") {
            opt.fetchWinHttp = true;
        } else if (a == "--fetch-original" && valueOf(v)) {
            opt.fetchOriginal = v;
        } else if (a == "--submit-original" && valueOf(v)) {
            opt.submitOriginal = v;
        } else if (a == "--submit-result" && valueOf(v)) {
            opt.submitResult = v;
        } else if (a == "--submit" && valueOf(v)) {
            opt.submitUrl = v;
        } else if (a == "--submit-file" && valueOf(v)) {
            opt.submitFile = v;
        } else if (a == "--submit-lang" && valueOf(v)) {
            opt.submitLang = v;
        } else if (a == "--submit-captcha" && valueOf(v)) {
            opt.submitCaptcha = v;
        } else if (a == "--result-oj" && valueOf(v)) {
            opt.resultOj = v;
        } else {
            std::cerr << "未知或缺少参数的选项: " << a << "\n";
            printHelp();
            return 1;
        }
    }

    if (opt.showVersion) {
        std::cout << "oi-judge " << kVersion << "\n";
        return 0;
    }
    if (opt.showHelp) {
        printHelp();
        return 0;
    }

    // 查询提交结果: 默认 HUSTOJ status-ajax.php, 洛谷走记录页内容接口
    if (!opt.submitResult.empty()) {
        SolutionResult sr;
        if (opt.resultOj == "luogu") {
            sr = fetchSolutionResultLuogu(std::atoll(opt.submitResult.c_str()), opt.fetchCookie);
        } else if (opt.resultOj == "hydro") {
            sr = fetchSolutionResultHydro(opt.submitResult, opt.fetchUrl, opt.fetchCookie);
        } else {
            sr = fetchSolutionResult(std::atoi(opt.submitResult.c_str()), opt.fetchUser, opt.fetchPass);
        }
        if (!sr.ok) {
            std::cerr << (sr.message.empty() ? "查询提交结果失败" : sr.message) << "\n";
            return 1;
        }
        Json root = Json::makeObject();
        root["ok"] = Json::makeBool(true);
        root["result"] = Json::makeInt(sr.result);
        root["timeMs"] = Json::makeInt(sr.timeMs);
        root["memoryKb"] = Json::makeInt(sr.memoryKb);
        root["finished"] = Json::makeBool(sr.finished);
        root["text"] = Json::makeString(sr.text);
        root["raw"] = Json::makeString(sr.raw);
        std::cout << root.dump(opt.pretty) << "\n";
        return 0;
    }

    // 原题直连提交(洛谷/CF/AtCoder)
    if (!opt.submitOriginal.empty()) {
        OriginalSubmitOptions oo;
        oo.url = opt.submitOriginal;
        oo.file = opt.submitFile;
        oo.lang = opt.submitLang;
        oo.cookie = opt.fetchCookie;
        oo.captcha = opt.submitCaptcha;
        OriginalSubmitResult osr = submitOriginal(oo);
        // 需要图形验证码: 回传图片与本次会话 Cookie, 由前端弹窗输入后重试
        if (osr.needCaptcha) {
            Json cap = Json::makeObject();
            cap["ok"] = Json::makeBool(false);
            cap["oj"] = Json::makeString(osr.oj);
            cap["needCaptcha"] = Json::makeBool(true);
            cap["captchaImage"] = Json::makeString(osr.captchaImage);
            cap["cookie"] = Json::makeString(osr.cookie);
            cap["message"] = Json::makeString(osr.message);
            std::cout << cap.dump(opt.pretty) << "\n";
            return 0;
        }
        if (!osr.ok) {
            std::cerr << (osr.message.empty() ? "提交失败" : osr.message) << "\n";
            return 1;
        }
        Json root = Json::makeObject();
        root["ok"] = Json::makeBool(true);
        root["oj"] = Json::makeString(osr.oj);
        root["submissionId"] = Json::makeString(osr.submissionId);
        root["recordPath"] = Json::makeString(osr.recordPath);
        root["message"] = Json::makeString(osr.message);
        root["cookie"] = Json::makeString(osr.cookie);
        std::cout << root.dump(opt.pretty) << "\n";
        return 0;
    }

    // 原题抓取(洛谷/CF/AtCoder/Hydro): 题面 + 样例
    if (!opt.fetchOriginal.empty()) {
        OriginalResult orr = fetchOriginal(opt.fetchOriginal, opt.fetchCookie, opt.fetchWinHttp);
        if (!orr.ok) {
            std::cerr << (orr.error.empty() ? "抓取原题失败" : orr.error) << "\n";
            return 1;
        }
        Json root = Json::makeObject();
        root["ok"] = Json::makeBool(true);
        root["oj"] = Json::makeString(orr.oj);
        root["url"] = Json::makeString(orr.url);
        root["title"] = Json::makeString(orr.title);
        root["html"] = Json::makeString(orr.html);
        root["md"] = Json::makeString(orr.md);
        root["submitUrl"] = Json::makeString(orr.submitUrl);
        Json samples = Json::makeArray();
        for (const FetchSample& s : orr.samples) {
            Json item = Json::makeObject();
            item["in"] = Json::makeString(s.in);
            item["out"] = Json::makeString(s.out);
            samples.arrVal.push_back(item);
        }
        root["samples"] = samples;
        std::cout << root.dump(opt.pretty) << "\n";
        return 0;
    }

    // submit 模式优先于抓取与评测
    if (!opt.submitUrl.empty()) {
        SubmitOptions so;
        so.url = opt.submitUrl;
        so.file = opt.submitFile;
        so.lang = opt.submitLang;
        so.user = opt.fetchUser;
        so.password = opt.fetchPass;
        SubmitResult sr = submitSolution(so);
        if (!sr.ok) {
            std::cerr << (sr.message.empty() ? "提交失败" : sr.message) << "\n";
            return 1;
        }
        Json root = Json::makeObject();
        root["ok"] = Json::makeBool(true);
        root["solutionId"] = Json::makeInt(sr.solutionId);
        root["problemId"] = Json::makeInt(sr.problemId);
        root["url"] = Json::makeString(sr.url);
        root["message"] = Json::makeString(sr.message);
        std::cout << root.dump(opt.pretty) << "\n";
        return 0;
    }

    // 竞赛题目抓取(新版 /web/contest 页面); 优先于普通抓取
    if (!opt.fetchContest.empty()) {
        FetchOptions fo;
        fo.url = opt.fetchContest;
        fo.user = opt.fetchUser;
        fo.password = opt.fetchPass;
        fo.pretty = opt.pretty;
        ContestResult cr = fetchContestProblem(fo);
        if (!cr.ok) {
            std::cerr << (cr.error.empty() ? "抓取竞赛题目失败" : cr.error) << "\n";
            return 1;
        }
        const ContestProblem& p = cr.problem;
        Json root = Json::makeObject();
        root["ok"] = Json::makeBool(true);
        root["contestId"] = Json::makeString(p.contestId);
        root["contestTitle"] = Json::makeString(p.contestTitle);
        root["num"] = Json::makeString(p.num);
        root["problemId"] = Json::makeString(p.problemId);
        root["title"] = Json::makeString(p.title);
        root["source"] = Json::makeString(p.source);
        root["timeLimit"] = Json::makeInt(p.timeMs);
        root["memoryLimit"] = Json::makeInt(p.memMb);
        root["description"] = Json::makeString(p.description);
        root["input"] = Json::makeString(p.input);
        root["output"] = Json::makeString(p.output);
        root["hint"] = Json::makeString(p.hint);
        root["dataRange"] = Json::makeString(p.dataRange);
        root["download"] = Json::makeString(p.download);
        root["startTime"] = Json::makeString(p.startTime);
        root["endTime"] = Json::makeString(p.endTime);
        root["leftSeconds"] = Json::makeInt(p.leftSeconds);
        root["classId"] = Json::makeString(p.classId);
        root["sessionEnd"] = Json::makeString(p.sessionEnd);
        root["fileIO"] = Json::makeBool(p.fileIO);
        root["freopenIn"] = Json::makeString(p.freopenIn);
        root["freopenOut"] = Json::makeString(p.freopenOut);
        root["state"] = Json::makeString(p.state);
        root["submitUrl"] = Json::makeString(p.submitUrl);
        Json samples = Json::makeArray();
        for (size_t i = 0; i < p.samples.size(); ++i) {
            Json item = Json::makeObject();
            item["in"] = Json::makeString(p.samples[i].in);
            item["out"] = Json::makeString(p.samples[i].out);
            item["explain"] = Json::makeString(i < p.explains.size() ? p.explains[i] : "");
            samples.arrVal.push_back(item);
        }
        root["samples"] = samples;
        Json items = Json::makeArray();
        for (const ContestItem& ci : p.problems) {
            Json item = Json::makeObject();
            item["num"] = Json::makeString(ci.num);
            item["title"] = Json::makeString(ci.title);
            item["problemId"] = Json::makeString(ci.problemId);
            items.arrVal.push_back(item);
        }
        root["problems"] = items;
        std::cout << root.dump(opt.pretty) << "\n";
        return 0;
    }

    // 竞赛「更多样例」下载解压
    if (!opt.fetchExtra.empty()) {
        FetchOptions fo;
        fo.user = opt.fetchUser;
        fo.password = opt.fetchPass;
        ExtraResult er = fetchExtraSamples(opt.fetchExtra, opt.fetchExtraOut, fo);
        if (!er.ok) {
            std::cerr << (er.error.empty() ? "下载样例失败" : er.error) << "\n";
            return 1;
        }
        Json root = Json::makeObject();
        root["ok"] = Json::makeBool(true);
        root["dir"] = Json::makeString(er.dir);
        Json files = Json::makeArray();
        for (const std::string& f : er.files) files.arrVal.push_back(Json::makeString(f));
        root["files"] = files;
        Json warns = Json::makeArray();
        for (const std::string& w : er.warnings) warns.arrVal.push_back(Json::makeString(w));
        root["warnings"] = warns;
        std::cout << root.dump(opt.pretty) << "\n";
        return 0;
    }

    // fetch 模式优先于评测逻辑
    if (!opt.fetchUrl.empty()) {
        FetchOptions fo;
        fo.url = opt.fetchUrl;
        fo.outBaseDir = opt.fetchOut;
        fo.user = opt.fetchUser;
        fo.password = opt.fetchPass;
        fo.cookie = opt.fetchCookie;
        fo.pretty = opt.pretty;
        fo.inlineSamples = opt.fetchInline;
        FetchResult fr = fetchProblem(fo);
        if (!fr.ok) {
            std::cerr << (fr.error.empty() ? "抓取失败" : fr.error) << "\n";
            return 1;
        }
        Json root = Json::makeObject();
        root["ok"] = Json::makeBool(true);
        root["pid"] = Json::makeInt(fr.pid);
        root["name"] = Json::makeString(fr.name);
        root["url"] = Json::makeString(fr.url);
        root["dir"] = Json::makeString(fr.dir);
        root["fileIO"] = Json::makeBool(fr.fileIO);
        root["tests"] = Json::makeInt(fr.tests);
        root["attachments"] = Json::makeInt(fr.attachments);
        root["source"] = Json::makeString(fr.source);
        root["freopenIn"] = Json::makeString(fr.freopenIn);
        root["freopenOut"] = Json::makeString(fr.freopenOut);
        if (opt.fetchInline) {
            Json samples = Json::makeArray();
            for (const auto& s : fr.samples) {
                Json item = Json::makeObject();
                item["in"] = Json::makeString(s.in);
                item["out"] = Json::makeString(s.out);
                samples.arrVal.push_back(item);
            }
            root["samples"] = samples;
        }
        Json warns = Json::makeArray();
        for (const auto& w : fr.warnings) warns.arrVal.push_back(Json::makeString(w));
        root["warnings"] = warns;
        std::cout << root.dump(opt.pretty) << "\n";
        return 0;
    }

    if (opt.servePort > 0) {
        return serveHttp(opt.servePort);
    }

    JudgeTask task;
    task.env = opt.env;
    task.jobs = opt.jobs;
    task.jsonPath = opt.jsonPath;
    task.pretty = opt.pretty;

    if (!opt.problemDir.empty()) {
        std::string err;
        task.problem = loadProblem(opt.problemDir, err);
        if (!err.empty()) {
            std::cerr << err << "\n";
            return 1;
        }
        task.srcFile = opt.srcFile;
        if (task.problem.type == ProblemType::OutputOnly) {
            if (task.srcFile.empty()) {
                std::cerr << "output-only 题型需要通过 --src 指定提交文件\n";
                return 1;
            }
        } else if (task.problem.type == ProblemType::Communication) {
            if (task.problem.sources.size() < 2) {
                std::cerr << "communication 题型需要在 problem.json 配置至少 2 个 sources\n";
                return 1;
            }
        } else {
            if (task.srcFile.empty()) {
                task.srcFile = findDefaultSource(opt.problemDir, task.problem.name);
            }
            if (task.srcFile.empty()) {
                std::cerr << "未指定 --src, 且题目目录中未找到 .cpp 源文件\n";
                return 1;
            }
        }
        if (opt.timeProvided) task.problem.timeLimit = opt.timeMs;
        if (opt.memoryProvided) task.problem.memoryLimit = opt.memoryMb;
        if (opt.standardProvided) task.problem.standard = opt.standard;
        if (opt.optimizeProvided) task.problem.optimize = opt.optimize;
        if (opt.checkerProvided) task.problem.checker = opt.checker;
        if (opt.formatProvided) task.problem.format = (opt.format == "icpc" ? "icpc" : "oi");
        if (opt.epsProvided) task.problem.eps = opt.eps;
    } else if (!opt.srcFile.empty()) {
        if (opt.inFiles.empty() || opt.inFiles.size() != opt.outFiles.size()) {
            std::cerr << "单文件模式需要成对的 --in 与 --out\n";
            return 1;
        }
        task.singleFile = true;
        task.srcFile = opt.srcFile;
        ProblemConfig& cfg = task.problem;
        cfg.name = stemOf(opt.srcFile);
        cfg.dir = "";
        cfg.type = ProblemType::Traditional;
        cfg.timeLimit = opt.timeMs;
        cfg.memoryLimit = opt.memoryMb;
        cfg.standard = opt.standard;
        cfg.optimize = opt.optimize;
        cfg.checker = opt.checker;
        cfg.format = opt.formatProvided ? (opt.format == "icpc" ? "icpc" : "oi") : "oi";
        cfg.eps = opt.eps;
        for (size_t i = 0; i < opt.inFiles.size(); ++i) {
            TestCase tc;
            tc.id = static_cast<int>(i + 1);
            tc.inputFile = opt.inFiles[i];
            tc.outputFile = opt.outFiles[i];
            cfg.tests.push_back(tc);
        }
    } else {
        std::cerr << "需要 --problem 或 --src\n";
        printHelp();
        return 1;
    }

    if (task.problem.tests.empty()) {
        std::cerr << "没有可用的测试点\n";
        return 1;
    }

    // output-only 不编译, 无需 g++
    if (task.problem.type != ProblemType::OutputOnly && findGpp().empty()) {
        std::cerr << "编译环境不可用: 未找到 g++\n";
        return 2;
    }

    JudgeResult res = runJudge(task);
    if (res.unimplemented) {
        std::cerr << res.compileMessage << "\n";
        return 1;
    }

    Json root = buildResultJson(res);
    std::string out = root.dump(opt.pretty);
    std::ofstream ofs(opt.jsonPath, std::ios::binary | std::ios::trunc);
    if (!ofs) {
        std::cerr << "无法写入结果文件: " << opt.jsonPath << "\n";
        return 1;
    }
    ofs << out;
    if (opt.pretty) ofs << "\n";
    ofs.close();

    std::cout << res.problem << ": " << statusToString(res.status) << " " << res.totalScore << "/"
              << res.maxScore << " (" << res.tests.size() << " tests) -> " << opt.jsonPath << "\n";
    return 0;
}

}  // namespace oi
