/* Persistent Blackman-windowed sinc conversion; packet edges retain phase/history. */
const RATE=24000, HALF=12, START=RATE*.12, MAX_START=RATE*.24, EDGE=RATE*.004, ACK=RATE*.02;
function kernel(x,c){if(Math.abs(x)>=HALF)return 0;return (Math.abs(x)<1e-8?c:Math.sin(Math.PI*c*x)/(Math.PI*x))*(.42+.5*Math.cos(Math.PI*x/HALF)+.08*Math.cos(2*Math.PI*x/HALF));}
function coefficients(c){return Array.from({length:256},(_,phase)=>{const row=new Float32Array(HALF*2);let sum=0;for(let j=0;j<row.length;j++)sum+=(row[j]=kernel(phase/256+HALF-1-j,c));for(let j=0;j<row.length;j++)row[j]/=sum;return row;});}
class VoicePlaybackProcessor extends AudioWorkletProcessor {
  constructor(){super();this.ring=new Float32Array(RATE*8);this.epoch=0;this.coefficients=coefficients(Math.min(1,sampleRate/RATE)*.94);this.reset();this.port.onmessage=({data:m})=>{if(m.type==='clear'){this.epoch=m.epoch;this.reset();}else if(m.epoch===this.epoch&&m.type==='pcm'){const samples=new Int16Array(m.data);if(samples.length+this.written-Math.floor(this.position)>this.ring.length-HALF){this.port.postMessage({type:'error',epoch:this.epoch,error:'播放缓冲超限'});return;}
    if(this.inputId!==m.id){this.inputId=m.id;this.lastPacket=null;if(!this.active){this.startupHold=0;this.startupReady=null;}}
    // A tiny header-like PCM packet followed by a long provider stall predicts
    // bursty delivery. A bounded startup hold builds reserve without requiring
    // a large fixed watermark or delaying complete short utterances.
    if(!this.active&&this.lastPacket!==null){const gap=this.clock-this.lastPacket;if(gap>=.24)this.startupHold=Math.max(this.startupHold,Math.min(.32,gap*.4));}
    this.lastPacket=this.clock;this.spans.push({at:this.written,id:m.id});for(const v of samples)this.ring[this.written++%this.ring.length]=v/32768;}else if(m.epoch===this.epoch&&m.type==='end')this.ends.push({at:this.written,id:m.id});};}
  // One short jitter cushion prevents a tiny first packet from speaking and
  // immediately starving. Preserve learned jitter across sentence cancellation.
  reset(){this.ring.fill(0);this.position=0;this.written=0;this.acked=0;this.ends=[];this.spans=[];this.started=false;this.active=false;this.meterFrames=0;this.target??=START;this.stable=0;this.edgeIn=0;this.clock=0;this.lastPacket=null;this.inputId=null;this.startupHold=0;this.startupReady=null;}
  process(_inputs,outputs){const out=outputs[0]?.[0];if(!out)return true;out.fill(0);const step=RATE/sampleRate,complete=this.ends.at(-1)?.at===this.written;let rendered=false;
    for(let i=0;i<out.length;i++){
      const remaining=this.written-this.position;
      if(!this.started){if(remaining>=this.target||complete&&remaining>0){this.startupReady??=this.clock;if(!this.active&&!complete&&this.clock-this.startupReady<this.startupHold)continue;this.started=true;this.edgeIn=EDGE;if(!this.active){this.active=true;this.port.postMessage({type:'playing',id:this.spans[0]?.id,epoch:this.epoch});}}else continue;}
      if(remaining<=0||!complete&&remaining<=HALF){if(this.started&&remaining<=HALF&&!complete){this.target=Math.min(MAX_START,this.target+RATE*.04);this.port.postMessage({type:'buffering',epoch:this.epoch});}this.started=false;continue;}
      let value=0;const integer=Math.floor(this.position),start=integer-HALF+1,row=this.coefficients[Math.min(255,Math.floor((this.position-integer)*256))];for(let j=0;j<HALF*2;j++){const at=start+j;value+=(at<0||at>=this.written?0:this.ring[at%this.ring.length])*row[j];}
      // Fade only actual playback boundaries, never individual network packets.
      const gainIn=1-this.edgeIn/EDGE,gainOut=complete?Math.min(1,Math.max(0,(remaining-step)/EDGE)):1;
      out[i]=value*Math.min(gainIn,gainOut);this.edgeIn=Math.max(0,this.edgeIn-step);this.position=Math.min(this.written,this.position+step);rendered=true;
    }
    // Confirm only audio consumed by this render quantum, never on receipt.
    while(this.spans[1]?.at<=this.position)this.spans.shift();
    let completed=false;while(this.ends[0]?.at<=this.position){this.port.postMessage({type:'played',id:this.ends.shift().id,epoch:this.epoch});completed=true;}
    const consumed=Math.floor(this.position)-this.acked;if(consumed>=ACK||consumed>0&&(completed||!this.started)){this.acked+=consumed;this.port.postMessage({type:'consumed',count:consumed,epoch:this.epoch});}
    // An underrun is still an active utterance: keep echo/interrupt protection
    // until its explicit end, including an end received after the last sample.
    if(this.position>=this.written&&this.active&&completed){this.active=false;this.started=false;this.port.postMessage({type:'idle',epoch:this.epoch});}
    if(rendered){this.meterFrames+=out.length;if(this.meterFrames>=sampleRate/15){this.meterFrames=0;let energy=0;for(const value of out)energy+=value*value;this.port.postMessage({type:'level',level:Math.min(1,Math.sqrt(energy/out.length)*4),epoch:this.epoch});}this.stable+=out.length/sampleRate;if(this.stable>=3){this.target=Math.max(START,this.target-RATE*.02);this.stable=0;}}else this.stable=0;this.clock+=out.length/sampleRate;return true;
  }
}
registerProcessor('voice-playback',VoicePlaybackProcessor);
