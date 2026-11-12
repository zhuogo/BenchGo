import test from 'node:test';
import assert from 'node:assert/strict';
import { CallLatency } from '../client/latency.mjs';

test('a prefetched later sentence cannot claim the head sentence first-audio latency',()=>{
  let time=400;const metric=new CallLatency({now:()=>time});metric.input(1);metric.recognition(1,{speechEndedAt:0,endpointAt:320},true);metric.submit();metric.bind(1);metric.bind(2);
  metric.tts({type:'tts.first_audio',id:2,at:500,first_byte_ms:100});assert.equal(metric.snapshot().current.first_audio_ms,null);
  metric.tts({type:'tts.first_audio',id:1,at:700,first_byte_ms:300});assert.equal(metric.snapshot().current.first_audio_ms,700);
  time=800;metric.playback({id:1},true);assert.equal(metric.snapshot().current.first_playback_ms,400);
});

test('timing history and segment bindings remain bounded in a long call',()=>{
  const metric=new CallLatency({now:()=>1000});
  for(let id=0;id<300;id++){metric.input(id);metric.submit();metric.bind(id);metric.tts({type:'tts.first_audio',id,at:1200,first_byte_ms:200});}
  assert.equal(metric.snapshot().history.length,16);assert.equal(metric.segments.size,128);
  const before=metric.snapshot();metric.tts({type:'tts.first_audio',id:0,at:9000,first_byte_ms:8000});assert.deepEqual(metric.snapshot(),before);
  metric.reset();assert.deepEqual(metric.snapshot(),{current:null,history:[]});assert.equal(metric.segments.size,0);
});

test('segment diagnostics separate synthesis backpressure from actual rendered sentence gaps',()=>{
  let time=400;const metric=new CallLatency({now:()=>time});metric.input(1);metric.recognition(1,{speechEndedAt:0});metric.submit();metric.bind(1);metric.bind(2);
  metric.tts({type:'tts.start',id:2,at:500,request_wait_ms:100});
  metric.tts({type:'tts.end',id:2,at:1900,audio_ms:1000,chunks:5,max_audio_gap_ms:50,backpressure_ms:1000,status:'complete'});
  metric.playback({id:1,event:'segment_started',render_time_ms:1000},true);
  metric.playback({id:1,event:'segment_ended',render_time_ms:1800});
  time=9999;metric.playback({id:2,event:'segment_started',render_time_ms:1850},true);
  const value=metric.snapshot().current,second=value.segments.find(row=>row.segment_id===2);
  assert.equal(second.request_wait_ms,100);assert.equal(second.max_audio_gap_ms,50);assert.equal(second.backpressure_ms,1000);
  assert.equal(second.previous_gap_ms,50);assert.equal(value.playback.segment_gap_ms,50);
  second.audio_ms=0;assert.equal(metric.snapshot().current.segments.find(row=>row.segment_id===2).audio_ms,1000);
  for(let id=3;id<50;id++){metric.bind(id);metric.tts({type:'tts.queued',id,at:2000});}
  assert.equal(metric.snapshot().current.segments.length,32);
});
