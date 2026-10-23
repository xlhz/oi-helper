#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { DISPLAY_VERSION, BUILD } = require('../src/version');

const USAGE = [
    'oih server list',
    'oih sync push --workspace <dir> --yes',
    'oih judge run --problem <dir>',
    'oih judge run --src <cpp> --in <input> --out <expected>'
];

function agentFile() {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'OIHelper', 'agent.json');
}

function envelope(ok, data, error) {
    return {
        ok,
        identity: { name: 'oih', client: 'cli', version: DISPLAY_VERSION, build: BUILD },
        data: data === undefined ? null : data,
        error: error || null
    };
}

function exitWith(ok, data, error, code) {
    process.stdout.write(`${JSON.stringify(envelope(ok, data, error), null, 2)}\n`);
    process.exitCode = ok ? 0 : (code || 1);
}

function parseFlags(args) {
    const flags = { _: [] };
    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg.startsWith('--')) {
            const key = arg.slice(2);
            const next = args[i + 1];
            if (next === undefined || next.startsWith('--')) {
                flags[key] = true;
            } else {
                flags[key] = next;
                i += 1;
            }
        } else {
            flags._.push(arg);
        }
    }
    return flags;
}

function loadAgent() {
    let text;
    try {
        text = fs.readFileSync(agentFile(), 'utf8');
    } catch {
        const err = new Error('未找到发现文件 %APPDATA%/OIHelper/agent.json, 请先启动 OI Helper 桌面程序.');
        err.code = 'discovery_missing';
        return { error: err };
    }
    let agent;
    try {
        agent = JSON.parse(text);
    } catch {
        const err = new Error('发现文件不是合法 JSON, 请重启桌面程序.');
        err.code = 'discovery_invalid';
        return { error: err };
    }
    if (!agent.token || !agent.apiPort) {
        const err = new Error('发现文件缺少 token/apiPort, 请在「接口」中开启 API 后重启程序.');
        err.code = 'discovery_incomplete';
        return { error: err };
    }
    return { agent };
}

function callApi(agent, method, pathname, body, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? '' : JSON.stringify(body);
        const headers = { 'x-oih-token': agent.token };
        if (payload) {
            headers['content-type'] = 'application/json';
            headers['content-length'] = Buffer.byteLength(payload);
        }
        const req = http.request({
            host: '127.0.0.1',
            port: agent.apiPort,
            path: pathname,
            method,
            headers,
            timeout: timeoutMs
        }, (res) => {
            let text = '';
            res.on('data', (chunk) => { text += chunk.toString(); });
            res.on('end', () => {
                let parsed;
                try {
                    parsed = JSON.parse(text);
                } catch {
                    const err = new Error(`接口返回非 JSON (HTTP ${res.statusCode}).`);
                    err.code = 'bad_response';
                    reject(err);
                    return;
                }
                if (res.statusCode >= 400 || (parsed && parsed.ok === false)) {
                    const detail = parsed && parsed.error ? parsed.error : {};
                    const err = new Error(detail.message || `HTTP ${res.statusCode}`);
                    err.code = detail.code || `http_${res.statusCode}`;
                    reject(err);
                    return;
                }
                resolve(parsed && parsed.data !== undefined ? parsed.data : parsed);
            });
        });
        req.on('timeout', () => {
            const err = new Error('请求超时, 请检查桌面程序是否响应.');
            err.code = 'timeout';
            req.destroy(err);
        });
        req.on('error', (cause) => {
            if (cause && cause.code === 'timeout') {
                reject(cause);
                return;
            }
            const err = new Error(`无法连接程序 API (127.0.0.1:${agent.apiPort}), 请确认程序已启动且 API 已开启. (${cause.message})`);
            err.code = 'api_unavailable';
            reject(err);
        });
        if (payload) {
            req.write(payload);
        }
        req.end();
    });
}

async function run(argv) {
    const flags = parseFlags(argv);
    const command = flags._[0];
    const sub = flags._[1];
    if (!command || flags.help) {
        exitWith(true, { usage: USAGE });
        return;
    }
    const loaded = loadAgent();
    if (loaded.error) {
        exitWith(false, null, { code: loaded.error.code, message: loaded.error.message });
        return;
    }
    const agent = loaded.agent;

    if (command === 'server' && sub === 'list') {
        const servers = await callApi(agent, 'GET', '/api/servers');
        exitWith(true, servers);
        return;
    }

    if (command === 'sync' && sub === 'push') {
        if (flags.yes !== true) {
            exitWith(false, null, {
                code: 'confirmation_required',
                message: '覆盖同步属于写操作, 需要 --yes 显式确认.'
            }, 2);
            return;
        }
        const workspace = typeof flags.workspace === 'string' ? flags.workspace : '';
        if (!workspace) {
            exitWith(false, null, { code: 'bad_request', message: '缺少 --workspace <目录>.' }, 2);
            return;
        }
        const data = await callApi(agent, 'POST', '/api/sync/push', { workspace, confirm: true });
        exitWith(true, data);
        return;
    }

    if (command === 'judge' && sub === 'run') {
        const body = {
            problemDir: typeof flags.problem === 'string' ? flags.problem : undefined,
            src: typeof flags.src === 'string' ? flags.src : undefined,
            input: typeof flags.in === 'string' ? flags.in : undefined,
            expected: typeof flags.out === 'string' ? flags.out : undefined,
            timeLimit: flags.time,
            memoryLimit: flags.memory
        };
        const data = await callApi(agent, 'POST', '/api/judge/run', body);
        exitWith(true, data);
        return;
    }

    exitWith(false, null, {
        code: 'unknown_command',
        message: `未知命令: ${[command, sub].filter(Boolean).join(' ')}`
    }, 2);
}

run(process.argv.slice(2)).catch((err) => {
    exitWith(false, null, { code: err.code || 'error', message: err.message });
});
