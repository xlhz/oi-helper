#include "../../testlib/testlib.h"

int main(int argc, char* argv[]) {
    registerTestlibCmd(argc, argv);
    long long ja = ans.readLong();
    long long pa = ouf.readLong();
    if (ja == pa) quitf(_ok, "ok");
    quitf(_wa, "expected %lld, got %lld", ja, pa);
}
