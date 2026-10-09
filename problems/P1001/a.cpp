// P1001 示例: A+B (freopen 文件输入输出)
#include <cstdio>

int main() {
    freopen("P1001.in", "r", stdin);
    freopen("P1001.out", "w", stdout);
    long long a, b;
    if (scanf("%lld %lld", &a, &b) != 2) return 0;
    printf("%lld\n", a + b);
    return 0;
}
