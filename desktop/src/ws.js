'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { DISPLAY_VERSION, BUILD } = require('./version');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 1024 * 1024;
const HEARTBEAT_MS = 30000;
const HEARTBEAT_TIMEOUT_MS = 75000;

const OPCODE = {
    continuation: 0x0,
    text: 0x1,
    binary: 0x2,
    close: 0x8,
    ping: 0x9,
    pong: 0xa
};

class WsConnection {
    constructor(socket, service) {
        this.socket = socket;
        this.service = service;
        this.clientId = crypto.randomUUID();
        this.buffer = Buffer.alloc(0);
        this.fragments = [];
        this.fragmentOpcode = 0;
        this.closed = false;
        this.lastPong = Date.now();
        this.connectedAt = Date.now();
        this.version = '';
        this.workspacePath = '';
        this.remote = `${socket.remoteAddress || '127.0.0.1'}:${socket.remotePort || 0}`;

        socket.setNoDelay(true);
        socket.on('data', (chunk) => this.onData(chunk));
        socket.on('error', () => this.destroy());
        socket.on('close', () => {
            this.closed = true;
            service.removeConnection(this);
        });
    }

    onData(chunk) {
        if (this.closed) {
            return;
        }
        this.buffer = Buffer.concat([this.buffer, chunk]);
        try {
            this.parseFrames();
        } catch (err) {
            this.service.log('warn', `WebSocket 帧解析失败: ${err.message}`);
            this.close(1002, 'protocol error');
        }
    }

    parseFrames() {
        for (;;) {
            const buf = this.buffer;
            if (buf.length < 2) {
                return;
            }
            const b0 = buf[0];
            const b1 = buf[1];
            const fin = (b0 & 0x80) !== 0;
            const opcode = b0 & 0x0f;
            const masked = (b1 & 0x80) !== 0;
            let length = b1 & 0x7f;
            let offset = 2;
            if (length === 126) {
                if (buf.length < 4) {
                    return;
                }
                length = buf.readUInt16BE(2);
                offset = 4;
            } else if (length === 127) {
                if (buf.length < 10) {
                    return;
                }
                const big = buf.readBigUInt64BE(2);
                if (big > BigInt(MAX_PAYLOAD)) {
                    throw new Error('消息体过大.');
                }
                length = Number(big);
                offset = 10;
            }
            if (length > MAX_PAYLOAD) {
                throw new Error('消息体过大.');
            }
            let maskKey = null;
            if (masked) {
                if (buf.length < offset + 4) {
                    return;
                }
                maskKey = buf.subarray(offset, offset + 4);
                offset += 4;
            }
            if (buf.length < offset + length) {
                return;
            }
            const payload = Buffer.from(buf.subarray(offset, offset + length));
            if (maskKey) {
                for (let i = 0; i < payload.length; i += 1) {
                    payload[i] ^= maskKey[i % 4];
                }
            }
            this.buffer = buf.subarray(offset + length);
            this.handleFrame(fin, opcode, payload);
        }
    }

    handleFrame(fin, opcode, payload) {
        if (opcode === OPCODE.close) {
            this.close(1000, 'bye');
            return;
        }
        if (opcode === OPCODE.ping) {
            this.sendFrame(OPCODE.pong, payload);
            return;
        }
        if (opcode === OPCODE.pong) {
            this.lastPong = Date.now();
            return;
        }
        if (opcode === OPCODE.binary) {
            this.close(1003, 'text only');
            return;
        }
        if (opcode === OPCODE.continuation) {
            this.fragments.push(payload);
            if (fin) {
                const full = Buffer.concat(this.fragments);
                const first = this.fragmentOpcode;
                this.fragments = [];
                this.fragmentOpcode = 0;
                this.dispatch(first, full);
            }
            return;
        }
        if (opcode === OPCODE.text) {
            if (fin) {
                this.dispatch(opcode, payload);
            } else {
                this.fragmentOpcode = opcode;
                this.fragments = [payload];
            }
        }
    }

    dispatch(opcode, payload) {
        if (opcode !== OPCODE.text) {
            return;
        }
        this.service.handleMessage(this, payload.toString('utf8'));
    }

    sendFrame(opcode, payload) {
        if (this.closed || this.socket.destroyed) {
            return;
        }
        const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? '');
        let header;
        if (data.length < 126) {
            header = Buffer.from([0x80 | opcode, data.length]);
        } else if (data.length < 65536) {
            header = Buffer.alloc(4);
            header[0] = 0x80 | opcode;
            header[1] = 126;
            header.writeUInt16BE(data.length, 2);
        } else {
            header = Buffer.alloc(10);
            header[0] = 0x80 | opcode;
            header[1] = 127;
            header.writeBigUInt64BE(BigInt(data.length), 2);
        }
        this.socket.write(Buffer.concat([header, data]));
    }

    sendJson(obj) {
        if (this.closed) {
            return;
        }
        this.sendFrame(OPCODE.text, Buffer.from(JSON.stringify(obj), 'utf8'));
    }

    sendPing() {
        this.sendFrame(OPCODE.ping, Buffer.alloc(0));
    }

    close(code = 1000, reason = '') {
        if (this.closed) {
            return;
        }
        const body = Buffer.alloc(2 + Buffer.byteLength(reason));
        body.writeUInt16BE(code, 0);
        body.write(reason, 2, 'utf8');
        this.sendFrame(OPCODE.close, body);
        this.closed = true;
        const socket = this.socket;
        setTimeout(() => socket.destroy(), 30);
    }

    destroy() {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.socket.destroy();
    }
}

class WsService {
    constructor(options = {}) {
        this.dataDir = options.dataDir;
        this.basePort = Number(options.port) > 0 ? Number(options.port) : 17321;
        this.maxAttempts = options.maxAttempts || 12;
        this.apiPort = Number(options.apiPort) || 0;
        this.judgePath = String(options.judgePath || '');
        this.onLog = typeof options.onLog === 'function' ? options.onLog : () => {};
        this.onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};
        this.token = crypto.randomBytes(32).toString('hex');
        this.server = null;
        this.port = 0;
        this.clients = new Set();
        this.workspaces = new Map();
        this.heartbeat = null;
    }

    log(level, message) {
        this.onLog({ source: 'ws', level, message });
    }

    async start() {
        if (this.server) {
            return this.snapshot();
        }
        this.server = await this.listen();
        this.heartbeat = setInterval(() => this.tick(), HEARTBEAT_MS);
        if (this.heartbeat.unref) {
            this.heartbeat.unref();
        }
        this.writeAgentFile();
        this.log('info', `WebSocket 服务已监听 127.0.0.1:${this.port}, 令牌 ${this.token.slice(0, 4)}****`);
        return this.snapshot();
    }

    listen() {
        return new Promise((resolve, reject) => {
            let port = this.basePort;
            let attempts = 0;
            const tryOnce = () => {
                const server = http.createServer((req, res) => {
                    res.writeHead(426, { 'content-type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ ok: false, error: { code: 'upgrade_required', message: '该端口仅提供 WebSocket 服务.' } }));
                });
                server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
                const onError = (err) => {
                    server.removeListener('listening', onListening);
                    if (err && err.code === 'EADDRINUSE' && attempts < this.maxAttempts) {
                        attempts += 1;
                        port += 1;
                        setImmediate(tryOnce);
                        return;
                    }
                    reject(err);
                };
                const onListening = () => {
                    server.removeListener('error', onError);
                    this.port = port;
                    resolve(server);
                };
                server.once('error', onError);
                server.once('listening', onListening);
                server.listen(port, '127.0.0.1');
            };
            tryOnce();
        });
    }

    handleUpgrade(req, socket, head) {
        const key = req.headers['sec-websocket-key'];
        const upgrade = String(req.headers.upgrade || '').toLowerCase();
        if (upgrade !== 'websocket' || !key) {
            socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
            socket.destroy();
            return;
        }
        if (this.clients.size >= 64) {
            socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
            socket.destroy();
            return;
        }
        const accept = crypto.createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
        socket.write([
            'HTTP/1.1 101 Switching Protocols',
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Accept: ${accept}`,
            '\r\n'
        ].join('\r\n'));
        const conn = new WsConnection(socket, this);
        this.clients.add(conn);
        this.log('info', `扩展连接已建立: ${conn.remote}`);
        if (head && head.length) {
            conn.onData(head);
        }
    }

    removeConnection(conn) {
        if (!this.clients.delete(conn)) {
            return;
        }
        this.log('info', `扩展连接已断开: ${conn.workspacePath || conn.remote}`);
        this.onEvent('clientDisconnected', { clientId: conn.clientId, workspacePath: conn.workspacePath });
    }

    verifyToken(input) {
        if (typeof input !== 'string' || !input) {
            return false;
        }
        const a = crypto.createHash('sha256').update(input).digest();
        const b = crypto.createHash('sha256').update(this.token).digest();
        return crypto.timingSafeEqual(a, b);
    }

    handleMessage(conn, text) {
        let msg;
        try {
            msg = JSON.parse(text);
        } catch {
            this.sendError(conn, 'bad_request', '消息必须是 JSON 对象.');
            return;
        }
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
            this.sendError(conn, 'bad_request', '消息必须是 JSON 对象.');
            return;
        }
        if (!this.verifyToken(msg.token)) {
            this.log('warn', '拒绝携带无效令牌的连接.');
            this.sendError(conn, 'invalid_token', '令牌无效, 请从 agent.json 读取最新 token 后重连.', true);
            return;
        }
        const type = String(msg.type || '');
        const payload = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};
        if (type === 'ping') {
            conn.sendJson({ type: 'pong', token: this.token, payload: { time: Date.now() } });
            return;
        }
        if (type === 'hello') {
            this.handleHello(conn, payload);
            return;
        }
        if (type === 'status') {
            this.handleStatus(conn, payload);
            return;
        }
        if (type === 'credentialsChanged') {
            this.handleCredentialsChanged(conn, payload);
            return;
        }
        if (type === 'contestEvent') {
            this.handleContestEvent(conn, payload);
            return;
        }
        if (type === 'openWorkspace' || type === 'createWorkspace' || type === 'syncRequest') {
            // 回执统一为 result, 方向不支持的明细放在 payload.error 中
            conn.sendJson({
                type: 'result',
                token: this.token,
                payload: {
                    ok: false,
                    request: type,
                    error: {
                        code: 'unsupported_direction',
                        message: `${type} 由程序下发给扩展, 扩展不应上报该类型.`
                    }
                }
            });
            return;
        }
        this.sendError(conn, 'unknown_type', `未知消息类型: ${type}`);
    }

    handleHello(conn, payload) {
        const workspacePath = String(payload.workspacePath || payload.path || '').trim();
        conn.version = String(payload.version || '');
        conn.workspacePath = workspacePath;
        if (workspacePath) {
            this.upsertWorkspace({
                path: workspacePath,
                clientId: conn.clientId,
                version: conn.version,
                source: 'extension'
            });
        }
        this.log('info', `扩展已接入: ${workspacePath || '未上报工作区'}${conn.version ? ` (v${conn.version})` : ''}`);
        conn.sendJson({
            type: 'helloAck',
            token: this.token,
            payload: { ok: true, clientId: conn.clientId, version: DISPLAY_VERSION, build: BUILD }
        });
        this.onEvent('hello', { clientId: conn.clientId, workspacePath, version: conn.version });
    }

    handleStatus(conn, payload) {
        const workspacePath = String(payload.workspacePath || conn.workspacePath || '').trim();
        const record = this.upsertWorkspace({
            path: workspacePath,
            clientId: conn.clientId,
            version: conn.version,
            source: 'extension',
            server: payload.server,
            connection: payload.connection || payload.state
        });
        conn.sendJson({
            type: 'result',
            token: this.token,
            payload: { ok: true, request: 'status', data: record || null }
        });
        this.onEvent('status', { clientId: conn.clientId, workspace: record });
    }

    handleCredentialsChanged(conn, payload) {
        const workspacePath = String(payload.workspacePath || conn.workspacePath || '').trim();
        this.log('info', `工作区凭据发生变化: ${workspacePath || '未上报路径'}`);
        conn.sendJson({
            type: 'result',
            token: this.token,
            payload: { ok: true, request: 'credentialsChanged' }
        });
        this.onEvent('credentialsChanged', { clientId: conn.clientId, workspacePath, changedAt: payload.changedAt });
    }

    // 扩展侧榜单轮询产生的事件交给统一事件源去重与分发
    handleContestEvent(conn, payload) {
        this.onEvent('contestEvent', { clientId: conn.clientId, workspacePath: conn.workspacePath, event: payload });
        conn.sendJson({
            type: 'result',
            token: this.token,
            payload: { ok: true, request: 'contestEvent' }
        });
    }

    upsertWorkspace(input) {
        const workspacePath = String(input.path || '').trim();
        if (!workspacePath) {
            return null;
        }
        const now = new Date().toISOString();
        const existing = this.workspaces.get(workspacePath) || {};
        const record = {
            path: workspacePath,
            clientId: input.clientId || existing.clientId || '',
            version: input.version || existing.version || '',
            source: input.source || existing.source || 'extension',
            server: input.server !== undefined ? input.server : (existing.server ?? null),
            connection: input.connection || existing.connection || 'unknown',
            updatedAt: now
        };
        this.workspaces.set(workspacePath, record);
        return record;
    }

    sendError(conn, code, message, closeAfter = false) {
        conn.sendJson({
            type: 'error',
            token: '',
            payload: { ok: false, error: { code, message } }
        });
        if (closeAfter) {
            setTimeout(() => conn.close(1008, code), 80);
        }
    }

    broadcast(type, payload, options = {}) {
        const targets = options.clientId
            ? [...this.clients].filter((conn) => conn.clientId === options.clientId)
            : [...this.clients];
        for (const conn of targets) {
            conn.sendJson({ type, token: this.token, payload });
        }
        this.log('info', `已下发 ${type}, 目标 ${targets.length} 个连接.`);
        return targets.length;
    }

    tick() {
        const now = Date.now();
        for (const conn of [...this.clients]) {
            if (now - conn.lastPong > HEARTBEAT_TIMEOUT_MS) {
                this.log('warn', `连接心跳超时已断开: ${conn.remote}`);
                conn.close(1001, 'heartbeat timeout');
                continue;
            }
            conn.sendPing();
        }
    }

    setApiPort(port) {
        this.apiPort = Number(port) || 0;
        if (this.port) {
            this.writeAgentFile();
        }
    }

    writeAgentFile() {
        if (!this.dataDir) {
            return;
        }
        fs.mkdirSync(this.dataDir, { recursive: true });
        const data = {
            port: this.port,
            apiPort: this.apiPort,
            token: this.token,
            pid: process.pid,
            version: DISPLAY_VERSION,
            build: BUILD,
            judgePath: this.judgePath,
            updatedAt: new Date().toISOString()
        };
        fs.writeFileSync(path.join(this.dataDir, 'agent.json'), JSON.stringify(data, null, 4));
    }

    stop() {
        if (this.heartbeat) {
            clearInterval(this.heartbeat);
            this.heartbeat = null;
        }
        for (const conn of [...this.clients]) {
            conn.close(1001, 'server shutdown');
        }
        this.clients.clear();
        if (this.server) {
            try {
                this.server.close();
            } catch {
                // 已关闭时忽略
            }
            this.server = null;
        }
        // 只清理当前进程写入的发现文件, 避免误删新实例记录
        const file = path.join(this.dataDir || '', 'agent.json');
        try {
            const current = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (current && current.pid === process.pid) {
                fs.rmSync(file, { force: true });
            }
        } catch {
            // 文件不存在时忽略
        }
        this.log('info', 'WebSocket 服务已停止.');
    }

    getClients() {
        return [...this.clients].map((conn) => ({
            clientId: conn.clientId,
            version: conn.version,
            workspacePath: conn.workspacePath,
            connectedAt: conn.connectedAt,
            remote: conn.remote
        }));
    }

    getReportedWorkspaces() {
        return [...this.workspaces.values()];
    }

    snapshot() {
        return {
            port: this.port,
            clients: this.getClients().length,
            workspaces: this.getReportedWorkspaces().length,
            token: this.token
        };
    }
}

module.exports = { WsService, WsConnection, WS_GUID, OPCODE };
