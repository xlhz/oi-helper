import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CollabServer } from './collab';
import { LuoguEvent, LuoguSnapshot, LuoguWatcher, normalizeCookie, parseContestId } from './luoguContest';

function createNonce(): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let value = '';
    for (let i = 0; i < 32; i += 1) {
        value += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    }
    return value;
}

// 本机局域网 IPv4, 供队友加入
function lanAddress(): string {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const net of nets[name] ?? []) {
            if (net.family === 'IPv4' && !net.internal) {
                return net.address;
            }
        }
    }
    return '127.0.0.1';
}

interface ContestMessage {
    type?: string;
    url?: string;
    port?: number;
    room?: string;
    name?: string;
    host?: string;
    file?: string;
    content?: string;
    text?: string;
    line?: number;
}

// ICPC 比赛视图: 洛谷实时同步 + 队伍协作
export class ContestView implements vscode.WebviewViewProvider {
    private view: vscode.WebviewView | undefined;

    private watcher: LuoguWatcher | undefined;

    private collab: CollabServer | undefined;

    private shareTimer: NodeJS.Timeout | undefined;

    private lastShare = '';

    private disposables: vscode.Disposable[] = [];

    private room = '';

    private peerName = '';

    private eventSink: ((event: Record<string, unknown>) => void) | undefined;

    constructor(private readonly extensionUri: vscode.Uri, private readonly output: vscode.OutputChannel) { }

    // 桌面事件源就绪后注入上报回调
    setEventSink(sink: (event: Record<string, unknown>) => void): void {
        this.eventSink = sink;
    }

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
            this.stopAll();
            if (this.view === view) {
                this.view = undefined;
            }
        });
        this.registerShareListeners();
        this.postState();
    }

    // 聚焦比赛视图
    open(): void {
        void vscode.commands.executeCommand('oiHelperContest.focus');
    }

    // 停止同步与协作
    dispose(): void {
        this.stopAll();
    }

    private async handleMessage(message: unknown): Promise<void> {
        if (!message || typeof message !== 'object') {
            return;
        }
        const payload = message as ContestMessage;
        switch (payload.type) {
            case 'ready':
                this.postState();
                break;
            case 'sync':
                this.startSync(payload.url ?? '');
                break;
            case 'stopSync':
                this.stopSync();
                break;
            case 'collabStart':
                await this.startCollab(payload);
                break;
            case 'collabStop':
                this.stopCollab();
                break;
            case 'share':
                this.shareActiveFile();
                break;
            case 'setShare':
                this.setShare(Boolean((payload as any).enabled));
                break;
            case 'savePeerCode':
                await this.savePeerCode(payload.file ?? '', payload.content ?? '');
                break;
            default:
                break;
        }
    }

    // 洛谷比赛同步: 15 秒一轮
    private startSync(rawUrl: string): void {
        const id = parseContestId(rawUrl);
        if (!id) {
            this.postToast('warn', '请输入洛谷比赛链接, 例如 https://www.luogu.com.cn/contest/123456');
            return;
        }
        const cfg = vscode.workspace.getConfiguration('oiHelper');
        const cookie = normalizeCookie(cfg.get<string>('luoguCookie') ?? '');
        if (!cookie) {
            this.postToast('warn', '未配置洛谷 Cookie, 请在设置中填写 oiHelper.luoguCookie');
            return;
        }
        const seconds = Number(cfg.get<number>('contestSyncSeconds')) || 15;
        const freezeMinutes = Number(cfg.get<number>('contestFreezeMinutes')) || 0;
        this.stopSync();
        this.output.appendLine(`[比赛] 开始同步洛谷比赛 ${id}, 间隔 ${seconds}s`);
        this.watcher = new LuoguWatcher(
            id,
            cookie,
            seconds * 1000,
            (snapshot) => this.postLuogu(snapshot),
            (event) => this.notifyEvent(event, id),
            freezeMinutes
        );
        this.watcher.start();
        this.postToast('info', `正在同步比赛 ${id}`);
    }

    private stopSync(): void {
        if (this.watcher) {
            this.watcher.stop();
            this.watcher = undefined;
        }
    }

    private stopAll(): void {
        this.stopSync();
        this.stopCollab();
        this.setShare(false);
        for (const d of this.disposables) {
            d.dispose();
        }
        this.disposables = [];
    }

    // 榜单事件: 面板内展示, 比赛类事件交给桌面统一事件源
    private notifyEvent(event: LuoguEvent, contestId: number): void {
        this.view?.webview.postMessage({ type: 'event', payload: event });
        const type = event.kind === 'first-blood'
            ? 'first_blood'
            : (event.kind === 'ac' ? 'teammate_submit' : event.kind);
        if (type === 'first_blood' || type === 'teammate_submit' || type === 'freeze' || type === 'unfreeze') {
            const info = this.watcher?.snapshot()?.info;
            const recordId = event.id.includes(':') ? event.id.split(':').pop() || '' : '';
            this.eventSink?.({
                type,
                time: new Date(event.at * 1000).toISOString(),
                source: 'luogu',
                payload: {
                    contest: info?.name || `比赛 ${contestId}`,
                    contestId: String(contestId),
                    oj: 'luogu',
                    problem: event.label || '',
                    submitId: recordId,
                    user: event.user || '',
                    title: event.text
                }
            });
            return;
        }
        if (event.kind === 'announcement') {
            void vscode.window.showInformationMessage(event.text);
        }
    }

    // 开启协作中继
    private async startCollab(payload: ContestMessage): Promise<void> {
        const room = (payload.room ?? '').trim() || 'oi-helper';
        const name = (payload.name ?? '').trim() || '队友';
        const port = Number(payload.port) || 0;
        const host = (payload.host ?? '').trim();
        if (host) {
            this.room = room;
            this.peerName = name;
            this.view?.webview.postMessage({
                type: 'collab',
                payload: { role: 'guest', url: `ws://${host}`, room, name }
            });
            this.postToast('info', `已连接到 ${host}`);
            return;
        }
        this.stopCollab();
        const server = new CollabServer();
        try {
            const actual = await server.start(port);
            this.collab = server;
            this.room = room;
            this.peerName = name;
            this.view?.webview.postMessage({
                type: 'collab',
                payload: {
                    role: 'host',
                    url: `ws://127.0.0.1:${actual}`,
                    lan: `ws://${lanAddress()}:${actual}`,
                    port: actual,
                    room,
                    name
                }
            });
            this.postToast('info', `已开房, 队友加入 ${lanAddress()}:${actual}`);
        } catch (err) {
            this.postToast('warn', `开房失败: ${String(err)}`);
        }
    }

    private stopCollab(): void {
        if (this.collab) {
            this.collab.stop();
            this.collab = undefined;
        }
    }

    // 监听编辑变化, 开启共享时推送当前文件
    private registerShareListeners(): void {
        this.disposables.push(vscode.window.onDidChangeActiveTextEditor(() => this.scheduleShare()));
        this.disposables.push(vscode.workspace.onDidChangeTextDocument((e) => {
            if (vscode.window.activeTextEditor && e.document === vscode.window.activeTextEditor.document) {
                this.scheduleShare();
            }
        }));
    }

    private sharing = false;

    private setShare(enabled: boolean): void {
        this.sharing = enabled;
        if (!enabled) {
            this.lastShare = '';
        }
    }

    // 节流 400ms
    private scheduleShare(): void {
        if (!this.sharing) {
            return;
        }
        if (this.shareTimer) {
            clearTimeout(this.shareTimer);
        }
        this.shareTimer = setTimeout(() => this.shareActiveFile(), 400);
    }

    private shareActiveFile(): void {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return;
        }
        const doc = editor.document;
        const content = doc.getText();
        if (content === this.lastShare) {
            return;
        }
        this.lastShare = content;
        this.view?.webview.postMessage({
            type: 'codeOut',
            payload: {
                file: path.basename(doc.fileName),
                lang: doc.languageId,
                content,
                line: editor.selection.active.line + 1
            }
        });
    }

    // 保存队友代码到工作区
    private async savePeerCode(file: string, content: string): Promise<void> {
        const name = path.basename(file || 'peer.cpp');
        const folders = vscode.workspace.workspaceFolders;
        const target = folders && folders.length
            ? vscode.Uri.joinPath(folders[0].uri, name)
            : vscode.Uri.file(path.join(os.tmpdir(), name));
        await vscode.workspace.fs.writeFile(target, Buffer.from(content, 'utf8'));
        const doc = await vscode.workspace.openTextDocument(target);
        await vscode.window.showTextDocument(doc);
        this.postToast('info', `已保存 ${name}`);
    }

    private postLuogu(snapshot: LuoguSnapshot): void {
        this.view?.webview.postMessage({ type: 'luogu', payload: snapshot });
    }

    private postState(): void {
        this.view?.webview.postMessage({ type: 'state', payload: null });
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
