'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { defaultDataDir, maskSecret } = require('./util');

const DOC_FILES = {
    servers: 'servers.json',
    credentials: 'credentials.json',
    workspaces: 'workspaces.json',
    instances: 'instances.json',
    state: 'state.json'
};

const ACCESS_MODES = ['localhost', 'lan', 'public'];
const SYNC_MODES = ['off', 'workspaceToArchive', 'archiveToWorkspace', 'both'];
const NOTIFY_TYPES = ['teammate_submit', 'first_blood', 'freeze', 'unfreeze'];

function normalizeLanServerAddress(input) {
    const text = String(input ?? '').trim();
    if (!text) {
        return '';
    }
    const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
    let parsed;
    try {
        parsed = new URL(candidate);
    } catch {
        throw new Error('局域网服务器地址无效, 示例: 192.168.1.10:17330 或 http://192.168.1.10:17330.');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('局域网服务器地址仅支持 http 或 https.');
    }
    return parsed.origin;
}

const DEFAULT_SETTINGS = {
    interface: {
        api: {
            enabled: true,
            host: '127.0.0.1',
            port: 17322,
            danger: {
                deleteServer: false,
                syncOverwrite: false
            }
        },
        mcp: {
            enabled: false
        },
        cli: {
            path: ''
        }
    },
    ws: {
        port: 17321
    },
    lan: {
        enabled: false,
        port: 17330,
        room: 'default',
        retention: false,
        nickname: '',
        serverAddress: ''
    },
    notifications: {
        enabled: true,
        types: {
            teammate_submit: true,
            first_blood: true,
            freeze: true,
            unfreeze: true
        },
        rules: []
    },
    scanPorts: [17321, 17322],
    scanRoots: [os.homedir()],
    autoSync: 'off',
    tray: true,
    autoStart: false,
    floatWindow: {
        enabled: false
    },
    sync: {
        archivePath: ''
    }
};

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function mergeDeep(base, patch) {
    const out = base && typeof base === 'object' && !Array.isArray(base) ? { ...base } : {};
    for (const [key, value] of Object.entries(patch || {})) {
        if (value && typeof value === 'object' && !Array.isArray(value)
            && out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])) {
            out[key] = mergeDeep(out[key], value);
        } else {
            out[key] = value;
        }
    }
    return out;
}

function emptyDoc() {
    return { version: 1, items: [] };
}

function requireText(value, field) {
    const text = String(value ?? '').trim();
    if (!text) {
        throw new Error(`${field} 不能为空.`);
    }
    return text;
}

function encryptSecret(plain) {
    const text = String(plain ?? '');
    if (!text) {
        return { scheme: 'empty', data: '' };
    }
    const { safeStorage } = require('electron');
    if (safeStorage && safeStorage.isEncryptionAvailable()) {
        return { scheme: 'safeStorage', data: safeStorage.encryptString(text).toString('base64') };
    }
    // 系统加密不可用时拒绝明文落盘, 只保留占位并给出提示
    return {
        scheme: 'placeholder',
        data: '',
        hint: '系统加密不可用, 密码未保存; 请先解锁系统密钥环后重新填写.'
    };
}

function decryptSecret(secret) {
    if (!secret || !secret.data) {
        return '';
    }
    if (secret.scheme !== 'safeStorage') {
        return '';
    }
    try {
        const { safeStorage } = require('electron');
        return safeStorage.decryptString(Buffer.from(secret.data, 'base64'));
    } catch {
        return '';
    }
}

function secretView(secret) {
    const scheme = secret && secret.scheme ? secret.scheme : 'empty';
    return {
        present: scheme === 'safeStorage',
        scheme,
        hint: secret && secret.hint ? secret.hint : undefined
    };
}

class Oihd {
    constructor(options = {}) {
        this.dir = options.dataDir || defaultDataDir();
        this.credentialsPath = '';
        this.docs = {};
        this.loaded = false;
    }

    init() {
        fs.mkdirSync(this.dir, { recursive: true });
        this.docs.servers = this.readFile(path.join(this.dir, DOC_FILES.servers), emptyDoc());
        if (!Array.isArray(this.docs.servers.items)) {
            this.docs.servers.items = [];
        }
        if (!Array.isArray(this.docs.servers.domainGroups)) {
            this.docs.servers.domainGroups = [];
        }
        this.docs.workspaces = this.readFile(path.join(this.dir, DOC_FILES.workspaces), emptyDoc());
        if (!Array.isArray(this.docs.workspaces.items)) {
            this.docs.workspaces.items = [];
        }
        this.docs.instances = this.readFile(path.join(this.dir, DOC_FILES.instances), emptyDoc());
        if (!Array.isArray(this.docs.instances.items)) {
            this.docs.instances.items = [];
        }
        const state = this.readFile(path.join(this.dir, DOC_FILES.state), {
            version: 1,
            settings: clone(DEFAULT_SETTINGS),
            judge: { lastRun: null, history: [] },
            sync: { baselines: {}, lastRun: null, conflicts: {} }
        });
        state.settings = mergeDeep(clone(DEFAULT_SETTINGS), state.settings || {});
        if (!state.judge || typeof state.judge !== 'object') {
            state.judge = { lastRun: null, history: [] };
        }
        if (!state.sync || typeof state.sync !== 'object') {
            state.sync = { baselines: {}, lastRun: null, conflicts: {} };
        }
        this.docs.state = state;
        if (Array.isArray(this.docs.workspaces.items)) {
            let touched = false;
            this.docs.workspaces.items = this.docs.workspaces.items.map((item) => {
                if (SYNC_MODES.includes(item.autoSync)) {
                    return item;
                }
                touched = true;
                return { ...item, autoSync: state.settings.autoSync };
            });
            if (touched) {
                this.writeDoc('workspaces', this.docs.workspaces);
            }
        }
        this.credentialsPath = this.resolveArchivePath(state.settings.sync.archivePath);
        state.settings.sync.archivePath = this.credentialsPath;
        this.docs.credentials = this.readFile(this.credentialsPath, emptyDoc());
        if (!Array.isArray(this.docs.credentials.items)) {
            this.docs.credentials.items = [];
        }
        this.loaded = true;
        this.writeDoc('state', state);
        return this;
    }

    resolveArchivePath(input) {
        const text = String(input || '').trim();
        if (!text) {
            return path.join(this.dir, DOC_FILES.credentials);
        }
        return path.isAbsolute(text) ? path.normalize(text) : path.join(this.dir, text);
    }

    filePath(name) {
        if (name === 'credentials') {
            return this.credentialsPath || path.join(this.dir, DOC_FILES.credentials);
        }
        return path.join(this.dir, DOC_FILES[name]);
    }

    readFile(file, fallback) {
        try {
            const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (parsed && typeof parsed === 'object') {
                return parsed;
            }
        } catch {
            // 文件不存在或损坏时回退默认结构
        }
        return clone(fallback);
    }

    // 切换总存档位置: 目标不存在时把当前存档写过去, 已存在时以目标内容为准
    switchArchive(nextPath) {
        fs.mkdirSync(path.dirname(nextPath), { recursive: true });
        let doc = null;
        if (fs.existsSync(nextPath)) {
            try {
                const parsed = JSON.parse(fs.readFileSync(nextPath, 'utf8'));
                if (parsed && Array.isArray(parsed.items)) {
                    doc = parsed;
                } else {
                    throw new Error('缺少 items 数组.');
                }
            } catch (err) {
                throw new Error(`总存档文件不可用 (${nextPath}): ${err.message}`);
            }
        }
        if (!doc) {
            doc = clone(this.docs.credentials || emptyDoc());
            this.credentialsPath = nextPath;
            this.writeDoc('credentials', doc);
        } else {
            this.credentialsPath = nextPath;
        }
        this.docs.credentials = doc;
    }

    writeDoc(name, doc) {
        const file = this.filePath(name);
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(doc, null, 4));
        fs.renameSync(tmp, file);
    }

    save(name) {
        this.writeDoc(name, this.docs[name]);
    }

    // ---- 服务器 ----
    listServers() {
        return clone(this.docs.servers.items || []);
    }

    getDefaultServer() {
        const items = this.docs.servers.items || [];
        const item = items.find((s) => s.isDefault) || null;
        return item ? clone(item) : null;
    }

    saveServer(input) {
        const item = input || {};
        const name = requireText(item.name, '服务器名称');
        const type = item.type === 'remote' ? 'remote' : 'local';
        const doc = this.docs.servers;
        const id = item.id ? String(item.id) : crypto.randomUUID();
        const existing = doc.items.find((s) => s.id === id);
        const now = new Date().toISOString();
        const next = {
            ...(existing || {}),
            id,
            name,
            type,
            createdAt: existing && existing.createdAt ? existing.createdAt : now,
            updatedAt: now
        };
        if (type === 'local') {
            const host = requireText(item.host, '地址');
            const port = Number(item.port);
            if (!Number.isInteger(port) || port < 1 || port > 65535) {
                throw new Error('端口必须是 1-65535 的整数.');
            }
            const access = ACCESS_MODES.includes(item.access) ? item.access : 'localhost';
            const domain = String(item.domain || '').trim();
            if (access === 'public' && !domain) {
                throw new Error('公网访问必须填写域名.');
            }
            const domainGroupId = String(item.domainGroupId || '').trim();
            if (domainGroupId && !(doc.domainGroups || []).some((g) => g.id === domainGroupId)) {
                throw new Error('所选域名组不存在, 请先创建.');
            }
            Object.assign(next, {
                host,
                port,
                access,
                domain: access === 'public' ? domain : '',
                domainGroupId,
                status: existing ? existing.status || 'stopped' : 'stopped',
                lastHealth: existing ? existing.lastHealth || null : null
            });
            delete next.url;
            delete next.verify;
            delete next.permission;
            delete next.connection;
        } else {
            const url = requireText(item.url, '地址');
            Object.assign(next, {
                url,
                verify: String(item.verify ?? ''),
                permission: String(item.permission ?? ''),
                connection: existing ? existing.connection || 'disconnected' : 'disconnected'
            });
            delete next.host;
            delete next.port;
            delete next.access;
            delete next.domain;
            delete next.domainGroupId;
            delete next.status;
            delete next.lastHealth;
        }
        next.isDefault = Boolean(item.isDefault) || (!existing && !doc.items.some((s) => s.isDefault));
        if (next.isDefault) {
            doc.items = doc.items.map((s) => (s.id === id ? s : { ...s, isDefault: false }));
        }
        if (existing) {
            doc.items = doc.items.map((s) => (s.id === id ? next : s));
        } else {
            doc.items.push(next);
        }
        this.save('servers');
        return clone(next);
    }

    setDefaultServer(id) {
        const doc = this.docs.servers;
        if (!doc.items.some((s) => s.id === id)) {
            throw new Error('服务器不存在.');
        }
        doc.items = doc.items.map((s) => ({ ...s, isDefault: s.id === id }));
        this.save('servers');
        return clone(doc.items);
    }

    setServerState(id, patch) {
        const doc = this.docs.servers;
        const item = doc.items.find((s) => s.id === id);
        if (!item) {
            throw new Error('服务器不存在.');
        }
        const next = { ...item, ...(patch || {}), updatedAt: new Date().toISOString() };
        if (patch && patch.lastHealth === undefined) {
            next.lastHealth = item.lastHealth || null;
        }
        doc.items = doc.items.map((s) => (s.id === id ? next : s));
        this.save('servers');
        return clone(next);
    }

    deleteServer(id) {
        const doc = this.docs.servers;
        const target = doc.items.find((s) => s.id === id);
        const before = doc.items.length;
        doc.items = doc.items.filter((s) => s.id !== id);
        if (target && target.isDefault && doc.items.length) {
            doc.items = doc.items.map((s, index) => (index === 0 ? { ...s, isDefault: true } : s));
        }
        this.save('servers');
        return before !== doc.items.length;
    }

    // ---- 域名组 ----
    listDomainGroups() {
        return clone(this.docs.servers.domainGroups || []);
    }

    saveDomainGroup(input) {
        const item = input || {};
        const name = requireText(item.name, '域名组名称');
        const groups = this.docs.servers.domainGroups;
        const id = item.id ? String(item.id) : crypto.randomUUID();
        if (groups.some((g) => g.id !== id && g.name.toLowerCase() === name.toLowerCase())) {
            throw new Error(`域名组名称已存在: ${name}`);
        }
        const existing = groups.find((g) => g.id === id);
        const now = new Date().toISOString();
        const next = {
            ...(existing || {}),
            id,
            name,
            note: String(item.note ?? (existing ? existing.note : '') ?? ''),
            createdAt: existing && existing.createdAt ? existing.createdAt : now,
            updatedAt: now
        };
        if (existing) {
            this.docs.servers.domainGroups = groups.map((g) => (g.id === id ? next : g));
        } else {
            this.docs.servers.domainGroups = [...groups, next];
        }
        this.save('servers');
        return clone(next);
    }

    deleteDomainGroup(id) {
        const doc = this.docs.servers;
        const before = doc.domainGroups.length;
        doc.domainGroups = doc.domainGroups.filter((g) => g.id !== id);
        doc.items = doc.items.map((s) => (s.domainGroupId === id ? { ...s, domainGroupId: '' } : s));
        this.save('servers');
        return before !== doc.domainGroups.length;
    }

    // ---- 凭据 ----
    listCredentials() {
        return (this.docs.credentials.items || []).map((item) => ({
            id: item.id,
            oj: item.oj,
            username: item.username,
            note: item.note || '',
            isDefault: Boolean(item.isDefault),
            password: secretView(item.password),
            cookie: secretView(item.cookie),
            updatedAt: item.updatedAt
        }));
    }

    saveCredential(input) {
        const item = input || {};
        const oj = requireText(item.oj, 'OJ 名称');
        const username = requireText(item.username, '用户名');
        const doc = this.docs.credentials;
        const id = item.id ? String(item.id) : crypto.randomUUID();
        const existing = doc.items.find((c) => c.id === id);
        const now = new Date().toISOString();
        const password = item.password !== undefined ? encryptSecret(item.password) : (existing ? existing.password : encryptSecret(''));
        const cookie = item.cookie !== undefined ? encryptSecret(item.cookie) : (existing ? existing.cookie : encryptSecret(''));
        const next = {
            ...existing,
            id,
            oj,
            username,
            note: String(item.note ?? (existing ? existing.note : '') ?? ''),
            isDefault: Boolean(item.isDefault),
            password,
            cookie,
            createdAt: existing && existing.createdAt ? existing.createdAt : now,
            updatedAt: now
        };
        if (next.isDefault) {
            doc.items = doc.items.map((c) => (c.oj === oj ? { ...c, isDefault: false } : c));
        }
        const index = doc.items.findIndex((c) => c.id === id);
        if (index >= 0) {
            doc.items[index] = next;
        } else {
            doc.items.push(next);
        }
        this.save('credentials');
        return { id, hint: secretView(next.password).hint };
    }

    deleteCredential(id) {
        const doc = this.docs.credentials;
        const before = doc.items.length;
        doc.items = doc.items.filter((c) => c.id !== id);
        this.save('credentials');
        return before !== doc.items.length;
    }

    // 解密仅在主进程内进行一次, 回传界面时仍以掩码呈现
    revealCredential(id, field) {
        if (field !== 'password' && field !== 'cookie') {
            throw new Error('仅支持显示密码或 Cookie.');
        }
        const item = (this.docs.credentials.items || []).find((c) => c.id === id);
        if (!item) {
            throw new Error('凭据不存在.');
        }
        const value = decryptSecret(item[field]);
        return {
            id,
            field,
            present: Boolean(value),
            masked: maskSecret(value)
        };
    }

    // 同步引擎按 oj + username 写入, 密码与 Cookie 统一加密
    upsertCredentialPlain(input) {
        const item = input || {};
        const oj = requireText(item.oj, 'OJ 名称');
        const username = requireText(item.username, '用户名');
        const doc = this.docs.credentials;
        const existing = doc.items.find((c) => c.oj === oj && c.username === username);
        const id = existing ? existing.id : crypto.randomUUID();
        const now = new Date().toISOString();
        const next = {
            id,
            oj,
            username,
            note: String(item.note ?? ''),
            isDefault: Boolean(item.isDefault),
            password: encryptSecret(item.password),
            cookie: encryptSecret(item.cookie),
            createdAt: existing && existing.createdAt ? existing.createdAt : now,
            updatedAt: now
        };
        if (next.isDefault) {
            doc.items = doc.items.map((c) => (c.oj === oj ? { ...c, isDefault: false } : c));
        }
        const index = doc.items.findIndex((c) => c.id === id);
        if (index >= 0) {
            doc.items[index] = next;
        } else {
            doc.items.push(next);
        }
        this.save('credentials');
        return { id, hint: secretView(next.password).hint };
    }

    deleteCredentialByKey(oj, username) {
        const doc = this.docs.credentials;
        const before = doc.items.length;
        doc.items = doc.items.filter((c) => !(c.oj === oj && c.username === username));
        this.save('credentials');
        return before !== doc.items.length;
    }

    getCredentialsPath() {
        return this.credentialsPath;
    }

    // 仅供同步等内部逻辑使用, 不暴露给渲染进程
    readCredentialSecrets() {
        return (this.docs.credentials.items || []).map((item) => ({
            oj: item.oj,
            username: item.username,
            note: item.note || '',
            isDefault: Boolean(item.isDefault),
            password: decryptSecret(item.password),
            cookie: decryptSecret(item.cookie),
            passwordScheme: item.password ? item.password.scheme : 'empty',
            cookieScheme: item.cookie ? item.cookie.scheme : 'empty'
        }));
    }

    // ---- 工作区 ----
    listWorkspaces() {
        return clone(this.docs.workspaces.items || []);
    }

    saveWorkspace(input) {
        const item = input || {};
        const workspacePath = requireText(item.path, '工作区路径');
        const doc = this.docs.workspaces;
        const id = item.id ? String(item.id) : crypto.randomUUID();
        const now = new Date().toISOString();
        const existing = doc.items.find((w) => w.id === id);
        const next = {
            ...existing,
            ...item,
            id,
            path: workspacePath,
            updatedAt: now,
            createdAt: existing && existing.createdAt ? existing.createdAt : now
        };
        // 新工作区沿用当前的自动同步默认模式, 已有工作区保持原值
        if (!existing && item.autoSync === undefined) {
            next.autoSync = this.docs.state.settings.autoSync || 'off';
        }
        if (existing) {
            doc.items = doc.items.map((w) => (w.id === id ? next : w));
        } else {
            doc.items.push(next);
        }
        this.save('workspaces');
        return clone(next);
    }

    deleteWorkspace(id) {
        const doc = this.docs.workspaces;
        const before = doc.items.length;
        doc.items = doc.items.filter((w) => w.id !== id);
        this.save('workspaces');
        return before !== doc.items.length;
    }

    // 扫描结果按路径去重, 同名不同路径只保留先出现的一条
    upsertScannedWorkspaces(items) {
        const doc = this.docs.workspaces;
        const now = new Date().toISOString();
        const names = new Set(doc.items.map((item) => String(item.name || '').trim().toLowerCase()).filter(Boolean));
        let added = 0;
        let updated = 0;
        let skipped = 0;
        for (const input of items || []) {
            const workspacePath = String(input && input.path || '').trim();
            if (!workspacePath) {
                continue;
            }
            const existing = doc.items.find((item) => this.samePath(item.path, workspacePath));
            if (existing) {
                Object.assign(existing, {
                    name: String(input.name || existing.name || path.basename(workspacePath)),
                    status: input.status || existing.status || 'ok',
                    scannedAt: now,
                    updatedAt: now
                });
                updated += 1;
                continue;
            }
            const name = String(input.name || path.basename(workspacePath)).trim();
            const nameKey = name.toLowerCase();
            if (names.has(nameKey)) {
                skipped += 1;
                continue;
            }
            names.add(nameKey);
            doc.items.push({
                id: crypto.randomUUID(),
                name,
                path: workspacePath,
                status: input.status || 'ok',
                source: 'scan',
                serverAddress: String(input.serverAddress || ''),
                connection: '',
                autoSync: this.docs.state.settings.autoSync || 'off',
                scannedAt: now,
                createdAt: now,
                updatedAt: now
            });
            added += 1;
        }
        if (added || updated) {
            this.save('workspaces');
        }
        return { items: clone(doc.items), added, updated, skipped };
    }

    // 扩展上报的 hello/status 同步到工作区表
    bindExtensionWorkspace(input) {
        const item = input || {};
        const workspacePath = String(item.path || '').trim();
        if (!workspacePath) {
            return null;
        }
        const doc = this.docs.workspaces;
        const now = new Date().toISOString();
        const existing = doc.items.find((w) => this.samePath(w.path, workspacePath));
        if (existing) {
            Object.assign(existing, {
                name: existing.name || path.basename(workspacePath),
                status: item.status || existing.status || 'ok',
                source: 'extension',
                clientId: item.clientId || existing.clientId || '',
                version: item.version || existing.version || '',
                serverAddress: item.serverAddress !== undefined ? String(item.serverAddress || '') : String(existing.serverAddress || ''),
                connection: item.connection || existing.connection || '',
                updatedAt: now
            });
            this.save('workspaces');
            return clone(existing);
        }
        return this.saveWorkspace({
            path: workspacePath,
            name: item.name || path.basename(workspacePath),
            status: item.status || 'ok',
            source: 'extension',
            clientId: item.clientId || '',
            version: item.version || '',
            serverAddress: String(item.serverAddress || ''),
            connection: item.connection || ''
        });
    }

    importWorkspaces(items) {
        if (!Array.isArray(items)) {
            throw new Error('工作区 JSON 必须是数组.');
        }
        const doc = this.docs.workspaces;
        const now = new Date().toISOString();
        let added = 0;
        let updated = 0;
        let skipped = 0;
        for (const raw of items) {
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
                throw new Error('工作区 JSON 条目必须是对象.');
            }
            const workspacePath = String(raw.path || '').trim();
            if (!workspacePath) {
                throw new Error('工作区 JSON 条目缺少 path.');
            }
            const existing = doc.items.find((item) => this.samePath(item.path, workspacePath));
            if (existing) {
                Object.assign(existing, {
                    name: String(raw.name || existing.name || path.basename(workspacePath)),
                    status: String(raw.status || existing.status || 'ok'),
                    source: String(raw.source || existing.source || 'manual'),
                    serverAddress: String(raw.serverAddress || ''),
                    connection: String(raw.connection || ''),
                    updatedAt: now
                });
                updated += 1;
                continue;
            }
            const name = String(raw.name || path.basename(workspacePath)).trim();
            doc.items.push({
                ...raw,
                id: raw.id ? String(raw.id) : crypto.randomUUID(),
                name,
                path: workspacePath,
                status: String(raw.status || 'ok'),
                source: String(raw.source || 'manual'),
                serverAddress: String(raw.serverAddress || ''),
                connection: String(raw.connection || ''),
                autoSync: SYNC_MODES.includes(raw.autoSync) ? raw.autoSync : this.docs.state.settings.autoSync || 'off',
                createdAt: raw.createdAt || now,
                updatedAt: now
            });
            added += 1;
        }
        this.save('workspaces');
        return { items: clone(doc.items), added, updated, skipped };
    }

    samePath(a, b) {
        if (!a || !b) {
            return false;
        }
        return path.resolve(String(a)).toLowerCase() === path.resolve(String(b)).toLowerCase();
    }

    // ---- 服务实例 ----
    listInstances() {
        return clone(this.docs.instances.items || []);
    }

    upsertInstance(input) {
        const item = input || {};
        const url = String(item.url || '').trim();
        const address = String(item.address || '').trim();
        if (!url && !address) {
            throw new Error('实例地址不能为空.');
        }
        const doc = this.docs.instances;
        const key = String(url || address).replace(/\/+$/, '').toLowerCase();
        const existing = doc.items.find((inst) => String(inst.url || inst.address || '').replace(/\/+$/, '').toLowerCase() === key);
        const now = new Date().toISOString();
        const next = {
            ...existing,
            ...item,
            id: existing ? existing.id : crypto.randomUUID(),
            url: url || (existing && existing.url) || '',
            address: address || (existing && existing.address) || '',
            createdAt: existing && existing.createdAt ? existing.createdAt : now,
            updatedAt: now
        };
        if (!item.version && existing && existing.version) {
            next.version = existing.version;
        }
        if (existing) {
            doc.items = doc.items.map((inst) => (inst.id === next.id ? next : inst));
        } else {
            doc.items.push(next);
        }
        this.save('instances');
        return clone(next);
    }

    deleteInstance(id) {
        const doc = this.docs.instances;
        const item = doc.items.find((inst) => inst.id === id);
        if (!item) {
            throw new Error('实例不存在.');
        }
        if (item.source !== 'manual') {
            throw new Error('仅手动添加的实例可删除, 其他实例离线后会保留.');
        }
        doc.items = doc.items.filter((inst) => inst.id !== id);
        this.save('instances');
        return true;
    }

    // ---- 设置与评测状态 ----
    getSettings() {
        return clone(this.docs.state.settings);
    }

    patchSettings(patch) {
        const state = this.docs.state;
        const previous = clone(state.settings);
        const next = mergeDeep(state.settings, patch || {});
        if (!SYNC_MODES.includes(next.autoSync)) {
            throw new Error(`自动同步模式无效: ${next.autoSync}`);
        }
        const wsPort = Number(next.ws && next.ws.port);
        if (!Number.isInteger(wsPort) || wsPort < 1 || wsPort > 65535) {
            throw new Error('WS 端口必须是 1-65535 的整数.');
        }
        next.ws.port = wsPort;
        if (!next.lan || typeof next.lan !== 'object') {
            next.lan = clone(DEFAULT_SETTINGS.lan);
        }
        const lanPort = Number(next.lan.port);
        if (!Number.isInteger(lanPort) || lanPort < 1 || lanPort > 65535) {
            throw new Error('局域网端口必须是 1-65535 的整数.');
        }
        next.lan.port = lanPort;
        const room = String(next.lan.room ?? '').trim();
        if (room.length > 64 || /[\s\x00-\x1f]/.test(room)) {
            throw new Error('房间名不能超过 64 个字符, 且不能包含空白或控制字符.');
        }
        next.lan.room = room || DEFAULT_SETTINGS.lan.room;
        next.lan.enabled = Boolean(next.lan.enabled);
        next.lan.retention = Boolean(next.lan.retention);
        next.lan.nickname = String(next.lan.nickname ?? '').trim().slice(0, 32);
        next.lan.serverAddress = normalizeLanServerAddress(next.lan.serverAddress);
        if (!next.notifications || typeof next.notifications !== 'object') {
            next.notifications = clone(DEFAULT_SETTINGS.notifications);
        }
        next.notifications.enabled = Boolean(next.notifications.enabled);
        const types = next.notifications.types && typeof next.notifications.types === 'object'
            ? next.notifications.types
            : {};
        next.notifications.types = {};
        for (const key of NOTIFY_TYPES) {
            next.notifications.types[key] = types[key] !== false;
        }
        const rules = Array.isArray(next.notifications.rules) ? next.notifications.rules : [];
        next.notifications.rules = rules.map((rule, index) => {
            if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
                throw new Error(`订阅规则第 ${index + 1} 条必须是对象.`);
            }
            const type = String(rule.type || '*').trim();
            if (type !== '*' && !NOTIFY_TYPES.includes(type)) {
                throw new Error(`订阅规则第 ${index + 1} 条类型无效: ${type}.`);
            }
            return {
                type,
                oj: String(rule.oj ?? '').trim(),
                contestId: String(rule.contestId ?? '').trim(),
                enabled: rule.enabled !== false
            };
        });
        if (!Array.isArray(next.scanPorts)) {
            throw new Error('扫描端口列表必须是数组.');
        }
        next.scanPorts = [...new Set(next.scanPorts
            .map((port) => Number(port))
            .filter((port) => Number.isInteger(port) && port >= 1 && port <= 65535))];
        if (!Array.isArray(next.scanRoots)) {
            throw new Error('扫描根目录列表必须是数组.');
        }
        next.scanRoots = [...new Set(next.scanRoots
            .map((root) => String(root || '').trim())
            .filter(Boolean)
            .map((root) => path.resolve(root)))];
        if (!next.scanRoots.length) {
            next.scanRoots = [os.homedir()];
        }
        if (!next.sync || typeof next.sync !== 'object') {
            next.sync = { archivePath: '' };
        }
        const nextArchive = this.resolveArchivePath(next.sync.archivePath);
        next.sync.archivePath = nextArchive;
        state.settings = next;
        try {
            if (nextArchive !== this.credentialsPath) {
                this.switchArchive(nextArchive);
            }
        } catch (err) {
            state.settings = previous;
            throw err;
        }
        this.writeDoc('state', state);
        return clone(state.settings);
    }

    getSyncState() {
        return clone(this.docs.state.sync || { baselines: {}, lastRun: null, conflicts: {} });
    }

    setSyncState(patch) {
        const state = this.docs.state;
        state.sync = mergeDeep(state.sync || { baselines: {}, lastRun: null, conflicts: {} }, patch || {});
        this.writeDoc('state', state);
        return clone(state.sync);
    }

    replaceSyncState(sync) {
        const state = this.docs.state;
        state.sync = sync && typeof sync === 'object' ? sync : { baselines: {}, lastRun: null, conflicts: {} };
        this.writeDoc('state', state);
        return clone(state.sync);
    }

    getJudgeState() {
        return clone(this.docs.state.judge);
    }

    setJudgeState(patch) {
        const state = this.docs.state;
        state.judge = mergeDeep(state.judge, patch || {});
        if (Array.isArray(state.judge.history) && state.judge.history.length > 50) {
            state.judge.history = state.judge.history.slice(-50);
        }
        this.writeDoc('state', state);
        return clone(state.judge);
    }
}

module.exports = {
    Oihd,
    DEFAULT_SETTINGS,
    SYNC_MODES,
    encryptSecret,
    decryptSecret,
    defaultDataDir
};
