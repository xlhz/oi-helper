#pragma once
#include <string>
#include <vector>

namespace oi {

// 抓取题目页的输入参数
struct FetchOptions {
    std::string url;         // 题目页 URL
    std::string outBaseDir;  // 输出基础目录, 为空取当前工作目录
    std::string user;        // 登录用户名, 为空则不登录
    std::string password;    // 登录密码
    std::string cookie;      // 附加 Cookie 头(洛谷用), 为空则不带
    bool pretty = false;
    bool inlineSamples = false;  // 内联: 不落盘, 仅回传样例内容
};

// 单个样例(输入/输出内容)
struct FetchSample {
    std::string in;
    std::string out;
};

// 抓取结果; ok 为 true 时已完成落盘(内联模式除外)
struct FetchResult {
    bool ok = false;
    int pid = 0;
    std::string name;
    std::string url;
    std::string dir;
    bool fileIO = false;
    int tests = 0;
    int attachments = 0;
    std::string source;  // 题目来源(如 CF1760G), 用于原题功能
    std::string freopenIn;   // 文件 IO 题目的输入文件名, 供填 freopen 使用
    std::string freopenOut;  // 文件 IO 题目的输出文件名
    std::vector<FetchSample> samples;  // 内联模式回传的样例内容
    std::vector<std::string> warnings;
    std::string error;  // ok 为 false 时的中文错误
};

// 洛谷题目难度查询结果
struct DifficultyResult {
    bool ok = false;
    std::string pid;
    int difficulty = -1;  // 0..7, -1 表示未知
    std::string text;     // 中文难度名
    std::string error;
};

// 查询洛谷题目难度(pid 形如 P1403); cookie 为洛谷登录 Cookie(可空)
DifficultyResult fetchLuoguDifficulty(const std::string& pid, const std::string& cookie);

// 洛谷题目检索结果项
struct LuoguSearchItem {
    std::string pid;
    std::string name;
};

// 洛谷题目检索结果
struct LuoguSearchResult {
    bool ok = false;
    std::vector<LuoguSearchItem> items;
    std::string error;
};

// 按关键词检索洛谷题目(竞赛题 source 非题号时用于定位原题); cookie 可空
LuoguSearchResult searchLuogu(const std::string& keyword, const std::string& cookie);

// 抓取 xmoj 题目页并生成题目目录; 失败时不产生半成品目录
FetchResult fetchProblem(const FetchOptions& opt);

// 竞赛题目列表项(供上一题/下一题/选题使用)
struct ContestItem {
    std::string num;        // A/B/C...
    std::string title;
    std::string problemId;
};

// 新版 xmoj 竞赛题目(/web/contest/{cid}/{num})抓取结果; HTML 字段交由前端转 Markdown
struct ContestProblem {
    std::string contestId;
    std::string contestTitle;
    std::string num;
    std::string problemId;
    std::string title;
    std::string source;
    int timeMs = 1000;  // 秒 * 1000
    int memMb = 256;
    std::string description;
    std::string input;
    std::string output;
    std::string hint;
    std::string dataRange;
    std::string download;
    std::string startTime;   // 开始时间(个人时间线优先)
    std::string endTime;     // 结束时间(个人时间线优先); rule 1/2 的比赛为比赛结束(onsiteEndTime)
    std::string correctionEnd;  // 补题截止(rule 1/2 的比赛, 即原 endTime; 其余为空)
    std::string classId;     // 所属班级
    std::string sessionEnd;  // 训练会话截止(本场个人时间线, 无则取同班当前生效的个人时间线)
    bool fileIO = false;     // 是否文件 IO(新版接口用 name 表示)
    std::string freopenIn;   // 文件 IO 输入文件名
    std::string freopenOut;  // 文件 IO 输出文件名
    int leftSeconds = -1;    // 服务器给出的剩余秒数, -1 表示未知
    std::string state;       // 比赛状态: pending/running/ended
    std::vector<FetchSample> samples;
    std::vector<std::string> explains;  // 与 samples 一一对应, 可为空串
    std::vector<ContestItem> problems;
    std::string submitUrl;
};

struct ContestResult {
    bool ok = false;
    ContestProblem problem;
    std::string error;
};

// 抓取 xmoj 新版竞赛题目(/web/contest/{cid}/{num}), 需登录会话
ContestResult fetchContestProblem(const FetchOptions& opt);

// 竞赛题目「更多样例」压缩包的下载解压结果
struct ExtraResult {
    bool ok = false;
    std::string dir;                 // 解压后的目录
    std::vector<std::string> files;  // 目录下的文件(相对 dir, 已排序)
    std::vector<std::string> warnings;
    std::string error;  // ok 为 false 时的中文错误
};

// 下载竞赛题目的「更多样例」链接并解压到 outDir; 需登录会话
ExtraResult fetchExtraSamples(const std::string& url, const std::string& outDir, const FetchOptions& opt);

// 原题(洛谷/Codeforces/AtCoder/Hydro)抓取结果
struct OriginalResult {
    bool ok = false;
    std::string oj;       // luogu/codeforces/atcoder/hydro
    std::string url;      // 题目页地址
    std::string title;
    std::string html;     // 题面 HTML, 由前端转 Markdown
    std::string md;       // 题面 Markdown(洛谷内容接口直接给 Markdown)
    std::string submitUrl;
    std::vector<FetchSample> samples;
    std::string error;  // ok 为 false 时的中文错误
};

// 抓取原题题面与样例; cookie 为对应 OJ 的登录 Cookie(可空);
// preferWinHttp 为 true 时先用内置网络库, 被站点拦截再回退 curl
OriginalResult fetchOriginal(const std::string& url, const std::string& cookie, bool preferWinHttp = true);

// 规范化用户粘贴的 Cookie: 去掉 "Cookie:" 前缀与换行, 统一为 "k=v; k=v"
std::string normalizeCookie(const std::string& raw);

// 直连提交到原题的参数
struct OriginalSubmitOptions {
    std::string url;           // 原题页地址
    std::string file;          // 源码文件路径
    std::string lang = "cpp";  // cpp|pas
    std::string cookie;        // 对应 OJ 的登录 Cookie
    std::string captcha;       // 图形验证码(洛谷要求时由用户输入)
};

// 直连提交结果; ok 为 false 时 message 为中文错误说明
struct OriginalSubmitResult {
    bool ok = false;
    std::string oj;
    std::string submissionId;
    std::string recordPath;     // 记录页路径(Hydro 用, 如 /d/PHIOITeam/record/xxx)
    std::string message;
    bool needCaptcha = false;   // 需要图形验证码: 前端取图给用户输入后重试
    std::string captchaImage;   // 验证码图片(data:image/...;base64,...)
    std::string cookie;         // 本次会话更新后的 Cookie, 重试时原样带回
};

// 直连提交源码到原题; 失败不抛异常
OriginalSubmitResult submitOriginal(const OriginalSubmitOptions& opt);

// 提交源码到 xmoj 的参数
struct SubmitOptions {
    std::string url;           // 题目页 URL
    std::string file;          // 源码文件路径
    std::string lang = "cpp";  // cpp|pas
    std::string user;          // 登录用户名
    std::string password;      // 登录密码
};

// 提交结果; ok 为 false 时 message 为中文错误说明
struct SubmitResult {
    bool ok = false;
    int solutionId = 0;
    int problemId = 0;
    std::string url;      // 提交后的状态页地址
    std::string message;  // 中文结果说明
};

// 登录后将源码提交到 xmoj; 失败不抛异常
SubmitResult submitSolution(const SubmitOptions& opt);

// 提交结果查询(HUSTOJ status-ajax.php)
struct SolutionResult {
    bool ok = false;
    int result = -1;        // 结果码, 4=AC
    int timeMs = 0;
    int memoryKb = 0;
    bool finished = false;  // 已出结果(结果码 >= 4)
    std::string text;       // 中文结果名
    std::string message;    // ok 为 false 时的中文错误
    std::string raw;        // 服务端原始响应片段(排查用, 可空)
};

// 查询某个提交的评测结果; 需登录会话
SolutionResult fetchSolutionResult(int solutionId, const std::string& user,
                                   const std::string& password);

// 查询洛谷提交结果(记录页内容接口); 需登录 Cookie
SolutionResult fetchSolutionResultLuogu(long long rid, const std::string& cookie);

// 查询 Hydro 提交结果(记录页); rid 为记录页路径(如 /d/PHIOITeam/record/xxx)或提交号,
// base 为题目页地址(用来取站点根)
SolutionResult fetchSolutionResultHydro(const std::string& rid, const std::string& base, const std::string& cookie);

}  // namespace oi
