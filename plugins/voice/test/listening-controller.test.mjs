import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceController } from '../client/controller.mjs';

globalThis.document ||= { baseURI: 'https://voice.example/' };
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness({ mode = 'direct' } = {}) {
  let time = 0, timerId = 0;
  const snapshot = { revision: 0, entries: [], change: { kind: 'replace' } };
  let config = { call: true, dictation: true, readAloud: true, asr: { configured: true, protocol: 'transcriptions-sse' }, tts: { configured: true, protocol: 'speech' }, listening: { enabled: true, configured: true, wakeSource: 'custom', wakeWord: 'BenchGo', wakeWordResolved: 'BenchGo', wakeAvailable: true } };
  const timers = new Map(), calls = [], sent = [], captures = [];
  const status = { running: false, pendingInteraction: false };
  const source = { getSnapshot: () => snapshot, subscribe: () => () => {} };
  const api = createVoiceController({
    uiSession: { sessionStatus: { getSnapshot: () => new Map([['original', status]]), subscribe: () => () => {} } },
    sessions: { binding: sessionId => ({ sessionId, eventSource: source }), retain: () => ({ ready: Promise.resolve(), release() {} }), scope: sessionId => ({ get: () => ({ send: async text => { sent.push({ sessionId, text }); }, cancel: async () => {} }) }) },
  }, {
    window: new EventTarget(), now: () => time, setInterval: () => 1, clearInterval() {},
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, at: time + ms }); return id; }, clearTimeout: id => timers.delete(id),
    json: async (action, args, signal) => { calls.push({ action, args, signal }); if (action === 'config') return { config: structuredClone(config) }; if (action === 'call.start') return { call: { callId: 'lease' }, conversation: { mode } }; if (action === 'listening.decide') throw Error('Unexpected decision request'); if (action === 'configure') { config = { ...config, ...args.config, listening: { ...config.listening, ...args.config.listening } }; return { config: structuredClone(config) }; } return {}; },
    createCapture: callbacks => { captures.push(callbacks); return { start: async () => {}, dispose: async () => {}, setMuted() {}, setPlaybackActive() {} }; },
    createPlayer: () => ({ start: async () => {}, dispose: async () => {} }),
    createQueue: () => ({ items: [], sequence: 0, push() { this.sequence++; return true; }, cancel() {}, dispose: async () => {} }),
    createChunker: () => ({ push: text => [text], finish: () => [] }),
    createConversation: () => ({ start: async () => {}, dispose: async () => {}, interrupt: async () => {}, send: async text => { sent.push({ sessionId: 'original', text }); return { accepted: true }; } }),
  });
  return { api, sent,
    setConfig: patch => { config = { ...config, ...patch, listening: { ...config.listening, ...patch.listening } }; },
    async advance(ms) { time += ms; for (const [id, row] of [...timers].sort((a, b) => a[1].at - b[1].at)) if (row.at <= time) { timers.delete(id); row.fn(); } await tick(); await tick(); },
    utterance(id, text) { const c = captures[0]; c.onSpeechStart(id); c.onPartial(text, { utteranceId: id }); c.onSpeechEnd(id,{speechEndedAt:time}); c.onFinal(text, { utteranceId: id,speechEndedAt:time }); },
    decisions: () => calls.filter(row => row.action === 'listening.decide'),
  };
}

test('all call routes submit first and later turns directly even with decisions configured', async () => {
  for (const mode of ['direct','native','enhanced']) {
    const h=harness({mode}); await h.api.startCall({sessionId:'original'});
    assert.equal(h.api.setCallInputMode,undefined); assert.equal(Object.hasOwn(h.api.state.getSnapshot(),'callInputMode'),false);
    h.utterance(1,'你好'); await h.advance(450); h.utterance(2,'接着说'); await h.advance(450);
    assert.deepEqual(h.sent.map(row=>row.text),['你好','接着说']); assert.equal(h.decisions().length,0);
    await h.api.dispose();
  }
});

test('direct conversation keeps continuation and original session without a decision request',async()=>{
  for(const mode of ['direct','native','enhanced']){
    const h=harness({mode});await h.api.startCall({sessionId:'original'});
    h.utterance(1,'查一下热点。');await h.advance(200);h.utterance(2,'不要用那个插件。');h.api.selectSession('other');
    await h.advance(449);assert.deepEqual(h.sent,[]);await h.advance(1);
    assert.deepEqual(h.sent,[{sessionId:'original',text:'查一下热点。\n不要用那个插件。'}]);assert.equal(h.decisions().length,0);
    if(mode==='enhanced')assert.equal(h.api.state.getSnapshot().conversationMessages[0].transcriptIds.length,2);
    await h.api.dispose();
  }
});

test('decision availability and configuration changes do not interrupt normal calls',async()=>{
  const h=harness();await h.api.startCall({sessionId:'original'});
  await h.api.configure({listening:{endpoint:'https://other.example/v1/systemone',apiKey:'new-key'}});
  assert.equal(h.api.state.getSnapshot().mode,'call');
  h.setConfig({listening:{configured:false,wakeAvailable:false,wakeWordResolved:''}});await h.api.load();
  assert.equal(h.api.state.getSnapshot().mode,'call');h.utterance(1,'正常对话');await h.advance(450);
  assert.deepEqual(h.sent.map(row=>row.text),['正常对话']);assert.equal(h.decisions().length,0);await h.api.dispose();
});
