'use strict';

const os = require('os');
const path = require('path');

// 数据目录固定在 %APPDATA%/OIHelper, 不使用 Electron 默认 userData 目录
function defaultDataDir() {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'OIHelper');
}

function maskSecret(value) {
    const text = String(value ?? '');
    if (!text) {
        return '';
    }
    if (text.length <= 8) {
        return '****';
    }
    return `${text.slice(0, 4)}****${text.slice(-4)}`;
}

// 日志统一掩码: 令牌 / Cookie / 密码只保留可识别前后缀
function maskText(value) {
    return String(value ?? '')
        .replace(/((?:token|password|pass|cookie)=)[^&\s]+/gi, '$1****')
        .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/g, '$1****')
        .replace(/("(?:token|password|pass|cookie|secret)"\s*:\s*")[^"]*(")/gi, '$1****$2');
}

module.exports = {
    defaultDataDir,
    maskSecret,
    maskText
};
