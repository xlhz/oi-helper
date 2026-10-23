(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
        return;
    }
    root.OIHCaptcha = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    const providers = new Map();

    function registerProvider(id, provider) {
        const key = String(id || '').trim();
        if (!key || !provider || typeof provider.recognize !== 'function') {
            throw new Error('provider 必须包含 id 与 recognize(ctx).');
        }
        providers.set(key, Object.assign({ id: key, local: true, name: key }, provider));
    }

    function getProvider(id) {
        return providers.get(String(id || '').trim()) || null;
    }

    function listProviders() {
        return Array.from(providers.values()).map((provider) => ({
            id: provider.id,
            name: provider.name,
            local: provider.local !== false,
            description: provider.description || ''
        }));
    }

    // 默认 provider 只做本地定位提示, 不读取图片像素, 不发起任何网络请求
    registerProvider('local-hint', {
        name: '本地定位提示',
        local: true,
        description: '定位页面中的验证码图片并提示手动输入, 不联网识别.',
        async recognize(ctx) {
            return {
                ok: true,
                provider: 'local-hint',
                recognized: false,
                mode: 'locate',
                selector: ctx && ctx.selector ? ctx.selector : '',
                message: '已在本地定位验证码图片; 默认 provider 不联网识别, 请手动输入验证码.'
            };
        }
    });

    async function recognize(id, ctx) {
        const provider = getProvider(id);
        if (!provider) {
            return {
                ok: false,
                error: `未找到验证码识别 provider: ${id || '(未配置)'}`
            };
        }
        return provider.recognize(ctx || {});
    }

    return {
        registerProvider,
        getProvider,
        listProviders,
        recognize
    };
});
