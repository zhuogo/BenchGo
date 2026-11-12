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
  const vault = createVault({ credentials: { readRecord: async key => structuredClone(records.get(key)), modifyRecord: async (key, fn) => { const next = await fn(structuredClone(records.get(key))); records.set(key, next); return structuredClone(next); } } });
  t.after(() => { vault.dispose(); database.close(); });
  const { entry } = await vault.save({ address: 'Private API', credentials: [{ name: '密钥', value: 'VERY_PRIVATE_KEY' }] });
  const tools = new Map(), approval = { request: async input => { approvals++; assert.equal(input.agent, agent); return approve ? approve(f, input) : 'allowed-once'; } };
  const ctx = { get: key => key === 'benchgoVault' ? vault : key === 'approval' ? approval : undefined };
  const scope = { get: ctx.get, tools: { register: tool => tools.set(tool.name, tool) } };
  const f = { database, assignment, run, ticket, agent, entry, vault, tools, ctx, scope, policy: () => policy, setPolicy: value => { policy = value; }, sends: () => sends, approvals: () => approvals };
  installWorkerVault(scope, agent, { ctx, database, assignment, run, readPolicy: async () => policy, authorizeAction: async () => ({ allowed: true }) });
  f.exec = (callId = 'call-1') => ({ agent, callId, signal: new AbortController().signal });
  f.input = { handle: entry.handle, revision: entry.revision, body: { task: 'approved' } };
  return f;
}

test('Worker only registers safe vault discovery; the old execute tool is absent', async t => {
  const f = await fixture(t);
  assert.deepEqual([...f.tools.keys()], ['assistant_vault_list']);
  assert.equal(f.tools.get('assistant_vault_execute'), undefined);
  const listing = await f.tools.get('assistant_vault_list').execute({}, f.exec('list'));
  assert.equal(listing.entries.length, 1);
  assert.doesNotMatch(JSON.stringify(listing), /VERY_PRIVATE_KEY/);
  assert.equal(f.sends(), 0); assert.equal(f.approvals(), 0);
  assert.equal(f.agent.session.snapshotEvents().length, 0);
});

test('vault discovery rejects foreign agents, paused tickets and stale mandate', async t => {
  const f = await fixture(t), tool = f.tools.get('assistant_vault_list');
  await assert.rejects(tool.execute({}, { ...f.exec(), agent: { ...f.agent } }), { code: 'VAULT_WORKER_MISMATCH' });
  f.setPolicy({ ...f.policy(), desktopVersion: 'revoked' });
  await assert.rejects(tool.execute({}, f.exec()), { code: 'VAULT_MANDATE_REVOKED' });
  assert.equal(f.sends(), 0); assert.equal(f.approvals(), 0);
  const g = await fixture(t); g.database.pauseTicket(g.ticket.id);
  await assert.rejects(g.tools.get('assistant_vault_list').execute({}, g.exec()), { code: 'VAULT_WORKER_STALE' });
});
