import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, open, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mountWorkbenchMedia, WORKBENCH_MEDIA_PATH } from '../src/media.mjs';

async function host(t) {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-workbench-media-'));
  const root = join(directory, 'project'), worktree = join(directory, 'entered-worktree'), outside = join(directory, 'outside');
  await Promise.all([root, worktree, outside].map(path => mkdir(path)));
  await writeFile(join(root, 'sample.mp4'), '0123456789');
  await writeFile(join(worktree, 'sample.mp4'), 'worktree');
  await writeFile(join(outside, 'secret.txt'), 'outside');
  const state = { current: root, disposedObservations: 0, authentication: undefined };
  const session = { header: { id: 'live', cwd: root } }, routes = new Map(), effects = [];
  const services = {
    workingDirectory: { get: value => { assert.equal(value, session); return state.current; } },
    sessionQuery: { async observeSession(id, options) {
      assert.equal(options.projectionMode, 'none');
      if (id !== 'cold') throw new Error('not found');
      return { header: { cwd: root }, events: [{ type: 'working-directory/change', data: { cwd: worktree } }], [Symbol.dispose]() { state.disposedObservations++; } };
    } },
  };
  const ctx = {
    sessions: { get: id => id === 'live' ? session : undefined },
    connection: { requestRejection: () => state.authentication },
    webServer: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } },
    get: name => services[name],
    effect(callback) { effects.push(callback()); },
  };
  mountWorkbenchMedia(ctx);
  const server = createServer((req, res) => {
    const route = routes.get(new URL(req.url, 'http://localhost').pathname);
    if (!route) { res.writeHead(404); res.end(); return; }
    Promise.resolve(route.handler(req, res)).catch(error => res.destroy(error));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let disposed = false;
  const dispose = async () => {
    if (disposed) return; disposed = true;
    for (const effect of effects.reverse()) await effect?.();
  };
  t.after(async () => {
    await dispose();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  });
  const request = (path = 'sample.mp4', options = {}, { sessionId = 'live', meta = false, extra = {} } = {}) => {
    const url = new URL(WORKBENCH_MEDIA_PATH + (meta ? '/meta' : ''), base);
    url.search = new URLSearchParams({ sessionId, path, ...extra }).toString();
    return fetch(url, options);
  };
  return { root, worktree, outside, state, services, request, dispose };
}

test('media uses the official committed directory and cold Session changes, with exact metadata envelope', async t => {
  const h = await host(t);
  let response = await h.request();
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '0123456789');
  assert.equal(response.headers.get('content-type'), 'video/mp4');
  assert.equal(response.headers.get('accept-ranges'), 'bytes');
  response = await h.request('sample.mp4', {}, { meta: true });
  assert.deepEqual(await response.json(), { ok: true, value: { path: await realpath(join(h.root, 'sample.mp4')), name: 'sample.mp4', size: 10, mime: 'video/mp4' } });
  h.state.current = h.worktree;
  response = await h.request();
  assert.equal(await response.text(), 'worktree');
  response = await h.request('sample.mp4', {}, { sessionId: 'cold', meta: true });
  assert.equal((await response.json()).value.path, await realpath(join(h.worktree, 'sample.mp4')));
  assert.equal(h.state.disposedObservations, 1);
});

test('GET and HEAD support one bounded/open/suffix Range and If-Range validators', async t => {
  const h = await host(t);
  const full = await h.request();
  const etag = full.headers.get('etag'), modified = full.headers.get('last-modified');
  await full.arrayBuffer();
  for (const [range, body, expectedRange] of [['bytes=2-5', '2345', 'bytes 2-5/10'], ['bytes=7-', '789', 'bytes 7-9/10'], ['bytes=-3', '789', 'bytes 7-9/10'], ['bytes=8-100', '89', 'bytes 8-9/10'], ['bytes=-100', '0123456789', 'bytes 0-9/10']]) {
    const response = await h.request(undefined, { headers: { Range: range } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), expectedRange);
    assert.equal(response.headers.get('content-length'), String(body.length));
    assert.equal(await response.text(), body);
  }
  for (const validator of [etag, modified]) {
    const response = await h.request(undefined, { headers: { Range: 'bytes=1-2', 'If-Range': validator } });
    assert.equal(response.status, 206); assert.equal(await response.text(), '12');
  }
  for (const validator of ['"stale"', `W/${etag}`, 'Wed, 01 Jan 1997 00:00:00 GMT', 'invalid']) {
    const response = await h.request(undefined, { headers: { Range: 'bytes=1-2', 'If-Range': validator } });
    assert.equal(response.status, 200); assert.equal(await response.text(), '0123456789');
  }
  const head = await h.request(undefined, { method: 'HEAD', headers: { Range: 'bytes=1-2' } });
  assert.equal(head.status, 206); assert.equal(head.headers.get('content-length'), '2'); assert.equal(await head.text(), '');
  const metaHead = await h.request(undefined, { method: 'HEAD' }, { meta: true });
  assert.equal(metaHead.status, 200); assert.ok(Number(metaHead.headers.get('content-length')) > 0); assert.equal(await metaHead.text(), '');
});

test('invalid/multiple/empty file ranges are 416 while unsupported units are ignored', async t => {
  const h = await host(t);
  for (const range of ['bytes=10-', 'bytes=4-2', 'bytes=-0', 'bytes=1-2,4-5', 'bytes=-', 'bytes=9007199254740992-']) {
    const response = await h.request(undefined, { headers: { Range: range } });
    assert.equal(response.status, 416, range); assert.equal(response.headers.get('content-range'), 'bytes */10');
    assert.equal((await response.json()).ok, false);
  }
  let response = await h.request(undefined, { headers: { Range: 'items=1-2' } });
  assert.equal(response.status, 200); assert.equal(await response.text(), '0123456789');
  await writeFile(join(h.root, 'empty.mp3'), '');
  response = await h.request('empty.mp3'); assert.equal(response.status, 200); assert.equal(await response.text(), '');
  response = await h.request('empty.mp3', { headers: { Range: 'bytes=0-' } });
  assert.equal(response.status, 416); assert.equal(response.headers.get('content-range'), 'bytes */0');
  await response.arrayBuffer();
});

test('media refuses unknown Sessions, caller cwd, traversal, directories and links outside the actual root', async t => {
  const h = await host(t);
  for (const path of [join(h.outside, 'secret.txt'), '../outside/secret.txt']) {
    const response = await h.request(path); assert.equal(response.status, 403); assert.equal((await response.json()).ok, false);
  }
  let response = await h.request('secret.txt', {}, { sessionId: 'unknown', extra: { cwd: h.outside } });
  assert.equal(response.status, 404); await response.arrayBuffer();
  response = await h.request('.', {}, { extra: { cwd: h.outside } });
  assert.equal(response.status, 404); await response.arrayBuffer();
  h.state.current = 'relative-root';
  response = await h.request(); assert.equal(response.status, 409); await response.arrayBuffer();
  h.state.current = h.root;
  try { await symlink(h.outside, join(h.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.diagnostic('host does not permit directory links'); return; } throw error; }
  response = await h.request('linked/secret.txt'); assert.equal(response.status, 403); await response.arrayBuffer();
});

test('owner authentication, method and download boundaries apply to metadata and bytes', async t => {
  const h = await host(t);
  h.state.authentication = 401;
  let response = await h.request(); assert.equal(response.status, 401); await response.arrayBuffer();
  h.state.authentication = undefined;
  response = await h.request(undefined, { headers: { Origin: 'https://external.invalid' } }, { meta: true });
  assert.equal(response.status, 403); await response.arrayBuffer();
  response = await h.request(undefined, { method: 'POST' }); assert.equal(response.status, 405); assert.equal(response.headers.get('allow'), 'GET, HEAD'); await response.arrayBuffer();
  await writeFile(join(h.root, 'page.html'), '<script>top.location="https://external.invalid"</script>');
  response = await h.request('page.html');
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  assert.match(response.headers.get('content-disposition'), /^attachment;/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('content-security-policy'), /sandbox/); await response.arrayBuffer();
  response = await h.request(undefined, {}, { extra: { download: '1' } });
  assert.match(response.headers.get('content-disposition'), /^attachment;/); await response.arrayBuffer();
});

test('large files stream a bounded range and active responses close on client abort or scope disposal', async t => {
  const h = await host(t), file = await open(join(h.root, 'large.mp4'), 'w');
  try { await file.truncate(128 * 1024 * 1024); } finally { await file.close(); }
  let response = await h.request('large.mp4', { headers: { Range: 'bytes=1000000-1000009' } });
  assert.equal(response.status, 206); assert.equal((await response.arrayBuffer()).byteLength, 10);
  const controller = new AbortController();
  response = await h.request('large.mp4', { signal: controller.signal });
  const reader = response.body.getReader(); assert.ok((await reader.read()).value.byteLength > 0);
  controller.abort(); await reader.cancel().catch(() => {});
  response = await h.request('large.mp4');
  const activeReader = response.body.getReader(); await activeReader.read();
  await h.dispose(); await activeReader.cancel().catch(() => {});
});
