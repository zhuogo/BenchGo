import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sharedUiStyles } from '../../base/scripts/shared-ui.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
const { chromium } = require('playwright');
const { build } = createRequire(new URL('../../base/package.json', import.meta.url))('esbuild');
const executablePath = [process.env.CHROMIUM_EXECUTABLE_PATH, chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(path => path && existsSync(path));
const screenshots = process.env.BENCHGO_STUDIO_SCREENSHOTS;

test('sound bell reports browser permission, previews on enable and preserves mute', { skip: !executablePath && 'Chromium/Edge required' }, async () => {
  const bundle = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {NotificationSoundToggle} from './plugins/superagent/client/notification-sound.jsx';
    import {createNotificationSound} from './plugins/superagent/client/notification-sound.mjs';
    import css from './plugins/superagent/client/style.css';
    const mode = new URL(location.href).searchParams.get('mode');
    const NativeAudio = window.AudioContext;
    window.playCount = 0;
    class Audio extends NativeAudio { createOscillator() { window.playCount++; return super.createOscillator(); } }
    class SlowAudio extends Audio { async resume() { await new Promise(resolve => { window.finishUnlock = resolve; }); return super.resume(); } }
    class ErrorAudio extends Audio { async resume() { if (!window.allowAudio) throw Error('测试浏览器拒绝播放'); return super.resume(); } }
    window.sound = createNotificationSound({ AudioContext: mode === 'error' ? ErrorAudio : mode === 'slow' ? SlowAudio : Audio, localStorage, performance, setTimeout: (...args) => window.setTimeout(...args), clearTimeout: (...args) => window.clearTimeout(...args) });
    createRoot(document.getElementById('root')).render(<div className="ba-root"><style>{css}</style><main className="ba-studio-body">
      <header className="ba-studio-heading"><div className="ba-studio-heading-main"><div className="ba-studio-heading-row"><h1>身份</h1><NotificationSoundToggle sound={window.sound}/></div></div></header>
      <label className="ba-field"><span>名字</span><input defaultValue="BenchGo" /></label>
    </main></div>);
  ` }, bundle: true, write: false, format: 'iife', jsx: 'automatic', nodePaths: [join(root, 'plugins/base/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')], alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')) }, plugins: [sharedUiStyles()], loader: { '.css': 'text', '.module.css': 'local-css' }, outdir: join(root, 'artifacts/unused-notification-sound-test') });
  const js = bundle.outputFiles.find(file => file.path.endsWith('.js')).text;
  const moduleCss = bundle.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n');
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>
    :root{font-family:Arial,"Microsoft YaHei",sans-serif;--dsw-alias-bg-base:#fff;--dsw-alias-label-primary:#202124;--dsw-alias-label-secondary:#6b6b70;--dsw-alias-border-l3:#d4d5d9;--dsw-alias-brand-primary:#315be8;--dsw-alias-label-primary-foreground:#fff;--dsw-alias-switch-thumb:#fff;--dsw-alias-state-business-primary:#315be8}
    :root[data-theme=dark]{color-scheme:dark;--dsw-alias-bg-base:#19191b;--dsw-alias-label-primary:#ededee;--dsw-alias-label-secondary:#a3a3a8;--dsw-alias-border-l3:#48484d;--dsw-alias-brand-primary:#6d85ff;--dsw-alias-state-business-primary:#6d85ff}
    body{margin:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}#root{max-width:980px;margin:auto}.ba-root{min-height:100vh}.ba-studio-body{box-sizing:border-box}
    ${moduleCss}</style><body><div id="root"></div><script>${js.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath, args: ['--autoplay-policy=user-gesture-required'] });
  try {
    for (const theme of ['light', 'dark']) for (const width of [1440, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce', colorScheme: theme });
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(theme => { document.addEventListener('DOMContentLoaded', () => { document.documentElement.dataset.theme = theme; }); }, theme);
      await page.route('http://localhost/**', route => route.fulfill({ contentType: 'text/html', body: html }));
      const toggle = page.getByRole('button', { name: '回复提示音' });
      const status = text => page.getByRole('status').filter({ hasText: text }).waitFor();
      const shot = async state => {
        const bounds = await toggle.evaluate(button => {
          const row = button.closest('.ba-studio-heading-row'), heading = row.querySelector('h1');
          const r = row.getBoundingClientRect(), h = heading.getBoundingClientRect(), b = button.getBoundingClientRect();
          const slash = getComputedStyle(button.querySelector('.ba-sound-slash'));
          return { right: r.right - b.right, center: Math.abs((h.top + h.bottom - b.top - b.bottom) / 2),
            width: b.width, overflow: document.documentElement.scrollWidth > innerWidth, duration: slash.transitionDuration, slash: slash.opacity };
        });
        assert(bounds.width >= 36 && Math.abs(bounds.right) <= 1 && bounds.center <= 1, JSON.stringify(bounds));
        assert.equal(bounds.overflow, false);
        assert.equal(bounds.duration, '0s');
        assert.equal(bounds.slash, state === 'muted' ? '1' : '0');
        if (screenshots) await page.screenshot({ path: join(screenshots, `sound-${theme}-${width}-${state}.png`) });
      };
      await page.goto('http://localhost/');
      await status('等待浏览器允许播放');
      assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
      assert.equal(await page.evaluate(() => window.sound.notify(['before-interaction'])), false);
      await shot('locked');
      await toggle.click();
      assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
      await page.reload(); await status('已静音');
      assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
      assert.equal(await page.evaluate(() => window.sound.notify(['muted'])), false); await shot('muted');
      await toggle.press('Enter'); await status(/^已开启$/);
      await page.waitForFunction(() => window.playCount === 1); await shot('ready');
      await page.goto('http://localhost/?mode=slow');
      assert.equal(await toggle.getAttribute('aria-pressed'), 'true', 're-enabling also persists');
      await toggle.click(); await toggle.click(); await status('正在启用'); await shot('unlocking');
      await toggle.click(); await status('已静音');
      await toggle.click(); await status('正在启用');
      await page.evaluate(() => window.finishUnlock());
      await status(/^已开启$/);
      await page.waitForFunction(() => window.playCount === 1);
      await page.goto('http://localhost/?mode=error'); await toggle.click(); await toggle.click();
      await status('测试浏览器拒绝播放');
      assert.equal(await page.evaluate(() => window.playCount), 0);
      await shot('error');
      await page.evaluate(() => { window.allowAudio = true; });
      await toggle.click(); await toggle.click();
      await status(/^已开启$/);
      await page.waitForFunction(() => window.playCount === 1);
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally { await browser.close(); }
});
