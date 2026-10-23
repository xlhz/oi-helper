(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory(
            require('./base.js'),
            require('./hydro.js'),
            require('./generic.js')
        );
        return;
    }
    root.OIHIdeAdapters = factory(root.OIHIdeBase, root.OIHIdeHydro, root.OIHIdeGeneric);
})(typeof self !== 'undefined' ? self : this, function (base, hydro, generic) {
    const ADAPTERS = [];
    const GENERIC_ID = 'generic';

    function register(adapter) {
        if (!adapter || typeof adapter !== 'object' || !adapter.id) {
            throw new Error('在线 IDE 适配器缺少 id.');
        }
        if (typeof adapter.match !== 'function' || typeof adapter.detect !== 'function') {
            throw new Error(`在线 IDE 适配器 ${adapter.id} 必须实现 match 与 detect.`);
        }
        const index = ADAPTERS.findIndex((item) => item.id === adapter.id);
        if (index >= 0) {
            ADAPTERS[index] = adapter;
        } else if (adapter.id === GENERIC_ID) {
            ADAPTERS.push(adapter);
        } else {
            const genericIndex = ADAPTERS.findIndex((item) => item.id === GENERIC_ID);
            if (genericIndex < 0) {
                ADAPTERS.push(adapter);
            } else {
                ADAPTERS.splice(genericIndex, 0, adapter);
            }
        }
        return adapter;
    }

    if (hydro) {
        register(hydro);
    }
    if (generic) {
        register(generic);
    }

    function byId(id) {
        return ADAPTERS.find((adapter) => adapter.id === id) || null;
    }

    function byUrl(url) {
        for (const adapter of ADAPTERS) {
            if (adapter.id !== GENERIC_ID && adapter.match(url)) {
                return adapter;
            }
        }
        const fallback = byId(GENERIC_ID);
        return fallback && fallback.match(url) ? fallback : null;
    }

    function resolve(url, doc) {
        const target = doc || base.defaultDoc();
        for (const adapter of ADAPTERS) {
            if (adapter.id === GENERIC_ID) {
                continue;
            }
            if (adapter.match(url) && adapter.detect(target)) {
                return adapter;
            }
        }
        const fallback = byId(GENERIC_ID);
        return fallback && fallback.match(url) && fallback.detect(target) ? fallback : null;
    }

    function pageKindOf(adapter, url) {
        if (adapter && typeof adapter.pageKind === 'function') {
            return adapter.pageKind(url) || '';
        }
        return '';
    }

    return {
        register,
        list: () => ADAPTERS.slice(),
        byId,
        byUrl,
        resolve,
        pageKindOf,
        findEditor: base.findEditor,
        findSubmitContext: base.findSubmitContext,
        triggerSubmit: base.triggerSubmit,
        currentUrl: base.currentUrl
    };
});
