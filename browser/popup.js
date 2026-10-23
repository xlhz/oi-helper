(function () {
    const current = {
        tab: null,
        state: null,
        settings: null,
        cookiePlain: ''
    };

    const $ = (id) => document.getElementById(id);

    function send(message) {
        return new Promise((resolve) => {
            chrome.runtime.sendMessage(message, (response) => {
                const error = chrome.runtime.lastError;
                if (error) {
                    resolve({ ok: false, error: `后台未响应: ${error.message}` });
                    return;
                }
                resolve(response || { ok: false, error: '后台未返回结果.' });
            });
        });
    }

    function showMsg(text, danger) {
        const box = $('msg');
        box.textContent = text;
        box.className = `msg${danger ? ' danger' : ''}`;
        box.classList.remove('hidden');
    }

    function clearMsg() {
        $('msg').classList.add('hidden');
    }

    function hostOf(url) {
        try {
            return new URL(url).hostname;
        } catch (error) {
            return '';
        }
    }

    function pageTypeLabel(type) {
        if (type === 'problem') {
            return '题目页';
        }
        if (type === 'login') {
            return '登录页';
        }
        return '站点页 (未识别页面类型)';
    }

    function renderSite(state) {
        const badge = $('ruleBadge');
        const info = $('siteInfo');
        info.textContent = '';
        const stale = state && state.url && current.tab && current.tab.url &&
            hostOf(state.url) !== hostOf(current.tab.url);
        if (!state || !state.ruleId || stale) {
            badge.textContent = '未识别';
            badge.className = 'badge off';
            const empty = document.createElement('div');
            empty.className = 'empty';
            empty.textContent = '当前页面未识别为受支持的 OJ. 支持: 洛谷 / XMOJ / Codeforces / AtCoder. 若刚安装或更新扩展, 请刷新页面后重试.';
            info.appendChild(empty);
            $('collectBtn').disabled = true;
            $('fetchBtn').disabled = true;
            $('manualBtn').disabled = true;
            $('cookieBtn').disabled = true;
            return;
        }
        badge.textContent = state.ruleName || state.ruleId;
        badge.className = 'badge ok';
        $('collectBtn').disabled = false;
        $('fetchBtn').disabled = false;
        $('manualBtn').disabled = false;
        $('cookieBtn').disabled = false;
        const rows = [
            ['规则版本', `v${state.ruleVersion || '?'}`],
            ['页面类型', pageTypeLabel(state.pageType)],
            ['域名', state.host || hostOf(state.url)],
            ['命中特征', (state.matchedFeatures || []).join(', ') || '仅域名'],
            ['页面标题', state.title || '未读取']
        ];
        for (const [key, value] of rows) {
            const row = document.createElement('div');
            row.className = 'row';
            const label = document.createElement('span');
            label.className = 'hint';
            label.style.minWidth = '64px';
            label.textContent = key;
            const text = document.createElement('span');
            text.textContent = value;
            row.appendChild(label);
            row.appendChild(text);
            info.appendChild(row);
        }
    }

    function renderSecurity() {
        const info = $('securityInfo');
        info.textContent = '';
        const settings = current.settings;
        if (!settings) {
            return;
        }
        const proxy = settings.proxy;
        const captcha = settings.captcha;
        const sites = Object.keys(captcha.sites || {}).filter((key) => captcha.sites[key]);
        const proxyText = proxy.enabled
            ? `已启用 ${proxy.host}:${proxy.port}`
            : proxy.host ? `未启用 (${proxy.host}:${proxy.port})` : '未配置';
        const rows = [
            ['代理', proxyText],
            ['自动填充', settings.autofill.enabled ? '已开启' : '关闭'],
            ['验证码', captcha.enabled ? `已开启 (${sites.join(', ') || '未选站点'})` : '关闭'],
            ['验证码 provider', captcha.provider || '未配置 (开启后会提示)']
        ];
        for (const [key, value] of rows) {
            const row = document.createElement('div');
            row.className = 'row';
            const label = document.createElement('span');
            label.className = 'hint';
            label.style.minWidth = '64px';
            label.textContent = key;
            const text = document.createElement('span');
            text.textContent = value;
            row.appendChild(label);
            row.appendChild(text);
            info.appendChild(row);
        }
        $('disableProxyBtn').classList.toggle('hidden', !proxy.enabled);
        const siteId = current.state && current.state.ruleId;
        const captchaAllowed = Boolean(captcha.enabled && siteId && captcha.sites && captcha.sites[siteId]);
        $('captchaBtn').disabled = !captchaAllowed;
        $('captchaBtn').title = captchaAllowed
            ? '使用已配置的本地 provider 定位验证码'
            : '验证码识别未开启或未对本站点启用, 请到设置中开启';
    }

    function renderResult(result) {
        const box = $('resultBox');
        box.textContent = '';
        if (!result) {
            return;
        }
        if (!result.ok) {
            const message = document.createElement('div');
            message.className = 'msg danger';
            message.textContent = result.error || '采集失败.';
            box.appendChild(message);
            return;
        }
        const rows = [
            ['站点', `${result.oj || ''} ${result.pid || ''}`.trim()],
            ['标题', result.name || result.title || ''],
            ['时限', result.timeLimit ? `${result.timeLimit} ms` : '未解析'],
            ['内存', result.memoryLimit ? `${result.memoryLimit} MB` : '未解析'],
            ['样例', `${result.sampleCount !== undefined ? result.sampleCount : (result.samples || []).length} 组`],
            ['规则', `${result.ruleId || ''} v${result.ruleVersion || '?'}`]
        ];
        for (const [key, value] of rows) {
            const row = document.createElement('div');
            row.className = 'row';
            const label = document.createElement('span');
            label.className = 'hint';
            label.style.minWidth = '48px';
            label.textContent = key;
            const text = document.createElement('span');
            text.textContent = value;
            row.appendChild(label);
            row.appendChild(text);
            box.appendChild(row);
        }
        const samples = result.samples || [];
        if (samples.length) {
            const sample = samples[0] || {};
            const preview = document.createElement('pre');
            preview.className = 'preview';
            preview.textContent = `样例 1 输入:\n${String(sample.in || '').slice(0, 300)}\n样例 1 输出:\n${String(sample.out || '').slice(0, 300)}`;
            box.appendChild(preview);
        }
        const markdown = String(result.markdown || '').trim();
        if (markdown) {
            const preview = document.createElement('pre');
            preview.className = 'preview';
            preview.textContent = markdown.length > 1200 ? `${markdown.slice(0, 1200)}\n...` : markdown;
            box.appendChild(preview);
        } else {
            const empty = document.createElement('div');
            empty.className = 'empty';
            empty.textContent = '未解析到题面, 可在设置中查看是否需要用「手动分析」指定选择器.';
            box.appendChild(empty);
        }
    }

    async function copyText(text) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (error) {
            const area = document.createElement('textarea');
            area.value = text;
            area.style.position = 'fixed';
            area.style.opacity = '0';
            document.body.appendChild(area);
            area.select();
            const ok = document.execCommand('copy');
            area.remove();
            return ok;
        }
    }

    function bindEvents() {
        $('optionsBtn').addEventListener('click', () => {
            chrome.runtime.openOptionsPage();
        });

        $('cookieBtn').addEventListener('click', async () => {
            clearMsg();
            if (!current.tab || !current.tab.url) {
                showMsg('未找到当前标签页.', true);
                return;
            }
            const response = await send({ type: 'getCookies', url: current.tab.url });
            if (!response.ok) {
                showMsg(response.error || '读取 Cookie 失败.', true);
                return;
            }
            current.cookiePlain = response.cookie || '';
            const box = $('cookieBox');
            box.textContent = response.masked || '(空)';
            box.classList.remove('hidden');
            $('copyCookieBtn').disabled = !current.cookiePlain;
            $('cookieMeta').textContent = `${response.count} 项 · 含 HttpOnly ${response.httpOnlyCount} 项`;
            showMsg('已读取 Cookie, 界面仅显示掩码.', false);
        });

        $('copyCookieBtn').addEventListener('click', async () => {
            if (!current.cookiePlain) {
                showMsg('没有可复制的 Cookie.', true);
                return;
            }
            const ok = await copyText(current.cookiePlain);
            showMsg(ok ? '已复制明文 Cookie, 请妥善保管.' : '复制失败, 请检查剪贴板权限.', !ok);
        });

        $('fetchBtn').addEventListener('click', async () => {
            clearMsg();
            if (!current.tab || !current.state) {
                showMsg('当前页面未命中站点规则.', true);
                return;
            }
            const button = $('fetchBtn');
            button.disabled = true;
            button.textContent = '抓取中...';
            const response = await send({ type: 'fetchProblem', url: current.tab.url });
            button.disabled = false;
            button.textContent = '后台抓取';
            renderResult(response);
            if (response.ok) {
                showMsg('后台抓取完成, 已携带站点 Cookie.', false);
            } else {
                showMsg(response.error || '后台抓取失败.', true);
            }
        });

        $('collectBtn').addEventListener('click', async () => {
            clearMsg();
            if (!current.tab || !current.state) {
                showMsg('当前页面未命中站点规则.', true);
                return;
            }
            const button = $('collectBtn');
            button.disabled = true;
            button.textContent = '解析中...';
            const response = await send({ type: 'collectCurrentPage', tabId: current.tab.id });
            button.disabled = false;
            button.textContent = '整页解析';
            renderResult(response);
            if (response.ok) {
                showMsg('整页解析完成, 已交给同一解析层.', false);
            } else {
                showMsg(response.error || '整页解析失败.', true);
            }
        });

        $('manualBtn').addEventListener('click', () => {
            clearMsg();
            if (!current.tab || !current.state) {
                showMsg('当前页面未命中站点规则.', true);
                return;
            }
            const purpose = $('manualPurpose').value;
            chrome.tabs.sendMessage(current.tab.id, { type: 'startManualPick', purpose }, (response) => {
                const error = chrome.runtime.lastError;
                if (error) {
                    showMsg('页面内容脚本未就绪, 请刷新后重试.', true);
                    return;
                }
                if (response && response.ok) {
                    showMsg(`已保存选择器: ${response.selector}`, false);
                } else {
                    showMsg((response && response.error) || '手动分析失败.', true);
                }
            });
        });

        $('captchaBtn').addEventListener('click', () => {
            clearMsg();
            if (!current.tab || !current.state) {
                showMsg('当前页面未命中站点规则.', true);
                return;
            }
            chrome.tabs.sendMessage(current.tab.id, { type: 'scanCaptcha' }, (response) => {
                const error = chrome.runtime.lastError;
                if (error) {
                    showMsg('页面内容脚本未就绪, 请刷新后重试.', true);
                    return;
                }
                if (response && response.ok) {
                    showMsg(response.message || '验证码已定位.', false);
                } else {
                    showMsg((response && response.error) || '验证码识别失败.', true);
                }
            });
        });

        $('disableProxyBtn').addEventListener('click', async () => {
            await OIHProxy.disable();
            if (current.settings) {
                current.settings.proxy.enabled = false;
                await OIHConfig.saveSettings(current.settings);
            }
            const response = await send({ type: 'getSettings' });
            current.settings = response.ok ? response.settings : current.settings;
            renderSecurity();
            showMsg('已停用代理, 采集恢复直连.', false);
        });
    }

    async function init() {
        bindEvents();
        const tabs = await new Promise((resolve) => {
            chrome.tabs.query({ active: true, currentWindow: true }, (items) => resolve(items || []));
        });
        current.tab = tabs[0] || null;
        if (current.tab) {
            const stateResponse = await send({ type: 'getTabState', tabId: current.tab.id });
            current.state = stateResponse.ok ? stateResponse.state : null;
        }
        renderSite(current.state);

        const settingsResponse = await send({ type: 'getSettings' });
        current.settings = settingsResponse.ok ? settingsResponse.settings : null;
        renderSecurity();

        const last = await send({ type: 'getLastResult' });
        if (last.ok && last.result) {
            renderResult(last.result);
        }
    }

    init();
})();
