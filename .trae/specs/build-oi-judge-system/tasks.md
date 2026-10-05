# Tasks

- [x] Task 1: 搭建仓库骨架与 C++ 核心工程
  - [x] SubTask 1.1: 建立目录结构 `core/`、`extension/`、`mcp/`、`testlib/`、`problems/`
  - [x] SubTask 1.2: 编写 `core/CMakeLists.txt`，产出 `oi-judge` 可执行文件
  - [x] SubTask 1.3: 定义核心数据结构（测试点、子任务、题型、判定状态、评测结果）

- [x] Task 2: 实现题目配置解析（`problem.json`）
  - [x] SubTask 2.1: 定义配置字段（name、timeLimit、memoryLimit、standard、optimize、freopen names、type、subtasks、checker、eps）
  - [x] SubTask 2.2: 实现轻量 JSON 解析与默认值（默认 1s/256MB、`-O2 -std=c++14 -DONLINE_JUDGE`）
  - [x] SubTask 2.3: 实现测试点自动配对（`1.in/1.out`、`name1.in/name1.out`）

- [x] Task 3: 实现编译模块
  - [x] SubTask 3.1: 组装 g++ 命令行，支持标准/优化可切换
  - [x] SubTask 3.2: 捕获编译输出，失败返回 `CE` 与 stderr 摘要

- [x] Task 4: 实现 freopen 自动解析
  - [x] SubTask 4.1: 扫描源码提取 `freopen` 的输入/输出文件名
  - [x] SubTask 4.2: 运行前把测试点输入写到对应文件名，运行后从对应输出文件名读取
  - [x] SubTask 4.3: 无 freopen 时走管道 stdin/stdout

- [x] Task 5: 实现运行与资源限制
  - [x] SubTask 5.1: 实现环境探测（WSL/Linux + isolate、Windows MinGW）与手动指定
  - [x] SubTask 5.2: 实现 WSL + isolate 强隔离运行，限制 CPU 时间/内存/进程数（本机无 isolate，仅验证降级路径）
  - [x] SubTask 5.3: 实现 Windows Job Object 受限模式回退，并在结果标注隔离级别
  - [x] SubTask 5.4: 判定 `TLE`/`MLE`/`RE`，记录真实耗时与峰值内存

- [x] Task 6: 实现输出比对
  - [x] SubTask 6.1: 实现 CCF 规则比对（忽略行末空格、文末空行、CR）
  - [x] SubTask 6.2: 实现浮点误差比对（按 `eps`）

- [x] Task 7: 实现 SPJ 特判
  - [x] SubTask 7.1: 引入 `testlib.h` 并编译用户 checker
  - [x] SubTask 7.2: 以三文件参数调用 checker，解析判定与分数

- [x] Task 8: 实现传统题评测与批量
  - [x] SubTask 8.1: 单测试点评测闭环（编译→运行→比对→判定）
  - [x] SubTask 8.2: 多测试点批量聚合与可配置并行度（默认串行）

- [x] Task 9: 实现子任务 subtask 计分
  - [x] SubTask 9.1: 按配置分组测试点，组内全过才得分
  - [x] SubTask 9.2: 汇总各子任务得分与总分

- [x] Task 10: 实现交互题
  - [x] SubTask 10.1: 编译选手程序与 interactor
  - [x] SubTask 10.2: 建立双向管道并运行，按 interactor 结果判定

- [x] Task 11: 实现提交答案题 output-only
  - [x] SubTask 11.1: 跳过编译，直接比对提交文件与标准答案（精确或 SPJ）

- [x] Task 12: 实现通信题
  - [x] SubTask 12.1: 编译多个源文件
  - [x] SubTask 12.2: 运行多进程并按协议接通管道，按最终输出判定

- [x] Task 13: 实现结果 JSON 输出与 CLI 入口
  - [x] SubTask 13.1: 输出 `result.json`（逐点状态、耗时、内存、子任务得分、总分）
  - [x] SubTask 13.2: 实现 CLI 参数（`--src/--in/--out/--problem/--time/--memory/--jobs/--env`）与退出码

- [x] Task 14: 实现本地 REST API
  - [x] SubTask 14.1: 提供 `/judge` 接口接收请求并返回评测 JSON

- [x] Task 15: 实现 MCP Server
  - [x] SubTask 15.1: 以 stdio 暴露评测工具，返回与 CLI 一致的结构化结果

- [x] Task 16: 实现 VSCode 插件
  - [x] SubTask 16.1: 插件骨架与命令面板命令
  - [x] SubTask 16.2: 编辑器右键"OI 评测"
  - [x] SubTask 16.3: 侧边树视图展示逐测试点状态
  - [x] SubTask 16.4: Webview 结果面板展示详情与总分

- [x] Task 17: 示例题目与端到端联调
  - [x] SubTask 17.1: 在 `problems/` 放置示例题目（含 freopen、SPJ、subtask、交互、output-only、通信）
  - [x] SubTask 17.2: 端到端跑通并打包插件 `.vsix`

# Task Dependencies

- Task 2 依赖 Task 1
- Task 3、Task 4 依赖 Task 2
- Task 5、Task 6 依赖 Task 3
- Task 7 依赖 Task 6
- Task 8 依赖 Task 5、Task 6
- Task 9、Task 10、Task 11、Task 12 依赖 Task 8
- Task 13 依赖 Task 8 至 Task 12
- Task 14、Task 15、Task 16 依赖 Task 13
- Task 17 依赖 Task 13 至 Task 16
