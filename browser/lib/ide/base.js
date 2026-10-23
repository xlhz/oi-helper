(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory(require('../html.js'));
        return;
    }
    root.OIHIdeBase = factory(root.OIHHtml);
})(typeof self !== 'undefined' ? self : this, function (OIHHtml) {
    const TEXTAREA_SELECTORS = [
        'textarea#code',
        'textarea[name="code"]',
        'textarea[name="source"]',
        'textarea[name="program"]',
        'textarea[name="answer"]',
        '.CodeMirror textarea',
        '.monaco-editor textarea',
        'textarea'
    ];
    const SUBMIT_SELECTORS = 'button[type="submit"], input[type="submit"], button';

    function isParsedDoc(doc) {
        return Boolean(doc && doc.tag === '#root');
    }

    function defaultDoc() {
        return typeof document !== 'undefined' ? document : null;
    }

    function queryAll(doc, selector) {
        if (!doc) {
            return [];
        }
        if (typeof doc.querySelectorAll === 'function') {
            return Array.prototype.slice.call(doc.querySelectorAll(selector));
        }
        if (isParsedDoc(doc) && OIHHtml) {
            return OIHHtml.querySelectorAll(doc, selector);
        }
        return [];
    }

    function query(doc, selector) {
        const list = queryAll(doc, selector);
        return list.length ? list[0] : null;
    }

    function attr(node, name) {
        if (!node) {
            return '';
        }
        if (typeof node.getAttribute === 'function') {
            return node.getAttribute(name) || '';
        }
        return (node.attrs && node.attrs[name]) || '';
    }

    function textOf(node) {
        if (!node) {
            return '';
        }
        if (node.tag === '#text') {
            if (typeof node.textContent === 'string') {
                return node.textContent;
            }
            return OIHHtml ? OIHHtml.decodeEntities(node.raw || '') : String(node.raw || '');
        }
        if (typeof node.textContent === 'string') {
            return node.textContent;
        }
        return OIHHtml ? OIHHtml.textContent(node) : '';
    }

    function valueOf(node) {
        if (!node) {
            return '';
        }
        if (typeof node.value === 'string') {
            return node.value;
        }
        return textOf(node);
    }

    function windowOf(doc) {
        if (doc && doc.defaultView) {
            return doc.defaultView;
        }
        if (doc && doc.ownerDocument && doc.ownerDocument.defaultView) {
            return doc.ownerDocument.defaultView;
        }
        return typeof window !== 'undefined' ? window : null;
    }

    function contains(ancestor, node) {
        if (!ancestor || !node) {
            return false;
        }
        if (typeof ancestor.contains === 'function') {
            return ancestor.contains(node);
        }
        let parent = node.parent;
        while (parent) {
            if (parent === ancestor) {
                return true;
            }
            parent = parent.parent;
        }
        return false;
    }

    function findTextarea(doc) {
        for (const selector of TEXTAREA_SELECTORS) {
            const node = query(doc, selector);
            if (node) {
                return node;
            }
        }
        return null;
    }

    function findCodeMirror5(doc) {
        for (const wrapper of queryAll(doc, '.CodeMirror')) {
            const instance = wrapper.CodeMirror;
            if (instance && typeof instance.getValue === 'function') {
                return instance;
            }
        }
        return null;
    }

    function hasMonacoDom(doc) {
        return Boolean(query(doc, '.monaco-editor'));
    }

    function findMonacoModel(doc) {
        if (!hasMonacoDom(doc)) {
            return null;
        }
        const win = windowOf(doc);
        const editor = win && win.monaco && win.monaco.editor;
        if (!editor) {
            return null;
        }
        if (typeof editor.getEditors === 'function') {
            const views = editor.getEditors() || [];
            for (const view of views) {
                const model = view && typeof view.getModel === 'function' ? view.getModel() : null;
                if (model) {
                    return model;
                }
            }
        }
        if (typeof editor.getModels === 'function') {
            const models = editor.getModels() || [];
            if (models.length) {
                return models[0];
            }
        }
        return null;
    }

    function findCm6(doc) {
        return query(doc, '.cm-editor') || query(doc, '.cm-content');
    }

    function readCm6Code(doc) {
        const lines = queryAll(doc, '.cm-content .cm-line');
        if (lines.length) {
            return lines.map((line) => textOf(line)).join('\n');
        }
        const content = query(doc, '.cm-content');
        return content ? textOf(content) : '';
    }

    function findEditor(doc) {
        return findTextarea(doc) || query(doc, '.CodeMirror') || query(doc, '.monaco-editor') || findCm6(doc);
    }

    function getCode(doc) {
        const target = doc || defaultDoc();
        const model = findMonacoModel(target);
        if (model && typeof model.getValue === 'function') {
            try {
                return { ok: true, code: String(model.getValue() || ''), source: 'monaco' };
            } catch (error) {
                return { ok: false, error: `读取 Monaco 编辑器失败: ${error && error.message ? error.message : '未知错误'}` };
            }
        }
        const cm5 = findCodeMirror5(target);
        if (cm5) {
            try {
                return { ok: true, code: String(cm5.getValue() || ''), source: 'codemirror5' };
            } catch (error) {
                return { ok: false, error: `读取 CodeMirror 失败: ${error && error.message ? error.message : '未知错误'}` };
            }
        }
        const textarea = findTextarea(target);
        if (textarea) {
            return { ok: true, code: String(valueOf(textarea)), source: 'textarea' };
        }
        if (findCm6(target)) {
            const code = readCm6Code(target);
            if (code) {
                return { ok: true, code, source: 'codemirror6' };
            }
        }
        return {
            ok: false,
            error: '当前页面未检测到可读取的代码编辑器 (支持 Monaco / CodeMirror / textarea).'
        };
    }

    function setTextareaValue(node, code) {
        try {
            const doc = node.ownerDocument;
            const win = doc && doc.defaultView;
            const proto = win && win.HTMLTextAreaElement ? win.HTMLTextAreaElement.prototype : null;
            const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
            if (descriptor && descriptor.set) {
                descriptor.set.call(node, code);
            } else {
                node.value = code;
            }
            if (win && win.Event && typeof node.dispatchEvent === 'function') {
                node.dispatchEvent(new win.Event('input', { bubbles: true }));
                node.dispatchEvent(new win.Event('change', { bubbles: true }));
            }
            return { ok: true, source: 'textarea' };
        } catch (error) {
            return { ok: false, error: `写入 textarea 失败: ${error && error.message ? error.message : '未知错误'}` };
        }
    }

    function setCode(code, doc) {
        const target = doc || defaultDoc();
        const value = String(code === undefined || code === null ? '' : code);
        const model = findMonacoModel(target);
        if (model && typeof model.setValue === 'function') {
            try {
                model.setValue(value);
                return { ok: true, source: 'monaco' };
            } catch (error) {
                return { ok: false, error: `写入 Monaco 编辑器失败: ${error && error.message ? error.message : '未知错误'}` };
            }
        }
        const cm5 = findCodeMirror5(target);
        if (cm5 && typeof cm5.setValue === 'function') {
            try {
                cm5.setValue(value);
                return { ok: true, source: 'codemirror5' };
            } catch (error) {
                return { ok: false, error: `写入 CodeMirror 失败: ${error && error.message ? error.message : '未知错误'}` };
            }
        }
        const textarea = findTextarea(target);
        if (textarea) {
            return setTextareaValue(textarea, value);
        }
        if (findCm6(target)) {
            return {
                ok: false,
                source: 'codemirror6',
                error: 'CodeMirror 6 编辑器暂不支持写回, 请在编辑器中手动粘贴代码.'
            };
        }
        return { ok: false, error: '当前页面未检测到可写入的代码编辑器.' };
    }

    function currentUrl(doc, url) {
        if (url) {
            return String(url);
        }
        if (doc && doc.location && doc.location.href) {
            return doc.location.href;
        }
        if (typeof location !== 'undefined' && location.href) {
            return location.href;
        }
        return '';
    }

    function findSubmitContext(doc) {
        const editor = findEditor(doc);
        const forms = queryAll(doc, 'form');
        let form = null;
        if (editor) {
            form = forms.find((item) => contains(item, editor)) || null;
        }
        if (!form) {
            form = forms.find((item) => query(item, SUBMIT_SELECTORS)) || null;
        }
        if (!form && forms.length && editor) {
            form = forms[0];
        }
        return { editor, form };
    }

    function triggerSubmit(doc) {
        const target = doc || defaultDoc();
        const context = findSubmitContext(target);
        if (!context.form) {
            return { ok: false, error: '未找到提交表单.' };
        }
        const form = context.form;
        const button = query(form, SUBMIT_SELECTORS);
        try {
            if (typeof button !== 'undefined' && button && typeof button.click === 'function') {
                button.click();
                return { ok: true };
            }
            if (typeof form.requestSubmit === 'function') {
                form.requestSubmit();
                return { ok: true };
            }
            if (typeof form.submit === 'function') {
                form.submit();
                return { ok: true };
            }
            return { ok: false, error: '未找到可点击的提交按钮.' };
        } catch (error) {
            return { ok: false, error: `自动提交失败: ${error && error.message ? error.message : '未知错误'}` };
        }
    }

    return {
        TEXTAREA_SELECTORS,
        SUBMIT_SELECTORS,
        isParsedDoc,
        defaultDoc,
        queryAll,
        query,
        attr,
        textOf,
        valueOf,
        windowOf,
        contains,
        findEditor,
        findSubmitContext,
        triggerSubmit,
        getCode,
        setCode,
        currentUrl
    };
});
