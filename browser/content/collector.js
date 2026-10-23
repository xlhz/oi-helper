(function () {
    const state = {
        url: location.href,
        rule: null,
        ruleId: '',
        pageType: '',
        picking: false
    };

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

    function firstMatch(selectors) {
        for (const selector of selectors || []) {
            if (!selector) {
                continue;
            }
            try {
                const node = document.querySelector(selector);
                if (node) {
                    return node;
                }
            } catch (error) {
                // 页面改版后的非法选择器直接跳过
            }
        }
        return null;
    }

    function setInputValue(element, value) {
        const proto = element instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
        if (descriptor && descriptor.set) {
            descriptor.set.call(element, value);
        } else {
            element.value = value;
        }
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
    }

    async function maybeAutofill() {
        const settings = await send({ type: 'getSettings' });
        if (!settings.ok || !settings.settings || !settings.settings.autofill.enabled) {
            return;
        }
        const credentials = await send({ type: 'getAutofill' });
        if (!credentials.ok) {
            return;
        }
        const manual = await send({ type: 'getManualSelectors', site: state.rule.id });
        const stored = (manual.ok && manual.selectors) || {};
        const selectors = state.rule.selectors || {};
        const userElement = firstMatch([stored.loginUser, ...(selectors.loginUser || [])]);
        const passElement = firstMatch([stored.loginPass, ...(selectors.loginPass || [])]);
        if (!userElement || !passElement) {
            return;
        }
        setInputValue(userElement, credentials.username || '');
        setInputValue(passElement, credentials.password || '');
    }

    function findCaptchaImage() {
        const manual = [];
        const selectors = (state.rule && state.rule.selectors) || {};
        const image = firstMatch(manual.concat(selectors.captchaImage || []));
        if (!image) {
            return { image: null, selector: '' };
        }
        return { image, selector: OIHSelectors.cssPath(image) };
    }

    async function scanCaptcha() {
        if (!state.rule) {
            return { ok: false, error: '当前页面未命中站点规则.' };
        }
        const settingsResponse = await send({ type: 'getSettings' });
        if (!settingsResponse.ok || !settingsResponse.settings) {
            return { ok: false, error: '读取设置失败.' };
        }
        const captcha = settingsResponse.settings.captcha || {};
        // 未开启时直接返回: 不查询验证码图片, 不调用 provider
        if (!captcha.enabled) {
            return { ok: false, error: '验证码识别未开启, 已跳过.' };
        }
        if (!captcha.sites || !captcha.sites[state.rule.id]) {
            return { ok: false, error: `未对 ${state.rule.name} 启用验证码识别.` };
        }
        const providerId = String(captcha.provider || '').trim();
        if (!providerId) {
            return { ok: false, error: '未配置验证码识别 provider, 请先在设置中选择.' };
        }
        const provider = OIHCaptcha.getProvider(providerId);
        if (!provider) {
            return { ok: false, error: `未找到 provider: ${providerId}` };
        }
        const located = findCaptchaImage();
        if (!located.image) {
            return { ok: false, error: '当前页面未找到验证码图片.' };
        }
        const result = await OIHCaptcha.recognize(providerId, {
            site: state.rule.id,
            image: located.image,
            selector: located.selector
        });
        return result;
    }

    function showToast(text, danger) {
        const toast = document.createElement('div');
        toast.textContent = text;
        toast.style.cssText = [
            'position:fixed', 'left:50%', 'bottom:24px', 'transform:translateX(-50%)',
            'z-index:2147483647', 'max-width:80vw', 'padding:8px 14px', 'border-radius:8px',
            'font:13px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif',
            'color:#fff', `background:${danger ? '#f54a45' : '#1f2329'}`,
            'box-shadow:0 6px 20px rgba(0,0,0,.18)', 'pointer-events:none', 'white-space:nowrap',
            'overflow:hidden', 'text-overflow:ellipsis'
        ].join(';');
        document.documentElement.appendChild(toast);
        setTimeout(() => toast.remove(), 2600);
    }

    // 手动分析: 点选元素后按站点 + 用途持久化选择器
    function startManualPick(purpose) {
        return new Promise((resolve) => {
            if (state.picking) {
                resolve({ ok: false, error: '已在点选状态, 请先按 Esc 退出.' });
                return;
            }
            if (!state.rule) {
                resolve({ ok: false, error: '当前页面未命中站点规则.' });
                return;
            }
            if (!OIHSelectors.PURPOSES.includes(purpose)) {
                resolve({ ok: false, error: `未知用途: ${purpose}` });
                return;
            }
            state.picking = true;
            const box = document.createElement('div');
            for (const [key, value] of Object.entries({
                position: 'fixed', 'z-index': '2147483646', 'pointer-events': 'none',
                border: '2px solid #3370ff', background: 'rgba(51,112,255,.12)',
                'border-radius': '4px', display: 'none', 'box-sizing': 'border-box'
            })) {
                box.style.setProperty(key, value);
            }
            const tip = document.createElement('div');
            for (const [key, value] of Object.entries({
                position: 'fixed', 'z-index': '2147483647', 'pointer-events': 'none',
                background: '#1f2329', color: '#fff', padding: '4px 8px', 'border-radius': '6px',
                font: '12px/1.4 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif',
                'max-width': '70vw', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap',
                display: 'none'
            })) {
                tip.style.setProperty(key, value);
            }
            document.documentElement.appendChild(box);
            document.documentElement.appendChild(tip);

            let current = null;
            const describe = (element) => {
                let text = element.tagName.toLowerCase();
                if (element.id) {
                    text += `#${element.id}`;
                }
                const classes = Array.from(element.classList || []).slice(0, 2);
                if (classes.length) {
                    text += `.${classes.join('.')}`;
                }
                return text;
            };
            const onMove = (event) => {
                const target = event.target;
                if (!target || target.nodeType !== 1) {
                    return;
                }
                current = target;
                const rect = target.getBoundingClientRect();
                box.style.display = 'block';
                box.style.left = `${rect.left}px`;
                box.style.top = `${rect.top}px`;
                box.style.width = `${rect.width}px`;
                box.style.height = `${rect.height}px`;
                tip.style.display = 'block';
                tip.style.left = `${Math.min(rect.left, window.innerWidth - 220)}px`;
                tip.style.top = `${Math.max(rect.top - 26, 4)}px`;
                tip.textContent = `${describe(target)}  点击选中, Esc 取消`;
            };
            const cleanup = () => {
                state.picking = false;
                document.removeEventListener('mousemove', onMove, true);
                document.removeEventListener('click', onClick, true);
                document.removeEventListener('keydown', onKey, true);
                box.remove();
                tip.remove();
            };
            const onKey = (event) => {
                if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    cleanup();
                    showToast('已取消手动分析', true);
                    resolve({ ok: false, error: '已取消.' });
                }
            };
            const onClick = async (event) => {
                event.preventDefault();
                event.stopPropagation();
                const target = current || event.target;
                cleanup();
                if (!target || target.nodeType !== 1) {
                    resolve({ ok: false, error: '未选中有效元素.' });
                    return;
                }
                const selector = OIHSelectors.cssPath(target);
                const saved = await send({
                    type: 'saveManualSelector',
                    site: state.rule.id,
                    purpose,
                    selector
                });
                if (!saved.ok) {
                    showToast(saved.error || '保存选择器失败', true);
                    resolve(saved);
                    return;
                }
                showToast(`已保存 ${purpose} 选择器: ${selector}`, false);
                resolve({ ok: true, selector });
            };

            document.addEventListener('mousemove', onMove, true);
            document.addEventListener('click', onClick, true);
            document.addEventListener('keydown', onKey, true);
            showToast(`请点选 ${purpose} 对应元素, Esc 取消`, false);
        });
    }

    async function init() {
        try {
            const rulesResponse = await send({ type: 'getRulesForUrl', url: location.href });
            if (!rulesResponse.ok || !rulesResponse.rules || !rulesResponse.rules.length) {
                return;
            }
            const domFeatures = {};
            for (const rule of rulesResponse.rules) {
                domFeatures[rule.id] = OIHRules.probeFeatures(rule, document);
            }
            const matched = await send({
                type: 'identify',
                url: location.href,
                domFeatures,
                title: document.title
            });
            if (!matched.ok || !matched.rule) {
                return;
            }
            state.rule = matched.rule;
            state.ruleId = matched.ruleId;
            state.pageType = matched.pageType;
            await send({
                type: 'pageState',
                state: {
                    url: location.href,
                    host: location.hostname,
                    ruleId: matched.ruleId,
                    ruleName: matched.ruleName,
                    ruleVersion: matched.ruleVersion,
                    pageType: matched.pageType,
                    matchedFeatures: matched.matchedFeatures,
                    title: document.title
                }
            });
            if (state.pageType === 'login') {
                await maybeAutofill();
            }
        } catch (error) {
            // 未命中规则或后台重启都不影响页面本身
        }
    }

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === 'collectOuterHtml') {
            sendResponse({
                ok: true,
                url: location.href,
                html: document.documentElement.outerHTML
            });
            return false;
        }
        if (message.type === 'startManualPick') {
            startManualPick(message.purpose).then(sendResponse).catch((error) => {
                sendResponse({ ok: false, error: (error && error.message) || '手动分析失败.' });
            });
            return true;
        }
        if (message.type === 'scanCaptcha') {
            scanCaptcha().then(sendResponse).catch((error) => {
                sendResponse({ ok: false, error: (error && error.message) || '验证码识别失败.' });
            });
            return true;
        }
        return false;
    });

    init();
})();
