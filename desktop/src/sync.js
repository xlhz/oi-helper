'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { encryptSecret, decryptSecret } = require('./oihd');

const WORKSPACE_FILE = path.join('.oihelper', 'credentials.json');
const DIFF_FIELDS = ['password', 'cookie', 'note'];

function keyOf(oj, username) {
    return `${oj}\u0000${username}`;
}

function plainSecret(value) {
    if (value === undefined || value === null) {
        return '';
    }
    if (typeof value === 'string') {
        return value;
    }
    if (typeof value === 'object') {
        return decryptSecret(value);
    }
    return '';
}

function hashPlain(item) {
    return crypto.createHash('sha256')
        .update(JSON.stringify([item.password || '', item.cookie || '', item.note || '']))
        .digest('hex');
}

function plainItem(input) {
    return {
        oj: String(input.oj || '').trim(),
        username: String(input.username || '').trim(),
        note: String(input.note || ''),
        isDefault: Boolean(input.isDefault),
        password: plainSecret(input.password),
        cookie: plainSecret(input.cookie)
    };
}

function view(item) {
    if (!item) {
        return null;
    }
    return {
        note: item.note || '',
        isDefault: Boolean(item.isDefault),
        passwordPresent: Boolean(item.password),
        cookiePresent: Boolean(item.cookie),
        updatedAt: item.updatedAt || ''
    };
}

function workspaceKey(workspace) {
    return path.resolve(workspace).toLowerCase();
}

class SyncEngine {
    constructor(options = {}) {
        this.oihd = options.oihd;
        this.onLog = typeof options.onLog === 'function' ? options.onLog : () => {};
    }

    log(level, message) {
        this.onLog({ source: 'sync', level, message });
    }

    archiveItems() {
        return this.oihd.readCredentialSecrets().map((item) => ({
            oj: String(item.oj || '').trim(),
            username: String(item.username || '').trim(),
            note: String(item.note || ''),
            isDefault: Boolean(item.isDefault),
            password: item.password || '',
            cookie: item.cookie || ''
        }));
    }

    workspaceFile(workspace) {
        return path.join(workspace, WORKSPACE_FILE);
    }

    readWorkspace(workspace) {
        const dir = path.resolve(String(workspace || ''));
        const file = this.workspaceFile(dir);
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
            throw new Error(`工作区目录不存在: ${dir}`);
        }
        let exists = fs.existsSync(file);
        let list = [];
        if (exists) {
            try {
                const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
                if (Array.isArray(parsed)) {
                    list = parsed;
                } else if (parsed && Array.isArray(parsed.credentials)) {
                    list = parsed.credentials;
                } else if (parsed && Array.isArray(parsed.items)) {
                    list = parsed.items;
                } else {
                    throw new Error('缺少 credentials 数组.');
                }
            } catch (err) {
                throw new Error(`工作区凭据文件不可用 (${file}): ${err.message}`);
            }
        }
        const items = list.map(plainItem).filter((item) => item.oj && item.username);
        return { dir, file, exists, items };
    }

    writeWorkspace(workspace, items) {
        const dir = path.resolve(String(workspace || ''));
        const target = this.workspaceFile(dir);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const now = new Date().toISOString();
        const credentials = items
            .slice()
            .sort((a, b) => `${a.oj}\u0000${a.username}`.localeCompare(`${b.oj}\u0000${b.username}`))
            .map((item) => ({
                oj: item.oj,
                username: item.username,
                note: item.note || '',
                isDefault: Boolean(item.isDefault),
                password: encryptSecret(item.password),
                cookie: encryptSecret(item.cookie),
                updatedAt: now
            }));
        const text = JSON.stringify({ version: 1, updatedAt: now, credentials }, null, 4);
        const tmp = `${target}.tmp`;
        fs.writeFileSync(tmp, text);
        fs.renameSync(tmp, target);
        return { file: target, count: credentials.length };
    }

    workspaceMode(workspace) {
        const key = workspaceKey(workspace);
        const record = this.oihd.listWorkspaces()
            .find((item) => workspaceKey(item.path) === key);
        return (record && record.autoSync) || this.oihd.getSettings().autoSync || 'off';
    }

    compare(workspace, mode) {
        const ws = this.readWorkspace(workspace);
        const archive = this.archiveItems();
        const archiveMap = new Map(archive.map((item) => [keyOf(item.oj, item.username), item]));
        const wsMap = new Map(ws.items.map((item) => [keyOf(item.oj, item.username), item]));
        const keys = [...archiveMap.keys(), ...[...wsMap.keys()].filter((key) => !archiveMap.has(key))];
        const diffMode = mode || this.workspaceMode(ws.dir);
        const baselines = (this.oihd.getSyncState().baselines || {})[workspaceKey(ws.dir)] || {};
        const diffs = [];
        for (const key of keys) {
            const a = archiveMap.get(key);
            const w = wsMap.get(key);
            const item = a || w;
            let kind = '';
            let fields = [];
            if (a && !w) {
                kind = 'archiveOnly';
            } else if (!a && w) {
                kind = 'workspaceOnly';
            } else {
                fields = DIFF_FIELDS.filter((field) => (a[field] || '') !== (w[field] || ''));
                if (!fields.length) {
                    continue;
                }
                kind = 'different';
            }
            let conflict = false;
            if (diffMode === 'both' && kind === 'different') {
                const base = baselines[key];
                conflict = base === undefined
                    ? true
                    : (hashPlain(a) !== base && hashPlain(w) !== base);
            }
            diffs.push({
                key,
                oj: item.oj,
                username: item.username,
                kind,
                fields,
                conflict,
                archive: view(a),
                workspace: view(w)
            });
        }
        let status = 'synced';
        if (!ws.exists) {
            status = 'missing';
        } else if (diffs.length) {
            status = 'diff';
        }
        return {
            workspace: ws.dir,
            file: ws.file,
            exists: ws.exists,
            mode: diffMode,
            status,
            diffs
        };
    }

    status(workspace) {
        try {
            const result = this.compare(workspace);
            return {
                workspace: result.workspace,
                exists: result.exists,
                status: result.status,
                count: result.diffs.length,
                mode: result.mode,
                error: ''
            };
        } catch (err) {
            return {
                workspace: path.resolve(String(workspace || '')),
                exists: false,
                status: 'error',
                count: 0,
                mode: this.workspaceMode(workspace),
                error: err.message
            };
        }
    }

    apply(workspace, keys, action) {
        return this.applyKeys(workspace, keys, action);
    }

    applyKeys(workspace, keys, action) {
        const list = Array.isArray(keys) ? keys.map(String) : [];
        if (!list.length) {
            return { ok: true, changed: 0, workspace: path.resolve(String(workspace || '')), action };
        }
        if (!['skip', 'toArchive', 'toWorkspace'].includes(action)) {
            throw new Error(`未知同步动作: ${action}`);
        }
        const ws = this.readWorkspace(workspace);
        if (action === 'skip') {
            return { ok: true, changed: 0, workspace: ws.dir, action };
        }
        const archive = this.archiveItems();
        const archiveMap = new Map(archive.map((item) => [keyOf(item.oj, item.username), item]));
        let changed = 0;
        if (action === 'toArchive') {
            for (const key of list) {
                const item = new Map(ws.items.map((entry) => [keyOf(entry.oj, entry.username), entry])).get(key);
                if (!item) {
                    continue;
                }
                this.oihd.upsertCredentialPlain(item);
                changed += 1;
            }
        } else {
            const wsMap = new Map(ws.items.map((item) => [keyOf(item.oj, item.username), item]));
            for (const key of list) {
                const item = archiveMap.get(key);
                if (!item) {
                    continue;
                }
                wsMap.set(key, item);
                changed += 1;
            }
            if (changed) {
                this.writeWorkspace(ws.dir, [...wsMap.values()]);
            }
        }
        this.updateBaselines(ws.dir, list);
        return { ok: true, changed, workspace: ws.dir, action };
    }

    updateBaselines(workspace, keys) {
        const ws = this.readWorkspace(workspace);
        const archive = this.archiveItems();
        const archiveMap = new Map(archive.map((item) => [keyOf(item.oj, item.username), item]));
        const wsMap = new Map(ws.items.map((item) => [keyOf(item.oj, item.username), item]));
        const state = this.oihd.getSyncState();
        const baselines = state.baselines || {};
        const map = baselines[workspaceKey(ws.dir)] || {};
        for (const key of keys || []) {
            const a = archiveMap.get(key);
            const w = wsMap.get(key);
            if (a && w && hashPlain(a) === hashPlain(w)) {
                map[key] = hashPlain(a);
            } else {
                delete map[key];
            }
        }
        baselines[workspaceKey(ws.dir)] = map;
        state.baselines = baselines;
        this.oihd.replaceSyncState(state);
    }

    // 覆盖同步: 以总存档为准完整写入工作区
    overwriteWorkspace(workspace) {
        const ws = this.readWorkspace(workspace);
        const archive = this.archiveItems();
        const result = this.writeWorkspace(ws.dir, archive);
        const keys = archive.map((item) => keyOf(item.oj, item.username));
        this.updateBaselines(ws.dir, keys);
        this.log('info', `覆盖同步完成: ${result.count} 条凭据写入工作区.`);
        return { workspace: ws.dir, file: result.file, count: result.count };
    }

    autoRun(workspace) {
        const ws = this.readWorkspace(workspace);
        const mode = this.workspaceMode(ws.dir);
        if (mode === 'off') {
            return { mode, workspace: ws.dir, applied: 0, conflicts: [], skipped: true };
        }
        if (!ws.exists) {
            return { mode, workspace: ws.dir, applied: 0, conflicts: [], skipped: true, reason: '工作区凭据文件不存在' };
        }
        const result = this.compare(ws.dir, mode);
        const archiveMap = new Map(this.archiveItems().map((item) => [keyOf(item.oj, item.username), item]));
        const wsMap = new Map(ws.items.map((item) => [keyOf(item.oj, item.username), item]));
        const baselines = (this.oihd.getSyncState().baselines || {})[workspaceKey(ws.dir)] || {};
        const toArchive = [];
        const toWorkspace = [];
        const conflicts = [];
        for (const diff of result.diffs) {
            if (mode === 'workspaceToArchive') {
                if (diff.kind === 'workspaceOnly' || diff.kind === 'different') {
                    toArchive.push(diff.key);
                }
                continue;
            }
            if (mode === 'archiveToWorkspace') {
                if (diff.kind === 'archiveOnly' || diff.kind === 'different') {
                    toWorkspace.push(diff.key);
                }
                continue;
            }
            if (diff.kind === 'archiveOnly') {
                toWorkspace.push(diff.key);
            } else if (diff.kind === 'workspaceOnly') {
                toArchive.push(diff.key);
            } else if (diff.conflict) {
                conflicts.push(diff.key);
            } else {
                const base = baselines[diff.key];
                const archiveChanged = hashPlain(archiveMap.get(diff.key)) !== base;
                const workspaceChanged = hashPlain(wsMap.get(diff.key)) !== base;
                if (archiveChanged && workspaceChanged) {
                    conflicts.push(diff.key);
                } else if (archiveChanged) {
                    toWorkspace.push(diff.key);
                } else {
                    toArchive.push(diff.key);
                }
            }
        }
        let applied = 0;
        if (toArchive.length) {
            applied += this.applyKeys(ws.dir, toArchive, 'toArchive').changed;
        }
        if (toWorkspace.length) {
            applied += this.applyKeys(ws.dir, toWorkspace, 'toWorkspace').changed;
        }
        const state = this.oihd.getSyncState();
        state.lastRun = {
            at: new Date().toISOString(),
            workspace: ws.dir,
            mode,
            applied,
            conflicts: conflicts.length
        };
        if (!state.conflicts || typeof state.conflicts !== 'object') {
            state.conflicts = {};
        }
        state.conflicts[workspaceKey(ws.dir)] = conflicts;
        this.oihd.replaceSyncState(state);
        const level = conflicts.length ? 'warn' : 'info';
        this.log(level, `自动同步 ${ws.dir} (${mode}): 应用 ${applied} 条, 冲突 ${conflicts.length} 条.`);
        return { mode, workspace: ws.dir, applied, conflicts, skipped: false };
    }

    autoRunAll() {
        const results = [];
        const seen = new Set();
        for (const record of this.oihd.listWorkspaces()) {
            const key = workspaceKey(record.path);
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            try {
                results.push(this.autoRun(record.path));
            } catch (err) {
                this.log('error', `自动同步失败 ${record.path}: ${err.message}`);
                results.push({ workspace: record.path, mode: this.workspaceMode(record.path), applied: 0, conflicts: [], error: err.message });
            }
        }
        return results;
    }
}

module.exports = { SyncEngine };
