#include "oi/freopen_scan.h"

#include <fstream>
#include <regex>
#include <sstream>

namespace oi {

FreopenScan scanFreopen(const std::string& srcFile) {
    FreopenScan r;
    std::ifstream in(srcFile, std::ios::binary);
    if (!in) return r;
    std::ostringstream ss;
    ss << in.rdbuf();
    std::string src = ss.str();

    // freopen("name", "mode", stdin|stdout)
    static const std::regex re(
        R"re(freopen\s*\(\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,\s*(stdin|stdout)\s*\))re");
    auto begin = std::sregex_iterator(src.begin(), src.end(), re);
    auto end = std::sregex_iterator();
    for (auto it = begin; it != end; ++it) {
        std::string name = (*it)[1].str();
        std::string mode = (*it)[2].str();
        std::string stream = (*it)[3].str();
        if (stream == "stdin" && !mode.empty() && mode[0] == 'r' && !r.hasIn) {
            r.hasIn = true;
            r.inName = name;
        } else if (stream == "stdout" && !mode.empty() && mode[0] == 'w' && !r.hasOut) {
            r.hasOut = true;
            r.outName = name;
        }
    }
    return r;
}

}  // namespace oi
