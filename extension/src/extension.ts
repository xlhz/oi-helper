import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { JudgeOptions, JudgeResult, promptJudgePath, resolveJudgePath, runJudge } from './judge';
import { FetchSummary, SubmitSummary, fetchProblemFlow, isContestUrl, isXmojUrl, submitFlow } from './fetch';
import { PanelController } from './panel';
import { ProblemView } from './problemView';
import { ResultsView } from './resultsView';
import { ContestView } from './contestView';
import { CookieHelp } from './cookieHelp';
import { OihClient, OihEvent } from './oihClient';
import { runEnvCheckCommand } from './envCheck';
import { applyEditorConfigCommand } from './workspaceConfig';
import { fixDivisionCommand, fixFreopenCommand, fixYesCaseCommand } from './fix';

let oihClient: OihClient | undefined;

function oihEnabled(): boolean {
    return vscode.workspace.getConfiguration('oiHelper').get<boolean>('oihEnabled', true);
}

function oihNotifyEnabled(): boolean {
    return vscode.workspace.getConfiguration('oiHelper').get<boolean>('oihNotify', true);
}

function workspacePaths(): string[] {
    return (vscode.workspace.workspaceFolders || []).map((folder) => folder.uri.fsPath);
}

function activeWorkspacePath(): string {
    const folders = vscode.workspace.workspaceFolders || [];
    return folders.length > 0 ? folders[0].uri.fsPath : '';
}

// 创建 .oihelper/workspace.json 与 problems/, 已存在时返回可读提示
function ensureWorkspaceStructure(targetPath: string): { ok: boolean; message: string } {
    const target = path.resolve(targetPath);
    const metaFile = path.join(target, '.oihelper', 'workspace.json');
    if (fs.existsSync(metaFile)) {
        return { ok: false, message: `该目录已是工作区: ${target}` };
    }
    fs.mkdirSync(path.join(target, '.oihelper'), { recursive: true });
    fs.mkdirSync(path.join(target, 'problems'), { recursive: true });
    const now = new Date().toISOString();
    fs.writeFileSync(metaFile, JSON.stringify({
        version: 1,
        name: path.basename(target),
        createdAt: now,
        updatedAt: now
    }, null, 4));
    return { ok: true, message: `已创建工作区: ${target}` };
}

export function activate(context: vscode.ExtensionContext): void {
    const output = vscode.window.createOutputChannel('OI Helper');
    const results = new ResultsView(context.extensionUri);
    const preview = new ProblemView(context.extensionUri, output, resolveJudgePath, promptJudgePath);
    const panel = new PanelController(context.extensionUri, output, preview);
    const contest = new ContestView(context.extensionUri, output);
    panel.setResultSink((result) => results.showResult(result));
    panel.setSubmitSink((state) => results.showSubmit(state));
    panel.setStateSink((running) => results.setRunning(running));
    panel.setResultGetter(() => results.lastResult());
    context.subscriptions.push(output);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider('oiHelperResults', results, {
        webviewOptions: { retainContextWhenHidden: true }
    }));
    context.subscriptions.push(vscode.window.registerWebviewViewProvider('oiHelperPanel', panel, {
        webviewOptions: { retainContextWhenHidden: true }
    }));
    context.subscriptions.push(vscode.window.registerWebviewViewProvider('oiHelperContest', contest, {
        webviewOptions: { retainContextWhenHidden: true }
    }));
    context.subscriptions.push(vscode.window.onDidChangeActiveColorTheme(() => panel.refreshTheme()));
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => panel.syncActiveFile()));
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('oiHelper.caseDuplicateHint') || e.affectsConfiguration('oiHelper.caseConflictWarn')) {
            panel.refreshConfig();
        }
        if (e.affectsConfiguration('oiHelper.oihEnabled')) {
            if (oihEnabled()) {
                oihClient?.start();
            } else {
                oihClient?.stop();
            }
        } else if (e.affectsConfiguration('oiHelper')) {
            oihClient?.refreshStatus();
        }
    }));
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
        oihClient?.notifyWorkspaceChanged();
    }));

    oihClient = new OihClient({
        extensionVersion: String((context.extension.packageJSON as { version?: string }).version || '0.0.0'),
        getWorkspacePath: activeWorkspacePath,
        getWorkspacePaths: workspacePaths,
        onOpenWorkspace: async (target: string) => {
            await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target), { forceNewWindow: false });
        },
        onCreateWorkspace: async (target: string) => ensureWorkspaceStructure(target),
        onEvent: (event: OihEvent) => {
            if (!oihNotifyEnabled()) {
                output.appendLine(`[OIH] 通知已关闭, 跳过编辑器提示: ${String(event.payload?.title || event.type || '')}`);
                return;
            }
            const payload = event.payload || {};
            const text = [payload.title || payload.text || event.type || '比赛事件', payload.contest, payload.problem, payload.user]
                .filter(Boolean)
                .join(' · ');
            void vscode.window.showInformationMessage(text);
        },
        onLog: (message) => output.appendLine(`[OIH] ${message}`)
    });
    contest.setEventSink((event) => oihClient?.publishEvent(event));
    context.subscriptions.push({
        dispose: () => {
            oihClient?.dispose();
            oihClient = undefined;
        }
    });
    if (oihEnabled()) {
        oihClient.start();
    }

    const configTarget = (): vscode.ConfigurationTarget => {
        return vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
            ? vscode.ConfigurationTarget.Workspace
            : vscode.ConfigurationTarget.Global;
    };

    async function execute(options: JudgeOptions): Promise<void> {
        const exe = resolveJudgePath();
        if (!exe) {
            await promptJudgePath();
            return;
        }
        let result: JudgeResult;
        try {
            results.setRunning(true);
            result = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'OI 评测中...', cancellable: false },
                () => runJudge(exe, options, output)
            );
        } catch (err) {
            results.setRunning(false);
            output.appendLine(`[错误] ${String(err)}`);
            vscode.window.showErrorMessage(`OI 评测失败: ${String(err)}`);
            return;
        }
        results.showResult(result);
        vscode.window.showInformationMessage(`OI 评测完成: ${result.status} ${result.totalScore}/${result.maxScore}`);
    }

    async function pickFile(placeHolder: string, filterName: string, filterExt: string): Promise<string | undefined> {
        const picked = await vscode.window.showOpenDialog({
            canSelectMany: false,
            canSelectFiles: true,
            canSelectFolders: false,
            title: placeHolder,
            filters: { [filterName]: [filterExt] }
        });
        return picked && picked.length > 0 ? picked[0].fsPath : undefined;
    }

    const judgeFile = async (uri?: vscode.Uri): Promise<void> => {
        let srcPath: string | undefined;
        if (uri && uri.fsPath.toLowerCase().endsWith('.cpp')) {
            srcPath = uri.fsPath;
        } else {
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document.fileName.toLowerCase().endsWith('.cpp')) {
                srcPath = editor.document.fileName;
            }
        }
        if (!srcPath) {
            vscode.window.showWarningMessage('请先打开一个 .cpp 文件.');
            return;
        }
        const dir = path.dirname(srcPath);
        const base = srcPath.slice(0, -'.cpp'.length);
        let input = `${base}.in`;
        let expected = `${base}.ans`;
        // 同名 .in/.ans 不存在时让用户手动选择
        if (!fs.existsSync(input) || !fs.existsSync(expected)) {
            const pickedIn = await pickFile('选择测试点输入 (.in)', 'Input', 'in');
            if (!pickedIn) {
                return;
            }
            const pickedOut = await pickFile('选择测试点预期输出 (.ans)', 'Output', 'ans');
            if (!pickedOut) {
                return;
            }
            input = pickedIn;
            expected = pickedOut;
        }
        const cfg = vscode.workspace.getConfiguration('oiHelper');
        await execute({
            cwd: dir,
            src: srcPath,
            input,
            expected,
            env: cfg.get<string>('env'),
            jobs: cfg.get<number>('jobs'),
            timeLimit: cfg.get<number>('timeLimit'),
            memoryLimit: cfg.get<number>('memoryLimit'),
            standard: cfg.get<string>('standard')
        });
    };

    const judgeProblem = async (): Promise<void> => {
        const picked = await vscode.window.showOpenDialog({
            canSelectMany: false,
            canSelectFiles: false,
            canSelectFolders: true,
            title: '选择题目目录 (含 problem.json)'
        });
        if (!picked || picked.length === 0) {
            return;
        }
        const problemDir = picked[0].fsPath;
        const cfg = vscode.workspace.getConfiguration('oiHelper');
        await execute({
            cwd: problemDir,
            problem: problemDir,
            env: cfg.get<string>('env'),
            jobs: cfg.get<number>('jobs'),
            timeLimit: cfg.get<number>('timeLimit'),
            memoryLimit: cfg.get<number>('memoryLimit'),
            standard: cfg.get<string>('standard')
        });
    };

    // 从 xmoj 网址导入题目到 <workspace>/problems
    const fetchProblem = async (): Promise<void> => {
        const clipboard = await vscode.env.clipboard.readText();
        const prefill = isXmojUrl(clipboard) ? clipboard.trim() : '';
        const url = await vscode.window.showInputBox({
            prompt: '输入题目网址',
            placeHolder: 'https://www.xmoj.tech/problem.php?id=2298',
            value: prefill,
            validateInput: (v) => (v.trim() ? undefined : '请输入题目网址')
        });
        if (!url) {
            return;
        }
        if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
            vscode.window.showErrorMessage('未打开工作区, 无法导入题目.');
            return;
        }
        const exe = resolveJudgePath();
        if (!exe) {
            await promptJudgePath();
            return;
        }
        let summary: FetchSummary;
        try {
            summary = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: '抓取题目中...', cancellable: false },
                () => fetchProblemFlow(url.trim(), exe, output)
            );
        } catch (err) {
            output.appendLine(`[错误] ${String(err)}`);
            vscode.window.showErrorMessage(`抓取题目失败: ${String(err)}`);
            return;
        }
        if (!summary.ok) {
            output.appendLine(`[错误] ${summary.error ?? '抓取失败'}`);
            vscode.window.showErrorMessage(`抓取题目失败: ${summary.error ?? '未知错误'}`);
            return;
        }
        output.appendLine(`[抓取] ${summary.name ?? ''} -> ${summary.dir ?? ''}`);
        for (const warning of summary.warnings ?? []) {
            output.appendLine(`[警告] ${warning}`);
        }
        const attach = summary.attachments ? `, 附件 ${summary.attachments} 个` : '';
        const action = await vscode.window.showInformationMessage(
            `已导入 ${summary.name ?? ''} (${summary.tests ?? 0} 个测试点${attach})`,
            '打开 problem.json'
        );
        if (action === '打开 problem.json' && summary.dir) {
            const jsonPath = path.join(summary.dir, 'problem.json');
            if (fs.existsSync(jsonPath)) {
                await vscode.window.showTextDocument(vscode.Uri.file(jsonPath));
            }
        }
    };

    const selectEnv = async (): Promise<void> => {
        const picked = await vscode.window.showQuickPick(['auto', 'wsl', 'mingw'], {
            placeHolder: '选择评测环境'
        });
        if (!picked) {
            return;
        }
        await vscode.workspace.getConfiguration('oiHelper').update('env', picked, configTarget());
    };

    const setJobs = async (): Promise<void> => {
        const current = vscode.workspace.getConfiguration('oiHelper').get<number>('jobs') ?? 1;
        const value = await vscode.window.showInputBox({
            prompt: '并行度',
            value: String(current),
            validateInput: (v) => (/^\d+$/.test(v) && Number(v) >= 1 ? undefined : '请输入 >= 1 的整数')
        });
        if (!value) {
            return;
        }
        await vscode.workspace.getConfiguration('oiHelper').update('jobs', Number(value), configTarget());
    };

    // 一键提交当前打开的源文件到 xmoj
    const submitSolution = async (): Promise<void> => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('请先打开要提交的源文件.');
            return;
        }
        const filePath = editor.document.fileName;
        const exe = resolveJudgePath();
        if (!exe) {
            await promptJudgePath();
            return;
        }
        let summary: SubmitSummary;
        try {
            summary = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: '提交中...', cancellable: false },
                () => submitFlow(filePath, exe, output)
            );
        } catch (err) {
            output.appendLine(`[错误] ${String(err)}`);
            vscode.window.showErrorMessage(`提交失败: ${String(err)}`);
            return;
        }
        if (!summary.ok) {
            output.appendLine(`[错误] ${summary.error ?? '提交失败'}`);
            vscode.window.showErrorMessage(`提交失败: ${summary.error ?? '未知错误'}`);
            return;
        }
        const pid = summary.problemId !== undefined ? summary.problemId : '未知';
        const action = await vscode.window.showInformationMessage(
            `已提交 ${pid}, 提交号 ${summary.solutionId ?? ''}`,
            '查看评测状态'
        );
        if (action === '查看评测状态' && summary.url) {
            await vscode.env.openExternal(vscode.Uri.parse(summary.url));
        }
    };

    // 设置 xmoj 账号: 写入用户(全局)设置, 抓取与提交自动登录
    const setXmojAccount = async (): Promise<void> => {
        const cfg = vscode.workspace.getConfiguration('oiHelper');
        const curUser = cfg.get<string>('xmojUser') ?? '';
        const curPass = cfg.get<string>('xmojPassword') ?? '';
        const user = await vscode.window.showInputBox({
            prompt: 'xmoj 账号',
            value: curUser,
            validateInput: (v) => (v.trim() ? undefined : '请输入 xmoj 账号')
        });
        if (user === undefined) {
            return;
        }
        const pass = await vscode.window.showInputBox({
            prompt: 'xmoj 密码',
            password: true,
            value: curPass
        });
        if (pass === undefined) {
            return;
        }
        await cfg.update('xmojUser', user.trim(), vscode.ConfigurationTarget.Global);
        await cfg.update('xmojPassword', pass, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage('已保存到扩展设置, 抓取与提交将自动登录.');
    };

    // 在新面板预览题目: 优先用剪贴板里的竞赛/题目链接, 否则手动输入
    const previewProblem = async (): Promise<void> => {
        const clipboard = (await vscode.env.clipboard.readText()).trim();
        const prefill = isContestUrl(clipboard) || isXmojUrl(clipboard) ? clipboard : '';
        const url = await vscode.window.showInputBox({
            prompt: '输入 xmoj 竞赛题目网址',
            placeHolder: 'https://www.xmoj.tech/web/contest/10780/A',
            value: prefill
        });
        if (url && url.trim()) {
            await preview.open(url.trim());
        } else {
            await preview.open();
        }
    };

    const guarded = (run: () => Promise<void>) => async (): Promise<void> => {
        try {
            await run();
        } catch (err) {
            output.appendLine(`[错误] ${String(err)}`);
            vscode.window.showErrorMessage(String(err));
        }
    };

    context.subscriptions.push(
        vscode.commands.registerCommand('oiHelper.openPanel', () => panel.open()),
        vscode.commands.registerCommand('oiHelper.previewProblem', previewProblem),
        vscode.commands.registerCommand('oiHelper.judgeFile', judgeFile),
        vscode.commands.registerCommand('oiHelper.judgeProblem', judgeProblem),
        vscode.commands.registerCommand('oiHelper.fetchProblem', fetchProblem),
        vscode.commands.registerCommand('oiHelper.submitSolution', submitSolution),
        vscode.commands.registerCommand('oiHelper.setXmojAccount', setXmojAccount),
        vscode.commands.registerCommand('oiHelper.cookieHelp', () => new CookieHelp(context.extensionUri).show()),
        vscode.commands.registerCommand('oiHelper.selectEnv', selectEnv),
        vscode.commands.registerCommand('oiHelper.setJobs', setJobs),
        vscode.commands.registerCommand('oiHelper.refresh', () => results.refresh()),
        vscode.commands.registerCommand('oiHelper.openContest', () => contest.open()),
        vscode.commands.registerCommand('oiHelper.loadContest', () => contest.open()),
        vscode.commands.registerCommand('oiHelper.envCheck', guarded(() => runEnvCheckCommand(output))),
        vscode.commands.registerCommand('oiHelper.applyEditorConfig', guarded(() => applyEditorConfigCommand(output))),
        vscode.commands.registerCommand('oiHelper.fixYesCase', guarded(() => fixYesCaseCommand(output))),
        vscode.commands.registerCommand('oiHelper.fixFreopen', guarded(() => fixFreopenCommand(output))),
        vscode.commands.registerCommand('oiHelper.fixDivisionByZero', guarded(() => fixDivisionCommand(output)))
    );
}

export function deactivate(): void {
    oihClient?.dispose();
    oihClient = undefined;
}
