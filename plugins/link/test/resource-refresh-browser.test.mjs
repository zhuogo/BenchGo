import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { officialUiEntries, officialUiLoaders } from '../scripts/official-ui.mjs';
import { sharedUiStyles } from '../../base/scripts/shared-ui.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(new URL('../package.json', import.meta.url));
const { build } = require('esbuild');
const { chromium } = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url))('playwright');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || [chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);

test('owner and paired workbenches share the scope menu and restore saved selections', { skip: !executablePath && 'Chromium/Edge is required', timeout: 30000 }, async () => {
  const built = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React from 'react'; import { createRoot } from 'react-dom/client';
    import { useResourceNavigation, ResourceScope } from './plugins/link/client/resource-navigation.jsx';
    function App() {
      const navigation = useResourceNavigation(true, false);
      return <><ResourceScope navigation={navigation}/><output data-ready={navigation.ready}>{navigation.scope.mode}:{navigation.scope.deviceIds.join(',')}</output></>;
    }
    createRoot(document.getElementById('root')).render(<App/>);
  ` }, bundle: true, write: false, outdir: join(root, 'artifacts/unused-resource-scope'), format: 'iife', jsx: 'automatic', target: 'es2022',
  alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')), ...await officialUiEntries() },
  nodePaths: [join(root, 'plugins/link/node_modules'), join(root, 'plugins/base/node_modules')], plugins: [sharedUiStyles()],
  loader: { '.css': 'text', '.svg': 'text', ...officialUiLoaders }, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    for (const mode of ['owner', 'paired', 'legacy-group']) {
      const page = await browser.newPage(); page.setDefaultTimeout(5000);
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      let scope = { mode: 'current', deviceIds: [] }, saves = 0;
      const paths = [];
      await page.addInitScript(mode => {
        if (mode === 'owner') return;
        globalThis.__DSH_LINK_WORKBENCH__ = true;
        if (mode === 'paired') globalThis.__DSH_LINK_RESOURCES__ = true;
        else globalThis.__DSH_LINK_GROUP_RESOURCES__ = true;
      }, mode);
      await page.route('**/*', async route => {
        if (route.request().method() !== 'POST') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="root"></div>' });
        paths.push(new URL(route.request().url()).pathname);
        const input = route.request().postDataJSON();
        if (input.action === 'devices') return route.fulfill({ json: { devices: [{ id: 'local', kind: 'local', name: '工作台主机' }] } });
        if (input.action === 'setResourceScope') { scope = input.scope; saves++; }
        assert.ok(['resourceScope', 'setResourceScope'].includes(input.action));
        return route.fulfill({ json: { scope } });
      });
      const mount = async () => {
        await page.goto('http://127.0.0.1:17993/link/workbench/');
        await page.addScriptTag({ content: built.outputFiles.find(file => file.path.endsWith('.js')).text });
        await page.locator('output[data-ready="true"]').waitFor();
      };
      await mount();
      await page.getByRole('button', { name: '显示范围', exact: true }).click();
      await page.getByText('所有已连接设备', { exact: true }).click();
      await page.waitForFunction(() => document.querySelector('output').textContent === 'all:');
      await page.getByRole('button', { name: '显示范围', exact: true }).click();
      await page.getByText('指定设备', { exact: true }).click();
      await page.getByRole('checkbox', { name: '工作台主机' }).check();
      await page.waitForFunction(() => document.querySelector('output').textContent === 'selected:local' && !document.querySelector('input[type="checkbox"]').disabled);
      assert.equal(saves, 3);
      await mount();
      assert.equal(await page.locator('output').textContent(), 'selected:local');
      assert.deepEqual([...new Set(paths)], [mode === 'owner' ? '/api/commander-devices' : '/link/workbench/api/group-resources']);
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser.close(); }
});

for (const eventName of ['visibilitychange', 'online', 'project-saved', 'project-saved-busy-recent', 'project-saved-busy-devices']) {
  test(`${eventName} during a resource read queues one fresh snapshot without overlapping reads`, { skip: !executablePath && 'Chromium/Edge is required', timeout: 30000 }, async () => {
    const projectSaved = eventName.startsWith('project-saved');
    const blocked = eventName.replace('project-saved-busy-', '');
    const busy = blocked === 'recent' || blocked === 'devices';
    const kind = projectSaved ? 'projects' : 'recent';
    const built = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
      import React from 'react'; import { createRoot } from 'react-dom/client';
      import { useResourceNavigation } from './plugins/link/client/resource-navigation.jsx';
      function App() {
        const navigation = useResourceNavigation(true, false);
        window.saveProject = () => navigation.refreshProjects(navigation.remote[0]);
        return <output>{navigation.pages['remote\\0${kind}']?.items?.[0]?.title || 'waiting'}</output>;
      }
      createRoot(document.getElementById('root')).render(<App/>);
    ` }, bundle: true, write: false, outdir: join(root, 'artifacts/unused-resource-refresh'), format: 'iife', jsx: 'automatic', target: 'es2022',
    alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')), ...await officialUiEntries() },
    nodePaths: [join(root, 'plugins/link/node_modules'), join(root, 'plugins/base/node_modules')], plugins: [sharedUiStyles()],
    loader: { '.css': 'text', '.svg': 'text', ...officialUiLoaders }, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
    const browser = await chromium.launch({ headless: true, executablePath });
    let releaseRead;
    try {
      const page = await browser.newPage(); page.setDefaultTimeout(5000);
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      let title = 'before', reads = 0, activeReads = 0, maxActiveReads = 0, started, deviceReads = 0;
      const kinds = [];
      const readStarted = new Promise(resolve => { started = resolve; });
      const deferred = new Promise(resolve => { releaseRead = resolve; });
      await page.route('**/*', async route => {
        if (new URL(route.request().url()).pathname !== '/api/commander-devices') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="root"></div>' });
        const input = route.request().postDataJSON();
        if (input.action === 'devices') {
          if (++deviceReads === 2 && blocked === 'devices') { started(); await deferred; }
          return route.fulfill({ json: { devices: [{ id: 'local', kind: 'local' }, { id: 'remote', name: 'Remote', hostId: 'host', authorizationId: 'pair', status: 'online' }] } });
        }
        if (input.action === 'resourceScope') return route.fulfill({ json: { scope: { mode: 'all', deviceIds: [] } } });
        assert.equal(input.action, 'resources');
        kinds.push(input.kind);
        const snapshot = title;
        if (busy && input.kind === blocked) { started(); await deferred; }
        if (input.kind === kind) {
          reads++; activeReads++; maxActiveReads = Math.max(maxActiveReads, activeReads);
          if (reads === 1 && !busy) { started(); await deferred; }
        }
        await route.fulfill({ json: { devices: [{ deviceId: 'remote', available: true, items: input.kind === kind ? [{ deviceId: 'remote', kind, resourceId: 'item', title: snapshot }] : [], observedAt: reads, hasMore: false }] } });
        if (input.kind === kind) activeReads--;
      });
      await page.goto('http://127.0.0.1:17993/');
      await page.addScriptTag({ content: built.outputFiles.find(file => file.path.endsWith('.js')).text });
      await readStarted;
      title = 'after';
      await page.evaluate(name => {
        if (name.startsWith('project-saved')) { window.saveProject(); if (name === 'project-saved') window.saveProject(); return; }
        const target = name === 'online' ? window : document;
        target.dispatchEvent(new Event(name)); target.dispatchEvent(new Event(name));
      }, eventName);
      if (!busy) {
        assert.equal(reads, 1, 'repeated invalidations coalesce while the current read is pending');
        releaseRead();
      }
      await page.getByText('after', { exact: true }).waitFor();
      releaseRead();
      assert.equal(reads, 2, 'one queued refresh reads the snapshot created after the first request');
      if (projectSaved) {
        assert.equal(kinds.filter(kind => kind === 'recent').length, 1);
        assert.equal(kinds.filter(kind => kind === 'capabilities').length, 1);
      }
      assert.equal(maxActiveReads, 1, 'refresh requests never overlap for the same resource');
      assert.deepEqual(errors, []);
    } finally { releaseRead?.(); await browser.close(); }
  });
}
