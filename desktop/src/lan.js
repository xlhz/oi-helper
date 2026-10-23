'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { WsConnection, WS_GUID } = require('./ws');

const LAN_FILE = 'lan-messages.json';
const DEFAULT_ROOM = 'default';
const DEFAULT_PORT = 17330;
const BODY_LIMIT = 256 * 1024;
const MAX_TEXT = 2000;
const MAX_NAME = 32;
const MAX_ROOM_MESSAGES = 300;
const MAX_CONNECTIONS = 64;

function normalizeRoom(input) {
    const text = String(input ?? '').trim();
    if (!text) {
        return DEFAULT_ROOM;
    }
    if (text.length > 64 || /[\s\x00-\x1f]/.test(text)) {
        throw new Error('房间名不能超过 64 个字符, 且不能包含空白或控制字符.');
    }
    return text;
}

function normalizeName(input, fallback) {
    const text = String(input ?? '').trim();
    if (!text) {
        return String(fallback || '匿名').slice(0, MAX_NAME);
    }
    return text.slice(0, MAX_NAME);
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
                reject(new Error('请求体超过 256KB.'));
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

// 局域网聊天: HTTP 加入房间 + RFC6455 帧收发, 帧解析复用 ws.js
class LanService {
    constructor(options = {}) {
        this.dataDir = options.dataDir || '';
        this.basePort = Number(options.port) > 0 ? Number(options.port) : DEFAULT_PORT;
        this.room = DEFAULT_ROOM;
        this.retention = Boolean(options.retention);
        this.nickname = normalizeName(options.nickname || (os.userInfo().username || ''), '我');
        this.serverAddress = String(options.serverAddress || '');
        this.onLog = typeof options.onLog === 'function' ? options.onLog : () => {};
        this.host = '0.0.0.0';
        this.port = 0;
        this.server = null;
        this.enabled = false;
        this.rooms = new Map();
        this.history = this.loadHistory();
    }

    log(level, message) {
        this.onLog({ source: 'lan', level, message });
    }

    historyFile() {
        return path.join(this.dataDir || '', LAN_FILE);
    }

    loadHistory() {
        if (!this.retention) {
            return {};
        }
        try {
            const parsed = JSON.parse(fs.readFileSync(this.historyFile(), 'utf8'));
            return parsed && parsed.rooms && typeof parsed.rooms === 'object' ? parsed.rooms : {};
        } catch {
            return {};
        }
    }

    saveHistory() {
        if (!this.retention || !this.dataDir) {
            return;
        }
        const rooms = {};
        for (const [name, room] of this.rooms) {
            if (room.messages.length) {
                rooms[name] = room.messages.slice(-MAX_ROOM_MESSAGES);
            }
        }
        const file = this.historyFile();
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            const tmp = `${file}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify({ version: 1, rooms }, null, 4));
            fs.renameSync(tmp, file);
        } catch (err) {
            this.log('warn', `消息留存写入失败: ${err.message}`);
        }
    }

    ensureRoom(name) {
        if (!this.rooms.has(name)) {
            const saved = Array.isArray(this.history[name]) ? this.history[name] : [];
            this.rooms.set(name, {
                token: crypto.randomBytes(24).toString('hex'),
                connections: new Set(),
                messages: saved.filter((item) => item && typeof item === 'object').slice(-MAX_ROOM_MESSAGES)
            });
        }
        return this.rooms.get(name);
    }

    async applyConfig(config) {
        const next = config || {};
        const enabled = Boolean(next.enabled);
        const port = Number(next.port) > 0 ? Number(next.port) : DEFAULT_PORT;
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw new Error('局域网端口必须是 1-65535 的整数.');
        }
        this.room = normalizeRoom(next.room);
        this.retention = Boolean(next.retention);
        this.nickname = normalizeName(next.nickname || this.nickname, '我');
        this.serverAddress = String(next.serverAddress || '');
        this.enabled = enabled;
        if (!enabled) {
            this.stop();
            return this.snapshot();
        }
        if (this.server && this.basePort === port) {
            return this.snapshot();
        }
        this.stop();
        this.basePort = port;
        await this.listen();
        return this.snapshot();
    }

    listen() {
        return new Promise((resolve, reject) => {
            let port = this.basePort;
            let attempts = 0;
            const tryOnce = () => {
                const server = http.createServer((req, res) => this.handleHttp(req, res));
                server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
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
                    this.port = port;
                    this.basePort = port;
                    this.log('info', `局域网服务已监听 0.0.0.0:${port}, 房间 ${this.room}${this.retention ? ', 消息留存开启' : ''}.`);
                    resolve();
                };
                server.once('error', onError);
                server.once('listening', onListening);
                server.listen(port, this.host);
            };
            tryOnce();
        });
    }

    stop() {
        for (const room of this.rooms.values()) {
            for (const conn of [...room.connections]) {
                conn.close(1001, 'server shutdown');
            }
            room.connections.clear();
        }
        this.rooms.clear();
        if (this.server) {
            const server = this.server;
            this.server = null;
            try {
                server.close();
            } catch {
                // 已关闭时忽略
            }
            this.log('info', '局域网服务已停止.');
        }
        this.port = 0;
    }

    handleHttp(req, res) {
        const origin = String(req.headers.origin || '');
        if (origin) {
            res.setHeader('access-control-allow-origin', origin);
        } else {
            res.setHeader('access-control-allow-origin', '*');
        }
        res.setHeader('vary', 'Origin');
        res.setHeader('access-control-allow-headers', 'Content-Type, X-OIH-Token');
        res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }
        const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
        if (req.method === 'POST' && url.pathname === '/api/lan/join') {
            readBody(req).then((raw) => {
                let body = {};
                try {
                    body = raw.trim() ? JSON.parse(raw) : {};
                } catch {
                    sendJson(res, 400, { ok: false, error: { code: 'bad_json', message: '请求体必须是 JSON.' } });
                    return;
                }
                try {
                    const room = normalizeRoom(body.room);
                    const self = normalizeName(body.name, this.nickname);
                    const state = this.ensureRoom(room);
                    sendJson(res, 200, {
                        ok: true,
                        data: {
                            room,
                            token: state.token,
                            self,
                            members: this.members(room),
                            history: state.messages.slice(-100)
                        }
                    });
                } catch (err) {
                    sendJson(res, 400, { ok: false, error: { code: 'bad_request', message: err.message } });
                }
            }).catch((err) => {
                sendJson(res, 400, { ok: false, error: { code: 'bad_request', message: err.message } });
            });
            return;
        }
        if (req.method === 'GET' && url.pathname === '/api/lan/status') {
            sendJson(res, 200, {
                ok: true,
                data: {
                    room: this.room,
                    port: this.port,
                    retention: this.retention,
                    members: this.members(this.room)
                }
            });
            return;
        }
        sendJson(res, 404, {
            ok: false,
            error: { code: 'not_found', message: `未知路径: ${url.pathname}` }
        });
    }

    handleUpgrade(req, socket, head) {
        const url = new URL(req.url, 'http://127.0.0.1');
        const roomName = url.searchParams.get('room') || '';
        const token = url.searchParams.get('token') || '';
        const key = req.headers['sec-websocket-key'];
        let room;
        try {
            room = this.rooms.get(normalizeRoom(roomName));
        } catch {
            room = null;
        }
        if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || !key
            || !room || !sameToken(token, room.token)) {
            socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Type: application/json\r\n\r\n'
                + JSON.stringify({ ok: false, error: { code: 'unauthorized', message: '房间或令牌无效, 请先通过 /api/lan/join 加入.' } }));
            socket.destroy();
            return;
        }
        if (room.connections.size >= MAX_CONNECTIONS) {
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
        const name = normalizeName(url.searchParams.get('name'), this.nickname);
        const conn = new WsConnection(socket, this);
        conn.room = room;
        conn.roomName = normalizeRoom(roomName);
        conn.name = name;
        room.connections.add(conn);
        this.log('info', `局域网成员接入: ${name} @ ${conn.roomName}`);
        this.broadcastPresence(conn.roomName);
        if (head && head.length) {
            conn.onData(head);
        }
    }

    members(roomName) {
        const room = this.rooms.get(roomName);
        if (!room) {
            return [];
        }
        return [...room.connections].map((conn) => ({
            id: conn.clientId,
            name: conn.name,
            joinedAt: conn.connectedAt
        }));
    }

    broadcastPresence(roomName) {
        const room = this.rooms.get(roomName);
        if (!room) {
            return;
        }
        const message = { type: 'presence', members: this.members(roomName) };
        for (const conn of room.connections) {
            conn.sendJson(message);
        }
    }

    broadcastMessage(roomName, message) {
        const room = this.rooms.get(roomName);
        if (!room) {
            return;
        }
        for (const conn of room.connections) {
            conn.sendJson(message);
        }
    }

    recordMessage(roomName, message) {
        const room = this.rooms.get(roomName);
        if (!room) {
            return;
        }
        room.messages.push(message);
        if (room.messages.length > MAX_ROOM_MESSAGES) {
            room.messages.splice(0, room.messages.length - MAX_ROOM_MESSAGES);
        }
        this.saveHistory();
    }

    handleMessage(conn, text) {
        let message;
        try {
            message = JSON.parse(text);
        } catch {
            conn.sendJson({ type: 'error', error: { code: 'bad_json', message: '消息必须是 JSON.' } });
            return;
        }
        if (!message || typeof message !== 'object' || Array.isArray(message)) {
            conn.sendJson({ type: 'error', error: { code: 'bad_json', message: '消息必须是 JSON 对象.' } });
            return;
        }
        const type = String(message.type || '');
        if (type === 'ping') {
            conn.sendJson({ type: 'pong', at: new Date().toISOString() });
            return;
        }
        if (type === 'chat') {
            if (message.token !== undefined && !sameToken(message.token, conn.room.token)) {
                conn.sendJson({ type: 'error', error: { code: 'invalid_token', message: '令牌无效.' } });
                return;
            }
            if (String(message.room || '') !== conn.roomName) {
                conn.sendJson({ type: 'error', error: { code: 'bad_room', message: `消息房间与连接房间不一致: ${conn.roomName}` } });
                return;
            }
            const content = String(message.text ?? '').trim();
            if (!content) {
                conn.sendJson({ type: 'error', error: { code: 'empty_message', message: '消息内容不能为空.' } });
                return;
            }
            if (content.length > MAX_TEXT) {
                conn.sendJson({ type: 'error', error: { code: 'message_too_long', message: `消息不能超过 ${MAX_TEXT} 个字符.` } });
                return;
            }
            const chat = {
                type: 'chat',
                room: conn.roomName,
                from: conn.name,
                text: content,
                at: new Date().toISOString()
            };
            this.recordMessage(conn.roomName, chat);
            this.broadcastMessage(conn.roomName, chat);
            return;
        }
        conn.sendJson({ type: 'error', error: { code: 'unknown_type', message: `未知消息类型: ${type}` } });
    }

    removeConnection(conn) {
        const room = conn.room;
        if (!room || !room.connections.delete(conn)) {
            return;
        }
        this.log('info', `局域网成员离开: ${conn.name} @ ${conn.roomName}`);
        this.broadcastPresence(conn.roomName);
    }

    snapshot() {
        return {
            enabled: this.enabled,
            running: Boolean(this.server),
            host: this.host,
            port: this.port || this.basePort,
            room: this.room,
            retention: this.retention,
            self: this.nickname,
            serverAddress: this.serverAddress,
            file: this.historyFile(),
            members: this.server ? this.members(this.room) : []
        };
    }
}

module.exports = { LanService, DEFAULT_ROOM, DEFAULT_PORT };
