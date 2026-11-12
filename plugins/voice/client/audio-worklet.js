/* Persistent Blackman-windowed sinc conversion; packet edges retain phase/history. */
const RATE=24000, HALF=12, START=RATE*.08, MAX_START=RATE*1.2, EDGE=RATE*.004, ACK=RATE*.02;
const OBSERVE=.16, RECOVER=.24;
function kernel(x,c){if(Math.abs(x)>=HALF)return 0;return (Math.abs(x)<1e-8?c:Math.sin(Math.PI*c*x)/(Math.PI*x))*(.42+.5*Math.cos(Math.PI*x/HALF)+.08*Math.cos(2*Math.PI*x/HALF));}
function coefficients(c){return Array.from({length:256},(_,phase)=>{const row=new Float32Array(HALF*2);let sum=0;for(let j=0;j<row.length;j++)sum+=(row[j]=kernel(phase/256+HALF-1-j,c));for(let j=0;j<row.length;j++)row[j]/=sum;return row;});}
class VoicePlaybackProcessor extends AudioWorkletProcessor {
  constructor(){
    super();this.ring=new Float32Array(RATE*8);this.epoch=0;this.coefficients=coefficients(Math.min(1,sampleRate/RATE)*.94);this.resetSupply();this.reset();
    this.port.onmessage=({data:m})=>{
      if(m.type==='reset_supply'){if(m.epoch===this.epoch)this.resetSupply();return;}
      if(m.type==='clear'){this.epoch=m.epoch;this.reset();return;}
      if(m.epoch!==this.epoch)return;
      if(m.type==='pcm'){
        const samples=new Int16Array(m.data);if(!samples.length)return;
        if(samples.length+this.written-Math.floor(this.position)>this.ring.length-HALF){this.port.postMessage({type:'error',epoch:this.epoch,error:'播放缓冲超限'});return;}
        const queued=this.written-this.position;
        if(this.supplyId!==m.id){this.supplyId=m.id;this.supplyFirst=this.clock;this.supplyLast=null;this.supplySamples=0;this.supplyReady=null;this.supplyDense=true;}
        // Learn only within one segment and near depletion: long queued audio can
        // deliberately stop upstream delivery through the shared backpressure.
        if(this.supplyLast!==null&&this.clock-this.supplyLast>.04)this.supplyDense=false;
        if(this.supplyLast!==null&&this.supplySamples>=START&&queued<START*3&&this.supplyQueued<MAX_START){
          const gap=this.clock-this.supplyLast;
          if(gap>=.04){this.supplyGap=Math.max(this.supplyGap,gap);this.target=Math.min(MAX_START,Math.max(START,this.supplyGap*RATE*1.2));}
        }
        this.supplyLast=this.clock;this.supplySamples+=samples.length;this.supplyQueued=queued+samples.length;
        if(this.supplySamples>=START)this.supplyReady??=this.clock;
        if(this.gapStarted!==null)this.recoveryFirst??=this.clock;
        this.spans.push({at:this.written,id:m.id});for(const v of samples)this.ring[this.written++%this.ring.length]=v/32768;
      }else if(m.type==='end'){
        this.ends.push({at:this.written,id:m.id});
        if(this.supplyId===m.id)this.supplyLast=null;
      }
    };
  }
  resetSupply(){this.target=START;this.supplyGap=0;this.supplyId=null;this.supplyLast=null;this.supplySamples=0;this.supplyReady=null;this.initialWait=OBSERVE;}
  // Retain the route's supply estimate, never old audio or per-turn statistics.
  reset(){this.ring.fill(0);this.position=0;this.written=0;this.acked=0;this.ends=[];this.spans=[];this.renderEnds=new Map();this.clock=0;this.lastRenderTime=this.renderTime(0);this.started=false;this.active=false;this.meterFrames=0;this.stable=0;this.edgeIn=0;this.firstBuffer=null;this.underruns=0;this.gap=0;this.gapStarted=null;this.recoveryFirst=null;this.renderId=null;this.supplyId=null;this.supplyLast=null;this.supplySamples=0;this.supplyReady=null;this.initialWait=Math.min(.4,Math.max(OBSERVE,this.target/RATE));}
  metrics(){let id;for(const span of this.spans){if(span.at>this.position)break;id=span.id;}return {id,buffer_ms:this.target/RATE*1000,first_buffer_ms:this.firstBuffer,underruns:this.underruns,gap_ms:this.gap*1000,queued_ms:Math.max(0,this.written-this.position)/RATE*1000};}
  report(type,extra={}){this.port.postMessage({type,epoch:this.epoch,...this.metrics(),...extra});}
  renderTime(offset){return {render_time_ms:(this.clock+offset/sampleRate)*1000,render_frame:Math.round(this.clock*sampleRate)+offset};}
  acknowledgeEnd(end){this.report('segment_ended',{id:end.id,...this.renderEnds.get(end.id)??this.lastRenderTime});this.renderEnds.delete(end.id);this.port.postMessage({type:'played',id:end.id,epoch:this.epoch});}
  process(_inputs,outputs){
    const out=outputs[0]?.[0];if(!out)return true;out.fill(0);
    const step=RATE/sampleRate,complete=this.ends.at(-1)?.at===this.written;let rendered=0,completed=false;
    for(let i=0;i<out.length;i++){
      const remaining=this.written-this.position,now=this.clock+i/sampleRate;
      if(!this.started){
        const observed=this.supplyReady!==null&&now-this.supplyReady>=this.initialWait;
        const continuous=this.supplyDense&&this.supplySamples>=START&&this.supplyLast-this.supplyFirst>=.08;
        const recovery=this.gapStarted!==null;
        const bounded=recovery?this.recoveryFirst!==null&&now-this.recoveryFirst>=RECOVER:observed;
        if(!(complete&&remaining>0)&&!(remaining>=START&&(remaining>=this.target&&(recovery||continuous||observed||remaining>=RATE*.5)||bounded)))continue;
        this.started=true;this.edgeIn=EDGE;
        if(recovery){this.gap+=now-this.gapStarted;this.gapStarted=null;this.recoveryFirst=null;this.report('metrics');}
        if(!this.active){this.active=true;this.firstBuffer??=Math.min(this.target,remaining)/RATE*1000;this.report('playing',{id:this.spans[0]?.id});}
      }
      if(remaining<=0||!complete&&remaining<=HALF){
        if(this.started&&!complete){this.underruns++;this.gapStarted=now;this.recoveryFirst=null;this.stable=0;this.report('buffering');}
        this.started=false;continue;
      }
      while(this.spans[1]?.at<=this.position)this.spans.shift();
      const id=this.spans[0]?.id;if(id!==this.renderId){this.renderId=id;this.renderEnds.set(id,{});this.report('segment_started',{id,...this.renderTime(i)});}
      let value=0;const integer=Math.floor(this.position),start=integer-HALF+1,row=this.coefficients[Math.min(255,Math.floor((this.position-integer)*256))];
      for(let j=0;j<HALF*2;j++){const at=start+j;value+=(at<0||at>=this.written?0:this.ring[at%this.ring.length])*row[j];}
      const gainIn=1-this.edgeIn/EDGE,gainOut=complete?Math.min(1,Math.max(0,(remaining-step)/EDGE)):1;
      out[i]=value*Math.min(gainIn,gainOut);this.edgeIn=Math.max(0,this.edgeIn-step);this.position=Math.min(this.written,this.position+step);rendered++;
      const stamp=this.renderEnds.get(id);stamp.render_time_ms=(this.clock+(i+1)/sampleRate)*1000;stamp.render_frame=Math.round(this.clock*sampleRate)+i+1;this.lastRenderTime=stamp;
      while(this.ends[0]?.at<=this.position){this.acknowledgeEnd(this.ends.shift());completed=true;}
    }
    while(this.spans[1]?.at<=this.position)this.spans.shift();
    while(this.ends[0]?.at<=this.position){this.acknowledgeEnd(this.ends.shift());completed=true;}
    const consumed=Math.floor(this.position)-this.acked;
    if(consumed>=ACK||consumed>0&&(completed||!this.started)){this.acked+=consumed;this.port.postMessage({type:'consumed',count:consumed,epoch:this.epoch});}
    if(this.position>=this.written&&this.active&&completed){this.active=false;this.started=false;this.gapStarted=null;this.recoveryFirst=null;this.report('idle');}
    if(rendered===out.length){this.stable+=out.length/sampleRate;if(this.stable>=2){this.supplyGap*=.9;this.target=Math.max(START,this.target*.9);this.stable-=2;this.report('metrics');}}
    else this.stable=0;
    if(rendered){this.meterFrames+=out.length;if(this.meterFrames>=sampleRate/15){this.meterFrames=0;let energy=0;for(const value of out)energy+=value*value;this.report('level',{level:Math.min(1,Math.sqrt(energy/out.length)*4)});}}
    this.clock+=out.length/sampleRate;return true;
  }
}
registerProcessor('voice-playback',VoicePlaybackProcessor);
