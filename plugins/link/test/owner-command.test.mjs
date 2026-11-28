import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ownerScript } from '../src/server/owner-command.mjs';

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'benchgo-owner-'));
  const requests = [];
  const responses = {
    '/api/commander-link': { hostId: 'host-identity', enabled: true, host: '127.0.0.1', port: 45317 },
    '/api/commander/updates': { busy: false, current: { plugin: '1.1.0' }, hostHealth: { instanceId: 'new', assistant: false } },
    '/api/commander': { projects: [], sessions: [] },
    '/api/commander/assistant': { state: {}, config: {} },
  };
  const failures = {};
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') {
      response.writeHead(302, { 'set-cookie': 'owner=test; HttpOnly', location: '/' });
      response.end();
      return;
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({ path: request.url, input: JSON.parse(body) });
    assert.equal(request.headers.cookie, 'owner=test');
    assert.equal(request.headers.origin, 'http://127.0.0.1:' + server.address().port);
    response.writeHead(failures[request.url] ?? 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(responses[request.url]));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const directory = join(home, '.local/share/benchgo/server');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'installation.json'), JSON.stringify({ schemaVersion: 1, webPort: server.address().port, port: 45317 }));
  await writeFile(join(directory, 'owner.json'), JSON.stringify({ url: 'http://127.0.0.1:' + server.address().port + '/?token=private' }));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  });
  const run = input => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-'], {
      env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      try { resolve({ code, value: JSON.parse(stdout) }); }
      catch { reject(new Error(stderr || stdout)); }
    });
    child.stdin.end(ownerScript({ expectedHostId: 'host-identity', ...input }));
  });
  return { responses, failures, requests, run };
}

test('owner health checks the running workbench and required assistant', async t => {
  const f = await fixture(t);
  const healthy = await f.run({ action: 'health', requireAssistant: true });
  assert.equal(healthy.code, 0);
  assert.deepEqual(healthy.value, { ready: true, assistant: true, busy: false, instanceId: 'new', version: '1.1.0' });
  f.responses['/api/commander'] = {};
  f.responses['/api/commander/assistant'] = { error: 'not mounted' };
  f.failures['/api/commander/assistant'] = 404;
  const warming = await f.run({ action: 'health', requireAssistant: true });
  assert.equal(warming.value.ready, false);
  assert.equal(warming.value.assistant, false);
  f.responses['/api/commander-link'].port = 1;
  const invalid = await f.run({ action: 'health' });
  assert.equal(invalid.code, 1);
  assert.match(invalid.value.error, /Link 监听/);
});

test('owner update commands verify host identity and allow only supported operations', async t => {
  const f = await fixture(t);
  const mismatch = await f.run({ action: 'updates', operation: 'install', expectedHostId: 'another-host' });
  assert.match(mismatch.value.error, /身份已变化/);
  const invalid = await f.run({ action: 'updates', operation: 'configure' });
  assert.match(invalid.value.error, /无效/);
  assert(f.requests.every(request => request.path === '/api/commander-link'));
  for (const operation of ['status', 'check', 'install', 'restart', 'restart-host']) {
    const result = await f.run({ action: 'updates', operation });
    assert.equal(result.code, 0);
    assert.deepEqual(f.requests.at(-1), { path: '/api/commander/updates', input: { action: operation } });
  }
});

test('owner update errors retain HTTP status for manager recovery decisions', async t => {
  const f = await fixture(t);
  f.responses['/api/commander/updates'] = { error: 'not authorized' };
  f.failures['/api/commander/updates'] = 403;
  assert.deepEqual(await f.run({ action: 'updates', operation: 'status' }), {
    code: 1, value: { error: 'not authorized', status: 403 },
  });
  f.responses['/api/commander-link'] = undefined;
  f.failures['/api/commander-link'] = 503;
  assert.deepEqual(await f.run({ action: 'updates', operation: 'status' }), {
    code: 1, value: { error: '服务器管理请求失败', status: 503 },
  });
});
