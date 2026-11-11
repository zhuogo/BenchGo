import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const STARTUP_STAGES = new Set(['started', 'splash-visible', 'enrollment-ready', 'shell-loading', 'shell-loaded', 'host-starting', 'host-ready', 'host-connected', 'welcome-state-ready', 'workspace-visible', 'workspace-ready', 'failed']);
const STARTUP_LABELS = { 'splash-visible': '正在准备插件…', 'enrollment-ready': '正在载入工作台…', 'shell-loading': '正在载入工作台…', 'shell-loaded': '正在启动服务…', 'host-starting': '正在启动服务…', 'host-ready': '正在连接工作台…', 'host-connected': '正在读取设置…', 'welcome-state-ready': '正在打开工作台…' };

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

/** A local, sandboxed splash shown before the official backend starts. */
export async function openStartupWindow({ app, BrowserWindow, nativeImage, nativeTheme, page, iconPath }) {
  const icon = iconPath && nativeImage ? nativeImage.createFromPath(iconPath) : undefined;
  const background = () => nativeTheme?.shouldUseDarkColors ? '#19191b' : '#ffffff';
  const window = new BrowserWindow({
    width: 420, height: 300, useContentSize: true, center: true,
    frame: false, resizable: false, maximizable: false, fullscreenable: false,
    show: false, backgroundColor: background(), title: 'BenchGo',
    ...(icon && !icon.isEmpty() ? { icon } : {}),
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
  });
  const updateTheme = () => { if (!window.isDestroyed()) window.setBackgroundColor(background()); };
  nativeTheme?.on('updated', updateTheme);
  const waiting = new Map();
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    nativeTheme?.removeListener('updated', updateTheme);
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
    const label = STARTUP_LABELS[stage];
    if (disposed || window.isDestroyed() || !label) return;
    // Only fixed presentation strings reach our local sandboxed document.
    void window.webContents.executeJavaScript(`(() => { const status = document.getElementById('startup-status'); if (status) { status.dataset.phase = ${JSON.stringify(stage)}; status.textContent = ${JSON.stringify(label)}; } })()`).catch(() => {});
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
  try {
    await window.loadFile(page);
    if (!disposed && !window.isDestroyed()) window.show();
  } catch (error) {
    // Presentation failure must not prevent the official application from starting.
    dispose();
    console.warn('Startup card unavailable:', error.message);
  }
  return dispose;
}
