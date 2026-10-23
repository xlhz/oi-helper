'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { DISPLAY_VERSION, BUILD } = require('./version');

// 与 mcp/src/server.js 的 TOOLS 保持一致, 用于界面展示与握手校验
const MCP_TOOLS = [
    'judge_problem',
    'judge_file',
    'judge_version',
    'fetch_problem',
    'fetch_original',
    'fetch_contest',
    'fetch_extra',
    'submit_solution',
    'submit_original',
    'query_submission'
];

class McpHost {
    constructor(options = {}) {
        this.rootDir = options.rootDir;
        this.onLog = typeof options.onLog === 'function' ? options.onLog : () => {};
        this.child = null;
        this.pid = 0;
        this.tools = [];
        this.startedAt = null;
        this.error = '';
        this.enabled = false;
        this.buffer = '';
        this.stderr = '';
        this.nextId = 0;
        this.pending = new Map();
    }

    log(level, message) {
        this.onLog({ source: 'mcp', level, message });
    }

    scriptPath() {
        return path.join(this.rootDir, 'mcp', 'src', 'server.js');
    }

    async start() {
        this.enabled = true;
        if (this.child) {
            return this.getState();
        }
        const script = this.scriptPath();
        if (!fs.existsSync(script)) {
            this.error = `未找到 MCP 入口: ${script}`;
            this.enabled = false;
            throw new Error(this.error);
        }
        this.log('info', '正在托管 MCP 服务 (stdio)...');
        this.stderr = '';
        this.tools = [];
        this.buffer = '';
        const child = spawn(process.execPath, [script], {
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe']
        });
        this.child = child;
        this.pid = child.pid;
        child.stdout.on('data', (chunk) => this.onStdout(chunk));
        child.stderr.on('data', (chunk) => {
            this.stderr += chunk.toString();
        });
        child.on('error', (err) => {
            this.error = `无法启动 MCP: ${err.message}`;
            this.log('error', this.error);
        });
        child.on('exit', (code) => {
            const wasRunning = Boolean(this.child);
            this.child = null;
            this.pid = 0;
            this.startedAt = null;
            if (wasRunning) {
                this.log('warn', `MCP 进程已退出 (code ${code}).${this.stderr ? ` ${this.stderr.trim().slice(0, 300)}` : ''}`);
            }
        });
        try {
            await this.handshake();
            this.startedAt = new Date().toISOString();
            this.error = '';
            this.log('info', `MCP 已启动: pid ${this.pid}, ${this.tools.length} 个工具.`);
        } catch (err) {
            this.error = err.message;
            this.log('error', `MCP 启动失败: ${err.message}`);
            this.stop();
            throw err;
        }
        return this.getState();
    }

    request(method, params, timeoutMs = 12000) {
        const id = this.nextId + 1;
        this.nextId = id;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`MCP 握手超时: ${method}`));
            }, timeoutMs);
            this.pending.set(id, {
                resolve: (value) => {
                    clearTimeout(timer);
                    resolve(value);
                },
                reject: (err) => {
                    clearTimeout(timer);
                    reject(err);
                }
            });
            this.write({ jsonrpc: '2.0', id, method, params });
        });
    }

    write(message) {
        if (!this.child || !this.child.stdin.writable) {
            throw new Error('MCP 进程未运行.');
        }
        this.child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    onStdout(chunk) {
        this.buffer += chunk.toString();
        for (;;) {
            const index = this.buffer.indexOf('\n');
            if (index < 0) {
                return;
            }
            const line = this.buffer.slice(0, index).trim();
            this.buffer = this.buffer.slice(index + 1);
            if (!line) {
                continue;
            }
            let msg;
            try {
                msg = JSON.parse(line);
            } catch {
                continue;
            }
            if (msg.id === undefined || !this.pending.has(msg.id)) {
                continue;
            }
            const waiter = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (msg.error) {
                waiter.reject(new Error(msg.error.message || 'MCP 返回错误.'));
            } else {
                waiter.resolve(msg.result);
            }
        }
    }

    async handshake() {
        await this.request('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'oi-helper-desktop', version: DISPLAY_VERSION }
        });
        this.write({ jsonrpc: '2.0', method: 'notifications/initialized' });
        const result = await this.request('tools/list', {});
        const names = Array.isArray(result && result.tools) ? result.tools.map((tool) => tool.name) : [];
        this.tools = names;
        if (names.length !== MCP_TOOLS.length) {
            this.log('warn', `MCP 工具数量为 ${names.length}, 期望 ${MCP_TOOLS.length}.`);
        }
    }

    stop() {
        this.enabled = false;
        const child = this.child;
        this.child = null;
        this.pid = 0;
        this.startedAt = null;
        if (child) {
            try {
                child.stdin.end();
            } catch {
                // 忽略
            }
            try {
                child.kill();
            } catch {
                // 忽略
            }
            this.log('info', 'MCP 服务已停止.');
        }
        return this.getState();
    }

    setEnabled(enabled) {
        this.enabled = Boolean(enabled);
    }

    getState() {
        return {
            enabled: this.enabled,
            running: Boolean(this.child),
            pid: this.pid,
            transport: 'stdio',
            version: DISPLAY_VERSION,
            build: BUILD,
            tools: this.tools.length ? this.tools : MCP_TOOLS,
            startedAt: this.startedAt,
            error: this.error
        };
    }
}

module.exports = { McpHost, MCP_TOOLS };
