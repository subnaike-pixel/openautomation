const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // ── Chat ──────────────────────────────────────────────────────────────────
  sendMessage: (text, key, sessionKey) => ipcRenderer.invoke('chat:send', text, key, sessionKey),
  onChatEvent: (cb) => { ipcRenderer.removeAllListeners('chat:event'); ipcRenderer.on('chat:event', (_, d) => cb(d)); },
  onChatHistory: (cb) => { ipcRenderer.removeAllListeners('chat:history'); ipcRenderer.on('chat:history', (_, d) => cb(d)); },
  getChatHistory: (sessionKey) => ipcRenderer.invoke('chat:history', sessionKey),
  onConnectionStatus: (cb) => { ipcRenderer.removeAllListeners('connection:status'); ipcRenderer.on('connection:status', (_, s) => cb(s)); },
  onGatewayError: (cb) => { ipcRenderer.removeAllListeners('gateway:error'); ipcRenderer.on('gateway:error', (_, m) => cb(m)); },
  onInstallLog: (cb) => { ipcRenderer.removeAllListeners('install:log'); ipcRenderer.on('install:log', (_, m) => cb(m)); },

  // ── Sessions ──────────────────────────────────────────────────────────────
  sessionsList: () => ipcRenderer.invoke('sessions:list'),
  setModel: (model) => ipcRenderer.invoke('model:set', model),
  gatewayTokenGet: () => ipcRenderer.invoke('gateway:token:get'),

  // ── Projects ──────────────────────────────────────────────────────────────
  getProjects: () => ipcRenderer.invoke('projects:get'),
  saveProjects: (p) => ipcRenderer.invoke('projects:save', p),

  // ── Notes ─────────────────────────────────────────────────────────────────
  getNotes: (id) => ipcRenderer.invoke('notes:get', id),
  saveNotes: (id, c) => ipcRenderer.invoke('notes:save', id, c),

  // ── Files ─────────────────────────────────────────────────────────────────
  getFiles: (id) => ipcRenderer.invoke('files:list', id),
  readFile: (id, f) => ipcRenderer.invoke('files:read', id, f),

  // ── Local chat backup ─────────────────────────────────────────────────────
  getLocalChat: (id) => ipcRenderer.invoke('localchat:get', id),
  saveLocalChat: (id, msgs) => ipcRenderer.invoke('localchat:save', id, msgs),

  // ── Backup ────────────────────────────────────────────────────────────────
  backup: () => ipcRenderer.invoke('backup:run'),

  // ── Config ────────────────────────────────────────────────────────────────
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (cfg) => ipcRenderer.invoke('config:save', cfg),

  // ── Doctor ────────────────────────────────────────────────────────────────
  doctorRun: (check) => ipcRenderer.invoke('doctor:run', check),

  // ── Setup ─────────────────────────────────────────────────────────────────
  setupCheck: () => ipcRenderer.invoke('setup:check'),
  setupInstall: () => ipcRenderer.invoke('setup:install'),
  setupConfigureApiKey: (provider, key) => ipcRenderer.invoke('setup:configure-apikey', provider, key),

  // ── Gmail ─────────────────────────────────────────────────────────────────
  gmailCheckPrereqs: () => ipcRenderer.invoke('gmail:check-prereqs'),
  gmailSetup: (email) => ipcRenderer.invoke('gmail:setup', email),
  gmailApplyConfig: (email) => ipcRenderer.invoke('gmail:apply-config', email),
  gmailTest: (email) => ipcRenderer.invoke('gmail:test', email),
  gmailStatus: () => ipcRenderer.invoke('gmail:status'),

  // ── Window ────────────────────────────────────────────────────────────────
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  maximizeWindow: () => ipcRenderer.send('window:maximize'),
  closeWindow: () => ipcRenderer.send('window:close'),

  // ── Shell ─────────────────────────────────────────────────────────────────
  openExternal: (url) => ipcRenderer.send('shell:open-external', url),
});
