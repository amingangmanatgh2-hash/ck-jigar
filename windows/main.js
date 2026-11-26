'use strict';

/**
 * The Windows client: one window, one `sing-box` process, the Windows system proxy pointed at it.
 *
 * Nothing here needs a driver or an administrator: sing-box listens on 127.0.0.1:2080 as a mixed proxy, and
 * everything that honours the Windows proxy setting (Chrome, Edge, Telegram, most apps) goes through it. The
 * previous proxy setting is saved before it is changed and put back when the tunnel stops or the app quits.
 */

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const { parseLink, parseSubscription, buildSingBox } = require('./core/config');
const store = require('./core/store');

const LISTEN_PORT = 2080;
const REG_PATH = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

let window = null;
let core = null;
let proxySnapshot = null;
let logLines = [];
const state = { running: false, activeId: '', message: '', startedAt: 0 };

/* ------------------------------------------------------------------ helpers */

const corePath = () =>
  app.isPackaged
    ? path.join(process.resourcesPath, 'bin', 'sing-box.exe')
    : path.join(__dirname, 'bin', 'sing-box.exe');

function log(line) {
  const text = String(line).trim();
  if (!text) return;
  logLines.push(`${new Date().toISOString().slice(11, 19)} ${text}`);
  if (logLines.length > 400) logLines = logLines.slice(-400);
  window?.webContents.send('event:log', text);
}

function run(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function queryProxy() {
  return run('reg', ['query', REG_PATH]).then((out) => {
    const enable = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(out.stdout);
    const server = /ProxyServer\s+REG_SZ\s+(.*)/i.exec(out.stdout);
    const override = /ProxyOverride\s+REG_SZ\s+(.*)/i.exec(out.stdout);
    return {
      enabled: enable ? parseInt(enable[1], 16) === 1 : false,
      server: server ? server[1].trim() : '',
      override: override ? override[1].trim() : '',
    };
  });
}

/** Tell Windows the proxy setting changed; without this most apps keep the old one until they restart. */
function refreshWinInet() {
  const script = [
    '[System.Runtime.InteropServices.DllImport("wininet.dll", SetLastError=true)]',
    'public static extern bool InternetSetOption(IntPtr h, int option, IntPtr buffer, int len);',
    '$null = [WinInet]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0)',
    '$null = [WinInet]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0)',
  ].join('; ');
  const command = `Add-Type -MemberDefinition '${script}' -Name WinInet -Namespace Zeus; `;
  return run('powershell', ['-NoProfile', '-NonInteractive', '-Command', command]);
}

async function enableSystemProxy() {
  if (!proxySnapshot) proxySnapshot = await queryProxy();
  await run('reg', ['add', REG_PATH, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '1', '/f']);
  await run('reg', ['add', REG_PATH, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', `127.0.0.1:${LISTEN_PORT}`, '/f']);
  await run('reg', ['add', REG_PATH, '/v', 'ProxyOverride', '/t', 'REG_SZ', '/d', '<local>', '/f']);
  await refreshWinInet();
  log(`system proxy → 127.0.0.1:${LISTEN_PORT}`);
}

async function restoreSystemProxy() {
  if (!proxySnapshot) return;
  await run('reg', ['add', REG_PATH, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', proxySnapshot.enabled ? '1' : '0', '/f']);
  if (proxySnapshot.server) {
    await run('reg', ['add', REG_PATH, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', proxySnapshot.server, '/f']);
  }
  if (proxySnapshot.override) {
    await run('reg', ['add', REG_PATH, '/v', 'ProxyOverride', '/t', 'REG_SZ', '/d', proxySnapshot.override, '/f']);
  }
  await refreshWinInet();
  proxySnapshot = null;
  log('system proxy put back');
}

function waitForPort(port, timeoutMs = 12000) {
  const started = Date.now();
  return new Promise((resolve) => {
    const attempt = () => {
      const socket = net.connect({ host: '127.0.0.1', port });
      socket.setTimeout(700);
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      const retry = () => {
        socket.destroy();
        if (Date.now() - started > timeoutMs) resolve(false);
        else setTimeout(attempt, 300);
      };
      socket.once('error', retry);
      socket.once('timeout', retry);
    };
    attempt();
  });
}

/** TCP latency to the server: the number the user cares about, measured without the tunnel. */
function ping(profile) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host: profile.host, port: profile.port });
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve(-1);
    }, 3000);
    socket.once('connect', () => {
      clearTimeout(timeout);
      socket.destroy();
      resolve(Date.now() - started);
    });
    socket.once('error', () => {
      clearTimeout(timeout);
      resolve(-1);
    });
  });
}

/* ------------------------------------------------------------------ tunnel */

async function startTunnel(id) {
  if (state.running) await stopTunnel();
  const snapshot = store.read(app);
  const profile = snapshot.configs.find((c) => c.id === id) || snapshot.configs[0];
  if (!profile) return fail('no config to connect to');

  if (!fs.existsSync(corePath())) return fail(`sing-box is missing (${corePath()})`);

  const configPath = path.join(path.dirname(store.file(app)), 'singbox.json');
  fs.writeFileSync(configPath, JSON.stringify(buildSingBox(profile, { listenPort: LISTEN_PORT }), null, 2), 'utf8');
  log(`starting sing-box for ${profile.name} (${profile.host}:${profile.port})`);

  core = spawn(corePath(), ['run', '-c', configPath], { windowsHide: true });
  core.stdout.on('data', (chunk) => log(String(chunk)));
  core.stderr.on('data', (chunk) => {
    const text = String(chunk);
    log(text);
    if (/FATAL|panic/i.test(text)) state.message = text.trim().slice(0, 300);
  });
  core.on('exit', (code) => {
    log(`sing-box exited (${code})`);
    if (state.running) {
      state.running = false;
      restoreSystemProxy().catch(() => {});
      window?.webContents.send('event:state', publicState());
    }
    core = null;
  });

  const up = await waitForPort(LISTEN_PORT);
  if (!up) {
    await stopTunnel();
    return fail('sing-box did not start listening — see the log');
  }

  await enableSystemProxy();
  state.running = true;
  state.activeId = profile.id;
  state.startedAt = Date.now();
  state.message = '';
  window?.webContents.send('event:state', publicState());
  return { ok: true, state: publicState() };
}

async function stopTunnel() {
  if (core) {
    const pid = core.pid;
    try {
      core.kill();
    } catch {
      /* already gone */
    }
    if (process.platform === 'win32' && pid) await run('taskkill', ['/pid', String(pid), '/t', '/f']);
    core = null;
  }
  await restoreSystemProxy().catch(() => {});
  state.running = false;
  state.activeId = '';
  state.startedAt = 0;
  window?.webContents.send('event:state', publicState());
  return { ok: true, state: publicState() };
}

function fail(message) {
  state.message = message;
  log(`error: ${message}`);
  window?.webContents.send('event:state', publicState());
  return { ok: false, error: message, state: publicState() };
}

function publicState() {
  const snapshot = store.read(app);
  return {
    ...state,
    configs: snapshot.configs,
    subscription: snapshot.subscription,
    selected: snapshot.selected,
    listening: LISTEN_PORT,
    coreReady: fs.existsSync(corePath()),
    version: app.getVersion(),
  };
}

/* ------------------------------------------------------------------ ipc */

function register() {
  ipcMain.handle('state:get', () => publicState());

  ipcMain.handle('config:add', async (_event, link) => {
    const profiles = String(link).includes('\n') ? parseSubscription(link) : [parseLink(link)].filter(Boolean);
    if (profiles.length === 0) return { ok: false, error: 'this is not a vless://, trojan:// or ss:// link' };
    let last = null;
    for (const profile of profiles) last = store.addConfig(app, profile).entry;
    return { ok: true, added: profiles.length, entry: last, state: publicState() };
  });

  ipcMain.handle('config:remove', (_event, id) => {
    store.removeConfig(app, id);
    return publicState();
  });

  ipcMain.handle('config:save', (_event, configs) => {
    const snapshot = store.read(app);
    store.write(app, { ...snapshot, configs });
    return publicState();
  });

  ipcMain.handle('subscription:fetch', async (_event, url) => {
    try {
      const response = await fetch(url, { headers: { 'User-Agent': 'ZeusLite/1.0' } });
      if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
      const body = await response.text();
      const profiles = parseSubscription(body);
      if (profiles.length === 0) return { ok: false, error: 'no configs in that subscription' };
      for (const profile of profiles) store.addConfig(app, profile);
      const snapshot = store.read(app);
      store.write(app, { ...snapshot, subscription: url });
      return { ok: true, added: profiles.length, state: publicState() };
    } catch (error) {
      return { ok: false, error: String(error.message || error) };
    }
  });

  ipcMain.handle('tunnel:start', (_event, id) => startTunnel(id));
  ipcMain.handle('tunnel:stop', () => stopTunnel());
  ipcMain.handle('core:ping', async (_event, id) => {
    const profile = store.read(app).configs.find((c) => c.id === id);
    if (!profile) return -1;
    return ping(profile);
  });
  ipcMain.handle('log:get', () => logLines.join('\n'));
  ipcMain.handle('link:open', (_event, url) => shell.openExternal(String(url)));
}

/* ------------------------------------------------------------------ window */

function createWindow() {
  window = new BrowserWindow({
    width: 460,
    height: 780,
    minWidth: 420,
    minHeight: 620,
    backgroundColor: '#07080f',
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0b0e1c', symbolColor: '#c9d4ff', height: 40 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  window.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  window.once('ready-to-show', () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  window.on('closed', () => {
    window = null;
  });
}

app.whenReady().then(() => {
  register();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', async () => {
  await stopTunnel().catch(() => {});
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  stopTunnel().catch(() => {});
});
