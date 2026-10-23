(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory(require('./base.js'));
        return;
    }
    root.OIHIdeHydro = factory(root.OIHIdeBase);
})(typeof self !== 'undefined' ? self : this, function (base) {
    function pageKind(url) {
        let parsed;
        try {
            parsed = new URL(url);
        } catch (error) {
            return '';
        }
        if (/\/p\/[^/?#]+/.test(parsed.pathname)) {
            return 'problem';
        }
        if (/\/ide(\/|$)/.test(parsed.pathname)) {
            return 'ide';
        }
        return '';
    }

    return {
        id: 'hydro',
        name: 'Hydro',
        match(url) {
            try {
                return /(^|\.)hydro\.ac$/i.test(new URL(url).hostname);
            } catch (error) {
                return false;
            }
        },
        detect(doc) {
            return Boolean(base.findEditor(doc || base.defaultDoc()));
        },
        pageKind,
        getCode: base.getCode,
        setCode: base.setCode,
        getSubmitUrl(doc, url) {
            const current = base.currentUrl(doc, url);
            let parsed;
            try {
                parsed = new URL(current);
            } catch (error) {
                return { ok: false, error: '当前页面链接无效, 无法生成提交地址.' };
            }
            const match = /\/p\/([^/?#]+)/.exec(parsed.pathname);
            if (!match) {
                return { ok: false, error: '未能从当前链接识别题目编号, 请在题目页打开面板后重试.' };
            }
            const prefix = parsed.pathname.slice(0, match.index);
            return {
                ok: true,
                url: `${parsed.origin}${prefix}/p/${encodeURIComponent(match[1])}/submit`,
                canAutoSubmit: false
            };
        }
    };
});
