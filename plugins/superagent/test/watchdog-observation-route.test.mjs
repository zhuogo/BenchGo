import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createWatchdogObservationClient, createWatchdogSignedRequest, installWatchdogObservationRoute,
  validateWatchdogSignal, WATCHDOG_OBSERVATION_PATH, WATCHDOG_SIGNAL_PATH } from '../src/watchdog-observation-route.mjs';

const targetId = 'fixture-target', token = 'fixture_only_' + 'a'.repeat(48);
const observation = (patch = {}) => ({ id: 'signal-1', incidentKey: 'host:unreachable', phase: 'opened', kind: 'host',
  targetId, observedAt: '2026-11-09T01:00:00.000Z', checkId: 'check-1', evidenceCursor: null,
  reasonCode: 'TARGET_UNREACHABLE', summary: '目标宿主接口暂不可达', ...patch });
const maintenance = { enabled: true, schedulerActive: true, state: 'idle', running: false, active: null,
  pending: 0, quietUntil: null, deadlineAt: null, lastCheckAt: '2026-11-09T01:00:00.000Z',
  nextCheckAt: '2026-11-09T01:00:30.000Z' };

async function officialServerFixture() {
  const requireBenchgo = createRequire(new URL('../../benchgo/package.json', import.meta.url));
  const requireOfficial = createRequire(new URL('../../../deepseek-harness/packages/host/webserver/package.json', import.meta.url));
  // Worktrees share the installed pnpm root; dependency links belong to its original checkout.
  const installedRoot = dirname(realpathSync(new URL('../../../deepseek-harness/node_modules/', import.meta.url)));
  const requireInstalled = createRequire(join(installedRoot, 'packages/host/webserver/package.json'));
  const resolveDependency = name => {
    try { return requireOfficial.resolve(name); }
    catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; return requireInstalled.resolve(name); }
  };
  const { transformSync } = requireBenchgo('esbuild');
  const source = new URL('../../../deepseek-harness/packages/host/webserver/src/', import.meta.url).href;
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL?.startsWith(source) && !/^(?:[./]|[a-z]+:)/i.test(specifier)) {
        return { url: pathToFileURL(resolveDependency(specifier)).href, shortCircuit: true };
      }
      return next(specifier, context);
    },
    load(url, context, next) {
      if (!url.startsWith(source) || !url.endsWith('.ts')) return next(url, context);
      return { format: 'module', source: transformSync(readFileSync(fileURLToPath(url), 'utf8'), {
        loader: 'ts', format: 'esm', target: 'node24', sourcefile: fileURLToPath(url),
      }).code, shortCircuit: true };
    },
  });
  const { WebServer } = await import('../../../deepseek-harness/packages/host/webserver/src/index.ts');
  const { Context } = await import(pathToFileURL(resolveDependency('@deepseek-ai/cordis')).href);
  const ctx = new Context();
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }).await();
  let mode = 'normal', route, calls = 0, clockOffset = 0;
  const signals = new Map();
  const mount = () => {
    route?.dispose();
    route = installWatchdogObservationRoute({ ctx, config: { targetId, token, maxBodyBytes: 2048, timeoutMs: 250 }, now: () => Date.now() + clockOffset,
      async readFacts({ signal, principal }) {
        assert.deepEqual(principal, { kind: 'watchdog', targetId });
        if (mode === 'facts-error') throw Object.assign(new Error('secret=' + token), { code: 'WATCHDOG_' + token });
        if (mode === 'facts-hung') return new Promise(() => {});
        if (mode === 'facts-large') return { text: 'x'.repeat(600_000) };
        signal.throwIfAborted();
        return { cursor: 7, tasks: [], host: { status: 'available', schedulerHeartbeatAt: null }, maintenance };
      },
      async acceptSignal(value, { signal, principal }) {
        signal.throwIfAborted();
        assert.deepEqual(principal, { kind: 'watchdog', targetId });
        calls++;
        if (mode === 'invalid-receipt') return { status: 'accepted' };
        if (mode === 'refused') return { accepted: false, id: value.id };
        const previous = signals.get(value.id);
        if (previous && JSON.stringify(previous) !== JSON.stringify(value)) throw new Error('immutable signal conflict');
        signals.set(value.id, value);
        return { accepted: true, id: value.id, duplicate: !!previous, secret: token };
      },
    });
  };
  mount();
  process.send({ ready: true, origin: ctx.get('webServer').getOrigin() });
  process.on('message', async message => {
    try {
      if (message.operation === 'mode') mode = message.value;
      if (message.operation === 'clock') clockOffset = message.value;
      if (message.operation === 'reload') mount();
      if (message.operation === 'stop') { route.dispose(); await ctx.fiber.dispose(); hooks.deregister(); process.exit(0); }
      process.send({ requestId: message.requestId, calls, signals: [...signals.keys()], instanceId: route.instanceId });
    } catch (error) { process.send({ requestId: message.requestId, error: String(error) }); }
  });
  process.on('disconnect', async () => { route.dispose(); await ctx.fiber.dispose(); process.exit(0); });
}

async function childFixture(t) {
  const child = fork(fileURLToPath(import.meta.url), ['--watchdog-fixture'], {
    execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  });
  t.after(async () => {
    if (child.exitCode !== null) return;
    const stopped = new Promise(resolve => child.once('exit', resolve));
    if (child.connected) child.send({ operation: 'stop' });
    const fallback = setTimeout(() => child.kill(), 3000);
    await stopped;
    clearTimeout(fallback);
  });
  let output = '';
  child.stderr.on('data', data => { output += data; });
  child.stdout.on('data', data => { output += data; });
  const ready = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Official WebServer fixture timed out\n' + output)), 15_000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Official WebServer fixture exited ${code}\n${output}`)); });
    child.on('message', message => { if (message.ready) { clearTimeout(timeout); resolve(message); } });
  });
  let sequence = 0;
  const command = (operation, value) => new Promise((resolve, reject) => {
    const requestId = ++sequence;
    const listen = message => {
      if (message.requestId !== requestId) return;
      child.off('message', listen);
      message.error ? reject(new Error(message.error)) : resolve(message);
    };
    child.on('message', listen); child.send({ operation, value, requestId });
  });
  const call = (signed, patch = {}) => fetch(ready.origin + signed.path, {
    method: signed.method, headers: signed.headers, ...(signed.body === undefined ? {} : { body: signed.body }), ...patch,
  });
  return { origin: ready.origin, command, call,
    client: createWatchdogObservationClient({ origin: ready.origin, targetId, token, timeoutMs: 2000 }) };
}

if (process.argv.includes('--watchdog-fixture')) {
  await officialServerFixture();
} else {
  test('independent process uses real official WebServer routes without assistant or owner credentials', async t => {
    const fixture = await childFixture(t);
    const read = await fixture.client.readFacts();
    assert.equal(read.protocolVersion, 1); assert.equal(read.targetId, targetId);
    assert.equal(read.facts.cursor, 7); assert.equal(read.facts.host.schedulerHeartbeatAt, null);
    assert.deepEqual(read.facts.maintenance, maintenance, 'the signed route preserves the optional redacted maintenance facts');
    const first = await fixture.client.sendSignal(observation());
    assert.deepEqual(first, { accepted: true, id: 'signal-1', duplicate: false });
    assert.deepEqual(await fixture.client.sendSignal(observation()), { accepted: true, id: 'signal-1', duplicate: true });
    assert.deepEqual((await fixture.command('status')).signals, ['signal-1']);
    assert.equal(JSON.stringify(first).includes(token), false);

    await fixture.command('mode', 'refused');
    assert.deepEqual(await fixture.client.sendSignal(observation({ id: 'refused' })), { accepted: false, id: 'refused' });
    await fixture.command('mode', 'invalid-receipt');
    await assert.rejects(fixture.client.sendSignal(observation({ id: 'invalid' })), { code: 'WATCHDOG_RECEIPT_INVALID' });
  });

  test('authentication binds target, method, body, time, nonce and current host instance', async t => {
    const fixture = await childFixture(t);
    const facts = await fixture.client.readFacts();
    const read = createWatchdogSignedRequest({ method: 'GET', targetId, token });
    assert.equal((await fixture.call(read)).status, 200);
    assert.equal((await fixture.call(read)).status, 409, 'a signed request is consumed once');
    const wrong = createWatchdogSignedRequest({ method: 'GET', targetId: 'other-target', token });
    assert.equal((await fixture.call(wrong)).status, 403);
    assert.equal((await fixture.call(createWatchdogSignedRequest({ method: 'GET', targetId, token: 'wrong'.repeat(12) }))).status, 401);
    assert.equal((await fixture.call(createWatchdogSignedRequest({ method: 'GET', targetId, token, now: Date.now() - 120_000 }))).status, 401);
    const signal = createWatchdogSignedRequest({ method: 'POST', targetId, token, instanceId: facts.instanceId, body: JSON.stringify(observation()) });
    assert.equal((await fixture.call(signal, { body: JSON.stringify(observation({ summary: 'tampered' })) })).status, 401);
    assert.equal((await fixture.command('status')).calls, 0, 'tampering never reaches signal acceptance');
    await fixture.command('reload');
    assert.equal((await fixture.call(signal)).status, 409, 'old signatures cannot survive the route generation');
    await assert.rejects(fixture.client.sendSignal(observation()), { code: 'WATCHDOG_INSTANCE_CHANGED' });
    await fixture.client.readFacts();
    assert.equal((await fixture.client.sendSignal(observation())).accepted, true);
  });

  test('no broad API, browser principal, extra fields or oversized payload enters the capability', async t => {
    const fixture = await childFixture(t), facts = await fixture.client.readFacts();
    const cookie = await fetch(fixture.origin + WATCHDOG_OBSERVATION_PATH, { headers: { cookie: 'owner=trusted' } });
    assert.notEqual(cookie.status, 200);
    const request = createWatchdogSignedRequest({ method: 'GET', targetId, token });
    assert.equal((await fixture.call(request, { headers: { ...request.headers, origin: fixture.origin } })).status, 403);
    assert.equal((await fetch(fixture.origin + WATCHDOG_OBSERVATION_PATH + '?path=/private')).status, 400);
    assert.equal((await fetch(fixture.origin + '/benchgo/watchdog/config', { method: 'POST' })).status, 404);
    assert.equal((await fetch(fixture.origin + WATCHDOG_SIGNAL_PATH, { method: 'DELETE' })).status, 405);
    for (const value of [observation({ metadata: { command: 'restart' } }), observation({ targetId: 'foreign' }),
      observation({ kind: 'execution' }), observation({ reasonCode: 'RESTART_HOST' }), observation({ summary: 'x'.repeat(1001) })]) {
      const signed = createWatchdogSignedRequest({ method: 'POST', targetId, token, instanceId: facts.instanceId, body: JSON.stringify(value) });
      assert.equal((await fixture.call(signed)).status, 400);
    }
    const oversized = createWatchdogSignedRequest({ method: 'POST', targetId, token, instanceId: facts.instanceId, body: ' '.repeat(4096) });
    assert.equal((await fixture.call(oversized)).status, 413);
    assert.equal((await fixture.command('status')).calls, 0);
  });

  test('a delayed signed body cannot reuse a nonce removed after the authentication window', async t => {
    const fixture = await childFixture(t), facts = await fixture.client.readFacts();
    const signed = createWatchdogSignedRequest({ method: 'POST', targetId, token,
      instanceId: facts.instanceId, body: JSON.stringify(observation()) });
    assert.equal((await fixture.call(signed)).status, 200);
    let finish;
    const delayed = new Promise((resolve, reject) => {
      const request = httpRequest(fixture.origin + signed.path, { method: signed.method,
        headers: { ...signed.headers, 'content-length': Buffer.byteLength(signed.body) } }, response => {
        response.resume(); response.on('end', () => resolve(response.statusCode));
      });
      request.on('error', reject); request.flushHeaders(); request.write(signed.body.slice(0, 2));
      finish = () => request.end(signed.body.slice(2));
    });
    await new Promise(resolve => setTimeout(resolve, 30));
    await fixture.command('clock', 120_000);
    const newer = createWatchdogSignedRequest({ method: 'GET', targetId, token, now: Date.now() + 120_000 });
    assert.equal((await fixture.call(newer)).status, 200, 'the newer request expires old cached nonces');
    finish();
    assert.equal(await delayed, 401);
    assert.equal((await fixture.command('status')).calls, 1);
  });

  test('callback failure, uncooperative read and unsigned or tampered responses remain unknown', async t => {
    const fixture = await childFixture(t);
    await fixture.command('mode', 'facts-error');
    await assert.rejects(fixture.client.readFacts(), { code: 'WATCHDOG_OBSERVATION_UNAVAILABLE' });
    const response = await fixture.call(createWatchdogSignedRequest({ method: 'GET', targetId, token }));
    assert.equal((await response.text()).includes(token), false);
    await fixture.command('mode', 'facts-large');
    await assert.rejects(fixture.client.readFacts(), { code: 'WATCHDOG_RESPONSE_TOO_LARGE' });
    await fixture.command('mode', 'facts-hung');
    const started = Date.now();
    await assert.rejects(fixture.client.readFacts(), { code: 'WATCHDOG_REQUEST_TIMEOUT' });
    assert.ok(Date.now() - started < 1500, 'server bounds callbacks even when they ignore AbortSignal');
    await fixture.command('mode', 'normal');
    const tampered = createWatchdogObservationClient({ origin: fixture.origin, targetId, token,
      fetcher: async (...args) => { const response = await fetch(...args); return new Response('{"targetId":"forged"}', { headers: response.headers }); } });
    await assert.rejects(tampered.readFacts(), { code: 'WATCHDOG_RESPONSE_UNVERIFIED' });
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(fixture.client.readFacts({ signal: cancelled.signal }), { name: 'AbortError' });
  });

  test('configuration is local-only and signal schema preserves exact execution identity', () => {
    for (const origin of ['http://example.com', 'http://127.0.0.1/config', 'http://user:pass@127.0.0.1', 'file:///tmp/file']) {
      assert.throws(() => createWatchdogObservationClient({ origin, targetId, token }), { code: 'WATCHDOG_ORIGIN_INVALID' });
    }
    assert.throws(() => createWatchdogObservationClient({ origin: 'http://127.0.0.1', targetId, token: 'weak' }), { code: 'WATCHDOG_TOKEN_INVALID' });
    const execution = { taskId: 'task:opaque', assignmentId: 'assignment', runId: 'run', sessionId: 'session', fence: 4, instructionRevision: 2 };
    const value = observation({ kind: 'execution', execution, reasonCode: 'EXECUTION_INACTIVE' });
    assert.deepEqual(validateWatchdogSignal(value, targetId), value);
    assert.throws(() => validateWatchdogSignal({ ...value, execution: { ...execution, owner: 'forged' } }, targetId), { code: 'WATCHDOG_SIGNAL_INVALID' });
    for (const reasonCode of ['MAINTENANCE_EXECUTION_TIMEOUT', 'MAINTENANCE_SCHEDULER_STALLED']) {
      const report = observation({ reasonCode });
      assert.deepEqual(validateWatchdogSignal(report, targetId), report);
      assert.throws(() => validateWatchdogSignal({ ...report, action: 'restart' }, targetId), { code: 'WATCHDOG_SIGNAL_INVALID' });
      assert.throws(() => validateWatchdogSignal({ ...report, kind: 'execution', execution }, targetId), { code: 'WATCHDOG_SIGNAL_INVALID' });
      assert.throws(() => validateWatchdogSignal({ ...report, execution }, targetId), { code: 'WATCHDOG_SIGNAL_INVALID' });
    }
    const routes = new Map(), ctx = { webServer: { register: route => { routes.set(route.path, route); return () => routes.delete(route.path); } }, effect: () => {} };
    const mounted = installWatchdogObservationRoute({ ctx, config: { targetId, token }, readFacts: async () => ({}), acceptSignal: async () => ({}) });
    assert.deepEqual([...routes.keys()], [WATCHDOG_OBSERVATION_PATH, WATCHDOG_SIGNAL_PATH]);
    mounted.dispose(); mounted.dispose(); assert.equal(routes.size, 0);
  });
}
