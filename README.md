# OI Helper 使用说明

本地 OI 评测系统：给定 `.cpp` 与测试点，返回是否通过及各测试点耗时/内存。包含 C++ 评测核心、VSCode 插件、MCP Server 与本地 REST API。

## 目录结构

```
core/        C++ 评测核心 (命令行 oi-judge)
extension/   VSCode 插件
mcp/         MCP Server (stdio)
testlib/     testlib.h (SPJ 用)
problems/    示例题目
```

## 构建

```powershell
cmake -S core -B core/build -G "MinGW Makefiles" -DCMAKE_BUILD_TYPE=Release
cmake --build core/build --target oi-judge
```

产物：`core/build/oi-judge.exe`。

## 快速开始

评测题目目录：

```powershell
core/build/oi-judge.exe --problem problems/P1001 --pretty
```

评测单个源文件：

```powershell
core/build/oi-judge.exe --src problems/ICPC1/A/a.cpp --in problems/ICPC1/A/1.in --out problems/ICPC1/A/1.out --time 1000 --memory 256
```

## CLI 参数

| 参数 | 说明 | 默认 |
|---|---|---|
| `--problem <dir>` | 评测题目目录（读取 `problem.json`） | - |
| `--src <file>` | 单个源文件（与 `--in/--out` 搭配） | - |
| `--in <file>` | 测试点输入, 可重复; 与 `--out` 按顺序配对 | - |
| `--out <file>` | 测试点预期输出, 可重复 | - |
| `--time <ms>` | 时限 | 1000 |
| `--memory <mb>` | 内存限制 | 256 |
| `--jobs <n>` | 并行度 | 1 |
| `--standard <std>` | `c++11/c++14/c++17/c++20` | c++14 |
| `--optimize <o>` | `O0/O1/O2` | O2 |
| `--env <e>` | `auto/wsl/mingw` | auto |
| `--checker <c>` | `diff/float/testlib` | diff |
| `--format <f>` | `oi/icpc` | oi |
| `--eps <x>` | 浮点误差 | 1e-6 |
| `--json <file>` | 结果输出路径 | result.json |
| `--pretty` | 美化 JSON | - |
| `--serve <port>` | 启动本地 HTTP 评测服务(阻塞, 监听 `POST /judge`) | - |
| `--fetch <url>` | 抓取题目页(xmoj/洛谷)并生成题目目录 | - |
| `--fetch-out <dir>` | 抓取输出基础目录 | 当前工作目录 |
| `--fetch-user <u>` | xmoj 登录用户名 | - |
| `--fetch-pass <p>` | xmoj 登录密码 | - |
| `--fetch-cookie <c>` | 洛谷 Cookie(抓取需登录题目时使用) | - |
| `--fetch-inline` | 不落盘, 仅回传样例内容(JSON) | - |
| `--fetch-contest <url>` | 抓取新版竞赛题目(`/web/contest/{cid}/{num}`), 回传 JSON | - |
| `--fetch-extra <url>` | 下载竞赛「更多样例」压缩包并解压, 回传 JSON | - |
| `--fetch-extra-out <dir>` | 「更多样例」解压目录 | - |
| `--fetch-winhttp` | 抓取时强制使用内置网络库(不启动 curl) | - |
| `--fetch-original <url>` | 抓取原题(洛谷/CF/AtCoder/Hydro)题面与样例, 回传 JSON | - |
| `--submit <url>` | 提交源码到 xmoj(题目页 URL), 需 `--fetch-user/--fetch-pass` | - |
| `--submit-original <url>` | 直连提交源码到原题(洛谷/CF/AtCoder/Hydro), 需 `--fetch-cookie` | - |
| `--submit-result <sid>` | 查询某个提交的评测结果 | - |
| `--result-oj <oj>` | 结果查询站点: `xmoj`(默认, 需 `--fetch-user/--fetch-pass`) / `luogu`(需 `--fetch-cookie`) / `hydro`(需 `--fetch` 传题目页地址) | xmoj |
| `--submit-file <f>` | 待提交的源码文件 | - |
| `--submit-lang <l>` | `cpp/pas` | cpp |
| `--submit-captcha <c>` | 图形验证码(洛谷需要时) | - |
| `--version` / `--help` | 版本 / 帮助 | - |

退出码：`0` 评测流程完成（不论 AC/WA），`1` 用法或内部错误，`2` 编译环境不可用。

## problem.json

```json
{
  "name": "P1001",
  "type": "traditional",
  "timeLimit": 1000,
  "memoryLimit": 256,
  "standard": "c++14",
  "optimize": "O2",
  "checker": "diff",
  "eps": 1e-6,
  "freopen": { "in": "P1001.in", "out": "P1001.out" },
  "tests": [
    { "id": 1, "in": "1.in", "out": "1.out" },
    { "id": 2, "in": "2.in", "out": "2.out" }
  ],
  "subtasks": [
    { "id": 1, "score": 50, "tests": [1] },
    { "id": 2, "score": 50, "tests": [2] }
  ]
}
```

字段说明：

- `type`：`traditional`（默认）/ `interactive` / `output-only` / `communication`。
- `tests`：省略时自动扫描目录，按 `1.in/1.out`、`name1.in/name1.out` 成对配对。
- `freopen`：省略时自动扫描源码里的 `freopen("...","r/w",stdin/stdout)`；有则把测试点输入写到该文件名、从该输出文件名读结果，无则走 stdin/stdout 管道。
- `checker`：`diff`（CCF 规则，忽略行末空格、文末空行、CR）/ `float`（按 `eps` 比数值）/ `testlib`（编译 `checkerFile`，默认 `checker.cpp`，以 `<输入> <选手输出> <标准答案>` 三参数调用，退出码 0 为 AC）。
- `subtasks`：省略时每个测试点等权；有则组内全 AC 才得该组分数，总分累加。

各题型补充字段：

| 题型 | 额外字段 | 说明 |
|---|---|---|
| interactive | `interactor` | interactor 源文件；其 stdin/stdout 与选手程序交叉相连，测试输入文件路径作为第 1 个命令行参数传入；退出码 0 为 AC |
| output-only | 无（提交文件用 `--src` 指定） | 不编译，直接比对提交文件与 `tests[].out` |
| communication | `sources` | 源文件列表（简化实现仅支持 2 个），交叉管道相连，按 `tests[].out` 比对 |

## 结果 JSON

```json
{
  "problem": "P1001",
  "env": "mingw",
  "isolation": "jobobject",
  "isolationDegraded": false,
  "compileMessage": "",
  "subtasks": [{ "id": 1, "score": 50, "maxScore": 50, "tests": [1] }],
  "tests": [{ "id": 1, "status": "AC", "timeMs": 156, "memoryKb": 27952, "score": 100, "maxScore": 100, "message": "" }],
  "totalScore": 100,
  "maxScore": 100,
  "status": "AC"
}
```

`status` 取值：`AC` / `WA` / `TLE` / `MLE` / `RE` / `CE`。

## VSCode 插件

安装：扩展面板选择 `extension/oi-helper-0.1.0-pre.vsix`（或 `installer/build-vsix.ps1` 生成的 `oi-helper-0.1.0.vsix`）安装，或按 F5 以开发模式运行。

使用：

- 命令面板执行 `OI Helper: 打开评测面板`, 打开可视化面板(评测 / 结果 / 仪表盘 / 配置 四个视图); 面板内可直接点「开始评测」, 结果由结果视图渲染.
- 在 `.cpp` 文件上右键选择「OI 评测」，或用命令面板执行 `OI Helper: 评测题目目录`。
- 侧边栏「OI 评测结果」视图展示逐测试点状态，评测后自动弹出结果面板显示总分与明细。

配置（设置里搜 `oiHelper`）：

| 配置项 | 默认 | 说明 |
|---|---|---|
| `oiHelper.judgePath` | 空 | `oi-judge` 路径; 留空则在当前工作区下查找 `core/build/oi-judge(.exe)`; 多个工作区共用同一份时可在用户设置里填写绝对路径 |
| `oiHelper.xmojUser` | 空 | xmoj 账号, 用于抓取需要登录的题目 |
| `oiHelper.xmojPassword` | 空 | xmoj 密码, 明文保存, 仅本机使用 |
| `oiHelper.env` | auto | 编译运行环境 |
| `oiHelper.jobs` | 1 | 并行度 |
| `oiHelper.timeLimit` | 1000 | 时限 (ms) |
| `oiHelper.memoryLimit` | 256 | 内存限制 (MB) |
| `oiHelper.standard` | c++14 | C++ 标准 |
| `oiHelper.contestPenaltyMinutes` | 20 | ICPC 罚时分钟数, 作为 contest.json 缺省 |
| `oiHelper.contestFreezeMinutes` | 0 | ICPC 封榜时长(分钟), 0 表示不封榜; 作为 contest.json 缺省 |
| `oiHelper.luoguCookie` | 空 | 洛谷 Cookie, 抓取需登录的洛谷题目或直连提交时使用 |
| `oiHelper.codeforcesCookie` | 空 | Codeforces Cookie, 直连提交 Codeforces 时使用 |
| `oiHelper.atcoderCookie` | 空 | AtCoder Cookie, 直连提交 AtCoder 时使用 |
| `oiHelper.hydroCookie` | 空 | Hydro Cookie, 抓取/直连提交自建 Hydro 站点时使用 |
| `oiHelper.hydroBase` | 空 | Hydro 站点地址(如 `https://hydro.ac`), 用于拼接原题链接 |
| `oiHelper.originalPriority` | `luogu,codeforces,atcoder,hydro` | 原题来源优先级(逗号分隔), 决定「查看/预览/样例/提交原题」优先使用哪个站点 |
| `oiHelper.originalSubmitMode` | direct | 提交原题方式: `direct` 直连提交(失败自动改用浏览器) / `browser` 打开提交页并复制源码 |
| `oiHelper.caseDuplicateHint` | true | 测试点完全重复(输入与输出都相同)时在面板给出提示 |
| `oiHelper.caseConflictWarn` | true | 测试点输入相同但输出不同时在面板给出警告 |
| `oiHelper.fastIO` | `ios::sync_with_stdio(0);cin.tie(0),cout.tie(0);` | 「加速 IO」按钮写入源文件 main 开头的内容, 留空则禁用该按钮 |
| `oiHelper.submitConfirmAcCount` | 1 | 最近一次评测 AC 时, 一键提交前的确认弹窗次数(1-5) |
| `oiHelper.submitConfirmAcText` | `你要提交了吗?` | 最近一次评测 AC 时确认弹窗的文案 |
| `oiHelper.submitConfirmNonAcCount` | 2 | 最近一次评测未 AC 时, 一键提交前的确认弹窗次数(1-5) |
| `oiHelper.submitConfirmNonAcText` | `你没有AC哦, 你真的要提交吗?` | 最近一次评测未 AC 时确认弹窗的文案 |
| `oiHelper.submitConfirmHoldSeconds` | 3 | 确认弹窗中「确定」按钮需强制等待的秒数, 0 表示不等待 |
| `oiHelper.submitResultTimeout` | 60 | 提交后自动查询评测结果的超时秒数, 超过即停止轮询 |
| `oiHelper.fetchCacheMinutes` | 30 | 题目抓取结果的缓存时长(分钟), 0 表示不缓存 |
| `oiHelper.fetchPreferWinHttp` | true | 抓取题目时优先用内置网络库(不启动 curl 进程), 被站点拦截时自动改用 curl; 关闭则始终用 curl |
| `oiHelper.previewIncremental` | true | 题目预览面板增量更新: 切换题目时只替换内容, 不重建整页; 关闭则每次重建页面 |

## MCP Server

```powershell
cd mcp; npm install; npm start
```

也可用 `mcp/setup.html` 可视化生成配置：一次填写, 同时生成 MCP 配置与插件设置片段。

stdio 暴露工具：

- `judge_problem`：`{ problemDir（必填）, env?, jobs?, timeLimit?, memoryLimit?, standard?, optimize?, checker?, format?, eps? }`
- `judge_file`：`{ src（必填）, input（必填）, expected（必填）, timeLimit?, memoryLimit?, env?, standard?, optimize?, checker?, eps? }`
- `judge_version`：无参数
- `fetch_problem`：`{ url（必填）, outDir?, inline? }`
- `fetch_original`：`{ url（必填） }`
- `fetch_contest`：`{ url（必填） }`
- `fetch_extra`：`{ url（必填）, outDir? }`
- `submit_solution`：`{ url（必填）, file（必填）, lang? }`
- `submit_original`：`{ url（必填）, file（必填）, lang?, captcha? }`
- `query_submission`：`{ id（必填）, oj?, problemUrl? }`

提交/抓取类工具的账号与 Cookie 不在参数中, 统一通过环境变量提供(见下表)。

| 变量 | 说明 |
|---|---|
| `OI_JUDGE_PATH` | `oi-judge` 可执行文件路径 |
| `OI_JUDGE_ENV` | 默认评测环境 `auto/wsl/mingw` |
| `OI_JUDGE_JOBS` | 默认并行度 |
| `OI_JUDGE_TIME` | 默认时限 (ms) |
| `OI_JUDGE_MEMORY` | 默认内存限制 (MB) |
| `OI_JUDGE_STANDARD` | 默认 C++ 标准 |
| `OI_JUDGE_OPTIMIZE` | 默认优化级别 |
| `OI_XMOJ_USER` / `OI_XMOJ_PASS` | xmoj 账号密码 |
| `OI_LUOGU_COOKIE` / `OI_CODEFORCES_COOKIE` / `OI_ATCODER_COOKIE` / `OI_HYDRO_COOKIE` | 各站点 Cookie |
| `OI_HYDRO_BASE` | Hydro 站点地址 |
| `OI_ORIGINAL_PRIORITY` | 原题来源优先级 |
| `OI_FETCH_OUT` | 抓取默认输出基础目录 |
| `OI_SUBMIT_DEDUP_SECONDS` | 提交去重窗口(秒), 默认 60; 设为 0 关闭 |
| `OI_SUBMIT_INTERVAL_MS` | 提交最小间隔(毫秒), 默认 1000; 设为 0 只串行不限间隔 |

工具参数优先于环境变量; 站点 Cookie 按 URL 主机自动选择(洛谷/CF/AtCoder, 其余回退 Hydro)。

提交防护: 所有提交串行执行, 且两次提交之间强制最小间隔(默认 1 秒), 避免并发或连续重复提交; 并对同一份源码(按 工具+URL+语言+源码内容 判定)在去重窗口内只放行一次, 重复调用返回「[重复提交已拦截]」并提示改用 `query_submission` 轮询。

`OI_SUBMIT_DEDUP_SECONDS` / `OI_SUBMIT_INTERVAL_MS` 对核心 CLI 的 `--submit` / `--submit-original` 同样生效(跨进程、落盘): 无论从 MCP、VSCode 扩展还是终端直接调用, 同一份源码都不会被重复提交, 且两次提交至少间隔 1 秒。

图形验证码: `submit_original` 提交洛谷时若需要验证码, 会返回说明文本与验证码图片(image 内容块), 并给出本次会话 `cookie`; 识别后带上 `captcha` 与该 `cookie` 重新调用即可完成提交 (验证码答案与 cookie 绑定, 必须沿用同一 cookie)。验证码输入有误时, 再次不带 `captcha` 调用可获取新图; 查询洛谷/Hydro 结果时也可用 `cookie` 沿用提交会话。

## REST API

```powershell
core/build/oi-judge.exe --serve 8899
```

`POST http://127.0.0.1:8899/judge`，请求体二选一：

```json
{ "problemDir": "problems/P1001", "env": "auto", "jobs": 1, "timeLimit": 1000, "memoryLimit": 256 }
```

```json
{ "src": "a.cpp", "input": "1.in", "expected": "1.out", "timeLimit": 1000, "memoryLimit": 256 }
```

响应为与 CLI 相同的结果 JSON；请求非法或非 `POST /judge` 返回 400。

## 示例题目

| 目录 | 覆盖能力 |
|---|---|
| `problems/P1001` | 传统题、freopen、subtask |
| `problems/SPJ1` | testlib 特判 |
| `problems/OUT1` | 提交答案题 |
| `problems/INT1` | 交互题 |
| `problems/ICPC1` | ICPC 赛制、比赛目录 `contest.json`（含 A/B 两道题） |

## 已知限制

- 本机无 `isolate` 时，`--env wsl` 会降级为 Windows Job Object 受限模式，结果里 `isolationDegraded=true`。
- 默认 `--env auto`（以及不传 `--env`）会优先探测 WSL + isolate，该探测有 3 秒超时上限；探测超时（例如本机 `wsl.exe` 无响应）或失败时回退到 MinGW + Windows Job Object 运行，这是正常回退，结果里 `isolationDegraded` 仍为 `false`；只有显式指定 `--env wsl` 而 WSL 不可用时才算降级，此时 `isolationDegraded` 为 `true`；由于探测需等满超时，默认路径比 `--env mingw` 慢约 3 秒，想跳过探测可直接指定 `--env mingw`。
- Windows 上 MinGW 程序冷启动 wall 约 1s，故 wall 等待 = 时限 + 3000ms 宽限，超时以 CPU 时间判定并容忍 200ms 启动开销。
- 通信题为简化实现，仅支持 2 个源文件。

## 目录说明

- `core/`: C++ 评测内核, 提供 `oi-judge` 命令行与 `POST /judge`.
- `extension/`: VS Code/Trae 扩展, 提供评测面板、题目抓取与比赛功能.
- `mcp/`: Node 实现的 MCP Server, 通过 stdio 暴露评测与抓取工具.
- `desktop/`: Electron 管理程序骨架, 统一管理服务器、凭据与工作区.
- `browser/`: MV3 浏览器扩展, 承载 OJ 页面采集、一键 Cookie 与在线 IDE 侧边面板.
- `installer/`: 打包与安装脚本, 生成扩展 vsix 并部署桌面程序.

## V0.1.0-100 发布说明

- 版本: `extension` / `mcp` / `desktop` / `browser` 均为 `0.1.0`, 对外版本 `V0.1.0-100`, 内核 `GET /health` 同步返回该版本与构建号 `100`.
- 新增: `desktop` 管理程序 (服务器/凭据/识别到的OIH/接口/工作区/设置、局域网聊天、比赛通知、置顶悬浮窗), `browser` MV3 采集扩展与在线 IDE 面板, `installer` 安装脚本, 扩展侧 5 个编辑器辅助命令, 内核 `GET /health`.
- 安装: 桌面程序用 `release/v0.1.0-100/OI-Helper-0.1.0-setup.exe` (安装时自动部署编辑器扩展; `resources/` 内已附带 `judge/oi-judge.exe`、`browser/`、扩展 vsix、README 与 docs); 也可单独使用 `extension/oi-helper-0.1.0.vsix` 与 `browser-0.1.0.zip`.
- 评测文件: `resources/judge/oi-judge.exe` 已静态链接, 不依赖本机 MinGW 运行库; 编辑器扩展会自动从安装目录的 `resources/judge/` 查找, 无需手工配置 `oiHelper.judgePath`.
- 已知限制: 仅装 VS Code 的机器上的一键安装未验证 (本机仅有 Trae CN); Codeforces / AtCoder 的登录态提交未验证; 榜单事件提醒未在真实比赛中触发. 详见 [docs/desktop-manager-open-issues.md](docs/desktop-manager-open-issues.md).

## 许可证

本项目采用 MIT 许可证，详见 [LICENSE](LICENSE)。`testlib/testlib.h` 为第三方 vendored 头文件，自带宽松许可。
