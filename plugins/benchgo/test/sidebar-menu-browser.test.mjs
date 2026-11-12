import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { sharedUiStyles } from '../scripts/shared-ui.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
const { chromium } = require('playwright');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || [chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);

test('conversation menu follows its actual trigger across scrolling, layout changes and row switches', { skip: !executablePath }, async () => {
  const bundle = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';
    import {Projects,setFixtureState} from './plugins/benchgo/client/index.jsx';
    import {moduleSource} from './plugins/benchgo/client/modules.mjs';
    import hostCss from './plugins/benchgo/client/style.css';
    import tokens from './deepseek-harness/packages/client/ui-theme/src/styles/design-platform.css';
    import themeBase from './deepseek-harness/packages/client/ui-theme/src/styles/base.css';
    import {installIconSprite} from './deepseek-harness/packages/client/ui-theme/src/client/icon-sprite.ts';
    installIconSprite({effect:effect=>effect(),on(){}},undefined);
    moduleSource.update({base:true,harness:true,superagent:false,link:false});
    const ids=Array.from({length:40},(_,i)=>'session-'+i);
    const sessions={ids,byId:Object.fromEntries(ids.map((id,i)=>[id,{id,title:'测试对话 '+i,blank:false,updatedAt:40-i}]))};
    const workspaces={phase:'ready',items:[],archivedSessionIds:[],pinnedSessionIds:[]},statuses=new Map();
    const source=snapshot=>({getSnapshot:()=>snapshot,subscribe:()=>()=>{}});
    const host={layout:{panelInfo:source({activePanelId:null})},sessions:{list:source(sessions)},workspaces:{list:source(workspaces)},uiSession:{sessionStatus:source(statuses)},remoteAccess:{source:()=>source(true)},uiWorkspace:{openSession(){}}};
    window.scenario=mode=>{sessions.ids=mode==='data'?ids:[];sessions.byId=mode==='data'?Object.fromEntries(ids.map((id,i)=>[id,{id,title:'测试对话 '+i,blank:false,updatedAt:40-i}])):{};workspaces.phase=mode==='loading'?'loading':'ready';setFixtureState({projects:[],sessions:[],loaded:mode!=='loading',error:mode==='error'?'连接失败，请重试':''});};
    window.scenario('data');
    createRoot(document.getElementById('root')).render(<><style>{tokens}{themeBase}{hostCss}</style><aside className="cmd-shell-sidebar" style={{display:'flex',flexDirection:'column',width:280,height:'100vh'}}><Projects host={host} open={()=>{}} newSession={()=>{}} renderSlot={()=>null}/></aside><main>工作台内容</main></>);
  ` }, bundle: true, write: false, outdir: join(root, 'artifacts/unused-sidebar-menu'), format: 'iife', jsx: 'automatic',
    alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')) },
    nodePaths: [join(root, 'plugins/benchgo/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
    loader: { '.css': 'text', '.module.css': 'local-css', '.svg': 'text' },
    plugins: [{ name: 'sidebar-fixture', setup(build) {
      build.onLoad({ filter: /benchgo[\\/]client[\\/]index\.jsx$/ }, async ({ path }) => {
        // Mount the real sidebar without loading unrelated application entry points.
        const keep = ['shared/client/ui/index', 'sidebar-state.mjs', "from 'react'", 'icons.json', 'dsh-client-ui-primitives', 'iconsax.jsx', 'modules.mjs', 'session-info.mjs'];
        const source = (await readFile(path, 'utf8')).split('\n').filter(line => !line.startsWith('import ') || keep.some(value => line.includes(value))).join('\n');
        return { loader: 'jsx', resolveDir: dirname(path), contents: source + '\nexport {Projects}; export function setFixtureState(value){update(value);}' };
      });
      build.onResolve({ filter: /^@deepseek-ai\/dsh-client-ui-primitives$/ }, () => ({ path: 'primitives', namespace: 'official-source' }));
      build.onLoad({ filter: /.*/, namespace: 'official-source' }, () => ({ loader: 'ts', resolveDir: root, contents: `
        export {Tooltip} from './deepseek-harness/packages/client/ui-primitives/src/Tooltip.tsx';
        export {Modal} from './deepseek-harness/packages/client/ui-primitives/src/Modal.tsx';
        export {Menu} from './deepseek-harness/packages/client/ui-primitives/src/Menu.tsx';
        export {FishLogo} from './deepseek-harness/packages/client/ui-primitives/src/FishLogo.tsx';
        export {LinkIconMedium} from './deepseek-harness/packages/client/ui-primitives/src/LinkIcon.tsx';
        export * from './deepseek-harness/packages/client/ui-primitives/src/icons/index.tsx';
      ` }));
    } }, sharedUiStyles()], define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  const browser = await chromium.launch({ headless: true, executablePath });
  const screenshots = join(root, 'artifacts/sidebar-menu-fix');
  await mkdir(screenshots, { recursive: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(5000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const styles = bundle.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n');
    await page.setContent(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>${styles}body{margin:0;font-family:Arial,sans-serif;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}#root{display:flex}main{padding:40px}</style></head><body><div id="root"></div></body></html>`);
    await page.addScriptTag({ content: bundle.outputFiles.find(file => file.path.endsWith('.js')).text });
    const trigger = index => page.getByRole('button', { name: '对话操作：测试对话 ' + index, exact: true });
    const menu = page.locator('.cmd-actions-popover');
    const aligned = async index => {
      await page.waitForFunction(label => {
        const button = document.querySelector('button[aria-label="' + label + '"]'), menu = document.querySelector('.cmd-actions-popover');
        if (!button || !menu) return false;
        const a = button.getBoundingClientRect(), b = menu.getBoundingClientRect();
        return Math.abs(b.left - a.right - 4) < 1 && Math.abs(b.top - a.top) < 1;
      }, '对话操作：测试对话 ' + index);
    };
    await trigger(8).click(); await aligned(8);
    const beforeScroll = await menu.boundingBox();
    await page.locator('.cmd-sidebar-content').evaluate(element => { element.scrollTop += 80; });
    await aligned(8);
    const afterScroll = await menu.boundingBox();
    assert.ok(Math.abs(beforeScroll.y - afterScroll.y - 80) < 1, 'scrolling moves both trigger and menu');
    await page.locator('aside').evaluate(element => { element.style.width = '340px'; });
    await aligned(8);
    assert.ok(Math.abs((await menu.boundingBox()).x - afterScroll.x - 60) < 1, 'resizing sidebar moves both trigger and menu');
    await page.screenshot({ path: join(screenshots, 'conversation-data.png') });
    await page.keyboard.press('Escape'); await menu.waitFor({ state: 'detached' });
    assert.equal(await trigger(8).evaluate(element => element === document.activeElement), true);
    await trigger(5).click(); await aligned(5);
    await trigger(6).click(); await aligned(6);
    assert.equal(await trigger(5).getAttribute('aria-expanded'), 'false');
    assert.equal(await trigger(6).getAttribute('aria-expanded'), 'true');
    await page.setViewportSize({ width: 500, height: 600 });
    await page.waitForFunction(() => { const r = document.querySelector('.cmd-actions-popover')?.getBoundingClientRect(); return r && r.left >= 11 && r.right <= innerWidth - 11 && r.top >= 11 && r.bottom <= innerHeight - 11; });
    await page.screenshot({ path: join(screenshots, 'conversation-narrow.png') });
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.keyboard.press('Escape');
    await trigger(5).click(); await aligned(5);
    await page.locator('#cmd-recent-section').evaluate(element => element.setAttribute('inert', ''));
    await menu.waitFor({ state: 'detached' });
    await page.locator('#cmd-recent-section').evaluate(element => element.removeAttribute('inert'));
    for (const mode of ['loading', 'error', 'empty']) {
      await page.evaluate(mode => window.scenario(mode), mode);
      await page.waitForFunction(() => !document.querySelector('.cmd-session-row'));
      assert.equal(await menu.count(), 0);
      if (mode === 'loading') await page.getByText('正在读取项目…', { exact: true }).waitFor();
      if (mode === 'error') await page.getByRole('alert').waitFor();
      if (mode === 'empty') await page.getByText('暂无项目', { exact: true }).waitFor();
      await page.screenshot({ path: join(screenshots, 'conversation-' + mode + '.png') });
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
