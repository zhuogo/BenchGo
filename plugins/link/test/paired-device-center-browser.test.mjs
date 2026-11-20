import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { officialUiEntries, officialUiLoaders } from '../scripts/official-ui.mjs';
import { sharedUiStyles } from '../../base/scripts/shared-ui.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const { build } = createRequire(new URL('../package.json', import.meta.url))('esbuild');
const { chromium } = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url))('playwright');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || [chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);

test('paired workbench opens the actual device center in wide and narrow layouts', { skip: !executablePath, timeout: 60000 }, async () => {
  const output = join(root, 'artifacts', 'link-paired-device-center');
  const result = await build({
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', target: 'es2022', outfile: join(output, 'app.js'),
    nodePaths: [join(root, 'plugins/link/node_modules'), join(root, 'plugins/base/node_modules')],
    alias: { react: join(root, 'plugins/link/node_modules/react'), 'react-dom': join(root, 'plugins/link/node_modules/react-dom'), ...await officialUiEntries() },
    plugins: [sharedUiStyles()], loader: { '.css': 'text', '.svg': 'text', '.json': 'json', ...officialUiLoaders },
    logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' },
    stdin: { resolveDir: root, loader: 'jsx', contents: `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { DeviceLauncher } from './plugins/link/client/device-launcher.jsx';
import { LinkWorkbenchEntry } from './plugins/link/client/workbench-entry.jsx';
import tokens from './deepseek-harness/packages/client/ui-theme/src/styles/design-platform.css';
import base from './deepseek-harness/packages/client/ui-theme/src/styles/base.css';
import commander from './plugins/base/client/style.css';
import mobile from './plugins/base/client/mobile-workbench.css';
const center = location.pathname.endsWith('/device-center/');
const nativeNavigation = !center && new URLSearchParams(location.search).get('navigation') === 'native';
document.body.toggleAttribute('data-ds-dark-theme', matchMedia('(prefers-color-scheme: dark)').matches);
globalThis.__DSH_LINK_WORKBENCH__ = !center;
globalThis.__DSH_DEVICE_CENTER__ = center;
globalThis.__DSH_PAIRED_DEVICE_CENTER__ = center;
globalThis.__DSH_DEVICE_PARENT_ORIGIN__ = center ? location.origin : '';
globalThis.__DSH_DEVICE_NAVIGATION__ = nativeNavigation ? { name: '手机连接' } : undefined;
globalThis.__DSH_NATIVE_MESSAGES__ = [];
globalThis.BenchGoDevices = nativeNavigation ? { postMessage(value) { globalThis.__DSH_NATIVE_MESSAGES__.push(JSON.parse(value)); } } : undefined;
createRoot(document.getElementById('root')).render(<><style>{tokens}{base}{commander}{mobile}</style>{center ? <LinkWorkbenchEntry /> : <><header className="cmd-mobile-navigation"><button type="button">工作台</button><div className="cmd-mobile-device"><DeviceLauncher compact={innerWidth < 768} /></div><span>当前会话</span></header><main>远端工作台内容</main></>}</>);
` },
  });
  await mkdir(output, { recursive: true });
  const script = result.outputFiles.find(file => file.path.endsWith('.js')).text;
  const css = result.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n');
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage({ hasTouch: true });
    const errors = [], calls = [];
    let mode = 'data', relayMode = 'data', enabled = false, retry, pending, pendingRelay;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/app.js')) return route.fulfill({ contentType: 'text/javascript', body: script });
      if (path.endsWith('/api/devices')) {
        const input = route.request().postDataJSON();
        calls.push(input);
        if (input.action === 'list') {
          if (mode === 'loading') return new Promise(resolve => { pending = () => resolve(route.abort()); });
          if (mode === 'error') return route.fulfill({ status: 503, json: { error: '设备读取暂时失败' } });
          return route.fulfill({ json: { activeId: 'local', devices: [{ id: 'local', kind: 'local', name: '远端主机' }, ...(mode === 'empty' ? [] : [{ id: 'paired', kind: 'paired', name: '已配对设备', deviceType: 'mobile' }])], capabilities: { relayManagement: true } } });
        }
        if (input.action === 'hostStatus') {
          if (relayMode === 'loading') return new Promise(resolve => { pendingRelay = () => resolve(route.abort()); });
          if (relayMode === 'error') return route.fulfill({ status: 503, json: { error: '中继读取暂时失败' } });
          const nodes = relayMode === 'empty' ? [] : [{ id: 'relay', url: 'https://relay.example.com', enabled, connected: enabled }];
          return route.fulfill({ json: { relay: { fingerprint: 'saved', nodes } } });
        }
        if (input.action === 'hostRelayPoolConfigure') { enabled = input.enabled; retry = input.requestId; return route.abort('connectionreset'); }
        if (input.action === 'hostRelayOperation') return route.fulfill({ json: { state: 'applied', requestId: retry, result: { application: { state: 'applied' } } } });
      }
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>' + css + 'body{margin:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}</style></head><body><div id="root"></div><script src="./app.js"></script></body></html>' });
    });
    for (const [width, theme] of [[1280, 'light'], [390, 'dark']]) {
      await page.setViewportSize({ width, height: 760 });
      await page.emulateMedia({ colorScheme: theme });
      const narrow = width < 768;
      const workbench = 'http://localhost/link/workbench/';
      const deviceButtons = page.locator('.cmd-mobile-device button');
      await page.goto(workbench + '?navigation=native');
      const switchDevice = page.getByRole('button', { name: '切换设备：手机连接', exact: true });
      await switchDevice.waitFor();
      assert.equal(await deviceButtons.count(), narrow ? 1 : 2);
      if (narrow) {
        await switchDevice.tap();
        await switchDevice.press('Enter');
        assert.equal(await page.evaluate(() => globalThis.__DSH_NATIVE_MESSAGES__.filter(message => message.type === 'dsh-devices:show').length), 2);
        assert.equal(await page.getByRole('menu').count(), 0);
        assert.equal(await page.locator('.dsh-device-dialog[open]').count(), 0);
      }
      for (const state of ['loading', 'error', 'empty', 'data']) {
        mode = state;
        await page.goto(narrow ? workbench : workbench + '?navigation=native');
        const launcher = page.getByRole('button', { name: '设备中心', exact: true });
        if (narrow) {
          await launcher.waitFor();
          assert.equal(await deviceButtons.count(), 1);
          const bounds = await launcher.boundingBox();
          assert(bounds.width >= 44 && bounds.height >= 44);
          if (state === 'data') await launcher.press('Enter');
          else await launcher.tap();
          assert.equal(await page.getByRole('menu').count(), 0);
        } else {
          await launcher.click();
        }
        const center = page.frameLocator('iframe[title="BenchGo设备中心"]');
        await center.getByText({ loading: '正在读取设备…', error: '设备读取暂时失败', empty: '没有其他已配对设备', data: '已配对设备' }[state], { exact: true }).first().waitFor();
        assert(await center.locator('html').evaluate(node => node.scrollWidth <= node.clientWidth));
        assert.equal(await center.locator('html').getAttribute('data-dsh-device-theme'), theme);
        const background = await center.locator('main.dc-root').evaluate(node => getComputedStyle(node).backgroundColor);
        assert.equal(Number(background.match(/\d+/)[0]) < 128, theme === 'dark');
        await page.screenshot({ path: join(output, `${state}-${width}.png`) });
        if (state === 'loading') { await pending?.(); pending = undefined; }
        if (state === 'error') {
          mode = 'data';
          await center.getByRole('button', { name: '重试读取设备' }).click();
          await center.getByText('已配对设备', { exact: true }).waitFor();
        }
        if (state === 'data') {
          assert.equal(await center.getByRole('button', { name: '添加设备' }).count(), 0);
          if (narrow) {
            const topbar = await center.locator('.dc-topbar').boundingBox();
            const tabs = await center.getByRole('tablist').boundingBox();
            const back = await center.getByRole('button', { name: '返回工作台' }).boundingBox();
            const refresh = await center.getByRole('button', { name: '刷新设备' }).boundingBox();
            assert(tabs.y - topbar.y - topbar.height <= 8);
            assert([tabs, back, refresh].every(bounds => bounds.width >= 44 && bounds.height >= 44));
            relayMode = 'loading';
          }
          await center.getByRole('tab', { name: '中继池' }).click();
          if (narrow) {
            await center.getByText('正在读取中继…', { exact: true }).waitFor();
            await page.screenshot({ path: join(output, 'relay-loading-390.png') });
            await page.waitForFunction(() => document.querySelector('dialog')?.open);
            relayMode = 'error';
            await pendingRelay?.();
            await center.getByText(/无法读取中继状态/).waitFor();
            await page.screenshot({ path: join(output, 'relay-error-390.png') });
            relayMode = 'empty';
            await center.getByRole('button', { name: '重试读取', exact: true }).click();
            await center.getByRole('heading', { name: '尚未添加中继' }).waitFor();
            await page.screenshot({ path: join(output, 'relay-empty-390.png') });
            relayMode = 'data';
            await center.getByRole('button', { name: '刷新中继', exact: true }).click();
          }
          await center.getByText('relay.example.com', { exact: true }).waitFor();
          assert.equal(await center.getByRole('button', { name: '添加中继' }).count(), 0);
          await page.screenshot({ path: join(output, `relay-${width}.png`) });
          if (narrow) {
            await center.getByRole('button', { name: '启用', exact: true }).click();
            await center.getByRole('button', { name: '查询保存结果' }).click();
            await center.getByText('中继设置已保存', { exact: true }).waitFor();
            await center.getByRole('button', { name: '停用', exact: true }).waitFor();
            assert.equal(calls.findLast(row => row.action === 'hostRelayOperation').requestId, calls.findLast(row => row.action === 'hostRelayPoolConfigure').requestId);
          }
        }
        await center.getByRole('button', { name: '返回工作台' }).click();
        await page.locator('.dsh-device-dialog').waitFor({ state: 'hidden' });
        await page.getByText('远端工作台内容').waitFor();
        if (narrow && state === 'data') assert(await launcher.evaluate(node => document.activeElement === node));
      }
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
