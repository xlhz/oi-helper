# Checklist

- [x] C++ 评测核心可编译为 `oi-judge` 可执行文件
- [x] `problem.json` 字段解析与默认值（1s/256MB、CCF 编译参数）实现如规格
- [x] 测试点自动配对（`1.in/1.out`、`name1.in/name1.out`）正确
- [x] 编译模块默认使用 `g++ -O2 -std=c++14 -DONLINE_JUDGE` 且标准/优化可切换
- [x] 编译失败返回 `CE` 并附带 stderr 摘要，不运行程序
- [x] `freopen` 自动解析生成对应文件名并读取结果，规格如描述
- [x] 无 `freopen` 代码可走管道 stdin/stdout 正常评测
- [x] 环境自动探测（WSL/MinGW）与手动选择实现如规格
- [x] WSL + isolate 强隔离运行，限制 CPU 时间/内存/进程数（注：本机无 isolate，isolate 调用代码已实现，实测走降级路径）
- [x] 无 WSL 时回退 Job Object 受限模式并在结果标注隔离级别
- [x] 超时判 `TLE`、超内存判 `MLE`、异常退出判 `RE`
- [x] CCF 比对规则（忽略行末空格、文末空行、CR）实现如规格
- [x] 浮点误差比对按 `eps` 生效
- [x] SPJ 支持 `checker: "testlib"`，调用 C++ checker 判定正确
- [x] 子任务 subtask 组内全过才得分，总分累加正确
- [x] 交互题通过双向管道运行并正确判定
- [x] 提交答案题 output-only 跳过编译直接比对
- [x] 通信题多源文件编译并按协议接通管道判定
- [x] 多测试点批量与可配置并行度（默认串行）实现如规格
- [x] `result.json` 含逐点状态、耗时、内存、子任务得分与总分
- [x] CLI 参数与退出码实现如规格
- [x] 本地 REST API `/judge` 返回评测 JSON
- [x] MCP Server 以 stdio 暴露评测工具且结果与 CLI 一致
- [x] VSCode 插件命令面板、右键评测、树视图、Webview 均可用（注：已编译并打包 `.vsix`，未在 VSCode 运行时实机验证）
- [x] 示例题目覆盖各题型且端到端跑通
- [x] 插件可打包为 `.vsix`
- [x] 下一版本预更新说明（`roadmap.md`）已记录未纳入首期的项

## 实测记录（2026-10-05）

| 用例 | 命令要点 | 结果 |
|---|---|---|
| P1001 传统题 + freopen + subtask | `--problem problems/P1001` | AC 100/100（2 点，50+50） |
| PA 自动配对 + 标准 IO + 行末空格容差 | `--problem`（无 tests 字段） | AC 100/100（2 点） |
| PA 并行度 | `--jobs 2` | AC 100/100 |
| TLE 死循环 | 时限 1000ms | TLE |
| FLT 浮点 eps | `checker=float, eps=1e-6` | AC |
| SPJ1 testlib 特判 | `--problem problems/SPJ1` | AC 100/100 |
| OUT1 提交答案题 | `--src answer.txt` | AC 100/100 |
| INT1 交互题 | `--problem problems/INT1` | AC 100/100 |
| COM1 通信题 | `--problem problems/COM1` | AC 100/100 |
| REST `/judge` | `POST {"problemDir":"problems/P1001"}` | status=AC |
| 隔离降级 | `--env wsl` | isolation=jobobject, isolationDegraded=true |
| 插件打包 | `vsce package` | `oi-helper-0.0.1.vsix`（16 files, 21KB） |

## 已知环境限制

- 本机无 `isolate`，WSL2 + isolate 的真隔离路径无法实机验证，仅验证了「不可用时降级到 Job Object 且标注隔离级别」。
- VSCode 插件仅完成静态编译与打包，未在 VSCode 运行时做交互验证。
- Windows 上 MinGW 程序冷启动 wall 约 1s（CPU 仅数十 ms），运行器已改为「wall 等待 = 时限 + 3000ms 宽限，超时以 CPU 时间判定并容忍 200ms 启动开销」，避免把冷启动误判为 TLE。
