import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { sharedUiStyles } from '../scripts/shared-ui.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
const { chromium } = require('playwright');
const executablePath = [process.env.CHROMIUM_EXECUTABLE_PATH, chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(value => value && existsSync(value));
const screenshots = join(root, 'artifacts/unified-updates');
let fixturePromise;

// Only the host boundary is synthetic. Modal, tooltip, picker, information dialog and
// UpdateLauncher use their production implementations and shared theme sheets.
// The compile-time location adapter models the Desktop-owned local origin;
// ordinary HTTPS cases retain a remote identity even when a bridge is present.
async function fixture() {
  return fixturePromise ||= (async () => {
    await mkdir(screenshots, { recursive: true });
    const result = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
      import React from 'react';import {createRoot} from 'react-dom/client';
      import {UpdateLauncher,mountUpdatesStyle} from './plugins/benchgo/client/updates.jsx';
      import hostCss from './plugins/benchgo/client/style.css';
      import tokens from './deepseek-harness/packages/client/ui-theme/src/styles/design-platform.css';
      import themeBase from './deepseek-harness/packages/client/ui-theme/src/styles/base.css';
      import {installIconSprite} from './deepseek-harness/packages/client/ui-theme/src/client/icon-sprite.ts';
      installIconSprite({effect:fn=>fn(),on(){}},undefined);
      mountUpdatesStyle({effect:fn=>fn()});
      const root=createRoot(document.getElementById('root'));let serial=0;
      const initial=()=>({config:{source:'mirror',mirrorUrl:''},current:{app:'0.1.0',plugin:'0.1.1',engine:'0.2.2-rc.1'},
        installation:'desktop',phase:'idle',release:{plugin:{version:'0.1.1',available:false,compatible:true},app:{version:'0.1.0',available:false}},
        managed:true,canInstall:false,restartRequired:false,busy:false});
      let mode='current',state=initial();window.updateCalls=[];window.desktopOpens=0;window.nativeStatusReads=0;
      window.dshDesktop={updates:{open:async()=>{window.desktopOpens++;},status:async()=>{window.nativeStatusReads++;return {phase:'idle'};},subscribe:()=>()=>{}}};
      window.fetch=async(url,options)=>{
        if(!String(url).endsWith('/api/commander/updates'))throw Error('Unexpected fixture request: '+url);
        const body=JSON.parse(options.body);window.updateCalls.push(body);
        if(mode==='loading')return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}));
        if(mode==='error'&&body.action==='check')return new Response(JSON.stringify({error:'测试更新服务暂不可用'}),{status:503,headers:{'content-type':'application/json'}});
        if(body.action==='configure')state={...state,config:{source:body.source,mirrorUrl:body.mirrorUrl}};
        if(body.action==='install')state={...state,phase:'ready',restartRequired:true,canInstall:false};
        return new Response(JSON.stringify(state),{status:200,headers:{'content-type':'application/json'}});
      };
      window.renderScenario=next=>{
        mode=next;state=initial();window.updateCalls=[];window.desktopOpens=0;window.nativeStatusReads=0;
        if(mode==='empty')state={...state,current:{},release:null,phase:'unpublished',notice:'更新通道尚未发布'};
        if(mode==='available'||mode==='restart')state={...state,canInstall:true,release:{notes:'改善任务看板、语音与更新体验。',plugin:{version:'0.1.2',available:true,compatible:true},app:{version:'0.1.0',available:false}}};
        if(mode==='restart')state={...state,phase:'ready',restartRequired:true,canInstall:false};
        if(mode==='app')state={...state,release:{plugin:{version:'0.1.1',available:false,compatible:true},app:{version:'0.2.0',available:true,url:'https://example.test/benchgo-setup.exe'}}};
        root.render(<React.Fragment key={++serial}><style>{tokens}{themeBase}{hostCss}</style>
          <aside className="cmd-shell-sidebar fixture-sidebar"><div className="fixture-brand">BenchGo</div><nav aria-label="工作区"><button type="button">最近对话</button><button type="button">项目</button></nav>
            <div className="fixture-sidebar-bottom"><UpdateLauncher host={{}} wide={false}/></div></aside>
          <main className="fixture-workbench"><h1>工作台</h1><p>项目、对话与任务</p><button type="button" id="workspace-action">新建对话</button><div className="fixture-workbench-surface"><h2>最近项目</h2><p>继续处理你的工作。</p></div></main>
        </React.Fragment>);
      };
      window.renderScenario('current');
    ` }, bundle: true, write: false, outdir: join(screenshots, 'fixture'), format: 'iife', jsx: 'automatic',
      nodePaths: [join(root, 'plugins/benchgo/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
      alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')) },
      loader: { '.css': 'text', '.module.css': 'local-css', '.svg': 'text' },
      plugins: [{ name: 'official-update-primitives', setup(build) {
        build.onResolve({ filter: /^@deepseek-ai\/dsh-client-ui-primitives$/ }, () => ({ path: 'primitives', namespace: 'official-source' }));
        build.onLoad({ filter: /.*/, namespace: 'official-source' }, () => ({ loader: 'ts', resolveDir: root, contents: `
          export {Tooltip} from './deepseek-harness/packages/client/ui-primitives/src/Tooltip.tsx';
          export {Modal} from './deepseek-harness/packages/client/ui-primitives/src/Modal.tsx';
          export {LinkIconMedium} from './deepseek-harness/packages/client/ui-primitives/src/LinkIcon.tsx';
          export * from './deepseek-harness/packages/client/ui-primitives/src/icons/index.tsx';
        ` }));
      } }, sharedUiStyles()], define: { 'process.env.NODE_ENV': '"production"', 'globalThis.location': 'window.__fixtureLocation' }, logLevel: 'silent' });
    const styles = result.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n');
    return { script: result.outputFiles.find(file => file.path.endsWith('.js')).text,
      html: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><base href="https://benchgo.example/link/"><style>${styles}
        *{box-sizing:border-box}body{margin:0;font-family:var(--dsw-font-family);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
        #root{display:flex;min-height:100vh}.fixture-sidebar{display:flex;flex-direction:column;flex:none;width:248px;padding:20px 14px 12px;border-right:1px solid color-mix(in srgb,currentColor 10%,transparent)}
        .fixture-brand{font-size:20px;font-weight:600;margin:4px 8px 30px}.fixture-sidebar nav{display:grid;gap:8px}.fixture-sidebar nav button,#workspace-action{border:0;border-radius:8px;padding:10px 12px;color:inherit;background:var(--dsw-alias-interactive-bg-hover);font:inherit;text-align:left}
        .fixture-sidebar-bottom{margin-top:auto;display:flex}.fixture-workbench{flex:1;min-width:0;padding:40px}.fixture-workbench h1{font-size:24px;margin:0 0 10px}.fixture-workbench p{color:var(--dsw-alias-label-secondary)}.fixture-workbench-surface{margin-top:32px;padding:24px;border-radius:16px;background:var(--dsw-alias-interactive-bg-hover)}.fixture-workbench h2{font-size:16px}
        @media(max-width:600px){.fixture-sidebar{width:64px;padding:14px}.fixture-brand,.fixture-sidebar nav{display:none}.fixture-workbench{padding:24px 18px}.fixture-workbench h1{font-size:22px}}
      </style></head><body><div id="root"></div></body></html>` };
  })();
}

async function mount(page, mode = 'current', dark = false, localDesktop = false) {
  const output = await fixture();
  await page.setContent(output.html);
  await page.evaluate(({ dark, localDesktop }) => {
    document.body.toggleAttribute('data-ds-dark-theme', dark);
    window.__fixtureLocation = localDesktop ? { protocol: 'dsh-app:', hostname: 'app' } : { protocol: 'https:', hostname: 'remote.example' };
  }, { dark, localDesktop });
  await page.addScriptTag({ content: output.script });
  await page.locator('.cmd-update-launcher').waitFor();
  await page.evaluate(mode => window.renderScenario(mode), mode);
  await page.waitForFunction(() => window.updateCalls.some(call => call.action === 'status'));
  const launcher = page.locator('.cmd-update-launcher');
  await launcher.click();
  const dialog = page.getByRole('dialog', { name: '更新', exact: true });
  await dialog.waitFor();
  return { launcher, dialog };
}

async function fits(page, dialog) {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'the workbench does not overflow horizontally');
  const box = await dialog.boundingBox(), viewport = page.viewportSize();
  assert(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1, 'the native modal fits the viewport');
  assert(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth), 'the update content has no horizontal clipping');
  const sourceLabel = await dialog.locator('.cmd-update-source-row label').boundingBox();
  assert(sourceLabel && sourceLabel.height <= 24, 'the update source label stays on one readable line');
  for (const button of await dialog.locator('button:visible').all()) {
    const bounds = await button.boundingBox();
    assert(bounds && bounds.width > 0 && bounds.x >= box.x - 1 && bounds.x + bounds.width <= box.x + box.width + 1, 'visible controls remain within the dialog');
  }
}

async function holdUpdate(page, dialog) {
  const button = dialog.getByRole('button', { name: '长按 2 秒更新', exact: true });
  const box = await button.boundingBox();
  assert(box, 'the hold action is visible');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(2050);
  await page.mouse.up();
}

test('unified updates render honest states beside the workbench in both themes and viewport sizes', { skip: !executablePath && 'Chromium/Edge required' }, async () => {
  await mkdir(screenshots, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    for (const dark of [false, true]) for (const width of [1280, 390]) for (const mode of ['empty', 'loading', 'error', 'available', 'restart']) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
      page.setDefaultTimeout(6000);
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      try {
        const { dialog } = await mount(page, mode, dark);
        await dialog.getByRole('heading', { name: 'BenchGo', exact: true }).waitFor();
        assert.equal(await dialog.getByRole('button', { name: /^(更新插件|检查应用更新)$/ }).count(), 0, 'component-specific update actions are absent');
        const details = dialog.getByRole('button', { name: '版本详情', exact: true });
        if (mode !== 'loading') assert.equal(await details.getAttribute('aria-expanded'), 'false', 'component versions start collapsed');
        else assert.equal(await details.count(), 0, 'initial loading does not fabricate component versions');
        assert.equal(await dialog.getByText('0.2.2-rc.1', { exact: false }).isVisible(), false, 'engine detail stays out of the primary card');
        if (mode === 'available') await dialog.getByRole('button', { name: '长按 2 秒更新', exact: true }).waitFor();
        else if (mode === 'restart') await dialog.getByText(/重启.*生效/).first().waitFor();
        else if (mode === 'error') {
          await dialog.getByRole('alert').waitFor();
          assert.match(await dialog.getByRole('alert').innerText(), /测试更新服务暂不可用/);
          assert.doesNotMatch(await dialog.getByRole('alert').innerText(), /api\/commander\/updates/, 'technical endpoint paths stay out of the user-facing error');
          assert.match(await dialog.locator('.cmd-update-card-heading').innerText(), /暂时无法检查更新/);
          assert.doesNotMatch(await dialog.locator('.cmd-update-card-heading').innerText(), /已是最新版本/, 'a failed check never advertises stale current status');
        }
        else if (mode === 'loading') {
          await dialog.getByText('正在读取更新信息', { exact: true }).waitFor();
          assert.equal(await dialog.getByRole('button', { name: /^(检查更新|长按 2 秒更新)$/ }).count(), 0, 'initial loading cannot submit another update request');
        }
        else assert.equal(await dialog.getByRole('button', { name: '长按 2 秒更新', exact: true }).count(), 0, 'an unpublished channel cannot advertise an install');
        await fits(page, dialog);
        await page.screenshot({ path: join(screenshots, `${dark ? 'dark' : 'light'}-${width}-${mode}.png`) });
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    }
  } finally { await browser.close(); }
});

test('unified update details, source picker and install preserve native keyboard and lifecycle behavior', { skip: !executablePath && 'Chromium/Edge required' }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(6000);
    const { launcher, dialog } = await mount(page, 'available');
    const details = dialog.getByRole('button', { name: '版本详情', exact: true });
    await details.click();
    assert.equal(await details.getAttribute('aria-expanded'), 'true');
    const information = page.getByRole('dialog', { name: '版本详情', exact: true });
    await information.getByText('0.2.2-rc.1', { exact: false }).waitFor();
    await information.getByText('改善任务看板、语音与更新体验。', { exact: true }).waitFor();
    await fits(page, dialog);
    await page.screenshot({ path: join(screenshots, 'light-390-version-details.png') });
    await page.keyboard.press('Escape');
    await information.waitFor({ state: 'detached' });
    assert(await dialog.isVisible(), 'Escape dismisses information before the update modal');
    const source = dialog.locator('.dowork-select');
    await source.click();
    await page.getByRole('listbox').waitFor();
    assert.equal(await page.getByRole('option').count(), 3);
    await page.keyboard.press('Escape');
    await page.getByRole('listbox').waitFor({ state: 'detached' });
    assert(await dialog.isVisible(), 'Escape closes the source menu before the modal');
    assert(await source.evaluate(node => document.activeElement === node), 'source picker restores keyboard focus');
    await source.click();
    await page.getByRole('option', { name: 'GitHub 直连', exact: true }).click();
    await page.waitForFunction(() => window.updateCalls.some(call => call.action === 'configure' && call.source === 'github'));
    await holdUpdate(page, dialog);
    await dialog.getByText(/重启.*生效/).first().waitFor();
    assert.equal(await page.evaluate(() => window.updateCalls.filter(call => call.action === 'install').length), 1);
    assert.equal(await dialog.getByRole('button', { name: '长按 2 秒更新', exact: true }).count(), 0);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    assert(await launcher.evaluate(node => document.activeElement === node), 'closing the modal returns focus to its actual sidebar launcher');
    await launcher.hover();
    await page.getByRole('tooltip').getByText(/更新/).waitFor();
  } finally { await browser.close(); }
});

test('application-only updates use the same primary action and delegate to the desktop updater', { skip: !executablePath && 'Chromium/Edge required' }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(6000);
    const { dialog } = await mount(page, 'app', false, true);
    await holdUpdate(page, dialog);
    await page.waitForFunction(() => window.desktopOpens === 1);
    assert.equal(await page.evaluate(() => window.updateCalls.filter(call => call.action === 'install').length), 0, 'an application update never invokes the plugin installer');
    assert.equal(await dialog.getByRole('button', { name: '检查应用更新', exact: true }).count(), 0);
  } finally { await browser.close(); }
});

test('a remote host update cannot invoke a local Desktop bridge carried into the page', { skip: !executablePath && 'Chromium/Edge required' }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(6000);
    const { dialog } = await mount(page, 'app');
    const update = dialog.getByRole('button', { name: '长按 2 秒更新', exact: true });
    await update.waitFor();
    assert(await update.isDisabled(), 'the remote application update requires action on its host');
    await dialog.getByText('请在当前连接主机上打开 BenchGo，完成应用更新。', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: '版本详情', exact: true }).click();
    assert.equal(await dialog.getByRole('button', { name: '检查安装器更新', exact: true }).count(), 0);
    assert.deepEqual(await page.evaluate(() => ({ opens: window.desktopOpens, statusReads: window.nativeStatusReads })), { opens: 0, statusReads: 0 });
    await page.screenshot({ path: join(screenshots, 'light-390-remote-application.png') });
  } finally { await browser.close(); }
});

test('hold confirmation animates progress, cancels quickly and never executes a short click', { skip: !executablePath && 'Chromium/Edge required' }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 }, reducedMotion: 'no-preference' });
    const { dialog } = await mount(page, 'available', true);
    const update = dialog.getByRole('button', { name: '长按 2 秒更新', exact: true });
    await update.click();
    assert.equal(await page.evaluate(() => window.updateCalls.filter(call => call.action === 'install').length), 0);
    const box = await update.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(650);
    assert.equal(await update.getAttribute('data-holding'), 'true');
    const progress = await update.evaluate(node => {
      const elements = [node, ...node.querySelectorAll('*')];
      for (const element of elements) {
        const matrix = getComputedStyle(element).transform;
        if (matrix !== 'none') { const scale = new DOMMatrixReadOnly(matrix).a; if (scale > 0.05 && scale < 0.9) return scale; }
      }
      for (const pseudo of ['::before', '::after']) {
        const matrix = getComputedStyle(node, pseudo).transform;
        if (matrix !== 'none') { const scale = new DOMMatrixReadOnly(matrix).a; if (scale > 0.05 && scale < 0.9) return scale; }
      }
      return null;
    });
    assert(progress !== null, 'the two-second hold has an actual intermediate transform progress');
    await page.screenshot({ path: join(screenshots, 'dark-390-hold-progress.png') });
    await page.mouse.up();
    await page.waitForTimeout(240);
    assert.notEqual(await update.getAttribute('data-holding'), 'true');
    assert.equal(await page.evaluate(() => window.updateCalls.filter(call => call.action === 'install').length), 0);
    await page.screenshot({ path: join(screenshots, 'dark-390-hold-cancelled.png') });
    const details = dialog.getByRole('button', { name: '版本详情', exact: true });
    assert.equal(await page.getByRole('dialog', { name: '版本详情', exact: true }).count(), 0);
    await details.click();
    const information = page.getByRole('dialog', { name: '版本详情', exact: true });
    await information.waitFor();
    const motion = await information.evaluate(node => node.getAnimations().map(animation => ({ duration: animation.effect.getTiming().duration, keyframes: animation.effect.getKeyframes().map(frame => ({ opacity: frame.opacity, transform: frame.transform })) })));
    assert(motion.some(animation => animation.duration > 0 && animation.duration <= 240), 'details use a brief entry animation');
    await page.waitForTimeout(240);
    await fits(page, dialog);
    await page.screenshot({ path: join(screenshots, 'dark-390-version-details.png') });
    await page.keyboard.press('Escape');
    await information.waitFor({ state: 'detached' });
    await update.focus();
    await page.keyboard.down('Space');
    await page.waitForTimeout(350);
    await page.keyboard.up('Space');
    await page.waitForTimeout(2050);
    assert.equal(await page.evaluate(() => window.updateCalls.filter(call => call.action === 'install').length), 0, 'releasing Space before two seconds cancels');
    await page.keyboard.down('Enter');
    await page.waitForFunction(() => window.updateCalls.filter(call => call.action === 'install').length === 1);
    await page.keyboard.up('Enter');
    assert.equal(await page.evaluate(() => window.updateCalls.filter(call => call.action === 'install').length), 1);
  } finally { await browser.close(); }
});

test('captured touchscreen movement cancels and a context menu never interrupts a complete hold', { skip: !executablePath && 'Chromium/Edge required' }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce' });
    const { dialog } = await mount(page, 'available');
    const button = dialog.getByRole('button', { name: '长按 2 秒更新', exact: true });
    const box = await button.boundingBox(), x = box.x + box.width / 2, y = box.y + box.height / 2;
    const input = await page.context().newCDPSession(page);
    await button.evaluate(node => node.addEventListener('pointerdown', event => { window.touchPointer = event.pointerId; }, { once: true }));
    await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
    await page.waitForTimeout(350);
    assert(await button.evaluate(node => node.hasPointerCapture(window.touchPointer)), 'the browser captures the active touchscreen pointer');
    await input.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box.x - 8, y, id: 1 }] });
    await page.waitForTimeout(100);
    await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(1800);
    assert.equal(await page.evaluate(() => window.updateCalls.filter(call => call.action === 'install').length), 0, 'moving outside cancels even under implicit pointer capture');
    await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 2 }] });
    await page.waitForTimeout(600);
    await button.dispatchEvent('contextmenu', { bubbles: true, cancelable: true });
    await page.waitForFunction(() => window.updateCalls.filter(call => call.action === 'install').length === 1);
    await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert.equal(await page.evaluate(() => window.updateCalls.filter(call => call.action === 'install').length), 1);
    await input.detach();
  } finally { await browser.close(); }
});
