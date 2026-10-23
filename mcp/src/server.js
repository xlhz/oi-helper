import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');

// 读取环境变量: 返回 trim 后的字符串, 缺省为空串
function envStr(name) {
    const v = process.env[name];
    return v ? v.trim() : '';
}

// 读取环境变量: 返回整数, 缺省或非法为 undefined
function envInt(name) {
    const v = process.env[name];
    if (!v || !v.trim()) {
        return undefined;
    }
    const n = Number.parseInt(v.trim(), 10);
    return Number.isNaN(n) ? undefined : n;
}

// 启动时从环境变量读取默认配置
const config = {
    env: envStr('OI_JUDGE_ENV'),
    jobs: envInt('OI_JUDGE_JOBS'),
    time: envInt('OI_JUDGE_TIME'),
    memory: envInt('OI_JUDGE_MEMORY'),
    standard: envStr('OI_JUDGE_STANDARD'),
    optimize: envStr('OI_JUDGE_OPTIMIZE'),
    xmojUser: envStr('OI_XMOJ_USER'),
    xmojPass: envStr('OI_XMOJ_PASS'),
    luoguCookie: envStr('OI_LUOGU_COOKIE'),
    codeforcesCookie: envStr('OI_CODEFORCES_COOKIE'),
    atcoderCookie: envStr('OI_ATCODER_COOKIE'),
    hydroCookie: envStr('OI_HYDRO_COOKIE'),
    hydroBase: envStr('OI_HYDRO_BASE'),
    originalPriority: envStr('OI_ORIGINAL_PRIORITY'),
    fetchOut: envStr('OI_FETCH_OUT'),
    submitDedupSeconds: envInt('OI_SUBMIT_DEDUP_SECONDS'),
    submitIntervalMs: envInt('OI_SUBMIT_INTERVAL_MS')
};

// 工具参数优先, 缺省回退环境变量
function pick(explicit, fallback) {
    if (explicit !== undefined && explicit !== null && explicit !== '') {
        return explicit;
    }
    if (fallback !== undefined && fallback !== null && fallback !== '') {
        return fallback;
    }
    return undefined;
}

// 提交去重窗口(秒): 未设置默认 60, 设为 0 关闭去重
function dedupWindow() {
    return config.submitDedupSeconds === undefined ? 60 : config.submitDedupSeconds;
}

// 跨进程共享状态目录: 去重记录与提交间隔均落盘, 多份实例/重启后仍有效
const stateDir = path.join(os.tmpdir(), 'oi-helper-mcp');
const lockPath = path.join(stateDir, 'submit.lock');
const lastStartPath = path.join(stateDir, 'submit-last-start');

function ensureStateDir() {
    try {
        fs.mkdirSync(stateDir, { recursive: true });
    } catch {
        // 目录不可用时降级, 不阻断提交
    }
}

// 源码指纹: 取 key 末段(内容 sha256)前 12 位, 便于在日志里比对是否同一份源码
function keySig(key) {
    if (!key) {
        return '';
    }
    return key.slice(key.lastIndexOf('|') + 1).slice(0, 12);
}

// 提交审计: 记录每次尝试/放行/拦截, 便于定位重复提交来源
function audit(fields) {
    ensureStateDir();
    try {
        fs.appendFileSync(path.join(stateDir, 'submit.log'), JSON.stringify({ t: Date.now(), pid: process.pid, ...fields }) + '\n');
    } catch {
        // 忽略
    }
}

function sha256(buf) {
    return createHash('sha256').update(buf).digest('hex');
}

// 同 (工具, URL, 语言, 源码内容) 视为同一份提交; 读不到文件时返回空串, 不参与去重
function submitKey(tool, url, lang, file) {
    try {
        return `${tool}|${url}|${lang}|${sha256(fs.readFileSync(file))}`;
    } catch {
        return '';
    }
}

function duplicateHint(tool, rec) {
    const id = rec.solutionId ? ` (提交号 ${rec.solutionId})` : '';
    return `[重复提交已拦截] 同一份源码刚刚已通过 ${tool} 提交${id}. 请改用 query_submission 轮询结果, 不要重复提交; 如需强制重提, 请稍后重试或设置 OI_SUBMIT_DEDUP_SECONDS=0 关闭去重.`;
}

function recordPath(key) {
    return path.join(stateDir, `rec-${sha256(key)}.json`);
}

function recentDuplicate(key) {
    const window = dedupWindow();
    if (!key || window <= 0) {
        return undefined;
    }
    let rec;
    try {
        rec = JSON.parse(fs.readFileSync(recordPath(key), 'utf8'));
    } catch {
        return undefined;
    }
    if (!rec || Date.now() - rec.time > window * 1000) {
        fs.rmSync(recordPath(key), { force: true });
        return undefined;
    }
    return rec;
}

function recordSubmit(key, solutionId) {
    if (!key) {
        return;
    }
    ensureStateDir();
    try {
        fs.writeFileSync(recordPath(key), JSON.stringify({ time: Date.now(), solutionId: solutionId ?? '' }));
    } catch {
        // 落盘失败不阻断提交
    }
}

function tryParse(text) {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

// 提交最小间隔(毫秒): 未设置默认 1000, 设为 0 则只串行不限间隔
function submitIntervalMs() {
    return config.submitIntervalMs === undefined ? 1000 : config.submitIntervalMs;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// 跨进程互斥锁: 原子创建锁文件; 残留锁自动清理; 无法建锁时降级为不加锁(不阻断提交)
async function acquireSubmitLock() {
    ensureStateDir();
    const staleMs = 120000;
    for (;;) {
        try {
            fs.closeSync(fs.openSync(lockPath, 'wx'));
            return true;
        } catch (err) {
            if (!err || err.code !== 'EEXIST') {
                return false;
            }
            try {
                if (Date.now() - fs.statSync(lockPath).mtimeMs > staleMs) {
                    fs.rmSync(lockPath, { force: true });
                    continue;
                }
            } catch {
                continue;
            }
            await sleep(50);
        }
    }
}

function releaseSubmitLock() {
    fs.rmSync(lockPath, { force: true });
}

function readLastSubmitStart() {
    try {
        return Number(fs.readFileSync(lastStartPath, 'utf8')) || 0;
    } catch {
        return 0;
    }
}

let submitChain = Promise.resolve();

// 所有提交跨进程串行, 且两次提交之间强制最小间隔, 避免并发或连续重复提交
function enqueueSubmit(task) {
    const run = submitChain.then(async () => {
        const locked = await acquireSubmitLock();
        try {
            const gap = submitIntervalMs() - (Date.now() - readLastSubmitStart());
            if (gap > 0) {
                await sleep(gap);
            }
            ensureStateDir();
            try {
                fs.writeFileSync(lastStartPath, String(Date.now()));
            } catch {
                // 忽略
            }
            return await task();
        } finally {
            if (locked) {
                releaseSubmitLock();
            }
        }
    });
    submitChain = run.then(() => undefined, () => undefined);
    return run;
}

// 定位 oi-judge: OI_JUDGE_PATH 优先, 否则 core/build/
function resolveJudgePath() {
    if (process.env.OI_JUDGE_PATH && process.env.OI_JUDGE_PATH.trim()) {
        return process.env.OI_JUDGE_PATH.trim();
    }
    const isWin = process.platform === 'win32';
    const names = isWin ? ['oi-judge.exe', 'oi-judge'] : ['oi-judge', 'oi-judge.exe'];
    const roots = [process.cwd(), repoRoot];
    for (const root of roots) {
        for (const name of names) {
            const candidate = path.join(root, 'core', 'build', name);
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
    }
    throw new Error('未找到 oi-judge. 请设置环境变量 OI_JUDGE_PATH 或将其放到 core/build/ 下.');
}

// 按 URL 主机选择 cookie, 未知主机回退 hydroCookie
function resolveCookie(url) {
    let hostname = '';
    try {
        hostname = new URL(url).hostname;
    } catch {
        return config.hydroCookie;
    }
    if (/luogu\.(com\.cn|org)$/i.test(hostname)) {
        return config.luoguCookie;
    }
    if (/codeforces\.com$/i.test(hostname)) {
        return config.codeforcesCookie;
    }
    if (/atcoder\.jp$/i.test(hostname)) {
        return config.atcoderCookie;
    }
    return config.hydroCookie;
}

// 运行 oi-judge, 始终 resolve 出退出码与输出
function runJudge(exe, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(exe, args, { windowsHide: true });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d.toString(); });
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.on('error', (err) => reject(new Error(`无法启动 oi-judge: ${err.message}`)));
        child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
}

// 通用 CLI 调用, 始终 resolve 出退出码与输出
async function runCli(args) {
    const exe = resolveJudgePath();
    return runJudge(exe, args);
}

// 通用 CLI 调用, 非 0 退出码抛错
async function execCli(args) {
    const { code, stdout, stderr } = await runCli(args);
    if (code === 2) {
        throw new Error(`oi-judge 编译环境不可用 (exit 2).\n${stderr || stdout}`);
    }
    if (code === 1) {
        throw new Error(`oi-judge 用法/内部错误 (exit 1).\n${stderr || stdout}`);
    }
    if (code !== 0) {
        throw new Error(`oi-judge 退出码 ${code}.\n${stderr || stdout}`);
    }
    return stdout;
}

// 非评测模式: 追加 --pretty, 运行并返回 trim 后的 stdout
async function runJson(cliArgs, emptyHint) {
    cliArgs.push('--pretty');
    const stdout = await execCli(cliArgs);
    const text = (stdout ?? '').trim();
    return text || emptyHint;
}

async function judgeProblem(request) {
    const args = request ?? {};
    if (!args.problemDir) {
        throw new Error('缺少参数 problemDir.');
    }
    const tmp = path.join(os.tmpdir(), `oi-judge-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    const cliArgs = ['--problem', args.problemDir, '--json', tmp, '--pretty'];
    const env = pick(args.env, config.env);
    if (env) cliArgs.push('--env', String(env));
    const jobs = pick(args.jobs, config.jobs);
    if (jobs !== undefined) cliArgs.push('--jobs', String(jobs));
    const time = pick(args.timeLimit, config.time);
    if (time !== undefined) cliArgs.push('--time', String(time));
    const memory = pick(args.memoryLimit, config.memory);
    if (memory !== undefined) cliArgs.push('--memory', String(memory));
    const standard = pick(args.standard, config.standard);
    if (standard) cliArgs.push('--standard', String(standard));
    const optimize = pick(args.optimize, config.optimize);
    if (optimize) cliArgs.push('--optimize', String(optimize));
    if (args.checker !== undefined && args.checker !== '') cliArgs.push('--checker', String(args.checker));
    if (args.format !== undefined && args.format !== '') cliArgs.push('--format', String(args.format));
    if (args.eps !== undefined && args.eps !== '') cliArgs.push('--eps', String(args.eps));
    try {
        await execCli(cliArgs);
        return fs.readFileSync(tmp, 'utf8');
    } finally {
        fs.rmSync(tmp, { force: true });
    }
}

async function judgeFile(request) {
    const args = request ?? {};
    if (!args.src || !args.input || !args.expected) {
        throw new Error('缺少参数 src/input/expected.');
    }
    const tmp = path.join(os.tmpdir(), `oi-judge-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    const cliArgs = ['--src', args.src, '--in', args.input, '--out', args.expected, '--json', tmp, '--pretty'];
    const env = pick(args.env, config.env);
    if (env) cliArgs.push('--env', String(env));
    const time = pick(args.timeLimit, config.time);
    if (time !== undefined) cliArgs.push('--time', String(time));
    const memory = pick(args.memoryLimit, config.memory);
    if (memory !== undefined) cliArgs.push('--memory', String(memory));
    const standard = pick(args.standard, config.standard);
    if (standard) cliArgs.push('--standard', String(standard));
    const optimize = pick(args.optimize, config.optimize);
    if (optimize) cliArgs.push('--optimize', String(optimize));
    if (args.checker !== undefined && args.checker !== '') cliArgs.push('--checker', String(args.checker));
    if (args.eps !== undefined && args.eps !== '') cliArgs.push('--eps', String(args.eps));
    try {
        await execCli(cliArgs);
        return fs.readFileSync(tmp, 'utf8');
    } finally {
        fs.rmSync(tmp, { force: true });
    }
}

async function judgeVersion() {
    const exe = resolveJudgePath();
    const { code, stdout, stderr } = await runJudge(exe, ['--version']);
    if (code !== 0) {
        throw new Error(`oi-judge --version 失败 (exit ${code}).\n${stderr || stdout}`);
    }
    return stdout.trim() || stderr.trim();
}

async function fetchProblem(request) {
    const args = request ?? {};
    if (!args.url) {
        throw new Error('缺少参数 url.');
    }
    const cliArgs = ['--fetch', String(args.url)];
    const outDir = pick(args.outDir, config.fetchOut);
    if (outDir) cliArgs.push('--fetch-out', String(outDir));
    if (args.inline) cliArgs.push('--fetch-inline');
    if (config.xmojUser) cliArgs.push('--fetch-user', config.xmojUser);
    if (config.xmojPass) cliArgs.push('--fetch-pass', config.xmojPass);
    const cookie = resolveCookie(args.url);
    if (cookie) cliArgs.push('--fetch-cookie', cookie);
    return runJson(cliArgs, '抓取题目完成, 无输出.');
}

async function fetchOriginal(request) {
    const args = request ?? {};
    if (!args.url) {
        throw new Error('缺少参数 url.');
    }
    const cliArgs = ['--fetch-original', String(args.url)];
    const cookie = resolveCookie(args.url);
    if (cookie) cliArgs.push('--fetch-cookie', cookie);
    return runJson(cliArgs, '抓取原题完成, 无输出.');
}

async function fetchContest(request) {
    const args = request ?? {};
    if (!args.url) {
        throw new Error('缺少参数 url.');
    }
    const cliArgs = ['--fetch-contest', String(args.url)];
    if (config.xmojUser) cliArgs.push('--fetch-user', config.xmojUser);
    if (config.xmojPass) cliArgs.push('--fetch-pass', config.xmojPass);
    return runJson(cliArgs, '抓取竞赛题完成, 无输出.');
}

async function fetchExtra(request) {
    const args = request ?? {};
    if (!args.url) {
        throw new Error('缺少参数 url.');
    }
    const cliArgs = ['--fetch-extra', String(args.url)];
    if (args.outDir) cliArgs.push('--fetch-extra-out', String(args.outDir));
    if (config.xmojUser) cliArgs.push('--fetch-user', config.xmojUser);
    if (config.xmojPass) cliArgs.push('--fetch-pass', config.xmojPass);
    return runJson(cliArgs, '抓取更多样例完成, 无输出.');
}

async function submitSolution(request) {
    const args = request ?? {};
    if (!args.url || !args.file) {
        throw new Error('缺少参数 url/file.');
    }
    const lang = String(args.lang || 'cpp');
    const key = submitKey('submit_solution', String(args.url), lang, String(args.file));
    return enqueueSubmit(async () => {
        audit({ tool: 'submit_solution', action: 'attempt', sig: keySig(key), file: String(args.file) });
        const dup = recentDuplicate(key);
        if (dup) {
            audit({ tool: 'submit_solution', action: 'block', sig: keySig(key), solutionId: dup.solutionId });
            return duplicateHint('submit_solution', dup);
        }
        const cliArgs = ['--submit', String(args.url), '--submit-file', String(args.file), '--submit-lang', lang];
        if (config.xmojUser) cliArgs.push('--fetch-user', config.xmojUser);
        if (config.xmojPass) cliArgs.push('--fetch-pass', config.xmojPass);
        const text = await runJson(cliArgs, '提交完成, 无输出.');
        const parsed = tryParse(text);
        if (parsed && parsed.ok === true) {
            recordSubmit(key, parsed.solutionId);
            audit({ tool: 'submit_solution', action: 'submit', sig: keySig(key), solutionId: parsed.solutionId });
        }
        return text;
    });
}

// 拆分 data URL: 取出 MIME 与 base64 数据
function splitDataUrl(s) {
    const m = /^data:([^;,]+);base64,(.*)$/s.exec(s);
    if (!m) {
        return { mimeType: 'image/jpeg', data: s };
    }
    return { mimeType: m[1], data: m[2] };
}

// 需要图形验证码时: 回传说明文本 + 验证码图片, 并给出重试所需的会话 cookie
function captchaContent(imageDataUrl, cookie, message) {
    const img = splitDataUrl(imageDataUrl);
    const lines = [
        '该站点要求图形验证码 (洛谷). 请识别下方图片中的验证码, 然后重新调用 submit_original:',
        '  captcha: <图片中的字符>',
        cookie ? `  cookie: ${cookie}` : '',
        cookie ? 'cookie 为本次会话凭据, 验证码答案与其绑定, 重试时必须原样带上.' : '',
        '若验证码看不清或输入有误, 可再次不带 captcha 调用以获取新图.'
    ].filter((s) => s);
    if (message) lines.push(`服务端消息: ${message}`);
    return [
        { type: 'text', text: lines.join('\n') },
        { type: 'image', data: img.data, mimeType: img.mimeType }
    ];
}

async function submitOriginal(request) {
    const args = request ?? {};
    if (!args.url || !args.file) {
        throw new Error('缺少参数 url/file.');
    }
    const lang = String(args.lang || 'cpp');
    const key = submitKey('submit_original', String(args.url), lang, String(args.file));
    return enqueueSubmit(async () => {
        audit({ tool: 'submit_original', action: 'attempt', sig: keySig(key), file: String(args.file) });
        const dup = recentDuplicate(key);
        if (dup) {
            audit({ tool: 'submit_original', action: 'block', sig: keySig(key), solutionId: dup.solutionId });
            return duplicateHint('submit_original', dup);
        }
        // 显式 cookie 优先: 验证码重试需沿用首次返回的会话 cookie
        const cookie = pick(args.cookie, resolveCookie(args.url));
        const cliArgs = ['--submit-original', String(args.url), '--submit-file', String(args.file), '--submit-lang', lang];
        if (args.captcha) cliArgs.push('--submit-captcha', String(args.captcha));
        if (cookie) cliArgs.push('--fetch-cookie', cookie);
        cliArgs.push('--pretty');
        const { code, stdout, stderr } = await runCli(cliArgs);
        const out = (stdout ?? '').trim();
        if (code === 0) {
            const parsed = tryParse(out);
            if (parsed && parsed.needCaptcha && parsed.captchaImage) {
                return captchaContent(parsed.captchaImage, parsed.cookie || cookie, parsed.message);
            }
            if (parsed && parsed.ok === true) {
                recordSubmit(key, parsed.submissionId);
                audit({ tool: 'submit_original', action: 'submit', sig: keySig(key), solutionId: parsed.submissionId });
            }
            return out || '提交完成, 无输出.';
        }
        const raw = (stderr || out || '').trim() || `oi-judge 退出码 ${code}.`;
        if (/验证码/.test(raw)) {
            if (args.captcha) {
                return [{ type: 'text', text: '验证码错误或不匹配. 不带 captcha 再次调用 submit_original 可获取新的验证码图片, 然后带上新的 captcha 与同一 cookie 重试.' }];
            }
            return [{ type: 'text', text: `${raw}\n提示: 未能获取验证码图片时, 请检查 cookie 是否有效, 或改用浏览器手动提交.` }];
        }
        throw new Error(raw);
    });
}

async function querySubmission(request) {
    const args = request ?? {};
    if (!args.id) {
        throw new Error('缺少参数 id.');
    }
    const oj = args.oj || 'xmoj';
    const cliArgs = ['--submit-result', String(args.id), '--result-oj', oj];
    if (oj === 'luogu') {
        const cookie = pick(args.cookie, config.luoguCookie);
        if (cookie) cliArgs.push('--fetch-cookie', cookie);
    } else if (oj === 'hydro') {
        if (args.problemUrl) cliArgs.push('--fetch', String(args.problemUrl));
        const cookie = pick(args.cookie, config.hydroCookie);
        if (cookie) cliArgs.push('--fetch-cookie', cookie);
    } else {
        if (config.xmojUser) cliArgs.push('--fetch-user', config.xmojUser);
        if (config.xmojPass) cliArgs.push('--fetch-pass', config.xmojPass);
    }
    return runJson(cliArgs, '查询完成, 无输出.');
}

const TOOLS = [
    {
        name: 'judge_problem',
        description: '评测一个题目目录 (读取 problem.json), 返回评测结果 JSON.',
        inputSchema: {
            type: 'object',
            properties: {
                problemDir: { type: 'string', description: '题目目录路径.' },
                env: { type: 'string', enum: ['auto', 'wsl', 'mingw'], description: '评测环境.' },
                jobs: { type: 'number', description: '并行度.' },
                timeLimit: { type: 'number', description: '时限 (ms).' },
                memoryLimit: { type: 'number', description: '内存限制 (MB).' },
                standard: { type: 'string', description: '语言标准 (如 c++17).' },
                optimize: { type: 'string', description: '优化级别 (如 O2).' },
                checker: { type: 'string', description: '自定义 checker 路径.' },
                format: { type: 'string', description: '输出比较格式.' },
                eps: { type: 'number', description: '浮点比较容差.' }
            },
            required: ['problemDir']
        }
    },
    {
        name: 'judge_file',
        description: '评测单个源文件, 返回评测结果 JSON.',
        inputSchema: {
            type: 'object',
            properties: {
                src: { type: 'string', description: '源文件路径 (.cpp).' },
                input: { type: 'string', description: '测试点输入文件.' },
                expected: { type: 'string', description: '测试点预期输出文件.' },
                timeLimit: { type: 'number', description: '时限 (ms).' },
                memoryLimit: { type: 'number', description: '内存限制 (MB).' },
                env: { type: 'string', enum: ['auto', 'wsl', 'mingw'], description: '评测环境.' },
                standard: { type: 'string', description: '语言标准 (如 c++17).' },
                optimize: { type: 'string', description: '优化级别 (如 O2).' },
                checker: { type: 'string', description: '自定义 checker 路径.' },
                eps: { type: 'number', description: '浮点比较容差.' }
            },
            required: ['src', 'input', 'expected']
        }
    },
    {
        name: 'judge_version',
        description: '返回 oi-judge --version 的版本信息.',
        inputSchema: {
            type: 'object',
            properties: {}
        }
    },
    {
        name: 'fetch_problem',
        description: '抓取题目页(xmoj/洛谷)并生成题目目录, 返回 JSON.',
        inputSchema: {
            type: 'object',
            properties: {
                url: { type: 'string', description: '题目页 URL.' },
                outDir: { type: 'string', description: '输出目录.' },
                inline: { type: 'boolean', description: '将样例内联到题目目录.' }
            },
            required: ['url']
        }
    },
    {
        name: 'fetch_original',
        description: '抓取原题(洛谷/CF/AtCoder/Hydro)题面与样例, 返回 JSON.',
        inputSchema: {
            type: 'object',
            properties: {
                url: { type: 'string', description: '原题 URL.' }
            },
            required: ['url']
        }
    },
    {
        name: 'fetch_contest',
        description: '抓取竞赛题目(/web/contest/{cid}/{num}), 返回 JSON.',
        inputSchema: {
            type: 'object',
            properties: {
                url: { type: 'string', description: '竞赛题目 URL.' }
            },
            required: ['url']
        }
    },
    {
        name: 'fetch_extra',
        description: '下载竞赛「更多样例」压缩包并解压, 返回 JSON.',
        inputSchema: {
            type: 'object',
            properties: {
                url: { type: 'string', description: '竞赛 URL.' },
                outDir: { type: 'string', description: '输出目录.' }
            },
            required: ['url']
        }
    },
    {
        name: 'submit_solution',
        description: '提交源码到 xmoj(题目页 URL), 凭据取自环境变量, 返回 JSON; 提交成功后请用 query_submission 轮询结果, 不要重复提交.',
        inputSchema: {
            type: 'object',
            properties: {
                url: { type: 'string', description: '题目页 URL.' },
                file: { type: 'string', description: '源码文件路径.' },
                lang: { type: 'string', enum: ['cpp', 'pas'], description: '语言 (默认 cpp).' }
            },
            required: ['url', 'file']
        }
    },
    {
        name: 'submit_original',
        description: '直连提交源码到原题(洛谷/CF/AtCoder/Hydro), 返回 JSON; 需要图形验证码时回传说明文本与验证码图片, 识别后带上 captcha 与返回的 cookie 重新调用; 提交成功后请用 query_submission 轮询结果, 不要重复提交.',
        inputSchema: {
            type: 'object',
            properties: {
                url: { type: 'string', description: '原题 URL.' },
                file: { type: 'string', description: '源码文件路径.' },
                lang: { type: 'string', enum: ['cpp', 'pas'], description: '语言 (默认 cpp).' },
                captcha: { type: 'string', description: '验证码字符 (需要验证码时).' },
                cookie: { type: 'string', description: '会话 Cookie; 验证码重试时带上首次返回的 cookie (与 captcha 绑定).' }
            },
            required: ['url', 'file']
        }
    },
    {
        name: 'query_submission',
        description: '查询某个提交的评测结果, 返回 JSON.',
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'string', description: '提交 ID.' },
                oj: { type: 'string', enum: ['xmoj', 'luogu', 'hydro'], description: '目标 OJ (默认 xmoj).' },
                problemUrl: { type: 'string', description: '题目 URL (hydro 查询时使用).' },
                cookie: { type: 'string', description: '会话 Cookie (洛谷/Hydro 查询时覆盖环境变量, 用于沿用提交会话).' }
            },
            required: ['id']
        }
    }
];

const server = new Server(
    { name: 'oi-helper-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments ?? {};
    try {
        let text;
        if (name === 'judge_problem') {
            text = await judgeProblem(args);
        } else if (name === 'judge_file') {
            text = await judgeFile(args);
        } else if (name === 'judge_version') {
            text = await judgeVersion();
        } else if (name === 'fetch_problem') {
            text = await fetchProblem(args);
        } else if (name === 'fetch_original') {
            text = await fetchOriginal(args);
        } else if (name === 'fetch_contest') {
            text = await fetchContest(args);
        } else if (name === 'fetch_extra') {
            text = await fetchExtra(args);
        } else if (name === 'submit_solution') {
            text = await submitSolution(args);
        } else if (name === 'submit_original') {
            text = await submitOriginal(args);
        } else if (name === 'query_submission') {
            text = await querySubmission(args);
        } else {
            throw new Error(`未知工具: ${name}`);
        }
        if (Array.isArray(text)) {
            return { content: text };
        }
        return { content: [{ type: 'text', text }] };
    } catch (err) {
        return { content: [{ type: 'text', text: `错误: ${err.message}` }], isError: true };
    }
});

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

export { server };
