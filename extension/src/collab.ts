import * as http from 'http';
import * as crypto from 'crypto';
import { AddressInfo } from 'net';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// 协作消息
interface CollabMessage {
    type: string;
    room?: string;
    name?: string;
    text?: string;
    file?: string;
    content?: string;
    lang?: string;
    line?: number;
    at?: number;
    peers?: number;
}

// 连接包装: 负责帧收发
class Peer {
    readonly id: string;

    room = '';

    name = '';

    alive = true;

    constructor(private readonly socket: any) {
        this.id = crypto.randomBytes(4).toString('hex');
    }

    send(message: CollabMessage): void {
        if (!this.alive) {
            return;
        }
        try {
            this.socket.write(encodeFrame(JSON.stringify(message)));
        } catch {
            this.alive = false;
        }
    }

    close(): void {
        this.alive = false;
        try {
            this.socket.end();
        } catch { /* 已关闭 */ }
    }

    // 处理一个完整文本帧
    handleText(text: string, server: CollabServer): void {
        let message: CollabMessage;
        try {
            message = JSON.parse(text);
        } catch {
            return;
        }
        if (!message || typeof message.type !== 'string') {
            return;
        }
        server.dispatch(this, message);
    }
}

// 编码服务端文本帧(不掩码)
function encodeFrame(text: string): Buffer {
    const payload = Buffer.from(text, 'utf8');
    const len = payload.length;
    let header: Buffer;
    if (len < 126) {
        header = Buffer.alloc(2);
        header[1] = len;
    } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[1] = 126;
        header.writeUInt16BE(len, 2);
    } else {
        header = Buffer.alloc(10);
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x81;
    return Buffer.concat([header, payload]);
}

// 解码客户端帧; 返回文本与剩余缓冲
function decodeFrame(buffer: Buffer): { text?: string; rest: Buffer; opcode: number } | undefined {
    if (buffer.length < 2) {
        return undefined;
    }
    const opcode = buffer[0] & 0x0f;
    const masked = (buffer[1] & 0x80) !== 0;
    let len = buffer[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
        if (buffer.length < 4) {
            return undefined;
        }
        len = buffer.readUInt16BE(2);
        offset = 4;
    } else if (len === 127) {
        if (buffer.length < 10) {
            return undefined;
        }
        len = Number(buffer.readBigUInt64BE(2));
        offset = 10;
    }
    const maskLen = masked ? 4 : 0;
    if (buffer.length < offset + maskLen + len) {
        return undefined;
    }
    const mask = masked ? buffer.subarray(offset, offset + 4) : undefined;
    const start = offset + maskLen;
    const payload = Buffer.from(buffer.subarray(start, start + len));
    if (mask) {
        for (let i = 0; i < payload.length; i += 1) {
            payload[i] ^= mask[i % 4];
        }
    }
    return {
        text: opcode === 0x1 ? payload.toString('utf8') : undefined,
        opcode,
        rest: buffer.subarray(start + len)
    };
}

// 协作中继: 一人开房, 其他人按地址加入
export class CollabServer {
    private server: http.Server | undefined;

    private peers: Set<Peer> = new Set();

    port = 0;

    error = '';

    // 启动监听; 端口 0 表示随机可用端口
    start(port: number): Promise<number> {
        return new Promise((resolve, reject) => {
            this.stop();
            const server = http.createServer((req, res) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, peers: this.peers.size }));
            });
            this.server = server;
            server.on('upgrade', (req: any, socket: any) => {
                const key = req.headers['sec-websocket-key'];
                if (!key) {
                    socket.destroy();
                    return;
                }
                const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
                socket.write('HTTP/1.1 101 Switching Protocols\r\n'
                    + 'Upgrade: websocket\r\n'
                    + 'Connection: Upgrade\r\n'
                    + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
                socket.setNoDelay(true);
                const peer = new Peer(socket);
                this.peers.add(peer);
                let buffer: any = Buffer.alloc(0);
                socket.on('data', (chunk: Buffer) => {
                    buffer = Buffer.concat([buffer, chunk]);
                    for (;;) {
                        const frame = decodeFrame(buffer);
                        if (!frame) {
                            break;
                        }
                        buffer = frame.rest;
                        if (frame.opcode === 0x8) {
                            peer.close();
                            break;
                        }
                        if (frame.opcode === 0x9) {
                            try {
                                socket.write(Buffer.from([0x8a, 0x00]));
                            } catch { /* 忽略 */ }
                            continue;
                        }
                        if (frame.text !== undefined && frame.text !== '') {
                            peer.handleText(frame.text, this);
                        }
                    }
                });
                socket.on('close', () => this.remove(peer));
                socket.on('error', () => this.remove(peer));
            });
            server.on('error', (err) => {
                this.error = String(err);
                reject(err);
            });
            server.listen(port, '0.0.0.0', () => {
                this.port = (server.address() as AddressInfo).port;
                resolve(this.port);
            });
        });
    }

    stop(): void {
        for (const peer of this.peers) {
            peer.close();
        }
        this.peers.clear();
        if (this.server) {
            this.server.close();
            this.server = undefined;
        }
    }

    // 消息分发: 加入/聊天/代码/光标
    dispatch(peer: Peer, message: CollabMessage): void {
        if (message.type === 'join') {
            peer.room = String(message.room ?? 'default');
            peer.name = String(message.name ?? '队友');
            this.broadcast(peer, {
                type: 'presence',
                text: `${peer.name} 加入了房间`,
                name: peer.name,
                peers: this.roomSize(peer.room)
            });
            peer.send({ type: 'joined', room: peer.room, name: peer.name, peers: this.roomSize(peer.room) });
            return;
        }
        if (!peer.room) {
            return;
        }
        if (message.type === 'chat') {
            this.broadcast(peer, {
                type: 'chat',
                name: peer.name,
                text: String(message.text ?? ''),
                at: Date.now()
            });
            return;
        }
        if (message.type === 'code') {
            this.broadcast(peer, {
                type: 'code',
                name: peer.name,
                file: String(message.file ?? ''),
                lang: String(message.lang ?? ''),
                content: String(message.content ?? ''),
                at: Date.now()
            });
            return;
        }
        if (message.type === 'cursor') {
            this.broadcast(peer, {
                type: 'cursor',
                name: peer.name,
                file: String(message.file ?? ''),
                line: Number(message.line) || 1
            });
        }
    }

    // 发给同房间其他成员
    private broadcast(from: Peer, message: CollabMessage): void {
        for (const peer of this.peers) {
            if (peer !== from && peer.alive && peer.room === from.room) {
                peer.send(message);
            }
        }
    }

    private roomSize(room: string): number {
        let count = 0;
        for (const peer of this.peers) {
            if (peer.room === room && peer.alive) {
                count += 1;
            }
        }
        return count;
    }

    private remove(peer: Peer): void {
        if (!this.peers.delete(peer)) {
            return;
        }
        peer.alive = false;
        if (peer.room) {
            this.broadcast(peer, {
                type: 'presence',
                text: `${peer.name} 离开了房间`,
                name: peer.name,
                peers: this.roomSize(peer.room)
            });
        }
    }
}
