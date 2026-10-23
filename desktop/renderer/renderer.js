'use strict';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const state = {
    status: null,
    interfaceConfig: null,
    token: '',
    logs: [],
    servers: [],
    domainGroups: [],
    credentials: [],
    workspaces: [],
    instances: [],
    oihSelection: new Set(),
    oihCompare: false,
    settings: null,
    syncInfo: null,
    syncStatuses: [],
    diff: null,
    diffWorkspace: '',
    lan: null,
    lanSelf: '',
    events: []
};

const KNOWN_OJS = ['xmoj', '洛谷', 'Codeforces', 'AtCoder', 'Hydro'];
const SYNC_MODE_LABELS = {
    off: '关闭',
    workspaceToArchive: '工作区 → 存档',
    archiveToWorkspace: '存档 → 工作区',
    both: '双向'
};
let modalSubmit = null;
let toastTimer = null;

const LOG_SOURCES = {
    api: ['api', 'ws', 'app', 'server', 'sync', 'oih'],
    cli: ['cli'],
    mcp: ['mcp']
};

function formatTime(ts) {
    const date = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function createLine(entry) {
    const line = document.createElement('div');
    line.className = 'log-line';
    const time = document.createElement('span');
    time.className = 'log-time';
    time.textContent = formatTime(entry.ts);
    const level = document.createElement('span');
    level.className = `log-level ${entry.level || 'info'}`;
    level.textContent = entry.level || 'info';
    const message = document.createElement('span');
    message.className = 'log-message';
    message.textContent = entry.message || '';
    line.append(time, level, message);
    return line;
}

function renderLogs(kind) {
    const box = $(`#log-${kind}`);
    if (!box) {
        return;
    }
    const sources = LOG_SOURCES[kind] || [];
    box.textContent = '';
    const entries = state.logs.filter((entry) => sources.includes(entry.source));
    for (const entry of entries) {
        box.appendChild(createLine(entry));
    }
    box.scrollTop = box.scrollHeight;
}

function appendLog(entry) {
    state.logs.push(entry);
    if (state.logs.length > 500) {
        state.logs.shift();
    }
    for (const kind of Object.keys(LOG_SOURCES)) {
        if (LOG_SOURCES[kind].includes(entry.source)) {
            const box = $(`#log-${kind}`);
            if (box) {
                box.appendChild(createLine(entry));
                box.scrollTop = box.scrollHeight;
            }
        }
    }
}

function setText(selector, text) {
    const node = $(selector);
    if (node) {
        node.textContent = text;
    }
}

function renderStatus() {
    const status = state.status;
    if (!status) {
        return;
    }
    setText('#version', status.version || '');
    const api = status.api || {};
    const inputs = {
        host: $('#api-host'),
        port: $('#api-port')
    };
    if (inputs.host && document.activeElement !== inputs.host) {
        inputs.host.value = api.host || '127.0.0.1';
    }
    if (inputs.port && document.activeElement !== inputs.port) {
        inputs.port.value = api.port || 17322;
    }
    $('#api-enabled').checked = Boolean(api.enabled);
    const endpoint = api.running ? `已监听 ${api.baseUrl}` : (api.enabled ? '已开启但未成功监听' : 'API 未开启');
    setText('#api-endpoint', endpoint);
    setText('#api-token', status.ws && status.ws.token ? status.ws.token : '—');

    const mcp = status.mcp || {};
    $('#mcp-enabled').checked = Boolean(mcp.enabled);
    setText('#mcp-state', mcp.running ? '运行中' : (mcp.enabled ? '已开启, 未运行' : '未启动'));
    setText('#mcp-pid', mcp.pid ? `pid ${mcp.pid} · ${mcp.transport || 'stdio'}` : '');
    const dot = $('#mcp-dot');
    if (dot) {
        dot.classList.toggle('on', Boolean(mcp.running));
    }
    const tools = $('#mcp-tools');
    if (tools) {
        const names = Array.isArray(mcp.tools) ? mcp.tools : [];
        if (tools.dataset.count !== String(names.length)) {
            tools.textContent = '';
            for (const name of names) {
                const chip = document.createElement('span');
                chip.className = 'tool';
                chip.textContent = name;
                tools.appendChild(chip);
            }
            tools.dataset.count = String(names.length);
        }
    }
    if (status.cli && status.cli.path) {
        setText('#cli-path', status.cli.path);
    }
}

function renderInterface(config) {
    if (!config) {
        return;
    }
    const api = config.api || {};
    const danger = api.danger || {};
    $('#api-enabled').checked = Boolean(api.enabled);
    $('#api-host').value = api.host || '127.0.0.1';
    $('#api-port').value = api.port || 17322;
    $('#danger-delete').checked = Boolean(danger.deleteServer);
    $('#danger-sync').checked = Boolean(danger.syncOverwrite);
}

async function refresh(applyConfig = true) {
    const [status, config] = await Promise.all([
        window.oih.getStatus(),
        window.oih.getInterface()
    ]);
    state.status = status;
    state.interfaceConfig = config;
    renderStatus();
    if (applyConfig) {
        renderInterface(config);
    }
}

function collectApiConfig() {
    return {
        enabled: $('#api-enabled').checked,
        host: $('#api-host').value.trim() || '127.0.0.1',
        port: Number($('#api-port').value) || 17322,
        danger: {
            deleteServer: $('#danger-delete').checked,
            syncOverwrite: $('#danger-sync').checked
        }
    };
}

async function saveApi() {
    const button = $('#save-api');
    button.disabled = true;
    try {
        const status = await window.oih.saveInterface({ api: collectApiConfig() });
        state.status = status;
        renderStatus();
        await refresh();
    } catch (err) {
        appendLog({ ts: Date.now(), source: 'api', level: 'error', message: `保存失败: ${err.message}` });
    } finally {
        button.disabled = false;
    }
}

async function testApi() {
    const button = $('#test-api');
    button.disabled = true;
    try {
        await window.oih.testApi();
    } finally {
        button.disabled = false;
        await refresh();
    }
}

async function testCli() {
    const button = $('#test-cli');
    button.disabled = true;
    try {
        await window.oih.testCli(['server', 'list']);
    } finally {
        button.disabled = false;
    }
}

async function toggleMcp(enabled) {
    const result = enabled ? await window.oih.startMcp() : await window.oih.stopMcp();
    if (!result.ok) {
        appendLog({ ts: Date.now(), source: 'mcp', level: 'error', message: result.error || 'MCP 操作失败.' });
    }
    await refresh();
}

async function testMcp() {
    const button = $('#test-mcp');
    button.disabled = true;
    try {
        const result = await window.oih.testMcp();
        if (!result.ok) {
            appendLog({ ts: Date.now(), source: 'mcp', level: 'error', message: result.error || 'MCP 启动失败.' });
        }
    } finally {
        button.disabled = false;
        await refresh();
    }
}

async function copyText(text, label) {
    if (!text) {
        return;
    }
    try {
        await navigator.clipboard.writeText(text);
        appendLog({ ts: Date.now(), source: 'api', level: 'info', message: `${label}已复制到剪贴板.` });
    } catch (err) {
        appendLog({ ts: Date.now(), source: 'api', level: 'warn', message: `复制失败: ${err.message}` });
    }
}

function bindTabs() {
    for (const tab of $$('.tab')) {
        tab.addEventListener('click', () => {
            $$('.tab').forEach((item) => item.classList.toggle('active', item === tab));
            $$('.panel').forEach((panel) => panel.classList.toggle('active', panel.dataset.panel === tab.dataset.tab));
            const loaders = {
                oih: () => loadOih(),
                workspace: async () => {
                    renderWorkspaceTab();
                    await loadLan();
                },
                servers: () => loadServers(),
                credentials: async () => {
                    await loadCredentials();
                    await loadSync();
                },
                settings: async () => {
                    await loadSettings();
                    await loadEvents();
                }
            };
            const loader = loaders[tab.dataset.tab];
            if (loader) {
                loader().catch((err) => fail('加载数据失败', err));
            }
        });
    }
    for (const tab of $$('.subtab[data-sub]')) {
        tab.addEventListener('click', () => {
            $$('.subtab[data-sub]').forEach((item) => item.classList.toggle('active', item === tab));
            $$('.subpanel[data-subpanel]').forEach((panel) => panel.classList.toggle('active', panel.dataset.subpanel === tab.dataset.sub));
        });
    }
}

function bindOihTab() {
    $('#oih-scan').addEventListener('click', () => scanOih());
    $('#oih-new-workspace').addEventListener('click', () => createWorkspaceFromOih());
    $('#oih-json').addEventListener('click', () => openWorkspaceJson());
    $('#oih-export').addEventListener('click', () => exportWorkspaceJson());
    $('#oih-workspace-remove').addEventListener('click', () => removeSelectedWorkspaces());
    $('#oih-add-instance').addEventListener('click', () => openManualInstanceForm());
    $('#oih-compare').addEventListener('click', () => {
        state.oihCompare = !state.oihCompare;
        renderOih();
        if (state.oihCompare && !state.oihSelection.size) {
            toast('对照已开启: 勾选工作区可高亮其绑定的服务实例.');
        }
    });
    $('#oih-workspace-all').addEventListener('change', (event) => {
        const checked = event.target.checked;
        if (checked) {
            state.workspaces.forEach((workspace) => state.oihSelection.add(workspace.id));
        } else {
            state.oihSelection.clear();
        }
        renderOih();
    });
}

function bindActions() {
    $('#save-api').addEventListener('click', saveApi);
    $('#test-api').addEventListener('click', testApi);
    $('#test-cli').addEventListener('click', testCli);
    $('#test-mcp').addEventListener('click', testMcp);
    $('#mcp-enabled').addEventListener('change', (event) => toggleMcp(event.target.checked));
    $('#copy-token').addEventListener('click', async () => {
        if (!state.token) {
            state.token = await window.oih.getToken();
        }
        await copyText(state.token, '令牌');
    });
    $('#copy-cli').addEventListener('click', () => {
        const path = state.status && state.status.cli ? state.status.cli.path : '';
        void copyText(path, 'CLI 入口路径');
    });
    for (const kind of Object.keys(LOG_SOURCES)) {
        const button = $(`#clear-log-${kind}`);
        if (button) {
            button.addEventListener('click', () => {
                const sources = LOG_SOURCES[kind];
                state.logs = state.logs.filter((entry) => !sources.includes(entry.source));
                renderLogs(kind);
            });
        }
    }
}

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
        node.className = className;
    }
    if (text !== undefined) {
        node.textContent = text;
    }
    return node;
}

function button(label, className, handler) {
    const node = el('button', className, label);
    node.type = 'button';
    node.addEventListener('click', handler);
    return node;
}

function field(labelText, control, hint) {
    const wrap = el('label', 'field');
    wrap.appendChild(el('span', 'field-label', labelText));
    wrap.appendChild(control);
    if (hint) {
        wrap.appendChild(el('span', 'hint', hint));
    }
    return wrap;
}

function chip(text, className) {
    return el('span', `status-chip ${className || 'idle'}`, text);
}

function errorMessage(err) {
    return String(err && err.message ? err.message : err || '未知错误')
        .replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
}

function toast(message, level) {
    const node = $('#toast');
    node.textContent = message;
    node.className = `toast ${level || ''}`.trim();
    node.hidden = false;
    if (toastTimer) {
        clearTimeout(toastTimer);
    }
    toastTimer = setTimeout(() => {
        node.hidden = true;
    }, 4200);
}

function fail(prefix, err) {
    toast(`${prefix}: ${errorMessage(err)}`, 'error');
}

function maskInline(value) {
    const text = String(value || '');
    if (!text) {
        return '';
    }
    if (text.length <= 8) {
        return '****';
    }
    return `${text.slice(0, 4)}****${text.slice(-4)}`;
}

function closeModal() {
    $('#modal').hidden = true;
    modalSubmit = null;
    setText('#modal-error', '');
}

function openModal(options) {
    setText('#modal-title', options.title || '编辑');
    setText('#modal-error', '');
    const body = $('#modal-body');
    body.textContent = '';
    options.build(body);
    $('#modal-submit').textContent = options.submitText || '保存';
    $('#modal-submit').disabled = false;
    modalSubmit = options.onSubmit;
    $('#modal').hidden = false;
}

async function submitModal() {
    if (!modalSubmit) {
        return;
    }
    const submit = $('#modal-submit');
    submit.disabled = true;
    setText('#modal-error', '');
    try {
        await modalSubmit();
        closeModal();
    } catch (err) {
        setText('#modal-error', errorMessage(err));
    } finally {
        submit.disabled = false;
    }
}

function accessLabel(access) {
    return { localhost: '本机', lan: '局域网', public: '公网' }[access] || '本机';
}

function serverAddress(server) {
    if (!server) {
        return '';
    }
    return server.type === 'remote' ? (server.url || '') : `${server.host || ''}:${server.port || ''}`;
}

function serverGroupName(id) {
    const group = state.domainGroups.find((item) => item.id === id);
    return group ? group.name : '未分组';
}

function renderServerOverview() {
    const def = state.servers.find((item) => item.isDefault);
    if (!def) {
        setText('#overview-name', '未设置');
        setText('#overview-meta', '在服务器列表中可将某台设为默认连接.');
        const idle = $('#overview-status');
        idle.textContent = '未连接';
        idle.className = 'status-chip idle';
        return;
    }
    setText('#overview-name', def.name);
    const parts = [def.type === 'remote' ? '远程' : '本地', serverAddress(def)];
    if (def.type === 'local') {
        parts.push(accessLabel(def.access));
        if (def.domain) {
            parts.push(def.domain);
        }
    } else if (def.permission) {
        parts.push(`权限: ${def.permission}`);
    }
    setText('#overview-meta', parts.filter(Boolean).join(' · '));
    const node = $('#overview-status');
    if (def.type === 'remote') {
        const connected = def.connection === 'connected';
        node.textContent = connected ? '已连接' : '未连接';
        node.className = `status-chip ${connected ? 'on' : 'idle'}`;
    } else {
        const running = def.status === 'running';
        const healthy = !running || !def.lastHealth || def.lastHealth.ok;
        node.textContent = running ? (healthy ? '运行中' : '运行中 (健康检查失败)') : '已停止';
        node.className = running ? `status-chip ${healthy ? 'on' : 'warn'}` : 'status-chip idle';
    }
}

function defaultCell(server) {
    const td = el('td');
    if (server.isDefault) {
        td.appendChild(chip('默认', 'on'));
    } else {
        td.appendChild(button('设为默认', 'ghost', async () => {
            try {
                await window.oih.setDefaultServer(server.id);
                await loadServers();
                toast(`已将 ${server.name} 设为默认连接.`);
            } catch (err) {
                fail('设置默认连接失败', err);
            }
        }));
    }
    return td;
}

function serverActions(server) {
    const td = el('td');
    const row = el('div', 'row-actions');
    if (server.type === 'local') {
        const running = server.status === 'running';
        row.appendChild(button(running ? '停止' : '启动', '', async () => {
            try {
                const result = running
                    ? await window.oih.stopServer(server.id)
                    : await window.oih.startServer(server.id);
                if (result && result.error) {
                    toast(result.error, 'error');
                } else if (!running && result && result.probe && !result.probe.ok) {
                    toast(`已记录启动状态, /health 探测失败: ${result.probe.error}`, 'error');
                } else {
                    toast(`${server.name} 已${running ? '停止' : '启动'}.`);
                }
                await loadServers();
            } catch (err) {
                fail(`${running ? '停止' : '启动'}失败`, err);
            }
        }));
    } else {
        const connected = server.connection === 'connected';
        row.appendChild(button(connected ? '断开' : '连接', '', async () => {
            try {
                if (connected) {
                    await window.oih.disconnectServer(server.id);
                    toast(`已断开 ${server.name}.`);
                } else {
                    const result = await window.oih.connectServer(server.id);
                    if (result && result.error) {
                        toast(result.error, 'error');
                    } else {
                        toast(`${server.name} 连接成功.`);
                    }
                }
                await loadServers();
            } catch (err) {
                fail('连接操作失败', err);
            }
        }));
    }
    row.appendChild(button('编辑', '', () => openServerForm(server.type, server)));
    row.appendChild(button('删除', 'danger', async () => {
        try {
            await window.oih.deleteServer(server.id);
            await loadServers();
            toast(`已删除 ${server.name}.`);
        } catch (err) {
            fail('删除服务器失败', err);
        }
    }));
    td.appendChild(row);
    return td;
}

function renderServers() {
    renderServerOverview();
    const local = state.servers.filter((item) => item.type !== 'remote');
    const remote = state.servers.filter((item) => item.type === 'remote');
    setText('#count-local', String(local.length));
    setText('#count-remote', String(remote.length));

    const localBody = $('#local-rows');
    localBody.textContent = '';
    for (const server of local) {
        const tr = el('tr');
        tr.appendChild(el('td', '', server.name));
        tr.appendChild(el('td', 'cell-wrap', serverAddress(server)));
        const accessTd = el('td');
        accessTd.appendChild(el('span', '', accessLabel(server.access)));
        if (server.domain) {
            accessTd.appendChild(el('span', 'cell-sub', server.domain));
        }
        tr.appendChild(accessTd);
        tr.appendChild(el('td', '', serverGroupName(server.domainGroupId)));
        const statusTd = el('td');
        const running = server.status === 'running';
        const healthy = running && server.lastHealth && server.lastHealth.ok;
        statusTd.appendChild(chip(running ? (healthy ? '运行中' : '运行中') : '已停止', running ? (healthy ? 'on' : 'warn') : 'idle'));
        tr.appendChild(statusTd);
        tr.appendChild(defaultCell(server));
        tr.appendChild(serverActions(server));
        localBody.appendChild(tr);
    }
    $('#local-empty').hidden = local.length > 0;

    const remoteBody = $('#remote-rows');
    remoteBody.textContent = '';
    for (const server of remote) {
        const tr = el('tr');
        tr.appendChild(el('td', '', server.name));
        tr.appendChild(el('td', 'cell-wrap', server.url || ''));
        tr.appendChild(el('td', '', server.verify ? maskInline(server.verify) : '—'));
        tr.appendChild(el('td', '', server.permission || '—'));
        const statusTd = el('td');
        const connected = server.connection === 'connected';
        statusTd.appendChild(chip(connected ? '已连接' : '未连接', connected ? 'on' : 'idle'));
        tr.appendChild(statusTd);
        tr.appendChild(defaultCell(server));
        tr.appendChild(serverActions(server));
        remoteBody.appendChild(tr);
    }
    $('#remote-empty').hidden = remote.length > 0;

    renderDomainGroups();
}

function renderDomainGroups() {
    const box = $('#domain-group-list');
    box.textContent = '';
    if (!state.domainGroups.length) {
        box.appendChild(el('div', 'empty-hint', '暂无域名组'));
        return;
    }
    for (const group of state.domainGroups) {
        const row = el('div', 'domain-group-row');
        const info = el('div');
        info.appendChild(el('div', 'domain-group-name', group.name));
        if (group.note) {
            info.appendChild(el('div', 'hint', group.note));
        }
        row.appendChild(info);
        const actions = el('div', 'row-actions');
        actions.appendChild(button('修改', '', () => openDomainGroupForm(group)));
        actions.appendChild(button('删除', 'danger', async () => {
            try {
                await window.oih.deleteDomainGroup(group.id);
                await loadServers();
                toast(`已删除域名组 ${group.name}.`);
            } catch (err) {
                fail('删除域名组失败', err);
            }
        }));
        row.appendChild(actions);
        box.appendChild(row);
    }
}

async function loadServers() {
    const [servers, groups] = await Promise.all([
        window.oih.listServers(),
        window.oih.listDomainGroups()
    ]);
    state.servers = Array.isArray(servers) ? servers : [];
    state.domainGroups = Array.isArray(groups) ? groups : [];
    renderServers();
}

const INSTANCE_SOURCE_LABELS = {
    program: '程序启动',
    extension: '扩展上报',
    scan: '扫描',
    manual: '手动'
};

const WORKSPACE_STATUS_LABELS = {
    ok: '正常',
    invalid: '配置损坏',
    missing: '目录缺失'
};

function normalizeAddress(value) {
    return String(value || '')
        .trim()
        .replace(/^https?:\/\//i, '')
        .replace(/\/+$/, '')
        .toLowerCase();
}

function instanceAddress(instance) {
    return normalizeAddress(instance.address || instance.url);
}

function instanceWorkspaces(instance) {
    const keys = new Set([normalizeAddress(instance.address), normalizeAddress(instance.url)].filter(Boolean));
    return state.workspaces.filter((workspace) => {
        const key = normalizeAddress(workspace.serverAddress);
        return key && keys.has(key);
    });
}

function selectedWorkspaceKeys() {
    const keys = new Set();
    for (const workspace of state.workspaces) {
        if (state.oihSelection.has(workspace.id)) {
            const key = normalizeAddress(workspace.serverAddress);
            if (key) {
                keys.add(key);
            }
        }
    }
    return keys;
}

function toggleWorkspaceSelection(id) {
    if (state.oihSelection.has(id)) {
        state.oihSelection.delete(id);
    } else {
        state.oihSelection.add(id);
    }
    renderOih();
}

async function renderOihWorkspaces() {
    const tbody = $('#oih-workspace-rows');
    tbody.textContent = '';
    let onlineCount = 0;

    for (const workspace of state.workspaces) {
        const tr = el('tr');
        if (state.oihSelection.has(workspace.id)) {
            tr.classList.add('selected');
        }
        if (normalizeAddress(workspace.serverAddress)) {
            const bound = state.instances.find((instance) => instanceAddress(instance) === normalizeAddress(workspace.serverAddress));
            if (bound && bound.status === 'online') {
                onlineCount += 1;
            }
        }

        const checkTd = el('td', 'cell-check');
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.checked = state.oihSelection.has(workspace.id);
        check.addEventListener('change', () => toggleWorkspaceSelection(workspace.id));
        checkTd.appendChild(check);
        tr.appendChild(checkTd);

        tr.appendChild(el('td', 'cell-wrap', workspace.name || workspace.path));
        tr.appendChild(el('td', 'cell-wrap', workspace.path));
        const bound = state.instances.find((instance) => instanceAddress(instance) === normalizeAddress(workspace.serverAddress));
        const connectionTd = el('td');
        const dot = el('span', 'dot-inline');
        if (bound) {
            dot.classList.add(bound.status === 'online' ? 'on' : 'off');
        } else if (workspace.connection === 'connected' && normalizeAddress(workspace.serverAddress)) {
            dot.classList.add('on');
        }
        connectionTd.appendChild(dot);
        connectionTd.appendChild(el('span', '', workspace.serverAddress || '未绑定'));
        tr.appendChild(connectionTd);

        const statusTd = el('td');
        const status = workspace.status || 'ok';
        statusTd.appendChild(chip(WORKSPACE_STATUS_LABELS[status] || status, status === 'ok' ? 'on' : 'error'));
        tr.appendChild(statusTd);

        const actionTd = el('td');
        const row = el('div', 'row-actions');
        row.appendChild(button('打开', '', async () => {
            try {
                const result = await window.oih.sendWorkspaceCommand('openWorkspace', { path: workspace.path }, workspace.clientId || undefined);
                if (!result || !result.ok) {
                    throw new Error('未连接该工作区的扩展, 无法在编辑器中打开.');
                }
                toast(`已请求扩展打开 ${workspace.name || workspace.path}.`);
            } catch (err) {
                fail('打开工作区失败', err);
            }
        }));
        actionTd.appendChild(row);
        tr.appendChild(actionTd);

        tr.addEventListener('click', (event) => {
            if (event.target.closest('button, input, a')) {
                return;
            }
            toggleWorkspaceSelection(workspace.id);
        });

        tbody.appendChild(tr);
    }

    const total = state.workspaces.length;
    setText('#oih-workspace-count', String(total));
    $('#oih-workspace-empty').hidden = total > 0;
    const all = $('#oih-workspace-all');
    const selectedCount = state.workspaces.filter((item) => state.oihSelection.has(item.id)).length;
    all.checked = total > 0 && selectedCount === total;
    all.indeterminate = selectedCount > 0 && selectedCount < total;
    const summary = $('#oih-workspace-summary');
    if (summary) {
        summary.textContent = total
            ? `已选 ${selectedCount} / ${total} 个, 绑定在线实例 ${onlineCount} 个.`
            : '点击行多选; 选中后右表高亮绑定实例.';
    }
}

function renderOihInstances() {
    const tbody = $('#oih-instance-rows');
    tbody.textContent = '';
    const selectedKeys = selectedWorkspaceKeys();

    for (const instance of state.instances) {
        const tr = el('tr');
        const boundWorkspaces = instanceWorkspaces(instance);
        const highlight = selectedKeys.size > 0 && selectedKeys.has(instanceAddress(instance));
        if (highlight) {
            tr.classList.add('bound');
        }

        tr.appendChild(el('td', '', INSTANCE_SOURCE_LABELS[instance.source] || instance.source || '扫描'));
        tr.appendChild(el('td', 'cell-wrap', instance.address || instance.url));

        const versionTd = el('td');
        versionTd.appendChild(el('span', '', instance.version || '—'));
        if (!instance.version && instance.status === 'offline' && instance.lastError) {
            versionTd.appendChild(el('span', 'cell-sub', instance.lastError));
        }
        tr.appendChild(versionTd);

        const statusTd = el('td');
        statusTd.appendChild(chip(instance.status === 'online' ? '在线' : '离线', instance.status === 'online' ? 'on' : 'idle'));
        tr.appendChild(statusTd);

        const workspaceTd = el('td', 'instance-workspaces');
        workspaceTd.textContent = boundWorkspaces.length
            ? boundWorkspaces.map((workspace) => workspace.name || workspace.path).join('、')
            : '—';
        workspaceTd.title = boundWorkspaces.map((workspace) => workspace.path).join('\n');
        tr.appendChild(workspaceTd);

        const actionTd = el('td');
        if (instance.source === 'manual') {
            const row = el('div', 'row-actions');
            row.appendChild(button('删除', 'danger', async () => {
                try {
                    await window.oih.deleteInstance(instance.id);
                    await loadOih();
                    toast(`已删除手动实例 ${instance.address}.`);
                } catch (err) {
                    fail('删除实例失败', err);
                }
            }));
            actionTd.appendChild(row);
        } else {
            actionTd.appendChild(el('span', 'hint', '—'));
        }
        tr.appendChild(actionTd);

        tbody.appendChild(tr);
    }

    const total = state.instances.length;
    const online = state.instances.filter((item) => item.status === 'online').length;
    setText('#oih-instance-count', String(total));
    const summary = $('#oih-instance-summary');
    if (summary) {
        summary.textContent = total
            ? `在线 ${online} / ${total} 个; 离线实例保留在表中.`
            : '来源: 程序启动 / 扩展上报 / 扫描 / 手动; 离线实例保留.';
    }
    $('#oih-instance-empty').hidden = total > 0;
}

function renderOih() {
    const ids = new Set(state.workspaces.map((item) => item.id));
    for (const id of [...state.oihSelection]) {
        if (!ids.has(id)) {
            state.oihSelection.delete(id);
        }
    }
    renderOihWorkspaces();
    renderOihInstances();
    const layout = $('#oih-layout');
    layout.classList.toggle('compare', state.oihCompare);
    const compare = $('#oih-compare');
    compare.textContent = state.oihCompare ? '退出对照' : '一键对照';
    compare.className = state.oihCompare ? 'primary' : '';
}

async function loadOih() {
    const [workspaces, instances] = await Promise.all([
        window.oih.listWorkspaces(),
        window.oih.listInstances()
    ]);
    state.workspaces = Array.isArray(workspaces) ? workspaces : [];
    state.instances = Array.isArray(instances) ? instances : [];
    renderOih();
    renderWorkspaceTab();
}

function renderWorkspaceTab() {
    const count = state.workspaces.length;
    setText('#workspace-empty-desc', count
        ? `当前已识别 ${count} 个工作区, 空态占位不触发数据请求; 明细在「识别到的OIH」.`
        : '工作区内容为 v0.1.0 的空态占位, 不触发任何数据请求.');
    setText('#workspace-empty-hint', count
        ? '入口: 「识别到的OIH」可扫描、新建、导出与导入工作区列表.'
        : '入口: 在「识别到的OIH」中扫描或新建工作区.');
}

const EVENT_TYPE_LABELS = {
    teammate_submit: '队友提交',
    first_blood: '一血',
    freeze: '封榜',
    unfreeze: '解榜'
};

const LAN_DEFAULT_PORT = 17330;

let lanSocket = null;
let lanJoinedKey = '';
let lanRetryTimer = null;
let lanMessages = [];

function formatDateTime(input) {
    const date = new Date(input);
    if (Number.isNaN(date.getTime())) {
        return '';
    }
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function lanEndpoints(lan) {
    const port = Number(lan && lan.port) || LAN_DEFAULT_PORT;
    const raw = String((lan && lan.serverAddress) || '').trim();
    if (!raw) {
        return { http: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}`, label: '本机' };
    }
    const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
    try {
        const parsed = new URL(candidate);
        if (!parsed.port) {
            parsed.port = String(port);
        }
        const http = parsed.origin;
        return { http, ws: http.replace(/^http/i, 'ws'), label: `${parsed.host}` };
    } catch {
        return { http: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}`, label: '本机' };
    }
}

function renderLanState() {
    const lan = state.lan || {};
    const node = $('#lan-status');
    if (!node) {
        return;
    }
    const running = Boolean(lan.running);
    const enabled = Boolean(lan.enabled);
    const endpoints = lanEndpoints(lan);
    const connected = Boolean(lanSocket && lanSocket.readyState === WebSocket.OPEN);
    node.textContent = connected
        ? `已连接 · ${endpoints.label}`
        : (running ? `运行中 · ${lan.port}` : (enabled ? '已开启, 未成功监听' : '未开启'));
    node.classList.toggle('on', running || connected);
    node.classList.toggle('warn', !running && enabled);
    node.classList.toggle('idle', !enabled && !connected);
    setText('#lan-self', state.lanSelf ? `我: ${state.lanSelf}` : '');
    const enabledNode = $('#lan-enabled');
    if (enabledNode) {
        enabledNode.checked = enabled;
    }
    const settingsEnabled = $('#settings-lan-enabled');
    if (settingsEnabled) {
        settingsEnabled.checked = enabled;
    }
}

function renderLanMembers(members) {
    const box = $('#lan-members');
    if (!box) {
        return;
    }
    const list = Array.isArray(members) ? members : [];
    setText('#lan-member-count', String(list.length));
    box.textContent = '';
    if (!list.length) {
        const empty = document.createElement('div');
        empty.className = 'lan-member-empty';
        empty.textContent = '暂无在线成员';
        box.appendChild(empty);
        return;
    }
    for (const member of list) {
        const row = document.createElement('div');
        row.className = 'lan-member';
        const avatar = document.createElement('span');
        avatar.className = 'lan-avatar';
        avatar.textContent = String(member.name || '?').slice(0, 1).toUpperCase();
        const name = document.createElement('span');
        name.className = 'lan-member-name';
        name.textContent = member.name || '匿名';
        row.append(avatar, name);
        if (member.name === state.lanSelf) {
            const me = document.createElement('span');
            me.className = 'lan-me';
            me.textContent = '我';
            row.appendChild(me);
        }
        box.appendChild(row);
    }
}

function createLanMessageNode(message) {
    const self = message.from === state.lanSelf;
    const row = document.createElement('div');
    row.className = `lan-msg ${self ? 'self' : 'other'}`;
    const avatar = document.createElement('span');
    avatar.className = 'lan-avatar';
    avatar.textContent = String(message.from || '?').slice(0, 1).toUpperCase();
    const content = document.createElement('div');
    content.className = 'lan-content';
    const meta = document.createElement('div');
    meta.className = 'lan-meta';
    const name = document.createElement('span');
    name.textContent = message.from || '匿名';
    const time = document.createElement('span');
    time.textContent = formatTime(message.at);
    meta.append(name, time);
    const bubble = document.createElement('div');
    bubble.className = 'lan-bubble';
    bubble.textContent = message.text || '';
    content.append(meta, bubble);
    row.append(avatar, content);
    return row;
}

function renderLanMessages() {
    const box = $('#lan-messages');
    if (!box) {
        return;
    }
    box.textContent = '';
    if (!lanMessages.length) {
        const empty = document.createElement('div');
        empty.className = 'lan-empty';
        empty.textContent = '还没有消息, 发一条试试.';
        box.appendChild(empty);
        return;
    }
    for (const message of lanMessages) {
        box.appendChild(createLanMessageNode(message));
    }
    box.scrollTop = box.scrollHeight;
}

function appendLanMessage(message) {
    lanMessages.push(message);
    if (lanMessages.length > 300) {
        lanMessages.shift();
    }
    const box = $('#lan-messages');
    if (box) {
        const empty = box.querySelector('.lan-empty');
        if (empty) {
            empty.remove();
        }
        box.appendChild(createLanMessageNode(message));
        box.scrollTop = box.scrollHeight;
    }
}

function disconnectLan() {
    if (lanRetryTimer) {
        clearTimeout(lanRetryTimer);
        lanRetryTimer = null;
    }
    if (lanSocket) {
        const socket = lanSocket;
        lanSocket = null;
        try {
            socket.close();
        } catch {
            // 已关闭时忽略
        }
    }
    lanJoinedKey = '';
    state.lanSelf = '';
}

function scheduleLanRetry() {
    if (lanRetryTimer) {
        return;
    }
    lanRetryTimer = setTimeout(() => {
        lanRetryTimer = null;
        ensureLanConnection().catch(() => undefined);
    }, 3000);
}

function openLanSocket(lan, data) {
    const endpoints = lanEndpoints(lan);
    const query = `room=${encodeURIComponent(lan.room)}&token=${encodeURIComponent(data.token)}&name=${encodeURIComponent(data.self || '')}`;
    const socket = new WebSocket(`${endpoints.ws}/ws?${query}`);
    lanSocket = socket;
    socket.addEventListener('open', () => {
        renderLanState();
    });
    socket.addEventListener('message', (event) => {
        let message;
        try {
            message = JSON.parse(event.data);
        } catch {
            return;
        }
        if (!message || typeof message !== 'object') {
            return;
        }
        if (message.type === 'chat' && message.room === lan.room) {
            appendLanMessage(message);
        } else if (message.type === 'presence') {
            renderLanMembers(message.members);
        } else if (message.type === 'error') {
            toast((message.error && message.error.message) || '局域网消息被拒绝.', 'error');
        }
    });
    socket.addEventListener('close', () => {
        if (lanSocket !== socket) {
            return;
        }
        lanSocket = null;
        if (state.lan && state.lan.running) {
            scheduleLanRetry();
        }
    });
    socket.addEventListener('error', () => {
        // close 事件统一处理重连
    });
}

async function joinLan(lan) {
    const endpoints = lanEndpoints(lan);
    const nickname = String(lan.nickname || (state.lan && state.lan.self) || '').trim();
    const key = `${endpoints.http}|${lan.room}|${nickname}`;
    lanJoinedKey = key;
    let payload;
    try {
        const response = await fetch(`${endpoints.http}/api/lan/join`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ room: lan.room, name: nickname })
        });
        payload = await response.json();
    } catch (err) {
        setText('#lan-self', `连接失败: ${err.message}`);
        scheduleLanRetry();
        return;
    }
    if (lanJoinedKey !== key) {
        return;
    }
    if (!payload.ok) {
        setText('#lan-self', (payload.error && payload.error.message) || '加入房间失败.');
        scheduleLanRetry();
        return;
    }
    state.lanSelf = payload.data.self || '';
    lanMessages = Array.isArray(payload.data.history) ? payload.data.history : [];
    renderLanMessages();
    renderLanMembers(payload.data.members);
    renderLanState();
    openLanSocket(lan, payload.data);
}

async function ensureLanConnection() {
    const lan = state.lan;
    const hasTarget = Boolean(lan && (lan.running || String(lan.serverAddress || '').trim()));
    if (!hasTarget) {
        disconnectLan();
        lanMessages = [];
        renderLanMessages();
        renderLanMembers([]);
        renderLanState();
        return;
    }
    const key = `${lanEndpoints(lan).http}|${lan.room}|${String(lan.nickname || (lan.self) || '').trim()}`;
    if (key === lanJoinedKey && lanSocket) {
        return;
    }
    disconnectLan();
    lanMessages = [];
    renderLanMessages();
    renderLanMembers(lan.members);
    renderLanState();
    await joinLan(lan);
}

async function loadLan() {
    state.lan = await window.oih.getLanStatus();
    renderLanState();
    await ensureLanConnection();
}

async function saveLanConfig(patch) {
    const current = (state.settings && state.settings.lan) || {};
    const lan = Object.assign({}, current, patch);
    try {
        const result = await window.oih.updateSettings({ lan });
        state.settings = result.settings;
        if ((result.notices || []).length) {
            toast(result.notices.join('; '));
        }
        await loadSettings();
        await loadLan();
    } catch (err) {
        fail('保存局域网设置失败', err);
        await loadLan().catch(() => undefined);
    }
}

async function sendLanMessage() {
    const input = $('#lan-input');
    const text = input ? input.value.trim() : '';
    if (!text) {
        return;
    }
    const lan = state.lan;
    if (!lan || !lanSocket || lanSocket.readyState !== WebSocket.OPEN) {
        toast('尚未连接局域网房间.', 'error');
        return;
    }
    if (text.length > 2000) {
        toast('消息不能超过 2000 个字符.', 'error');
        return;
    }
    lanSocket.send(JSON.stringify({
        type: 'chat',
        room: lan.room,
        from: state.lanSelf,
        text,
        at: new Date().toISOString()
    }));
    input.value = '';
}

function renderEvents() {
    const box = $('#event-list');
    if (!box) {
        return;
    }
    box.textContent = '';
    if (!state.events.length) {
        const empty = document.createElement('div');
        empty.className = 'event-empty';
        empty.textContent = '暂无事件.';
        box.appendChild(empty);
        return;
    }
    for (const event of state.events) {
        const payload = event.payload || {};
        const row = document.createElement('div');
        row.className = 'event-row';
        const type = document.createElement('span');
        type.className = `event-type ${event.type || ''}`;
        type.textContent = EVENT_TYPE_LABELS[event.type] || event.type || '事件';
        const title = document.createElement('span');
        title.className = 'event-title';
        title.textContent = payload.title || payload.text || '';
        const meta = document.createElement('span');
        meta.className = 'event-meta';
        meta.textContent = [payload.contest || payload.contestId, payload.problem, payload.user, event.source]
            .filter(Boolean)
            .join(' · ');
        const time = document.createElement('span');
        time.className = 'event-time';
        time.textContent = formatDateTime(event.time);
        row.append(type, title, meta, time);
        box.appendChild(row);
    }
}

async function loadEvents() {
    const items = await window.oih.listEvents();
    state.events = Array.isArray(items) ? items : [];
    renderEvents();
}

function bindLanEvents() {
    $('#lan-enabled').addEventListener('change', (event) => saveLanConfig({ enabled: event.target.checked }));
    $('#lan-room').addEventListener('change', (event) => saveLanConfig({ room: event.target.value.trim() || 'default' }));
    $('#lan-port').addEventListener('change', (event) => saveLanConfig({ port: Number(event.target.value) || LAN_DEFAULT_PORT }));
    $('#lan-server').addEventListener('change', (event) => saveLanConfig({ serverAddress: event.target.value.trim() }));
    $('#lan-nickname').addEventListener('change', (event) => saveLanConfig({ nickname: event.target.value.trim() }));
    $('#lan-retention').addEventListener('change', (event) => saveLanConfig({ retention: event.target.checked }));
    $('#lan-send').addEventListener('click', () => sendLanMessage().catch((err) => fail('发送消息失败', err)));
    $('#lan-input').addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            sendLanMessage().catch((err) => fail('发送消息失败', err));
        }
    });
    $('#clear-events').addEventListener('click', async () => {
        try {
            await window.oih.clearEvents();
            state.events = [];
            renderEvents();
            toast('事件已清空.');
        } catch (err) {
            fail('清空事件失败', err);
        }
    });
}

async function scanOih() {
    const buttons = ['#oih-scan'].map((selector) => $(selector));
    buttons.forEach((node) => { node.disabled = true; });
    try {
        const workspaceResult = await window.oih.scanWorkspaces();
        const instanceResult = await window.oih.scanInstances();
        state.workspaces = Array.isArray(workspaceResult.items) ? workspaceResult.items : state.workspaces;
        state.instances = Array.isArray(instanceResult.items) ? instanceResult.items : state.instances;
        renderOih();
        renderWorkspaceTab();
        const skipped = workspaceResult.skipped ? `, 同名跳过 ${workspaceResult.skipped}` : '';
        const limited = workspaceResult.truncated ? ' (目录或数量已达上限)' : '';
        toast(`扫描完成: 工作区识别 ${workspaceResult.scanned} 个, 实例在线 ${instanceResult.online}/${instanceResult.probed}${skipped}${limited}.`);
    } catch (err) {
        fail('扫描失败', err);
    } finally {
        buttons.forEach((node) => { node.disabled = false; });
    }
}

function openManualInstanceForm() {
    openModal({
        title: '手动添加服务实例',
        submitText: '探测并添加',
        build(body) {
            const input = document.createElement('input');
            input.type = 'text';
            input.spellcheck = false;
            input.placeholder = '127.0.0.1:17322 或 http://host:port';
            body.appendChild(field('地址', input, '探测 GET /health, 成功后以「手动」来源保存.')); 
            openManualInstanceForm.collect = () => input.value.trim();
        },
        async onSubmit() {
            const address = openManualInstanceForm.collect();
            if (!address) {
                throw new Error('请填写实例地址.');
            }
            await window.oih.addInstance(address);
            await loadOih();
            toast(`实例 ${address} 已添加.`);
        }
    });
}

function openWorkspaceJson() {
    let textarea = null;
    openModal({
        title: '工作区列表 JSON',
        submitText: '应用导入',
        build(body) {
            textarea = document.createElement('textarea');
            textarea.spellcheck = false;
            textarea.style.minHeight = '260px';
            textarea.value = JSON.stringify(state.workspaces, null, 4);
            body.appendChild(field('查看 / 编辑 / 导入', textarea, '编辑后点击「应用导入」; 按 path 合并, 已存在条目更新.'));
        },
        async onSubmit() {
            const result = await window.oih.importWorkspaces(textarea.value);
            await loadOih();
            toast(`JSON 导入完成: 新增 ${result.added}, 更新 ${result.updated}.`);
        }
    });
}

async function exportWorkspaceJson() {
    try {
        const text = await window.oih.exportWorkspaces();
        await navigator.clipboard.writeText(text);
        toast('工作区 JSON 已复制到剪贴板.');
    } catch (err) {
        fail('导出工作区 JSON 失败', err);
    }
}

async function removeSelectedWorkspaces() {
    const selected = state.workspaces.filter((item) => state.oihSelection.has(item.id));
    if (!selected.length) {
        toast('请先勾选要删除的工作区.', 'error');
        return;
    }
    const names = selected.map((item) => item.name || item.path).join('、');
    if (!window.confirm(`从工作区表删除 ${selected.length} 条? 不会删除磁盘目录.\n${names}`)) {
        return;
    }
    try {
        for (const item of selected) {
            await window.oih.deleteWorkspace(item.id);
        }
        state.oihSelection.clear();
        await loadOih();
        toast(`已从工作区表删除 ${selected.length} 条.`);
    } catch (err) {
        fail('删除工作区失败', err);
    }
}

async function createWorkspaceFromOih() {
    try {
        const result = await window.oih.createWorkspace();
        if (!result || result.canceled) {
            return;
        }
        await loadOih();
        toast(`已创建工作区: ${result.workspace && result.workspace.path ? result.workspace.path : ''}`);
    } catch (err) {
        fail('创建工作区失败', err);
    }
}

function openServerForm(type, server) {
    const editing = Boolean(server);
    let currentType = type === 'remote' ? 'remote' : 'local';
    openModal({
        title: editing ? '编辑服务器' : '新建服务器',
        submitText: editing ? '保存修改' : '创建',
        build(body) {
            const typeSwitch = el('div', 'type-switch');
            const nameInput = document.createElement('input');
            nameInput.type = 'text';
            nameInput.value = server ? server.name : '';
            nameInput.placeholder = '例如 本机评测机';

            const localBox = el('div');
            const addressInput = document.createElement('input');
            addressInput.type = 'text';
            addressInput.spellcheck = false;
            addressInput.placeholder = 'host:port, 例如 127.0.0.1:17322';
            addressInput.value = server && server.type === 'local' ? `${server.host}:${server.port}` : '';
            const accessSelect = document.createElement('select');
            for (const [value, label] of [['localhost', '本机'], ['lan', '局域网'], ['public', '公网']]) {
                const option = document.createElement('option');
                option.value = value;
                option.textContent = label;
                accessSelect.appendChild(option);
            }
            accessSelect.value = server && server.access ? server.access : 'localhost';
            const domainInput = document.createElement('input');
            domainInput.type = 'text';
            domainInput.spellcheck = false;
            domainInput.placeholder = '例如 judge.example.com';
            domainInput.value = server && server.domain ? server.domain : '';
            const domainField = field('域名', domainInput, '访问方式为公网时必填.');
            const groupSelect = document.createElement('select');
            const none = document.createElement('option');
            none.value = '';
            none.textContent = '未分组';
            groupSelect.appendChild(none);
            for (const group of state.domainGroups) {
                const option = document.createElement('option');
                option.value = group.id;
                option.textContent = group.name;
                groupSelect.appendChild(option);
            }
            groupSelect.value = server && server.domainGroupId ? server.domainGroupId : '';
            localBox.append(
                field('地址', addressInput, '格式为 host:port.'),
                field('访问方式', accessSelect),
                domainField,
                field('域名组', groupSelect)
            );

            const remoteBox = el('div');
            const urlInput = document.createElement('input');
            urlInput.type = 'text';
            urlInput.spellcheck = false;
            urlInput.placeholder = 'https://judge.example.com';
            urlInput.value = server && server.type === 'remote' ? server.url : '';
            const verifyInput = document.createElement('input');
            verifyInput.type = 'text';
            verifyInput.spellcheck = false;
            verifyInput.placeholder = '令牌或说明, 列表仅显示掩码';
            verifyInput.value = server && server.verify ? server.verify : '';
            const permissionInput = document.createElement('input');
            permissionInput.type = 'text';
            permissionInput.spellcheck = false;
            permissionInput.placeholder = '例如 管理员 / 参赛者';
            permissionInput.value = server && server.permission ? server.permission : '';
            remoteBox.append(
                field('地址 URL', urlInput, '连接时探测该地址的 /health.'),
                field('验证信息', verifyInput),
                field('我的权限', permissionInput, '自定义标签, 创建后可修改.')
            );

            const defaultCheck = document.createElement('input');
            defaultCheck.type = 'checkbox';
            defaultCheck.checked = Boolean(server && server.isDefault);
            const defaultRow = el('label', 'check-row');
            defaultRow.append(defaultCheck, el('span', '', '设为默认连接'));

            const applyType = () => {
                localBox.hidden = currentType !== 'local';
                remoteBox.hidden = currentType !== 'remote';
                domainField.hidden = accessSelect.value !== 'public';
            };

            for (const [value, label] of [['local', '本地'], ['remote', '远程']]) {
                const item = document.createElement('label');
                const input = document.createElement('input');
                input.type = 'radio';
                input.name = 'server-type';
                input.value = value;
                input.checked = currentType === value;
                input.addEventListener('change', () => {
                    if (input.checked) {
                        currentType = value;
                        applyType();
                    }
                });
                item.append(input, el('span', '', label));
                typeSwitch.appendChild(item);
            }
            accessSelect.addEventListener('change', applyType);

            body.append(
                typeSwitch,
                field('名称', nameInput),
                localBox,
                remoteBox,
                defaultRow
            );
            applyType();

            openServerForm.collect = () => {
                const name = nameInput.value.trim();
                if (!name) {
                    throw new Error('服务器名称不能为空.');
                }
                const item = {
                    id: server ? server.id : undefined,
                    name,
                    type: currentType,
                    isDefault: defaultCheck.checked
                };
                if (currentType === 'local') {
                    const match = /^([^\s:]+):(\d{1,5})$/.exec(addressInput.value.trim());
                    if (!match) {
                        throw new Error('地址格式应为 host:port.');
                    }
                    const port = Number(match[2]);
                    if (!Number.isInteger(port) || port < 1 || port > 65535) {
                        throw new Error('端口必须是 1-65535 的整数.');
                    }
                    item.host = match[1];
                    item.port = port;
                    item.access = accessSelect.value;
                    if (item.access === 'public' && !domainInput.value.trim()) {
                        throw new Error('公网访问必须填写域名.');
                    }
                    item.domain = item.access === 'public' ? domainInput.value.trim() : '';
                    item.domainGroupId = groupSelect.value;
                } else {
                    const url = urlInput.value.trim();
                    if (!url) {
                        throw new Error('远程服务器地址不能为空.');
                    }
                    item.url = url;
                    item.verify = verifyInput.value.trim();
                    item.permission = permissionInput.value.trim();
                }
                return item;
            };
        },
        async onSubmit() {
            await window.oih.saveServer(openServerForm.collect());
            await loadServers();
            toast(editing ? '服务器已更新.' : '服务器已创建.');
        }
    });
}

function openDomainGroupForm(group) {
    const editing = Boolean(group);
    openModal({
        title: editing ? '修改域名组' : '新增域名组',
        submitText: editing ? '保存修改' : '创建',
        build(body) {
            const nameInput = document.createElement('input');
            nameInput.type = 'text';
            nameInput.value = group ? group.name : '';
            nameInput.placeholder = '例如 比赛域名';
            const noteInput = document.createElement('input');
            noteInput.type = 'text';
            noteInput.value = group && group.note ? group.note : '';
            noteInput.placeholder = '可选说明';
            body.append(field('名称', nameInput), field('备注', noteInput));
            openDomainGroupForm.collect = () => {
                const name = nameInput.value.trim();
                if (!name) {
                    throw new Error('域名组名称不能为空.');
                }
                return {
                    id: group ? group.id : undefined,
                    name,
                    note: noteInput.value.trim()
                };
            };
        },
        async onSubmit() {
            await window.oih.saveDomainGroup(openDomainGroupForm.collect());
            await loadServers();
            toast(editing ? '域名组已更新.' : '域名组已创建.');
        }
    });
}

function groupCredentials() {
    const groups = new Map();
    for (const item of state.credentials) {
        if (!groups.has(item.oj)) {
            groups.set(item.oj, []);
        }
        groups.get(item.oj).push(item);
    }
    const names = [...groups.keys()].sort((a, b) => {
        const ia = KNOWN_OJS.indexOf(a);
        const ib = KNOWN_OJS.indexOf(b);
        if (ia >= 0 && ib >= 0) {
            return ia - ib;
        }
        if (ia >= 0) {
            return -1;
        }
        if (ib >= 0) {
            return 1;
        }
        return a.localeCompare(b);
    });
    return names.map((name) => ({ oj: name, items: groups.get(name) }));
}

function secretCell(item, fieldName) {
    const td = el('td');
    const wrap = el('div', 'secret-cell');
    const view = fieldName === 'password' ? item.password : item.cookie;
    const label = el('span', 'secret-value', view && view.present ? '已设置' : '未设置');
    if (view && view.present) {
        const masked = el('span', 'secret-value', '');
        masked.hidden = true;
        wrap.append(
            chip('已设置', 'on'),
            button('显示', 'ghost', async () => {
                try {
                    const result = await window.oih.revealCredential(item.id, fieldName);
                    masked.textContent = result.masked || '****';
                    masked.hidden = false;
                    masked.title = '已解密并以掩码显示.';
                    toast(`${fieldName === 'password' ? '密码' : 'Cookie'} 已解密, 界面按掩码显示.`);
                } catch (err) {
                    fail('显示失败', err);
                }
            }),
            masked
        );
    } else {
        wrap.appendChild(label);
    }
    td.appendChild(wrap);
    if (view && view.hint) {
        td.appendChild(el('span', 'cell-sub', view.hint));
    }
    return td;
}

function renderCredentials() {
    const box = $('#credential-groups');
    box.textContent = '';
    const groups = groupCredentials();
    $('#credential-empty').hidden = groups.length > 0;
    for (const group of groups) {
        const card = el('article', 'card cred-group');
        const head = el('div', 'cred-group-head');
        const title = el('h3');
        title.append(el('span', '', group.oj), el('span', 'badge', String(group.items.length)));
        head.appendChild(title);
        head.appendChild(button('新增账号', 'ghost', () => openCredentialForm(group.oj, null)));
        card.appendChild(head);

        const wrap = el('div', 'table-wrap');
        const table = el('table', 'data-table');
        const thead = el('thead');
        const headRow = el('tr');
        for (const label of ['用户名', '密码', 'Cookie', '备注', '默认', '操作']) {
            headRow.appendChild(el('th', '', label));
        }
        thead.appendChild(headRow);
        table.appendChild(thead);
        const tbody = el('tbody');
        for (const item of group.items) {
            const tr = el('tr');
            tr.appendChild(el('td', '', item.username));
            tr.appendChild(secretCell(item, 'password'));
            tr.appendChild(secretCell(item, 'cookie'));
            tr.appendChild(el('td', 'cell-wrap', item.note || '—'));
            const defTd = el('td');
            if (item.isDefault) {
                defTd.appendChild(chip('默认', 'on'));
            } else {
                defTd.appendChild(button('设为默认', 'ghost', async () => {
                    try {
                        await window.oih.saveCredential({
                            id: item.id,
                            oj: item.oj,
                            username: item.username,
                            note: item.note,
                            isDefault: true
                        });
                        await loadCredentials();
                        toast(`${item.oj} / ${item.username} 已设为默认.`);
                    } catch (err) {
                        fail('设置默认账号失败', err);
                    }
                }));
            }
            tr.appendChild(defTd);
            const actions = el('td');
            const row = el('div', 'row-actions');
            row.appendChild(button('编辑', '', () => openCredentialForm(item.oj, item)));
            row.appendChild(button('删除', 'danger', async () => {
                try {
                    await window.oih.deleteCredential(item.id);
                    await loadCredentials();
                    await loadSync();
                    toast(`已删除 ${item.oj} / ${item.username}.`);
                } catch (err) {
                    fail('删除凭据失败', err);
                }
            }));
            actions.appendChild(row);
            tr.appendChild(actions);
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        wrap.appendChild(table);
        card.appendChild(wrap);
        box.appendChild(card);
    }
}

async function loadCredentials() {
    const items = await window.oih.listCredentials();
    state.credentials = Array.isArray(items) ? items : [];
    renderCredentials();
}

function openCredentialForm(presetOj, item) {
    const editing = Boolean(item);
    const initialOj = presetOj || (item ? item.oj : KNOWN_OJS[0]);
    const custom = !KNOWN_OJS.includes(initialOj);
    openModal({
        title: editing ? '编辑凭据' : '新增凭据',
        submitText: editing ? '保存修改' : '创建',
        build(body) {
            const ojSelect = document.createElement('select');
            const options = custom ? [...KNOWN_OJS, initialOj] : KNOWN_OJS;
            for (const name of options) {
                const option = document.createElement('option');
                option.value = name;
                option.textContent = name;
                ojSelect.appendChild(option);
            }
            const customOption = document.createElement('option');
            customOption.value = '__custom';
            customOption.textContent = '自定义…';
            ojSelect.appendChild(customOption);
            ojSelect.value = custom ? initialOj : initialOj;

            const customInput = document.createElement('input');
            customInput.type = 'text';
            customInput.placeholder = '输入 OJ 名称';
            const customField = field('自定义 OJ', customInput);
            customField.hidden = !custom;

            const usernameInput = document.createElement('input');
            usernameInput.type = 'text';
            usernameInput.value = item ? item.username : '';
            usernameInput.placeholder = '用户名';

            const passwordInput = document.createElement('input');
            passwordInput.type = 'password';
            passwordInput.placeholder = editing ? '留空保持原密码' : '可留空';

            const cookieInput = document.createElement('textarea');
            cookieInput.placeholder = editing ? '留空保持原 Cookie' : '可留空, 支持整段 Cookie';
            cookieInput.spellcheck = false;

            const noteInput = document.createElement('input');
            noteInput.type = 'text';
            noteInput.value = item ? item.note || '' : '';
            noteInput.placeholder = '可选备注';

            const defaultCheck = document.createElement('input');
            defaultCheck.type = 'checkbox';
            defaultCheck.checked = Boolean(item && item.isDefault);
            const defaultRow = el('label', 'check-row');
            defaultRow.append(defaultCheck, el('span', '', '设为该 OJ 的默认账号'));

            ojSelect.addEventListener('change', () => {
                customField.hidden = ojSelect.value !== '__custom';
            });

            body.append(
                field('OJ', ojSelect),
                customField,
                field('用户名', usernameInput),
                field('密码', passwordInput, '系统加密存储, 读取只返回是否已设置.'),
                field('Cookie', cookieInput, '系统加密存储, 日志与界面默认掩码.'),
                field('备注', noteInput),
                defaultRow
            );

            openCredentialForm.collect = () => {
                const oj = ojSelect.value === '__custom' ? customInput.value.trim() : ojSelect.value;
                const username = usernameInput.value.trim();
                if (!oj) {
                    throw new Error('OJ 名称不能为空.');
                }
                if (!username) {
                    throw new Error('用户名不能为空.');
                }
                const payload = {
                    id: item ? item.id : undefined,
                    oj,
                    username,
                    note: noteInput.value,
                    isDefault: defaultCheck.checked
                };
                if (passwordInput.value !== '' || !editing) {
                    payload.password = passwordInput.value;
                }
                if (cookieInput.value !== '' || !editing) {
                    payload.cookie = cookieInput.value;
                }
                return payload;
            };
        },
        async onSubmit() {
            await window.oih.saveCredential(openCredentialForm.collect());
            await loadCredentials();
            await loadSync();
            toast(editing ? '凭据已更新.' : '凭据已创建.');
        }
    });
}

function syncStatusChip(status) {
    if (status === 'synced') {
        return chip('已同步', 'on');
    }
    if (status === 'diff') {
        return chip('有差异', 'warn');
    }
    if (status === 'missing') {
        return chip('未同步', 'idle');
    }
    return chip('读取失败', 'error');
}

function renderSyncWorkspaces() {
    const box = $('#sync-workspaces');
    box.textContent = '';
    if (!state.syncStatuses.length) {
        box.appendChild(el('div', 'empty-hint', '暂无工作区, 可在上方输入目录后添加.'));
        return;
    }
    for (const item of state.syncStatuses) {
        const row = el('div', 'sync-workspace-row');
        const info = el('div');
        info.appendChild(el('div', 'sync-workspace-path', item.workspace));
        const meta = el('div', 'hint');
        meta.textContent = `${SYNC_MODE_LABELS[item.mode] || item.mode || '关闭'}${item.error ? ` · ${item.error}` : ''}`;
        info.appendChild(meta);
        row.appendChild(info);
        const actions = el('div', 'sync-workspace-meta');
        actions.appendChild(syncStatusChip(item.status));
        actions.appendChild(button('比对', 'ghost', () => openDiff(item.workspace)));
        row.appendChild(actions);
        box.appendChild(row);
    }
}

function sideText(view) {
    if (!view) {
        return '—';
    }
    const note = view.note ? view.note : '无备注';
    return `${note} · 密码${view.passwordPresent ? '已设置' : '未设置'} · Cookie${view.cookiePresent ? '已设置' : '未设置'}`;
}

function renderDiff() {
    const panel = $('#sync-diff');
    if (!state.diff) {
        panel.hidden = true;
        return;
    }
    panel.hidden = false;
    setText('#sync-diff-title', `差异 · ${state.diff.workspace}`);
    const conflicts = state.diff.diffs.filter((item) => item.conflict).length;
    setText('#sync-diff-summary', `${state.diff.diffs.length} 条差异 · 模式 ${SYNC_MODE_LABELS[state.diff.mode] || state.diff.mode}${conflicts ? ` · ${conflicts} 条冲突暂停` : ''}`);
    const body = $('#sync-diff-rows');
    body.textContent = '';
    for (const diff of state.diff.diffs) {
        const tr = el('tr');
        tr.appendChild(el('td', '', `${diff.oj} / ${diff.username}`));
        const fieldsTd = el('td');
        if (diff.kind === 'archiveOnly') {
            fieldsTd.appendChild(el('span', 'field-chip', '仅存档有'));
        } else if (diff.kind === 'workspaceOnly') {
            fieldsTd.appendChild(el('span', 'field-chip', '仅工作区有'));
        } else {
            const labels = { password: '密码', cookie: 'Cookie', note: '备注' };
            for (const name of diff.fields) {
                fieldsTd.appendChild(el('span', 'field-chip', labels[name] || name));
            }
        }
        if (diff.conflict) {
            fieldsTd.appendChild(chip('冲突暂停', 'warn'));
        }
        tr.appendChild(fieldsTd);
        tr.appendChild(el('td', 'cell-wrap', sideText(diff.archive)));
        tr.appendChild(el('td', 'cell-wrap', sideText(diff.workspace)));
        const actions = el('td');
        const row = el('div', 'row-actions');
        row.appendChild(button('不改', 'ghost', () => toast('已选择不改, 两侧均未修改.')));
        row.appendChild(button('写回存档', '', () => applyDiff([diff.key], 'toArchive')));
        row.appendChild(button('写回工作区', '', () => applyDiff([diff.key], 'toWorkspace')));
        actions.appendChild(row);
        tr.appendChild(actions);
        body.appendChild(tr);
    }
}

async function openDiff(workspace) {
    try {
        const result = await window.oih.compareSync(workspace);
        state.diff = result;
        state.diffWorkspace = workspace;
        renderDiff();
        if (!result.diffs.length) {
            toast(result.exists ? '两侧凭据一致, 无差异.' : '工作区尚未生成凭据文件.');
        }
    } catch (err) {
        fail('比对失败', err);
    }
}

async function applyDiff(keys, action) {
    const workspace = state.diffWorkspace;
    if (!workspace) {
        return;
    }
    try {
        const result = await window.oih.applySync(workspace, keys, action);
        await loadCredentials();
        await loadSync();
        await openDiff(workspace);
        toast(`${action === 'toArchive' ? '写回存档' : '写回工作区'}完成, 影响 ${result.changed} 条.`);
    } catch (err) {
        fail('同步失败', err);
    }
}

async function loadSync() {
    const [info, statuses] = await Promise.all([
        window.oih.getSyncInfo(),
        window.oih.getSyncStatus()
    ]);
    state.syncInfo = info;
    state.syncStatuses = Array.isArray(statuses) ? statuses : [];
    if (info) {
        setText('#sync-archive-path', info.archivePath || '—');
    }
    renderSyncWorkspaces();
}

async function loadSettings() {
    const settings = await window.oih.getSettings();
    state.settings = settings;
    $('#settings-archive-path').value = settings.sync ? settings.sync.archivePath || '' : '';
    $('#settings-auto-sync').value = settings.autoSync || 'off';
    $('#settings-ws-port').value = settings.ws ? settings.ws.port : 17321;
    $('#settings-scan-ports').value = Array.isArray(settings.scanPorts) ? settings.scanPorts.join(',') : '';
    $('#settings-scan-roots').value = Array.isArray(settings.scanRoots) ? settings.scanRoots.join('\n') : '';
    $('#settings-auto-start').checked = Boolean(settings.autoStart);
    $('#settings-tray').checked = Boolean(settings.tray);
    $('#settings-float').checked = Boolean(settings.floatWindow && settings.floatWindow.enabled);
    const lan = settings.lan || {};
    $('#settings-lan-enabled').checked = Boolean(lan.enabled);
    $('#settings-lan-port').value = lan.port || LAN_DEFAULT_PORT;
    $('#settings-lan-room').value = lan.room || 'default';
    $('#settings-lan-retention').checked = Boolean(lan.retention);
    $('#lan-enabled').checked = Boolean(lan.enabled);
    $('#lan-port').value = lan.port || LAN_DEFAULT_PORT;
    $('#lan-room').value = lan.room || 'default';
    $('#lan-server').value = lan.serverAddress || '';
    $('#lan-nickname').value = lan.nickname || '';
    $('#lan-retention').checked = Boolean(lan.retention);
    const notifications = settings.notifications || {};
    const types = notifications.types || {};
    $('#settings-notify-enabled').checked = Boolean(notifications.enabled);
    $('#settings-notify-teammate-submit').checked = types.teammate_submit !== false;
    $('#settings-notify-first-blood').checked = types.first_blood !== false;
    $('#settings-notify-freeze').checked = types.freeze !== false;
    $('#settings-notify-unfreeze').checked = types.unfreeze !== false;
    const rules = Array.isArray(notifications.rules) ? notifications.rules : [];
    $('#settings-notify-rules').value = rules.length ? JSON.stringify(rules, null, 4) : '';
}

async function saveSettings() {
    const buttonNode = $('#save-settings');
    buttonNode.disabled = true;
    try {
        const wsPort = Number($('#settings-ws-port').value);
        if (!Number.isInteger(wsPort) || wsPort < 1 || wsPort > 65535) {
            throw new Error('WS 端口必须是 1-65535 的整数.');
        }
        const scanPorts = $('#settings-scan-ports').value
            .split(',')
            .map((text) => text.trim())
            .filter(Boolean)
            .map((text) => Number(text));
        if (scanPorts.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
            throw new Error('扫描端口必须是 1-65535 的整数.');
        }
        const scanRoots = $('#settings-scan-roots').value
            .split(/\r?\n/)
            .map((text) => text.trim())
            .filter(Boolean);
        const lanPort = Number($('#settings-lan-port').value);
        if (!Number.isInteger(lanPort) || lanPort < 1 || lanPort > 65535) {
            throw new Error('局域网端口必须是 1-65535 的整数.');
        }
        const rulesText = $('#settings-notify-rules').value.trim();
        let rules = [];
        if (rulesText) {
            try {
                rules = JSON.parse(rulesText);
            } catch (err) {
                throw new Error(`订阅规则必须是合法的 JSON: ${err.message}`);
            }
            if (!Array.isArray(rules)) {
                throw new Error('订阅规则必须是 JSON 数组.');
            }
        }
        const patch = {
            sync: { archivePath: $('#settings-archive-path').value.trim() },
            autoSync: $('#settings-auto-sync').value,
            ws: { port: wsPort },
            scanPorts,
            scanRoots,
            autoStart: $('#settings-auto-start').checked,
            tray: $('#settings-tray').checked,
            floatWindow: {
                enabled: $('#settings-float').checked
            },
            lan: {
                enabled: $('#settings-lan-enabled').checked,
                port: lanPort,
                room: $('#settings-lan-room').value.trim() || 'default',
                retention: $('#settings-lan-retention').checked
            },
            notifications: {
                enabled: $('#settings-notify-enabled').checked,
                types: {
                    teammate_submit: $('#settings-notify-teammate-submit').checked,
                    first_blood: $('#settings-notify-first-blood').checked,
                    freeze: $('#settings-notify-freeze').checked,
                    unfreeze: $('#settings-notify-unfreeze').checked
                },
                rules
            }
        };
        const result = await window.oih.updateSettings(patch);
        state.settings = result.settings;
        setText('#settings-notice', (result.notices || []).join('\n'));
        toast('设置已保存.');
        await loadSettings();
        await loadCredentials();
        await loadSync();
        await loadLan();
    } catch (err) {
        setText('#settings-notice', errorMessage(err));
        fail('保存设置失败', err);
    } finally {
        buttonNode.disabled = false;
    }
}

function bindServerTab() {
    for (const tab of $$('#server-subtabs .subtab')) {
        tab.addEventListener('click', () => {
            $$('#server-subtabs .subtab').forEach((item) => item.classList.toggle('active', item === tab));
            $$('[data-server-panel]').forEach((panel) => panel.classList.toggle('active', panel.dataset.serverPanel === tab.dataset.serverSub));
        });
    }
    $('#add-local-server').addEventListener('click', () => openServerForm('local', null));
    $('#add-remote-server').addEventListener('click', () => openServerForm('remote', null));
    $('#add-domain-group').addEventListener('click', () => openDomainGroupForm(null));
    $('#toggle-domain-groups').addEventListener('click', () => {
        const card = $('#domain-group-card');
        card.hidden = !card.hidden;
    });
    $('#add-credential').addEventListener('click', () => openCredentialForm(KNOWN_OJS[0], null));
    $('#modal-close').addEventListener('click', closeModal);
    $('#modal-cancel').addEventListener('click', closeModal);
    $('#modal-submit').addEventListener('click', submitModal);
    $('#modal').addEventListener('click', (event) => {
        if (event.target === $('#modal')) {
            closeModal();
        }
    });
    $('#sync-refresh').addEventListener('click', () => {
        loadSync().catch((err) => fail('刷新同步状态失败', err));
    });
    $('#sync-add-workspace').addEventListener('click', async () => {
        const input = $('#sync-workspace-input');
        const workspace = input.value.trim();
        if (!workspace) {
            toast('请先输入工作区目录.', 'error');
            return;
        }
        try {
            await window.oih.saveWorkspace({ path: workspace });
            input.value = '';
            await loadSync();
            toast('工作区已添加.');
        } catch (err) {
            fail('添加工作区失败', err);
        }
    });
    $('#sync-auto-run').addEventListener('click', async () => {
        try {
            const result = await window.oih.runAutoSync();
            const results = (result && result.results) || [];
            const applied = results.reduce((sum, item) => sum + (item.applied || 0), 0);
            const conflicts = results.reduce((sum, item) => sum + (item.conflicts || []).length, 0);
            const errors = results.filter((item) => item.error);
            await loadCredentials();
            await loadSync();
            if (errors.length) {
                toast(`自动同步完成 ${applied} 条, 冲突 ${conflicts} 条; ${errors.length} 个工作区失败: ${errors[0].error}`, 'error');
            } else {
                toast(`自动同步完成, 应用 ${applied} 条, 冲突暂停 ${conflicts} 条.`);
            }
            const conflicted = results.find((item) => (item.conflicts || []).length);
            if (conflicted) {
                await openDiff(conflicted.workspace);
            }
        } catch (err) {
            fail('自动同步失败', err);
        }
    });
    $('#sync-apply-skip').addEventListener('click', () => {
        if (!state.diff || !state.diff.diffs.length) {
            toast('当前没有可忽略的差异.', 'error');
            return;
        }
        toast(`已选择不改, ${state.diff.diffs.length} 条差异均未写入.`);
    });
    $('#sync-apply-archive').addEventListener('click', () => {
        if (!state.diff || !state.diff.diffs.length) {
            toast('当前没有可应用的差异.', 'error');
            return;
        }
        applyDiff(state.diff.diffs.map((item) => item.key), 'toArchive');
    });
    $('#sync-apply-workspace').addEventListener('click', () => {
        if (!state.diff || !state.diff.diffs.length) {
            toast('当前没有可应用的差异.', 'error');
            return;
        }
        applyDiff(state.diff.diffs.map((item) => item.key), 'toWorkspace');
    });
    $('#sync-close-diff').addEventListener('click', () => {
        state.diff = null;
        $('#sync-diff').hidden = true;
    });
    $('#save-settings').addEventListener('click', saveSettings);
}

async function init() {
    bindTabs();
    bindActions();
    bindOihTab();
    bindServerTab();
    bindLanEvents();
    const logs = await window.oih.getLogs();
    state.logs = Array.isArray(logs) ? logs : [];
    await refresh();
    await Promise.all([
        loadOih().catch((err) => fail('加载识别到的OIH失败', err)),
        loadServers().catch((err) => fail('加载服务器失败', err)),
        loadCredentials().catch((err) => fail('加载凭据失败', err)),
        loadSync().catch((err) => fail('加载同步状态失败', err)),
        loadSettings().catch((err) => fail('加载设置失败', err)),
        loadEvents().catch((err) => fail('加载事件失败', err))
    ]);
    state.token = await window.oih.getToken();
    for (const kind of Object.keys(LOG_SOURCES)) {
        renderLogs(kind);
    }
    window.oih.onLog((entry) => appendLog(entry));
    window.oih.onEvent((event) => {
        state.events = [event, ...state.events.filter((item) => item.id !== event.id)].slice(0, 200);
        renderEvents();
    });
    window.oih.onNotification((payload) => {
        toast(`${payload.title}${payload.body ? ` · ${payload.body}` : ''}`);
    });
    window.oih.onSettingsChanged((settings) => {
        state.settings = settings;
        $('#settings-float').checked = Boolean(settings.floatWindow && settings.floatWindow.enabled);
    });
    setInterval(() => {
        refresh(false).catch(() => undefined);
    }, 5000);
}

init().catch((err) => {
    appendLog({ ts: Date.now(), source: 'app', level: 'error', message: `界面初始化失败: ${err.message}` });
});
