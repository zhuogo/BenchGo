import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantStore } from '../src/store.mjs';
import { createOrchestrationRuntime } from '../src/orchestration-runtime.mjs';
import { readAssessmentPolicy } from '../src/assessment-policy.mjs';

test('production runtime protects dispatched Worker files and exposes authorized rollback', async t => {
  const root = await mkdtemp(join(tmpdir(), 'benchgo-checkpoint-executor-'));
  const store = await createAssistantStore({ dataDirectory: root });
  let runtime, file, active;
  const transcript = [];
  t.after(async () => { await runtime?.stop(); await store.close(); await rm(root, { recursive: true, force: true }); });
  await store.updateConfig({ workerModels: [{ providerId: 'provider', modelId: 'opaque' }] });
  const db = store.orchestration, policy = await readAssessmentPolicy(store);
  db.createThread({ id: 'thread', source: { type: 'desktop', id: 'owner' } });
  const ticket = db.createTicket({ threadId: 'thread', target: 'create artifact', mandate: { source: { channel: 'desktop', sessionId: 'owner', messageId: 'source' }, actorId: 'desktop-owner', admission: 'desktop-approved-delegation', policyVersion: policy.desktopVersion, controlledActions: 'require-current-policy-and-harness-approval' } });
  db.createAssignment(ticket.id, { model: { providerId: 'provider', modelId: 'opaque' } });
  const ctx = {
    on() { return () => {}; },
    llm: { prepareCall: async () => {} },
    sessionQuery: { readSession: async () => ({ events: structuredClone(transcript) }) },
    agents: {
      get: () => active,
      create: async input => {
        const handlers = new Map(), tools = new Map(); file = join(input.meta.cwd, 'artifact.txt');
        const agent = { id: input.sessionId, session: { snapshotEvents: () => structuredClone(transcript) }, followup(message) {
          transcript.push({ seq: transcript.length, type: 'turn/start', data: { turn: 1 } });
          handlers.get('agent/status')({ status: 'running' });
          void handlers.get('agent/pre-step')({ turn: 1, messages: [message] }, async () => ({ kind: 'enter', messages: [] }))
            .then(() => handlers.get('tools/execute')({ name: 'opaque/write-tool', callId: 'call-1', agent, signal: new AbortController().signal }, () => writeFile(file, 'agent content')))
            .then(async () => {
              assert.equal(await readFile(file, 'utf8'), 'agent content');
              await tools.get('assistant_task_result').execute({ selfCheck: { summary: 'Verified created artifact', checks: ['Read created file'] } }, { agent, signal: new AbortController().signal, callId: 'self-check' });
              transcript.push({ seq: transcript.length, type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'Created artifact' }] } } });
              transcript.push({ seq: transcript.length, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
            }).then(() => handlers.get('agent/status')({ status: 'idle' }), error => handlers.get('agent/error')({ error }));
        } };
        await input.setup({ tools: { register(tool) { tools.set(tool.name, tool); } }, systemPrompt: { section() {}, context() {} }, get: () => undefined, on: (name, handler) => { handlers.set(name, handler); } }, agent);
        active = agent;
        return { agent, dispose: async () => { active = undefined; } };
      },
    },
  };
  runtime = createOrchestrationRuntime({ ctx, store,
    prepareTicketReply: async delivery => {
      assert.equal(db.getTicket(ticket.id).status, 'waiting');
      assert.equal(delivery.payload.text, undefined);
      assert.equal(delivery.payload.publication, undefined);
      assert.equal(db.results(ticket.id).at(-1).finalSummary, 'Created artifact');
      return { status: 'ready', text: '文件已经创建并检查完成。' };
    },
    deliverDesktop: async delivery => {
      assert.equal(delivery.payload.publication.origin, 'router');
      assert.equal(delivery.payload.text, '文件已经创建并检查完成。');
      return { status: 'accepted', messageId: 'local' };
    } });
  for (let count = 0; count < 100 && db.getTicket(ticket.id).status !== 'completed'; count++) { await runtime.tick(); await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal(db.getTicket(ticket.id).status, 'completed');
  assert.equal(await readFile(file, 'utf8'), 'agent content');
  const rows = await runtime.checkpoints.list({ ticketId: ticket.id, ownerSessionId: 'owner' });
  assert.equal(rows.length, 1); assert.equal(rows[0].callId, 'call-1');
  const request = { ticketId: ticket.id, runId: rows[0].runId, ownerSessionId: 'owner' };
  const preview = await runtime.checkpoints.preview(request);
  assert.deepEqual(preview.changes.map(row => row.path), ['artifact.txt']);
  await runtime.checkpoints.restore({ ...request, token: preview.token });
  await assert.rejects(readFile(file), { code: 'ENOENT' });
});
