#include <string>
#include <vector>

#include "oi/cli.h"
#include "oi/compiler.h"

#ifdef _WIN32
#include <windows.h>

// Windows 下 main 的 argv 使用系统 ANSI 代码页(中文为 GBK), 统一转为 UTF-8
static std::string toUtf8(const std::wstring& w) {
    if (w.empty()) return std::string();
    int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), static_cast<int>(w.size()), nullptr, 0, nullptr, nullptr);
    std::string s(static_cast<size_t>(n), 0);
    WideCharToMultiByte(CP_UTF8, 0, w.c_str(), static_cast<int>(w.size()), &s[0], n, nullptr, nullptr);
    return s;
}
#endif

int main(int argc, char** argv) {
    std::string gpp = oi::findGpp();
    if (!gpp.empty()) oi::prependToolchainPath(gpp);
#ifdef _WIN32
    int wargc = 0;
    LPWSTR* wargv = CommandLineToArgvW(GetCommandLineW(), &wargc);
    if (wargv) {
        std::vector<std::string> args;
        args.reserve(static_cast<size_t>(wargc));
        for (int i = 0; i < wargc; ++i) {
            args.push_back(toUtf8(wargv[i]));
        }
        LocalFree(wargv);
        std::vector<char*> ptrs;
        ptrs.reserve(args.size());
        for (std::string& s : args) {
            ptrs.push_back(&s[0]);
        }
        return oi::runCli(static_cast<int>(ptrs.size()), ptrs.data());
    }
#endif
    return oi::runCli(argc, argv);
}
