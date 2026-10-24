'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, dialog, Notification } = require('electron');
const { DISPLAY_VERSION, BUILD } = require('./version');
const { TRAY_ICON_DATA_URL } = require('./icon');
const { Oihd, defaultDataDir } = require('./oihd');
const { scanWorkspaces, normalizeInstanceAddress, createWorkspaceStructure } = require('./oih-scan');
const { SyncEngine } = require('./sync');
const { WsService } = require('./ws');
const { ApiService, resolveJudgePath } = require('./api');
const { LanService } = require('./lan');
const { EventService } = require('./events');
const { McpHost } = require('./mcp-host');
const { FloatWindowManager } = require('./float');
const { maskSecret, maskText } = require('./util');

const repoRoot = path.resolve(__dirname, '..', '..');
const cliPath = path.join(__dirname, '..', 'bin', 'oih.js');

let mainWindow = null;
let tray = null;
let isQuitting = false;
let oihd = null;
let syncEngine = null;
let wsService = null;
let apiService = null;
let lanService = null;
let eventService = null;
let mcpHost = null;
let floatManager = null;

const logs = [];

function log(entry) {
    const item = {
        ts: Date.now(),
        source: entry.source || 'app',
        level: entry.level || 'info',
        message: maskText(entry.message || '')
    };
    logs.push(item);
    if (logs.length > 500) {
        logs.shift();
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('oih:log', item);
    }
}

function readProblemJson(dir) {
    const file = path.join(dir, 'problem.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') {
        throw new Error('problem.json 内容无效.');
    }
    return parsed;
}

// 悬浮窗与主界面共用 ApiService.judgeRun, 只按勾选裁剪 problem.json 后交给 oi-judge
async function judgeProblem(payload) {
    if (!apiService) {
        throw new Error('评测服务未就绪.');
    }
    const problemDir = path.resolve(String(payload && payload.problemDir || '').trim());
    const problem = readProblemJson(problemDir);
    const allIds = Array.isArray(problem.tests) ? problem.tests.map((item) => Number(item.id)) : [];
    const requested = Array.isArray(payload && payload.tests) && payload.tests.length
        ? payload.tests.map(Number)
        : allIds;
    const selected = allIds.filter((id) => requested.includes(id));
    if (requested.length && !selected.length) {
        throw new Error('没有可评测的测试点, 请检查勾选.');
    }
    let targetDir = problemDir;
    let tempDir = '';
    if (allIds.length && selected.length && selected.length < allIds.length) {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oih-float-judge-'));
        targetDir = path.join(tempDir, 'problem');
        fs.cpSync(problemDir, targetDir, { recursive: true });
        const subset = {
            ...problem,
            tests: problem.tests.filter((item) => selected.includes(Number(item.id)))
        };
        if (Array.isArray(problem.subtasks)) {
            const subtasks = problem.subtasks
                .map((item) => ({ ...item, tests: (item.tests || []).map(Number).filter((id) => selected.includes(id)) }))
                .filter((item) => item.tests.length);
            if (subtasks.length) {
                subset.subtasks = subtasks;
            } else {
                delete subset.subtasks;
            }
        }
        fs.writeFileSync(path.join(targetDir, 'problem.json'), JSON.stringify(subset, null, 4));
    }
    try {
        const result = await apiService.judgeRun({ problemDir: targetDir });
        const summary = {
            ts: new Date().toISOString(),
            problemDir,
            problem: result.problem,
            status: result.status,
            totalScore: result.totalScore,
            maxScore: result.maxScore,
            tests: (result.tests || []).map((item) => ({
                id: item.id,
                status: item.status,
                score: item.score,
                maxScore: item.maxScore,
                timeMs: item.timeMs,
                memoryKb: item.memoryKb,
                message: item.message
            }))
        };
        const judgeState = oihd.getJudgeState();
        oihd.setJudgeState({
            lastRun: summary,
            history: [...(judgeState.history || []), summary].slice(-50)
        });
        log({ source: 'judge', level: 'info', message: `悬浮窗评测 ${summary.problem}: ${summary.status} ${summary.totalScore}/${summary.maxScore}.` });
        return { ...result, problemDir, selectedTests: selected };
    } catch (err) {
        log({ source: 'judge', level: 'error', message: `悬浮窗评测失败: ${err.message}` });
        throw err;
    } finally {
        if (tempDir) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    }
}

function currentInterface() {
    const settings = oihd.getSettings();
    return settings.interface;
}

function rendererToast(title, body) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('oih:notification', { title, body, ts: Date.now() });
    }
}

// 托盘通知: 系统通知不可用或未确认弹出时回退到窗口内 toast
function showEventNotification(event) {
    const payload = event.payload || {};
    const title = payload.title || '比赛事件';
    const body = [payload.contest, payload.problem, payload.user].filter(Boolean).join(' · ') || '收到新的比赛事件.';
    let settled = false;
    const fallback = (reason) => {
        if (settled) {
            return;
        }
        settled = true;
        log({ source: 'event', level: 'warn', message: `系统通知不可用 (${reason}), 已回退到窗口内提示: ${title}` });
        console.log(`[notification fallback] ${reason}: ${title}`);
        rendererToast(title, body);
    };
    if (!Notification.isSupported()) {
        fallback('当前系统不支持通知');
        return;
    }
    try {
        const note = new Notification({ title, body });
        note.on('show', () => {
            if (settled) {
                return;
            }
            settled = true;
            log({ source: 'event', level: 'info', message: `通知已弹出: ${title}` });
            console.log(`[notification shown] ${title}`);
        });
        note.on('failed', (_event, error) => fallback(error ? String(error) : '未知原因'));
        note.on('click', showMainWindow);
        note.show();
        setTimeout(() => fallback('等待系统确认超时'), 2500);
    } catch (err) {
        fallback(err.message);
    }
}

function handleNotifiedEvent(event) {
    if (wsService) {
        wsService.broadcast('event', event);
    }
    showEventNotification(event);
}

function handleRecordedEvent(event) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('oih:event', event);
    }
}

function buildStatus() {
    const api = apiService ? apiService.snapshot() : { enabled: false, host: '127.0.0.1', port: 0, running: false, baseUrl: '' };
    const mcp = mcpHost ? mcpHost.getState() : { enabled: false, running: false, tools: [] };
    return {
        version: DISPLAY_VERSION,
        build: BUILD,
        dataDir: oihd ? oihd.dir : '',
        ws: {
            port: wsService ? wsService.port : 0,
            clients: wsService ? wsService.getClients().length : 0,
            token: wsService ? maskSecret(wsService.token) : ''
        },
        api,
        lan: lanService ? lanService.snapshot() : {
            enabled: false,
            running: false,
            host: '0.0.0.0',
            port: 0,
            room: 'default',
            retention: false,
            self: '',
            serverAddress: '',
            file: '',
            members: []
        },
        events: eventService ? eventService.list().length : 0,
        mcp,
        cli: {
            path: cliPath
        }
    };
}

function mergeInterface(patch) {
    const base = currentInterface();
    const api = patch.api || {};
    return {
        ...base,
        ...patch,
        api: {
            ...base.api,
            ...api,
            danger: {
                ...base.api.danger,
                ...(api.danger || {})
            }
        },
        mcp: { ...base.mcp, ...(patch.mcp || {}) },
        cli: { ...base.cli, ...(patch.cli || {}) }
    };
}

function httpGetJson(url) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, { timeout: 5000 }, (res) => {
            let text = '';
            res.on('data', (chunk) => { text += chunk.toString(); });
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(text) });
                } catch {
                    resolve({ status: res.statusCode, data: text });
                }
            });
        });
        req.on('timeout', () => req.destroy(new Error('请求超时.')));
        req.on('error', reject);
    });
}

function probeHealth(baseUrl, timeoutMs = 3000) {
    const url = `${String(baseUrl || '').replace(/\/+$/, '')}/health`;
    const client = /^https:/i.test(url) ? https : http;
    return new Promise((resolve) => {
        const req = client.get(url, { timeout: timeoutMs }, (res) => {
            let text = '';
            res.on('data', (chunk) => { text += chunk.toString(); });
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    resolve({ ok: false, url, status: res.statusCode, error: `HTTP ${res.statusCode}` });
                    return;
                }
                let data = null;
                try {
                    data = JSON.parse(text);
                } catch {
                    resolve({ ok: false, url, status: res.statusCode, error: '响应不是 JSON.' });
                    return;
                }
                resolve({ ok: true, url, status: res.statusCode, data });
            });
        });
        req.on('timeout', () => req.destroy(new Error('请求超时.')));
        req.on('error', (err) => resolve({ ok: false, url, error: err.message }));
    });
}

function serverBaseUrl(server) {
    if (!server) {
        return '';
    }
    if (server.type === 'remote') {
        return String(server.url || '');
    }
    const host = /^\d+\.\d+\.\d+\.\d+$/.test(String(server.host || '')) ? server.host : (server.host || '127.0.0.1');
    return `http://${host}:${server.port}`;
}

function displayServerAddress(server) {
    if (!server) {
        return '';
    }
    if (server.type === 'remote') {
        return server.url || '';
    }
    return `${server.host}:${server.port}`;
}

async function startLocalServer(id) {
    const server = oihd.listServers().find((item) => item.id === id);
    if (!server) {
        throw new Error('服务器不存在.');
    }
    if (server.type !== 'local') {
        throw new Error('仅本地服务器支持启动.');
    }
    oihd.setServerState(id, { status: 'running', lastHealth: { ok: false, checkedAt: new Date().toISOString() } });
    const probe = await probeHealth(serverBaseUrl(server));
    const next = oihd.setServerState(id, {
        status: 'running',
        lastHealth: { ok: probe.ok, status: probe.status || 0, checkedAt: new Date().toISOString(), error: probe.ok ? '' : probe.error }
    });
    log({
        source: 'server',
        level: probe.ok ? 'info' : 'warn',
        message: `启动 ${server.name} (${displayServerAddress(server)}): 状态已记录, /health ${probe.ok ? '探测成功' : `探测失败: ${probe.error}`}.`
    });
    return { server: next, probe };
}

function stopLocalServer(id) {
    const server = oihd.listServers().find((item) => item.id === id);
    if (!server) {
        throw new Error('服务器不存在.');
    }
    const next = oihd.setServerState(id, { status: 'stopped', lastHealth: null });
    log({ source: 'server', level: 'info', message: `停止 ${server.name} (${displayServerAddress(server)}): 状态已记录.` });
    return next;
}

async function connectRemoteServer(id) {
    const server = oihd.listServers().find((item) => item.id === id);
    if (!server) {
        throw new Error('服务器不存在.');
    }
    if (server.type !== 'remote') {
        throw new Error('仅远程服务器支持连接.');
    }
    const probe = await probeHealth(serverBaseUrl(server));
    const next = oihd.setServerState(id, {
        connection: probe.ok ? 'connected' : 'disconnected',
        lastHealth: { ok: probe.ok, status: probe.status || 0, checkedAt: new Date().toISOString(), error: probe.ok ? '' : probe.error }
    });
    log({
        source: 'server',
        level: probe.ok ? 'info' : 'warn',
        message: `连接 ${server.name}: ${probe.ok ? '成功' : `失败 (${probe.error})`}.`
    });
    if (!probe.ok) {
        return { server: next, probe, error: `连接失败: ${probe.error}` };
    }
    return { server: next, probe };
}

function disconnectRemoteServer(id) {
    const server = oihd.listServers().find((item) => item.id === id);
    if (!server) {
        throw new Error('服务器不存在.');
    }
    const next = oihd.setServerState(id, { connection: 'disconnected' });
    log({ source: 'server', level: 'info', message: `已断开 ${server.name}.` });
    return next;
}

async function testApi() {
    if (!apiService || !apiService.snapshot().running) {
        const message = 'API 未开启, 请先在「接口 > API」中打开开关.';
        log({ source: 'api', level: 'error', message });
        return { ok: false, error: message };
    }
    const url = `${apiService.snapshot().baseUrl}/health`;
    log({ source: 'api', level: 'info', message: `测试调用 GET ${url}` });
    try {
        const { status, data } = await httpGetJson(url);
        log({ source: 'api', level: status === 200 ? 'info' : 'warn', message: `返回 ${status}: ${JSON.stringify(data)}` });
        return { ok: status === 200, status, data };
    } catch (err) {
        log({ source: 'api', level: 'error', message: `调用失败: ${err.message}` });
        return { ok: false, error: err.message };
    }
}

function testCli(payload) {
    const args = Array.isArray(payload) && payload.length ? payload.map(String) : ['server', 'list'];
    return new Promise((resolve) => {
        log({ source: 'cli', level: 'info', message: `执行 oih ${args.join(' ')}` });
        const child = spawn(process.execPath, [cliPath, ...args], {
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
            windowsHide: true
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
        child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
        child.on('error', (err) => {
            log({ source: 'cli', level: 'error', message: `启动失败: ${err.message}` });
            resolve({ ok: false, code: -1, stdout, stderr: err.message });
        });
        child.on('close', (code) => {
            const text = (stdout || stderr).trim();
            if (text) {
                log({ source: 'cli', level: code === 0 ? 'info' : 'warn', message: text });
            }
            resolve({ ok: code === 0, code, stdout, stderr });
        });
    });
}

async function testMcp() {
    try {
        if (mcpHost && mcpHost.getState().running) {
            mcpHost.stop();
        }
        const state = await mcpHost.start();
        mcpHost.setEnabled(true);
        oihd.patchSettings({ interface: { mcp: { enabled: true } } });
        log({ source: 'mcp', level: 'info', message: `托管正常, 工具: ${state.tools.join(', ')}` });
        return { ok: true, data: state };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

function runAutoSync(reason) {
    if (!syncEngine) {
        return [];
    }
    try {
        const results = syncEngine.autoRunAll();
        const applied = results.reduce((sum, item) => sum + (item.applied || 0), 0);
        const conflicts = results.reduce((sum, item) => sum + (item.conflicts || []).length, 0);
        if (applied || conflicts) {
            log({ source: 'sync', level: conflicts ? 'warn' : 'info', message: `${reason}: 自动同步应用 ${applied} 条, 冲突暂停 ${conflicts} 条.` });
        }
        return results;
    } catch (err) {
        log({ source: 'sync', level: 'error', message: `自动同步失败: ${err.message}` });
        return [];
    }
}

function applyTraySetting(enabled) {
    if (enabled) {
        createTray();
    } else {
        destroyTray();
    }
}

function notifySettingsChanged() {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('oih:settings:changed', oihd.getSettings());
    }
}

// 悬浮窗自身关闭时只同步设置与托盘勾选, 不再回调 setVisible
function persistFloatVisibility(enabled) {
    if (!oihd) {
        return;
    }
    const value = Boolean(enabled);
    const settings = oihd.getSettings();
    if (Boolean(settings.floatWindow && settings.floatWindow.enabled) !== value) {
        oihd.patchSettings({ floatWindow: { enabled: value } });
    }
    refreshTrayMenu();
    notifySettingsChanged();
}

function setFloatEnabled(enabled) {
    if (!oihd) {
        return false;
    }
    const value = Boolean(enabled);
    const settings = oihd.getSettings();
    if (Boolean(settings.floatWindow && settings.floatWindow.enabled) !== value) {
        oihd.patchSettings({ floatWindow: { enabled: value } });
    }
    if (floatManager) {
        floatManager.setVisible(value);
    }
    refreshTrayMenu();
    notifySettingsChanged();
    return value;
}

function applyAutoStart(enabled) {
    if (!app.isPackaged) {
        return false;
    }
    try {
        app.setLoginItemSettings({ openAtLogin: Boolean(enabled) });
        return true;
    } catch (err) {
        log({ source: 'app', level: 'warn', message: `设置开机自启失败: ${err.message}` });
        return false;
    }
}

function registerProgramInstance() {
    if (!oihd || !apiService) {
        return null;
    }
    const api = apiService.snapshot();
    if (!api.running) {
        return null;
    }
    const target = normalizeInstanceAddress(api.baseUrl);
    if (!target) {
        return null;
    }
    return oihd.upsertInstance({
        source: 'program',
        name: `程序 ${DISPLAY_VERSION}`,
        url: target.url,
        address: target.address,
        version: DISPLAY_VERSION,
        build: BUILD,
        status: 'online',
        lastCheckedAt: new Date().toISOString()
    });
}

function reportedServerAddress(server) {
    if (!server) {
        return '';
    }
    if (typeof server === 'string') {
        return server.trim();
    }
    if (typeof server === 'object') {
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
    return '';
}

function collectInstanceTargets(settings) {
    const targets = new Map();
    const add = (input, source, name) => {
        const normalized = normalizeInstanceAddress(input);
        if (!normalized || targets.has(normalized.url)) {
            return;
        }
        targets.set(normalized.url, { ...normalized, source, name: name || normalized.address });
    };

    const api = apiService ? apiService.snapshot() : null;
    if (api && api.running) {
        add(api.baseUrl, 'program', `程序 ${DISPLAY_VERSION}`);
    }
    if (wsService) {
        for (const workspace of wsService.getReportedWorkspaces()) {
            const server = reportedServerAddress(workspace.server);
            if (server) {
                add(server, 'extension', `扩展上报 ${workspace.path || ''}`.trim());
            }
        }
    }
    for (const instance of oihd.listInstances()) {
        add(instance.url || instance.address, instance.source || 'scan', instance.name);
    }
    for (const port of settings.scanPorts || []) {
        add(`127.0.0.1:${port}`, 'scan', `扫描端口 ${port}`);
    }
    return [...targets.values()];
}

async function scanWorkspaceRoots() {
    const settings = oihd.getSettings();
    const result = await scanWorkspaces(settings.scanRoots || [], { maxDepth: 3 });
    const merged = oihd.upsertScannedWorkspaces(result.items);
    log({
        source: 'oih',
        level: result.errors.length ? 'warn' : 'info',
        message: `工作区扫描完成: 识别 ${result.items.length} 个, 新增 ${merged.added}, 更新 ${merged.updated}, 同名跳过 ${merged.skipped}, 目录 ${result.scannedDirs}${result.truncated ? ' (已达上限)' : ''}.`
    });
    if (result.errors.length) {
        log({ source: 'oih', level: 'warn', message: result.errors[0] });
    }
    return { ...merged, scanned: result.items.length, dirs: result.scannedDirs, errors: result.errors };
}

async function scanServiceInstances() {
    const settings = oihd.getSettings();
    const targets = collectInstanceTargets(settings);
    const checkedAt = new Date().toISOString();
    const probes = await Promise.all(targets.map(async (target) => ({
        target,
        probe: await probeHealth(target.url, 1500)
    })));
    for (const { target, probe } of probes) {
        oihd.upsertInstance({
            source: target.source,
            name: target.name,
            url: target.url,
            address: target.address,
            version: probe.ok && probe.data && probe.data.version ? String(probe.data.version) : '',
            build: probe.ok && probe.data && probe.data.build !== undefined ? probe.data.build : '',
            status: probe.ok ? 'online' : 'offline',
            lastError: probe.ok ? '' : String(probe.error || `HTTP ${probe.status || 0}`),
            lastCheckedAt: checkedAt
        });
    }
    const online = probes.filter((item) => item.probe.ok).length;
    log({
        source: 'oih',
        level: 'info',
        message: `服务实例扫描完成: 探测 ${probes.length} 个地址, 在线 ${online}, 离线 ${probes.length - online}.`
    });
    return { items: oihd.listInstances(), probed: probes.length, online };
}

async function addManualInstance(address) {
    const target = normalizeInstanceAddress(address);
    if (!target) {
        throw new Error('地址格式无效, 请输入 host:port 或 http(s)://地址.');
    }
    const probe = await probeHealth(target.url, 1500);
    if (!probe.ok) {
        throw new Error(`探测失败 (${target.address}): ${probe.error || `HTTP ${probe.status || 0}`}.`);
    }
    const instance = oihd.upsertInstance({
        source: 'manual',
        name: target.address,
        url: target.url,
        address: target.address,
        version: probe.data && probe.data.version ? String(probe.data.version) : '',
        build: probe.data && probe.data.build !== undefined ? probe.data.build : '',
        status: 'online',
        lastError: '',
        lastCheckedAt: new Date().toISOString()
    });
    log({ source: 'oih', level: 'info', message: `手动添加实例 ${target.address} 探测成功.` });
    return { instance, probe };
}

function pickDirectory(title) {
    const options = { title, properties: ['openDirectory', 'createDirectory'] };
    return mainWindow && !mainWindow.isDestroyed()
        ? dialog.showOpenDialog(mainWindow, options)
        : dialog.showOpenDialog(options);
}

async function createWorkspaceFlow() {
    const picked = await pickDirectory('选择新工作区目录');
    if (picked.canceled || !picked.filePaths.length) {
        return { ok: false, canceled: true };
    }
    const created = createWorkspaceStructure(picked.filePaths[0]);
    const workspace = oihd.saveWorkspace({
        path: created.path,
        name: created.name,
        status: 'ok',
        source: 'manual',
        serverAddress: '',
        connection: ''
    });
    log({ source: 'oih', level: 'info', message: `已创建工作区: ${created.path}` });
    return { ok: true, workspace };
}

function exportWorkspaces() {
    return JSON.stringify(oihd.listWorkspaces(), null, 4);
}

function importWorkspaces(text) {
    let parsed;
    try {
        parsed = JSON.parse(String(text || ''));
    } catch (err) {
        throw new Error(`工作区 JSON 解析失败: ${err.message}`);
    }
    const result = oihd.importWorkspaces(parsed);
    log({ source: 'oih', level: 'info', message: `工作区 JSON 导入: 新增 ${result.added}, 更新 ${result.updated}.` });
    return result;
}

function registerIpc() {
    ipcMain.handle('oih:status', () => buildStatus());
    ipcMain.handle('oih:logs:list', () => logs);
    ipcMain.handle('oih:token', () => (wsService ? wsService.token : ''));
    ipcMain.handle('oih:interface:get', () => currentInterface());
    ipcMain.handle('oih:interface:save', async (_event, patch) => {
        const next = mergeInterface(patch || {});
        oihd.patchSettings({ interface: next });
        if (apiService) {
            try {
                await apiService.applyConfig(next.api);
                wsService.setApiPort(apiService.port || 0);
                registerProgramInstance();
            } catch (err) {
                log({ source: 'api', level: 'error', message: `API 配置应用失败: ${err.message}` });
            }
        }
        if (mcpHost) {
            if (next.mcp.enabled && !mcpHost.getState().running) {
                try {
                    await mcpHost.start();
                } catch (err) {
                    log({ source: 'mcp', level: 'error', message: `MCP 启动失败: ${err.message}` });
                }
            } else if (!next.mcp.enabled && mcpHost.getState().running) {
                mcpHost.stop();
            }
        }
        return buildStatus();
    });

    ipcMain.handle('oih:api:test', () => testApi());
    ipcMain.handle('oih:cli:test', (_event, args) => testCli(args));
    ipcMain.handle('oih:mcp:test', () => testMcp());
    ipcMain.handle('oih:mcp:start', async () => {
        try {
            const state = await mcpHost.start();
            oihd.patchSettings({ interface: { mcp: { enabled: true } } });
            return { ok: true, data: state };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });
    ipcMain.handle('oih:mcp:stop', () => {
        const state = mcpHost.stop();
        oihd.patchSettings({ interface: { mcp: { enabled: false } } });
        return { ok: true, data: state };
    });

    ipcMain.handle('oih:servers:list', () => oihd.listServers());
    ipcMain.handle('oih:servers:default', () => oihd.getDefaultServer());
    ipcMain.handle('oih:servers:save', (_event, item) => oihd.saveServer(item));
    ipcMain.handle('oih:servers:delete', (_event, id) => oihd.deleteServer(id));
    ipcMain.handle('oih:servers:set-default', (_event, id) => oihd.setDefaultServer(id));
    ipcMain.handle('oih:servers:start', (_event, id) => startLocalServer(id));
    ipcMain.handle('oih:servers:stop', (_event, id) => stopLocalServer(id));
    ipcMain.handle('oih:servers:connect', (_event, id) => connectRemoteServer(id));
    ipcMain.handle('oih:servers:disconnect', (_event, id) => disconnectRemoteServer(id));
    ipcMain.handle('oih:domain-groups:list', () => oihd.listDomainGroups());
    ipcMain.handle('oih:domain-groups:save', (_event, item) => oihd.saveDomainGroup(item));
    ipcMain.handle('oih:domain-groups:delete', (_event, id) => oihd.deleteDomainGroup(id));
    ipcMain.handle('oih:credentials:list', () => oihd.listCredentials());
    ipcMain.handle('oih:credentials:save', (_event, item) => {
        const result = oihd.saveCredential(item);
        runAutoSync('凭据保存后');
        return result;
    });
    ipcMain.handle('oih:credentials:delete', (_event, id) => {
        const result = oihd.deleteCredential(id);
        runAutoSync('凭据删除后');
        return result;
    });
    ipcMain.handle('oih:credentials:reveal', (_event, request) => oihd.revealCredential(
        request && request.id,
        request && request.field
    ));
    ipcMain.handle('oih:workspaces:list', () => oihd.listWorkspaces());
    ipcMain.handle('oih:workspaces:save', (_event, item) => oihd.saveWorkspace(item));
    ipcMain.handle('oih:workspaces:delete', (_event, id) => oihd.deleteWorkspace(id));
    ipcMain.handle('oih:workspaces:export', () => exportWorkspaces());
    ipcMain.handle('oih:workspaces:import', (_event, text) => importWorkspaces(text));
    ipcMain.handle('oih:oih:scan-workspaces', () => scanWorkspaceRoots());
    ipcMain.handle('oih:oih:create-workspace', () => createWorkspaceFlow());
    ipcMain.handle('oih:instances:list', () => oihd.listInstances());
    ipcMain.handle('oih:instances:scan', () => scanServiceInstances());
    ipcMain.handle('oih:instances:add', (_event, address) => addManualInstance(address));
    ipcMain.handle('oih:instances:delete', (_event, id) => oihd.deleteInstance(id));
    ipcMain.handle('oih:settings:get', () => oihd.getSettings());
    ipcMain.handle('oih:settings:update', async (_event, patch) => {
        const before = oihd.getSettings();
        const settings = oihd.patchSettings(patch || {});
        const notices = [];
        if (settings.tray !== before.tray) {
            applyTraySetting(settings.tray);
            notices.push(settings.tray ? '托盘已启用, 关闭窗口将隐藏到托盘.' : '托盘已关闭, 关闭窗口将直接退出.');
        }
        const floatNext = Boolean(settings.floatWindow && settings.floatWindow.enabled);
        const floatPrev = Boolean(before.floatWindow && before.floatWindow.enabled);
        if (floatNext !== floatPrev) {
            if (floatManager) {
                floatManager.setVisible(floatNext);
            }
            refreshTrayMenu();
            notices.push(floatNext ? '悬浮窗已显示.' : '悬浮窗已隐藏.');
        }
        if (settings.autoStart !== before.autoStart) {
            if (applyAutoStart(settings.autoStart)) {
                notices.push(settings.autoStart ? '已设置开机自启.' : '已取消开机自启.');
            } else {
                notices.push('开机自启设置已保存; 开发模式下未写入系统启动项.');
            }
        }
        if (settings.ws.port !== before.ws.port) {
            notices.push(`WebSocket 端口改为 ${settings.ws.port}, 下次启动生效.`);
        }
        if (settings.lan.enabled !== before.lan.enabled) {
            notices.push(settings.lan.enabled ? '局域网协作已开启.' : '局域网协作已关闭.');
        }
        if (settings.lan.port !== before.lan.port) {
            notices.push(`局域网端口改为 ${settings.lan.port}, 已即时生效.`);
        }
        if (lanService) {
            try {
                await lanService.applyConfig(settings.lan);
            } catch (err) {
                log({ source: 'lan', level: 'error', message: `局域网配置应用失败: ${err.message}` });
                notices.push(`局域网配置应用失败: ${err.message}`);
            }
        }
        if (settings.sync.archivePath !== before.sync.archivePath) {
            notices.push(`总存档路径已切换: ${settings.sync.archivePath}`);
        }
        return { ok: true, settings, notices };
    });
    ipcMain.handle('oih:lan:status', () => (lanService ? lanService.snapshot() : null));
    ipcMain.handle('oih:events:list', () => (eventService ? eventService.list() : []));
    ipcMain.handle('oih:events:clear', () => {
        if (eventService) {
            eventService.clear();
        }
        return { ok: true };
    });
    ipcMain.handle('oih:sync:status', (_event, workspace) => {
        const records = oihd.listWorkspaces();
        if (workspace) {
            return syncEngine.status(workspace);
        }
        return records.map((record) => syncEngine.status(record.path));
    });
    ipcMain.handle('oih:sync:compare', (_event, workspace) => syncEngine.compare(workspace));
    ipcMain.handle('oih:sync:apply', (_event, request) => syncEngine.apply(
        request && request.workspace,
        (request && request.keys) || [],
        request && request.action
    ));
    ipcMain.handle('oih:sync:auto', (_event, workspace) => {
        if (workspace) {
            return { results: [syncEngine.autoRun(workspace)] };
        }
        return { results: syncEngine.autoRunAll() };
    });
    ipcMain.handle('oih:sync:info', () => ({
        archivePath: oihd.getCredentialsPath(),
        workspaces: oihd.listWorkspaces()
    }));
    ipcMain.handle('oih:workspaces:clients', () => ({
        clients: wsService ? wsService.getClients() : [],
        workspaces: wsService ? wsService.getReportedWorkspaces() : []
    }));
    ipcMain.handle('oih:workspace:command', (_event, request) => {
        const type = request && request.type;
        if (!['openWorkspace', 'createWorkspace', 'syncRequest'].includes(type)) {
            return { ok: false, error: `不支持的下发类型: ${type}` };
        }
        const sent = wsService.broadcast(type, (request && request.payload) || {}, {
            clientId: request && request.clientId
        });
        return { ok: sent > 0, sent };
    });
}

function showMainWindow() {
    if (!mainWindow) {
        return;
    }
    if (mainWindow.isMinimized()) {
        mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
}

function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 1000,
        height: 700,
        show: false,
        title: `OI Helper ${DISPLAY_VERSION}`,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), {
        query: { version: DISPLAY_VERSION }
    });
    mainWindow.once('ready-to-show', showMainWindow);

    mainWindow.on('close', (event) => {
        if (isQuitting) {
            return;
        }
        const trayEnabled = oihd ? oihd.getSettings().tray : true;
        if (trayEnabled) {
            event.preventDefault();
            mainWindow.hide();
            return;
        }
        // 托盘关闭时按普通退出处理
        isQuitting = true;
        app.quit();
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

function trayTemplate() {
    const settings = oihd ? oihd.getSettings() : { floatWindow: { enabled: false } };
    return [
        { label: '打开', click: showMainWindow },
        {
            label: '悬浮窗',
            type: 'checkbox',
            checked: Boolean(settings.floatWindow && settings.floatWindow.enabled),
            click: (item) => setFloatEnabled(item.checked)
        },
        { type: 'separator' },
        {
            label: '退出',
            click: () => {
                isQuitting = true;
                app.quit();
            }
        }
    ];
}

function refreshTrayMenu() {
    if (tray) {
        tray.setContextMenu(Menu.buildFromTemplate(trayTemplate()));
    }
}

function createTray() {
    if (tray) {
        refreshTrayMenu();
        return;
    }
    tray = new Tray(nativeImage.createFromDataURL(TRAY_ICON_DATA_URL));
    tray.setToolTip(`OI Helper ${DISPLAY_VERSION}`);
    tray.setContextMenu(Menu.buildFromTemplate(trayTemplate()));
    tray.on('double-click', showMainWindow);
}

function destroyTray() {
    if (!tray) {
        return;
    }
    tray.destroy();
    tray = null;
}

function createFloatManager() {
    floatManager = new FloatWindowManager({
        dataDir: oihd.dir,
        judge: judgeProblem,
        getLastRun: () => oihd.getJudgeState().lastRun,
        isEnabled: () => {
            const settings = oihd.getSettings();
            return Boolean(settings.floatWindow && settings.floatWindow.enabled);
        },
        onVisibilityChange: persistFloatVisibility,
        onLog: log
    });
    floatManager.registerIpc(ipcMain);
}

async function startServices() {
    oihd = new Oihd({ dataDir: defaultDataDir() }).init();
    log({ source: 'app', level: 'info', message: `数据目录: ${oihd.dir}` });
    syncEngine = new SyncEngine({ oihd, onLog: log });

    const settings = oihd.getSettings();
    eventService = new EventService({
        dataDir: oihd.dir,
        getSettings: () => oihd.getSettings(),
        onLog: log,
        onEvent: handleNotifiedEvent,
        onRecord: handleRecordedEvent
    });
    wsService = new WsService({
        dataDir: oihd.dir,
        port: settings.ws.port,
        judgePath: (() => {
            try {
                return resolveJudgePath();
            } catch {
                return '';
            }
        })(),
        onLog: log,
        onEvent: (name, data) => {
            if (name === 'hello') {
                log({ source: 'ws', level: 'info', message: `扩展上报工作区: ${data.workspacePath || '未填写'}` });
                if (data.workspacePath) {
                    oihd.bindExtensionWorkspace({
                        path: data.workspacePath,
                        version: data.version,
                        clientId: data.clientId,
                        source: 'extension'
                    });
                }
            }
            if (name === 'status' && data.workspace) {
                const record = data.workspace;
                oihd.bindExtensionWorkspace({
                    path: record.path,
                    version: record.version,
                    clientId: record.clientId,
                    serverAddress: reportedServerAddress(record.server),
                    connection: record.connection || '',
                    source: 'extension'
                });
            }
            if (name === 'clientDisconnected' && data.workspacePath) {
                oihd.bindExtensionWorkspace({
                    path: data.workspacePath,
                    connection: 'disconnected',
                    source: 'extension'
                });
            }
            if (name === 'contestEvent' && data.event) {
                try {
                    const result = eventService.push(data.event);
                    if (result.duplicate) {
                        log({ source: 'event', level: 'info', message: `重复事件已忽略: ${result.event.id}` });
                    } else {
                        log({ source: 'event', level: 'info', message: `事件已记录: ${result.event.payload.title}${result.notified ? ', 已提醒' : ', 未提醒'}` });
                    }
                } catch (err) {
                    log({ source: 'event', level: 'error', message: `事件处理失败: ${err.message}` });
                }
            }
        }
    });
    try {
        await wsService.start();
    } catch (err) {
        log({ source: 'ws', level: 'error', message: `WebSocket 启动失败: ${err.message}` });
    }

    lanService = new LanService({
        dataDir: oihd.dir,
        port: settings.lan.port,
        room: settings.lan.room,
        retention: settings.lan.retention,
        nickname: settings.lan.nickname,
        serverAddress: settings.lan.serverAddress,
        onLog: log
    });
    try {
        await lanService.applyConfig(settings.lan);
    } catch (err) {
        log({ source: 'lan', level: 'error', message: `局域网服务启动失败: ${err.message}` });
    }

    apiService = new ApiService({
        oihd,
        sync: syncEngine,
        events: eventService,
        token: wsService.token,
        onLog: log,
        onPortChange: (port) => {
            if (wsService) {
                wsService.setApiPort(port);
            }
        }
    });
    try {
        await apiService.applyConfig(settings.interface.api);
        registerProgramInstance();
    } catch (err) {
        log({ source: 'api', level: 'error', message: `API 启动失败: ${err.message}` });
    }

    mcpHost = new McpHost({ rootDir: repoRoot, onLog: log });
    if (settings.interface.mcp.enabled) {
        try {
            await mcpHost.start();
        } catch (err) {
            log({ source: 'mcp', level: 'error', message: `MCP 启动失败: ${err.message}` });
        }
    }
}

function stopServices() {
    if (apiService) {
        apiService.stop();
    }
    if (lanService) {
        lanService.stop();
    }
    if (mcpHost) {
        mcpHost.stop();
    }
    if (wsService) {
        wsService.stop();
    }
}

const hasLock = app.requestSingleInstanceLock();

if (!hasLock) {
    app.quit();
} else {
    app.on('second-instance', showMainWindow);

    app.whenReady().then(async () => {
        app.setAppUserModelId('com.oihelper.desktop');
        registerIpc();
        await startServices();
        createFloatManager();
        createMainWindow();
        if (oihd.getSettings().tray) {
            createTray();
        }
        const settings = oihd.getSettings();
        if (settings.floatWindow && settings.floatWindow.enabled) {
            floatManager.show();
        }
        runAutoSync('启动时');
    });

    // 窗口关闭时仅隐藏到托盘, 由托盘菜单退出
    app.on('before-quit', () => {
        isQuitting = true;
        if (floatManager) {
            floatManager.destroy();
        }
        stopServices();
    });
}
