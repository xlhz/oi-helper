(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
        return;
    }
    root.OIHDesktop = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    const STORAGE_KEY = 'oih.desktop';
    const DEFAULT_API_BASE = 'http://127.0.0.1:17322';
    const DEFAULT_DESKTOP = {
        apiBase: DEFAULT_API_BASE,
        token: '',
        problemDir: ''
    };

    function normalizeApiBase(value) {
        let text = String(value || '').trim();
        if (!text) {
            text = DEFAULT_API_BASE;
        }
        if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
            text = `http://${text}`;
        }
        try {
            const parsed = new URL(text);
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                return DEFAULT_API_BASE;
            }
            const path = parsed.pathname.replace(/\/+$/, '');
            return `${parsed.origin}${path === '/' ? '' : path}`;
        } catch (error) {
            return DEFAULT_API_BASE;
        }
    }

    function validateApiBase(value) {
        const text = String(value || '').trim();
        if (!text) {
            throw new Error('请填写桌面程序 API 地址.');
        }
        const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
        let parsed;
        try {
            parsed = new URL(candidate);
        } catch (error) {
            throw new Error('API 地址无效, 示例: http://127.0.0.1:17322');
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new Error('API 地址仅支持 http 或 https.');
        }
        return normalizeApiBase(candidate);
    }

    function normalizeDesktop(raw) {
        const value = raw && typeof raw === 'object' ? raw : {};
        return {
            apiBase: normalizeApiBase(value.apiBase),
            token: String(value.token || '').trim(),
            problemDir: String(value.problemDir || '').trim()
        };
    }

    function storageOf(storage) {
        if (storage) {
            return storage;
        }
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            return chrome.storage.local;
        }
        return null;
    }

    async function loadDesktop(storage) {
        const store = storageOf(storage);
        if (!store) {
            return normalizeDesktop(null);
        }
        const data = await store.get(STORAGE_KEY);
        return normalizeDesktop(data[STORAGE_KEY]);
    }

    async function saveDesktop(storage, value) {
        const store = storageOf(storage);
        const normalized = normalizeDesktop(value);
        if (store) {
            await store.set({ [STORAGE_KEY]: normalized });
        }
        return normalized;
    }

    function maskToken(token) {
        const text = String(token || '');
        if (!text) {
            return '';
        }
        if (text.length <= 8) {
            return '****';
        }
        return `${text.slice(0, 4)}****${text.slice(-4)}`;
    }

    function errorMessage(data) {
        if (!data) {
            return '';
        }
        const error = data.error;
        if (typeof error === 'string') {
            return error;
        }
        if (error && typeof error === 'object') {
            return String(error.message || error.code || '');
        }
        if (typeof data.message === 'string') {
            return data.message;
        }
        return '';
    }

    function unwrap(data) {
        if (data && typeof data === 'object' && data.ok === true && Object.prototype.hasOwnProperty.call(data, 'data')) {
            return data.data;
        }
        return data;
    }

    async function requestJson(config, path, options) {
        const cfg = normalizeDesktop(config);
        const opts = options || {};
        if (!opts.allowEmptyToken && !cfg.token) {
            return {
                ok: false,
                code: 'no_token',
                error: '未配置桌面程序令牌, 请到扩展设置页的「桌面程序」中粘贴令牌后重试.'
            };
        }
        const method = opts.method || 'GET';
        const headers = { Accept: 'application/json' };
        if (cfg.token) {
            headers['X-OIH-Token'] = cfg.token;
        }
        let body;
        if (opts.body !== undefined) {
            headers['Content-Type'] = 'application/json';
            body = JSON.stringify(opts.body);
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), opts.timeoutMs || 10000);
        let response;
        try {
            response = await fetch(`${cfg.apiBase}${path}`, {
                method,
                headers,
                body,
                signal: controller.signal,
                cache: 'no-store'
            });
        } catch (error) {
            clearTimeout(timer);
            if (error && error.name === 'AbortError') {
                return {
                    ok: false,
                    code: 'timeout',
                    error: `连接桌面程序超时 (${cfg.apiBase}), 请确认桌面程序已启动且 API 已开启.`
                };
            }
            return {
                ok: false,
                code: 'network',
                error: `无法连接桌面程序 (${cfg.apiBase}), 请确认桌面程序已启动且 API 已开启.`
            };
        }
        clearTimeout(timer);
        const text = await response.text();
        let data = null;
        if (text) {
            try {
                data = JSON.parse(text);
            } catch (error) {
                data = null;
            }
        }
        if (!response.ok) {
            if (response.status === 401 || response.status === 403) {
                return {
                    ok: false,
                    code: 'unauthorized',
                    status: response.status,
                    error: '桌面程序令牌无效或已失效, 请在扩展设置页更新令牌.'
                };
            }
            const detail = errorMessage(data) || text.slice(0, 200) || '空响应';
            return {
                ok: false,
                code: 'http',
                status: response.status,
                error: `桌面程序返回错误 (HTTP ${response.status}): ${detail}`
            };
        }
        if (!data) {
            return { ok: false, code: 'bad_json', error: '桌面程序返回的不是有效 JSON.' };
        }
        if (data && typeof data === 'object' && data.ok === false) {
            return {
                ok: false,
                code: (data.error && data.error.code) || 'api',
                error: errorMessage(data) || '桌面程序返回失败.'
            };
        }
        return { ok: true, data: unwrap(data), raw: data };
    }

    async function health(config) {
        const response = await requestJson(config, '/health', {
            method: 'GET',
            allowEmptyToken: true,
            timeoutMs: 5000
        });
        if (!response.ok) {
            return response;
        }
        return { ok: true, health: response.data };
    }

    async function judge(config, payload) {
        const source = String((payload && payload.source) || '');
        if (!source.trim()) {
            return { ok: false, code: 'empty_source', error: '代码为空, 请先刷新代码后重试.' };
        }
        const body = {
            problemDir: String((payload && payload.problemDir) || '').trim(),
            source
        };
        if (payload && payload.input !== undefined) {
            body.input = String(payload.input);
        }
        if (payload && payload.expected !== undefined) {
            body.expected = String(payload.expected);
        }
        return requestJson(config, '/api/judge', {
            method: 'POST',
            body,
            timeoutMs: 120000
        });
    }

    return {
        STORAGE_KEY,
        DEFAULT_API_BASE,
        DEFAULT_DESKTOP,
        normalizeApiBase,
        validateApiBase,
        normalizeDesktop,
        loadDesktop,
        saveDesktop,
        maskToken,
        requestJson,
        health,
        judge
    };
});
