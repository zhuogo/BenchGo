import test from 'node:test';
import assert from 'node:assert/strict';
import {createVoiceController} from '../client/controller.mjs';
import { SpeakableChunker } from '../client/speech.mjs';
import { Context } from '@deepseek-ai/cordis';
globalThis.document||={baseURI:'https://voice.example/'};
const flush=()=>new Promise(resolve=>setTimeout(resolve,0));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
test('call rejects JSON ASR and buffered TTS before acquiring media or lease without rewriting configuration',async()=>{
  for(const blocked of ['asr','tts']){
    const config={dictation:true,readAloud:true,call:true,asr:{configured:true,protocol:blocked==='asr'?'transcriptions':'transcriptions-sse'},tts:{configured:true,protocol:'speech',stream:blocked!=='tts'}};
    const h=setup({json:async action=>action==='config'?{config}:{}});
    await assert.rejects(h.api.startCall({sessionId:'s'}),blocked==='asr'?/SSE/:/开启流式播放/);
    assert.equal(h.captures.length,0);assert.equal(h.players.length,0);assert.deepEqual(h.calls.map(x=>x.action),['config']);
    assert.deepEqual(h.api.state.getSnapshot().config,config);await h.api.dispose();
  }
});
test('failed final recognition preserves the visible partial in its own session without sending or retrying',async()=>{
  const h=setup();await h.api.startCall({sessionId:'s'});const c=h.captures[0].callbacks;
  c.onSpeechStart(1);c.onPartial('你好，请检查这段转录',{utteranceId:1});c.onError(Error('最终识别失败'));await flush();
  assert.equal(h.api.state.getSnapshot().mode,'idle');assert.equal(h.api.state.getSnapshot().error,'最终识别失败');
  assert.equal(h.api.state.getSnapshot().recoveryText,'你好，请检查这段转录');assert.equal(h.api.state.getSnapshot().recoverySessionId,'s');
  assert.deepEqual(h.texts(),[]);assert.equal(h.captures[0].disposed,true);
  h.api.selectSession('other');assert.equal(h.api.state.getSnapshot().recoveryText,'');h.api.selectSession('s');
  assert.equal(h.api.state.getSnapshot().recoveryText,'你好，请检查这段转录');
  const inserted=[];assert.equal(h.api.recoverToDraft({captureInsertion:()=>({start:0,end:0}),insertText:text=>{inserted.push(text);return true;},persistDraft(){}}),true);
  assert.deepEqual(inserted,['你好，请检查这段转录']);assert.deepEqual(h.texts(),[]);await h.api.dispose();
});
test('idle voice does not poll; pending speech alone arms and drains the flush timer',async()=>{
  const timers=new Map();let next=0;
  const h=setup({setInterval:(fn,ms)=>{const id=++next;timers.set(id,{fn,ms});return id;},clearInterval:id=>timers.delete(id),createChunker:()=>({raw:'',text:'',push(text){this.text+=text;return [];},flushIdle(){const text=this.text;this.text='';return text?[text]:[];},finish(){return this.flushIdle();}})});
  assert.equal(timers.size,0);await h.api.toggleRead('s');assert.equal(timers.size,0);
  h.publish('turn/start');h.publish('assistant/live-chunk',{attemptId:'a',chunk:{type:'text-delta',text:'pending sentence'}});
  assert.equal(timers.size,1);const timer=[...timers.values()][0];assert.equal(timer.ms,25);timer.fn();
  assert.deepEqual(h.queues[0].text,['pending sentence']);assert.equal(timers.size,0);
  h.publish('assistant/live-chunk',{attemptId:'a',chunk:{type:'text-delta',text:'remaining'}});assert.equal(timers.size,1);
  await h.api.hangup();assert.equal(timers.size,0);await h.api.dispose();
});
function setup(options={}){
  let status={running:false,pendingInteraction:false},revision=0,snapshot={revision:0,entries:[],change:{kind:'replace'}};const listeners=new Set(),calls=[],sent=[],captures=[],players=[],queues=[];let cancelCalls=0;
  const source={getSnapshot:()=>snapshot,subscribe:fn=>{listeners.add(fn);return ()=>listeners.delete(fn);}};
  const conversation={send:async(text,sessionId='s')=>{calls.push(text);sent.push({sessionId,text});await options.send?.(text,sessionId);},cancel:async()=>{cancelCalls++;await options.cancel?.();status.running=false;}};
  const cordisScope=options.cordisScope?new Context():null;if(cordisScope)cordisScope.provide('conversation',conversation);
  const statusListeners=new Set();
  const ctx={uiSession:{sessionStatus:{getSnapshot:()=>new Map([['s',status]]),subscribe:fn=>{statusListeners.add(fn);return ()=>statusListeners.delete(fn);}}},sessions:{binding:id=>({sessionId:id,eventSource:source}),scope:sessionId=>cordisScope||({get:name=>name==='conversation'?{send:text=>conversation.send(text,sessionId),cancel:conversation.cancel}:undefined})}};
  const deps={window:{addEventListener(){},removeEventListener(){}},setInterval:options.setInterval||globalThis.setInterval,clearInterval:options.clearInterval||globalThis.clearInterval,json:async(action,args,signal)=>{calls.push({action,args});if(options.json)return options.json(action,args,signal);if(action==='config')return {config:{dictation:true,readAloud:true,call:true,asr:{configured:true,protocol:'transcriptions-sse'},tts:{configured:true,protocol:'speech'}}};if(action==='call.start'){await options.callStart?.();return {call:{callId:'lease'},...(options.conversationMode?{conversation:{mode:options.conversationMode}}:{})};}if(action==='call.heartbeat')await options.heartbeat?.();return {};},
    createCapture:callbacks=>{const c={callbacks,start:async()=>{await options.captureStart?.();},stop:async()=>'',dispose:async()=>{c.disposed=true;await options.captureDispose?.();}};captures.push(c);return c;},
    createPlayer:callbacks=>{const p={callbacks,start:async()=>{await options.playerStart?.();},dispose:async()=>{p.disposed=true;},clear(){}};players.push(p);return p;},
    createQueue:()=>{const q={items:[],sequence:0,text:[],push:t=>{q.sequence++;q.text.push(t);return true;},cancel(){q.cancelled=true;},dispose:async()=>{q.disposed=true;}};queues.push(q);return q;},
    ...(options.createConversation?{createConversation:options.createConversation}:{}),createChunker:options.createChunker||(()=>({push:text=>[text],finish:()=>[]}))};
  const api=createVoiceController(ctx,deps);
  return {api,calls,sent,captures,players,queues,get status(){return status;},set status(s){status=s;for(const fn of statusListeners)fn();},get cancelCalls(){return cancelCalls;},texts:()=>calls.filter(x=>typeof x==='string'),publish(type,data={},envelope={}){const e={type:'event',event:{seq:++revision,type,data,...envelope}};snapshot={revision,entries:[...snapshot.entries,e],change:{kind:'append',entries:[e]}};for(const fn of listeners)fn();}};
}

test('native SuperAgent publication flushes a short reply once without reading tool arguments', async () => {
  const h = setup({ conversationMode: 'native', createChunker: () => new SpeakableChunker() });
  await h.api.startCall({ sessionId: 's' });
  const capture = h.captures[0].callbacks;
  capture.onSpeechStart(1); capture.onFinal('你好', { utteranceId: 1 }); await flush();
  assert.deepEqual(h.texts(), ['你好']);
  h.publish('turn/start', { turn: 1 });
  h.publish('assistant/live-chunk', { turn: 1, step: 1, attemptId: 'a', chunk: { type: 'tool-call-delta', text: '{"text":"你好"}' } });
  assert.equal(h.queues.length, 0);
  h.publish('plugin:benchgo-plugin/chat-publication', { kind: 'final', requestId: 'hello', text: '你好' }, { ignorable: true });
  assert.deepEqual(h.queues[0].text, []);
  h.publish('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: '你好' }] } }, { surfaceOp: 'append' });
  h.publish('turn/end', { turn: 1, reason: { kind: 'completed' } });
  assert.deepEqual(h.queues[0].text, ['你好']);
  assert.equal(h.api.state.getSnapshot().replyText, '你好');
  assert.equal(h.api.state.getSnapshot().error, '');
  await h.api.dispose();
});

test('native call exposes a blocked or failed turn instead of silently returning to listening', async () => {
  for (const kind of ['blocked', 'error', 'interrupted']) {
    const h = setup({ conversationMode: 'native' });
    await h.api.startCall({ sessionId: 's' });
    const capture = h.captures[0].callbacks;
    capture.onSpeechStart(1); capture.onFinal('你好', { utteranceId: 1 }); await flush();
    h.status = { running: true, pendingInteraction: false };
    h.publish('turn/start', { turn: 1 });
    if (kind === 'error') { h.publish('assistant/attempt', { turn: 1, step: 1 }); h.publish('llm/retry', { turn: 1, step: 1 }); }
    h.publish('turn/end', { turn: 1, reason: { kind, error: { message: 'private upstream response' } } });
    h.status = { running: false, pendingInteraction: false };
    const state = h.api.state.getSnapshot();
    assert.equal(state.mode, 'call');
    assert.equal(state.transcript, '你好');
    assert.match(state.error, /原会话/);
    assert.doesNotMatch(state.error, /private upstream response/);
    assert.deepEqual(h.texts(), ['你好']);
    assert.equal(h.queues.length, 0);
    capture.onSpeechStart(2); capture.onFinal('继续', { utteranceId: 2 }); await flush();
    assert.equal(h.api.state.getSnapshot().error, '');
    assert.deepEqual(h.texts(), ['你好', '继续']);
    await h.api.dispose();
  }
});

test('native user interruption does not report the cancelled turn as a failure', async () => {
  const h = setup({ conversationMode: 'native' });
  await h.api.startCall({ sessionId: 's' });
  h.publish('turn/start', { turn: 1 });
  h.captures[0].callbacks.onSpeechStart(1);
  h.publish('turn/end', { turn: 1, reason: { kind: 'blocked' } });
  assert.equal(h.api.state.getSnapshot().error, '');
  await h.api.dispose();
});

test('saved matched dictation starts without protocol detection and preserves the exact selected transport', async () => {
  const config = { dictation: true, asr: { configured: true, protocol: 'stepfun-sse', model: 'Step Name/@opaque' }, tts: {} };
  const h = setup({ json: async () => ({ config }) });
  await h.api.startDictation({ sessionId: 's', inputActions: { captureInsertion: () => ({ start: 0, end: 0 }), insertText: () => true, persistDraft() {} } });
  assert.deepEqual(h.calls.map(call => call.action), ['config']);
  assert.equal(h.captures[0].callbacks.parallel, true);
  assert.equal(h.api.state.getSnapshot().config.asr.protocol, 'stepfun-sse');
  await h.api.dispose();
});

test('call capture uses saved concrete protocols without discovery at startup', async () => {
  const config = { call: true, asr: { configured: true, protocol: 'transcriptions-sse' }, tts: { configured: true, protocol: 'speech', stream: true } };
  const h = setup({ json: async action => action === 'call.start' ? { call: { callId: 'lease' }, config } : { config } });
  await h.api.startCall({ sessionId: 's' });
  assert.equal(h.captures[0].callbacks.parallel, true);
  assert.equal(h.api.state.getSnapshot().config.asr.protocol, 'transcriptions-sse');
  assert.deepEqual(h.calls.map(call => call.action), ['config', 'call.start']);
  await h.api.dispose();
});

test('unset and legacy automatic protocols require matching before acquiring microphone or playback', async () => {
  for (const protocol of ['', 'auto']) for (const mode of ['dictation', 'call', 'readAloud']) {
    const config = { dictation: true, readAloud: true, call: true, asr: { configured: true, protocol }, tts: { configured: true, protocol, stream: true } };
    const h = setup({ json: async () => ({ config }) });
    await assert.rejects(mode === 'dictation' ? h.api.startDictation({ sessionId: 's', inputActions: {} }) : mode === 'call' ? h.api.startCall({ sessionId: 's' }) : h.api.toggleRead('s'), /自动匹配/);
    assert.equal(h.captures.length, 0); assert.equal(h.players.length, 0);
    assert.deepEqual(h.calls.map(call => call.action), ['config']);
    await h.api.dispose();
  }
});

test('protocol detection metadata refresh preserves a running capture and read-aloud', async () => {
  const config = { dictation: true, readAloud: true, call: true, asr: { configured: true, protocol: 'transcriptions-sse' }, tts: { configured: true, protocol: 'speech', stream: true } };
  let current = config;
  const h = setup({ json: async action => action === 'call.start' ? { call: { callId: 'lease' } } : { config: current } });
  await h.api.startCall({ sessionId: 's' });
  current = { ...config, asr: { ...config.asr, detection: { status: 'supported' }, resolvedProtocol: 'transcriptions-sse' }, tts: { ...config.tts, detection: { status: 'supported' }, resolvedProtocol: 'speech' } };
  await h.api.load(); assert.equal(h.api.state.getSnapshot().mode, 'call'); assert.equal(h.captures[0].disposed, undefined);
  await h.api.dispose();
});
test('older utterance final waits until current utterance final then merges once',async()=>{const h=setup();await h.api.startCall({sessionId:'s'});const c=h.captures[0].callbacks;c.onSpeechStart(1);c.onSpeechStart(2);c.onFinal('前半句',{utteranceId:1});await flush();assert.deepEqual(h.texts(),[]);c.onFinal('后半句',{utteranceId:2});await flush();assert.deepEqual(h.texts(),['前半句\n后半句']);await h.api.dispose();});
test('speech start invalidates earlier deliver while cancellation is pending',async()=>{const gate=deferred();const h=setup({cancel:()=>gate.promise});await h.api.startCall({sessionId:'s'});h.status={running:true,pendingInteraction:false};const c=h.captures[0].callbacks;c.onSpeechStart(1);c.onFinal('旧语段',{utteranceId:1});await flush();c.onSpeechStart(2);gate.resolve();await flush();assert.deepEqual(h.texts(),[]);c.onFinal('继续',{utteranceId:2});await flush();assert.deepEqual(h.texts(),['旧语段\n继续']);await h.api.dispose();});
test('pending interaction neither cancels nor sends, and hangup preserves approval',async()=>{const h=setup();await h.api.startCall({sessionId:'s'});h.status={running:true,pendingInteraction:true};const c=h.captures[0].callbacks;c.onSpeechStart(1);c.onFinal('需要确认',{utteranceId:1});await flush();assert.deepEqual(h.texts(),[]);assert.equal(h.cancelCalls,0);assert.equal(h.api.state.getSnapshot().phase,'waiting');await h.api.hangup();assert.equal(h.cancelCalls,0);await h.api.dispose();});
test('approval completion sends queued speech once after the approved turn becomes idle',async()=>{
 const h=setup();await h.api.startCall({sessionId:'s'});h.status={running:true,pendingInteraction:true};
 const c=h.captures[0].callbacks;c.onSpeechStart(1);c.onFinal('授权后继续',{utteranceId:1});await flush();
 h.status={running:true,pendingInteraction:false};await flush();assert.deepEqual(h.texts(),[]);assert.equal(h.cancelCalls,0);
 h.status={running:false,pendingInteraction:false};h.status={running:false,pendingInteraction:false};await flush();
 assert.deepEqual(h.texts(),['授权后继续']);assert.equal(h.api.state.getSnapshot().error,'');await h.api.dispose();
});
test('startup failure and hangup release media and remote lease once',async()=>{const h=setup({captureStart:async()=>{throw Error('no mic');}});await assert.rejects(h.api.startCall({sessionId:'s'}),/no mic/);assert.equal(h.captures[0].disposed,true);assert.equal(h.players[0].disposed,true);assert.equal(h.calls.filter(x=>x.action==='call.end').length,1);assert.equal(h.api.state.getSnapshot().mode,'idle');await h.api.dispose();});
test('call remains connecting until microphone capture is actually ready',async()=>{
  const gate=deferred(),h=setup({captureStart:()=>gate.promise});
  const start=h.api.startCall({sessionId:'s'});await flush();
  assert.equal(h.captures.length,1);assert.equal(h.api.state.getSnapshot().phase,'starting');
  h.status={running:false,pendingInteraction:false};assert.equal(h.api.state.getSnapshot().phase,'starting');
  gate.resolve();await start;assert.equal(h.api.state.getSnapshot().phase,'listening');
  await h.api.dispose();
});
test('hangup is reentrant and preserves running execution while releasing media in direct and native calls',async()=>{for(const conversationMode of ['direct','native']){const gate=deferred(),h=setup({conversationMode,captureDispose:()=>gate.promise});await h.api.startCall({sessionId:'s'});h.status={running:true,pendingInteraction:false};const a=h.api.hangup(),b=h.api.hangup();assert.equal(a,b);assert.equal(h.cancelCalls,0);gate.resolve();await a;assert.equal(h.calls.filter(x=>x.action==='call.end').length,1);assert.equal(h.players[0].disposed,true);assert.equal(h.status.running,true);await h.api.dispose();}});
test('concurrent start rejected, late acquired lease ended after hangup',async()=>{const gate=deferred(),h=setup({callStart:()=>gate.promise});const start=h.api.startCall({sessionId:'s'});await flush();await assert.rejects(h.api.startCall({sessionId:'s'}),/正在启动/);await h.api.hangup();gate.resolve();await start;assert.equal(h.captures.length,0);assert.equal(h.calls.filter(x=>x.action==='call.end').length,1);assert.equal(h.api.state.getSnapshot().mode,'idle');await h.api.dispose();});
test('automatic read keeps session binding and streams only fresh output after retry',async()=>{const h=setup();await h.api.toggleRead('s');assert.equal(h.api.state.getSnapshot().sessionId,'s');h.publish('turn/start');h.publish('assistant/live-chunk',{attemptId:'a',chunk:{type:'reasoning-delta',text:'hidden'}});h.publish('assistant/live-chunk',{attemptId:'a',chunk:{type:'text-delta',text:'首句'}});h.publish('llm/retry');h.publish('assistant/live-chunk',{attemptId:'b',chunk:{type:'text-delta',text:'重试'}});assert.deepEqual(h.queues[0].text,['首句','重试']);assert.equal(h.api.state.getSnapshot().readEnabled,true);await h.api.dispose();});
test('automatic read and call each play a successful streamed reply once',async()=>{
 for(const call of [false,true]){
  const h=setup();await h.api.toggleRead('s');if(call)await h.api.startCall({sessionId:'s'});
  h.publish('turn/start');h.publish('assistant/live-chunk',{attemptId:'a',turn:1,step:1,chunk:{type:'text-delta',text:'只读一次。'}});
  h.publish('assistant/message',{turn:1,step:1,message:{content:[{type:'text',text:'只读一次。'}]}});h.publish('step/end',{turn:1,step:1});h.publish('turn/end');
  assert.equal(h.queues.length,1);assert.deepEqual(h.queues[0].text,['只读一次。']);await h.api.dispose();
 }
});
test('voice sends only the recognized transcript verbatim',async()=>{
 const h=setup();await h.api.startCall({sessionId:'s'});const c=h.captures[0].callbacks;
 c.onSpeechStart(1);c.onPartial('暂时');c.onFinal('暂时没有。\n你可以帮我做什么呢？',{utteranceId:1});await flush();
 assert.deepEqual(h.texts(),['暂时没有。\n你可以帮我做什么呢？']);assert.equal(h.api.state.getSnapshot().transcript,h.texts()[0]);await h.api.dispose();
});
test('barge-in cancels playback and generation without appending playback status to user text',async()=>{
 const h=setup();await h.api.startCall({sessionId:'s'});h.publish('turn/start');
 h.publish('assistant/live-chunk',{attemptId:'a',chunk:{type:'text-delta',text:'完整听到'}});h.publish('assistant/live-chunk',{attemptId:'a',chunk:{type:'text-delta',text:'尚未确认'}});
 h.players[0].callbacks.onPlayed(1);h.status={running:true,pendingInteraction:false};const c=h.captures[0].callbacks;c.onSpeechStart(1);
 assert.equal(h.queues[0].cancelled,true);assert.ok(h.cancelCalls>0);h.players[0].callbacks.onPlayed(2);c.onFinal('插话',{utteranceId:1});await flush();
 assert.deepEqual(h.texts(),['插话']);await h.api.dispose();
});
test('failed voice send restores only transcript for the next voice retry',async()=>{
 let attempts=0;const h=setup({send:async()=>{if(++attempts===1)throw Error('发送失败');}});await h.api.startCall({sessionId:'s'});
 h.publish('turn/start');h.publish('assistant/live-chunk',{attemptId:'a',chunk:{type:'text-delta',text:'播放中'}});
 const c=h.captures[0].callbacks;c.onSpeechStart(1);c.onFinal('保留语段',{utteranceId:1});await flush();assert.equal(h.api.state.getSnapshot().error,'发送失败');
 c.onSpeechStart(2);c.onFinal('继续说',{utteranceId:2});await flush();assert.deepEqual(h.texts(),['保留语段','保留语段\n继续说']);
 c.onSpeechStart(3);c.onFinal('下一条',{utteranceId:3});await flush();assert.equal(h.texts()[2],'下一条');await h.api.dispose();
});
test('session switch discards pending transcript and ignores old playback and failed send callbacks',async()=>{
 const gate=deferred();let sends=0;const h=setup({send:()=>++sends===1?gate.promise:undefined});await h.api.startCall({sessionId:'s'});
 h.publish('turn/start');h.publish('assistant/live-chunk',{attemptId:'a',chunk:{type:'text-delta',text:'旧回复'}});h.players[0].callbacks.onPlayed(1);
 const old=h.captures[0].callbacks;old.onSpeechStart(1);old.onFinal('旧输入',{utteranceId:1});await flush();await h.api.hangup();
 await h.api.startCall({sessionId:'s2'});gate.reject(Error('旧会话发送失败'));await flush();old.onFinal('迟到转录',{utteranceId:2});h.players[0].callbacks.onPlayed(1);h.players[0].callbacks.onPlaybackStart();h.players[0].callbacks.onMetrics({level:0.9});assert.equal(h.api.state.getSnapshot().phase,'listening');assert.equal(h.api.state.getSnapshot().playbackLevel,0);
 const current=h.captures[1].callbacks;current.onSpeechStart(1);current.onFinal('新会话输入',{utteranceId:1});await flush();
 assert.deepEqual(h.sent,[{sessionId:'s',text:'旧输入'},{sessionId:'s2',text:'新会话输入'}]);assert.equal(h.api.state.getSnapshot().error,'');assert.equal(h.api.state.getSnapshot().sessionId,'s2');await h.api.dispose();
});
test('heartbeat failure hangs up while retaining actionable error',async()=>{let heartbeat,cleared=false;const h=setup({setInterval:fn=>{heartbeat=fn;return 7;},clearInterval:()=>{cleared=true;},heartbeat:async()=>{throw Error('连接已失效');}});await h.api.startCall({sessionId:'s'});heartbeat();await flush();assert.equal(h.api.state.getSnapshot().mode,'idle');assert.equal(h.api.state.getSnapshot().error,'连接已失效');assert.equal(cleared,true);assert.equal(h.captures[0].disposed,true);await h.api.dispose();});
test('already sent segment is not merged again while previous send promise remains pending',async()=>{const gate=deferred();let sends=0;const h=setup({send:()=>++sends===1?gate.promise:undefined});await h.api.startCall({sessionId:'s'});const c=h.captures[0].callbacks;c.onSpeechStart(1);c.onFinal('第一条',{utteranceId:1});await flush();c.onSpeechStart(2);c.onFinal('第二条',{utteranceId:2});await flush();assert.deepEqual(h.texts(),['第一条','第二条']);gate.resolve();await h.api.dispose();});
test('real un-injected Cordis session scope uses explicit get for send and cancel',async()=>{const h=setup({cordisScope:true});await h.api.startCall({sessionId:'s'});h.status={running:true,pendingInteraction:false};const c=h.captures[0].callbacks;c.onSpeechStart(1);c.onFinal('测试会话服务',{utteranceId:1});await flush();assert.ok(h.cancelCalls>0);assert.deepEqual(h.texts(),['测试会话服务']);await h.api.dispose();});
test('dictation revisions replace captured span and refuse overwriting manually edited draft',async()=>{
 const h=setup();let draft='前后',rev=1,selection={start:1,end:1},persisted=0;
 const actions={captureInsertion:()=>({...selection,draftRev:rev}),insertText(text,span){if(span.draftRev!==rev)return false;draft=draft.slice(0,span.start)+text+draft.slice(span.end);rev++;selection={start:span.start+text.length,end:span.start+text.length};return true;},persistDraft(){persisted++;}};
 await h.api.startDictation({sessionId:'s',inputActions:actions});const c=h.captures[0].callbacks;c.onPartial('错字');assert.equal(draft,'前错字后');c.onPartial('正确');assert.equal(draft,'前正确后');assert.equal(persisted,2);
 draft+='手写';rev++;c.onPartial('修订');assert.equal(draft,'前正确后手写');assert.match(h.api.state.getSnapshot().error,/草稿已被修改/);c.onFinal('最终');assert.equal(draft,'前正确后手写');await h.api.dispose();c.onPartial('迟到');assert.equal(draft,'前正确后手写');
});
test('newest final cannot overtake an older unfinished recognition',async()=>{
 const h=setup();await h.api.startCall({sessionId:'s'});const c=h.captures[0].callbacks;
 c.onSpeechStart(1);c.onSpeechEnd(1);c.onSpeechStart(2);c.onSpeechEnd(2);c.onFinal('后句',{utteranceId:2});await flush();assert.deepEqual(h.texts(),[]);
 c.onFinal('前句',{utteranceId:1});await flush();assert.deepEqual(h.texts(),['前句\n后句']);await h.api.dispose();
});
test('muting drops pending speech and leaves receiving playback available',async()=>{
 const h=setup();await h.api.startCall({sessionId:'s'});const c=h.captures[0].callbacks;c.onSpeechStart(1);h.api.setMuted(true);assert.equal(h.api.state.getSnapshot().muted,true);assert.equal(h.api.state.getSnapshot().level,0);assert.deepEqual(h.texts(),[]);h.api.toggleMute();assert.equal(h.api.state.getSnapshot().muted,false);c.onSpeechStart(2);c.onFinal('新输入',{utteranceId:2});await flush();assert.deepEqual(h.texts(),['新输入']);await h.api.dispose();
});
test('speaking phase follows real playback instead of queued synthesis',async()=>{
 const h=setup();await h.api.startCall({sessionId:'s'});h.publish('turn/start');h.publish('assistant/live-chunk',{attemptId:'a',chunk:{type:'text-delta',text:'一句话'}});assert.notEqual(h.api.state.getSnapshot().phase,'speaking');h.players[0].callbacks.onPlaybackStart({id:1});assert.equal(h.api.state.getSnapshot().phase,'speaking');h.players[0].callbacks.onPlaybackIdle();assert.equal(h.api.state.getSnapshot().phase,'listening');await h.api.dispose();
});

test('failed transcript survives mute, retries once, and discard prevents failed send resurrection',async()=>{
 const gate=deferred();let attempts=0;const h=setup({send:()=>++attempts===1?Promise.reject(Error('offline')):gate.promise});
 await h.api.startCall({sessionId:'s'});const c=h.captures[0].callbacks;c.onSpeechStart(1);c.onFinal('retain',{utteranceId:1});await flush();
 h.api.setMuted(true);assert.equal(h.api.state.getSnapshot().recoveryText,'retain');
 const retry=h.api.retryPending();await flush();await h.api.retryPending();assert.equal(attempts,2);
 h.api.discardRecovery();gate.reject(Error('offline again'));await assert.rejects(retry,/offline again/);
 assert.equal(h.api.state.getSnapshot().recoveryText,'');await h.api.dispose();
});

test('recovery remains isolated by session and must be handled before new recording',async()=>{
 const h=setup();await h.api.startCall({sessionId:'s'});h.status={running:true,pendingInteraction:true};
 const c=h.captures[0].callbacks;c.onSpeechStart(1);c.onFinal('unsent',{utteranceId:1});await flush();await h.api.hangup();
 h.api.selectSession('other');assert.equal(h.api.state.getSnapshot().recoveryText,'');h.api.selectSession('s');
 assert.equal(h.api.state.getSnapshot().recoveryText,'unsent');await assert.rejects(h.api.startCall({sessionId:'s'}),/恢复或丢弃/);
 assert.throws(()=>h.api.recoverToDraft({captureInsertion:()=>({}),insertText:()=>false}),/草稿已变化/);
 assert.equal(h.api.state.getSnapshot().recoveryText,'unsent');let draft='';
 assert.equal(h.api.recoverToDraft({captureInsertion:()=>({}),insertText:text=>{draft=text;return true;},persistDraft(){}}),true);
 assert.equal(draft,'unsent');assert.equal(h.api.state.getSnapshot().recoveryText,'');await h.api.dispose();
});

test('dictation conflict retains all English segments with sentence spacing',async()=>{
 const h=setup();const actions={captureInsertion:()=>({}),insertText:()=>false,persistDraft(){}};
 await h.api.startDictation({sessionId:'s',inputActions:actions});const c=h.captures[0].callbacks;
 c.onFinal('Hello.');c.onPartial('How are');c.onFinal('How are you?');await h.api.stopDictation();
 assert.equal(h.api.state.getSnapshot().recoveryText,'Hello. How are you?');assert.equal(h.api.state.getSnapshot().recoverySessionId,'s');await h.api.dispose();
});

test('player startup and remote lease acquisition run concurrently and failed audio releases lease',async()=>{
 const audio=deferred(),lease=deferred();let requested=false;
 const h=setup({playerStart:()=>audio.promise,callStart:()=>{requested=true;return lease.promise;}});
 const start=h.api.startCall({sessionId:'s'});await flush();assert.equal(requested,true);
 audio.reject(Error('audio unavailable'));lease.resolve();await assert.rejects(start,/audio unavailable/);
 assert.equal(h.calls.filter(x=>x.action==='call.end').length,1);assert.equal(h.players[0].disposed,true);await h.api.dispose();
});

test('configuration save wins against focus loads begun before and during save',async()=>{
 const before=deferred(),during=deferred(),save=deferred();let reads=0;
 const config={dictation:true,call:true,readAloud:true,asr:{configured:true,protocol:'transcriptions-sse'},tts:{configured:true,protocol:'speech',speed:1}};
 const h=setup({json:action=>action==='configure'?save.promise:++reads===1?Promise.resolve({config}):reads===2?before.promise:during.promise});
 await h.api.load();const a=h.api.load(),saving=h.api.configure({...config,tts:{...config.tts,speed:2}}),b=h.api.load();
 during.resolve({config});await b;save.resolve({config:{...config,tts:{...config.tts,speed:2}}});await saving;
 before.resolve({config});await a;assert.equal(h.api.state.getSnapshot().config.tts.speed,2);await h.api.dispose();
});

test('TTS changes preserve dictation and call capture while ASR changes end capture',async()=>{
 let config={dictation:true,call:true,readAloud:false,asr:{configured:true,protocol:'transcriptions-sse',model:'a'},tts:{configured:true,protocol:'speech',speed:1}};
 const h=setup({json:async(action,args)=>action==='config'?{config}:action==='configure'?{config:config=args.config}:action==='call.start'?{call:{callId:'lease'}}:{}});
 await h.api.startCall({sessionId:'s'});await h.api.load();assert.equal(h.api.state.getSnapshot().mode,'call');
 await h.api.configure({...config,tts:{...config.tts,speed:2}});assert.equal(h.api.state.getSnapshot().mode,'call');assert.equal(h.captures[0].disposed,undefined);
 await h.api.configure({...config,asr:{...config.asr,model:'b'}});assert.equal(h.api.state.getSnapshot().mode,'idle');assert.equal(h.captures[0].disposed,true);await h.api.dispose();
});


test('enhanced call uses one speaking channel and barge-in/hangup preserve the original execution',async()=>{
 let events,bridge;const messages=[];
 const h=setup({conversationMode:'enhanced',createConversation:options=>{events=options.onEvent;return bridge={start:async()=>{},send:async(text,id)=>{messages.push({text,id});return {accepted:true};},interrupt:async()=>{bridge.interrupted=true;},dispose:async()=>{bridge.closed=true;}};}});
 await h.api.startCall({sessionId:'s'});h.status={running:true,pendingInteraction:false};
 h.publish('turn/start');h.publish('assistant/live-chunk',{attemptId:'worker',chunk:{type:'text-delta',text:'执行原文不应直接朗读。'}});h.publish('turn/end');
 assert.equal(h.queues.length,0);
 const c=h.captures[0].callbacks;c.onSpeechStart(1);c.onFinal('你好',{utteranceId:1});await flush();
 assert.deepEqual(messages.map(x=>x.text),['你好']);assert.deepEqual(h.texts(),[]);assert.equal(h.cancelCalls,0);
 events({type:'start',messageId:'a'});events({type:'text',messageId:'a',text:'你好，有什么想聊的？'});events({type:'end',messageId:'a'});
 assert.deepEqual(h.queues[0].text,['你好，有什么想聊的？']);
 c.onSpeechStart(2);assert.equal(bridge.interrupted,true);assert.equal(h.cancelCalls,0);
 await h.api.hangup();assert.equal(bridge.closed,true);assert.equal(h.cancelCalls,0);await h.api.dispose();
});

test('enhanced unknown delivery retries the same request and does not merge new speech into it',async()=>{
 let attempts=0;const requests=[];
 const h=setup({conversationMode:'enhanced',createConversation:()=>({start:async()=>{},interrupt:async()=>{},dispose:async()=>{},send:async(text,id)=>{requests.push({text,id});if(++attempts===1)throw Error('unknown delivery');return {accepted:true};}})});
 await h.api.startCall({sessionId:'s'});const c=h.captures[0].callbacks;
 c.onSpeechStart(1);c.onFinal('帮我查热点',{utteranceId:1});await flush();
 c.onSpeechStart(2);c.onFinal('还有天气',{utteranceId:2});await flush();assert.equal(requests.length,1);
 await h.api.retryPending();assert.equal(requests.length,2);assert.deepEqual(requests[0],requests[1]);assert.equal(h.api.state.getSnapshot().recoveryText,'还有天气');
 await h.api.retryPending();assert.equal(requests.at(-1).text,'还有天气');assert.notEqual(requests.at(-1).id,requests[0].id);await h.api.dispose();
});

test('enhanced speed update keeps capture and original execution; changing interaction route ends the call',async()=>{
 let events,disposals=0;
 const config={dictation:true,call:true,readAloud:true,asr:{configured:true,protocol:'transcriptions-sse'},tts:{configured:true,protocol:'speech',speed:1.2},conversation:{providerId:'p',model:'fast'}};
 const h=setup({json:async action=>action==='config'?{config}:action==='call.start'?{call:{callId:'lease'},conversation:{mode:'enhanced'}}:{},createConversation:options=>{events=options.onEvent;return {start:async()=>{},interrupt:async()=>{},dispose:async()=>{disposals++;},send:async()=>({accepted:true})};}});
 await h.api.startCall({sessionId:'s'});events({type:'start',messageId:'speed-reply'});events({type:'text',messageId:'speed-reply',text:'我来调整。'});events({type:'config',config:{...config,tts:{...config.tts,speed:1.5}}});await flush();
 assert.equal(h.api.state.getSnapshot().config.tts.speed,1.5);assert.equal(h.api.state.getSnapshot().mode,'call');assert.equal(h.captures[0].disposed,undefined);assert.equal(h.cancelCalls,0);
 events({type:'text',messageId:'speed-reply',text:'调到一点五倍了。'});events({type:'end',messageId:'speed-reply'});
 assert.deepEqual(h.queues[0].text,['我来调整。','调到一点五倍了。']);assert.notEqual(h.queues[0].cancelled,true);
 events({type:'config',config:{...config,conversation:{providerId:'p',model:'other'}}});await flush();assert.equal(h.api.state.getSnapshot().mode,'idle');assert.equal(disposals,1);assert.equal(h.cancelCalls,0);await h.api.dispose();
});

test('leaving and returning during hangup does not restore stale read-aloud; disposal cannot reopen audio',async()=>{
 for(const dispose of [false,true]){
  const gate=deferred(),h=setup({captureDispose:()=>gate.promise});
  await h.api.toggleRead('s');await h.api.startCall({sessionId:'s'});
  const ending=h.api.hangup();
  const cleanup=dispose?h.api.dispose():null;
  if(!dispose){h.api.selectSession('other');h.api.selectSession('s');}
  gate.resolve();await ending;await cleanup;
  assert.equal(h.players.length,1);assert.equal(h.api.state.getSnapshot().readEnabled,false);
  if(!dispose)await h.api.dispose();
 }
});

test('native and direct speech records follow official user and assistant source identities',async()=>{
 for(const conversationMode of ['direct','native']){
  const h=setup({conversationMode});await h.api.startCall({sessionId:'s'});
  const c=h.captures[0].callbacks;c.onSpeechStart(1);c.onFinal('看一下首页',{utteranceId:1});await flush();
  assert.equal(h.api.state.getSnapshot().conversationMessages.length,0);
  h.publish('user/message',{id:'official-user',source:{kind:'user'},content:[{type:'text',text:'看一下首页'}]});
  h.publish('turn/start');
  h.publish('assistant/live-chunk',{attemptId:'a',turn:1,step:1,chunk:{type:'text-delta',text:'正在查看'}});
  h.publish('assistant/message',{turn:1,step:1,message:{id:'official-assistant',content:[{type:'text',text:'正在查看首页。'}]}});
  h.publish('turn/end');
  const rows=h.api.state.getSnapshot().conversationMessages;
  assert.equal(rows.length,2);assert.equal(rows[0].sourceId,'user:official-user');
  assert.equal(rows[1].sourceId,'assistant:1:1');assert.equal(rows[1].partial,false);assert.equal(rows[1].text,'正在查看首页。');
  await h.api.dispose();
 }
});

test('enhanced ASR partial and settled user row share an identity across retries',async()=>{
 let attempts=0;const h=setup({conversationMode:'enhanced',createConversation:()=>({start:async()=>{},interrupt:async()=>{},dispose:async()=>{},send:async()=>{if(++attempts===1)throw Error('unknown delivery');return {accepted:true};}})});
 await h.api.startCall({sessionId:'s'});const c=h.captures[0].callbacks;
 c.onSpeechStart(1);const transcriptId=h.api.state.getSnapshot().transcriptId;
 c.onPartial('你好',{utteranceId:1});assert.equal(h.api.state.getSnapshot().transcriptId,transcriptId);
 c.onFinal('你好，帮我看看',{utteranceId:1});await flush();
 assert.deepEqual(h.api.state.getSnapshot().conversationMessages[0].transcriptIds,[transcriptId]);
 await h.api.retryPending();assert.equal(h.api.state.getSnapshot().conversationMessages.length,1);
 assert.deepEqual(h.api.state.getSnapshot().conversationMessages[0].transcriptIds,[transcriptId]);
 await h.api.dispose();
});

test('native successful delivery clears temporary subtitle identity and a new utterance never inherits the old text',async()=>{
 const h=setup({conversationMode:'native'});await h.api.startCall({sessionId:'s'});const c=h.captures[0].callbacks;
 c.onSpeechStart(1);c.onPartial('第一句',{utteranceId:1});c.onFinal('第一句',{utteranceId:1});await flush();
 assert.equal(h.api.state.getSnapshot().transcriptId,null);
 c.onSpeechStart(2);assert.equal(h.api.state.getSnapshot().transcript,'');assert.ok(h.api.state.getSnapshot().transcriptId);
 c.onPartial('第二句',{utteranceId:2});assert.equal(h.api.state.getSnapshot().transcript,'第二句');await h.api.dispose();
});
