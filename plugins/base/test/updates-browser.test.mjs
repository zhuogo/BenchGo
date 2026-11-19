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
const progressScreenshots = join(root, 'artifacts/update-progress-browser-20261115');
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
      import {UpdateLauncher,mountUpdatesStyle} from './plugins/base/client/updates.jsx';
      import hostCss from './plugins/base/client/style.css';
      import tokens from './deepseek-harness/packages/client/ui-theme/src/styles/design-platform.css';
      import themeBase from './deepseek-harness/packages/client/ui-theme/src/styles/base.css';
      import {installIconSprite} from './deepseek-harness/packages/client/ui-theme/src/client/icon-sprite.ts';
      installIconSprite({effect:fn=>fn(),on(){}},undefined);
      mountUpdatesStyle({effect:fn=>fn()});
      const root=createRoot(document.getElementById('root'));let serial=0;
      const initial=()=>({config:{source:'mirror',mirrorUrl:''},current:{app:'0.1.0',plugin:'0.1.1',engine:'0.2.2-rc.1'},
        installation:'desktop',phase:'idle',release:{plugin:{version:'0.1.1',available:false,compatible:true},app:{version:'0.1.0',available:false}},
        managed:true,canInstall:false,restartRequired:false,busy:false});
      let mode='current',state=initial(),nativeState={phase:'idle'},nativeListener,finishNativeStatus;window.updateCalls=[];window.desktopOpens=0;window.nativeStatusReads=0;
      window.publishHostState=value=>{state={...state,...value};};
      window.publishNativeState=value=>{nativeState=value;nativeListener?.(value);};
      window.finishNativeStatus=()=>{finishNativeStatus?.();};
      window.dshDesktop={updates:{open:async()=>{window.desktopOpens++;},status:async()=>{
        window.nativeStatusReads++;const snapshot=nativeState;
        if(mode==='native-race'&&window.desktopOpens>0){window.nativeStatusPending=true;return new Promise(resolve=>{finishNativeStatus=()=>{window.nativeStatusPending=false;resolve(snapshot);};});}
        return snapshot;
      },subscribe:listener=>{nativeListener=listener;return ()=>{if(nativeListener===listener)nativeListener=undefined;};}}};
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
        mode=next;state=initial();nativeState={phase:'idle'};finishNativeStatus=undefined;window.nativeStatusPending=false;window.updateCalls=[];window.desktopOpens=0;window.nativeStatusReads=0;
        delete window.dshDesktop.updates.apply;delete window.dshDesktop.updates.restart;
        window.unifiedCalls=[];
        if(mode.startsWith('combined')){
          state={...state,canInstall:true,release:{plugin:{version:'0.1.2',available:true,compatible:true},app:{version:'0.2.0',available:true}}};
          window.dshDesktop.updates.apply=async()=>{
            window.unifiedCalls.push('app');
            if(mode==='combined-error')throw Error('安全关闭未完成，请重试');
            nativeState={phase:'downloading',percent:42,version:'0.2.0'};nativeListener?.(nativeState);
            return new Promise(resolve=>{window.finishUnifiedUpdate=()=>{nativeState={phase:'installing',version:'0.2.0'};nativeListener?.(nativeState);resolve(nativeState);};});
          };
          window.dshDesktop.updates.restart=async()=>{window.unifiedCalls.push('restart');};
        }
        if(mode==='empty')state={...state,current:{},release:null,phase:'unpublished',notice:'更新通道尚未发布'};
        if(mode==='available'||mode==='restart'||mode==='feature-native-error')state={...state,canInstall:true,release:{notes:'改善任务看板、语音与更新体验。',plugin:{version:'0.1.2',available:true,compatible:true},app:{version:'0.1.0',available:false}}};
        if(mode==='restart')state={...state,phase:'ready',restartRequired:true,canInstall:false};
        if(['feature-native-error','app-stop-failed','current-stop-failed'].includes(mode))nativeState={phase:'error',failure:'stop-failed',version:'0.2.0'};
        if(mode==='app'||mode==='app-stop-failed')state={...state,release:{plugin:{version:'0.1.1',available:false,compatible:true},app:{version:'0.2.0',available:true,url:'https://example.test/benchgo-setup.exe'}}};
        if(mode==='same-release-app')state={...state,current:{...state.current,release:'0.1.4',plugin:'0.1.4',app:'0.1.2'},release:{releaseVersion:'0.1.4',plugin:{version:'0.1.4',available:false,compatible:true},app:{version:'0.1.3',available:true}}};
        if(mode==='native-race'){state={...state,decision:{action:'blocked',available:true,enabled:false,reason:'引擎版本暂不可识别'}};nativeState={phase:'error',failure:'check-network'};}
        if(mode==='host-progress')state={...state,phase:'downloading',progress:{stage:'downloading',transferred:12*1024**2,total:48*1024**2,bytesPerSecond:1.5*1024**2,updatedAt:new Date().toISOString()}};
        if(mode==='native-progress')nativeState={phase:'downloading',percent:37.8,version:'0.2.0'};
        root.render(<React.Fragment key={++serial}><style>{tokens}{themeBase}{hostCss}</style>
          <aside className="cmd-shell-sidebar fixture-sidebar"><div className="fixture-brand">BenchGo</div><nav aria-label="工作区"><button type="button">最近对话</button><button type="button">项目</button></nav>
            <div className="fixture-sidebar-bottom"><UpdateLauncher host={{}} wide={false}/></div></aside>
          <main className="fixture-workbench"><h1>工作台</h1><p>项目、对话与任务</p><button type="button" id="workspace-action">新建对话</button><div className="fixture-workbench-surface"><h2>最近项目</h2><p>继续处理你的工作。</p></div></main>
        </React.Fragment>);
      };
      window.renderScenario('current');
    ` }, bundle: true, write: false, outdir: join(screenshots, 'fixture'), format: 'iife', jsx: 'automatic',
      nodePaths: [join(root, 'plugins/base/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
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

async function holdUpdate(page, dialog, label = '长按 2 秒更新') {
  const button = dialog.getByRole('button', { name: label, exact: true });
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
    for (const dark of [false, true]) for (const width of [1280, 390]) for (const mode of ['empty', 'loading', 'error', 'available', 'restart', 'same-release-app']) {
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
        if (mode === 'available' || mode === 'same-release-app') {
          await dialog.getByRole('button', { name: '长按 2 秒更新', exact: true }).waitFor();
          if (mode === 'same-release-app') {
            const heading = await dialog.locator('.cmd-update-card-heading').innerText();
            assert.match(heading, /v0\.1\.4 · 主机应用有更新/);
            assert.doesNotMatch(heading, /→|发现新版本/);
          }
        }
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
        if (mode === 'same-release-app') {
          await details.click();
          const information = page.getByRole('dialog', { name: '版本详情', exact: true });
          assert.match(await information.innerText(), /主机应用\s*v0\.1\.2 → v0\.1\.3/);
          await fits(page, dialog);
          await page.screenshot({ path: join(screenshots, `${dark ? 'dark' : 'light'}-${width}-${mode}-details.png`) });
        }
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    }
  } finally { await browser.close(); }
});

test('a combined update keeps native progress visible after staging and exposes one recovery action', { skip: !executablePath && 'Chromium/Edge required' }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    for (const dark of [false, true]) for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
      page.setDefaultTimeout(6000);
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      try {
        const { dialog } = await mount(page, 'combined', dark, true);
        await holdUpdate(page, dialog);
        const bar = dialog.getByRole('progressbar', { name: '正在下载应用', exact: true });
        await bar.waitFor(); assert.equal(await bar.getAttribute('aria-valuenow'), '42');
        assert.match(await dialog.innerText(), /功能包已就绪，正在完成主机应用更新/);
        assert.deepEqual(await page.evaluate(() => window.unifiedCalls), ['app']);
        await fits(page, dialog);
        await page.screenshot({ path: join(screenshots, `${dark ? 'dark' : 'light'}-${width}-combined-progress.png`) });
        await page.evaluate(() => window.finishUnifiedUpdate());
        await dialog.getByText('正在重启主机应用，更新后自动返回工作台', { exact: true }).waitFor();
        assert.deepEqual(await page.evaluate(() => window.unifiedCalls), ['app'], 'the installer owns the only restart');
        await page.evaluate(() => window.renderScenario('combined-error'));
        await page.locator('.cmd-update-launcher').click();
        await holdUpdate(page, dialog);
        await dialog.getByRole('alert').filter({ hasText: '安全关闭未完成' }).waitFor();
        assert.equal(await dialog.getByRole('button', { name: '长按 2 秒重试', exact: true }).count(), 1);
        await fits(page, dialog);
        await page.screenshot({ path: join(screenshots, `${dark ? 'dark' : 'light'}-${width}-combined-error.png`) });
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    }
  } finally { await browser.close(); }
});

test('host progress shows real bytes and speed, honest unknown totals and stalled downloads before local preparation', { skip: !executablePath && 'Chromium/Edge required' }, async () => {
  await mkdir(progressScreenshots, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    for (const dark of [false, true]) for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
      page.setDefaultTimeout(6000);
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      try {
        await page.clock.install();
        const { dialog } = await mount(page, 'host-progress', dark);
        const progress = dialog.locator('.cmd-update-progress');
        const bar = dialog.getByRole('progressbar', { name: '正在下载功能包', exact: true });
        const capture = async stage => {
          await fits(page, dialog);
          assert(await page.getByRole('heading', { name: '工作台', exact: true }).isVisible(), 'the real modal retains its neighboring workbench');
          await page.screenshot({ path: join(progressScreenshots, `${dark ? 'dark' : 'light'}-${width}-host-${stage}.png`) });
        };
        // Host changes still reach the production component through its normal status poll.
        const publish = async value => {
          await page.evaluate(value => window.publishHostState({ ...value, progress: { ...value.progress, updatedAt: new Date().toISOString() } }), value);
          await page.clock.runFor(2001);
        };
        await bar.waitFor();
        assert.equal(await bar.getAttribute('aria-valuenow'), '25');
        assert.equal(await bar.getAttribute('aria-valuetext'), '25%');
        assert.equal(await progress.locator('strong').innerText(), '25%');
        assert.equal(await progress.locator('.cmd-update-progress-detail').innerText(), '12.0 MB / 48.0 MB · 1.5 MB/s');
        assert.equal(await bar.locator('span').evaluate(node => getComputedStyle(node).transform), 'matrix(0.25, 0, 0, 1, 0, 0)', 'the visible fill matches downloaded bytes');
        assert(await dialog.locator('.dowork-select').isDisabled(), 'download source changes are disabled during an active transfer');
        await capture('downloading');

        const current = { stage: 'downloading', transferred: 24 * 1024 ** 2, total: 48 * 1024 ** 2, bytesPerSecond: 2 * 1024 ** 2 };
        await publish({ progress: current });
        assert.equal(await bar.getAttribute('aria-valuenow'), '50', 'a newer host poll advances the actual progress');
        assert.match(await progress.innerText(), /24\.0 MB \/ 48\.0 MB · 2\.0 MB\/s/);

        await publish({ progress: { ...current, total: null, bytesPerSecond: null } });
        assert.equal(await bar.getAttribute('aria-valuenow'), null, 'an unknown content length never implies a percentage');
        assert.equal(await bar.getAttribute('aria-valuetext'), '等待下载进度');
        assert.equal(await bar.locator('span').count(), 0, 'unknown progress has no fabricated fill');
        assert.doesNotMatch(await progress.innerText(), /%|MB\/s/);
        await progress.getByText('正在连接下载源，等待下载数据…', { exact: true }).waitFor();
        await capture('unknown');

        await publish({ progress: current });
        await page.clock.runFor(26_000);
        assert.equal(await progress.getAttribute('data-stalled'), 'false', 'a download younger than thirty seconds is not reported stalled');
        await page.clock.runFor(4001);
        assert.equal(await progress.getAttribute('data-stalled'), 'true');
        await progress.getByText(/30 秒未收到新的下载进度/).waitFor();
        assert.equal(await bar.getAttribute('aria-valuenow'), '50', 'elapsed time never advances downloaded bytes');
        assert.doesNotMatch(await progress.innerText(), /MB\/s/, 'a stalled download does not keep advertising an obsolete transfer speed');
        await capture('stalled');

        for (const [stage, title] of [['verifying', '正在校验安装包'], ['extracting', '正在解包功能包'], ['activating', '正在准备功能包']]) {
          await publish({ progress: { ...current, stage, transferred: current.total, bytesPerSecond: 0 } });
          await progress.getByRole('status').getByText(title, { exact: true }).waitFor();
          assert.equal(await progress.getAttribute('data-stage'), stage);
          assert.equal(await dialog.getByRole('progressbar').count(), 0, 'local processing is a stage, not a fake byte percentage');
          assert.equal(await progress.locator('.cmd-update-progress-stalled').count(), 0, 'download stalling does not bleed into local preparation');
          assert.doesNotMatch(await progress.innerText(), /%/);
          assert.match(await dialog.locator('.cmd-update-card-heading').innerText(), /正在准备更新/);
          assert.equal(await dialog.getByRole('button', { name: '准备中…', exact: true }).isDisabled(), true);
          await capture(stage);
        }
        await publish({ phase: 'ready', progress: { stage: 'ready' }, restartRequired: true, canInstall: false });
        await dialog.getByText(/重启主机应用后生效/).waitFor();
        assert.equal(await progress.count(), 0, 'a completed feature package gives the actual restart instruction');
        assert.equal(await dialog.getByRole('progressbar').count(), 0);
        assert.deepEqual(await page.evaluate(() => ({ installs: window.updateCalls.filter(call => call.action === 'install').length, opens: window.desktopOpens })), { installs: 0, opens: 0 });
        await capture('ready');
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    }
  } finally { await browser.close(); }
});

test('native progress follows public percentages and stages while repeated events cannot conceal a thirty-second stall', { skip: !executablePath && 'Chromium/Edge required' }, async () => {
  await mkdir(progressScreenshots, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    for (const dark of [false, true]) for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
      page.setDefaultTimeout(6000);
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      try {
        await page.clock.install();
        const { dialog } = await mount(page, 'native-progress', dark, true);
        const progress = dialog.locator('.cmd-update-progress');
        const bar = dialog.getByRole('progressbar', { name: '正在下载应用', exact: true });
        const publish = value => page.evaluate(value => window.publishNativeState(value), { version: '0.2.0', ...value });
        const capture = async stage => {
          await fits(page, dialog);
          assert(await page.getByRole('heading', { name: '工作台', exact: true }).isVisible());
          await page.screenshot({ path: join(progressScreenshots, `${dark ? 'dark' : 'light'}-${width}-native-${stage}.png`) });
        };
        await bar.waitFor();
        assert.equal(await bar.getAttribute('aria-valuenow'), '37');
        assert.equal(await progress.locator('strong').innerText(), '37%');
        assert.equal(await progress.locator('.cmd-update-progress-detail').innerText(), '安装包正在后台下载');
        assert.doesNotMatch(await progress.innerText(), /MB|\/s/, 'the public native bridge does not expose byte counts or transfer speed');
        assert(await dialog.getByRole('button', { name: '长按 2 秒更新', exact: true }).isDisabled());
        await capture('downloading');

        await publish({ phase: 'downloading', percent: null });
        await page.waitForFunction(() => document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow') === null);
        assert.equal(await bar.getAttribute('aria-valuetext'), '等待下载进度');
        assert.equal(await bar.locator('span').count(), 0);
        assert.doesNotMatch(await progress.innerText(), /%/);
        await capture('unknown');

        await publish({ phase: 'downloading', percent: 37.8 });
        await page.waitForFunction(() => document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow') === '37');
        await page.clock.runFor(28_000);
        assert.equal(await progress.getAttribute('data-stalled'), 'false');
        await publish({ phase: 'downloading', percent: 37.8 });
        await page.clock.runFor(3001);
        assert.equal(await progress.getAttribute('data-stalled'), 'true', 'repeated identical bridge events do not restart the no-progress timer');
        await progress.getByText(/30 秒未收到新的下载进度/).waitFor();
        assert.equal(await bar.getAttribute('aria-valuenow'), '37', 'waiting never fabricates native progress');
        await capture('stalled');

        await publish({ phase: 'downloading', percent: 42.3 });
        await page.waitForFunction(() => document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow') === '42');
        assert.equal(await progress.getAttribute('data-stalled'), 'false', 'actual progress clears the stalled notice');
        assert.equal(await progress.locator('.cmd-update-progress-stalled').count(), 0);
        for (const [stage, title] of [['verifying', '正在校验安装包'], ['installing', '正在准备安装应用'], ['ready', '应用安装包已就绪']]) {
          await publish({ phase: stage, percent: 100 });
          await progress.getByRole('status').getByText(title, { exact: true }).waitFor();
          assert.equal(await progress.getAttribute('data-stage'), stage);
          assert.equal(await dialog.getByRole('progressbar').count(), 0);
          assert.equal(await progress.locator('.cmd-update-progress-stalled').count(), 0);
          assert.doesNotMatch(await progress.innerText(), /%/);
          if (stage === 'ready') {
            await progress.getByText('等待在应用更新窗口确认安装。', { exact: true }).waitFor();
            assert.doesNotMatch(await dialog.innerText(), /重启.*生效|已安装成功/, 'a ready native installer is not represented as an installed application');
          } else assert.match(await dialog.locator('.cmd-update-card-heading').innerText(), /正在准备更新/);
          await capture(stage);
        }
        assert.deepEqual(await page.evaluate(() => ({ installs: window.updateCalls.filter(call => call.action === 'install').length, opens: window.desktopOpens })), { installs: 0, opens: 0 });
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

test('native retry remains usable with a blocked plugin and cannot restore an obsolete error snapshot', { skip: !executablePath && 'Chromium/Edge required' }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    for (const dark of [false, true]) for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
      page.setDefaultTimeout(6000);
      try {
        const { dialog } = await mount(page, 'native-race', dark, true);
        await dialog.getByText('引擎版本暂不可识别', { exact: true }).waitFor();
        await dialog.getByRole('alert').getByText('无法连接安装器更新服务，请检查网络后重试。', { exact: true }).waitFor();
        await fits(page, dialog);
        await page.screenshot({ path: join(screenshots, `${dark ? 'dark' : 'light'}-${width}-native-error.png`) });
        await dialog.getByRole('button', { name: '重试应用更新', exact: true }).click();
        await page.waitForFunction(() => window.nativeStatusPending);
        assert.equal(await page.evaluate(() => window.desktopOpens), 1);
        await page.evaluate(() => window.publishNativeState({ phase: 'idle' }));
        await dialog.getByRole('alert').waitFor({ state: 'detached' });
        await page.evaluate(async () => { window.finishNativeStatus(); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
        assert.equal(await dialog.getByRole('alert').count(), 0, 'a stale error snapshot cannot overwrite the newer healthy event');
        await dialog.getByText('引擎版本暂不可识别', { exact: true }).waitFor();
        assert.equal(await page.evaluate(() => window.updateCalls.filter(call => call.action === 'install').length), 0);
        await fits(page, dialog);
        await page.screenshot({ path: join(screenshots, `${dark ? 'dark' : 'light'}-${width}-native-recovered.png`) });
      } finally { await page.close(); }
    }
  } finally { await browser.close(); }
});

test('native shutdown failure keeps the main card concise and recovery in version details', { skip: !executablePath && 'Chromium/Edge required' }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    for (const dark of [false, true]) for (const width of [1280, 390]) for (const mode of ['app-stop-failed', 'current-stop-failed']) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
      page.setDefaultTimeout(6000);
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      try {
        const { dialog } = await mount(page, mode, dark, true);
        await dialog.locator('.cmd-update-card-heading').getByText(/应用更新未完成/).waitFor();
        assert.equal(await dialog.getByRole('alert').count(), 0);
        assert.equal(await dialog.getByRole('button', { name: '重试应用更新', exact: true }).count(), 0);
        if (mode === 'app-stop-failed') {
          assert.equal(await dialog.getByRole('button', { name: '长按 2 秒重试', exact: true }).isEnabled(), true);
          await holdUpdate(page, dialog, '长按 2 秒重试');
          assert.equal(await page.evaluate(() => window.desktopOpens), 1);
        }
        await fits(page, dialog);
        await page.screenshot({ path: join(screenshots, `${dark ? 'dark' : 'light'}-${width}-${mode}.png`) });
        await dialog.getByRole('button', { name: '版本详情', exact: true }).click();
        const details = page.getByRole('dialog', { name: '版本详情', exact: true });
        await details.getByRole('alert').getByText(/主机未能安全完成关闭，更新尚未安装/).waitFor();
        assert.equal(await details.getByRole('button', { name: '检查安装器更新', exact: true }).count(), 0);
        await details.getByRole('button', { name: '重试应用更新', exact: true }).click();
        assert.equal(await page.evaluate(() => window.desktopOpens), mode === 'app-stop-failed' ? 2 : 1);
        assert.equal(await details.getByRole('alert').count(), 1, 'opening the native window does not clear the unresolved failure');
        assert(await details.evaluate(node => node.scrollWidth <= node.clientWidth), 'the complete diagnostic fits the details panel');
        await fits(page, dialog);
        await page.screenshot({ path: join(screenshots, `${dark ? 'dark' : 'light'}-${width}-${mode}-details.png`) });
        await page.evaluate(() => window.publishNativeState({ phase: 'idle' }));
        await details.getByRole('alert').waitFor({ state: 'detached' });
        assert.doesNotMatch(await dialog.locator('.cmd-update-card-heading').innerText(), /应用更新未完成/);
        assert.equal(await page.evaluate(() => window.updateCalls.filter(call => call.action === 'install').length), 0);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    }
  } finally { await browser.close(); }
});

test('a pending feature restart keeps the native failure in details without a disabled recovery banner', { skip: !executablePath && 'Chromium/Edge required' }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    for (const dark of [false, true]) for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
      page.setDefaultTimeout(6000);
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      try {
        const { dialog, launcher } = await mount(page, 'feature-native-error', dark, true);
        assert.equal(await dialog.getByRole('alert').count(), 0);
        assert.match(await dialog.locator('.cmd-update-card-heading').innerText(), /发现新版本/);
        assert.equal(await dialog.getByRole('button', { name: '长按 2 秒更新', exact: true }).isEnabled(), true);
        await holdUpdate(page, dialog);
        await dialog.getByText('功能包已就绪，重启主机应用后生效', { exact: true }).waitFor();
        assert.equal(await dialog.getByRole('alert').count(), 0);
        assert.equal(await dialog.getByRole('button', { name: '重试应用更新', exact: true }).count(), 0);
        await dialog.getByRole('button', { name: '关闭更新', exact: true }).click();
        await launcher.click();
        assert.equal(await dialog.getByRole('alert').count(), 0, 'reopening keeps focus on the required restart');
        await fits(page, dialog);
        await page.screenshot({ path: join(screenshots, `${dark ? 'dark' : 'light'}-${width}-restart-native-error.png`) });
        await dialog.getByRole('button', { name: '版本详情', exact: true }).click();
        const details = page.getByRole('dialog', { name: '版本详情', exact: true });
        await details.getByRole('alert').getByText(/主机未能安全完成关闭，更新尚未安装/).waitFor();
        await details.getByText('请先重启主机应用，使功能包生效，再重试应用更新。', { exact: true }).waitFor();
        assert.equal(await details.getByRole('button', { name: '重试应用更新', exact: true }).count(), 0);
        await fits(page, dialog);
        await page.screenshot({ path: join(screenshots, `${dark ? 'dark' : 'light'}-${width}-restart-native-details.png`) });
        await page.evaluate(() => window.publishNativeState({ phase: 'idle' }));
        await details.getByRole('alert').waitFor({ state: 'detached' });
        assert.equal(await details.getByText('应用更新尚未完成', { exact: true }).count(), 0);
        assert.deepEqual(await page.evaluate(() => ({ installs: window.updateCalls.filter(call => call.action === 'install').length, opens: window.desktopOpens })), { installs: 1, opens: 0 });
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    }
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
