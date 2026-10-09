import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JudgeCase, JudgeOptions, JudgeResult, promptJudgePath, resolveJudgePath, runJudge } from './judge';
import { ContestSummary, FetchSummary, OriginalSubmitSummary, OriginalSummary, SubmitSummary, cleanUrl, clearOriginalCache, contestProblemUrl, downloadUrlOf, fetchContestFlow, fetchExtraFlow, fetchOriginalFlow, fetchProblemFlow, isContestUrl, isLuoguUrl, isXmojUrl, oldContestUrlToNew, runSubmitResult, runSubmitResultHydro, runSubmitResultLuogu, submitFlow, submitOriginalFlow } from './fetch';
import { OriginalRef, ojLabel, parseOriginals } from './original';
import { ProblemView } from './problemView';
import type { SubmitViewState } from './resultsView';

// 画布页面 ID -> media 下的 HTML 文件
const PAGE_FILES: { [pageId: string]: string } = {
    'page-judge-panel': 'judge-panel.html'
};

const PAGE_TITLES: { [pageId: string]: string } = {
    'page-judge-panel': 'OI 评测'
};

// HTML 里的 data-dom-id -> 画布页面 ID
const NAV_TARGETS: { [domId: string]: string } = {
    'nav-judge': 'page-judge-panel'
};

function createNonce(): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let value = '';
    for (let i = 0; i < 32; i += 1) {
        value += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    }
    return value;
}

function isLightTheme(): boolean {
    const kind = vscode.window.activeColorTheme.kind;
    return kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight;
}

// 面板表单里的路径: 相对路径按工作区根解析为绝对路径
function toAbsolute(value?: string): string | undefined {
    if (!value) {
        return undefined;
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return undefined;
    }
    if (path.isAbsolute(trimmed)) {
        return trimmed;
    }
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0 ? path.join(folders[0].uri.fsPath, trimmed) : trimmed;
}

// 由题目 URL 判断 OJ 名称, 用于导入测试点的标签
function ojName(url: string): string {
    if (isXmojUrl(url)) {
        return 'XMOJ';
    }
    if (isLuoguUrl(url)) {
        return '洛谷';
    }
    try {
        return new URL(url).hostname.replace(/^www\./, '') || '题目';
    } catch {
        return '题目';
    }
}

// 在 main 函数开头插入 freopen 语句; 源码中已有的 freopen 行会被替换, 避免重复
function insertFreopen(text: string, inName: string, outName: string): string | undefined {
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/).filter((line) => !/^\s*freopen\s*\(/.test(line));
    const joined = lines.join(eol);
    const mainIdx = joined.search(/\bint\s+main\s*\(/);
    if (mainIdx < 0) {
        return undefined;
    }
    let at = joined.indexOf('{', mainIdx);
    if (at < 0) {
        return undefined;
    }
    // 跳过 main 开头已有的读写加速语句, freopen 紧跟在最后一条 IO 语句下面
    let insertAt = at + 1;
    let scan = at + 1;
    while (scan < joined.length) {
        const lineEnd = joined.indexOf('\n', scan);
        const raw = joined.slice(scan, lineEnd < 0 ? joined.length : lineEnd);
        const line = raw.trim();
        if (line) {
            if (!/sync_with_stdio|cin\s*\.\s*tie|cout\s*\.\s*tie/.test(line)) {
                break;  // 真正的第一条语句: 插在它前面
            }
            insertAt = (lineEnd < 0) ? joined.length : lineEnd;
        }
        if (lineEnd < 0) {
            break;
        }
        scan = lineEnd + 1;
    }
    const snippet = `${eol}    freopen("${inName}", "r", stdin);${eol}    freopen("${outName}", "w", stdout);`;
    return joined.slice(0, insertAt) + snippet + joined.slice(insertAt);
}

// 在 main 函数开头插入读写加速语句; 源码中已有的同内容行会被替换, 避免重复
function insertFastIO(text: string, snippet: string): string | undefined {
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const body = snippet.split(/\r?\n/).map((l) => l.trim()).filter((l) => l).join(eol + '    ');
    if (!body) {
        return undefined;
    }
    const lines = text.split(/\r?\n/).filter((line) => !/sync_with_stdio|cin\.tie|cout\.tie/.test(line));
    const joined = lines.join(eol);
    const mainIdx = joined.search(/\bint\s+main\s*\(/);
    if (mainIdx < 0) {
        return undefined;
    }
    const braceIdx = joined.indexOf('{', mainIdx);
    if (braceIdx < 0) {
        return undefined;
    }
    return joined.slice(0, braceIdx + 1) + eol + '    ' + body + joined.slice(braceIdx + 1);
}

// 删除源码中所有 freopen 行
function removeFreopen(text: string): string {
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    return text.split(/\r?\n/).filter((line) => !/^\s*freopen\s*\(/.test(line)).join(eol);
}

// 删除源码中所有读写加速行
function removeFastIO(text: string): string {
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    return text.split(/\r?\n/).filter((line) => !/sync_with_stdio|cin\s*\.\s*tie|cout\s*\.\s*tie/.test(line)).join(eol);
}

// 解析手动输入的 freopen 文件名:
// a) 只填名字(如 x) -> x.in / x.out; b) 填 x.in 或 x.out -> 补全另一个; c) 填两个 -> 原样使用
function parseFreopenSpec(text: string): { in: string; out: string } | undefined {
    const t = (text ?? '').trim();
    if (!t) {
        return undefined;
    }
    const parts = t.split(/\s+/);
    if (parts.length >= 2) {
        return { in: parts[0], out: parts[1] };
    }
    const lower = t.toLowerCase();
    if (lower.endsWith('.in')) {
        return { in: t, out: t.slice(0, -3) + '.out' };
    }
    if (lower.endsWith('.out') || lower.endsWith('.ans')) {
        return { in: t.replace(/\.[^./\\]+$/, '.in'), out: t };
    }
    return { in: t + '.in', out: t + '.out' };
}

// 面板表单字段
interface JudgeInputs {
    problemDir?: string;
    sourceFile?: string;
    cases?: { kind?: string; input?: string; expected?: string }[];
    pasteCases?: { input?: string; expected?: string }[];
}

// 面板消息: 表单字段 + 控制字段
interface PanelMessage extends JudgeInputs {
    type?: string;
    domId?: string;
    index?: number;
    field?: string;
    dir?: string;
    url?: string;
    file?: string;
    sampleMode?: string;
    num?: string;
    level?: string;
    text?: string;
    count?: number;
    oj?: number; // 原题功能: 选中的站点下标
}

// 最近一次网址导入的题目信息: 无 problem.json 时供 freopen 回退使用
interface FetchedProblem {
    dir?: string;
    name?: string;
    freopenIn?: string;
    freopenOut?: string;
}

// Webview 面板控制器: 侧边栏视图 + 独立面板 + 页面导航 + 真实评测接通
export class PanelController implements vscode.WebviewViewProvider {
    private panel: vscode.WebviewPanel | undefined;

    private view: vscode.WebviewView | undefined;

    private currentPage = 'page-judge-panel';

    private rendered = false;

    private resultSink: ((result: JudgeResult) => void) | undefined;

    private stateSink: ((running: boolean) => void) | undefined;

    private resultGetter: (() => JudgeResult | undefined) | undefined;

    private submitSink: ((state: SubmitViewState) => void) | undefined;

    private lastFetch: FetchedProblem | undefined;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly output: vscode.OutputChannel,
        private readonly preview: ProblemView
    ) {
        // 预览面板切换题目时, 同步评测面板的导航行/来源/更多样例
        this.preview.onDidChange((state) => {
            this.extraToken += 1; // 作废上一题未完成的更多样例下载
            this.postNavState();
            this.setSource(state.source);
            this.applyDownload(state.download, state.problemId, state.contestId, state.num);
        });
    }

    // 由导航状态刷新「更多样例」下载信息(换题后按钮才会指向新题目)
    private applyDownload(download?: string, problemId?: string, contestId?: string, num?: string): void {
        const url = downloadUrlOf(download);
        const dir = this.problemDir(problemId, contestId, num);
        this.lastDownload = (url && dir) ? { url, dir } : undefined;
    }

    // 当前承载页面渲染的 webview: 优先侧边栏视图, 其次独立面板
    private get webview(): vscode.Webview | undefined {
        return this.view ? this.view.webview : this.panel?.webview;
    }

    // 注册为侧边栏视图提供者
    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
        };
        webviewView.onDidDispose(() => {
            if (this.view === webviewView) {
                this.view = undefined;
                this.rendered = false;
            }
        });
        webviewView.webview.onDidReceiveMessage((message: unknown) => {
            void this.handleMessage(message);
        });
        this.rendered = false;
        void this.navigate(this.currentPage, true);
    }

    async open(pageId = 'page-judge-panel'): Promise<void> {
        if (this.view) {
            void vscode.commands.executeCommand('oiHelperPanel.focus');
            await this.navigate(pageId);
            return;
        }
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.Active);
            await this.navigate(pageId);
            return;
        }
        this.panel = vscode.window.createWebviewPanel(
            'oiHelperPanel',
            PAGE_TITLES[pageId] || 'OI Helper',
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
            }
        );
        this.panel.onDidDispose(() => {
            this.panel = undefined;
            this.rendered = false;
        });
        this.panel.webview.onDidReceiveMessage((message: unknown) => {
            void this.handleMessage(message);
        });
        this.currentPage = pageId;
        await this.navigate(pageId);
    }

    // 评测结果转交给右侧「评测结果」视图
    setResultSink(sink: (result: JudgeResult) => void): void {
        this.resultSink = sink;
    }

    // 提交结果(自动轮询)转交给右侧「评测结果」视图
    setSubmitSink(sink: (state: SubmitViewState) => void): void {
        this.submitSink = sink;
    }

    // 评测激活/结束时通知右侧视图切换等待态
    setStateSink(sink: (running: boolean) => void): void {
        this.stateSink = sink;
    }

    // 提交前读取最近一次评测结果, 用于判断是否 AC
    setResultGetter(getter: () => JudgeResult | undefined): void {
        this.resultGetter = getter;
    }

    // 编辑器主题变化时同步面板明暗
    refreshTheme(): void {
        this.sendTheme();
    }

    // 面板请求的弹窗提示: 警告/错误/信息三档
    private notify(level: string | undefined, text: string | undefined): void {
        const msg = text ?? '';
        if (!msg) {
            return;
        }
        if (level === 'error') {
            void vscode.window.showErrorMessage(msg);
        } else if (level === 'info') {
            void vscode.window.showInformationMessage(msg);
        } else {
            void vscode.window.showWarningMessage(msg);
        }
    }

    // 一键打开测试点文件: 相对路径按题目目录或工作区根解析
    private async openCaseFile(file?: string, dir?: string): Promise<void> {
        const value = (file ?? '').trim();
        if (!value) {
            return;
        }
        const base = toAbsolute(dir) ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const target = path.isAbsolute(value) ? value : base ? path.join(base, value) : value;
        if (!fs.existsSync(target)) {
            void vscode.window.showWarningMessage(`文件不存在: ${target}`);
            return;
        }
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(target));
    }

    // 导入新题目时询问是否删除面板上已有的测试点
    private async confirmClearCases(count: number): Promise<void> {
        const pick = await vscode.window.showWarningMessage(
            `面板已有 ${count} 个测试点, 导入新题目是否先删除?`,
            { modal: true },
            '删除旧测试点',
            '保留'
        );
        this.webview?.postMessage({ type: 'clearCasesResult', remove: pick === '删除旧测试点' });
    }

    // 相关设置变化时重新下发测试点提示开关
    refreshConfig(): void {
        this.sendCaseRules();
    }

    // 面板当前是否已打开
    isOpen(): boolean {
        return this.panel !== undefined || this.view !== undefined;
    }

    // 切换编辑器时把当前 .cpp 同步到面板(不预置测试点)
    syncActiveFile(): void {
        if (!this.isOpen()) {
            return;
        }
        const src = this.activeCppFile();
        if (!src) {
            return;
        }
        this.webview?.postMessage({ type: 'path-value', field: 'sourceFile', value: src });
        this.webview?.postMessage({ type: 'path-value', field: 'problemDir', value: path.dirname(src) });
    }

    private async handleMessage(message: unknown): Promise<void> {
        if (!message || typeof message !== 'object') {
            return;
        }
        const payload = message as PanelMessage;
        switch (payload.type) {
            case 'ready':
                this.sendTheme();
                this.sendCaseRules();
                this.pushActiveFile();
                this.postNavState();
                this.postOrigState();
                break;
            case 'navigate':
                await this.navigate(payload.domId ? NAV_TARGETS[payload.domId] : undefined);
                break;
            case 'navPrev':
                await this.preview.prev();
                this.syncPreviewUrl();
                break;
            case 'navNext':
                await this.preview.next();
                this.syncPreviewUrl();
                break;
            case 'navGo':
                await this.preview.go(payload.num ?? '');
                this.syncPreviewUrl();
                break;
            case 'openPreview':
                await this.openPreview(payload.url);
                break;
            case 'run-judge':
                await this.runActiveJudge(payload);
                break;
            case 'fetchProblem':
                await this.runFetchProblem(payload.url, payload.sampleMode);
                break;
            case 'fetchExtra':
                await this.runDownloadExtra();
                break;
            case 'refreshProblem':
                await this.refreshProblem(payload.url);
                break;
            case 'cookieHelp':
                await vscode.commands.executeCommand('oiHelper.cookieHelp');
                break;
            case 'clearCache':
                await this.clearSampleCache();
                break;
            case 'prepareSubmit':
                this.prepareSubmit();
                break;
            case 'submitSolution':
                await this.runSubmitSolution(payload.file, payload.url);
                break;
            case 'applyFreopen':
                await this.applyFreopen(payload.file, payload.dir);
                break;
            case 'applyFastIO':
                await this.applyFastIO(payload.file);
                break;
            case 'removeFreopen':
                await this.removeCode(payload.file, 'freopen');
                break;
            case 'removeFastIO':
                await this.removeCode(payload.file, 'fastio');
                break;
            case 'copySource':
                await this.applyCopySource(payload.file);
                break;
            case 'openSubmit':
                await this.applyOpenSubmit(payload.file, payload.url);
                break;
            case 'captchaSubmit':
                await this.retrySubmitWithCaptcha(payload.text);
                break;
            case 'captchaCancel':
                this.pendingSubmit = undefined;
                break;
            case 'origOpen':
            case 'origPreview':
            case 'origSamples':
            case 'origLink':
            case 'origSubmit':
                await this.runOriginal(payload.type, payload.file, payload.oj);
                break;
            case 'browse-problem':
                await this.browseProblemDir();
                break;
            case 'browse-source':
                await this.browseSourceFile();
                break;
            case 'browse-case-input':
                await this.browseCasePoint(payload.index ?? 0, 'input', payload.dir);
                break;
            case 'browse-case-output':
                await this.browseCasePoint(payload.index ?? 0, 'expected', payload.dir);
                break;
            case 'reset':
                await this.navigate('page-judge-panel', true);
                break;
            case 'notify':
                this.notify(payload.level, payload.text);
                break;
            case 'openCaseFile':
                await this.openCaseFile(payload.file, payload.dir);
                break;
            case 'confirmClearCases':
                await this.confirmClearCases(payload.count ?? 0);
                break;
            default:
                break;
        }
    }

    private sendTheme(): void {
        this.webview?.postMessage({ type: 'theme', theme: isLightTheme() ? 'light' : 'dark' });
    }

    // 下发测试点提示开关(重复/输入冲突), 供面板判定是否提示
    private sendCaseRules(): void {
        const cfg = vscode.workspace.getConfiguration('oiHelper');
        this.webview?.postMessage({
            type: 'caseRules',
            payload: {
                duplicateHint: cfg.get<boolean>('caseDuplicateHint') !== false,
                conflictWarn: cfg.get<boolean>('caseConflictWarn') !== false
            }
        });
    }

    // 把预览面板的题目导航状态同步到评测面板
    private postNavState(): void {
        this.webview?.postMessage({ type: 'navState', payload: this.preview.navState() });
    }

    // 面板内换题后, 把新题目链接同步到「网址导入」输入框
    private syncPreviewUrl(): void {
        const url = this.preview.currentUrl();
        if (url) {
            this.webview?.postMessage({ type: 'path-value', field: 'fetchUrl', value: url });
        }
    }

    // 「预览题目」入口: 用网址导入框里的链接打开独立题目预览面板
    private async openPreview(url?: string): Promise<void> {
        const target = (url ?? '').trim();
        const summary = await this.preview.open(target || undefined);
        if (target && !summary) {
            this.webview?.postMessage({
                type: 'fetchResult',
                payload: { ok: false, error: '题目预览失败, 详见 OI Helper 输出.' }
            });
        }
    }

    // 竞赛题目落盘目录: <workspace>/problems/<题目号>
    private contestDir(summary: ContestSummary): string | undefined {
        return this.problemDir(summary.problemId, summary.contestId, summary.num);
    }

    // <工作区>/problems/<problemId 或 contestId_num>
    private problemDir(problemId?: string, contestId?: string, num?: string): string | undefined {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            return undefined;
        }
        const key = (problemId ?? '').trim() || `${contestId ?? ''}_${num ?? ''}`;
        return path.join(folders[0].uri.fsPath, 'problems', key);
    }

    // 解压出的文件按同名配对 .in + .out/.ans, 返回相对 extra 目录的路径对
    private pairExtraFiles(files: string[]): { in: string; out: string }[] {
        const inputs = new Map<string, string>();
        const outputs = new Map<string, string>();
        for (const f of files) {
            const ext = path.extname(f).toLowerCase();
            const stem = f.slice(0, f.length - ext.length);
            if (ext === '.in') {
                inputs.set(stem, f);
            } else if (ext === '.out' || ext === '.ans') {
                outputs.set(stem, f);
            }
        }
        return [...inputs.keys()].filter((k) => outputs.has(k)).sort()
            .map((k) => ({ in: inputs.get(k) as string, out: outputs.get(k) as string }));
    }

    // 竞赛题目「下载为文件」: 样例写入 <workspace>/problems/<题目目录>/, 并生成 problem.json
    private writeContestSamples(summary: ContestSummary, extra: { in: string; out: string }[] = []): { dir?: string; tests?: number; error?: string } {
        const dir = this.contestDir(summary);
        if (!dir) {
            return { error: '未打开工作区, 无法确定抓取目录.' };
        }
        const key = (summary.problemId ?? '').trim() || `${summary.contestId ?? ''}_${summary.num ?? ''}`;
        const samples = summary.samples ?? [];
        try {
            fs.mkdirSync(dir, { recursive: true });
            const tests = samples.map((_, i) => ({ id: i + 1, in: `${i + 1}.in`, out: `${i + 1}.ans` }));
            extra.forEach((p, i) => tests.push({ id: samples.length + i + 1, in: p.in, out: p.out }));
            const meta = {
                name: summary.title ?? key,
                type: 'traditional',
                timeLimit: summary.timeLimit ?? 1000,
                memoryLimit: summary.memoryLimit ?? 256,
                standard: 'c++14',
                optimize: 'O2',
                checker: 'diff',
                tests,
                sourceUrl: contestProblemUrl(summary.contestId ?? '', summary.num ?? ''),
                ...(this.lastFetch?.freopenIn && this.lastFetch?.freopenOut
                    ? { freopen: { in: this.lastFetch.freopenIn, out: this.lastFetch.freopenOut } }
                    : {})
            };
            fs.writeFileSync(path.join(dir, 'problem.json'), JSON.stringify(meta, null, 2) + '\n');
            samples.forEach((s, i) => {
                fs.writeFileSync(path.join(dir, `${i + 1}.in`), s.in ?? '');
                fs.writeFileSync(path.join(dir, `${i + 1}.ans`), s.out ?? '');
            });
        } catch (err) {
            return { error: `写入样例失败: ${String(err)}` };
        }
        return { dir, tests: samples.length + extra.length };
    }

    // 供「下载更多样例」按钮重复触发
    private lastDownload?: { url: string; dir: string };

    // 更多样例下载令牌: 换题/重新导入时自增, 用于丢弃过期结果
    private extraToken = 0;

    // 「下载更多样例」: 下载压缩包解压到 <题目目录>/extra, 配对为文件型测试点
    private async runDownloadExtra(): Promise<void> {
        if (!this.lastDownload) {
            this.webview?.postMessage({ type: 'fetchResult', payload: { ok: false, error: '当前题目没有「更多样例」链接.' } });
            return;
        }
        const exe = resolveJudgePath();
        if (!exe) {
            await promptJudgePath();
            this.webview?.postMessage({ type: 'fetchResult', payload: { ok: false, error: '未找到 oi-judge 可执行文件.' } });
            return;
        }
        const extraDir = path.join(this.lastDownload.dir, 'extra');
        const token = ++this.extraToken;
        this.output.appendLine(`[面板] 下载更多样例 ${this.lastDownload.url}`);
        const er = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: '下载更多样例中...', cancellable: false },
            () => fetchExtraFlow(this.lastDownload?.url as string, extraDir, exe as string, this.output)
        );
        if (token !== this.extraToken) {
            this.output.appendLine('[面板] 已切换题目, 丢弃过期的更多样例结果');
            return;
        }
        if (!er.ok) {
            this.output.appendLine(`[错误] 下载更多样例失败: ${er.error ?? ''}`);
            this.webview?.postMessage({ type: 'fetchResult', payload: { ok: false, error: er.error || '下载更多样例失败.' } });
            return;
        }
        const cases = this.pairExtraFiles(er.files ?? []).map((p) => ({
            kind: 'path',
            input: path.join(extraDir, p.in),
            expected: path.join(extraDir, p.out),
            tag: '更多样例'
        }));
        this.output.appendLine(`[抓取] 更多样例 ${cases.length} 个测试点 -> ${extraDir}`);
        this.webview?.postMessage({
            type: 'fetchResult',
            payload: { ok: true, name: '更多样例', tests: cases.length, cases, dedupe: true }
        });
    }

    // 竞赛题目(/web/contest/{cid}/{num}): file 模式落盘到 problems 目录, inline 模式把样例内联到面板
    private async runContestImport(url: string, sampleMode?: string): Promise<void> {
        url = cleanUrl(url);
        const exe = resolveJudgePath();
        if (!exe) {
            await promptJudgePath();
            this.webview?.postMessage({ type: 'fetchResult', payload: { ok: false, error: '未找到 oi-judge 可执行文件.' } });
            return;
        }
        let summary: ContestSummary;
        try {
            this.output.appendLine(`[面板] 抓取竞赛题目样例 ${url}`);
            summary = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: '抓取题目中...', cancellable: false },
                () => fetchContestFlow(url, exe as string, this.output)
            );
        } catch (err) {
            summary = { ok: false, error: String(err) };
        }
        if (!summary.ok) {
            this.webview?.postMessage({ type: 'fetchResult', payload: { ok: false, error: summary.error || '题目加载失败.' } });
            return;
        }
        // 同步题目导航(选题/跳转)状态, 但不打开预览面板
        this.preview.adopt(summary);
        this.setSource(summary.source);
        // 文件 IO: 新版接口的 name 字段即可判定(name.in / name.out), 不依赖旧版页面
        if (summary.freopenIn && summary.freopenOut) {
            this.lastFetch = { name: summary.title, freopenIn: summary.freopenIn, freopenOut: summary.freopenOut };
            this.saveFreopen(summary, summary.freopenIn, summary.freopenOut);
            this.output.appendLine(`[抓取] 文件 IO: ${summary.freopenIn} / ${summary.freopenOut}`);
        } else if (summary.fileIO === false) {
            this.output.appendLine('[抓取] 本题为标准 IO');
        }
        // 「更多样例」只落文件: 与「样例方式」无关, 后台下载解压到 <题目目录>/extra
        const baseDir = this.contestDir(summary);
        const download = downloadUrlOf(summary.download);
        this.lastDownload = (download && baseDir) ? { url: download, dir: baseDir } : undefined;
        // 识别: 只回传题目信息, 不导入测试点、不下载更多样例
        if (sampleMode === 'identify') {
            this.webview?.postMessage({
                type: 'fetchResult',
                payload: {
                    ok: true,
                    identify: true,
                    source: ojName(url),
                    name: summary.title,
                    fileIO: summary.fileIO,
                    freopenIn: summary.freopenIn,
                    freopenOut: summary.freopenOut,
                    hasExtra: !!download,
                    samples: (summary.samples ?? []).map((s) => ({ in: s.in ?? '', out: s.out ?? '' }))
                }
            });
            return;
        }
        // 「样例方式」只作用于普通样例: 内联到面板 或 落盘
        if (sampleMode !== 'file') {
            this.webview?.postMessage({
                type: 'fetchResult',
                payload: {
                    ok: true,
                    inline: true,
                    source: ojName(url),
                    name: summary.title,
                    hasExtra: !!download,
                    samples: (summary.samples ?? []).map((s) => ({ in: s.in ?? '', out: s.out ?? '' }))
                }
            });
            this.startExtraDownload(summary);
            return;
        }
        const written = this.writeContestSamples(summary, []);
        if (!written.dir) {
            this.webview?.postMessage({ type: 'fetchResult', payload: { ok: false, error: written.error || '写入样例失败.' } });
            return;
        }
        this.output.appendLine(`[抓取] ${summary.title ?? ''} -> ${written.dir}`);
        this.lastFetch = { dir: written.dir, name: summary.title };
        const cppFile = this.findCppInDir(written.dir);
        if (cppFile) {
            this.webview?.postMessage({ type: 'path-value', field: 'sourceFile', value: cppFile });
            this.output.appendLine(`[抓取] 自动填入源文件: ${cppFile}`);
        }
        this.webview?.postMessage({
            type: 'fetchResult',
            payload: { ok: true, inline: false, name: summary.title, dir: written.dir, tests: written.tests, hasExtra: !!download }
        });
        this.startExtraDownload(summary);
    }

    // 把文件 IO 名字写进已有题目目录的 problem.json, 之后离线也能自动填
    private saveFreopen(summary: ContestSummary, inName: string, outName: string): void {
        const dir = this.contestDir(summary);
        if (!dir || !fs.existsSync(dir)) {
            return;
        }
        try {
            const file = path.join(dir, 'problem.json');
            let meta: Record<string, unknown> = {};
            if (fs.existsSync(file)) {
                meta = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
            }
            if (meta.freopen) {
                return;
            }
            meta.freopen = { in: inName, out: outName };
            fs.writeFileSync(file, JSON.stringify(meta, null, 2) + '\n');
        } catch (err) {
            this.output.appendLine(`[错误] 写入 problem.json freopen 失败: ${String(err)}`);
        }
    }

    // 后台下载「更多样例」: 不阻塞导入, 完成后补上文件型测试点(文件模式同时补写 problem.json)
    private startExtraDownload(summary: ContestSummary): void {
        const target = this.lastDownload;
        if (!target) {
            return;
        }
        void (async () => {
            const token = ++this.extraToken;
            const exe = resolveJudgePath();
            if (!exe) {
                return;
            }
            const extraDir = path.join(target.dir, 'extra');
            this.output.appendLine(`[面板] 下载更多样例 ${target.url}`);
            const er = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: '下载更多样例中...', cancellable: false },
                () => fetchExtraFlow(target.url, extraDir, exe, this.output)
            );
            if (token !== this.extraToken) {
                this.output.appendLine('[面板] 已切换题目, 丢弃过期的更多样例结果');
                return;
            }
            if (!er.ok) {
                this.output.appendLine(`[错误] 下载更多样例失败: ${er.error ?? ''}`);
                return;
            }
            const list = this.pairExtraFiles(er.files ?? []);
            const cases = list.map((p) => ({
                kind: 'path',
                input: path.join(extraDir, p.in),
                expected: path.join(extraDir, p.out),
                tag: '更多样例'
            }));
            this.output.appendLine(`[抓取] 更多样例 ${cases.length} 个测试点 -> ${extraDir}`);
            this.writeContestSamples(summary, list.map((p) => ({ in: `extra/${p.in}`, out: `extra/${p.out}` })));
            this.webview?.postMessage({
                type: 'fetchResult',
                payload: { ok: true, name: '更多样例', tests: cases.length, cases, dedupe: true }
            });
        })();
    }

    private async navigate(pageId?: string, force = false): Promise<void> {
        const webview = this.webview;
        if (!pageId || !PAGE_FILES[pageId] || !webview) {
            return;
        }
        if (!force && pageId === this.currentPage && this.rendered) {
            return;
        }
        this.currentPage = pageId;
        if (this.panel) {
            this.panel.title = PAGE_TITLES[pageId] || 'OI Helper';
        }
        webview.html = this.renderHtml(pageId);
        this.rendered = true;
    }

    private renderHtml(pageId: string): string {
        const file = PAGE_FILES[pageId] || PAGE_FILES['page-judge-panel'];
        const filePath = vscode.Uri.joinPath(this.extensionUri, 'media', file).fsPath;
        const nonce = createNonce();
        const cspSource = this.webview ? this.webview.cspSource : '';
        return fs.readFileSync(filePath, 'utf8')
            .replace(/__NONCE__/g, nonce)
            .replace(/__CSP_SOURCE__/g, cspSource);
    }

    // 汇总面板测试点: 文件行取路径, 粘贴行写入临时文件
    private collectCases(inputs?: JudgeInputs): JudgeCase[] {
        const cases: JudgeCase[] = [];
        let pasteDir: string | undefined;
        const writePasted = (c: { input?: string; expected?: string }): void => {
            if (!pasteDir) {
                pasteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oi-helper-case-'));
            }
            const input = path.join(pasteDir, `${cases.length + 1}.in`);
            const expected = path.join(pasteDir, `${cases.length + 1}.ans`);
            fs.writeFileSync(input, c.input ?? '');
            fs.writeFileSync(expected, c.expected ?? '');
            cases.push({ input, expected });
        };
        for (const c of inputs?.cases ?? []) {
            if (c.kind === 'text') {
                writePasted(c);
                continue;
            }
            const input = toAbsolute(c.input);
            const expected = toAbsolute(c.expected);
            if (input && expected) {
                cases.push({ input, expected });
            }
        }
        for (const c of inputs?.pasteCases ?? []) {
            writePasted(c);
        }
        return cases;
    }

    // 「开始评测」: 优先用面板填写的题目目录/源文件, 缺省回退到当前活动 .cpp
    private async runActiveJudge(inputs?: JudgeInputs): Promise<void> {
        const exe = resolveJudgePath();
        if (!exe) {
            await promptJudgePath();
            return;
        }
        const cfg = vscode.workspace.getConfiguration('oiHelper');
        const common = {
            env: cfg.get<string>('env'),
            jobs: cfg.get<number>('jobs'),
            timeLimit: cfg.get<number>('timeLimit'),
            memoryLimit: cfg.get<number>('memoryLimit'),
            standard: cfg.get<string>('standard')
        };
        // 校验测试点: 文件型测试点必须同时填输入与输出
        const rows = inputs?.cases ?? [];
        for (let i = 0; i < rows.length; i += 1) {
            if (rows[i].kind === 'text') {
                continue;
            }
            const missing: string[] = [];
            if (!rows[i].input?.trim()) {
                missing.push('输入文件');
            }
            if (!rows[i].expected?.trim()) {
                missing.push('输出文件');
            }
            if (missing.length > 0) {
                vscode.window.showWarningMessage(`测试点 #${i + 1} 未填写${missing.join(' 与 ')}.`);
                return;
            }
        }
        const problemDir = toAbsolute(inputs?.problemDir);
        if (inputs?.problemDir?.trim() && problemDir && !fs.existsSync(problemDir)) {
            vscode.window.showWarningMessage(`题目目录不存在: ${problemDir}`);
            return;
        }
        let srcPath = toAbsolute(inputs?.sourceFile);
        if (srcPath && !fs.existsSync(srcPath)) {
            vscode.window.showWarningMessage(`源文件不存在: ${srcPath}`);
            return;
        }
        if (!srcPath) {
            const editor = vscode.window.activeTextEditor;
            srcPath = editor && editor.document.fileName.toLowerCase().endsWith('.cpp')
                ? editor.document.fileName
                : undefined;
        }
        const cases = this.collectCases(inputs);
        const hasProblemJson = !!problemDir && fs.existsSync(path.join(problemDir, 'problem.json'));
        let options: JudgeOptions;
        if (srcPath && cases.length > 0) {
            options = { cwd: path.dirname(srcPath), src: srcPath, cases, ...common };
        } else if (hasProblemJson) {
            // 题目目录优先: 用 problem.json 的测试点/freopen, 有源文件则一并评测
            options = { cwd: problemDir, problem: problemDir, src: srcPath, ...common };
        } else if (srcPath) {
            // 无题目目录时, 回退到与源文件同名的 .in/.ans
            const dir = path.dirname(srcPath);
            const base = srcPath.slice(0, -'.cpp'.length);
            const input = `${base}.in`;
            const expected = `${base}.ans`;
            if (!fs.existsSync(input) || !fs.existsSync(expected)) {
                vscode.window.showWarningMessage('未找到测试点, 请填写测试点, 或补齐与源文件同名的 .in/.ans 文件.');
                return;
            }
            options = { cwd: dir, src: srcPath, cases: [{ input, expected }], ...common };
        } else {
            vscode.window.showWarningMessage('请填写源文件或题目目录, 或先打开一个 .cpp 文件.');
            return;
        }
        let result: JudgeResult;
        try {
            this.stateSink?.(true);
            this.output.appendLine(`[面板] 开始评测 ${options.src || options.problem}`);
            result = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'OI 评测中...', cancellable: false },
                () => runJudge(exe, options, this.output)
            );
        } catch (err) {
            this.stateSink?.(false);
            this.output.appendLine(`[错误] ${String(err)}`);
            vscode.window.showErrorMessage(`OI 评测失败: ${String(err)}`);
            return;
        }
        vscode.window.showInformationMessage(`OI 评测完成: ${result.status} ${result.totalScore}/${result.maxScore}`);
        this.resultSink?.(result);
    }

    // 「刷新题目」: 清掉该题缓存后重新抓取(识别)
    private async refreshProblem(url?: string): Promise<void> {
        const target = cleanUrl(url ?? '');
        if (!target) {
            this.webview?.postMessage({ type: 'fetchResult', payload: { ok: false, error: '请输入题目网址.' } });
            return;
        }
        clearOriginalCache(target);
        this.output.appendLine(`[面板] 刷新题目 ${target}`);
        await this.runFetchProblem(target, 'identify');
    }

    // 其它站点(Hydro 等): 抓题面与样例; 识别只回题目信息, 导入把样例加入测试点
    private async runSiteImport(url: string, sampleMode?: string): Promise<void> {
        const exe = resolveJudgePath();
        if (!exe) {
            await promptJudgePath();
            this.webview?.postMessage({ type: 'fetchResult', payload: { ok: false, error: '未找到 oi-judge 可执行文件.' } });
            return;
        }
        let summary: OriginalSummary;
        try {
            this.output.appendLine(`[面板] 抓取题目 ${url}`);
            summary = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: '抓取题目中...', cancellable: false },
                () => fetchOriginalFlow(url, exe as string, this.output)
            );
        } catch (err) {
            summary = { ok: false, error: String(err) };
        }
        if (!summary.ok) {
            this.webview?.postMessage({ type: 'fetchResult', payload: { ok: false, error: summary.error || '题目加载失败.' } });
            return;
        }
        const name = summary.title || url;
        // 同步普通题目状态, 面板的「题号」跳转才有值
        this.preview.adoptPlain(url, name);
        const samples = (summary.samples ?? []).map((s) => ({ in: s.in ?? '', out: s.out ?? '' }));
        if (sampleMode === 'identify') {
            this.webview?.postMessage({
                type: 'fetchResult',
                payload: { ok: true, identify: true, source: ojName(url), name, hasExtra: false, samples }
            });
            return;
        }
        this.output.appendLine(`[抓取] ${name} -> ${samples.length} 个样例`);
        this.webview?.postMessage({
            type: 'fetchResult',
            payload: { ok: true, inline: true, source: ojName(url), name, hasExtra: false, samples }
        });
    }

    // 「从网址导入题目」: 复用抓取流程, 结果回传面板; 内联模式把样例直接加入测试点
    private async runFetchProblem(url?: string, sampleMode?: string): Promise<void> {
        const target = cleanUrl(url ?? '');
        const identify = sampleMode === 'identify';
        const inline = sampleMode === 'inline' || identify;
        if (!target) {
            this.webview?.postMessage({ type: 'fetchResult', payload: { ok: false, error: '请输入题目网址.' } });
            return;
        }
        // 竞赛题目(新版 /web/contest/{cid}/{num} 或旧版 problem.php?cid=&pid=):
        // 按样例方式落盘或内联, 均不打开预览面板
        const contestLike = isContestUrl(target) ? target : oldContestUrlToNew(target);
        if (contestLike) {
            await this.runContestImport(contestLike, sampleMode);
            return;
        }
        // xmoj/洛谷之外的站点(如 Hydro): 用原题接口抓题面与样例
        if (!isXmojUrl(target) && !isLuoguUrl(target)) {
            await this.runSiteImport(target, sampleMode);
            return;
        }
        const exe = resolveJudgePath();
        if (!exe) {
            await promptJudgePath();
            this.webview?.postMessage({ type: 'fetchResult', payload: { ok: false, error: '未找到 oi-judge 可执行文件.' } });
            return;
        }
        let summary: FetchSummary;
        try {
            this.output.appendLine(`[面板] ${identify ? '识别题目' : '抓取题目'} ${target}${inline && !identify ? ' (内联样例)' : ''}`);
            summary = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: '抓取题目中...', cancellable: false },
                () => fetchProblemFlow(target, exe, this.output, inline)
            );
        } catch (err) {
            summary = { ok: false, error: String(err) };
        }
        if (summary.ok) {
            this.output.appendLine(`[抓取] ${summary.name ?? ''} -> ${summary.dir || '(内联样例)'}`);
            this.setSource(summary.source);
            // 普通题目(做题链接): 同步题目编号, 供面板「跳转」按题目编号换题
            this.preview.adoptPlain(target, summary.name);
            this.lastFetch = {
                dir: summary.dir,
                name: summary.name,
                freopenIn: summary.freopenIn,
                freopenOut: summary.freopenOut
            };
            // 下载模式: 导入成功后自动查找目录下的 .cpp 源文件填入面板
            if (!inline && summary.dir) {
                const cppFile = this.findCppInDir(summary.dir);
                if (cppFile) {
                    this.webview?.postMessage({ type: 'path-value', field: 'sourceFile', value: cppFile });
                    this.output.appendLine(`[抓取] 自动填入源文件: ${cppFile}`);
                }
            }
        } else {
            this.output.appendLine(`[错误] ${summary.error ?? '抓取失败'}`);
        }
        this.webview?.postMessage({ type: 'fetchResult', payload: { ...summary, inline, identify, source: ojName(target) } });
    }

    // 「清除样例缓存」: 二次确认后删除 <workspace>/problems 下的已下载题目
    private async clearSampleCache(): Promise<void> {
        // 顺带清掉抓取结果的短期缓存
        clearOriginalCache();
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            this.webview?.postMessage({ type: 'cacheResult', payload: { ok: false, error: '未打开工作区.' } });
            return;
        }
        const baseDir = path.join(folders[0].uri.fsPath, 'problems');
        if (!fs.existsSync(baseDir)) {
            this.webview?.postMessage({ type: 'cacheResult', payload: { ok: true, removed: 0 } });
            return;
        }
        let removed = 0;
        try {
            for (const name of fs.readdirSync(baseDir)) {
                if (fs.statSync(path.join(baseDir, name)).isDirectory()) {
                    removed += 1;
                }
            }
        } catch { /* 统计失败时按 0 计 */ }
        const pick = await vscode.window.showWarningMessage(
            `确定删除样例缓存目录? 将移除 ${removed} 个已下载题目.\n${baseDir}`,
            { modal: true },
            '删除'
        );
        if (pick !== '删除') {
            this.webview?.postMessage({ type: 'cacheResult', payload: { canceled: true } });
            return;
        }
        try {
            fs.rmSync(baseDir, { recursive: true, force: true });
            this.output.appendLine(`[缓存] 已删除 ${baseDir} (${removed} 个题目)`);
            this.lastFetch = undefined;
            this.webview?.postMessage({ type: 'cacheResult', payload: { ok: true, removed } });
        } catch (err) {
            this.webview?.postMessage({ type: 'cacheResult', payload: { ok: false, error: String(err) } });
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

    // 「一键填写 freopen」: 读取 problem.json 的 freopen 并写入源文件 main 开头
    private async applyFreopen(file?: string, dir?: string): Promise<void> {
        const target = toAbsolute(file) ?? this.activeCppFile();
        if (!target || !fs.existsSync(target)) {
            this.webview?.postMessage({ type: 'freopenResult', payload: { ok: false, error: '请先填写或用编辑器打开一个 .cpp 源文件.' } });
            return;
        }
        const io = await this.resolveFreopen(target, toAbsolute(dir));
        if (!io) {
            this.webview?.postMessage({ type: 'freopenResult', payload: { ok: false, error: '已取消或未输入有效的 freopen 文件名.' } });
            return;
        }
        try {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
            const text = doc.getText();
            const updated = insertFreopen(text, io.in, io.out);
            if (updated === undefined) {
                this.webview?.postMessage({ type: 'freopenResult', payload: { ok: false, error: '未在源码中找到 main 函数.' } });
                return;
            }
            const edit = new vscode.WorkspaceEdit();
            edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(text.length)), updated);
            const applied = await vscode.workspace.applyEdit(edit);
            if (applied) {
                await doc.save();
            }
            this.webview?.postMessage({
                type: 'freopenResult',
                payload: applied
                    ? { ok: true, in: io.in, out: io.out }
                    : { ok: false, error: '写入源文件失败.' }
            });
        } catch (err) {
            this.webview?.postMessage({ type: 'freopenResult', payload: { ok: false, error: String(err) } });
        }
    }

    // 「一键加速 IO」: 在源文件 main 开头插入设置中的读写加速语句
    private async applyFastIO(file?: string): Promise<void> {
        const target = toAbsolute(file) ?? this.activeCppFile();
        if (!target || !fs.existsSync(target)) {
            this.webview?.postMessage({ type: 'fastIOResult', payload: { ok: false, error: '请先填写或用编辑器打开一个 .cpp 源文件.' } });
            return;
        }
        const snippet = vscode.workspace.getConfiguration('oiHelper').get<string>('fastIO') ?? '';
        if (!snippet.trim()) {
            this.webview?.postMessage({ type: 'fastIOResult', payload: { ok: false, error: 'oiHelper.fastIO 为空, 请先在设置中填写加速语句.' } });
            return;
        }
        try {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
            const text = doc.getText();
            const updated = insertFastIO(text, snippet);
            if (updated === undefined) {
                this.webview?.postMessage({ type: 'fastIOResult', payload: { ok: false, error: '未在源码中找到 main 函数.' } });
                return;
            }
            const edit = new vscode.WorkspaceEdit();
            edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(text.length)), updated);
            const applied = await vscode.workspace.applyEdit(edit);
            if (applied) {
                await doc.save();
            }
            this.webview?.postMessage({
                type: 'fastIOResult',
                payload: applied ? { ok: true } : { ok: false, error: '写入源文件失败.' }
            });
        } catch (err) {
            this.webview?.postMessage({ type: 'fastIOResult', payload: { ok: false, error: String(err) } });
        }
    }

    // 右键「填 freopen」/「加速 IO」: 从源文件中删除对应语句
    private async removeCode(file: string | undefined, kind: 'freopen' | 'fastio'): Promise<void> {
        const type = kind === 'freopen' ? 'freopenResult' : 'fastIOResult';
        const target = toAbsolute(file) ?? this.activeCppFile();
        if (!target || !fs.existsSync(target)) {
            this.webview?.postMessage({ type, payload: { ok: false, removed: kind, error: '请先填写或用编辑器打开一个 .cpp 源文件.' } });
            return;
        }
        try {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
            const text = doc.getText();
            const updated = kind === 'freopen' ? removeFreopen(text) : removeFastIO(text);
            if (updated === text) {
                this.webview?.postMessage({
                    type,
                    payload: { ok: false, removed: kind, error: kind === 'freopen' ? '源码中没有 freopen 语句.' : '源码中没有读写加速语句.' }
                });
                return;
            }
            const edit = new vscode.WorkspaceEdit();
            edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(text.length)), updated);
            const applied = await vscode.workspace.applyEdit(edit);
            if (applied) {
                await doc.save();
            }
            this.webview?.postMessage({
                type,
                payload: applied ? { ok: true, removed: kind } : { ok: false, removed: kind, error: '写入源文件失败.' }
            });
        } catch (err) {
            this.webview?.postMessage({ type, payload: { ok: false, removed: kind, error: String(err) } });
        }
    }

    // 从题目目录(或源文件上级目录)的 problem.json 读取 freopen 配置
    private readProblemFreopen(file: string, dir?: string): { in: string; out: string } | undefined {
        const candidates: string[] = [];
        if (dir) {
            candidates.push(dir);
        }
        let cur = path.dirname(file);
        for (let i = 0; i < 6; i += 1) {
            candidates.push(cur);
            const parent = path.dirname(cur);
            if (parent === cur) {
                break;
            }
            cur = parent;
        }
        for (const d of candidates) {
            const jsonPath = path.join(d, 'problem.json');
            if (!fs.existsSync(jsonPath)) {
                continue;
            }
            try {
                const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as { freopen?: { in?: string; out?: string } };
                if (data.freopen && data.freopen.in && data.freopen.out) {
                    return { in: data.freopen.in, out: data.freopen.out };
                }
            } catch { /* 解析失败则继续向上查找 */ }
        }
        return undefined;
    }

    // freopen 来源优先级: problem.json > 网址导入的题目信息 > 手动输入
    private async resolveFreopen(file: string, dir?: string): Promise<{ in: string; out: string } | undefined> {
        const fromJson = this.readProblemFreopen(file, dir);
        if (fromJson) {
            return fromJson;
        }
        if (this.lastFetch && this.lastFetch.freopenIn && this.lastFetch.freopenOut) {
            return { in: this.lastFetch.freopenIn, out: this.lastFetch.freopenOut };
        }
        return this.promptFreopenSpec();
    }

    // 手动输入 freopen 文件名: 只填名字 / 填一个 .in 或 .out / 填完整两者 均可
    private async promptFreopenSpec(): Promise<{ in: string; out: string } | undefined> {
        const input = await vscode.window.showInputBox({
            prompt: '输入 freopen 文件名: 只填名字(如 x) 自动补全 x.in/x.out; 或填 x.in; 或填完整两个(空格分隔 a.in b.out)',
            placeHolder: 'x  或  x.in  或  a.in b.out',
            validateInput: (v) => (parseFreopenSpec(v) ? undefined : '请输入文件名')
        });
        if (input === undefined) {
            return undefined;
        }
        return parseFreopenSpec(input);
    }

    // 提交前: 依据最近一次评测是否 AC 组装确认弹窗参数(次数/文案/强制等待秒数)
    private prepareSubmit(): void {
        const last = this.resultGetter ? this.resultGetter() : undefined;
        const ac = !!last && last.solved === true;
        const cfg = vscode.workspace.getConfiguration('oiHelper');
        const count = ac ? this.readCount('submitConfirmAcCount') : this.readCount('submitConfirmNonAcCount');
        const seconds = Math.max(0, cfg.get<number>('submitConfirmHoldSeconds') ?? 0);
        const raw = ((ac
            ? cfg.get<string>('submitConfirmAcText')
            : cfg.get<string>('submitConfirmNonAcText')) ?? '').trim();
        // 文案按句拆分: 多段时每次弹窗显示一段, 只有第 1 段需要等待
        const parts = raw
            .split(/(?<=[，,。!！?？;；\n])/)
            .map((t) => t.replace(/[，,；;\s]+$/, '').trim())
            .filter((t) => t);
        const texts: string[] = [];
        for (let i = 0; i < count; i += 1) {
            texts.push(parts.length ? parts[Math.min(i, parts.length - 1)] : raw);
        }
        this.webview?.postMessage({
            type: 'submitConfirm',
            payload: { ac, count, seconds, texts }
        });
    }

    private readCount(key: string): number {
        const value = vscode.workspace.getConfiguration('oiHelper').get<number>(key) ?? 1;
        return Math.max(1, Math.min(5, Math.floor(value)));
    }

    // 提交结果轮询次数: 超时秒数来自设置(默认 60s), 每 2 秒查一次
    private resultPollAttempts(): number {
        const seconds = vscode.workspace.getConfiguration('oiHelper').get<number>('submitResultTimeout') ?? 60;
        return Math.max(1, Math.ceil(Math.max(6, Math.min(600, Math.floor(seconds))) / 2));
    }

    // 提交后轮询评测结果, 直到出结果或超时
    private lastSolutionId = 0;

    private async pollSubmitResult(solutionId?: number, title?: string): Promise<void> {
        if (!solutionId) {
            return;
        }
        this.lastSolutionId = solutionId;
        const cfg = vscode.workspace.getConfiguration('oiHelper');
        const user = (cfg.get<string>('xmojUser') ?? '').trim();
        const pass = (cfg.get<string>('xmojPassword') ?? '').trim();
        const exe = resolveJudgePath();
        if (!user || !exe) {
            // 无账号信息时无法自动查询, 只在结果视图记录提交号
            this.submitSink?.({ title, solutionId, text: '已提交(未配置 xmoj 账号, 无法自动查询)' });
            return;
        }
        // 先展示「评测中」, 后续每轮刷新, 结果同步到右侧「评测结果」视图
        this.submitSink?.({ title, solutionId, text: '评测中', pending: true });
        const attempts = this.resultPollAttempts();
        for (let i = 0; i < attempts; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
            if (this.lastSolutionId !== solutionId) {
                return; // 已提交新的一次
            }
            const state = await runSubmitResult(exe, solutionId, user, pass, this.output);
            if (!state.ok) {
                this.output.appendLine(`[提交结果] 查询失败: ${state.error ?? ''}`);
                return;
            }
            this.webview?.postMessage({
                type: 'submitState',
                payload: {
                    solutionId,
                    text: state.text,
                    pending: !state.finished,
                    timeMs: state.timeMs,
                    memoryKb: state.memoryKb
                }
            });
            this.submitSink?.({
                title,
                solutionId,
                text: state.text,
                pending: !state.finished,
                timeMs: state.timeMs,
                memoryKb: state.memoryKb
            });
            if (state.finished) {
                this.output.appendLine(`[提交结果] ${solutionId} -> ${state.text ?? ''} (${state.timeMs ?? 0}ms, ${state.memoryKb ?? 0}KB)`);
                return;
            }
        }
        this.webview?.postMessage({ type: 'submitState', payload: { solutionId, text: '评测中...', pending: true } });
        this.output.appendLine(`[提交结果] ${solutionId} 等待 ${attempts * 2}s 仍未出结果, 停止轮询`);
        this.submitSink?.({ title, solutionId, text: '仍在评测中(已停止轮询)' });
    }

    // 「一键提交」: 用面板填写的源文件提交到 xmoj, 结果回传面板
    private async runSubmitSolution(file?: string, url?: string): Promise<void> {
        const target = toAbsolute(file);
        if (!target) {
            this.webview?.postMessage({ type: 'submitResult', payload: { ok: false, error: '请填写源文件.' } });
            return;
        }
        if (!fs.existsSync(target)) {
            this.webview?.postMessage({ type: 'submitResult', payload: { ok: false, error: `源文件不存在: ${target}` } });
            return;
        }
        const exe = resolveJudgePath();
        if (!exe) {
            await promptJudgePath();
            this.webview?.postMessage({ type: 'submitResult', payload: { ok: false, error: '未找到 oi-judge 可执行文件.' } });
            return;
        }
        // 面板填的是其它 OJ 链接(洛谷/CF 等): 改走原题直连提交
        const refs = parseOriginals(cleanUrl(url ?? ''));
        if (refs.length) {
            await this.submitOriginalNow(target, refs, exe);
            return;
        }
        let summary: SubmitSummary;
        try {
            this.output.appendLine(`[面板] 提交 ${target}`);
            summary = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: '提交中...', cancellable: false },
                () => submitFlow(target, exe, this.output, url)
            );
        } catch (err) {
            summary = { ok: false, error: String(err) };
        }
        if (summary.ok) {
            this.output.appendLine(`[提交] ${summary.problemId ?? ''} -> ${summary.solutionId ?? ''}`);
            void this.pollSubmitResult(summary.solutionId,
                summary.problemId !== undefined ? `题目 ${summary.problemId}` : undefined);
        } else {
            this.output.appendLine(`[错误] ${summary.error ?? '提交失败'}`);
        }
        this.webview?.postMessage({ type: 'submitResult', payload: summary });
    }

    // 当前题目的原题来源(来源字段 -> 候选站点)
    private originals: OriginalRef[] = [];

    private sourceText = '';

    private setSource(source?: string): void {
        this.sourceText = (source ?? '').trim();
        this.originals = parseOriginals(this.sourceText);
        // 记录来源解析结果, 便于排查「原题栏为什么没出现」
        this.output.appendLine(this.originals.length
            ? `[来源] ${this.sourceText} -> ${this.originals.map((r) => `${ojLabel(r.oj)} ${r.id}`).join(' / ')}`
            : (this.sourceText ? `[来源] ${this.sourceText} (未识别出原题站点)` : '[来源] 当前题目没有来源信息'));
        this.postOrigState();
    }

    private postOrigState(): void {
        this.webview?.postMessage({
            type: 'origState',
            payload: {
                source: this.sourceText,
                refs: this.originals.map((r) => `${ojLabel(r.oj)} ${r.id}`)
            }
        });
    }

    private origHint(text: string, kind = ''): void {
        this.webview?.postMessage({ type: 'origHint', payload: { text, kind } });
    }

    // 原题功能: 查看/预览/样例/复制链接/提交; index 为下拉框选中的站点
    private async runOriginal(action: string, file?: string, index?: number): Promise<void> {
        if (this.originals.length === 0) {
            this.origHint(this.sourceText ? `未识别出来源: ${this.sourceText}` : '当前题目没有来源信息 (用竞赛链接导入后可获取)', 't-error');
            return;
        }
        const pick = (index !== undefined && index >= 0 && index < this.originals.length) ? index : 0;
        const ref = this.originals[pick];
        if (action === 'origOpen') {
            await vscode.env.openExternal(vscode.Uri.parse(ref.url));
            this.origHint(`已打开 ${ojLabel(ref.oj)} ${ref.id}`, 't-success');
            return;
        }
        if (action === 'origLink') {
            await vscode.env.clipboard.writeText(ref.url);
            this.origHint(`已复制 ${ojLabel(ref.oj)} 链接: ${ref.url}`, 't-success');
            return;
        }
        const exe = resolveJudgePath();
        if (!exe) {
            await promptJudgePath();
            this.origHint('未找到 oi-judge 可执行文件.', 't-error');
            return;
        }
        if (action === 'origSubmit') {
            await this.submitOriginal(file, exe, pick);
            return;
        }
        this.origHint('抓取原题中...');
        const summary = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: '抓取原题中...', cancellable: false },
            () => fetchOriginalFlow(ref.url, exe, this.output)
        );
        if (!summary.ok) {
            this.origHint(`抓取原题失败: ${summary.error ?? '未知错误'}`, 't-error');
            return;
        }
        if (action === 'origPreview') {
            this.preview.openMarkdown(`${ojLabel(ref.oj)} ${summary.title ?? ref.id}`, summary.markdown ?? '');
            this.origHint(`已预览 ${ojLabel(ref.oj)} ${summary.title ?? ref.id}`, 't-success');
            return;
        }
        const samples = summary.samples ?? [];
        this.webview?.postMessage({
            type: 'fetchResult',
            payload: {
                ok: true,
                inline: true,
                source: `${ojLabel(ref.oj)}原题`,
                name: summary.title ?? ref.id,
                samples: samples.map((s) => ({ in: s.in ?? '', out: s.out ?? '' }))
            }
        });
        this.origHint(`已从 ${ojLabel(ref.oj)} 取得 ${samples.length} 个样例`, samples.length ? 't-success' : 't-error');
    }

    // 提交到原题: 选中的站点优先, 失败再按优先级换其他站点(仍失败则改用打开提交页+复制源码)
    private async submitOriginal(file: string | undefined, exe: string, index = 0): Promise<void> {
        const target = toAbsolute(file) ?? this.activeCppFile();
        if (!target || !fs.existsSync(target)) {
            this.origHint('请先填写或用编辑器打开一个 .cpp 源文件.', 't-error');
            return;
        }
        const ref = (index >= 0 && index < this.originals.length) ? this.originals[index] : this.originals[0];
        const order = [ref, ...this.originals.filter((item) => item !== ref)];
        const mode = vscode.workspace.getConfiguration('oiHelper').get<string>('originalSubmitMode') ?? 'direct';
        if (mode === 'direct') {
            this.origHint('提交原题中...');
            // 成功或等待用户输入验证码时都不再回落浏览器方式
            if (await this.submitOriginalNow(target, order, exe)) {
                return;
            }
            this.output.appendLine('[原题提交] 直连提交失败, 改用浏览器方式');
        }
        await this.openSubmitPage(target, ref.submitUrl);
        this.origHint(`直连不可用, 已打开 ${ojLabel(ref.oj)} 提交页并把源码复制到剪贴板`, '');
    }

    // 洛谷提交后自动轮询记录, 结果同步到右侧「评测结果」视图
    private async pollLuoguResult(rid: number, cookie: string, title?: string): Promise<void> {
        const exe = resolveJudgePath();
        if (!exe) {
            return;
        }
        this.submitSink?.({ title, solutionId: rid, text: '评测中', pending: true });
        const attempts = this.resultPollAttempts();
        let logged = false;
        for (let i = 0; i < attempts; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
            const state = await runSubmitResultLuogu(exe, rid, cookie, this.output);
            if (!state.ok) {
                const reason = (state.error ?? '').replace(/\s+/g, ' ').slice(0, 60);
                this.output.appendLine(`[提交结果] 洛谷记录查询失败: ${reason}`);
                this.submitSink?.({
                    title,
                    solutionId: rid,
                    text: reason ? `已提交(查询失败: ${reason})` : '已提交(无法查询结果)'
                });
                return;
            }
            // 首次查询把原始响应记到输出, 便于核对状态字段
            if (!logged && state.raw) {
                this.output.appendLine(`[提交结果] 洛谷记录响应: ${state.raw}`);
                logged = true;
            }
            this.submitSink?.({
                title,
                solutionId: rid,
                text: state.text,
                pending: !state.finished,
                timeMs: state.timeMs,
                memoryKb: state.memoryKb
            });
            if (state.finished) {
                this.output.appendLine(`[提交结果] 洛谷 ${rid} -> ${state.text ?? ''} (${state.timeMs ?? 0}ms, ${state.memoryKb ?? 0}KB)`);
                return;
            }
        }
        this.output.appendLine(`[提交结果] 洛谷 ${rid} 等待 ${attempts * 2}s 仍未出结果, 停止轮询`);
        this.submitSink?.({ title, solutionId: rid, text: '仍在评测中(已停止轮询)' });
    }

    // Hydro 提交后自动轮询记录, 结果同步到右侧「评测结果」视图
    private async pollHydroResult(rid: string, base: string, cookie: string, title?: string): Promise<void> {
        const exe = resolveJudgePath();
        if (!exe) {
            return;
        }
        this.submitSink?.({ title, solutionId: rid, text: '评测中', pending: true });
        const attempts = this.resultPollAttempts();
        let logged = false;
        for (let i = 0; i < attempts; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
            const state = await runSubmitResultHydro(exe, rid, base, cookie, this.output);
            if (!state.ok) {
                const reason = (state.error ?? '').replace(/\s+/g, ' ').slice(0, 60);
                this.output.appendLine(`[提交结果] Hydro 记录查询失败: ${reason}`);
                this.submitSink?.({
                    title,
                    solutionId: rid,
                    text: reason ? `已提交(查询失败: ${reason})` : '已提交(无法查询结果)'
                });
                return;
            }
            if (!logged && state.raw) {
                this.output.appendLine(`[提交结果] Hydro 记录响应: ${state.raw}`);
                logged = true;
            }
            this.submitSink?.({
                title,
                solutionId: rid,
                text: state.text,
                pending: !state.finished,
                timeMs: state.timeMs,
                memoryKb: state.memoryKb
            });
            if (state.finished) {
                this.output.appendLine(`[提交结果] Hydro ${rid} -> ${state.text ?? ''}`);
                return;
            }
        }
        this.output.appendLine(`[提交结果] Hydro ${rid} 等待 ${attempts * 2}s 仍未出结果, 停止轮询`);
        this.submitSink?.({ title, solutionId: rid, text: '仍在评测中(已停止轮询)' });
    }

    // 待输入验证码的原题提交(用户输入后重试, 沿用同一会话 Cookie)
    private pendingSubmit: { file: string; refs: OriginalRef[]; exe: string; cookie: string } | undefined;

    // 原题直连提交; 需要验证码时把图片发到面板等用户输入, 返回 true 表示已受理(成功或等待输入)
    private async submitOriginalNow(file: string, refs: OriginalRef[], exe: string,
                                    captcha?: string, cookie?: string): Promise<boolean> {
        let orig: OriginalSubmitSummary;
        try {
            this.output.appendLine(`[面板] 提交原题 ${refs[0]?.url ?? ''}${captcha ? ' (带验证码)' : ''}`);
            orig = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: '提交中...', cancellable: false },
                () => submitOriginalFlow(file, refs, exe, this.output, { captcha, cookie })
            );
        } catch (err) {
            orig = { ok: false, error: String(err) };
        }
        if (orig.needCaptcha && orig.captchaImage) {
            this.pendingSubmit = { file, refs, exe, cookie: orig.cookie ?? '' };
            this.output.appendLine('[面板] 该站要求图形验证码, 等待用户输入');
            this.webview?.postMessage({ type: 'captcha', payload: { image: orig.captchaImage } });
            return true;
        }
        this.pendingSubmit = undefined;
        if (orig.ok) {
            this.output.appendLine(`[提交] ${ojLabel(orig.oj ?? '')} 提交号 ${orig.submissionId ?? ''}`);
            this.webview?.postMessage({
                type: 'submitResult',
                payload: {
                    ok: true,
                    message: `已提交到 ${ojLabel(orig.oj ?? '')}` +
                        (orig.submissionId ? `, 提交号 ${orig.submissionId}` : '')
                }
            });
            // 同步到右侧「评测结果」视图: 洛谷可自动轮询记录, 其它站点只记录提交号
            const rid = Number(orig.submissionId);
            const hydroId = (orig.recordPath ?? '').trim() || (orig.submissionId ?? '').trim();
            if ((orig.oj ?? '') === 'luogu' && Number.isFinite(rid) && rid > 0) {
                void this.pollLuoguResult(rid, orig.cookie ?? '', `洛谷 ${rid}`);
            } else if ((orig.oj ?? '') === 'hydro' && hydroId) {
                void this.pollHydroResult(hydroId, refs[0]?.url ?? '', orig.cookie ?? '', `Hydro ${orig.submissionId ?? hydroId}`);
            } else {
                this.submitSink?.({
                    title: `已提交到 ${ojLabel(orig.oj ?? '')}`,
                    solutionId: orig.submissionId || (Number.isFinite(rid) && rid > 0 ? rid : undefined),
                    text: '已提交'
                });
            }
            return true;
        }
        const message = orig.error ?? '提交失败';
        this.output.appendLine(`[错误] ${message}`);
        this.webview?.postMessage({ type: 'submitResult', payload: { ok: false, error: message } });
        if (/验证码/.test(message)) {
            if (captcha) {
                // 输入有误: 重新取一张验证码图让用户再试
                return this.submitOriginalNow(file, refs, exe);
            }
            // 取不到验证码图片等: 改用打开提交页手动提交
            await this.applyOpenSubmit(file, refs[0]?.url ?? '');
            return false;
        }
        // 该站点不支持直连提交: 直接打开提交页并复制源码
        if (/暂不支持直连提交/.test(message)) {
            await this.applyOpenSubmit(file, refs[0]?.url ?? '');
            return true;
        }
        return false;
    }

    // 用户在面板里提交验证码
    private async retrySubmitWithCaptcha(code?: string): Promise<void> {
        const pending = this.pendingSubmit;
        if (!pending) {
            return;
        }
        const value = (code ?? '').trim();
        this.pendingSubmit = undefined;
        if (!value) {
            return;
        }
        await this.submitOriginalNow(pending.file, pending.refs, pending.exe, value, pending.cookie);
    }

    // 打开原题提交页并把源码复制到剪贴板(手动提交)
    private async openSubmitPage(file: string, submitUrl: string): Promise<void> {
        try {
            await vscode.env.clipboard.writeText(fs.readFileSync(file, 'utf8'));
        } catch (err) {
            this.origHint(`复制源码失败: ${String(err)}`, 't-error');
            return;
        }
        await vscode.env.openExternal(vscode.Uri.parse(submitUrl));
    }

    // 提交失败时复制源码到剪贴板, 便于手动粘贴提交
    private async applyCopySource(file?: string): Promise<void> {
        const target = toAbsolute(file) ?? this.activeCppFile();
        if (!target || !fs.existsSync(target)) {
            this.webview?.postMessage({ type: 'copySourceResult', payload: { ok: false, error: '请先填写或用编辑器打开一个 .cpp 源文件.' } });
            return;
        }
        try {
            const text = fs.readFileSync(target, 'utf8');
            await vscode.env.clipboard.writeText(text);
            this.webview?.postMessage({ type: 'copySourceResult', payload: { ok: true } });
        } catch (err) {
            this.webview?.postMessage({ type: 'copySourceResult', payload: { ok: false, error: String(err) } });
        }
    }

    // 由题目链接推出该站点的提交页地址
    private submitPageUrl(url: string): string | undefined {
        const target = cleanUrl(url ?? '');
        if (!target) {
            return undefined;
        }
        const refs = parseOriginals(target);
        if (refs.length) {
            return refs[0].submitUrl;
        }
        // xmoj 竞赛题: /web/contest/{cid}/{num} -> submitpage.php?cid=&pid=(0 起)
        const contest = /\/web\/contest\/(\d+)\/([A-Za-z]+)/.exec(target);
        if (contest) {
            const index = contest[2].toUpperCase().charCodeAt(0) - 65;
            return `https://www.xmoj.tech/submitpage.php?cid=${contest[1]}&pid=${index}`;
        }
        if (isXmojUrl(target)) {
            const id = /[?&]id=(\d+)/.exec(target);
            return id ? `https://www.xmoj.tech/submitpage.php?id=${id[1]}` : undefined;
        }
        // 其它站点: 直接用题目页
        return target;
    }

    // 手动提交: 复制源码并打开该题目的提交页
    private async applyOpenSubmit(file: string | undefined, url: string | undefined): Promise<void> {
        const target = toAbsolute(file) ?? this.activeCppFile();
        if (!target || !fs.existsSync(target)) {
            this.webview?.postMessage({ type: 'openSubmitResult', payload: { ok: false, error: '请先填写或用编辑器打开一个 .cpp 源文件.' } });
            return;
        }
        const page = this.submitPageUrl(url ?? '');
        if (!page) {
            this.webview?.postMessage({ type: 'openSubmitResult', payload: { ok: false, error: '无法由当前链接推出提交页地址.' } });
            return;
        }
        try {
            await vscode.env.clipboard.writeText(fs.readFileSync(target, 'utf8'));
        } catch (err) {
            this.webview?.postMessage({ type: 'openSubmitResult', payload: { ok: false, error: `复制源码失败: ${String(err)}` } });
            return;
        }
        this.output.appendLine(`[面板] 打开提交页 ${page}`);
        await vscode.env.openExternal(vscode.Uri.parse(page));
        this.webview?.postMessage({ type: 'openSubmitResult', payload: { ok: true, url: page } });
    }

    // 当前活动的 .cpp 文件
    private activeCppFile(): string | undefined {
        const editor = vscode.window.activeTextEditor;
        return editor && editor.document.fileName.toLowerCase().endsWith('.cpp')
            ? editor.document.fileName
            : undefined;
    }

    // 面板打开时把当前编辑器路径填进表单(不预置测试点)
    private pushActiveFile(): void {
        const src = this.activeCppFile();
        if (!src) {
            return;
        }
        this.webview?.postMessage({ type: 'paths', problemDir: path.dirname(src), sourceFile: src });
    }

    // 浏览题目目录
    private async browseProblemDir(): Promise<void> {
        const picked = await vscode.window.showOpenDialog({
            canSelectMany: false,
            canSelectFiles: false,
            canSelectFolders: true,
            title: '选择题目目录'
        });
        if (picked && picked.length > 0) {
            this.webview?.postMessage({ type: 'path-value', field: 'problemDir', value: picked[0].fsPath });
        }
    }

    // 浏览源文件, 联动推导题目目录(不预置测试点)
    private async browseSourceFile(): Promise<void> {
        const picked = await vscode.window.showOpenDialog({
            canSelectMany: false,
            canSelectFiles: true,
            canSelectFolders: false,
            title: '选择源文件',
            filters: { 'C++': ['cpp', 'cc', 'cxx'] }
        });
        if (!picked || picked.length === 0) {
            return;
        }
        const src = picked[0].fsPath;
        this.webview?.postMessage({ type: 'path-value', field: 'sourceFile', value: src });
        this.webview?.postMessage({ type: 'path-value', field: 'problemDir', value: path.dirname(src) });
    }

    // 浏览某个测试点的输入 / 预期输出: 先列出题目目录下的 .in / .ans 供一键选择
    private async browseCasePoint(index: number, field: 'input' | 'expected', dir?: string): Promise<void> {
        const isInput = field === 'input';
        const exts = isInput ? ['.in'] : ['.ans', '.out'];
        const base = dir ? toAbsolute(dir) : undefined;
        let files: string[] = [];
        if (base && fs.existsSync(base) && fs.statSync(base).isDirectory()) {
            files = fs.readdirSync(base)
                .filter((name) => exts.includes(path.extname(name).toLowerCase()))
                .sort()
                .map((name) => path.join(base, name));
        }
        interface PathItem extends vscode.QuickPickItem {
            file?: string;
        }
        const items: PathItem[] = files.map((file) => ({ label: path.basename(file), file }));
        items.push({ label: '浏览其他文件...' });
        const picked = await vscode.window.showQuickPick<PathItem>(items, {
            title: isInput ? '选择测试点输入 (.in)' : '选择预期输出 (.ans)',
            placeHolder: base ? `题目目录: ${base}` : '未指定题目目录'
        });
        if (!picked) {
            return;
        }
        let file = picked.file;
        if (!file) {
            const dialog = await vscode.window.showOpenDialog({
                canSelectMany: false,
                canSelectFiles: true,
                canSelectFolders: false,
                title: isInput ? '选择测试点输入 (.in)' : '选择预期输出 (.ans)',
                filters: isInput ? { Input: ['in'] } : { Output: ['ans', 'out'] }
            });
            if (!dialog || dialog.length === 0) {
                return;
            }
            file = dialog[0].fsPath;
        }
        this.webview?.postMessage({
            type: 'case-path-value',
            index,
            field,
            value: file
        });
    }
}
