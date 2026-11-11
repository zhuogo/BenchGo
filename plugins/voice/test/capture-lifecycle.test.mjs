import test from 'node:test';
import assert from 'node:assert/strict';
import { Capture } from '../client/media.mjs';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function fixture(t,{mediaReady,noiseReady,resumeReady,startupTimeoutMs}={}){
  const events=[],contexts=[],errors=[],accepted=[];
  const track={enabled:true,stops:0,stop(){this.stops++;events.push('track.stop');}};
  const stream={getTracks:()=>[track],getAudioTracks:()=>[track]};
  const source={connect(node){assert.equal(node,noise.node);events.push('source.connect');},disconnect(){events.push('source.disconnect');}};
  const node={port:{onmessage:null,postMessage(message){events.push(['post',message]);}},connect(){events.push('noise.connect');},disconnect(){events.push('noise.disconnect');},onprocessorerror:null};
  const noise={node,disposed:0,dispose(){this.disposed++;events.push('noise.dispose');}};
  const previous=new Map(['navigator','AudioContext','document'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  for(const [key,value] of Object.entries({navigator:{mediaDevices:{async getUserMedia(options){events.push(['media',options]);return mediaReady?await mediaReady.promise:stream;}}},document:{baseURI:'https://benchgo.test/app/'},AudioContext:class{
    constructor(options){this.state='suspended';this.options=options;this.destination={};this.closed=0;contexts.push(this);}
    async resume(){events.push('context.resume');if(resumeReady)await resumeReady.promise;this.state='running';}
    createMediaStreamSource(value){assert.equal(value,stream);events.push('source.create');return source;}
    async close(){this.closed++;this.state='closed';events.push('context.close');}
  }}))Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  const capture=new Capture({startupTimeoutMs,transcribe:async()=>'',createNoise:async(context,options)=>{events.push(['noise.create',options]);if(noiseReady)await noiseReady.promise;return noise;},onError:error=>errors.push(error.message)});
  capture.accept=(pcm,probability)=>accepted.push({pcm:[...pcm],probability});
  t.after(async()=>{await capture.dispose();for(const [key,descriptor] of previous)if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];});
  return {capture,events,contexts,errors,accepted,track,stream,node,noise};
}

test('capture waits for local noise readiness before connecting and forwards modeled PCM',async t=>{
  const ready=deferred(),h=fixture(t,{noiseReady:ready});
  const starting=h.capture.start();await tick();
  assert.deepEqual(h.events[0],['media',{audio:{channelCount:1,sampleRate:48000,echoCancellation:true,noiseSuppression:false,autoGainControl:false}}]);
  assert.deepEqual(h.contexts[0].options,{sampleRate:48000});
  assert.equal(h.events.includes('source.create'),false);assert.equal(h.events.includes('noise.connect'),false);
  const options=h.events.find(event=>event[0]==='noise.create')[1];
  assert.equal(String(options.workletURL),'https://benchgo.test/app/api/voice/noise-worklet');
  assert.equal(String(options.wasmURL),'https://benchgo.test/app/api/voice/noise-wasm');
  ready.resolve();await starting;
  assert.ok(h.events.includes('source.connect'));assert.ok(h.events.includes('noise.connect'));
  const message={type:'pcm',epoch:h.capture.generation,data:new Int16Array([10,-10]).buffer,probability:.72};
  h.node.port.onmessage({data:{...message,epoch:0}});assert.deepEqual(h.accepted,[]);
  h.node.port.onmessage({data:message});assert.deepEqual(h.accepted,[{pcm:[10,-10],probability:.72}]);
  await h.capture.dispose();assert.equal(h.track.stops,1);assert.equal(h.contexts[0].closed,1);assert.equal(h.noise.disposed,1);
  assert.equal(h.node.port.onmessage,null);assert.equal(h.node.onprocessorerror,null);
});

for(const kind of ['error','missing-probability','processorerror'])test(`capture stops rather than bypassing failed denoising: ${kind}`,async t=>{
  const h=fixture(t);await h.capture.start();
  if(kind==='processorerror')h.node.onprocessorerror();
  else h.node.port.onmessage({data:{type:kind==='error'?'error':'pcm',epoch:h.capture.generation,data:new Int16Array(480).buffer}});
  await tick();assert.equal(h.errors.length,1);assert.equal(h.capture.active,false);assert.equal(h.track.stops,1);assert.equal(h.contexts[0].closed,1);assert.equal(h.noise.disposed,1);assert.deepEqual(h.accepted,[]);
});

test('muting updates the processor epoch and only current unmuted PCM is accepted',async t=>{
  const h=fixture(t);await h.capture.start();const first=h.capture.generation;
  h.capture.setMuted(true);assert.equal(h.track.enabled,false);
  const send=epoch=>h.node.port.onmessage({data:{type:'pcm',epoch,data:new Int16Array([1]).buffer,probability:.9}});
  send(first);send(h.capture.generation);assert.deepEqual(h.accepted,[]);
  h.capture.setMuted(false);assert.equal(h.track.enabled,true);send(first);send(h.capture.generation);
  assert.equal(h.accepted.length,1);
  assert.deepEqual(h.events.filter(Array.isArray).filter(event=>event[0]==='post').map(event=>event[1]),[{type:'mute',value:false,epoch:first},{type:'mute',value:true,epoch:first+1},{type:'mute',value:false,epoch:first+1}]);
});

test('hangup during microphone permission stops late tracks without creating audio resources',async t=>{
  const media=deferred(),h=fixture(t,{mediaReady:media});const starting=h.capture.start();
  await h.capture.dispose();await starting;media.resolve(h.stream);await tick();
  assert.equal(h.track.stops,1);assert.equal(h.contexts.length,0);assert.equal(h.noise.disposed,0);assert.equal(h.capture.active,false);
});

test('hangup during noise initialization aborts assets and disposes late processor',async t=>{
  const ready=deferred(),h=fixture(t,{noiseReady:ready});const starting=h.capture.start();await tick();
  const signal=h.events.find(event=>event[0]==='noise.create')[1].signal;
  await h.capture.dispose();assert.equal(signal.aborted,true);assert.equal(h.track.stops,1);assert.equal(h.contexts[0].closed,1);
  await starting;ready.resolve();await tick();assert.equal(h.noise.disposed,1);assert.equal(h.events.includes('source.create'),false);
});

test('hangup while the audio context resumes never starts a late noise processor',async t=>{
  const resume=deferred(),h=fixture(t,{resumeReady:resume});const starting=h.capture.start();await tick();
  await h.capture.dispose();resume.resolve();await starting;
  assert.equal(h.events.some(event=>Array.isArray(event)&&event[0]==='noise.create'),false);
  assert.equal(h.track.stops,1);assert.equal(h.contexts[0].closed,1);assert.deepEqual(h.errors,[]);
});

test('noise initialization rejection releases the microphone and context',async t=>{
  const ready=deferred(),h=fixture(t,{noiseReady:ready});const starting=h.capture.start();await tick();ready.reject(Error('asset failed'));
  await assert.rejects(starting,/asset failed/);assert.equal(h.track.stops,1);assert.equal(h.contexts[0].closed,1);assert.equal(h.capture.active,false);assert.equal(h.events.includes('source.create'),false);
});

test('processor failure after mute and unmute still stops capture',async t=>{
  const h=fixture(t);await h.capture.start();h.capture.setMuted(true);h.capture.setMuted(false);
  h.node.onprocessorerror();await tick();assert.equal(h.errors.length,1);assert.equal(h.capture.active,false);
});

test('unanswered microphone permission times out and releases late tracks',async t=>{
  const media=deferred(),h=fixture(t,{mediaReady:media,startupTimeoutMs:15});
  await assert.rejects(h.capture.start(),/麦克风初始化超时/);
  assert.equal(h.capture.active,false);assert.equal(h.contexts.length,0);
  media.resolve(h.stream);await tick();assert.equal(h.track.stops,1);assert.equal(h.contexts.length,0);
});

test('timeout during audio resume releases tracks and context without waiting for the browser',async t=>{
  const resume=deferred(),h=fixture(t,{resumeReady:resume,startupTimeoutMs:15});
  await assert.rejects(h.capture.start(),/麦克风初始化超时/);
  assert.equal(h.track.stops,1);assert.equal(h.contexts[0].closed,1);
  assert.equal(h.events.some(event=>Array.isArray(event)&&event[0]==='noise.create'),false);
  resume.resolve();await tick();assert.equal(h.contexts[0].closed,1);
});

test('late permission from a cancelled attempt cannot close a new capture',async t=>{
  const media=deferred(),h=fixture(t,{mediaReady:media});const first=h.capture.start();
  await h.capture.dispose();await first;
  navigator.mediaDevices.getUserMedia=async()=>h.stream;
  await h.capture.start();const activeContext=h.contexts[0];
  const oldTrack={stops:0,stop(){this.stops++;}};media.resolve({getTracks:()=>[oldTrack]});await tick();
  assert.equal(oldTrack.stops,1);assert.equal(h.track.stops,0);assert.equal(activeContext.closed,0);assert.equal(h.capture.active,true);
});
