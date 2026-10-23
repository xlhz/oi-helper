'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const EVENT_FILE = 'events.json';
const MAX_EVENTS = 200;
const EVENT_TYPES = ['teammate_submit', 'first_blood', 'freeze', 'unfreeze'];
const LEGACY_TYPES = { submission: 'teammate_submit', ac: 'teammate_submit', 'first-blood': 'first_blood' };

const TYPE_LABELS = {
    teammate_submit: '队友提交',
    first_blood: '一血',
    freeze: '封榜',
    unfreeze: '解榜'
};

function requireObject(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('事件必须是 JSON 对象.');
    }
    return input;
}

function textField(input, fallback) {
    const text = String(input ?? '').trim();
    return text || String(fallback || '');
}

function normalizeType(value) {
    const raw = String(value || '').trim();
    const type = LEGACY_TYPES[raw] || raw;
    if (!EVENT_TYPES.includes(type)) {
        throw new Error(`事件类型无效: ${raw || '空'}, 可用类型: ${EVENT_TYPES.join(', ')}.`);
    }
    return type;
}

function normalizeTime(input) {
    if (typeof input === 'number' && Number.isFinite(input)) {
        const ms = input < 1e12 ? input * 1000 : input;
        return new Date(ms).toISOString();
    }
    const text = String(input || '').trim();
    if (text) {
        if (/^\d+$/.test(text)) {
            return normalizeTime(Number(text));
        }
        const parsed = Date.parse(text);
        if (!Number.isNaN(parsed)) {
            return new Date(parsed).toISOString();
        }
    }
    return new Date().toISOString();
}

function defaultTitle(event) {
    const payload = event.payload;
    const contest = payload.contest ? `${payload.contest} ` : '';
    const problem = payload.problem ? String(payload.problem) : '';
    const user = payload.user ? `${payload.user} ` : '';
    return {
        teammate_submit: `${user}提交了 ${contest}${problem}`.trim(),
        first_blood: `${user}拿到 ${contest}${problem} 一血`.trim(),
        freeze: `${contest}封榜`.trim(),
        unfreeze: `${contest}解榜`.trim()
    }[event.type] || `${TYPE_LABELS[event.type] || event.type} ${contest}${problem}`.trim();
}

class EventService {
    constructor(options = {}) {
        this.dataDir = options.dataDir || '';
        this.getSettings = typeof options.getSettings === 'function' ? options.getSettings : () => ({});
        this.onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};
        this.onRecord = typeof options.onRecord === 'function' ? options.onRecord : () => {};
        this.onLog = typeof options.onLog === 'function' ? options.onLog : () => {};
        this.items = [];
        this.byId = new Map();
        this.load();
    }

    file() {
        return path.join(this.dataDir || '', EVENT_FILE);
    }

    load() {
        try {
            const parsed = JSON.parse(fs.readFileSync(this.file(), 'utf8'));
            const items = parsed && Array.isArray(parsed.items) ? parsed.items : [];
            this.items = items.filter((item) => item && EVENT_TYPES.includes(item.type)).slice(-MAX_EVENTS);
            this.byId.clear();
            for (const item of this.items) {
                this.byId.set(item.id, item);
            }
        } catch {
            this.items = [];
            this.byId.clear();
        }
    }

    persist() {
        if (!this.dataDir) {
            return;
        }
        try {
            fs.mkdirSync(this.dataDir, { recursive: true });
            const file = this.file();
            const tmp = `${file}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify({ version: 2, items: this.items }, null, 4));
            fs.renameSync(tmp, file);
        } catch (err) {
            this.onLog({ source: 'event', level: 'warn', message: `事件留存写入失败: ${err.message}` });
        }
    }

    // 去重键: 比赛 + 题目 + 提交序号 + 类型; 事件 id 由该键派生
    keyOf(type, payload) {
        return [
            payload.contestId || payload.contest || '',
            payload.problem || '',
            payload.submitId || payload.submitSeq || '',
            type
        ].map((part) => String(part || '')).join('|');
    }

    normalizePayload(input, type) {
        const source = input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload)
            ? { ...input.payload }
            : {};
        const payload = {
            ...source,
            contest: textField(source.contest ?? input.contest),
            contestId: textField(source.contestId ?? input.contestId),
            oj: textField(source.oj ?? input.oj),
            problem: textField(source.problem ?? input.problem),
            submitId: textField(source.submitId ?? input.submitId ?? source.submitSeq ?? input.submitSeq ?? source.id),
            user: textField(source.user ?? input.user),
            text: textField(source.text ?? input.text),
            title: textField(source.title ?? input.title)
        };
        if (!payload.title) {
            payload.title = defaultTitle({ type, payload });
        }
        return payload;
    }

    push(input) {
        const source = requireObject(input);
        const type = normalizeType(source.type);
        const payload = this.normalizePayload(source, type);
        const key = this.keyOf(type, payload);
        const id = crypto.createHash('sha1').update(key).digest('hex').slice(0, 32);
        const existing = this.byId.get(id);
        if (existing) {
            return { event: existing, duplicate: true, notified: false };
        }
        const event = {
            id,
            type,
            time: normalizeTime(source.time ?? source.at ?? payload.time ?? payload.at),
            payload,
            source: textField(source.source ?? payload.source, 'contest')
        };
        this.items.push(event);
        if (this.items.length > MAX_EVENTS) {
            const removed = this.items.splice(0, this.items.length - MAX_EVENTS);
            for (const item of removed) {
                this.byId.delete(item.id);
            }
        }
        this.byId.set(id, event);
        this.persist();
        this.onRecord(event);
        const notified = this.allowNotify(event);
        if (notified) {
            this.onEvent(event);
        }
        return { event, duplicate: false, notified };
    }

    ruleMatches(rule, event) {
        if (!rule || rule.enabled === false) {
            return false;
        }
        if (rule.type && rule.type !== '*' && rule.type !== event.type) {
            return false;
        }
        if (rule.oj && rule.oj !== event.payload.oj) {
            return false;
        }
        if (rule.contestId) {
            const contest = String(event.payload.contestId || event.payload.contest || '');
            if (rule.contestId !== contest) {
                return false;
            }
        }
        return true;
    }

    allowNotify(event) {
        const settings = this.getSettings() || {};
        const notify = settings.notifications || {};
        if (!notify.enabled) {
            return false;
        }
        const types = notify.types || {};
        if (types[event.type] === false) {
            return false;
        }
        const rules = Array.isArray(notify.rules) ? notify.rules : [];
        if (!rules.length) {
            return true;
        }
        if (!rules.some((rule) => rule && rule.enabled !== false)) {
            return false;
        }
        return rules.some((rule) => this.ruleMatches(rule, event));
    }

    list() {
        return JSON.parse(JSON.stringify(this.items)).reverse();
    }

    clear() {
        this.items = [];
        this.byId.clear();
        this.persist();
        return true;
    }
}

module.exports = { EventService, EVENT_TYPES, TYPE_LABELS };
