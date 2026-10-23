(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
        return;
    }
    root.OIHVault = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    const KEY_STORE = 'oih.vault.key';
    const DATA_STORE = 'oih.vault.data';
    const PROXY_STORE = 'oih.vault.proxy';
    const ALG = 'AES-GCM';

    function bytesToBase64(bytes) {
        let binary = '';
        bytes.forEach((value) => {
            binary += String.fromCharCode(value);
        });
        return btoa(binary);
    }

    function base64ToBytes(text) {
        const binary = atob(String(text || ''));
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    }

    async function getKey(create) {
        const data = await chrome.storage.local.get(KEY_STORE);
        if (data[KEY_STORE]) {
            return crypto.subtle.importKey('raw', base64ToBytes(data[KEY_STORE]), ALG, false, ['encrypt', 'decrypt']);
        }
        if (!create) {
            return null;
        }
        const key = await crypto.subtle.generateKey({ name: ALG, length: 256 }, true, ['encrypt', 'decrypt']);
        const raw = await crypto.subtle.exportKey('raw', key);
        await chrome.storage.local.set({ [KEY_STORE]: bytesToBase64(new Uint8Array(raw)) });
        return key;
    }

    async function writeRecord(storeKey, username, password) {
        const user = String(username || '').trim();
        const pass = String(password || '');
        if (!user || !pass) {
            throw new Error('账号和密码都不能为空.');
        }
        const key = await getKey(true);
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const cipher = await crypto.subtle.encrypt(
            { name: ALG, iv },
            key,
            new TextEncoder().encode(pass)
        );
        const record = {
            username: user,
            iv: bytesToBase64(iv),
            cipher: bytesToBase64(new Uint8Array(cipher)),
            alg: ALG,
            updatedAt: Date.now()
        };
        await chrome.storage.local.set({ [storeKey]: record });
        return { username: user, updatedAt: record.updatedAt };
    }

    async function readRecord(storeKey) {
        const data = await chrome.storage.local.get(storeKey);
        const record = data[storeKey];
        if (!record || !record.cipher) {
            return null;
        }
        const key = await getKey(false);
        if (!key) {
            throw new Error('本地密钥缺失, 请重新保存账号密码.');
        }
        try {
            const plain = await crypto.subtle.decrypt(
                { name: ALG, iv: base64ToBytes(record.iv) },
                key,
                base64ToBytes(record.cipher)
            );
            return {
                username: record.username || '',
                password: new TextDecoder().decode(plain)
            };
        } catch (error) {
            throw new Error('本地密码解密失败, 请重新保存账号密码.');
        }
    }

    // 仅作本地混淆级保护: 密钥与密文同存 chrome.storage.local, 不等同系统级密钥管理
    async function saveCredentials(username, password) {
        return writeRecord(DATA_STORE, username, password);
    }

    async function getStatus() {
        const data = await chrome.storage.local.get(DATA_STORE);
        const record = data[DATA_STORE];
        if (!record) {
            return { saved: false, username: '' };
        }
        return { saved: true, username: record.username || '', updatedAt: record.updatedAt || 0 };
    }

    async function loadCredentials() {
        return readRecord(DATA_STORE);
    }

    async function clearCredentials() {
        await chrome.storage.local.remove([DATA_STORE]);
    }

    async function saveProxySecret(username, password) {
        return writeRecord(PROXY_STORE, username, password);
    }

    async function loadProxySecret() {
        return readRecord(PROXY_STORE);
    }

    async function clearProxySecret() {
        await chrome.storage.local.remove([PROXY_STORE]);
    }

    return {
        KEY_STORE,
        DATA_STORE,
        PROXY_STORE,
        saveCredentials,
        getStatus,
        loadCredentials,
        clearCredentials,
        saveProxySecret,
        loadProxySecret,
        clearProxySecret
    };
});
