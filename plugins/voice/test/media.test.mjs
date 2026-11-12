import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {Capture,PCMPlayer,pcmWav,HTTP_FIRST_CHUNK_SECONDS,HTTP_CHUNK_SECONDS} from '../client/media.mjs';
const frame=(n=2000)=>new Int16Array(480).fill(n);
const tick=()=>new Promise(r=>setTimeout(r,0));

test('capture freezes the voiced endpoint before delayed recognition and refreshes it on resumed speech',async()=>{
  let now=1000,resolve;const endpoints=[],finals=[];
  const c=new Capture({now:()=>now,transcribe:()=>new Promise(done=>resolve=done),onSpeechEnd:(id,meta)=>endpoints.push({id,...meta}),onFinal:(text,meta)=>finals.push({text,...meta})});
  const send=(sample,count)=>{for(let i=0;i<count;i++){now+=20;c.accept(frame(sample),sample?.9:0);}};
  send(2000,5);send(0,8);send(2000,2);
  const speechEndedAt=now;send(0,15);assert.deepEqual(endpoints,[]);
  send(0,1);await tick();const endpointAt=now;
  assert.equal(endpointAt-speechEndedAt,320);
  assert.deepEqual(endpoints,[{id:1,cancelled:false,speechEndedAt,endpointAt}]);
  now+=700;resolve('完整语音');await c.pending;
  assert.deepEqual(finals,[{text:'完整语音',utteranceId:1,final:true,speechEndedAt,endpointAt,finalizedAt:now}]);
  await c.dispose();
});

test('overlapping ASR finals preserve each utterance audio timing independently',async()=>{
  let now=1000;const resolvers=new Map(),finals=[],ends=[];
  const c=new Capture({now:()=>now,realtime:{append(){},commit:id=>new Promise(resolve=>resolvers.set(id,resolve)),close:async()=>{}},onSpeechEnd:(id,meta)=>ends.push({id,...meta}),onFinal:(text,meta)=>finals.push({text,...meta})});
  const speak=()=>{for(let i=0;i<5;i++){now+=20;c.accept(frame(),.9);}const speechEndedAt=now;for(let i=0;i<16;i++){now+=20;c.accept(frame(0),0);}return {speechEndedAt,endpointAt:now};};
  const first=speak(),second=speak();
  resolvers.get(2)('第二段');await tick();assert.deepEqual(finals,[]);
  now+=200;resolvers.get(1)('第一段');await c.pending;
  assert.deepEqual(ends,[{id:1,cancelled:false,...first},{id:2,cancelled:false,...second}]);
  assert.deepEqual(finals,[{text:'第一段',utteranceId:1,final:true,...first,finalizedAt:now},{text:'第二段',utteranceId:2,final:true,...second,finalizedAt:now}]);
  await c.dispose();
});

test('muting discards old audio timing and late finals before a fresh utterance',async()=>{
  let now=1000;const resolvers=new Map(),finals=[];
  const c=new Capture({now:()=>now,realtime:{append(){},commit:id=>new Promise(resolve=>resolvers.set(id,resolve)),clear:async()=>{},close:async()=>{}},onFinal:(text,meta)=>finals.push({text,...meta})});
  const speak=()=>{for(let i=0;i<5;i++){now+=20;c.accept(frame(),.9);}const speechEndedAt=now;for(let i=0;i<16;i++){now+=20;c.accept(frame(0),0);}return {speechEndedAt,endpointAt:now};};
  speak();c.setMuted(true);resolvers.get(1)('旧内容');await c.pending;assert.deepEqual(finals,[]);
  c.setMuted(false);now+=1000;const current=speak();resolvers.get(2)('新内容');await c.pending;
  assert.deepEqual(finals,[{text:'新内容',utteranceId:2,final:true,...current,finalizedAt:now}]);await c.dispose();
});
test('HTTP ASR starts a short WAV upload while the user is still speaking',async()=>{
  let calls=0;const c=new Capture({transcribe:async()=>{calls++;return '';}});
  for(let i=0;i<Math.ceil(HTTP_CHUNK_SECONDS*50)+2;i++)c.accept(frame(),.9);
  await tick();assert.equal(calls,1);await c.dispose();
});

test('HTTP starts at 900 ms then uses 1500 ms fragments without dropping voiced PCM',async()=>{
  const lengths=[],c=new Capture({parallel:true,transcribe:async blob=>{lengths.push((blob.size-44)/48);return '';}});
  for(let i=0;i<HTTP_FIRST_CHUNK_SECONDS*50-1;i++)c.accept(frame(),.9);
  await tick();assert.deepEqual(lengths,[]);
  c.accept(frame(),.9);await tick();assert.deepEqual(lengths,[1000]);
  for(let i=0;i<HTTP_CHUNK_SECONDS*50-1;i++)c.accept(frame(),.9);
  await tick();assert.deepEqual(lengths,[1000]);
  c.accept(frame(),.9);await tick();assert.deepEqual(lengths,[1000,1500]);
  await c.stop();assert.deepEqual(lengths,[1000,1500,2400]);
});

test('speech followed by an upload-boundary silence never requests a hallucinating silent tail',async()=>{
  const requests=[],finals=[],c=new Capture({parallel:true,transcribe:async blob=>{
    const pcm=new Int16Array((await blob.arrayBuffer()).slice(44));requests.push({samples:pcm.length,voiced:pcm.some(Boolean)});
    return pcm.some(Boolean)?'你好':'嗯啊耶啊';
  },onFinal:text=>finals.push(text)});
  for(let i=0;i<HTTP_FIRST_CHUNK_SECONDS*50;i++)c.accept(frame(),.9);
  for(let i=0;i<16;i++)c.accept(frame(0),.01);
  await c.pending;assert.deepEqual(requests,[{samples:24000,voiced:true}]);assert.deepEqual(finals,['你好']);
  await c.dispose();
});

test('a voiced suffix triggers full recognition and ignores aborted preview publications',async()=>{
  const requests=[],partials=[],finals=[],errors=[];
  const c=new Capture({parallel:true,transcribe:(blob,signal,partial)=>new Promise(resolve=>requests.push({blob,signal,partial,resolve})),onPartial:text=>partials.push(text),onFinal:text=>finals.push(text),onError:error=>errors.push(error)});
  for(let i=0;i<45;i++)c.accept(frame(2000),.9);await tick();
  assert.equal(requests.length,1);requests[0].partial('你好');
  for(let i=0;i<3;i++)c.accept(frame(3000),.9);
  for(let i=0;i<16;i++)c.accept(frame(0),0);
  await tick();assert.equal(requests.length,2);assert.equal(requests[0].signal.aborted,true);
  assert.equal((requests[1].blob.size-44)/48,1280);
  const samples=new Int16Array((await requests[1].blob.arrayBuffer()).slice(44));
  assert.equal(samples[0],2000);assert.equal(samples[21600],3000);assert.equal(samples[23040],0);
  requests[0].partial('Yeah.');requests[1].partial('你好呀');requests[1].resolve('你好呀');
  await c.pending;assert.deepEqual(finals,['你好呀']);assert.deepEqual(partials,['你好','你好呀']);assert.deepEqual(errors,[]);
  requests[0].resolve('Yeah.');requests[0].partial('late');await tick();assert.deepEqual(finals,['你好呀']);assert.equal(partials.includes('late'),false);await c.dispose();
});

test('full recognition replaces all completed previews and corrects words split across fragments',async()=>{
  const requests=[],partials=[],finals=[];
  const c=new Capture({parallel:true,transcribe:async blob=>{requests.push((blob.size-44)/48);return ['这是一个实','十雨音测试','这是一个实时语音测试'][requests.length-1];},onPartial:text=>partials.push(text),onFinal:text=>finals.push(text)});
  for(let i=0;i<120;i++)c.accept(frame(),.9);await tick();
  assert.deepEqual(requests,[1000,1500]);assert.equal(partials.at(-1),'这是一个实十雨音测试');
  const segment=c.segment;
  for(let i=0;i<4;i++)c.accept(frame(),.9);for(let i=0;i<16;i++)c.accept(frame(0),0);
  await c.pending;assert.deepEqual(requests,[1000,1500,2800]);assert.equal(segment.parts.length,1);assert.equal(segment.audio,null);assert.deepEqual(finals,['这是一个实时语音测试']);await c.dispose();
});

test('full recognition cancels previews and starts ahead of obsolete queued fragments',async()=>{
  const requests=[],partials=[],finals=[];let active=0,max=0;
  const c=new Capture({parallel:true,transcribe:(blob,signal,partial)=>{active++;max=Math.max(active,max);let released=false;const release=()=>{if(!released){released=true;active--;}};signal.addEventListener('abort',release,{once:true});return new Promise(resolve=>requests.push({duration:(blob.size-44)/48,signal,partial,resolve:text=>{release();resolve(text);}}));},onPartial:text=>partials.push(text),onFinal:text=>finals.push(text)});
  for(let i=0;i<195;i++)c.accept(frame(),.9);await tick();assert.equal(requests.length,2);
  for(let i=0;i<3;i++)c.accept(frame(),.9);for(let i=0;i<16;i++)c.accept(frame(0),0);
  await tick();assert.equal(requests.length,3);assert.equal(requests[2].duration,4280);assert.equal(requests[0].signal.aborted,true);assert.equal(requests[1].signal.aborted,true);
  requests[2].partial('全句');requests[2].resolve('完整全句');await c.pending;assert.equal(max,2);assert.deepEqual(finals,['完整全句']);assert.equal(c.asrWaiters.length,0);assert.equal(c.backlog,0);await c.dispose();
});

test('failed full recognition preserves preview and never publishes a successful final',async()=>{
  const partials=[],finals=[],errors=[];
  const c=new Capture({parallel:true,transcribe:async blob=>{if((blob.size-44)/48===1000)return '预览尚未确认';throw Error('full recognition failed');},onPartial:text=>partials.push(text),onFinal:text=>finals.push(text),onError:error=>errors.push(error.message)});
  for(let i=0;i<45;i++)c.accept(frame(),.9);await tick();assert.deepEqual(partials,['预览尚未确认']);
  for(let i=0;i<15;i++)c.accept(frame(),.9);
  await assert.rejects(c.commit(),/full recognition failed/);await c.pending;
  assert.deepEqual(finals,[]);assert.deepEqual(partials,['预览尚未确认']);assert.deepEqual(errors,['full recognition failed']);await c.dispose();
});

test('full recognition starts while an older utterance final is pending and publishes in utterance order',async()=>{
  const requests=[],finals=[];let active=0,max=0;
  const c=new Capture({parallel:true,transcribe:(blob,signal,partial)=>{active++;max=Math.max(max,active);let released=false;const release=()=>{if(!released){released=true;active--;}};signal.addEventListener('abort',release,{once:true});return new Promise(resolve=>requests.push({duration:(blob.size-44)/48,signal,partial,resolve:text=>{release();resolve(text);}}));},onFinal:text=>finals.push(text)});
  for(let i=0;i<10;i++)c.accept(frame(),.9);const first=c.commit();await tick();assert.equal(requests.length,1);
  for(let i=0;i<120;i++)c.accept(frame(),.9);await tick();assert.equal(requests.length,2);
  const second=c.commit();await tick();assert.equal(requests.length,3);assert.equal(requests[2].duration,2400);assert.equal(requests[1].signal.aborted,true);
  requests[2].resolve('第二句话');await tick();assert.deepEqual(finals,[]);
  requests[0].resolve('第一句');await Promise.all([first,second]);assert.deepEqual(finals,['第一句','第二句话']);assert.equal(max,2);await c.dispose();
});

test('JSON full recognition bypasses its cancelled serial preview queue',async()=>{
  const requests=[],finals=[],c=new Capture({parallel:false,transcribe:(blob,signal)=>new Promise(resolve=>requests.push({duration:(blob.size-44)/48,signal,resolve})),onFinal:text=>finals.push(text)});
  for(let i=0;i<120;i++)c.accept(frame(),.9);await tick();assert.equal(requests.length,1);
  const stopped=c.stop();await tick();assert.equal(requests.length,2);assert.deepEqual(requests.map(request=>request.duration),[1000,2400]);assert.equal(requests[0].signal.aborted,true);
  requests[1].resolve('完整转录');assert.equal(await stopped,'完整转录');assert.deepEqual(finals,['完整转录']);assert.equal(c.backlog,0);await c.dispose();
});

test('full recognition may correct a nonempty preview to an empty final',async()=>{
  const partials=[],finals=[];let calls=0;
  const c=new Capture({parallel:true,transcribe:async()=>++calls===1?'噪音预览':'',onPartial:text=>partials.push(text),onFinal:text=>finals.push(text)});
  for(let i=0;i<45;i++)c.accept(frame(),.9);await tick();for(let i=0;i<10;i++)c.accept(frame(),.9);await c.commit();
  assert.deepEqual(partials,['噪音预览','']);assert.deepEqual(finals,['']);await c.dispose();
});

test('complete utterance audio including preroll stays within the 15-second provider limit',async()=>{
  const durations=[],ended=[];
  const c=new Capture({parallel:true,transcribe:async blob=>{durations.push((blob.size-44)/48);return '';},onSpeechEnd:id=>ended.push(id)});
  for(let i=0;i<10;i++)c.accept(frame(0),0);
  for(let i=0;i<760&&!ended.length;i++){c.accept(frame(),.9);if(i%40===0)await tick();}
  await c.pending;assert.deepEqual(ended,[1]);assert.equal(durations.at(-1),15000);assert.ok(durations.every(duration=>duration<=15000));assert.equal(c.segment,null);await c.dispose();
});

test('a short first utterance still uploads all audio and invalid probability cannot open speech',async()=>{
  const requests=[],finals=[],c=new Capture({transcribe:async blob=>{requests.push((blob.size-44)/48);return '嗯';},onFinal:text=>finals.push(text)});
  for(const probability of [undefined,NaN,Infinity,-1,2])for(let i=0;i<20;i++)c.accept(frame(),probability);
  assert.equal(c.segment,null);
  for(let i=0;i<6;i++)c.accept(frame(),.9);for(let i=0;i<16;i++)c.accept(frame(0),0);
  await c.pending;assert.deepEqual(requests,[1000]);assert.deepEqual(finals,['嗯']);await c.dispose();
});

test('short file padding preserves speech and submits at the existing silence endpoint without recording longer',async()=>{
  const requests=[],ended=[],c=new Capture({transcribe:async blob=>{requests.push(blob);return '你好';},onSpeechEnd:id=>ended.push(id)});
  for(let i=0;i<6;i++)c.accept(frame(300),.99);
  for(let i=0;i<15;i++)c.accept(frame(0),0);
  assert.equal(requests.length,0);assert.deepEqual(ended,[]);
  c.accept(frame(0),0);await c.pending;
  assert.deepEqual(ended,[1]);assert.equal(requests.length,1);
  const samples=new Int16Array((await requests[0].arrayBuffer()).slice(44));
  assert.equal(samples.length,24000);assert.ok(samples.subarray(0,2880).every(sample=>sample===300));
  assert.ok(samples.subarray(2880).every(sample=>sample===0));await c.dispose();
});

test('model probability rejects sustained loud noise and retains quiet speech with hysteresis',async()=>{
  const starts=[],finals=[],c=new Capture({transcribe:async()=>'嗯啊',onSpeechStart:id=>starts.push(id),onFinal:text=>finals.push(text)});
  for(let i=0;i<120;i++)c.accept(frame(3000),.05);
  assert.equal(c.segment,null);assert.deepEqual(starts,[]);assert.equal(c.backlog,0);
  for(let i=0;i<4;i++)c.accept(frame(100),.59);
  assert.equal(c.segment,null);
  for(let i=0;i<5;i++)c.accept(frame(100),.6);
  assert.deepEqual(starts,[1]);
  for(let i=0;i<20;i++)c.accept(frame(100),.35);
  assert.equal(c.segment.silence,0);
  for(let i=0;i<16;i++)c.accept(frame(0),.99);
  await c.pending;assert.deepEqual(finals,['嗯啊']);await c.dispose();
});

test('modeled speech keeps stricter playback interruption and resets activity on mute',async()=>{
  const requests=[],c=new Capture({transcribe:async blob=>{requests.push(blob.size);return 'new';}});
  c.setPlaybackActive(true);
  for(let i=0;i<20;i++)c.accept(frame(100),.99);
  assert.equal(c.segment,null);
  for(let i=0;i<15;i++)c.accept(frame(1000),.9);
  assert.equal(c.segment,null);
  c.accept(frame(1000),.9);assert.ok(c.segment.voiceSamples>0);
  c.setMuted(true);assert.equal(c.segment,null);assert.equal(c.attack,0);assert.deepEqual(c.pre,[]);
  c.setMuted(false);
  for(let i=0;i<30;i++)c.accept(frame(0),.01);
  assert.equal(c.segment,null);assert.deepEqual(requests,[]);
  await c.dispose();
});

test('soft onset requires high model confidence and never bypasses digital silence or playback protection',async()=>{
  for(const [sample,probability,playback] of [[50,.89,false],[0,.99,false],[20,.99,false],[50,.99,true]]){
    const c=new Capture({transcribe:async()=>''});if(playback)c.setPlaybackActive(true);
    for(let i=0;i<20;i++)c.accept(frame(sample),probability);
    assert.equal(c.segment,null);await c.dispose();
  }
  const requests=[],c=new Capture({transcribe:async blob=>{requests.push(blob);return '你好';}});
  for(let i=0;i<4;i++)c.accept(frame(50),.99);assert.equal(c.segment,null);
  c.accept(frame(50),.99);assert.ok(c.segment);
  for(let i=0;i<16;i++)c.accept(frame(0),0);await c.pending;
  assert.equal(requests.length,1);await c.dispose();
});

test('short syllables bridge only bounded modeled low-energy valleys',async()=>{
  const starts=[],c=new Capture({transcribe:async()=>'你好',onSpeechStart:id=>starts.push(id)});
  for(let i=0;i<4;i++)c.accept(frame(200),.9);
  for(let i=0;i<2;i++)c.accept(frame(30),.94);
  assert.equal(c.segment,null);assert.equal(c.attack,80);
  c.accept(frame(200),.9);assert.deepEqual(starts,[1]);
  await c.stop();
});

test('syllable attack cannot accumulate across real silence, noise, excessive valleys or playback',async()=>{
  for(const [gap,probability,count,playback] of [[0,.99,1,false],[30,.1,1,false],[30,.9,3,false],[30,.9,2,true]]){
    const c=new Capture({transcribe:async()=>''});if(playback)c.setPlaybackActive(true);
    for(let i=0;i<4;i++)c.accept(frame(1000),.9);
    for(let i=0;i<count;i++)c.accept(frame(gap),probability);
    c.accept(frame(1000),.9);
    assert.equal(c.segment,null);assert.equal(c.attack,20);
    await c.dispose();
  }
});

test('faster fragments publish in order before whole-utterance final correction',async()=>{
  const resolvers=[],partials=[],finals=[];let active=0,max=0;
  const c=new Capture({parallel:true,transcribe:()=>{active++;max=Math.max(max,active);return new Promise(resolve=>resolvers.push(text=>{active--;resolve(text);}));},onPartial:text=>partials.push(text),onFinal:text=>finals.push(text)});
  for(let i=0;i<(HTTP_FIRST_CHUNK_SECONDS+HTTP_CHUNK_SECONDS*2)*50;i++)c.accept(frame(),.9);
  await tick();assert.equal(resolvers.length,2);assert.equal(max,2);
  resolvers[1]('二');await tick();assert.equal(resolvers.length,3);assert.deepEqual(partials,[]);
  resolvers[2]('三');resolvers[0]('一');await tick();assert.equal(partials.at(-1),'一二三');
  const end=c.commit();await tick();assert.equal(resolvers.length,4);resolvers[3]('完整句子');await end;
  assert.equal(max,2);assert.equal(partials.at(-1),'完整句子');assert.deepEqual(finals,['完整句子']);await c.dispose();
});
test('WAV is mono little-endian PCM24k',async()=>{const v=new DataView(await pcmWav([new Int16Array([-32768,32767])]).arrayBuffer());assert.equal(v.getUint32(24,true),24000);assert.equal(v.getUint16(22,true),1);assert.equal(v.getInt16(44,true),-32768);assert.equal(v.getUint32(40,true),4);});
test('short utterance retains preroll and commits only after ASR',async()=>{
  const events=[];let finish;const c=new Capture({silenceMs:100,transcribe:()=>new Promise(r=>finish=r),onSpeechStart:()=>events.push('start'),onPartial:t=>events.push('partial:'+t),onFinal:t=>events.push('final:'+t)});
  for(let i=0;i<4;i++)c.accept(frame(0),0);for(let i=0;i<6;i++)c.accept(frame(),.9);for(let i=0;i<5;i++)c.accept(frame(0),0);await tick();assert.deepEqual(events,['start']);finish('你好');await c.pending;assert.deepEqual(events,['start','partial:你好','final:你好']);await c.dispose();
});
test('continuous ASR preview pieces accumulate before authoritative full recognition',async()=>{
  const partial=[],final=[];let count=0;const c=new Capture({transcribe:async()=>['hello','world','hello world'][count++],onPartial:t=>partial.push(t),onFinal:t=>final.push(t)});
  for(let i=0;i<120;i++)c.accept(frame(),.9);await tick();const text=await c.stop();assert.equal(text,'hello world');assert.deepEqual(partial,['hello','hello world']);assert.deepEqual(final,['hello world']);
});
test('dispose aborts ASR and isolates late results',async()=>{
  let finish,signal;const final=[];const c=new Capture({transcribe:(_b,s)=>{signal=s;return new Promise(r=>finish=r);},onFinal:t=>final.push(t)});
  for(let i=0;i<110;i++)c.accept(frame(),.9);await tick();await c.dispose();assert.equal(signal.aborted,true);finish('late');await tick();assert.deepEqual(final,[]);assert.equal(c.backlog,0);
});
test('ASR queue stays bounded',async()=>{const c=new Capture({transcribe:()=>new Promise(()=>{}),onError:()=>{}});for(let i=0;i<2000;i++)c.accept(frame(),.9);assert.ok(c.backlog<=12);await c.dispose();});
test('realtime capture sends preroll immediately then every 20 ms without retaining upload tasks',async()=>{
  const packets=[],c=new Capture({realtime:{append:(frames,id)=>packets.push({frames,id}),close:async()=>{}}});
  for(let i=0;i<10;i++)c.accept(frame(0),0);for(let i=0;i<4;i++)c.accept(frame(),.9);assert.equal(packets.length,0);
  c.accept(frame(),.9);assert.equal(packets.length,1);assert.equal(packets[0].frames.length,11);assert.equal(packets[0].frames.reduce((sum,f)=>sum+f.length,0),5280);
  c.accept(frame(),.9);c.accept(frame(),.9);assert.deepEqual(packets.slice(1).map(p=>p.frames.length),[1,1]);assert.equal(c.backlog,0);assert.equal(c.tasks.size,0);assert.equal(c.segment.frames.length,0);await c.dispose();
});
test('realtime commits establish immediate barriers while old finals never block new capture',async()=>{
  const events=[],partials=[],finals=[],resolve=new Map(),callbacks=new Map();
  const c=new Capture({realtime:{append:(_frames,id,onPartial)=>{events.push(['append',id]);callbacks.set(id,onPartial);},commit:id=>{events.push(['commit',id]);return new Promise(done=>resolve.set(id,done));},close:async()=>{}},onPartial:(text,meta)=>partials.push([text,meta.utteranceId]),onFinal:(text,meta)=>finals.push([text,meta.utteranceId])});
  for(let i=0;i<5;i++)c.accept(frame(),.9);const first=c.commit();assert.deepEqual(events,[['append',1],['commit',1]]);
  for(let i=0;i<5;i++)c.accept(frame(),.9);assert.deepEqual(events.at(-1),['append',2]);callbacks.get(1)('stale');callbacks.get(2)('current');assert.deepEqual(partials,[['current',2]]);
  const second=c.commit();assert.deepEqual(events.at(-1),['commit',2]);resolve.get(2)('two');await tick();assert.deepEqual(finals,[]);resolve.get(1)('one');await Promise.all([first,second]);assert.deepEqual(finals,[['one',1],['two',2]]);await c.dispose();
});
test('muting realtime capture isolates old partials and commits across generations',async()=>{
  const finals=[],partials=[];let finish,partial,clears=0;const c=new Capture({realtime:{append:(_f,_id,cb)=>partial=cb,commit:()=>new Promise(done=>finish=done),clear:async()=>{clears++;},close:async()=>{}},onFinal:t=>finals.push(t),onPartial:t=>partials.push(t)});
  for(let i=0;i<5;i++)c.accept(frame(),.9);const committed=c.commit();c.setMuted(true);partial('late');finish('late');await committed;assert.deepEqual(finals,[]);assert.deepEqual(partials,[]);assert.equal(clears,1);await c.dispose();
});
test('capture uses 320 ms endpoint and requires sustained speech during playback',async()=>{
  const commits=[],c=new Capture({realtime:{append:()=>{},commit:id=>{commits.push(id);return Promise.resolve('');},close:async()=>{}}});
  c.setPlaybackActive(true);for(let i=0;i<15;i++)c.accept(frame(),.9);assert.equal(c.segment,null);c.accept(frame(),.9);assert.ok(c.segment);for(let i=0;i<15;i++)c.accept(frame(0),0);assert.deepEqual(commits,[]);c.accept(frame(0),0);assert.deepEqual(commits,[1]);await c.pending;await c.dispose();
});

test('playback rejects brief close-mic transients and sustained ambiguous noise before interruption',async()=>{
  const starts=[],packets=[],c=new Capture({realtime:{append:frames=>packets.push(frames),close:async()=>{}},onSpeechStart:id=>starts.push(id)});
  c.setPlaybackActive(true);
  // Loud near-mic sound alone is insufficient even when RNNoise is moderately
  // confident. Brief high-confidence mouth sounds cannot accumulate either.
  for(let i=0;i<100;i++)c.accept(frame(16000),.8);
  for(let burst=0;burst<3;burst++){for(let i=0;i<15;i++)c.accept(frame(16000),.99);c.accept(frame(0),0);}
  assert.deepEqual(starts,[]);assert.deepEqual(packets,[]);assert.equal(c.segment,null);
  // The energy floor is unchanged: sustained speech just above it still wins.
  for(let i=0;i<15;i++)c.accept(frame(300),.9);assert.deepEqual(starts,[]);
  c.accept(frame(300),.9);assert.deepEqual(starts,[1]);assert.equal(packets.length,1);
  const speech=packets[0].flatMap(part=>[...part]).filter(sample=>sample===300);
  assert.equal(speech.length,16*480,'the whole confirmed onset must survive in preroll');
  await c.dispose();
});

test('playback boundary candidates reset without delaying ordinary listening',async t=>{
  let now=1000;t.mock.method(Date,'now',()=>now);
  const c=new Capture({transcribe:async()=>''});
  for(let i=0;i<4;i++)c.accept(frame(),.9);
  c.setPlaybackActive(true);for(let i=0;i<15;i++)c.accept(frame(),.9);
  assert.equal(c.segment,null);assert.equal(c.attack,300);
  c.accept(frame(),.9);assert.ok(c.segment);await c.dispose();
  const tail=new Capture({transcribe:async()=>''});
  tail.setPlaybackActive(true);tail.setPlaybackActive(false);
  for(let i=0;i<10;i++){tail.accept(frame(),.9);now+=20;}
  assert.equal(tail.segment,null);now+=21;
  for(let i=0;i<4;i++)tail.accept(frame(100),.6);
  assert.equal(tail.segment,null);assert.equal(tail.attack,80);
  tail.accept(frame(100),.6);assert.ok(tail.segment,'idle speech still starts at 100 ms');
  await tail.dispose();
});
test('player joins odd PCM bytes and isolates old epochs',async()=>{
  const messages=[];const p=new PCMPlayer();p.context={state:'running'};p.node={port:{postMessage:m=>messages.push(m)}};
  await p.enqueue(new Uint8Array([1]),1);await p.enqueue(new Uint8Array([2,3,4]),1);p.segmentEnd(1);assert.deepEqual([...new Int16Array(messages[0].data)],[513,1027]);assert.equal(messages.at(-1).type,'end');p.clear();assert.equal(p.queued,0);
});

test('player forwards PCM through one shared path without adapter-specific startup options',async()=>{
  const messages=[],p=new PCMPlayer();p.context={state:'running'};p.node={port:{postMessage:m=>messages.push(m)}};
  await p.enqueue(new Uint8Array([1,0,2,0]),1);
  await p.enqueue(new Uint8Array([3,0]),2);
  await p.enqueue(new Uint8Array([4,0]),3);
  assert(messages.every(m=>Object.keys(m).sort().join(',')==='data,epoch,id,type'));
  assert.deepEqual(messages.map(m=>[...new Int16Array(m.data)]),[[1,2],[3],[4]]);
  p.clear();await p.enqueue(new Uint8Array([5,0]),4);
  assert.equal(messages.at(-1).epoch,1);
});

test('player forwards render metrics with its local clock and rejects stale playback events',async t=>{
  const metrics=[],starts=[],previousAudio=globalThis.AudioContext,previousNode=globalThis.AudioWorkletNode;
  globalThis.AudioContext=class{constructor(options){assert.equal(options.latencyHint,'interactive');this.state='running';this.destination={};this.audioWorklet={addModule:async()=>{}};}async resume(){}async close(){this.state='closed';}};
  globalThis.AudioWorkletNode=class{constructor(){this.port={postMessage(){}};}connect(){}disconnect(){}};
  t.after(()=>{globalThis.AudioContext=previousAudio;globalThis.AudioWorkletNode=previousNode;});
  const p=new PCMPlayer({now:()=>1234,onMetrics:value=>metrics.push(value),onPlaybackStart:value=>starts.push(value)});await p.start();
  const node=p.node,event={type:'playing',epoch:0,id:7,buffer_ms:80,first_buffer_ms:80,underruns:0,gap_ms:0,queued_ms:100};
  node.port.onmessage({data:event});assert.equal(starts.length,1);assert.equal(starts[0].id,7);assert.equal(starts[0].at,1234);
  assert.equal(metrics[0].type,'playback');assert.equal(metrics[0].event,'playing');assert.equal(metrics[0].buffer_ms,80);assert.equal(metrics[0].bufferedSeconds,.1);
  node.port.onmessage({data:{...event,type:'buffering',buffer_ms:120,underruns:1,queued_ms:.5}});
  assert.equal(metrics.at(-1).event,'buffering');assert.equal(metrics.at(-1).underruns,1);
  node.port.onmessage({data:{type:'segment_ended',epoch:0,id:7,render_time_ms:456.7,render_frame:21922}});
  assert.equal(metrics.at(-1).event,'segment_ended');assert.equal(metrics.at(-1).render_time_ms,456.7);
  p.clear();node.port.onmessage({data:event});assert.equal(starts.length,1);assert.equal(metrics.length,3);await p.dispose();
});
test('playback worklet resamples 48/44.1 kHz and ACKs only consumed PCM',async()=>{
  const code=await fs.readFile(new URL('../client/audio-worklet.js',import.meta.url),'utf8');
  for(const sampleRate of [48000,44100]){
    const types={},sent=[];const context={sampleRate,AudioWorkletProcessor:class{constructor(){this.port={postMessage:m=>sent.push(m)};}},registerProcessor:(n,c)=>types[n]=c};vm.runInNewContext(code,context);
    assert.deepEqual(Object.keys(types),['voice-playback']);
    const player=new types['voice-playback']();player.port.onmessage({data:{type:'pcm',epoch:0,id:1,data:new Int16Array(480).fill(1000).buffer}});player.port.onmessage({data:{type:'end',epoch:0,id:1}});assert.equal(sent.length,0);
    player.process([],[[new Float32Array(128)]]);assert.equal(sent.some(x=>x.type==='played'),false);for(let i=0;i<10;i++)player.process([],[[new Float32Array(128)]]);assert.equal(sent.filter(x=>x.type==='played').length,1);
  }
});
test('player clear releases buffer backpressure and discards stale packet',async()=>{
  const messages=[],p=new PCMPlayer({maxBufferedSeconds:1});p.context={state:'running'};p.node={port:{postMessage:m=>messages.push(m)}};
  await p.enqueue(new Uint8Array(48000),1);const blocked=p.enqueue(new Uint8Array(4),1);await tick();p.clear();await blocked;assert.equal(messages.filter(m=>m.type==='pcm').length,2);assert.equal(p.queued,0);
});
test('RMS level callback reflects PCM energy and throttles UI updates',()=>{const values=[];const capture=new Capture({onLevel:value=>values.push(value)});capture.active=true;capture.accept(frame(0),0);capture.accept(frame(4000),.9);assert.equal(values.length,1);assert.equal(values[0],0);capture.levelAt=0;capture.accept(frame(4000),.9);assert.ok(values[1]>.5&&values[1]<=1);capture.active=false;});
test('muting disables microphone track, drops input and ignores delayed recognizer results',async()=>{
  const finals=[],ends=[];let resolve;const c=new Capture({transcribe:()=>new Promise(done=>resolve=done),onFinal:t=>finals.push(t),onSpeechEnd:(id,m)=>ends.push([id,m.cancelled])});
  const track={enabled:true};c.stream={getAudioTracks:()=>[track],getTracks:()=>[]};for(let i=0;i<110;i++)c.accept(frame(),.9);await tick();c.setMuted(true);assert.equal(track.enabled,false);assert.equal(c.segment,null);for(let i=0;i<100;i++)c.accept(frame(),.9);assert.equal(c.segment,null);resolve('stale');await c.pending;assert.deepEqual(finals,[]);assert.deepEqual(ends,[[1,true]]);c.setMuted(false);assert.equal(track.enabled,true);await c.dispose();
});
test('empty ASR final still closes local utterance so controller never remains busy',async()=>{
  const events=[];const c=new Capture({transcribe:async()=>'',onSpeechEnd:(id)=>events.push(['end',id]),onFinal:(text,meta)=>events.push(['final',text,meta.final])});for(let i=0;i<10;i++)c.accept(frame(),.9);await c.stop();assert.deepEqual(events,[['end',1],['final','',true]]);
});
test('playback startup prebuffer holds short incomplete streams then flushes completed tail',async()=>{
  const code=await fs.readFile(new URL('../client/audio-worklet.js',import.meta.url),'utf8'),types={},sent=[];
  vm.runInNewContext(code,{sampleRate:48000,AudioWorkletProcessor:class{constructor(){this.port={postMessage:m=>sent.push(m)};}},registerProcessor:(n,c)=>types[n]=c});
  const p=new types['voice-playback']();p.port.onmessage({data:{type:'pcm',epoch:0,id:1,data:new Int16Array(480).fill(1000).buffer}});const out=new Float32Array(128);p.process([],[[out]]);assert.equal(out.some(Boolean),false);assert.equal(sent.length,0);p.port.onmessage({data:{type:'end',epoch:0,id:1}});for(let i=0;i<8;i++)p.process([],[[out]]);assert.equal(sent.filter(e=>e.type==='played').length,1);assert.ok(sent.some(e=>e.type==='playing'));assert.ok(sent.some(e=>e.type==='idle'));
});
test('playback uses bounded observation and preserves activity through a same-segment supply gap',async()=>{
  const code=await fs.readFile(new URL('../client/audio-worklet.js',import.meta.url),'utf8'),types={},sent=[];
  vm.runInNewContext(code,{sampleRate:48000,AudioWorkletProcessor:class{constructor(){this.port={postMessage:m=>sent.push(m)};}},registerProcessor:(n,c)=>types[n]=c});
  const p=new types['voice-playback'](),render=()=>p.process([],[[new Float32Array(128)]]),send=(type,samples=0)=>p.port.onmessage({data:{type,epoch:0,id:1,data:new Int16Array(samples).fill(1000).buffer}});
  send('pcm',1920);render();assert.equal(sent.some(e=>e.type==='playing'),false);
  for(let i=0;i<110;i++)render();assert.equal(sent.filter(e=>e.type==='playing').length,1);assert.equal(sent.filter(e=>e.type==='buffering').length,1);assert.equal(sent.some(e=>e.type==='idle'),false);
  send('pcm',12000);send('end');for(let i=0;i<200;i++)render();assert.equal(sent.filter(e=>e.type==='played').length,1);assert.equal(sent.filter(e=>e.type==='idle').length,1);assert.equal(sent.filter(e=>e.type==='playing').length,1);
});

test('playback retains learned same-route supply while clear isolates epochs and route reset clears only learning',async()=>{
  const code=await fs.readFile(new URL('../client/audio-worklet.js',import.meta.url),'utf8'),types={},sent=[];
  vm.runInNewContext(code,{sampleRate:48000,AudioWorkletProcessor:class{constructor(){this.port={postMessage:m=>sent.push(m)};}},registerProcessor:(n,c)=>types[n]=c});
  const p=new types['voice-playback'](),render=()=>p.process([],[[new Float32Array(128)]]);
  p.port.onmessage({data:{type:'pcm',epoch:0,id:1,data:new Int16Array(2400).fill(1000).buffer}});for(let i=0;i<160;i++)render();
  p.port.onmessage({data:{type:'pcm',epoch:0,id:1,data:new Int16Array(2400).fill(1000).buffer}});const learned=p.target;assert(learned>1920&&learned<=28800);
  p.port.onmessage({data:{type:'clear',epoch:1}});p.port.onmessage({data:{type:'pcm',epoch:0,id:1,data:new Int16Array(2000).buffer}});assert.equal(p.target,learned);assert.equal(p.written,0);assert.equal(p.active,false);
  p.port.onmessage({data:{type:'pcm',epoch:1,id:2,data:new Int16Array(2400).buffer}});p.port.onmessage({data:{type:'reset_supply',epoch:0}});assert.equal(p.target,learned);
  p.port.onmessage({data:{type:'reset_supply',epoch:1}});assert.equal(p.target,1920);assert.equal(p.written,2400);
});
