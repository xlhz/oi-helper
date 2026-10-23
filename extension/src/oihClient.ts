import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { Socket } from 'net';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const PING_INTERVAL_MS = 25000;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export interface OihAgentInfo {
    port: number;
    apiPort: number;
    token: string;
}

export interface OihEvent {
    id?: string;
    type?: string;
    time?: string;
    source?: string;
    payload?: Record<string, unknown>;
}

export interface OihClientOptions {
    extensionVersion: string;
    getWorkspacePath: () => string;
    getWorkspacePaths?: () => string[];
    onOpenWorkspace: (targetPath: string) => Promise<void>;
    onCreateWorkspace: (targetPath: string) => Promise<{ ok: boolean; message: string }>;
    onEvent?: (event: OihEvent) => void;
    onLog?: (message: string, level?: 'info' | 'warn' | 'error') => void;
}

export class OihClient {
    private stopped = true;
    private socket: Socket | null = null;
    private handshake: http.ClientRequest | null = null;
    private buffer = Buffer.alloc(0);
    private fragments: Buffer[] = [];
    private reconnectTimer: NodeJS.Timeout | null = null;
    private pingTimer: NodeJS.Timeout | null = null;
    private attempts = 0;
    private token = '';
    private agent: OihAgentInfo | null = null;
    private credentialsFile = '';

    constructor(private readonly options: OihClientOptions) {}

    start(): void {
        if (!this.stopped) {
            return;
        }
        this.stopped = false;
        this.attempts = 0;
        this.watchCredentials();
        this.connect();
    }

    stop(): void {
        this.stopped = true;
        this.clearReconnect();
        this.clearPing();
        this.unwatchCredentials();
        const socket = this.socket;
        this.socket = null;
        if (socket && !socket.destroyed) {
            try {
                this.writeFrame(socket, 0x8, Buffer.alloc(0));
            } catch {
                // 关闭帧发送失败时直接销毁
            }
            socket.destroy();
        }
        if (this.handshake) {
            this.handshake.destroy();
            this.handshake = null;
        }
    }

    dispose(): void {
        this.stop();
    }

    // 工作区切换或设置变化后刷新上报
    notifyWorkspaceChanged(): void {
        this.watchCredentials();
        this.sendStatus();
    }

    refreshStatus(): void {
        this.sendStatus();
    }

    // 把榜单轮询产生的事件交给桌面统一事件源去重与分发
    publishEvent(event: OihEvent): boolean {
        if (!this.socket || this.socket.destroyed) {
            this.log(`桌面程序未连接, 事件未上报: ${String(event.payload?.title || event.type || '')}`, 'warn');
            return false;
        }
        this.sendJson({ type: 'contestEvent', token: this.token, payload: event });
        return true;
    }

    private log(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
        if (this.options.onLog) {
            this.options.onLog(message, level);
        }
    }

    private workspacePath(): string {
        try {
            return String(this.options.getWorkspacePath() || '').trim();
        } catch {
            return '';
        }
    }

    private agentFile(): string {
        const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
        return path.join(appData, 'OIHelper', 'agent.json');
    }

    private readAgent(): OihAgentInfo | null {
        try {
            const raw = JSON.parse(fs.readFileSync(this.agentFile(), 'utf8'));
            const port = Number(raw.port);
            const token = String(raw.token || '').trim();
            if (!Number.isInteger(port) || port < 1 || port > 65535 || !token) {
                return null;
            }
            return {
                port,
                apiPort: Number(raw.apiPort) || 0,
                token
            };
        } catch {
            // 程序未启动或文件尚未写入, 静默等待重试
            return null;
        }
    }

    private connect(): void {
        if (this.stopped) {
            return;
        }
        const agent = this.readAgent();
        if (!agent) {
            this.scheduleReconnect();
            return;
        }
        this.agent = agent;
        this.token = agent.token;
        const key = crypto.randomBytes(16).toString('base64');
        const request = http.request({
            host: '127.0.0.1',
            port: agent.port,
            path: '/',
            timeout: 5000,
            headers: {
                Connection: 'Upgrade',
                Upgrade: 'websocket',
                'Sec-WebSocket-Version': '13',
                'Sec-WebSocket-Key': key
            }
        });
        this.handshake = request;
        let upgraded = false;

        request.on('upgrade', (response: http.IncomingMessage, socket: Socket, head: Buffer) => {
            upgraded = true;
            this.handshake = null;
            const expected = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
            if (String(response.headers['sec-websocket-accept'] || '') !== expected) {
                this.log('WebSocket 握手校验失败.', 'warn');
                socket.destroy();
                this.scheduleReconnect();
                return;
            }
            this.attachSocket(socket);
            if (head && head.length) {
                this.onData(head);
            }
            this.attempts = 0;
            this.sendHello();
            this.sendStatus();
            this.startPing();
            this.log('已连接桌面程序 OI Helper.');
        });

        request.on('response', (response: http.IncomingMessage) => {
            this.log(`WebSocket 握手被拒绝: HTTP ${response.statusCode || 0}.`, 'warn');
            response.resume();
            this.handshake = null;
            this.scheduleReconnect();
        });

        request.on('timeout', () => {
            request.destroy(new Error('连接超时'));
        });

        request.on('error', (err: Error) => {
            this.handshake = null;
            if (!upgraded) {
                this.log(`连接桌面程序失败: ${err.message}`, 'warn');
                this.scheduleReconnect();
            }
        });

        request.end();
    }

    private attachSocket(socket: Socket): void {
        this.socket = socket;
        this.buffer = Buffer.alloc(0);
        this.fragments = [];
        socket.setNoDelay(true);
        socket.on('data', (chunk: Buffer) => this.onData(chunk));
        socket.on('error', (err: Error) => {
            if (!this.stopped) {
                this.log(`WebSocket 连接异常: ${err.message}`, 'warn');
            }
        });
        socket.on('close', () => {
            if (this.socket === socket) {
                this.socket = null;
            }
            this.clearPing();
            if (!this.stopped) {
                this.sendStatus();
                this.scheduleReconnect();
            }
        });
    }

    private scheduleReconnect(): void {
        if (this.stopped || this.reconnectTimer) {
            return;
        }
        const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, this.attempts));
        this.attempts += 1;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, delay);
        if (typeof this.reconnectTimer.unref === 'function') {
            this.reconnectTimer.unref();
        }
    }

    private clearReconnect(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    private startPing(): void {
        this.clearPing();
        this.pingTimer = setInterval(() => {
            if (this.socket && !this.socket.destroyed) {
                try {
                    this.writeFrame(this.socket, 0x9, Buffer.from('oih'));
                } catch {
                    this.socket.destroy();
                }
            }
        }, PING_INTERVAL_MS);
        if (typeof this.pingTimer.unref === 'function') {
            this.pingTimer.unref();
        }
    }

    private clearPing(): void {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
    }

    private sendHello(): void {
        let workspacePaths: string[] = [];
        if (this.options.getWorkspacePaths) {
            try {
                workspacePaths = this.options.getWorkspacePaths() || [];
            } catch {
                workspacePaths = [];
            }
        }
        this.sendJson({
            type: 'hello',
            token: this.token,
            payload: {
                version: this.options.extensionVersion,
                workspacePath: this.workspacePath(),
                workspacePaths,
                platform: process.platform
            }
        });
    }

    private sendStatus(): void {
        if (!this.socket || this.socket.destroyed) {
            return;
        }
        const workspacePath = this.workspacePath();
        this.sendJson({
            type: 'status',
            token: this.token,
            payload: {
                workspacePath,
                version: this.options.extensionVersion,
                server: this.resolveServer(workspacePath),
                connection: 'connected',
                updatedAt: new Date().toISOString()
            }
        });
    }

    private resolveServer(workspacePath: string): string {
        if (!workspacePath) {
            return '';
        }
        try {
            const raw = JSON.parse(fs.readFileSync(path.join(workspacePath, '.oihelper', 'workspace.json'), 'utf8'));
            const server = raw.server !== undefined ? raw.server : (raw.serverAddress || raw.serverUrl);
            if (typeof server === 'string') {
                return server.trim();
            }
            if (server && typeof server === 'object') {
                if (server.url) {
                    return String(server.url);
                }
                if (server.address) {
                    return String(server.address);
                }
                if (server.host) {
                    return `${server.host}${server.port ? `:${server.port}` : ''}`;
                }
            }
        } catch {
            // 工作区元数据不存在或损坏时不上报服务器连接
        }
        return '';
    }

    private notifyCredentialsChanged(): void {
        if (!this.socket || this.socket.destroyed) {
            return;
        }
        this.sendJson({
            type: 'credentialsChanged',
            token: this.token,
            payload: {
                workspacePath: this.workspacePath(),
                changedAt: new Date().toISOString()
            }
        });
        this.log('已上报工作区凭据变化.');
    }

    private watchCredentials(): void {
        const workspacePath = this.workspacePath();
        const file = workspacePath ? path.join(workspacePath, '.oihelper', 'credentials.json') : '';
        if (file === this.credentialsFile) {
            return;
        }
        this.unwatchCredentials();
        if (!file) {
            return;
        }
        this.credentialsFile = file;
        // fs.watchFile 轮询文件时间戳, 文件创建/修改都会触发
        fs.watchFile(file, { interval: 1500 }, (current, previous) => {
            if (current.mtimeMs !== previous.mtimeMs || current.size !== previous.size) {
                this.notifyCredentialsChanged();
            }
        });
    }

    private unwatchCredentials(): void {
        if (!this.credentialsFile) {
            return;
        }
        fs.unwatchFile(this.credentialsFile);
        this.credentialsFile = '';
    }

    private onData(chunk: Buffer): void {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        while (this.buffer.length >= 2) {
            const first = this.buffer[0];
            const second = this.buffer[1];
            const fin = (first & 0x80) !== 0;
            const opcode = first & 0x0f;
            const masked = (second & 0x80) !== 0;
            let length = second & 0x7f;
            let offset = 2;
            if (length === 126) {
                if (this.buffer.length < 4) {
                    return;
                }
                length = this.buffer.readUInt16BE(2);
                offset = 4;
            } else if (length === 127) {
                if (this.buffer.length < 10) {
                    return;
                }
                const large = this.buffer.readBigUInt64BE(2);
                if (large > BigInt(MAX_FRAME_BYTES)) {
                    this.dropConnection('帧过大');
                    return;
                }
                length = Number(large);
                offset = 10;
            }
            const maskLength = masked ? 4 : 0;
            if (this.buffer.length < offset + maskLength + length) {
                return;
            }
            let payload = this.buffer.subarray(offset + maskLength, offset + maskLength + length);
            if (masked) {
                const mask = this.buffer.subarray(offset, offset + 4);
                const unmasked = Buffer.alloc(payload.length);
                for (let i = 0; i < payload.length; i += 1) {
                    unmasked[i] = payload[i] ^ mask[i % 4];
                }
                payload = unmasked;
            } else {
                payload = Buffer.from(payload);
            }
            this.buffer = this.buffer.subarray(offset + maskLength + length);
            this.handleFrame(fin, opcode, payload);
        }
    }

    private handleFrame(fin: boolean, opcode: number, payload: Buffer): void {
        if (opcode === 0x8) {
            const socket = this.socket;
            if (socket && !socket.destroyed) {
                try {
                    this.writeFrame(socket, 0x8, payload.subarray(0, 2));
                } catch {
                    // 关闭帧失败时忽略
                }
                socket.end();
            }
            return;
        }
        if (opcode === 0x9) {
            if (this.socket && !this.socket.destroyed) {
                try {
                    this.writeFrame(this.socket, 0xa, payload);
                } catch {
                    this.socket.destroy();
                }
            }
            return;
        }
        if (opcode === 0xa) {
            return;
        }
        if (opcode === 0x1 || opcode === 0x0 || opcode === 0x2) {
            this.fragments.push(payload);
            if (!fin) {
                return;
            }
            const full = Buffer.concat(this.fragments);
            this.fragments = [];
            if (opcode === 0x2) {
                return;
            }
            this.handleText(full.toString('utf8'));
        }
    }

    private handleText(text: string): void {
        let message: { type?: string; payload?: Record<string, unknown> };
        try {
            message = JSON.parse(text);
        } catch {
            this.log('收到无法解析的 WebSocket 消息.', 'warn');
            return;
        }
        const type = String(message.type || '');
        const payload = (message.payload && typeof message.payload === 'object' ? message.payload : {}) as Record<string, unknown>;
        if (type === 'ping') {
            this.sendJson({ type: 'pong', token: this.token, payload: { time: Date.now() } });
            return;
        }
        if (type === 'pong') {
            return;
        }
        if (type === 'helloAck') {
            this.log('桌面程序已确认 hello.');
            return;
        }
        if (type === 'result' || type === 'error') {
            if (type === 'error') {
                const error = payload.error as { message?: string } | undefined;
                this.log(`桌面程序返回错误: ${error && error.message ? error.message : '未知错误'}`, 'warn');
            }
            return;
        }
        if (type === 'openWorkspace') {
            void this.handleOpenWorkspace(payload);
            return;
        }
        if (type === 'createWorkspace') {
            void this.handleCreateWorkspace(payload);
            return;
        }
        if (type === 'syncRequest') {
            void this.handleSyncRequest(payload);
            return;
        }
        if (type === 'event') {
            this.handleEvent(payload);
        }
    }

    private handleEvent(payload: Record<string, unknown>): void {
        const event = payload as OihEvent;
        const title = String((event.payload && event.payload.title) || event.type || '未知');
        this.log(`收到比赛事件: ${title}`);
        if (this.options.onEvent) {
            try {
                this.options.onEvent(event);
            } catch (err) {
                this.log(`处理比赛事件失败: ${String(err)}`, 'warn');
            }
        }
    }

    private async handleOpenWorkspace(payload: Record<string, unknown>): Promise<void> {
        const target = String(payload.path || payload.workspacePath || '').trim();
        if (!target) {
            this.sendReceipt('openWorkspace', false, { error: '缺少工作区路径.' });
            return;
        }
        try {
            await this.options.onOpenWorkspace(target);
            this.sendReceipt('openWorkspace', true, { path: target });
            this.log(`已打开工作区: ${target}`);
        } catch (err) {
            this.sendReceipt('openWorkspace', false, { error: String(err) });
            this.log(`打开工作区失败: ${String(err)}`, 'warn');
        }
    }

    private async handleCreateWorkspace(payload: Record<string, unknown>): Promise<void> {
        const target = String(payload.path || payload.workspacePath || '').trim();
        if (!target) {
            this.sendReceipt('createWorkspace', false, { error: '缺少工作区路径.' });
            return;
        }
        try {
            const result = await this.options.onCreateWorkspace(target);
            this.sendReceipt('createWorkspace', result.ok, { message: result.message, path: target });
            if (result.ok) {
                this.notifyWorkspaceChanged();
            }
        } catch (err) {
            this.sendReceipt('createWorkspace', false, { error: String(err) });
        }
    }

    private async handleSyncRequest(payload: Record<string, unknown>): Promise<void> {
        const workspace = String(payload.workspace || payload.path || this.workspacePath()).trim();
        if (!workspace) {
            this.sendReceipt('syncRequest', false, { pending: true, message: '未打开工作区, 已记为待办.' });
            return;
        }
        if (!this.agent || !this.agent.apiPort) {
            this.sendReceipt('syncRequest', false, { pending: true, message: '桌面 API 未启动, 已记为待办.' });
            return;
        }
        try {
            const response = await this.postApi('/api/sync/push', { workspace, confirm: true });
            if (response.status >= 200 && response.status < 300) {
                this.sendReceipt('syncRequest', true, { pending: false, message: '同步完成.' });
            } else {
                this.sendReceipt('syncRequest', false, {
                    pending: true,
                    message: `同步待办: HTTP ${response.status} ${response.body.slice(0, 200)}`
                });
            }
        } catch (err) {
            this.sendReceipt('syncRequest', false, { pending: true, message: `同步待办: ${String(err)}` });
        }
    }

    private postApi(apiPath: string, body: unknown): Promise<{ status: number; body: string }> {
        return new Promise((resolve, reject) => {
            if (!this.agent) {
                reject(new Error('缺少桌面程序信息.'));
                return;
            }
            const data = Buffer.from(JSON.stringify(body));
            const request = http.request({
                host: '127.0.0.1',
                port: this.agent.apiPort,
                path: apiPath,
                method: 'POST',
                timeout: 3000,
                headers: {
                    'content-type': 'application/json',
                    'content-length': data.length,
                    'x-oih-token': this.token
                }
            }, (response) => {
                const chunks: Buffer[] = [];
                response.on('data', (chunk: Buffer) => chunks.push(chunk));
                response.on('end', () => resolve({
                    status: response.statusCode || 0,
                    body: Buffer.concat(chunks).toString('utf8')
                }));
            });
            request.on('timeout', () => request.destroy(new Error('请求超时')));
            request.on('error', reject);
            request.end(data);
        });
    }

    private sendReceipt(request: string, ok: boolean, data: Record<string, unknown>): void {
        this.sendJson({
            type: 'result',
            token: this.token,
            payload: { ok, request, data }
        });
    }

    private sendJson(message: unknown): void {
        if (!this.socket || this.socket.destroyed) {
            return;
        }
        const payload = Buffer.from(JSON.stringify(message), 'utf8');
        if (payload.length > MAX_FRAME_BYTES) {
            return;
        }
        this.writeFrame(this.socket, 0x1, payload);
    }

    private writeFrame(socket: Socket, opcode: number, payload: Buffer): void {
        const mask = crypto.randomBytes(4);
        const length = payload.length;
        let header: Buffer;
        if (length < 126) {
            header = Buffer.alloc(2);
            header[0] = 0x80 | opcode;
            header[1] = 0x80 | length;
        } else if (length < 65536) {
            header = Buffer.alloc(4);
            header[0] = 0x80 | opcode;
            header[1] = 0x80 | 126;
            header.writeUInt16BE(length, 2);
        } else {
            header = Buffer.alloc(10);
            header[0] = 0x80 | opcode;
            header[1] = 0x80 | 127;
            header.writeBigUInt64BE(BigInt(length), 2);
        }
        const masked = Buffer.alloc(length);
        for (let i = 0; i < length; i += 1) {
            masked[i] = payload[i] ^ mask[i % 4];
        }
        socket.write(Buffer.concat([header, mask, masked]));
    }

    private dropConnection(reason: string): void {
        this.log(`WebSocket 连接已丢弃: ${reason}`, 'warn');
        const socket = this.socket;
        this.socket = null;
        if (socket && !socket.destroyed) {
            socket.destroy();
        }
        this.scheduleReconnect();
    }
}
