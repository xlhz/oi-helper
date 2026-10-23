(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
        return;
    }
    root.OIHConfig = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    const SETTINGS_KEY = 'oih.settings';
    const DEFAULT_SETTINGS = {
        proxy: {
            host: '',
            port: '',
            username: '',
            password: '',
            enabled: false
        },
        autofill: {
            enabled: false
        },
        captcha: {
            enabled: false,
            provider: 'local-hint',
            sites: {}
        }
    };

    function normalizeSettings(raw) {
        const value = raw && typeof raw === 'object' ? raw : {};
        const proxy = Object.assign({}, DEFAULT_SETTINGS.proxy, value.proxy || {});
        proxy.host = String(proxy.host || '').trim();
        proxy.port = String(proxy.port || '').trim();
        proxy.username = String(proxy.username || '');
        proxy.password = String(proxy.password || '');
        proxy.enabled = Boolean(proxy.enabled);
        const autofill = { enabled: Boolean(value.autofill && value.autofill.enabled) };
        const captchaRaw = value.captcha || {};
        const captcha = {
            enabled: Boolean(captchaRaw.enabled),
            provider: String(captchaRaw.provider === undefined ? DEFAULT_SETTINGS.captcha.provider : captchaRaw.provider),
            sites: Object.assign({}, captchaRaw.sites || {})
        };
        return { proxy, autofill, captcha };
    }

    async function loadSettings() {
        const data = await chrome.storage.local.get(SETTINGS_KEY);
        return normalizeSettings(data[SETTINGS_KEY]);
    }

    async function saveSettings(settings) {
        const value = normalizeSettings(settings);
        await chrome.storage.local.set({ [SETTINGS_KEY]: value });
        return value;
    }

    // Cookie 掩码只暴露前 4 后 4, 其余一律星号
    function maskCookie(cookie) {
        const text = String(cookie || '');
        if (!text) {
            return '';
        }
        if (text.length <= 8) {
            return '****';
        }
        return `${text.slice(0, 4)}****${text.slice(-4)}`;
    }

    function readableError(error, fallback) {
        if (typeof error === 'string' && error.trim()) {
            return error.trim();
        }
        if (error && typeof error.message === 'string' && error.message.trim()) {
            return error.message.trim();
        }
        return fallback || '操作失败, 请稍后重试.';
    }

    return {
        SETTINGS_KEY,
        DEFAULT_SETTINGS,
        normalizeSettings,
        loadSettings,
        saveSettings,
        maskCookie,
        readableError
    };
});
