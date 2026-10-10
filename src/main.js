const { app, BrowserWindow, ipcMain, Menu, nativeImage, Tray } = require('electron');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const path = require('node:path');

const bridgePath = path.join(__dirname, 'media-session.ps1');   // old one-shot script, kept as a fallback
const daemonPath = path.join(__dirname, 'media-daemon.ps1');    // long-running script
const windowsPowerShell = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];

let mainWindow;
let tray;
let isQuitting = false;

function settingsPath() { return path.join(app.getPath('userData'), 'widget-settings.json'); }
function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')); }
  catch { return { alwaysOnTop: true }; }
}
function writeSettings(next) {
  try { fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2)); }
  catch { /* The widget remains usable if settings cannot be written. */ }
}
function trayImage() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
    <rect x="2" y="7" width="28" height="19" rx="4" fill="#25252a" stroke="#d17a58"/>
    <circle cx="11" cy="17" r="5" fill="#d8d1c2"/><circle cx="21" cy="17" r="5" fill="#d8d1c2"/>
    <circle cx="11" cy="17" r="1.8" fill="#24252a"/><circle cx="21" cy="17" r="1.8" fill="#24252a"/>
  </svg>`;
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ */
/* Fallback artwork (iTunes). Returns a data URL so the renderer can   */
/* both paint it and read its colours. Only successes are cached.      */
/* ------------------------------------------------------------------ */

const artworkCache = new Map();

async function findArtwork(title, artist) {
  const key = `${title}|${artist}`.toLocaleLowerCase();
  if (artworkCache.has(key)) return artworkCache.get(key);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const query = new URLSearchParams({ term: `${title} ${artist}`, entity: 'song', limit: '5' });
    const response = await fetch(`https://itunes.apple.com/search?${query}`, { signal: controller.signal });
    if (!response.ok) return null;
    const payload = await response.json();
    const expectedArtist = artist.toLocaleLowerCase();
    const result = payload.results?.find((item) => item.artistName?.toLocaleLowerCase() === expectedArtist) || payload.results?.[0];
    const url = result?.artworkUrl100?.replace('100x100bb', '300x300bb');   // the label art is small; 300px is plenty
    if (!url) return null;
    const image = await fetch(url, { signal: controller.signal });
    if (!image.ok) return null;
    const type = image.headers.get('content-type') || 'image/jpeg';
    const dataUrl = `data:${type};base64,${Buffer.from(await image.arrayBuffer()).toString('base64')}`;
    artworkCache.set(key, dataUrl);
    if (artworkCache.size > 40) artworkCache.delete(artworkCache.keys().next().value);
    return dataUrl;
  } catch { return null; }
  finally { clearTimeout(timeout); }
}

/* ------------------------------------------------------------------ */
/* Old one-shot bridge (fallback only, used if the daemon is down)     */
/* ------------------------------------------------------------------ */

function runBridge(action = 'snapshot') {
  return new Promise((resolve, reject) => {
    const child = spawn(windowsPowerShell, [...POWERSHELL_ARGS, '-File', bridgePath, '-Action', action], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(stderr || `Media bridge exited with ${code}`));
      try { resolve(JSON.parse(stdout.trim())); }
      catch { reject(new Error(stderr || 'The media bridge returned unreadable data.')); }
    });
  });
}

async function legacySnapshot() {
  const data = await runBridge();
  if (data.ok && data.active && !data.artwork) data.artwork = await findArtwork(data.title, data.artist);
  return data;
}

/* ------------------------------------------------------------------ */
/* Media daemon: one PowerShell process, started once                  */
/* ------------------------------------------------------------------ */

let daemon = null;
let daemonReady = false;          // true after the first state line arrives
let daemonBuffer = '';
let restartTimer = null;
let latest = { ok: true, active: false };

let daemonFailures = 0;           // quick crashes in a row; after 3 we stop restarting and use the one-shot script

function startDaemon() {
  if (isQuitting || daemon) return;
  if (!fs.existsSync(daemonPath)) return;   // script not installed: stay on the one-shot script
  const startedAt = Date.now();
  const child = spawn(windowsPowerShell, [...POWERSHELL_ARGS, '-File', daemonPath], { windowsHide: true });
  daemon = child;
  daemonReady = false;
  daemonBuffer = '';
  let gone = false;

  const onGone = () => {
    if (gone) return;
    gone = true;
    if (daemon === child) { daemon = null; daemonReady = false; }
    daemonFailures = Date.now() - startedAt < 5000 ? daemonFailures + 1 : 0;
    if (!isQuitting && daemonFailures < 3) restartTimer = setTimeout(startDaemon, 2000);
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', onDaemonData);
  child.stderr.on('data', () => { /* drain */ });
  child.stdin.on('error', () => { /* daemon went away; onGone handles it */ });
  child.on('error', onGone);
  child.on('close', onGone);
}

function onDaemonData(chunk) {
  daemonBuffer += chunk;
  let index;
  while ((index = daemonBuffer.indexOf('\n')) >= 0) {
    const line = daemonBuffer.slice(0, index).trim();
    daemonBuffer = daemonBuffer.slice(index + 1);
    if (line) handleDaemonLine(line);
  }
}

function handleDaemonLine(line) {
  let message;
  try { message = JSON.parse(line); } catch { return; }

  if (message.type === 'art') {
    // Windows' own thumbnail always wins when it arrives.
    if (message.artwork && message.key === latest.key) latest.artwork = message.artwork;
    return;
  }
  if (message.type !== 'state') return;

  daemonReady = true;
  const sameTrack = Boolean(message.key) && message.key === latest.key;
  const artwork = sameTrack ? latest.artwork : undefined;
  latest = message;
  if (artwork) latest.artwork = artwork;
  if (message.active && !sameTrack) scheduleFallbackArtwork(message);
}

// If Windows has not supplied a thumbnail shortly after a track change, look one up online.
// This runs in the background and never delays the title.
const lookupsInFlight = new Set();
function scheduleFallbackArtwork(track) {
  const key = track.key;
  setTimeout(async () => {
    if (latest.key !== key || latest.artwork || lookupsInFlight.has(key)) return;
    lookupsInFlight.add(key);
    const artwork = await findArtwork(track.title, track.artist);
    lookupsInFlight.delete(key);
    if (artwork && latest.key === key && !latest.artwork) latest.artwork = artwork;
  }, 1200);
}

async function snapshot() {
  if (daemon && daemonReady) return latest;   // instant, no process spawn
  return legacySnapshot();                    // daemon starting, missing or crashed: old one-shot script
}

async function sendCommand(action) {
  if (daemon && daemonReady) {
    try {
      daemon.stdin.write(`${action}\n`);
      await sleep(350);    // give the daemon one tick to apply it and publish the new state
      return { ok: true };
    } catch { /* fall through to the one-shot script */ }
  }
  return runBridge(action);
}

async function sendSeek(seconds) {
  const value = Math.floor(Number(seconds));
  if (!Number.isFinite(value) || value < 0) return { ok: false, error: 'Invalid position.' };
  if (!(daemon && daemonReady)) return { ok: false, error: 'Seeking needs the media daemon.' };
  try { daemon.stdin.write(`seek ${value}\n`); return { ok: true }; }
  catch (error) { return { ok: false, error: error.message }; }
}

/* ------------------------------------------------------------------ */
/* Window, tray                                                         */
/* ------------------------------------------------------------------ */

function createWindow() {
  const settings = readSettings();
  mainWindow = new BrowserWindow({
    width: settings.bounds?.width || 410,
    height: settings.bounds?.height || 525,
    x: settings.bounds?.x, y: settings.bounds?.y,
    minWidth: 355,
    minHeight: 450,
    maxWidth: 560,
    maxHeight: 680,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: settings.alwaysOnTop !== false,
    skipTaskbar: true,
    show: false,
    title: 'Cassette Widget',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.setAlwaysOnTop(settings.alwaysOnTop !== false, 'floating');
  mainWindow.loadFile(path.join(__dirname, '..', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', (event) => {
    if (!isQuitting) { event.preventDefault(); mainWindow.hide(); }
  });
  mainWindow.on('resize', () => saveWindowState());
  mainWindow.on('move', () => saveWindowState());
}

let saveTimer = null;
function saveWindowState() {
  // debounced: dragging the widget fires this many times per second
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
    writeSettings({ ...readSettings(), bounds: mainWindow.getBounds() });
  }, 400);
}

function toggleWidget() {
  if (!mainWindow) return;
  if (mainWindow.isVisible()) mainWindow.hide();
  else { mainWindow.show(); mainWindow.focus(); }
}

function createTray() {
  tray = new Tray(trayImage());
  tray.setToolTip('Cassette Widget');
  tray.on('click', toggleWidget);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show / hide widget', click: toggleWidget },
    { type: 'separator' },
    { label: 'Quit Cassette Widget', click: () => { isQuitting = true; app.quit(); } },
  ]));
}

/* ------------------------------------------------------------------ */
/* Start-up (single instance only)                                      */
/* ------------------------------------------------------------------ */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('com.cassettewidget.app');
    startDaemon();
    ipcMain.handle('media:snapshot', async () => {
      try { return await snapshot(); }
      catch (error) { return { ok: false, active: false, error: error.message }; }
    });
    ipcMain.handle('media:command', async (_, action) => {
      const supported = new Set(['toggle', 'next', 'previous']);
      if (!supported.has(action)) return { ok: false, error: 'Unsupported command.' };
      try { return await sendCommand(action); }
      catch (error) { return { ok: false, error: error.message }; }
    });
    ipcMain.handle('media:seek', async (_, seconds) => sendSeek(seconds));
    // Click-through: the renderer tells us when the pointer is over the cassette / buttons (false)
    // or over the transparent part of the window (true, clicks fall through to whatever is behind).
    ipcMain.on('window:set-ignore-mouse', (_, ignore) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (ignore) mainWindow.setIgnoreMouseEvents(true, { forward: true });
      else mainWindow.setIgnoreMouseEvents(false);
    });
    // Dragging is done by the renderer (the old whole-window drag region blocked click-through).
    ipcMain.on('window:drag-by', (_, dx, dy) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const bounds = mainWindow.getBounds();
      mainWindow.setBounds({ x: bounds.x + Math.round(dx), y: bounds.y + Math.round(dy), width: bounds.width, height: bounds.height });
    });
    ipcMain.on('window:minimize', () => mainWindow?.hide());
    ipcMain.on('window:close', () => mainWindow?.hide());
    ipcMain.handle('window:toggle-pin', () => {
      const next = !mainWindow.isAlwaysOnTop();
      mainWindow.setAlwaysOnTop(next, 'floating');
      writeSettings({ ...readSettings(), alwaysOnTop: next });
      return next;
    });
    ipcMain.handle('window:widget-state', () => ({ pinned: mainWindow?.isAlwaysOnTop() ?? true }));
    createWindow();
    createTray();
  });

  app.on('before-quit', () => {
    isQuitting = true;
    clearTimeout(restartTimer);
    if (daemon) daemon.kill();
  });
}