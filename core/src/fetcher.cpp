#include "oi/fetcher.h"

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#include <winhttp.h>
#endif

#include "oi/json.h"

namespace fs = std::filesystem;

namespace oi {

namespace {

// ---------- 通用字符串工具 ----------

std::string trim(const std::string& s) {
    size_t b = 0;
    size_t e = s.size();
    while (b < e && std::isspace(static_cast<unsigned char>(s[b]))) ++b;
    while (e > b && std::isspace(static_cast<unsigned char>(s[e - 1]))) --e;
    return s.substr(b, e - b);
}

// 取字符串中第一段连续数字, 无则返回 -1
int leadingInt(const std::string& s) {
    size_t i = 0;
    while (i < s.size() && !std::isdigit(static_cast<unsigned char>(s[i]))) ++i;
    if (i >= s.size()) return -1;
    long long v = 0;
    while (i < s.size() && std::isdigit(static_cast<unsigned char>(s[i]))) {
        v = v * 10 + (s[i] - '0');
        ++i;
    }
    return static_cast<int>(v);
}

void appendUtf8(std::string& out, unsigned code) {
    if (code < 0x80) {
        out.push_back(static_cast<char>(code));
    } else if (code < 0x800) {
        out.push_back(static_cast<char>(0xC0 | (code >> 6)));
        out.push_back(static_cast<char>(0x80 | (code & 0x3F)));
    } else {
        out.push_back(static_cast<char>(0xE0 | (code >> 12)));
        out.push_back(static_cast<char>(0x80 | ((code >> 6) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | (code & 0x3F)));
    }
}

// 解码常见 HTML 实体
std::string htmlDecode(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    size_t i = 0;
    while (i < s.size()) {
        if (s[i] != '&') {
            out.push_back(s[i++]);
            continue;
        }
        if (s.compare(i, 5, "&lt;") == 0) {
            out.push_back('<');
            i += 5;
        } else if (s.compare(i, 5, "&gt;") == 0) {
            out.push_back('>');
            i += 5;
        } else if (s.compare(i, 6, "&amp;") == 0) {
            out.push_back('&');
            i += 6;
        } else if (s.compare(i, 6, "&quot;") == 0) {
            out.push_back('"');
            i += 6;
        } else if (s.compare(i, 5, "&#39;") == 0) {
            out.push_back('\'');
            i += 5;
        } else if (s.compare(i, 6, "&nbsp;") == 0) {
            out.push_back(' ');
            i += 6;
        } else if (i + 1 < s.size() && s[i + 1] == '#') {
            // 数字实体 &#DDD; / &#xHH;
            size_t j = i + 2;
            bool hex = false;
            if (j < s.size() && (s[j] == 'x' || s[j] == 'X')) {
                hex = true;
                ++j;
            }
            size_t start = j;
            unsigned code = 0;
            while (j < s.size()) {
                char c = s[j];
                int d = -1;
                if (c >= '0' && c <= '9') d = c - '0';
                else if (hex && c >= 'a' && c <= 'f') d = c - 'a' + 10;
                else if (hex && c >= 'A' && c <= 'F') d = c - 'A' + 10;
                else break;
                code = code * (hex ? 16u : 10u) + static_cast<unsigned>(d);
                ++j;
            }
            if (j > start && j < s.size() && s[j] == ';') {
                appendUtf8(out, code);
                i = j + 1;
            } else {
                out.push_back(s[i++]);
            }
        } else {
            out.push_back(s[i++]);
        }
    }
    return out;
}

std::string stripTags(const std::string& s) {
    std::string out;
    bool inTag = false;
    for (char c : s) {
        if (c == '<') inTag = true;
        else if (c == '>') inTag = false;
        else if (!inTag) out.push_back(c);
    }
    return out;
}

std::string toLower(std::string s) {
    for (char& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return s;
}

bool writeFile(const std::string& path, const std::string& data) {
    std::ofstream out(path, std::ios::binary | std::ios::trunc);
    if (!out) return false;
    out.write(data.data(), static_cast<std::streamsize>(data.size()));
    return static_cast<bool>(out);
}

// ---------- 页面解析 ----------

// 取 <span class=green>标签: </span> 之后到下一个 '<' 之前的文本
std::string textAfterLabel(const std::string& page, const std::string& label) {
    size_t p = page.find(label);
    if (p == std::string::npos) return "";
    size_t sp = page.find("</span>", p);
    if (sp == std::string::npos) return "";
    size_t s = sp + 7;
    size_t e = page.find('<', s);
    std::string t = page.substr(s, e == std::string::npos ? std::string::npos : e - s);
    return trim(htmlDecode(t));
}

// 从 <h2 class='lang_cn'>...</h2> 取题名, 去掉 "问题 X:" / "<id>:" 前缀
std::string extractName(const std::string& page) {
    size_t p = page.find("lang_cn");
    if (p == std::string::npos) return "";
    size_t gt = page.find('>', p);
    if (gt == std::string::npos) return "";
    size_t end = page.find("</h2>", gt);
    if (end == std::string::npos) return "";
    std::string inner = stripTags(page.substr(gt + 1, end - gt - 1));
    inner = trim(htmlDecode(inner));
    size_t c1 = inner.find(':');
    size_t c2 = inner.find("：");
    size_t pos = std::string::npos;
    if (c1 == std::string::npos) pos = c2;
    else if (c2 == std::string::npos) pos = c1;
    else pos = std::min(c1, c2);
    if (pos != std::string::npos) inner = trim(inner.substr(pos + 1));
    return inner;
}

int extractPidFromPage(const std::string& page) {
    const std::string key = "problemstatus.php?id=";
    size_t p = page.find(key);
    if (p == std::string::npos) return -1;
    p += key.size();
    std::string num;
    while (p < page.size() && std::isdigit(static_cast<unsigned char>(page[p]))) {
        num.push_back(page[p]);
        ++p;
    }
    return num.empty() ? -1 : std::atoi(num.c_str());
}

int extractPidFromUrl(const std::string& url) {
    const std::string keys[2] = {"?id=", "&id="};
    for (const auto& key : keys) {
        size_t p = url.find(key);
        if (p == std::string::npos) continue;
        p += key.size();
        std::string num;
        while (p < url.size() && std::isdigit(static_cast<unsigned char>(url[p]))) {
            num.push_back(url[p]);
            ++p;
        }
        if (!num.empty()) return std::atoi(num.c_str());
    }
    return -1;
}

// 在一个 data-sample 块内, 取某标签后第一个 sampledata span 的原始内容
std::string sampleContent(const std::string& block, const std::string& label) {
    size_t l = block.find(label);
    if (l == std::string::npos) return std::string();
    size_t sp = block.find("sampledata", l);
    if (sp == std::string::npos) return std::string();
    size_t gt = block.find('>', sp);
    if (gt == std::string::npos) return std::string();
    size_t end = block.find("</span>", gt);
    if (end == std::string::npos) return std::string();
    return htmlDecode(block.substr(gt + 1, end - gt - 1));
}

// 切分 div.data-sample, 按出现顺序解析样例
void extractSamples(const std::string& page,
                    std::vector<std::pair<std::string, std::string>>& samples) {
    std::vector<size_t> pos;
    size_t p = 0;
    while ((p = page.find("data-sample", p)) != std::string::npos) {
        // 排除 <style> 中的 .data-sample 选择器, 仅接受 class= 属性
        size_t back = p >= 8 ? p - 8 : 0;
        if (page.substr(back, p - back).find("class=") != std::string::npos) pos.push_back(p);
        p += 11;
    }
    for (size_t i = 0; i < pos.size(); ++i) {
        size_t s = pos[i];
        size_t e = (i + 1 < pos.size()) ? pos[i + 1] : page.size();
        std::string block = page.substr(s, e - s);
        std::string in = sampleContent(block, "样例输入");
        std::string out = sampleContent(block, "样例输出");
        if (trim(in) == "（无）" || trim(in) == "(无)") in.clear();
        if (trim(out) == "（无）" || trim(out) == "(无)") out.clear();
        samples.emplace_back(in, out);
    }
}

// 收集 "下载文件" 附件链接 (ke-insertfile)
std::vector<std::string> extractAttachments(const std::string& page) {
    std::vector<std::string> urls;
    size_t p = 0;
    while ((p = page.find("ke-insertfile", p)) != std::string::npos) {
        size_t h = page.find("href=", p);
        if (h == std::string::npos) break;
        size_t q = h + 5;
        if (q < page.size() && (page[q] == '"' || page[q] == '\'')) {
            char quote = page[q];
            size_t s = q + 1;
            size_t e = page.find(quote, s);
            if (e == std::string::npos) break;
            std::string href = page.substr(s, e - s);
            if (!href.empty() && std::find(urls.begin(), urls.end(), href) == urls.end())
                urls.push_back(href);
            p = e;
        } else {
            p = q;
        }
    }
    return urls;
}

std::string urlOrigin(const std::string& url) {
    size_t p = url.find("://");
    if (p == std::string::npos) return "";
    size_t slash = url.find('/', p + 3);
    if (slash == std::string::npos) return url;
    return url.substr(0, slash);
}

std::string absoluteUrl(const std::string& origin, const std::string& href) {
    if (href.rfind("http://", 0) == 0 || href.rfind("https://", 0) == 0) return href;
    if (!href.empty() && href[0] == '/') return origin + href;
    return origin + "/" + href;
}

std::string filenameOf(const std::string& url) {
    size_t q = url.find_first_of("?#");
    std::string u = (q == std::string::npos) ? url : url.substr(0, q);
    size_t s = u.find_last_of('/');
    std::string name = (s == std::string::npos) ? u : u.substr(s + 1);
    if (name.empty()) name = "attachment";
    return name;
}

// 是否为洛谷题目链接
bool isLuoguUrl(const std::string& url) {
    return url.find("luogu.com.cn") != std::string::npos || url.find("luogu.org") != std::string::npos;
}

// 是否为 xmoj 新版竞赛题目链接
bool isContestUrl(const std::string& url) {
    return url.find("/web/contest/") != std::string::npos;
}

// 从 /web/contest/{cid}/{num} 解析竞赛号与题号; 缺题号时默认 A
bool parseContestUrl(const std::string& url, std::string& cid, std::string& num) {
    const std::string key = "/web/contest/";
    size_t p = url.find(key);
    if (p == std::string::npos) return false;
    p += key.size();
    std::string a;
    while (p < url.size() && std::isdigit(static_cast<unsigned char>(url[p]))) a.push_back(url[p++]);
    if (a.empty()) return false;
    while (p < url.size() && url[p] == '/') ++p;
    std::string b;
    while (p < url.size() && (std::isalnum(static_cast<unsigned char>(url[p])) || url[p] == '_'))
        b.push_back(url[p++]);
    if (b.empty()) b = "A";
    for (char& c : b) c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
    cid = a;
    num = b;
    return true;
}

// 从洛谷 URL 取题号, 如 /problem/P1001 -> P1001; 无则返回空
std::string luoguPid(const std::string& url) {
    const std::string key = "/problem/";
    size_t p = url.find(key);
    if (p == std::string::npos) return "";
    p += key.size();
    std::string id;
    while (p < url.size()) {
        char c = url[p];
        if (std::isalnum(static_cast<unsigned char>(c)) || c == '_') {
            id.push_back(c);
            ++p;
        } else {
            break;
        }
    }
    return id;
}

#ifdef _WIN32

// ---------- WinHTTP ----------

std::wstring toWide(const std::string& s) {
    if (s.empty()) return std::wstring();
    int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()), nullptr, 0);
    std::wstring w(static_cast<size_t>(n), 0);
    MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()), &w[0], n);
    return w;
}

std::string urlEncode(const std::string& s) {
    static const char* kHex = "0123456789ABCDEF";
    std::string out;
    for (unsigned char c : s) {
        if (std::isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') {
            out.push_back(static_cast<char>(c));
        } else {
            out.push_back('%');
            out.push_back(kHex[c >> 4]);
            out.push_back(kHex[c & 0x0F]);
        }
    }
    return out;
}

// 取标签属性值; 支持 value="x"/value='x'/value=x
std::string attrAfter(const std::string& s, size_t from, const std::string& attr) {
    std::string key = attr + "=";
    size_t p = s.find(key, from);
    if (p == std::string::npos) return "";
    p += key.size();
    if (p >= s.size()) return "";
    char c = s[p];
    if (c == '"' || c == '\'') {
        size_t e = s.find(c, p + 1);
        if (e == std::string::npos) return "";
        return s.substr(p + 1, e - p - 1);
    }
    size_t e = s.find_first_of(" \t\r\n/>", p);
    return s.substr(p, e == std::string::npos ? std::string::npos : e - p);
}

// 从 csrf.php 页面解析 csrf 隐藏字段的 value
std::string extractCsrf(const std::string& page) {
    size_t p = page.find("name=\"csrf\"");
    if (p == std::string::npos) p = page.find("name='csrf'");
    if (p == std::string::npos) return "";
    return trim(attrAfter(page, p, "value"));
}

// 在 submitpage.php 的 language 下拉框里, 按语言名匹配 option 的 value
std::string matchLanguage(const std::string& page, const std::string& lang) {
    std::string want = toLower(lang);
    if (want == "cpp" || want == "c++" || want == "cxx") want = "c++";
    else if (want == "pas" || want == "pascal") want = "pascal";
    size_t sel = page.find("id=\"language\"");
    if (sel == std::string::npos) sel = page.find("name=\"language\"");
    size_t scopeEnd = page.size();
    if (sel != std::string::npos) {
        size_t e = page.find("</select>", sel);
        if (e != std::string::npos) scopeEnd = e;
    } else {
        sel = 0;
    }
    size_t p = sel;
    while (p < scopeEnd) {
        size_t opt = page.find("<option", p);
        if (opt == std::string::npos || opt >= scopeEnd) break;
        size_t gt = page.find('>', opt);
        if (gt == std::string::npos || gt >= scopeEnd) break;
        size_t nextOpt = page.find("<option", gt + 1);
        if (nextOpt == std::string::npos || nextOpt > scopeEnd) nextOpt = scopeEnd;
        size_t close = page.find("</option>", gt + 1);
        size_t textEnd = (close != std::string::npos && close < nextOpt) ? close : nextOpt;
        std::string tag = page.substr(opt, gt - opt);
        std::string text =
            toLower(trim(stripTags(htmlDecode(page.substr(gt + 1, textEnd - gt - 1)))));
        if (!want.empty() && text.find(want) != std::string::npos) {
            std::string v = trim(attrAfter(tag, 0, "value"));
            if (!v.empty()) return v;
        }
        p = gt + 1;
    }
    return "";
}

// 是否全为数字(忽略首尾空白)
bool allDigits(const std::string& s) {
    std::string t = trim(s);
    if (t.empty()) return false;
    for (char c : t)
        if (!std::isdigit(static_cast<unsigned char>(c))) return false;
    return true;
}

// 取 URL 查询串中的参数值; 无该参数返回 false
bool queryValue(const std::string& url, const std::string& key, std::string& out) {
    size_t q = url.find('?');
    if (q == std::string::npos) return false;
    std::string query = url.substr(q + 1);
    size_t p = 0;
    while (p <= query.size()) {
        size_t amp = query.find('&', p);
        std::string pair = query.substr(p, amp == std::string::npos ? std::string::npos : amp - p);
        size_t eq = pair.find('=');
        if ((eq == std::string::npos ? pair : pair.substr(0, eq)) == key) {
            out = eq == std::string::npos ? "" : pair.substr(eq + 1);
            return true;
        }
        if (amp == std::string::npos) break;
        p = amp + 1;
    }
    return false;
}

// 取页面 jumbotron 区块内的纯文本(登录提示/错误信息)
std::string jumbotronText(const std::string& page) {
    size_t p = page.find("jumbotron");
    if (p == std::string::npos) return "";
    size_t s = page.find('>', p);
    if (s == std::string::npos) return "";
    size_t e = page.find("</div>", s);
    if (e == std::string::npos) return "";
    return trim(stripTags(htmlDecode(page.substr(s + 1, e - s - 1))));
}

// 取 key 之后第一段数字, 无则返回 -1
int numberAfter(const std::string& s, const std::string& key) {
    size_t p = s.find(key);
    if (p == std::string::npos) return -1;
    p += key.size();
    int guard = 0;
    while (p < s.size() && !std::isdigit(static_cast<unsigned char>(s[p])) && guard < 5) {
        ++p;
        ++guard;
    }
    if (p >= s.size() || !std::isdigit(static_cast<unsigned char>(s[p]))) return -1;
    long long v = 0;
    while (p < s.size() && std::isdigit(static_cast<unsigned char>(s[p]))) {
        v = v * 10 + (s[p] - '0');
        ++p;
    }
    return static_cast<int>(v);
}

// 从提交响应/状态页中解析 solution id, 无则返回 -1
int extractSolutionId(const std::string& resp) {
    const char* keys[] = {"print_result(", "solution_id=", "solution_id", "sid=", "\"sid\":"};
    for (const char* k : keys) {
        int v = numberAfter(resp, k);
        if (v >= 0) return v;
    }
    return -1;
}

// 简单 HTTP 客户端; 同一 session 内自动维护 Cookie
class HttpClient {
public:
    HttpClient() {
        session_ = WinHttpOpen(L"oi-judge/0.1", WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
                               WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
        if (session_) {
            WinHttpSetTimeouts(session_, 15000, 15000, 30000, 30000);
        }
    }
    ~HttpClient() {
        if (session_) WinHttpCloseHandle(session_);
    }
    bool ok() const { return session_ != nullptr; }
    unsigned status() const { return status_; }

    bool request(const std::string& method, const std::string& url, const std::string& body,
                 const std::string& contentType, std::string& resp, std::string& err,
                 const std::string& headers = "") {
        resp.clear();
        std::wstring wurl = toWide(url);
        URL_COMPONENTS uc;
        ZeroMemory(&uc, sizeof(uc));
        uc.dwStructSize = sizeof(uc);
        wchar_t host[256] = {0};
        wchar_t path[4096] = {0};
        wchar_t extra[4096] = {0};
        uc.lpszHostName = host;
        uc.dwHostNameLength = 255;
        uc.lpszUrlPath = path;
        uc.dwUrlPathLength = 4095;
        uc.lpszExtraInfo = extra;
        uc.dwExtraInfoLength = 4095;
        if (!WinHttpCrackUrl(wurl.c_str(), static_cast<DWORD>(wurl.size()), 0, &uc)) {
            err = "无效的 URL: " + url;
            return false;
        }
        std::wstring wpath = std::wstring(path) + extra;
        DWORD flags = (uc.nScheme == INTERNET_SCHEME_HTTPS) ? WINHTTP_FLAG_SECURE : 0;

        HINTERNET conn = WinHttpConnect(session_, host, uc.nPort, 0);
        if (!conn) {
            err = "无法连接服务器: " + url;
            return false;
        }
        const wchar_t* verb = (method == "POST") ? L"POST" : L"GET";
        HINTERNET req = WinHttpOpenRequest(conn, verb, wpath.c_str(), NULL, WINHTTP_NO_REFERER,
                                           WINHTTP_DEFAULT_ACCEPT_TYPES, flags);
        if (!req) {
            WinHttpCloseHandle(conn);
            err = "创建请求失败: " + url;
            return false;
        }
        DWORD policy = WINHTTP_OPTION_REDIRECT_POLICY_ALWAYS;
        WinHttpSetOption(req, WINHTTP_OPTION_REDIRECT_POLICY, &policy, sizeof(policy));

        BOOL sent = FALSE;
        if (method == "POST") {
            std::string h = "Content-Type: " + contentType;
            if (!headers.empty()) h += "\r\n" + headers;
            std::wstring wh = toWide(h);
            sent = WinHttpSendRequest(req, wh.c_str(), static_cast<DWORD>(-1L),
                                      const_cast<char*>(body.data()),
                                      static_cast<DWORD>(body.size()),
                                      static_cast<DWORD>(body.size()), 0);
        } else if (!headers.empty()) {
            std::wstring wh = toWide(headers);
            sent = WinHttpSendRequest(req, wh.c_str(), static_cast<DWORD>(-1L),
                                      WINHTTP_NO_REQUEST_DATA, 0, 0, 0);
        } else {
            sent = WinHttpSendRequest(req, WINHTTP_NO_ADDITIONAL_HEADERS, 0, WINHTTP_NO_REQUEST_DATA,
                                      0, 0, 0);
        }
        if (!sent) {
            WinHttpCloseHandle(req);
            WinHttpCloseHandle(conn);
            err = "发送请求失败: " + url;
            return false;
        }
        if (!WinHttpReceiveResponse(req, NULL)) {
            WinHttpCloseHandle(req);
            WinHttpCloseHandle(conn);
            err = "接收响应失败: " + url;
            return false;
        }
        DWORD st = 0;
        DWORD slen = sizeof(st);
        WinHttpQueryHeaders(req, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                            WINHTTP_HEADER_NAME_BY_INDEX, &st, &slen, WINHTTP_NO_HEADER_INDEX);
        status_ = st;

        std::string data;
        DWORD avail = 0;
        while (WinHttpQueryDataAvailable(req, &avail) && avail > 0) {
            size_t old = data.size();
            data.resize(old + avail);
            DWORD read = 0;
            if (!WinHttpReadData(req, &data[old], avail, &read)) break;
            data.resize(old + read);
        }
        WinHttpCloseHandle(req);
        WinHttpCloseHandle(conn);
        resp = std::move(data);
        return true;
    }

private:
    HINTERNET session_ = nullptr;
    unsigned status_ = 0;
};

// 建立会话(GET index.php 拿 PHPSESSID)并按需登录; 失败时写入 err
bool prepareSession(HttpClient& http, const std::string& user, const std::string& password,
                    std::string& err) {
    std::string body;
    if (!http.request("GET", "https://www.xmoj.tech/index.php", "", "", body, err)) return false;
    if (user.empty()) return true;
    std::string form = "user_id=" + urlEncode(user) + "&password=" + urlEncode(password);
    std::string lbody;
    std::string lerr;
    if (!http.request("POST", "https://www.xmoj.tech/login.php", form,
                      "application/x-www-form-urlencoded", lbody, lerr)) {
        err = "登录请求失败: " + lerr;
        return false;
    }
    if (lbody.find("history.go(-2)") == std::string::npos) {
        if (lbody.find("UserName or Password Wrong") != std::string::npos)
            err = "登录失败: 用户名或密码错误";
        else
            err = "登录失败: 未获得有效响应";
        return false;
    }
    return true;
}

// 训练会话截止: 同班级中当前生效的个人时间线结束时间, 取最早的一个; 无则返回空串
std::string sessionEndFromClass(HttpClient& http, const std::string& classId,
                                const std::string& now) {
    if (classId.empty() || now.empty()) return "";
    std::string best;
    // 列表按竞赛号倒序, 当天生效的会话必在前 50 条内, 只扫 1 页
    for (int page = 1; page <= 1; ++page) {
        std::string url = "https://www.xmoj.tech/api/contest/list?page=" + std::to_string(page) +
                          "&pageSize=50";
        std::string body;
        std::string err;
        std::string headers =
            "Accept: application/json, text/plain, */*\r\n"
            "X-Requested-With: XMLHttpRequest\r\n"
            "Referer: https://www.xmoj.tech/web/contest\r\n";
        if (!http.request("GET", url, "", "", body, err, headers)) break;
        if (http.status() != 200) break;
        Json root;
        std::string perr;
        if (!Json::parse(body, root, perr)) break;
        const Json& list = root["list"];
        if (list.size() == 0) break;
        for (size_t i = 0; i < list.size(); ++i) {
            const Json& item = list.at(i);
            if (item["classId"].getString() != classId) continue;
            const Json& tl = item["myTimeline"];
            if (!tl["enabled"].getBool(false)) continue;
            std::string s = tl["startTime"].getString();
            std::string e = tl["endTime"].getString();
            if (s.empty() || e.empty()) continue;
            // 时间为 "YYYY-MM-DD HH:MM:SS", 可直接按字典序比较
            if (now < s || now >= e) continue;
            if (best.empty() || e < best) best = e;
        }
    }
    return best;
}

// 抓取洛谷题目: 带 x-lentille-request: content-only 头取 JSON, 解析样例后落盘
FetchResult fetchLuogu(HttpClient& http, const FetchOptions& opt, const std::string& pid) {
    FetchResult r;
    r.url = opt.url;
    std::string headers =
        "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, "
        "like Gecko) Chrome/120.0.0.0 Safari/537.36\r\n"
        "Accept: application/json, text/plain, */*\r\n"
        "X-Requested-With: XMLHttpRequest\r\n"
        "x-lentille-request: content-only\r\n"
        "Referer: https://www.luogu.com.cn/problem/" + pid + "\r\n";
    if (!opt.cookie.empty()) headers += "Cookie: " + opt.cookie + "\r\n";

    std::string body;
    std::string err;
    if (!http.request("GET", "https://www.luogu.com.cn/problem/" + pid, "", "", body, err,
                      headers)) {
        r.error = err;
        return r;
    }
    if (http.status() != 200) {
        r.error = "抓取洛谷题目失败: HTTP " + std::to_string(http.status());
        return r;
    }
    Json root;
    std::string perr;
    if (!Json::parse(body, root, perr)) {
        r.error = "洛谷响应解析失败: " + perr;
        return r;
    }
    const Json& prob = root["data"]["problem"];
    if (!prob.contains("pid")) {
        long long st = root["status"].getInt(0);
        r.error = "洛谷返回异常(status=" + std::to_string(st) +
                  "): 题目不存在或需登录. 可配置 oiHelper.luoguCookie 后重试.";
        return r;
    }

    std::string title = prob["name"].getString(pid);
    // limits.time 单位 ms, limits.memory 单位 KB
    int timeMs = static_cast<int>(prob["limits"]["time"].at(0).getInt(1000));
    long long memKb = prob["limits"]["memory"].at(0).getInt(262144);
    int memMb = static_cast<int>(memKb / 1024);
    std::vector<std::pair<std::string, std::string>> samples;
    const Json& arr = prob["samples"];
    for (size_t i = 0; i < arr.size(); ++i) {
        const Json& pair = arr.at(i);
        samples.emplace_back(pair.at(0).getString(), pair.at(1).getString());
    }

    // 内联模式: 不创建目录/写文件, 仅回传样例内容
    if (opt.inlineSamples) {
        r.ok = true;
        r.pid = leadingInt(pid);
        if (r.pid < 0) r.pid = 0;
        r.name = title;
        r.fileIO = false;
        r.tests = static_cast<int>(samples.size());
        for (const auto& s : samples) r.samples.push_back({s.first, s.second});
        if (samples.empty()) r.warnings.push_back("未解析到样例测试点");
        return r;
    }

    fs::path base = opt.outBaseDir.empty() ? fs::current_path() : fs::path(opt.outBaseDir);
    fs::path dir = base / pid;
    std::error_code ec;
    fs::create_directories(dir, ec);
    if (ec) {
        r.error = "无法创建目录: " + dir.string();
        return r;
    }

    Json rootJson = Json::makeObject();
    rootJson["name"] = Json::makeString(title);
    rootJson["type"] = Json::makeString("traditional");
    rootJson["timeLimit"] = Json::makeInt(timeMs);
    rootJson["memoryLimit"] = Json::makeInt(memMb);
    rootJson["standard"] = Json::makeString("c++14");
    rootJson["optimize"] = Json::makeString("O2");
    rootJson["checker"] = Json::makeString("diff");
    Json tests = Json::makeArray();
    for (size_t i = 0; i < samples.size(); ++i) {
        Json t = Json::makeObject();
        t["id"] = Json::makeInt(static_cast<long long>(i + 1));
        t["in"] = Json::makeString(std::to_string(i + 1) + ".in");
        t["out"] = Json::makeString(std::to_string(i + 1) + ".ans");
        tests.arrVal.push_back(t);
    }
    rootJson["tests"] = tests;
    rootJson["sourceUrl"] = Json::makeString(opt.url);

    if (!writeFile((dir / "problem.json").string(), rootJson.dump(true) + "\n")) {
        r.error = "无法写入 problem.json";
        return r;
    }
    for (size_t i = 0; i < samples.size(); ++i) {
        std::string n = std::to_string(i + 1);
        if (!writeFile((dir / (n + ".in")).string(), samples[i].first) ||
            !writeFile((dir / (n + ".ans")).string(), samples[i].second)) {
            r.error = "无法写入样例文件 " + n;
            return r;
        }
    }

    r.ok = true;
    r.pid = leadingInt(pid);
    if (r.pid < 0) r.pid = 0;
    r.name = title;
    r.fileIO = false;
    r.tests = static_cast<int>(samples.size());
    r.dir = dir.string();
    if (samples.empty()) r.warnings.push_back("未解析到样例测试点");
    return r;
}

// 抓取新版竞赛题目: GET /api/contest/{cid}/{num}?lang=cn, 原样回传 HTML 字段
ContestResult fetchContest(HttpClient& http, const std::string& cid, const std::string& num) {
    ContestResult r;
    std::string page = "https://www.xmoj.tech/web/contest/" + cid + "/" + num;
    std::string api = "https://www.xmoj.tech/api/contest/" + cid + "/" + num + "?lang=cn";
    std::string headers =
        "Accept: application/json, text/plain, */*\r\n"
        "X-Requested-With: XMLHttpRequest\r\n"
        "Referer: " + page + "\r\n";

    std::string body;
    std::string err;
    if (!http.request("GET", api, "", "", body, err, headers)) {
        r.error = err;
        return r;
    }
    if (http.status() != 200) {
        r.error = "抓取竞赛题目失败: HTTP " + std::to_string(http.status());
        return r;
    }
    Json root;
    std::string perr;
    if (!Json::parse(body, root, perr)) {
        r.error = "竞赛题目响应解析失败: " + perr;
        return r;
    }
    if (!root.contains("problem")) {
        r.error = "竞赛题目不存在或需登录. 请配置 oiHelper.xmojUser / oiHelper.xmojPassword.";
        return r;
    }

    const Json& ct = root["contest"];
    const Json& cur = root["current"];
    const Json& prob = root["problem"];
    ContestProblem& p = r.problem;
    p.contestId = ct["contestId"].getString(cid);
    p.contestTitle = ct["title"].getString();
    p.startTime = ct["startTime"].getString();
    p.endTime = ct["endTime"].getString();
    p.classId = ct["classId"].getString();
    // 非固定时间比赛: 以个人时间线为准
    const Json& tl = ct["myTimeline"];
    if (tl["enabled"].getBool(false) && !tl["endTime"].getString().empty()) {
        p.startTime = tl["startTime"].getString();
        p.endTime = tl["endTime"].getString();
        p.sessionEnd = tl["endTime"].getString();
    } else {
        // 本场无个人时间线: 用同班当前生效的训练会话截止时间
        p.sessionEnd = sessionEndFromClass(http, p.classId, root["serverTime"].getString());
    }
    p.leftSeconds = static_cast<int>(ct["status"]["leftSeconds"].getInt(-1));
    p.state = ct["status"]["state"].getString();
    p.num = cur["num"].getString(num);
    p.problemId = prob["problemId"].getString();
    p.title = prob["title"].getString();
    p.source = prob["source"].getString();
    int sec = static_cast<int>(prob["timeLimit"].getInt(1));
    if (sec > 0) p.timeMs = sec * 1000;
    int mb = static_cast<int>(prob["memoryLimit"].getInt(256));
    if (mb > 0) p.memMb = mb;
    p.description = prob["description"].getString();
    p.input = prob["input"].getString();
    p.output = prob["output"].getString();
    p.hint = prob["hint"].getString();
    p.dataRange = prob["dataRange"].getString();
    // download 字段是 HTML 片段, 取出其中的下载链接
    std::string dl = prob["download"].getString();
    size_t a = dl.find("<a ");
    if (a != std::string::npos) {
        size_t h = dl.find("href=", a);
        if (h != std::string::npos) {
            std::string href;
            size_t v = h + 5;
            if (v < dl.size() && (dl[v] == '"' || dl[v] == '\'')) {
                char q = dl[v];
                size_t s = v + 1;
                size_t e = dl.find(q, s);
                if (e != std::string::npos) href = dl.substr(s, e - s);
            } else {
                size_t e = dl.find_first_of(" \t\r\n>", v);
                href = dl.substr(v, e == std::string::npos ? std::string::npos : e - v);
            }
            if (!href.empty()) dl = absoluteUrl("https://www.xmoj.tech", href);
        }
    }
    p.download = trim(dl);
    // 新版接口用 name 表示文件 IO(与 SPA 一致): 非空即 <name>.in / <name>.out, 空则标准 IO
    std::string ioName = trim(prob["name"].getString());
    if (!ioName.empty()) {
        p.fileIO = true;
        p.freopenIn = ioName + ".in";
        p.freopenOut = ioName + ".out";
    }
    p.submitUrl = root["submitUrl"].getString();

    // 样例固定槽位 1..4: 第一组无后缀, 2..4 追加数字后缀
    for (int i = 1; i <= 4; ++i) {
        std::string suffix = (i == 1) ? "" : std::to_string(i);
        std::string in = prob["sampleInput" + suffix].getString();
        std::string out = prob["sampleOutput" + suffix].getString();
        std::string ex = prob["sampleExplain" + suffix].getString();
        if (trim(in).empty() && trim(out).empty()) continue;
        p.samples.push_back({in, out});
        p.explains.push_back(ex);
    }

    const Json& list = root["problems"];
    for (size_t i = 0; i < list.size(); ++i) {
        const Json& item = list.at(i);
        ContestItem ci;
        ci.num = item["num"].getString();
        ci.title = item["problemTitle"].getString();
        ci.problemId = item["problemId"].getString();
        p.problems.push_back(std::move(ci));
    }

    r.ok = true;
    return r;
}

// ---------- 原题(洛谷/Codeforces/AtCoder/Hydro) ----------

const char* kBrowserUa =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/120.0.0.0 Safari/537.36";

// 判断链接所属 OJ; 无法识别时返回空串
// Hydro 自建站域名各异, 以题目页路径 /p/<id> 或 hydro 域名作为识别特征
std::string detectOj(const std::string& url) {
    if (url.find("luogu.com.cn") != std::string::npos || url.find("luogu.org") != std::string::npos)
        return "luogu";
    if (url.find("codeforces.com") != std::string::npos) return "codeforces";
    if (url.find("atcoder.jp") != std::string::npos) return "atcoder";
    std::string lower;
    lower.reserve(url.size());
    for (char c : url) lower.push_back(static_cast<char>(std::tolower(static_cast<unsigned char>(c))));
    if (lower.find("/p/") != std::string::npos || lower.find("hydro") != std::string::npos)
        return "hydro";
    return "";
}

// 取 start 处起始标签的配对内容; tag 为标签名(如 div/pre)
bool balancedInner(const std::string& html, size_t start, const std::string& tag,
                   std::string& inner) {
    std::string open = "<" + tag;
    std::string close = "</" + tag;
    size_t gt = html.find('>', start);
    if (gt == std::string::npos) return false;
    size_t pos = gt + 1;
    int depth = 1;
    while (pos < html.size()) {
        size_t no = html.find(open, pos);
        size_t nc = html.find(close, pos);
        if (nc == std::string::npos) return false;
        if (no != std::string::npos && no < nc) {
            char c = (no + open.size() < html.size()) ? html[no + open.size()] : '\0';
            if (c == '>' || c == ' ' || c == '\t' || c == '\n' || c == '\r') ++depth;
            pos = no + open.size();
        } else {
            --depth;
            if (depth == 0) {
                inner = html.substr(gt + 1, nc - gt - 1);
                return true;
            }
            pos = nc + close.size();
        }
    }
    return false;
}

// 去掉 script/style 块
std::string dropScripts(const std::string& html) {
    std::string out;
    size_t pos = 0;
    while (pos < html.size()) {
        size_t s = html.find("<script", pos);
        size_t st = html.find("<style", pos);
        size_t hit = std::min(s == std::string::npos ? html.size() : s,
                              st == std::string::npos ? html.size() : st);
        if (hit >= html.size()) {
            out.append(html, pos, std::string::npos);
            break;
        }
        out.append(html, pos, hit - pos);
        std::string tag = (hit == s) ? "script" : "style";
        size_t gt = html.find('>', hit);
        if (gt == std::string::npos) break;
        size_t end = html.find("</" + tag, gt);
        if (end == std::string::npos) break;
        size_t close = html.find('>', end);
        pos = (close == std::string::npos) ? html.size() : close + 1;
    }
    return out;
}

// 收集 <pre> 块内容, 块级标签换成换行
std::vector<std::string> preTexts(const std::string& html) {
    std::vector<std::string> out;
    size_t pos = 0;
    while (true) {
        size_t p = html.find("<pre", pos);
        if (p == std::string::npos) break;
        std::string inner;
        if (!balancedInner(html, p, "pre", inner)) break;
        std::string text;
        for (size_t i = 0; i < inner.size(); ++i) {
            if (inner[i] != '<') {
                text.push_back(inner[i]);
                continue;
            }
            size_t e = inner.find('>', i);
            if (e == std::string::npos) break;
            std::string tag = toLower(inner.substr(i, e - i + 1));
            if (tag.rfind("<br", 0) == 0 || tag.rfind("</div", 0) == 0 || tag.rfind("</p", 0) == 0)
                text.push_back('\n');
            i = e;
        }
        out.push_back(trim(htmlDecode(text)));
        pos = p + 4;
    }
    return out;
}

// 反爬挑战页(Cerberus/Anubis/Cloudflare): 这种页面不是真题目
bool isAntiBotPage(const std::string& page) {
    return page.find("Cerberus") != std::string::npos ||
           page.find("you're not a bot") != std::string::npos ||
           page.find("Anubis") != std::string::npos ||
           page.find("Just a moment") != std::string::npos ||
           page.find("cf-challenge") != std::string::npos;
}

// <pre> 成对组成样例
std::vector<FetchSample> pairSamples(const std::vector<std::string>& pres) {
    std::vector<FetchSample> out;
    for (size_t i = 0; i + 1 < pres.size(); i += 2) {
        if (pres[i].empty() && pres[i + 1].empty()) continue;
        out.push_back({pres[i], pres[i + 1]});
    }
    return out;
}

std::string pageTitle(const std::string& html) {
    size_t p = html.find("<title");
    if (p == std::string::npos) return "";
    size_t s = html.find('>', p);
    if (s == std::string::npos) return "";
    size_t e = html.find("</title>", s);
    if (e == std::string::npos) return "";
    return trim(htmlDecode(stripTags(html.substr(s + 1, e - s - 1))));
}

// 在 select 范围内按候选关键字(按优先级)挑 option 的 value
std::string pickLangInSelect(const std::string& page, size_t selectPos,
                             const std::vector<std::string>& keys) {
    size_t end = page.find("</select>", selectPos);
    if (end == std::string::npos) end = page.size();
    for (const std::string& key : keys) {
        size_t p = selectPos;
        while (p < end) {
            size_t opt = page.find("<option", p);
            if (opt == std::string::npos || opt >= end) break;
            size_t gt = page.find('>', opt);
            if (gt == std::string::npos || gt >= end) break;
            size_t next = page.find("<option", gt + 1);
            if (next == std::string::npos || next > end) next = end;
            size_t close = page.find("</option>", gt + 1);
            size_t textEnd = (close != std::string::npos && close < next) ? close : next;
            std::string tag = page.substr(opt, gt - opt);
            std::string text =
                toLower(trim(stripTags(htmlDecode(page.substr(gt + 1, textEnd - gt - 1)))));
            if (text.find(key) != std::string::npos) {
                std::string v = trim(attrAfter(tag, 0, "value"));
                if (!v.empty()) return v;
            }
            p = gt + 1;
        }
    }
    return "";
}

// 语言下拉的关键字优先级
std::vector<std::string> langKeys(const std::string& lang) {
    std::string want = toLower(lang);
    if (want == "pas" || want == "pascal") return {"pascal", "fpc"};
    return {"c++20", "c++17", "g++17", "g++", "c++14", "c++", "gcc"};
}

std::string detectOjSubmitUrl(const std::string& oj, const std::string& url);

// Codeforces/AtCoder: cookie 已登录时抓提交页并 POST 表单
OriginalSubmitResult submitOriginalForm(const std::string& oj, const std::string& url,
                                        const std::string& source, const std::string& lang,
                                        const std::string& cookie, HttpClient& http);

// 洛谷: meta csrf-token + fe/api 提交接口
OriginalSubmitResult submitOriginalLuogu(const std::string& url, const std::string& source,
                                         const std::string& lang, const std::string& cookie,
                                         const std::string& captcha);

// 洛谷: 抓题面(HTML)与样例
OriginalResult fetchOriginalLuogu(const std::string& url, const std::string& cookie) {
    OriginalResult r;
    r.oj = "luogu";
    r.url = url;
    std::string pid = luoguPid(url);
    if (pid.empty()) {
        r.error = "无法从链接解析洛谷题号";
        return r;
    }
    HttpClient http;
    if (!http.ok()) {
        r.error = "初始化网络库失败(WinHTTP)";
        return r;
    }
    std::string headers =
        "User-Agent: " + std::string(kBrowserUa) + "\r\n"
        "Accept: application/json, text/plain, */*\r\n"
        "X-Requested-With: XMLHttpRequest\r\n"
        "x-lentille-request: content-only\r\n";
    if (!cookie.empty()) headers += "Cookie: " + cookie + "\r\n";
    std::string body;
    std::string err;
    if (!http.request("GET", url, "", "", body, err, headers)) {
        r.error = err;
        return r;
    }
    Json root;
    std::string perr;
    if (!Json::parse(body, root, perr)) {
        r.error = "洛谷响应解析失败: " + perr;
        return r;
    }
    const Json& prob = root["data"]["problem"];
    if (!prob.contains("pid")) {
        r.error = "洛谷返回异常: 题目不存在或需登录. 可在设置中配置洛谷 Cookie 后重试.";
        return r;
    }
    r.title = prob["name"].getString(pid);
    // contenu 为译版内容, 顶层为原版内容; 均为 Markdown
    const Json& zh = prob["contenu"];
    auto pick = [&](const char* key) -> std::string {
        std::string v = zh[key].getString();
        if (trim(v).empty()) v = prob[key].getString();
        return v;
    };
    auto section = [&](const std::string& heading, const std::string& body) {
        if (trim(body).empty()) return;
        r.md += "## " + heading + "\n\n" + body + "\n\n";
    };
    section("题目背景", pick("background"));
    section("题目描述", pick("description"));
    section("输入格式", pick("formatI"));
    section("输出格式", pick("formatO"));
    section("提示", pick("hint"));
    const Json& arr = prob["samples"];
    for (size_t i = 0; i < arr.size(); ++i) {
        const Json& pair = arr.at(i);
        r.samples.push_back({pair.at(0).getString(), pair.at(1).getString()});
    }
    r.submitUrl = "https://www.luogu.com.cn/problem/" + pid;
    r.ok = true;
    return r;
}

// 去掉会破坏命令行的字符
std::string sanitizeArg(const std::string& s) {
    std::string o;
    for (char c : s) {
        if (c == '"' || c == '\n' || c == '\r') continue;
        o.push_back(c);
    }
    return o;
}

// 调用系统 curl.exe(Windows 10+ 自带): 部分 OJ 的 Cloudflare 会拦截 WinHTTP 指纹
bool curlRequest(const std::string& args, std::string& out) {
    // --compressed: 让服务端用 gzip 传输, 大页面下载更快
    std::string cmd = "curl.exe -s -L -f --compressed --max-time 90 " + args;
    FILE* p = _popen(cmd.c_str(), "rb");
    if (!p) return false;
    char buf[4096];
    out.clear();
    size_t n = 0;
    while ((n = fread(buf, 1, sizeof(buf), p)) > 0) out.append(buf, n);
    int rc = _pclose(p);
    return rc == 0 && !out.empty();
}

// GET 一个页面/接口
bool curlGet(const std::string& url, const std::string& cookie, std::string& out) {
    std::string a = "-A \"" + std::string(kBrowserUa) + "\"";
    if (!cookie.empty()) a += " -H \"Cookie: " + sanitizeArg(cookie) + "\"";
    a += " \"" + sanitizeArg(url) + "\"";
    return curlRequest(a, out);
}

// POST 表单
bool curlPostForm(const std::string& url, const std::string& cookie,
                  const std::string& referer, const std::string& form, std::string& out) {
    std::string a = "-A \"" + std::string(kBrowserUa) + "\"";
    if (!cookie.empty()) a += " -H \"Cookie: " + sanitizeArg(cookie) + "\"";
    if (!referer.empty()) a += " -H \"Referer: " + sanitizeArg(referer) + "\"";
    a += " --data \"" + sanitizeArg(form) + "\" \"" + sanitizeArg(url) + "\"";
    return curlRequest(a, out);
}

// 二进制安全地读整个文件
std::string readFileBinary(const std::string& path) {
    std::ifstream in(path, std::ios::binary);
    if (!in) return std::string();
    return std::string((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
}

// base64 编码: 把验证码图片内联给前端显示
std::string base64Encode(const std::string& data) {
    static const char kTable[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    out.reserve((data.size() + 2) / 3 * 4);
    size_t i = 0;
    while (i + 2 < data.size()) {
        unsigned v = (static_cast<unsigned char>(data[i]) << 16) |
                     (static_cast<unsigned char>(data[i + 1]) << 8) |
                     static_cast<unsigned char>(data[i + 2]);
        out += kTable[(v >> 18) & 63];
        out += kTable[(v >> 12) & 63];
        out += kTable[(v >> 6) & 63];
        out += kTable[v & 63];
        i += 3;
    }
    if (i + 1 == data.size()) {
        unsigned v = static_cast<unsigned char>(data[i]) << 16;
        out += kTable[(v >> 18) & 63];
        out += kTable[(v >> 12) & 63];
        out += "==";
    } else if (i + 2 == data.size()) {
        unsigned v = (static_cast<unsigned char>(data[i]) << 16) |
                     (static_cast<unsigned char>(data[i + 1]) << 8);
        out += kTable[(v >> 18) & 63];
        out += kTable[(v >> 12) & 63];
        out += kTable[(v >> 6) & 63];
        out += '=';
    }
    return out;
}

// 临时文件路径(用于 curl 的 body/header 中转)
std::string tempFilePath(const std::string& name) {
    std::error_code ec;
    fs::path dir = fs::temp_directory_path(ec);
    if (ec) dir = fs::current_path(ec);
    static int seq = 0;
    return (dir / ("oi-helper-" + std::to_string(++seq) + "-" + name)).string();
}

// 把响应头里的 set-cookie 合并进当前 Cookie 串(同名覆盖), 保证多步请求同一会话
std::string mergeCookies(const std::string& cookie, const std::string& headerText) {
    std::vector<std::pair<std::string, std::string>> pairs;
    auto setPair = [&](const std::string& name, const std::string& value) {
        for (auto& item : pairs) {
            if (item.first == name) {
                item.second = value;
                return;
            }
        }
        pairs.push_back({name, value});
    };
    size_t pos = 0;
    while (pos < cookie.size()) {
        size_t end = cookie.find(';', pos);
        std::string part = trim(cookie.substr(pos, end == std::string::npos ? std::string::npos : end - pos));
        size_t eq = part.find('=');
        if (eq != std::string::npos && eq > 0) setPair(part.substr(0, eq), part.substr(eq + 1));
        if (end == std::string::npos) break;
        pos = end + 1;
    }
    std::string lower = toLower(headerText);
    size_t cur = 0;
    while ((cur = lower.find("set-cookie:", cur)) != std::string::npos) {
        size_t lineEnd = headerText.find('\n', cur);
        std::string line = headerText.substr(cur + 11, lineEnd == std::string::npos ? std::string::npos
                                                                                  : lineEnd - cur - 11);
        size_t semi = line.find(';');
        std::string kv = trim(semi == std::string::npos ? line : line.substr(0, semi));
        size_t eq = kv.find('=');
        if (eq != std::string::npos && eq > 0) setPair(kv.substr(0, eq), kv.substr(eq + 1));
        if (lineEnd == std::string::npos) break;
        cur = lineEnd + 1;
    }
    std::string out;
    for (const auto& item : pairs) {
        if (item.first.empty()) continue;
        if (!out.empty()) out += "; ";
        out += item.first + "=" + item.second;
    }
    return out;
}

// 带响应头的 curl 请求: body 与 headers 落临时文件后读回(二进制安全)
bool curlRequestFull(const std::string& args, std::string& body, std::string& headers, bool followRedirect = true) {
    std::string bodyFile = tempFilePath("body");
    std::string headerFile = tempFilePath("hdr");
    std::string cmd = "curl.exe -s " + std::string(followRedirect ? "-L " : "") +
                      "--compressed --max-time 90 -D \"" + headerFile + "\" -o \"" + bodyFile +
                      "\" " + args;
    FILE* p = _popen(cmd.c_str(), "rb");
    if (!p) return false;
    char buf[1024];
    while (fread(buf, 1, sizeof(buf), p) > 0) { }
    int rc = _pclose(p);
    body = readFileBinary(bodyFile);
    headers = readFileBinary(headerFile);
    std::error_code ec;
    fs::remove(bodyFile, ec);
    fs::remove(headerFile, ec);
    return rc == 0;
}

// Codeforces / AtCoder / Hydro: 抓页面并按标签切题面与样例
OriginalResult fetchOriginalHttp(const std::string& url, const std::string& cookie, bool preferWinHttp) {
    OriginalResult r;
    r.oj = detectOj(url);
    r.url = url;
    HttpClient http;
    if (!http.ok()) {
        r.error = "初始化网络库失败(WinHTTP)";
        return r;
    }
    std::string page;
    std::string err;
    bool got = false;
    // Cloudflare/WAF 会拦截 WinHTTP 指纹, 这类站点默认直接走系统 curl
    const bool needsCurl = (r.oj == "codeforces" || r.oj == "hydro");
    if (needsCurl && !preferWinHttp) {
        got = curlGet(url, cookie, page);
    }
    if (!got) {
        // 先试内置网络库(省一次进程启动), 被拦或非 200 再回退 curl
        std::string headers =
            "User-Agent: " + std::string(kBrowserUa) + "\r\n"
            "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8\r\n"
            "Accept-Language: en-US,en;q=0.9,zh-CN;q=0.8\r\n"
            "Referer: " + url + "\r\n";
        if (!cookie.empty()) headers += "Cookie: " + cookie + "\r\n";
        std::string probe;
        if (http.request("GET", url, "", "", probe, err, headers) && http.status() == 200 &&
            !isAntiBotPage(probe)) {
            page = probe;
            got = true;
        } else if (!needsCurl) {
            // 其它站点不回落 curl, 直接报错
            if (isAntiBotPage(probe)) {
                r.error = "该站点有反爬验证(Cerberus/Anubis): 请先在浏览器打开该站通过验证, "
                          "再把整段 Cookie 填到设置的对应站点 Cookie 里后重试";
            } else if (probe.empty() && !err.empty()) {
                r.error = err;
            } else {
                std::string hint = trim(stripTags(htmlDecode(probe.substr(0, 400))));
                r.error = "抓取原题失败: HTTP " + std::to_string(http.status()) +
                          (hint.empty() ? "" : " | " + hint.substr(0, 160));
            }
            return r;
        }
    }
    if (!got) {
        if (!curlGet(url, cookie, page)) {
            r.error = "抓取题目失败: 该站点可能需要 Cookie 或网络不可达(见「Cookie 帮助」)";
            return r;
        }
    }
    // 反爬挑战页(Cerberus/Anubis 等): 需要浏览器通过验证后的 Cookie
    if (isAntiBotPage(page)) {
        r.error = "该站点有反爬验证(Cerberus/Anubis): 请先在浏览器打开该站通过验证, "
                  "再把整段 Cookie 填到设置的对应站点 Cookie 里(见「Cookie 帮助」)后重试";
        return r;
    }
    std::string title = pageTitle(page);
    std::string html;
    if (r.oj == "codeforces") {
        size_t p = page.find("class=\"problem-statement\"");
        if (p == std::string::npos) p = page.find("class='problem-statement'");
        if (p != std::string::npos) {
            size_t start = page.rfind("<div", p);
            if (start != std::string::npos) balancedInner(page, start, "div", html);
        }
        size_t t = html.find("class=\"title\"");
        if (t != std::string::npos) {
            size_t s = html.find('>', t);
            size_t e = html.find("</div>", s == std::string::npos ? t : s);
            if (s != std::string::npos && e != std::string::npos)
                title = trim(htmlDecode(stripTags(html.substr(s + 1, e - s - 1))));
        }
        r.submitUrl = detectOjSubmitUrl("codeforces", url);
    } else if (r.oj == "atcoder") {
        size_t p = page.find("id=\"task-statement\"");
        if (p != std::string::npos) {
            size_t start = page.rfind("<div", p);
            std::string whole;
            if (start != std::string::npos && balancedInner(page, start, "div", whole)) {
                // 优先英文题面
                size_t en = whole.find("lang-en");
                std::string part;
                if (en != std::string::npos && balancedInner(whole, whole.rfind("<span", en), "span", part) &&
                    !trim(stripTags(part)).empty())
                    html = part;
                else
                    html = whole;
            }
        }
        r.submitUrl = detectOjSubmitUrl("atcoder", url);
    } else {
        // Hydro: 题面分成多个 section__body 区块, 样例在靠后的区块里, 需要全部收集
        size_t p = 0;
        while ((p = page.find("section__body", p)) != std::string::npos) {
            size_t start = page.rfind("<div", p);
            std::string block;
            if (start != std::string::npos && balancedInner(page, start, "div", block)) {
                html += block;
                html += "\n";
            }
            p += 13;
        }
        r.submitUrl = url + "/submit";
    }
    if (html.empty()) html = dropScripts(page);
    r.title = title.empty() ? r.oj : title;
    r.html = dropScripts(html);
    r.samples = pairSamples(preTexts(html));
    r.ok = true;
    return r;
}

OriginalResult fetchOriginalWin(const std::string& url, const std::string& cookie, bool preferWinHttp) {
    std::string oj = detectOj(url);
    if (oj.empty()) {
        OriginalResult r;
        r.url = url;
        r.error = "无法识别该站点: 仅支持 洛谷/Codeforces/AtCoder/Hydro 的题目页链接";
        return r;
    }
    if (oj == "luogu") return fetchOriginalLuogu(url, cookie);
    return fetchOriginalHttp(url, cookie, preferWinHttp);
}

// 从链接里解析 Codeforces 的 contestId 与题号, 如 /problemset/problem/1760/G
bool parseCfRef(const std::string& url, std::string& cid, std::string& idx) {
    size_t p = url.find("/problem/");
    if (p == std::string::npos) p = url.find("problemCode=");
    if (p == std::string::npos) return false;
    if (url.compare(p, 9, "/problem/") == 0) {
        size_t s = p + 9;
        while (s < url.size() && !std::isdigit(static_cast<unsigned char>(url[s]))) ++s;
        size_t e = s;
        while (e < url.size() && std::isdigit(static_cast<unsigned char>(url[e]))) ++e;
        if (e == s) return false;
        cid = url.substr(s, e - s);
        size_t i = url.find_first_not_of('/', e);
        if (i == std::string::npos) return false;
        size_t j = i;
        while (j < url.size() && (std::isalnum(static_cast<unsigned char>(url[j])))) ++j;
        if (j == i) return false;
        idx = url.substr(i, j - i);
        return true;
    }
    // ?problemCode=1760G
    size_t s = p + 12;
    size_t j = s;
    while (j < url.size() && std::isalnum(static_cast<unsigned char>(url[j]))) ++j;
    std::string code = url.substr(s, j - s);
    size_t k = 0;
    while (k < code.size() && std::isdigit(static_cast<unsigned char>(code[k]))) ++k;
    if (k == 0) return false;
    cid = code.substr(0, k);
    idx = code.substr(k);
    return !idx.empty();
}

// 从链接里解析 AtCoder 的 contest 与 task, 如 /contests/abc300/tasks/abc300_a
bool parseAtRef(const std::string& url, std::string& contest, std::string& task) {
    size_t p = url.find("/contests/");
    if (p == std::string::npos) return false;
    size_t s = p + 10;
    size_t e = url.find('/', s);
    if (e == std::string::npos) return false;
    contest = url.substr(s, e - s);
    size_t t = url.find("/tasks/", e);
    if (t == std::string::npos) return false;
    size_t ts = t + 7;
    size_t te = url.find_first_of("?#", ts);
    task = url.substr(ts, te == std::string::npos ? std::string::npos : te - ts);
    return !contest.empty() && !task.empty();
}

std::string detectOjSubmitUrl(const std::string& oj, const std::string& url) {
    std::string cid;
    std::string idx;
    if (oj == "codeforces" && parseCfRef(url, cid, idx))
        return "https://codeforces.com/problemset/submit/" + cid + "/" + idx;
    std::string contest;
    std::string task;
    if (oj == "atcoder" && parseAtRef(url, contest, task))
        return "https://atcoder.jp/contests/" + contest + "/submit";
    return url;
}

// Codeforces/AtCoder 表单直连提交
OriginalSubmitResult submitOriginalForm(const std::string& oj, const std::string& url,
                                        const std::string& source, const std::string& lang,
                                        const std::string& cookie, HttpClient& http) {
    OriginalSubmitResult r;
    r.oj = oj;
    std::string submitUrl = detectOjSubmitUrl(oj, url);
    std::string headers = "User-Agent: " + std::string(kBrowserUa) + "\r\n"
                          "Accept: text/html,application/xhtml+xml\r\n";
    if (!cookie.empty()) headers += "Cookie: " + cookie + "\r\n";
    std::string page;
    std::string err;
    if (oj == "codeforces" && curlGet(submitUrl, cookie, page)) {
        // 已通过 curl 取到提交页
    } else if (!http.request("GET", submitUrl, "", "", page, err, headers)) {
        r.message = err;
        return r;
    }
    if (page.find("action=\"/enter") != std::string::npos || page.find("loginForm") != std::string::npos) {
        r.message = "未登录: 请在设置中配置该 OJ 的 Cookie";
        return r;
    }
    std::string form = "";
    std::string postUrl = submitUrl;
    std::string csrf;
    std::vector<std::string> keys = langKeys(lang);
    if (oj == "codeforces") {
        size_t c = page.find("name='csrf_token'");
        if (c == std::string::npos) c = page.find("name=\"csrf_token\"");
        csrf = c == std::string::npos ? "" : trim(attrAfter(page, c, "value"));
        size_t sel = page.find("name=\"programTypeId\"");
        if (sel == std::string::npos) sel = page.find("name='programTypeId'");
        std::string langId = sel == std::string::npos ? "" : pickLangInSelect(page, sel, keys);
        if (csrf.empty()) {
            r.message = "未取到 csrf_token: 可能未登录(请配置 Codeforces Cookie)";
            return r;
        }
        if (langId.empty()) {
            r.message = "未找到合适的语言选项(需为 C++ 或 Pascal)";
            return r;
        }
        std::string cid;
        std::string idx;
        parseCfRef(url, cid, idx);
        form = "csrf_token=" + urlEncode(csrf) +
               "&action=submitSolutionFormSubmitted" +
               "&submittedProblemCode=" + urlEncode(cid + idx) +
               "&programTypeId=" + urlEncode(langId) +
               "&source=" + urlEncode(source) +
               "&tabSize=4&sourceFile=";
        postUrl = "https://codeforces.com/problemset/submit?csrf_token=" + urlEncode(csrf);
    } else {
        // AtCoder: csrf_token 存在 cookie 中
        size_t tc = cookie.find("csrf_token=");
        if (tc != std::string::npos) {
            size_t s = tc + 11;
            size_t e = cookie.find(';', s);
            csrf = cookie.substr(s, e == std::string::npos ? std::string::npos : e - s);
        }
        size_t sel = page.find("name=\"data.LanguageId\"");
        std::string langId = sel == std::string::npos ? "" : pickLangInSelect(page, sel, keys);
        std::string contest;
        std::string task;
        parseAtRef(url, contest, task);
        if (csrf.empty()) {
            r.message = "未取到 csrf_token: 请在设置的 AtCoder Cookie 中包含 csrf_token";
            return r;
        }
        if (langId.empty()) {
            r.message = "未找到合适的语言选项(需为 C++ 或 Pascal)";
            return r;
        }
        form = "csrf_token=" + urlEncode(csrf) +
               "&data.TaskScreenName=" + urlEncode(task) +
               "&data.LanguageId=" + urlEncode(langId) +
               "&sourceCode=" + urlEncode(source);
        postUrl = "https://atcoder.jp/contests/" + contest + "/submit";
    }
    std::string resp;
    std::string serr;
    std::string h2 = headers + "Referer: " + submitUrl + "\r\n";
    bool posted = false;
    if (oj == "codeforces") posted = curlPostForm(postUrl, cookie, submitUrl, form, resp);
    if (!posted) {
        if (!http.request("POST", postUrl, form, "application/x-www-form-urlencoded", resp, serr,
                          h2)) {
            r.message = serr;
            return r;
        }
    }
    if (resp.find("submitted successfully") != std::string::npos ||
        resp.find("提出") != std::string::npos) {
        r.ok = true;
        r.message = "已提交";
        return r;
    }
    if (resp.find("exactly the same code") != std::string::npos) {
        r.message = "提交失败: 与上次提交的代码完全相同";
        return r;
    }
    if (resp.find("submissionId") != std::string::npos || resp.find("submission_id") != std::string::npos) {
        r.ok = true;
        r.message = "已提交";
        return r;
    }
    std::string why = jumbotronText(resp);
    r.message = "提交失败" + (why.empty() ? std::string(": 未确认提交结果") : ": " + why);
    return r;
}

// 洛谷直连提交: meta csrf-token + /fe/api/problem/submit/<pid>
OriginalSubmitResult submitOriginalLuogu(const std::string& url, const std::string& source,
                                         const std::string& lang, const std::string& cookie,
                                         const std::string& captcha) {
    OriginalSubmitResult r;
    r.oj = "luogu";
    std::string pid = luoguPid(url);
    if (pid.empty()) {
        r.message = "无法从链接解析洛谷题号";
        return r;
    }
    if (lang == "pas" || lang == "pascal") {
        r.message = "洛谷直连暂只支持 C++, 请改用「打开提交页」手动提交";
        return r;
    }
    // 全程用 curl 并合并响应的 set-cookie: 验证码答案绑定在会话 Cookie 上,
    // 必须保证取验证码与提交用同一会话
    std::string jar = cookie;
    // 注意: 洛谷对「curl + 浏览器 UA」的组合会返回重定向循环, 这里保留 curl 默认 UA
    auto run = [&](const std::string& args, std::string& body) -> bool {
        std::string a;
        if (!jar.empty()) a += "-H \"Cookie: " + sanitizeArg(jar) + "\" ";
        a += args;
        std::string headers;
        if (!curlRequestFull(a, body, headers)) {
            return false;
        }
        jar = mergeCookies(jar, headers);
        return true;
    };
    // 1. 题目页取 csrf-token
    std::string page;
    if (!run("-H \"Accept: text/html,application/xhtml+xml\" \"" +
                 sanitizeArg("https://www.luogu.com.cn/problem/" + pid) + "\"", page)) {
        r.message = "洛谷题目页请求失败, 请检查网络";
        return r;
    }
    size_t m = page.find("csrf-token");
    std::string csrf = m == std::string::npos ? "" : trim(attrAfter(page, m, "content"));
    if (csrf.empty()) {
        r.message = "未取到洛谷 csrf-token: 请检查设置中的洛谷 Cookie";
        return r;
    }
    // 2. 该题允许的语言(acceptLanguages)
    std::vector<int> allowed;
    std::string cbody;
    if (run("-H \"Accept: application/json, text/plain, */*\" -H \"x-lentille-request: content-only\" \"" +
                sanitizeArg("https://www.luogu.com.cn/problem/" + pid + "?_contentOnly=1") + "\"", cbody)) {
        Json croot;
        std::string cperr;
        if (Json::parse(cbody, croot, cperr)) {
            const Json& arr = croot["data"]["problem"]["acceptLanguages"];
            for (size_t i = 0; i < arr.size(); ++i) {
                int id = arr.at(i).getInt(-1);
                if (id >= 0) allowed.push_back(id);
            }
        }
    }
    // 常见 C++ 编译器 id, 取该题允许的第一个
    static const int kCppLangs[] = {28, 4, 3, 2, 5, 27, 14, 15, 17};
    std::string langId;
    for (int cand : kCppLangs) {
        if (allowed.empty() || std::find(allowed.begin(), allowed.end(), cand) != allowed.end()) {
            langId = std::to_string(cand);
            break;
        }
    }
    if (langId.empty()) {
        std::string list;
        for (int id : allowed) {
            if (!list.empty()) list += ", ";
            list += std::to_string(id);
        }
        r.message = "该题不支持 C++ 提交(可用语言 id: " + list + "), 请改用「打开提交页」手动提交";
        return r;
    }
    // 3. 提交(JSON 走临时文件, 避免命令行引号被破坏)
    Json body = Json::makeObject();
    body["code"] = Json::makeString(source);
    body["lang"] = Json::makeInt(std::atoll(langId.c_str()));
    body["enableO2"] = Json::makeBool(true);
    if (!captcha.empty()) body["captcha"] = Json::makeString(captcha);
    std::string jsonFile = tempFilePath("submit.json");
    {
        std::ofstream out(jsonFile, std::ios::binary);
        out << body.dump();
    }
    std::string resp;
    bool sent = run("-H \"Accept: application/json, text/plain, */*\" -H \"Content-Type: application/json\""
                    " -H \"x-csrf-token: " + sanitizeArg(csrf) +
                    "\" -H \"Referer: " + sanitizeArg("https://www.luogu.com.cn/problem/" + pid) +
                    "\" --data-binary @\"" + jsonFile + "\" \"" +
                    sanitizeArg("https://www.luogu.com.cn/fe/api/problem/submit/" + pid) + "\"", resp);
    std::error_code ec;
    fs::remove(jsonFile, ec);
    if (!sent) {
        r.message = "提交请求失败, 请检查网络";
        return r;
    }
    Json rroot;
    std::string perr;
    if (!Json::parse(resp, rroot, perr)) {
        r.message = "响应无法解析: " + trim(resp.substr(0, 80));
        return r;
    }
    long long rid = rroot["rid"].getInt(-1);
    if (rid < 0) rid = rroot["data"]["rid"].getInt(-1);
    if (rid < 0) rid = rroot["id"].getInt(-1);
    if (rid >= 0) {
        r.ok = true;
        r.submissionId = std::to_string(rid);
        r.message = "已提交";
        // 回传本次会话 Cookie, 供后续轮询该提交的结果
        r.cookie = jar;
        return r;
    }
    // 不带「提交失败: 」前缀, 由前端统一加, 避免出现两层前缀
    std::string msg;
    if (rroot.contains("errorMessage")) {
        msg = rroot["errorMessage"].getString();
    } else if (rroot.contains("errorType")) {
        msg = rroot["errorType"].getString() + "(可能未登录或 Cookie 失效)";
    } else {
        msg = "未确认提交结果";
    }
    if (msg.find("验证码") == std::string::npos) {
        r.message = msg;
        return r;
    }
    // 需要验证码: 首次拉图交给前端弹窗输入, 已输入过则提示重试
    r.cookie = jar;
    if (!captcha.empty()) {
        r.message = "验证码错误, 请重新输入或换一张";
        return r;
    }
    std::string img;
    if (run("-H \"Accept: image/avif,image/webp,image/*,*/*;q=0.8\" \"" +
                sanitizeArg("https://www.luogu.com.cn/api/verify/captcha") + "\"", img) && !img.empty()) {
        r.needCaptcha = true;
        r.captchaImage = "data:image/jpeg;base64," + base64Encode(img);
        r.cookie = jar;
        r.message = "需要图形验证码";
        return r;
    }
    r.message = "验证码图片获取失败, 请改用「打开提交页」手动提交";
    return r;
}

// 从响应头/正文里取记录页路径, 如 /d/PHIOITeam/record/6ac8eaed9d62437afd6c49d1 或 /record/123
// Hydro 的提交号是 24 位十六进制串, 且可能带 domain 前缀
std::string recordPathOf(const std::string& text) {
    size_t p = text.find("/record/");
    while (p != std::string::npos) {
        size_t s = p + 8;
        size_t e = s;
        while (e < text.size() && std::isalnum(static_cast<unsigned char>(text[e]))) ++e;
        if (e - s >= 4) {
            size_t start = p;
            size_t d = text.rfind("/d/", p);
            if (d != std::string::npos && d < p) {
                std::string between = text.substr(d + 3, p - d - 3);
                if (!between.empty() && between.find('/') == std::string::npos && between.size() < 40) {
                    start = d;
                }
            }
            return text.substr(start, e - start);
        }
        p = text.find("/record/", p + 1);
    }
    return "";
}

// 记录页路径最后一段(提交号)
std::string recordIdOf(const std::string& path) {
    size_t p = path.rfind('/');
    return p == std::string::npos ? path : path.substr(p + 1);
}

// 从页面里取 csrf token(meta 或 window.csrfToken = "...")
std::string extractCsrfToken(const std::string& page) {
    for (const char* key : {"csrf-token", "csrfToken", "csrf"}) {
        size_t p = page.find(key);
        while (p != std::string::npos && p < page.size()) {
            std::string v = trim(attrAfter(page, p, "content"));
            if (v.size() >= 8) return v;
            size_t q = p;
            while (q < page.size() && page[q] != '"' && page[q] != '\'' && q - p < 80) ++q;
            if (q < page.size() && q - p < 80) {
                char quote = page[q];
                size_t q2 = page.find(quote, q + 1);
                if (q2 != std::string::npos && q2 - q > 8) return page.substr(q + 1, q2 - q - 1);
            }
            p = page.find(key, p + 1);
        }
    }
    return "";
}

// Hydro(SOJ): 题目页取语言与 csrf, POST <题目页>/submit
OriginalSubmitResult submitOriginalHydro(const std::string& url, const std::string& source,
                                         const std::string& lang, const std::string& cookie) {
    OriginalSubmitResult r;
    r.oj = "hydro";
    std::string base = trim(url);
    size_t cut = base.find_first_of("?#");
    if (cut != std::string::npos) base = base.substr(0, cut);
    if (base.size() > 7 && base.compare(base.size() - 7, 7, "/submit") == 0) base = base.substr(0, base.size() - 7);
    while (!base.empty() && base.back() == '/') base.pop_back();
    if (base.empty()) {
        r.message = "无法解析题目地址";
        return r;
    }
    std::string jar = normalizeCookie(cookie);
    auto request = [&](const std::string& args, std::string& body, std::string& headers, bool follow) -> bool {
        std::string a;
        if (!jar.empty()) a += "-H \"Cookie: " + sanitizeArg(jar) + "\" ";
        a += args;
        if (!curlRequestFull(a, body, headers, follow)) {
            return false;
        }
        jar = mergeCookies(jar, headers);
        return true;
    };
    std::string page;
    std::string headers;
    if (!request("\"" + sanitizeArg(base) + "\"", page, headers, true)) {
        r.message = "打开题目页失败, 请检查网络";
        return r;
    }
    if (isAntiBotPage(page)) {
        r.message = "该站点有反爬验证: 请在浏览器通过验证后, 把整段 Cookie 填到 Hydro Cookie 再试";
        return r;
    }
    // 提交表单里的语言选项(value 即 Hydro 的语言 id, 如 cc.cc17o2)
    std::string langId;
    size_t sel = page.find("name=\"lang\"");
    if (sel == std::string::npos) sel = page.find("name='lang'");
    if (sel == std::string::npos) sel = page.find("id=\"lang\"");
    if (sel != std::string::npos) {
        langId = pickLangInSelect(page, sel, langKeys(lang));
    }
    if (langId.empty()) {
        langId = "cc.cc17o2";
    }
    std::string csrf = extractCsrfToken(page);
    // 源码走文件, 避免命令行长度与转义问题
    std::string codeFile = tempFilePath("submit.cpp");
    {
        std::ofstream out(codeFile, std::ios::binary);
        out << source;
    }
    std::string args = "-H \"Accept: text/html,application/xhtml+xml\" ";
    args += "-H \"Referer: " + sanitizeArg(base) + "\" ";
    args += "--data-urlencode \"lang=" + sanitizeArg(langId) + "\" ";
    args += "--data-urlencode \"code@" + codeFile + "\" ";
    if (!csrf.empty()) args += "--data-urlencode \"csrfToken=" + sanitizeArg(csrf) + "\" ";
    args += "\"" + sanitizeArg(base + "/submit") + "\"";
    std::string body;
    std::string respHeaders;
    const bool posted = request(args, body, respHeaders, false);
    std::error_code ec;
    fs::remove(codeFile, ec);
    if (!posted) {
        r.message = "提交请求失败, 请检查网络";
        return r;
    }
    std::string path = recordPathOf(respHeaders + "\n" + body);
    if (!path.empty()) {
        r.ok = true;
        r.submissionId = recordIdOf(path);
        r.recordPath = path;
        r.message = "已提交";
        r.cookie = jar;
        return r;
    }
    std::string hint = trim(stripTags(htmlDecode(body.substr(0, 300))));
    r.message = "提交失败: " + (hint.empty() ? "未确认提交结果(语言 id=" + langId + ")" : hint.substr(0, 120));
    return r;
}

// 在记录页正文里找已知的评测状态词
std::string hydroStatusOf(const std::string& text) {
    static const char* kWanted[] = {
        "Accepted", "Wrong Answer", "Time Limit Exceeded", "Memory Limit Exceeded",
        "Runtime Error", "Compile Error", "System Error", "Output Limit Exceeded",
        "Waiting", "Judging", "Compiling",
        "答案正确", "答案错误", "运行超时", "内存超限", "运行错误", "编译错误", "系统错误",
        "等待评测", "评测中", "编译中"
    };
    for (const char* word : kWanted) {
        if (text.find(word) != std::string::npos) {
            return word;
        }
    }
    return "";
}

// Hydro: 记录页解析状态文本
SolutionResult fetchSolutionResultHydroWin(const std::string& rid, const std::string& base, const std::string& cookie) {
    SolutionResult r;
    std::string root = trim(base);
    if (root.empty()) {
        r.message = "缺少站点地址";
        return r;
    }
    size_t scheme = root.find("://");
    if (scheme != std::string::npos) {
        size_t slash = root.find('/', scheme + 3);
        if (slash != std::string::npos) root = root.substr(0, slash);
    }
    std::string jar = normalizeCookie(cookie);
    // rid 可含 domain 前缀(如 /d/PHIOITeam/record/xxx), 否则按 /record/<id> 拼
    std::string path = trim(rid);
    std::string url = root;
    if (!path.empty() && path[0] == '/') {
        url += path;
    } else {
        url += "/record/" + path;
    }
    std::string a;
    if (!jar.empty()) a += "-H \"Cookie: " + sanitizeArg(jar) + "\" ";
    a += "-H \"Referer: " + sanitizeArg(root + "/") + "\" ";
    a += "\"" + sanitizeArg(url) + "\"";
    std::string body;
    std::string headers;
    if (!curlRequestFull(a, body, headers)) {
        r.message = "记录页打开失败";
        return r;
    }
    r.raw = trim(body.substr(0, 200));
    std::string text;
    size_t p = body.find("record-status--text");
    if (p == std::string::npos) p = body.find("record-status");
    if (p != std::string::npos) {
        size_t gt = body.find('>', p);
        size_t lt = gt == std::string::npos ? std::string::npos : body.find('<', gt + 1);
        if (gt != std::string::npos && lt != std::string::npos) {
            text = trim(htmlDecode(stripTags(body.substr(gt + 1, lt - gt - 1))));
        }
    }
    if (text.empty()) {
        // 回退: 在整页文本里找已知状态词
        text = hydroStatusOf(stripTags(htmlDecode(body)));
    }
    if (text.empty()) {
        // 带上状态行与正文长度, 便于判断是 404/登录页还是空响应
        std::string statusLine = trim(headers.substr(0, headers.find('\n')));
        std::string snippet = trim(stripTags(htmlDecode(body.substr(0, 150))));
        r.message = "未取到记录状态(" + statusLine + ", 正文 " + std::to_string(body.size()) + " 字节)" +
                    (snippet.empty() ? "" : ": " + snippet);
        return r;
    }
    r.ok = true;
    r.text = text;
    r.finished = text.find("Waiting") == std::string::npos && text.find("Judging") == std::string::npos &&
                 text.find("等待") == std::string::npos && text.find("评测中") == std::string::npos;
    r.result = 0;
    return r;
}

// HUSTOJ 结果码 -> 中文名
std::string resultText(int code) {
    switch (code) {
        case 0: return "等待评测";
        case 1: return "等待重测";
        case 2: return "编译中";
        case 3: return "运行中";
        case 4: return "Accepted";
        case 5: return "格式错误";
        case 6: return "答案错误";
        case 7: return "运行超时";
        case 8: return "内存超限";
        case 9: return "输出超限";
        case 10: return "运行错误";
        case 11: return "编译错误";
        case 12: return "编译成功";
        case 13: return "测试运行";
        case 14: return "人工确认";
        case 15: return "提交中";
        case 16: return "远程等待";
        case 17: return "远程评测";
        default: return "未知(" + std::to_string(code) + ")";
    }
}

// 查询提交结果: GET status-ajax.php?solution_id=<sid>, 返回 "结果码,耗时,内存"
SolutionResult fetchSolutionResultWin(int solutionId, const std::string& user,
                                      const std::string& password) {
    SolutionResult r;
    if (solutionId <= 0) {
        r.message = "缺少提交号";
        return r;
    }
    HttpClient http;
    if (!http.ok()) {
        r.message = "初始化网络库失败(WinHTTP)";
        return r;
    }
    std::string err;
    if (!prepareSession(http, user, password, err)) {
        r.message = err;
        return r;
    }
    std::string body;
    std::string herr;
    std::string headers =
        "Accept: text/plain, */*\r\n"
        "X-Requested-With: XMLHttpRequest\r\n";
    std::string url =
        "https://www.xmoj.tech/status-ajax.php?solution_id=" + std::to_string(solutionId);
    if (!http.request("GET", url, "", "", body, herr, headers)) {
        r.message = herr;
        return r;
    }
    if (http.status() != 200) {
        r.message = "查询提交结果失败: HTTP " + std::to_string(http.status());
        return r;
    }
    // 形如 "4,19376,91"
    int parts[3] = {-1, 0, 0};
    size_t p = 0;
    for (int i = 0; i < 3; ++i) {
        while (p < body.size() && !std::isdigit(static_cast<unsigned char>(body[p])) && body[p] != '-')
            ++p;
        if (p >= body.size()) break;
        size_t start = p;
        if (body[p] == '-') ++p;
        while (p < body.size() && std::isdigit(static_cast<unsigned char>(body[p]))) ++p;
        parts[i] = std::atoi(body.substr(start, p - start).c_str());
        while (p < body.size() && (body[p] == ',' || body[p] == ' ')) ++p;
    }
    if (parts[0] < 0) {
        r.message = "提交结果响应无法解析";
        return r;
    }
    r.result = parts[0];
    r.timeMs = parts[1];
    r.memoryKb = parts[2];
    r.finished = r.result >= 4;
    r.text = resultText(r.result);
    r.ok = true;
    return r;
}

// 洛谷提交记录状态码 -> 文本
std::string luoguStatusText(int code) {
    switch (code) {
        case 0: return "排队中";
        case 1: return "评测中";
        case 2: return "编译错误";
        case 3: return "输出超限";
        case 4: return "内存超限";
        case 5: return "运行超时";
        case 6: return "答案错误";
        case 7: return "运行错误";
        case 12: return "Accepted";
        case 14: return "未通过";
        case 21: return "Hack 成功";
        default: return "状态 " + std::to_string(code);
    }
}

// 洛谷提交结果查询: 记录页的内容接口(需登录 Cookie)
SolutionResult fetchSolutionResultLuoguWin(long long rid, const std::string& cookie) {
    SolutionResult r;
    std::string a;
    std::string jar = normalizeCookie(cookie);
    if (!jar.empty()) a += "-H \"Cookie: " + sanitizeArg(jar) + "\" ";
    a += "-H \"Accept: application/json, text/plain, */*\" -H \"x-lentille-request: content-only\" \"" +
         std::string("https://www.luogu.com.cn/record/") + std::to_string(rid) + "?_contentOnly=1\"";
    std::string body;
    std::string headers;
    if (!curlRequestFull(a, body, headers)) {
        r.message = "洛谷记录查询失败";
        return r;
    }
    Json root;
    std::string perr;
    if (!Json::parse(body, root, perr)) {
        r.message = "洛谷记录解析失败";
        r.raw = trim(body.substr(0, 300));
        return r;
    }
    r.raw = trim(body.substr(0, 300));
    const Json& rec = root["data"]["record"];
    int status = rec["status"].getInt(-1);
    if (status < 0) {
        std::string msg = root["data"]["errorMessage"].getString();
        r.message = msg.empty() ? "未取到洛谷记录(可能未登录)" : msg;
        return r;
    }
    r.ok = true;
    r.result = status;
    r.text = luoguStatusText(status);
    r.timeMs = rec["time"].getInt(0);
    r.memoryKb = rec["memory"].getInt(0);
    r.finished = status != 0 && status != 1;
    return r;
}

OriginalSubmitResult submitOriginalWin(const OriginalSubmitOptions& opt) {
    OriginalSubmitResult r;
    if (opt.url.empty() || opt.file.empty()) {
        r.message = "缺少原题链接或源码文件";
        return r;
    }
    std::ifstream in(opt.file, std::ios::binary);
    if (!in) {
        r.message = "无法读取源码文件: " + opt.file;
        return r;
    }
    std::string source((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
    in.close();
    std::string oj = detectOj(opt.url);
    r.oj = oj;
    if (oj.empty()) {
        r.message = "无法识别该站点: 仅支持 洛谷/Codeforces/AtCoder/Hydro 的题目页链接";
        return r;
    }
    if (oj == "luogu") return submitOriginalLuogu(opt.url, source, opt.lang, opt.cookie, opt.captcha);
    if (oj == "hydro") return submitOriginalHydro(opt.url, source, opt.lang, opt.cookie);
    if (oj == "codeforces" || oj == "atcoder") {
        HttpClient http;
        if (!http.ok()) {
            r.message = "初始化网络库失败(WinHTTP)";
            return r;
        }
        return submitOriginalForm(oj, opt.url, source, opt.lang, opt.cookie, http);
    }
    r.message = "该 OJ(如 Hydro)暂不支持直连提交, 请用「打开提交页」手动提交";
    return r;
}

#endif  // _WIN32

}  // namespace

// 查询洛谷提交结果(记录页内容接口); 需登录 Cookie
SolutionResult fetchSolutionResultLuogu(long long rid, const std::string& cookie) {
#ifdef _WIN32
    return fetchSolutionResultLuoguWin(rid, cookie);
#else
    SolutionResult r;
    r.message = "该功能仅在 Windows 下可用";
    return r;
#endif
}

// 查询 Hydro 提交结果(记录页); rid 为记录页路径或提交号, base 为题目页地址
SolutionResult fetchSolutionResultHydro(const std::string& rid, const std::string& base, const std::string& cookie) {
#ifdef _WIN32
    return fetchSolutionResultHydroWin(rid, base, cookie);
#else
    SolutionResult r;
    r.message = "该功能仅在 Windows 下可用";
    return r;
#endif
}

// 规范化用户粘贴的 Cookie: 去掉 "Cookie:" 前缀与换行, 统一为 "k=v; k=v"
std::string normalizeCookie(const std::string& raw) {
    std::string text;
    text.reserve(raw.size());
    for (char c : raw) {
        if (c == '\r' || c == '\n' || c == '\t') {
            text += ';';
        } else {
            text += c;
        }
    }
    std::string out;
    size_t pos = 0;
    while (pos <= text.size()) {
        size_t end = text.find(';', pos);
        std::string part = trim(text.substr(pos, end == std::string::npos ? std::string::npos : end - pos));
        if (part.size() > 7 && toLower(part.substr(0, 7)) == "cookie:") {
            part = trim(part.substr(7));
        }
        if (!part.empty()) {
            if (!out.empty()) out += "; ";
            out += part;
        }
        if (end == std::string::npos) break;
        pos = end + 1;
    }
    return out;
}

OriginalResult fetchOriginal(const std::string& url, const std::string& cookie, bool preferWinHttp) {
    OriginalResult r;
    r.url = url;
    r.oj = detectOj(url);
#ifdef _WIN32
    return fetchOriginalWin(url, cookie, preferWinHttp);
#else
    r.error = "仅支持 Windows(WinHTTP)";
    return r;
#endif
}

OriginalSubmitResult submitOriginal(const OriginalSubmitOptions& opt) {
#ifdef _WIN32
    return submitOriginalWin(opt);
#else
    OriginalSubmitResult r;
    r.message = "仅支持 Windows(WinHTTP)";
    return r;
#endif
}

SolutionResult fetchSolutionResult(int solutionId, const std::string& user,
                                   const std::string& password) {
#ifdef _WIN32
    return fetchSolutionResultWin(solutionId, user, password);
#else
    SolutionResult r;
    r.message = "仅支持 Windows(WinHTTP)";
    return r;
#endif
}


FetchResult fetchProblem(const FetchOptions& opt) {
    FetchResult r;
    r.url = opt.url;
    if (opt.url.empty()) {
        r.error = "缺少题目 URL";
        return r;
    }

#ifdef _WIN32
    HttpClient http;
    if (!http.ok()) {
        r.error = "初始化网络库失败(WinHTTP)";
        return r;
    }

    // 洛谷: 走独立 JSON 解析, 不使用 xmoj 登录流程
    if (isLuoguUrl(opt.url)) {
        std::string pid = luoguPid(opt.url);
        if (pid.empty()) {
            r.error = "无法从 URL 解析洛谷题号(如 P1001)";
            return r;
        }
        return fetchLuogu(http, opt, pid);
    }

    // 1. 建立会话并可选登录
    std::string err;
    if (!prepareSession(http, opt.user, opt.password, err)) {
        r.error = err;
        return r;
    }

    // 3. 抓取题目页
    std::string page;
    if (!http.request("GET", opt.url, "", "", page, err)) {
        r.error = err;
        return r;
    }
    if (http.status() != 200) {
        r.error = "抓取题目页失败: HTTP " + std::to_string(http.status());
        return r;
    }
    if (page.empty()) {
        r.error = "题目页内容为空";
        return r;
    }

    // 4. 解析
    std::string name = extractName(page);
    int pid = extractPidFromPage(page);
    if (pid < 0) pid = extractPidFromUrl(opt.url);
    if (pid < 0) {
        r.error = "无法解析题目 ID(pid)";
        return r;
    }
    if (name.empty()) {
        name = std::to_string(pid);
        r.warnings.push_back("未解析到题目名称");
    }

    // 旧版竞赛链接(problem.php?cid=&pid=): 顺带取来源字段(供原题功能使用)
    std::string qcid;
    std::string qpid;
    if (queryValue(opt.url, "cid", qcid) && queryValue(opt.url, "pid", qpid) && !qcid.empty() &&
        !qpid.empty()) {
        std::string num(1, static_cast<char>('A' + std::atoi(qpid.c_str())));
        std::string api = "https://www.xmoj.tech/api/contest/" + qcid + "/" + num + "?lang=cn";
        std::string aj;
        std::string aerr;
        std::string ah =
            "Accept: application/json, text/plain, */*\r\n"
            "X-Requested-With: XMLHttpRequest\r\n"
            "Referer: " + opt.url + "\r\n";
        if (http.request("GET", api, "", "", aj, aerr, ah)) {
            Json aroot;
            std::string perr;
            if (Json::parse(aj, aroot, perr)) r.source = aroot["problem"]["source"].getString();
        }
    }

    // 页面缺少题目特征(如未登录被重定向): 直接报错而非静默成功
    if (page.find("请登录") != std::string::npos ||
        (page.find("时间限制") == std::string::npos &&
         page.find("data-sample") == std::string::npos)) {
        r.error = "页面不含题目内容, 可能需要登录. 请配置 oiHelper.xmojUser / oiHelper.xmojPassword, 或使用 --fetch-user/--fetch-pass.";
        return r;
    }

    std::string inFile = textAfterLabel(page, "输入文件:");
    std::string outFile = textAfterLabel(page, "输出文件:");
    bool fileIO =
        !inFile.empty() && !outFile.empty() && inFile != "标准输入" && outFile != "标准输出";

    int timeMs = 1000;
    int memMb = 256;
    std::string timeText = textAfterLabel(page, "时间限制:");
    int sec = leadingInt(timeText);
    if (sec > 0) timeMs = sec * 1000;
    std::string memText = textAfterLabel(page, "内存限制:");
    int mb = leadingInt(memText);
    if (mb > 0) memMb = mb;

    std::vector<std::pair<std::string, std::string>> samples;
    extractSamples(page, samples);
    if (samples.empty()) r.warnings.push_back("未解析到样例测试点");

    // 内联模式: 不创建目录/写文件, 仅回传样例内容(附件跳过)
    if (opt.inlineSamples) {
        r.ok = true;
        r.pid = pid;
        r.name = name;
        r.fileIO = fileIO;
        r.tests = static_cast<int>(samples.size());
        if (fileIO) {
            r.freopenIn = inFile;
            r.freopenOut = outFile;
        }
        for (const auto& s : samples) r.samples.push_back({s.first, s.second});
        return r;
    }

    // 5. 下载附件到内存 (保证落盘原子性)
    struct Attachment {
        std::string fileName;
        std::string data;
        bool isZip = false;
    };
    std::vector<Attachment> attachments;
    std::string origin = urlOrigin(opt.url);
    for (const std::string& href : extractAttachments(page)) {
        std::string full = absoluteUrl(origin, href);
        std::string abody;
        std::string aerr;
        if (!http.request("GET", full, "", "", abody, aerr) || http.status() != 200 ||
            abody.empty()) {
            r.warnings.push_back("附件下载失败: " + href);
            continue;
        }
        Attachment a;
        a.fileName = filenameOf(full);
        a.data = std::move(abody);
        std::string low = toLower(a.fileName);
        a.isZip = low.size() >= 4 && low.substr(low.size() - 4) == ".zip";
        attachments.push_back(std::move(a));
    }

    // 6. 全部抓取解析成功后再落盘
    fs::path base = opt.outBaseDir.empty() ? fs::current_path() : fs::path(opt.outBaseDir);
    fs::path dir = base / std::to_string(pid);
    std::error_code ec;
    fs::create_directories(dir, ec);
    if (ec) {
        r.error = "无法创建目录: " + dir.string();
        return r;
    }

    Json root = Json::makeObject();
    root["name"] = Json::makeString(name);
    root["type"] = Json::makeString("traditional");
    root["timeLimit"] = Json::makeInt(timeMs);
    root["memoryLimit"] = Json::makeInt(memMb);
    root["standard"] = Json::makeString("c++14");
    root["optimize"] = Json::makeString("O2");
    root["checker"] = Json::makeString("diff");
    if (fileIO) {
        Json fr = Json::makeObject();
        fr["in"] = Json::makeString(inFile);
        fr["out"] = Json::makeString(outFile);
        root["freopen"] = fr;
    }
    Json tests = Json::makeArray();
    for (size_t i = 0; i < samples.size(); ++i) {
        Json t = Json::makeObject();
        t["id"] = Json::makeInt(static_cast<long long>(i + 1));
        t["in"] = Json::makeString(std::to_string(i + 1) + ".in");
        t["out"] = Json::makeString(std::to_string(i + 1) + ".ans");
        tests.arrVal.push_back(t);
    }
    root["tests"] = tests;
    root["sourceUrl"] = Json::makeString(opt.url);

    if (!writeFile((dir / "problem.json").string(), root.dump(true) + "\n")) {
        r.error = "无法写入 problem.json";
        return r;
    }
    for (size_t i = 0; i < samples.size(); ++i) {
        std::string n = std::to_string(i + 1);
        if (!writeFile((dir / (n + ".in")).string(), samples[i].first) ||
            !writeFile((dir / (n + ".ans")).string(), samples[i].second)) {
            r.error = "无法写入样例文件 " + n;
            return r;
        }
    }

    if (!attachments.empty()) {
        fs::path attDir = dir / "attachment";
        fs::create_directories(attDir, ec);
        for (Attachment& a : attachments) {
            fs::path fp = attDir / a.fileName;
            if (!writeFile(fp.string(), a.data)) {
                r.warnings.push_back("附件保存失败: " + a.fileName);
                continue;
            }
            r.attachments++;
            if (a.isZip) {
                std::string cmd = "tar -xf \"" + fp.string() + "\" -C \"" + attDir.string() + "\"";
                int rc = std::system(cmd.c_str());
                if (rc == 0) {
                    fs::remove(fp, ec);
                } else {
                    r.warnings.push_back("zip 解压失败, 保留原文件: " + a.fileName);
                }
            }
        }
    }

    r.ok = true;
    r.pid = pid;
    r.name = name;
    r.fileIO = fileIO;
    r.tests = static_cast<int>(samples.size());
    r.dir = dir.string();
    if (fileIO) {
        r.freopenIn = inFile;
        r.freopenOut = outFile;
    }
    return r;
#else
    r.error = "仅支持 Windows(WinHTTP)";
    return r;
#endif
}

ContestResult fetchContestProblem(const FetchOptions& opt) {
    ContestResult r;
    if (opt.url.empty()) {
        r.error = "缺少题目 URL";
        return r;
    }
    std::string cid;
    std::string num;
    if (!parseContestUrl(opt.url, cid, num)) {
        r.error = "无法解析竞赛题目链接(形如 https://www.xmoj.tech/web/contest/10780/A)";
        return r;
    }

#ifdef _WIN32
    HttpClient http;
    if (!http.ok()) {
        r.error = "初始化网络库失败(WinHTTP)";
        return r;
    }
    std::string err;
    if (!prepareSession(http, opt.user, opt.password, err)) {
        r.error = err;
        return r;
    }
    return fetchContest(http, cid, num);
#else
    r.error = "仅支持 Windows(WinHTTP)";
    return r;
#endif
}

ExtraResult fetchExtraSamples(const std::string& url, const std::string& outDir, const FetchOptions& opt) {
    ExtraResult r;
    r.dir = outDir;
    if (url.empty()) {
        r.error = "缺少下载链接";
        return r;
    }
    if (outDir.empty()) {
        r.error = "缺少解压目录";
        return r;
    }
#ifdef _WIN32
    HttpClient http;
    if (!http.ok()) {
        r.error = "初始化网络库失败(WinHTTP)";
        return r;
    }
    std::string err;
    if (!prepareSession(http, opt.user, opt.password, err)) {
        r.error = err;
        return r;
    }
    std::string body;
    std::string headers = "Referer: https://www.xmoj.tech/\r\n";
    if (!http.request("GET", absoluteUrl("https://www.xmoj.tech", url), "", "", body, err, headers)) {
        r.error = err;
        return r;
    }
    if (http.status() != 200 || body.empty()) {
        r.error = "下载样例失败: HTTP " + std::to_string(http.status());
        return r;
    }
    // 「更多样例」固定为 zip 压缩包, 以 PK 魔数判断(忽略链接后缀)
    if (!(body.size() > 4 && body[0] == 'P' && body[1] == 'K')) {
        r.error = "下载内容不是压缩包, 可能需要登录";
        return r;
    }
    std::error_code ec;
    fs::create_directories(outDir, ec);
    if (ec) {
        r.error = "无法创建目录: " + outDir;
        return r;
    }
    fs::path archive = fs::path(outDir) / "extra.zip";
    if (!writeFile(archive.string(), body)) {
        r.error = "无法写入文件: " + archive.string();
        return r;
    }
    std::string cmd = "tar -xf \"" + archive.string() + "\" -C \"" + outDir + "\"";
    if (std::system(cmd.c_str()) != 0) {
        r.error = "解压失败: " + archive.string();
        return r;
    }
    fs::remove(archive, ec);
    for (const auto& de : fs::recursive_directory_iterator(outDir, ec)) {
        if (!de.is_regular_file()) {
            continue;
        }
        r.files.push_back(fs::relative(de.path(), outDir, ec).generic_string());
    }
    std::sort(r.files.begin(), r.files.end());
    if (r.files.empty()) {
        r.error = "压缩包内没有文件";
        return r;
    }
    r.ok = true;
    return r;
#else
    r.error = "仅支持 Windows(WinHTTP)";
    return r;
#endif
}

SubmitResult submitSolution(const SubmitOptions& opt) {
    SubmitResult r;
    r.url = "https://www.xmoj.tech/status.php";
    if (opt.url.empty()) {
        r.message = "缺少题目 URL";
        return r;
    }
    if (opt.file.empty()) {
        r.message = "缺少源码文件";
        return r;
    }
    if (opt.user.empty()) {
        r.message = "缺少登录用户名, 请用 --fetch-user/--fetch-pass 指定";
        return r;
    }

#ifdef _WIN32
    // 读取源码文件
    std::ifstream in(opt.file, std::ios::binary);
    if (!in) {
        r.message = "无法读取源码文件: " + opt.file;
        return r;
    }
    std::string source((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
    in.close();

    HttpClient http;
    if (!http.ok()) {
        r.message = "初始化网络库失败(WinHTTP)";
        return r;
    }

    // 1. 登录
    std::string err;
    if (!prepareSession(http, opt.user, opt.password, err)) {
        r.message = err;
        return r;
    }

    // 2. 判断提交目标: 竞赛题目须带 cid/pid, 公开题目用 id
    std::string page;
    if (!http.request("GET", opt.url, "", "", page, err)) {
        r.message = err;
        return r;
    }
    if (http.status() != 200) {
        r.message = "抓取题目页失败: HTTP " + std::to_string(http.status());
        return r;
    }
    int pid = extractPidFromPage(page);
    if (pid < 0) pid = extractPidFromUrl(opt.url);

    std::string cid;       // 竞赛号, 非空表示竞赛提交
    std::string cpid;      // 竞赛内题号(0 起)
    std::string langmask;  // 竞赛语言掩码
    std::string cnum;
    if (parseContestUrl(opt.url, cid, cnum)) {
        // 新版竞赛链接(/web/contest/{cid}/{num}): 走 api/contest 取 problemId 与 submitUrl
        std::string api = "https://www.xmoj.tech/api/contest/" + cid + "/" + cnum + "?lang=cn";
        std::string aj;
        std::string aerr;
        std::string ah =
            "Accept: application/json, text/plain, */*\r\n"
            "X-Requested-With: XMLHttpRequest\r\n"
            "Referer: " + opt.url + "\r\n";
        if (http.request("GET", api, "", "", aj, aerr, ah)) {
            Json root;
            std::string perr;
            if (Json::parse(aj, root, perr)) {
                const Json& pj = root["problem"]["problemId"];
                if (pid < 0)
                    pid = pj.type == Json::Type::String ? std::atoi(pj.strVal.c_str())
                                                        : static_cast<int>(pj.getInt(-1));
                // 提交页与竞赛题号以接口下发的 submitUrl 为准
                std::string su = root["submitUrl"].getString();
                std::string qcid;
                std::string qpid;
                if (queryValue(su, "cid", qcid) && !qcid.empty()) cid = qcid;
                queryValue(su, "pid", cpid);
                queryValue(su, "langmask", langmask);
                if (pid < 0) {
                    int ip = extractPidFromUrl(su);
                    if (ip >= 0) pid = ip;
                }
                if (langmask.empty()) {
                    long long lm = root["contest"]["langmask"].getInt(-1);
                    if (lm >= 0) langmask = std::to_string(lm);
                }
            }
        }
        if (cpid.empty() && !cnum.empty())
            cpid = std::to_string(std::toupper(static_cast<unsigned char>(cnum[0])) - 'A');
    } else {
        // 旧版竞赛链接(problem.php?cid=&pid= 等)
        std::string qcid;
        std::string qpid;
        if (queryValue(opt.url, "cid", qcid) && queryValue(opt.url, "pid", qpid) && !qcid.empty() &&
            !qpid.empty()) {
            cid = qcid;
            cpid = qpid;
        }
    }
    if (pid < 0 && cid.empty()) {
        r.message = "无法解析题目 ID(pid): 该链接不是 xmoj 题目, 非 xmoj 题目请用「提交原题」提交";
        return r;
    }
    if (pid >= 0) r.problemId = pid;

    // 3. 取 csrf 令牌(须与提交在同一会话内)
    std::string csrfPage;
    if (!http.request("GET", "https://www.xmoj.tech/csrf.php", "", "", csrfPage, err)) {
        r.message = err;
        return r;
    }
    std::string csrf = extractCsrf(csrfPage);
    if (csrf.empty()) {
        r.message = "无法获取 csrf 令牌";
        return r;
    }

    // 4. 语言映射(竞赛题走竞赛提交页, 公开题走 ?id=)
    std::string langUrl =
        cid.empty() ? "https://www.xmoj.tech/submitpage.php?id=" + std::to_string(pid)
                    : "https://www.xmoj.tech/submitpage.php?cid=" + cid + "&pid=" + cpid +
                          (langmask.empty() ? "" : "&langmask=" + langmask);
    std::string langPage;
    if (!http.request("GET", langUrl, "", "", langPage, err)) {
        r.message = err;
        return r;
    }
    std::string langVal = matchLanguage(langPage, opt.lang);
    if (langVal.empty()) {
        std::string hint = jumbotronText(langPage);
        if (hint.empty())
            r.message = "不支持的语言: " + opt.lang + "(未取到语言列表)";
        else if (cid.empty() && hint.find("无权访问") != std::string::npos)
            r.message =
                "该题不在公开题库(可能属于竞赛), 请改用竞赛题目链接提交: "
                "https://www.xmoj.tech/web/contest/<竞赛号>/<题号>";
        else
            r.message = hint;
        return r;
    }

    // 5. 提交(ajax 模式服务端直接回显 solution id)
    std::string form = cid.empty() ? "id=" + std::to_string(pid) + "&"
                                   : "cid=" + cid + "&pid=" + cpid + "&";
    form += "language=" + urlEncode(langVal) + "&source=" + urlEncode(source) +
            "&enable_O2=on&csrf=" + urlEncode(csrf);
    std::string resp;
    std::string serr;
    if (!http.request("POST", "https://www.xmoj.tech/submit.php?ajax", form,
                      "application/x-www-form-urlencoded", resp, serr)) {
        r.message = serr;
        return r;
    }

    // 6. 解析结果: 正常回显数字 id, 其余为错误页
    std::string body = trim(resp);
    if (allDigits(body)) {
        r.ok = true;
        r.solutionId = std::atoi(body.c_str());
        r.message = "已提交";
        return r;
    }
    int sid = extractSolutionId(body);
    if (sid >= 0) {
        r.ok = true;
        r.solutionId = sid;
        r.message = "已提交";
        return r;
    }
    if (body == "-1") {
        r.message = "提交被拒: 题目不可用或提交受限";
        return r;
    }
    std::string why = jumbotronText(body);
    r.message = why.empty() ? "提交失败: 未获得 solution id" : "提交失败: " + why;
    return r;
#else
    r.message = "仅支持 Windows(WinHTTP)";
    return r;
#endif
}

}  // namespace oi
