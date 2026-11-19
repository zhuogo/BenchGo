import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { DelegationBridge } from '../src/delegation.mjs';
import { LineProcess } from '../src/line-process.mjs';

const tool = {
  name: 'generate_image', description: 'Generate an image',
  parameters: { type: 'object', properties: { prompt: { type: 'string' } } },
};

async function fixture(t) {
  const commander = new EventEmitter();
  const calls = [], events = [];
  const session = { status: 'running', turnId: 'turn-a', receipts: {
    old: { receipt: { turnId: 'turn-old' }, kind: 'prompt', text: 'Use the old model.' },
    current: { receipt: { turnId: 'turn-a' }, kind: 'prompt', text: 'Draw spring.' },
  } };
  const media = {
    async nativeTools() { return [tool]; },
    async executeNative(call) {
      calls.push(call);
      commander.emit('media.called', call);
      if (call.args.prompt === 'wait') await once(call.signal, 'abort');
      if (call.args.prompt === 'external') {
        const externalUrl = 'https://pub-13fd1d3607a441b4a9d232b3a223f5f6.r2.dev/generated/testing.png';
        return { requestId: 'external', externalUrl, url: externalUrl, mimeType: 'image/png', status: 'completed' };
      }
      return { requestId: 'fixture', filename: 'result.png', url: 'api/benchgo/media/artifact?file=result.png', mimeType: 'image/png', aborted: call.signal.aborted };
    },
  };
  Object.assign(commander, {
    get: () => session, getMediaGeneration: () => media,
    interruptedTurns: new Map(), async delegate(id) { return { delegated: id }; },
    event: (sessionId, type, data) => events.push({ sessionId, type, data }),
  });
  const bridge = await new DelegationBridge(commander).open();
  t.after(() => bridge.close());
  return { commander, bridge, media, calls, session, events };
}

test('native stdio publishes shared media tools beside delegation and uses trusted call identities', async t => {
  const { bridge, calls, events } = await fixture(t);
  const authority = bridge.forSession('native-fixture');
  async function stdio(mediaOnly) {
    const env = { COMMANDER_DELEGATE_URL: authority.url, COMMANDER_DELEGATE_TOKEN: authority.token };
    const wire = new LineProcess(authority.command, [authority.script, ...(mediaOnly ? ['--media-only'] : [])], { env });
    t.after(() => wire.close());
    const reply = await wire.request('initialize', { protocolVersion: '2024-11-05' });
    assert.deepEqual(reply.capabilities, { tools: {} });
    return wire;
  }
  const combined = await stdio(false);
  const only = await stdio(true);
  const schema = { name: tool.name, description: tool.description, inputSchema: tool.parameters };
  assert.deepEqual((await combined.request('tools/list')).tools.map(value => value.name), ['commander_delegate', tool.name]);
  assert.deepEqual((await only.request('tools/list')).tools, [schema]);
  const call = { name: tool.name, arguments: { prompt: 'hello' } };
  const generated = await only.request('tools/call', call);
  assert.equal(generated.isError, false);
  assert.equal(JSON.parse(generated.content[0].text).requestId, 'fixture');
  assert.equal(calls[0].sessionId, 'native-fixture');
  assert.match(calls[0].callId, /^turn-a:/u);
  assert.equal(calls[0].userText, 'Draw spring.');
  assert.equal(events[0].type, 'media.result');
  assert.equal(events[0].data.filename, 'result.png');
  const external = await only.request('tools/call', { name: tool.name, arguments: { prompt: 'external' } });
  const externalResult = JSON.parse(external.content[0].text);
  assert.equal(externalResult.requestId, 'external');
  assert.equal(externalResult.url, undefined);
  assert.equal(externalResult.externalUrl, undefined);
  assert.match(externalResult.delivery, /Shown in the conversation/);
  assert.equal(events[1].sessionId, 'native-fixture');
  assert.equal(events[1].type, 'media.result');
  assert.equal(events[1].data.url, events[1].data.externalUrl);
  assert.equal(events[1].data.requestId, 'external');
  const delegated = await combined.request('tools/call', { name: 'commander_delegate', arguments: {} });
  assert.deepEqual(JSON.parse(delegated.content[0].text), { delegated: 'native-fixture' });
});

test('media requests require a live turn and abort when it ends', async t => {
  const { bridge, commander, calls, session } = await fixture(t);
  const authority = bridge.forSession('native-fixture');
  const url = new URL('/media/call', authority.url);
  const body = JSON.stringify({ name: tool.name, callId: 'opaque', args: { prompt: 'wait' }, sessionId: 'claimed-other-id', userText: 'Claimed user text.' });
  const call = token => fetch(url, { method: 'POST', headers: { authorization: 'Bearer ' + token }, body });
  assert.equal((await call('foreign-token')).status, 403);
  session.status = 'idle';
  assert.equal((await call(authority.token)).status, 400);
  assert.equal(calls.length, 0);
  session.status = 'running';
  const active = once(commander, 'media.called');
  const pending = call(authority.token);
  await active;
  session.status = 'idle';
  commander.emit('event', { sessionId: 'native-fixture', type: 'turn.completed' });
  assert.equal((await (await pending).json()).aborted, true);
  assert.equal(calls[0].sessionId, 'native-fixture');
  assert.equal(calls[0].userText, 'Draw spring.');
  bridge.revoke('native-fixture');
  assert.equal((await call(authority.token)).status, 403);
});
