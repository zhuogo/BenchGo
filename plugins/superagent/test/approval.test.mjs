import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { requestExternalActionApproval } from '../src/approval.mjs';
import { createExternalActionStore } from '../src/external-action-store.mjs';
import { createExternalActionRegistry, createExternalActionService } from '../src/external-actions.mjs';
import { loadRolePackage } from './role-host-fixture.mjs';

test('external approval never trusts internal authorized flag and preserves official once-only outcome', async () => {
  let asks = 0;
  const ctx = { get: () => ({ request: async request => { asks++; assert.equal(request.toolName, 'assistant_external_action'); assert.match(request.reason, /recipient/); return 'allowed-once'; } }) };
  assert.equal(await requestExternalActionApproval(ctx, { exec: { agent: {}, callId: 'send', authorized: true }, action: { category: 'external-send', target: { recipient: 'person' }, content: { text: 'final' } } }), 'allowed-once');
  assert.equal(asks, 1);
});

for (const override of [false, true]) test(`official never policy rejects a business action without a card or submission (session override=${override})`, async t => {
  const requireHost = createRequire(new URL('../../../deepseek-harness/packages/core/agent-loop/package.json', import.meta.url));
  const load = name => import(pathToFileURL(requireHost.resolve(name)).href);
  const { Context } = await load('@deepseek-ai/cordis');
  const { default: SessionStore } = await load('@deepseek-ai/dsh-session');
  const { default: SessionProjectionRegistry } = await load('@deepseek-ai/dsh-session-projection');
  const { default: ApprovalService, setApprovalPolicy } = await loadRolePackage('interaction/user-approval', '@deepseek-ai/dsh-user-approval');
  const ctx = new Context(), store = createExternalActionStore({ filename: ':memory:', profileId: 'profile' });
  t.after(async () => { store.close(); await ctx.fiber.dispose(); });
  await ctx.plugin(SessionStore); await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(ApprovalService, { policy: override ? 'ask' : 'never' });
  const session = ctx.sessions.create();
  if (override) setApprovalPolicy(session, 'never');
  session.append('turn/start', { turn: 1 });
  let cards = 0, submissions = 0;
  ctx.on('approval/request', () => { cards++; return 'allowed-once'; });
  const registry = createExternalActionRegistry();
  registry.register({ id: 'send', category: 'external-send', inputSchema: { type: 'object' },
    prepare: () => ({ target: { recipient: 'person' }, content: { text: 'exact body' }, submission: { recipient: 'person', text: 'exact body' } }),
    submit: () => { submissions++; return { status: 'accepted', receiptId: 'unexpected' }; } });
  const context = { profileId: 'profile', actorId: 'owner', taskId: 'task', assignmentId: 'assignment', runId: 'run',
    authorizationVersion: 'one', policyVersion: 'one' };
  const service = createExternalActionService({ store, registry, getContext: async () => context,
    requestApproval: request => requestExternalActionApproval(ctx, request) });
  const exec = { agent: { session }, callId: 'send', signal: new AbortController().signal };
  const action = await service.prepare({ adapterId: 'send', requestId: 'exact-action' }, exec);
  await assert.rejects(service.submit({ actionId: action.id }, exec), error => {
    assert.equal(error.code, 'APPROVAL_POLICY_NEVER');
    assert.match(error.message, /不会显示审批卡/);
    assert.match(error.message, /未提交/);
    return true;
  });
  assert.equal(cards, 0);
  assert.equal(submissions, 0);
  assert.equal(store.get(action.id).state, 'pending', 'policy denial cannot be recorded as a human decision');
  const events = session.snapshotEvents();
  const asked = events.filter(event => event.type === 'approval/asked');
  const decided = events.filter(event => event.type === 'approval/decided');
  assert.equal(asked.length, 1);
  assert.deepEqual(decided.map(event => event.data), [{ id: asked[0].data.id, outcome: 'rejected' }]);
  assert.equal(ctx.approval.overrideOf(session) ?? ctx.approval.config.policy, 'never');
  assert.equal(events.filter(event => event.type === 'approval/policy').length, Number(override));
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
});
