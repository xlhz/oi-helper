# 桌面管理程序 V0.1.0 遗留问题

本文档记录 `build-desktop-manager-v0.1.0` 实施与验收后的剩余问题.
相关文件: [spec.md](file:///d:/OIHelpper/.trae/specs/build-desktop-manager-v0.1.0/spec.md)、[tasks.md](file:///d:/OIHelpper/.trae/specs/build-desktop-manager-v0.1.0/tasks.md)、[checklist.md](file:///d:/OIHelpper/.trae/specs/build-desktop-manager-v0.1.0/checklist.md)、[验收计划](file:///d:/OIHelpper/.trae/documents/accept-desktop-manager-v0.1.0.md).

## 一、当前状态

无发布阻塞. `checklist.md` 43 项全部勾选. 剩余为「仅装 VS Code 的机器」安装验证, 以及原题溯源 webview、榜单事件提醒的逐项点击.

## 二、未验证项

### 1. 仅装 VS Code 的机器一键安装

- 已验: Trae CN 上安装包静默安装 exit 0, 自动探测并安装扩展 `exit=0`; 启动打包版 `/health` 正常.
- 未验: 本机无 VS Code, 未验证仅装 VS Code 时的探测与回退链.

### 2. 原题溯源 webview 与榜单提醒

- 已验 (数据层):
    - 原题溯源: `CF1A` → 洛谷 `CF1A` + Codeforces `1A`; `AT_abc100_a` → 洛谷 `AT_abc100_a` + AtCoder `abc100_a`; `hydro:1001` → Hydro; Codeforces 题目 URL 可解析为 `1A`; 洛谷 `P1002` / `P1003` 可解析.
    - 比赛榜单: 已结束比赛 `183510`「PKOI Round 1」`/scoreboard` 200, 榜单数据 200、48,605 字节, 可提取 `P11901/P11900/P11899/P11898`; 未开始比赛 `366008` 榜单 403 属比赛未开始/未报名.
- 已验 (登录态浏览器): Edge 已登录 (`hz_xl`), 以「加载解压缩的扩展」装入 `browser/` 后, 在 `P1003` 页面注入面板成功采集题目名、1000ms / 125MB 与 2 组样例.
- 未验: 原题溯源 webview 未逐项点击; 队友提交/一血/封榜等提醒未在真实比赛触发.

### 3. Codeforces / AtCoder 登录态专属功能

- 已验 (扩展后台真实链路): Codeforces `1A` (`A. Theatre Square`, 1000ms/256MB, 1 样例) 与 AtCoder `abc100_a` (`A - Happy Birthday!`, 2000ms/976MB, 4 样例) 均 `ok=true`.
- 未验: 两站点的登录态提交等操作.

## 三、本轮修复

| 问题 | 修复 |
|---|---|
| WS 回执类型错误: 上报 `openWorkspace/createWorkspace/syncRequest` 回 `error` | [ws.js](file:///d:/OIHelpper/desktop/src/ws.js) 改回 `result`, 错误明细放 `payload.error` |
| 深色主题主按钮被 `.oih-btn` 覆盖 | [panel.css](file:///d:/OIHelpper/browser/content/panel.css#L468-L472) 深色块补回主按钮规则 |
| AtCoder 题名多出 `Editorial` 后缀 | [parse.js](file:///d:/OIHelpper/browser/lib/parse.js#L175-L179) 在 `cleanTitle` 去掉尾部 `Editorial`, 复验题名为 `A - Happy Birthday!` |
| `installer/install.ps1` 与 `build-vsix.ps1` 含双 UTF-8 BOM, PowerShell 5 解析失败, 安装器扩展自动部署 exit=1 | 去掉重复 BOM, 保留单个 BOM; 重打安装包并静默安装验证 `install-ext.log` 为 `exit=0` |
| electron-builder 在 `CI=true` 下因缺少 repository 触发 update-info 报错 | 构建命令加 `--config.publish.provider=generic --config.publish.url=... --publish never`; 与 `--config.electronDist` 配合可离线复用已解压 Electron |

## 四、非阻塞限制

| 项 | 说明 | 建议 |
|---|---|---|
| `host_permissions` 含本机 | [manifest.json](file:///d:/OIHelpper/browser/manifest.json) 额外声明 `http://127.0.0.1/*` 与 `http://localhost/*`, 用于对接桌面 API 与本地测试 | 发布前可移除 |
| 桌面 API 相对路径 | `/api/judge/run` 传相对路径时以进程工作目录解析, 会失败; UI 已传绝对路径 | 需要时改为以工作区为基准解析 |
| 通用适配器提交提示 | 无表单页时代码已写回, 提示仍可能显示「无法自动写入代码」 | 按 `canAutoSubmit` 调整文案 |
| 服务器「验证信息」 | 明文落盘, 界面与日志掩码 | 与凭据一致改用 `safeStorage` |
| MCP 托管 | 主进程 spawn `mcp/src/server.js`, 未开放外部直连 transport | 需要时再补 |
| 在线 IDE 写回 | 支持 Monaco、CodeMirror 5 与 textarea, CodeMirror 6 只读 | 需要时补 CM6 |
| 局域网传输 | 明文 WebSocket, 无 TLS | 跨不可信网络前加 TLS |
| 队友提交识别 | 仅能从榜单提交记录判断 | 待榜单提供队伍信息 |
| 封榜/解榜事件 | 依赖 `oiHelper.contestFreezeMinutes > 0` 且由洛谷榜单轮询产生 | 无 |
| Chrome 加载扩展 | Chrome 155 忽略 `--load-extension` | 手工用「加载已解压的扩展程序」 |
| vsce 打包警告 | 扩展目录无 LICENSE 文件 | 需要时补 |

## 五、产物

| 产物 | 状态 |
|---|---|
| `release/v0.1.0-100/` | 发布包: 安装包、vsix、浏览器扩展 zip、README、docs、`SHA256SUMS.txt` |
| `desktop/dist/OI-Helper-0.1.0-setup.exe` | 已产出 112,648,442 字节; 静默安装 exit 0; 内含 `browser/` 28 文件、docs 2 篇、README 与 1 个 vsix |
| `desktop/dist/win-unpacked/` | 已产出 |
| `extension/oi-helper-0.1.0.vsix` | 已产出 255,917 字节, 49 文件 |
| `browser-0.1.0.zip` | 已产出 61,480 字节, 28 条目 (含 AtCoder 题名修复) |
| README `V0.1.0-100 发布说明` | 已补充 |
