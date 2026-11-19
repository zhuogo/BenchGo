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

for (const eventName of ['visibilitychange', 'online']) {
  test(`${eventName} during a resource read queues one fresh snapshot without overlapping reads`, { skip: !executablePath && 'Chromium/Edge is required', timeout: 30000 }, async () => {
    const built = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
      import React from 'react'; import { createRoot } from 'react-dom/client';
      import { useResourceNavigation } from './plugins/link/client/resource-navigation.jsx';
      function App() {
        const navigation = useResourceNavigation(true, false);
        return <output>{navigation.pages['remote\\0recent']?.items?.[0]?.title || 'waiting'}</output>;
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
      let title = 'before', recentReads = 0, activeReads = 0, maxActiveReads = 0, started;
      const readStarted = new Promise(resolve => { started = resolve; });
      const deferred = new Promise(resolve => { releaseRead = resolve; });
      await page.route('**/*', async route => {
        if (new URL(route.request().url()).pathname !== '/api/commander-devices') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="root"></div>' });
        const input = route.request().postDataJSON();
        if (input.action === 'devices') return route.fulfill({ json: { devices: [{ id: 'local', kind: 'local' }, { id: 'remote', name: 'Remote', hostId: 'host', authorizationId: 'pair', status: 'online' }] } });
        if (input.action === 'resourceScope') return route.fulfill({ json: { scope: { mode: 'all', deviceIds: [] } } });
        assert.equal(input.action, 'resources');
        const snapshot = title;
        if (input.kind === 'recent') {
          recentReads++; activeReads++; maxActiveReads = Math.max(maxActiveReads, activeReads);
          if (recentReads === 1) { started(); await deferred; }
        }
        await route.fulfill({ json: { devices: [{ deviceId: 'remote', available: true, items: input.kind === 'recent' ? [{ deviceId: 'remote', kind: 'sessions', resourceId: 'session', title: snapshot }] : [], observedAt: recentReads, hasMore: false }] } });
        if (input.kind === 'recent') activeReads--;
      });
      await page.goto('http://127.0.0.1:17993/');
      await page.addScriptTag({ content: built.outputFiles.find(file => file.path.endsWith('.js')).text });
      await readStarted;
      title = 'after';
      await page.evaluate(name => {
        const target = name === 'online' ? window : document;
        target.dispatchEvent(new Event(name)); target.dispatchEvent(new Event(name));
      }, eventName);
      assert.equal(recentReads, 1, 'repeated invalidations coalesce while the current read is pending');
      releaseRead();
      await page.getByText('after', { exact: true }).waitFor();
      assert.equal(recentReads, 2, 'one queued refresh reads the snapshot created after the first request');
      assert.equal(maxActiveReads, 1, 'refresh requests never overlap for the same resource');
      assert.deepEqual(errors, []);
    } finally { releaseRead?.(); await browser.close(); }
  });
}
