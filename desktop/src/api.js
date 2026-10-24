'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DISPLAY_VERSION, BUILD } = require('./version');
const { maskText } = require('./util');

const BODY_LIMIT = 2 * 1024 * 1024;

function httpError(status, code, message) {
    const err = new Error(message);
    err.status = status;
    err.code = code;
    return err;
}

function sendJson(res, status, data) {
    const text = JSON.stringify(data);
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(text)
    });
    res.end(text);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > BODY_LIMIT) {
                reject(httpError(413, 'payload_too_large', '请求体超过 2MB.'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function sameToken(a, b) {
    if (!a || !b) {
        return false;
    }
    const ha = crypto.createHash('sha256').update(String(a)).digest();
    const hb = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
}

// 定位 oi-judge: 环境变量优先, 其次安装目录 resources/judge, 最后仓库 core/build
function resolveJudgePath() {
    const fromEnv = String(process.env.OI_JUDGE_PATH || '').trim();
    if (fromEnv && fs.existsSync(fromEnv)) {
        return fromEnv;
    }
    const repoRoot = path.resolve(__dirname, '..', '..');
    const names = ['oi-judge.exe', 'oi-judge'];
    const dirs = [
        path.join(repoRoot, 'judge'),
        path.join(repoRoot, 'core', 'build'),
        path.join(process.cwd(), 'core', 'build')
    ];
    for (const dir of dirs) {
        for (const name of names) {
            const candidate = path.join(dir, name);
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
    }
    throw httpError(503, 'judge_unavailable', '未找到 oi-judge, 请设置 OI_JUDGE_PATH 或重新安装 OI Helper.');
}

function runProcess(exe, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(exe, args, { windowsHide: true });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d.toString(); });
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.on('error', (err) => reject(httpError(500, 'judge_spawn_failed', `无法启动 oi-judge: ${err.message}`)));
        child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
}

class ApiService {
    constructor(options = {}) {
        this.oihd = options.oihd;
        this.sync = options.sync || null;
        this.events = options.events || null;
        this.token = options.token;
        this.onLog = typeof options.onLog === 'function' ? options.onLog : () => {};
        this.onPortChange = typeof options.onPortChange === 'function' ? options.onPortChange : () => {};
        this.host = '127.0.0.1';
        this.port = 0;
        this.server = null;
        this.config = { enabled: false, host: '127.0.0.1', port: 17322 };
    }

    log(level, message) {
        this.onLog({ source: 'api', level, message });
    }

    async applyConfig(config) {
        const next = {
            enabled: Boolean(config && config.enabled),
            host: String(config && config.host ? config.host : '127.0.0.1'),
            port: Number(config && config.port) > 0 ? Number(config.port) : 17322
        };
        this.config = next;
        if (!next.enabled) {
            if (this.server) {
                this.stop();
                this.log('info', 'HTTP API 已关闭.');
            }
            return this.snapshot();
        }
        if (this.server && this.host === next.host && this.port === next.port) {
            return this.snapshot();
        }
        this.stop();
        await this.listen(next.host, next.port);
        return this.snapshot();
    }

    listen(host, basePort) {
        return new Promise((resolve, reject) => {
            let port = basePort;
            let attempts = 0;
            const tryOnce = () => {
                const server = http.createServer((req, res) => {
                    this.handle(req, res).catch((err) => {
                        this.log('error', `API 请求处理异常: ${maskText(err.message)}`);
                        if (!res.headersSent) {
                            sendJson(res, 500, { ok: false, error: { code: 'internal_error', message: err.message } });
                        }
                    });
                });
                const onError = (err) => {
                    server.removeListener('listening', onListening);
                    if (err && err.code === 'EADDRINUSE' && attempts < 12) {
                        attempts += 1;
                        port += 1;
                        setImmediate(tryOnce);
                        return;
                    }
                    reject(err);
                };
                const onListening = () => {
                    server.removeListener('error', onError);
                    this.server = server;
                    this.host = host;
                    this.port = port;
                    this.log('info', `HTTP API 已监听 http://${host}:${port}`);
                    this.onPortChange(port);
                    resolve();
                };
                server.once('error', onError);
                server.once('listening', onListening);
                server.listen(port, host);
            };
            tryOnce();
        });
    }

    stop() {
        if (!this.server) {
            return;
        }
        const server = this.server;
        this.server = null;
        try {
            server.close();
        } catch {
            // 已关闭时忽略
        }
    }

    authorized(req, url) {
        const header = String(req.headers['x-oih-token'] || '');
        const auth = String(req.headers.authorization || '');
        const bearer = /^Bearer\s+(.+)$/i.exec(auth);
        const query = url.searchParams.get('token') || '';
        return sameToken(header, this.token) || (bearer && sameToken(bearer[1], this.token)) || sameToken(query, this.token);
    }

    dangerEnabled(key) {
        const api = this.oihd.getSettings().interface.api;
        return Boolean(api && api.danger && api.danger[key]);
    }

    // 回显来源以便扩展与本地页面调用; 写操作仍需令牌
    applyCors(req, res) {
        const origin = String(req.headers.origin || '');
        if (origin) {
            res.setHeader('access-control-allow-origin', origin);
        }
        res.setHeader('vary', 'Origin');
        res.setHeader('access-control-allow-headers', 'Content-Type, X-OIH-Token');
        res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    }

    async handle(req, res) {
        const started = Date.now();
        const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
        const pathname = url.pathname;
        this.applyCors(req, res);
        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            this.finishLog(req, pathname, 204, started);
            return;
        }
        let status = 200;
        try {
            if (req.method === 'GET' && pathname === '/health') {
                sendJson(res, 200, {
                    name: 'oi-helper',
                    version: DISPLAY_VERSION,
                    build: BUILD,
                    status: 'ok'
                });
                this.finishLog(req, pathname, 200, started);
                return;
            }
            if (pathname !== '/api' && !pathname.startsWith('/api/')) {
                throw httpError(404, 'not_found', `未知路径: ${pathname}`);
            }
            if (!this.authorized(req, url)) {
                throw httpError(401, 'unauthorized', '令牌无效, 请在请求头携带 x-oih-token.');
            }
            const raw = await readBody(req);
            let body = {};
            if (raw.trim()) {
                try {
                    body = JSON.parse(raw);
                } catch {
                    throw httpError(400, 'bad_json', '请求体必须是 JSON.');
                }
            }
            const data = await this.route(req.method, pathname, body);
            sendJson(res, 200, { ok: true, data });
        } catch (err) {
            status = err.status || 500;
            if (!res.headersSent) {
                sendJson(res, status, {
                    ok: false,
                    error: {
                        code: err.code || 'internal_error',
                        message: maskText(err.message || '内部错误.')
                    }
                });
            }
        } finally {
            this.finishLog(req, pathname, status, started);
        }
    }

    finishLog(req, pathname, status, started) {
        const level = status >= 400 ? 'warn' : 'info';
        this.log(level, `${req.method} ${maskText(pathname)} -> ${status} (${Date.now() - started} ms)`);
    }

    async route(method, pathname, body) {
        if (method === 'GET' && pathname === '/api/servers') {
            return this.oihd.listServers();
        }
        if (method === 'GET' && pathname === '/api/credentials') {
            return this.oihd.listCredentials();
        }
        if (method === 'GET' && pathname === '/api/workspaces') {
            return this.oihd.listWorkspaces();
        }
        const serverMatch = /^\/api\/servers\/([^/]+)$/.exec(pathname);
        if (method === 'DELETE' && serverMatch) {
            if (!this.dangerEnabled('deleteServer')) {
                throw httpError(403, 'danger_disabled', '删除服务器默认关闭, 请在「接口 > API」中显式开启后重试.');
            }
            const id = decodeURIComponent(serverMatch[1]);
            const removed = this.oihd.deleteServer(id);
            return { id, removed };
        }
        if (method === 'POST' && pathname === '/api/sync/push') {
            if (!this.dangerEnabled('syncOverwrite')) {
                throw httpError(403, 'danger_disabled', '覆盖同步默认关闭, 请在「接口 > API」中显式开启后重试.');
            }
            return this.syncPush(body);
        }
        if (method === 'POST' && pathname === '/api/judge/run') {
            return this.judgeRun(body);
        }
        if (method === 'POST' && pathname === '/api/judge') {
            return this.judgePanel(body);
        }
        if (method === 'GET' && pathname === '/api/events') {
            if (!this.events) {
                throw httpError(503, 'events_unavailable', '事件服务未就绪, 请重启桌面程序.');
            }
            return this.events.list();
        }
        if (method === 'POST' && pathname === '/api/events') {
            if (!this.events) {
                throw httpError(503, 'events_unavailable', '事件服务未就绪, 请重启桌面程序.');
            }
            try {
                return this.events.push(body);
            } catch (err) {
                throw httpError(400, 'bad_event', err.message);
            }
        }
        throw httpError(404, 'not_found', `未知接口: ${method} ${pathname}`);
    }

    syncPush(body) {
        if (body.confirm !== true) {
            throw httpError(400, 'confirmation_required', '覆盖同步需要显式确认 (confirm=true).');
        }
        const workspace = String(body.workspace || '').trim();
        if (!workspace) {
            throw httpError(400, 'bad_request', '缺少 workspace 参数.');
        }
        if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
            throw httpError(400, 'bad_workspace', `工作区目录不存在: ${workspace}`);
        }
        if (!this.sync) {
            throw httpError(503, 'sync_unavailable', '同步引擎未就绪, 请重启桌面程序.');
        }
        const result = this.sync.overwriteWorkspace(workspace);
        this.log('info', `覆盖同步完成: ${result.count} 条凭据写入工作区.`);
        return result;
    }

    // 浏览器面板入口: source 既可以是源码路径, 也可以是源码文本
    async judgePanel(body) {
        const problemDir = String(body.problemDir || '').trim();
        const source = String(body.source || '').trim();
        let src = source;
        const temps = [];
        const tempFile = (ext, content) => {
            const file = path.join(os.tmpdir(), `oih-${ext}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`);
            fs.writeFileSync(file, content);
            temps.push(file);
            return file;
        };
        if (source && !fs.existsSync(source)) {
            if (/[\r\n]/.test(source) || source.includes('#include')) {
                src = tempFile('cpp', source);
            }
        }
        let input = body.input;
        let expected = body.expected;
        if (input !== undefined) {
            input = tempFile('in', String(input ?? ''));
        }
        if (expected !== undefined) {
            expected = tempFile('out', String(expected ?? ''));
        }
        try {
            return await this.judgeRun({
                problemDir,
                src,
                input,
                expected,
                timeLimit: body.timeLimit,
                memoryLimit: body.memoryLimit
            });
        } finally {
            for (const file of temps) {
                fs.rmSync(file, { force: true });
            }
        }
    }

    async judgeRun(body) {
        const exe = resolveJudgePath();
        const tmp = path.join(os.tmpdir(), `oih-judge-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`);
        const args = [];
        if (body.problemDir) {
            args.push('--problem', String(body.problemDir));
        } else if (body.src && body.input && body.expected) {
            args.push('--src', String(body.src), '--in', String(body.input), '--out', String(body.expected));
        } else {
            throw httpError(400, 'bad_request', '需要 problemDir 或 src/input/expected.');
        }
        if (body.timeLimit !== undefined && body.timeLimit !== '') {
            args.push('--time', String(body.timeLimit));
        }
        if (body.memoryLimit !== undefined && body.memoryLimit !== '') {
            args.push('--memory', String(body.memoryLimit));
        }
        args.push('--json', tmp, '--pretty');
        try {
            const result = await runProcess(exe, args);
            if (result.code !== 0) {
                throw httpError(500, 'judge_failed', `oi-judge 退出码 ${result.code}: ${(result.stderr || result.stdout || '').trim()}`);
            }
            const text = fs.readFileSync(tmp, 'utf8');
            return JSON.parse(text);
        } finally {
            fs.rmSync(tmp, { force: true });
        }
    }

    snapshot() {
        return {
            enabled: this.config.enabled,
            host: this.host,
            port: this.port,
            running: Boolean(this.server),
            baseUrl: this.server ? `http://${this.host}:${this.port}` : ''
        };
    }
}

module.exports = { ApiService };
