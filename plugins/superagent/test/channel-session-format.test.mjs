import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createChannelSessionHost, applyChannelSessionSource } from '../src/channel-session.mjs';
import { channelMessageRecordOf } from '../src/channel-session-record.mjs';

const requireBenchgo = createRequire(new URL('../../benchgo/package.json', import.meta.url));
const { transformSync } = requireBenchgo('esbuild');
const sourceRoots = ['session-format', 'session-format-v3-to-v4'].map(name => new URL(`../../../deepseek-harness/packages/session/${name}/src/`, import.meta.url).href);
// Exercise the official public V4 restore validator from the pinned checkout
// in memory; no official builds, dependency writes or generated source files.
const hook = registerHooks({ resolve(specifier, context, next) {
  if (sourceRoots.some(root => context.parentURL?.startsWith(root)) && specifier === '@deepseek-ai/dsh-session-format')
    return { url: new URL('index.ts', sourceRoots[0]).href, shortCircuit: true };
  if (sourceRoots.some(root => context.parentURL?.startsWith(root)) && !/^(?:[./]|[a-z]+:)/i.test(specifier))
    return { url: pathToFileURL(requireBenchgo.resolve(specifier)).href, shortCircuit: true };
  return next(specifier, context);
}, load(url, context, next) {
  if (!sourceRoots.some(root => url.startsWith(root)) || !url.endsWith('.ts')) return next(url, context);
  return { format: 'module', source: transformSync(readFileSync(fileURLToPath(url), 'utf8'), {
    loader: 'ts', format: 'esm', target: 'node24', sourcefile: fileURLToPath(url),
  }).code, shortCircuit: true };
} });
const { restoreReleasedV4Artifact } = await import('../../../deepseek-harness/packages/session/session-format-v3-to-v4/src/validation.ts');
hook.deregister();
const load = name => import(pathToFileURL(requireBenchgo.resolve(name)).href);
const { Context } = await load('@deepseek-ai/cordis');
const { default: SessionStore, Session, KNOWN_SESSION_EVENT_TYPES } = await load('@deepseek-ai/dsh-session');

test('real official Session channel records survive JSON/V4 restore without occupying a model surface head', async t => {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(SessionStore);
  const session = ctx.sessions.create(undefined, { meta: { delegationDepth: 0 } }), threads = [], source = { channel: 'feishu', sourceType: 'direct', conversationId: 'private', chatId: 'private', connectionId: 'bot' };
  let flushes = 0;
  const host = createChannelSessionHost({
    ctx: { sessions: { async flush(subject) { assert.equal(subject, session); flushes++; } },
      sessionQuery: { async readSession(id) { assert.equal(id, session.id); return { events: session.snapshotEvents() }; } } },
    store: { async getState() { return { threads }; } },
    engine: { async ensureSourceThread(input) {
      let thread = threads.find(row => row.sourceKey === input.sourceKey);
      if (!thread) threads.push(thread = { ...input, id: 'channel-thread', sessionId: session.id, createdAt: '2026-01-01T00:00:00.000Z' });
      return thread;
    }, async ensureSession() { return { session }; } },
  });
  const event = { source, threadId: 'remote-thread', text: 'channel input' }, result = { intakeEvent: { id: 'original-trigger' } };
  await host.onInbound(event, result); await host.onInbound(event, result);
  await host.onDelivery({ id: 'outbox', state: 'sent', sentAt: '2026-01-01T00:00:01.000Z', receipt: { status: 'accepted', messageId: 'remote-message' },
    source, threadId: event.threadId, text: 'confirmed original-source reply' });
  assert.equal(flushes, 3);
  const physical = JSON.stringify({ header: { ...session.header, version: 4 }, events: session.snapshotEvents(), inheritedEventCount: 0 });
  const artifact = restoreReleasedV4Artifact(JSON.parse(physical), KNOWN_SESSION_EVENT_TYPES);
  const restored = Session.fromRestore(session.id, artifact.events, session.header, 0, 'detached');
  assert.equal(restored.snapshotEvents().filter(channelMessageRecordOf).length, 2);
  assert.deepEqual(restored.surface.nodes, [], 'channel display cannot take the head reserved for the first genuine official model step');
  assert.deepEqual(restored.deriveMessages(), []);
  assert.equal(restored.snapshotEvents().some(event => event.type === 'user/message' || event.type === 'system/message' || event.type === 'turn/start'), false);
  assert.deepEqual(restored.snapshotEvents().reduce(applyChannelSessionSource, null), { channel: 'feishu', sourceType: 'direct', conversationId: 'private' });
  // Reopening the same session preserves the central mirror identity and does
  // not turn these records into a followup/inject or another action ledger.
  assert.deepEqual(restored.snapshotEvents().filter(channelMessageRecordOf).map(event => event.data.mirrorKey), ['intake:original-trigger', 'delivery:task:outbox']);
});
