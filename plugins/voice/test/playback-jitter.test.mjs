import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../client/audio-worklet.js',import.meta.url),'utf8');
function fixture(rate=48000){
  const sent=[];let Processor;
  vm.runInNewContext(source,{sampleRate:rate,AudioWorkletProcessor:class{constructor(){this.port={postMessage:event=>sent.push(event)};}},registerProcessor:(_name,value)=>Processor=value});
  const processor=new Processor();
  return {processor,sent,send(type,samples=0,id=1){processor.port.onmessage({data:{type,epoch:0,id,data:new Int16Array(samples).fill(10000).buffer}});},render(){const out=new Float32Array(128);processor.process([],[[out]]);return out;}};
}

test('a 60 ms first packet followed by 100 ms network jitter plays continuously once started',()=>{
  const h=fixture(),wave=[];h.send('pcm',1440);
  for(let quantum=0;quantum<300;quantum++){
    if(quantum===38)h.send('pcm',5760);
    if(quantum===83){h.send('pcm',5760);h.send('end');}
    wave.push(...h.render());
  }
  const first=wave.findIndex(value=>value>1e-6),last=wave.findLastIndex(value=>value>1e-6);
  assert(first>=38*128&&first<39*128,'starts immediately when the second packet supplies enough cushion');
  assert.equal(wave.slice(first,last+1).some(value=>value<=1e-6),false,'no injected silence within the utterance');
  assert.equal(h.sent.filter(event=>event.type==='buffering').length,0);
  assert.equal(h.sent.filter(event=>event.type==='played').length,1);
  assert.equal(h.sent.filter(event=>event.type==='idle').length,1);
});

const measuredTiming=JSON.parse(await readFile(new URL('./fixtures/tts-packet-timing.json',import.meta.url),'utf8'));
// Public fixed-text provider probe, 2026-11-10: timing and lengths only, no audio.
for(const sample of measuredTiming.filter(row=>!row.holdout))test(`measured bursty TTS packets ${sample.sample} play without interior gaps with at most 325 ms extra startup`,()=>{
  const h=fixture(),wave=[];let cursor=0,bytes=0,fed=0,ended=false;
  for(let quantum=0;quantum<3600;quantum++){
    const now=quantum*128/48;
    while(sample.packets[cursor]?.atMs<=now){bytes+=sample.packets[cursor++].bytes;const samples=Math.floor(bytes/2)-fed;fed+=samples;h.send('pcm',samples);}
    if(!ended&&now>=sample.totalMs){h.send('end');ended=true;}
    wave.push(...h.render());
  }
  const first=wave.findIndex(value=>value>1e-6),last=wave.findLastIndex(value=>value>1e-6),firstMs=first/48;
  assert(firstMs>sample.buffer120Ms);assert(firstMs-sample.buffer120Ms<=325);
  assert.equal(wave.slice(first,last+1).some(value=>value<=1e-6),false);
  assert.equal(h.sent.filter(event=>event.type==='buffering').length,0);
  assert.equal(h.sent.filter(event=>event.type==='played').length,1);
});

test('held-out slower provider trace improves without unbounded initial waiting or claiming gap-free playback',()=>{
  const sample=measuredTiming.find(row=>row.holdout);
  const replay=hold=>{
    const h=fixture();let cursor=0,bytes=0,fed=0,ended=false,first=-1,silent=0,pendingSilence=0;
    for(let quantum=0;quantum<4500;quantum++){
      const now=quantum*128/48;
      while(sample.packets[cursor]?.atMs<=now){bytes+=sample.packets[cursor++].bytes;const samples=Math.floor(bytes/2)-fed;fed+=samples;h.send('pcm',samples);}
      if(!hold)h.processor.startupHold=0;
      if(!ended&&now>=sample.totalMs){h.send('end');ended=true;}
      const out=h.render();for(let i=0;i<out.length;i++)if(out[i]>1e-6){if(first<0)first=quantum*128+i;else silent+=pendingSilence;pendingSilence=0;}else if(first>=0)pendingSilence++;
    }
    return {first:first/48,silent:silent/48,underruns:h.sent.filter(event=>event.type==='buffering').length};
  };
  const baseline=replay(false),bounded=replay(true);
  assert(bounded.first-baseline.first<=325);assert(bounded.silent>0,'persistent slow upstream cannot be hidden by a bounded startup hold');
  assert(bounded.silent<baseline.silent*.6);assert(bounded.underruns<baseline.underruns);
});

test('a complete short sentence bypasses the provider-jitter startup hold',()=>{
  const h=fixture();h.send('pcm',256);for(let i=0;i<300;i++)h.render();
  h.send('pcm',480);assert(h.processor.startupHold>0);h.send('end');
  assert(h.render().some(Boolean));assert.equal(h.sent.filter(event=>event.type==='playing').length,1);
});

test('short complete speech fades only its true edges, with no dip at a network packet boundary',()=>{
  const h=fixture(),wave=[];h.send('pcm',720);h.send('pcm',720);h.send('end');
  for(let i=0;i<24;i++)wave.push(...h.render());
  assert.equal(wave[0],0);assert(Math.abs(wave[2879])<1e-6);
  assert(wave[1439]>.3&&wave[1440]>.3,'no fade between PCM packets');
  let maxJump=0;for(let i=1;i<wave.length;i++)maxJump=Math.max(maxJump,Math.abs(wave[i]-wave[i-1]));
  assert(maxJump<.01,'start/end avoid abrupt sample discontinuities');
  assert.equal(h.sent.filter(event=>event.type==='played').length,1);
});

test('consumption acknowledgements stay bounded and account for every sample at 44.1/48 kHz',()=>{
  for(const rate of [44100,48000]){
    const h=fixture(rate);h.send('pcm',24000);h.send('end');
    for(let i=0;i<Math.ceil(rate/128)+2;i++)h.render();
    const acknowledgements=h.sent.filter(event=>event.type==='consumed');
    assert(acknowledgements.length<=51);assert.equal(acknowledgements.reduce((sum,event)=>sum+event.count,0),24000);
    assert.equal(h.sent.filter(event=>event.type==='idle').length,1);
  }
});

test('barge-in clears all queued samples immediately without emitting an old completion',()=>{
  const h=fixture();h.send('pcm',24000);h.send('end');h.render();
  h.processor.port.onmessage({data:{type:'clear',epoch:1}});
  for(let i=0;i<10;i++)assert.equal(h.render().some(Boolean),false);
  assert.equal(h.sent.some(event=>event.type==='played'),false);
});
