import * as vscode from 'vscode';
import { normalizeCookie } from './original';

// 各 OJ Cookie: 面板元素 id / 设置键 / 必含字段
const OJ_COOKIES: { id: string; key: string; need: string[] }[] = [
    { id: 'luogu', key: 'luoguCookie', need: ['__client_id'] },
    { id: 'codeforces', key: 'codeforcesCookie', need: ['JSESSIONID'] },
    { id: 'atcoder', key: 'atcoderCookie', need: ['REVEL_SESSION', 'csrf_token'] },
    { id: 'hydro', key: 'hydroCookie', need: [] }
];

// Cookie 帮助面板: 说明各 OJ Cookie 的获取步骤, 并可直接粘贴保存
export class CookieHelp {
    private panel: vscode.WebviewPanel | undefined;

    constructor(private readonly extensionUri: vscode.Uri) { }

    show(): void {
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.Active);
            this.postState();
            return;
        }
        this.panel = vscode.window.createWebviewPanel(
            'oiHelperCookieHelp',
            'Cookie 帮助',
            vscode.ViewColumn.Active,
            { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')] }
        );
        this.panel.onDidDispose(() => {
            this.panel = undefined;
        });
        this.panel.webview.onDidReceiveMessage((message: unknown) => {
            void this.handle(message);
        });
        this.panel.webview.html = this.html();
    }

    private async handle(message: unknown): Promise<void> {
        const payload = message as { type?: string; key?: string; value?: string };
        if (payload.type === 'ready') {
            this.postState();
            return;
        }
        if (payload.type === 'openSetting' && payload.key) {
            await vscode.commands.executeCommand('workbench.action.openSettings', payload.key);
            return;
        }
        if (payload.type === 'openSettings') {
            await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:oi-helper');
            return;
        }
        // 面板传来的是完整键(oiHelper.luoguCookie), 这里按短键匹配
        const short = (payload.key ?? '').replace(/^oiHelper\./, '');
        const oj = OJ_COOKIES.find((item) => item.key === short);
        if (!oj) {
            return;
        }
        const cfg = vscode.workspace.getConfiguration('oiHelper');
        if (payload.type === 'saveCookie') {
            // 粘贴内容可能带 cookie: 前缀与换行, 统一清理后再存
            const value = normalizeCookie(payload.value ?? '');
            if (!value) {
                this.reply(oj.id, false, '请先粘贴 Cookie');
                return;
            }
            try {
                await cfg.update(oj.key, value, vscode.ConfigurationTarget.Global);
            } catch (err) {
                this.reply(oj.id, false, `保存失败: ${String(err)}`);
                return;
            }
            const missing = oj.need.filter((k) => !value.includes(k + '='));
            this.reply(oj.id, true, `已保存 · ${value.length} 字符` +
                (missing.length ? `, 未找到 ${missing.join(' / ')}` : ''));
            if (missing.length) {
                vscode.window.showWarningMessage(`Cookie 已保存, 但没有找到 ${missing.join(' / ')}, 可能无法登录.`);
            }
            return;
        }
        if (payload.type === 'clearCookie') {
            try {
                await cfg.update(oj.key, '', vscode.ConfigurationTarget.Global);
            } catch (err) {
                this.reply(oj.id, false, `清空失败: ${String(err)}`);
                return;
            }
            this.reply(oj.id, true, '已清空');
        }
    }

    private reply(id: string, ok: boolean, text: string): void {
        this.panel?.webview.postMessage({ type: 'cookieResult', id, ok, text });
    }

    // 各 Cookie 的配置状态: 只回传是否配置与长度, 不回显原文
    private postState(): void {
        const cfg = vscode.workspace.getConfiguration('oiHelper');
        const items = OJ_COOKIES.map((oj) => {
            const value = (cfg.get<string>(oj.key) ?? '').trim();
            return { id: oj.id, set: !!value, length: value.length };
        });
        this.panel?.webview.postMessage({ type: 'cookieState', items });
    }

    private html(): string {
        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
    :root { color-scheme: light dark; }
    body {
        margin: 0;
        padding: 20px 24px 40px;
        font-family: var(--vscode-font-family);
        font-size: 14px;
        line-height: 1.75;
        color: var(--vscode-editor-foreground, var(--vscode-foreground));
        background: var(--vscode-editor-background);
    }
    h1 { font-size: 20px; margin: 0 0 4px; }
    h2 { font-size: 15px; margin: 26px 0 8px; }
    p, li { margin: 4px 0; }
    ol, ul { padding-left: 22px; margin: 6px 0; }
    code {
        font-family: var(--vscode-editor-font-family);
        font-size: 12px;
        padding: 1px 5px;
        border-radius: 4px;
        background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.18));
    }
    .muted { color: var(--vscode-descriptionForeground); }
    .card {
        border: 1px solid var(--vscode-panel-border, rgba(127,127,127,0.35));
        border-radius: 6px;
        padding: 12px 16px;
        margin: 12px 0;
    }
    .card h2 { margin-top: 0; }
    .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 8px; }
    textarea {
        width: 100%;
        min-height: 62px;
        margin-top: 6px;
        padding: 6px 8px;
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 12px;
        color: var(--vscode-input-foreground);
        background: var(--vscode-input-background);
        border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
        border-radius: 4px;
        resize: vertical;
    }
    .state { font-size: 12px; color: var(--vscode-descriptionForeground); }
    .state.err { color: var(--vscode-errorForeground, #f0584f); }
    .state.ok { color: var(--vscode-terminal-ansiGreen, #3fb950); }
    button {
        font-family: inherit;
        font-size: 13px;
        padding: 4px 12px;
        border-radius: 4px;
        border: 1px solid transparent;
        cursor: pointer;
        color: var(--vscode-button-foreground);
        background: var(--vscode-button-background);
    }
    button.secondary {
        color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
        background: var(--vscode-button-secondaryBackground, rgba(127,127,127,0.25));
    }
    button:hover { opacity: 0.9; }
</style>
</head>
<body>
    <h1>Cookie 帮助</h1>
    <p class="muted">只有「直连提交到原题」必须配 Cookie; 抓取题面与样例一般不需要(洛谷题目需登录时除外)。</p>

    <h2>通用步骤</h2>
    <ol>
        <li>用浏览器登录对应网站。</li>
        <li>按 <code>F12</code> 打开开发者工具, 切到 <strong>Network(网络)</strong> 面板。</li>
        <li>刷新页面, 随便点一个请求, 找到 <strong>Request Headers(请求标头)</strong> 里的 <code>Cookie:</code> 那一行。</li>
        <li>复制 <code>Cookie:</code> <strong>冒号后面的一整段</strong>, 粘贴到下面任意一个输入框里点保存即可。</li>
    </ol>
    <p><strong>要点: 整段一起复制, 不要只挑一条。</strong>一条 Cookie 头里有很多条(如 <code>_uid</code>、<code>__client_id</code>、<code>C3VK</code>),
    单看名字看不出该用哪条, 直接整段粘贴即可, 换行与 <code>cookie:</code> 前缀会被自动清理。</p>
    <p class="muted">最快的做法: 在 Network 面板找到 <code>Cookie</code> 那一行, 右键 <strong>Copy value(复制值)</strong>, 或双击该行后全选复制。</p>

    <div class="card">
        <h2>洛谷</h2>
        <p>必须包含: <code>__client_id</code>(登录凭据)。<code>_uid</code> 建议一起带。</p>
        <p class="muted">像 <code>C3VK</code>、<code>__cf_bm</code> 这些不是登录凭据, 有没有都行。用于: 抓取需登录的洛谷题目(如私有团队题)、直连提交。</p>
        <textarea id="in-luogu" placeholder="粘贴整段 Cookie, 如 __client_id=xxx; _uid=123"></textarea>
        <div class="row">
            <button data-save="oiHelper.luoguCookie" data-in="in-luogu">保存</button>
            <button class="secondary" data-clear="oiHelper.luoguCookie" data-in="in-luogu">清空</button>
            <span class="state" id="st-luogu"></span>
        </div>
    </div>

    <div class="card">
        <h2>Codeforces</h2>
        <p>必须包含: <code>JSESSIONID</code>(登录凭据)。</p>
        <p class="muted">若提交被 Cloudflare 拦(提示「Just a moment...」), 先在浏览器正常打开一次 Codeforces 通过人机验证, 再把 <code>cf_clearance</code> 一起复制进来。
        只带 <code>cf_clearance</code> 只能过验证, 缺少 <code>JSESSIONID</code> 提交仍会失败。题面/样例抓取走本机 <code>curl</code>, 不需要 Cookie。</p>
        <textarea id="in-codeforces" placeholder="粘贴整段 Cookie, 如 JSESSIONID=xxx; cf_clearance=xxx"></textarea>
        <div class="row">
            <button data-save="oiHelper.codeforcesCookie" data-in="in-codeforces">保存</button>
            <button class="secondary" data-clear="oiHelper.codeforcesCookie" data-in="in-codeforces">清空</button>
            <span class="state" id="st-codeforces"></span>
        </div>
    </div>

    <div class="card">
        <h2>AtCoder</h2>
        <p>必须包含: <code>REVEL_SESSION</code>(登录凭据) 与 <code>csrf_token</code>(提交表单校验)。</p>
        <p class="muted">若提示「未取到 csrf_token」, 就是整行里缺这一条, 按通用步骤重新复制整段。</p>
        <textarea id="in-atcoder" placeholder="粘贴整段 Cookie, 如 REVEL_SESSION=xxx; csrf_token=xxx"></textarea>
        <div class="row">
            <button data-save="oiHelper.atcoderCookie" data-in="in-atcoder">保存</button>
            <button class="secondary" data-clear="oiHelper.atcoderCookie" data-in="in-atcoder">清空</button>
            <span class="state" id="st-atcoder"></span>
        </div>
    </div>

    <div class="card">
        <h2>Hydro</h2>
        <p>必须包含: 登录后的整段 Cookie 即可(各站会话字段名不同, 无法逐一列出)。</p>
        <p class="muted">同时要填写站点地址 <code>oiHelper.hydroBase</code>(如 <code>https://hydro.ac</code>), 否则无法由来源拼出原题链接。</p>
        <textarea id="in-hydro" placeholder="粘贴整段 Cookie"></textarea>
        <div class="row">
            <button data-save="oiHelper.hydroCookie" data-in="in-hydro">保存</button>
            <button class="secondary" data-clear="oiHelper.hydroCookie" data-in="in-hydro">清空</button>
            <span class="state" id="st-hydro"></span>
            <button class="secondary" data-setting="oiHelper.hydroBase">打开站点地址设置</button>
        </div>
    </div>

    <div class="card">
        <h2>XMOJ</h2>
        <p>不用 Cookie: 在设置里填 <code>oiHelper.xmojUser</code> 与 <code>oiHelper.xmojPassword</code> 即可(登录后自动维护会话)。</p>
        <div class="row"><button data-setting="oiHelper.xmojUser">打开该设置</button></div>
    </div>

    <h2>提醒</h2>
    <ul>
        <li>Cookie 等同于登录凭据, 只保存在本机设置中, 不要外发或提交到仓库。</li>
        <li>退出登录或过一段时间后 Cookie 会失效, 表现为「未登录」, 重新复制一次即可。</li>
        <li>不想配 Cookie 时, 可把提交方式设为 <code>browser</code>: 点「提交原题」会打开提交页并把源码复制到剪贴板, 由你手动粘贴提交。</li>
    </ul>

    <div class="row">
        <button class="secondary" data-setting="">打开全部 OI Helper 设置</button>
    </div>

<script>
    const vscode = acquireVsCodeApi();
    // 去掉 cookie: 前缀与换行, 与扩展侧保存逻辑保持一致
    function clean(value) {
        return String(value || '')
            .split(/[\\r\\n\\t]+/)
            .map(function (part) { return part.trim().replace(/^cookie:\\s*/i, '').trim(); })
            .filter(function (part) { return part; })
            .join('; ');
    }
    function setState(inputId, text, kind) {
        const el = document.getElementById('st-' + inputId.replace(/^in-/, ''));
        if (!el) {
            return;
        }
        el.textContent = text || '';
        el.className = 'state' + (kind ? ' ' + kind : '');
    }
    document.querySelectorAll('button[data-save]').forEach(function (btn) {
        btn.addEventListener('click', function () {
            const input = document.getElementById(btn.getAttribute('data-in'));
            const value = clean(input ? input.value : '');
            if (!value) {
                setState(btn.getAttribute('data-in'), '请先粘贴 Cookie', 'err');
                return;
            }
            setState(btn.getAttribute('data-in'), '保存中...', '');
            vscode.postMessage({ type: 'saveCookie', key: btn.getAttribute('data-save'), value: value });
        });
    });
    document.querySelectorAll('button[data-clear]').forEach(function (btn) {
        btn.addEventListener('click', function () {
            const input = document.getElementById(btn.getAttribute('data-in'));
            if (input) {
                input.value = '';
            }
            vscode.postMessage({ type: 'clearCookie', key: btn.getAttribute('data-clear') });
        });
    });
    document.querySelectorAll('button[data-setting]').forEach(function (btn) {
        btn.addEventListener('click', function () {
            const key = btn.getAttribute('data-setting');
            if (key) {
                vscode.postMessage({ type: 'openSetting', key: key });
            } else {
                vscode.postMessage({ type: 'openSettings' });
            }
        });
    });
    window.addEventListener('message', function (event) {
        const message = event.data || {};
        if (message.type === 'cookieResult') {
            setState('in-' + message.id, message.text, message.ok ? 'ok' : 'err');
            if (message.ok) {
                const input = document.getElementById('in-' + message.id);
                if (input) {
                    input.value = '';
                }
            }
            return;
        }
        if (message.type === 'cookieState') {
            (message.items || []).forEach(function (item) {
                setState('in-' + item.id,
                    item.set ? ('已配置 · ' + item.length + ' 字符') : '未配置',
                    item.set ? 'ok' : '');
            });
        }
    });
    vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
    }
}
