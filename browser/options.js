(function () {
    const state = {
        settings: null,
        rules: [],
        vault: null,
        proxySecret: null,
        desktop: null,
        captchaTimer: null,
        captchaSeconds: 5
    };

    const PURPOSE_LABELS = {
        title: '标题',
        pid: '题号',
        statement: '题面',
        timeLimit: '时间限制',
        memoryLimit: '内存限制',
        sampleInput: '样例输入',
        sampleOutput: '样例输出',
        loginUser: '登录账号',
        loginPass: '登录密码'
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
        const box = $('globalMsg');
        box.textContent = text;
        box.className = `msg${danger ? ' danger' : ''}`;
        box.classList.remove('hidden');
    }

    function clearMsg() {
        $('globalMsg').classList.add('hidden');
    }

    function proxyDomains() {
        return Array.from(new Set(state.rules.flatMap((rule) => rule.domains || [])));
    }

    function renderRules() {
        const list = $('ruleList');
        list.textContent = '';
        if (!state.rules.length) {
            const empty = document.createElement('div');
            empty.className = 'empty';
            empty.textContent = '未加载到站点规则.';
            list.appendChild(empty);
            return;
        }
        for (const rule of state.rules) {
            const item = document.createElement('div');
            item.className = 'list-item';
            const left = document.createElement('span');
            left.textContent = `${rule.name} (${rule.id})`;
            const right = document.createElement('span');
            right.className = 'hint';
            right.textContent = `v${rule.version} · ${(rule.domains || []).join(', ')}`;
            item.appendChild(left);
            item.appendChild(right);
            list.appendChild(item);
        }
    }

    function fillProxyForm() {
        const proxy = state.settings.proxy;
        $('proxyAddress').value = proxy.host ? `${proxy.host}:${proxy.port}` : '';
        const secretUser = state.proxySecret ? state.proxySecret.username : '';
        $('proxyUser').value = proxy.username || secretUser || '';
        $('proxyPass').value = '';
        $('proxyPass').placeholder = state.proxySecret ? '已加密保存, 留空则沿用' : '代理密码 (可选)';
        $('proxyBadge').textContent = proxy.enabled ? '已启用' : '未启用';
        $('proxyBadge').className = `badge ${proxy.enabled ? 'ok' : 'off'}`;
        $('enableProxyBtn').disabled = proxy.enabled;
        $('disableProxyBtn').disabled = !proxy.enabled;
    }

    function renderAutofill() {
        const enabled = state.settings.autofill.enabled;
        const status = state.vault || { saved: false, username: '' };
        $('autofillBadge').textContent = enabled ? '已开启' : '关闭';
        $('autofillBadge').className = `badge ${enabled ? 'ok' : 'off'}`;
        $('vaultStatus').textContent = status.saved
            ? `本地已保存账号: ${status.username} (密码为 AES-GCM 密文)`
            : '尚未保存账号密码.';
        $('vaultUser').value = status.saved ? status.username : '';
        $('toggleAutofillBtn').textContent = enabled ? '关闭自动填充' : '开启自动填充';
    }

    function renderDesktop() {
        const desktop = state.desktop || OIHDesktop.normalizeDesktop(null);
        $('desktopApi').value = desktop.apiBase;
        $('desktopProblemDir').value = desktop.problemDir;
        $('desktopToken').value = '';
        $('desktopToken').placeholder = desktop.token ? '已保存令牌, 留空则沿用' : '粘贴桌面程序令牌';
        $('desktopBadge').textContent = desktop.token ? '已保存' : '未配置';
        $('desktopBadge').className = `badge ${desktop.token ? 'ok' : 'off'}`;
        $('desktopStatus').textContent = desktop.token
            ? `令牌已保存; API: ${desktop.apiBase}`
            : `令牌未保存; API: ${desktop.apiBase}`;
    }

    function renderProviderSelect() {
        const select = $('captchaProvider');
        const captcha = state.settings.captcha;
        const configured = captcha.provider || '';
        select.textContent = '';
        const blank = document.createElement('option');
        blank.value = '';
        blank.textContent = '不配置';
        select.appendChild(blank);
        const known = new Set();
        // 未开启验证码时不枚举 provider, 避免进入任何识别相关代码路径
        if (captcha.enabled) {
            for (const provider of OIHCaptcha.listProviders()) {
                known.add(provider.id);
                const option = document.createElement('option');
                option.value = provider.id;
                option.textContent = `${provider.name} (${provider.local ? '本地, 不联网' : '自定义'})`;
                select.appendChild(option);
            }
        } else {
            known.add('local-hint');
            const option = document.createElement('option');
            option.value = 'local-hint';
            option.textContent = '本地定位提示 (local-hint)';
            select.appendChild(option);
        }
        if (configured && !known.has(configured)) {
            const option = document.createElement('option');
            option.value = configured;
            option.textContent = `${configured} (未注册)`;
            select.appendChild(option);
        }
        select.value = configured;
    }

    function selectedCaptchaSites() {
        return Object.keys(state.settings.captcha.sites || {})
            .filter((key) => state.settings.captcha.sites[key]);
    }

    function captchaScopeText() {
        const ids = selectedCaptchaSites();
        if (!ids.length) {
            return '未勾选';
        }
        const names = ids.map((id) => {
            const rule = state.rules.find((item) => item.id === id);
            return rule ? rule.name : id;
        });
        return names.join(', ');
    }

    function renderCaptchaSites() {
        const box = $('captchaSites');
        box.textContent = '';
        for (const rule of state.rules) {
            const label = document.createElement('label');
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = Boolean(state.settings.captcha.sites && state.settings.captcha.sites[rule.id]);
            checkbox.addEventListener('change', async () => {
                state.settings.captcha.sites[rule.id] = checkbox.checked;
                state.settings = await OIHConfig.saveSettings(state.settings);
                $('captchaScopeText').textContent = captchaScopeText();
                updateCaptchaConfirmState();
            });
            const text = document.createElement('span');
            text.textContent = `${rule.name} (${rule.id})`;
            label.appendChild(checkbox);
            label.appendChild(text);
            box.appendChild(label);
        }
    }

    function renderCaptcha() {
        const captcha = state.settings.captcha;
        $('captchaBadge').textContent = captcha.enabled ? '已开启' : '关闭';
        $('captchaBadge').className = `badge ${captcha.enabled ? 'ok' : 'off'}`;
        $('toggleCaptchaBtn').textContent = captcha.enabled ? '关闭验证码识别' : '开启验证码识别';
        renderProviderSelect();
        renderCaptchaSites();
        $('captchaScopeText').textContent = captchaScopeText();
    }

    function updateCaptchaConfirmState() {
        const button = $('captchaConfirmBtn');
        if (state.captchaSeconds > 0) {
            button.disabled = true;
            button.textContent = `请阅读 ${state.captchaSeconds} 秒 (${state.captchaSeconds})`;
            return;
        }
        const hasSite = selectedCaptchaSites().length > 0;
        button.disabled = !hasSite;
        button.textContent = hasSite ? '我已知晓并承担风险, 开启' : '请至少勾选一个站点';
    }

    function startCaptchaCountdown() {
        clearInterval(state.captchaTimer);
        state.captchaSeconds = 5;
        updateCaptchaConfirmState();
        state.captchaTimer = setInterval(() => {
            state.captchaSeconds -= 1;
            if (state.captchaSeconds <= 0) {
                state.captchaSeconds = 0;
                clearInterval(state.captchaTimer);
                state.captchaTimer = null;
            }
            updateCaptchaConfirmState();
        }, 1000);
    }

    function openCaptchaWarning() {
        $('captchaScopeText').textContent = captchaScopeText();
        $('captchaModal').classList.remove('hidden');
        startCaptchaCountdown();
    }

    function closeCaptchaWarning() {
        clearInterval(state.captchaTimer);
        state.captchaTimer = null;
        $('captchaModal').classList.add('hidden');
    }

    function openAutofillConfirm() {
        $('autofillModal').classList.remove('hidden');
    }

    function closeAutofillConfirm() {
        $('autofillModal').classList.add('hidden');
    }

    async function renderSelectors() {
        const box = $('selectorList');
        box.textContent = '';
        let total = 0;
        for (const rule of state.rules) {
            const response = await send({ type: 'getManualSelectors', site: rule.id });
            const selectors = (response.ok && response.selectors) || {};
            for (const [purpose, selector] of Object.entries(selectors)) {
                total += 1;
                const item = document.createElement('div');
                item.className = 'list-item';
                const left = document.createElement('div');
                const title = document.createElement('div');
                title.textContent = `${rule.name} · ${PURPOSE_LABELS[purpose] || purpose}`;
                const code = document.createElement('div');
                code.className = 'hint';
                code.textContent = selector;
                left.appendChild(title);
                left.appendChild(code);
                const button = document.createElement('button');
                button.className = 'btn small danger';
                button.textContent = '清除';
                button.addEventListener('click', async () => {
                    const removed = await send({ type: 'removeManualSelector', site: rule.id, purpose });
                    if (!removed.ok) {
                        showMsg(removed.error || '清除选择器失败.', true);
                        return;
                    }
                    showMsg(`已清除 ${rule.name} 的 ${PURPOSE_LABELS[purpose] || purpose} 选择器.`, false);
                    await renderSelectors();
                });
                item.appendChild(left);
                item.appendChild(button);
                box.appendChild(item);
            }
        }
        if (!total) {
            const empty = document.createElement('div');
            empty.className = 'empty';
            empty.textContent = '尚未保存手动选择器.';
            box.appendChild(empty);
        }
    }

    async function saveProxySettings(enabled) {
        const normalized = OIHProxy.normalize({
            address: $('proxyAddress').value,
            username: $('proxyUser').value,
            password: $('proxyPass').value
        });
        state.settings.proxy = {
            host: normalized.host,
            port: normalized.port,
            username: normalized.username || (state.proxySecret ? state.proxySecret.username : ''),
            password: '',
            enabled: Boolean(enabled)
        };
        state.settings = await OIHConfig.saveSettings(state.settings);
        fillProxyForm();
    }

    function bindEvents() {
        $('saveProxyBtn').addEventListener('click', async () => {
            clearMsg();
            const address = $('proxyAddress').value.trim();
            const user = $('proxyUser').value.trim();
            const pass = $('proxyPass').value;
            try {
                if (address) {
                    OIHProxy.validate(OIHProxy.normalize({ address }));
                } else if (state.settings.proxy.enabled) {
                    throw new Error('代理已启用, 请填写地址或先停用代理.');
                }
                if (pass && !user) {
                    throw new Error('填写代理密码时请同时填写代理账号.');
                }
                if (pass) {
                    state.proxySecret = await OIHVault.saveProxySecret(user, pass);
                    $('proxyPass').value = '';
                }
                await saveProxySettings(state.settings.proxy.enabled);
                showMsg('代理配置已保存.', false);
            } catch (error) {
                showMsg(OIHConfig.readableError(error), true);
            }
        });

        $('enableProxyBtn').addEventListener('click', async () => {
            clearMsg();
            const normalized = OIHProxy.normalize({
                address: $('proxyAddress').value,
                username: $('proxyUser').value,
                password: $('proxyPass').value
            });
            try {
                OIHProxy.validate(normalized);
                if (!proxyDomains().length) {
                    throw new Error('未加载到站点规则, 无法生成 PAC.');
                }
                const username = normalized.username || (state.proxySecret ? state.proxySecret.username : '');
                const password = normalized.password || (state.proxySecret ? state.proxySecret.password : '');
                if ((username && !password) || (!username && password)) {
                    throw new Error('代理账号和密码需同时配置.');
                }
                const spec = {
                    host: normalized.host,
                    port: normalized.port,
                    username,
                    password
                };
                await OIHProxy.enable(spec, proxyDomains());
                if (normalized.password) {
                    state.proxySecret = await OIHVault.saveProxySecret(username, normalized.password);
                    $('proxyPass').value = '';
                }
                await saveProxySettings(true);
                showMsg('代理已启用: PAC 仅对规则命中的 OJ 域名分流, 其他直连.', false);
            } catch (error) {
                showMsg(OIHConfig.readableError(error), true);
            }
        });

        $('disableProxyBtn').addEventListener('click', async () => {
            clearMsg();
            await OIHProxy.disable();
            await saveProxySettings(false);
            showMsg('代理已停用, 恢复直连.', false);
        });

        $('saveDesktopBtn').addEventListener('click', async () => {
            clearMsg();
            try {
                const apiBase = OIHDesktop.validateApiBase($('desktopApi').value);
                const tokenInput = $('desktopToken').value.trim();
                const desktop = {
                    apiBase,
                    token: tokenInput || (state.desktop ? state.desktop.token : ''),
                    problemDir: $('desktopProblemDir').value.trim()
                };
                state.desktop = await OIHDesktop.saveDesktop(chrome.storage.local, desktop);
                renderDesktop();
                showMsg(state.desktop.token ? '桌面程序配置已保存.' : '桌面程序配置已保存, 尚未填写令牌.', false);
            } catch (error) {
                showMsg(OIHConfig.readableError(error), true);
            }
        });

        $('testDesktopBtn').addEventListener('click', async () => {
            clearMsg();
            let apiBase;
            try {
                apiBase = OIHDesktop.validateApiBase($('desktopApi').value);
            } catch (error) {
                showMsg(OIHConfig.readableError(error), true);
                return;
            }
            const button = $('testDesktopBtn');
            button.disabled = true;
            button.textContent = '测试中...';
            const response = await send({ type: 'panel:testDesktop', apiBase });
            button.disabled = false;
            button.textContent = '测试连接';
            if (!response.ok) {
                $('desktopStatus').textContent = response.error || '连接失败.';
                showMsg(response.error || '桌面程序连接失败.', true);
                return;
            }
            const health = response.health || {};
            $('desktopStatus').textContent = `连接成功: ${health.name || '桌面程序'} ${health.version || ''} (${health.status || 'ok'})`;
            showMsg('桌面程序连接正常.', false);
        });

        $('saveVaultBtn').addEventListener('click', async () => {
            clearMsg();
            try {
                await OIHVault.saveCredentials($('vaultUser').value, $('vaultPass').value);
                $('vaultPass').value = '';
                state.vault = await OIHVault.getStatus();
                renderAutofill();
                showMsg('账号密码已加密保存到本地.', false);
            } catch (error) {
                showMsg(OIHConfig.readableError(error), true);
            }
        });

        $('clearVaultBtn').addEventListener('click', async () => {
            clearMsg();
            await OIHVault.clearCredentials();
            state.vault = await OIHVault.getStatus();
            if (state.settings.autofill.enabled) {
                state.settings.autofill.enabled = false;
                state.settings = await OIHConfig.saveSettings(state.settings);
            }
            renderAutofill();
            showMsg('本地凭据已清除, 自动填充同时关闭.', false);
        });

        $('toggleAutofillBtn').addEventListener('click', async () => {
            clearMsg();
            if (state.settings.autofill.enabled) {
                state.settings.autofill.enabled = false;
                state.settings = await OIHConfig.saveSettings(state.settings);
                renderAutofill();
                showMsg('自动填充已关闭.', false);
                return;
            }
            const status = await OIHVault.getStatus();
            if (!status.saved) {
                showMsg('请先保存账号密码, 再开启自动填充.', true);
                return;
            }
            openAutofillConfirm();
        });

        $('autofillCancelBtn').addEventListener('click', closeAutofillConfirm);
        $('autofillConfirmBtn').addEventListener('click', async () => {
            closeAutofillConfirm();
            state.settings.autofill.enabled = true;
            state.settings = await OIHConfig.saveSettings(state.settings);
            renderAutofill();
            showMsg('自动填充已开启, 仅在规则命中的登录页生效.', false);
        });

        $('captchaProvider').addEventListener('change', async () => {
            state.settings.captcha.provider = $('captchaProvider').value;
            state.settings = await OIHConfig.saveSettings(state.settings);
            renderCaptcha();
            showMsg('验证码 provider 已更新.', false);
        });

        $('toggleCaptchaBtn').addEventListener('click', async () => {
            clearMsg();
            if (state.settings.captcha.enabled) {
                state.settings.captcha.enabled = false;
                state.settings = await OIHConfig.saveSettings(state.settings);
                renderCaptcha();
                showMsg('验证码识别已关闭, 不会读取验证码图片.', false);
                return;
            }
            if (!selectedCaptchaSites().length) {
                showMsg('请先在上方勾选至少一个生效站点, 再开启验证码识别.', true);
                return;
            }
            openCaptchaWarning();
        });

        $('captchaCancelBtn').addEventListener('click', () => {
            closeCaptchaWarning();
            showMsg('已取消开启验证码识别.', false);
        });

        $('captchaConfirmBtn').addEventListener('click', async () => {
            if (state.captchaSeconds > 0) {
                return;
            }
            if (!selectedCaptchaSites().length) {
                showMsg('请至少勾选一个生效站点.', true);
                return;
            }
            state.settings.captcha.enabled = true;
            state.settings.captcha.provider = $('captchaProvider').value;
            state.settings = await OIHConfig.saveSettings(state.settings);
            closeCaptchaWarning();
            renderCaptcha();
            showMsg('验证码识别已开启; 风险由你自行承担.', false);
        });
    }

    async function init() {
        bindEvents();
        $('versionBadge').textContent = `v${chrome.runtime.getManifest().version}`;
        state.settings = await OIHConfig.loadSettings();
        const rulesResponse = await send({ type: 'getRuleInfo' });
        state.rules = rulesResponse.ok ? rulesResponse.rules : [];
        state.vault = await OIHVault.getStatus();
        state.proxySecret = await OIHVault.loadProxySecret().catch(() => null);
        state.desktop = await OIHDesktop.loadDesktop(chrome.storage.local);
        renderRules();
        fillProxyForm();
        renderAutofill();
        renderDesktop();
        renderCaptcha();
        await renderSelectors();
    }

    init();
})();
