import { isTranscriptUser } from '../src/transcript-message.mjs';
import { chatPublicationRecordOf, channelMessageRecordOf } from '../../benchgo/shared/public-chat-record.mjs';
import { questionBatch, readBoundQuestionReply } from '../../benchgo/shared/question-reply.mjs';
import { fallbackRequestIds, modelFallbackType, modelFallbackSource } from '../../benchgo/shared/model-fallback.mjs';

/** Only fresh append publications are eligible for automatic speech. */
export class AgentFeed {
  constructor({onText,onPublication,onStart,onEnd,onReset,onRecord,publicOnly=false}={}) { Object.assign(this,{onText,onPublication,onStart,onEnd,onReset,onRecord,publicOnly}); this.attempts=new Map();this.steps=new Map();this.seen=new Set();this.publications=new Set();this.requests=new Map();this.questions=new Map();this.continuations=[];this.publicationEchoes=[];this.fallback=[];this.revision=null;this.restart=false; }
  key(event){return event.data?.attemptId??String(event.data?.turn??'')+':'+String(event.data?.step??'');}
  step(event){const {turn,step}=event.data||{};return turn!==undefined&&step!==undefined?turn+':'+step:undefined;}
  track(event){const key=this.key(event),step=this.step(event);if(step!==undefined)this.steps.set(step,key);return key;}
  forget(key){this.attempts.delete(key);for(const [step,id]of this.steps)if(id===key)this.steps.delete(step);}
  clear(){this.attempts.clear();this.steps.clear();this.publicationEchoes=[];this.fallback=[];}
  isPublicOnly(){return typeof this.publicOnly==='function'?this.publicOnly():this.publicOnly;}
  observe(event){
    // Reuse the host's exact persisted-fallback identity rules. Retain only
    // bounded metadata, never fallback prompts or private execution content.
    if(['turn/start','turn/end','user/message',modelFallbackType].includes(event.type)){
      const row=event.data||{},source=row.source&&{kind:row.source.kind,fallbackId:row.source.fallbackId};
      this.continuations.push({type:event.type,seq:event.seq,ignorable:event.ignorable,data:{id:row.id,kind:row.kind,requestId:row.requestId,failedTurn:row.failedTurn,turn:row.turn,reason:row.reason,source,
        ...(row.message?{message:{id:row.message.id,source:row.message.source&&{kind:row.message.source.kind,fallbackId:row.message.source.fallbackId}}}:{})}});
      if(this.continuations.length>2048)this.continuations.shift();
    }
    if(event.type==='turn/start'){this.turn=event.data?.turn;this.request=null;this.fallback=[];}
    if(event.type==='tool/call'&&event.data?.name==='ask_user_question'&&!event.data.parentCallId||event.type==='tool/ptc-dispatch'&&event.data?.name==='ask_user_question'&&!event.data.isError){
      const questions=questionBatch(event.data.arguments);if(questions)this.questions.set(String(event.data.subCallId??event.data.callId),questions);
      if(this.questions.size>1024)this.questions.delete(this.questions.keys().next().value);
    }
    if(event.type==='user/message'&&event.data?.id&&(event.surfaceOp===undefined||event.surfaceOp==='append')){
      const request={id:event.data.id,source:event.data.source};
      if(request.source?.kind===modelFallbackSource){const original=fallbackRequestIds([...this.continuations].sort((a,b)=>a.seq-b.seq)).get(request.id);if(original)this.request=this.requests.get(original)||null;return;}
      if(!['user','user-question-reply','benchgo-ticket-reply','benchgo-ticket-state','benchgo-execution-input'].includes(request.source?.kind))return;
      if(request.source.kind==='user-question-reply'&&!readBoundQuestionReply(event.data,this.questions.get(request.source.callId)))return;
      this.requests.set(request.id,request);
      if(this.requests.size>4096)this.requests.delete(this.requests.keys().next().value);
      if(['user','user-question-reply','benchgo-ticket-reply','benchgo-ticket-state','benchgo-execution-input'].includes(request.source?.kind))this.request=request;
    }
  }
  publication(event){return chatPublicationRecordOf(event,this.requests.get(event.data?.requestId));}
  publicationKey(event){return event.type==='plugin:benchgo-plugin/channel-message'?`channel:${event.data.mirrorKey}`:`request:${event.data.requestId}`;}
  rememberPublication(event){const key=this.publicationKey(event);if(this.publications.has(key))return false;this.publications.add(key);if(this.publications.size>4096)this.publications.delete(this.publications.values().next().value);return true;}
  publish(event,text){
    if(!this.rememberPublication(event))return;
    if(this.restart){this.restart=false;this.onStart?.(event);}
    if(event.type==='plugin:benchgo-plugin/chat-publication'){this.publicationEchoes.push(text);if(this.publicationEchoes.length>128)this.publicationEchoes.shift();}
    (this.onPublication||this.onText)?.(text,event);
    this.onRecord?.(event,{role:'assistant',text});
  }
  remember(event){const key=event.type+':'+event.seq+':'+this.key(event);if(this.seen.has(key))return false;this.seen.add(key);if(this.seen.size>4096)this.seen.delete(this.seen.values().next().value);return true;}
  baseline(window) { this.revision=window.revision;this.clear();this.seen.clear();this.publications.clear();this.requests.clear();this.questions.clear();this.continuations=[];this.turn=undefined;this.request=null;this.restart=false;for(const {event}of window.entries||[]){this.observe(event);this.remember(event);if(this.publication(event)||channelMessageRecordOf(event))this.rememberPublication(event);if(event.type==='assistant/live-chunk'&&event.data?.chunk?.type==='text-delta'){const key=this.track(event);this.attempts.set(key,(this.attempts.get(key)||'')+event.data.chunk.text);}if(event.type==='turn/end'){this.turn=undefined;this.request=null;}} }
  accept(window) {
    if(window.revision!==undefined&&window.revision===this.revision)return;this.revision=window.revision;
    const change=window.change;
    if(change.kind==='replace') { this.onReset?.(); this.baseline(window); return; }
    if(change.kind==='prepend'){const turn=this.turn,request=this.request,fallback=this.fallback;for(const {event}of change.entries||[]){this.observe(event);this.remember(event);if(this.publication(event)||channelMessageRecordOf(event))this.rememberPublication(event);}this.turn=turn;this.request=request;this.fallback=fallback;return;}
    if(change.kind==='settle-assistant'&&!change.entry){this.forget(change.attemptId);return;}
    const entries=change.kind==='settle-assistant'?[change.entry].filter(Boolean):change.entries||[];
    for(const {event} of entries) {
      if(!this.remember(event))continue;
      this.observe(event);
      if(event.type==='assistant/live-chunk') {
        if(this.isPublicOnly())continue;
        const {chunk}=event.data;const key=this.track(event);
        if(chunk.type==='text-delta') {if(this.restart){this.restart=false;this.onStart?.(event);}this.attempts.set(key,(this.attempts.get(key)||'')+chunk.text); this.onText?.(chunk.text,event); }
        continue;
      }
      if(event.type==='turn/start'){this.restart=false;this.clear();this.onStart?.();}
      if(isTranscriptUser(event))this.onRecord?.(event);
      const channel=channelMessageRecordOf(event);
      if(channel){
        if(channel.direction==='delivery'&&channel.text.trim())this.publish(event,channel.text);
        else if(this.rememberPublication(event))this.onRecord?.(event,{role:'user',text:channel.text});
        continue;
      }
      if(this.publication(event)) {
        // SuperAgent publishes its human-facing reply as a plugin record, not as
        // assistant text; read that text or read-aloud stays silent there.
        this.publish(event,event.data.text);
        continue;
      }
      if(event.type==='llm/retry'||event.type==='assistant/attempt') { this.onReset?.(); this.clear();this.restart=true; }
      if(event.type==='assistant/message') {
        if(event.surfaceOp!==undefined&&event.surfaceOp!=='append')continue;
        const text=(event.data.message?.content||[]).filter(x=>x.type==='text').map(x=>x.text).join('');
        if(this.isPublicOnly()){
          if(event.data.turn===this.turn&&!event.data.interrupted&&!event.data.parentCallId&&event.data.message?.source?.kind==='model'&&text.trim())this.fallback.push({event,text});
          continue;
        }
        // Successful messages append before step/end retires the transient attempt.
        // Durable messages carry turn/step, while live chunks carry attemptId.
        const key=change.kind==='settle-assistant'?change.attemptId??this.key(event):this.steps.get(this.step(event))??this.key(event),prefix=this.attempts.get(key)||'';
        // Consume one durable mirror, not every future message with the same
        // wording. Separate publications may arrive before their mirrors.
        const echo=this.publicationEchoes.indexOf(text);
        if(echo>=0){this.publicationEchoes.splice(echo,1);this.forget(key);continue;}
        if(!event.data.interrupted&&text.startsWith(prefix)){if(this.restart){this.restart=false;this.onStart?.(event);}if(text.length>prefix.length)this.onText?.(text.slice(prefix.length),event);}
        this.onRecord?.(event);
        this.forget(key);
      }
      if(event.type==='turn/end'){
        if(this.isPublicOnly()&&event.data?.turn===this.turn&&event.data?.reason?.kind==='completed'&&['user','user-question-reply'].includes(this.request?.source?.kind)&&!this.publications.has(`request:${this.request.id}`)&&this.fallback.length){
          const text=this.fallback.map(row=>row.text).join('\n\n');
          const projected={...event,data:{...event.data,requestId:this.request.id}};
          this.rememberPublication(projected);
          (this.onPublication||this.onText)?.(text,projected);this.onRecord?.(projected,{role:'assistant',text});
        }
        this.fallback=[];this.turn=undefined;this.request=null;this.onEnd?.(event);
      }
    }
  }
}
