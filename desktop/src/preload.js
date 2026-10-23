'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribeLog(callback) {
    const handler = (_event, entry) => callback(entry);
    ipcRenderer.on('oih:log', handler);
    return () => ipcRenderer.removeListener('oih:log', handler);
}

function subscribe(channel, callback) {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('oih', {
    getStatus: () => ipcRenderer.invoke('oih:status'),
    getLogs: () => ipcRenderer.invoke('oih:logs:list'),
    onLog: subscribeLog,
    getToken: () => ipcRenderer.invoke('oih:token'),
    getInterface: () => ipcRenderer.invoke('oih:interface:get'),
    saveInterface: (patch) => ipcRenderer.invoke('oih:interface:save', patch),
    testApi: () => ipcRenderer.invoke('oih:api:test'),
    testCli: (args) => ipcRenderer.invoke('oih:cli:test', args),
    testMcp: () => ipcRenderer.invoke('oih:mcp:test'),
    startMcp: () => ipcRenderer.invoke('oih:mcp:start'),
    stopMcp: () => ipcRenderer.invoke('oih:mcp:stop'),
    listServers: () => ipcRenderer.invoke('oih:servers:list'),
    getDefaultServer: () => ipcRenderer.invoke('oih:servers:default'),
    saveServer: (item) => ipcRenderer.invoke('oih:servers:save', item),
    deleteServer: (id) => ipcRenderer.invoke('oih:servers:delete', id),
    setDefaultServer: (id) => ipcRenderer.invoke('oih:servers:set-default', id),
    startServer: (id) => ipcRenderer.invoke('oih:servers:start', id),
    stopServer: (id) => ipcRenderer.invoke('oih:servers:stop', id),
    connectServer: (id) => ipcRenderer.invoke('oih:servers:connect', id),
    disconnectServer: (id) => ipcRenderer.invoke('oih:servers:disconnect', id),
    listDomainGroups: () => ipcRenderer.invoke('oih:domain-groups:list'),
    saveDomainGroup: (item) => ipcRenderer.invoke('oih:domain-groups:save', item),
    deleteDomainGroup: (id) => ipcRenderer.invoke('oih:domain-groups:delete', id),
    listCredentials: () => ipcRenderer.invoke('oih:credentials:list'),
    saveCredential: (item) => ipcRenderer.invoke('oih:credentials:save', item),
    deleteCredential: (id) => ipcRenderer.invoke('oih:credentials:delete', id),
    revealCredential: (id, field) => ipcRenderer.invoke('oih:credentials:reveal', { id, field }),
    listWorkspaces: () => ipcRenderer.invoke('oih:workspaces:list'),
    saveWorkspace: (item) => ipcRenderer.invoke('oih:workspaces:save', item),
    deleteWorkspace: (id) => ipcRenderer.invoke('oih:workspaces:delete', id),
    exportWorkspaces: () => ipcRenderer.invoke('oih:workspaces:export'),
    importWorkspaces: (text) => ipcRenderer.invoke('oih:workspaces:import', text),
    scanWorkspaces: () => ipcRenderer.invoke('oih:oih:scan-workspaces'),
    createWorkspace: () => ipcRenderer.invoke('oih:oih:create-workspace'),
    listInstances: () => ipcRenderer.invoke('oih:instances:list'),
    scanInstances: () => ipcRenderer.invoke('oih:instances:scan'),
    addInstance: (address) => ipcRenderer.invoke('oih:instances:add', address),
    deleteInstance: (id) => ipcRenderer.invoke('oih:instances:delete', id),
    getSettings: () => ipcRenderer.invoke('oih:settings:get'),
    updateSettings: (patch) => ipcRenderer.invoke('oih:settings:update', patch),
    getLanStatus: () => ipcRenderer.invoke('oih:lan:status'),
    listEvents: () => ipcRenderer.invoke('oih:events:list'),
    clearEvents: () => ipcRenderer.invoke('oih:events:clear'),
    onEvent: (callback) => subscribe('oih:event', callback),
    onNotification: (callback) => subscribe('oih:notification', callback),
    getWorkspaceClients: () => ipcRenderer.invoke('oih:workspaces:clients'),
    sendWorkspaceCommand: (type, payload, clientId) => ipcRenderer.invoke('oih:workspace:command', { type, payload, clientId }),
    getSyncInfo: () => ipcRenderer.invoke('oih:sync:info'),
    getSyncStatus: (workspace) => ipcRenderer.invoke('oih:sync:status', workspace),
    compareSync: (workspace) => ipcRenderer.invoke('oih:sync:compare', workspace),
    applySync: (workspace, keys, action) => ipcRenderer.invoke('oih:sync:apply', { workspace, keys, action }),
    runAutoSync: (workspace) => ipcRenderer.invoke('oih:sync:auto', workspace),
    onSettingsChanged: (callback) => subscribe('oih:settings:changed', callback),
    floatState: () => ipcRenderer.invoke('oih:float:state'),
    floatPickProblem: () => ipcRenderer.invoke('oih:float:pick-problem'),
    floatSetProblem: (dir) => ipcRenderer.invoke('oih:float:set-problem', dir),
    floatSetSelection: (ids) => ipcRenderer.invoke('oih:float:set-selection', ids),
    floatJudge: (payload) => ipcRenderer.invoke('oih:float:judge', payload),
    floatOpenProblem: () => ipcRenderer.invoke('oih:float:open-problem'),
    floatMinimize: () => ipcRenderer.invoke('oih:float:minimize'),
    floatClose: () => ipcRenderer.invoke('oih:float:close'),
    floatToggle: () => ipcRenderer.invoke('oih:float:toggle'),
    floatDebug: () => ipcRenderer.invoke('oih:float:debug'),
    onFloatState: (callback) => subscribe('oih:float:state', callback)
});
