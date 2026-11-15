import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Commander } from '../src/runtime.mjs';
import { CodexProvider } from '../src/providers/codex.mjs';

const fixture = { command: process.execPath, commandArgs: [fileURLToPath(new URL('./codex-fixture.mjs', import.meta.url))] };

test('Codex new standalone sessions default to Full while each turn and reconnect follow authoritative lower settings', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'commander-codex-permission-')), log = join(directory, 'protocol.jsonl');
  const commander = await new Commander({ dataDir: directory, providers: { codex: { ...fixture, env: { COMMANDER_TEST_PROTOCOL_LOG: log } } } }).open();
  t.after(async () => { await commander.close(); await rm(directory, { recursive: true, force: true }); });
  const { id } = await commander.create({ provider: 'codex', cwd: directory });
  await commander.submit(id, 'full'); await commander.wait(id);
  let permission = { sandbox: 'workspace-write', approval: 'ask', additionalWritableRoots: [join(directory, 'extra')] };
  commander.resolvePermission = () => permission;
  await commander.submit(id, 'limited'); await commander.wait(id);
  permission = { sandbox: 'read-only', approval: 'never' };
  await commander.disconnect(id); await commander.connect(id);
  await commander.submit(id, 'read'); await commander.wait(id);
  const protocol = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const start = protocol.find(message => message.method === 'thread/start').params;
  assert.equal(start.approvalPolicy, 'never'); assert.equal(start.sandbox, 'danger-full-access');
  const turns = protocol.filter(message => message.method === 'turn/start').map(message => message.params);
  assert.deepEqual(turns[0].sandboxPolicy, { type: 'dangerFullAccess' }); assert.equal(turns[0].approvalPolicy, 'never');
  assert.deepEqual(turns[1].sandboxPolicy, { type: 'workspaceWrite', writableRoots: [directory, join(directory, 'extra')] }); assert.equal(turns[1].approvalPolicy, 'on-request');
  assert.deepEqual(turns[2].sandboxPolicy, { type: 'readOnly' }); assert.equal(turns[2].approvalPolicy, 'never');
  const resume = protocol.find(message => message.method === 'thread/resume').params;
  assert.equal(resume.sandbox, 'read-only'); assert.equal(resume.approvalPolicy, 'never');
  assert.deepEqual(commander.snapshot(id).permission, permission);
});

test('Codex imported native threads with unknown prior permissions are resumed without raising or replacing them', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'commander-codex-import-')), log = join(directory, 'protocol.jsonl');
  const commander = await new Commander({ dataDir: directory, providers: { codex: { ...fixture, env: { COMMANDER_TEST_PROTOCOL_LOG: log } } } }).open();
  t.after(async () => { await commander.close(); await rm(directory, { recursive: true, force: true }); });
  const { id } = await commander.create({ provider: 'codex', cwd: directory, nativeId: 'thread-fixture' });
  await commander.submit(id, 'resume'); await commander.wait(id);
  const protocol = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const resume = protocol.find(message => message.method === 'thread/resume').params;
  assert.equal(Object.hasOwn(resume, 'approvalPolicy'), false); assert.equal(Object.hasOwn(resume, 'sandbox'), false);
  const turn = protocol.find(message => message.method === 'turn/start').params;
  assert.equal(Object.hasOwn(turn, 'approvalPolicy'), false); assert.equal(Object.hasOwn(turn, 'sandboxPolicy'), false);
  assert.equal(commander.snapshot(id).permission, undefined);
});

test('Codex duplex protocol: approvals, multiple turns, steer, interrupt and resume', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'commander-codex-'));
  const commander = await new Commander({ dataDir: directory, providers: { codex: fixture } }).open();
  commander.resolvePermission = () => ({ sandbox: 'workspace-write', approval: 'ask' });
  t.after(async () => { await commander.close(); await rm(directory, { recursive: true, force: true }); });
  const { id } = await commander.create({ provider: 'codex' });
  const approvalReceived = new Promise(resolve => commander.on('event', event => { if (event.type === 'approval.requested') resolve(event.data); }));
  await commander.submit(id, 'approval');
  const approval = await approvalReceived;
  commander.approve(id, approval.id, { allow: false });
  await commander.wait(id);
  assert.equal(commander.snapshot(id).status, 'idle');
  assert.ok(commander.events(id).events.some(e => e.type === 'text.delta' && e.data.text === 'decline'));
  await commander.submit(id, 'second'); await commander.wait(id);
  await commander.submit(id, 'usage'); await commander.wait(id);
  const usage = commander.events(id).events.filter(event => event.type === 'usage');
  assert.equal(usage.length, 2); assert.deepEqual(usage.map(event => event.data.usage.totalTokens), [110, 220]);
  assert.deepEqual(usage.map(event => event.data.usage.contextTokens), [100, 200]);
  assert.notEqual(usage[0].data.id, usage[1].data.id);
  await commander.submit(id, 'hang'); await commander.steer(id, 'steer'); await commander.interrupt(id); await commander.wait(id);
  await commander.disconnect(id); await commander.connect(id);
  assert.equal(commander.snapshot(id).nativeId, 'thread-fixture');
  assert.equal((await commander.history(id)).thread.id, 'thread-fixture');
  assert.equal((await commander.discover(id)).data.length, 1);
});

test('Codex model changes apply to later turns on the same native thread', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'commander-codex-model-'));
  const commander = await new Commander({ dataDir: directory, providers: { codex: fixture } }).open();
  t.after(async () => { await commander.close(); await rm(directory, { recursive: true, force: true }); });
  const { id } = await commander.create({ provider: 'codex', model: 'model-one' });
  await commander.submit(id, 'first'); await commander.wait(id);
  await commander.drivers.get(id).setModel('model-two');
  await commander.submit(id, 'second'); await commander.wait(id);
  assert.equal(commander.snapshot(id).nativeId, 'thread-fixture');
  assert.deepEqual(commander.events(id).events.filter(event => event.type === 'turn.started').map(event => event.data.model), ['model-one', 'model-two']);
});

test('subscription connections check native account before creating any thread', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'commander-codex-subscription-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const host = { event() {}, failure() {}, approval: async () => ({ allow: false }) };
  const provider = new CodexProvider({ ...fixture, managedProfile: { subscription: true }, env: { COMMANDER_TEST_ACCOUNT_TYPE: 'apiKey' } });
  await assert.rejects(provider.connect({ cwd: directory }, host), /ChatGPT 登录/);
  provider.config.env.COMMANDER_TEST_ACCOUNT_TYPE = 'chatgpt';
  const driver = await provider.connect({ cwd: directory }, host);
  assert.equal(driver.nativeId, 'thread-fixture');
  await driver.close();
});
