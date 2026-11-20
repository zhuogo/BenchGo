import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startupWindowPlugin } from './prepare-startup.mjs';

const main = fileURLToPath(new URL('../../deepseek-harness/apps/desktop/lib/types/main.js', import.meta.url));

test('Desktop main claims common ownership before profile preparation and publishes official task inspection after ready', async () => {
  const source = await readFile(main, 'utf8');
  const plugin = startupWindowPlugin(main);
  plugin.buildStart();
  assert.equal(plugin.transform(source, `${main}.other`), null);
  const result = plugin.transform(source, main).code;
  plugin.generateBundle();
  assert(result.indexOf('benchgoWorkbench = await ensureBenchgoPlugin(process.resourcesPath)') < result.indexOf('const paths = resolveDesktopPaths()'));
  assert.match(result, /beginDesktopWorkbench\(\{ resources: resourcesPath, initialize: initializePluginProfile \}\)/);
  assert.match(result, /await Promise\.all\(\[authenticateWebHost\(ready\.url\), benchgoWorkbench\.publishReady\(\{ url: ready\.url, inspect: \(\) => host\.inspectQuit\(\) \}\)\]\)/);
  assert.match(result, /app\.once\('will-quit'.*benchgoWorkbench\.dispose/s);
  assert.match(result, /cleanupRetiredInstalls/);
  assert.throws(() => plugin.transform(source + source, main), /Official startup changed/);
});

test('shell navigation and Host startup overlap before the initial window can open', async () => {
  const source = await readFile(main, 'utf8');
  const result = startupWindowPlugin(main).transform(source, main).code;
  const reconcile = result.slice(result.indexOf('    const reconcileBackend ='), result.indexOf('    const manifest = JSON.parse(await readFile'));
  const setup = new Function('navigateMain', 'backend', 'manager', 'prepareHostEnvironment', 'openInitialWindow', 'benchgoStartupStage', `
    let startup, updateJournal;
    const applicationUrl = 'dsh://app/';
    const reportFatal = error => { throw error; };
    ${reconcile}
    return reconcileBackend;
  `);
  for (const first of ['shell', 'host']) {
    const shell = Promise.withResolvers();
    const host = Promise.withResolvers();
    const events = [];
    const backend = { host: {}, async start(prepare) { events.push('host'); await prepare(); await host.promise; } };
    const start = setup(
      () => { events.push('shell'); return shell.promise; },
      backend, { async applyRelease() {} }, async () => {},
      async () => { events.push('visible'); },
      stage => events.push(stage),
    );
    const ready = start();
    assert.equal(start(), ready);
    assert.deepEqual(events, ['shell-loading', 'shell', 'host']);
    const gates = { shell, host };
    gates[first].resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(events.includes('visible'), false);
    gates[first === 'shell' ? 'host' : 'shell'].resolve();
    await ready;
    assert.deepEqual(events.slice(-2), ['shell-loaded', 'visible']);
  }
});

test('changed official ready anchor fails closed before producing a Desktop bundle', async () => {
  const source = await readFile(main, 'utf8');
  const plugin = startupWindowPlugin(main);
  plugin.buildStart();
  assert.throws(() => plugin.transform(source.replace('const ready = await host.start();', 'const ready = await host.begin();'), main), /Official startup changed/);
});
