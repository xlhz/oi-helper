# OI 评测系统 Spec

## Why

OI 选手与出题人需要在本地快速验证代码：给定 `.cpp`、测试点与预期输出，立即得到是否通过及各测试点的耗时/内存。现有本地工具要么只支持单文件简单比对，要么无法还原 CCF 考场行为（编译参数、资源限制、freopen、子任务计分）。本项目提供一个贴近 CCF 标准考试环境的评测系统，并以 VSCode 插件为主入口，解决"写完题无法快速自测"的问题。

## What Changes

- 新增 C++ 评测核心（命令行 exe）：编译、运行、限制、比对、计分。
- 新增 VSCode 插件（TypeScript）：命令面板、编辑器右键、树视图、结果 Webview。
- 新增题目目录包规范（`problem.json` + 测试点文件）与手动选文件对两种输入方式。
- 新增 WSL2 + isolate 强隔离；无 WSL 时自动降级为 Windows Job Object 受限模式。
- 新增题型支持：传统题、交互题、提交答案题（output-only）、通信题、子任务 subtask 计分。
- 新增 SPJ：C++ checker + testlib.h。
- 新增对外接口：CLI、MCP Server、本地 REST API。
- 新增结果 JSON 落盘（每测试点状态/耗时/内存/总分）。
- **BREAKING**：无（全新项目）。

## Impact

- Affected specs：新建 `core`（C++ 评测核心）、`extension`（VSCode 插件）、`mcp`（MCP Server）、`api`（本地 REST）四项能力。
- Affected code：全新仓库，主要目录 `core/`、`extension/`、`mcp/`、`testlib/`、`problems/`（示例题目）。

## ADDED Requirements

### Requirement: 评测核心 CLI

系统 SHALL 提供 C++ 编写的命令行评测核心，接受题目目录或测试点文件对，输出结构化 JSON 结果与退出码。

#### Scenario: 单个源文件 + 手动测试点

- **WHEN** 用户执行 `oi-judge --src a.cpp --in 1.in --out 1.out --time 1000 --memory 256`
- **THEN** 系统编译并运行 `a.cpp`，比对输出，输出 JSON（含状态、耗时、内存）并以 0 退出

#### Scenario: 目录包批量

- **WHEN** 用户执行 `oi-judge --problem problems/P1001`
- **THEN** 系统读取 `problem.json`，按测试点顺序依次评测并输出汇总

### Requirement: 编译参数

系统 SHALL 默认使用 CCF 考场参数 `g++ -O2 -std=c++14 -DONLINE_JUDGE`，并允许在题目配置或命令行切换标准与优化等级。

#### Scenario: 切换标准

- **WHEN** 题目配置 `standard` 设为 `c++17`
- **THEN** 编译使用 `-std=c++17`，其余默认参数不变

#### Scenario: 编译错误

- **WHEN** 源码编译失败
- **THEN** 结果状态为 `CE`，附带编译器 stderr 摘要，不运行程序

### Requirement: freopen 自动解析

系统 SHALL 扫描源码中的 `freopen("name", "r/w", stdin/stdout)` 调用，自动将测试点输入/输出写到对应文件名后再运行；对不带 freopen 的标准 IO 代码 SHALL 仍能正常评测。

#### Scenario: 代码含 freopen

- **WHEN** 源码存在 `freopen("P1001.in","r",stdin)` 与 `freopen("P1001.out","w",stdout)`
- **THEN** 系统把测试点输入写到运行目录下的 `P1001.in`，运行后从 `P1001.out` 读取结果比对

#### Scenario: 标准 IO 代码

- **WHEN** 源码无 freopen
- **THEN** 系统通过管道提供 stdin、收集 stdout 进行比对

### Requirement: 运行与资源限制

系统 SHALL 在强隔离下运行选手程序，强制时间与内存上限，超限判定 `TLE` / `MLE`，并保证隔离不可用时明确提示当前隔离级别。

#### Scenario: WSL + isolate 强隔离

- **WHEN** 检测到 WSL 可用且用户选择强隔离
- **THEN** 在 WSL 内以 isolate（cgroup+namespace）运行，限制 CPU 时间、内存、进程数

#### Scenario: 超时

- **WHEN** 程序运行时间超过题目时限
- **THEN** 该测试点状态为 `TLE`，进程被终止

#### Scenario: 隔离降级

- **WHEN** 无 WSL 且未指定隔离方式
- **THEN** 使用 Windows Job Object 受限模式运行，并在结果中标注隔离级别为 `jobobject`

### Requirement: 输出比对

系统 SHALL 按 CCF 规则比对输出：忽略每行行末空格、忽略文末空行、忽略行末 CR；题目可开启浮点误差容忍并指定误差范围。

#### Scenario: 行末空格差异

- **WHEN** 选手输出行末多出空格，其他内容一致
- **THEN** 判定为 `AC`

#### Scenario: 浮点误差

- **WHEN** 题目配置 `checker: "float"` 且误差阈值 `eps=1e-6`，输出数值在阈值内
- **THEN** 判定为 `AC`

### Requirement: SPJ 特判

系统 SHALL 支持题目配置 `checker: "testlib"`，编译用户提供的 C++ checker（含 testlib.h），以输入/选手输出/标准答案三文件参数调用并读取判定结果。

#### Scenario: 特判通过

- **WHEN** checker 返回 `ok` / 退出码 0 且给出正确分数
- **THEN** 该测试点判定为 `AC`

#### Scenario: 特判失败

- **WHEN** checker 返回 `wrong` / 非 0
- **THEN** 该测试点判定为 `WA`

### Requirement: 子任务 subtask 计分

系统 SHALL 支持题目配置将测试点分组为 subtask，subtask 内测试点全部通过才得该子任务分值，总分由各子任务累加。

#### Scenario: 子任务内存在失败点

- **WHEN** subtask 含 3 个测试点，其中 1 个 `WA`
- **THEN** 该 subtask 得 0 分，其余子任务照常计分

### Requirement: 交互题

系统 SHALL 支持交互题：编译选手程序，运行 interactor，通过双向管道交互，按交互结果判定。

#### Scenario: 交互题正常交互

- **WHEN** 题目配置 `type: "interactive"` 且提供 interactor
- **THEN** 系统启动 interactor 与选手程序并接通管道，按 interactor 输出判定 `AC`/`WA`

### Requirement: 提交答案题 output-only

系统 SHALL 支持提交答案题：不编译运行选手代码，直接以选手提交的文件与标准答案比对（支持精确或 SPJ）。

#### Scenario: 提交答案比对

- **WHEN** 题目配置 `type: "output-only"`，选手提交 `answer.out`
- **THEN** 系统与标准答案比对并返回判定结果

### Requirement: 通信题

系统 SHALL 支持通信题：将选手的多个源文件分别编译，运行多个进程并通过管道互相通信，按最终输出判定。

#### Scenario: 多源文件通信

- **WHEN** 题目配置 `type: "communication"` 且指定多个源文件
- **THEN** 系统分别编译并接通进程管道，按约定协议判定结果

### Requirement: 批量与并行度

系统 SHALL 支持单题多测试点批量评测，并允许配置并行度；默认串行以保证计时准确。

#### Scenario: 配置并行度

- **WHEN** 用户设置 `--jobs 4`
- **THEN** 系统最多并行 4 个测试点，结果按测试点编号聚合

### Requirement: 题目目录包

系统 SHALL 支持每题一个目录，含 `problem.json`（题目名、时限、内存、标准、freopen 文件名、题型、子任务、checker）与测试点文件，并自动按 `1.in/1.out`、`name1.in/name1.out` 配对。

#### Scenario: 自动配对

- **WHEN** 目录含 `1.in,1.out,2.in,2.out`
- **THEN** 系统识别为 2 个测试点并依次评测

### Requirement: VSCode 插件

系统 SHALL 提供 VSCode 插件，支持命令面板调用、编辑器右键评测当前文件、侧边树视图展示逐测试点状态、Webview 展示结果详情与总分。

#### Scenario: 右键评测

- **WHEN** 用户在 `.cpp` 文件右键选择"OI 评测"
- **THEN** 插件调用评测核心并在树视图与结果面板展示逐点结果

#### Scenario: 选择题目目录

- **WHEN** 用户选择题目目录进行批量评测
- **THEN** 插件按 `problem.json` 评测全部测试点并展示总分

### Requirement: 对外接口

系统 SHALL 除插件外提供 CLI、MCP Server、本地 REST API 三种调用方式。

#### Scenario: MCP 调用

- **WHEN** AI/agent 通过 MCP 调用评测工具
- **THEN** 返回与 CLI 一致的结构化评测结果

#### Scenario: REST 调用

- **WHEN** 外部程序 POST `/judge` 提交评测请求
- **THEN** 返回 JSON 评测结果

### Requirement: 环境自动探测与手动选择

系统 SHALL 自动探测可用评测环境（WSL/Linux + isolate、Windows MinGW g++），并允许用户在插件或命令行手动指定环境。

#### Scenario: 自动探测

- **WHEN** 系统启动且未指定环境
- **THEN** 优先选择 WSL，缺失时回退 MinGW，并在结果中标注所用环境

### Requirement: 结果输出

系统 SHALL 输出 JSON 结果文件，包含每个测试点的状态（`AC`/`WA`/`TLE`/`MLE`/`RE`/`CE`）、耗时、内存、子任务得分与总分。

#### Scenario: 生成结果文件

- **WHEN** 评测完成
- **THEN** 在工作目录生成 `result.json`，插件据此渲染面板
