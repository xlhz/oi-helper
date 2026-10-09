#pragma once
#include <string>

namespace oi {

// freopen 解析结果
struct FreopenScan {
    bool hasIn = false;
    std::string inName;
    bool hasOut = false;
    std::string outName;
};

// 扫描源码里的 freopen("name","r",stdin) 与 freopen("name","w",stdout)
FreopenScan scanFreopen(const std::string& srcFile);

}  // namespace oi
