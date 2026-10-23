import * as https from 'https';

// 洛谷比赛信息
export interface LuoguContestInfo {
    id: number;
    name: string;
    startTime: number;
    endTime: number;
    method: number;
    squad: boolean;
    problemCount: number;
    description: string;
    joined: boolean;
    canViewScoreboard: boolean;
}

// 洛谷比赛题目
export interface LuoguProblem {
    pid: string;
    label: string;
    name: string;
    accepted: number;
    submitted: number;
    totalSubmit: number;
    acRate: number;
    difficulty: string;
}

// 洛谷题目元信息: 名称与全局通过率
export interface LuoguProblemMeta {
    name: string;
    totalSubmit: number;
    totalAccepted: number;
}

// 洛谷单条提交
export interface LuoguRecord {
    id: number;
    pid: string;
    status: number;
    submitTime: number;
    uid: number;
    user: string;
}

// 同步出的实时事件
export interface LuoguEvent {
    id: string;
    at: number;
    kind: 'ac' | 'first-blood' | 'freeze' | 'unfreeze' | 'contest' | 'announcement';
    uid?: number;
    user?: string;
    label?: string;
    pid?: string;
    text: string;
}

// 一次同步快照
export interface LuoguSnapshot {
    info: LuoguContestInfo;
    problems: LuoguProblem[];
    events: LuoguEvent[];
    online: boolean;
    error: string;
    updatedAt: number;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
    + 'Chrome/120.0.0.0 Safari/537.36';

// 洛谷 AC 状态码
const STATUS_AC = 12;

// 规范化 Cookie: 去掉前缀与换行
export function normalizeCookie(raw: string): string {
    return String(raw ?? '')
        .split(/[\r\n\t]+/)
        .map((part) => part.trim().replace(/^cookie:\s*/i, '').trim())
        .filter((part) => part)
        .join('; ');
}

// 从比赛 URL 解析比赛号
export function parseContestId(url: string): number {
    const m = String(url ?? '').match(/\/contest\/(\d+)/);
    return m ? Number(m[1]) : 0;
}

// 从题目 URL 解析题号
export function parsePid(url: string): string {
    const m = String(url ?? '').match(/\/problem\/([A-Za-z]\d+)/);
    return m ? m[1] : '';
}

// 题号: 0 -> A, 25 -> Z, 之后用数字
function labelOf(index: number): string {
    return index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
}

// GET JSON; 带洛谷自定义头, 超时 15 秒
function getJson(url: string, cookie: string, referer: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const headers: { [key: string]: string } = {
            'User-Agent': UA,
            'Accept': 'application/json, text/plain, */*',
            'X-Requested-With': 'XMLHttpRequest',
            'x-lentille-request': 'content-only',
            'Referer': referer
        };
        if (cookie) {
            headers['Cookie'] = cookie;
        }
        const req = https.get(url, { headers, timeout: 15000 }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (d: Buffer) => chunks.push(d));
            res.on('end', () => {
                resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
            });
        });
        req.on('timeout', () => {
            req.destroy(new Error('请求超时'));
        });
        req.on('error', reject);
    });
}

// 解析 JSON, 失败返回 undefined
function tryJson(body: string): any {
    try {
        return JSON.parse(body);
    } catch {
        return undefined;
    }
}

// 拉取比赛详情
export async function fetchContest(id: number, cookie: string): Promise<LuoguContestInfo> {
    const referer = `https://www.luogu.com.cn/contest/${id}`;
    const res = await getJson(`https://www.luogu.com.cn/contest/${id}`, cookie, referer);
    const json = tryJson(res.body);
    const c = json && json.data && json.data.contest;
    if (!c) {
        throw new Error(`洛谷比赛 ${id} 读取失败 (HTTP ${res.status}), 请检查 Cookie`);
    }
    return {
        id: Number(c.id) || id,
        name: String(c.name ?? ''),
        startTime: Number(c.startTime) || 0,
        endTime: Number(c.endTime) || 0,
        method: Number(c.method) || 0,
        squad: c.squad === true,
        problemCount: Number(c.problemCount) || 0,
        description: String(c.description ?? ''),
        joined: json.data.joined === true,
        canViewScoreboard: json.data.canViewScoreboard === true
    };
}

// 从榜单响应中提取题目题号; 洛谷返回自定义二进制, 只能提取可见的 Pxxxx
export async function fetchProblemPids(id: number, cookie: string): Promise<string[]> {
    const referer = `https://www.luogu.com.cn/contest/${id}`;
    const first = await getJson(`https://www.luogu.com.cn/contest/${id}/scoreboard`, cookie, referer);
    const meta = tryJson(first.body);
    if (!meta || !meta.scoreboardUrl) {
        return [];
    }
    const url = 'https://www.luogu.com.cn' + String(meta.scoreboardUrl);
    const second = await getJson(url, cookie, referer);
    const raw = Array.from(new Set(second.body.match(/P\d{4,6}/g) ?? []));
    const nums = raw.map((p) => Number(p.slice(1))).sort((a, b) => a - b);
    // 比赛题号是连续分配的一段, 取最长连续段
    const best = longestRun(nums);
    return best.map((n) => 'P' + n);
}

// 最长连续(差值为 1)整数段
function longestRun(nums: number[]): number[] {
    let best: number[] = [];
    let run: number[] = [];
    for (const n of nums) {
        if (run.length && n === run[run.length - 1]) {
            continue;
        }
        if (run.length && n !== run[run.length - 1] + 1) {
            if (run.length > best.length) {
                best = run;
            }
            run = [];
        }
        run.push(n);
    }
    return run.length > best.length ? run : best;
}

// 解析比赛描述中的赛时公告栏: `时间` 内容
export function parseAnnouncements(description: string): LuoguEvent[] {
    const out: LuoguEvent[] = [];
    const re = /`(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})`\s*([^\n]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(description)) !== null) {
        const text = m[2].trim();
        const at = Math.floor(new Date(m[1].replace(' ', 'T') + '+08:00').getTime() / 1000);
        out.push({
            id: `ann-${m[1]}-${text.slice(0, 12)}`,
            at,
            kind: 'announcement',
            text
        });
    }
    return out;
}

// 拉取题目元信息(只取一次)
export async function fetchProblemMeta(pid: string, cookie: string): Promise<LuoguProblemMeta> {
    const url = `https://www.luogu.com.cn/problem/${pid}`;
    const res = await getJson(url, cookie, url);
    const json = tryJson(res.body);
    const p = json && json.data && json.data.problem;
    if (!p) {
        return { name: pid, totalSubmit: 0, totalAccepted: 0 };
    }
    return {
        name: String(p.name ?? pid),
        totalSubmit: Number(p.totalSubmit) || 0,
        totalAccepted: Number(p.totalAccepted) || 0
    };
}

// 拉取某题在比赛内的最近提交
export async function fetchRecords(id: number, pid: string, cookie: string): Promise<LuoguRecord[]> {
    const referer = `https://www.luogu.com.cn/contest/${id}`;
    const url = `https://www.luogu.com.cn/record/list?pid=${encodeURIComponent(pid)}`
        + `&contestId=${id}&page=1`;
    const res = await getJson(url, cookie, referer);
    const json = tryJson(res.body);
    const list = json && json.data && json.data.records && json.data.records.result;
    if (!Array.isArray(list)) {
        return [];
    }
    return list.map((r: any) => ({
        id: Number(r.id) || 0,
        pid,
        status: Number(r.status) || 0,
        submitTime: Number(r.submitTime) || 0,
        uid: Number(r.user && r.user.uid) || 0,
        user: String((r.user && r.user.name) ?? '')
    }));
}

// 统计通过率并给出难度建议
export function buildProblems(
    pids: string[],
    metas: { [pid: string]: LuoguProblemMeta },
    records: { [pid: string]: LuoguRecord[] }
): LuoguProblem[] {
    const list: LuoguProblem[] = pids.map((pid, i) => {
        const meta = metas[pid];
        const rows = records[pid] ?? [];
        const useMeta = Boolean(meta && meta.totalSubmit > 0);
        const submitted = useMeta ? meta.totalSubmit : rows.length;
        const accepted = useMeta ? meta.totalAccepted : rows.filter((r) => r.status === STATUS_AC).length;
        const rate = submitted ? accepted / submitted : 0;
        return {
            pid,
            label: labelOf(i),
            name: meta && meta.name ? meta.name : pid,
            accepted,
            submitted,
            totalSubmit: submitted,
            acRate: rate,
            difficulty: difficultyOf(rate)
        };
    });
    // 难度推荐: 通过率高的排前面
    const ranked = list.slice().sort((a, b) => b.acRate - a.acRate);
    ranked.forEach((p, i) => {
        p.difficulty = `${difficultyOf(p.acRate)} #${i + 1}`;
    });
    return list;
}

// 通过率 -> 难度标签
function difficultyOf(rate: number): string {
    if (rate >= 0.6) {
        return '简单';
    }
    if (rate >= 0.3) {
        return '中等';
    }
    if (rate > 0) {
        return '较难';
    }
    return '未知';
}

// 比赛同步器: 定时拉取比赛状态与各题提交, 产生过题事件
export class LuoguWatcher {
    private timer: NodeJS.Timeout | undefined;

    private info: LuoguContestInfo | undefined;

    private pids: string[] = [];

    private metas: { [pid: string]: LuoguProblemMeta } = {};

    private problems: LuoguProblem[] = [];

    private events: LuoguEvent[] = [];

    private seen: Set<string> = new Set();

    private firstAc: Set<string> = new Set();

    private error = '';

    private online = false;

    private busy = false;

    private initialized = false;

    private freezeState: 'freeze' | 'unfreeze' | '' = '';

    constructor(
        readonly contestId: number,
        private readonly cookie: string,
        private readonly intervalMs: number,
        private readonly onSnapshot: (snapshot: LuoguSnapshot) => void,
        private readonly onEvent: (event: LuoguEvent) => void,
        private readonly freezeMinutes: number = 0
    ) { }

    // 开始轮询, 立即同步一次
    start(): void {
        this.stop();
        void this.poll();
        this.timer = setInterval(() => void this.poll(), Math.max(5000, this.intervalMs));
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    // 取当前快照
    snapshot(): LuoguSnapshot | undefined {
        if (!this.info) {
            return undefined;
        }
        return {
            info: this.info,
            problems: this.problems,
            events: this.events.slice(-80),
            online: this.online,
            error: this.error,
            updatedAt: Date.now()
        };
    }

    // 一轮同步
    private async poll(): Promise<void> {
        if (this.busy) {
            return;
        }
        this.busy = true;
        try {
            const info = await fetchContest(this.contestId, this.cookie);
            this.info = info;
            if (!this.pids.length) {
                this.pids = await fetchProblemPids(this.contestId, this.cookie);
            }
            if (this.pids.length > info.problemCount && info.problemCount > 0) {
                // 榜单里可能混入无关题号, 取最接近的连续段
                this.pids = this.pids.slice(0, info.problemCount);
            }
            const records: { [pid: string]: LuoguRecord[] } = {};
            await Promise.all(this.pids.map(async (pid) => {
                if (!this.metas[pid]) {
                    try {
                        this.metas[pid] = await fetchProblemMeta(pid, this.cookie);
                    } catch {
                        this.metas[pid] = { name: pid, totalSubmit: 0, totalAccepted: 0 };
                    }
                }
                try {
                    records[pid] = await fetchRecords(this.contestId, pid, this.cookie);
                } catch {
                    records[pid] = [];
                }
            }));
            this.problems = buildProblems(this.pids, this.metas, records);
            this.collectAnnouncements(info.description);
            this.collect(records);
            this.checkFreeze(info);
            this.online = true;
            this.error = this.pids.length ? '' : '未获取到题号, 请确认已加入比赛且有权限查看榜单';
            this.initialized = true;
        } catch (err) {
            this.online = false;
            this.error = String(err instanceof Error ? err.message : err);
        } finally {
            this.busy = false;
            const snap = this.snapshot();
            if (snap) {
                this.onSnapshot(snap);
            }
        }
    }

    // 封榜/解榜: 复用同一轮 poll 的比赛时间, 状态变化才产生事件
    private checkFreeze(info: LuoguContestInfo): void {
        if (!this.initialized || this.freezeMinutes <= 0 || !info.startTime || !info.endTime) {
            return;
        }
        const now = Date.now() / 1000;
        const freezeStart = info.endTime - this.freezeMinutes * 60;
        let state: 'freeze' | 'unfreeze' | '' = '';
        if (now >= freezeStart && now < info.endTime) {
            state = 'freeze';
        } else if (now >= info.endTime) {
            state = 'unfreeze';
        }
        if (!state || state === this.freezeState) {
            return;
        }
        this.freezeState = state;
        const event: LuoguEvent = {
            id: `${this.contestId}-${state}`,
            at: Math.floor(now),
            kind: state,
            text: `${info.name || `比赛 ${this.contestId}`} ${state === 'freeze' ? '已封榜' : '已解榜'}`
        };
        this.events.push(event);
        this.onEvent(event);
    }

    // 比赛描述中的公告: 首轮只入库, 之后新增才提醒
    private collectAnnouncements(description: string): void {
        for (const event of parseAnnouncements(description)) {
            if (this.seen.has(event.id)) {
                continue;
            }
            this.seen.add(event.id);
            this.events.push(event);
            if (this.initialized) {
                this.onEvent(event);
            }
        }
    }

    // 对比提交记录, 生成提交与首杀事件
    private collect(records: { [pid: string]: LuoguRecord[] }): void {
        for (const pid of Object.keys(records)) {
            const problem = this.problems.find((p) => p.pid === pid);
            const label = problem ? problem.label : pid;
            for (const r of records[pid]) {
                const key = `${pid}:${r.id}`;
                if (this.seen.has(key)) {
                    continue;
                }
                this.seen.add(key);
                const isAc = r.status === STATUS_AC;
                const hadAc = this.firstAc.has(pid);
                if (isAc && !hadAc) {
                    this.firstAc.add(pid);
                }
                // 首轮的记录视为历史, 不宣称首杀
                const isFirst = this.initialized && isAc && !hadAc;
                const event: LuoguEvent = {
                    id: key,
                    at: r.submitTime,
                    kind: isFirst ? 'first-blood' : 'ac',
                    uid: r.uid,
                    user: r.user,
                    label,
                    pid,
                    text: isFirst
                        ? `${r.user} 首杀 ${label} 题`
                        : (isAc ? `${r.user} 通过 ${label} 题` : `${r.user} 提交 ${label} 题`)
                };
                this.events.push(event);
                if (this.initialized) {
                    this.onEvent(event);
                }
            }
        }
    }
}
