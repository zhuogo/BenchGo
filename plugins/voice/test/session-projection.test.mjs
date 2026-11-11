import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { applyVoiceSessionActivity, registerVoiceSessionProjection, voiceSessionProjectionKey } from '../src/session-projection.mjs';

const event = (kind, time, extra = {}) => ({ type: 'plugin:benchgo-plugin/voice-conversation', ignorable: true, time,
  data: { kind, callId: 'call', requestId: 'call', ...extra } });

test('Voice summary recognizes call starts and legacy speech without exposing text or changing ordinary sessions', () => {
  assert.equal(applyVoiceSessionActivity(null, { type: 'turn/start' }), null);
  assert.equal(applyVoiceSessionActivity(null, { ...event('user', 20), ignorable: false }), null);
  const started = applyVoiceSessionActivity(null, event('call-start', 20, { startedAt: 10 }));
  assert.deepEqual(started, { used: true, startedAt: 10, lastActivityAt: 20 });
  assert.equal(applyVoiceSessionActivity(started, event('call-start', 20, { startedAt: 10 })), started);
  const legacy = applyVoiceSessionActivity(null, event('user', 40, { text: 'private words' }));
  const updated = applyVoiceSessionActivity(legacy, event('assistant', 60, { text: 'private reply' }));
  assert.deepEqual(updated, { used: true, startedAt: 40, lastActivityAt: 60 });
  assert.equal(applyVoiceSessionActivity(updated, event('handoff', 80)), updated);
  assert.doesNotMatch(JSON.stringify(updated), /private|text|callId/);
});

test('official Session projection publishes the minimal Voice summary for live and replayed durable events', async t => {
  const upstream = createRequire(new URL('../../../deepseek-harness/packages/core/agent-loop/package.json', import.meta.url));
  const load = async name => import(pathToFileURL(upstream.resolve(name)).href);
  const { Context } = await load('@deepseek-ai/cordis');
  const { default: Sessions, appendPluginRecord } = await load('@deepseek-ai/dsh-session');
  const { default: Projections } = await load('@deepseek-ai/dsh-session-projection');
  const ctx = new Context(); t.after(() => ctx.fiber.dispose());
  await ctx.plugin(Sessions); await ctx.plugin(Projections);
  const legacy = ctx.sessions.create();
  appendPluginRecord(legacy, 'plugin:benchgo-plugin/voice-conversation', { kind: 'user', callId: 'old', requestId: 'r', text: 'keep private' });
  await registerVoiceSessionProjection(ctx);
  assert.ok(ctx.sessionProjections.summaryKeys().has(voiceSessionProjectionKey));
  assert.equal(ctx.sessionProjections.summaryKeys().has('sessionListMetadata'), false);
  const prior = ctx.sessionProjections.snapshot(legacy, ctx.sessionProjections.summaryKeys()).values.benchgoVoice;
  assert.equal(prior.used, true); assert.equal(typeof prior.lastActivityAt, 'number');
  const current = ctx.sessions.create();
  assert.equal(ctx.sessionProjections.snapshot(current).values.benchgoVoice, null);
  appendPluginRecord(current, 'plugin:benchgo-plugin/voice-conversation', { kind: 'call-start', callId: 'new', requestId: 'new', mode: 'native', startedAt: Date.now() });
  const value = ctx.sessionProjections.snapshot(current, ctx.sessionProjections.summaryKeys()).values.benchgoVoice;
  assert.equal(value.used, true); assert.deepEqual(Object.keys(value).sort(), ['lastActivityAt', 'startedAt', 'used']);
  assert.equal(current.snapshotEvents().some(event => event.type === 'turn/start' || event.type === 'user/message'), false);
});
