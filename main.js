const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execSync, spawn, exec } = require('child_process');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

// ─── Splash window ────────────────────────────────────────────────────────────
let splashWindow = null;

// ─── Bundled openclaw path ────────────────────────────────────────────────────
// Use the openclaw bundled in node_modules — no global install needed
const OPENCLAW_BIN = (() => {
  // In packaged app, resources are in process.resourcesPath
  const candidates = [
    path.join(process.resourcesPath || '', 'app', 'node_modules', 'openclaw', 'openclaw.mjs'),
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'node_modules', 'openclaw', 'openclaw.mjs'),
    path.join(__dirname, 'node_modules', 'openclaw', 'openclaw.mjs'),
  ];
  for (const c of candidates) { if (fs.existsSync(c)) return c; }
  return 'openclaw'; // fallback to global
})();

function runOpenClaw(args, opts = {}) {
  // Run openclaw via node since it's an .mjs file
  if (OPENCLAW_BIN.endsWith('.mjs')) {
    return spawn(process.execPath, [OPENCLAW_BIN, ...args], { ...opts, shell: false });
  }
  return spawn(OPENCLAW_BIN, args, { ...opts, shell: true });
}

function runOpenClawSync(args) {
  if (OPENCLAW_BIN.endsWith('.mjs')) {
    return execSync(`"${process.execPath}" "${OPENCLAW_BIN}" ${args.join(' ')}`, { timeout: 10000, encoding: 'utf8' });
  }
  return execSync(`openclaw ${args.join(' ')}`, { timeout: 10000, encoding: 'utf8' });
}

// ─── Constants ────────────────────────────────────────────────────────────────
const GATEWAY_URL = 'ws://127.0.0.1:18789';
const GATEWAY_HTTP = 'http://127.0.0.1:18789';
const CLIENT_ID = 'openclaw-control-ui';
// Use userData (AppData/Roaming/OpenAutomation) in packaged builds so data
// persists outside the asar bundle; fall back to local ./data in dev mode.
const DATA_DIR = app.isPackaged
  ? path.join(app.getPath('userData'), 'data')
  : path.join(__dirname, 'data');
const KEYPAIR_PATH = path.join(DATA_DIR, 'device-keypair.json');
const PROJECTS_PATH = path.join(DATA_DIR, 'projects.json');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

// ─── State ────────────────────────────────────────────────────────────────────
let mainWindow = null;
let ws = null;
let reconnectTimer = null;
let isConnected = false;
let deviceKeypair = null;
let pendingRequests = new Map();
let gatewayToken = null;
let watchdogInterval = null;
let doctorRunning = false;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function ensureDirs() {
  [DATA_DIR, path.join(DATA_DIR, 'projects'), BACKUP_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });
}

function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ─── Config (API keys, gateway token, etc.) ───────────────────────────────────
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {}
  return {};
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// ─── Device Keypair ───────────────────────────────────────────────────────────
function loadOrGenerateKeypair() {
  const userDataPath = path.join(app.getPath('userData'), 'device-keypair.json');

  for (const p of [userDataPath, KEYPAIR_PATH]) {
    if (fs.existsSync(p)) {
      try {
        const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
        const privateKey = crypto.createPrivateKey({
          key: Buffer.from(raw.privateKeyDer, 'base64'),
          format: 'der', type: 'pkcs8'
        });
        const publicKey = crypto.createPublicKey(privateKey);
        // Derive raw public key (last 32 bytes of SPKI DER)
        const pubSpki = publicKey.export({ type: 'spki', format: 'der' });
        const rawPub = pubSpki.slice(-32);
        console.log('[keypair] Loaded, deviceId:', raw.deviceId);
        if (!fs.existsSync(userDataPath)) fs.writeFileSync(userDataPath, JSON.stringify(raw, null, 2));
        if (!fs.existsSync(KEYPAIR_PATH)) fs.writeFileSync(KEYPAIR_PATH, JSON.stringify(raw, null, 2));
        return { privateKey, rawPub, deviceId: raw.deviceId };
      } catch (e) { console.warn('[keypair] Load failed:', e.message); }
    }
  }

  // Generate fresh keypair
  console.log('[keypair] Generating...');
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const pubSpki = publicKey.export({ type: 'spki', format: 'der' });
  const rawPub = pubSpki.slice(-32);
  const deviceId = crypto.createHash('sha256').update(rawPub).digest('hex'); // full 64-char hex
  const privDer = privateKey.export({ type: 'pkcs8', format: 'der' });

  const stored = { deviceId, privateKeyDer: privDer.toString('base64'), publicKeyDer: pubSpki.toString('base64'), createdAt: Date.now() };
  fs.writeFileSync(userDataPath, JSON.stringify(stored, null, 2));
  fs.writeFileSync(KEYPAIR_PATH, JSON.stringify(stored, null, 2));
  console.log('[keypair] Generated:', deviceId);
  return { privateKey, rawPub, deviceId };
}

// ─── Gateway WebSocket ────────────────────────────────────────────────────────
function connectGateway() {
  if (ws) { try { ws.terminate(); } catch (_) {} ws = null; }
  if (!deviceKeypair) return;

  const cfg = loadConfig();
  const token = cfg.gatewayToken || gatewayToken || 'b6d0cc230b901cfc66e4ce148420e931b187e870ce70a59d';

  console.log('[gateway] Connecting...');
  sendToRenderer('connection:status', 'connecting');

  ws = new WebSocket(GATEWAY_URL, {
    headers: { origin: GATEWAY_HTTP }
  });

  ws.on('open', () => console.log('[gateway] Socket open'));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'event' && msg.event === 'connect.challenge') {
      handleChallenge(msg.payload, token);
      return;
    }

    if (msg.type === 'res' && msg.id && pendingRequests.has(msg.id)) {
      const { resolve, reject, timeout } = pendingRequests.get(msg.id);
      pendingRequests.delete(msg.id);
      clearTimeout(timeout);
      if (msg.ok) resolve(msg.payload);
      else reject(new Error(msg.error?.message || 'Request failed'));
      return;
    }

    if (msg.type === 'event' && msg.event === 'chat') {
      sendToRenderer('chat:event', msg.payload);
      return;
    }
  });

  ws.on('close', (code, reason) => {
    console.log('[gateway] Closed', code, reason?.toString());
    isConnected = false;
    for (const [, { reject, timeout }] of pendingRequests) { clearTimeout(timeout); reject(new Error('WS closed')); }
    pendingRequests.clear();
    sendToRenderer('connection:status', 'disconnected');
    scheduleReconnect();
  });

  ws.on('error', (err) => console.error('[gateway] WS error:', err.message));
}

function handleChallenge(payload, token) {
  const nonce = payload.nonce;
  const signedAtMs = Date.now();
  const scopes = ['operator.read', 'operator.write'];

  // Exact signing format from Control UI source (v2 pipe-delimited)
  // clientMode = 'webchat', deviceId = full sha256 hex of raw pub key
  const sigPayload = [
    'v2',
    deviceKeypair.deviceId,
    CLIENT_ID,
    'webchat',
    'operator',
    scopes.join(','),
    String(signedAtMs),
    token,
    nonce
  ].join('|');

  const signature = b64url(crypto.sign(null, Buffer.from(sigPayload, 'utf8'), deviceKeypair.privateKey));
  const publicKey = b64url(deviceKeypair.rawPub);

  const reqId = uuidv4();
  sendRequest_raw(reqId, {
    type: 'req', id: reqId, method: 'connect',
    params: {
      minProtocol: 3, maxProtocol: 3,
      client: { id: CLIENT_ID, version: 'control-ui', platform: 'windows', mode: 'webchat' },
      role: 'operator', scopes,
      caps: ['tool-events'],
      commands: [], permissions: {},
      auth: { token },
      locale: 'en-US', userAgent: 'openautomation/1.0.0',
      device: { id: deviceKeypair.deviceId, publicKey, signature, signedAt: signedAtMs, nonce }
    }
  }).then(p => {
    console.log('[gateway] hello-ok! Connected.');
    isConnected = true;
    sendToRenderer('connection:status', 'connected');
    fetchChatHistory();
  }).catch(err => {
    console.error('[gateway] Connect rejected:', err.message);
    sendToRenderer('connection:status', 'error');
    sendToRenderer('gateway:error', err.message);
    scheduleReconnect();
  });
}

function sendRequest_raw(id, msg) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { pendingRequests.delete(id); reject(new Error('Timed out')); }, 30000);
    pendingRequests.set(id, { resolve, reject, timeout });
    ws.send(JSON.stringify(msg));
  });
}

function sendRequest(method, params) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Not connected'));
  const id = uuidv4();
  return sendRequest_raw(id, { type: 'req', id, method, params });
}

function fetchChatHistory() {
  sendRequest('chat.history', {})
    .then(p => sendToRenderer('chat:history', p))
    .catch(err => console.warn('[gateway] chat.history failed:', err.message));
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; if (!isConnected) connectGateway(); }, 5000);
}

// ─── Splash helpers ───────────────────────────────────────────────────────────
function createSplashWindow() {
  const win = new BrowserWindow({
    width: 800, height: 500,
    frame: false, transparent: false,
    resizable: false, center: true,
    backgroundColor: '#0d0d0d',
    webPreferences: {
      preload: path.join(__dirname, 'preload-splash.js'),
      contextIsolation: true, nodeIntegration: false
    },
    show: false,
  });
  win.loadFile(path.join(__dirname, 'renderer', 'splash.html'));
  win.once('ready-to-show', () => win.show());
  return win;
}

function sendToSplash(channel, data) {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.send(channel, data);
  }
}

function waitForSplashReady() {
  return new Promise(resolve => {
    ipcMain.once('splash:ready', resolve);
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── First-run check ──────────────────────────────────────────────────────────
async function firstRunCheck() {
  if (isOpenClawInstalled()) {
    await ensureGatewayRunning();
    return;
  }

  // OpenClaw not installed — show splash
  splashWindow = createSplashWindow();
  await waitForSplashReady();

  sendToSplash('splash:log', '🔍 OpenClaw not found. Starting installation...');
  await sleep(500);

  try {
    await installOpenClawForSplash();
    sendToSplash('splash:log', '🚀 Starting OpenClaw gateway...');
    await ensureGatewayRunning();
    await sleep(500);
    sendToSplash('splash:done');
    await sleep(1800);
  } catch (e) {
    sendToSplash('splash:error', e.message);
    await sleep(4000);
  }

  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.close();
    splashWindow = null;
  }
}

function installOpenClawForSplash() {
  return new Promise((resolve) => {
    // openclaw is bundled � no install needed
    sendToSplash('splash:log', '? OpenClaw is bundled � skipping install.');
    resolve();
  });
}

// ─── OpenClaw installer / launcher ────────────────────────────────────────────
function isOpenClawInstalled() {
  try { execSync('openclaw --version', { stdio: 'ignore', timeout: 5000 }); return true; } catch { return false; }
}

function isNodeInstalled() {
  try { execSync('node --version', { stdio: 'ignore', timeout: 5000 }); return true; } catch { return false; }
}

function isNpmInstalled() {
  try { execSync('npm --version', { stdio: 'ignore', timeout: 5000 }); return true; } catch { return false; }
}

function installOpenClaw() {
  return new Promise((resolve, reject) => {
    sendToRenderer('install:log', '📦 Installing OpenClaw via npm...');
    const proc = spawn('npm', ['install', '-g', 'openclaw'], { shell: true, stdio: 'pipe' });
    proc.stdout.on('data', d => sendToRenderer('install:log', d.toString()));
    proc.stderr.on('data', d => sendToRenderer('install:log', d.toString()));
    proc.on('close', code => {
      if (code === 0) {
        sendToRenderer('install:log', '✅ OpenClaw installed!');
        resolve();
      } else {
        reject(new Error('npm install failed with code ' + code));
      }
    });
  });
}

function ensureGatewayRunning() {
  return new Promise((resolve) => {
    // Check if already reachable
    const http = require('http');
    http.get(GATEWAY_HTTP, res => { resolve(true); }).on('error', () => {
      // Try to start gateway
      sendToRenderer('install:log', '🚀 Starting OpenClaw gateway...');
      try {
        runOpenClaw(['gateway'], { shell: true, detached: true, stdio: 'ignore' }).unref();
        setTimeout(() => resolve(true), 3000);
      } catch (e) {
        sendToRenderer('install:log', '⚠️ Could not start gateway: ' + e.message);
        resolve(false);
      }
    });
  });
}

// ─── Watchdog: keep gateway alive ────────────────────────────────────────────
function startWatchdog() {
  if (watchdogInterval) return;
  console.log('[watchdog] Started');
  watchdogInterval = setInterval(() => {
    if (!isConnected && !reconnectTimer) {
      console.log('[watchdog] Not connected, ensuring gateway running...');
      ensureGatewayRunning().then(() => {
        if (!isConnected) connectGateway();
      });
    }
  }, 15000); // check every 15s
}

// ─── Doctor: diagnostic agent ────────────────────────────────────────────────
function runDoctor(check) {
  if (doctorRunning) return Promise.reject(new Error('Doctor already running'));
  doctorRunning = true;

  const checks = {
    gateway: async () => {
      const results = [];
      results.push({ label: 'Gateway URL', value: GATEWAY_URL, ok: true });
      results.push({ label: 'WebSocket connected', value: isConnected ? 'Yes' : 'No', ok: isConnected });
      try {
        const status = await sendRequest('status', {});
        results.push({ label: 'Gateway version', value: status?.version || 'unknown', ok: true });
      } catch (e) {
        results.push({ label: 'Gateway status', value: e.message, ok: false });
      }
      return results;
    },
    system: async () => {
      const results = [];
      results.push({ label: 'OpenClaw installed', value: isOpenClawInstalled() ? 'Yes' : 'No', ok: isOpenClawInstalled() });
      results.push({ label: 'Node.js', value: isNodeInstalled() ? 'Yes' : 'No', ok: isNodeInstalled() });
      try {
        const v = execSync('node --version', { timeout: 3000 }).toString().trim();
        results.push({ label: 'Node version', value: v, ok: true });
      } catch {}
      try {
        const v = execSync('openclaw --version', { timeout: 3000 }).toString().trim();
        results.push({ label: 'OpenClaw version', value: v, ok: true });
      } catch {}
      results.push({ label: 'Data directory', value: DATA_DIR, ok: fs.existsSync(DATA_DIR) });
      results.push({ label: 'Keypair saved', value: fs.existsSync(KEYPAIR_PATH) ? 'Yes' : 'No', ok: fs.existsSync(KEYPAIR_PATH) });
      return results;
    },
    models: async () => {
      try {
        const res = await sendRequest('models.list', {});
        const models = res?.models || [];
        return models.map(m => ({ label: m.id || m.name, value: m.provider || '', ok: true }));
      } catch (e) {
        return [{ label: 'Error', value: e.message, ok: false }];
      }
    },
    health: async () => {
      try {
        const res = await sendRequest('health', {});
        const out = [];
        if (res) {
          Object.entries(res).forEach(([k, v]) => {
            out.push({ label: k, value: typeof v === 'object' ? JSON.stringify(v).slice(0, 60) : String(v), ok: String(v) !== 'error' });
          });
        }
        return out.length ? out : [{ label: 'Health', value: 'OK', ok: true }];
      } catch (e) {
        return [{ label: 'Error', value: e.message, ok: false }];
      }
    }
  };

  const fn = checks[check] || checks.system;
  return fn().finally(() => { doctorRunning = false; });
}

// ─── Auto-backup ──────────────────────────────────────────────────────────────
function runAutoBackup() {
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(BACKUP_DIR, `backup-${ts}`);
    fs.mkdirSync(backupPath, { recursive: true });
    if (fs.existsSync(PROJECTS_PATH)) fs.copyFileSync(PROJECTS_PATH, path.join(backupPath, 'projects.json'));
    if (fs.existsSync(CONFIG_PATH)) fs.copyFileSync(CONFIG_PATH, path.join(backupPath, 'config.json'));
    const projectsDir = path.join(DATA_DIR, 'projects');
    if (fs.existsSync(projectsDir)) {
      for (const id of fs.readdirSync(projectsDir)) {
        const src = path.join(projectsDir, id);
        if (fs.statSync(src).isDirectory()) copyDirSync(src, path.join(backupPath, 'projects', id));
      }
    }
    // Keep last 10 backups
    const backups = fs.readdirSync(BACKUP_DIR).filter(n => n.startsWith('backup-')).sort();
    while (backups.length > 10) rmDirSync(path.join(BACKUP_DIR, backups.shift()));
    console.log('[backup] Done:', backupPath);
  } catch (e) { console.error('[backup]', e.message); }
}

function copyDirSync(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src)) {
    const s = path.join(src, entry), d = path.join(dst, entry);
    fs.statSync(s).isDirectory() ? copyDirSync(s, d) : fs.copyFileSync(s, d);
  }
}

function rmDirSync(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir)) {
    const p = path.join(dir, e);
    fs.statSync(p).isDirectory() ? rmDirSync(p) : fs.unlinkSync(p);
  }
  fs.rmdirSync(dir);
}

// ─── IPC Handlers ─────────────────────────────────────────────────────────────
// Session key for main agent session
const MAIN_SESSION_KEY = 'agent:main:main';

ipcMain.handle('chat:send', (_, text, key, sessionKey) =>
  sendRequest('chat.send', { sessionKey: sessionKey || MAIN_SESSION_KEY, message: text, idempotencyKey: key }));
ipcMain.handle('chat:history', (_, sessionKey) =>
  sendRequest('chat.history', { sessionKey: sessionKey || MAIN_SESSION_KEY }));

ipcMain.handle('projects:get', () => { try { return fs.existsSync(PROJECTS_PATH) ? JSON.parse(fs.readFileSync(PROJECTS_PATH, 'utf8')) : []; } catch { return []; } });
ipcMain.handle('projects:save', (_, projects) => { fs.writeFileSync(PROJECTS_PATH, JSON.stringify(projects, null, 2)); runAutoBackup(); return true; });

ipcMain.handle('notes:get', (_, id) => { const p = path.join(DATA_DIR, 'projects', id, 'notes.md'); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; });
ipcMain.handle('notes:save', (_, id, content) => { const d = path.join(DATA_DIR, 'projects', id); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'notes.md'), content); return true; });

ipcMain.handle('files:list', (_, id) => { const d = path.join(DATA_DIR, 'projects', id, 'files'); return fs.existsSync(d) ? fs.readdirSync(d).filter(f => fs.statSync(path.join(d, f)).isFile()) : []; });
ipcMain.handle('files:read', (_, id, f) => { const p = path.join(DATA_DIR, 'projects', id, 'files', f); try { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; } catch { return '[Binary]'; } });

ipcMain.handle('localchat:get', (_, id) => { const p = path.join(DATA_DIR, 'projects', id, 'chat-local.json'); try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : []; } catch { return []; } });
ipcMain.handle('localchat:save', (_, id, msgs) => { const d = path.join(DATA_DIR, 'projects', id); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'chat-local.json'), JSON.stringify(msgs, null, 2)); return true; });

ipcMain.handle('backup:run', () => { runAutoBackup(); return true; });
ipcMain.handle('sessions:list', () => sendRequest('sessions.list', {}));

ipcMain.handle('model:set', async (_, model) => {
  try {
    // Set primary model in openclaw config
    execSync(`openclaw config set agents.defaults.model.primary "${model}"`, { shell: true, timeout: 10000 });
    return { ok: true };
  } catch (e) {
    // Try via gateway request as fallback
    try {
      await sendRequest('config.set', { path: 'agents.defaults.model.primary', value: model });
      return { ok: true };
    } catch (e2) {
      return { ok: false, error: e.message };
    }
  }
});
ipcMain.handle('gateway:token:get', () => {
  // Read the token directly from openclaw config file
  try {
    const ocConfig = JSON.parse(fs.readFileSync(
      path.join(process.env.USERPROFILE || process.env.HOME, '.openclaw', 'openclaw.json'), 'utf8'));
    return ocConfig?.gateway?.auth?.token || null;
  } catch { return null; }
});

ipcMain.handle('config:get', () => loadConfig());
ipcMain.handle('config:save', (_, cfg) => { saveConfig(cfg); return true; });

ipcMain.handle('doctor:run', (_, check) => runDoctor(check));

ipcMain.handle('setup:check', async () => ({
  nodeInstalled: isNodeInstalled(),
  npmInstalled: isNpmInstalled(),
  openclawInstalled: isOpenClawInstalled(),
  gatewayConnected: isConnected,
}));

ipcMain.handle('setup:install', async () => {
  try {
    if (!isOpenClawInstalled()) await installOpenClaw();
    await ensureGatewayRunning();
    setTimeout(() => connectGateway(), 2000);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('setup:configure-apikey', async (_, provider, apiKey) => {
  try {
    // Map provider names to openclaw config paths
    const providerMap = {
      anthropic: `auth.profiles.anthropic:default.apiKey`,
      openai: `auth.profiles.openai:default.apiKey`,
      openrouter: `auth.profiles.openrouter:default.apiKey`,
      brave: `tools.web.search.braveApiKey`,
    };
    const configPath = providerMap[provider];
    if (!configPath) throw new Error(`Unknown provider: ${provider}`);
    execSync(`openclaw config set "${configPath}" "${apiKey}"`, { shell: true, timeout: 10000 });
    // Also set mode to api_key for AI providers
    if (['anthropic','openai','openrouter'].includes(provider)) {
      execSync(`openclaw config set "auth.profiles.${provider}:default.mode" "api_key"`, { shell: true, timeout: 10000 });
    }
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:maximize', () => mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize());
ipcMain.on('window:close', () => mainWindow?.close());
ipcMain.on('shell:open-external', (_, url) => shell.openExternal(url));

// ─── Gmail IPC Handlers ────────────────────────────────────────────────────────
ipcMain.handle('gmail:check-prereqs', async () => {
  const check = (cmd) => {
    try { execSync(cmd, { stdio: 'ignore', timeout: 5000 }); return true; } catch { return false; }
  };
  return {
    node: check('node --version'),
    openclaw: check('openclaw --version'),
    gcloud: check('gcloud --version'),
    gogcli: check('gog --version'),
  };
});

ipcMain.handle('gmail:setup', async (_, email) => {
  return new Promise((resolve) => {
    try {
      const proc = runOpenClaw(['webhooks', 'gmail', 'setup', '--account', email], {
        shell: true, stdio: 'pipe'
      });
      proc.on('close', code => {
        if (code === 0) resolve({ ok: true });
        else resolve({ ok: false, error: `Process exited with code ${code}` });
      });
      proc.on('error', err => resolve({ ok: false, error: err.message }));
    } catch (e) {
      resolve({ ok: false, error: e.message });
    }
  });
});

ipcMain.handle('gmail:apply-config', async (_, email) => {
  try {
    const token = crypto.randomBytes(24).toString('hex');
    // Use openclaw config set for each field (config patch doesn't exist)
    execSync(`openclaw config set hooks.enabled true`, { shell: true, timeout: 10000 });
    execSync(`openclaw config set hooks.token "${token}"`, { shell: true, timeout: 10000 });
    execSync(`openclaw config set hooks.path "/hooks"`, { shell: true, timeout: 10000 });
    // Restart gateway by stopping and starting
    try {
      spawn('openclaw', ['gateway', 'stop'], { shell: true, stdio: 'ignore' });
      await new Promise(r => setTimeout(r, 2000));
      runOpenClaw(['gateway'], { shell: true, detached: true, stdio: 'ignore' }).unref();
    } catch (e) {
      console.warn('[gmail] gateway restart warning:', e.message);
    }
    return { ok: true, token };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('gmail:test', async (_, email) => {
  try {
    execSync(
      `gog gmail send --account "${email}" --to "${email}" --subject "OpenAutomation Test" --body "Gmail integration is working!"`,
      { shell: true, timeout: 30000 }
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('gmail:status', async () => {
  try {
    const result = execSync('openclaw config get hooks', { shell: true, timeout: 5000, encoding: 'utf8' });
    const parsed = JSON.parse(result.trim());
    if (parsed && parsed.enabled) {
      return { configured: true, account: parsed.account || null };
    }
    return { configured: false, account: null };
  } catch {
    return { configured: false, account: null };
  }
});

// ─── BrowserWindow ────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 820, minWidth: 960, minHeight: 620,
    frame: false, backgroundColor: '#0d0d0d',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
    show: false,
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ─── First-run batch (post-installer) ────────────────────────────────────────
function runFirstRunBatch() {
  try {
    const batPath = path.join(process.resourcesPath || __dirname, 'first-run.bat');
    const batPath2 = path.join(__dirname, 'first-run.bat');
    const bat = fs.existsSync(batPath) ? batPath : fs.existsSync(batPath2) ? batPath2 : null;
    if (bat) {
      console.log('[first-run] Running batch:', bat);
      spawn('cmd', ['/c', bat], { shell: false, detached: true, stdio: 'ignore' }).unref();
    }
  } catch (e) { console.warn('[first-run]', e.message); }
}

// ─── App lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  runFirstRunBatch();
  ensureDirs();
  deviceKeypair = loadOrGenerateKeypair();

  // Load saved gateway token if any
  const cfg = loadConfig();
  if (cfg.gatewayToken) gatewayToken = cfg.gatewayToken;

  // First-run check: install openclaw if missing, start gateway
  await firstRunCheck();

  createWindow();

  // Connect to gateway and start watchdog
  connectGateway();
  startWatchdog();
  setInterval(runAutoBackup, 30 * 60 * 1000);

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => {
  if (watchdogInterval) clearInterval(watchdogInterval);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (ws) try { ws.terminate(); } catch (_) {}
});




