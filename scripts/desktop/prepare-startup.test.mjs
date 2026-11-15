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
  assert.match(result, /await benchgoWorkbench\.publishReady\(\{ url: ready\.url, inspect: \(\) => host\.inspectQuit\(\) \}\)/);
  assert.match(result, /app\.once\('will-quit'.*benchgoWorkbench\.dispose/s);
  assert.match(result, /cleanupRetiredInstalls/);
  assert.throws(() => plugin.transform(source + source, main), /Official startup changed/);
});

test('changed official ready anchor fails closed before producing a Desktop bundle', async () => {
  const source = await readFile(main, 'utf8');
  const plugin = startupWindowPlugin(main);
  plugin.buildStart();
  assert.throws(() => plugin.transform(source.replace('const ready = await host.start();', 'const ready = await host.begin();'), main), /Official startup changed/);
});
