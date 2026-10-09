import { ContestSummary } from './fetch';

const XMOJ_ORIGIN = 'https://www.xmoj.tech';

// 把 xmoj 返回的 HTML 片段解析为 Markdown
// 说明: 仅做常见标签的转换, 数学公式的 $...$ 原样保留给 KaTeX 渲染

function decodeEntities(text: string): string {
    return text
        .replace(/&nbsp;/gi, ' ')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#0*39;|&apos;/gi, "'")
        .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
        .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&amp;/gi, '&');
}

// 当前转换用的基准地址(题目页地址); 为空时按 xmoj 站点补全(面板题面用)
let mdBase = '';

// 设置后续 htmlToMarkdown 的相对地址基准; 传空串回到 xmoj 默认
export function setMarkdownBase(base: string): void {
    mdBase = (base || '').trim();
}

function absolute(href: string): string {
    const value = (href || '').trim();
    if (!value || value.startsWith('#') || value.startsWith('mailto:')) {
        return value;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
        return value;
    }
    if (value.startsWith('//')) {
        return `https:${value}`;
    }
    const root = mdBase || XMOJ_ORIGIN;
    try {
        return new URL(value, root).toString();
    } catch {
        return `${root.replace(/\/+$/, '')}/${value.replace(/^\.?\//, '')}`;
    }
}

// 行内元素 -> Markdown 行内语法, 其余标签直接剔除
function inlineMd(html: string): string {
    let s = html || '';
    s = s.replace(/<a\b[^>]*href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, text: string) => {
        const label = inlineMd(text).replace(/\s+/g, ' ').trim();
        return label ? `[${label}](${absolute(href)})` : '';
    });
    // 图片: 兼容懒加载(data-src/data-original)与 alt
    s = s.replace(/<img\b[^>]*>/gi, (tag: string) => {
        const hit = /data-src\s*=\s*["']([^"']*)["']/i.exec(tag) ||
            /data-original\s*=\s*["']([^"']*)["']/i.exec(tag) ||
            /src\s*=\s*["']([^"']*)["']/i.exec(tag);
        const src = hit ? absolute(hit[1]) : '';
        if (!src) {
            return '';
        }
        const altHit = /alt\s*=\s*["']([^"']*)["']/i.exec(tag);
        const alt = altHit ? decodeEntities(altHit[1]).trim() : '';
        return `![${alt || '图片'}](${src})`;
    });
    s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _tag: string, text: string) => `**${inlineMd(text)}**`);
    s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _tag: string, text: string) => `*${inlineMd(text)}*`);
    s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, text: string) => '`' + decodeEntities(text.replace(/<[^>]+>/g, '')) + '`');
    s = s.replace(/<br\s*\/?>/gi, '\n');
    s = s.replace(/<[^>]+>/g, '');
    return decodeEntities(s);
}

// 块内文本: 合并空白, 去掉多余换行
function blockText(html: string): string {
    return inlineMd(html).replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n{2,}/g, '\n').trim();
}

function listToMarkdown(inner: string, ordered: boolean): string {
    const items = inner.split(/<li\b[^>]*>/i).slice(1);
    return items.map((raw, i) => {
        const text = blockText(raw.replace(/<\/li>[\s\S]*$/i, '')).replace(/\n+/g, ' ');
        return `${ordered ? `${i + 1}.` : '-'} ${text}`.trimEnd();
    }).join('\n');
}

function tableToMarkdown(table: string): string {
    const rows = (table.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || []).map((row) => {
        const cells = row.match(/<(th|td)\b[^>]*>[\s\S]*?<\/\1>/gi) || [];
        return cells.map((cell) => {
            const inner = cell.replace(/^<(th|td)\b[^>]*>/i, '').replace(/<\/(th|td)>$/i, '');
            return blockText(inner).replace(/\n+/g, ' ').replace(/\|/g, '\\|').trim();
        });
    });
    if (rows.length === 0) {
        return '';
    }
    const width = Math.max(...rows.map((r) => r.length));
    const pad = (cells: string[]): string => {
        const copy = cells.slice();
        while (copy.length < width) {
            copy.push('');
        }
        return `| ${copy.join(' | ')} |`;
    };
    const lines = [pad(rows[0]), `| ${new Array(width).fill('---').join(' | ')} |`];
    for (const row of rows.slice(1)) {
        lines.push(pad(row));
    }
    return lines.join('\n');
}

// 把 Markdown 里的相对图片/链接补成绝对地址(预览面板按题目页地址解析); base 为题目页地址
export function absolutizeMarkdown(md: string, base: string): string {
    const root = (base || '').trim();
    if (!md || !root) {
        return md;
    }
    return md.replace(/(!?\[[^\]]*\]\()([^)\s]+)(\))/g, (whole: string, head: string, url: string, tail: string) => {
        if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(url)) {
            return whole;
        }
        try {
            return `${head}${new URL(url, root).toString()}${tail}`;
        } catch {
            return whole;
        }
    });
}

export function htmlToMarkdown(html: string): string {
    if (!html) {
        return '';
    }
    // 复杂块先抽出为占位符, 避免被后续行内处理破坏
    const stash: string[] = [];
    const keep = (md: string): string => `\u0000${stash.push(md) - 1}\u0000`;
    let s = html.replace(/\r\n?/g, '\n');

    s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, code: string) =>
        keep(`\n\`\`\`\n${decodeEntities(code.replace(/<[^>]+>/g, '')).replace(/\s+$/, '')}\n\`\`\`\n`));
    s = s.replace(/<table\b[\s\S]*?<\/table>/gi, (t: string) => keep(`\n${tableToMarkdown(t)}\n`));
    s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level: string, text: string) =>
        keep(`\n${'#'.repeat(Number(level))} ${blockText(text).replace(/\n+/g, ' ')}\n`));
    s = s.replace(/<ul\b[^>]*>([\s\S]*?)<\/ul>/gi, (_, inner: string) => keep(`\n${listToMarkdown(inner, false)}\n`));
    s = s.replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi, (_, inner: string) => keep(`\n${listToMarkdown(inner, true)}\n`));
    s = s.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, inner: string) =>
        keep(`\n${blockText(inner).split('\n').map((l) => `> ${l}`).join('\n')}\n`));
    s = s.replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (_, inner: string) => keep(`\n${blockText(inner)}\n`));
    s = s.replace(/<hr\s*\/?>/gi, '\n---\n');

    s = inlineMd(s);
    s = s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => stash[Number(i)] ?? '');
    return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function codeBlock(text: string): string {
    return '```text\n' + (text || '').replace(/\r\n?/g, '\n').replace(/\n+$/, '') + '\n```';
}

// 把竞赛题目抓取结果拼成完整题目 Markdown
export function buildProblemMarkdown(problem: ContestSummary): string {
    // xmoj 题面的相对图片/链接按 xmoj 站点补全
    setMarkdownBase('');
    const parts: string[] = [];
    const heading = [problem.num, problem.title].filter(Boolean).join('. ');
    parts.push(`# ${heading || '题目'}`);

    const meta: string[] = [];
    if (problem.contestTitle) {
        meta.push(`竞赛: ${problem.contestTitle}${problem.contestId ? ` (${problem.contestId})` : ''}`);
    }
    const limits: string[] = [];
    if (problem.timeLimit) {
        limits.push(`时间限制: ${problem.timeLimit} ms`);
    }
    if (problem.memoryLimit) {
        limits.push(`内存限制: ${problem.memoryLimit} MB`);
    }
    if (problem.source) {
        limits.push(`来源: ${problem.source}`);
    }
    if (limits.length) {
        meta.push(limits.join(' · '));
    }
    if (problem.freopenIn && problem.freopenOut) {
        meta.push(`输入文件: ${problem.freopenIn} · 输出文件: ${problem.freopenOut}`);
    }
    if (problem.startTime || problem.endTime) {
        meta.push(`比赛时间: ${problem.startTime || '?'} ~ ${problem.endTime || '?'}`);
    }
    if (meta.length) {
        parts.push(meta.map((m) => `- ${m}`).join('\n'));
    }

    const section = (title: string, html?: string): void => {
        const md = htmlToMarkdown(html || '');
        if (md) {
            parts.push(`## ${title}\n\n${md}`);
        }
    };
    section('题目描述', problem.description);
    section('输入格式', problem.input);
    section('输出格式', problem.output);

    (problem.samples || []).forEach((sample, i) => {
        const idx = i + 1;
        const block = [`## 样例 ${idx}`, `**输入**\n\n${codeBlock(sample.in)}`, `**输出**\n\n${codeBlock(sample.out)}`];
        parts.push(block.join('\n\n'));
        const explain = htmlToMarkdown(sample.explain || '');
        if (explain) {
            parts.push(`### 样例解释 ${idx}\n\n${explain}`);
        }
    });

    section('数据范围与提示', problem.dataRange);
    section('提示', problem.hint);
    section('附件', problem.download);

    return parts.join('\n\n') + '\n';
}
