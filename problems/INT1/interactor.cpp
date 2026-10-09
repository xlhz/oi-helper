#include <fstream>
#include <iostream>

int main(int argc, char** argv) {
    if (argc < 2) return 2;
    std::ifstream fin(argv[1]);
    int a = 0, b = 0;
    if (!(fin >> a >> b)) return 2;
    std::cout << a << " " << b << std::endl;
    int ans = 0;
    if (!(std::cin >> ans)) return 1;
    return ans == a + b ? 0 : 1;
}
