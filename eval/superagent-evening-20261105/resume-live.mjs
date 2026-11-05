import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { preflight } from './preflight.mjs';
import { inspectRetainedState } from './resume-state.mjs';
import { assertNoCredentials } from './retention.mjs';
import { assertPrivateAccess, createPrivateDirectory } from './private-access.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
const index = args.indexOf('--attempt-dir');
assert.ok(index >= 0 && args[index + 1], 'Specify --attempt-dir');
const attempt = resolve(root, args[index + 1]);
const base = resolve(root, 'eval/superagent-evening-20261105');
assert.ok(attempt.startsWith(base + '\\') || attempt.startsWith(base + '/'), 'Attempt must be within the evening evidence directory');
const directory = join(attempt, 'isolated-state');
await assertPrivateAccess(directory);
const original = JSON.parse(await readFile(join(attempt, 'results.json'), 'utf8'));
assert.equal(original.scenarios.length, 1);
const identity = await inspectRetainedState(directory, original.scenarios[0]);
const prepared = await preflight({ credentials: args.includes('--run') });
assert.deepEqual(original.isolatedConfig.models, prepared.assistant.models);
assert.deepEqual(original.isolatedConfig.workerModels, prepared.assistant.workerModels || []);
assert.deepEqual(original.isolatedConfig.auxiliary, prepared.assistant.auxiliary || null);
const patch = JSON.parse(await readFile(join(directory, 'user/.dsh/profiles/web/cordis.patch.yml'), 'utf8'));
assertNoCredentials(patch, prepared.secrets);
assert.deepEqual(patch.find(row => row.id === 'llm-pi-ai')?.config?.providers, prepared.providers, 'Provider configuration changed');
if (!args.includes('--run')) {
  console.log(JSON.stringify({ ready: true, requiresExplicitRun: true, identity }));
  process.exit(0);
}
const output = join(attempt, `resume-${randomUUID()}`);
await createPrivateDirectory(output);
const redact = value => Object.values(prepared.secrets).reduce((text, secret) => text.replaceAll(secret, '[REDACTED]'), String(value))
  .replace(/([?&]token=)[^\s&"']+/g, '$1[REDACTED]');
const report = { identity, startedAt: new Date().toISOString(), status: 'running', timeline: [] };
let child, ended, log = '';
try {
  const isolatedUser = join(directory, 'user');
  child = spawn(process.execPath, ['--import', pathToFileURL(join(root, 'deepseek-harness/node_modules/tsx/dist/esm/index.mjs')).href,
    join(root, 'deepseek-harness/apps/cli/src/bin.ts'), '--profile', 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
    cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      TEMP: directory, TMP: directory, HOME: isolatedUser, USERPROFILE: isolatedUser, DSH_HOME: join(isolatedUser, '.dsh'),
      DSH_AGENTS_HOME: join(isolatedUser, 'agents'), TSX_TSCONFIG_PATH: join(root, 'deepseek-harness/tsconfig.json'),
      DSH_TELEMETRY_DISABLED: '1', NO_COLOR: '1', ...prepared.secrets } });
  ended = new Promise(done => { child.once('exit', (code, signal) => done({ code, signal })); child.once('error', error => { log += error.message; done({ error: error.message }); }); });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log += chunk.toString(); });
  let login;
  for (const deadline = Date.now() + 90000; Date.now() < deadline;) {
    const match = log.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/);
    if (match) { login = new URL(match[1]); break; }
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Loader exited before ready');
    await delay(200);
  }
  assert.ok(login, 'Loader did not become ready');
  const signed = await fetch(login, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
  const cookie = signed.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  assert.ok(cookie, 'Authentication failed');
  const call = async input => {
    const response = await fetch(new URL('/api/commander/assistant', login), { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(25000) });
    const body = await response.json();
    assert.equal(response.status, 200, redact(JSON.stringify(body)));
    return body;
  };
  let tickets = await call({ action: 'tickets' });
  assert.equal(tickets.tickets.length, 1);
  let ticket = tickets.tickets[0];
  assert.equal(ticket.id, identity.ticketId);
  assert.equal(ticket.status, 'paused');
  assert.deepEqual(ticket.assignments.map(row => row.id), [identity.assignmentId]);
  assert.equal(ticket.instructionRevision, identity.instructionRevision);
  assert.deepEqual(await inspectRetainedState(directory, original.scenarios[0]), identity);
  const history = await call({ action: 'history', threadId: identity.threadId });
  assert.equal(history.sessionId, identity.routerSessionId, 'Original conversation session changed');
  const config = (await call({ action: 'state' })).config;
  for (const key of ['models', 'workerModels', 'auxiliary']) assert.deepEqual(config[key] ?? (key === 'workerModels' ? [] : null), original.isolatedConfig[key]);
  report.resumeReceipt = await call({ action: 'ticketResume', ticketId: identity.ticketId });
  for (const deadline = Date.now() + 1800000; Date.now() < deadline;) {
    tickets = await call({ action: 'tickets' });
    assert.equal(tickets.tickets.length, 1);
    ticket = tickets.tickets[0];
    assert.equal(ticket.id, identity.ticketId);
    assert.deepEqual(ticket.assignments.map(row => row.id), [identity.assignmentId]);
    assert.equal(ticket.instructionRevision, identity.instructionRevision);
    report.timeline.push({ at: new Date().toISOString(), status: ticket.status, resultVersion: ticket.resultVersion });
    await writeFile(join(output, 'results.json'), redact(JSON.stringify(report, null, 2)));
    if (ticket.status === 'completed' || ['failed', 'cancelled', 'closed', 'waiting'].includes(ticket.status)) break;
    await delay(2000);
  }
  assert.equal(ticket.status, 'completed', 'Original Ticket did not complete');
  const final = ticket.results.at(-1);
  assert.equal(final?.runId, identity.runId);
  assert.equal(final?.sessionId, identity.sessionId);
  assert.equal(final?.review?.verdict, 'passed');
  assert.ok(ticket.deliveries.some(row => row.state === 'sent' && row.payload?.resultVersion === ticket.resultVersion && row.payload?.publication?.action === 'deliver'));
  report.final = ticket;
  report.status = 'completed';
} catch (error) {
  report.status = 'failed'; report.error = redact(error.stack || error.message); process.exitCode = 1;
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill(); await Promise.race([ended, delay(10000)]);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await ended; }
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(join(output, 'loader.log'), redact(log));
  await writeFile(join(output, 'results.json'), redact(JSON.stringify(report, null, 2)));
  console.log(JSON.stringify({ output, status: report.status, error: report.error }));
}
