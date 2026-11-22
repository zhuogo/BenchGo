import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const STARTUP_STAGES = new Set(['started', 'splash-visible', 'enrollment-ready', 'shell-loading', 'shell-loaded', 'host-starting', 'host-ready', 'host-connected', 'welcome-state-ready', 'workspace-visible', 'workspace-ready', 'failed']);
const STARTUP_LABELS = {
  'enrollment-ready': '正在载入工作台…',
  'host-starting': '正在启动服务…',
  'host-ready': '正在连接工作台…',
  'host-connected': '正在读取设置…',
  'welcome-state-ready': '正在打开工作台…',
};
const STARTUP_PHASES = Object.keys(STARTUP_LABELS);

/** Keep the official welcome controls over the same theme color as the renderer. */
export function createWelcomeWindow({ BrowserWindow, nativeTheme, platform, options }) {
  const { vibrancy, visualEffectState, backgroundMaterial, ...windowOptions } = options;
  const background = () => nativeTheme.shouldUseDarkColors ? '#101218' : '#f3f6f6';
  const titleBarOverlay = () => ({
    ...options.titleBarOverlay,
    symbolColor: nativeTheme.shouldUseDarkColors ? '#eef5f6' : '#161c23',
  });
  const window = new BrowserWindow({
    ...windowOptions,
    hasShadow: false,
    backgroundColor: background(),
    ...(platform === 'win32' ? { thickFrame: false, accentColor: false, titleBarOverlay: titleBarOverlay() } : {}),
  });
  const updateTheme = () => {
    window.setBackgroundColor(background());
    if (platform === 'win32') window.setTitleBarOverlay(titleBarOverlay());
  };
  nativeTheme.on('updated', updateTheme);
  window.once('closed', () => nativeTheme.removeListener('updated', updateTheme));
  return window;
}

/** Keep one bounded, local startup record; diagnostic I/O must never gate startup. */
export function createStartupTiming(directory, { now = () => performance.now(), startedAt = new Date().toISOString() } = {}) {
  const start = now(), stages = [], seen = new Set();
  let finished = false, writes = Promise.resolve();
  const persist = () => {
    const value = JSON.stringify({ startedAt, pid: process.pid, status: finished ? stages.at(-1).stage : 'starting', elapsedMs: stages.at(-1).elapsedMs, stages }, null, 2);
    writes = writes.then(async () => { await mkdir(directory, { recursive: true }); await writeFile(join(directory, 'benchgo-startup.json'), value, { mode: 0o600 }); }).catch(() => {});
  };
  const mark = stage => {
    if (finished || !STARTUP_STAGES.has(stage) || seen.has(stage)) return;
    seen.add(stage);
    const elapsedMs = Math.max(0, Math.round(now() - start));
    stages.push({ stage, elapsedMs, durationMs: elapsedMs - (stages.at(-1)?.elapsedMs ?? 0) });
    persist();
  };
  mark('started');
  return {
    mark,
    finish(stage = 'workspace-ready') {
      if (finished || !['workspace-ready', 'failed'].includes(stage)) return;
      mark(stage); finished = true; persist();
    },
    flush: () => writes,
  };
}

/** Start a local sandboxed splash without waiting for Chromium; return its cleanup handle. */
export async function openStartupWindow({ app, BrowserWindow, nativeImage, page, iconPath, onVisible }) {
  const icon = iconPath && nativeImage ? nativeImage.createFromPath(iconPath) : undefined;
  const window = new BrowserWindow({
    width: 420, height: 300, useContentSize: true, center: true,
    frame: false, resizable: false, maximizable: false, fullscreenable: false,
    show: false, transparent: true, hasShadow: false, title: 'BenchGo',
    ...(icon && !icon.isEmpty() ? { icon } : {}),
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
  });
  const waiting = new Map();
  let disposed = false, loaded = false, phase = -1;
  const sendStage = () => {
    const stage = STARTUP_PHASES[phase];
    if (!stage) return;
    const detail = JSON.stringify({ stage, label: STARTUP_LABELS[stage] });
    // Only fixed presentation strings reach our local sandboxed document.
    void window.webContents.executeJavaScript(`window.dispatchEvent(new CustomEvent('benchgo-startup-stage', { detail: ${detail} }))`).catch(() => {});
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    app.removeListener('browser-window-created', observe);
    app.removeListener('will-quit', dispose);
    for (const [other, shown] of waiting) {
      other.removeListener('show', shown);
      other.removeListener('closed', shown);
    }
    waiting.clear();
    if (!window.isDestroyed()) window.destroy();
  };
  dispose.setStage = stage => {
    const next = STARTUP_PHASES.indexOf(stage);
    if (disposed || window.isDestroyed() || next <= phase) return;
    phase = next;
    if (loaded) sendStage();
  };
  const observe = (_event, other) => {
    const shown = () => {
      if (!other.isDestroyed() && other.isVisible()) dispose();
      else {
        other.removeListener('show', shown);
        other.removeListener('closed', shown);
        waiting.delete(other);
      }
    };
    waiting.set(other, shown);
    other.once('show', shown);
    other.once('closed', shown);
  };
  app.on('browser-window-created', observe);
  app.once('will-quit', dispose);
  window.once('closed', () => {
    const userClosed = !disposed;
    dispose();
    if (userClosed) app.quit();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.once('render-process-gone', dispose);
  const unavailable = error => {
    // Presentation failure must not prevent the official application from starting.
    dispose();
    console.warn('Startup window unavailable:', error.message);
  };
  try {
    // Chromium may take seconds to start on a cold machine. Return the cleanup
    // handle now so enrollment and the Host can prepare while this page loads.
    void window.loadFile(page).then(() => {
      loaded = true;
      if (disposed || window.isDestroyed()) return;
      window.show();
      onVisible?.();
      sendStage();
    }, unavailable).catch(unavailable);
  } catch (error) { unavailable(error); }
  return dispose;
}
