import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sharedUiStyles } from '../../benchgo/scripts/shared-ui.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
const { chromium } = require('playwright');
const { build } = createRequire(new URL('../../benchgo/package.json', import.meta.url))('esbuild');
const executablePath = [process.env.CHROMIUM_EXECUTABLE_PATH, chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(path => path && existsSync(path));
const screenshots = join(root, 'artifacts/notification-sound-ui-fix');

test('official sound switch fits the identity panel in every audio state, theme and viewport and preserves mute', { skip: !executablePath && 'Chromium/Edge required' }, async () => {
  const bundle = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {NotificationSoundSettings} from './plugins/superagent/client/notification-sound.jsx';
    import {createNotificationSound} from './plugins/superagent/client/notification-sound.mjs';
    import css from './plugins/superagent/client/style.css';
    const mode = new URL(location.href).searchParams.get('mode');
    const NativeAudio = window.AudioContext;
    window.playCount = 0;
    class Audio extends NativeAudio { createOscillator() { window.playCount++; return super.createOscillator(); } }
    class SlowAudio extends Audio { async resume() { await new Promise(resolve => { window.finishUnlock = resolve; }); return super.resume(); } }
    class ErrorAudio extends Audio { async resume() { throw Error('测试浏览器拒绝播放'); } }
    window.sound = createNotificationSound({ AudioContext: mode === 'error' ? ErrorAudio : mode === 'slow' ? SlowAudio : Audio, localStorage, performance, setTimeout: (...args) => window.setTimeout(...args), clearTimeout: (...args) => window.clearTimeout(...args) });
    createRoot(document.getElementById('root')).render(<div className="ba-root"><style>{css}</style><main className="ba-studio-body">
      <header className="ba-studio-heading"><h1>身份与形象</h1><p>设置助手的称呼、名片和消息体验。</p></header>
      <div className="ba-identity-pane"><div className="ba-identity-panel" data-tab="info">
        <section className="ba-identity-info">
          <div className="ba-identity-name"><div className="ba-settings-section-heading"><h2>如何称呼你的助手</h2><p>这个名字会显示在名片和对话中。</p></div><label className="ba-field"><span>名字</span><input aria-label="名字" defaultValue="BenchGo" /></label></div>
          <div className="ba-settings-section-heading"><h2>名片</h2><p>在聊天中展示助手的名字和简介。</p><label className="ba-field"><span>简介</span><textarea aria-label="简介" defaultValue="一起把事情做好。" rows={2} /></label></div>
        </section><NotificationSoundSettings sound={window.sound}/>
      </div></div></main></div>);
  ` }, bundle: true, write: false, format: 'iife', jsx: 'automatic', nodePaths: [join(root, 'plugins/benchgo/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')], alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')) }, plugins: [sharedUiStyles()], loader: { '.css': 'text', '.module.css': 'local-css' }, outdir: join(root, 'artifacts/unused-notification-sound-test') });
  const js = bundle.outputFiles.find(file => file.path.endsWith('.js')).text;
  const moduleCss = bundle.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n');
  assert.match(moduleCss, /width: 36px/, 'the official Switch CSS module must be emitted and loaded');
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>
    :root{font-family:Arial,"Microsoft YaHei",sans-serif;--dsw-alias-bg-base:#fff;--dsw-alias-label-primary:#202124;--dsw-alias-label-secondary:#6b6b70;--dsw-alias-border-l3:#d4d5d9;--dsw-alias-brand-primary:#315be8;--dsw-alias-label-primary-foreground:#fff;--dsw-alias-switch-thumb:#fff;--dsw-alias-state-business-primary:#315be8}
    :root[data-theme=dark]{color-scheme:dark;--dsw-alias-bg-base:#19191b;--dsw-alias-label-primary:#ededee;--dsw-alias-label-secondary:#a3a3a8;--dsw-alias-border-l3:#48484d;--dsw-alias-brand-primary:#6d85ff;--dsw-alias-state-business-primary:#6d85ff}
    body{margin:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}#root{max-width:980px;margin:auto}.ba-root{min-height:100vh}.ba-studio-body{box-sizing:border-box}
    ${moduleCss}</style><body><div id="root"></div><script>${js.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
  await mkdir(screenshots, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath, args: ['--autoplay-policy=user-gesture-required'] });
  try {
    for (const theme of ['light', 'dark']) for (const width of [1440, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce', colorScheme: theme });
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(theme => { document.addEventListener('DOMContentLoaded', () => { document.documentElement.dataset.theme = theme; }); }, theme);
      await page.route('http://localhost/**', route => route.fulfill({ contentType: 'text/html', body: html }));
      const sound = page.getByRole('region', { name: '回复提示音' });
      const toggle = sound.getByRole('switch', { name: '播放提示音' });
      const preview = sound.getByRole('button', { name: '试听提示音' });
      const shot = async state => {
        const bounds = await sound.evaluate(section => {
          const row = section.querySelector('.ba-notification-sound-row'), copy = section.querySelector('.ba-notification-sound-copy');
          const control = section.querySelector('[role=switch]'), footer = section.querySelector('.ba-notification-sound-footer');
          const r = row.getBoundingClientRect(), c = copy.getBoundingClientRect(), s = control.getBoundingClientRect(), f = footer.getBoundingClientRect();
          return { rowWidth:r.width, switchWidth:s.width, switchHeight:s.height, right:r.right-s.right, gap:s.left-c.right,
            center:Math.abs((s.top+s.bottom-r.top-r.bottom)/2), footerLeft:Math.abs(f.left-r.left), input:section.querySelectorAll('input[type=checkbox]').length,
            overflow:document.documentElement.scrollWidth>innerWidth || section.scrollWidth>section.clientWidth, thumbWidth:control.firstElementChild.getBoundingClientRect().width };
        });
        assert.equal(bounds.switchWidth, 36, `${theme}/${width}/${state}: fixed official switch width`);
        assert.equal(bounds.switchHeight, 20); assert.equal(bounds.thumbWidth, 16);
        assert(bounds.switchWidth < bounds.rowWidth / 4, 'switch must not expand across the row');
        assert(bounds.right <= 1 && bounds.right >= -1 && bounds.gap >= 10 && bounds.center <= 1 && bounds.footerLeft <= 1, JSON.stringify(bounds));
        assert.equal(bounds.input, 0); assert.equal(bounds.overflow, false);
        await page.screenshot({ path: join(screenshots, `${theme}-${width}-${state}.png`), fullPage: true });
      };
      await page.goto('http://localhost/');
      await sound.getByRole('status').filter({ hasText: '点击试听' }).waitFor();
      assert.equal(await toggle.getAttribute('aria-checked'), 'true');
      assert.equal(await page.evaluate(() => window.sound.notify(['before-interaction'])), false);
      await shot('locked');
      await preview.click();
      await sound.getByRole('status').filter({ hasText: '已开启' }).waitFor();
      await page.waitForFunction(() => window.playCount === 1); await shot('ready');
      await toggle.click();
      assert.equal(await toggle.getAttribute('aria-checked'), 'false');
      await page.reload(); await sound.getByRole('status').filter({ hasText: '已静音' }).waitFor();
      assert.equal(await toggle.getAttribute('aria-checked'), 'false'); assert.equal(await preview.isDisabled(), true);
      assert.equal(await page.evaluate(() => window.sound.notify(['muted'])), false); await shot('muted');
      await toggle.click(); await sound.getByRole('status').filter({ hasText: '已开启' }).waitFor();
      await page.goto('http://localhost/?mode=slow');
      assert.equal(await toggle.getAttribute('aria-checked'), 'true', 're-enabling also persists');
      await preview.click(); await sound.getByRole('status').filter({ hasText: '正在启用' }).waitFor();
      assert.equal(await preview.isDisabled(), true); await shot('unlocking');
      await page.evaluate(() => window.finishUnlock());
      await sound.getByRole('status').filter({ hasText: '已开启' }).waitFor();
      await page.waitForFunction(() => window.playCount === 1);
      await page.goto('http://localhost/?mode=error'); await preview.click();
      await sound.getByRole('alert').filter({ hasText: '测试浏览器拒绝播放' }).waitFor();
      assert.equal(await page.evaluate(() => window.playCount), 0); assert.equal(await preview.isDisabled(), false);
      await shot('error'); assert.deepEqual(errors, []);
      await context.close();
    }
  } finally { await browser.close(); }
});
