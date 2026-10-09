#include "oi/server.h"

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <filesystem>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

#include <winsock2.h>
#include <ws2tcpip.h>

#include "oi/config.h"
#include "oi/judge.h"
#include "oi/json.h"
#include "oi/types.h"

namespace fs = std::filesystem;

namespace oi {

namespace {

std::string errorJson(const std::string& msg) {
    Json root = Json::makeObject();
    root["error"] = Json::makeString(msg);
    return root.dump(false);
}

std::string toLower(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return s;
}

// 在题目目录中查找默认选手源码(与 CLI 逻辑一致)
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
            fn != "interactor.cpp")
            found.push_back(de.path().string());
    }
    std::sort(found.begin(), found.end());
    return found.empty() ? "" : found.front();
}

// 由请求 JSON 构造并执行评测; 非法请求返回 400
int handleJudge(const std::string& body, std::string& respBody) {
    Json req;
    std::string perr;
    if (!Json::parse(body, req, perr)) {
        respBody = errorJson("请求 JSON 解析失败: " + perr);
        return 400;
    }
    JudgeTask task;
    task.env = req["env"].getString("auto");
    task.jobs = static_cast<int>(req["jobs"].getInt(1));

    if (req.contains("problemDir")) {
        std::string dir = req["problemDir"].getString("");
        if (dir.empty()) {
            respBody = errorJson("problemDir 为空");
            return 400;
        }
        std::string lerr;
        task.problem = loadProblem(dir, lerr);
        if (!lerr.empty()) {
            respBody = errorJson(lerr);
            return 400;
        }
        if (req.contains("timeLimit")) task.problem.timeLimit = static_cast<int>(req["timeLimit"].getInt(task.problem.timeLimit));
        if (req.contains("memoryLimit")) task.problem.memoryLimit = static_cast<int>(req["memoryLimit"].getInt(task.problem.memoryLimit));
        task.srcFile = req["src"].getString("");
        if (task.problem.type != ProblemType::OutputOnly &&
            task.problem.type != ProblemType::Communication && task.srcFile.empty()) {
            task.srcFile = findDefaultSource(dir, task.problem.name);
        }
    } else if (req.contains("src")) {
        task.singleFile = true;
        task.srcFile = req["src"].getString("");
        if (task.srcFile.empty()) {
            respBody = errorJson("src 为空");
            return 400;
        }
        ProblemConfig& cfg = task.problem;
        cfg.name = fs::path(task.srcFile).stem().string();
        cfg.type = ProblemType::Traditional;
        cfg.timeLimit = static_cast<int>(req["timeLimit"].getInt(1000));
        cfg.memoryLimit = static_cast<int>(req["memoryLimit"].getInt(256));
        cfg.checker = req["checker"].getString("diff");
        cfg.eps = req["eps"].getDouble(1e-6);
        TestCase tc;
        tc.id = 1;
        tc.inputFile = req["input"].getString("");
        tc.outputFile = req["expected"].getString("");
        cfg.tests.push_back(tc);
    } else {
        respBody = errorJson("请求需包含 problemDir 或 src");
        return 400;
    }

    if (task.problem.tests.empty()) {
        respBody = errorJson("没有可用的测试点");
        return 400;
    }
    JudgeResult res = runJudge(task);
    respBody = buildResultJson(res).dump(false);
    return 200;
}

bool sendAll(SOCKET s, const std::string& data) {
    size_t sent = 0;
    while (sent < data.size()) {
        int n = send(s, data.data() + sent, static_cast<int>(data.size() - sent), 0);
        if (n <= 0) return false;
        sent += static_cast<size_t>(n);
    }
    return true;
}

void sendResponse(SOCKET s, int code, const std::string& body) {
    const char* reason = code == 200 ? "OK" : (code == 400 ? "Bad Request" : "Not Found");
    std::ostringstream oss;
    oss << "HTTP/1.1 " << code << " " << reason << "\r\n";
    oss << "Content-Type: application/json\r\n";
    oss << "Content-Length: " << body.size() << "\r\n";
    oss << "Connection: close\r\n\r\n";
    oss << body;
    sendAll(s, oss.str());
}

void handleClient(SOCKET client) {
    std::string data;
    char buf[4096];
    size_t headerEnd = std::string::npos;
    size_t contentLen = 0;
    while (true) {
        int n = recv(client, buf, sizeof(buf), 0);
        if (n <= 0) break;
        data.append(buf, static_cast<size_t>(n));
        if (headerEnd == std::string::npos) {
            headerEnd = data.find("\r\n\r\n");
            if (headerEnd != std::string::npos) {
                std::string headers = toLower(data.substr(0, headerEnd));
                size_t p = headers.find("content-length:");
                if (p != std::string::npos) {
                    size_t v = p + std::string("content-length:").size();
                    while (v < headers.size() && (headers[v] == ' ' || headers[v] == '\t')) ++v;
                    contentLen = std::strtoul(headers.c_str() + v, nullptr, 10);
                }
            }
        }
        if (headerEnd != std::string::npos && data.size() >= headerEnd + 4 + contentLen) break;
    }
    if (headerEnd == std::string::npos) {
        sendResponse(client, 400, errorJson("请求格式非法"));
        return;
    }
    std::string head = data.substr(0, headerEnd);
    std::string body = data.substr(headerEnd + 4);
    if (body.size() > contentLen) body.resize(contentLen);

    std::istringstream hs(head);
    std::string method, path;
    hs >> method >> path;
    if (method != "POST" || path != "/judge") {
        sendResponse(client, 400, errorJson("仅支持 POST /judge"));
        return;
    }
    std::string resp;
    int code = handleJudge(body, resp);
    sendResponse(client, code, resp);
}

}  // namespace

int serveHttp(int port) {
    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
        std::cerr << "WSAStartup 失败\n";
        return 2;
    }
    SOCKET listener = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (listener == INVALID_SOCKET) {
        std::cerr << "创建 socket 失败\n";
        WSACleanup();
        return 2;
    }
    int reuse = 1;
    setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, reinterpret_cast<const char*>(&reuse),
               sizeof(reuse));
    sockaddr_in addr;
    ZeroMemory(&addr, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_ANY);
    addr.sin_port = htons(static_cast<u_short>(port));
    if (bind(listener, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) == SOCKET_ERROR) {
        std::cerr << "bind 失败, 端口 " << port << " 可能被占用\n";
        closesocket(listener);
        WSACleanup();
        return 2;
    }
    if (listen(listener, SOMAXCONN) == SOCKET_ERROR) {
        std::cerr << "listen 失败\n";
        closesocket(listener);
        WSACleanup();
        return 2;
    }
    std::cout << "oi-judge REST 服务已启动, 监听 http://127.0.0.1:" << port << "/judge\n";
    std::cout.flush();
    while (true) {
        SOCKET client = accept(listener, nullptr, nullptr);
        if (client == INVALID_SOCKET) continue;
        handleClient(client);
        closesocket(client);
    }
    closesocket(listener);
    WSACleanup();
    return 0;
}

}  // namespace oi
