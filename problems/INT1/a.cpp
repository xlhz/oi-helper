#include <iostream>

int main() {
    int a = 0, b = 0;
    if (!(std::cin >> a >> b)) return 0;
    std::cout << (a + b) << std::endl;
    return 0;
}
