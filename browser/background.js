importScripts(
    'lib/config.js',
    'lib/rules.js',
    'lib/html.js',
    'lib/parse.js',
    'lib/selectors.js',
    'lib/vault.js',
    'lib/proxy.js',
    'lib/desktop.js',
    'lib/ide/base.js',
    'lib/ide/hydro.js',
    'lib/ide/generic.js',
    'lib/ide/index.js'
);

const LAST_RESULT_KEY = 'oih.lastResult';
let rulesPromise = null;

function sessionArea() {
    return chrome.storage.session || chrome.storage.local;
}

function activeTab() {
    return new Promise((resolve) => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            resolve((tabs && tabs[0]) || null);
        });
    });
}

async function loadRules() {
    if (!rulesPromise) {
        rulesPromise = Promise.all(OIHRules.RULE_FILES.map(async (id) => {
            const response = await fetch(chrome.runtime.getURL(`lib/rules/${id}.json`), { cache: 'no-store' });
            if (!response.ok) {
                throw new Error(`规则文件加载失败: ${id}.json`);
            }
            const rule = await response.json();
            if (!rule.id || !rule.version || !Array.isArray(rule.domains)) {
                throw new Error(`规则文件字段不完整: ${id}.json`);
            }
            return rule;
        })).catch((error) => {
            rulesPromise = null;
            throw error;
        });
    }
    return rulesPromise;
}

function identifyWithRules(rules, url, domFeatures) {
    let best = null;
    for (const rule of rules) {
        const dom = (domFeatures && domFeatures[rule.id]) || {};
        const hit = OIHRules.matchRule(rule, { url, dom });
        if (!hit) {
            continue;
        }
        if (!best || hit.score > best.score) {
            best = hit;
        }
    }
    return best;
}

async function identifyUrl(url, domFeatures) {
    const rules = await loadRules();
    return identifyWithRules(rules, url, domFeatures);
}

function tabStateKey(tabId) {
    return `oih.tab.${tabId}`;
}

async function saveTabState(tabId, state) {
    if (!tabId) {
        return;
    }
    await sessionArea().set({ [tabStateKey(tabId)]: state });
}

async function readTabState(tabId) {
    if (!tabId) {
        return null;
    }
    const key = tabStateKey(tabId);
    const data = await sessionArea().get(key);
    return data[key] || null;
}

function assertUrl(url) {
    let parsed;
    try {
        parsed = new URL(url);
    } catch (error) {
        throw new Error('链接无效, 请传入 http(s) 地址.');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new Error('仅支持 http(s) 页面.');
    }
    return parsed;
}

async function cookieHeaderFor(url) {
    const cookies = await chrome.cookies.getAll({ url });
    return {
        cookie: cookies.map((item) => `${item.name}=${item.value}`).join('; '),
        count: cookies.length,
        httpOnlyCount: cookies.filter((item) => item.httpOnly).length
    };
}

function withContentQuery(url, query) {
    const parsed = new URL(url);
    for (const part of String(query || '').split('&')) {
        if (!part) {
            continue;
        }
        const index = part.indexOf('=');
        const key = index < 0 ? part : part.slice(0, index);
        const value = index < 0 ? '' : part.slice(index + 1);
        parsed.searchParams.set(key, value);
    }
    return parsed.toString();
}

function looksAntiBot(text) {
    const page = String(text || '');
    return ['Cerberus', "you're not a bot", 'Anubis', 'Just a moment', 'cf-challenge']
        .some((mark) => page.includes(mark));
}

async function requestPage(url, cookie, rule) {
    const isJson = rule && rule.fetch && rule.fetch.mode === 'luogu-json';
    const headers = {
        Accept: isJson ? 'application/json, text/plain, */*' : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
    };
    if (isJson) {
        headers['X-Requested-With'] = 'XMLHttpRequest';
        headers['x-lentille-request'] = 'content-only';
    }
    if (cookie) {
        headers.Cookie = cookie;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    const request = () => fetch(url, {
        method: 'GET',
        credentials: 'include',
        headers,
        redirect: 'follow',
        signal: controller.signal
    });
    let response;
    try {
        response = await request();
    } catch (error) {
        if (error && error.name === 'AbortError') {
            clearTimeout(timer);
            throw new Error('请求超时, 请检查网络或代理设置.');
        }
        // 个别 Chrome 版本禁止手动设置 Cookie 头, 退回 credentials: include
        if (headers.Cookie) {
            delete headers.Cookie;
            try {
                response = await request();
            } catch (retryError) {
                clearTimeout(timer);
                if (retryError && retryError.name === 'AbortError') {
                    throw new Error('请求超时, 请检查网络或代理设置.');
                }
                throw new Error('网络请求失败, 请检查网络或代理设置.');
            }
        } else {
            clearTimeout(timer);
            throw new Error('网络请求失败, 请检查网络或代理设置.');
        }
    }
    clearTimeout(timer);
    const text = await response.text();
    if (!response.ok) {
        if (looksAntiBot(text)) {
            throw new Error('站点触发反爬验证: 请先在浏览器打开该页面并通过验证, 再重试.');
        }
        throw new Error(`抓取失败: HTTP ${response.status}. 请确认已在浏览器登录该站点.`);
    }
    if (looksAntiBot(text)) {
        throw new Error('站点触发反爬验证: 请先在浏览器打开该页面并通过验证, 再重试.');
    }
    return text;
}

async function parseWithRule(url, html, domFeatures) {
    const match = await identifyUrl(url, domFeatures);
    if (!match) {
        return {
            ok: false,
            url,
            error: '未命中受支持站点的规则, 请确认链接域名在 host_permissions 内.'
        };
    }
    const manual = await OIHSelectors.getSiteSelectors(chrome.storage.local, match.rule.id);
    const result = OIHParse.parsePage({ url, html, rule: match.rule, manual });
    result.pageType = match.pageType;
    return result;
}

function previewOf(result) {
    if (!result) {
        return null;
    }
    return {
        ok: Boolean(result.ok),
        error: result.error || '',
        oj: result.oj || '',
        pid: result.pid || '',
        name: result.name || result.title || '',
        title: result.title || result.name || '',
        url: result.url || '',
        submitUrl: result.submitUrl || '',
        timeLimit: result.timeLimit === null ? null : result.timeLimit,
        memoryLimit: result.memoryLimit === null ? null : result.memoryLimit,
        sampleCount: (result.samples || []).length,
        samples: (result.samples || []).slice(0, 3),
        markdown: String(result.markdown || '').slice(0, 4000),
        ruleId: result.ruleId || '',
        ruleVersion: result.ruleVersion || '',
        fetchedAt: Date.now()
    };
}

async function saveLastResult(result) {
    await sessionArea().set({ [LAST_RESULT_KEY]: previewOf(result) });
}

async function fetchProblem(url) {
    assertUrl(url);
    const match = await identifyUrl(url);
    if (!match) {
        return { ok: false, url, error: '未命中受支持站点的规则.' };
    }
    const cookie = await cookieHeaderFor(url);
    const target = match.rule.fetch && match.rule.fetch.mode === 'luogu-json' && match.rule.fetch.contentQuery
        ? withContentQuery(url, match.rule.fetch.contentQuery)
        : url;
    const html = await requestPage(target, cookie.cookie, match.rule);
    const result = await parseWithRule(url, html, null);
    await saveLastResult(result);
    return result;
}

async function collectCurrentPage(tabId) {
    let tab = null;
    if (tabId) {
        tab = await new Promise((resolve) => chrome.tabs.get(tabId, (value) => resolve(value || null)));
    }
    if (!tab) {
        tab = await activeTab();
    }
    if (!tab || !tab.id) {
        return { ok: false, error: '未找到当前标签页.' };
    }
    let response;
    try {
        response = await chrome.tabs.sendMessage(tab.id, { type: 'collectOuterHtml' });
    } catch (error) {
        return { ok: false, error: '内容脚本未就绪, 请刷新页面后重试.' };
    }
    if (!response || !response.ok || !response.html) {
        return { ok: false, error: (response && response.error) || '页面采集失败.' };
    }
    const result = await parseWithRule(response.url || tab.url, response.html, null);
    await saveLastResult(result);
    return result;
}

async function getSettings() {
    return OIHConfig.loadSettings();
}

async function getAutofill() {
    const settings = await OIHConfig.loadSettings();
    if (!settings.autofill.enabled) {
        return { ok: false, error: '自动填充未开启.' };
    }
    const credentials = await OIHVault.loadCredentials();
    if (!credentials) {
        return { ok: false, error: '本地未保存账号密码.' };
    }
    return { ok: true, username: credentials.username, password: credentials.password };
}

async function handleMessage(message, sender) {
    const type = message.type;
    if (type === 'getRulesForUrl') {
        assertUrl(message.url);
        const rules = await loadRules();
        return { ok: true, rules: OIHRules.rulesForHost(rules, OIHRules.hostOf(message.url)) };
    }
    if (type === 'getRuleInfo') {
        const rules = await loadRules();
        return { ok: true, rules: rules.map(OIHRules.ruleSummary) };
    }
    if (type === 'identify') {
        assertUrl(message.url);
        const match = await identifyUrl(message.url, message.domFeatures);
        if (!match) {
            return { ok: false, error: '未命中站点规则.' };
        }
        const tabId = sender && sender.tab ? sender.tab.id : message.tabId;
        const state = {
            url: message.url,
            host: match.host,
            ruleId: match.rule.id,
            ruleName: match.rule.name,
            ruleVersion: match.rule.version,
            pageType: match.pageType,
            matchedFeatures: match.matchedFeatures,
            title: message.title || ''
        };
        await saveTabState(tabId, state);
        return {
            ok: true,
            rule: match.rule,
            ruleId: match.rule.id,
            ruleName: match.rule.name,
            ruleVersion: match.rule.version,
            pageType: match.pageType,
            matchedFeatures: match.matchedFeatures
        };
    }
    if (type === 'pageState') {
        const tabId = sender && sender.tab ? sender.tab.id : message.tabId;
        const previous = (await readTabState(tabId)) || {};
        await saveTabState(tabId, Object.assign({}, previous, message.state || {}, { updatedAt: Date.now() }));
        return { ok: true };
    }
    if (type === 'getTabState') {
        const tabId = message.tabId || (sender && sender.tab ? sender.tab.id : null) || (await activeTab() || {}).id;
        return { ok: true, state: await readTabState(tabId) };
    }
    if (type === 'getCookies') {
        assertUrl(message.url);
        const cookies = await cookieHeaderFor(message.url);
        return {
            ok: true,
            cookie: cookies.cookie,
            masked: OIHConfig.maskCookie(cookies.cookie),
            count: cookies.count,
            httpOnlyCount: cookies.httpOnlyCount
        };
    }
    if (type === 'fetchProblem') {
        return fetchProblem(message.url);
    }
    if (type === 'collectCurrentPage') {
        return collectCurrentPage(message.tabId);
    }
    if (type === 'parsePage') {
        assertUrl(message.url);
        const result = await parseWithRule(message.url, message.html, message.domFeatures);
        await saveLastResult(result);
        return result;
    }
    if (type === 'getSettings') {
        return { ok: true, settings: await getSettings() };
    }
    if (type === 'getAutofill') {
        return getAutofill();
    }
    if (type === 'getManualSelectors') {
        const selectors = await OIHSelectors.getSiteSelectors(chrome.storage.local, message.site);
        return { ok: true, selectors };
    }
    if (type === 'saveManualSelector') {
        const site = String(message.site || '').trim();
        if (!site) {
            return { ok: false, error: '缺少站点标识.' };
        }
        const store = await OIHSelectors.saveSelector(chrome.storage.local, site, message.purpose, message.selector);
        return { ok: true, store };
    }
    if (type === 'removeManualSelector') {
        const store = await OIHSelectors.removeSelector(chrome.storage.local, message.site, message.purpose);
        return { ok: true, store };
    }
    if (type === 'panel:collect') {
        const tabId = (sender && sender.tab && sender.tab.id) || message.tabId;
        return collectCurrentPage(tabId);
    }
    if (type === 'panel:judge') {
        const config = await OIHDesktop.loadDesktop(chrome.storage.local);
        const hasCase = message.input !== undefined || message.expected !== undefined;
        return OIHDesktop.judge(config, {
            problemDir: message.problemDir || (hasCase ? '' : config.problemDir),
            source: message.source,
            input: message.input,
            expected: message.expected
        }).then((response) => {
            if (!response.ok) {
                return response;
            }
            return { ok: true, result: response.data };
        });
    }
    if (type === 'panel:testDesktop') {
        const config = await OIHDesktop.loadDesktop(chrome.storage.local);
        const target = Object.assign({}, config, { apiBase: message.apiBase || config.apiBase });
        const response = await OIHDesktop.health(target);
        if (!response.ok) {
            return response;
        }
        return { ok: true, health: response.health };
    }
    if (type === 'panel:submit') {
        assertUrl(message.url);
        const adapter = OIHIdeAdapters.byUrl(message.url);
        if (!adapter) {
            return { ok: false, error: '当前站点暂无可用的在线 IDE 适配器.' };
        }
        let doc = null;
        if (message.html) {
            try {
                doc = OIHHtml.parse(message.html);
            } catch (error) {
                doc = null;
            }
        }
        const target = adapter.getSubmitUrl(doc, message.url);
        return {
            ok: Boolean(target.ok),
            adapterId: adapter.id,
            url: target.url || '',
            canAutoSubmit: Boolean(target.canAutoSubmit),
            error: target.error || ''
        };
    }
    if (type === 'panel:openTab') {
        const target = assertUrl(message.url).toString();
        const tab = await new Promise((resolve) => {
            chrome.tabs.create({ url: target }, (value) => {
                const error = chrome.runtime.lastError;
                resolve(error ? { error: error.message } : (value || null));
            });
        });
        if (!tab || tab.error) {
            return { ok: false, error: `打开提交页失败: ${(tab && tab.error) || '未创建标签页'}` };
        }
        return { ok: true, tabId: tab.id };
    }
    if (type === 'getLastResult') {
        const data = await sessionArea().get(LAST_RESULT_KEY);
        return { ok: true, result: data[LAST_RESULT_KEY] || null };
    }
    if (type === 'clearLastResult') {
        await sessionArea().remove(LAST_RESULT_KEY);
        return { ok: true };
    }
    return { ok: false, error: `未知消息类型: ${type}` };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message || {}, sender || {})
        .then((response) => sendResponse(response))
        .catch((error) => sendResponse({ ok: false, error: OIHConfig.readableError(error) }));
    return true;
});

chrome.runtime.onInstalled.addListener((details) => {
    const version = chrome.runtime.getManifest().version;
    console.info(`[OI Helper] 扩展已${details.reason === 'install' ? '安装' : '更新'}, 版本 ${version}`);
});

// Service Worker 重启后恢复用户显式启用的 PAC 代理
async function restoreProxy() {
    try {
        const [rules, settings, secret] = await Promise.all([
            loadRules(),
            OIHConfig.loadSettings(),
            OIHVault.loadProxySecret().catch(() => null)
        ]);
        const domains = Array.from(new Set(rules.flatMap((rule) => rule.domains)));
        const proxy = Object.assign({}, settings.proxy);
        if (secret) {
            proxy.username = secret.username || proxy.username;
            proxy.password = secret.password;
        }
        await OIHProxy.restore(Object.assign({}, settings, { proxy }), domains);
    } catch (error) {
        // 代理恢复失败不影响采集, 用户可在设置页重新启用
    }
}

restoreProxy();
