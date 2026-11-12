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
  assert(first>=38*128&&first<100*128,'bounded observation overlaps incoming audio');
  assert.equal(wave.slice(first,last+1).some(value=>value<=1e-6),false,'no injected silence within the utterance');
  assert.equal(h.sent.filter(event=>event.type==='buffering').length,0);
  assert.equal(h.sent.filter(event=>event.type==='played').length,1);
  assert.equal(h.sent.filter(event=>event.type==='idle').length,1);
});

test('all routes use bounded burst observation, while dense large PCM and continuous supply start quickly',()=>{
  for(const rate of [44100,48000]){
    const h=fixture(rate);h.send('pcm',1919);assert.equal(h.render().some(Boolean),false);
    h.send('pcm',1);assert.equal(h.render().some(Boolean),false);
    for(let i=0;i<Math.ceil(rate*.16/128);i++)h.render();
    const started=h.sent.find(event=>event.type==='playing');
    assert.equal(started.first_buffer_ms,80);assert.equal(started.buffer_ms,80);assert.equal(started.underruns,0);
    const large=fixture(rate);large.send('pcm',12000);assert(large.render().some(Boolean),'500 ms already buffered needs no observation');
    const stream=fixture(rate);let first;
    for(let i=0;i<Math.ceil(rate*.15/128);i++){if(i%8===0)stream.send('pcm',600);if(stream.render().some(Boolean)&&first===undefined)first=i*128/rate;}
    assert(first>=.08&&first<.12,'continuous usable arrivals take the quick path');
  }
});

test('each queued segment reports its first render even during uninterrupted playback',()=>{
  for(const rate of [44100,48000]){
    const h=fixture(rate);h.send('pcm',2400,10);h.send('end',0,10);h.send('pcm',4800,11);h.send('end',0,11);
    assert.equal(h.sent.some(event=>event.type==='segment_started'),false);
    for(let i=0;i<Math.ceil(rate*.4/128);i++)h.render();
    assert.deepEqual(h.sent.filter(event=>event.type==='segment_started').map(event=>event.id),[10,11]);
    assert.equal(h.sent.filter(event=>event.type==='playing').length,1);
    assert.deepEqual(h.sent.filter(event=>event.type==='played').map(event=>event.id),[10,11]);
    assert.equal(h.processor.underruns,0);
  }
});

test('recovered gaps are measured, counted once, and raise the shared watermark',()=>{
  for(const rate of [44100,48000]){
    const h=fixture(rate);h.send('pcm',2400);
    for(let i=0;i<Math.ceil(rate*.4/128);i++)h.render();
    assert.equal(h.processor.underruns,1);assert.equal(h.processor.gap,0);
    h.send('pcm',7200);for(let i=0;i<Math.ceil(rate*.25/128);i++)h.render();
    const recovery=h.sent.filter(event=>event.type==='metrics').at(-1);
    assert.equal(recovery.id,1);assert.equal(recovery.underruns,1);assert(recovery.gap_ms>=140&&recovery.gap_ms<390);
    assert(h.processor.target>1920&&h.processor.target<=28800);
    assert.equal(h.sent.filter(event=>event.type==='playing').length,1,'recovery stays within the same active turn');
    assert.equal(h.sent.some(event=>event.type==='idle'),false);
  }
});

test('stable consumption gradually forgets burst reserve; clear keeps it and route reset removes it',()=>{
  for(const rate of [44100,48000]){
    const h=fixture(rate);h.processor.target=24000*.24;h.send('pcm',72000);
    for(let i=0;i<Math.floor(rate*2/128);i++)h.render();
    assert.equal(h.processor.target,5760);
    h.render();assert.equal(h.processor.target,5184);
    h.processor.port.onmessage({data:{type:'clear',epoch:1}});
    assert.equal(h.processor.target,5184);assert.equal(h.processor.underruns,0);assert.equal(h.processor.gap,0);assert.equal(h.processor.firstBuffer,null);
    h.processor.port.onmessage({data:{type:'reset_supply',epoch:0}});assert.equal(h.processor.target,5184,'old route notices cannot reset a new epoch');
    h.processor.port.onmessage({data:{type:'reset_supply',epoch:1}});assert.equal(h.processor.target,1920);
  }
});

const measuredTiming=JSON.parse(await readFile(new URL('./fixtures/tts-packet-timing.json',import.meta.url),'utf8'));
// Historical public probes retain burst gaps: the low-latency policy must not hide
// slow supply by holding every route, and must consume every received sample.
for(const sample of measuredTiming)test(`measured TTS trace ${sample.sample} bounds startup without dropping samples`,t=>{
  const h=fixture();let cursor=0,bytes=0,fed=0,ended=false,first=null,thresholdAt=null;
  for(let quantum=0;quantum<6000;quantum++){
    const now=quantum*128/48;
    while(sample.packets[cursor]?.atMs<=now){bytes+=sample.packets[cursor++].bytes;const samples=Math.floor(bytes/2)-fed;fed+=samples;h.send('pcm',samples);if(thresholdAt===null&&fed>=1920)thresholdAt=now;}
    if(!ended&&now>=sample.totalMs){h.send('end');ended=true;}
    const out=h.render();if(first===null&&out.some(value=>value>1e-6))first=now;
  }
  assert(first>=thresholdAt&&first<=thresholdAt+165);assert.equal(h.processor.position,fed);
  assert.equal(h.sent.filter(event=>event.type==='played').length,1);
  assert(h.processor.target>=1920&&h.processor.target<=28800);
  assert.equal(h.processor.underruns,h.sent.filter(event=>event.type==='buffering').length);
  t.diagnostic(JSON.stringify({sample:sample.sample,first_ms:first,gap_ms:h.processor.gap*1000,underruns:h.processor.underruns}));
});

test('a complete short sentence bypasses the watermark without an extra timer',()=>{
  const h=fixture();h.send('pcm',256);for(let i=0;i<300;i++)h.render();
  h.send('pcm',480);assert.equal(h.render().some(Boolean),false);h.send('end');
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

test('segment clocks describe consumed audio, including late completion and empty segments',()=>{
  const h=fixture();h.send('pcm',2400,1);h.send('end',0,1);h.send('pcm',2400,2);h.send('end',0,2);
  for(let i=0;i<100;i++)h.render();
  const starts=h.sent.filter(event=>event.type==='segment_started'),ends=h.sent.filter(event=>event.type==='segment_ended');
  assert.equal(ends[0].render_frame,4800);assert.equal(starts[1].render_frame,4800);assert.equal(ends[1].render_frame,9600);
  h.send('end',0,3);h.render();const empty=h.sent.filter(event=>event.type==='segment_ended').at(-1);
  assert.equal(empty.id,3);assert.equal(empty.render_frame,9600,'a late empty completion does not invent extra rendered silence');
  assert.deepEqual(h.sent.filter(event=>event.type==='played').map(event=>event.id),[1,2,3]);
});

test('smooth online PCM is invariant to packet splitting at both device sample rates',()=>{
  for(const rate of [44100,48000]){
    const whole=fixture(rate),split=fixture(rate);let next=0,first=null;
    for(let quantum=0;quantum<Math.ceil(rate*1.2/128);quantum++){
      const now=quantum*128/rate;
      while(next<50&&next*.02<=now){whole.send('pcm',480);for(const length of [1,39,127,313])split.send('pcm',length);next++;}
      if(next===50){whole.send('end');split.send('end');next++;}
      const a=whole.render(),b=split.render();assert.deepEqual(a,b);
      if(first===null&&a.some(Boolean))first=now;
    }
    assert(first>=.08&&first<.12);assert.equal(whole.processor.underruns,0);assert.equal(whole.processor.position,24000);
    assert.equal(whole.sent.filter(event=>event.type==='played').length,1);
  }
});

test('supply slower than realtime remains bounded and drains every sample on completion',()=>{
  const h=fixture();let next=0,ended=false;
  for(let quantum=0;quantum<1400;quantum++){
    const now=quantum*128/48;
    while(next<25&&next*60<=now){h.send('pcm',480);next++;}
    if(!ended&&now>=1500){h.send('end');ended=true;}
    h.render();assert(h.processor.target<=28800);
  }
  assert.equal(h.processor.position,12000);assert.equal(h.sent.filter(event=>event.type==='played').length,1);
  assert(h.processor.underruns>0,'a slow source is reported, not disguised by discarded audio');
});

test('unsynthesized following sentences and deliberate backpressure never train supply gaps',()=>{
  const h=fixture();h.send('pcm',2400,1);h.send('end',0,1);
  for(let i=0;i<200;i++)h.render();h.send('pcm',2400,2);h.send('end',0,2);
  for(let i=0;i<100;i++)h.render();
  assert.equal(h.processor.underruns,0);assert.equal(h.processor.target,1920);
  const ends=h.sent.filter(event=>event.type==='segment_ended'),starts=h.sent.filter(event=>event.type==='segment_started');
  assert(starts[1].render_time_ms-ends[0].render_time_ms>400);
  const paced=fixture();paced.send('pcm',48000);for(let i=0;i<700;i++)paced.render();paced.send('pcm',2400);
  assert.equal(paced.processor.target,1920,'a queue above the low watermark indicates intentional pacing');
});

// Fixed public synthesis probe, 2026-11-12: packet times and lengths only.
// All packets are 2048 bytes except the final packet; no recorded audio or credentials.
const liveBursts=[{"endMs":4844,"lastBytes":726,"at":[714,716,720,720,734,735,953,954,955,956,957,1346,1346,1346,1346,1371,1371,1371,1371,1371,1371,1858,1858,1859,1860,1880,1881,1885,1885,1889,1889,1889,1890,2595,2595,2599,2617,2618,2621,2623,2624,2626,2628,2628,2628,2629,2640,2641,2643,2643,2645,2645,3543,3544,3544,3566,3567,3569,3571,3573,3574,3575,3576,3578,3579,3589,3589,3590,3591,3592,3594,3595,3596,4653,4653,4653,4676,4676,4678,4682,4682,4684,4686,4687,4687,4688,4698,4699,4700,4701,4702,4704,4705,4706,4706,4707,4708,4709,4709,4710,4711,4711,4791,4791,4791,4791,4792]},{"endMs":4228,"lastBytes":474,"at":[667,670,672,675,691,692,896,897,898,900,900,1233,1234,1235,1257,1257,1257,1260,1260,1263,1263,1684,1685,1695,1695,1696,1709,1709,1709,1713,1713,1713,1714,2354,2354,2355,2356,2380,2380,2384,2384,2388,2388,2388,2389,2393,2393,2393,2406,2406,2406,2406,3173,3173,3173,3197,3200,3200,3204,3204,3206,3206,3208,3210,3222,3222,3223,3225,3225,3227,3229,3229,3229,4115,4116,4116,4140,4143,4143,4147,4147,4150,4150,4154,4154,4154,4164,4166,4166,4168,4168,4172,4172,4172,4175,4175,4175,4177,4177,4177,4177]},{"endMs":4540,"lastBytes":1670,"at":[768,769,772,775,792,792,1007,1008,1009,1011,1012,1362,1363,1365,1365,1388,1391,1391,1393,1395,1396,1854,1854,1855,1878,1878,1882,1882,1884,1887,1888,1889,1889,2503,2504,2505,2529,2529,2532,2535,2535,2536,2539,2539,2540,2556,2556,2556,2557,2561,2561,2561,3384,3385,3385,3410,3411,3413,3416,3416,3418,3420,3420,3422,3435,3435,3436,3437,3439,3439,3441,3441,3442,4419,4419,4419,4445,4445,4447,4451,4451,4454,4455,4469,4469,4469,4470,4471,4472,4473,4474,4477,4477,4477,4478,4481,4481,4481,4481,4482,4483,4483]},{"endMs":4659,"lastBytes":590,"at":[770,770,770,770,770,771,1030,1032,1033,1035,1058,1447,1450,1450,1452,1480,1480,1480,1486,1486,1486,1956,1957,1958,1985,1987,1994,1994,1994,1998,1998,1999,1999,2602,2603,2604,2631,2632,2638,2638,2640,2642,2645,2646,2663,2663,2663,2666,2666,2667,2667,2669,3445,3446,3447,3476,3476,3484,3484,3484,3485,3488,3489,3490,3505,3505,3505,3506,3510,3510,3510,3511,3512,4525,4525,4526,4554,4555,4558,4560,4561,4563,4566,4566,4567,4584,4584,4586,4587,4592,4592,4592,4592,4593,4594,4596,4596,4597,4597,4598,4601,4601,4601,4601]}];

function replayLive(trace,rate=48000,h=fixture(rate)){
  let cursor=0,ended=false,first=-1,starvedFrames=0;
  const duration=trace.endMs+7000;
  for(let quantum=0;quantum<Math.ceil(duration*rate/128000);quantum++){
    const now=quantum*128000/rate;
    while(trace.at[cursor]<=now){const samples=(cursor===trace.at.length-1?trace.lastBytes:2048)/2;cursor++;h.send('pcm',samples);}
    if(!ended&&now>=trace.endMs){h.send('end');ended=true;}
    const start=h.processor.position,out=h.render(),consumed=h.processor.position-start;
    if(first<0&&out.some(value=>value>1e-6))first=now;
    if(first>=0&&h.processor.active&&consumed<128*24000/rate)starvedFrames+=128-consumed*rate/24000;
  }
  return {firstMs:first,starvedMs:starvedFrames*1000/rate,underruns:h.processor.underruns,played:h.sent.filter(event=>event.type==='played').length};
}
// Frozen evidence from the former 80/+40/240 ms policy, same PCM and device rate.
const former=[{first:717.33,gap:849,underruns:5},{first:672,gap:358,underruns:4},{first:770.67,gap:563,underruns:5},{first:770.67,gap:675,underruns:5}];
for(const [index,trace]of liveBursts.entries())test('online supply strategy reduces repeated real burst gaps '+index,t=>{
  const fast=replayLive(trace),old=former[index];
  t.diagnostic(JSON.stringify({trace:index,first_ms:fast.firstMs,underruns:fast.underruns,gap_ms:fast.starvedMs,former:old}));
  assert.equal(fast.played,1);assert(fast.underruns<old.underruns);
  assert(fast.starvedMs<=old.gap+20,'recovery does not merely hide more silence behind fewer underruns');
  assert(fast.firstMs+fast.starvedMs<=old.first+old.gap+100,'startup plus audible gaps remains comparable or improves');
  assert(fast.firstMs<trace.at[0]+170,'cold observation is bounded, not a 900 ms reserve');
});

test('the same route reuses measured supply across a real second turn',t=>{
  const h=fixture(),cold=replayLive(liveBursts[0],48000,h);
  h.processor.port.onmessage({data:{type:'clear',epoch:0}});h.sent.length=0;
  const warm=replayLive(liveBursts[0],48000,h);
  t.diagnostic(JSON.stringify({cold,warm}));
  assert(warm.underruns<cold.underruns);assert(warm.starvedMs<cold.starvedMs);
  assert(warm.firstMs+warm.starvedMs<=cold.firstMs+cold.starvedMs+50);
  assert(warm.firstMs<liveBursts[0].at[0]+410,'learned reserve has a bounded startup wait');
});
