# Tasks

- [x] Task 1: 核心抓取模块与 HTTP 客户端
    - [x] SubTask 1.1: 新增 `core/include/oi/fetcher.h` 与 `core/src/fetcher.cpp`, 定义 `FetchOptions`/`FetchResult`
    - [x] SubTask 1.2: 用 WinHTTP 实现 HTTPS GET 与表单 POST, 维持会话 Cookie
    - [x] SubTask 1.3: 实现 xmoj 登录（`POST login.php`, 字段 `user_id`/`password`）
    - [x] SubTask 1.4: 把新源文件加入 `core/CMakeLists.txt`

- [x] Task 2: 题目页解析
    - [x] SubTask 2.1: 解析题目名（`h2.lang_cn`）与内部 pid（页内 `problemstatus.php?id=`）
    - [x] SubTask 2.2: 解析输入文件/输出文件, 区分标准输入输出与文件名
    - [x] SubTask 2.3: 解析时限（Sec→ms）与内存（MB）
    - [x] SubTask 2.4: 解析多组样例并做 HTML 实体解码, 空输入记为 `（无）`
    - [x] SubTask 2.5: 解析「下载文件」节 `a.ke-insertfile` 链接并补全为绝对 URL

- [x] Task 3: 生成题目目录
    - [x] SubTask 3.1: 按 pid 建 `<base>/<pid>/`, 写 `problem.json`（name/type/timeLimit/memoryLimit/checker=diff/freopen?/tests/sourceUrl）
    - [x] SubTask 3.2: 写样例文件 `N.in`/`N.out`
    - [x] SubTask 3.3: 下载附件; zip 解压到 `attachment/`, 非 zip 原样保存
    - [x] SubTask 3.4: 输出抓取结果 JSON 摘要

- [x] Task 4: CLI 接入
    - [x] SubTask 4.1: 新增参数 `--fetch/--fetch-out/--fetch-user/--fetch-pass`
    - [x] SubTask 4.2: `runCli` 优先处理 fetch 模式并返回退出码
    - [x] SubTask 4.3: 更新 `--help`

- [x] Task 5: 编译与真实链接验证
    - [x] SubTask 5.1: 编译 `oi-judge`
    - [x] SubTask 5.2: 抓取 `problem.php?id=2298`、`problem.php?cid=10745&pid=0`、`problem.php?cid=10744&pid=1`, 核对 freopen 与样例
    - [x] SubTask 5.3: 对生成目录跑 `--problem` 冒烟评测（有/无 freopen 各一次）

- [x] Task 6: 插件命令与设置
    - [x] SubTask 6.1: 新增 `extension/src/fetch.ts` 封装 `oi-judge --fetch` 调用
    - [x] SubTask 6.2: 注册命令 `oiHelper.fetchProblem`（输入 URL、落到工作区 `problems/`、提示结果）
    - [x] SubTask 6.3: `package.json` 增加命令与 `oiHelper.xmojUser`/`oiHelper.xmojPassword` 配置
    - [x] SubTask 6.4: `tsc -p extension` 编译无错

- [x] Task 7: 评测面板导入入口
    - [x] SubTask 7.1: `judge-panel.html` 增加题目 URL 输入与「从网址导入」按钮, postMessage 触发
    - [x] SubTask 7.2: `panel.ts` 处理该消息并调用 fetch 模块
    - [x] SubTask 7.3: 重新编译扩展确认无错

# Task Dependencies

- Task 2 依赖 Task 1
- Task 3 依赖 Task 2
- Task 4 依赖 Task 3
- Task 5 依赖 Task 4
- Task 6 依赖 Task 4
- Task 7 依赖 Task 6

# 附: 实现期额外修复

- `core/src/judge.cpp`: 新增 `sanitizeName`, 使临时运行目录名只含 ASCII. 中文题名（抓取产物常见）会让 runner 与 comparator 解析到不同临时目录, 导致误报 `WA 无法读取选手输出文件`. 仅影响临时目录名, 不改评测语义.
