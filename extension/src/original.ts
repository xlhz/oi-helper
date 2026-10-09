import * as vscode from 'vscode';

// 原题来源站点
export type OjName = 'luogu' | 'codeforces' | 'atcoder' | 'hydro';

export const OJ_LABEL: { [key in OjName]: string } = {
    luogu: '洛谷',
    codeforces: 'Codeforces',
    atcoder: 'AtCoder',
    hydro: 'Hydro'
};

export interface OriginalRef {
    oj: OjName;
    id: string;        // 站点内题号
    url: string;       // 题面地址
    submitUrl: string; // 提交页地址
}

export function ojLabel(oj: string): string {
    return OJ_LABEL[oj as OjName] ?? oj;
}

// 按链接判断所属 OJ; 无法识别时返回空串
// Hydro 自建站域名各异, 以题目页路径 /p/<id> 或 hydro 域名作为识别特征
export function ojOfUrl(url: string): OjName | '' {
    if (/luogu\.(com\.cn|org)/i.test(url)) {
        return 'luogu';
    }
    if (/codeforces\.com/i.test(url)) {
        return 'codeforces';
    }
    if (/atcoder\.jp/i.test(url)) {
        return 'atcoder';
    }
    if (/\/p\//i.test(url) || /hydro/i.test(url)) {
        return 'hydro';
    }
    return '';
}

// 原题优先级: 设置项 originalPriority, 默认 洛谷 -> CF -> AtCoder -> Hydro
export function originalPriority(): OjName[] {
    const raw = vscode.workspace.getConfiguration('oiHelper').get<string>('originalPriority') ?? '';
    const out: OjName[] = [];
    for (const part of raw.split(',')) {
        const key = part.trim().toLowerCase() as OjName;
        if (OJ_LABEL[key] && !out.includes(key)) {
            out.push(key);
        }
    }
    return out.length ? out : ['luogu', 'codeforces', 'atcoder', 'hydro'];
}

// 规范化粘贴来的 Cookie: 去掉 "Cookie:" 前缀与换行, 统一为 "k=v; k=v"
export function normalizeCookie(raw: string): string {
    return String(raw ?? '')
        .split(/[\r\n\t]+/)
        .map((part) => part.trim().replace(/^cookie:\s*/i, '').trim())
        .filter((part) => part)
        .join('; ');
}

// 该 OJ 的登录 Cookie(设置项)
export function ojCookie(oj: string): string {
    const cfg = vscode.workspace.getConfiguration('oiHelper');
    if (oj === 'luogu') {
        return normalizeCookie(cfg.get<string>('luoguCookie') ?? '');
    }
    if (oj === 'codeforces') {
        return normalizeCookie(cfg.get<string>('codeforcesCookie') ?? '');
    }
    if (oj === 'atcoder') {
        return normalizeCookie(cfg.get<string>('atcoderCookie') ?? '');
    }
    if (oj === 'hydro') {
        return normalizeCookie(cfg.get<string>('hydroCookie') ?? '');
    }
    return '';
}

function hydroBase(): string {
    const raw = (vscode.workspace.getConfiguration('oiHelper').get<string>('hydroBase') ?? '').trim();
    return raw.replace(/\/+$/, '');
}

function cfRef(id: string): OriginalRef | undefined {
    const m = /^CF(\d+)([A-Z]\d?)$/i.exec(id);
    if (!m) {
        return undefined;
    }
    const cid = m[1];
    const idx = m[2].toUpperCase();
    return {
        oj: 'codeforces',
        id: `${cid}${idx}`,
        url: `https://codeforces.com/problemset/problem/${cid}/${idx}`,
        submitUrl: `https://codeforces.com/problemset/submit/${cid}/${idx}`
    };
}

function luoguRef(id: string): OriginalRef {
    const pid = id.toUpperCase().startsWith('AT_') ? `AT_${id.slice(3).toLowerCase()}` : id.toUpperCase();
    return {
        oj: 'luogu',
        id: pid,
        url: `https://www.luogu.com.cn/problem/${encodeURIComponent(pid)}`,
        submitUrl: `https://www.luogu.com.cn/problem/${encodeURIComponent(pid)}`
    };
}

function atcoderRef(taskId: string): OriginalRef {
    const task = taskId.toLowerCase();
    const cut = task.lastIndexOf('_');
    const contest = cut > 0 ? task.slice(0, cut) : task;
    return {
        oj: 'atcoder',
        id: task,
        url: `https://atcoder.jp/contests/${contest}/tasks/${task}`,
        submitUrl: `https://atcoder.jp/contests/${contest}/submit`
    };
}

function hydroRef(id: string): OriginalRef | undefined {
    const base = hydroBase();
    if (!base || !id) {
        return undefined;
    }
    return {
        oj: 'hydro',
        id,
        url: `${base}/p/${encodeURIComponent(id)}`,
        submitUrl: `${base}/p/${encodeURIComponent(id)}/submit`
    };
}

// 单个来源片段 -> 原题候选(同一题目可能有多个站点镜像)
function refsOfToken(token: string): OriginalRef[] {
    const t = token.trim();
    if (!t) {
        return [];
    }
    // 直接给出链接
    if (/^https?:\/\//i.test(t)) {
        const url = t;
        if (/luogu\.(com\.cn|org)/i.test(url)) {
            const id = (/\/(?:problem|training)\/([^/?#]+)/i.exec(url) ?? [])[1] ?? url;
            return [luoguRef(id)];
        }
        if (/codeforces\.com/i.test(url)) {
            const m = /(\d+)[/ ]([A-Z]\d?)/i.exec(url);
            return m ? [cfRef(`CF${m[1]}${m[2]}`)].filter((r): r is OriginalRef => !!r) : [];
        }
        if (/atcoder\.jp/i.test(url)) {
            const id = (/\/tasks\/([^/?#]+)/i.exec(url) ?? [])[1];
            return id ? [atcoderRef(id)] : [];
        }
        const hid = /\/p\/([^/?#]+)/i.exec(url);
        return hid ? [{ oj: 'hydro', id: hid[1], url, submitUrl: `${url.replace(/\/+$/, '')}/submit` }] : [];
    }
    const out: OriginalRef[] = [];
    const cf = cfRef(t);
    if (cf) {
        out.push(luoguRef(`CF${cf.id}`));
        out.push(cf);
        return out;
    }
    const at = /^(?:AT_)?([a-z]{2,4}\d{2,4}_[a-z]\d?)$/i.exec(t);
    if (at) {
        out.push(luoguRef(`AT_${at[1].toLowerCase()}`));
        out.push(atcoderRef(at[1]));
        return out;
    }
    const hydro = /^hydro[:\-\s]*(.+)$/i.exec(t);
    if (hydro) {
        const ref = hydroRef(hydro[1].trim());
        return ref ? [ref] : [];
    }
    // 洛谷题号: P1001 / B2001 / SP1234 / UVA100 / CF1760G / AT_xxx / tarjan 等
    if (/^[A-Za-z][A-Za-z0-9_]{2,}$/.test(t)) {
        const lower = t.toLowerCase();
        const ug = /^(?:uva|sp|p|b|cf|at|spoj)/.test(lower);
        if (ug || /^\d/.test(t)) {
            out.push(luoguRef(t));
        }
    }
    return out;
}

// 从题目来源字段解析原题候选, 按设置优先级排序
export function parseOriginals(source: string): OriginalRef[] {
    const text = String(source ?? '').trim();
    if (!text) {
        return [];
    }
    const refs: OriginalRef[] = [];
    const seen = new Set<string>();
    for (const token of text.split(/[\s,，;；、|]+/)) {
        for (const ref of refsOfToken(token)) {
            if (seen.has(ref.url)) {
                continue;
            }
            seen.add(ref.url);
            refs.push(ref);
        }
    }
    const order = originalPriority();
    return refs.sort((a, b) => order.indexOf(a.oj) - order.indexOf(b.oj));
}
