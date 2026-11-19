import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantStore } from '../src/store.mjs';
import { createRouterTools } from '../src/router-tools.mjs';

const skillBody = '## When to Use\nVerify changes.\n## Procedure\nRun checks.\n## Pitfalls\nDo not assume.\n## Verification\nRead results.';
async function fixture(t, { threadId = 'main', channel, link } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-router-maintenance-'));
  const store = await createAssistantStore({ dataDirectory: directory });
  const tools = new Map(), actions = [];
  const agent = { id: 'owner-session', status: 'running', session: { header: {}, snapshotEvents: () => events } };
  let events;
  const message = (text, id = 'message-1') => { events = [{ type: 'turn/start' }, { type: 'user/message', data: { id, source: { kind: 'user' }, content: [{ type: 'text', text }] } }]; };
  message('我喜欢简洁回答。');
  const ctx = { get: name => name === 'benchgoLink' ? link : undefined, agents: { get: id => id === agent.id ? agent : undefined,
    currentInitiator: () => agent, turnBoundaryOf: () => ({ openTurnStartSeq: 0 }) } };
  await store.updateState(threadId === 'main' ? { mainSessionId: agent.id } : { threads: [{ id: threadId, sessionId: agent.id, title: 'side', ...(channel ? { source: { channel }, sourceKey: 'external' } : {}) }] });
  const scope = { tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } }, systemPrompt: { section() {}, context() {} } };
  createRouterTools({ ctx, store, shutdown: new AbortController(),
    modelActions: { execute(input) { actions.push(input); return { legacyAction: true }; } } })(scope, { threadId, agent });
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  return { store, tools, actions, agent, events: () => events, message,
    run: (name, args, extra) => tools.get(name).execute(args, { agent, callId: 'call-1', signal: new AbortController().signal, ...extra }) };
}

test('Router immediate memory uses real original evidence, creates no task, and preserves correction and forgetting', async t => {
  const f = await fixture(t);
  const before = f.store.orchestration.listTasks().length;
  const saved = await f.run('assistant_memory', { content: '用户偏好简洁回答。', source: { excerpt: 'model invented' } });
  assert.equal(saved.source.excerpt, '我喜欢简洁回答。');
  assert.equal(saved.source.messageId, 'message-1');
  assert.equal(saved.source.role, 'user');
  assert.equal(saved.source.excerptTruncated, false);
  const corrected = await f.run('assistant_memory', { id: saved.id, revision: saved.revision, content: '偏好先结论再说明。' });
  assert.equal(corrected.revision, saved.revision + 1);
  assert.deepEqual(await f.run('assistant_memory', { id: saved.id, revision: corrected.revision, remove: true }), { removed: true });
  assert.equal(f.store.orchestration.listTasks().length, before);
  assert.deepEqual(f.actions, []);
  f.events().push({ type: 'turn/end' });
  await assert.rejects(f.run('assistant_memory', { content: 'no current turn' }), /当前原始用户消息/);
});

test('stable work and proactive preference updates save directly; identity retains explicit action path', async t => {
  const f = await fixture(t);
  f.message('以后不在晚上联系我；先结论后说明。');
  for (const name of ['AGENTS.md', 'PROACTIVE_PREFERENCES.md']) {
    const { document } = await f.run('assistant_profile', { op: 'read', name });
    const result = await f.run('assistant_profile', { op: 'update', name, expectedHash: document.hash, content: `${document.content}\n先结论后说明。\n` });
    assert.match(result.document.content, /先结论/);
    assert.equal(result.document.source.excerpt, '以后不在晚上联系我；先结论后说明。');
  }
  assert.deepEqual(f.actions, []);
  assert.deepEqual(await f.run('assistant_profile', { op: 'update', name: 'IDENTITY.md', content: 'new identity', expectedHash: 'fresh' }), { legacyAction: true });
  assert.equal(f.actions.length, 1);
  assert.equal(f.actions[0].instruction.message.id, 'message-1');
  await assert.rejects(f.run('assistant_profile', { op: 'read', name: '../config.json' }), /不安全路径/);
  const recursive = await f.run('assistant_profile', { op: 'list', recursive: true });
  assert.equal(recursive.recursive, true);
  assert.ok(recursive.documents.some(row => row.name === 'PROACTIVE_PREFERENCES.md'));
});

test('learning enqueue accepts only host-bound references and no model payload or source', async t => {
  const f = await fixture(t);
  await assert.rejects(f.run('assistant_review', { op: 'enqueue', payload: { content: 'made up' }, source: { messageId: 'fake' } }), /不接受模型正文/);
  const result = await f.run('assistant_review', { op: 'enqueue' });
  assert.equal(result.entry, 'natural-language');
  const [review] = await f.run('assistant_review', { op: 'list' });
  assert.equal(review.source.messageId, 'message-1');
  assert.equal(review.payload.material, 'trusted-sources-v1');
  assert.equal(JSON.stringify(review.payload).includes('我喜欢'), false);
  assert.equal(f.tools.get('assistant_review').parameters.properties.source, undefined);
  assert.equal(f.tools.get('assistant_review').parameters.properties.payload, undefined);
  assert.ok((await f.run('assistant_review', { op: 'budget' })).limit >= 1);
});

test('skill usage is separate from effectiveness and feedback persists the real user text only', async t => {
  const f = await fixture(t);
  const pending = f.store.ownedSkills.propose({ name: 'check-changes', description: 'Check changes', content: skillBody, source: { messageId: 'trusted' }, idempotencyKey: 'first' });
  const skill = f.store.ownedSkills.approve(pending.id, { revision: pending.revision });
  assert.deepEqual((await f.run('assistant_review', { op: 'skills' })).skills[0].usage, { count: 0, lastUsedAt: null });
  f.store.ownedSkills.recordUse({ id: skill.id, eventId: 'load-1' });
  const listed = await f.run('assistant_review', { op: 'skills' });
  assert.equal(listed.skills[0].usage.count, 1);
  assert.deepEqual(f.store.ownedSkills.reviewInputs(), []);
  f.message('这个检查方法漏了关键问题，结果失败。', 'failure-feedback');
  const args = { op: 'skill-feedback', id: skill.id, outcome: 'failure' };
  const { feedback } = await f.run('assistant_review', args);
  assert.equal(feedback.text, '这个检查方法漏了关键问题，结果失败。');
  assert.equal(feedback.source.messageId, 'failure-feedback');
  assert.equal(feedback.outcome, 'failure');
  assert.equal((await f.run('assistant_review', args)).feedback.eventId, feedback.eventId);
  assert.equal(f.store.ownedSkills.reviewInputs()[0].feedback.length, 1);
  await assert.rejects(f.run('assistant_review', { ...args, text: 'model success' }), /不接受模型正文/);
  await assert.rejects(f.run('assistant_review', { ...args, id: 'third-party' }), /可用自建技能/);
});

test('ideas expose proactive preferences and explicit dismissal without creating a task', async t => {
  const f = await fixture(t, { threadId: 'manual-side' });
  const idea = f.store.ideas.propose({ title: 'A useful suggestion', content: 'Consider organizing references.', source: { messageId: 'source', sessionId: f.agent.id }, idempotencyKey: 'idea:1', expiresAt: new Date(Date.now() + 86400000).toISOString() });
  const before = f.store.orchestration.listTasks().length;
  const result = await f.run('assistant_review', { op: 'ideas' });
  assert.equal(result.ideas[0].id, idea.id);
  assert.equal(result.preferences.name, 'PROACTIVE_PREFERENCES.md');
  f.message('这个建议不需要，别再提了。');
  assert.equal((await f.run('assistant_review', { op: 'dismiss-idea', id: idea.id })).idea.status, 'dismissed');
  assert.equal(f.store.orchestration.listTasks().length, before);
  assert.deepEqual(f.actions, []);
});

test('maintenance tools reject retained Worker handles, external chats and changed human turns', async t => {
  const f = await fixture(t);
  for (const [name, args] of [['assistant_memory', { content: 'x' }], ['assistant_profile', { op: 'update', name: 'AGENTS.md' }], ['assistant_review', { op: 'skill-feedback', id: 'x' }], ['assistant_review', { op: 'dismiss-idea', id: 'x' }]]) {
    await assert.rejects(f.run(name, args, { agent: { id: 'worker' } }), { code: 'WORKER_MEMORY_WRITE_DENIED' });
  }
  const external = await fixture(t, { threadId: 'external', channel: 'feishu' });
  await assert.rejects(external.run('assistant_memory', { content: 'x' }), { code: 'HISTORY_SCOPE_DENIED' });
  await assert.rejects(external.run('assistant_review', { op: 'ideas' }), { code: 'HISTORY_SCOPE_DENIED' });
  const original = f.store.getState;
  f.store.getState = async () => { const state = await original(); f.message('another user message', 'message-2'); return state; };
  await assert.rejects(f.run('assistant_memory', { content: 'x' }), /用户消息已变化/);
});

const sshArgs = { deviceId: 'server-42', command: 'printf "benchgo\\n"' };
const sshTarget = { name: '香港', host: 'server.example.test', port: 2200, username: 'operator', revision: 'settings-revision' };
test('SSH maintenance resolves registered servers and executes directly from a manual conversation', async t => {
  const commands = [];
  const link = {
    devices: async () => ({ devices: [
      { id: 'linked-only', name: 'Link', sshManaged: false },
      { id: 'server-42', name: '香港', sshManaged: true, sshStatus: 'disconnected', status: 'offline', token: 'private' },
    ] }),
    sshTarget: async ({ deviceId }) => { assert.equal(deviceId, sshArgs.deviceId); return sshTarget; },
    sshCommand: async input => { commands.push(input); return { exitCode: 0, stdout: 'benchgo\n', stderr: '' }; },
  };
  const f = await fixture(t, { threadId: 'manual-side', link });
  f.message('在香港执行输出检查');
  assert.deepEqual(await f.run('assistant_server_ssh', {}), { devices: [{ id: 'server-42', name: '香港', sshStatus: 'disconnected' }] });
  assert.deepEqual(await f.run('assistant_server_ssh', sshArgs), { exitCode: 0, stdout: 'benchgo\n', stderr: '' });
  assert.equal(commands.length, 1);
  const { signal, ...submitted } = commands[0];
  assert.equal(signal.aborted, false);
  assert.deepEqual(submitted, { ...sshArgs, expectedRevision: sshTarget.revision });
});

test('SSH maintenance rejects a closed turn and external channel before resolving targets', async t => {
  const link = { sshTarget: () => assert.fail('Link target accessed'), sshCommand: () => assert.fail('SSH command started') };
  const f = await fixture(t, { link });
  f.events().push({ type: 'turn/end' });
  await assert.rejects(f.run('assistant_server_ssh', sshArgs), /真实用户文字指令/);
  const external = await fixture(t, { threadId: 'external', channel: 'feishu', link });
  await assert.rejects(external.run('assistant_server_ssh', sshArgs), { code: 'HISTORY_SCOPE_DENIED' });
});

test('SSH maintenance rechecks the current instruction and cancellation after resolving the target', async t => {
  const controller = new AbortController();
  let onTarget;
  const f = await fixture(t, { link: { sshTarget: async () => { onTarget(); return sshTarget; }, sshCommand: () => assert.fail('SSH command started') } });
  onTarget = () => f.message('别执行', 'message-2');
  await assert.rejects(f.run('assistant_server_ssh', sshArgs), /用户消息已变化/);
  onTarget = () => controller.abort();
  await assert.rejects(f.run('assistant_server_ssh', sshArgs, { signal: controller.signal }), { name: 'AbortError' });
});
