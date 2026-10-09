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

// 定位 oi-judge: 配置优先, 其次 workspace 下 core/build/
export function resolveJudgePath(): string | undefined {
    const configured = (vscode.workspace.getConfiguration('oiHelper').get<string>('judgePath') ?? '').trim();
    if (configured && fs.existsSync(configured)) {
        return configured;
    }
    const isWin = process.platform === 'win32';
    const names = isWin ? ['oi-judge.exe', 'oi-judge'] : ['oi-judge', 'oi-judge.exe'];
    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const folder of folders) {
        for (const name of names) {
            const candidate = path.join(folder.uri.fsPath, 'core', 'build', name);
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
    }
    return configured || undefined;
}

export async function promptJudgePath(): Promise<void> {
    const action = await vscode.window.showErrorMessage(
        '未找到 oi-judge 可执行文件. 请配置 oiHelper.judgePath, 或将其放在 core/build/ 下.',
        '打开设置'
    );
    if (action === '打开设置') {
        await vscode.commands.executeCommand('workbench.action.openSettings', 'oiHelper.judgePath');
    }
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
    const jsonPath = path.join(os.tmpdir(), `oi-judge-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    const args = buildArgs(options, jsonPath);
    return new Promise<JudgeResult>((resolve, reject) => {
        output.appendLine(`[oi-judge] ${exe} ${args.join(' ')}`);
        output.appendLine(`[oi-judge] cwd: ${options.cwd}`);
        const child = spawn(exe, args, { cwd: options.cwd, windowsHide: true });
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
