import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareSidebarRuntime } from '../scripts/sidebar-runtime.mjs';
import { mountWorkbench } from '../src/plugin.mjs';

const require = createRequire(new URL('../../package.json', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

test('deployed sidebar runs without its npm source graph and serves real lazy assets and file APIs', { timeout: 30000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'benchgo-sidebar-runtime-'));
  const output = join(temporary, 'lib'), workspace = join(temporary, 'workspace');
  const disposers = [], routes = [], upgrades = [], pending = [], warnings = [];
  let server;
  try {
    const manifest = await prepareSidebarRuntime({ output });
    await mkdir(workspace);
    await writeFile(join(temporary, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    await writeFile(join(workspace, 'fixture.txt'), 'Before edit\n');
    await writeFile(join(workspace, 'preview.html'), '<!doctype html><title>Preview</title><p>Preview works</p>');
    const packages = new Set(manifest.externalImports.filter(name => !name.startsWith('node:')).map(name => name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name));
    for (const name of packages) {
      const destination = join(temporary, 'node_modules', name);
      await mkdir(dirname(destination), { recursive: true });
      await symlink(dirname(require.resolve(`${name}/package.json`)), destination, process.platform === 'win32' ? 'junction' : 'dir');
    }
    const isolatedRequire = createRequire(join(temporary, 'package.json'));
    for (const name of ['dsh-better-sidebar', 'react-icons', 'mermaid', '@deepseek-ai/schemastery']) assert.throws(() => isolatedRequire.resolve(name), { code: 'MODULE_NOT_FOUND' });
    const sidebar = await import(pathToFileURL(join(output, 'sidebar-host.mjs')).href);
    assert.equal(sidebar.name, 'dsh-better-sidebar');
    assert.equal(typeof sidebar.apply, 'function');
    for (const record of manifest.files) {
      const bytes = await readFile(join(output, record.path));
      assert.equal(bytes.length, record.bytes);
      assert.equal(sha256(bytes), record.sha256);
    }
    const originalRoot = dirname(require.resolve('dsh-better-sidebar/package.json'));
    for (const name of ['editor', 'mermaid', 'locale', 'terminal']) assert.deepEqual(await readFile(join(output, `client-${name}.js`)), await readFile(join(originalRoot, `lib/client-${name}.js`)));
    assert.deepEqual(manifest.sources.map(source => [source.name, source.version]), [
      ['@deepseek-ai/cosmokit', '1.8.6'], ['@deepseek-ai/schemastery', '3.18.5'], ['dsh-better-sidebar', '0.30.1'],
    ]);
    const notices = await readFile(join(output, 'SIDEBAR-RUNTIME-LICENSES.txt'), 'utf8');
    for (const name of ['@codemirror/view', '@xterm/xterm', 'mermaid', 'react-icons', 'fastdom', 'strictdom']) assert.ok(notices.includes(`## ${name}@`), `Missing bundled ${name} notice`);
    assert.match(notices, /Copyright \(c\) 2016 Wilson Page/);
    assert.match(notices, /Copyright \(c\) 2013 Wilson Page/);
    const ctx = {
      fiber: { entry: { options: {} } },
      connection: { requestRejection: request => request.headers['x-test-deny'] ? 403 : undefined },
      webServer: { register(route) { routes.push(route); return () => {}; }, registerUpgrade(route) { upgrades.push(route); return () => {}; } },
      sessions: new Map(), tools: { register() { throw new Error('Sidebar model tools must stay disabled'); } },
      systemPrompt: {}, logger: { warn: (...args) => warnings.push(args), info() {} },
      provide(name, service) { this[name] = service; },
      effect(callback) { const dispose = callback(); if (typeof dispose === 'function') disposers.push(dispose); return dispose; },
      on() { return () => {}; }, get(name) { return this[name]; },
      inject(services, callback) {
        if (!services.every(name => this.get(name))) return;
        const result = callback(this); if (result?.then) pending.push(result);
      },
    };
    const workbench = await mountWorkbench(ctx, {
      directory: join(temporary, 'settings'), loadSidebar: async () => sidebar,
      loadSsh: async () => ({ apply() {} }),
    });
    while (pending.length) await Promise.all(pending.splice(0));
    assert.equal(workbench.snapshot().sidebar.status, 'ready', JSON.stringify(warnings));
    assert.ok(upgrades.length > 0, 'Sidebar sockets must still be registered');
    server = createServer(async (request, response) => {
      try {
        const pathname = new URL(request.url, 'http://localhost').pathname;
        const route = routes.find(candidate => candidate.kind === 'exact' ? pathname === candidate.path : pathname.startsWith(candidate.path));
        if (route) await route.handler(request, response);
        else { response.writeHead(404); response.end(); }
      } catch (error) { response.writeHead(500); response.end(error.message); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const name of ['editor', 'mermaid', 'locale', 'terminal']) {
      const path = `/sidebar/bundle/${name}.js`, bytes = await readFile(join(output, `client-${name}.js`));
      const response = await fetch(base + path);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-cache');
      const etag = response.headers.get('etag');
      assert.ok(etag);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
      const head = await fetch(base + path, { method: 'HEAD' });
      assert.equal(head.status, 200); assert.equal(Number(head.headers.get('content-length')), bytes.length);
      assert.equal(await head.text(), '');
      assert.equal((await fetch(base + path, { headers: { 'if-none-match': etag } })).status, 304);
      assert.equal((await fetch(base + path, { method: 'POST' })).status, 405);
    }
    assert.equal((await fetch(base + '/sidebar/bundle/unknown.js')).status, 404);
    assert.equal((await fetch(base + '/sidebar/bundle/editor.js', { headers: { 'x-test-deny': '1' } })).status, 403);
    const api = async (method, payload) => {
      const response = await fetch(`${base}/sidebar/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'closure-fixture', cwd: workspace, ...payload }) });
      const value = await response.json();
      assert.equal(response.status, 200, JSON.stringify(value));
      assert.equal(value.ok, true, JSON.stringify(value));
      return value.value;
    };
    const tree = await api('fs.tree', {});
    assert.ok(tree.entries.some(entry => entry.name === 'fixture.txt'));
    const read = await api('fs.read', { path: 'fixture.txt' });
    assert.equal(read.content, 'Before edit\n');
    const write = await fetch(`${base}/sidebar/write?${new URLSearchParams({ sessionId: 'closure-fixture', cwd: workspace, path: 'fixture.txt', expectedMtimeMs: String(read.mtimeMs) })}`, { method: 'POST', body: 'After edit\n' });
    assert.equal(write.status, 200, await write.text());
    assert.equal(await readFile(join(workspace, 'fixture.txt'), 'utf8'), 'After edit\n');
    assert.match(await (await fetch(`${base}/sidebar/file?${new URLSearchParams({ sessionId: 'closure-fixture', cwd: workspace, path: 'preview.html' })}`)).text(), /Preview works/);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    for (const dispose of disposers.reverse()) await dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});

test('sidebar dependency changes fail before touching existing deployment files', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'benchgo-sidebar-review-'));
  try {
    const source = join(temporary, 'source'), output = join(temporary, 'output');
    await mkdir(source); await mkdir(output);
    await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'dsh-better-sidebar', version: '0.30.2' }));
    await writeFile(join(output, 'sidebar-host.mjs'), 'previous verified host');
    await assert.rejects(prepareSidebarRuntime({ source, output }), /version requires integration review/);
    assert.equal(await readFile(join(output, 'sidebar-host.mjs'), 'utf8'), 'previous verified host');
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
