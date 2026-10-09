#include <string>

#include "oi/cli.h"
#include "oi/compiler.h"

int main(int argc, char** argv) {
    std::string gpp = oi::findGpp();
    if (!gpp.empty()) oi::prependToolchainPath(gpp);
    return oi::runCli(argc, argv);
}
