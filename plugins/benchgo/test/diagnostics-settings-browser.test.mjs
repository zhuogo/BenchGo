import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sharedUiStyles } from '../scripts/shared-ui.mjs';
import { shellUi } from '../scripts/shell-ui.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
const { chromium } = require('playwright');
const { build } = createRequire(new URL('../package.json', import.meta.url))('esbuild');
const executablePath = [process.env.CHROMIUM_EXECUTABLE_PATH, chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(path => path && existsSync(path));
const screenshots = join(root, 'artifacts/diagnostics-settings');

test('performance diagnostics render every state in both themes and export real observer records', { skip: !executablePath && 'Chromium/Edge required' }, async () => {
  const bundle = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React, {useSyncExternalStore} from 'react'; import {createRoot} from 'react-dom/client';
    import {mountDiagnosticsSettings} from './plugins/benchgo/client/diagnostics-settings.jsx';
    import {SettingsRoot} from './deepseek-harness/packages/client/ui-settings-general/src/client/SettingsRoot.tsx';
    import {GeneralSection} from './deepseek-harness/packages/client/ui-settings-general/src/client/GeneralSection.tsx';
    import {DeveloperToolsRow} from './deepseek-harness/packages/client/ui-settings-general/src/client/DeveloperToolsRow.tsx';
    import {createPerfTrace} from './plugins/shared/client/perf-trace.mjs';
    import hostCss from './plugins/benchgo/client/style.css';
    import tokens from './deepseek-harness/packages/client/ui-theme/src/styles/design-platform.css';
    import base from './deepseek-harness/packages/client/ui-theme/src/styles/base.css'; import focus from './deepseek-harness/packages/client/ui-theme/src/styles/focus.css';
    const mode = new URL(location.href).searchParams.get('mode');
    const bare = { performance, localStorage, navigator, setTimeout: (...args) => window.setTimeout(...args), clearTimeout: id => window.clearTimeout(id), PerformanceObserver: class { static supportedEntryTypes = []; } };
    window.trace = createPerfTrace(mode === 'unsupported' ? bare : window);
    const blocked = mode === 'blocked' ? { save() { throw new Error('download blocked'); }, copy: async () => false } : {};
    let DiagnosticsItem;
    mountDiagnosticsSettings({ effect: run => run(), slots: {
      inject: (name, run) => { window.diagnosticsSlot = name; run(); },
      register: (options, Component) => { window.diagnosticsEntry = options; DiagnosticsItem = Component; },
    } });
    const jank = () => { const end = performance.now() + 260; while (performance.now() < end); };
    const rows = [{id:'general',label:'通用'},{id:'models',label:'模型'},{id:'plugins',label:'插件'}], listeners = new Set();
    let state = {open:true,activeId:'general'};
    const change = patch => { state = {...state,...patch}; listeners.forEach(run => run()); };
    const t = key => ({'developerTools.title':'开发者工具','developerTools.description':'显示开发者工具与预览功能。'}[key] || key);
    const renderSlot = (name, props, filter) => {
      if (name === 'settings.header') return '设置';
      if (name === 'settings.close') return '关闭设置';
      if (name === 'settings.launcher') return <button onClick={() => change({open:true})}>设置</button>;
      if (name === 'settings.section') return filter.only === 'general' ? <GeneralSection renderSlot={renderSlot} /> : <p>其他设置</p>;
      if (name === 'settings.general.item') return <>
        <div data-slot={name}><DeveloperToolsRow useDeveloperTools={select => select(false)} setEnabled={async () => {}} t={t}/></div>
        <div data-slot={name}><DiagnosticsItem trace={window.trace} {...blocked} /></div>
        <button className="jank primary extra" aria-label="触发卡顿" onClick={jank}>private button text</button>
      </>;
      return null;
    };
    const host = {
      wide:true, renderSlot, t, reconnect(){},
      useStore: select => useSyncExternalStore(run => {listeners.add(run);return () => listeners.delete(run);}, () => select(state)),
      actions:{close:() => change({open:false}),open:() => change({open:true}),select:id => change({activeId:id}),openSection:id => change({open:true,activeId:id})},
      useSections: select => select(rows), useConnectionState: select => select('connected'),
      useOnboardingSteps: select => select([]), useSessions: select => select({phase:'ready',byId:{main:{retainedBy:{mainView:1},blank:false}}}),
      useShortcuts: select => select([]),
    };
    createRoot(document.getElementById('root')).render(<><style>{tokens}{base}{focus}{hostCss}</style><SettingsRoot {...host}/></>);
  ` }, bundle: true, write: false, format: 'iife', jsx: 'automatic', nodePaths: [join(root, 'plugins/benchgo/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
  alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')) },
  plugins: [{ name: 'official-primitives-source', setup(build) {
    // Use the pinned official components directly when workspace lib outputs are absent.
    build.onResolve({ filter: /^@deepseek-ai\/dsh-client-ui-primitives$/ }, () => ({ path: 'primitives', namespace: 'official-source' }));
    build.onLoad({ filter: /.*/, namespace: 'official-source' }, () => ({ loader: 'ts', resolveDir: root, contents: `
      export {Tooltip} from './deepseek-harness/packages/client/ui-primitives/src/Tooltip.tsx';
      export {Switch} from './deepseek-harness/packages/client/ui-primitives/src/Switch.tsx';
      export {writeClipboard} from './deepseek-harness/packages/client/ui-primitives/src/clipboard.ts';
      export {ConnectionIndicator} from './deepseek-harness/packages/client/ui-primitives/src/ConnectionIndicator.tsx';
      export {useModalLayer} from './deepseek-harness/packages/client/ui-primitives/src/useModalLayer.ts';
      export * from './deepseek-harness/packages/client/ui-primitives/src/icons/index.tsx';
    ` }));
  } }, shellUi(), sharedUiStyles()], loader: { '.css': 'text', '.module.css': 'local-css' }, define: { 'process.env.NODE_ENV': '"production"' }, outdir: join(root, 'artifacts/unused-diagnostics-settings-test'), logLevel: 'silent' });
  const js = bundle.outputFiles.find(file => file.path.endsWith('.js')).text;
  const moduleCss = bundle.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n');
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
    body{margin:0;font-family:var(--dsw-font-family,Arial,"Microsoft YaHei",sans-serif);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
    ${moduleCss}</style><body><div id="root"></div><script>${js.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
  await mkdir(screenshots, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    for (const [theme, width] of [['light', 1440], ['dark', 1440], ['light', 390], ['dark', 390]]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, acceptDownloads: true });
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(theme => { document.addEventListener('DOMContentLoaded', () => { if (theme === 'dark') document.body.setAttribute('data-ds-dark-theme', ''); }); }, theme);
      await page.route('http://localhost/**', route => route.fulfill({ contentType: 'text/html', body: html }));
      const section = page.getByRole('region', { name: '性能诊断' }), toggle = section.getByRole('switch', { name: '开启性能记录' });
      const disclosure = page.getByRole('button', { name: /^性能诊断/ });
      const shot = async state => {
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${theme}/${width}/${state}: no horizontal overflow`);
        await page.screenshot({ path: join(screenshots, `${theme}-${width}-${state}.png`), fullPage: true });
      };

      await page.goto('http://localhost/?session=secret-token');
      await disclosure.waitFor();
      assert.equal(await page.evaluate(() => window.diagnosticsSlot), 'settings.general.item');
      assert.equal(await page.getByRole('navigation').getByRole('button', {name:'性能诊断'}).count(), 0);
      assert.equal(await disclosure.getAttribute('aria-expanded'), 'false');
      assert.equal(await section.count(), 0, 'diagnostics content is unmounted while collapsed');
      assert.equal(await page.evaluate(() => window.trace.getSnapshot().enabled), false, 'visiting General does not enable recording');
      await shot('collapsed');
      await disclosure.focus(); await page.keyboard.press('Enter');
      await section.getByText('尚未开始记录').waitFor();
      assert.equal(await toggle.getAttribute('aria-checked'), 'false');
      assert.deepEqual(await toggle.evaluate(node => { const box = node.getBoundingClientRect(); return [box.width, box.height]; }), [36, 20], 'the official switch keeps its fixed size');
      await shot('idle');
      await toggle.focus(); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
      assert.equal(await toggle.evaluate(node => node.matches(':focus-visible') && getComputedStyle(node).outlineStyle !== 'none'), true, 'keyboard focus is visible');
      await page.keyboard.press('Space');
      await section.getByText('正在记录，暂未发现卡顿').waitFor();
      assert.equal(await toggle.getAttribute('aria-checked'), 'true');
      await shot('recording');
      await disclosure.click();
      assert.equal(await section.count(), 0);
      assert.match(await disclosure.innerText(), /正在记录/);
      await shot('recording-collapsed');
      await page.getByRole('navigation').getByRole('button', {name:'模型',exact:true}).click();
      await page.getByRole('navigation').getByRole('button', {name:'通用',exact:true}).click();
      assert.equal(await disclosure.getAttribute('aria-expanded'), 'false');
      assert.match(await disclosure.innerText(), /正在记录/, 'recording remains discoverable after changing sections');
      await disclosure.click();

      await page.getByRole('button', { name: '触发卡顿' }).click();
      await page.evaluate(async () => {
        for (const [label, ms] of [['commander:state', 20], ['commander:create', 140], ['assistant:send', 60]]) { const done = window.trace.time(label); await new Promise(resolve => setTimeout(resolve, ms)); done(); }
      });
      await page.waitForFunction(() => { const { frames, interactions, labels } = window.trace.getSnapshot().summary; return frames.count > 0 && interactions.count > 0 && labels['assistant:send']; });
      assert.match(await section.locator('dl').innerText(), /(长帧|长任务)\s+\d+ 次\s+最长 [\d.]+ (毫秒|秒)\s+慢交互\s+\d+ 次\s+最慢 [\d.]+ (毫秒|秒)/);
      assert.equal(await section.locator('tbody tr').count(), 3);
      const [download] = await Promise.all([page.waitForEvent('download'), section.getByRole('button', { name: '导出记录' }).click()]);
      assert.match(download.suggestedFilename(), /^benchgo-perf-\d{4}(-\d\d){5}\.json$/);
      await section.getByText(`已导出 ${download.suggestedFilename()}`).waitFor();
      await shot('data');
      const text = await readFile(await download.path(), 'utf8'), record = JSON.parse(text);
      for (const leaked of ['secret-token', 'session=', 'private button text']) assert.equal(text.includes(leaked), false, leaked);
      assert.equal(record.version, 1); assert.deepEqual(record.viewport, { width, height: 900 }); assert(record.timeOrigin > 0);
      assert.equal(record.summary.interactions.count, 1, 'one click is one slow interaction');
      const frame = record.entries.find(entry => entry.kind === record.summary.frames.type && entry.duration >= 200);
      assert(frame, 'the blocking handler is recorded as a long frame or task');
      if (frame.kind === 'long-animation-frame') assert(frame.scripts.length > 0 && frame.scripts.length <= 3 && frame.scripts.every(script => !/[?=]/.test(script.sourceFile + script.invoker)), JSON.stringify(frame.scripts));
      const click = record.entries.find(entry => entry.kind === 'event' && entry.name === 'click');
      assert.equal(click.target, 'button.jank.primary[触发卡顿]'); assert(click.duration >= 200 && click.interactionId > 0);
      assert.deepEqual(record.entries.filter(entry => entry.kind === 'time').map(entry => entry.label), ['commander:create', 'assistant:send']);

      await page.reload(); await disclosure.waitFor();
      assert.equal(await disclosure.getAttribute('aria-expanded'), 'false');
      assert.match(await disclosure.innerText(), /正在记录/, 'persisted recording is visible before expanding');
      await disclosure.click(); await toggle.waitFor();
      assert.equal(await toggle.getAttribute('aria-checked'), 'true', 'the switch survives a reload');
      assert.deepEqual(await page.evaluate(() => { const record = window.trace.export(); return [record.summary.interactions.count, Object.keys(record.summary.labels).length]; }), [0, 0], 'records live in memory only');

      await page.goto('http://localhost/?mode=unsupported');
      await disclosure.click();
      await section.getByText('当前环境无法观察：长帧与长任务、慢交互、窗口切换。其余项目照常记录。').waitFor();
      await shot('unsupported');
      await page.goto('http://localhost/?mode=blocked');
      await disclosure.click();
      await page.evaluate(() => window.trace.time('commander:state')());
      await section.getByRole('button', { name: '导出记录' }).click();
      await section.getByRole('alert').filter({ hasText: '导出失败：下载与剪贴板均不可用（download blocked）。请重试。' }).waitFor();
      await shot('error');
      await section.getByRole('button', { name: '清空记录' }).click(); await toggle.click();
      await section.getByText('尚未开始记录').waitFor();
      assert.equal(await page.evaluate(() => localStorage.getItem('benchgo.perf.trace')), null);
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally { await browser.close(); }
});
