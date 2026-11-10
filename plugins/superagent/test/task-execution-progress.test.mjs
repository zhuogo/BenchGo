import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createTaskExecutionProgress } from '../src/task-execution-progress.mjs';

const at = 1794000000000;
function fixture() {
  const hooks = new Map(), agents = new Map(), runs = new Map();
  let scans = 0;
  const ctx = {
    on(name, callback) { hooks.set(name, callback); return () => hooks.delete(name); },
    agents: { list() { scans++; return [...agents.values()]; } },
  };
  const progress = createTaskExecutionProgress({ ctx, database: { runs: id => runs.get(id) || [] }, now: () => at });
  const add = (id, parentSession, fresh = true) => {
    const session = { id, seq: 0, inheritedEventCount: 0, header: { id, ...(parentSession ? { origin: 'subagent', parentSession } : {}) } };
    const agent = { id, session, status: 'running' }; agents.set(id, agent);
    if (fresh) hooks.get('session/created')(session);
    return agent;
  };
  const emit = (agent, type, data, time = at) => hooks.get('session/event')(agent.session, { seq: agent.session.seq++, time, type, data });
  const assignment = (ticketId, sessionId, revision = 1, fence = 1) => {
    const value = { id: `assignment:${ticketId}`, ticketId, instructionRevision: revision, fence, state: 'claimed' };
    runs.set(value.id, [{ id: `run:${ticketId}`, assignmentId: value.id, sessionId, fence, state: 'submitted', updatedAt: new Date(at).toISOString() }]);
    return value;
  };
  const read = (ticketId, assignment, revision = 1) => progress.batch()({ id: ticketId, instructionRevision: revision }, [assignment]);
  return { ctx, hooks, agents, runs, progress, add, emit, assignment, read, scans: () => scans };
}

test('task progress follows exact parent, current instruction revision and assignment fence', () => {
  const f = fixture();
  const a = f.add('worker-a'), b = f.add('worker-b');
  f.add('child-a', a.id); f.add('child-b', b.id); f.add('grandchild-a', 'child-a');
  const aa = f.assignment('a', a.id), ab = f.assignment('b', b.id);
  const view = f.progress.batch();
  assert.deepEqual(view({ id: 'a' }, [aa]).children.map(row => row.id), ['child-a']);
  assert.deepEqual(view({ id: 'b' }, [ab]).children.map(row => row.id), ['child-b']);
  assert.equal(f.scans(), 1, 'one registry scan per response, not one per ticket');
  assert.equal(view({ id: 'a', instructionRevision: 2 }, [aa]), null);
  assert.equal(view({ id: 'a' }, [ab]), null);
  assert.equal(view({ id: 'a' }, [{ ...aa, fence: 2 }]), null);
});

test('official subagent lifecycle retains completion, failure and cancellation after disposal', () => {
  const f = fixture(), parent = f.add('parent'), assignment = f.assignment('ticket', parent.id);
  for (const [index, reason] of ['completed', 'error', 'aborted'].entries()) {
    const child = f.add(`child-${index}`, parent.id);
    f.hooks.get('subagent/start')({ id: child.id, parentSessionId: parent.id, runId: `activation-${index}` });
    f.hooks.get('subagent/end')({ id: child.id, parentSessionId: parent.id, runId: `activation-${index}`, stopReason: reason,
      lastAssistantMessage: [{ type: 'text', text: 'PRIVATE CHILD OUTPUT' }] });
    f.agents.delete(child.id); f.hooks.get('agent/disposed')({ agent: child });
  }
  f.agents.delete(parent.id); f.hooks.get('agent/disposed')({ agent: parent });
  const view = f.read('ticket', assignment);
  assert.deepEqual(view.children.map(row => row.status), ['completed', 'failed', 'cancelled']);
  assert.deepEqual(view.childCounts, { total: 3, running: 0, completed: 1, failed: 1 });
  assert.equal(view.worker.status, 'unknown');
  assert.equal(view.limitation, undefined, 'new parent was observed from creation');
  assert.doesNotMatch(JSON.stringify(view), /PRIVATE/);
});

test('idle is waiting, verification is distinct, and tool errors do not fabricate a failed ticket', () => {
  const f = fixture(), parent = f.add('parent'), assignment = f.assignment('ticket', parent.id);
  f.emit(parent, 'tool/call', { callId: 'call', name: 'web_search', arguments: 'PRIVATE ARGUMENT' });
  assert.equal(f.read('ticket', assignment).worker.activity, '正在搜索网页');
  f.emit(parent, 'tool/result', { message: { isError: true, content: [{ type: 'text', text: 'PRIVATE RESULT' }] }, error: { reason: 'PRIVATE ERROR' } });
  assert.equal(f.read('ticket', assignment).worker.status, 'running');
  f.emit(parent, 'turn/end', { reason: { kind: 'completed' } }); parent.status = 'idle';
  assert.equal(f.read('ticket', assignment).worker.status, 'waiting');
  f.runs.get(assignment.id)[0].state = 'verifying';
  const view = f.read('ticket', assignment);
  assert.equal(view.phase, 'verifying'); assert.equal(view.worker.status, 'waiting');
  assert.equal(view.worker.activity, '正在保存执行结果');
  assert.doesNotMatch(JSON.stringify(view), /PRIVATE/);
});

test('runtime notices use structured source identity and ignore text, inherited events and stale activations', () => {
  const f = fixture(), parent = f.add('parent'), child = f.add('child', parent.id), assignment = f.assignment('ticket', parent.id);
  f.emit(parent, 'subagent/catalog', { version: 3, childId: child.id, childCreatedAt: at, name: 'secret_name', label: 'PRIVATE TASK', mode: 'continuable' });
  const notice = { id: 'notice', source: { kind: 'subagent-settled', senderSessionId: child.id, stopReason: 'completed', summary: 'PRIVATE SUMMARY' }, content: [{ type: 'text', text: 'PRIVATE OUTPUT' }] };
  f.emit(parent, 'agent/inbox/spliced', { inserted: [notice] });
  child.status = 'idle';
  assert.equal(f.read('ticket', assignment).children[0].status, 'completed');
  f.hooks.get('subagent/start')({ id: child.id, parentSessionId: parent.id, runId: 'new' }); child.status = 'running';
  f.hooks.get('subagent/end')({ id: child.id, parentSessionId: parent.id, runId: 'old', stopReason: 'error' });
  assert.equal(f.read('ticket', assignment).children[0].status, 'running');
  f.hooks.get('subagent/end')({ id: child.id, parentSessionId: parent.id, runId: 'new', stopReason: 'error' });
  f.agents.delete(child.id);
  f.emit(parent, 'user/message', notice);
  assert.equal(f.read('ticket', assignment).children[0].status, 'failed', 'old notice entering transcript cannot overwrite a newer activation');
  parent.session.inheritedEventCount = 10;
  f.emit(parent, 'subagent/catalog', { version: 3, childId: 'inherited-child', childCreatedAt: at, name: 'fake', mode: 'continuable' });
  const view = f.read('ticket', assignment);
  assert.deepEqual(view.children.map(row => row.id), ['child']);
  assert.doesNotMatch(JSON.stringify(view), /PRIVATE|secret_name|inherited-child/);
});

test('cold historical data stays unknown, and shutdown removes all observers', () => {
  const f = fixture(), assignment = f.assignment('ticket', 'cold-worker');
  const cold = f.read('ticket', assignment);
  assert.equal(cold.observed, false); assert.equal(cold.worker.status, 'unknown');
  assert.match(cold.limitation, /历史子任务记录未完整加载/);
  const parent = f.add('cold-worker', undefined, false); parent.status = 'idle';
  const live = f.read('ticket', assignment);
  assert.equal(live.observed, true); assert.equal(live.worker.status, 'waiting');
  assert.match(live.limitation, /未完整加载/);
  f.progress.dispose();
  assert.equal(f.hooks.size, 0);
});

test('cleanup failure lifecycle wins over a captured successful notice entering the parent later', () => {
  const f = fixture(), parent = f.add('parent'), assignment = f.assignment('ticket', parent.id);
  // Harness notifies the captured result before publishing the post-cleanup
  // terminal lifecycle outcome; the parent may consume that notice later.
  f.hooks.get('subagent/start')({ id: 'child', parentSessionId: parent.id, runId: 'activation' });
  f.hooks.get('subagent/end')({ id: 'child', parentSessionId: parent.id, runId: 'activation', stopReason: 'error' });
  f.emit(parent, 'user/message', { id: 'delayed-success', source: { kind: 'subagent-settled', senderSessionId: 'child', stopReason: 'completed' } });
  const view = f.read('ticket', assignment);
  assert.equal(view.children[0].status, 'failed');
  assert.equal(view.childCounts.completed, 0);
  assert.equal(view.childCounts.failed, 1);
  // Also protect an observed end when observation began after its start.
  f.hooks.get('subagent/end')({ id: 'late-child', parentSessionId: parent.id, runId: 'late-activation', stopReason: 'error' });
  f.emit(parent, 'agent/inbox/spliced', { inserted: [{ id: 'late-notice', source: { kind: 'subagent-settled', senderSessionId: 'late-child', stopReason: 'completed' } }] });
  assert.equal(f.read('ticket', assignment).children[1].status, 'failed');
});

test('an unseen delayed notice from an older activation cannot settle the next activation', () => {
  const f = fixture(), parent = f.add('parent'), assignment = f.assignment('ticket', parent.id);
  f.hooks.get('subagent/start')({ id: 'child', parentSessionId: parent.id, runId: 'old' });
  f.hooks.get('subagent/end')({ id: 'child', parentSessionId: parent.id, runId: 'old', stopReason: 'completed' });
  f.hooks.get('subagent/start')({ id: 'child', parentSessionId: parent.id, runId: 'new' });
  f.emit(parent, 'agent/inbox/spliced', { inserted: [{ id: 'first-seen-old-notice', source: { kind: 'subagent-settled', senderSessionId: 'child', stopReason: 'completed' } }] });
  assert.equal(f.read('ticket', assignment).children[0].status, 'running');
  f.hooks.get('subagent/end')({ id: 'child', parentSessionId: parent.id, runId: 'new', stopReason: 'error' });
  assert.equal(f.read('ticket', assignment).children[0].status, 'failed');
});

test('bounded presentation cache explicitly reports unavailable older observations', () => {
  const f = fixture(), assignment = f.assignment('ticket', 'old-parent');
  f.add('old-parent'); f.agents.delete('old-parent');
  for (let i = 0; i < 2050; i++) { f.add(`other-${i}`); f.agents.delete(`other-${i}`); }
  const view = f.read('ticket', assignment);
  assert.equal(view.observed, false); assert.equal(view.worker.status, 'unknown');
  assert.match(view.limitation, /未完整加载/);
});

test('resumed parent session and ownership changes exclude historical child work from current progress', () => {
  const f = fixture(), parent = f.add('parent'), assignment = f.assignment('ticket', parent.id);
  const child = f.add('old-child', parent.id);
  f.hooks.get('subagent/start')({ id: child.id, parentSessionId: parent.id, runId: 'old-activation' });
  f.hooks.get('subagent/end')({ id: child.id, parentSessionId: parent.id, runId: 'old-activation', stopReason: 'completed' });
  f.agents.delete(child.id);
  assert.equal(f.read('ticket', assignment).childCounts.completed, 1);
  // Same persisted Run/session id is recovered under a new fence and a new
  // official Session instance, as the real assignment continuation does.
  f.add('parent', undefined, false);
  assignment.fence = 2; f.runs.get(assignment.id)[0].fence = 2;
  let view = f.read('ticket', assignment);
  assert.equal(view.children.length, 0);
  assert.match(view.limitation, /未完整加载/);
  // A previously captured notice cannot recreate a child in the new scope.
  f.emit(f.agents.get('parent'), 'user/message', { id: 'old-delayed', source: { kind: 'subagent-settled', senderSessionId: child.id, stopReason: 'completed' } });
  assert.equal(f.read('ticket', assignment).children.length, 0);
  f.hooks.get('subagent/start')({ id: child.id, parentSessionId: parent.id, runId: 'new-activation' });
  assert.equal(f.read('ticket', assignment).children[0].status, 'running', 'explicit restart belongs to the current parent generation');
  // Even without a Session replacement, a new assignment/fence cannot reuse
  // previously observed children until new lifecycle facts establish them.
  assignment.fence = 3; f.runs.get(assignment.id)[0].fence = 3;
  view = f.read('ticket', assignment);
  assert.equal(view.childCounts.total, 0);
  f.hooks.get('subagent/start')({ id: 'new-child', parentSessionId: parent.id, runId: 'third-activation' });
  assert.deepEqual(f.read('ticket', assignment).children.map(row => row.id), ['new-child']);
});

test('actual official Agent and Session event envelopes project catalog and settled notice without model calls', async t => {
  const requireHarness = createRequire(new URL('../../../deepseek-harness/packages/core/agent-loop/package.json', import.meta.url));
  const load = name => import(pathToFileURL(requireHarness.resolve(name)).href);
  const { Context } = await load('@deepseek-ai/cordis');
  const ctx = new Context();
  let progress;
  t.after(async () => { progress?.dispose(); await ctx.fiber.dispose(); });
  for (const name of ['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-projection', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-agent-loop']) {
    await ctx.plugin((await load(name)).default, name.endsWith('agent-loop') ? { agents: [] } : undefined);
  }
  const run = { id: 'run', assignmentId: 'assignment', sessionId: 'progress-parent', fence: 1, state: 'submitted' };
  progress = createTaskExecutionProgress({ ctx, database: { runs: () => [run] } });
  const parent = await ctx.agents.create({ sessionId: run.sessionId, meta: { cwd: process.cwd() } });
  const child = await ctx.agents.create({ sessionId: 'progress-child', meta: { cwd: process.cwd(), origin: 'subagent', parentSession: run.sessionId, delegationDepth: 1 } });
  parent.agent.session.append('subagent/catalog', { version: 3, childId: child.agent.id, childCreatedAt: child.agent.session.header.createdAt, mode: 'continuable', name: 'research', label: 'PRIVATE TASK' });
  const { createUserMessage } = await load('@deepseek-ai/dsh-llm');
  parent.agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'PRIVATE OUTPUT' }], source: { kind: 'subagent-settled', form: 'notice', senderSessionId: child.agent.id, stopReason: 'completed', summary: 'PRIVATE SUMMARY' } }), { surfaceOp: 'append' });
  await child.dispose(); await parent.dispose();
  const view = progress.batch()({ id: 'ticket' }, [{ id: 'assignment', ticketId: 'ticket', fence: 1 }]);
  assert.equal(view.children.length, 1);
  assert.equal(view.children[0].id, 'progress-child');
  assert.equal(view.children[0].status, 'completed');
  assert.equal(view.worker.status, 'unknown', 'parent completion is not inferred from child completion');
  assert.doesNotMatch(JSON.stringify(view), /PRIVATE|research/);
});
