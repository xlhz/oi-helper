(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory(require('./html.js'));
        return;
    }
    root.OIHParse = factory(root.OIHHtml);
})(typeof self !== 'undefined' ? self : this, function (OIHHtml) {
    function decodeEntities(text) {
        return OIHHtml.decodeEntities(text);
    }

    function absoluteUrl(href, base) {
        const value = String(href || '').trim();
        if (!value || value.startsWith('#') || value.startsWith('mailto:')) {
            return value;
        }
        if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
            return value;
        }
        if (value.startsWith('//')) {
            return `https:${value}`;
        }
        try {
            return new URL(value, base || 'https://www.xmoj.tech').toString();
        } catch (error) {
            return value;
        }
    }

    function inlineMd(html, base) {
        let s = String(html || '');
        s = s.replace(/<a\b[^>]*href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (whole, href, text) => {
            const label = inlineMd(text, base).replace(/\s+/g, ' ').trim();
            return label ? `[${label}](${absoluteUrl(href, base)})` : '';
        });
        s = s.replace(/<img\b[^>]*>/gi, (tag) => {
            const hit = /data-src\s*=\s*["']([^"']*)["']/i.exec(tag) ||
                /data-original\s*=\s*["']([^"']*)["']/i.exec(tag) ||
                /src\s*=\s*["']([^"']*)["']/i.exec(tag);
            const src = hit ? absoluteUrl(hit[1], base) : '';
            if (!src) {
                return '';
            }
            const altHit = /alt\s*=\s*["']([^"']*)["']/i.exec(tag);
            const alt = altHit ? decodeEntities(altHit[1]).trim() : '';
            return `![${alt || '图片'}](${src})`;
        });
        s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (whole, tag, text) => `**${inlineMd(text, base)}**`);
        s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (whole, tag, text) => `*${inlineMd(text, base)}*`);
        s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (whole, text) => {
            return `\`${decodeEntities(text.replace(/<[^>]+>/g, ''))}\``;
        });
        s = s.replace(/<br\s*\/?>/gi, '\n');
        s = s.replace(/<[^>]+>/g, '');
        return decodeEntities(s);
    }

    function blockText(html, base) {
        return inlineMd(html, base).replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n{2,}/g, '\n').trim();
    }

    function listToMarkdown(inner, ordered, base) {
        const items = inner.split(/<li\b[^>]*>/i).slice(1);
        return items.map((raw, index) => {
            const text = blockText(raw.replace(/<\/li>[\s\S]*$/i, ''), base).replace(/\n+/g, ' ');
            return `${ordered ? `${index + 1}.` : '-'} ${text}`.trimEnd();
        }).join('\n');
    }

    function tableToMarkdown(table, base) {
        const rows = (table.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || []).map((row) => {
            const cells = row.match(/<(th|td)\b[^>]*>[\s\S]*?<\/\1>/gi) || [];
            return cells.map((cell) => {
                const inner = cell.replace(/^<(th|td)\b[^>]*>/i, '').replace(/<\/(th|td)>$/i, '');
                return blockText(inner, base).replace(/\n+/g, ' ').replace(/\|/g, '\\|').trim();
            });
        });
        if (!rows.length) {
            return '';
        }
        const width = Math.max(...rows.map((row) => row.length));
        const pad = (cells) => {
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

    // 与 extension/src/problem.ts 的 htmlToMarkdown 输出保持一致
    function htmlToMarkdown(html, base) {
        if (!html) {
            return '';
        }
        const stash = [];
        const keep = (md) => `\u0000${stash.push(md) - 1}\u0000`;
        let s = String(html).replace(/\r\n?/g, '\n');

        s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (whole, code) => {
            return keep(`\n\`\`\`\n${decodeEntities(code.replace(/<[^>]+>/g, '')).replace(/\s+$/, '')}\n\`\`\`\n`);
        });
        s = s.replace(/<table\b[\s\S]*?<\/table>/gi, (table) => keep(`\n${tableToMarkdown(table, base)}\n`));
        s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (whole, level, text) => {
            return keep(`\n${'#'.repeat(Number(level))} ${blockText(text, base).replace(/\n+/g, ' ')}\n`);
        });
        s = s.replace(/<ul\b[^>]*>([\s\S]*?)<\/ul>/gi, (whole, inner) => keep(`\n${listToMarkdown(inner, false, base)}\n`));
        s = s.replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi, (whole, inner) => keep(`\n${listToMarkdown(inner, true, base)}\n`));
        s = s.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (whole, inner) => {
            const lines = blockText(inner, base).split('\n').map((line) => `> ${line}`).join('\n');
            return keep(`\n${lines}\n`);
        });
        s = s.replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (whole, inner) => keep(`\n${blockText(inner, base)}\n`));
        s = s.replace(/<hr\s*\/?>/gi, '\n---\n');

        s = inlineMd(s, base);
        const expand = (text) => text.replace(/\u0000(\d+)\u0000/g, (whole, index) => stash[Number(index)] || '');
        for (let i = 0; i < 10 && s.indexOf('\u0000') >= 0; i += 1) {
            s = expand(s);
        }
        return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    }

    function absolutizeMarkdown(md, base) {
        if (!md || !base) {
            return md;
        }
        return String(md).replace(/(!?\[[^\]]*\]\()([^)\s]+)(\))/g, (whole, head, url, tail) => {
            if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(url)) {
                return whole;
            }
            try {
                return `${head}${new URL(url, base).toString()}${tail}`;
            } catch (error) {
                return whole;
            }
        });
    }

    function applyTemplate(template, match) {
        return String(template || '').replace(/\$(\d+)/g, (whole, index) => match[Number(index)] || '');
    }

    function pickNode(doc, selectors) {
        for (const selector of selectors || []) {
            if (!selector) {
                continue;
            }
            const node = OIHHtml.querySelector(doc, selector);
            if (node) {
                return node;
            }
        }
        return null;
    }

    function chain(manualSelector, selectors) {
        return (manualSelector ? [manualSelector] : []).concat(selectors || []);
    }

    function textOf(node) {
        return node ? OIHHtml.textContent(node).replace(/\s+/g, ' ').trim() : '';
    }

    function cleanTitle(text, rule) {
        const value = String(text || '').trim();
        if (!value) {
            return '';
        }
        return value
            .replace(/\s*[-|]\s*(洛谷|Codeforces|AtCoder|XMOJ)\s*$/i, '')
            .replace(/\s*[-–]?\s*Editorial\s*$/i, '')
            .replace(/\s+/g, ' ')
            .trim() || rule.name;
    }

    function parseTimeLimit(text) {
        const value = String(text || '');
        let m = /(\d+(?:\.\d+)?)\s*(ms|milliseconds?|毫秒)/i.exec(value);
        if (m) {
            return Math.round(Number(m[1]));
        }
        m = /(\d+(?:\.\d+)?)\s*(sec(?:ond)?s?|s\b|秒)/i.exec(value);
        if (m) {
            return Math.round(Number(m[1]) * 1000);
        }
        m = /(\d+(?:\.\d+)?)\s*(minutes?|min|分钟)/i.exec(value);
        if (m) {
            return Math.round(Number(m[1]) * 60 * 1000);
        }
        return null;
    }

    function parseMemoryLimit(text) {
        const value = String(text || '');
        let m = /(\d+(?:\.\d+)?)\s*(mb|mib|megabytes?|兆字节|兆)/i.exec(value);
        if (m) {
            return Math.round(Number(m[1]));
        }
        m = /(\d+(?:\.\d+)?)\s*(kb|kib|kilobytes?|千字节)/i.exec(value);
        if (m) {
            return Math.round(Number(m[1]) / 1024);
        }
        m = /(\d+(?:\.\d+)?)\s*(gb|gib|gigabytes?|吉字节)/i.exec(value);
        if (m) {
            return Math.round(Number(m[1]) * 1024);
        }
        return null;
    }

    function pairSamples(inputs, outputs) {
        const out = [];
        const count = Math.max(inputs.length, outputs.length);
        for (let i = 0; i < count; i += 1) {
            const input = inputs[i] || '';
            const output = outputs[i] || '';
            if (!input && !output) {
                continue;
            }
            out.push({ in: input, out: output });
        }
        return out;
    }

    function collectBySelector(doc, selectors) {
        for (const selector of selectors || []) {
            if (!selector) {
                continue;
            }
            const nodes = OIHHtml.querySelectorAll(doc, selector);
            if (nodes.length) {
                return nodes.map((node) => OIHHtml.textContent(node).replace(/\r\n?/g, '\n').trim());
            }
        }
        return [];
    }

    // 显式输入/输出选择器优先; 缺失时按 <pre> 顺序成对切分, 与 core 的 pairSamples 一致
    function extractSamples(scope, rule, manual) {
        const selectors = rule.selectors || {};
        const inputs = collectBySelector(scope, chain(manual.sampleInput, selectors.sampleInput));
        const outputs = collectBySelector(scope, chain(manual.sampleOutput, selectors.sampleOutput));
        if (inputs.length && outputs.length) {
            return pairSamples(inputs, outputs);
        }
        const pres = OIHHtml.querySelectorAll(scope, 'pre').map((node) => {
            return OIHHtml.textContent(node).replace(/\r\n?/g, '\n').trim();
        });
        return pairSamples(pres.filter((item, index) => index % 2 === 0), pres.filter((item, index) => index % 2 === 1));
    }

    function pidFromRule(rule, url) {
        if (!rule.pidPattern) {
            return '';
        }
        try {
            const match = new RegExp(rule.pidPattern, 'i').exec(url);
            if (match) {
                return applyTemplate(rule.pidTemplate || '$1', match);
            }
        } catch (error) {
            return '';
        }
        return '';
    }

    function submitUrlFromRule(rule, url, pid) {
        const config = rule.submitUrl || {};
        let out = String(config.template || '{url}')
            .replace(/\{url\}/g, url)
            .replace(/\{pid\}/g, pid || '');
        if (config.pattern) {
            try {
                const match = new RegExp(config.pattern, 'i').exec(url);
                if (match) {
                    out = applyTemplate(out, match);
                }
            } catch (error) {
                // 规则里的地址模板异常时退回原链接
            }
        }
        return out;
    }

    function sectionMarkdown(heading, body) {
        const text = String(body || '').trim();
        return text ? `## ${heading}\n\n${text}\n\n` : '';
    }

    function parseLuoguJson(data, url, rule) {
        const problem = data && data.data && data.data.problem;
        if (!problem || !problem.pid) {
            return {
                ok: false,
                oj: rule.id,
                url,
                error: '洛谷返回异常: 题目不存在或需登录. 请先在浏览器登录该站点后重试.'
            };
        }
        const translated = problem.contenu || {};
        const pick = (key) => {
            const value = translated[key];
            if (typeof value === 'string' && value.trim()) {
                return value;
            }
            const origin = problem[key];
            return typeof origin === 'string' ? origin : '';
        };
        let md = '';
        md += sectionMarkdown('题目背景', pick('background'));
        md += sectionMarkdown('题目描述', pick('description'));
        md += sectionMarkdown('输入格式', pick('formatI'));
        md += sectionMarkdown('输出格式', pick('formatO'));
        md += sectionMarkdown('提示', pick('hint'));
        md = md.trim();
        const title = String(problem.name || problem.pid || rule.name).trim();
        const samples = (problem.samples || []).map((pair) => ({
            in: String((pair && pair[0]) || ''),
            out: String((pair && pair[1]) || '')
        }));
        const limits = problem.limits || {};
        const time = Array.isArray(limits.time) ? Number(limits.time[0]) : Number(limits.time);
        const memory = Array.isArray(limits.memory) ? Number(limits.memory[0]) : Number(limits.memory);
        const markdown = absolutizeMarkdown(title ? `# ${title}\n\n${md}` : md, url);
        return {
            ok: true,
            oj: rule.id,
            pid: String(problem.pid),
            name: title,
            title,
            url,
            html: '',
            md,
            markdown,
            submitUrl: submitUrlFromRule(rule, url, String(problem.pid)),
            samples,
            timeLimit: Number.isFinite(time) ? time : null,
            memoryLimit: Number.isFinite(memory) ? memory : null,
            ruleId: rule.id,
            ruleVersion: rule.version,
            source: 'browser',
            warnings: samples.length ? [] : ['未解析到样例测试点']
        };
    }

    function parseHtmlPage(input) {
        const rule = input.rule;
        const url = input.url;
        const manual = input.manual || {};
        const selectors = rule.selectors || {};
        const doc = OIHHtml.parse(input.html || '');
        const statementNode = pickNode(doc, chain(manual.statement, selectors.statement));
        const scope = statementNode || doc;
        const statementHtml = statementNode ? OIHHtml.outerHTML(statementNode) : String(input.html || '');

        let title = textOf(pickNode(doc, chain(manual.title, selectors.title)));
        if (!title) {
            title = cleanTitle(textOf(pickNode(doc, ['title'])), rule);
        }
        title = cleanTitle(title, rule) || rule.name;

        let pid = pidFromRule(rule, url);
        if (!pid) {
            pid = textOf(pickNode(doc, chain(manual.pid, selectors.pid)));
            if (!/^[A-Za-z0-9_-]+$/.test(pid)) {
                pid = '';
            }
        }

        const pageText = OIHHtml.textContent(doc);
        let timeLimit = parseTimeLimit(textOf(pickNode(doc, chain(manual.timeLimit, selectors.timeLimit))));
        if (timeLimit === null) {
            timeLimit = parseTimeLimit(pageText);
        }
        let memoryLimit = parseMemoryLimit(textOf(pickNode(doc, chain(manual.memoryLimit, selectors.memoryLimit))));
        if (memoryLimit === null) {
            memoryLimit = parseMemoryLimit(pageText);
        }

        const samples = extractSamples(scope, rule, manual);
        const body = htmlToMarkdown(statementHtml, url);
        const markdown = absolutizeMarkdown(title ? `# ${title}\n\n${body}` : body, url);
        return {
            ok: true,
            oj: rule.id,
            pid,
            name: title,
            title,
            url,
            html: statementHtml,
            md: body,
            markdown,
            submitUrl: submitUrlFromRule(rule, url, pid),
            samples,
            timeLimit,
            memoryLimit,
            ruleId: rule.id,
            ruleVersion: rule.version,
            source: 'browser',
            warnings: samples.length ? [] : ['未解析到样例测试点']
        };
    }

    // 后台抓取与内容脚本整页采集共用此入口
    function parsePage(input) {
        const rule = input && input.rule;
        if (!rule || !rule.id) {
            return { ok: false, url: input && input.url, error: '未命中站点规则, 无法解析.' };
        }
        const html = String((input && input.html) || '');
        try {
            if (rule.fetch && rule.fetch.mode === 'luogu-json' && html.trim().startsWith('{')) {
                return parseLuoguJson(JSON.parse(html), input.url, rule);
            }
            return parseHtmlPage(Object.assign({}, input, { html }));
        } catch (error) {
            return {
                ok: false,
                oj: rule.id,
                url: input && input.url,
                error: `解析失败: ${error && error.message ? error.message : '未知错误'}`
            };
        }
    }

    return {
        decodeEntities,
        htmlToMarkdown,
        absolutizeMarkdown,
        parseTimeLimit,
        parseMemoryLimit,
        parsePage
    };
});
