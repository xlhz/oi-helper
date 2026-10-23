import * as vscode from 'vscode';
import { ContestProblemItem, ContestSummary, OriginalSummary, cleanUrl, contestProblemUrl, fetchContestFlow, fetchDifficultyFlow, fetchOriginalFlow, isContestUrl, isLuoguUrl } from './fetch';
import { parseOriginals } from './original';
import { buildProblemMarkdown } from './problem';

// 普通题目(做题)当前题号: 洛谷 /problem/P1001 -> P1001, xmoj problem.php?id=2298 -> 2298
function plainIdOf(url: string): string {
    const query = /[?&]id=([^&#]+)/i.exec(url);
    if (query) {
        return query[1];
    }
    const m = /\/([^/?#]+)\/?$/.exec(url);
    return m ? m[1] : '';
}

// 普通题目跳转: 洛谷按 /problem/<题号>, xmoj 按 ?id=<题号>, 其它 OJ 替换链接末段
function plainUrlFor(url: string, num: string): string | undefined {
    const value = num.trim().replace(/[/?#\s]/g, '');
    if (!value) {
        return undefined;
    }
    const luogu = /^(https?:\/\/[^/]*luogu\.(?:com\.cn|org))\/problem\/[^/?#]+/i.exec(url);
    if (luogu) {
        return `${luogu[1]}/problem/${value.toUpperCase()}`;
    }
    if (/[?&]id=/i.test(url)) {
        return url.replace(/([?&]id=)[^&#]*/i, `$1${encodeURIComponent(value)}`);
    }
    const m = /^(.*\/)([^/?#]+)([?#].*)?$/.exec(url);
    if (!m) {
        return undefined;
    }
    return m[1] + encodeURIComponent(value) + (m[3] ?? '');
}

function createNonce(): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let value = '';
    for (let i = 0; i < 32; i += 1) {
        value += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    }
    return value;
}

function escapeHtml(text: string): string {
    return String(text === undefined || text === null ? '' : text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// 供评测面板同步的题目导航状态
export interface ProblemNavState {
    contestId?: string;
    num?: string;
    title?: string;
    problemId?: string;
    source?: string;
    download?: string;
    endTime?: string;
    leftSeconds?: number;
    plain?: boolean; // 普通题目(做题链接): 无比赛题目列表
    problems: ContestProblemItem[];
}

// 独立的题目预览面板: 渲染题目 Markdown, 并提供 上一题/下一题/选题/题号跳转
export class ProblemView {
    private panel: vscode.WebviewPanel | undefined;

    private contestId = '';

    private problems: ContestProblemItem[] = [];

    private current: ContestSummary | undefined;

    private markdown = '';

    private banner = '';

    private titleOverride = '';

    // 普通题目(做题链接): 当前链接与题号, 用于按题目编号跳转
    private plainUrl = '';

    private plainId = '';

    // 自动获取的题目难度(洛谷难度名, 空表示未获取/不适用)
    private difficulty = '';

    private readonly listeners: ((state: ProblemNavState) => void)[] = [];

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly output: vscode.OutputChannel,
        private readonly getJudgeExe: () => string | undefined,
        private readonly promptJudgeExe: () => Promise<void>
    ) { }

    onDidChange(listener: (state: ProblemNavState) => void): void {
        this.listeners.push(listener);
    }

    navState(): ProblemNavState {
        return {
            contestId: this.contestId,
            num: this.current?.num ?? (this.plainUrl ? this.plainId : undefined),
            title: this.current?.title ?? (this.plainUrl ? this.titleOverride : undefined),
            problemId: this.current?.problemId,
            source: this.current?.source,
            download: this.current?.download,
            endTime: this.current?.endTime,
            leftSeconds: this.current?.leftSeconds,
            plain: !!this.plainUrl,
            problems: this.problems
        };
    }

    isOpen(): boolean {
        return this.panel !== undefined;
    }

    // 当前题目的链接(供评测面板同步网址导入): 普通题目用其自身链接
    currentUrl(): string | undefined {
        if (this.plainUrl) {
            return this.plainUrl;
        }
        if (!this.contestId || !this.current?.num) {
            return undefined;
        }
        return contestProblemUrl(this.contestId, this.current.num);
    }

    // 仅同步导航状态(不打开预览面板): 供评测面板网址导入后填充选题/跳转
    adopt(summary: ContestSummary): void {
        if (!summary || !summary.ok) {
            return;
        }
        this.contestId = summary.contestId || this.contestId;
        if (summary.problems && summary.problems.length > 0) {
            this.problems = summary.problems;
        }
        this.current = summary;
        this.banner = '';
        this.titleOverride = '';
        this.plainUrl = '';
        this.plainId = '';
        this.difficulty = '';
        this.markdown = buildProblemMarkdown(summary);
        this.notifyNav();
        this.loadDifficulty(this.luoguIdOfSource(summary.source));
    }

    // 仅同步普通题目状态(不打开预览面板): 供评测面板识别/导入做题链接后填充题目编号
    adoptPlain(url: string, title?: string): void {
        const target = cleanUrl(url ?? '');
        if (!target) {
            return;
        }
        this.contestId = '';
        this.problems = [];
        this.current = undefined;
        this.plainUrl = target;
        this.plainId = plainIdOf(target);
        this.titleOverride = (title ?? '').trim();
        this.difficulty = '';
        this.notifyNav();
        this.loadDifficulty(isLuoguUrl(target) ? plainIdOf(target) : '');
    }

    // 预览任意 Markdown(如原题题面): 不带竞赛导航与倒计时
    openMarkdown(title: string, markdown: string): void {
        this.current = undefined;
        this.problems = [];
        this.markdown = markdown;
        this.banner = '';
        this.difficulty = '';
        this.titleOverride = title;
        this.show();
    }

    // url 为空时仅揭示范本
    async open(url?: string): Promise<ContestSummary | OriginalSummary | undefined> {
        const target = cleanUrl(url ?? '');
        if (!target) {
            if (this.panel) {
                this.panel.reveal(vscode.ViewColumn.Active);
            }
            return this.current;
        }
        // 竞赛链接用竞赛抓取, 其它(做题链接)按普通题目抓题面
        if (!isContestUrl(target)) {
            return this.loadPlain(target);
        }
        return this.load(target);
    }

    // 按题号切换: 竞赛题跳比赛题号(A/B/C), 普通题目跳题目编号(P1001/CF1760G)
    async go(num: string): Promise<void> {
        const value = (num ?? '').trim();
        if (!value) {
            return;
        }
        if (this.plainUrl) {
            const url = plainUrlFor(this.plainUrl, value);
            if (!url) {
                vscode.window.showWarningMessage('无法由当前链接拼出新题目地址.');
                return;
            }
            // 面板内换题: 不自动打开预览窗口
            await this.loadPlain(url, false);
            return;
        }
        if (!this.contestId) {
            vscode.window.showWarningMessage('尚未载入题目, 请先打开一道题目.');
            return;
        }
        // 面板内换题: 不自动打开预览窗口
        await this.load(contestProblemUrl(this.contestId, value.toUpperCase()), false);
    }

    async prev(): Promise<void> {
        await this.step(-1);
    }

    async next(): Promise<void> {
        await this.step(1);
    }

    private async step(delta: number): Promise<void> {
        const idx = this.problems.findIndex((p) => p.num === this.current?.num);
        const target = idx >= 0 ? this.problems[idx + delta] : undefined;
        if (!target) {
            return;
        }
        // 面板内换题: 不自动打开预览窗口
        await this.load(contestProblemUrl(this.contestId, target.num), false);
    }

    private async load(url: string, reveal = true): Promise<ContestSummary | undefined> {
        const exe = this.getJudgeExe();
        if (!exe) {
            await this.promptJudgeExe();
            return undefined;
        }
        // 面板未打开且不要求预览时, 只刷新状态
        const render = (): void => {
            if (reveal || this.panel) {
                this.show();
            }
        };
        // 立刻显示面板, 避免抓取期间看不到任何反馈
        this.banner = '';
        this.difficulty = '';
        this.markdown = '# 加载中...\n';
        render();
        let summary: ContestSummary;
        try {
            this.output.appendLine(`[题目预览] 加载 ${url}`);
            summary = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: '加载题目中...', cancellable: false },
                () => fetchContestFlow(url, exe, this.output)
            );
        } catch (err) {
            summary = { ok: false, error: String(err) };
        }
        if (!summary.ok) {
            this.banner = `加载失败: ${summary.error || '未知错误'}`;
            this.markdown = '';
            this.output.appendLine(`[错误] ${this.banner}`);
            render();
            return undefined;
        }
        this.banner = '';
        this.contestId = summary.contestId || this.contestId;
        if (summary.problems && summary.problems.length > 0) {
            this.problems = summary.problems;
        }
        this.current = summary;
        this.markdown = buildProblemMarkdown(summary);
        this.titleOverride = '';
        this.plainUrl = '';
        this.plainId = '';
        render();
        this.notifyNav();
        this.loadDifficulty(this.luoguIdOfSource(summary.source));
        return summary;
    }

    // 普通题目(做题链接, 如洛谷 P1001): 抓题面 Markdown, 导航按题目编号跳转
    private async loadPlain(url: string, reveal = true): Promise<OriginalSummary | undefined> {
        const exe = this.getJudgeExe();
        if (!exe) {
            await this.promptJudgeExe();
            return undefined;
        }
        // 面板未打开且不要求预览时, 只刷新状态(跳转不自动打开预览页)
        const render = (): void => {
            if (reveal || this.panel) {
                this.show();
            }
        };
        // 立刻显示面板, 避免抓取期间看不到任何反馈
        this.banner = '';
        this.difficulty = '';
        this.markdown = '# 加载中...\n';
        render();
        let summary: OriginalSummary;
        try {
            this.output.appendLine(`[题目预览] 加载 ${url}`);
            summary = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: '加载题目中...', cancellable: false },
                () => fetchOriginalFlow(url, exe, this.output)
            );
        } catch (err) {
            summary = { ok: false, error: String(err) };
        }
        if (!summary.ok) {
            this.banner = `加载失败: ${summary.error || '未知错误'}`;
            this.markdown = '';
            this.output.appendLine(`[错误] ${this.banner}`);
            render();
            return undefined;
        }
        this.banner = '';
        this.contestId = '';
        this.problems = [];
        this.current = undefined;
        this.plainUrl = url;
        this.plainId = plainIdOf(url);
        this.titleOverride = summary.title || this.plainId || 'OI 题目预览';
        this.markdown = summary.markdown ?? '';
        render();
        this.notifyNav();
        this.loadDifficulty(isLuoguUrl(url) ? plainIdOf(url) : '');
        return summary;
    }

    // 上次已发给面板的内容, 用于增量更新时跳过未变化的部分
    private sent = { markdown: '', nav: '', banner: '' };

    // 面板是否已渲染过首屏
    private rendered = false;

    private show(): void {
        if (!this.panel) {
            this.createPanel();
        }
        const panel = this.panel;
        if (!panel) {
            return;
        }
        this.applyTitle(panel);
        // 首次渲染或关闭增量更新时重建整页; 否则只替换变化的内容(图片不会重新下载)
        const incremental = vscode.workspace.getConfiguration('oiHelper').get<boolean>('previewIncremental') ?? true;
        if (!incremental || !this.rendered) {
            this.snapshotSent();
            panel.webview.html = this.html();
            this.rendered = true;
            return;
        }
        this.postContent();
    }

    private applyTitle(panel: vscode.WebviewPanel): void {
        panel.title = this.current
            ? `${this.current.num ?? ''} ${this.current.title ?? '题目'}`.trim()
            : (this.titleOverride || 'OI 题目预览');
    }

    private snapshotSent(): void {
        this.sent = { markdown: this.markdown, nav: this.navHtml(), banner: this.banner };
    }

    private postContent(): void {
        const nav = this.navHtml();
        const payload: { markdown?: string; nav?: string; banner?: string; timer?: unknown } = {};
        if (this.markdown !== this.sent.markdown) {
            payload.markdown = this.markdown;
            this.sent.markdown = this.markdown;
        }
        if (nav !== this.sent.nav) {
            payload.nav = nav;
            this.sent.nav = nav;
        }
        if (this.banner !== this.sent.banner) {
            payload.banner = this.banner;
            this.sent.banner = this.banner;
        }
        payload.timer = this.timerInfo();
        this.panel?.webview.postMessage({ type: 'content', payload });
    }

    private createPanel(): void {
        this.panel = vscode.window.createWebviewPanel(
            'oiHelperProblemView',
            'OI 题目预览',
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
    }

    private async handleMessage(message: unknown): Promise<void> {
        if (!message || typeof message !== 'object') {
            return;
        }
        const payload = message as { type?: string; num?: string };
        switch (payload.type) {
            case 'prev':
                await this.prev();
                break;
            case 'next':
                await this.next();
                break;
            case 'goto':
                await this.go(payload.num ?? '');
                break;
            case 'copyMd':
                await this.copyMarkdown();
                break;
            case 'ready':
                // 面板首屏就绪: 补齐可能已变化的内容
                this.postContent();
                break;
            default:
                break;
        }
    }

    // 复制当前题目的 Markdown 到剪贴板
    private async copyMarkdown(): Promise<void> {
        if (!this.markdown) {
            vscode.window.showWarningMessage('暂无题目内容可复制.');
            return;
        }
        await vscode.env.clipboard.writeText(this.markdown);
        vscode.window.showInformationMessage('已复制题目 Markdown.');
    }

    private notifyNav(): void {
        const state = this.navState();
        for (const listener of this.listeners) {
            listener(state);
        }
    }

    private navHtml(): string {
        const cur = this.current?.num ?? '';
        const idx = this.problems.findIndex((p) => p.num === cur);
        const canPrev = idx > 0;
        const canNext = idx >= 0 && idx < this.problems.length - 1;
        const options = this.problems.map((p) => {
            const label = `${p.num} ${p.title || ''}`.trim();
            return `<option value="${escapeHtml(p.num)}"${p.num === cur ? ' selected' : ''}>${escapeHtml(label)}</option>`;
        }).join('');
        // 普通题目(做题): 只保留题目编号跳转与复制
        if (this.plainUrl) {
            return [
                `<input class="inp num" id="nav-num" type="text" placeholder="题目编号" value="${escapeHtml(this.plainId)}">`,
                '<button class="btn btn-accent" id="nav-goto" type="button">跳转</button>',
                '<button class="btn" id="nav-copy" type="button">复制 Markdown</button>',
                this.diffChip()
            ].join('');
        }
        // 非竞赛内容(如原题题面): 仅保留复制按钮
        if (!this.current) {
            return '<button class="btn" id="nav-copy" type="button">复制 Markdown</button>';
        }
        return [
            `<button class="btn" id="nav-prev" type="button"${canPrev ? '' : ' disabled'}>上一题</button>`,
            `<select class="inp sel" id="nav-select"${this.problems.length ? '' : ' disabled'}>${options}</select>`,
            `<button class="btn" id="nav-next" type="button"${canNext ? '' : ' disabled'}>下一题</button>`,
            `<input class="inp num" id="nav-num" type="text" placeholder="题号" value="${escapeHtml(cur)}">`,
            '<button class="btn btn-accent" id="nav-goto" type="button">跳转</button>',
            '<button class="btn" id="nav-copy" type="button">复制 Markdown</button>',
            this.diffChip(),
            '<span class="timer" id="nav-timer"></span>'
        ].join('');
    }

    // 难度徽标(自动获取自洛谷题号); 未获取时不显示
    private diffChip(): string {
        return this.difficulty ? `<span class="diff">难度 ${escapeHtml(this.difficulty)}</span>` : '';
    }

    // 由题目 source 解析洛谷题号(如 AHOI2005 P1403 -> P1403); 无则返回空
    private luoguIdOfSource(source: string | undefined): string {
        const ref = parseOriginals(source ?? '').find((r) => r.oj === 'luogu');
        return ref && ref.id ? ref.id : '';
    }

    // 自动获取题目难度: 查不到(非洛谷题/未登录/网络失败)时静默留空
    private async loadDifficulty(pid: string): Promise<void> {
        const value = (pid ?? '').trim();
        if (!value) {
            if (this.difficulty) {
                this.difficulty = '';
                if (this.panel) {
                    this.show();
                }
            }
            return;
        }
        const exe = this.getJudgeExe();
        if (!exe) {
            return;
        }
        let text = '';
        try {
            const data = await fetchDifficultyFlow(value, exe, this.output);
            text = data.ok && data.text ? data.text : '';
        } catch {
            text = '';
        }
        if (text !== this.difficulty) {
            this.difficulty = text;
            if (this.panel) {
                this.show();
            }
        }
    }

    // 比赛倒计时数据: 优先训练会话截止时间, 其次结束时间, 再退化到服务器剩余秒数
    private timerInfo(): { end?: number; left?: number } {
        const s = this.current;
        if (!s) {
            return {};
        }
        const text = (s.sessionEnd || '').trim() || s.endTime || '';
        const end = text ? new Date(text.replace(/-/g, '/')).getTime() : NaN;
        return {
            end: Number.isNaN(end) ? undefined : end,
            left: typeof s.leftSeconds === 'number' && s.leftSeconds >= 0 ? s.leftSeconds * 1000 : undefined
        };
    }

    private html(): string {
        const nonce = createNonce();
        const cspSource = this.panel ? this.panel.webview.cspSource : '';
        const md = JSON.stringify(this.markdown).replace(/</g, '\\u003c');
        const timer = JSON.stringify(this.timerInfo());
        const banner = `<div class="banner" id="banner"${this.banner ? '' : ' hidden'}>${escapeHtml(this.banner)}</div>`;
        const bannerText = JSON.stringify(this.banner ?? '');
        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data: https:; style-src ${cspSource} 'unsafe-inline' https://cdn.jsdelivr.net; script-src 'nonce-${nonce}' https://cdn.jsdelivr.net; font-src https://cdn.jsdelivr.net data:; connect-src https://cdn.jsdelivr.net;">
<title>OI 题目预览</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
<style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
        margin: 0;
        font-family: var(--vscode-font-family);
        font-size: 14px;
        line-height: 1.7;
        color: var(--vscode-editor-foreground, var(--vscode-foreground));
        background: var(--vscode-editor-background);
    }
    .topbar {
        position: sticky;
        top: 0;
        z-index: 10;
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 8px;
        padding: 10px 20px;
        background: var(--vscode-editor-background);
        border-bottom: 1px solid var(--vscode-panel-border);
    }
    .btn, .inp {
        height: 28px;
        padding: 0 10px;
        font-family: inherit;
        font-size: 12px;
        color: var(--vscode-foreground);
        background: var(--vscode-button-secondaryBackground, transparent);
        border: 1px solid var(--vscode-panel-border);
        border-radius: 4px;
        cursor: pointer;
    }
    .btn:disabled { opacity: .45; cursor: default; }
    .btn:not(:disabled):hover { border-color: var(--vscode-focusBorder); }
    .btn-accent {
        color: var(--vscode-button-foreground);
        background: var(--vscode-button-background);
        border-color: var(--vscode-button-background);
    }
    .sel { min-width: 180px; cursor: pointer; }
    .num { width: 72px; cursor: text; }
    .timer {
        margin-left: auto;
        padding-left: 12px;
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 12.5px;
        color: var(--vscode-descriptionForeground);
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
    }
    .timer-end { color: var(--vscode-errorForeground, #f0584f); }
    .diff {
        padding: 2px 10px;
        border: 1px solid var(--vscode-panel-border);
        border-radius: 999px;
        font-size: 12px;
        color: var(--vscode-descriptionForeground);
        white-space: nowrap;
    }
    .banner {
        margin: 12px 20px 0;
        padding: 8px 12px;
        color: var(--vscode-inputValidation-errorForeground, #f0584f);
        border: 1px solid var(--vscode-inputValidation-errorBorder, #f0584f);
        border-radius: 4px;
        font-size: 12.5px;
    }

    .banner[hidden] {
        display: none;
    }
    .doc {
        max-width: 860px;
        margin: 0 auto;
        padding: 16px 20px 64px;
    }
    .doc h1 { font-size: 22px; }
    .doc h2 {
        margin-top: 26px;
        padding-bottom: 6px;
        font-size: 17px;
        border-bottom: 1px solid var(--vscode-panel-border);
    }
    .doc h3 { margin-top: 20px; font-size: 15px; }
    .doc pre {
        padding: 4px 0;
        overflow: auto;
    }
    .doc code { font-family: var(--vscode-editor-font-family, monospace); font-size: 12.5px; }
    .doc pre code { font-size: 12.5px; }
    .doc table { border-collapse: collapse; }
    .doc th, .doc td { padding: 5px 12px; border: 1px solid var(--vscode-panel-border); }
    .doc blockquote {
        margin: 12px 0;
        padding: 2px 14px;
        color: var(--vscode-descriptionForeground);
        border-left: 3px solid var(--vscode-panel-border);
    }
    .doc a { color: var(--vscode-textLink-foreground); }
    .doc img { max-width: 100%; }
</style>
</head>
<body>
    <div class="topbar">${this.navHtml()}</div>
    ${banner}
    <div class="doc" id="md"></div>
<script src="https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js"></script>
<script nonce="${nonce}">
    (function () {
        const vscode = acquireVsCodeApi();
        const target = document.getElementById('md');
        const topbar = document.querySelector('.topbar');
        const bannerEl = document.getElementById('banner');
        let timerState = null;
        let timerHandle = null;
        let timerOn = false;

        // 渲染后的收尾: 公式 + 图片属性
        function decorate() {
            if (window.renderMathInElement) {
                window.renderMathInElement(target, {
                    delimiters: [
                        { left: '$$', right: '$$', display: true },
                        { left: '$', right: '$', display: false }
                    ],
                    throwOnError: false
                });
            }
            // 题面图片: 不发送 Referer, 规避部分站点的防盗链
            target.querySelectorAll('img').forEach(function (img) {
                img.referrerPolicy = 'no-referrer';
                img.loading = 'lazy';
            });
        }

        function renderMarkdown(md) {
            try {
                target.innerHTML = window.marked ? window.marked.parse(md) : '';
            } catch (e) {
                target.textContent = md;
            }
            decorate();
        }

        function renderBanner(text) {
            if (!bannerEl) {
                return;
            }
            bannerEl.textContent = text || '';
            bannerEl.hidden = !text;
        }

        function on(id, handler) {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('click', handler);
            }
        }

        function bindNav() {
            on('nav-prev', function () { vscode.postMessage({ type: 'prev' }); });
            on('nav-next', function () { vscode.postMessage({ type: 'next' }); });
            on('nav-goto', function () {
                const numEl = document.getElementById('nav-num');
                const value = numEl ? numEl.value.trim() : '';
                if (value) {
                    vscode.postMessage({ type: 'goto', num: value });
                }
            });
            on('nav-copy', function () { vscode.postMessage({ type: 'copyMd' }); });
            const sel = document.getElementById('nav-select');
            if (sel) {
                sel.addEventListener('change', function () { vscode.postMessage({ type: 'goto', num: sel.value }); });
            }
            const num = document.getElementById('nav-num');
            if (num) {
                num.addEventListener('keydown', function (e) {
                    if (e.key === 'Enter') {
                        vscode.postMessage({ type: 'goto', num: num.value.trim() });
                    }
                });
            }
        }

        function renderNav(html) {
            if (!topbar) {
                return;
            }
            topbar.innerHTML = html;
            bindNav();
        }

        // 比赛倒计时: 优先用结束时间, 否则从服务器剩余秒数起逐秒递减
        function pad2(n) { return n < 10 ? '0' + n : String(n); }

        function tick() {
            const timerEl = document.getElementById('nav-timer');
            if (!timerEl) {
                return;
            }
            if (!timerOn) {
                timerEl.textContent = '';
                return;
            }
            let ms;
            if (typeof timerState.end === 'number') {
                ms = timerState.end - Date.now();
            } else {
                ms = timerState.left;
                timerState.left = timerState.left - 1000;
            }
            if (ms <= 0) {
                timerEl.textContent = '比赛已结束';
                timerEl.className = 'timer timer-end';
                return;
            }
            const total = Math.floor(ms / 1000);
            const day = Math.floor(total / 86400);
            const hour = Math.floor((total % 86400) / 3600);
            const min = Math.floor((total % 3600) / 60);
            const sec = total % 60;
            timerEl.className = 'timer';
            timerEl.textContent = '剩余 ' + (day ? day + '天 ' : '')
                + pad2(hour) + ':' + pad2(min) + ':' + pad2(sec);
        }

        function startTimer(timer) {
            timerState = timer || {};
            timerOn = !!(timerState && (typeof timerState.end === 'number' || typeof timerState.left === 'number'));
            if (timerHandle) {
                clearInterval(timerHandle);
                timerHandle = null;
            }
            tick();
            if (timerOn) {
                timerHandle = setInterval(tick, 1000);
            }
        }

        // 首屏用服务端内联内容初始化
        renderMarkdown(${md});
        renderBanner(${bannerText});
        bindNav();
        startTimer(${timer});
        vscode.postMessage({ type: 'ready' });

        // 增量更新: 切换题目/刷新时只替换变化的部分
        window.addEventListener('message', function (event) {
            const message = event.data;
            if (!message || message.type !== 'content') {
                return;
            }
            const payload = message.payload || {};
            if (typeof payload.nav === 'string') {
                renderNav(payload.nav);
            }
            if (typeof payload.markdown === 'string') {
                renderMarkdown(payload.markdown);
            }
            if (typeof payload.banner === 'string') {
                renderBanner(payload.banner);
            }
            if (payload.timer) {
                startTimer(payload.timer);
            }
        });
    })();
</script>
</body>
</html>`;
    }
}
