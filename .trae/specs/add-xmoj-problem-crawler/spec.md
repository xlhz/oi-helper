# 从 xmoj 抓取题目测试点与文件 IO 配置 Spec

## Why

OI Helper 的题目目录（`problem.json` + 测试点文件）目前只能手工填写. 从 xmoj 抄一道题需要人工判断是否使用文件 IO, 逐条复制样例, 容易出错. 需要按题目链接自动抓取题目结构（时限/内存/文件 IO/样例, 含大样例附件）, 一键生成可评测的题目目录.

## What Changes

- 核心 `oi-judge` 新增抓取模式: `--fetch <url>`, 登录 xmoj, 解析题目页, 生成本地题目目录.
- 插件新增命令 `OI Helper: 从网址导入题目`.
- 插件新增设置 `oiHelper.xmojUser` / `oiHelper.xmojPassword`, 用于可选自动登录.
- 评测面板 `judge-panel` 新增「从网址导入」入口.
- 不改变现有评测流程与 `problem.json` 语义, 仅新增字段与目录产物.
- **BREAKING**: 无.

## Impact

- Affected specs: `core`（新增 fetch 子能力）, `extension`（新增导入命令与设置）.
- Affected code:
    - 核心: [cli.h](file:///D:/OIHelpper/core/include/oi/cli.h), [cli.cpp](file:///D:/OIHelpper/core/src/cli.cpp), 新增 `core/include/oi/fetcher.h`, `core/src/fetcher.cpp`, `core/CMakeLists.txt`
    - 插件: [extension.ts](file:///D:/OIHelpper/extension/src/extension.ts), 新增 `extension/src/fetch.ts`, [panel.ts](file:///D:/OIHelpper/extension/src/panel.ts), [package.json](file:///D:/OIHelpper/extension/package.json), `extension/media/judge-panel.html`
- 实现位置说明: 源码实体在主仓库 `D:/OIHelpper`, 当前 worktree 只有 `.trae`（master 无文件提交）, 因此代码改动需在主仓库进行.

## 已核实的数据来源

登录账号 `yinkaiyuan` 后可 `POST https://www.xmoj.tech/login.php`（字段 `user_id`/`password`, 会话为 `PHPSESSID`）; 题目页 `problem.php?cid=..&pid=..` 与 `problem.php?id=..` 结构一致.

页面可稳定抽取的信息:

- 题目名: `<h2 class='lang_cn'>`; 内部编号: 页内 `problemstatus.php?id=<pid>`.
- 头部: `<span class=green>输入文件: </span>` / `输出文件: ` , `时间限制: N Sec`, `内存限制: N MB`.
    - 例: `id=2298` 为 `标准输入/标准输出`; `cid=10744&pid=1` 为 `road.in/road.out`.
- 样例: 多个 `div.data-sample`, 内含 `样例输入 #N` / `样例输出 #N` 的 `<span class=sampledata>`.
- 大样例: 「下载文件」节内 `<a class="ke-insertfile" href="/upload/file/.../xxx.zip">下载更多样例</a>`.
- 真实评测数据文件不可得: `admin/phpfm.php` 对该账号返回 `Please Login First!`, 本方案不抓取隐藏数据.

## ADDED Requirements

### Requirement: xmoj 登录与抓取

系统 SHALL 支持以题目页 URL 为输入, 使用可选账号密码登录 xmoj 并获取题目页 HTML.

#### Scenario: 带账号登录

- **WHEN** 提供 `--fetch <url> --fetch-user <u> --fetch-pass <p>`
- **THEN** 系统先 `POST login.php` 建立会话, 再以该会话获取题目页; 登录失败时返回错误且不生成目录

#### Scenario: 公开题

- **WHEN** 未提供账号密码且页面可直接访问
- **THEN** 系统直接获取题目页并继续解析

### Requirement: 题目结构解析

系统 SHALL 从题目页解析题目名、时限、内存限制、输入/输出文件名与样例数据.

#### Scenario: 标准 IO 题

- **WHEN** 头部为 `输入文件: 标准输入` 与 `输出文件: 标准输出`
- **THEN** 判定为不使用文件 IO, `problem.json` 不写 `freopen`

#### Scenario: 文件 IO 题

- **WHEN** 头部为 `输入文件: road.in` 与 `输出文件: road.out`
- **THEN** 判定为使用文件 IO, 写入 `freopen: {"in":"road.in","out":"road.out"}`

#### Scenario: 时限与内存换算

- **WHEN** 页面显示 `时间限制: 2 Sec` 与 `内存限制: 256 MB`
- **THEN** 写入 `timeLimit: 2000` 与 `memoryLimit: 256`

#### Scenario: 多组样例

- **WHEN** 页面含 `样例输入 #1/#2/#3` 及对应输出
- **THEN** 依次写出 `1.in/1.out`, `2.in/2.out`, `3.in/3.out` 并登记为 `tests`

#### Scenario: 空输入样例

- **WHEN** 样例输入为 `（无）`
- **THEN** 写出空文件作为该测试点输入

### Requirement: 大样例附件

系统 SHALL 解析「下载文件」节的附件链接并下载; 对 zip 附件 SHALL 解压到题目目录.

#### Scenario: 下载并解压 zip

- **WHEN** 页面含 `<a class="ke-insertfile" href="/upload/file/.../xxx.zip">`
- **THEN** 下载该 zip 并解压到 `<题目目录>/attachment/`

#### Scenario: 非 zip 附件

- **WHEN** 附件扩展名不是 `.zip`
- **THEN** 原样保存到 `<题目目录>/attachment/`

### Requirement: 生成题目目录

系统 SHALL 在指定基础目录下按内部题目编号创建 `<base>/<pid>/`, 写入 `problem.json`、样例文件与附件, 并输出抓取结果 JSON.

#### Scenario: 生成成功

- **WHEN** 抓取 `problem.php?cid=10744&pid=1`
- **THEN** 生成目录含 `problem.json`（`name/timeLimit/memoryLimit/freopen/tests`）与 `1.in/1.out` 等文件, stdout 输出 JSON 摘要（含 pid、目录、测试点数）

#### Scenario: 无样例

- **WHEN** 题目页没有样例
- **THEN** 仍生成 `problem.json`（`tests` 为空）并在结果中提示, 不作为致命错误

### Requirement: 插件导入命令

插件 SHALL 提供命令 `OI Helper: 从网址导入题目`, 接收题目 URL 与可选账号密码, 调用核心抓取并落到工作区 `problems/` 下.

#### Scenario: 命令导入

- **WHEN** 用户执行命令并输入 URL
- **THEN** 插件调用 `oi-judge --fetch`, 成功后提示目录路径

#### Scenario: 缺少凭据

- **WHEN** 页面需要登录且设置为空
- **THEN** 插件提示输入账号密码

### Requirement: 凭据设置

插件 SHALL 提供 `oiHelper.xmojUser` 与 `oiHelper.xmojPassword` 配置项用于自动登录.

#### Scenario: 保存账号

- **WHEN** 用户填入这两个配置项
- **THEN** 后续导入自动携带凭据, 不再重复询问

### Requirement: 错误处理

系统 SHALL 在网络失败、登录失败、页面解析失败时给出明确错误并返回非零退出码, 且不留下半成品目录.

#### Scenario: 登录失败

- **WHEN** 账号密码错误
- **THEN** 核心输出错误信息并返回非零退出码, 不生成目录

#### Scenario: 非法 URL

- **WHEN** 传入非 xmoj 题目链接
- **THEN** 提示不支持的链接并返回非零退出码
