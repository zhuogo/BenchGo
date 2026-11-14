import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sharedUiStyles } from '../../benchgo/scripts/shared-ui.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
// Reuse the pinned official ESM client when this worktree shares its built dependency tree.
const checkout = join(root, 'deepseek-harness');
const official = existsSync(join(checkout, 'packages/api/gateway/lib/client.node.js')) ? checkout : dirname(realpathSync(join(checkout, 'node_modules')));
const requireOfficial = createRequire(join(official, 'packages/api/gateway/package.json'));
const { chromium } = require('playwright');
const { build } = createRequire(new URL('../../benchgo/package.json', import.meta.url))('esbuild');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || [chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);

async function fixture() {
  const bundle = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';
    import {AssistantSidebarEntry} from './plugins/superagent/client/index.jsx';
    import {installIconSprite} from './deepseek-harness/packages/client/ui-theme/src/client/icon-sprite.ts';
    import css from './plugins/superagent/client/style.css';import hostCss from './plugins/benchgo/client/style.css';
    import tokens from './deepseek-harness/packages/client/ui-theme/src/styles/design-platform.css';import themeBase from './deepseek-harness/packages/client/ui-theme/src/styles/base.css';
    installIconSprite({effect:effect=>effect(),on(){}},undefined);
    const panel={activePanelId:'benchgo-assistant'},sessions={ids:[],byId:{}},statuses=new Map();
    const ctx={layout:{panelInfo:{getSnapshot:()=>panel,subscribe:()=>()=>{}},selectPanel:id=>window.openedPanels.push(id)},sessions:{list:{getSnapshot:()=>sessions,subscribe:()=>()=>{}}},uiSession:{sessionStatus:{getSnapshot:()=>statuses,subscribe:()=>()=>{}}}};
    window.openedPanels=[];window.threadEvents=[];
    document.addEventListener('benchgo:assistant-thread',event=>window.threadEvents.push(event.detail));
    createRoot(document.getElementById('root')).render(<><style>{tokens}{themeBase}{hostCss}{css}</style><aside style={{width:208}}><AssistantSidebarEntry ctx={ctx}/></aside><main><textarea aria-label='当前草稿' defaultValue='保留这段草稿'/><div aria-label='全局任务'>所有来源的任务</div></main></>);
  ` }, bundle: true, write: false, outdir: join(root, 'artifacts', 'unused-sidebar-list-test'), format: 'iife', jsx: 'automatic',
    nodePaths: [join(root, 'plugins/benchgo/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
    alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')),
      '@deepseek-ai/dsh-util-workspace-path': join(root, 'deepseek-harness/packages/util/workspace-path/src/index.ts'),
      '@deepseek-ai/dsh-api-gateway/client': requireOfficial.resolve('@deepseek-ai/dsh-api-gateway/client') },
    loader: { '.css': 'text', '.module.css': 'local-css', '.svg': 'text', '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' }, plugins: [{ name: 'official-sidebar-primitives-source', setup(build) {
      // Use the pinned official components directly when workspace lib outputs are absent.
      build.onResolve({ filter: /^@deepseek-ai\/dsh-client-ui-primitives$/ }, () => ({ path: 'primitives', namespace: 'official-source' }));
      build.onLoad({ filter: /.*/, namespace: 'official-source' }, () => ({ loader: 'ts', resolveDir: root, contents: `
        export {Tooltip} from './deepseek-harness/packages/client/ui-primitives/src/Tooltip.tsx';
        export {Modal} from './deepseek-harness/packages/client/ui-primitives/src/Modal.tsx';
        export {Menu} from './deepseek-harness/packages/client/ui-primitives/src/Menu.tsx';
        export {Switch} from './deepseek-harness/packages/client/ui-primitives/src/Switch.tsx';
        export {MarkdownText} from './deepseek-harness/packages/client/ui-primitives/src/markdown/MarkdownText.tsx';
        export {writeClipboard} from './deepseek-harness/packages/client/ui-primitives/src/clipboard.ts';
        export * from './deepseek-harness/packages/client/ui-primitives/src/icons/index.tsx';
      ` }));
    } }, sharedUiStyles()], define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  const script = bundle.outputFiles.find(file => file.path.endsWith('.js')).text;
  const styles = bundle.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${styles}body{margin:0;font-family:var(--dsw-font-family,Arial,sans-serif);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}#root{height:100vh}.ba-root{min-width:0!important}</style></head><body><div id="root"></div><script>${script.replaceAll('</script', '<\\/script')}</script></body></html>`;
}

test('sidebar switches only its list, preserves source identities and renders all states at narrow widths', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors = [], calls = [];
  page.on('pageerror', error => errors.push(error.message));
  const html = await fixture(), screenshots = join(root, 'artifacts', 'sidebar-im-browser');
  await mkdir(screenshots, { recursive: true });
  let mode = 'loading', release;
  const gate = new Promise(resolve => { release = resolve; });
  const source = (id, key, conversationId, sourceType = 'group', channel = 'feishu') => ({
    id, sessionId: `existing-${id}`, title: id, sourceKey: `channel:${key.repeat(64)}`,
    source: { channel, sourceType, conversationId, ...(sourceType === 'direct' ? { senderName: '张三' } : { conversationName: id }), ...(sourceType === 'topic' ? { topicId: 'real-topic' } : {}) },
  });
  const threads = [{ id: 'manual', title: '普通旁聊', sessionId: 'manual-existing' },
    source('固定群聊', 'a', 'chat-a'), source('固定私聊', 'b', 'chat-b', 'direct'),
    source('另一个真实群聊', 'c', 'chat-c'), source('断开渠道历史', 'd', 'chat-d', 'group', 'telegram')];
  try {
    await page.addInitScript(() => {
      localStorage.setItem('benchgo.assistant.sidebarExpanded', 'true');
      if (!localStorage.getItem('benchgo.assistant.sidebarList')) localStorage.setItem('benchgo.assistant.sidebarList', 'im');
    });
    await page.route('**/*', async route => {
      if (route.request().url() === 'http://localhost/') return route.fulfill({ contentType: 'text/html', body: html });
      if (!route.request().url().endsWith('/api/commander/assistant')) return route.abort();
      const input = route.request().postDataJSON(); calls.push(input);
      if (mode === 'loading') await gate;
      if (input.action === 'connectionCatalog') {
        if (mode === 'error') return route.fulfill({ status: 503, json: { error: '连接状态读取失败' } });
        return route.fulfill({ json: { channels: [
          { id: 'feishu', label: '飞书', status: { enabled: mode !== 'disconnected', authentication: 'verified', connection: { state: mode === 'disconnected' ? 'disabled' : 'connected' } } },
          { id: 'telegram', label: 'Telegram', status: { enabled: true, authentication: 'verified', connection: { state: 'failed' } } },
        ] } });
      }
      assert.equal(input.action, 'state', 'list switching never mutates or starts a session');
      return route.fulfill({ json: { state: { threads: mode === 'empty' ? [] : threads } } });
    });
    await page.goto('http://localhost/');
    await page.getByLabel('正在加载IM 会话').waitFor();
    await page.screenshot({ path: join(screenshots, 'loading.png') });
    mode = 'data'; release();
    await page.getByRole('button', { name: '固定群聊', exact: false }).waitFor();
    assert.equal(await page.locator('.cmd-session-row').count(), 3);
    assert.equal(await page.getByText('普通旁聊', { exact: true }).count(), 0);
    assert.equal(await page.getByText('断开渠道历史', { exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: '新建旁聊' }).count(), 0);
    assert.equal(await page.getByText('来源待核实', { exact: true }).count(), 0);
    await page.screenshot({ path: join(screenshots, 'data.png') });
    assert.equal(await page.locator('aside').evaluate(node => node.scrollWidth <= node.clientWidth), true);
    assert.equal(await page.locator('[data-source="im"] .ba-thread-status').count(), 0, 'the IM type is not repeated at the right edge');
    assert.equal(await page.locator('[data-source="im"] .ba-thread-title').filter({ hasText: '飞书私聊 · 张三' }).count(), 1);
    const alignment = await page.locator('.ba-sidebar-toolbar').evaluate(node => {
      const tabs = node.querySelector('[role="tablist"]').getBoundingClientRect(), toggle = node.querySelector('.cmd-section-toggle').getBoundingClientRect();
      return { centerDelta: Math.abs(tabs.y + tabs.height / 2 - toggle.y - toggle.height / 2), width: tabs.width, toggleWidth: toggle.width };
    });
    assert.ok(alignment.centerDelta < 1, JSON.stringify(alignment));
    assert.ok(alignment.width < 120, 'the two segments stay compact');
    assert.equal(alignment.toggleWidth, 28);
    await page.getByRole('button', { name: '收起IM 会话', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.ba-sidebar-body').getBoundingClientRect().height < 1);
    assert.equal(await page.locator('.ba-sidebar-body').getAttribute('inert'), '');
    await page.screenshot({ path: join(screenshots, 'collapsed.png') });
    await page.getByRole('tab', { name: 'IM', exact: true }).click();
    await page.getByRole('button', { name: '收起IM 会话', exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('.ba-sidebar-body').getBoundingClientRect().height > 50);
    await page.getByRole('tab', { name: 'IM', exact: true }).focus();
    await page.keyboard.press('ArrowLeft');
    await page.locator('.cmd-session').filter({ hasText: '普通旁聊' }).waitFor();
    assert.equal(await page.locator('.cmd-session-row').count(), 1);
    await page.screenshot({ path: join(screenshots, 'keyboard-side.png') });
    const more = page.getByRole('button', { name: '对话操作：普通旁聊', exact: true });
    await page.locator('.cmd-session-row').hover();
    await more.click();
    const menu = page.getByRole('menu');
    await menu.waitFor();
    const followsTrigger = async () => page.waitForFunction(() => {
      const trigger = document.querySelector('.cmd-session-more[aria-expanded="true"]');
      const popup = document.querySelector('[role="menu"].cmd-actions-popover');
      if (!trigger || !popup) return false;
      const anchor = trigger.getBoundingClientRect(), rect = popup.getBoundingClientRect();
      return Math.abs(rect.left - anchor.right - 4) < 1 && Math.abs(rect.top - anchor.top) < 1;
    });
    await followsTrigger();
    assert.equal(await more.getAttribute('aria-expanded'), 'true');
    const originalMenu = await menu.boundingBox();
    await page.locator('aside').evaluate(node => { node.style.marginLeft = '40px'; node.style.marginTop = '60px'; });
    await followsTrigger();
    const movedMenu = await menu.boundingBox();
    assert.ok(Math.abs(movedMenu.x - originalMenu.x - 40) < 1, 'menu follows horizontal sidebar movement');
    assert.ok(Math.abs(movedMenu.y - originalMenu.y - 60) < 1, 'menu follows vertical sidebar movement');
    const menuScreenshots = join(root, 'artifacts', 'sidebar-menu-fix');
    await mkdir(menuScreenshots, { recursive: true });
    await page.screenshot({ path: join(menuScreenshots, 'assistant.png') });
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'hidden' });
    assert.equal(await more.getAttribute('aria-expanded'), 'false');
    assert.equal(await more.evaluate(node => document.activeElement === node), true);
    await page.locator('aside').evaluate(node => { node.style.marginLeft = ''; node.style.marginTop = ''; });
    await page.getByRole('tab', { name: '旁聊', exact: true }).focus();
    assert.equal(await page.getByRole('button', { name: '新建旁聊' }).count(), 1);
    assert.deepEqual(await page.evaluate(() => window.threadEvents), []);
    assert.deepEqual(await page.evaluate(() => window.openedPanels), []);
    assert.equal(await page.getByRole('textbox', { name: '当前草稿' }).inputValue(), '保留这段草稿');
    assert.equal(await page.getByLabel('全局任务').textContent(), '所有来源的任务');
    await page.keyboard.press('End');
    await page.getByRole('button', { name: '固定群聊', exact: false }).waitFor();
    await page.getByRole('button', { name: '固定群聊', exact: false }).click();
    const opened = await page.evaluate(() => window.threadEvents);
    assert.ok(opened.length > 0 && opened.every(id => id === '固定群聊'));
    assert.equal(await page.evaluate(() => localStorage.getItem('benchgo.assistant.sidebarList')), 'im');
    await page.reload();
    await page.getByRole('tab', { name: 'IM', exact: true }).waitFor();
    assert.equal(await page.getByRole('tab', { name: 'IM', exact: true }).getAttribute('aria-selected'), 'true');
    mode = 'empty';
    await page.evaluate(() => document.dispatchEvent(new Event('benchgo:assistant-changed')));
    await page.getByText('暂无 IM 会话', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '连接渠道', exact: true }).count(), 1);
    await page.screenshot({ path: join(screenshots, 'empty.png') });
    mode = 'disconnected';
    await page.evaluate(() => document.dispatchEvent(new Event('benchgo:assistant-changed')));
    await page.getByText('尚未连接渠道', { exact: true }).waitFor();
    await page.screenshot({ path: join(screenshots, 'disconnected.png') });
    mode = 'error';
    await page.evaluate(() => document.dispatchEvent(new Event('benchgo:assistant-changed')));
    await page.getByText('IM 会话暂时无法更新', { exact: true }).waitFor();
    await page.screenshot({ path: join(screenshots, 'error.png') });
    mode = 'data';
    await page.getByRole('button', { name: '重试加载', exact: true }).click();
    await page.getByRole('button', { name: '飞书私聊 · 张三', exact: false }).waitFor();
    assert.equal(await page.locator('.ba-sidebar-state[data-kind="error"]').count(), 0);
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await page.evaluate(() => {
      document.body.toggleAttribute('data-ds-dark-theme', true);
      document.documentElement.style.colorScheme = 'dark';
    });
    const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert.match(background, /^rgb\(/, 'the official theme resolves to an opaque background');
    assert.ok(background.match(/\d+/g).slice(0, 3).every(value => Number(value) < 80), `expected a real dark background, received ${background}`);
    await page.screenshot({ path: join(screenshots, 'dark-reduced-motion.png') });
    assert.equal(calls.every(input => ['state', 'connectionCatalog'].includes(input.action)), true);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
