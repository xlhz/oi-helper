# Checklist

- [x] `oi-judge --fetch` 能登录 xmoj 并抓取题目页
- [x] 时限/内存解析正确（`2 Sec`→2000, `256 MB`→256）
- [x] 标准 IO 题不写 `freopen`; 文件 IO 题写入正确的 `.in/.out` 文件名
- [x] 多组样例正确写成 `1.in/1.out` 等并登记 `tests`
- [x] `（无）` 输入写成空文件
- [x] 无样例时仍生成 `problem.json` 且不报致命错误
- [x] 「下载文件」附件可下载, zip 解压到 `attachment/`
- [x] 生成的题目目录可被 `oi-judge --problem` 正常评测（有/无 freopen 各一次）
- [x] 登录失败返回非零退出码且不生成半成品目录
- [x] 插件命令 `oiHelper.fetchProblem` 可用, 落到工作区 `problems/`
- [x] 插件可保存 xmoj 账号密码并自动登录
- [x] `tsc -p extension` 编译无错误

## 实测记录（2026-10-05）

| 用例 | 命令要点 | 结果 |
|---|---|---|
| 2298 签到题 | `--fetch problem.php?id=2298` | ok, pid=2298, fileIO=false, tests=1, 1 Sec→1000ms, 128MB, `1.in` 为空文件, `1.out`=`0` |
| 10745 pid0 小明的整齐队伍 | `--fetch problem.php?cid=10745&pid=0` | ok, pid=12148, fileIO=false, tests=4 |
| 10744 pid1 山地邮路 | `--fetch problem.php?cid=10744&pid=1` | ok, pid=12048, fileIO=true, freopen=road.in/road.out, 2 Sec→2000ms, tests=3, 附件 zip 解压出 subtask1..4.in/.ans |
| 冒烟评测（2298） | 写 `a.cpp` 输出 `0` 后 `--problem` | `签到题: AC 100/100 (1 tests)` |
| 冒烟评测（12048，freopen） | 写 `a.cpp` freopen + 输出 `YES` | 正常跑完, exit 0, tests=3, 状态 WA（样例答案不同, 非 CE） |
| 登录失败 | `--fetch-pass wrongpass` | stderr `登录失败: 用户名或密码错误`, exit 1, 未生成目录 |
| 非法 URL | `--fetch index.php` | stderr `无法解析题目 ID(pid)`, exit 1 |
| 核心构建 | `cmake --build ... --target oi-judge` | exit 0, `Built target oi-judge` |
| 插件编译 | `node ...\typescript\bin\tsc -p extension` | exit 0, 无输出, `out/fetch.js` 已生成 |

## 说明

- 抓取能力只覆盖题面结构与样例/大样例附件; 隐藏评测数据在 `admin/phpfm.php` 之后（该账号无权限）, 不在范围内.
- 插件为静态编译验证, 未在 VSCode 运行时实机交互（本机无可用 GUI 调试环境）.
- 实现期修复了核心既有 bug: 中文题名会使临时运行目录解析不一致, 已在 `judge.cpp` 加 `sanitizeName` 处理.
