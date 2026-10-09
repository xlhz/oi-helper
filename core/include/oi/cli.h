#pragma once
#include <string>
#include <vector>

namespace oi {

struct CliOptions {
    std::string problemDir;
    std::string srcFile;
    std::vector<std::string> inFiles;   // 可重复, 第 i 个与第 i 个 outFiles 配对
    std::vector<std::string> outFiles;
    int timeMs = 1000;
    bool timeProvided = false;
    int memoryMb = 256;
    bool memoryProvided = false;
    int jobs = 1;
    std::string standard = "c++14";
    bool standardProvided = false;
    std::string optimize = "O2";
    bool optimizeProvided = false;
    std::string format;
    bool formatProvided = false;
    std::string env = "auto";
    bool envProvided = false;
    std::string checker = "diff";
    bool checkerProvided = false;
    double eps = 1e-6;
    bool epsProvided = false;
    std::string jsonPath = "result.json";
    bool pretty = false;
    bool showHelp = false;
    bool showVersion = false;
    int servePort = 0;

    // fetch 模式
    std::string fetchUrl;   // --fetch
    std::string fetchOut;   // --fetch-out
    std::string fetchUser;  // --fetch-user
    std::string fetchPass;  // --fetch-pass
    std::string fetchCookie;  // --fetch-cookie
    bool fetchInline = false; // --fetch-inline: 不落盘, 仅回传样例内容
    std::string fetchContest; // --fetch-contest: 抓取新版竞赛题目(/web/contest/{cid}/{num})
    std::string fetchExtra;    // --fetch-extra: 下载并解压「更多样例」链接
    std::string fetchExtraOut; // --fetch-extra-out: 解压目标目录
    std::string fetchOriginal; // --fetch-original: 抓取原题(洛谷/CF/AtCoder/Hydro)题面与样例
    bool fetchWinHttp = false; // --fetch-winhttp: 优先用内置网络库, 被拦再回退 curl

    // submit 模式
    std::string submitUrl;           // --submit
    std::string submitFile;          // --submit-file
    std::string submitLang = "cpp";  // --submit-lang, cpp|pas
    std::string submitOriginal;      // --submit-original: 直连提交到原题
    std::string submitCaptcha;       // --submit-captcha: 图形验证码(洛谷要求时)
    std::string submitResult;        // --submit-result: 查询某个提交的评测结果
    std::string resultOj;            // --result-oj: 结果查询的站点, xmoj(默认)|luogu
};

int runCli(int argc, char** argv);

}  // namespace oi
