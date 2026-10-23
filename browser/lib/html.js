(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
        return;
    }
    root.OIHHtml = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    const VOID_TAGS = new Set([
        'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
        'link', 'meta', 'param', 'source', 'track', 'wbr'
    ]);
    const BLOCK_TAGS = new Set([
        'address', 'article', 'aside', 'blockquote', 'div', 'dl', 'fieldset',
        'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'header', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul'
    ]);

    function decodeEntities(text) {
        return String(text || '')
            .replace(/&nbsp;/gi, ' ')
            .replace(/&lt;/gi, '<')
            .replace(/&gt;/gi, '>')
            .replace(/&quot;/gi, '"')
            .replace(/&#0*39;|&apos;/gi, "'")
            .replace(/&#(\d+);/g, (whole, d) => String.fromCodePoint(Number(d)))
            .replace(/&#x([0-9a-f]+);/gi, (whole, h) => String.fromCodePoint(parseInt(h, 16)))
            .replace(/&amp;/gi, '&');
    }

    function escapeHtml(text) {
        return String(text || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function findTagEnd(html, start) {
        let quote = '';
        for (let i = start + 1; i < html.length; i += 1) {
            const ch = html[i];
            if (quote) {
                if (ch === quote) {
                    quote = '';
                }
                continue;
            }
            if (ch === '"' || ch === "'") {
                quote = ch;
                continue;
            }
            if (ch === '>') {
                return i;
            }
        }
        return -1;
    }

    function parseAttrs(text) {
        const attrs = {};
        const re = /([^\s=/>]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
        let m;
        while ((m = re.exec(text))) {
            const name = m[1].toLowerCase();
            const value = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5] !== undefined ? m[5] : '';
            attrs[name] = decodeEntities(value);
        }
        return attrs;
    }

    // 容错 HTML 解析: 只构建规则选择与题面序列化需要的最小树
    function parse(html) {
        const rootNode = { tag: '#root', attrs: {}, children: [], parent: null, index: 0 };
        const stack = [rootNode];
        const source = String(html || '');
        let i = 0;
        let index = 0;
        const appendText = (raw) => {
            if (!raw) {
                return;
            }
            stack[stack.length - 1].children.push({ tag: '#text', raw, parent: stack[stack.length - 1] });
        };
        const popTag = (tag) => {
            for (let p = stack.length - 1; p > 0; p -= 1) {
                if (stack[p].tag === tag) {
                    stack.length = p;
                    return;
                }
            }
        };

        while (i < source.length) {
            const lt = source.indexOf('<', i);
            if (lt < 0) {
                appendText(source.slice(i));
                break;
            }
            if (lt > i) {
                appendText(source.slice(i, lt));
            }
            if (source.startsWith('<!--', lt)) {
                const end = source.indexOf('-->', lt + 4);
                i = end < 0 ? source.length : end + 3;
                continue;
            }
            if (source[lt + 1] === '!' || source[lt + 1] === '?') {
                const end = findTagEnd(source, lt);
                i = end < 0 ? source.length : end + 1;
                continue;
            }
            const endTag = /^<\s*\/\s*([a-zA-Z][\w:-]*)\s*>/.exec(source.slice(lt, lt + 80));
            if (endTag) {
                popTag(endTag[1].toLowerCase());
                i = lt + endTag[0].length;
                continue;
            }
            const end = findTagEnd(source, lt);
            if (end < 0) {
                appendText(source.slice(lt));
                break;
            }
            const tagText = source.slice(lt, end + 1);
            const startMatch = /^<\s*([a-zA-Z][\w:-]*)([\s\S]*)$/.exec(tagText);
            if (!startMatch) {
                appendText('<');
                i = lt + 1;
                continue;
            }
            const tag = startMatch[1].toLowerCase();
            let body = startMatch[2];
            const selfClosing = /\/\s*$/.test(body);
            body = body.replace(/\/\s*$/, '');
            i = end + 1;
            if (tag === 'script' || tag === 'style') {
                const close = source.toLowerCase().indexOf(`</${tag}`, i);
                if (close < 0) {
                    i = source.length;
                } else {
                    const gt = source.indexOf('>', close);
                    i = gt < 0 ? source.length : gt + 1;
                }
                continue;
            }
            while (stack.length > 1) {
                const top = stack[stack.length - 1].tag;
                const blockInP = top === 'p' && (BLOCK_TAGS.has(tag) || tag === 'p');
                const sameListItem = (tag === 'li' && top === 'li') ||
                    ((tag === 'dt' || tag === 'dd') && (top === 'dt' || top === 'dd'));
                if (blockInP || sameListItem) {
                    stack.pop();
                    continue;
                }
                break;
            }
            const node = {
                tag,
                attrs: parseAttrs(body),
                children: [],
                parent: stack[stack.length - 1],
                index: index += 1
            };
            node.parent.children.push(node);
            if (VOID_TAGS.has(tag) || selfClosing) {
                continue;
            }
            stack.push(node);
        }
        return rootNode;
    }

    function textContent(node) {
        if (!node) {
            return '';
        }
        if (node.tag === '#text') {
            return decodeEntities(node.raw);
        }
        let out = '';
        for (const child of node.children || []) {
            out += textContent(child);
        }
        return out;
    }

    function innerHTML(node) {
        if (!node || !node.children) {
            return '';
        }
        return node.children.map(outerHTML).join('');
    }

    function outerHTML(node) {
        if (!node) {
            return '';
        }
        if (node.tag === '#text') {
            return node.raw;
        }
        if (node.tag === '#root') {
            return innerHTML(node);
        }
        const attrs = Object.keys(node.attrs || {}).map((name) => {
            const value = node.attrs[name];
            return value === '' ? ` ${name}` : ` ${name}="${escapeHtml(value)}"`;
        }).join('');
        const tag = node.tag;
        if (VOID_TAGS.has(tag)) {
            return `<${tag}${attrs}>`;
        }
        return `<${tag}${attrs}>${innerHTML(node)}</${tag}>`;
    }

    function splitSelectorList(selector) {
        const out = [];
        let buf = '';
        let bracket = 0;
        let quote = '';
        for (const ch of String(selector || '')) {
            if (quote) {
                buf += ch;
                if (ch === quote) {
                    quote = '';
                }
                continue;
            }
            if (ch === '"' || ch === "'") {
                quote = ch;
                buf += ch;
                continue;
            }
            if (ch === '[') {
                bracket += 1;
            }
            if (ch === ']') {
                bracket -= 1;
            }
            if (ch === ',' && bracket === 0) {
                out.push(buf.trim());
                buf = '';
                continue;
            }
            buf += ch;
        }
        if (buf.trim()) {
            out.push(buf.trim());
        }
        return out.filter(Boolean);
    }

    function parseSelectorSequence(selector) {
        const parts = [];
        let buf = '';
        let comb = ' ';
        let bracket = 0;
        let quote = '';
        const flush = () => {
            const text = buf.trim();
            if (text) {
                parts.push({ text, comb });
                comb = ' ';
            }
            buf = '';
        };
        for (const ch of selector) {
            if (quote) {
                buf += ch;
                if (ch === quote) {
                    quote = '';
                }
                continue;
            }
            if (ch === '"' || ch === "'") {
                quote = ch;
                buf += ch;
                continue;
            }
            if (ch === '[') {
                bracket += 1;
            }
            if (ch === ']') {
                bracket -= 1;
            }
            if (bracket === 0 && ch === '>') {
                flush();
                comb = '>';
                continue;
            }
            if (bracket === 0 && /\s/.test(ch)) {
                flush();
                continue;
            }
            buf += ch;
        }
        flush();
        return parts;
    }

    function findClosingBracket(text, start) {
        let quote = '';
        for (let i = start + 1; i < text.length; i += 1) {
            const ch = text[i];
            if (quote) {
                if (ch === quote) {
                    quote = '';
                }
                continue;
            }
            if (ch === '"' || ch === "'") {
                quote = ch;
                continue;
            }
            if (ch === ']') {
                return i;
            }
        }
        return -1;
    }

    function parseAttrToken(token) {
        const m = /^([^\s=*^$~|]+)\s*([*^$~|]?=)?\s*(.*)$/.exec(token.trim());
        if (!m) {
            return null;
        }
        let value = m[3] || '';
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        return { name: m[1].toLowerCase(), op: m[2] || '', value: decodeEntities(value) };
    }

    function parseCompound(text) {
        const comp = { tag: '', id: '', classes: [], attrs: [], nthOfType: 0 };
        let i = 0;
        if (text[0] === '*') {
            comp.tag = '*';
            i = 1;
        } else {
            const m = /^[a-zA-Z][\w-]*/.exec(text);
            if (m) {
                comp.tag = m[0].toLowerCase();
                i = m[0].length;
            }
        }
        while (i < text.length) {
            const ch = text[i];
            if (ch === '#' || ch === '.') {
                const m = /^[\w-]+/.exec(text.slice(i + 1));
                if (!m) {
                    i += 1;
                    continue;
                }
                if (ch === '#') {
                    comp.id = m[0];
                } else {
                    comp.classes.push(m[0]);
                }
                i += m[0].length + 1;
                continue;
            }
            if (ch === '[') {
                const end = findClosingBracket(text, i);
                if (end < 0) {
                    break;
                }
                const attr = parseAttrToken(text.slice(i + 1, end));
                if (attr) {
                    comp.attrs.push(attr);
                }
                i = end + 1;
                continue;
            }
            if (ch === ':') {
                const nth = /^:nth-of-type\(\s*(\d+)\s*\)/.exec(text.slice(i));
                if (nth) {
                    comp.nthOfType = Number(nth[1]);
                    i += nth[0].length;
                    continue;
                }
            }
            i += 1;
        }
        return comp;
    }

    function attrMatches(node, attr) {
        const has = Object.prototype.hasOwnProperty.call(node.attrs || {}, attr.name);
        if (!attr.op) {
            return has;
        }
        if (!has) {
            return false;
        }
        const actual = String(node.attrs[attr.name]);
        const expected = attr.value;
        if (attr.op === '=') {
            return actual === expected;
        }
        if (attr.op === '*=') {
            return actual.includes(expected);
        }
        if (attr.op === '^=') {
            return actual.startsWith(expected);
        }
        if (attr.op === '$=') {
            return actual.endsWith(expected);
        }
        if (attr.op === '~=') {
            return actual.split(/\s+/).includes(expected);
        }
        if (attr.op === '|=') {
            return actual === expected || actual.startsWith(`${expected}-`);
        }
        return false;
    }

    function matchesCompound(node, comp) {
        if (!node || node.tag === '#text' || node.tag === '#root') {
            return false;
        }
        if (comp.tag && comp.tag !== '*' && node.tag !== comp.tag) {
            return false;
        }
        if (comp.id && node.attrs.id !== comp.id) {
            return false;
        }
        const classes = String(node.attrs.class || '').split(/\s+/).filter(Boolean);
        for (const name of comp.classes) {
            if (!classes.includes(name)) {
                return false;
            }
        }
        for (const attr of comp.attrs) {
            if (!attrMatches(node, attr)) {
                return false;
            }
        }
        if (comp.nthOfType) {
            if (!node.parent || !node.parent.children) {
                return false;
            }
            const sameTag = node.parent.children.filter((child) => child.tag === node.tag);
            if (sameTag.indexOf(node) + 1 !== comp.nthOfType) {
                return false;
            }
        }
        return true;
    }

    function matchesSequence(node, parts, index) {
        const part = parts[index];
        if (!matchesCompound(node, parseCompound(part.text))) {
            return false;
        }
        if (index === 0) {
            return true;
        }
        if (part.comb === '>') {
            return Boolean(node.parent) && matchesSequence(node.parent, parts, index - 1);
        }
        let parent = node.parent;
        while (parent && parent.tag !== '#root') {
            if (matchesSequence(parent, parts, index - 1)) {
                return true;
            }
            parent = parent.parent;
        }
        return false;
    }

    function allElements(rootNode) {
        const out = [];
        const walk = (node) => {
            for (const child of node.children || []) {
                if (child.tag !== '#text') {
                    out.push(child);
                    walk(child);
                }
            }
        };
        walk(rootNode);
        return out;
    }

    function querySelectorAll(rootNode, selector) {
        const elements = allElements(rootNode);
        const found = new Set();
        for (const one of splitSelectorList(selector)) {
            const parts = parseSelectorSequence(one);
            if (!parts.length) {
                continue;
            }
            for (const node of elements) {
                if (matchesSequence(node, parts, parts.length - 1)) {
                    found.add(node);
                }
            }
        }
        return Array.from(found).sort((a, b) => a.index - b.index);
    }

    function querySelector(rootNode, selector) {
        const list = querySelectorAll(rootNode, selector);
        return list.length ? list[0] : null;
    }

    return {
        decodeEntities,
        parse,
        textContent,
        innerHTML,
        outerHTML,
        querySelector,
        querySelectorAll
    };
});
