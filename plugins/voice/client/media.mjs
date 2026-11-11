import { createNoiseSuppressor } from './noise.mjs';
import { waitForMedia } from './media-startup.mjs';
const RATE=24000;
// Send the first HTTP fragment earlier; keep later fragments longer so the
// bounded two-request pipeline does not accumulate provider round-trip delay.
export const HTTP_FIRST_CHUNK_SECONDS=.9;
export const HTTP_CHUNK_SECONDS=1.5;
let microphoneOwner=null;
const abortError=()=>new DOMException('Voice operation cancelled','AbortError');
export function pcmWav(frames,minimumSamples=0){
  const length=Math.max(minimumSamples,frames.reduce((n,f)=>n+f.length,0)),bytes=new ArrayBuffer(44+length*2),v=new DataView(bytes);
  const str=(p,s)=>{for(let i=0;i<s.length;i++)v.setUint8(p+i,s.charCodeAt(i));};
  str(0,'RIFF');v.setUint32(4,36+length*2,true);str(8,'WAVE');str(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,RATE,true);v.setUint32(28,RATE*2,true);v.setUint16(32,2,true);v.setUint16(34,16,true);str(36,'data');v.setUint32(40,length*2,true);
  let p=44;for(const f of frames)for(const x of f){v.setInt16(p,x,true);p+=2;}
  return new Blob([bytes],{type:'audio/wav'});
}
const join=(a,b)=>!a?b:!b?a:a+(/[\p{Script=Han}]$/u.test(a)||/^[\p{Script=Han}，。！？、]/u.test(b)?'':' ')+b;
export class Capture {
  constructor({transcribe,realtime,parallel=false,onPartial=()=>{},onFinal=()=>{},onSpeechStart=()=>{},onSpeechEnd=()=>{},onLevel=()=>{},onError=()=>{},silenceMs=320,workletURL='api/voice/worklet',createNoise=createNoiseSuppressor,startupTimeoutMs=20000}={}){
    Object.assign(this,{transcribe,realtime,parallel,onPartial,onFinal,onSpeechStart,onSpeechEnd,onLevel,onError,silenceMs,workletURL,createNoise,startupTimeoutMs});this.levelAt=0;this.generation=0;this.active=false;this.pending=Promise.resolve();this.controllers=new Set();this.pre=[];this.muted=false;this.playbackActive=false;this.echoUntil=0;this.attack=0;this.attackGap=0;this.backlog=0;this.segment=null;this.stopping=null;this.utteranceId=0;this.finals=new Set();this.tasks=new Set();this.finalChain=Promise.resolve();this.asrActive=0;this.asrWaiters=[];
  }
  async start(){
    if(this.active)return;if(this.stopping)await this.stopping;if(microphoneOwner&&microphoneOwner!==this)throw Error('麦克风已被另一个语音入口使用');
    if(!globalThis.navigator?.mediaDevices?.getUserMedia)throw Error('麦克风需要 HTTPS 或 localhost 安全环境');
    microphoneOwner=this;this.active=true;this.lastFinal='';const generation=++this.generation,initializing=new AbortController();this.initializing=initializing;
    const timer=setTimeout(()=>initializing.abort(Error('麦克风初始化超时，请检查麦克风权限后重试')),this.startupTimeoutMs);
    try{
      const stream=await waitForMedia(navigator.mediaDevices.getUserMedia({audio:{channelCount:1,sampleRate:48000,echoCancellation:true,noiseSuppression:false,autoGainControl:false}}),initializing.signal,late=>late.getTracks().forEach(track=>track.stop()));
      if(!this.active||generation!==this.generation){stream.getTracks().forEach(t=>t.stop());return;}
      this.stream=stream;const Audio=globalThis.AudioContext||globalThis.webkitAudioContext;this.context=new Audio({sampleRate:48000});
      const context=this.context;await waitForMedia(context.resume(),initializing.signal);
      if(!this.active||generation!==this.generation){if(this.context===context)await this.release();return;}
      const noise=await waitForMedia(this.createNoise(context,{workletURL:new URL('noise-worklet',new URL(String(this.workletURL),globalThis.document?.baseURI||globalThis.location?.href||'http://localhost/')),wasmURL:new URL('noise-wasm',new URL(String(this.workletURL),globalThis.document?.baseURI||globalThis.location?.href||'http://localhost/')),signal:initializing.signal}),initializing.signal,late=>late.dispose());
      if(!this.active||generation!==this.generation){noise.dispose();if(this.context===context)await this.release();return;}
      this.noiseProcessor=noise;this.node=noise.node;
      const failed=()=>{if(this.active&&this.noiseProcessor===noise){this.onError(Error('本地语音降噪处理失败，请重新开始语音。'));void this.stop({flush:false});}};
      this.node.onprocessorerror=failed;
      this.node.port.onmessage=({data})=>{if(!this.active||this.muted||data.epoch!==this.generation)return;if(data.type==='error'){failed();return;}if(data.type==='pcm'){if(!Number.isFinite(data.probability)||data.probability<0||data.probability>1){failed();return;}this.accept(new Int16Array(data.data),data.probability);}};
      this.node.port.postMessage({type:'mute',value:this.muted,epoch:this.generation});for(const track of stream.getAudioTracks?.()||[])track.enabled=!this.muted;this.source=this.context.createMediaStreamSource(stream);this.source.connect(this.node);this.node.connect(this.context.destination);await waitForMedia(context.resume(),initializing.signal);
    }catch(e){if(generation!==this.generation||!this.active)return;this.active=false;await this.release();throw e;}
    finally{clearTimeout(timer);if(this.initializing===initializing)this.initializing=null;}
  }
  setPlaybackActive(value){this.playbackActive=!!value;if(!value)this.echoUntil=Date.now()+220;}
  setMuted(value){
    if(this.muted===!!value)return;this.muted=!!value;if(this.muted)this.generation++;for(const track of this.stream?.getAudioTracks?.()||[])track.enabled=!this.muted;this.node?.port.postMessage({type:'mute',value:this.muted,epoch:this.generation});
    if(this.muted){const id=this.segment?.id;this.segment=null;this.pre=[];this.attack=0;this.attackGap=0;for(const c of this.controllers)c.abort();void this.realtime?.clear?.().catch(error=>this.onError(error));this.onLevel(0);if(id)this.onSpeechEnd(id,{cancelled:true});}
  }
  accept(frame,speechProbability){
    if(this.muted)return;
    let sum=0;for(const x of frame)sum+=(x/32768)**2;const rms=Math.sqrt(sum/frame.length),ms=frame.length/RATE*1000;
    const now=Date.now();if(now-this.levelAt>=66){this.levelAt=now;this.onLevel(Math.min(1,rms*8));}
    const protectedAudio=this.playbackActive||now<this.echoUntil;
    if(!Number.isFinite(speechProbability)||speechProbability<0||speechProbability>1)return;
    // RNNoise can confidently detect soft syllables while attenuating their
    // output below the ordinary energy floor. Retain these samples without
    // lowering the confidence/duration gate or playback interruption protection.
    const energyFloor=protectedAudio?.009:speechProbability>=.9?.001:.002;
    const voice=speechProbability>=(this.segment?.35:.6)&&rms>energyFloor;
    if(!this.segment){
      this.pre.push(frame);while(this.pre.reduce((n,f)=>n+f.length,0)>RATE*.22)this.pre.shift();
      // RNNoise can preserve speech confidence while attenuating a syllable's
      // low-energy valley. Keep up to 40 ms of those gaps without counting
      // them as voiced attack; actual silence/noise still resets immediately.
      // Playback interruption retains its stricter continuous 200 ms attack.
      if(voice)this.attack+=ms;
      else if(this.attack&&!protectedAudio&&speechProbability>=.6&&rms>0&&this.attackGap+ms<=40)this.attackGap+=ms;
      else this.attack=this.attackGap=0;
      if(this.attack<(protectedAudio?200:100))return;
      this.segment={frames:this.pre.splice(0),samples:0,voiceSamples:this.attack*RATE/1000,silence:0,text:'',generation:this.generation,id:++this.utteranceId};
      this.segment.samples=this.segment.frames.reduce((n,f)=>n+f.length,0);this.segment.audioSamples=this.segment.samples;this.segment.audio=this.realtime?null:this.segment.frames.slice();this.attack=this.attackGap=0;this.onSpeechStart(this.segment.id);
    }else{this.segment.frames.push(frame);this.segment.audio?.push(frame);this.segment.audioSamples+=frame.length;this.segment.samples+=frame.length;if(voice)this.segment.voiceSamples+=frame.length;}
    const s=this.segment;s.silence=voice?0:s.silence+ms;
    if(s.silence>=this.silenceMs||s.audioSamples>=RATE*15)this.commit();else if(this.realtime||s.samples>=RATE*(s.parts?.length?HTTP_CHUNK_SECONDS:HTTP_FIRST_CHUNK_SECONDS))this.submit(s);
  }
  submit(s,authoritative=false){
    if(!s.frames.length)return;
    if(this.realtime){
      // The recognizer owns a bounded socket queue. Microphone frames must not
      // wait behind an earlier utterance's network round trip or final text.
      const frames=s.frames;s.frames=[];s.samples=0;s.voiceSamples=0;
      try{Promise.resolve(this.realtime.append(frames,s.id,text=>{if(s.generation===this.generation&&s.id===this.utteranceId){s.text=text;this.onPartial(text,{utteranceId:s.id});}})).catch(error=>{if(error.name!=='AbortError'&&s.generation===this.generation)this.onError(error);});}catch(error){if(error.name!=='AbortError'&&s.generation===this.generation)this.onError(error);}
      return;
    }
    // An upload boundary may fall just before the user stops speaking. Never
    // send the remaining all-silence hangover as another independent ASR file.
    if(!s.voiceSamples&&!authoritative){s.frames=[];s.samples=0;return;}
    if(this.backlog>=6&&!authoritative){s.frames=[];s.samples=0;s.voiceSamples=0;this.onError(Error('语音识别处理过慢，已丢弃超限音频'));return;}
    // Short file recognizers can finish with empty text below their analysis
    // window. Pad only the WAV tail immediately; never wait for more recording
    // or alter the speech, endpoint timing, protocol or continuous WS packets.
    const blob=pcmWav(s.frames,RATE);s.frames=[];s.samples=0;s.voiceSamples=0;this.backlog++;s.parts??=[];
    const part={text:'',done:false},controller=new AbortController();s.parts.push(part);part.controller=controller;this.controllers.add(controller);
    const current=()=>s.generation===this.generation&&!controller.signal.aborted;
    const run=async()=>{
      let timer,acquired=false,completed=false;
      try{
        if(!current())return;
        while(this.asrActive>=2&&current())await new Promise(resolve=>{
            const wake=()=>{controller.signal.removeEventListener('abort',wake);const at=this.asrWaiters.indexOf(wake);if(at>=0)this.asrWaiters.splice(at,1);resolve();};
            this.asrWaiters[authoritative?'unshift':'push'](wake);controller.signal.addEventListener('abort',wake,{once:true});
          });
        if(!current())return;this.asrActive++;acquired=true;
        const result=await Promise.race([Promise.resolve().then(()=>this.transcribe(blob,controller.signal,text=>{if(current()){part.text=text;this.publishPartials(s,part);}})),new Promise((_,reject)=>{timer=setTimeout(()=>{reject(Error('语音识别超时'));controller.abort();},25000);controller.signal.addEventListener('abort',()=>reject(abortError()),{once:true});})]);
        if(current()){part.text=(typeof result==='string'?result:result?.text||'').trim();completed=true;}
      }catch(e){if(e.name!=='AbortError'&&s.generation===this.generation){s.failure=e;s.errorReported=true;this.onError(e);}}
      finally{if(current()&&completed){part.done=true;this.publishPartials(s,part);}if(acquired){this.asrActive--;this.asrWaiters.shift()?.();}clearTimeout(timer);this.controllers.delete(controller);}
    };
    // Final recognition has priority over previews and never waits behind an
    // earlier utterance's publication barrier or an obsolete preview queue.
    const task=(authoritative?run():!this.parallel?this.pending.then(run):Promise.resolve().then(run)).finally(()=>{this.backlog--;});
    part.task=task;this.track(task);this.pending=!this.parallel?task:Promise.all([...this.tasks]);
  }
  track(task){this.tasks.add(task);task.then(()=>this.tasks.delete(task),()=>this.tasks.delete(task));}
  publishPartials(s,part){
    if(s.generation!==this.generation)return;
    let text='',previousDone=true;for(const current of s.parts){if(!previousDone)break;if(current.text)text=join(text,current.text);previousDone=current.done;}
    if(text!==s.text&&(text||s.authoritative&&part.done)){s.text=text;this.onPartial(text,{utteranceId:s.id});}
  }
  commit(){const s=this.segment;if(!s)return Promise.resolve('');this.segment=null;this.pre=[];this.onSpeechEnd(s.id,{cancelled:false});
    // Fragments are latency-oriented previews. Multiple fragments can split a
    // word, so only one complete, bounded utterance decides the final text.
    if(!this.realtime&&(s.parts?.length>=2||s.parts?.length&&s.voiceSamples)){
      for(const part of s.parts)part.controller.abort();
      s.parts=[];s.frames=s.audio;s.samples=s.audioSamples;s.authoritative=true;this.submit(s,true);
    }else this.submit(s);
    s.audio=null;
    // Queue the commit barrier immediately, before the next utterance's frames.
    // Only publication of final text is serialized, never microphone capture.
    let result;try{result=this.realtime&&s.generation===this.generation?Promise.resolve(this.realtime.commit(s.id)):null;}catch(error){result=Promise.reject(error);}
    result?.catch(()=>{});
    const final=this.finalChain.then(async()=>{await Promise.all(s.parts?.map(part=>part.task)||[]);if(result)s.text=await result;if(s.failure)throw s.failure;if(s.generation===this.generation){if(s.text)this.lastFinal=s.text;this.onFinal(s.text,{utteranceId:s.id,final:true});return s.text;}return '';});this.finalChain=final.catch(()=>{});const settled=final.then(()=>{},error=>{if(s.generation===this.generation&&error.name!=='AbortError'&&!s.errorReported)this.onError(error);}).finally(()=>this.finals.delete(settled));this.finals.add(settled);this.pending=Promise.all([...this.tasks,this.finalChain]);return final;
  }
  async release(){
    this.initializing?.abort();this.initializing=null;this.node?.disconnect();this.source?.disconnect();if(this.node){this.node.port.onmessage=null;this.node.onprocessorerror=null;}this.noiseProcessor?.dispose();this.noiseProcessor=null;this.stream?.getTracks().forEach(t=>t.stop());
    const context=this.context;this.node=null;this.source=null;this.stream=null;this.context=null;if(context&&context.state!=='closed')await context.close().catch(()=>{});if(microphoneOwner===this)microphoneOwner=null;
  }
  stop({flush=true}={}){
    if(this.stopping)return this.stopping;this.active=false;const final=flush?this.commit():Promise.resolve('');
    if(!flush){this.generation++;this.segment=null;for(const c of this.controllers)c.abort();void this.realtime?.close();}
    this.pre=[];this.attack=this.attackGap=0;this.stopping=(async()=>{await this.release();const text=await final;await this.pending;await Promise.allSettled([...this.finals]);await this.realtime?.close();return flush?(text||this.lastFinal||''):'';})().finally(()=>{this.stopping=null;});return this.stopping;
  }
  dispose(){return this.stop({flush:false});}
}
export class PCMPlayer {
  constructor({onPlayed=()=>{},onPlaybackStart=()=>{},onPlaybackIdle=()=>{},onMetrics=()=>{},onError=()=>{},workletURL='api/voice/worklet',maxBufferedSeconds=2,startupTimeoutMs=12000}={}){
    Object.assign(this,{onPlayed,onPlaybackStart,onPlaybackIdle,onMetrics,onError,workletURL,startupTimeoutMs});this.maxSamples=Math.max(RATE,maxBufferedSeconds*RATE);this.epoch=0;this.queued=0;this.waiters=[];this.odd=null;this.starting=null;this.initializing=null;
  }
  async start(){
    if(this.starting)return this.starting;if(this.context?.state==='running'&&this.node)return;
    const initializing=new AbortController();this.initializing=initializing;
    const timer=setTimeout(()=>initializing.abort(Error('音频播放初始化超时，请重新连接')),this.startupTimeoutMs);
    const task=(async()=>{const Audio=globalThis.AudioContext||globalThis.webkitAudioContext;if(!Audio)throw Error('此浏览器不支持 Web Audio');
      const context=this.context||new Audio();this.context=context;
      try{
        if(!this.node){await waitForMedia(context.audioWorklet.addModule(String(this.workletURL)),initializing.signal);initializing.signal.throwIfAborted();
          const node=new AudioWorkletNode(context,'voice-playback',{numberOfInputs:0,numberOfOutputs:1,outputChannelCount:[1]});this.node=node;
          node.port.onmessage=({data:m})=>{if(this.node!==node||m.epoch!==this.epoch)return;if(m.type==='consumed'){this.queued=Math.max(0,this.queued-m.count);this.wake();}else if(m.type==='played')this.onPlayed(m.id);else if(m.type==='playing')this.onPlaybackStart({id:m.id,epoch:this.epoch});else if(m.type==='idle')this.onPlaybackIdle();else if(m.type==='error')this.onError(Error(m.error));if(m.type==='level')this.onMetrics({bufferedSeconds:this.queued/RATE,level:m.level});};node.connect(context.destination);node.port.postMessage({type:'clear',epoch:this.epoch});
        }
        await waitForMedia(context.resume(),initializing.signal);
      }catch(error){if(this.context===context){const node=this.node;this.node=null;this.context=null;node?.disconnect();if(node)node.port.onmessage=null;await context.close().catch(()=>{});}throw error;}
    })();
    const pending=task.finally(()=>{clearTimeout(timer);if(this.initializing===initializing)this.initializing=null;if(this.starting===pending)this.starting=null;});this.starting=pending;return pending;
  }
  wake(){for(const done of this.waiters.splice(0))done();}
  async enqueue(bytes,id){
    const epoch=this.epoch;await this.start();if(epoch!==this.epoch)return;
    if(!(bytes instanceof Uint8Array))bytes=new Uint8Array(bytes);
    if(this.odd!==null){const merged=new Uint8Array(bytes.length+1);merged[0]=this.odd;merged.set(bytes,1);bytes=merged;this.odd=null;}
    if(bytes.length%2){this.odd=bytes[bytes.length-1];bytes=bytes.subarray(0,-1);}
    for(let offset=0;offset<bytes.length;offset+=24000){
      const part=bytes.subarray(offset,Math.min(bytes.length,offset+24000));while(epoch===this.epoch&&this.queued+part.length/2>this.maxSamples)await new Promise(resolve=>this.waiters.push(resolve));if(epoch!==this.epoch)return;
      const samples=new Int16Array(part.length/2),view=new DataView(part.buffer,part.byteOffset,part.byteLength);for(let i=0;i<samples.length;i++)samples[i]=view.getInt16(i*2,true);
      this.queued+=samples.length;this.node.port.postMessage({type:'pcm',id,epoch,data:samples.buffer},[samples.buffer]);
    }
  }
  segmentEnd(id){if(this.odd!==null){this.odd=null;this.onError(Error('TTS PCM 数据存在不完整采样'));}this.node?.port.postMessage({type:'end',id,epoch:this.epoch});}
  clear(){this.onPlaybackIdle();this.epoch++;this.queued=0;this.odd=null;this.node?.port.postMessage({type:'clear',epoch:this.epoch});this.wake();}
  async dispose(){this.clear();this.initializing?.abort(abortError());this.initializing=null;this.starting=null;const node=this.node,c=this.context;this.node=null;this.context=null;node?.disconnect();if(node)node.port.onmessage=null;if(c&&c.state!=='closed')await c.close();}
}
