import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { approvalReminderSignal, currentApprovalReminderSignal } from '../src/approval-reminder.mjs';

const requireBenchgo = createRequire(new URL('../../benchgo/package.json', import.meta.url));
const { transformSync } = requireBenchgo('esbuild');
const approvalSource = new URL('../../../deepseek-harness/packages/interaction/user-approval/src/', import.meta.url).href;
// Read the official service in memory, preserving the same installed Session /
// Cordis instance. No changes or generated files enter the official checkout.
const hook = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.startsWith(approvalSource) && !/^(?:[./]|[a-z]+:)/i.test(specifier))
    return { url: pathToFileURL(requireBenchgo.resolve(specifier)).href, shortCircuit: true };
  return next(specifier, context);
}, load(url, context, next) {
  if (!url.startsWith(approvalSource) || !url.endsWith('.ts')) return next(url, context);
  return { format: 'module', source: transformSync(readFileSync(fileURLToPath(url), 'utf8'), {
    loader: 'ts', format: 'esm', target: 'node24', sourcefile: fileURLToPath(url),
  }).code, shortCircuit: true };
} });
const { default: ApprovalService } = await import('../../../deepseek-harness/packages/interaction/user-approval/src/index.ts');
const load = name => import(pathToFileURL(requireBenchgo.resolve(name)).href);
const { Context } = await load('@deepseek-ai/cordis');
const { default: SessionStore } = await load('@deepseek-ai/dsh-session');
const { default: SessionProjectionRegistry } = await load('@deepseek-ai/dsh-session-projection');
hook.deregister();

const identity = { assignmentId: 'assignment', runId: 'run', sessionId: 'worker', callId: 'call', actionId: 'action' };
function fixture() {
  const ticket = { id: 'ticket', title: '发送报告', status: 'open', instructionRevision: 1,
    mandate: { actorId: 'desktop-owner', source: { channel: 'desktop', sessionId: 'router-side', threadId: 'side', messageId: 'human' } } };
  const assignment = { id: 'assignment', ticketId: ticket.id, state: 'claimed', owner: 'owner', fence: 1, leaseUntil: 2000 };
  const run = { id: 'run', owner: 'owner', fence: 1, sessionId: 'worker', state: 'running' };
  const database = { getAssignment: () => assignment, getTicket: () => ticket, runs: () => [run] };
  const call = { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'call', name: 'assistant_external_action',
    arguments: JSON.stringify({ operation: 'submit', actionId: 'action' }) }] } } };
  const asked = { type: 'approval/asked', data: { id: 'official-ask', toolName: 'assistant_external_action', callId: 'call', reason: 'PRIVATE EXACT BODY' } };
  return { database, ticket, assignment, run, events: [call, asked], call, asked };
}

test('approval reminder requires an unpaired official audit for the exact Worker submit, never prepare pending', () => {
  const f = fixture();
  assert.equal(approvalReminderSignal(f.database, identity, [f.call], 1000), null);
  const signal = approvalReminderSignal(f.database, identity, f.events, 1000);
  assert.equal(signal.eventKey, 'approval:worker:official-ask');
  assert.equal(signal.source.threadId, 'side');
  assert.doesNotMatch(JSON.stringify(signal), /PRIVATE EXACT BODY/);
  assert.equal(approvalReminderSignal(f.database, { ...identity, actionId: 'different' }, f.events, 1000), null);
  assert.equal(approvalReminderSignal(f.database, { ...identity, callId: 'different' }, f.events, 1000), null);
  f.call.data.message.content[0].arguments = JSON.stringify({ operation: 'prepare', actionId: 'action' });
  assert.equal(approvalReminderSignal(f.database, identity, f.events, 1000), null);
});

test('PTC-dispatched Worker submissions retain the same official audit identity', () => {
  const f = fixture(), call = { type: 'tool/ptc-dispatch-start', data: { subCallId: 'call', name: 'assistant_external_action', arguments: { operation: 'submit', actionId: 'action' } } };
  assert.equal(approvalReminderSignal(f.database, identity, [call, f.asked], 1000).approvalId, 'official-ask');
});

for (const change of ['stopped', 'expired', 'fence', 'session', 'toolScope', 'channel', 'actor']) test(`approval reminder fails closed for ${change}`, () => {
  const f = fixture();
  if (change === 'stopped') f.ticket.status = 'cancelled';
  if (change === 'expired') f.assignment.leaseUntil = 1000;
  if (change === 'fence') f.run.fence++;
  if (change === 'session') f.run.sessionId = 'other-worker';
  if (change === 'toolScope') f.ticket.mandate.toolScope = ['read'];
  if (change === 'channel') f.ticket.mandate.source.channel = 'feishu';
  if (change === 'actor') f.ticket.mandate.actorId = 'other';
  assert.equal(approvalReminderSignal(f.database, identity, f.events, 1000), null);
});

test('expression rechecks the exact ask; decided, unreadable and stopped notices are suppressed', async () => {
  const f = fixture(), signal = approvalReminderSignal(f.database, identity, f.events, 1000);
  const options = { database: f.database, signal, readSession: async () => ({ events: f.events }), now: 1000 };
  assert.deepEqual(await currentApprovalReminderSignal(options), signal);
  f.events.push({ type: 'approval/decided', data: { id: 'other-ask', outcome: 'rejected' } });
  assert.deepEqual(await currentApprovalReminderSignal(options), signal);
  f.events.push({ type: 'approval/decided', data: { id: signal.approvalId, outcome: 'allowed-once' } });
  assert.equal(await currentApprovalReminderSignal(options), null);
  assert.equal(await currentApprovalReminderSignal({ ...options, readSession: async () => { throw Error('unavailable'); } }), null);
  f.ticket.status = 'completed';
  assert.equal(await currentApprovalReminderSignal({ ...options, readSession: () => assert.fail('inactive historical notices do not read Worker logs') }), null);
});

test('real official approval service supplies asked before waiting and decided suppresses the same reminder', async t => {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(SessionStore); await ctx.plugin(SessionProjectionRegistry); await ctx.plugin(ApprovalService, { policy: 'ask' });
  const f = fixture(), session = ctx.sessions.create();
  f.run.sessionId = String(session.id);
  const exact = { ...identity, sessionId: String(session.id) };
  session.append('turn/start', { turn: 1 });
  session.append(f.call.type, { ...f.call.data, turn: 1 }, { surfaceOp: 'append' });
  let decide;
  ctx.on('approval/request', () => new Promise(resolve => { decide = resolve; }));
  const pending = ctx.approval.request({ agent: { session }, toolName: 'assistant_external_action', callId: 'call', reason: 'PRIVATE EXACT BODY' });
  const signal = approvalReminderSignal(f.database, exact, session.snapshotEvents(), 1000);
  assert.ok(signal, 'the official service appended asked synchronously before the answerer waits');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof decide, 'function');
  decide('rejected');
  assert.equal(await pending, 'rejected');
  assert.equal(approvalReminderSignal(f.database, exact, session.snapshotEvents(), 1000), null);
  assert.equal(session.snapshotEvents().filter(event => event.type === 'approval/asked').length, 1);
  assert.equal(session.snapshotEvents().filter(event => event.type === 'approval/decided').length, 1);
});
