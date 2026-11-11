import test from 'node:test';
import assert from 'node:assert/strict';
import { PCMPlayer } from '../client/media.mjs';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function fixture(t,{moduleReady,resumeReady,startupTimeoutMs}={}){
  const contexts=[],nodes=[];
  const previous=new Map(['AudioContext','AudioWorkletNode'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  class Audio {
    constructor(){this.state='suspended';this.closed=0;this.destination={};this.audioWorklet={addModule:()=>moduleReady?.promise||Promise.resolve()};contexts.push(this);}
    async resume(){if(resumeReady)await resumeReady.promise;this.state='running';}
    async close(){this.state='closed';this.closed++;}
  }
  class Node {
    constructor(){this.disconnected=0;this.port={postMessage(){},onmessage:null};nodes.push(this);}
    connect(){}
    disconnect(){this.disconnected++;}
  }
  for(const [key,value] of Object.entries({AudioContext:Audio,AudioWorkletNode:Node}))Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  const player=new PCMPlayer({startupTimeoutMs});
  t.after(async()=>{await player.dispose();for(const [key,descriptor] of previous)if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];});
  return {player,contexts,nodes};
}

for(const stage of ['module','resume'])test(`playback ${stage} initialization has a finite deadline`,async t=>{
  const gate=deferred(),h=fixture(t,{[stage==='module'?'moduleReady':'resumeReady']:gate,startupTimeoutMs:15});
  await assert.rejects(h.player.start(),/音频播放初始化超时/);
  assert.equal(h.contexts[0].closed,1);assert.equal(h.player.context,null);assert.equal(h.player.starting,null);
  const created=h.nodes.length;gate.resolve();await tick();assert.equal(h.nodes.length,created);assert.equal(h.contexts[0].closed,1);
});

test('hangup cancels a pending playback worklet immediately and never creates a late node',async t=>{
  const gate=deferred(),h=fixture(t,{moduleReady:gate});const rejected=assert.rejects(h.player.start(),{name:'AbortError'});
  await h.player.dispose();await rejected;assert.equal(h.contexts[0].closed,1);assert.equal(h.nodes.length,0);
  gate.resolve();await tick();assert.equal(h.nodes.length,0);assert.equal(h.contexts[0].closed,1);
});

test('late playback initialization cannot replace or close the next player context',async t=>{
  const gate=deferred(),h=fixture(t,{moduleReady:gate});const rejected=assert.rejects(h.player.start(),{name:'AbortError'});
  await h.player.dispose();await rejected;
  const next=h.player.start();gate.resolve();await next;
  assert.equal(h.contexts.length,2);assert.equal(h.nodes.length,1);assert.equal(h.player.context,h.contexts[1]);assert.equal(h.contexts[1].closed,0);
});
