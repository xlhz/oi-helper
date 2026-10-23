(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
        return;
    }
    root.OIHRules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    const RULE_FILES = ['luogu', 'xmoj', 'codeforces', 'atcoder', 'hydro'];
    const DOMAIN_SCORE = 10;
    const URL_SCORE = 20;
    const DOM_SCORE = 40;

    function hostOf(url) {
        try {
            return new URL(url).hostname.toLowerCase();
        } catch (error) {
            return '';
        }
    }

    function pathOf(url) {
        try {
            const value = new URL(url);
            return `${value.pathname}${value.search}`;
        } catch (error) {
            return String(url || '');
        }
    }

    function domainMatched(host, domains) {
        if (!host) {
            return false;
        }
        return (domains || []).some((domain) => {
            const value = String(domain || '').toLowerCase();
            return host === value || host.endsWith(`.${value}`);
        });
    }

    function patternMatched(text, patterns) {
        return (patterns || []).some((pattern) => {
            try {
                return new RegExp(pattern, 'i').test(text);
            } catch (error) {
                return false;
            }
        });
    }

    function featureScore(rule, name, ctx) {
        const feature = rule.features && rule.features[name];
        if (!feature) {
            return { score: 0, matched: false };
        }
        const path = pathOf(ctx.url);
        let score = 0;
        let matched = false;
        if (patternMatched(path, feature.urlPatterns)) {
            score += URL_SCORE;
            matched = true;
        }
        const probe = ctx.dom && ctx.dom[name];
        if (probe) {
            score += DOM_SCORE;
            matched = true;
        }
        return { score, matched };
    }

    function matchRule(rule, ctx) {
        if (!rule || !rule.id) {
            return null;
        }
        const host = ctx.host || hostOf(ctx.url);
        if (!domainMatched(host, rule.domains)) {
            return null;
        }
        const problem = featureScore(rule, 'problem', ctx);
        const login = featureScore(rule, 'login', ctx);
        const best = problem.score >= login.score
            ? { pageType: 'problem', matched: problem.matched, score: problem.score }
            : { pageType: 'login', matched: login.matched, score: login.score };
        return {
            rule,
            host,
            score: DOMAIN_SCORE + best.score,
            pageType: best.matched ? best.pageType : '',
            matchedFeatures: ['problem', 'login'].filter((name) => (
                name === 'problem' ? problem.matched : login.matched
            ))
        };
    }

    // 按域名 + DOM 特征评分, 返回得分最高的规则
    function matchRules(rules, ctx) {
        const host = ctx.host || hostOf(ctx.url);
        if (!host) {
            return null;
        }
        let best = null;
        for (const rule of rules || []) {
            const hit = matchRule(rule, Object.assign({}, ctx, { host }));
            if (!hit) {
                continue;
            }
            if (!best || hit.score > best.score) {
                best = hit;
            }
        }
        return best;
    }

    function rulesForHost(rules, host) {
        return (rules || []).filter((rule) => domainMatched(host, rule.domains));
    }

    function pickElement(doc, selectors) {
        for (const selector of selectors || []) {
            const value = String(selector || '').trim();
            if (!value) {
                continue;
            }
            try {
                const node = doc.querySelector(value);
                if (node) {
                    return node;
                }
            } catch (error) {
                // 改版后的非法选择器直接跳过
            }
        }
        return null;
    }

    // 内容脚本用规则内的特征选择器探测 DOM, 避免在页面里硬编码站点标记
    function probeFeatures(rule, doc) {
        const out = {};
        for (const name of Object.keys((rule && rule.features) || {})) {
            const feature = rule.features[name];
            out[name] = Boolean(pickElement(doc, feature.selectors));
        }
        return out;
    }

    function ruleSummary(rule) {
        return {
            id: rule.id,
            name: rule.name,
            version: rule.version,
            domains: (rule.domains || []).slice()
        };
    }

    return {
        RULE_FILES,
        hostOf,
        pathOf,
        domainMatched,
        matchRule,
        matchRules,
        rulesForHost,
        pickElement,
        probeFeatures,
        ruleSummary
    };
});
