import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { OriginalRef, normalizeCookie, ojCookie, ojLabel, ojOfUrl } from './original';
import { absolutizeMarkdown, htmlToMarkdown, setMarkdownBase } from './problem';
import { spawnEnv } from './judge';

export interface FetchOptions {
    url: string;
    outBaseDir?: string;
    user?: string;
    pass?: string;
    cookie?: string;
    inline?: boolean;
}

export interface FetchSample {
    in: string;
    out: string;
}

export interface FetchSummary {
    ok: boolean;
    pid?: number;
    name?: string;
    url?: string;
    dir?: string;
    fileIO?: boolean;
    tests?: number;
    attachments?: number;
    warnings?: string[];
    error?: string;
    freopenIn?: string;
    freopenOut?: string;
    source?: string;
    samples?: FetchSample[];
}

export interface SubmitOptions {
    url: string;
    file: string;
    lang?: string;
    user?: string;
    pass?: string;
}

export interface SubmitSummary {
    ok: boolean;
    solutionId?: number;
    problemId?: number;
    url?: string;
    message?: string;
    error?: string;
}

// 竞赛题目列表项(供上一题/下一题/选题使用)
export interface ContestProblemItem {
    num: string;
    title: string;
    problemId?: string;
}

export interface ContestSample {
    in: string;
    out: string;
    explain?: string;
}

// 新版竞赛题目(/web/contest/{cid}/{num})抓取结果; HTML 字段由 problem.ts 转 Markdown
export interface ContestSummary {
    ok: boolean;
    error?: string;
    contestId?: string;
    contestTitle?: string;
    num?: string;
    problemId?: string;
    title?: string;
    source?: string;
    timeLimit?: number;   // ms
    memoryLimit?: number; // MB
    description?: string;
    input?: string;
    output?: string;
    hint?: string;
    dataRange?: string;
    download?: string;
    startTime?: string;   // 开始时间(个人时间线优先)
    endTime?: string;     // 结束时间(个人时间线优先); rule 1/2 的比赛为比赛结束
    correctionEnd?: string; // 补题截止(rule 1/2 的比赛)
    classId?: string;     // 所属班级
    sessionEnd?: string;  // 训练会话截止(用于倒计时)
    fileIO?: boolean;     // 是否文件 IO
    freopenIn?: string;   // 文件 IO 输入文件名
    freopenOut?: string;  // 文件 IO 输出文件名
    leftSeconds?: number; // 服务器剩余秒数, -1 未知
    state?: string;       // pending/running/ended
    submitUrl?: string;
    samples?: ContestSample[];
    problems?: ContestProblemItem[];
}

// 竞赛题目「更多样例」压缩包下载解压结果
export interface ExtraSummary {
    ok: boolean;
    error?: string;
    dir?: string;
    files?: string[];
    warnings?: string[];
}

// 是否为 xmoj 链接, 用于决定是否需要账号密码
export function isXmojUrl(url: string): boolean {
    return /xmoj\.tech/i.test(url);
}

// 清理粘贴来的链接: 去掉成对的反引号/引号/尖括号与首尾空白
export function cleanUrl(raw: string): string {
    return String(raw ?? '')
        .trim()
        .replace(/^[`'"<（(\[]+/, '')
        .replace(/[`'">）)\]]+$/, '')
        .trim();
}

// 是否为洛谷链接
export function isLuoguUrl(url: string): boolean {
    return /luogu\.(com\.cn|org)/i.test(url);
}

// 是否为 xmoj 新版竞赛题目链接(/web/contest/{cid}/{num})
export function isContestUrl(url: string): boolean {
    return /\/web\/contest\//i.test(url);
}

// 由竞赛号与题号拼出竞赛题目链接
export function contestProblemUrl(contestId: string, num: string): string {
    return `https://www.xmoj.tech/web/contest/${contestId}/${num}`;
}

// 更多样例链接: download 字段可能是 HTML 片段, 取出其中的链接
export function downloadUrlOf(raw: string | undefined): string {
    const text = String(raw ?? '').trim();
    if (!text) {
        return '';
    }
    if (!text.includes('<')) {
        return text;
    }
    const m = /href\s*=\s*["']([^"']+)["']/i.exec(text);
    if (!m) {
        return '';
    }
    const href = m[1];
    if (/^https?:\/\//i.test(href)) {
        return href;
    }
    return `https://www.xmoj.tech${href.startsWith('/') ? '' : '/'}${href}`;
}

// 旧版竞赛链接(problem.php?cid=&pid=)转新版竞赛题目链接; 非竞赛链接返回 undefined
export function oldContestUrlToNew(url: string): string | undefined {
    const cid = /[?&]cid=(\d+)/i.exec(url);
    const pid = /[?&]pid=(\d+)/i.exec(url);
    if (!cid || !pid) {
        return undefined;
    }
    const index = Number(pid[1]);
    if (!Number.isFinite(index) || index < 0 || index > 25) {
        return undefined;
    }
    return contestProblemUrl(cid[1], String.fromCharCode(65 + index));
}

// xmoj 账号密码: 配置优先; 缺失时弹窗询问, 可选择保存到设置
export async function resolveCredentials(url: string): Promise<{ user?: string; pass?: string } | undefined> {
    const cfg = vscode.workspace.getConfiguration('oiHelper');
    let user = (cfg.get<string>('xmojUser') ?? '').trim();
    let pass = (cfg.get<string>('xmojPassword') ?? '').trim();
    if (!isXmojUrl(url) || (user && pass)) {
        return { user, pass };
    }
    const inputUser = await vscode.window.showInputBox({
        prompt: 'xmoj 账号 (留空表示匿名抓取)',
        value: user
    });
    if (inputUser === undefined) {
        return undefined;
    }
    const inputPass = await vscode.window.showInputBox({
        prompt: 'xmoj 密码',
        password: true
    });
    if (inputPass === undefined) {
        return undefined;
    }
    user = inputUser.trim();
    pass = inputPass;
    if (user || pass) {
        const save = await vscode.window.showInformationMessage('是否将账号密码保存到扩展设置?', '保存', '不保存');
        if (save === '保存') {
            await cfg.update('xmojUser', user, vscode.ConfigurationTarget.Global);
            await cfg.update('xmojPassword', pass, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage('已保存到扩展设置.');
        }
    }
    return { user, pass };
}

// 洛谷 Cookie: 只读配置; 未配置时按匿名抓取(公开题不需要登录), 不弹窗打断
export async function resolveLuoguCookie(): Promise<string | null> {
    const cfg = vscode.workspace.getConfiguration('oiHelper');
    return normalizeCookie(cfg.get<string>('luoguCookie') ?? '');
}

function buildArgs(options: FetchOptions): string[] {
    const args: string[] = ['--fetch', options.url];
    const push = (key: string, value: string | undefined): void => {
        if (value !== undefined && value !== '') {
            args.push(key, value);
        }
    };
    push('--fetch-out', options.outBaseDir);
    push('--fetch-user', options.user);
    push('--fetch-pass', options.pass);
    push('--fetch-cookie', options.cookie);
    if (options.inline) {
        args.push('--fetch-inline');
    }
    args.push('--pretty');
    return args;
}

// 从 stdout 解析结果 JSON: 兼容单行与 pretty 多行输出
function parseSummary<T>(stdout: string): T | undefined {
    const text = stdout.trim();
    if (!text) {
        return undefined;
    }
    try {
        return JSON.parse(text) as T;
    } catch {
        const line = text.split('\n').filter((l) => l.trim()).pop();
        if (!line) {
            return undefined;
        }
        try {
            return JSON.parse(line) as T;
        } catch {
            return undefined;
        }
    }
}

// 调用 oi-judge --fetch 抓取题目, 解析 stdout JSON; 失败时以 error 返回而非抛异常
export function runFetch(exe: string, options: FetchOptions, output: vscode.OutputChannel): Promise<FetchSummary> {
    const args = buildArgs(options);
    return new Promise<FetchSummary>((resolve) => {
        const safeArgs = args.map((arg, i) => (i > 0 && (args[i - 1] === '--fetch-pass' || args[i - 1] === '--fetch-cookie') ? '****' : arg));
        output.appendLine(`[oi-judge] ${exe} ${safeArgs.join(' ')}`);
        const child = spawn(exe, args, { windowsHide: true, env: spawnEnv() });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
        child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        child.on('error', (err: Error) => {
            output.appendLine(`[错误] 无法启动 oi-judge: ${err.message}`);
            resolve({ ok: false, error: `无法启动 oi-judge: ${err.message}` });
        });
        child.on('close', (code: number | null) => {
            if (stdout.trim()) {
                output.appendLine(stdout.trim());
            }
            if (stderr.trim()) {
                output.appendLine(stderr.trim());
            }
            const summary = parseSummary<FetchSummary>(stdout);
            if (summary) {
                resolve(summary);
                return;
            }
            if (code === 0) {
                resolve({ ok: false, error: '未解析到 oi-judge 输出 JSON.' });
                return;
            }
            resolve({ ok: false, error: stderr.trim() || `oi-judge 退出码 ${code}.` });
        });
    });
}

// 供命令与面板复用的抓取流程: 下载模式落到 <workspace>/problems, 内联模式仅回传样例
export async function fetchProblemFlow(url: string, exe: string, output: vscode.OutputChannel, inline = false): Promise<FetchSummary> {
    url = cleanUrl(url);
    const folders = vscode.workspace.workspaceFolders;
    let baseDir: string | undefined;
    if (folders && folders.length > 0) {
        baseDir = path.join(folders[0].uri.fsPath, 'problems');
        if (!inline && !fs.existsSync(baseDir)) {
            fs.mkdirSync(baseDir, { recursive: true });
        }
    } else if (!inline) {
        return { ok: false, error: '未打开工作区, 无法确定抓取目录.' };
    }
    const cred = await resolveCredentials(url);
    if (!cred) {
        return { ok: false, error: '已取消抓取.' };
    }
    let cookie: string | undefined;
    if (isLuoguUrl(url)) {
        const value = await resolveLuoguCookie();
        if (value === null) {
            return { ok: false, error: '已取消抓取.' };
        }
        cookie = value;
    }
    return runFetch(exe, { url, outBaseDir: baseDir, user: cred.user, pass: cred.pass, cookie, inline }, output);
}

// 调用 oi-judge --fetch-contest 抓取新版竞赛题目, 解析 stdout JSON
export function runFetchContest(exe: string, url: string, user: string | undefined, pass: string | undefined, output: vscode.OutputChannel): Promise<ContestSummary> {
    const args: string[] = ['--fetch-contest', url];
    if (user) {
        args.push('--fetch-user', user);
    }
    if (pass) {
        args.push('--fetch-pass', pass);
    }
    args.push('--pretty');
    return new Promise<ContestSummary>((resolve) => {
        output.appendLine(`[oi-judge] ${exe} --fetch-contest ${url}`);
        const child = spawn(exe, args, { windowsHide: true, env: spawnEnv() });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
        child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        child.on('error', (err: Error) => {
            output.appendLine(`[错误] 无法启动 oi-judge: ${err.message}`);
            resolve({ ok: false, error: `无法启动 oi-judge: ${err.message}` });
        });
        child.on('close', (code: number | null) => {
            if (stderr.trim()) {
                output.appendLine(stderr.trim());
            }
            const summary = parseSummary<ContestSummary>(stdout);
            if (summary) {
                resolve(summary);
                return;
            }
            if (code === 0) {
                resolve({ ok: false, error: '未解析到 oi-judge 输出 JSON.' });
                return;
            }
            resolve({ ok: false, error: stderr.trim() || `oi-judge 退出码 ${code}.` });
        });
    });
}

// 竞赛题目抓取流程: 处理 xmoj 账号后调用 oi-judge
export async function fetchContestFlow(url: string, exe: string, output: vscode.OutputChannel): Promise<ContestSummary> {
    url = cleanUrl(url);
    const cred = await resolveCredentials(url);
    if (!cred) {
        return { ok: false, error: '已取消抓取.' };
    }
    return runFetchContest(exe, url, cred.user, cred.pass, output);
}

// 调用 oi-judge --fetch-extra 下载并解压「更多样例」压缩包, 解析 stdout JSON
export function runFetchExtra(exe: string, url: string, outDir: string, user: string | undefined, pass: string | undefined, output: vscode.OutputChannel): Promise<ExtraSummary> {
    const args: string[] = ['--fetch-extra', url, '--fetch-extra-out', outDir];
    if (user) {
        args.push('--fetch-user', user);
    }
    if (pass) {
        args.push('--fetch-pass', pass);
    }
    args.push('--pretty');
    return new Promise<ExtraSummary>((resolve) => {
        output.appendLine(`[oi-judge] ${exe} --fetch-extra ${url}`);
        const child = spawn(exe, args, { windowsHide: true, env: spawnEnv() });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
        child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        child.on('error', (err: Error) => {
            output.appendLine(`[错误] 无法启动 oi-judge: ${err.message}`);
            resolve({ ok: false, error: `无法启动 oi-judge: ${err.message}` });
        });
        child.on('close', (code: number | null) => {
            if (stderr.trim()) {
                output.appendLine(stderr.trim());
            }
            const summary = parseSummary<ExtraSummary>(stdout);
            if (summary) {
                resolve(summary);
                return;
            }
            if (code === 0) {
                resolve({ ok: false, error: '未解析到 oi-judge 输出 JSON.' });
                return;
            }
            resolve({ ok: false, error: stderr.trim() || `oi-judge 退出码 ${code}.` });
        });
    });
}

// 「更多样例」下载解压流程: 处理 xmoj 账号后调用 oi-judge
export async function fetchExtraFlow(url: string, outDir: string, exe: string, output: vscode.OutputChannel): Promise<ExtraSummary> {
    url = cleanUrl(url);
    const cred = await resolveCredentials(url);
    if (!cred) {
        return { ok: false, error: '已取消下载.' };
    }
    return runFetchExtra(exe, url, outDir, cred.user, cred.pass, output);
}

// 原题(洛谷/CF/AtCoder/Hydro)抓取结果
export interface OriginalSummary {
    ok: boolean;
    error?: string;
    oj?: string;
    url?: string;
    title?: string;
    markdown?: string;
    submitUrl?: string;
    samples?: FetchSample[];
}

// 调用 oi-judge --fetch-original 抓取原题题面与样例
export function runFetchOriginal(exe: string, url: string, cookie: string, output: vscode.OutputChannel, preferWinHttp = false): Promise<OriginalSummary> {
    const args: string[] = ['--fetch-original', url];
    if (cookie) {
        args.push('--fetch-cookie', cookie);
    }
    if (preferWinHttp) {
        // 先走内置网络库(不启 curl), 被拦时核心会自动回退 curl
        args.push('--fetch-winhttp');
    }
    args.push('--pretty');
    return new Promise<OriginalSummary>((resolve) => {
        output.appendLine(`[oi-judge] ${exe} --fetch-original ${url}`);
        const child = spawn(exe, args, { windowsHide: true, env: spawnEnv() });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
        child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        child.on('error', (err: Error) => {
            resolve({ ok: false, error: `无法启动 oi-judge: ${err.message}` });
        });
        child.on('close', (code: number | null) => {
            if (stderr.trim()) {
                output.appendLine(stderr.trim());
            }
            const raw = parseSummary<{ ok: boolean; oj?: string; url?: string; title?: string; html?: string; md?: string; submitUrl?: string; samples?: FetchSample[] }>(stdout);
            if (!raw) {
                resolve({ ok: false, error: stderr.trim() || `oi-judge 退出码 ${code}.` });
                return;
            }
            // 相对图片/链接按题目页地址补全(而不是默认的 xmoj 站点)
            setMarkdownBase(raw.url ?? '');
            const body = (raw.md ?? '').trim() ? raw.md ?? '' : htmlToMarkdown(raw.html ?? '');
            const markdown = raw.title ? `# ${raw.title}\n\n${body}` : body;
            // 记录题面图片, 便于排查预览面板图片不显示
            const images = markdown.match(/!\[[^\]]*\]\(([^)\s]+)\)/g) ?? [];
            output.appendLine(images.length
                ? `[抓取] 题面图片 ${images.length} 张: ${images.slice(0, 3).join(' ')}`
                : '[抓取] 题面未发现图片');
            resolve({
                ok: true,
                oj: raw.oj,
                url: raw.url,
                title: raw.title,
                // 题面里的相对图片/链接补成绝对地址, 预览面板才能加载
                markdown: absolutizeMarkdown(markdown, raw.url ?? ''),
                submitUrl: raw.submitUrl,
                samples: raw.samples ?? []
            });
        });
    });
}

// 抓取结果短期缓存: 识别/导入/预览同一题时不必重复抓页面
const originalCache = new Map<string, { at: number; data: OriginalSummary }>();

// 缓存时长来自设置(分钟), 0 表示不缓存
function cacheTtlMs(): number {
    const minutes = vscode.workspace.getConfiguration('oiHelper').get<number>('fetchCacheMinutes') ?? 30;
    if (!Number.isFinite(minutes) || minutes <= 0) {
        return 0;
    }
    return Math.min(24 * 60, minutes) * 60 * 1000;
}

export function clearOriginalCache(url?: string): void {
    if (url) {
        originalCache.delete(cleanUrl(url));
        return;
    }
    originalCache.clear();
}

// 抓取原题流程: 自动带上该 OJ 的 Cookie; 缓存期内同一题复用上次结果
export async function fetchOriginalFlow(url: string, exe: string, output: vscode.OutputChannel): Promise<OriginalSummary> {
    const target = cleanUrl(url);
    const ttl = cacheTtlMs();
    if (ttl > 0) {
        const hit = originalCache.get(target);
        if (hit && Date.now() - hit.at < ttl) {
            output.appendLine(`[抓取] 复用缓存 ${target}`);
            return hit.data;
        }
    }
    const preferWinHttp = vscode.workspace.getConfiguration('oiHelper').get<boolean>('fetchPreferWinHttp') ?? true;
    const data = await runFetchOriginal(exe, target, ojCookie(ojOfUrl(target)), output, preferWinHttp);
    if (data.ok && ttl > 0) {
        originalCache.set(target, { at: Date.now(), data });
    }
    return data;
}

export interface OriginalSubmitSummary {
    ok: boolean;
    error?: string;
    oj?: string;
    submissionId?: string;
    recordPath?: string;     // 记录页路径(Hydro)
    message?: string;
    needCaptcha?: boolean;   // 需要图形验证码: 前端弹窗输入后重试
    captchaImage?: string;   // 验证码图片(data:image/...;base64,...)
    cookie?: string;         // 本次会话更新后的 Cookie, 重试时带给核心
}

// 带验证码重试的提交参数
export interface OriginalSubmitRetry {
    captcha?: string;
    cookie?: string;
}

// 调用 oi-judge --submit-original 直连提交到原题
export function runSubmitOriginal(exe: string, url: string, file: string, lang: string, cookie: string, output: vscode.OutputChannel, captcha?: string): Promise<OriginalSubmitSummary> {
    const args: string[] = ['--submit-original', url, '--submit-file', file, '--submit-lang', lang];
    if (cookie) {
        args.push('--fetch-cookie', cookie);
    }
    if (captcha) {
        args.push('--submit-captcha', captcha);
    }
    args.push('--pretty');
    return new Promise<OriginalSubmitSummary>((resolve) => {
        output.appendLine(`[oi-judge] ${exe} --submit-original ${url}`);
        const child = spawn(exe, args, { windowsHide: true, env: spawnEnv() });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
        child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        child.on('error', (err: Error) => {
            resolve({ ok: false, error: `无法启动 oi-judge: ${err.message}` });
        });
        child.on('close', (code: number | null) => {
            if (stderr.trim()) {
                output.appendLine(stderr.trim());
            }
            const summary = parseSummary<OriginalSubmitSummary>(stdout);
            // 需要图形验证码不算失败: 图片与 Cookie 交给上层弹窗处理
            if (summary && (summary.ok || summary.needCaptcha)) {
                resolve(summary);
                return;
            }
            resolve({ ok: false, error: stderr.trim() || summary?.error || `oi-judge 退出码 ${code}.` });
        });
    });
}

// 直连提交到原题: 按设置优先级依次尝试候选站点, 全部失败时返回最后一次的错误
export async function submitOriginalFlow(filePath: string, refs: OriginalRef[], exe: string, output: vscode.OutputChannel,
    retry?: OriginalSubmitRetry): Promise<OriginalSubmitSummary> {
    const lang = submitLang(filePath);
    let last: OriginalSubmitSummary = { ok: false, error: '没有可提交的原题站点.' };
    for (const ref of refs) {
        // 验证码重试时沿用上次会话的 Cookie(验证码答案绑定在会话上)
        const cookie = (retry?.cookie ?? '').trim() || ojCookie(ref.oj);
        const summary = await runSubmitOriginal(exe, ref.url, filePath, lang, cookie, output, retry?.captcha);
        if (summary.ok || summary.needCaptcha) {
            return { ...summary, oj: ref.oj };
        }
        output.appendLine(`[原题提交] ${ojLabel(ref.oj)} 失败: ${summary.error ?? ''}`);
        last = summary;
    }
    return last;
}

// 提交评测结果的查询结果
export interface SubmitStateSummary {
    ok: boolean;
    error?: string;
    result?: number;
    text?: string;
    timeMs?: number;
    memoryKb?: number;
    finished?: boolean;
    raw?: string;   // 服务端原始响应片段(排查用)
}

// 调用 oi-judge --submit-result 查询某个提交的评测结果
export function runSubmitResult(exe: string, solutionId: number, user: string | undefined, pass: string | undefined, output: vscode.OutputChannel): Promise<SubmitStateSummary> {
    const args: string[] = ['--submit-result', String(solutionId)];
    if (user) {
        args.push('--fetch-user', user);
    }
    if (pass) {
        args.push('--fetch-pass', pass);
    }
    args.push('--pretty');
    return new Promise<SubmitStateSummary>((resolve) => {
        const child = spawn(exe, args, { windowsHide: true, env: spawnEnv() });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
        child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        child.on('error', (err: Error) => {
            resolve({ ok: false, error: `无法启动 oi-judge: ${err.message}` });
        });
        child.on('close', (code: number | null) => {
            const summary = parseSummary<SubmitStateSummary>(stdout);
            if (summary && summary.ok) {
                resolve(summary);
                return;
            }
            resolve({ ok: false, error: stderr.trim() || `oi-judge 退出码 ${code}.` });
        });
    });
}

// 查询洛谷提交结果(记录页内容接口): 用提交时的会话 Cookie
export function runSubmitResultLuogu(exe: string, rid: number, cookie: string, output: vscode.OutputChannel): Promise<SubmitStateSummary> {
    const args: string[] = ['--submit-result', String(rid), '--result-oj', 'luogu'];
    if (cookie) {
        args.push('--fetch-cookie', cookie);
    }
    args.push('--pretty');
    return new Promise<SubmitStateSummary>((resolve) => {
        const child = spawn(exe, args, { windowsHide: true, env: spawnEnv() });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
        child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        child.on('error', (err: Error) => {
            resolve({ ok: false, error: `无法启动 oi-judge: ${err.message}` });
        });
        child.on('close', (code: number | null) => {
            const summary = parseSummary<SubmitStateSummary>(stdout);
            if (summary && summary.ok) {
                resolve(summary);
                return;
            }
            resolve({ ok: false, error: stderr.trim() || summary?.error || `oi-judge 退出码 ${code}.` });
        });
    });
}

// 查询 Hydro 提交结果(记录页): rid 为记录页路径或提交号, base 为题目页地址
export function runSubmitResultHydro(exe: string, rid: string, base: string, cookie: string, output: vscode.OutputChannel): Promise<SubmitStateSummary> {
    const args: string[] = ['--submit-result', rid, '--result-oj', 'hydro'];
    if (base) {
        // 复用 --fetch 传递题目页地址(核心据此取站点根)
        args.push('--fetch', base);
    }
    if (cookie) {
        args.push('--fetch-cookie', cookie);
    }
    args.push('--pretty');
    return new Promise<SubmitStateSummary>((resolve) => {
        const child = spawn(exe, args, { windowsHide: true, env: spawnEnv() });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
        child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        child.on('error', (err: Error) => {
            resolve({ ok: false, error: `无法启动 oi-judge: ${err.message}` });
        });
        child.on('close', (code: number | null) => {
            const summary = parseSummary<SubmitStateSummary>(stdout);
            if (summary && summary.ok) {
                resolve(summary);
                return;
            }
            resolve({ ok: false, error: stderr.trim() || summary?.error || `oi-judge 退出码 ${code}.` });
        });
    });
}

// 洛谷题目难度查询结果
export interface DifficultySummary {
    ok: boolean;
    error?: string;
    pid?: string;
    difficulty?: number;
    text?: string;
}

// 调用 oi-judge --difficulty 查询洛谷题目难度
export function runDifficulty(exe: string, pid: string, cookie: string, output: vscode.OutputChannel): Promise<DifficultySummary> {
    const args: string[] = ['--difficulty', pid];
    if (cookie) {
        args.push('--fetch-cookie', cookie);
    }
    args.push('--pretty');
    return new Promise<DifficultySummary>((resolve) => {
        const child = spawn(exe, args, { windowsHide: true, env: spawnEnv() });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
        child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        child.on('error', (err: Error) => {
            resolve({ ok: false, error: `无法启动 oi-judge: ${err.message}` });
        });
        child.on('close', (code: number | null) => {
            const summary = parseSummary<DifficultySummary>(stdout);
            if (summary && summary.ok) {
                resolve(summary);
                return;
            }
            resolve({ ok: false, error: stderr.trim() || summary?.error || `oi-judge 退出码 ${code}.` });
        });
    });
}

// 难度缓存: 同一题号短期内不重复查询
const difficultyCache = new Map<string, { at: number; data: DifficultySummary }>();

// 查询洛谷难度流程: 自动带洛谷 Cookie; 命中缓存则直接复用
export async function fetchDifficultyFlow(pid: string, exe: string, output: vscode.OutputChannel): Promise<DifficultySummary> {
    const key = pid.trim().toUpperCase();
    if (!key) {
        return { ok: false, error: '缺少题号' };
    }
    const ttl = cacheTtlMs();
    if (ttl > 0) {
        const hit = difficultyCache.get(key);
        if (hit && Date.now() - hit.at < ttl) {
            return hit.data;
        }
    }
    const cookie = (await resolveLuoguCookie()) ?? '';
    const data = await runDifficulty(exe, key, cookie, output);
    if (data.ok && ttl > 0) {
        difficultyCache.set(key, { at: Date.now(), data });
    }
    return data;
}

// 清除难度缓存(刷新题目时一并清除)
export function clearDifficultyCache(): void {
    difficultyCache.clear();
}

// 洛谷关键词检索结果项
export interface LuoguSearchItem {
    pid: string;
    name: string;
}

export interface LuoguSearchSummary {
    ok: boolean;
    error?: string;
    items?: LuoguSearchItem[];
}

// 调用 oi-judge --search-luogu 按关键词检索洛谷题目
export function runSearchLuogu(exe: string, keyword: string, cookie: string, output: vscode.OutputChannel): Promise<LuoguSearchSummary> {
    const args: string[] = ['--search-luogu', keyword];
    if (cookie) {
        args.push('--fetch-cookie', cookie);
    }
    args.push('--pretty');
    return new Promise<LuoguSearchSummary>((resolve) => {
        const child = spawn(exe, args, { windowsHide: true, env: spawnEnv() });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
        child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        child.on('error', (err: Error) => {
            resolve({ ok: false, error: `无法启动 oi-judge: ${err.message}` });
        });
        child.on('close', (code: number | null) => {
            const summary = parseSummary<LuoguSearchSummary>(stdout);
            if (summary && summary.ok) {
                resolve(summary);
                return;
            }
            resolve({ ok: false, error: stderr.trim() || summary?.error || `oi-judge 退出码 ${code}.` });
        });
    });
}

// 洛谷检索缓存: 同一关键词短期内不重复检索(避免换题来回切时反复起进程而卡顿)
const searchCache = new Map<string, { at: number; data: LuoguSearchSummary }>();

// 检索洛谷题目流程: 自动带洛谷 Cookie; 命中缓存则直接复用
export async function searchLuoguFlow(keyword: string, exe: string, output: vscode.OutputChannel): Promise<LuoguSearchSummary> {
    const kw = keyword.trim();
    if (!kw) {
        return { ok: false, error: '缺少关键词' };
    }
    const ttl = cacheTtlMs();
    if (ttl > 0) {
        const hit = searchCache.get(kw);
        if (hit && Date.now() - hit.at < ttl) {
            return hit.data;
        }
    }
    const cookie = (await resolveLuoguCookie()) ?? '';
    const data = await runSearchLuogu(exe, kw, cookie, output);
    if (data.ok && ttl > 0) {
        searchCache.set(kw, { at: Date.now(), data });
    }
    return data;
}

function buildSubmitArgs(options: SubmitOptions): string[] {
    const args: string[] = ['--submit', options.url, '--submit-file', options.file];
    const push = (key: string, value: string | undefined): void => {
        if (value !== undefined && value !== '') {
            args.push(key, value);
        }
    };
    push('--submit-lang', options.lang);
    push('--fetch-user', options.user);
    push('--fetch-pass', options.pass);
    args.push('--pretty');
    return args;
}

// 调用 oi-judge --submit 提交题解, 解析 stdout JSON; 失败时以 error 返回而非抛异常
export function runSubmit(exe: string, options: SubmitOptions, output: vscode.OutputChannel): Promise<SubmitSummary> {
    const args = buildSubmitArgs(options);
    return new Promise<SubmitSummary>((resolve) => {
        const safeArgs = args.map((arg, i) => (i > 0 && args[i - 1] === '--fetch-pass' ? '****' : arg));
        output.appendLine(`[oi-judge] ${exe} ${safeArgs.join(' ')}`);
        const child = spawn(exe, args, { windowsHide: true, env: spawnEnv() });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
        child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        child.on('error', (err: Error) => {
            output.appendLine(`[错误] 无法启动 oi-judge: ${err.message}`);
            resolve({ ok: false, error: `无法启动 oi-judge: ${err.message}` });
        });
        child.on('close', (code: number | null) => {
            if (stdout.trim()) {
                output.appendLine(stdout.trim());
            }
            if (stderr.trim()) {
                output.appendLine(stderr.trim());
            }
            const summary = parseSummary<SubmitSummary>(stdout);
            if (summary) {
                resolve(summary);
                return;
            }
            if (code === 0) {
                resolve({ ok: false, error: '未解析到 oi-judge 输出 JSON.' });
                return;
            }
            resolve({ ok: false, error: stderr.trim() || `oi-judge 退出码 ${code}.` });
        });
    });
}

// 从源文件所在目录逐级向上查找 problem.json, 读取其中 sourceUrl 字段作为题目链接
export function resolveProblemUrl(filePath: string): string | undefined {
    let dir = path.dirname(filePath);
    while (dir) {
        const jsonPath = path.join(dir, 'problem.json');
        if (fs.existsSync(jsonPath)) {
            try {
                const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as { sourceUrl?: string };
                if (data.sourceUrl && data.sourceUrl.trim()) {
                    return data.sourceUrl.trim();
                }
            } catch {
                // problem.json 解析失败则继续向上查找
            }
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            break;
        }
        dir = parent;
    }
    return undefined;
}

// 按扩展名映射提交语言: cpp 系 -> cpp, pas 系 -> pas, 其它默认 cpp
function submitLang(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.pas' || ext === '.pp') {
        return 'pas';
    }
    return 'cpp';
}

// 供命令与面板复用的提交流程: 定位题目链接 -> 处理账号 -> 调用 oi-judge
export async function submitFlow(filePath: string, exe: string, output: vscode.OutputChannel, preferredUrl?: string): Promise<SubmitSummary> {
    // 优先用面板/命令传入的题目网址, 其次从 problem.json 推断, 最后才让用户输入
    let url = (preferredUrl ?? '').trim() || resolveProblemUrl(filePath);
    if (!url) {
        const input = await vscode.window.showInputBox({
            prompt: '未找到 problem.json, 输入题目网址',
            placeHolder: 'https://www.xmoj.tech/problem.php?id=2298',
            validateInput: (v) => (v.trim() ? undefined : '请输入题目网址')
        });
        if (!input || !input.trim()) {
            return { ok: false, error: '已取消提交.' };
        }
        url = input.trim();
    }
    url = cleanUrl(url);
    // 非 xmoj 链接: 提交目标是原题站点, 交给面板的「提交原题」
    if (!isXmojUrl(url)) {
        return { ok: false, error: `提交目标不是 xmoj: ${url} (请用「提交原题」提交到该站点)` };
    }
    const lang = submitLang(filePath);
    const cred = await resolveCredentials(url);
    if (!cred) {
        return { ok: false, error: '已取消提交.' };
    }
    const summary = await runSubmit(exe, { url, file: filePath, lang, user: cred.user, pass: cred.pass }, output);
    if (summary.ok || !/竞赛题目链接/.test(summary.error ?? '')) {
        return summary;
    }
    // 竞赛题目无法用公开题目链接提交: 输入竞赛链接后重试
    const contestUrl = await vscode.window.showInputBox({
        prompt: '该题属于竞赛, 请输入竞赛题目链接后重试',
        placeHolder: 'https://www.xmoj.tech/web/contest/10780/A',
        validateInput: (v) => (v.trim() ? undefined : '请输入竞赛题目链接')
    });
    if (!contestUrl || !contestUrl.trim()) {
        return summary;
    }
    const retryUrl = cleanUrl(contestUrl);
    const retry = await resolveCredentials(retryUrl);
    if (!retry) {
        return { ok: false, error: '已取消提交.' };
    }
    return runSubmit(exe, { url: retryUrl, file: filePath, lang, user: retry.user, pass: retry.pass }, output);
}
