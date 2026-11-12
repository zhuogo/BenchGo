import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { requestSpeech } from '../../src/protocols/registry.mjs';
import { requestSpeech as websocketSpeech, speechEndpoint } from '../../src/protocols/stepfun/tts-websocket.mjs';

const config = { baseURL: 'https://audio.example/v1', apiKey: 'private-fixture', model: 'Opaque Model:9', voice: 'Exact Voice:7', speed: 1.25 };
const encode = value => Buffer.from(value).toString('base64');
const event = value => 'data: ' + JSON.stringify(value) + '\n\n';
const consume = response => response.arrayBuffer();

test('native SSE forwards first PCM before completion and keeps the common request fields opaque', async () => {
  let upstream, cancelled = false;
  const response = await requestSpeech(async (url, options) => {
    assert.equal(url, config.baseURL + '/audio/speech');
    assert.equal(options.headers.authorization, 'Bearer private-fixture');
    assert.deepEqual(JSON.parse(options.body), { model: config.model, voice: config.voice, input: '你好。', response_format: 'pcm', speed: 1.25, stream_format: 'sse', sample_rate: 24000 });
    return new Response(new ReadableStream({ start(controller) { upstream = controller; }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } });
  }, { ...config, protocol: 'stepfun-speech-sse' }, '你好。', AbortSignal.timeout(2000));
  const reader = response.body.getReader();
  upstream.enqueue(new TextEncoder().encode(event({ type: 'speech.audio.delta', audio: encode([1, 2, 3]) })));
  assert.deepEqual([...((await reader.read()).value)], [1, 2]);
  upstream.enqueue(new TextEncoder().encode(event({ type: 'speech.audio.delta', audio: encode([4]) }) + event({ type: 'speech.audio.done', audio: '' })));
  assert.deepEqual([...((await reader.read()).value)], [3, 4]); assert.equal((await reader.read()).done, true);
  assert.equal(cancelled, true); assert.match(response.headers.get('content-type'), /rate=24000;channels=1/u);
});

for (const [name, data, code] of [
  ['truncated EOF', event({ type: 'speech.audio.delta', audio: encode([1, 2]) }), 'tts_stream_incomplete'],
  ['missing audio', event({ type: 'speech.audio.done', audio: '' }), 'tts_audio_empty'],
  ['odd final PCM', event({ type: 'speech.audio.delta', audio: encode([1]) }) + event({ type: 'speech.audio.done', audio: '' }), 'tts_audio_empty'],
  ['invalid base64', event({ type: 'speech.audio.delta', audio: 'not base64' }), 'tts_audio_invalid'],
  ['invalid completion', event({ type: 'speech.audio.delta', audio: encode([1, 2]) }) + event({ type: 'speech.audio.done', audio: 'AAAA' }), 'tts_audio_invalid'],
  ['safe error', event({ type: 'speech.audio.error', error: { code: 'quota_exceeded', message: 'private-fixture' } }), 'quota_exceeded'],
]) test('SSE rejects ' + name, async () => {
  const response = await requestSpeech(async () => new Response(data, { headers: { 'content-type': 'text/event-stream' } }), { ...config, protocol: 'stepfun-speech-sse' }, '测试', AbortSignal.timeout(1000));
  await assert.rejects(consume(response), error => error.code === code && !error.message.includes('private-fixture'));
});

test('native SSE validates its protocol-specific text and speed bounds without guessing replacements', async () => {
  for (const [override, text, code] of [[{ speed: .25 }, '测试', 'tts_speed_unsupported'], [{}, '长'.repeat(1001), 'tts_text_limit']]) {
    await assert.rejects(requestSpeech(() => assert.fail('must validate before network'), { ...config, ...override, protocol: 'stepfun-speech-sse' }, text, new AbortController().signal), error => error.code === code);
  }
});

test('SSE accepts the live completion event that omits the empty audio field', async () => {
  // Confirmed against official stepaudio-3-tts for both Hello. and Chinese.
  const data = event({ type: 'speech.audio.delta', audio: encode([1, 2, 3, 4]) }) + event({ type: 'speech.audio.done' }) + 'data: [DONE]\n\n';
  const response = await requestSpeech(async () => new Response(data, { headers: { 'content-type': 'text/event-stream' } }),
    { ...config, protocol: 'stepfun-speech-sse' }, 'Hello.', AbortSignal.timeout(1000));
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3, 4]);
});

test('SSE rejects bare JSON, cancels an unread event stream and observes abort', async () => {
  await assert.rejects(requestSpeech(async () => Response.json({ audio: 'AAA=' }), { ...config, protocol: 'stepfun-speech-sse' }, 'test', new AbortController().signal), error => error.code === 'tts_stream_unavailable');
  for (const mode of ['cancel', 'abort']) {
    const abort = new AbortController(); let cancelled = false;
    const response = await requestSpeech(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } }), { ...config, protocol: 'stepfun-speech-sse' }, 'test', abort.signal);
    if (mode === 'cancel') await response.body.cancel();
    else { const pending = response.arrayBuffer(); abort.abort(); await assert.rejects(pending, { name: 'AbortError' }); }
    await new Promise(resolve => setImmediate(resolve)); assert.equal(cancelled, true);
  }
});

async function server(t, connected) {
  const ws = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => ws.once('listening', resolve));
  t.after(async () => { for (const client of ws.clients) client.terminate(); await new Promise(resolve => ws.close(resolve)); });
  ws.on('connection', connected); return 'http://127.0.0.1:' + ws.address().port + '/v1';
}

test('native WebSocket accepts incremental text, streams before final and never replays aggregate audio', async t => {
  let socket, finish, request, sent = [];
  const baseURL = await server(t, (ws, incoming) => {
    socket = ws; request = incoming;
    const send = (type, data) => ws.send(JSON.stringify({ type, data: { session_id: 'session-1', ...data } }));
    ws.on('message', raw => {
      const value = JSON.parse(String(raw)); sent.push(value);
      if (value.type === 'tts.create') send('tts.response.created');
      if (value.type === 'tts.text.done') { send('tts.response.audio.delta', { audio: encode([1, 2, 3]), status: 'unfinished' }); finish = () => { send('tts.response.audio.delta', { audio: encode([4]), status: 'finished' }); send('tts.response.audio.done', { audio: encode([1, 2, 3, 4]) }); }; }
    });
    send('tts.connection.done');
  });
  const response = await requestSpeech(null, { ...config, baseURL, protocol: 'stepfun-speech-websocket' }, '第一句。第二句。', AbortSignal.timeout(2000));
  const reader = response.body.getReader(); assert.deepEqual([...((await reader.read()).value)], [1, 2]);
  assert.equal(new URL(request.url, baseURL).searchParams.get('model'), config.model);
  assert.equal(request.headers.authorization, 'Bearer private-fixture');
  assert.deepEqual(sent[0], { type: 'tts.create', data: { session_id: 'session-1', voice_id: config.voice, response_format: 'pcm', sample_rate: 24000, speed_ratio: 1.25, mode: 'sentence' } });
  assert.equal(sent.filter(item => item.type === 'tts.text.delta').length, 1);
  assert.equal(sent.filter(item => item.type === 'tts.text.delta').map(item => item.data.text).join(''), '第一句。第二句。');
  assert.equal(sent.some(item => item.type === 'tts.text.flush'), false);
  assert.equal(sent.at(-1).type, 'tts.text.done');
  assert.equal(response.headers.get('x-voice-start-buffer-ms'), null);
  finish(); assert.deepEqual([...((await reader.read()).value)], [3, 4]); assert.equal((await reader.read()).done, true);
  assert.ok(socket);
});

for (const mode of ['truncated', 'error', 'wrong-session', 'empty']) test('WebSocket rejects ' + mode, async t => {
  const baseURL = await server(t, ws => {
    const send = (type, data) => ws.send(JSON.stringify({ type, data: { session_id: 'sid', ...data } }));
    ws.on('message', raw => {
      const value = JSON.parse(String(raw));
      if (value.type === 'tts.create') send('tts.response.created');
      if (value.type !== 'tts.text.done') return;
      if (mode === 'truncated') ws.close();
      if (mode === 'error') send('tts.response.error', { code: '503', message: 'private-fixture' });
      if (mode === 'wrong-session') send('tts.response.audio.delta', { session_id: 'other', audio: 'AQI=' });
      if (mode === 'empty') send('tts.response.audio.done', { audio: '' });
    }); send('tts.connection.done');
  });
  const response = await requestSpeech(null, { ...config, baseURL, protocol: 'stepfun-speech-websocket' }, '测试', AbortSignal.timeout(1000));
  await assert.rejects(consume(response), error => error.status === 502 && !error.message.includes('private-fixture'));
});

test('WebSocket splits only at the protocol text limit and preserves Unicode without an extra flush', async t => {
  const sent=[],text='你'.repeat(999)+'🌤'+'好'.repeat(1001);
  const baseURL=await server(t,ws=>{
    const send=(type,data)=>ws.send(JSON.stringify({type,data:{session_id:'long-text',...data}}));
    ws.on('message',raw=>{const value=JSON.parse(String(raw));sent.push(value);
      if(value.type==='tts.create')send('tts.response.created');
      if(value.type==='tts.text.done')send('tts.response.audio.done',{audio:encode([1,2])});
    });send('tts.connection.done');
  });
  const response=await websocketSpeech(null,{...config,baseURL},text,AbortSignal.timeout(2000));
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())],[1,2]);
  const chunks=sent.filter(value=>value.type==='tts.text.delta').map(value=>value.data.text);
  assert.deepEqual(chunks.map(value=>Array.from(value).length),[1000,1000,1]);
  assert.equal(chunks.join(''),text);assert.equal(sent.some(value=>value.type==='tts.text.flush'),false);
});

test('WebSocket timeouts and cancellation close the media connection', async t => {
  let closed;
  const closedPromise = new Promise(resolve => closed = resolve);
  const baseURL = await server(t, ws => ws.once('close', closed));
  await assert.rejects(websocketSpeech(null, { ...config, baseURL }, 'test', new AbortController().signal, { timeoutMs: 30 }), { name: 'TimeoutError' });
  await closedPromise;
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(websocketSpeech(null, { ...config, baseURL }, 'test', aborted.signal), { name: 'AbortError' });
  assert.equal(speechEndpoint({ baseURL: 'https://api.stepfun.com/step_plan/v1', model: 'Opaque/Model ?' }).href, 'wss://api.stepfun.com/step_plan/v1/realtime/audio?model=Opaque%2FModel+%3F');
});
