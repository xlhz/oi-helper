(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
        return;
    }
    root.OIHProxy = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    let active = null;
    let authListener = null;

    function splitAddress(value) {
        const text = String(value || '').trim();
        if (!text) {
            return { host: '', port: '' };
        }
        const parts = text.split(':');
        if (parts.length === 2) {
            return { host: parts[0].trim(), port: parts[1].trim() };
        }
        return { host: text, port: '' };
    }

    function normalize(input) {
        const value = input && typeof input === 'object' ? input : {};
        const fromAddress = splitAddress(value.address || '');
        const host = String(value.host || fromAddress.host || '').trim();
        const port = String(value.port || fromAddress.port || '').trim();
        return {
            host,
            port,
            username: String(value.username || ''),
            password: String(value.password || ''),
            enabled: Boolean(value.enabled)
        };
    }

    function validate(spec) {
        if (!spec.host || !/^[A-Za-z0-9.-]+$/.test(spec.host)) {
            throw new Error('代理地址无效: 请填写 host:port, host 只支持域名或 IPv4.');
        }
        const port = Number(spec.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw new Error('代理端口无效: 请填写 1-65535 之间的整数.');
        }
        return spec;
    }

    // PAC 只对规则命中的 OJ 域名走代理, 其余全部直连
    function buildPac(spec, domains) {
        const proxy = `PROXY ${spec.host}:${spec.port}; DIRECT`;
        const list = (domains || []).map((domain) => JSON.stringify(String(domain)));
        return [
            'function FindProxyForURL(url, host) {',
            `    var domains = [${list.join(', ')}];`,
            '    for (var i = 0; i < domains.length; i += 1) {',
            '        var d = domains[i];',
            '        if (host === d || host.slice(-(d.length + 1)) === "." + d) {',
            `            return ${JSON.stringify(proxy)};`,
            '        }',
            '    }',
            '    return "DIRECT";',
            '}'
        ].join('\n');
    }

    function removeAuthListener() {
        if (authListener && chrome.webRequest && chrome.webRequest.onAuthRequired) {
            chrome.webRequest.onAuthRequired.removeListener(authListener);
        }
        authListener = null;
    }

    function ensureAuthListener(spec) {
        removeAuthListener();
        if (!chrome.webRequest || !chrome.webRequest.onAuthRequired) {
            return;
        }
        authListener = (details, callback) => {
            if (!active || !details.isProxy) {
                callback({});
                return;
            }
            callback({
                authCredentials: {
                    username: spec.username,
                    password: spec.password
                }
            });
        };
        try {
            chrome.webRequest.onAuthRequired.addListener(
                authListener,
                { urls: ['https://*/*', 'http://*/*'] },
                ['asyncBlocking']
            );
        } catch (error) {
            authListener = null;
        }
    }

    async function apply(spec, domains) {
        const config = validate(normalize(spec));
        if (!chrome.proxy || !chrome.proxy.settings) {
            throw new Error('当前浏览器不支持 chrome.proxy, 无法启用代理.');
        }
        const pacScript = buildPac(config, domains);
        await new Promise((resolve, reject) => {
            chrome.proxy.settings.set({
                value: {
                    mode: 'pac_script',
                    pacScript: { data: pacScript, mandatory: false }
                },
                scope: 'regular'
            }, () => {
                const error = chrome.runtime.lastError;
                if (error) {
                    reject(new Error(`设置代理失败: ${error.message}`));
                    return;
                }
                resolve();
            });
        });
        const detail = await new Promise((resolve) => {
            chrome.proxy.settings.get({}, (value) => resolve(value || {}));
        });
        if (detail.levelOfControl && detail.levelOfControl !== 'controlled_by_this_extension') {
            throw new Error(`代理设置无法生效: ${detail.levelOfControl}. 请检查其他代理扩展或系统策略.`);
        }
        active = config;
        if (config.username || config.password) {
            ensureAuthListener(config);
        } else {
            removeAuthListener();
        }
        return active;
    }

    // 启用前由用户手势触发可选权限申请; 不申请与代理无关的权限
    async function enable(input, domains) {
        const config = validate(normalize(input));
        const permissions = ['proxy'];
        if (config.username || config.password) {
            permissions.push('webRequest', 'webRequestAuthProvider');
        }
        const granted = await chrome.permissions.request({ permissions });
        if (!granted) {
            throw new Error('未授予代理权限, 已取消启用.');
        }
        return apply(config, domains);
    }

    async function disable() {
        removeAuthListener();
        active = null;
        if (chrome.proxy && chrome.proxy.settings) {
            await new Promise((resolve) => {
                chrome.proxy.settings.clear({ scope: 'regular' }, () => {
                    resolve();
                });
            });
        }
        try {
            // 停用后立即归还可选权限, 保持最小权限
            await chrome.permissions.remove({
                permissions: ['proxy', 'webRequest', 'webRequestAuthProvider']
            });
        } catch (error) {
            // 权限可能未授予, 忽略
        }
    }

    async function restore(settings, domains) {
        const proxy = normalize((settings && settings.proxy) || {});
        if (!chrome.proxy || !chrome.proxy.settings) {
            return null;
        }
        const granted = await chrome.permissions.contains({ permissions: ['proxy'] });
        if (!granted) {
            return null;
        }
        if (!proxy.enabled) {
            await disable();
            return null;
        }
        if (!proxy.host || !proxy.port) {
            return null;
        }
        try {
            return await apply(proxy, domains);
        } catch (error) {
            return null;
        }
    }

    function current() {
        return active ? Object.assign({}, active) : null;
    }

    return {
        normalize,
        validate,
        buildPac,
        enable,
        apply,
        disable,
        restore,
        current
    };
});
