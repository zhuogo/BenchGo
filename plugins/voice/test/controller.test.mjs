import test from 'node:test';
import assert from 'node:assert/strict';
import {createVoiceController} from '../client/controller.mjs';
import { SpeakableChunker, SpeechQueue } from '../client/speech.mjs';
import { Capture } from '../client/media.mjs';
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
test('a tiny opening coalesces only same-task text and cancellation invalidates its microtask',async()=>{
  const timers=new Map();let next=0;
  const h=setup({setInterval:(fn,ms)=>{const id=++next;timers.set(id,{fn,ms});return id;},clearInterval:id=>timers.delete(id),createChunker:()=>new SpeakableChunker({now:()=>0})});
  try{
    await h.api.toggleRead('s');h.publish('turn/start');
    h.publish('assistant/live-chunk',{attemptId:'a',chunk:{type:'text-delta',text:'好的。'}});
    assert.equal(timers.size,0);
    assert.deepEqual(h.queues[0].text,[]);
    h.publish('assistant/live-chunk',{attemptId:'a',chunk:{type:'text-delta',text:'接下来检查语音设置。'}});
    assert.deepEqual(h.queues[0].text,['好的。接下来检查语音设置。']);assert.equal(timers.size,0);
    h.publish('turn/start');h.publish('assistant/live-chunk',{attemptId:'b',chunk:{type:'text-delta',text:'你好。'}});
    assert.equal(timers.size,0);
    await h.api.hangup();assert.equal(timers.size,0);
    assert.deepEqual(h.queues[0].text,['好的。接下来检查语音设置。']);
  }finally{await h.api.dispose();}
});
function setup(options={}){
  let status={running:false,pendingInteraction:false},revision=0,snapshot={revision:0,entries:[],change:{kind:'replace'}};const listeners=new Set(),calls=[],sent=[],captures=[],players=[],queues=[],references=[],closedViews=new Set();let cancelCalls=0;
  const source={getSnapshot:()=>snapshot,subscribe:fn=>{listeners.add(fn);return ()=>listeners.delete(fn);}};
  const conversation={send:async(text,sessionId='s')=>{calls.push(text);sent.push({sessionId,text});await options.send?.(text,sessionId);},cancel:async()=>{cancelCalls++;await options.cancel?.();status.running=false;}};
  const cordisScope=options.cordisScope?new Context():null;if(cordisScope)cordisScope.provide('conversation',conversation);
  const statusListeners=new Set();
  const ctx={uiSession:{sessionStatus:{getSnapshot:()=>new Map([['s',status]]),subscribe:fn=>{statusListeners.add(fn);return ()=>statusListeners.delete(fn);}}},sessions:{binding:id=>({sessionId:id,eventSource:source}),scope:sessionId=>closedViews.has(sessionId)&&!references.some(row=>row.sessionId===sessionId&&!row.released)?undefined:cordisScope||({get:name=>name==='conversation'?{send:text=>conversation.send(text,sessionId),cancel:conversation.cancel}:undefined}),retain(sessionId,request){if(options.retainError)throw options.retainError;const reference={sessionId,binding:this.binding(sessionId),release(){this.released=true;this.releases=(this.releases||0)+1;}};references.push(reference);reference.ready=options.retainReady?.(reference,request)||Promise.resolve(reference.binding);return reference;}}};
  const deps={window:options.window||{addEventListener(){},removeEventListener(){}},...(options.fetch?{fetch:options.fetch}:{}),setInterval:options.setInterval||globalThis.setInterval,clearInterval:options.clearInterval||globalThis.clearInterval,json:async(action,args,signal)=>{calls.push({action,args});if(options.json)return options.json(action,args,signal);if(action==='config')return {config:{dictation:true,readAloud:true,call:true,asr:{configured:true,protocol:'transcriptions-sse'},tts:{configured:true,protocol:'speech'}}};if(action==='call.start'){await options.callStart?.();return {call:{callId:'lease'},...(options.conversationMode?{conversation:{mode:options.conversationMode}}:{})};}if(action==='call.heartbeat')await options.heartbeat?.();return {};},
    createCapture:callbacks=>{const final=callbacks.onFinal;if(options.now)callbacks.onFinal=(text,meta={})=>final(text,{speechEndedAt:options.now(),...meta});const c=options.createCapture?.(callbacks)||{callbacks,start:async()=>{await options.captureStart?.();},stop:async()=>'',dispose:async()=>{c.disposed=true;await options.captureDispose?.();}};captures.push(c);return c;},
    createPlayer:callbacks=>{const p={callbacks,start:async()=>{await options.playerStart?.();},dispose:async()=>{p.disposed=true;},resetSupply(){p.supplyResets=(p.supplyResets||0)+1;},clear(){}};players.push(p);return p;},
    createQueue:callbacks=>{const q={callbacks,items:[],sequence:0,text:[],push:t=>{q.sequence++;q.text.push(t);return true;},cancel(){q.cancelled=true;},dispose:async()=>{q.disposed=true;}};queues.push(q);return q;},
    ...(options.createConversation?{createConversation:options.createConversation}:{}),createChunker:options.createChunker||(()=>({push:text=>[text],finish:()=>[]}))};
  // Most existing cases exercise delivery, not elapsed silence. Dedicated
  // continuation cases below inject the last voiced timestamp and a clock.
  deps.now=options.now;
  if(options.createQueue)deps.createQueue=options.createQueue;
  deps.setTimeout=options.setTimeout||(fn=>setTimeout(fn,0));deps.clearTimeout=options.clearTimeout||clearTimeout;
  const api=createVoiceController(ctx,deps);
  return {api,calls,sent,captures,players,queues,references,closeView:sessionId=>closedViews.add(sessionId),get status(){return status;},set status(s){status=s;for(const fn of statusListeners)fn();},get cancelCalls(){return cancelCalls;},texts:()=>calls.filter(x=>typeof x==='string'),rebaseline(){snapshot={revision:++revision,entries:snapshot.entries,change:{kind:'replace'}};for(const fn of listeners)fn();},publish(type,data={},envelope={}){const e={type:'event',event:{seq:++revision,type,data,...envelope}};snapshot={revision,entries:[...snapshot.entries,e],change:{kind:'append',entries:[e]}};for(const fn of listeners)fn();}};
}

function protectedCall(options={}){
  let now=1000,events;
  const h=setup({...options,now:()=>now,createCapture:callbacks=>Object.assign(new Capture(callbacks),{callbacks,start:async()=>{}}),
    createConversation:callbacks=>{events=callbacks.onEvent;return {start:async()=>{},interrupt:async()=>{},dispose:async()=>{}};}});
  return {...h,startReply(){
    if(options.conversationMode==='enhanced')events({type:'start',messageId:'reply'});
    else {h.publish('turn/start',{turn:1});h.publish('user/message',{id:'request',source:{kind:'user'},content:[{type:'text',text:'你好'}]});}
  },reply(){
    if(options.conversationMode==='enhanced')events({type:'text',messageId:'reply',text:'这是一段正在生成的回复。'});
    else h.publish('assistant/live-chunk',{turn:1,step:1,attemptId:'a',chunk:{type:'text-delta',text:'这是一段正在生成的回复。'}});
  },endReply(){
    if(options.conversationMode==='enhanced')events({type:'end',messageId:'reply'});
    else h.publish('turn/end',{turn:1,reason:{kind:'completed'}});
  },advance(ms){now+=ms;},audio(sample,probability,count){for(let i=0;i<count;i++){now+=20;h.captures[0].accept(new Int16Array(480).fill(sample),probability);}}};
}

test('call protects generation and synthesis gaps, then restores soft idle speech in every mode',async()=>{
  for(const conversationMode of ['direct','native','enhanced']){
    const h=protectedCall({conversationMode});await h.api.startCall({sessionId:'s'});
    try{
      const c=h.captures[0];h.startReply();
      h.audio(100,.6,5);assert.equal(c.segment,null,conversationMode+' generation must use the protected gate');
      h.reply();h.players[0].callbacks.onPlaybackStart();h.players[0].callbacks.onPlaybackIdle();h.advance(1000);
      h.audio(100,.6,5);assert.equal(c.segment,null,conversationMode+' playback idle must not disable reply protection');
      h.audio(1000,.99,15);assert.equal(c.segment,null,'a brief confident transient must not interrupt');
      h.audio(0,0,1);
      h.players[0].callbacks.onPlayed(1);h.advance(1000);
      h.audio(100,.6,5);assert.equal(c.segment,null,'generation between sentences remains protected after the prior segment is played');
      h.reply();h.endReply();h.players[0].callbacks.onPlaybackIdle();h.advance(1000);
      h.audio(100,.6,5);assert.equal(c.segment,null,'completed generation with queued synthesis remains protected');
      h.players[0].callbacks.onPlayed(2);h.advance(1000);
      h.audio(100,.6,5);assert.ok(c.segment,'ordinary soft speech must start at 100 ms once the reply is fully played');
      assert.equal(h.queues[0].cancelled,true);
    }finally{await h.api.dispose();}
  }
});

test('continuous user speech still interrupts a reply during a long synthesis gap without clipping onset',async()=>{
  for(const conversationMode of ['direct','native','enhanced']){
    const h=protectedCall({conversationMode});await h.api.startCall({sessionId:'s'});
    try{
      h.startReply();h.reply();h.players[0].callbacks.onPlaybackStart();h.players[0].callbacks.onPlaybackIdle();h.advance(1000);
      h.audio(1000,.9,15);assert.equal(h.captures[0].segment,null);assert.notEqual(h.queues[0].cancelled,true);
      h.audio(1000,.9,1);const segment=h.captures[0].segment;assert.ok(segment);assert.equal(h.queues[0].cancelled,true);
      assert.equal(segment.audio.filter(frame=>frame[0]===1000).reduce((count,frame)=>count+frame.length,0),16*480);
    }finally{await h.api.dispose();}
  }
});

function continuationClock(){
  let now=0,next=0;const timers=new Map();
  return {
    timers,now:()=>now,setTimeout(fn,ms){const id=++next;timers.set(id,{fn,at:now+ms});return id;},clearTimeout(id){timers.delete(id);},
    async advance(ms){now+=ms;for(const [id,timer]of [...timers].sort((a,b)=>a[1].at-b[1].at)){if(timer.at>now)continue;timers.delete(id);timer.fn();}await flush();}
  };
}

test('turn submission spends VAD and ASR time inside the silence budget in every call mode',async()=>{
  for(const conversationMode of ['direct','native','enhanced'])for(const asrMs of [80,700]){
    const clock=continuationClock(),requests=[];
    const h=setup({...clock,conversationMode,createConversation:()=>({start:async()=>{},interrupt:async()=>{},dispose:async()=>{},send:async text=>{requests.push(text);return {accepted:true};}})});
    await h.api.startCall({sessionId:'s'});const c=h.captures[0].callbacks;
    c.onSpeechStart(1);await clock.advance(320);c.onSpeechEnd(1,{speechEndedAt:0,endpointAt:320});
    await clock.advance(asrMs);c.onFinal('检查设置',{utteranceId:1,speechEndedAt:0,endpointAt:320,finalizedAt:clock.now()});
    const remaining=Math.max(0,450-clock.now());assert.equal([...clock.timers.values()][0].at,clock.now()+remaining);
    if(remaining){await clock.advance(remaining-1);assert.deepEqual(h.texts(),[]);assert.deepEqual(requests,[]);}
    await clock.advance(remaining?1:0);
    assert.deepEqual(conversationMode==='enhanced'?requests:h.texts(),['检查设置']);
    const metrics=h.api.state.getSnapshot().metrics.current;
    assert.equal(metrics.endpoint_ms,320);assert.equal(metrics.transcript_ms,320+asrMs);assert.equal(metrics.submit_ms,Math.max(450,320+asrMs));
    await h.api.dispose();
  }
});

test('missing capture timing uses a cancellable zero-delay dispatch without inventing latency',async()=>{
  const clock=continuationClock(),h=setup({...clock});await h.api.startCall({sessionId:'s'});const c=h.captures[0].callbacks;
  c.onSpeechStart(1);c.onFinal('立即处理',{utteranceId:1,speechEndedAt:undefined});
  assert.equal([...clock.timers.values()][0].at,clock.now());await clock.advance(0);
  assert.deepEqual(h.texts(),['立即处理']);assert.equal(h.api.state.getSnapshot().metrics.current.transcript_ms,null);
  assert.equal(h.api.state.getSnapshot().metrics.current.submit_ms,null);await h.api.dispose();
});

test('call metrics connect recognition, synthesis and rendered playback and isolate interrupted segments',async()=>{
  const clock=continuationClock(),h=setup({...clock});await h.api.startCall({sessionId:'s'});const c=h.captures[0].callbacks;
  c.onSpeechStart(1);await clock.advance(320);c.onSpeechEnd(1,{speechEndedAt:0,endpointAt:320});
  await clock.advance(80);c.onFinal('检查设置',{utteranceId:1,speechEndedAt:0,endpointAt:320});await clock.advance(50);
  await clock.advance(50);h.publish('turn/start');h.publish('assistant/live-chunk',{attemptId:'a',chunk:{type:'text-delta',text:'正在检查。'}});
  const q=h.queues[0],p=h.players[0];await clock.advance(200);
  q.callbacks.onMetrics({type:'tts.first_audio',id:1,at:clock.now(),first_byte_ms:180});
  // An unrelated announcement may already be playing on the common queue.
  p.callbacks.onPlaybackStart({id:999});assert.equal(h.api.state.getSnapshot().metrics.current.first_playback_ms,null);
  await clock.advance(80);p.callbacks.onMetrics({type:'playback',event:'segment_started',id:1,buffer_ms:80,first_buffer_ms:80,underruns:0,gap_ms:0,bufferedSeconds:.08});
  p.callbacks.onMetrics({type:'playback',id:1,buffer_ms:120,first_buffer_ms:80,underruns:1,gap_ms:45,bufferedSeconds:.12});
  const metric=h.api.state.getSnapshot().metrics.current;
  assert.equal(metric.first_token_ms,500);assert.equal(metric.first_audio_ms,700);assert.equal(metric.first_playback_ms,330);assert.equal(metric.speech_to_playback_ms,780);
  assert.deepEqual(metric.tts_first_byte_ms,[{segment_id:1,first_byte_ms:180}]);assert.equal(metric.playback.underruns,1);assert.equal(metric.playback.gap_ms,45);
  c.onSpeechStart(2);q.callbacks.onMetrics({type:'tts.first_audio',id:1,at:9999,first_byte_ms:9999});
  const next=h.api.state.getSnapshot().metrics;assert.equal(next.current.turn_id,2);assert.equal(next.current.first_audio_ms,null);
  assert.equal(next.history[0].interrupted,true);assert.equal(next.history[0].first_audio_ms,700);
  assert.doesNotMatch(JSON.stringify(next),/检查|正在/);await h.api.dispose();
});

test('call sentences share one live draft and one delivery after a remaining 450 ms silence budget',async()=>{
  for(const conversationMode of ['direct','native','enhanced']){
    const clock=continuationClock(),requests=[];
    const h=setup({...clock,conversationMode,createConversation:()=>({start:async()=>{},interrupt:async()=>{},dispose:async()=>{},send:async(text,id)=>{requests.push({text,id});return {accepted:true};}})});
    await h.api.startCall({sessionId:'s'});const c=h.captures[0].callbacks;
    c.onSpeechStart(1);const identity=h.api.state.getSnapshot().transcriptId;
    c.onPartial('先检查',{utteranceId:1});c.onSpeechEnd(1);c.onFinal('先检查首页。',{utteranceId:1});
    assert.equal(h.api.state.getSnapshot().turnPending,true);assert.equal(h.api.state.getSnapshot().phase,'listening');
    assert.equal(clock.timers.size,1);const cancelled=[...clock.timers.values()][0].fn;
    await clock.advance(449);assert.deepEqual(h.texts(),[]);assert.deepEqual(requests,[]);
    c.onSpeechStart(2);c.onPartial('再看看',{utteranceId:2});
    assert.equal(clock.timers.size,0);assert.equal(h.api.state.getSnapshot().transcriptId,identity);
    assert.equal(h.api.state.getSnapshot().transcript,'先检查首页。\n再看看');
    c.onSpeechEnd(2);c.onFinal('再看看设置。',{utteranceId:2});cancelled();
    h.status={running:false,pendingInteraction:false};assert.equal(h.api.state.getSnapshot().phase,'listening');
    await clock.advance(449);assert.deepEqual(h.texts(),[]);assert.deepEqual(requests,[]);
    await clock.advance(1);
    assert.deepEqual(conversationMode==='enhanced'?requests.map(row=>row.text):h.texts(),['先检查首页。\n再看看设置。']);
    assert.equal(h.api.state.getSnapshot().turnPending,false);assert.equal(clock.timers.size,0);
    if(conversationMode==='enhanced')assert.equal(h.api.state.getSnapshot().conversationMessages[0].transcriptIds[0],identity);
    await h.api.dispose();
  }
});

test('late earlier finals preserve the current partial and do not start the continuation clock early',async()=>{
  const clock=continuationClock(),h=setup({...clock});await h.api.startCall({sessionId:'s'});const c=h.captures[0].callbacks;
  c.onSpeechStart(1);const identity=h.api.state.getSnapshot().transcriptId;c.onPartial('前半',{utteranceId:1});c.onSpeechEnd(1);
  c.onSpeechStart(2);c.onPartial('后半',{utteranceId:2});c.onFinal('前半句。',{utteranceId:1});
  assert.equal(h.api.state.getSnapshot().transcript,'前半句。\n后半');assert.equal(h.api.state.getSnapshot().transcriptId,identity);assert.equal(clock.timers.size,0);
  assert.equal(h.api.state.getSnapshot().phase,'listening');c.onSpeechEnd(2);assert.equal(h.api.state.getSnapshot().phase,'transcribing');
  await clock.advance(3000);assert.deepEqual(h.texts(),[]);
  c.onFinal('后半句。',{utteranceId:2});await clock.advance(450);assert.deepEqual(h.texts(),['前半句。\n后半句。']);await h.api.dispose();
});

test('muting and lifecycle exits cancel continuation without late delivery and retain final text',async()=>{
  for(const ending of ['mute','hangup','offline','dispose']){
    const clock=continuationClock(),environment=new EventTarget(),h=setup({...clock,window:environment});await h.api.startCall({sessionId:'s'});const c=h.captures[0].callbacks;
    c.onSpeechStart(1);c.onFinal('尚未发送',{utteranceId:1});const stale=[...clock.timers.values()][0].fn;
    if(ending==='mute')h.api.setMuted(true);else if(ending==='offline')environment.dispatchEvent(new Event('offline'));else await h.api[ending]();
    assert.equal(clock.timers.size,0);stale();c.onFinal('迟到旧输入',{utteranceId:1});await clock.advance(1000);
    assert.deepEqual(h.texts(),[]);assert.equal(h.api.state.getSnapshot().recoveryText,'尚未发送');
    if(ending==='mute'){
      h.api.setMuted(false);c.onFinal('解除静音后的迟到旧输入',{utteranceId:1});await clock.advance(1000);assert.deepEqual(h.texts(),[]);
      c.onSpeechStart(2);c.onFinal('再接一句',{utteranceId:2});await clock.advance(450);assert.deepEqual(h.texts(),['尚未发送\n再接一句']);
    }
    await h.api.dispose();
  }
});

test('approval completion cannot bypass a newer continuation window',async()=>{
  const clock=continuationClock(),h=setup({...clock});await h.api.startCall({sessionId:'s'});const c=h.captures[0].callbacks;
  h.status={running:true,pendingInteraction:true};c.onSpeechStart(1);c.onFinal('先检查',{utteranceId:1});await clock.advance(450);
  assert.equal(h.api.state.getSnapshot().phase,'waiting');assert.deepEqual(h.texts(),[]);
  c.onSpeechStart(2);c.onFinal('还有这里',{utteranceId:2});h.status={running:false,pendingInteraction:false};await flush();
  assert.equal(h.api.state.getSnapshot().phase,'listening');assert.deepEqual(h.texts(),[]);
  await clock.advance(449);assert.deepEqual(h.texts(),[]);await clock.advance(1);assert.deepEqual(h.texts(),['先检查\n还有这里']);await h.api.dispose();
});

test('enhanced dispatch starts a new draft immediately even before its acceptance arrives',async()=>{
  const clock=continuationClock(),gate=deferred(),requests=[];
  const h=setup({...clock,conversationMode:'enhanced',createConversation:()=>({start:async()=>{},interrupt:async()=>{},dispose:async()=>{},send:async(text,id)=>{requests.push({text,id});return requests.length===1?gate.promise:{accepted:true};}})});
  await h.api.startCall({sessionId:'s'});const c=h.captures[0].callbacks;c.onSpeechStart(1);const first=h.api.state.getSnapshot().transcriptId;
  c.onFinal('已发出的任务',{utteranceId:1});await clock.advance(450);assert.equal(requests.length,1);
  c.onSpeechStart(2);c.onPartial('后续补充',{utteranceId:2});assert.notEqual(h.api.state.getSnapshot().transcriptId,first);assert.equal(h.api.state.getSnapshot().transcript,'后续补充');
  c.onFinal('后续补充',{utteranceId:2});gate.resolve({accepted:true});await flush();await clock.advance(450);
  assert.deepEqual(requests.map(row=>row.text),['已发出的任务','后续补充']);assert.equal(h.api.state.getSnapshot().conversationMessages.length,2);await h.api.dispose();
});

test('a failed continuation final preserves both the earlier sentence and live partial without sending',async()=>{
  const clock=continuationClock(),h=setup({...clock});await h.api.startCall({sessionId:'s'});const c=h.captures[0].callbacks;
  c.onSpeechStart(1);c.onFinal('已识别的前句',{utteranceId:1});c.onSpeechStart(2);c.onPartial('还没识别完的后句',{utteranceId:2});c.onError(Error('识别失败'));
  await clock.advance(2000);assert.deepEqual(h.texts(),[]);assert.equal(clock.timers.size,0);assert.equal(h.api.state.getSnapshot().recoveryText,'已识别的前句\n还没识别完的后句');await h.api.dispose();
});

test('a pre-dispatch failure settles continuation and preserves a retryable draft',async()=>{
  const clock=continuationClock(),h=setup({...clock,cancel:async()=>{throw Error('取消失败');}});await h.api.startCall({sessionId:'s'});
  h.status={running:true,pendingInteraction:false};const c=h.captures[0].callbacks;c.onSpeechStart(1);c.onFinal('等待重试',{utteranceId:1});await clock.advance(450);
  assert.deepEqual(h.texts(),[]);assert.equal(h.api.state.getSnapshot().turnPending,false);assert.equal(h.api.state.getSnapshot().canRetry,true);assert.equal(h.api.state.getSnapshot().recoveryText,'等待重试');await h.api.dispose();
});

test('dictation continues writing its captured draft immediately without a call continuation timer',async()=>{
  const clock=continuationClock(),h=setup({...clock});let draft='',revision=0;
  await h.api.startDictation({sessionId:'s',inputActions:{captureInsertion:()=>({start:0,end:draft.length,draftRev:revision}),insertText:text=>{draft=text;revision++;return true;},persistDraft(){}}});
  const c=h.captures[0].callbacks;c.onSpeechStart(1);c.onFinal('第一句。',{utteranceId:1});assert.equal(draft,'第一句。');
  c.onSpeechStart(2);c.onPartial('第二句',{utteranceId:2});assert.equal(draft,'第一句。第二句');assert.equal(clock.timers.size,0);assert.equal(h.api.state.getSnapshot().turnPending,false);await h.api.dispose();
});

function heldDictation(options={}){
  const h=setup(options);let draft='',revision=0;
  const inputActions={captureInsertion:()=>({start:0,end:draft.length,draftRev:revision}),insertText:text=>{draft=text;revision++;return true;},persistDraft(){}};
  // Extend in place: spreading would drop the harness's status accessor.
  return Object.assign(h,{inputActions,draft:()=>draft,snapshot:()=>h.api.state.getSnapshot(),start:()=>h.api.startDictation({sessionId:'s',inputActions,hold:true})});
}
test('held dictation buffers speech away from the draft and sends it once on release',async()=>{
  const h=heldDictation();await h.start();const c=h.captures[0].callbacks;
  assert.equal(h.snapshot().dictationHold,true);
  c.onPartial('帮我查');c.onFinal('帮我查一下天气。');
  assert.equal(h.draft(),'');assert.equal(h.snapshot().transcript,'帮我查一下天气。');
  assert.deepEqual(await h.api.sendDictation(),{sent:true});
  assert.deepEqual(h.sent,[{sessionId:'s',text:'帮我查一下天气。'}]);assert.equal(h.draft(),'');
  assert.equal(h.snapshot().mode,'idle');assert.equal(h.snapshot().dictationHold,false);assert.equal(h.snapshot().recoveryText,'');
  assert.deepEqual(await h.api.sendDictation(),{sent:false});assert.equal(h.sent.length,1);await h.api.dispose();
});
test('a tap turns the held session into ordinary dictation that writes the draft and never sends',async()=>{
  const h=heldDictation();await h.start();const c=h.captures[0].callbacks;
  c.onPartial('第一');assert.equal(h.draft(),'');
  h.api.keepDictation(h.inputActions);assert.equal(h.snapshot().dictationHold,false);assert.equal(h.draft(),'第一');
  c.onFinal('第一句。');assert.equal(h.draft(),'第一句。');
  await h.api.stopDictation();assert.deepEqual(h.sent,[]);assert.equal(h.snapshot().recoveryText,'');assert.equal(h.snapshot().mode,'idle');await h.api.dispose();
});
test('held speech that cannot be sent returns to the draft: approval pending, send failure, lost release and teardown',async()=>{
  const pending=heldDictation();await pending.start();pending.captures[0].callbacks.onFinal('删除旧文件');pending.status={running:true,pendingInteraction:{kind:'approval'}};
  await assert.rejects(pending.api.sendDictation(),/授权或交互.*保留到草稿/);
  assert.deepEqual(pending.sent,[]);assert.equal(pending.snapshot().recoveryText,'删除旧文件');assert.equal(pending.snapshot().recoverySessionId,'s');await pending.api.dispose();
  const failed=heldDictation({send:async()=>{throw Error('private transport detail');}});await failed.start();failed.captures[0].callbacks.onFinal('查一下日志');
  await assert.rejects(failed.api.sendDictation(),error=>/发送失败.*保留到草稿/.test(error.message)&&!/private/.test(error.message));
  assert.equal(failed.snapshot().recoveryText,'查一下日志');await failed.api.dispose();
  const lost=heldDictation();await lost.start();lost.captures[0].callbacks.onFinal('说到一半');
  await lost.api.stopDictation();assert.deepEqual(lost.sent,[]);assert.equal(lost.snapshot().recoveryText,'说到一半');assert.equal(lost.draft(),'');await lost.api.dispose();
  const torn=heldDictation();await torn.start();torn.captures[0].callbacks.onPartial('还没说完');
  await torn.api.hangup();assert.deepEqual(torn.sent,[]);assert.equal(torn.snapshot().recoveryText,'还没说完');assert.equal(torn.snapshot().dictationHold,false);await torn.api.dispose();
});
test('held dictation with no recognized speech sends nothing and leaves no draft',async()=>{
  const h=heldDictation();await h.start();h.captures[0].callbacks.onFinal('   ');
  assert.deepEqual(await h.api.sendDictation(),{sent:false});assert.deepEqual(h.sent,[]);assert.equal(h.snapshot().recoveryText,'');assert.equal(h.draft(),'');await h.api.dispose();
});

test('native SuperAgent publication flushes a short reply once without reading tool arguments', async () => {
  const h = setup({ conversationMode: 'native', createChunker: () => new SpeakableChunker() });
  await h.api.startCall({ sessionId: 's' });
  const capture = h.captures[0].callbacks;
  capture.onSpeechStart(1); capture.onFinal('你好', { utteranceId: 1 }); await flush();
  assert.deepEqual(h.texts(), ['你好']);
  h.publish('turn/start', { turn: 1 });
  h.publish('user/message', { id: 'hello', source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] });
  h.publish('assistant/live-chunk', { turn: 1, step: 1, attemptId: 'a', chunk: { type: 'tool-call-delta', text: '{"text":"你好"}' } });
  assert.equal(h.queues.length, 0);
  h.publish('plugin:benchgo-plugin/chat-publication', { kind: 'final', requestId: 'hello', text: '你好' }, { ignorable: true });
  assert.deepEqual(h.queues[0].text, ['你好']);
  h.publish('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: '你好' }] } }, { surfaceOp: 'append' });
  h.publish('turn/end', { turn: 1, reason: { kind: 'completed' } });
  assert.deepEqual(h.queues[0].text, ['你好']);
  assert.equal(h.api.state.getSnapshot().replyText, '你好');
  assert.equal(h.api.state.getSnapshot().error, '');
  await h.api.dispose();
});

test('native public sentences deliver PCM before text settlement and upstream audio completion',async t=>{
  const requests=[],audio=[],streams=[],queues=[];
  const h=setup({conversationMode:'native',createChunker:()=>new SpeakableChunker(),fetch:async(_url,options)=>{
    requests.push(JSON.parse(options.body).text);
    return new Response(new ReadableStream({start(controller){streams.push(controller);controller.enqueue(new Uint8Array([1,0]));}}));
  },createQueue:options=>{
    options.player.enqueue=async chunk=>audio.push([...chunk]);options.player.segmentEnd=()=>{};
    const queue=new SpeechQueue(options);queues.push(queue);return queue;
  }});t.after(()=>h.api.dispose());await h.api.startCall({sessionId:'s'});
  h.publish('turn/start',{turn:1});h.publish('user/message',{id:'human',source:{kind:'user'},content:[]});
  h.publish('assistant/live-chunk',{turn:1,step:1,attemptId:'a',chunk:{type:'text-delta',text:'我先核对这些工单。'}});
  await flush();assert.deepEqual(requests,['我先核对这些工单。']);assert.deepEqual(audio,[[1,0]]);
  assert.equal(queues[0].items[0].done,undefined);
  h.publish('assistant/message',{turn:1,step:1,message:{source:{kind:'model'},content:[{type:'text',text:'我先核对这些工单。'}]}});
  h.publish('assistant/live-chunk',{turn:1,step:2,attemptId:'b',chunk:{type:'text-delta',text:'接下来给你预览'}});
  h.publish('assistant/message',{turn:1,step:2,message:{source:{kind:'model'},content:[{type:'text',text:'接下来给你预览'}]}});
  await flush();assert.deepEqual(requests,['我先核对这些工单。','接下来给你预览']);
  h.publish('turn/end',{turn:1,reason:{kind:'completed'}});await flush();assert.equal(requests.length,2);
  for(const stream of streams)stream.close();await queues[0].finish();
  assert.deepEqual(audio,[[1,0],[1,0]]);
  assert.deepEqual(h.api.state.getSnapshot().conversationMessages.filter(row=>row.role==='assistant').map(row=>[row.text,row.partial]),[['我先核对这些工单。',false],['接下来给你预览',false]]);
});

test('native startup retains a completed reply until microphone and playback are ready',async t=>{
  const ready=deferred(),h=setup({conversationMode:'native',captureStart:()=>ready.promise});t.after(()=>h.api.dispose());
  const start=h.api.startCall({sessionId:'s'});await flush();
  h.publish('turn/start',{turn:1});h.publish('user/message',{id:'human',source:{kind:'user'},content:[]});
  h.publish('assistant/live-chunk',{turn:1,step:1,attemptId:'a',chunk:{type:'text-delta',text:'连接时已完成的回复。'}});
  h.publish('assistant/message',{turn:1,step:1,message:{source:{kind:'model'},content:[{type:'text',text:'连接时已完成的回复。'}]}});
  h.publish('turn/end',{turn:1,reason:{kind:'completed'}});
  assert.ok(h.queues.every(queue=>!queue.text.length));ready.resolve();await start;
  assert.deepEqual(h.queues[0].text,['连接时已完成的回复。']);
});

test('native reconnect resumes only fresh text without replaying its baseline prefix',async t=>{
  const h=setup({conversationMode:'native'});t.after(()=>h.api.dispose());await h.api.startCall({sessionId:'s'});
  h.publish('turn/start',{turn:1});h.publish('user/message',{id:'human',source:{kind:'user'},content:[]});
  h.publish('assistant/live-chunk',{turn:1,step:1,attemptId:'a',chunk:{type:'text-delta',text:'已经输出的前半句。'}});
  h.rebaseline();
  h.publish('assistant/live-chunk',{turn:1,step:1,attemptId:'a',chunk:{type:'text-delta',text:'恢复后的后半句。'}});
  h.publish('assistant/message',{turn:1,step:1,message:{source:{kind:'model'},content:[{type:'text',text:'已经输出的前半句。恢复后的后半句。'}]}});
  h.publish('turn/end',{turn:1,reason:{kind:'completed'}});
  assert.deepEqual(h.queues[0].text,['已经输出的前半句。','恢复后的后半句。']);
});

function publishNotice(h,id,text,{replyKind}={}){
  h.publish('user/message',{id,source:replyKind?{kind:'benchgo-ticket-reply',replyKind}:{kind:'user'},content:[]});
  h.publish('plugin:benchgo-plugin/chat-publication',{kind:replyKind?'ticket-reply':'final',requestId:id,text},{ignorable:true});
}
function publishDelivery(h,id,text){h.publish('plugin:benchgo-plugin/channel-message',{mirrorKey:id,direction:'delivery',text,source:{channel:'desktop',sourceType:'conversation'}},{ignorable:true});}

test('formal messages wait through continued speech, stay ordered across navigation and do not duplicate records',async()=>{
  const clock=continuationClock(),h=setup({...clock,conversationMode:'native'});await h.api.startCall({sessionId:'s'});const c=h.captures[0].callbacks;
  c.onSpeechStart(1);publishNotice(h,'reminder','有项权限需要确认。',{replyKind:'approval'});
  c.onFinal('我还要补充',{utteranceId:1});publishDelivery(h,'result','新的结果已经到了。');
  h.api.selectSession('other');await h.api.releaseSessionView('s');
  await clock.advance(449);assert.equal(h.queues.length,0);
  c.onSpeechStart(2);publishNotice(h,'recovery','有项工作需要恢复。',{replyKind:'recovery'});c.onFinal('这一句。',{utteranceId:2});
  await clock.advance(449);assert.equal(h.queues.length,0);await clock.advance(1);
  assert.deepEqual(h.queues[0].text,['有项权限需要确认。','新的结果已经到了。','有项工作需要恢复。']);
  assert.equal(h.api.state.getSnapshot().sessionId,'s');assert.deepEqual(h.texts(),['我还要补充\n这一句。']);
  const assistant=h.api.state.getSnapshot().conversationMessages.filter(row=>row.role==='assistant');
  assert.deepEqual(assistant.map(row=>row.text),h.queues[0].text);assert.ok(assistant.every(row=>!row.partial));
  publishDelivery(h,'result','新的结果已经到了。');assert.equal(h.queues[0].text.length,3);
  await h.api.dispose();
});

test('muting releases queued formal output while preserving the unsent draft',async()=>{
  const clock=continuationClock(),h=setup({...clock,conversationMode:'native'});await h.api.startCall({sessionId:'s'});const c=h.captures[0].callbacks;
  c.onSpeechStart(1);c.onFinal('还没有说完',{utteranceId:1});publishNotice(h,'n','需要你确认。',{replyKind:'watchdog'});
  assert.equal(h.queues.length,0);h.api.setMuted(true);assert.deepEqual(h.queues[0].text,['需要你确认。']);
  await clock.advance(1000);assert.deepEqual(h.texts(),[]);assert.equal(h.api.state.getSnapshot().recoveryText,'还没有说完');
  publishDelivery(h,'d','另一条主动结果。');assert.deepEqual(h.queues[0].text,['需要你确认。','另一条主动结果。']);await h.api.dispose();
});

test('cancelled or empty speech releases pending notifications without sending an empty user turn',async()=>{
  for(const cancelled of [true,false]){
    const h=setup({conversationMode:'native'});await h.api.startCall({sessionId:'s'});const c=h.captures[0].callbacks;
    c.onSpeechStart(1);publishNotice(h,'n','提醒仍然有效。');
    if(cancelled)c.onSpeechEnd(1,{cancelled:true});else c.onFinal('',{utteranceId:1});
    assert.deepEqual(h.queues[0].text,['提醒仍然有效。']);assert.deepEqual(h.texts(),[]);assert.equal(h.api.state.getSnapshot().turnPending,false);await h.api.dispose();
  }
});

test('hangup clears pending formal speech and reopening never replays its baseline',async()=>{
  const h=setup({conversationMode:'native'});await h.api.startCall({sessionId:'s'});
  h.captures[0].callbacks.onSpeechStart(1);publishNotice(h,'old','上一通的提醒。');assert.equal(h.queues.length,0);
  await h.api.hangup();await h.api.startCall({sessionId:'s'});h.api.setMuted(true);assert.equal(h.queues.length,0);
  publishNotice(h,'new','这一通的新提醒。');assert.deepEqual(h.queues[0].text,['这一通的新提醒。']);await h.api.dispose();
});

test('pending speech is bounded and overflow stays visible in the original conversation',async()=>{
  const h=setup({conversationMode:'native'});await h.api.startCall({sessionId:'s'});h.captures[0].callbacks.onSpeechStart(1);
  for(let i=0;i<33;i++)publishDelivery(h,`n:${i}`,`提醒 ${i}。`);
  assert.match(h.api.state.getSnapshot().error,/部分未朗读.*原对话/);
  assert.equal(h.api.state.getSnapshot().conversationMessages.filter(row=>row.role==='assistant').length,33);
  h.api.setMuted(true);assert.equal(h.queues[0].text.length,32);assert.equal(h.queues[0].text.at(-1),'提醒 31。');await h.api.dispose();
});

test('direct formal assistant output received while speaking is retained but interrupted drafts are not queued',async()=>{
  const h=setup(),c=()=>h.captures[0].callbacks;await h.api.startCall({sessionId:'s'});c().onSpeechStart(1);
  h.publish('assistant/live-chunk',{attemptId:'later',turn:1,step:1,chunk:{type:'text-delta',text:'新的正式结果。'}});
  h.publish('assistant/message',{turn:1,step:1,message:{source:{kind:'model'},content:[{type:'text',text:'新的正式结果。'}]}});
  h.publish('assistant/message',{turn:1,step:2,interrupted:true,message:{source:{kind:'model'},content:[{type:'text',text:'已取消的旧草稿'}]}});
  assert.equal(h.queues.length,0);h.api.setMuted(true);assert.deepEqual(h.queues[0].text,['新的正式结果。']);await h.api.dispose();
});

test('interrupting a partially spoken direct or native reply never replays its durable prefix or late suffix',async()=>{
 for(const conversationMode of ['direct','native']){
  const h=setup({conversationMode});await h.api.startCall({sessionId:'s'});
  h.publish('turn/start',{turn:1});h.publish('user/message',{id:'human',source:{kind:'user'},content:[]});h.publish('assistant/live-chunk',{attemptId:'old',turn:1,step:1,chunk:{type:'text-delta',text:'已听到的前半句。'}});await Promise.resolve();
  h.captures[0].callbacks.onSpeechStart(1);
  h.publish('assistant/message',{turn:1,step:1,message:{source:{kind:'model'},content:[{type:'text',text:'已听到的前半句。未听到的后半句。'}]}});
  publishDelivery(h,'new','另一条新提醒。');h.api.setMuted(true);
  h.publish('assistant/live-chunk',{attemptId:'old',turn:1,step:1,chunk:{type:'text-delta',text:'迟到的旧回复。'}});
  assert.deepEqual(h.queues[0].text,['已听到的前半句。','另一条新提醒。']);await h.api.dispose();
 }
});

test('native retry replaces the failed live subtitle with the new attempt',async t=>{
  const h=setup({conversationMode:'native'});t.after(()=>h.api.dispose());await h.api.startCall({sessionId:'s'});
  h.publish('turn/start',{turn:1});h.publish('user/message',{id:'human',source:{kind:'user'},content:[]});
  h.publish('assistant/live-chunk',{turn:1,step:1,attemptId:'a',chunk:{type:'text-delta',text:'失败的尝试。'}});
  h.publish('llm/retry',{turn:1,step:1});
  h.publish('assistant/live-chunk',{turn:1,step:1,attemptId:'b',chunk:{type:'text-delta',text:'重试后的正文。'}});
  assert.deepEqual(h.api.state.getSnapshot().conversationMessages.filter(row=>row.role==='assistant').map(row=>row.text),['重试后的正文。']);
  h.publish('assistant/message',{turn:1,step:1,message:{source:{kind:'model'},content:[{type:'text',text:'重试后的正文。'}]}});
  h.publish('turn/end',{turn:1,reason:{kind:'completed'}});
  assert.deepEqual(h.api.state.getSnapshot().conversationMessages.filter(row=>row.role==='assistant').map(row=>[row.text,row.partial]),[['重试后的正文。',false]]);
});

test('native call never speaks or records internal reply drafts and enhanced keeps its single speaking channel',async()=>{
  for(const conversationMode of ['native','enhanced']){
    const h=setup({conversationMode,createConversation:()=>({start:async()=>{},interrupt:async()=>{},dispose:async()=>{}})});await h.api.startCall({sessionId:'s'});
    h.publish('turn/start',{turn:1});h.publish('user/message',{id:'internal',source:{kind:'benchgo-ticket-reply',replyKind:'result'},content:[{type:'text',text:'PRIVATE NOTICE'}]});
    h.publish('assistant/live-chunk',{attemptId:'private',turn:1,step:1,chunk:{type:'text-delta',text:'PRIVATE DRAFT'}});
    h.publish('assistant/message',{turn:1,step:1,message:{source:{kind:'model'},content:[{type:'text',text:'PRIVATE DRAFT'}]}});
    h.publish('plugin:benchgo-plugin/chat-publication',{kind:'ticket-reply',requestId:'internal',text:'PRIVATE OUTBOX DRAFT'},{ignorable:true});h.publish('turn/end',{turn:1,reason:{kind:'completed'}});
    assert.ok(h.queues.every(queue=>!queue.text.length));assert.doesNotMatch(JSON.stringify(h.api.state.getSnapshot().conversationMessages),/PRIVATE/);
    if(conversationMode==='enhanced'){publishDelivery(h,'ready','正式交付结果');assert.ok(h.queues.every(queue=>!queue.text.length));}
    await h.api.dispose();
  }
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
  await h.api.load(); assert.equal(h.api.state.getSnapshot().mode, 'call'); assert.equal(h.captures[0].disposed, undefined); assert.equal(h.players[0].supplyResets,undefined);
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
test('automatic read keeps session binding and streams only fresh output after retry',async()=>{const h=setup();await h.api.toggleRead('s');assert.equal(h.api.state.getSnapshot().sessionId,'s');h.publish('turn/start');h.publish('assistant/live-chunk',{attemptId:'a',chunk:{type:'reasoning-delta',text:'hidden'}});h.publish('assistant/live-chunk',{attemptId:'a',chunk:{type:'text-delta',text:'首句'}});await Promise.resolve();h.publish('llm/retry');h.publish('assistant/live-chunk',{attemptId:'b',chunk:{type:'text-delta',text:'重试'}});await Promise.resolve();assert.deepEqual(h.queues[0].text,['首句','重试']);assert.equal(h.api.state.getSnapshot().readEnabled,true);await h.api.dispose();});
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

test('new recording restores unsent text into its own draft without overwriting the selection',async()=>{
 const h=setup();await h.api.startCall({sessionId:'s'});h.status={running:true,pendingInteraction:true};
 const c=h.captures[0].callbacks;c.onSpeechStart(1);c.onFinal('unsent',{utteranceId:1});await flush();await h.api.hangup();
 h.api.selectSession('other');assert.equal(h.api.state.getSnapshot().recoveryText,'');h.api.selectSession('s');
 assert.equal(h.api.state.getSnapshot().recoveryText,'unsent');await assert.rejects(h.api.startCall({sessionId:'s'}),/返回原对话/);
 assert.throws(()=>h.api.recoverToDraft({captureInsertion:()=>({}),insertText:()=>false}),/草稿暂时无法编辑/);
 assert.equal(h.api.state.getSnapshot().recoveryText,'unsent');let draft='existing draft',persisted=0;
 const inputActions={captureInsertion:()=>({start:0,end:8,draftRev:1}),insertText:(text,span)=>{assert.equal(span.start,8);assert.equal(span.end,8);assert.equal(span.draftRev,1);draft=draft.slice(0,span.start)+text+draft.slice(span.end);return true;},persistDraft(){persisted++;}};
 await h.api.startCall({sessionId:'s',inputActions});
 assert.equal(draft,'existingunsent draft');assert.equal(persisted,1);assert.equal(h.api.state.getSnapshot().recoveryText,'');assert.deepEqual(h.texts(),[]);await h.api.dispose();
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
 await h.api.configure({...config,tts:{...config.tts,speed:2}});assert.equal(h.players[0].supplyResets,1);assert.equal(h.api.state.getSnapshot().mode,'call');assert.equal(h.captures[0].disposed,undefined);
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

test('enhanced interruption without an utterance releases suspended results; a real utterance takes the normal turn instead',async()=>{
 const actions=[];
 const h=setup({conversationMode:'enhanced',createConversation:()=>({start:async()=>{},dispose:async()=>{},interrupt:async()=>{actions.push('interrupt');},resume:async()=>{actions.push('resume');},send:async text=>{actions.push('send:'+text);return {accepted:true};}})});
 await h.api.startCall({sessionId:'s'});const c=h.captures[0].callbacks;
 c.onSpeechStart(1);assert.deepEqual(actions,['interrupt']);
 c.onSpeechEnd(1,{cancelled:true});await flush();assert.deepEqual(actions,['interrupt','resume']);
 c.onSpeechStart(2);c.onFinal('',{utteranceId:2});await flush();assert.deepEqual(actions.slice(2),['interrupt','resume']);
 c.onSpeechStart(3);c.onFinal('继续',{utteranceId:3});await flush();assert.deepEqual(actions.slice(4),['interrupt','send:继续']);
 c.onSpeechStart(4);h.api.setMuted(true);assert.deepEqual(actions.slice(6),['interrupt','resume']);
 await h.api.hangup();await h.api.dispose();
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

test('direct call state carries the downgrade reason and whether settings can resolve it',async()=>{
 const config={dictation:true,readAloud:true,call:true,asr:{configured:true,protocol:'transcriptions-sse'},tts:{configured:true,protocol:'speech'}};
 for(const [conversation,configurable] of [[{mode:'direct',reason:'未配置通话交互模型',configurable:true},true],[{mode:'direct',reason:'子 Agent 会话未启用通话交接'},false],[{mode:'direct',reason:'未配置',configurable:'yes'},false]]){
  const h=setup({json:async action=>action==='config'?{config}:action==='call.start'?{call:{callId:'lease'},conversation}:{}});
  await h.api.startCall({sessionId:'s'});
  assert.equal(h.api.state.getSnapshot().conversationReason,conversation.reason);assert.equal(h.api.state.getSnapshot().conversationConfigurable,configurable);
  await h.api.hangup();
  assert.equal(h.api.state.getSnapshot().conversationReason,'');assert.equal(h.api.state.getSnapshot().conversationConfigurable,false);await h.api.dispose();
 }
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
  h.publish('turn/start',{turn:1});
  h.publish('user/message',{id:'official-user',source:{kind:'user'},content:[{type:'text',text:'看一下首页'}]});
  h.publish('assistant/live-chunk',{attemptId:'a',turn:1,step:1,chunk:{type:'text-delta',text:'正在查看'}});
  h.publish('assistant/message',{turn:1,step:1,message:{id:'official-assistant',source:{kind:'model'},content:[{type:'text',text:'正在查看首页。'}]}});
  h.publish('turn/end',{turn:1,reason:{kind:'completed'}});
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

test('navigation retains the original session scope and keeps sending and playing its conversation',async t=>{
 const h=setup();t.after(()=>h.api.dispose());h.api.selectSession('s');await h.api.startCall({sessionId:'s'});
 h.closeView('s');h.api.selectSession('other');await h.api.releaseSessionView('s');
 assert.equal(h.api.state.getSnapshot().mode,'call');assert.equal(h.api.state.getSnapshot().sessionId,'s');assert.equal(h.references[0].released,undefined);
 const c=h.captures[0].callbacks;c.onSpeechStart(1);c.onFinal('继续原来的任务',{utteranceId:1});await flush();
 assert.deepEqual(h.sent,[{sessionId:'s',text:'继续原来的任务'}]);
 h.publish('turn/start');h.publish('assistant/live-chunk',{attemptId:'a',chunk:{type:'text-delta',text:'原会话的回复'}});await Promise.resolve();
 assert.deepEqual(h.queues[0].text,['原会话的回复']);assert.equal(h.captures[0].disposed,undefined);
 await h.api.hangup();assert.equal(h.references[0].releases,1);assert.equal(h.cancelCalls,0);
});

test('starting a second call or dictation cannot replace the active call',async t=>{
 const h=setup();t.after(()=>h.api.dispose());await h.api.startCall({sessionId:'s'});
 await assert.rejects(h.api.startCall({sessionId:'other'}),/先结束当前通话/);
 await assert.rejects(h.api.startCall({sessionId:'s'}),/先结束当前通话/);
 await assert.rejects(h.api.startDictation({sessionId:'other'}),/先结束当前通话/);
 assert.equal(h.api.state.getSnapshot().sessionId,'s');assert.equal(h.api.state.getSnapshot().mode,'call');assert.equal(h.references.length,1);
 assert.equal(h.captures.length,1);assert.equal(h.captures[0].disposed,undefined);assert.equal(h.calls.filter(x=>x.action==='call.end').length,0);
});

test('navigation while the retained session opens cannot change startup ownership',async t=>{
 const ready=deferred(),h=setup({retainReady:(_reference,options)=>{assert.equal(options.source,'controllerOperation');assert.equal(options.signal.aborted,false);return ready.promise;}});t.after(()=>h.api.dispose());
 h.api.selectSession('s');const start=h.api.startCall({sessionId:'s'});await flush();
 h.api.selectSession('other');h.closeView('s');await h.api.releaseSessionView('s');
 assert.equal(h.captures.length,0);assert.equal(h.references[0].released,undefined);
 ready.resolve();await start;assert.equal(h.api.state.getSnapshot().sessionId,'s');assert.equal(h.api.state.getSnapshot().phase,'listening');
 assert.equal(h.calls.filter(x=>x.action==='call.start').length,1);
});

test('hangup releases a pending retained session and its late readiness cannot reopen audio',async t=>{
 const ready=deferred(),h=setup({retainReady:()=>ready.promise});t.after(()=>h.api.dispose());
 const start=h.api.startCall({sessionId:'s'});await flush();await h.api.hangup();h.api.selectSession('other');
 assert.equal(h.references[0].releases,1);ready.resolve();await start;
 assert.equal(h.captures.length,0);assert.equal(h.players.length,0);assert.equal(h.calls.filter(x=>x.action==='call.start').length,0);
 assert.equal(h.api.state.getSnapshot().sessionId,'other');assert.equal(h.api.state.getSnapshot().mode,'idle');assert.equal(h.references[0].releases,1);
});

test('retained-session and media startup failures release ownership exactly once',async t=>{
 for(const failure of ['session','capture']){
  const h=setup(failure==='session'?{retainReady:()=>Promise.reject(Error('session unavailable'))}:{captureStart:()=>Promise.reject(Error('capture unavailable'))});t.after(()=>h.api.dispose());
  await assert.rejects(h.api.startCall({sessionId:'s'}),/unavailable/);
  assert.equal(h.references[0].releases,1);assert.equal(h.api.state.getSnapshot().mode,'idle');
  if(failure==='session')assert.equal(h.players.length,0);
 }
});

test('cancelling a new call waiting for prior cleanup does not start it later',async t=>{
 const disposal=deferred(),h=setup({captureDispose:()=>disposal.promise});t.after(()=>h.api.dispose());
 await h.api.startCall({sessionId:'s'});const ending=h.api.hangup();const next=h.api.startCall({sessionId:'other'});
 assert.equal(h.api.hangup(),ending);h.api.selectSession('third');disposal.resolve();await ending;await next;
 assert.equal(h.captures.length,1);assert.equal(h.references.length,1);assert.equal(h.api.state.getSnapshot().sessionId,'third');assert.equal(h.api.state.getSnapshot().mode,'idle');
});

test('view release stops page-owned dictation and read-aloud while other views cannot stop them',async t=>{
 const h=setup();t.after(()=>h.api.dispose());h.api.selectSession('s');
 await h.api.startDictation({sessionId:'s',inputActions:{captureInsertion:()=>({}),insertText:()=>true,persistDraft(){}}});
 await h.api.releaseSessionView('other');assert.equal(h.api.state.getSnapshot().mode,'dictation');
 await h.api.releaseSessionView('s');assert.equal(h.api.state.getSnapshot().mode,'idle');assert.equal(h.captures[0].disposed,true);
 h.api.selectSession('s');await h.api.toggleRead('s');await h.api.releaseSessionView('s');assert.equal(h.api.state.getSnapshot().readEnabled,false);assert.equal(h.players[0].disposed,true);
 assert.equal(h.references.length,0);
});

test('background visibility and blur keep a call alive but pagehide and offline release it',async t=>{
 const previousDocument=globalThis.document,document=new EventTarget();document.baseURI='https://voice.example/';document.visibilityState='visible';globalThis.document=document;t.after(()=>{globalThis.document=previousDocument;});
 for(const endingEvent of ['pagehide','offline']){
  const window=new EventTarget(),h=setup({window});t.after(()=>h.api.dispose());await h.api.startCall({sessionId:'s'});
  document.visibilityState='hidden';document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('blur'));await flush();
  assert.equal(h.api.state.getSnapshot().mode,'call');assert.equal(h.references[0].released,undefined);assert.equal(h.captures[0].disposed,undefined);
  window.dispatchEvent(new Event(endingEvent));await flush();assert.equal(h.api.state.getSnapshot().mode,'idle');assert.equal(h.references[0].releases,1);await h.api.dispose();
 }
});

test('hangup restores read-aloud only while its original conversation is still viewed',async t=>{
 for(const navigate of [false,true]){
  const h=setup();t.after(()=>h.api.dispose());h.api.selectSession('s');await h.api.toggleRead('s');await h.api.startCall({sessionId:'s'});
  if(navigate){h.api.selectSession('other');await h.api.releaseSessionView('s');}
  await h.api.hangup();assert.equal(h.api.state.getSnapshot().readEnabled,!navigate);assert.equal(h.players.length,navigate?1:2);assert.equal(h.references[0].releases,1);
 }
});

test('reading another conversation history never applies the active call mode',async t=>{
 const requests=[],h=setup({conversationMode:'native',fetch:async(_url,options)=>{requests.push(JSON.parse(options.body));return Response.json({items:[]});}});t.after(()=>h.api.dispose());await h.api.startCall({sessionId:'s'});
 await h.api.readConversationHistory('s');await h.api.readConversationHistory('other');
 assert.deepEqual(requests,[{action:'history',sessionId:'s',mode:'native'},{action:'history',sessionId:'other'}]);assert.equal(h.api.state.getSnapshot().sessionId,'s');
});

test('failed read-aloud restoration settles hangup and releases its new player', {timeout:1000},async t=>{
 let starts=0;const h=setup({playerStart:()=>{if(++starts===3)throw Error('playback unavailable');}});t.after(()=>h.api.dispose());
 h.api.selectSession('s');await h.api.toggleRead('s');await h.api.startCall({sessionId:'s'});await h.api.hangup();
 assert.equal(h.references[0].releases,1);assert.equal(h.players.length,2);assert.equal(h.players[1].disposed,true);assert.equal(h.api.state.getSnapshot().readEnabled,false);assert.equal(h.api.state.getSnapshot().error,'playback unavailable');
});
