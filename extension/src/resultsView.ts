import * as vscode from 'vscode';
import * as path from 'path';
import { JudgeResult } from './judge';

function createNonce(): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let value = '';
    for (let i = 0; i < 32; i += 1) {
        value += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    }
    return value;
}

// 提交结果(提交后自动轮询, 与评测结果一起显示在结果视图)
export interface SubmitViewState {
    title?: string;       // 题目/提交标识
    solutionId?: number | string;  // 提交号(Hydro 为 24 位十六进制串)
    text?: string;        // 状态文本(评测中 / Accepted / ...)
    pending?: boolean;    // 是否仍在评测
    timeMs?: number;
    memoryKb?: number;
}

// 右侧「评测结果」视图: 用 webview 直接呈现最近一次评测详情
export class ResultsView implements vscode.WebviewViewProvider {
    private view: vscode.WebviewView | undefined;

    private last: JudgeResult | undefined;

    private submit: SubmitViewState | undefined;

    private running = false;

    constructor(private readonly extensionUri: vscode.Uri) { }

    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
        view.webview.html = this.html();
        view.webview.onDidReceiveMessage((message: { type?: string; file?: string; line?: number }) => {
            if (message && message.type === 'ready') {
                this.post();
            } else if (message && message.type === 'openFile' && message.file) {
                void this.openInEditor(message.file, message.line || 0);
            } else if (message && message.type === 'reset') {
                this.reset();
            }
        });
        view.onDidDispose(() => {
            this.view = undefined;
        });
    }

    // 编译报错跳转: 打开报错引用的源文件并定位到对应行
    private async openInEditor(file: string, line: number): Promise<void> {
        let target = file;
        if (!path.isAbsolute(target)) {
            const folders = vscode.workspace.workspaceFolders;
            if (folders && folders.length > 0) {
                target = path.join(folders[0].uri.fsPath, target);
            }
        }
        try {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
            const editor = await vscode.window.showTextDocument(doc, { preview: true });
            const row = Math.max(0, Math.min(line - 1, Math.max(0, doc.lineCount - 1)));
            const pos = new vscode.Position(row, 0);
            editor.selection = new vscode.Selection(pos, pos);
            editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        } catch {
            vscode.window.showWarningMessage('无法打开源文件: ' + target);
        }
    }

    // 评测激活/结束: 结果视图在等待态与结果态之间切换
    setRunning(running: boolean): void {
        this.running = running;
        this.post();
    }

    showResult(result: JudgeResult): void {
        this.running = false;
        this.last = result;
        this.post();
    }

    // 提交后自动轮询到的结果: 与评测卡片并列显示
    showSubmit(state: SubmitViewState | undefined): void {
        this.submit = state;
        this.post();
    }

    // 最近一次评测结果, 供提交前判断是否 AC
    lastResult(): JudgeResult | undefined {
        return this.last;
    }

    // 重置: 清空评测与提交结果, 回到空态
    reset(): void {
        this.running = false;
        this.last = undefined;
        this.submit = undefined;
        this.post();
    }

    refresh(): void {
        this.post();
    }

    private post(): void {
        if (this.running) {
            this.view?.webview.postMessage({ type: 'running' });
        } else {
            this.view?.webview.postMessage({ type: 'result', payload: this.last ?? null });
        }
        this.view?.webview.postMessage({ type: 'submit', payload: this.submit ?? null });
    }

    private html(): string {
        const nonce = createNonce();
        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
    * { box-sizing: border-box; }
    body {
        margin: 0;
        padding: 12px;
        font-family: var(--vscode-font-family);
        font-size: 13px;
        color: var(--vscode-foreground);
    }
    .tnum { font-variant-numeric: tabular-nums; }
    .topbar { display: flex; justify-content: flex-end; margin-bottom: 8px; }
    .topbar[hidden] { display: none; }
    .empty {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
        margin: 24px 0;
        text-align: center;
        color: var(--vscode-descriptionForeground);
    }
    .running {
        display: none;
        align-items: center;
        justify-content: center;
        gap: 8px;
        margin: 24px 0;
        color: var(--vscode-descriptionForeground);
    }
    .running.on { display: flex; }
    .spin {
        width: 12px;
        height: 12px;
        border: 2px solid var(--vscode-descriptionForeground);
        border-top-color: transparent;
        border-radius: 50%;
        animation: spin 800ms linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .card { display: none; flex-direction: column; gap: 14px; }
    .card.visible { display: flex; }
    .head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
    .vd {
        padding: 2px 8px;
        border: 1px solid transparent;
        border-radius: 999px;
        font-size: 11px;
        font-weight: 600;
        letter-spacing: .04em;
    }
    .vd-ac { color: var(--vscode-testing-iconPassed); border-color: var(--vscode-testing-iconPassed); }
    .vd-wa, .vd-re, .vd-ce { color: var(--vscode-testing-iconFailed); border-color: var(--vscode-testing-iconFailed); }
    .vd-tle, .vd-mle { color: var(--vscode-list-warningForeground); border-color: var(--vscode-list-warningForeground); }
    .name {
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        font-weight: 600;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .time { font-size: 11px; color: var(--vscode-descriptionForeground); }
    .score { display: flex; align-items: baseline; gap: 8px; }
    .score b { font-size: 26px; }
    .score span { font-size: 12px; color: var(--vscode-descriptionForeground); }
    .kpis { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
    .kpis div { padding: 8px 10px; border-radius: 6px; }
    .kpis span { display: block; font-size: 11px; color: var(--vscode-descriptionForeground); }
    section {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding-top: 12px;
        border-top: 1px solid var(--vscode-panel-border);
    }
    h4 {
        margin: 0;
        font-size: 11px;
        font-weight: 600;
        letter-spacing: .04em;
        color: var(--vscode-descriptionForeground);
    }
    .subtask { margin-bottom: 10px; }
    .subtask-head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 12px; }
    .subtask-name { font-weight: 600; }
    .subtask-tests {
        font-family: var(--vscode-editor-font-family);
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
    }
    .subtask-note { margin-left: auto; font-size: 11px; }
    .ok { color: var(--vscode-testing-iconPassed); }
    .err { color: var(--vscode-testing-iconFailed); }
    .bar { margin-top: 6px; height: 6px; border-radius: 3px; overflow: hidden; }
    .bar i { display: block; height: 100%; border-radius: 3px; background: var(--vscode-progressBar-background); }
    .bar i.full { width: 100%; background: var(--vscode-testing-iconPassed); }
    .bar i.zero { width: 0; }
    .row {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 8px;
        padding: 6px 0;
        border-bottom: 1px solid var(--vscode-panel-border);
        font-size: 12px;
    }
    .row:last-child { border-bottom: none; }
    .idx { font-family: var(--vscode-editor-font-family); color: var(--vscode-descriptionForeground); }
    .ms { margin-left: auto; color: var(--vscode-descriptionForeground); }
    .mem, .sc { color: var(--vscode-descriptionForeground); }
    .msg {
        flex: 1 1 100%;
        font-size: 11px;
        line-height: 1.5;
        color: var(--vscode-testing-iconFailed);
        word-break: break-all;
    }
    .fail {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: 6px 0;
        border-bottom: 1px solid var(--vscode-panel-border);
        font-size: 11.5px;
        line-height: 1.5;
        color: var(--vscode-descriptionForeground);
    }
    .fail:last-child { border-bottom: none; }
    .fail-head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; cursor: pointer; }
    .fail-head .caret { width: 8px; color: var(--vscode-descriptionForeground); }
    .fail-head .txt { flex: 1 1 auto; min-width: 0; word-break: break-all; }
    .fail-body {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 6px 0 2px 16px;
    }
    .fail-body[hidden] { display: none; }
    .cmp { display: flex; flex-direction: column; gap: 2px; font-family: var(--vscode-editor-font-family); font-size: 11.5px; }
    .c-line { display: flex; gap: 8px; white-space: pre-wrap; word-break: break-all; }
    .c-line .tag { flex: 0 0 auto; color: var(--vscode-descriptionForeground); }
    .c-line .hl { border-radius: 3px; padding: 0 3px; background: var(--vscode-diffEditor-removedTextBackground); }
    .btn {
        align-self: flex-start;
        padding: 3px 8px;
        border: 1px solid var(--vscode-panel-border);
        border-radius: 4px;
        background: transparent;
        color: var(--vscode-foreground);
        cursor: pointer;
        font-size: 11px;
    }
    .btn:hover { background: var(--vscode-toolbar-hoverBackground); }
    .full { max-height: 240px; overflow: auto; }
    .full[hidden] { display: none; }
    .lnk { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: underline; }
    .mono {
        padding: 8px 10px;
        border-radius: 6px;
        font-family: var(--vscode-editor-font-family);
        font-size: 11.5px;
        line-height: 1.6;
        white-space: pre-wrap;
        word-break: break-all;
        color: var(--vscode-descriptionForeground);
    }
</style>
</head>
<body>
    <div class="topbar" id="topbar" hidden>
        <button class="btn" id="reset" title="清除评测与提交结果">重置</button>
    </div>
    <div class="empty" id="empty">
        <span>暂无评测结果</span>
    </div>
    <div class="running" id="running">
        <span class="spin"></span>
        <span>评测中...</span>
    </div>
    <div class="card" id="submit-card">
        <div class="head">
            <span class="vd" id="s-status">--</span>
            <strong class="name" id="s-title">已提交</strong>
            <span class="time" id="s-time"></span>
        </div>
        <div class="kpis">
            <div><span>提交号</span><b class="tnum" id="s-id">-</b></div>
            <div><span>耗时</span><b class="tnum" id="s-ms">-</b></div>
            <div><span>内存</span><b class="tnum" id="s-mem">-</b></div>
        </div>
    </div>
    <div class="card" id="card">
        <div class="head">
            <span class="vd" id="status">--</span>
            <strong class="name" id="problem">-</strong>
            <span class="time" id="time"></span>
        </div>
        <div class="score"><b class="tnum" id="score">--/--</b><span>总分</span></div>
        <div class="kpis">
            <div><span>通过点</span><b class="tnum" id="passed">0/0</b></div>
            <div><span>最大耗时</span><b class="tnum" id="maxtime">0 ms</b></div>
            <div><span>最大内存</span><b class="tnum" id="maxmem">0 MB</b></div>
        </div>
        <section id="subtask-block">
            <h4>子任务计分</h4>
            <div id="subtasks"></div>
        </section>
        <section>
            <h4>测试点</h4>
            <div id="tests"></div>
        </section>
        <section id="fail-block">
            <h4>失败点诊断</h4>
            <div id="fails"></div>
        </section>
        <section>
            <h4>编译信息</h4>
            <div class="mono" id="compile"></div>
        </section>
    </div>
<script nonce="${nonce}">
    const vscodeApi = acquireVsCodeApi();
    const STATUS_CLASS = { AC: 'vd-ac', WA: 'vd-wa', TLE: 'vd-tle', MLE: 'vd-mle', RE: 'vd-re', CE: 'vd-ce' };

    function statusClass(status) {
        return STATUS_CLASS[status] || 'vd-re';
    }

    function escapeHtml(value) {
        return String(value === undefined || value === null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function formatMemory(memoryKb) {
        if (memoryKb === undefined || memoryKb === null) {
            return '—';
        }
        return memoryKb >= 1024 ? (memoryKb / 1024).toFixed(1) + ' MB' : String(memoryKb) + ' KB';
    }

    function setText(id, text) {
        const el = document.getElementById(id);
        if (el) {
            el.textContent = text;
        }
    }

    function renderSubtasks(result) {
        const list = document.getElementById('subtasks');
        const block = document.getElementById('subtask-block');
        const subtasks = result.subtasks || [];
        block.style.display = subtasks.length ? '' : 'none';
        list.innerHTML = subtasks.map(function (item) {
            const full = item.maxScore > 0 && item.score >= item.maxScore;
            const note = full ? '<span class="subtask-note ok">满分</span>' : '<span class="subtask-note err">含失败点 · 该组不得分</span>';
            return '<div class="subtask"><div class="subtask-head">'
                + '<span class="subtask-name">子任务 #' + escapeHtml(item.id) + '</span>'
                + '<span class="tnum">' + escapeHtml(item.score) + '/' + escapeHtml(item.maxScore) + '</span>'
                + '<span class="subtask-tests">测试点 [' + (item.tests || []).map(escapeHtml).join(', ') + ']</span>'
                + note + '</div>'
                + '<div class="bar"><i class="' + (full ? 'full' : 'zero') + '"></i></div></div>';
        }).join('');
    }

    function renderTests(result) {
        const list = document.getElementById('tests');
        const tests = result.tests || [];
        if (!tests.length) {
            list.innerHTML = '<div class="row"><span class="idx">暂无测试点结果</span></div>';
            return;
        }
        list.innerHTML = tests.map(function (t) {
            const msg = t.status !== 'AC' && t.message ? '<span class="msg">' + escapeHtml(t.message) + '</span>' : '';
            return '<div class="row">'
                + '<span class="idx">#' + escapeHtml(t.id) + '</span>'
                + '<span class="vd ' + statusClass(t.status) + '">' + escapeHtml(t.status) + '</span>'
                + '<span class="ms tnum">' + escapeHtml(t.timeMs || 0) + ' ms</span>'
                + '<span class="mem tnum">' + escapeHtml(formatMemory(t.memoryKb)) + '</span>'
                + '<span class="sc tnum">' + escapeHtml(t.score) + '/' + escapeHtml(t.maxScore) + '</span>'
                + msg + '</div>';
        }).join('');
    }

    // 失败点详情: RE 展示 stderr; WA 展示首个不同行对比并可展开完整实际输出
    function failDetail(t) {
        const parts = [];
        if (t.status === 'RE' && t.stderr) {
            parts.push('<div class="mono">' + escapeHtml(t.stderr) + '</div>');
        }
        const actual = String(t.actual === undefined || t.actual === null ? '' : t.actual);
        const expected = String(t.expected === undefined || t.expected === null ? '' : t.expected);
        if (t.status === 'WA' && (actual || expected)) {
            const line = t.diffLine || 0;
            let rows = '';
            if (line > 0) {
                const el = expected.split('\\n')[line - 1];
                const al = actual.split('\\n')[line - 1];
                rows += '<div class="c-line"><span class="tag">期望</span><span class="hl">'
                    + escapeHtml(el === undefined ? '(缺行)' : el) + '</span></div>';
                rows += '<div class="c-line"><span class="tag">实际</span><span class="hl">'
                    + escapeHtml(al === undefined ? '(缺行)' : al) + '</span></div>';
            }
            parts.push('<div class="cmp">' + rows + '</div>');
            parts.push('<button class="btn more">展开完整实际输出</button>');
            parts.push('<div class="mono full" hidden>' + escapeHtml(actual || '(无输出)') + '</div>');
        }
        if (!parts.length) {
            parts.push('<div class="mono">' + escapeHtml(t.message || '无附加信息') + '</div>');
        }
        return parts.join('');
    }

    function renderFails(result) {
        const list = document.getElementById('fails');
        const block = document.getElementById('fail-block');
        const fails = (result.tests || []).filter(function (t) { return t.status !== 'AC'; });
        block.style.display = fails.length ? '' : 'none';
        list.innerHTML = fails.map(function (t) {
            return '<div class="fail">'
                + '<div class="fail-head"><span class="caret">\u25b8</span>'
                + '<span class="vd ' + statusClass(t.status) + '">' + escapeHtml(t.status) + '</span>'
                + '<span class="idx">#' + escapeHtml(t.id) + '</span>'
                + '<span class="txt">' + escapeHtml(t.message || '无附加信息') + '</span></div>'
                + '<div class="fail-body" hidden>' + failDetail(t) + '</div></div>';
        }).join('');
    }

    function renderCompile(result) {
        const block = document.getElementById('compile');
        if (result.compileMessage) {
            const lines = String(result.compileMessage).split('\\n');
            block.innerHTML = '<span class="err">编译失败</span>\\n' + lines.map(function (line) {
                const m = line.match(/^(.+?):(\\d+):(\\d+):\\s*(fatal error|error|warning|note):(.*)$/);
                if (m) {
                    return '<span class="lnk" data-file="' + escapeHtml(m[1]) + '" data-line="' + escapeHtml(m[2]) + '">'
                        + escapeHtml(m[1] + ':' + m[2] + ':' + m[3]) + '</span>:'
                        + escapeHtml(m[4]) + ':' + escapeHtml(m[5]);
                }
                return escapeHtml(line);
            }).join('\\n');
            return;
        }
        block.textContent = (result.env || 'g++') + ' · ' + (result.isolation || '')
            + (result.isolationDegraded ? ' (降级)' : '') + '\\n编译通过';
    }

    let curState = 'empty';
    let hasSubmit = false;

    // 空态仅在既无评测结果也无提交结果时显示
    function renderState(state) {
        curState = state || 'empty';
        const empty = document.getElementById('empty');
        const running = document.getElementById('running');
        const card = document.getElementById('card');
        empty.style.display = (curState === 'empty' && !hasSubmit) ? '' : 'none';
        running.classList.toggle('on', curState === 'running');
        card.classList.toggle('visible', curState === 'card');
        const topbar = document.getElementById('topbar');
        topbar.hidden = !(curState === 'card' || hasSubmit);
    }

    function renderResult(payload) {
        if (!payload) {
            renderState('empty');
            return;
        }
        renderState('card');
        const statusEl = document.getElementById('status');
        statusEl.className = 'vd ' + statusClass(payload.status);
        statusEl.textContent = payload.status || '--';
        setText('problem', payload.problem || '-');
        setText('time', new Date().toLocaleString('zh-CN', { hour12: false }));
        setText('score', (payload.totalScore || 0) + '/' + (payload.maxScore || 0));
        const tests = payload.tests || [];
        let passed = 0;
        let maxTime = 0;
        let maxMem = 0;
        tests.forEach(function (t) {
            if (t.status === 'AC') {
                passed += 1;
            }
            maxTime = Math.max(maxTime, t.timeMs || 0);
            maxMem = Math.max(maxMem, t.memoryKb || 0);
        });
        setText('passed', passed + '/' + tests.length);
        setText('maxtime', maxTime + ' ms');
        setText('maxmem', formatMemory(tests.length ? maxMem : null));
        renderSubtasks(payload);
        renderTests(payload);
        renderFails(payload);
        renderCompile(payload);
    }

    // 提交结果卡片: 提交后自动轮询刷新
    function renderSubmit(payload) {
        const card = document.getElementById('submit-card');
        if (!card) {
            return;
        }
        hasSubmit = !!payload;
        if (!payload) {
            card.classList.remove('visible');
            renderState(curState);
            return;
        }
        card.classList.add('visible');
        renderState(curState);
        const statusEl = document.getElementById('s-status');
        const text = payload.text || (payload.pending ? '评测中' : '已提交');
        const kind = text === 'Accepted' ? 'vd-ac' : (payload.pending ? 'vd-tle' : 'vd-re');
        statusEl.className = 'vd ' + kind;
        statusEl.textContent = text;
        setText('s-title', payload.title || '提交');
        setText('s-time', new Date().toLocaleString('zh-CN', { hour12: false }));
        setText('s-id', payload.solutionId || '-');
        setText('s-ms', payload.timeMs ? payload.timeMs + ' ms' : '—');
        setText('s-mem', formatMemory(payload.memoryKb));
    }

    // 失败点诊断: 点击标题展开/收起详情, 点击按钮展开完整实际输出
    document.getElementById('fails').addEventListener('click', function (event) {
        const more = event.target.closest('.more');
        if (more) {
            const full = more.parentNode.querySelector('.full');
            if (full) {
                const hidden = full.hasAttribute('hidden');
                if (hidden) {
                    full.removeAttribute('hidden');
                } else {
                    full.setAttribute('hidden', '');
                }
                more.textContent = hidden ? '收起完整实际输出' : '展开完整实际输出';
            }
            return;
        }
        const head = event.target.closest('.fail-head');
        if (head) {
            const body = head.parentNode.querySelector('.fail-body');
            if (body) {
                const hidden = body.hasAttribute('hidden');
                if (hidden) {
                    body.removeAttribute('hidden');
                } else {
                    body.setAttribute('hidden', '');
                }
                const caret = head.querySelector('.caret');
                if (caret) {
                    caret.textContent = hidden ? '\u25be' : '\u25b8';
                }
            }
        }
    });

    // 编译报错: 点击「文件:行:列」跳转到对应源文件行
    document.getElementById('compile').addEventListener('click', function (event) {
        const link = event.target.closest('.lnk');
        if (link) {
            vscodeApi.postMessage({
                type: 'openFile',
                file: link.getAttribute('data-file'),
                line: Number(link.getAttribute('data-line')) || 0
            });
        }
    });

    // 重置: 清空评测与提交结果, 回到空态
    document.getElementById('reset').addEventListener('click', function () {
        vscodeApi.postMessage({ type: 'reset' });
    });

    window.addEventListener('message', function (event) {
        const message = event.data;
        if (!message) {
            return;
        }
        if (message.type === 'result') {
            renderResult(message.payload);
        } else if (message.type === 'running') {
            renderState('running');
        } else if (message.type === 'submit') {
            renderSubmit(message.payload);
        }
    });

    vscodeApi.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
    }
}