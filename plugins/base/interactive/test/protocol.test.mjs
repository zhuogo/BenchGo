import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInteractive, splitInteractive, validateForm, responseText } from '../client/protocol.mjs';
import { sendInteractive } from '../client/send.mjs';
import { mountInteractivePrompt } from '../src/prompt.mjs';

const form = { id:'preferences',type:'form',fields:[{id:'count',type:'number',label:'数量',required:true,min:1,max:10,step:1},{id:'choice',type:'select',label:'方案',required:true,options:[{label:'A',value:'a'}]},{id:'date',type:'date',label:'日期'}] };
const encode = blocks => JSON.stringify({version:1,blocks});
test('schema keeps supported data and rejects executable/unknown schemas', () => {
  assert.equal(parseInteractive(encode([form])).blocks[0].fields.length,3);
  for(const value of [encode([{type:'iframe',url:'https://example.com'}]),'{"version":1,"blocks":[],"__proto__":{}}',JSON.stringify({componentName:'Page'}),encode([{type:'chart',kind:'pie',data:[]}]), encode([{type:'table',columns:['x'],rows:[[1,2]]}])]) assert.throws(()=>parseInteractive(value));
  assert.throws(()=>parseInteractive(encode([{type:'form',fields:[{id:'x',type:'text',label:'x'},{id:'x',type:'text',label:'y'}]}])));
  assert.throws(()=>parseInteractive(' '.repeat(65537)));
});
test('ordinary fences stay verbatim and interactive state follows actual completeness',()=>{
  const schema=encode([]), wrapped='Before\n```benchgo-ui\n'+schema+'\n```\nAfter';
  const split=splitInteractive(wrapped); assert.deepEqual(split.map(x=>x.kind),['markdown','interactive','markdown']); assert.equal(split[1].complete,true);
  const example='````markdown\n```benchgo-ui\n'+schema+'\n```\n````'; assert.deepEqual(splitInteractive(example),[{kind:'markdown',text:example}]);
  assert.equal(splitInteractive('```benchgo-ui\n{"version":',true)[0].loading,true);
  assert.equal(splitInteractive('```benchgo-ui\n{"version":',false)[0].loading,false);
  assert.equal(splitInteractive('<schemaJson>\n'+schema+'\n</schemaJson>')[0].complete,true);
});
test('form validation checks all fields before submission and preserves opaque choice values',()=>{
  const block=parseInteractive(encode([form])).blocks[0];
  assert.throws(()=>validateForm(block,{}),/数量/); assert.throws(()=>validateForm(block,{count:2,choice:'b'}),/无效选项/);
  assert.throws(()=>validateForm(block,{count:2.5,choice:'a'}),/步长/); assert.throws(()=>validateForm(block,{count:2,choice:'a',date:'2026-02-30'}),/有效日期/);
  assert.deepEqual({...validateForm(block,{count:'2',choice:'a',date:'2026-11-07'})},{count:2,choice:'a',date:'2026-11-07'});
  assert.match(responseText({title:'选择'},block,{choice:'opaque:model/1'}),/opaque:model\/1/);
});
test('submission uses official admission, preserves id on retry and releases references',async()=>{
  let calls=0,releases=0,requestIds=[];
  const session={getSnapshot:()=>({running:false}),beginSubmission:()=>({requestId:'stable-id'}),prompt:async(content,mode,signal,id)=>{requestIds.push(id); assert.equal(mode,'queue');assert.deepEqual(content,[{type:'text',text:'answer'}]); if(!calls++) throw Error('offline');return {ok:true};}};
  const sessions={using:async(id,options,run)=>{assert.equal(id,'session-a');try{return await run({binding:{session}})}finally{releases++}}},request={};
  await assert.rejects(sendInteractive(sessions,'session-a','answer',request),/offline/);
  await sendInteractive(sessions,'session-a','answer',request);assert.deepEqual(requestIds,['stable-id','stable-id']);assert.equal(releases,2);
  session.getSnapshot=()=>({running:true});await assert.rejects(sendInteractive(sessions,'session-a','answer',{}),/等待/);
  session.getSnapshot=()=>({running:false});session.prompt=async()=>({ok:false,error:{message:'denied'}});await assert.rejects(sendInteractive(sessions,'session-a','answer',{}),/denied/);
});
test('prompt attaches to existing and newly created Agent scopes and releases on unload',()=>{
  let count=0,removed=0,cleanup;const events=new Map();
  const makeAgent=()=>({ctx:{systemPrompt:{section:options=>{assert.equal(options.name,'benchgo:interactive'); count++;return ()=>removed++}}}});
  const existing=makeAgent(),next=makeAgent();
  mountInteractivePrompt({inject:(dependencies,run)=>{assert.deepEqual(dependencies,['agents']);run({agents:{list:()=>[existing]},on:(event,handler)=>events.set(event,handler),effect:fn=>{cleanup=fn()}})}});
  assert.equal(count,1);events.get('agent/created')({agent:next});events.get('agent/created')({agent:next});assert.equal(count,2);
  events.get('agent/disposed')({agent:existing});cleanup();assert.equal(removed,2);
});
