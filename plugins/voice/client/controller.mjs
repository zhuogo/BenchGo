import { readVoiceEvents, RealtimeRecognizer } from './asr.mjs';
import { Capture, PCMPlayer } from './media.mjs';
import { playCallCue } from './call-cues.mjs';
import { SpeakableChunker, SpeechQueue } from './speech.mjs';
import { CallLatency } from './latency.mjs';
import { AgentFeed } from './agent-feed.mjs';
import { callStreamingReason } from '../src/call-streaming.mjs';
import { VoiceConversation } from './conversation.mjs';
import { readVoiceTranscript } from './conversation-records.mjs';
import { transcriptSourceId } from '../src/transcript-source.mjs';
import { transcriptMessage } from '../src/transcript-message.mjs';
import { protocolDescriptor } from '../shared/protocol-catalog.mjs';
const url=path=>new URL(path,document.baseURI);
const endpointRoute=({detection,resolvedProtocol,...rest}={})=>rest;
const ttsRoute=({speed,...rest}={})=>JSON.stringify(endpointRoute(rest));
const joinTranscript=(left,right)=>left&&right&&/[\p{L}\p{N}.!?,;:]$/u.test(left)&&/^[\p{L}\p{N}]/u.test(right)&&!/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(left)&&! /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(right)?left+' '+right:left+right;
async function json(action,args={},signal) {
  const timeout=AbortSignal.timeout(action==='call.start'?45000:12000);
  const response=await fetch(url('api/voice'),{method:'POST',credentials:'same-origin',signal:signal?AbortSignal.any([timeout,signal]):timeout,headers:{'content-type':'application/json'},body:JSON.stringify({action,...args})});
  const data=await response.json(); if(!response.ok)throw Error(data.error||'语音服务不可用'); return data;
}
function observable(initial) { let value=initial;const listeners=new Set();return {getSnapshot:()=>value,subscribe:fn=>{listeners.add(fn);return ()=>listeners.delete(fn);},patch:patch=>{value={...value,...patch};for(const fn of listeners)fn();}}; }
export function createVoiceController(ctx,deps={}) {
  // RealtimeRecognizer calls request as an instance method; Window.fetch needs
  // its own receiver rather than the recognizer instance.
  const request=deps.fetch||globalThis.fetch.bind(globalThis),requestJson=deps.json||json,environment=deps.window||globalThis.window;
  const makeCapture=deps.createCapture||(options=>new Capture(options)),makePlayer=deps.createPlayer||(options=>new PCMPlayer(options)),makeQueue=deps.createQueue||(options=>new SpeechQueue(options)),makeChunker=deps.createChunker||(()=>new SpeakableChunker({now:clock}));
  const makeConversation=deps.createConversation||(options=>new VoiceConversation(options));
  const wait=deps.wait||(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
  const schedule=deps.setInterval||globalThis.setInterval,unschedule=deps.clearInterval||globalThis.clearInterval;
  const defer=deps.setTimeout||globalThis.setTimeout,cancelDeferred=deps.clearTimeout||globalThis.clearTimeout;
  const now=deps.now||Date.now,playCue=deps.playCallCue||playCallCue;
  const clock=deps.clock||deps.now||(()=>globalThis.performance?.now?.()??Date.now());
  let connectionCue=null,callConnected=false;
  const state=observable({config:null,mode:'idle',phase:'idle',sessionId:null,error:'',transcript:'',transcriptId:null,turnPending:false,recoveryText:'',recoverySessionId:null,canRetry:false,level:0,playbackLevel:0,muted:false,readEnabled:false,dictationHold:false,conversationMode:'direct',conversationReason:'',conversationConfigurable:false,replyText:'',conversationMessages:[],conversationRevision:0});
  const deviceId=crypto.randomUUID(),played=new Set(),pendingText=new Map(),partialText=new Map(),awaitingFinal=new Set(),recoveries=new Map(),deliveries=new Set();
  const recoveryVersions=new Map();let loadSequence=0,configureSequence=0,configuring=0;
  const pendingPublications=new Map(),interruptedSpeech=new Set();let pendingPublicationCharacters=0;
  let delivering=null,waitingForInteraction=false,dictation=null;
  let callConversation=null,conversationPhase='listening',conversationInterrupted=false,uncertainDelivery=null,readBeforeCall=false;
  let speechMessageId=null,replyActive=false;
  let opening=true,pendingOpening='',openingVersion=0;
  let continuationTimer=null,continuationVersion=0,pendingTurnId=null,speechEndedAt=null;
  let capture,player,queue,chunker,stopFeed,lease,heartbeat,binding,callReference,viewSessionId=null,generation=0,inputSequence=0,latestUtterance=0,inputActive=false,speaking=false,blocked=false,disposed=false,stopping=false,starting=null,ending=null;
  const patch=value=>{if(!disposed)state.patch(value);};
  const latency=new CallLatency({now:clock,onChange:metrics=>{patch({metrics});deps.onMetrics?.(metrics);}});
  function interruptInput(){stopSpeech(true);settleInterruptedMessages();if(!callConversation)return cancelAgent();conversationInterrupted=true;return callConversation.interrupt();}
  function recordMessage(role,id,text,fields={},append=false){
    const current=state.getSnapshot(),messages=[...current.conversationMessages],index=messages.findIndex(row=>row.id===id);
    const previous=index>=0?messages[index]:{id,role,text:'',time:now(),callId:lease?.callId};
    const row={...previous,...fields,text:append?previous.text+text:text};
    if(index>=0)messages[index]=row;else messages.push(row);
    let characters=messages.reduce((size,item)=>size+item.text.length,0);
    while(messages.length>200||characters>160000){
      const removable=messages.findIndex(item=>item.id!==id&&!item.partial&&(!uncertainDelivery||item.requestId!==uncertainDelivery.requestId));
      if(removable<0)break;characters-=messages[removable].text.length;messages.splice(removable,1);
    }
    patch({conversationMessages:messages,conversationRevision:current.conversationRevision+(row.partial?0:1)});
  }
  function settleInterruptedMessages(){const current=state.getSnapshot();if(current.conversationMessages.some(row=>row.partial))patch({conversationMessages:current.conversationMessages.map(row=>row.partial?{...row,partial:false,interrupted:true}:row),conversationRevision:current.conversationRevision+1});}
  const recover=(sessionId,text)=>{if(text)recoveries.set(sessionId,text);else recoveries.delete(sessionId);if(state.getSnapshot().sessionId===sessionId)patch({recoveryText:text,recoverySessionId:text?sessionId:null});};
  const pendingTranscript=()=>[...pendingText.entries()].sort((a,b)=>a[0]-b[0]).map(x=>x[1]).filter(Boolean).join('\n');
  const inputEntries=()=>[...new Map([...pendingText,...partialText])].sort((a,b)=>a[0]-b[0]);
  const draftEntries=()=>inputEntries().filter(([id])=>!uncertainDelivery?.entries.some(([sent])=>sent===id));
  const visibleTranscript=()=>draftEntries().map(([,text])=>text).filter(Boolean).join('\n');
  function clearContinuation(){continuationVersion++;if(continuationTimer!==null){cancelDeferred(continuationTimer);continuationTimer=null;}}
  function continueTurn(gen,sequence){
    clearContinuation();
    if(gen!==generation||state.getSnapshot().mode!=='call'||state.getSnapshot().muted||inputActive||awaitingFinal.size)return;
    if(!pendingTranscript().trim()){pendingTurnId=null;patch({turnPending:false});flushPublications();refreshPhase();return;}
    // VAD and recognition already spent silence time. Only wait the remainder
    // of the common turn budget, never restart it after the ASR final.
    const version=continuationVersion;
    const remaining=Number.isFinite(speechEndedAt)?Math.max(0,Math.min(450,speechEndedAt+450-clock())):0;
    continuationTimer=defer(()=>{if(version!==continuationVersion)return;continuationTimer=null;void deliver(gen,sequence).catch(error=>{if(gen===generation)fail(error);});},remaining);
    continuationTimer?.unref?.();patch({turnPending:true,canRetry:false});refreshPhase();
  }
  const fail=error=>patch({error:error?.message||String(error)});
  const callHeaders=()=>lease?{'x-voice-call-id':lease.callId}:{};
  const status=(sessionId=state.getSnapshot().sessionId)=>ctx.uiSession.sessionStatus.getSnapshot().get(sessionId);
  const refreshPhase=()=>{
    // Synthesis gaps and an empty render buffer do not finish the reply.
    // Keep interruption protection independent of the visible speaking phase.
    capture?.setPlaybackActive?.(!!connectionCue||speaking||!blocked&&(replyActive||played.size>0));
    patch({phase:state.getSnapshot().phase==='starting'&&starting?'starting':inputActive?'listening':awaitingFinal.size?'transcribing':continuationTimer!==null?'listening':speaking?'speaking':callConversation?conversationPhase:status()?.pendingInteraction?'waiting':status()?.running?'thinking':state.getSnapshot().mode!=='idle'?'listening':'idle'});
  };
  const statusOff=ctx.uiSession.sessionStatus.subscribe(()=>{
    refreshPhase();
    if(waitingForInteraction&&!status()?.pendingInteraction&&!status()?.running){
      const gen=generation,sequence=inputSequence;
      void Promise.resolve().then(()=>deliver(gen,sequence)).catch(error=>{if(gen===generation)fail(error);});
    }
  });
  function stopSpeech(interrupted=false) {if(interrupted&&(speaking||played.size))latency.interrupt();latency.clearSegments();if(interrupted&&speechMessageId){interruptedSpeech.add(speechMessageId);if(interruptedSpeech.size>256)interruptedSpeech.delete(interruptedSpeech.values().next().value);}clearChunkTimer();resetOpening();blocked=true;speaking=false;replyActive=false;patch({playbackLevel:0});chunker=makeChunker();queue?.cancel();played.clear();refreshPhase(); }
  function ensurePlayer() {
    if(!player){const current=makePlayer({now:clock,workletURL:url('api/voice/worklet'),onError:error=>{if(player===current)fail(error);},onPlaybackStart:metrics=>{if(player!==current)return;latency.playback(metrics||{},true);speaking=true;refreshPhase();},onPlaybackIdle:()=>{if(player!==current)return;speaking=false;patch({playbackLevel:0});refreshPhase();},onMetrics:metrics=>{if(player!==current)return;if(metrics.level!==undefined)patch({playbackLevel:metrics.level});if(metrics.type==='playback')latency.playback(metrics,metrics.event==='segment_started');},onPlayed:id=>{if(player!==current)return;played.delete(id);if(!played.size&&!queue?.items.length){speaking=false;patch({playbackLevel:0});}refreshPhase();}});player=current;}
    return player.start();
  }
  function ensureQueue() {
    if(!queue)queue=makeQueue({player,now:clock,onMetrics:event=>latency.tts(event),synthesize:async(text,signal)=>{
      const response=await request(url('api/voice/speech'),{method:'POST',credentials:'same-origin',signal,headers:{'content-type':'application/json',...callHeaders()},body:JSON.stringify({text})});
      if(!response.ok){const result=await response.json();throw Error(result.error||'朗读失败');}return response;
    },onError:error=>{stopSpeech();fail(error);}});
  }
  function resetOpening(){pendingOpening='';opening=true;openingVersion++;}
  function flushOpening(){if(!pendingOpening)return;const text=pendingOpening;pendingOpening='';openingVersion++;sendSpeech(text);}
  function sendSpeech(text) {opening=false;if(played.size>=128){fail(Error('播放确认队列已满，请停止后重新朗读'));return;}if(state.getSnapshot().mode==='call')latency.bind(queue.sequence+1);if(queue.push(text)){played.add(queue.sequence);refreshPhase();} }
  function enqueue(text) {
    if(pendingOpening){if([...pendingOpening,...text].length<=60){const merged=pendingOpening+text;pendingOpening='';openingVersion++;sendSpeech(merged);return;}flushOpening();}
    // Coalesce only deltas already available in this task; never add a timer
    // or mutate a synthesis request that has already started.
    if(opening&&(text.match(/[\p{L}\p{N}]/gu)||[]).length<8){pendingOpening=text;const version=++openingVersion;queueMicrotask(()=>{if(version===openingVersion&&!blocked&&!disposed)flushOpening();});return;}
    sendSpeech(text);
  }
  function pushText(delta,event) {
    if(callConversation||state.getSnapshot().mode==='call'&&state.getSnapshot().phase==='starting'||interruptedSpeech.has(transcriptSourceId(event)))return;
    if(state.getSnapshot().mode==='call'&&delta&&!blocked){const sourceId=transcriptSourceId(event),append=!!speechMessageId&&speechMessageId===sourceId;speechMessageId=sourceId||speechMessageId||crypto.randomUUID();recordMessage('assistant',speechMessageId,delta,{sourceId,messageId:speechMessageId,partial:true},append);patch({replyText:state.getSnapshot().replyText+delta});}
    pushSpeech(delta);
  }
  const inputPending=()=>inputActive||awaitingFinal.size>0||continuationTimer!==null||state.getSnapshot().turnPending;
  function pushPublication(text,event){
    const current=state.getSnapshot();if(callConversation||!text?.trim())return;
    if(current.mode!=='call'){pushText(text,event);return;}
    if(inputPending()||current.phase==='starting'){
      const key=transcriptSourceId(event)||`${event.type}:${event.seq}`;
      if(pendingPublications.has(key))return;
      if(pendingPublications.size>=32||pendingPublicationCharacters+text.length>32000){fail(Error('待播消息较多，部分未朗读；消息仍保留在原对话中'));return;}
      pendingPublications.set(key,{text,event});pendingPublicationCharacters+=text.length;return;
    }
    blocked=false;speechMessageId=transcriptSourceId(event)||speechMessageId;patch({replyText:state.getSnapshot().replyText+text});pushSpeech(text);
    // A formal message is complete even when it has no surrounding model turn.
    if(chunker){for(const value of chunker.finish())enqueue(value);flushOpening();clearChunkTimer();}
  }
  function flushPublications(){
    if(inputPending()||state.getSnapshot().mode!=='call'||state.getSnapshot().phase==='starting')return;
    if(callConversation){
      // A cough, noise or empty recognition interrupts without any utterance,
      // so no turn follows to release the execution results it suspended.
      if(conversationInterrupted&&!uncertainDelivery&&!pendingTranscript().trim()){conversationInterrupted=false;const current=callConversation;void current.resume().catch(error=>{if(callConversation===current)fail(error);});}
      return;
    }
    for(const [key,row]of pendingPublications){pendingPublications.delete(key);pendingPublicationCharacters-=row.text.length;pushPublication(row.text,row.event);}
  }
  function pushSpeech(delta) {
    if(blocked||!(state.getSnapshot().readEnabled||state.getSnapshot().mode==='call')||!delta)return;
    if(state.getSnapshot().mode==='call')latency.token();
    ensureQueue();chunker||=makeChunker();for(const text of chunker.push(delta))enqueue(text);scheduleChunkFlush();
  }
  function attach(sessionId) {
    if(binding?.sessionId===sessionId)return;const next=ctx.sessions.binding(sessionId);if(!next)throw Error('请先打开一个可用对话');if(binding)stopSpeech();stopFeed?.();binding=next;
    const source=binding.eventSource;
    const feed=new AgentFeed({publicOnly:()=>state.getSnapshot().conversationMode==='native'||starting?.mode==='call'&&!lease,streamPublicText:()=>state.getSnapshot().phase!=='starting'&&!(starting?.mode==='call'&&!lease),onText:pushText,onPublication:pushPublication,onRecord:(event,projected)=>{
      if(callConversation||state.getSnapshot().mode!=='call')return;
      const data=event.data||{},sourceId=transcriptSourceId(event),message=projected||transcriptMessage(event),role=message?.role||(event.type==='user/message'?'user':'assistant');
      const text=message?.text;
      if(role==='assistant'&&data.interrupted){const row=state.getSnapshot().conversationMessages.find(row=>row.sourceId===sourceId);if(row)recordMessage(role,row.id,row.text,{partial:false,interrupted:true});return;}
      if(text?.trim())recordMessage(role,sourceId,text,{sourceId,seq:event.seq,partial:false});
      if(!projected&&role==='assistant'&&text?.trim()&&blocked&&!interruptedSpeech.has(sourceId))pushPublication(text,event);
      // A completed native text step is ready to speak even if tools keep the
      // turn open. Flush its short trailing phrase instead of waiting for end.
      if(state.getSnapshot().conversationMode==='native'&&event.type==='assistant/message'&&!blocked&&chunker){
        for(const value of chunker.finish())enqueue(value);flushOpening();clearChunkTimer();chunker=makeChunker();
      }
    },onStart:()=>{if(callConversation)return;speechMessageId=null;patch({replyText:''});if(!inputActive&&!awaitingFinal.size&&!state.getSnapshot().turnPending)blocked=false;replyActive=!blocked;flushOpening();resetOpening();chunker=makeChunker();refreshPhase();},onReset:()=>{if(!callConversation)stopSpeech();},onEnd:event=>{
      if(callConversation)return;
      replyActive=false;
      const reason=event?.data?.reason;
      if(!inputActive&&!awaitingFinal.size&&!state.getSnapshot().turnPending&&(state.getSnapshot().readEnabled||state.getSnapshot().mode==='call')&&['blocked','error','interrupted'].includes(reason?.kind)){
        stopSpeech();settleInterruptedMessages();
        const message=reason.kind==='blocked'?'原会话执行被拦截，尚未生成回复，请查看原会话（BLOCKED）':reason.kind==='interrupted'?'原会话运行中断，请返回原会话查看并重试':'原会话执行失败，请返回原会话查看错误详情';
        fail(Error(message));return;
      }
      if(speechMessageId){const row=state.getSnapshot().conversationMessages.find(row=>row.id===speechMessageId);if(row)recordMessage('assistant',speechMessageId,row.text,{partial:false});}
      if(!blocked&&(state.getSnapshot().readEnabled||state.getSnapshot().mode==='call')) {ensureQueue();for(const text of (chunker||=makeChunker()).finish())enqueue(text);flushOpening();}
      clearChunkTimer();refreshPhase();
    }});
    feed.baseline(source.getSnapshot());stopFeed=source.subscribe(()=>feed.accept(source.getSnapshot()));patch({sessionId});
  }
  async function cancelAgent(sessionId=state.getSnapshot().sessionId) {if(status(sessionId)?.pendingInteraction)return false;const scope=ctx.sessions.scope(sessionId);if(scope&&status(sessionId)?.running)await scope.get('conversation').cancel();return true;}
  async function deliver(gen,sequence,manual=false) {
    const claim=gen+':'+sequence;if(deliveries.has(claim))return;deliveries.add(claim);delivering=claim;const deliverySession=state.getSnapshot().sessionId,recoveryVersion=recoveryVersions.get(deliverySession)||0;
    try{
    const valid=()=>gen===generation&&sequence===inputSequence&&state.getSnapshot().mode==='call'&&!inputActive&&!awaitingFinal.size&&(manual||!state.getSnapshot().muted&&continuationTimer===null);if(!valid())return;
    let entries=[...pendingText.entries()].sort((a,b)=>a[0]-b[0]),text=entries.map(x=>x[1]).filter(Boolean).join('\n');if(!text.trim())return;
    if(callConversation){
      if(uncertainDelivery&&!manual)throw Error('上一段交接尚未确认，请先重试核对或保留文字；不会自动重复发送');
      const current=callConversation;
      if(uncertainDelivery){entries=uncertainDelivery.entries;text=uncertainDelivery.text;}
      const requestId=uncertainDelivery?.requestId||crypto.randomUUID();
      recordMessage('user',requestId,text,{requestId,transcriptIds:entries.map(([id])=>`voice-input:${gen}:${id}`),partial:false});
      uncertainDelivery={requestId,text,entries};conversationInterrupted=false;pendingTurnId=null;conversationPhase='thinking';patch({phase:'thinking',turnPending:false,error:''});

      latency.submit();const result=await current.send(text,requestId);
      if(!result?.accepted)throw Error('语音交接未确认，请重试核对');
      if(gen!==generation||callConversation!==current)return;
      uncertainDelivery=null;
      for(const [id,value]of entries)if(pendingText.get(id)===value)pendingText.delete(id);
      recover(deliverySession,pendingTranscript());return;
    }
    const awaiting=()=>{if(!status()?.pendingInteraction)return false;waitingForInteraction=true;patch({error:'请先在对话中完成授权或交互；本段语音尚未发送',transcript:text,phase:'waiting'});return true;};if(awaiting())return;
    const scope=ctx.sessions.scope(state.getSnapshot().sessionId);if(!scope)throw Error('对话已经关闭');
    await cancelAgent();if(!valid()||awaiting())return;const deadline=Date.now()+10000;
    while(status()?.running){if(!valid()||awaiting())return;if(Date.now()>deadline)throw Error('原工具尚未停止，本段语音未发送，请手动重试');await wait(50);}
    if(!valid()||awaiting())return;waitingForInteraction=false;blocked=false;pendingTurnId=null;resetOpening();chunker=makeChunker();patch({transcript:text,phase:'thinking',turnPending:false,error:''});flushPublications();

    for(const [id,value]of entries)if(pendingText.get(id)===value)pendingText.delete(id);
    recover(deliverySession,pendingTranscript());try{latency.submit();await scope.get('conversation').send(text);if(gen===generation&&sequence===inputSequence)patch({transcriptId:null});}catch(error){if((recoveryVersions.get(deliverySession)||0)===recoveryVersion){if(gen===generation){for(const [id,value]of entries)if(!pendingText.has(id))pendingText.set(id,value);}else recover(deliverySession,[recoveries.get(deliverySession),text].filter(Boolean).join('\n'));}throw error;}
    }catch(error){if(gen===generation&&sequence===inputSequence&&!inputActive&&!awaitingFinal.size&&continuationTimer===null){patch({turnPending:false});refreshPhase();}throw error;}
    finally{deliveries.delete(claim);if(delivering===claim)delivering=null;if(gen===generation){const text=pendingTranscript();recover(deliverySession,text);patch({canRetry:!!text&&state.getSnapshot().mode==='call'&&!inputActive&&!awaitingFinal.size&&continuationTimer===null});flushPublications();}}
  }
  async function begin({sessionId,inputActions,hold=false},mode) {
    if(disposed)throw Error('语音插件已停用');if(starting)throw Error('语音正在启动');if(state.getSnapshot().mode==='call')throw Error('已有通话正在进行，请先结束当前通话');if(stopping)throw Error('正在释放上一段语音，请稍后重试');
    if(recoveries.has(sessionId)&&state.getSnapshot().mode==='idle'){api.selectSession(sessionId);api.recoverToDraft(inputActions);}
    const opening=new AbortController(),attempt={mode,sessionId,opening};starting=attempt;let gen,createdCapture;
    // Held dictation buffers its text until release decides: send it, or keep dictating into the draft.
    const session=mode==='dictation'?{sessionId,held:!!hold,text:'',keep:null}:null;if(session){dictation=session;attempt.dictation=session;}
    try{
    if(ending)await ending;opening.signal.throwIfAborted();if(capture)await endMedia(attempt);opening.signal.throwIfAborted();gen=++generation;
    let config=state.getSnapshot().config||await api.load();if(gen!==generation||disposed)return;
    if(!protocolDescriptor('asr',config.asr?.protocol)||mode==='call'&&!protocolDescriptor('tts',config.tts?.protocol))throw Error('请在「设置 → 媒体 → 语音」点击自动匹配并保存协议，或在高级设置中选择具体协议');
    if(!config[mode==='call'?'call':'dictation']||!config.asr.configured||mode==='call'&&!config.tts.configured)throw Error('请先在「设置 → 媒体 → 语音」启用功能并配置模型');
    if(mode==='call'){
      const reason=callStreamingReason(config);if(reason)throw Error(reason);
      if(!ctx.sessions.retain)throw Error('当前宿主不支持持续通话所需的会话保留');
      // The page's reference may disappear while audio starts. Own an exact
      // session generation until media teardown, independently of navigation.
      const reference=ctx.sessions.retain(sessionId,{source:'controllerOperation',signal:opening.signal});callReference=reference;
      await reference.ready;if(gen!==generation||disposed||opening.signal.aborted)return;
    }
    attach(sessionId);if(mode==='call'){latency.reset();patch({metrics:latency.snapshot()});}speechEndedAt=null;patch({mode,sessionId,phase:'starting',error:'',transcript:'',transcriptId:null,turnPending:false,dictationHold:!!session?.held});
    patch({recoveryText:recoveries.get(sessionId)||'',recoverySessionId:recoveries.has(sessionId)?sessionId:null,canRetry:false,muted:false,playbackLevel:0});clearContinuation();pendingTurnId=null;pendingText.clear();partialText.clear();awaitingFinal.clear();latestUtterance=0;inputActive=false;inputSequence++;
    if(mode==='call'){
      readBeforeCall=state.getSnapshot().readEnabled;
      const [audioResult,leaseResult]=await Promise.allSettled([ensurePlayer(),requestJson('call.start',{sessionId,deviceId},opening.signal)]);
      if(leaseResult.status==='rejected')throw leaseResult.reason;const result=leaseResult.value;
      if(result.config){config=result.config;patch({config});}
      if(gen!==generation||disposed){await requestJson('call.end',{sessionId,deviceId,callId:result.call.callId});return;}lease={...result.call,sessionId};if(audioResult.status==='rejected')throw audioResult.reason;const currentLease=lease;
      const conversationMode=result.conversation?.mode||'direct';
      if(!['direct','native','enhanced'].includes(conversationMode))throw Error('通话接入模式不可用');
      patch({conversationMode,conversationReason:typeof result.conversation?.reason==='string'?result.conversation.reason:'',conversationConfigurable:result.conversation?.configurable===true,replyText:''});uncertainDelivery=null;conversationInterrupted=false;conversationPhase='listening';
      if(conversationMode==='enhanced'){
        const current=makeConversation({request,endpoint:url('api/voice/conversation'),identity:{sessionId,deviceId,callId:lease.callId},
          onEvent:event=>{
            if(gen!==generation||callConversation!==current)return;
            if(event.type==='start'){flushOpening();resetOpening();blocked=inputActive||awaitingFinal.size>0||state.getSnapshot().turnPending;replyActive=!blocked;chunker=makeChunker();conversationPhase='thinking';patch({replyText:''});refreshPhase();}
            if(event.type==='text'){patch({replyText:(state.getSnapshot().replyText+event.text).slice(-4000)});recordMessage('assistant',event.messageId,event.text,{messageId:event.messageId,requestId:event.requestId,partial:true},true);pushSpeech(event.text);}
            if(event.type==='end'){replyActive=false;const row=state.getSnapshot().conversationMessages.find(row=>row.id===event.messageId);if(row)recordMessage('assistant',event.messageId,row.text,{partial:false});if(!blocked){ensureQueue();for(const text of (chunker||=makeChunker()).finish())enqueue(text);flushOpening();}clearChunkTimer();conversationPhase='listening';refreshPhase();}
            if(event.type==='state'){if(['thinking','listening','waiting'].includes(event.phase))conversationPhase=event.phase;refreshPhase();}
            if(event.type==='config'||event.type==='settings'){if(event.config)void applyConfig(event.config).catch(fail);}
            if(event.type==='error'){replyActive=false;fail(Error(event.error||'语音交互失败'));conversationPhase='listening';refreshPhase();}
          },onError:error=>{if(gen===generation){fail(error);void endMedia();}}});
        callConversation=current;await current.start();
        if(gen!==generation||disposed){await current.dispose();return;}
      }
      heartbeat=schedule(()=>{void requestJson('call.heartbeat',{sessionId,deviceId,callId:currentLease.callId}).catch(error=>{if(lease===currentLease){fail(error);void endMedia();}});},15000);
    }
    patch({mode,sessionId,phase:'starting',error:'',transcript:''});blocked=false;
    let span=session&&!session.held?inputActions.captureInsertion():null,inserted='',finalText='',draftConflict=false;
    const writeDraft=text=>{
      if(session)session.text=text;
      if(gen!==generation||session?.held||text===inserted||draftConflict)return;
      if(!inputActions.insertText(text,span)){draftConflict=true;patch({error:'草稿已被修改，结束转录后会保留识别文字到草稿',transcript:text});recover(sessionId,text);return;}
      inserted=text;const next=inputActions.captureInsertion();span={start:span.start,end:span.start+text.length,draftRev:next.draftRev};inputActions.persistDraft();
    };
    if(session)session.keep=actions=>{if(gen!==generation)return;inputActions=actions||inputActions;span=inputActions.captureInsertion();writeDraft(session.text);};
    const asrProtocol=config.asr.protocol;
    const realtime=asrProtocol==='openai-websocket'?new RealtimeRecognizer({request,endpoint:url,headers:callHeaders,now:clock,openSocket:path=>ctx.connection.openWebSocket(path),onError:error=>{if(gen===generation){fail(error);void endMedia();}}}):null;
    if(realtime){createdCapture={dispose:()=>realtime.close()};capture=createdCapture;await realtime.start();if(gen!==generation){await realtime.close();return;}}
    createdCapture=makeCapture({now:clock,realtime,parallel:['transcriptions-sse','stepfun-sse'].includes(asrProtocol),workletURL:url('api/voice/worklet'),transcribe:async(blob,signal,onPartial)=>{
      const response=await request(url('api/voice/transcribe'),{method:'POST',credentials:'same-origin',signal,headers:{'content-type':'audio/wav',...callHeaders()},body:blob});
      if(response.headers.get('content-type')?.includes('application/x-ndjson')){let text='',final=false;await readVoiceEvents(response,signal,event=>{if(event.type==='partial'){text=event.text;onPartial?.(text);}if(event.type==='final'){text=event.text;final=true;}});if(!final)throw Error('识别连接在最终结果前关闭');return {text};}
      const result=await response.json();if(!response.ok)throw Error(result.error||'转录失败');return result;
    },onLevel:level=>{if(gen===generation)patch({level});},onSpeechStart:id=>{
      if(gen!==generation||state.getSnapshot().muted||connectionCue)return;
      clearContinuation();speechEndedAt=null;latestUtterance=id??latestUtterance+1;
      pendingTurnId??=`voice-input:${gen}:${draftEntries()[0]?.[0]??latestUtterance}`;
      awaitingFinal.add(latestUtterance);inputActive=true;inputSequence++;
      patch({transcriptId:pendingTurnId,transcript:visibleTranscript(),turnPending:mode==='call',canRetry:false});
      if(mode==='call'){const cancel=interruptInput();latency.input(latestUtterance);void cancel.catch(error=>{if(gen===generation)fail(error);});}
      patch({phase:'listening'});
    },
    onSpeechEnd:(id,meta={})=>{if(gen!==generation)return;if(id===latestUtterance){inputActive=false;if(!meta.cancelled&&Number.isFinite(meta.speechEndedAt))speechEndedAt=meta.speechEndedAt;}if(mode==='call'&&!meta.cancelled)latency.recognition(id,meta);if(meta.cancelled){awaitingFinal.delete(id);pendingText.delete(id);partialText.delete(id);if(mode==='call'&&!inputActive&&!awaitingFinal.size)continueTurn(gen,inputSequence);}refreshPhase();},
    onPartial:(text,meta={})=>{
      if(gen!==generation)return;
      if(mode==='dictation'){const combined=joinTranscript(finalText,text);patch({transcript:combined});if(draftConflict)recover(sessionId,combined);writeDraft(combined);}
      else {const id=meta.utteranceId??latestUtterance;if(!awaitingFinal.has(id))return;partialText.set(id,text);patch({transcript:visibleTranscript()});}
    },
    onFinal:(text,meta={})=>{
      if(gen!==generation)return;const id=meta.utteranceId??latestUtterance;
      if(mode==='call'&&!awaitingFinal.has(id))return;
      awaitingFinal.delete(id);partialText.delete(id);if(id===latestUtterance){inputActive=false;if(Number.isFinite(meta.speechEndedAt))speechEndedAt=meta.speechEndedAt;}if(mode==='call')latency.recognition(id,meta,true);
      if(mode==='dictation'){finalText=joinTranscript(finalText,text);patch({transcript:finalText});if(draftConflict)recover(sessionId,finalText);writeDraft(finalText);}
      else {pendingText.set(id,text);patch({transcript:visibleTranscript()});recover(sessionId,pendingTranscript());if(!inputActive&&!awaitingFinal.size)continueTurn(gen,inputSequence);else refreshPhase();}
    },
    onError:error=>{if(gen===generation){if(mode==='call'){const text=inputEntries().map(([,text])=>text).filter(Boolean).join('\n');if(text?.trim())recover(sessionId,text);}else if(session?.held&&session.text.trim())recover(sessionId,session.text);fail(error);void endMedia();}}});
    capture=createdCapture;await createdCapture.start();if(gen!==generation||disposed){await createdCapture.dispose();return;}
    if(mode==='call'){
      callConnected=true;
      try{
        const cue=playCue('connected',{context:player?.context});
        if(cue){connectionCue=cue;refreshPhase();const finished=()=>{if(connectionCue!==cue)return;connectionCue=null;if(gen===generation&&capture===createdCapture)refreshPhase();};void Promise.resolve(cue.finished).then(finished,finished);}
      }catch{}
    }
    patch({phase:'listening'});blocked=false;flushPublications();refreshPhase();
    }catch(error){if(gen===generation){await endMedia();throw error;}await createdCapture?.dispose();if(error?.name!=='AbortError'&&!opening.signal.aborted)throw error;}finally{if(starting===attempt)starting=null;}
  }
  async function applyConfig(config){
    const previous=state.getSnapshot().config,snapshot=state.getSnapshot();patch({config});if(!previous)return;
    const changed=key=>JSON.stringify(endpointRoute(previous[key]))!==JSON.stringify(endpointRoute(config[key]));
    if(changed('tts'))player?.resetSupply?.();
    if(snapshot.mode!=='idle'&&(changed('asr')||snapshot.mode==='call'&&(snapshot.conversationMode!=='native'&&changed('conversation')||!config.call||callStreamingReason(config))||snapshot.mode==='dictation'&&!config.dictation)){await endMedia();return;}
    if(ttsRoute(previous.tts)!==ttsRoute(config.tts)||snapshot.mode!=='call'&&previous.readAloud&&!config.readAloud){stopSpeech();if(!config.readAloud||!config.tts?.configured)patch({readEnabled:false});}
    if(snapshot.mode==='call'&&!config.tts?.configured)await endMedia();
  }
  // Ends dictation after its final recognition. Returns the buffered text of a held session; otherwise the draft already has it.
  async function finishDictation(){
    const session=dictation,snapshot=state.getSnapshot();
    if(snapshot.mode!=='dictation'){if(starting?.mode==='dictation')await endMedia();return null;}
    // Nothing was captured before the microphone is ready, and a half-started capture cannot be flushed.
    if(!capture?.stop||snapshot.phase==='starting'){await endMedia();return null;}
    const current=capture;stopping=true;
    try{await current.stop({flush:true});}finally{if(capture===current){capture=null;patch({mode:'idle',phase:'idle',dictationHold:false});}stopping=false;}
    if(dictation===session)dictation=null;
    return session?.held&&session.text.trim()?{sessionId:session.sessionId,text:session.text}:null;
  }
  const api={state,
    selectSession(sessionId){viewSessionId=sessionId;const snapshot=state.getSnapshot();if(snapshot.mode==='call'||starting?.mode==='call'&&!starting.opening.signal.aborted||snapshot.sessionId===sessionId)return;if(snapshot.mode!=='idle'||snapshot.readEnabled)void endMedia();++generation;patch({sessionId,transcript:'',transcriptId:null,error:'',recoveryText:recoveries.get(sessionId)||'',recoverySessionId:recoveries.has(sessionId)?sessionId:null,canRetry:false,conversationMessages:[],conversationRevision:0});},
    releaseSessionView(sessionId){if(viewSessionId===sessionId)viewSessionId=null;const snapshot=state.getSnapshot();if(snapshot.mode==='call'||starting?.mode==='call'&&!starting.opening.signal.aborted)return;if(snapshot.sessionId===sessionId||starting?.sessionId===sessionId)return endMedia();},
    async readConversationHistory(sessionId,{before,signal}={}){
      const snapshot=state.getSnapshot();
      const response=await request(url('api/voice/conversation'),{method:'POST',credentials:'same-origin',signal,headers:{'content-type':'application/json'},body:JSON.stringify({action:'history',sessionId,...(snapshot.mode==='call'&&snapshot.sessionId===sessionId?{mode:snapshot.conversationMode}:{}),...(before!==undefined?{before}:{})})});
      const result=await response.json();if(!response.ok)throw Error(result.error||'无法读取语音记录');
      return {...result,before:result.before??result.nextBefore,items:result.items||readVoiceTranscript(result.events||result.entries||[])};
    },
    async retryPending(){if(state.getSnapshot().mode!=='call'||delivering)return;if(inputActive||awaitingFinal.size)throw Error('请等待当前语音识别完成后重试');clearContinuation();try{await deliver(generation,inputSequence,true);}catch(error){fail(error);throw error;}},
    discardRecovery(){const snapshot=state.getSnapshot(),sessionId=snapshot.recoverySessionId||snapshot.sessionId;recoveryVersions.set(sessionId,(recoveryVersions.get(sessionId)||0)+1);recover(sessionId,'');if(snapshot.mode==='call'){clearContinuation();pendingTurnId=null;inputSequence++;pendingText.clear();partialText.clear();uncertainDelivery=null;waitingForInteraction=false;}patch({canRetry:false,turnPending:false});flushPublications();},
    recoverToDraft(inputActions){const snapshot=state.getSnapshot();if(snapshot.mode!=='idle')throw Error('请先结束语音再恢复草稿');if(!snapshot.recoveryText||snapshot.recoverySessionId!==snapshot.sessionId)return false;if(!inputActions)throw Error('未发送的语音文字已保留，请返回原对话继续');const span=inputActions.captureInsertion();if(!inputActions.insertText(snapshot.recoveryText,{...span,start:span.end}))throw Error('草稿暂时无法编辑，语音文字已保留，请稍后重试');inputActions.persistDraft();api.discardRecovery();return true;},
    async load(){const sequence=++loadSequence;try{const {config}=await requestJson('config');if(sequence===loadSequence&&!disposed&&!configuring)await applyConfig(config);return state.getSnapshot().config||config;}catch(error){if(sequence===loadSequence&&!disposed&&!configuring)fail(error);throw error;}},
    async configure(config){const sequence=++configureSequence;++loadSequence;configuring++;try{const result=await requestJson('configure',{config});if(sequence===configureSequence&&!disposed){++loadSequence;await applyConfig(result.config);}return result.config;}finally{configuring--; }},
    setMuted(value){if(state.getSnapshot().mode!=='call')return;const muted=!!value;if(muted===state.getSnapshot().muted)return;clearContinuation();capture?.setMuted?.(muted);inputSequence++;inputActive=false;awaitingFinal.clear();partialText.clear();patch({muted,level:0,transcript:visibleTranscript(),turnPending:false,canRetry:!!pendingTranscript()});flushPublications();refreshPhase();},
    toggleMute(){api.setMuted(!state.getSnapshot().muted);},
    async toggleRead(sessionId){
      if(state.getSnapshot().mode==='call'||starting?.mode==='call'&&!starting.opening.signal.aborted)return;
      if(state.getSnapshot().readEnabled){stopSpeech();patch({readEnabled:false});return;}
      const config=state.getSnapshot().config||await api.load();if(!config.readAloud||!config.tts.configured)throw Error('请先在「设置 → 媒体 → 语音」配置并开启朗读');
      if(!protocolDescriptor('tts',config.tts.protocol))throw Error('请在「设置 → 媒体 → 语音」点击自动匹配并保存语音合成协议');
      const gen=generation;attach(sessionId);try{await ensurePlayer();if(gen!==generation||disposed)return;ensureQueue();resetOpening();chunker=makeChunker();blocked=false;patch({readEnabled:true,sessionId,error:''});}catch(error){await endMedia();throw error;}
    },
    startDictation:args=>begin(args,'dictation'),
    keepDictation(inputActions){const session=dictation;if(!session?.held)return;session.held=false;patch({dictationHold:false});session.keep?.(inputActions);},
    async stopDictation(){const held=await finishDictation();if(held?.text)recover(held.sessionId,held.text);},
    async sendDictation(){
      const held=await finishDictation();if(!held?.text)return {sent:false};
      const {sessionId,text}=held;
      // Spoken words are never dropped: whatever cannot be sent returns to the draft.
      if(status(sessionId)?.pendingInteraction){recover(sessionId,text);throw Error('请先在对话中完成授权或交互；语音文字已保留到草稿');}
      const scope=ctx.sessions.scope(sessionId);if(!scope){recover(sessionId,text);throw Error('对话已经关闭，语音文字已保留');}
      try{await scope.get('conversation').send(text);}catch{recover(sessionId,text);throw Error('发送失败，语音文字已保留到草稿');}
      return {sent:true};
    },
    startCall:args=>begin(args,'call'),
    hangup:()=>endMedia(undefined,true),
    async dispose(){disposed=true;readBeforeCall=false;loadSequence++;environment?.removeEventListener('focus',reload);globalThis.document?.removeEventListener?.('visibilitychange',visible);unschedule(chunkTimer);await endMedia();statusOff();environment?.removeEventListener('pagehide',leave);environment?.removeEventListener('offline',leave);}
  };
  function endMedia(preserveStart,userInitiated=false){
    if(starting!==preserveStart)starting?.opening.abort();
    // Words buffered by a held dictation survive any teardown as a recoverable draft.
    if(dictation&&dictation!==preserveStart?.dictation){const lost=dictation;dictation=null;if(lost.held&&lost.text.trim())recover(lost.sessionId,lost.text);}
    if(ending)return ending;
    const notifyEnd=userInitiated&&callConnected;callConnected=false;const oldCue=connectionCue;connectionCue=null;oldCue?.cancel();
    const endGeneration=++generation;clearContinuation();pendingTurnId=null;inputSequence++;inputActive=false;waitingForInteraction=false;unschedule(heartbeat);const snapshot=state.getSnapshot(),oldCapture=capture,oldLease=lease,oldQueue=queue,oldPlayer=player,oldConversation=callConversation,oldReference=callReference,restoreRead=readBeforeCall;capture=null;lease=null;callConversation=null;callReference=null;uncertainDelivery=null;conversationInterrupted=false;readBeforeCall=false;
    stopSpeech();settleInterruptedMessages();queue=null;player=null;played.clear();pendingText.clear();partialText.clear();awaitingFinal.clear();pendingPublications.clear();pendingPublicationCharacters=0;interruptedSpeech.clear();stopFeed?.();stopFeed=null;binding=null;patch({mode:'idle',phase:'idle',level:0,playbackLevel:0,muted:false,readEnabled:false,dictationHold:false,turnPending:false,canRetry:false,conversationMode:'direct',conversationReason:'',conversationConfigurable:false,replyText:''});
    const run=(async()=>{
      try{
        await Promise.allSettled([oldCapture?.dispose(),oldQueue?.dispose(),oldPlayer?.dispose(),oldConversation?.dispose()]);
        if(oldLease)await requestJson('call.end',{sessionId:oldLease.sessionId,deviceId,callId:oldLease.callId}).catch(()=>{});
      }finally{oldReference?.release();}
    })();
    if(notifyEnd){try{playCue('disconnected');}catch{}}
    const finished=run.then(async()=>{
      // Read-aloud opens a new media lifecycle. Its own failure cleanup must
      // not await the hangup promise that is currently restoring it.
      if(ending===finished)ending=null;
      if(restoreRead&&endGeneration===generation&&viewSessionId===snapshot.sessionId&&snapshot.sessionId===state.getSnapshot().sessionId&&!disposed&&state.getSnapshot().config?.readAloud){patch({readEnabled:false});await api.toggleRead(snapshot.sessionId).catch(fail);}
    }).finally(()=>{if(ending===finished)ending=null;});ending=finished;return finished;
  }
  let chunkTimer=null;
  function clearChunkTimer(){if(chunkTimer!==null){unschedule(chunkTimer);chunkTimer=null;}}
  function scheduleChunkFlush(){
    if(chunkTimer!==null||!chunker?.flushIdle||!chunker.raw&&!chunker.text)return;
    chunkTimer=schedule(()=>{
      if(blocked||!(state.getSnapshot().readEnabled||state.getSnapshot().mode==='call')){clearChunkTimer();return;}
      for(const text of chunker.flushIdle(clock()))enqueue(text);
      if(!chunker.raw&&!chunker.text)clearChunkTimer();
    },25);chunkTimer?.unref?.();
  }
  const reload=()=>{void api.load().catch(()=>{});},visible=()=>{if(globalThis.document?.visibilityState==='visible')reload();};environment?.addEventListener('focus',reload);globalThis.document?.addEventListener?.('visibilitychange',visible);
  const leave=()=>{void endMedia();};environment?.addEventListener('pagehide',leave);environment?.addEventListener('offline',leave);return api;
}
