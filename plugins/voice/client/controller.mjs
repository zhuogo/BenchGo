import { readVoiceEvents, RealtimeRecognizer } from './asr.mjs';
import { Capture, PCMPlayer } from './media.mjs';
import { SpeakableChunker, SpeechQueue } from './speech.mjs';
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
  const makeCapture=deps.createCapture||(options=>new Capture(options)),makePlayer=deps.createPlayer||(options=>new PCMPlayer(options)),makeQueue=deps.createQueue||(options=>new SpeechQueue(options)),makeChunker=deps.createChunker||(()=>new SpeakableChunker());
  const makeConversation=deps.createConversation||(options=>new VoiceConversation(options));
  const wait=deps.wait||(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
  const schedule=deps.setInterval||globalThis.setInterval,unschedule=deps.clearInterval||globalThis.clearInterval;
  const state=observable({config:null,mode:'idle',phase:'idle',sessionId:null,error:'',transcript:'',transcriptId:null,recoveryText:'',recoverySessionId:null,canRetry:false,level:0,playbackLevel:0,muted:false,readEnabled:false,conversationMode:'direct',replyText:'',conversationMessages:[],conversationRevision:0});
  const deviceId=crypto.randomUUID(),played=new Set(),pendingText=new Map(),awaitingFinal=new Set(),recoveries=new Map(),deliveries=new Set();
  const recoveryVersions=new Map();let loadSequence=0,configureSequence=0,configuring=0;
  let delivering=null,waitingForInteraction=false;
  let callConversation=null,conversationPhase='listening',uncertainDelivery=null,readBeforeCall=false;
  let speechMessageId=null;
  let capture,player,queue,chunker,stopFeed,lease,heartbeat,binding,startAbort,generation=0,inputSequence=0,latestUtterance=0,inputActive=false,speaking=false,blocked=false,disposed=false,stopping=false,starting=false,ending=null;
  const patch=value=>{if(!disposed)state.patch(value);};
  function recordMessage(role,id,text,fields={},append=false){
    const current=state.getSnapshot(),messages=[...current.conversationMessages],index=messages.findIndex(row=>row.id===id);
    const previous=index>=0?messages[index]:{id,role,text:'',time:Date.now(),callId:lease?.callId};
    const row={...previous,...fields,text:append?previous.text+text:text};
    if(index>=0)messages[index]=row;else messages.push(row);
    patch({conversationMessages:messages,conversationRevision:current.conversationRevision+(row.partial?0:1)});
  }
  function settleInterruptedMessages(){const current=state.getSnapshot();if(current.conversationMessages.some(row=>row.partial))patch({conversationMessages:current.conversationMessages.map(row=>row.partial?{...row,partial:false,interrupted:true}:row),conversationRevision:current.conversationRevision+1});}
  const recover=(sessionId,text)=>{if(text)recoveries.set(sessionId,text);else recoveries.delete(sessionId);if(state.getSnapshot().sessionId===sessionId)patch({recoveryText:text,recoverySessionId:text?sessionId:null});};
  const pendingTranscript=()=>[...pendingText.entries()].sort((a,b)=>a[0]-b[0]).map(x=>x[1]).filter(Boolean).join('\n');
  const fail=error=>patch({error:error?.message||String(error)});
  const callHeaders=()=>lease?{'x-voice-call-id':lease.callId}:{};
  const status=(sessionId=state.getSnapshot().sessionId)=>ctx.uiSession.sessionStatus.getSnapshot().get(sessionId);
  const refreshPhase=()=>patch({phase:state.getSnapshot().phase==='starting'&&starting?'starting':speaking?'speaking':awaitingFinal.size&&!inputActive?'transcribing':callConversation?conversationPhase:status()?.pendingInteraction?'waiting':status()?.running?'thinking':state.getSnapshot().mode!=='idle'?'listening':'idle'});
  const statusOff=ctx.uiSession.sessionStatus.subscribe(()=>{
    refreshPhase();
    if(waitingForInteraction&&!status()?.pendingInteraction&&!status()?.running){
      const gen=generation,sequence=inputSequence;
      void Promise.resolve().then(()=>deliver(gen,sequence)).catch(error=>{if(gen===generation)fail(error);});
    }
  });
  function stopSpeech() {clearChunkTimer();blocked=true;speaking=false;capture?.setPlaybackActive?.(false);patch({playbackLevel:0});chunker=makeChunker();queue?.cancel();played.clear();refreshPhase(); }
  function ensurePlayer() {
    if(!player){const current=makePlayer({workletURL:url('api/voice/worklet'),onError:error=>{if(player===current)fail(error);},onPlaybackStart:()=>{if(player!==current)return;speaking=true;capture?.setPlaybackActive?.(true);refreshPhase();},onPlaybackIdle:()=>{if(player!==current)return;speaking=false;capture?.setPlaybackActive?.(false);patch({playbackLevel:0});refreshPhase();},onMetrics:metrics=>{if(player===current&&metrics.level!==undefined)patch({playbackLevel:metrics.level});},onPlayed:id=>{if(player!==current)return;played.delete(id);if(!played.size&&!queue?.items.length){speaking=false;capture?.setPlaybackActive?.(false);refreshPhase();}}});player=current;}
    return player.start();
  }
  function ensureQueue() {
    if(!queue)queue=makeQueue({player,synthesize:async(text,signal)=>{
      const response=await request(url('api/voice/speech'),{method:'POST',credentials:'same-origin',signal,headers:{'content-type':'application/json',...callHeaders()},body:JSON.stringify({text})});
      if(!response.ok){const result=await response.json();throw Error(result.error||'朗读失败');}return response;
    },onError:error=>{stopSpeech();fail(error);}});
  }
  function enqueue(text) {if(played.size>=128){fail(Error('播放确认队列已满，请停止后重新朗读'));return;}if(queue.push(text)){played.add(queue.sequence);refreshPhase();} }
  function pushText(delta,event) {
    if(callConversation)return;
    if(state.getSnapshot().mode==='call'&&delta&&!blocked){const sourceId=transcriptSourceId(event);speechMessageId=sourceId||speechMessageId||crypto.randomUUID();recordMessage('assistant',speechMessageId,delta,{sourceId,messageId:speechMessageId,partial:true},true);patch({replyText:state.getSnapshot().replyText+delta});}
    pushSpeech(delta);
  }
  function pushSpeech(delta) {
    if(blocked||!(state.getSnapshot().readEnabled||state.getSnapshot().mode==='call')||!delta)return;
    ensureQueue();chunker||=makeChunker();for(const text of chunker.push(delta))enqueue(text);scheduleChunkFlush();
  }
  function attach(sessionId) {
    if(binding?.sessionId===sessionId)return;const next=ctx.sessions.binding(sessionId);if(!next)throw Error('请先打开一个可用对话');if(binding)stopSpeech();stopFeed?.();binding=next;
    const source=binding.eventSource;
    const feed=new AgentFeed({onText:pushText,onRecord:event=>{
      if(callConversation||state.getSnapshot().mode!=='call')return;
      const data=event.data||{},sourceId=transcriptSourceId(event),role=event.type==='user/message'?'user':'assistant';
      const text=transcriptMessage(event)?.text;
      if(role==='assistant'&&data.interrupted){const row=state.getSnapshot().conversationMessages.find(row=>row.sourceId===sourceId);if(row)recordMessage(role,row.id,row.text,{partial:false,interrupted:true});return;}
      if(text?.trim())recordMessage(role,sourceId,text,{sourceId,seq:event.seq,partial:false});
    },onStart:()=>{if(callConversation)return;speechMessageId=null;patch({replyText:''});if(!inputActive&&!awaitingFinal.size)blocked=false;chunker=makeChunker();refreshPhase();},onReset:()=>{if(!callConversation)stopSpeech();},onEnd:event=>{
      if(callConversation)return;
      const reason=event?.data?.reason;
      if(!inputActive&&!awaitingFinal.size&&(state.getSnapshot().readEnabled||state.getSnapshot().mode==='call')&&['blocked','error','interrupted'].includes(reason?.kind)){
        stopSpeech();settleInterruptedMessages();
        const message=reason.kind==='blocked'?'原会话执行被拦截，尚未生成回复，请查看原会话（BLOCKED）':reason.kind==='interrupted'?'原会话运行中断，请返回原会话查看并重试':'原会话执行失败，请返回原会话查看错误详情';
        fail(Error(message));return;
      }
      if(speechMessageId){const row=state.getSnapshot().conversationMessages.find(row=>row.id===speechMessageId);if(row)recordMessage('assistant',speechMessageId,row.text,{partial:false});}
      if(!blocked&&(state.getSnapshot().readEnabled||state.getSnapshot().mode==='call')) {ensureQueue();for(const text of (chunker||=makeChunker()).finish())enqueue(text);}
      clearChunkTimer();refreshPhase();
    }});
    feed.baseline(source.getSnapshot());stopFeed=source.subscribe(()=>feed.accept(source.getSnapshot()));patch({sessionId});
  }
  async function cancelAgent(sessionId=state.getSnapshot().sessionId) {if(status(sessionId)?.pendingInteraction)return false;const scope=ctx.sessions.scope(sessionId);if(scope&&status(sessionId)?.running)await scope.get('conversation').cancel();return true;}
  async function deliver(gen,sequence,manual=false) {
    const claim=gen+':'+sequence;if(deliveries.has(claim))return;deliveries.add(claim);delivering=claim;const deliverySession=state.getSnapshot().sessionId,recoveryVersion=recoveryVersions.get(deliverySession)||0;
    try{
    const valid=()=>gen===generation&&sequence===inputSequence&&state.getSnapshot().mode==='call'&&!inputActive&&!awaitingFinal.size;if(!valid())return;
    let entries=[...pendingText.entries()].sort((a,b)=>a[0]-b[0]),text=entries.map(x=>x[1]).filter(Boolean).join('\n');if(!text.trim())return;
    if(callConversation){
      if(uncertainDelivery&&!manual)throw Error('上一段交接尚未确认，请先重试核对或保留文字；不会自动重复发送');
      const current=callConversation;
      if(uncertainDelivery){entries=uncertainDelivery.entries;text=uncertainDelivery.text;}
      const requestId=uncertainDelivery?.requestId||crypto.randomUUID();
      recordMessage('user',requestId,text,{requestId,transcriptIds:entries.map(([id])=>`voice-input:${gen}:${id}`),partial:false});
      uncertainDelivery={requestId,text,entries};conversationPhase='thinking';patch({phase:'thinking',error:''});
      const result=await current.send(text,requestId);
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
    if(!valid()||awaiting())return;waitingForInteraction=false;blocked=false;chunker=makeChunker();patch({transcript:text,phase:'thinking',error:''});
    for(const [id,value]of entries)if(pendingText.get(id)===value)pendingText.delete(id);
    recover(deliverySession,pendingTranscript());try{await scope.get('conversation').send(text);if(gen===generation&&sequence===inputSequence)patch({transcriptId:null});}catch(error){if((recoveryVersions.get(deliverySession)||0)===recoveryVersion){if(gen===generation){for(const [id,value]of entries)if(!pendingText.has(id))pendingText.set(id,value);}else recover(deliverySession,[recoveries.get(deliverySession),text].filter(Boolean).join('\n'));}throw error;}
    }finally{deliveries.delete(claim);if(delivering===claim)delivering=null;if(gen===generation){const text=pendingTranscript();recover(deliverySession,text);patch({canRetry:!!text&&state.getSnapshot().mode==='call'});}}
  }
  async function begin({sessionId,inputActions},mode) {
    if(recoveries.has(sessionId)){if(state.getSnapshot().mode==='idle')api.selectSession(sessionId);throw Error('请先恢复或丢弃上次未发送的转录');}
    if(disposed)throw Error('语音插件已停用');if(starting)throw Error('语音正在启动');if(stopping)throw Error('正在释放上一段语音，请稍后重试');starting=true;let gen,createdCapture;
    try{
    if(ending)await ending;if(capture)await api.hangup();gen=++generation;const opening=new AbortController();startAbort=opening;
    let config=state.getSnapshot().config||await api.load();if(gen!==generation||disposed)return;
    if(!protocolDescriptor('asr',config.asr?.protocol)||mode==='call'&&!protocolDescriptor('tts',config.tts?.protocol))throw Error('请在「设置 → 媒体 → 语音」点击自动匹配并保存协议，或在高级设置中选择具体协议');
    if(!config[mode==='call'?'call':'dictation']||!config.asr.configured||mode==='call'&&!config.tts.configured)throw Error('请先在「设置 → 媒体 → 语音」启用功能并配置模型');
    if(mode==='call'){const reason=callStreamingReason(config);if(reason)throw Error(reason);}
    attach(sessionId);patch({mode,sessionId,phase:'starting',error:'',transcript:'',transcriptId:null});
    patch({recoveryText:recoveries.get(sessionId)||'',recoverySessionId:recoveries.has(sessionId)?sessionId:null,canRetry:false,muted:false,playbackLevel:0});pendingText.clear();awaitingFinal.clear();latestUtterance=0;inputActive=false;inputSequence++;
    if(mode==='call'){
      readBeforeCall=state.getSnapshot().readEnabled;
      const [audioResult,leaseResult]=await Promise.allSettled([ensurePlayer(),requestJson('call.start',{sessionId,deviceId},opening.signal)]);
      if(leaseResult.status==='rejected')throw leaseResult.reason;const result=leaseResult.value;
      if(result.config){config=result.config;patch({config});}
      if(gen!==generation||disposed){await requestJson('call.end',{sessionId,deviceId,callId:result.call.callId});return;}lease={...result.call,sessionId};if(audioResult.status==='rejected')throw audioResult.reason;const currentLease=lease;
      const conversationMode=result.conversation?.mode||'direct';
      if(!['direct','native','enhanced'].includes(conversationMode))throw Error('通话接入模式不可用');
      patch({conversationMode,replyText:''});uncertainDelivery=null;conversationPhase='listening';
      if(conversationMode==='enhanced'){
        const current=makeConversation({request,endpoint:url('api/voice/conversation'),identity:{sessionId,deviceId,callId:lease.callId},
          onEvent:event=>{
            if(gen!==generation||callConversation!==current)return;
            if(event.type==='start'){blocked=inputActive||awaitingFinal.size>0;chunker=makeChunker();conversationPhase='thinking';patch({replyText:''});}
            if(event.type==='text'){patch({replyText:(state.getSnapshot().replyText+event.text).slice(-4000)});recordMessage('assistant',event.messageId,event.text,{messageId:event.messageId,requestId:event.requestId,partial:true},true);pushSpeech(event.text);}
            if(event.type==='end'){const row=state.getSnapshot().conversationMessages.find(row=>row.id===event.messageId);if(row)recordMessage('assistant',event.messageId,row.text,{partial:false});if(!blocked){ensureQueue();for(const text of (chunker||=makeChunker()).finish())enqueue(text);}clearChunkTimer();conversationPhase='listening';refreshPhase();}
            if(event.type==='state'){if(['thinking','listening','waiting'].includes(event.phase))conversationPhase=event.phase;refreshPhase();}
            if(event.type==='config'||event.type==='settings'){if(event.config)void applyConfig(event.config).catch(fail);}
            if(event.type==='error'){fail(Error(event.error||'语音交互失败'));conversationPhase='listening';refreshPhase();}
          },onError:error=>{if(gen===generation){fail(error);void api.hangup();}}});
        callConversation=current;await current.start();
        if(gen!==generation||disposed){await current.dispose();return;}
      }
      heartbeat=schedule(()=>{void requestJson('call.heartbeat',{sessionId,deviceId,callId:currentLease.callId}).catch(error=>{if(lease===currentLease){fail(error);void api.hangup();}});},15000);
    }
    patch({mode,sessionId,phase:'starting',error:'',transcript:''});blocked=false;
    let span=mode==='dictation'?inputActions.captureInsertion():null,inserted='',finalText='',draftConflict=false;
    const writeDraft=text=>{
      if(gen!==generation||text===inserted||draftConflict)return;
      if(!inputActions.insertText(text,span)){draftConflict=true;patch({error:'草稿已被修改，请复制语音栏转录文字后插入',transcript:text});recover(sessionId,text);return;}
      inserted=text;const next=inputActions.captureInsertion();span={start:span.start,end:span.start+text.length,draftRev:next.draftRev};inputActions.persistDraft();
    };
    const asrProtocol=config.asr.protocol;
    const realtime=asrProtocol==='openai-websocket'?new RealtimeRecognizer({request,endpoint:url,headers:callHeaders,openSocket:path=>ctx.connection.openWebSocket(path),onWarning:warning=>{if(gen===generation)patch({error:warning.message});},onError:error=>{if(gen===generation){fail(error);void api.hangup();}}}):null;
    if(realtime){createdCapture={dispose:()=>realtime.close()};capture=createdCapture;await realtime.start();if(gen!==generation){await realtime.close();return;}}
    createdCapture=makeCapture({realtime,parallel:['transcriptions-sse','stepfun-sse'].includes(asrProtocol),workletURL:url('api/voice/worklet'),transcribe:async(blob,signal,onPartial)=>{
      const response=await request(url('api/voice/transcribe'),{method:'POST',credentials:'same-origin',signal,headers:{'content-type':'audio/wav',...callHeaders()},body:blob});
      if(response.headers.get('content-type')?.includes('application/x-ndjson')){let text='',final=false;await readVoiceEvents(response,signal,event=>{if(event.type==='partial'){text=event.text;onPartial?.(text);}if(event.type==='final'){text=event.text;final=true;}});if(!final)throw Error('识别连接在最终结果前关闭');return {text};}
      const result=await response.json();if(!response.ok)throw Error(result.error||'转录失败');return result;
    },onLevel:level=>{if(gen===generation)patch({level});},onSpeechStart:id=>{if(gen!==generation)return;latestUtterance=id??latestUtterance+1;patch({transcriptId:`voice-input:${gen}:${latestUtterance}`,transcript:pendingTranscript()});awaitingFinal.add(latestUtterance);inputActive=true;inputSequence++;if(mode==='call'){stopSpeech();settleInterruptedMessages();const cancel=callConversation?callConversation.interrupt():cancelAgent(sessionId);void cancel.catch(error=>{if(gen===generation)fail(error);});}patch({phase:status(sessionId)?.pendingInteraction?'waiting':'listening'});},
    onSpeechEnd:(id,meta={})=>{if(gen!==generation)return;if(id===latestUtterance)inputActive=false;if(meta.cancelled){awaitingFinal.delete(id);pendingText.delete(id);}refreshPhase();},
    onPartial:(text,meta={})=>{if(gen!==generation)return;if(mode==='dictation'){const combined=joinTranscript(finalText,text);patch({transcript:combined});if(draftConflict)recover(sessionId,combined);writeDraft(combined);}else if((meta.utteranceId??latestUtterance)===latestUtterance)patch({transcript:[...pendingText.values(),text].filter(Boolean).join('\n')});},
    onFinal:(text,meta={})=>{if(gen!==generation)return;const id=meta.utteranceId??latestUtterance;awaitingFinal.delete(id);if(id===latestUtterance)inputActive=false;if(mode==='dictation'){finalText=joinTranscript(finalText,text);patch({transcript:finalText});if(draftConflict)recover(sessionId,finalText);writeDraft(finalText);}else{pendingText.set(id,text);const pending=[...pendingText.entries()].sort((a,b)=>a[0]-b[0]).map(x=>x[1]).join('\n');patch({transcript:pending});recover(sessionId,pending);if(!inputActive&&!awaitingFinal.size)void deliver(gen,inputSequence).catch(error=>{if(gen===generation)fail(error);});}},
    onError:error=>{if(gen===generation){if(mode==='call'){const text=state.getSnapshot().transcript;if(text?.trim())recover(sessionId,text);}fail(error);void api.hangup();}}});
    capture=createdCapture;await createdCapture.start();if(gen!==generation||disposed){await createdCapture.dispose();return;}patch({phase:'listening'});blocked=false;
    }catch(error){if(gen===generation){await api.hangup();throw error;}await createdCapture?.dispose();if(error?.name!=='AbortError')throw error;}finally{startAbort=null;starting=false;}
  }
  async function applyConfig(config){const previous=state.getSnapshot().config,snapshot=state.getSnapshot();patch({config});if(!previous)return;const changed=key=>JSON.stringify(endpointRoute(previous[key]))!==JSON.stringify(endpointRoute(config[key]));if(snapshot.mode!=='idle'&&(changed('asr')||snapshot.mode==='call'&&(snapshot.conversationMode!=='native'&&changed('conversation')||!config.call||callStreamingReason(config))||snapshot.mode==='dictation'&&!config.dictation)){await api.hangup();return;}if(ttsRoute(previous.tts)!==ttsRoute(config.tts)||snapshot.mode!=='call'&&previous.readAloud&&!config.readAloud){stopSpeech();if(!config.readAloud||!config.tts?.configured)patch({readEnabled:false});}if(snapshot.mode==='call'&&!config.tts?.configured)await api.hangup();}
  const api={state,
    selectSession(sessionId){const snapshot=state.getSnapshot();if(snapshot.sessionId===sessionId)return;if(snapshot.mode!=='idle'||snapshot.readEnabled)void api.hangup();++generation;patch({sessionId,transcript:'',transcriptId:null,error:'',recoveryText:recoveries.get(sessionId)||'',recoverySessionId:recoveries.has(sessionId)?sessionId:null,canRetry:false,conversationMessages:[],conversationRevision:0});},
    async readConversationHistory(sessionId,{before,signal}={}){
      const response=await request(url('api/voice/conversation'),{method:'POST',credentials:'same-origin',signal,headers:{'content-type':'application/json'},body:JSON.stringify({action:'history',sessionId,...(state.getSnapshot().mode==='call'?{mode:state.getSnapshot().conversationMode}:{}),...(before!==undefined?{before}:{})})});
      const result=await response.json();if(!response.ok)throw Error(result.error||'无法读取语音记录');
      return {...result,before:result.before??result.nextBefore,items:result.items||readVoiceTranscript(result.events||result.entries||[])};
    },
    async retryPending(){if(state.getSnapshot().mode!=='call'||delivering)return;if(inputActive||awaitingFinal.size)throw Error('请等待当前语音识别完成后重试');try{await deliver(generation,inputSequence,true);}catch(error){fail(error);throw error;}},
    discardRecovery(){const snapshot=state.getSnapshot(),sessionId=snapshot.recoverySessionId||snapshot.sessionId;recoveryVersions.set(sessionId,(recoveryVersions.get(sessionId)||0)+1);recover(sessionId,'');if(snapshot.mode==='call'){inputSequence++;pendingText.clear();uncertainDelivery=null;waitingForInteraction=false;}patch({canRetry:false});},
    recoverToDraft(inputActions){const snapshot=state.getSnapshot();if(snapshot.mode!=='idle')throw Error('请先结束语音再恢复草稿');if(!snapshot.recoveryText||snapshot.recoverySessionId!==snapshot.sessionId)return false;const span=inputActions.captureInsertion();if(!inputActions.insertText(snapshot.recoveryText,span))throw Error('草稿已变化，请重试或复制文字');inputActions.persistDraft();api.discardRecovery();return true;},
    async load(){const sequence=++loadSequence;try{const {config}=await requestJson('config');if(sequence===loadSequence&&!disposed&&!configuring)await applyConfig(config);return state.getSnapshot().config||config;}catch(error){if(sequence===loadSequence&&!disposed&&!configuring)fail(error);throw error;}},
    async configure(config){const sequence=++configureSequence;++loadSequence;configuring++;try{const result=await requestJson('configure',{config});if(sequence===configureSequence&&!disposed){++loadSequence;await applyConfig(result.config);}return result.config;}finally{configuring--; }},
    setMuted(value){if(state.getSnapshot().mode!=='call')return;const muted=!!value;if(muted===state.getSnapshot().muted)return;capture?.setMuted?.(muted);inputSequence++;inputActive=false;awaitingFinal.clear();patch({muted,level:0,transcript:pendingTranscript(),canRetry:!!pendingTranscript()});refreshPhase();},
    toggleMute(){api.setMuted(!state.getSnapshot().muted);},
    async toggleRead(sessionId){
      if(state.getSnapshot().mode==='call')return;
      if(state.getSnapshot().readEnabled){stopSpeech();patch({readEnabled:false});return;}
      const config=state.getSnapshot().config||await api.load();if(!config.readAloud||!config.tts.configured)throw Error('请先在「设置 → 媒体 → 语音」配置并开启朗读');
      if(!protocolDescriptor('tts',config.tts.protocol))throw Error('请在「设置 → 媒体 → 语音」点击自动匹配并保存语音合成协议');
      const gen=generation;attach(sessionId);try{await ensurePlayer();if(gen!==generation||disposed)return;ensureQueue();chunker=makeChunker();blocked=false;patch({readEnabled:true,sessionId,error:''});}catch(error){await api.hangup();throw error;}
    },
    startDictation:args=>begin(args,'dictation'),
    async stopDictation(){if(state.getSnapshot().mode!=='dictation')return;if(!capture){await api.hangup();return;}const current=capture;stopping=true;try{await current.stop({flush:true});}finally{if(capture===current){capture=null;patch({mode:'idle',phase:'idle'});}stopping=false;}},
    startCall:args=>begin(args,'call'),
    hangup(){
      if(ending)return ending;startAbort?.abort();const endGeneration=++generation;inputSequence++;inputActive=false;waitingForInteraction=false;unschedule(heartbeat);const snapshot=state.getSnapshot(),oldCapture=capture,oldLease=lease,oldQueue=queue,oldPlayer=player,oldConversation=callConversation,restoreRead=readBeforeCall;capture=null;lease=null;callConversation=null;uncertainDelivery=null;readBeforeCall=false;
      stopSpeech();settleInterruptedMessages();queue=null;player=null;played.clear();pendingText.clear();awaitingFinal.clear();stopFeed?.();stopFeed=null;binding=null;patch({mode:'idle',phase:'idle',level:0,playbackLevel:0,muted:false,readEnabled:false,canRetry:false,conversationMode:'direct',replyText:''});
      const run=(async()=>{await Promise.allSettled([oldCapture?.dispose(),oldQueue?.dispose(),oldPlayer?.dispose()]);await oldConversation?.dispose();if(oldLease)await requestJson('call.end',{sessionId:oldLease.sessionId,deviceId,callId:oldLease.callId}).catch(()=>{});if(restoreRead&&endGeneration===generation&&snapshot.sessionId===state.getSnapshot().sessionId&&!disposed&&state.getSnapshot().config?.readAloud){patch({readEnabled:false});await api.toggleRead(snapshot.sessionId).catch(fail);}})();ending=run.finally(()=>{ending=null;});return ending;
    },
    async dispose(){disposed=true;readBeforeCall=false;loadSequence++;environment?.removeEventListener('focus',reload);globalThis.document?.removeEventListener?.('visibilitychange',visible);unschedule(chunkTimer);await api.hangup();statusOff();environment?.removeEventListener('pagehide',leave);environment?.removeEventListener('offline',leave);}
  };
  let chunkTimer=null;
  function clearChunkTimer(){if(chunkTimer!==null){unschedule(chunkTimer);chunkTimer=null;}}
  function scheduleChunkFlush(){
    if(chunkTimer!==null||!chunker?.flushIdle||!chunker.raw&&!chunker.text)return;
    chunkTimer=schedule(()=>{
      if(blocked||!(state.getSnapshot().readEnabled||state.getSnapshot().mode==='call')){clearChunkTimer();return;}
      for(const text of chunker.flushIdle(Date.now()))enqueue(text);
      if(!chunker.raw&&!chunker.text)clearChunkTimer();
    },25);chunkTimer?.unref?.();
  }
  const reload=()=>{void api.load().catch(()=>{});},visible=()=>{if(globalThis.document?.visibilityState==='visible')reload();};environment?.addEventListener('focus',reload);globalThis.document?.addEventListener?.('visibilitychange',visible);
  const leave=()=>{void api.hangup();};environment?.addEventListener('pagehide',leave);environment?.addEventListener('offline',leave);return api;
}
