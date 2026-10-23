'use strict';

const fs = require('fs');
const path = require('path');

const MAX_DEPTH = 3;
const MAX_DIRS = 3000;
const MAX_WORKSPACES = 200;
const SKIP_NAMES = new Set([
    'node_modules',
    '.git',
    'AppData',
    '$Recycle.Bin',
    'System Volume Information',
    '.cache'
]);

function workspaceMetaFile(dir) {
    return path.join(dir, '.oihelper', 'workspace.json');
}

function extractServerAddress(meta) {
    if (!meta || typeof meta !== 'object') {
        return '';
    }
    const server = meta.server !== undefined ? meta.server : (meta.serverAddress || meta.serverUrl);
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
    return String(meta.serverAddress || meta.serverUrl || '').trim();
}

function readWorkspace(dir) {
    const file = workspaceMetaFile(dir);
    let meta = null;
    let status = 'ok';
    try {
        meta = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
            meta = null;
            status = 'invalid';
        }
    } catch {
        status = 'invalid';
    }
    const name = meta && (meta.name || meta.title)
        ? String(meta.name || meta.title).trim()
        : path.basename(dir);
    return {
        name: name || path.basename(dir),
        path: path.resolve(dir),
        status,
        serverAddress: extractServerAddress(meta),
        meta
    };
}

async function scanWorkspaces(roots, options = {}) {
    const maxDepth = Number(options.maxDepth) > 0 ? Number(options.maxDepth) : MAX_DEPTH;
    const maxDirs = Number(options.maxDirs) > 0 ? Number(options.maxDirs) : MAX_DIRS;
    const maxWorkspaces = Number(options.maxWorkspaces) > 0 ? Number(options.maxWorkspaces) : MAX_WORKSPACES;
    const queue = [];
    const seen = new Set();
    const items = [];
    const errors = [];
    let scannedDirs = 0;

    for (const root of roots || []) {
        const start = path.resolve(String(root || '').trim());
        if (!start || seen.has(start.toLowerCase())) {
            continue;
        }
        try {
            if (fs.statSync(start).isDirectory()) {
                queue.push({ dir: start, depth: 0 });
            } else {
                errors.push(`扫描根目录不是目录: ${start}`);
            }
        } catch (err) {
            errors.push(`扫描根目录不可用 (${start}): ${err.message}`);
        }
    }

    while (queue.length && scannedDirs < maxDirs && items.length < maxWorkspaces) {
        const current = queue.shift();
        const key = current.dir.toLowerCase();
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        scannedDirs += 1;

        if (fs.existsSync(workspaceMetaFile(current.dir))) {
            items.push(readWorkspace(current.dir));
        }

        if (current.depth >= maxDepth) {
            continue;
        }
        let entries = [];
        try {
            entries = await fs.promises.readdir(current.dir, { withFileTypes: true });
        } catch (err) {
            if (errors.length < 20) {
                errors.push(`读取目录失败 (${current.dir}): ${err.message}`);
            }
            continue;
        }
        for (const entry of entries) {
            if (!entry.isDirectory() || SKIP_NAMES.has(entry.name)) {
                continue;
            }
            queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
        }
    }

    return {
        items,
        scannedDirs,
        truncated: scannedDirs >= maxDirs || items.length >= maxWorkspaces,
        errors
    };
}

// 输入 host:port 或 http(s)://地址, 统一为用于 /health 探测的 origins
function normalizeInstanceAddress(input) {
    let text = String(input || '').trim();
    if (!text) {
        return null;
    }
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
        text = `http://${text}`;
    }
    let url;
    try {
        url = new URL(text);
    } catch {
        return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return null;
    }
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    const host = url.hostname;
    if (!host) {
        return null;
    }
    return {
        url: `${url.protocol}//${host}:${port}`,
        address: `${host}:${port}`
    };
}

function createWorkspaceStructure(dir, name) {
    const target = path.resolve(String(dir || '').trim());
    if (!target) {
        throw new Error('工作区目录不能为空.');
    }
    const file = workspaceMetaFile(target);
    if (fs.existsSync(file)) {
        throw new Error(`该目录已是工作区: ${target}`);
    }
    fs.mkdirSync(target, { recursive: true });
    fs.mkdirSync(path.join(target, '.oihelper'), { recursive: true });
    fs.mkdirSync(path.join(target, 'problems'), { recursive: true });
    const workspaceName = String(name || '').trim() || path.basename(target);
    const now = new Date().toISOString();
    const doc = {
        version: 1,
        name: workspaceName,
        createdAt: now,
        updatedAt: now
    };
    fs.writeFileSync(file, JSON.stringify(doc, null, 4));
    return { path: target, name: workspaceName };
}

module.exports = {
    scanWorkspaces,
    normalizeInstanceAddress,
    createWorkspaceStructure,
    readWorkspace,
    workspaceMetaFile
};
