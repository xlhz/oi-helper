import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';

export interface TestResult {
    id: number;
    status: string;
    timeMs: number;
    memoryKb: number;
    score: number;
    maxScore: number;
    message: string;
    stderr?: string;
    actual?: string;
    expected?: string;
    diffLine?: number;
}

export interface SubtaskResult {
    id: number;
    score: number;
    maxScore: number;
    tests: number[];
}

export interface JudgeResult {
    problem: string;
    env: string;
    isolation: string;
    isolationDegraded: boolean;
    compileMessage: string;
    subtasks: SubtaskResult[];
    tests: TestResult[];
    totalScore: number;
    maxScore: number;
    status: string;
    format?: string;
    solved?: boolean;
}

export interface JudgeCase {
    input: string;
    expected: string;
}

export interface JudgeOptions {
    cwd: string;
    problem?: string;
    src?: string;
    input?: string;
    expected?: string;
    cases?: JudgeCase[];
    env?: string;
    jobs?: number;
    timeLimit?: number;
    memoryLimit?: number;
    standard?: string;
    format?: string;
}

// 定位 oi-judge: 配置优先, 其次安装目录 resources/judge, 最后 workspace 下 core/build/
export function resolveJudgePath(): string | undefined {
    const isWin = process.platform === 'win32';
    const names = isWin ? ['oi-judge.exe', 'oi-judge'] : ['oi-judge', 'oi-judge.exe'];
    const candidates: string[] = [];

    const fromEnv = (process.env.OI_JUDGE_PATH ?? '').trim();
    if (fromEnv) {
        candidates.push(fromEnv);
    }
    const fromAgent = agentJudgePath();
    if (fromAgent) {
        candidates.push(fromAgent);
    }
    const configured = (vscode.workspace.getConfiguration('oiHelper').get<string>('judgePath') ?? '').trim();
    if (configured) {
        candidates.push(configured);
    }
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        for (const name of names) {
            candidates.push(path.join(folder.uri.fsPath, 'core', 'build', name));
        }
    }
    if (isWin) {
        const bases = [
            process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'OI Helper') : '',
            process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'OI Helper') : '',
            process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'OI Helper') : '',
            process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'OI Helper') : ''
        ].filter(Boolean);
        for (const base of bases) {
            for (const name of names) {
                candidates.push(path.join(base, 'resources', 'judge', name));
                candidates.push(path.join(base, 'judge', name));
            }
        }
        candidates.push(...scanInstallDirs(names));
    }
    for (const candidate of candidates) {
        if (candidate && fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return configured || undefined;
}

// 安装到自定义目录时, 在常见安装根目录下按名称扫描 resources/judge
function scanInstallDirs(names: string[]): string[] {
    const localPrograms = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs') : '';
    const roots = [
        localPrograms,
        process.env.ProgramFiles ?? '',
        process.env['ProgramFiles(x86)'] ?? ''
    ].filter(Boolean);
    const found: string[] = [];
    for (const root of roots) {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(root, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries.slice(0, 200)) {
            if (!entry.isDirectory()) {
                continue;
            }
            if (root !== localPrograms && !/oi|helper/i.test(entry.name)) {
                continue;
            }
            for (const name of names) {
                const candidate = path.join(root, entry.name, 'resources', 'judge', name);
                if (fs.existsSync(candidate)) {
                    found.push(candidate);
                }
            }
        }
    }
    return found;
}

// 找不到 judge 时给出可操作的提示
export function judgeHint(): string {
    const base = process.env.LOCALAPPDATA
        ? path.join(process.env.LOCALAPPDATA, 'Programs', 'OI Helper', 'resources', 'judge', 'oi-judge.exe')
        : '%LOCALAPPDATA%\\Programs\\OI Helper\\resources\\judge\\oi-judge.exe';
    return `未找到 oi-judge 可执行文件. 新版安装包应包含 ${base}; 若不存在, 请重新安装最新 OI-Helper-0.1.0-setup.exe, 或在设置中配置 oiHelper.judgePath.`;
}

// 桌面程序在 agent.json 中写入实际 judge 路径, 支持自定义安装目录
function agentJudgePath(): string {
    const appData = process.env.APPDATA;
    if (!appData) {
        return '';
    }
    try {
        const file = path.join(appData, 'OIHelper', 'agent.json');
        if (!fs.existsSync(file)) {
            return '';
        }
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        return typeof data.judgePath === 'string' ? data.judgePath.trim() : '';
    } catch {
        return '';
    }
}

export async function promptJudgePath(): Promise<void> {
    const action = await vscode.window.showErrorMessage(
        judgeHint(),
        '打开设置'
    );
    if (action === '打开设置') {
        await vscode.commands.executeCommand('workbench.action.openSettings', 'oiHelper.judgePath');
    }
}

// 临时目录: 优先 oiHelper.tempDir; 留空时自动选剩余空间最大的盘, 在其下建 oi-helper-temp
let cachedTempRoot: string | undefined;

export function tempRoot(): string {
    if (cachedTempRoot) {
        return cachedTempRoot;
    }
    const configured = (vscode.workspace.getConfiguration('oiHelper').get<string>('tempDir') ?? '').trim();
    if (configured) {
        cachedTempRoot = configured;
    } else {
        let best: string | undefined;
        let bestFree = -1;
        for (let i = 0; i < 26; i += 1) {
            const root = `${String.fromCharCode(65 + i)}:\\`;
            try {
                if (!fs.existsSync(root)) {
                    continue;
                }
                const stat = fs.statfsSync(root);
                const free = stat.bavail * stat.bsize;
                if (free > bestFree) {
                    bestFree = free;
                    best = path.join(root, 'oi-helper-temp');
                }
            } catch {
                // 无权限或不支持 statfs 的盘符跳过
            }
        }
        cachedTempRoot = best ?? os.tmpdir();
    }
    try {
        fs.mkdirSync(cachedTempRoot, { recursive: true });
    } catch {
        cachedTempRoot = os.tmpdir();
    }
    return cachedTempRoot;
}

// 子进程环境: 把 TEMP/TMP 指向临时目录, 使 oi-judge 的临时文件一并转移
export function spawnEnv(): NodeJS.ProcessEnv {
    const dir = tempRoot();
    return { ...process.env, TEMP: dir, TMP: dir };
}

function buildArgs(options: JudgeOptions, jsonPath: string): string[] {
    const args: string[] = [];
    const push = (key: string, value: string | number | undefined): void => {
        if (value !== undefined && value !== '') {
            args.push(key, String(value));
        }
    };
    push('--problem', options.problem);
    push('--src', options.src);
    if (options.cases && options.cases.length > 0) {
        for (const c of options.cases) {
            args.push('--in', c.input, '--out', c.expected);
        }
    } else {
        push('--in', options.input);
        push('--out', options.expected);
    }
    push('--env', options.env);
    push('--jobs', options.jobs);
    push('--time', options.timeLimit);
    push('--memory', options.memoryLimit);
    push('--standard', options.standard);
    push('--format', options.format);
    args.push('--json', jsonPath, '--pretty');
    return args;
}

// 调用 oi-judge 并读取结果 JSON
export function runJudge(exe: string, options: JudgeOptions, output: vscode.OutputChannel): Promise<JudgeResult> {
    const jsonPath = path.join(tempRoot(), `oi-judge-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    const args = buildArgs(options, jsonPath);
    return new Promise<JudgeResult>((resolve, reject) => {
        output.appendLine(`[oi-judge] ${exe} ${args.join(' ')}`);
        output.appendLine(`[oi-judge] cwd: ${options.cwd}`);
        const child = spawn(exe, args, { cwd: options.cwd, windowsHide: true, env: spawnEnv() });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
        child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        child.on('error', (err: Error) => {
            output.appendLine(`[错误] 无法启动 oi-judge: ${err.message}`);
            reject(new Error(`无法启动 oi-judge: ${err.message}`));
        });
        child.on('close', (code: number | null) => {
            if (stdout.trim()) {
                output.appendLine(stdout.trim());
            }
            if (stderr.trim()) {
                output.appendLine(stderr.trim());
            }
            if (code === 2) {
                reject(new Error('oi-judge 报告编译环境不可用 (exit 2).'));
                return;
            }
            if (code === 1) {
                reject(new Error(`oi-judge 用法/内部错误 (exit 1).\n${stderr || stdout}`));
                return;
            }
            if (code !== 0) {
                reject(new Error(`oi-judge 退出码 ${code}.`));
                return;
            }
            if (!fs.existsSync(jsonPath)) {
                reject(new Error(`未找到结果文件: ${jsonPath}`));
                return;
            }
            try {
                const result = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as JudgeResult;
                resolve(result);
            } catch (e) {
                reject(new Error(`结果 JSON 解析失败: ${String(e)}`));
            } finally {
                fs.rmSync(jsonPath, { force: true });
            }
        });
    });
}
