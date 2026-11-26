import test from 'node:test';
import assert from 'node:assert/strict';
import { installWorkerMedia, workerMediaReport } from '../src/worker-media.mjs';
import { mediaArtifactUrl, NATIVE_MEDIA_RESULT } from '../../media/shared/generation-result.mjs';
import { updateHistoryIndex } from '../src/history-index.mjs';
import { installChatPublication, projectChatMessages } from '../src/chat-publication.mjs';
import { taskReplyInstruction, taskReplySource } from '../src/task-reply.mjs';

test('bound Worker generates a batch using the original explicit selection and records partial results', async () => {
  const source = { channel: 'desktop', sessionId: 'router', messageId: 'request' };
  const userMessage = { id: 'request', source: { kind: 'user' }, content: [{ type: 'text', text: '用 model-exact 生成两张图' }] };
  const agent = { id: 'worker', session: { header: { origin: 'subagent' }, snapshotEvents: () => [] } };
  const registrations = new Map();
  const sections = [];
  const scope = {
    tools: { register: (definition, { when }) => registrations.set(definition.name, { ...definition, when }) },
    systemPrompt: { section: section => sections.push(section) },
  };
  const generation = {
    getSettings: async () => ({ image: { enabled: true, routes: [{}] } }),
    async generateBatch({ kind, model, prompts }) {
      assert.equal(kind, 'image');
      assert.equal(model, 'model-exact');
      assert.deepEqual(prompts, ['dog', 'dog']);
      return { results: [
        { filename: 'first.png', mimeType: 'image/png' },
        { requestId: 'second', error: { code: 'MEDIA_SUBMISSION_UNCERTAIN', message: '未收到 HTTP 响应' } },
      ] };
    },
  };
  installWorkerMedia(scope, { get: name => name === 'mediaGeneration' ? generation : undefined, sessionQuery: { readSession: async id => {
    assert.equal(id, source.sessionId);
    return { events: [{ type: 'user/message', data: userMessage }] };
  } } }, agent, source);
  assert.deepEqual(sections.map(({ name }) => name), ['benchgo-worker-media']);
  assert.ok(Number.isFinite(sections[0].order));
  const tool = registrations.get('generate_image');
  assert.equal(await tool.when({ agent }), true);
  assert.equal(await tool.when({ agent: {} }), false);
  const args = { model: 'model-exact', count: 2, prompt: 'dog' };
  await assert.rejects(tool.execute(args, { agent: { ...agent }, callId: 'call' }), /仅供此工单/u);
  const value = await tool.execute(args, { agent, callId: 'call' });
  const events = [
    { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', name: tool.name, id: 'call' }] } } },
    { type: 'tool/result', data: { message: { toolCallId: 'call', content: tool.output.render(args, value) }, meta: tool.output.presentationMeta(args, value) } },
  ];
  const report = workerMediaReport(events);
  assert.deepEqual(report.files.map(file => file.filename), ['first.png']);
  assert.deepEqual(report.failures, ['second · MEDIA_SUBMISSION_UNCERTAIN · 未收到 HTTP 响应']);
});

test('Worker media receipts deliver independently of the Router wording and preserve the actual error', async () => {
  const media = [
    { filename: 'first.png', url: mediaArtifactUrl('first.png'), mimeType: 'image/png' },
    { filename: 'first.mp4', url: mediaArtifactUrl('first.mp4'), mimeType: 'video/mp4' },
    { filename: 'first.mp3', url: mediaArtifactUrl('first.mp3'), mimeType: 'audio/mpeg' },
  ];
  const instruction = taskReplyInstruction({ kind: 'result', media: { files: media } });
  assert.match(instruction, /可在正文中用 Markdown 图片、文件链接/u);
  const markdown = `![生成图片](${media[0].url})\n\n[下载音频](${media[2].url})`;
  const events = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'user/message', seq: 1, data: { id: 'result-notice', source: {
      kind: taskReplySource, replyKind: 'result', eventKey: 'result:task:1', taskId: 'task',
      replyMode: 'conversation', media, mediaFailures: ['ECONNRESET · request-id'],
    } } },
    { type: 'assistant/message', seq: 2, data: { turn: 1, message: {
      source: { kind: 'model' }, content: [{ type: 'text', text: markdown }],
    } } },
  ];
  let stopping;
  const agent = { session: { snapshotEvents: () => events } };
  installChatPublication({ on: (_name, handler) => { stopping = handler; }, tools: { register() {} } }, agent, {
    canPublish: () => true,
    appendRecord: (_session, type, data) => events.push({ type, data, ignorable: true, seq: events.length }),
  });
  await stopping({ agent, turn: 1 });
  await stopping({ agent, turn: 1 });
  assert.equal(events.filter(event => event.type === NATIVE_MEDIA_RESULT).length, 3);
  const index = updateHistoryIndex(events);
  assert.deepEqual(index.images.map(row => row.image.url), [media[0].url]);
  assert.deepEqual(index.media.map(row => row.file.url), [media[1].url, media[2].url]);
  const end = { type: 'turn/end', seq: events.length, data: { turn: 1, reason: { kind: 'completed' } } };
  const [reply] = projectChatMessages([...events, end]);
  assert.ok(reply.text.startsWith(markdown));
  assert.match(reply.text, /ECONNRESET · request-id/u);
});
