import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localOwnerRejection, ownerWebServer, contextFacade } from '../src/boundary.mjs';
import { openPreferences, SIDEBAR_NS } from '../src/preferences.mjs';
import { localWorkbenchPage } from '../client/local-surface.mjs';

const request = overrides => ({ headers: { host: 'localhost:3000', origin: 'http://localhost:3000' }, socket: { remoteAddress: '::ffff:127.0.0.1' }, ...overrides });
const connection = { requestRejection: () => undefined };
test('Desktop local surface requires the official owned-host connection', () => {
  assert.equal(localWorkbenchPage(new URL('dsh-app://app/'), { isLoopback: true }), true);
  assert.equal(localWorkbenchPage(new URL('dsh-app://app/'), { isLoopback: false }), false);
  assert.equal(localWorkbenchPage(new URL('dsh-app://shell/'), { isLoopback: true }), false);
  assert.equal(localWorkbenchPage(new URL('https://remote.example/'), { isLoopback: true }), false);
  // Official forwardWebRequest strips renderer Origin and inserts the Host cookie;
  // WS forwarding rewrites Origin to the actual loopback Host origin.
  assert.equal(localOwnerRejection(request({ headers: { host: '127.0.0.1:3000', cookie: 'host-issued' } }), connection), undefined);
  assert.equal(localOwnerRejection(request({ headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' } }), connection), undefined);
  assert.equal(localOwnerRejection(request({ headers: { host: '127.0.0.1:3000', origin: 'dsh-app://app' } }), connection), 403);
});
test('official authentication and local-owner boundary both apply', () => {
  assert.equal(localOwnerRejection(request(), connection), undefined);
  assert.equal(localOwnerRejection(request(), { requestRejection: () => 401 }), 401);
  assert.equal(localOwnerRejection(request(), {}), 503);
  for (const req of [request({ socket: { remoteAddress: '192.168.1.2' } }), request({ headers: { host: 'remote.example' } }), request({ headers: { host: 'localhost:3000', origin: 'https://evil.example' } }), request({ headers: { host: 'localhost:3000', 'x-forwarded-for': '127.0.0.1' } }), request({ headers: { host: 'localhost:3000', 'x-benchgo-device': 'linked-device' } })]) assert.equal(localOwnerRejection(req, connection), 403);
});
test('HTTP and official websocket upgrade signatures preserve request identity', async () => {
  let http, upgrade, received;
  const server = ownerWebServer({ register: route => { http = route; }, registerUpgrade: route => { upgrade = route; } }, connection);
  server.register({ kind: 'exact', path: '/test', handler: (...args) => { received = args; } });
  server.registerUpgrade({ path: '/ws', handler: (...args) => { received = args; } });
  const req = request(), res = {}, socket = {}, head = Buffer.from('head');
  await http.handler(req, res); assert.deepEqual(received, [req, res]);
  upgrade.handler(req, socket, head); assert.deepEqual(received, [req, socket, head]);
  let rejected; upgrade.handler(request({ socket: { remoteAddress: '10.0.0.1' } }), { end: value => { rejected = value; } }, head);
  assert.match(rejected, /^HTTP\/1.1 403/);
});
test('Cordis injection keeps adapted faces and real method ownership', () => {
  const original = { value: 'real', get() { return this.value; }, inject(services, callback) { callback(this); }, owned() { return this === original; } };
  const face = contextFacade(original, { tools: 'disabled' });
  assert.equal(face.owned(), true); assert.equal(face.get('tools'), 'disabled');
  face.inject(['tools'], child => assert.equal(child.tools, 'disabled'));
});
test('project composition rejects alternate sidechat and task APIs', async () => {
  let route, calls = 0;
  ownerWebServer({ register: value => { route = value; } }, connection, { projectOnly: true }).register({ handler: () => { calls++; } });
  for (const url of ['/sidebar/api/sidechat.start', '/sidebar/api/subagents.live', '/sidebar/api/teams.taskCreate', '/sidebar/api/workflows.list', '/sidebar/sidechat-image']) {
    let status;
    await route.handler({ ...request(), url }, { writeHead: value => { status = value; }, end: () => {} });
    assert.equal(status, 403);
  }
  await route.handler({ ...request(), url: '/sidebar/api/fs.tree' }, {});
  assert.equal(calls, 1);
});
test('built-in preferences ignore retired overrides, reject edits and return isolated snapshots', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-workbench-'));
  try {
    const retired = '{"value":{"agentOpenTools":true,"htmlViewerNoSandbox":true,"tabsEnabled":{"sidechat":true}}}';
    await writeFile(join(directory, 'workbench.json'), retired);
    const settings = await openPreferences(directory);
    await assert.rejects(settings.update(SIDEBAR_NS, { editorExplorer: false }, 0), /固定配置/);
    await assert.rejects(settings.update(SIDEBAR_NS, { agentOpenTools: true }), /固定配置/);
    settings.snapshot().value.tabsEnabled.sidechat = true;
    const restored = (await openPreferences(directory)).snapshot();
    assert.equal(restored.value.editorExplorer, true);
    assert.equal(restored.value.editorGitGutter, true);
    assert.equal(restored.value.agentOpenTools, false);
    assert.equal(restored.value.htmlViewerNoSandbox, false);
    assert.equal(restored.value.htmlViewerDefaultUnsafe, false);
    assert.equal(restored.value.autoOpenSubagent, false);
    assert.equal(restored.value.autoOpenJobs, false);
    assert.deepEqual(restored.value.tabsEnabled, { sidechat: false, subagent: false });
    assert.deepEqual(restored.value.viewersEnabled, {});
    assert.equal(restored.revision, 0);
    assert.equal(await readFile(join(directory, 'workbench.json'), 'utf8'), retired);
    assert.deepEqual(settings.describe(), [{ ns: SIDEBAR_NS, ...restored, user: {} }]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
