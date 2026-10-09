import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { JudgeOptions, runJudge } from './judge';
import { ContestModel, ContestSnapshot } from './contest';

function createNonce(): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let value = '';
    for (let i = 0; i < 32; i += 1) {
        value += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    }
    return value;
}

interface ContestMessage {
    type?: string;
    label?: string;
    name?: string;
    solved?: number;
    penalty?: number;
}

// ICPC 比赛视图: 管理比赛状态与逐题评测
export class ContestView implements vscode.WebviewViewProvider {
    private view: vscode.WebviewView | undefined;

    private model: ContestModel | undefined;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly output: vscode.OutputChannel,
        private readonly getJudgeExe: () => string | undefined
    ) { }

    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        view.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
        };
        view.webview.html = this.renderHtml();
        view.webview.onDidReceiveMessage((message: unknown) => {
            void this.handleMessage(message);
        });
        view.onDidDispose(() => {
            if (this.view === view) {
                this.view = undefined;
            }
        });
    }

    // 选择比赛目录并载入
    async loadContest(): Promise<void> {
        const picked = await vscode.window.showOpenDialog({
            canSelectMany: false,
            canSelectFiles: false,
            canSelectFolders: true,
            title: '选择比赛目录 (含 contest.json)'
        });
        if (!picked || picked.length === 0) {
            return;
        }
        const dir = picked[0].fsPath;
        const model = new ContestModel(dir, this.output);
        try {
            model.load();
        } catch (err) {
            this.output.appendLine(`[错误] 载入比赛失败: ${String(err)}`);
            vscode.window.showErrorMessage(`载入比赛失败: ${String(err)}`);
            return;
        }
        this.model = model;
        this.postState();
    }

    // 聚焦比赛视图
    open(): void {
        void vscode.commands.executeCommand('oiHelperContest.focus');
    }

    // 重新回发当前快照
    refresh(): void {
        this.postState();
    }

    private async handleMessage(message: unknown): Promise<void> {
        if (!message || typeof message !== 'object') {
            return;
        }
        const payload = message as ContestMessage;
        switch (payload.type) {
            case 'ready':
            case 'refresh':
                this.postState();
                break;
            case 'load':
                await this.loadContest();
                break;
            case 'start':
                this.control('start');
                break;
            case 'pause':
                this.control('pause');
                break;
            case 'end':
                this.control('end');
                break;
            case 'reset':
                await this.resetContest();
                break;
            case 'judge':
                await this.runJudgeProblem(payload.label);
                break;
            case 'addOpponent':
                this.addOpponent(payload.name, payload.solved, payload.penalty);
                break;
            default:
                break;
        }
    }

    // 开始/暂停/结束: 操作后保存并回发
    private control(action: 'start' | 'pause' | 'end'): void {
        if (!this.model) {
            this.postToast('warn', '未载入比赛.');
            return;
        }
        if (action === 'start') {
            this.model.start();
        } else if (action === 'pause') {
            this.model.pause();
        } else {
            this.model.end();
        }
        this.model.save();
        this.postState();
    }

    // 重置: 二次确认后恢复初始状态
    private async resetContest(): Promise<void> {
        if (!this.model) {
            this.postToast('warn', '未载入比赛.');
            return;
        }
        const picked = await vscode.window.showWarningMessage('确定重置比赛状态? 所有提交记录将被清空.', { modal: true }, '重置');
        if (picked !== '重置') {
            return;
        }
        this.model.reset();
        this.model.save();
        this.postState();
    }

    private addOpponent(name?: string, solved?: number, penalty?: number): void {
        if (!this.model) {
            this.postToast('warn', '未载入比赛.');
            return;
        }
        const team = (name ?? '').trim();
        if (!team) {
            this.postToast('warn', '请输入对手队名.');
            return;
        }
        this.model.addOpponent(team, Number(solved) || 0, Number(penalty) || 0);
        this.model.save();
        this.postState();
    }

    // 评测某题: 定位题目目录与源文件, 进行中才记录
    private async runJudgeProblem(label?: string): Promise<void> {
        const model = this.model;
        if (!model || !model.config) {
            this.postToast('warn', '未载入比赛.');
            return;
        }
        const problem = model.config.problems.find((p) => p.label === label);
        if (!problem) {
            this.postToast('warn', `未找到题目 ${label ?? ''}.`);
            return;
        }
        const problemDir = path.resolve(model.dir, problem.dir);
        const src = this.findCppInDir(problemDir);
        if (!src) {
            this.postToast('warn', `题目 ${problem.label} 目录下未找到 .cpp 源文件.`);
            return;
        }
        const exe = this.getJudgeExe();
        if (!exe) {
            this.postToast('warn', '未找到 oi-judge, 请配置 oiHelper.judgePath.');
            return;
        }
        const cfg = vscode.workspace.getConfiguration('oiHelper');
        const options: JudgeOptions = {
            cwd: problemDir,
            problem: problemDir,
            src,
            format: 'icpc',
            env: cfg.get<string>('env'),
            jobs: cfg.get<number>('jobs'),
            timeLimit: cfg.get<number>('timeLimit'),
            memoryLimit: cfg.get<number>('memoryLimit'),
            standard: cfg.get<string>('standard')
        };
        this.view?.webview.postMessage({ type: 'running', label: problem.label });
        this.output.appendLine(`[比赛] 评测 ${problem.label}: ${src}`);
        try {
            const result = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `评测 ${problem.label} 中...`, cancellable: false },
                () => runJudge(exe, options, this.output)
            );
            const solved = result.solved === true;
            if (model.state.status === 'running') {
                model.recordSubmission(problem.label, result.status);
                this.postToast(solved ? 'info' : 'warn', `${problem.label} ${result.status}${solved ? ' (通过)' : ''}`);
            } else {
                this.postToast('warn', '比赛未在进行, 本次评测不记录.');
            }
            this.postState();
        } catch (err) {
            this.output.appendLine(`[错误] 评测 ${problem.label} 失败: ${String(err)}`);
            this.postToast('warn', `评测失败: ${String(err)}`);
        }
    }

    // 在题目目录下查找第一个 .cpp 文件
    private findCppInDir(dir: string): string | undefined {
        try {
            const files = fs.readdirSync(dir);
            for (const f of files) {
                if (f.toLowerCase().endsWith('.cpp')) {
                    return path.join(dir, f);
                }
            }
        } catch { /* 目录不存在等异常忽略 */ }
        return undefined;
    }

    private postState(): void {
        const payload: ContestSnapshot | null = this.model ? this.model.snapshot() : null;
        this.view?.webview.postMessage({ type: 'state', payload });
    }

    private postToast(level: 'info' | 'warn', message: string): void {
        this.view?.webview.postMessage({ type: 'toast', level, message });
    }

    private renderHtml(): string {
        const filePath = vscode.Uri.joinPath(this.extensionUri, 'media', 'contest-panel.html').fsPath;
        const nonce = createNonce();
        const cspSource = this.view ? this.view.webview.cspSource : '';
        return fs.readFileSync(filePath, 'utf8')
            .replace(/__NONCE__/g, nonce)
            .replace(/__CSP_SOURCE__/g, cspSource);
    }
}