import test from 'node:test';
import assert from 'node:assert/strict';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import { createAssistantOrchestrationStore } from '../src/orchestration-store.mjs';
import { installWorkerVault } from '../src/worker-vault.mjs';
import { createVault } from '../../benchgo/src/vault.mjs';

async function fixture(t, { approve } = {}) {
  const records = new Map(); let policy = { desktopVersion: 'desktop-1', version: 'feishu-1' }, sends = 0, approvals = 0;
  const database = createAssistantOrchestrationStore({ filename: ':memory:' });
  database.createThread({ id: 'vault-thread', source: { type: 'desktop', id: 'main' } });
  const mandate = { source: { channel: 'desktop', sessionId: 'owner', messageId: 'owner-message' }, actorId: 'desktop-owner', admission: 'desktop-approved-delegation', controlledActions: 'require-current-policy-and-harness-approval', policyVersion: policy.desktopVersion };
  const ticket = database.createTicket({ threadId: 'vault-thread', target: 'Call the private API', mandate });
  database.createAssignment(ticket.id, { executor: 'harness' });
  const [assignment] = database.claimAssignments('worker', { validateMandate: () => true });
  const run = database.prepareRun(assignment.id, { owner: assignment.owner, fence: assignment.fence, sessionId: 'worker-session', directory: '/isolated' });
  database.updateRun(run.id, { owner: assignment.owner, fence: assignment.fence, state: 'submitted' });
  const session = Session.create(SessionId('worker-session')), agent = { id: 'worker-session', session };
  const vault = createVault({ credentials: { readRecord: async key => structuredClone(records.get(key)), modifyRecord: async (key, fn) => { const next = await fn(structuredClone(records.get(key))); records.set(key, next); return structuredClone(next); } }, fetcher: async (url, options) => {
    sends++; assert.equal(url, 'https://bound.test/submit'); assert.equal(options.headers.Authorization, 'Bearer VERY_PRIVATE_KEY');
    if (f.failRequest) throw Error('VERY_PRIVATE_KEY');
    f.sentBody = options.body;
    return new Response('VERY_PRIVATE_KEY', { status: 202 });
  } });
  t.after(() => { vault.dispose(); database.close(); });
  const { entry } = await vault.save({ label: 'Private API', target: 'https://bound.test/submit', method: 'POST', placement: 'header', field: 'Authorization', prefix: 'bearer', secret: 'VERY_PRIVATE_KEY' });
  const tools = new Map(), approval = { request: async input => { approvals++; assert.equal(input.agent, agent); return approve ? approve(f, input) : 'allowed-once'; } };
  const ctx = { get: key => key === 'benchgoVault' ? vault : key === 'approval' ? approval : undefined };
  const scope = { get: ctx.get, tools: { register: tool => tools.set(tool.name, tool) } };
  const f = { database, assignment, run, ticket, agent, entry, vault, tools, ctx, scope, policy: () => policy, setPolicy: value => { policy = value; }, sends: () => sends, approvals: () => approvals };
  installWorkerVault(scope, agent, { ctx, database, assignment, run, readPolicy: async () => policy, authorizeAction: async () => ({ allowed: true }) });
  f.exec = (callId = 'call-1') => ({ agent, callId, signal: new AbortController().signal });
  f.input = { handle: entry.handle, revision: entry.revision, body: { task: 'approved' } };
  return f;
}

test('Worker vault binds actual run, officially approves and writes only redacted host records', async t => {
  const f = await fixture(t), tool = f.tools.get('assistant_vault_execute');
  assert.equal(f.tools.size, 2);
  assert.equal((await f.tools.get('assistant_vault_list').execute({}, f.exec('list'))).entries.length, 1);
  const result = await tool.execute(f.input, f.exec());
  assert.deepEqual(result, { handle: f.entry.handle, status: 202, ok: true, redacted: true });
  assert.equal(f.sends(), 1); assert.equal(f.approvals(), 1);
  const records = f.agent.session.snapshotEvents();
  assert.deepEqual(records.map(event => event.data.phase), ['submitted', 'completed']);
  assert.ok(records.every(event => event.ignorable && event.data.ticketId === f.ticket.id && event.data.runId === f.run.id));
  assert.doesNotMatch(JSON.stringify(records), /VERY_PRIVATE_KEY|approved/);
  assert.deepEqual(f.agent.session.deriveMessages(), []);
  await assert.rejects(tool.execute(f.input, f.exec()), { code: 'VAULT_REPLAY_BLOCKED' });
  assert.equal(f.sends(), 1);
});

test('Worker rejects foreign agents, paused tickets and forged identities before approval', async t => {
  const f = await fixture(t), tool = f.tools.get('assistant_vault_execute');
  await assert.rejects(tool.execute(f.input, { ...f.exec(), agent: { ...f.agent } }), { code: 'VAULT_WORKER_MISMATCH' });
  f.database.pauseTicket(f.ticket.id);
  await assert.rejects(tool.execute(f.input, f.exec()), { code: 'VAULT_WORKER_STALE' });
  assert.equal(f.approvals(), 0); assert.equal(f.sends(), 0);
});

test('rule tightening or cancellation during official approval stops the HTTP boundary', async t => {
  for (const change of ['policy', 'cancel']) {
    const f = await fixture(t, { approve: current => { if (change === 'policy') current.setPolicy({ ...current.policy(), desktopVersion: 'revoked' }); else current.database.cancelTicket(current.ticket.id); return true; } });
    await assert.rejects(f.tools.get('assistant_vault_execute').execute(f.input, f.exec()), error => ['VAULT_POLICY_CHANGED', 'VAULT_WORKER_STALE'].includes(error.code));
    assert.equal(f.sends(), 0);
    assert.equal(f.agent.session.snapshotEvents().length, 0);
  }
});

test('approval rejection is audited and authorized=true cannot bypass the official approval service', async t => {
  const f = await fixture(t, { approve: () => false });
  await assert.rejects(f.tools.get('assistant_vault_execute').execute(f.input, { ...f.exec(), authorized: true }), { code: 'VAULT_APPROVAL_DENIED' });
  assert.equal(f.sends(), 0); assert.equal(f.approvals(), 1);
  assert.equal(f.agent.session.snapshotEvents()[0].data.phase, 'denied');
});

test('final policy/fence gate runs after vault IO immediately before network submission', async t => {
  const f = await fixture(t);
  const original = f.vault.execute;
  f.vault.execute = async input => {
    f.setPolicy({ ...f.policy(), desktopVersion: 'revoked-while-vault-waits' });
    return original(input);
  };
  await assert.rejects(f.tools.get('assistant_vault_execute').execute(f.input, f.exec()), { code: 'VAULT_POLICY_CHANGED' });
  assert.equal(f.approvals(), 1); assert.equal(f.sends(), 0);
});

test('uncertain external effect cannot be replayed under a new call id or reordered body', async t => {
  const f = await fixture(t), tool = f.tools.get('assistant_vault_execute'); f.failRequest = true;
  await assert.rejects(tool.execute({ ...f.input, body: { a: 'first', b: 'second' } }, f.exec()), { code: 'VAULT_REQUEST_UNCERTAIN' });
  await assert.rejects(tool.execute({ ...f.input, body: { b: 'second', a: 'first' } }, f.exec('new-call')), { code: 'VAULT_REPLAY_BLOCKED' });
  assert.equal(f.sends(), 1); assert.equal(f.approvals(), 1);
  assert.doesNotMatch(JSON.stringify(f.agent.session.snapshotEvents()), /VERY_PRIVATE_KEY/);
});

test('approval binds immutable request body and credential rotation invalidates prior approval', async t => {
  const f = await fixture(t, { approve: current => { current.input.body.task = 'changed-during-approval'; return true; } });
  await f.tools.get('assistant_vault_execute').execute(f.input, f.exec());
  assert.equal(JSON.parse(f.sentBody).task, 'approved');
  const g = await fixture(t, { approve: async current => {
    await current.vault.save({ ...current.entry, secret: 'ROTATED_KEY' }); return true;
  } });
  await assert.rejects(g.tools.get('assistant_vault_execute').execute(g.input, g.exec()), { code: 'VAULT_CONFLICT' });
  assert.equal(g.sends(), 0);
});
