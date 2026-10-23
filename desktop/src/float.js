'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { BrowserWindow, dialog, screen, shell } = require('electron');
const { defaultDataDir } = require('./util');

const STATE_FILE = 'float-window.json';
const DEFAULT_WIDTH = 380;
const DEFAULT_HEIGHT = 480;
const MIN_WIDTH = 320;
const MIN_HEIGHT = 280;

function readStateFile(file) {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function writeStateFile(file, doc) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 4));
    fs.renameSync(tmp, file);
}

function normalizeBounds(input) {
    const bounds = input && typeof input === 'object' ? input : {};
    const width = Number(bounds.width);
    const height = Number(bounds.height);
    const x = Number(bounds.x);
    const y = Number(bounds.y);
    if (![x, y, width, height].every(Number.isFinite)) {
        return null;
    }
    return {
        x: Math.round(x),
        y: Math.round(y),
        width: Math.max(MIN_WIDTH, Math.round(width)),
        height: Math.max(MIN_HEIGHT, Math.round(height))
    };
}

function defaultBounds() {
    const area = screen.getPrimaryDisplay().workArea;
    return {
        x: area.x + Math.round((area.width - DEFAULT_WIDTH) / 2),
        y: area.y + Math.round((area.height - DEFAULT_HEIGHT) / 2),
        width: DEFAULT_WIDTH,
        height: DEFAULT_HEIGHT
    };
}

// 窗口至少要有 80x80 落在某个屏幕工作区内才算可见, 否则回落到默认位置
function boundsVisible(bounds) {
    return screen.getAllDisplays().some((display) => {
        const area = display.workArea;
        const overlapX = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x);
        const overlapY = Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y);
        return overlapX >= 80 && overlapY >= 80;
    });
}

function readProblem(problemDir) {
    const dir = String(problemDir || '').trim();
    if (!dir) {
        return null;
    }
    const file = path.join(dir, 'problem.json');
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!parsed || typeof parsed !== 'object') {
            return null;
        }
        return {
            name: String(parsed.name || path.basename(dir)),
            type: String(parsed.type || 'traditional'),
            timeLimit: parsed.timeLimit,
            memoryLimit: parsed.memoryLimit,
            url: String(parsed.url || parsed.problemUrl || ''),
            tests: Array.isArray(parsed.tests)
                ? parsed.tests.map((item) => ({ id: Number(item.id), in: String(item.in || ''), out: String(item.out || '') }))
                : [],
            subtasks: Array.isArray(parsed.subtasks)
                ? parsed.subtasks.map((item) => ({ id: Number(item.id), score: Number(item.score), tests: (item.tests || []).map(Number) }))
                : []
        };
    } catch {
        return null;
    }
}

class FloatWindowManager {
    constructor(options = {}) {
        this.dataDir = options.dataDir || defaultDataDir();
        this.file = path.join(this.dataDir, STATE_FILE);
        this.judge = typeof options.judge === 'function' ? options.judge : null;
        this.getLastRun = typeof options.getLastRun === 'function' ? options.getLastRun : () => null;
        this.isEnabled = typeof options.isEnabled === 'function' ? options.isEnabled : () => false;
        this.onVisibilityChange = typeof options.onVisibilityChange === 'function' ? options.onVisibilityChange : () => {};
        this.onLog = typeof options.onLog === 'function' ? options.onLog : () => {};
        this.win = null;
        this.quitting = false;
        this.saveTimer = null;
        const stored = readStateFile(this.file);
        const bounds = normalizeBounds(stored.bounds);
        this.state = {
            bounds: bounds && boundsVisible(bounds) ? bounds : defaultBounds(),
            problemDir: typeof stored.problemDir === 'string' ? stored.problemDir : '',
            // null 表示全部测试点, 数组表示显式勾选
            selectedTests: Array.isArray(stored.selectedTests) ? stored.selectedTests.map(Number).filter(Number.isFinite) : null
        };
    }

    save() {
        if (this.win && !this.win.isDestroyed() && this.win.isVisible()) {
            this.state.bounds = this.win.getBounds();
        }
        writeStateFile(this.file, this.state);
    }

    scheduleSave() {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
        }
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            try {
                this.save();
            } catch (err) {
                this.onLog({ source: 'float', level: 'warn', message: `保存悬浮窗位置失败: ${err.message}` });
            }
        }, 300);
    }

    createWindow() {
        if (this.win && !this.win.isDestroyed()) {
            return this.win;
        }
        const bounds = this.state.bounds;
        this.win = new BrowserWindow({
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
            minWidth: MIN_WIDTH,
            minHeight: MIN_HEIGHT,
            frame: false,
            resizable: true,
            alwaysOnTop: true,
            skipTaskbar: false,
            show: false,
            title: 'OI Helper 悬浮窗',
            backgroundColor: '#f2f3f5',
            webPreferences: {
                preload: path.join(__dirname, 'preload.js'),
                contextIsolation: true,
                nodeIntegration: false
            }
        });
        // screen-saver 层级可覆盖 OICPP / Dev-C++ 等普通前台窗口
        this.win.setAlwaysOnTop(true, 'screen-saver');
        this.win.setMenuBarVisibility(false);
        this.win.loadFile(path.join(__dirname, '..', 'float', 'index.html'));
        this.win.once('ready-to-show', () => {
            if (this.win && !this.win.isDestroyed() && this.isEnabled()) {
                this.win.show();
            }
        });
        this.win.on('move', () => this.scheduleSave());
        this.win.on('resize', () => this.scheduleSave());
        this.win.on('close', (event) => {
            if (this.quitting) {
                return;
            }
            event.preventDefault();
            this.hide();
        });
        this.win.on('closed', () => {
            this.win = null;
        });
        return this.win;
    }

    show() {
        const win = this.createWindow();
        if (win.isMinimized()) {
            win.restore();
        }
        win.show();
        win.focus();
        this.onVisibilityChange(true);
        this.refresh();
        return true;
    }

    hide() {
        if (this.win && !this.win.isDestroyed()) {
            try {
                this.save();
            } catch (err) {
                this.onLog({ source: 'float', level: 'warn', message: `保存悬浮窗状态失败: ${err.message}` });
            }
            this.win.hide();
        }
        this.onVisibilityChange(false);
        return true;
    }

    setVisible(enabled) {
        if (enabled) {
            return this.show();
        }
        return this.hide();
    }

    toggle() {
        const next = !this.isEnabled();
        this.setVisible(next);
        return next;
    }

    destroy() {
        this.quitting = true;
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        if (this.win && !this.win.isDestroyed()) {
            this.save();
            this.win.destroy();
        }
        this.win = null;
    }

    problem() {
        return this.state.problemDir ? readProblem(this.state.problemDir) : null;
    }

    snapshot() {
        const problem = this.problem();
        const allIds = problem ? problem.tests.map((item) => item.id) : [];
        const selected = this.state.selectedTests === null
            ? null
            : this.state.selectedTests.filter((id) => allIds.includes(id));
        return {
            visible: Boolean(this.win && !this.win.isDestroyed() && this.win.isVisible()),
            enabled: Boolean(this.isEnabled()),
            problemDir: this.state.problemDir,
            problem,
            selectedTests: selected,
            lastRun: this.getLastRun()
        };
    }

    refresh() {
        if (this.win && !this.win.isDestroyed()) {
            this.win.webContents.send('oih:float:state', this.snapshot());
        }
    }

    setProblem(dir) {
        const target = path.resolve(String(dir || '').trim());
        if (!fs.existsSync(path.join(target, 'problem.json'))) {
            throw new Error('所选目录缺少 problem.json.');
        }
        this.state.problemDir = target;
        this.state.selectedTests = null;
        this.save();
        this.refresh();
        return this.snapshot();
    }

    async pickProblem() {
        const options = { title: '选择题目目录', properties: ['openDirectory'] };
        const picked = this.win && !this.win.isDestroyed()
            ? await dialog.showOpenDialog(this.win, options)
            : await dialog.showOpenDialog(options);
        if (picked.canceled || !picked.filePaths.length) {
            return { ok: false, canceled: true, state: this.snapshot() };
        }
        const state = this.setProblem(picked.filePaths[0]);
        return { ok: true, state };
    }

    setSelection(ids) {
        const problem = this.problem();
        const allIds = problem ? problem.tests.map((item) => item.id) : [];
        const selected = Array.isArray(ids)
            ? [...new Set(ids.map(Number).filter((id) => allIds.includes(id)))]
            : null;
        // 勾选覆盖全部测试点时回到 null, 之后新增测试点会自动纳入
        this.state.selectedTests = selected && selected.length === allIds.length ? null : selected;
        this.save();
        this.refresh();
        return this.snapshot();
    }

    async runJudge(payload) {
        if (!this.judge) {
            throw new Error('评测服务未就绪.');
        }
        const problemDir = String(payload && payload.problemDir || this.state.problemDir || '').trim();
        if (!problemDir) {
            throw new Error('请先选择题目目录.');
        }
        const result = await this.judge({ problemDir, tests: payload && payload.tests });
        this.refresh();
        return { result, state: this.snapshot() };
    }

    openProblem() {
        const problem = this.problem();
        const url = problem && problem.url;
        if (url) {
            return shell.openExternal(url).then(() => ({ ok: true, target: url }));
        }
        const dir = this.state.problemDir;
        if (!dir) {
            throw new Error('请先选择题目目录.');
        }
        const editor = String(process.env.OI_HELPER_EDITOR || 'code').trim();
        return new Promise((resolve) => {
            let settled = false;
            const fallback = (reason) => {
                if (settled) {
                    return;
                }
                settled = true;
                shell.openPath(dir).then((error) => {
                    resolve(error
                        ? { ok: false, error: `${reason}; 打开目录失败: ${error}` }
                        : { ok: true, target: dir, fallback: 'explorer' });
                }).catch((err) => resolve({ ok: false, error: `${reason}; ${err.message}` }));
            };
            try {
                const child = spawn(editor, [dir], { shell: true, windowsHide: true, stdio: 'ignore' });
                child.on('error', (err) => fallback(`无法启动 ${editor}: ${err.message}`));
                child.on('close', (code) => {
                    if (code === 0) {
                        settled = true;
                        resolve({ ok: true, target: dir, editor });
                    } else {
                        fallback(`${editor} 退出码 ${code}`);
                    }
                });
            } catch (err) {
                fallback(`无法启动 ${editor}: ${err.message}`);
            }
        });
    }

    debug() {
        const win = this.win;
        if (!win || win.isDestroyed()) {
            return { exists: false, enabled: Boolean(this.isEnabled()) };
        }
        return {
            exists: true,
            visible: win.isVisible(),
            enabled: Boolean(this.isEnabled()),
            alwaysOnTop: win.isAlwaysOnTop(),
            resizable: win.isResizable(),
            frame: false,
            bounds: win.getBounds(),
            minimumSize: win.getMinimumSize()
        };
    }

    registerIpc(ipcMain) {
        ipcMain.handle('oih:float:state', () => this.snapshot());
        ipcMain.handle('oih:float:pick-problem', () => this.pickProblem());
        ipcMain.handle('oih:float:set-problem', (_event, dir) => this.setProblem(dir));
        ipcMain.handle('oih:float:set-selection', (_event, ids) => this.setSelection(ids));
        ipcMain.handle('oih:float:judge', (_event, payload) => this.runJudge(payload || {}));
        ipcMain.handle('oih:float:open-problem', () => this.openProblem());
        ipcMain.handle('oih:float:minimize', () => {
            if (this.win && !this.win.isDestroyed()) {
                this.win.minimize();
            }
            return true;
        });
        ipcMain.handle('oih:float:close', () => this.hide());
        ipcMain.handle('oih:float:toggle', () => this.toggle());
        ipcMain.handle('oih:float:debug', () => this.debug());
    }
}

module.exports = { FloatWindowManager };
