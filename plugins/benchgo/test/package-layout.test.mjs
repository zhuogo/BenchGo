import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { DelegationBridge } from '../lib/modules/harness/src/delegation.mjs';
import { LineProcess } from '../lib/modules/harness/src/line-process.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const packagePath = path => relative(root, path).split(sep).join('/');

test('published server entries include their relative module closure and native launch resources', { timeout: 30000 }, async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const packed = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root, encoding: 'utf8', shell: process.platform === 'win32', windowsHide: true, timeout: 20000,
  });
  assert.equal(packed.status, 0, packed.error?.message || packed.stderr);
  const published = new Set(JSON.parse(packed.stdout)[0].files.map(file => file.path));
  const entries = new Set([manifest.main, ...['.', './runtime', './harness-plugin', './superagent-plugin', './voice-plugin', './link-plugin'].map(key => manifest.exports[key])].map(path => resolve(root, path)));
  const checked = new Set();

  // esbuild resolves real static/dynamic imports; package dependencies remain external.
  // Native launch scripts and worklets use URL resources instead of import statements.
  for (;;) {
    const result = await build({
      absWorkingDir: root, entryPoints: [...entries], bundle: true, packages: 'external',
      platform: 'node', format: 'esm', target: 'node22', write: false, metafile: true,
      outdir: resolve(root, '.package-layout-check'), logLevel: 'silent',
    });
    const before = entries.size;
    for (const input of Object.keys(result.metafile.inputs)) {
      const absolute = resolve(root, input);
      const path = packagePath(absolute);
      assert.ok(!isAbsolute(path) && path !== '..' && !path.startsWith('../'), `server module escapes package: ${input}`);
      assert.ok(published.has(path), `server module omitted from npm package: ${path}`);
      if (checked.has(path)) continue;
      checked.add(path);
      const source = await readFile(absolute, 'utf8');
      for (const match of source.matchAll(/new URL\(\s*(['"])(\.[^'"]+\.(?:[cm]?js|ts))\1\s*,\s*import\.meta\.url\s*\)/g)) {
        entries.add(fileURLToPath(new URL(match[2], pathToFileURL(absolute))));
      }
    }
    if (entries.size === before) break;
  }

  for (const path of ['lib/modules/harness/src/runtime.mjs', 'lib/modules/harness/src/mcp.mjs', 'lib/modules/harness/src/isolated-launch.mjs', 'lib/modules/harness/src/providers/pi-permissions.ts', 'lib/modules/superagent/src/service.mjs', 'lib/modules/superagent/src/engine.mjs', 'lib/modules/voice/client/audio-worklet.js', 'lib/link.mjs']) {
    assert.ok(checked.has(path), `published entry graph must reach ${path}`);
  }
  assert.equal(published.has('lib/modules/superagent/client/index.jsx'), false, 'frontend source is compiled into the published client');
  for (const name of ['markdown.js', 'docx.js', 'sheet-worker.js', 'pdf.js', 'pdf-worker.js', 'resources.json', 'LICENSES.txt']) {
    assert.ok(published.has(`lib/preview/${name}`), `lazy preview asset omitted from package: ${name}`);
  }
  assert.equal([...published].some(path => /^(?:agents|autoagent|voice)\//.test(path)), false, 'replaced source directories are excluded from the package');
  for (const module of ['harness', 'superagent', 'voice']) {
    assert.ok(published.has(`lib/modules/${module}/package.json`));
    if (module !== 'superagent') assert.equal([...published].some(path => path.startsWith(`lib/modules/${module}/shared/`)), false, 'unrelated shared source is not copied into modules');
  }
  assert.ok(published.has('lib/modules/superagent/shared/pet-catalog.mjs'), 'pet composition catalog ships with the server');
  assert.ok([...published].some(path => path.startsWith('lib/modules/superagent/assets/pet/')), 'pet source provenance and assets ship with the plugin');
});

test('relocated delegation MCP script initializes and forwards commander_delegate calls', { timeout: 15000 }, async t => {
  const calls = [];
  const answer = { sessionId: 'child-fixture', status: 'completed', text: 'local fixture result' };
  const bridge = await new DelegationBridge({
    async delegate(sessionId, args) { calls.push({ sessionId, args }); return answer; },
  }).open();
  let wire;
  t.after(async () => { try { await wire?.close(); } finally { await bridge.close(); } });
  const capability = bridge.forSession('parent-fixture');
  assert.equal(packagePath(capability.script), 'lib/modules/harness/src/mcp.mjs');
  wire = new LineProcess(capability.command, [capability.script], {
    cwd: root, timeout: 5000,
    env: { COMMANDER_DELEGATE_URL: capability.url, COMMANDER_DELEGATE_TOKEN: capability.token },
  });

  const initialized = await wire.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'package-layout-test', version: '1.0.0' } });
  assert.equal(initialized.protocolVersion, '2024-11-05');
  assert.equal(initialized.serverInfo.name, 'BenchGo');
  assert.deepEqual(initialized.capabilities, { tools: {} });
  wire.notify('notifications/initialized');
  const listed = await wire.request('tools/list');
  assert.deepEqual(listed.tools.map(tool => tool.name), ['commander_delegate']);
  assert.deepEqual(listed.tools[0].inputSchema, capability.schema);
  assert.deepEqual(await wire.request('ping'), {});

  const args = { provider: 'codex', model: 'opaque/model:fixture', text: 'local test only' };
  const result = await wire.request('tools/call', { name: 'commander_delegate', arguments: args });
  assert.equal(result.isError, false);
  assert.deepEqual(JSON.parse(result.content[0].text), answer);
  assert.deepEqual(calls, [{ sessionId: 'parent-fixture', args }]);
  await assert.rejects(wire.request('tools/call', { name: 'renamed_delegate', arguments: args }), /Unsupported MCP method/);
  assert.equal(calls.length, 1, 'an unsupported tool must not dispatch a task');
});
