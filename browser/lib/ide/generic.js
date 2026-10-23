(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory(require('./base.js'));
        return;
    }
    root.OIHIdeGeneric = factory(root.OIHIdeBase);
})(typeof self !== 'undefined' ? self : this, function (base) {
    // 通用适配器覆盖自身带编辑器的页面, 并显式标记 /ide 与 /problem 形态
    function pageKind(url) {
        let parsed;
        try {
            parsed = new URL(url);
        } catch (error) {
            return '';
        }
        if (/\/problem(\/|$)/.test(parsed.pathname) || /\/p\/[^/?#]+/.test(parsed.pathname)) {
            return 'problem';
        }
        if (/\/ide(\/|$)/.test(parsed.pathname)) {
            return 'ide';
        }
        return '';
    }

    return {
        id: 'generic',
        name: '通用编辑器',
        match(url) {
            try {
                const protocol = new URL(url).protocol;
                return protocol === 'http:' || protocol === 'https:';
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
            const target = doc || base.defaultDoc();
            const current = base.currentUrl(target, url);
            const context = base.findSubmitContext(target);
            if (!context.form) {
                return {
                    ok: false,
                    error: '未找到提交表单或提交按钮, 当前页面不支持自动提交, 请手动在站点提交.'
                };
            }
            const action = base.attr(context.form, 'action');
            let submitUrl = current;
            if (action) {
                try {
                    submitUrl = new URL(action, current).toString();
                } catch (error) {
                    submitUrl = action;
                }
            }
            return {
                ok: true,
                url: submitUrl,
                canAutoSubmit: Boolean(context.editor),
                error: context.editor ? '' : '未检测到代码编辑器, 无法自动写入.'
            };
        }
    };
});
