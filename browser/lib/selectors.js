(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
        return;
    }
    root.OIHSelectors = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    const STORAGE_KEY = 'oih.manualSelectors';
    const PURPOSES = [
        'title',
        'pid',
        'statement',
        'timeLimit',
        'memoryLimit',
        'sampleInput',
        'sampleOutput',
        'loginUser',
        'loginPass'
    ];

    function emptyStore() {
        return { version: 1, sites: {} };
    }

    function normalizeStore(raw) {
        if (!raw || typeof raw !== 'object' || !raw.sites || typeof raw.sites !== 'object') {
            return emptyStore();
        }
        const sites = {};
        for (const site of Object.keys(raw.sites)) {
            const value = raw.sites[site];
            if (!value || typeof value !== 'object') {
                continue;
            }
            const item = {};
            for (const purpose of Object.keys(value)) {
                if (PURPOSES.includes(purpose) && typeof value[purpose] === 'string' && value[purpose].trim()) {
                    item[purpose] = value[purpose];
                }
            }
            if (Object.keys(item).length) {
                sites[site] = item;
            }
        }
        return { version: 1, sites };
    }

    async function readStore(storage) {
        const data = await storage.get(STORAGE_KEY);
        return normalizeStore(data[STORAGE_KEY]);
    }

    async function writeStore(storage, store) {
        await storage.set({ [STORAGE_KEY]: normalizeStore(store) });
    }

    // 按站点 + 用途持久化; storage 需提供 get/set, 便于在 Node 里注入模拟实现
    async function saveSelector(storage, site, purpose, selector) {
        const value = String(selector || '').trim();
        if (!value) {
            throw new Error('选择器不能为空.');
        }
        if (!PURPOSES.includes(purpose)) {
            throw new Error(`未知用途: ${purpose}`);
        }
        const store = await readStore(storage);
        if (!store.sites[site]) {
            store.sites[site] = {};
        }
        store.sites[site][purpose] = value;
        await writeStore(storage, store);
        return store;
    }

    async function getSelector(storage, site, purpose) {
        const store = await readStore(storage);
        return (store.sites[site] && store.sites[site][purpose]) || '';
    }

    async function getSiteSelectors(storage, site) {
        const store = await readStore(storage);
        return Object.assign({}, (store.sites && store.sites[site]) || {});
    }

    async function removeSelector(storage, site, purpose) {
        const store = await readStore(storage);
        if (store.sites[site]) {
            delete store.sites[site][purpose];
            if (!Object.keys(store.sites[site]).length) {
                delete store.sites[site];
            }
        }
        await writeStore(storage, store);
        return store;
    }

    function escapeIdentifier(value) {
        const text = String(value || '');
        if (/^[A-Za-z_][\w-]*$/.test(text)) {
            return text;
        }
        if (typeof CSS !== 'undefined' && CSS && CSS.escape) {
            return CSS.escape(text);
        }
        return text.replace(/([^\w-])/g, '\\$1');
    }

    // CSS 路径优先, 兄弟标签重名时用 nth-of-type 兜底保证唯一
    function cssPath(element) {
        if (!element || element.nodeType !== 1) {
            return '';
        }
        const doc = element.ownerDocument;
        const parts = [];
        let node = element;
        while (node && node.nodeType === 1) {
            const tag = node.tagName.toLowerCase();
            if (tag === 'html' || tag === 'body') {
                parts.unshift(tag);
                break;
            }
            const id = node.getAttribute('id');
            if (id && /^[A-Za-z][\w-]*$/.test(id)) {
                const selector = `#${id}`;
                try {
                    if (doc.querySelectorAll(selector).length === 1) {
                        parts.unshift(selector);
                        break;
                    }
                } catch (error) {
                    // 非法 id 继续走标签路径
                }
            }
            let part = tag;
            const classes = Array.from(node.classList || [])
                .filter((name) => /^[A-Za-z_][\w-]*$/.test(name))
                .slice(0, 3);
            if (classes.length) {
                part += `.${classes.join('.')}`;
            }
            const parent = node.parentElement;
            if (parent) {
                const sameTag = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
                if (sameTag.length > 1) {
                    part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
                }
            }
            parts.unshift(part);
            node = parent;
        }
        let selector = parts.join(' > ');
        try {
            if (!doc.querySelectorAll(selector).length) {
                selector = `${element.tagName.toLowerCase()}${element.getAttribute('id') ? escapeIdentifier(element.getAttribute('id')) : ''}`;
            }
        } catch (error) {
            selector = element.tagName.toLowerCase();
        }
        return selector;
    }

    return {
        STORAGE_KEY,
        PURPOSES,
        normalizeStore,
        saveSelector,
        getSelector,
        getSiteSelectors,
        removeSelector,
        cssPath
    };
});
