import test from 'node:test';
import assert from 'node:assert/strict';
import { createComposerInboxBridge, serializeComposerText, mountComposerInboxAdapter } from '../client/composer-inbox.mjs';
import { SlotCore } from '../../../deepseek-harness/packages/client/ui-slots/lib/index.js';

function fixture(options = {}) {
  let draft = { draft: '第一条', phase: 'plain', draftRev: 1, occurrences: [], attachmentIds: [] };
  const sent = [], errors = [], commands = [], data = new Map(); let sequence = 0;
  const storage = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
  const bridge = createComposerInboxBridge({ threadId: 'main', storage, storageKey: 'draft',
    getDraft: () => draft, clearDraft: () => { draft = { ...draft, draft: '', draftRev: draft.draftRev + 1 }; },
    serialize: value => serializeComposerText(value), send: async row => { sent.push(row); return { status: 'queued', requestId: row.requestId }; },
    submitCommand: (...args) => commands.push(args), onSystemError: error => errors.push(error), uuid: () => `request-${++sequence}`,
    ...options,
  });
  return { bridge, sent, errors, commands, storage, data, draft: () => draft, setDraft: text => { draft = { ...draft, draft: text, draftRev: draft.draftRev + 1 }; }, patch: value => { draft = { ...draft, ...value }; } };
}

test('official composer accepts consecutive messages while the first admission is pending and preserves newer drafts', async () => {
  let release;
  const sent = [];
  const f = fixture({ send: row => { sent.push(row); return row.text === '第一条' ? new Promise(resolve => { release = resolve; }) : Promise.resolve({ status: 'queued' }); } });
  const first = f.bridge.submit(); await Promise.resolve();
  f.setDraft('第二条'); await f.bridge.submit();
  assert.equal(f.draft().draft, '');
  f.setDraft('仍在编辑'); release({ status: 'processing' }); await first;
  assert.equal(f.draft().draft, '仍在编辑');
  assert.deepEqual(sent.map(row => row.text), ['第一条', '第二条']);
  assert.notEqual(sent[0].requestId, sent[1].requestId);
});

test('lost receipt retries the same request identity and reports explicit system state', async () => {
  const sent = [];
  const f = fixture({ send: async row => { sent.push(row); if (sent.length === 1) throw Error('transport disconnected'); return { status: 'queued' }; } });
  await f.bridge.submit(); assert.equal(f.draft().draft, '第一条');
  await f.bridge.submit(); assert.equal(f.draft().draft, '');
  assert.equal(sent[0].requestId, sent[1].requestId);
  assert.match(f.errors[0], /disconnected/);
});

test('restart only reconciles stored receipts and never replays an unknown dispatch', async () => {
  const first = fixture({ send: async () => { throw Error('lost reply'); } });
  await first.bridge.submit(); first.bridge.dispose();
  const saved = JSON.parse(first.storage.getItem('draft'));
  let sent = 0;
  const second = fixture({ storage: first.storage, send: async () => { sent++; }, requests: async () => [{ requestId: saved[0].requestId, status: 'processing' }] });
  await second.bridge.reconcile();
  assert.equal(sent, 0); assert.equal(first.storage.getItem('draft'), undefined);
});

test('attachments and unresolved references preserve drafts, commands use the official plane, clear uses the inbox', async () => {
  const f = fixture();
  f.patch({ attachmentIds: ['image'] }); await f.bridge.submit();
  assert.equal(f.sent.length, 0); assert.equal(f.draft().draft, '第一条'); assert.match(f.errors[0], /附件.*保留/);
  f.patch({ attachmentIds: [] }); f.setDraft('/compact'); await f.bridge.submit('steer', 'enter');
  assert.deepEqual(f.commands, [['steer', 'enter']]);
  f.setDraft('/clear'); await f.bridge.submit(); assert.equal(f.sent[0].text, '/clear');
  assert.equal(f.data.size, 0);
});

test('references use the official serializer in order and reject overlapping ranges', async () => {
  const draft = { draft: '看 @a 和 @b', occurrences: [{ source: 'reference', ref: 'a', offset: 2, length: 2 }, { source: 'reference', ref: 'b', offset: 7, length: 2 }] };
  assert.equal(await serializeComposerText(draft, { serializeReference: async (_source, ref) => `[${ref}]` }), '看 [a] 和 [b]');
  await assert.rejects(serializeComposerText({ ...draft, occurrences: [...draft.occurrences, draft.occurrences[0]] }, { serializeReference: async () => 'x' }), /引用/);
});

test('assistant composer uses real slots without redeclaring the official input or overriding pending interactions', () => {
  const core = new SlotCore(), component = () => null;
  core.register({ name: 'root', children: {
    'conversation.composer': { kind: 'chain', scope: 'session' },
    'conversation.composer.bar': { kind: 'single', scope: 'session-maybe' },
  } }, component);
  core.register({ name: 'conversation.composer.bar', children: {
    'conversation.input.attachments': { kind: 'single', scope: 'session-maybe' },
  } }, component);
  const slots = { inject: (_name, install) => install(), register: (options, entry) => core.register(options, entry) };
  const dispose = mountComposerInboxAdapter(slots, 'assistant-session', component);
  const entry = core.entries('conversation.composer')[0];
  assert.equal(entry.options.priority, 100);
  assert.deepEqual(entry.select({ sessionId: 'assistant-session' }), { sessionId: 'assistant-session' });
  assert.equal(entry.select({ sessionId: 'normal-session' }), null);
  assert.equal(entry.select({ sessionId: 'assistant-session', pendingInteraction: {} }), null);
  assert.ok(core.specDynamic('conversation.input.attachments'));
  dispose(); assert.equal(core.entries('conversation.composer').length, 0);
  assert.ok(core.specDynamic('conversation.input.attachments'));
});
