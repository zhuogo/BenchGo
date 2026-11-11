import test from 'node:test';
import assert from 'node:assert/strict';
import {AgentFeed} from '../client/agent-feed.mjs';
const entry=(seq,type,data={})=>({type:type==='assistant/live-chunk'?'transient':'event',event:{seq,type,data}});
const live=(seq,text,id='a')=>entry(seq,'assistant/live-chunk',{attemptId:id,turn:1,step:1,chunk:{type:'text-delta',text}});
function harness(history=[]){const out=[],events=[],feed=new AgentFeed({onText:t=>out.push(t),onStart:()=>events.push('start'),onReset:()=>events.push('reset'),onEnd:()=>events.push('end')});let revision=0;feed.baseline({revision,entries:history});return {feed,out,events,append(...entries){feed.accept({revision:++revision,change:{kind:'append',entries}});},settle(id,e){feed.accept({revision:++revision,change:{kind:'settle-assistant',attemptId:id,entry:e}});}};}
test('fresh deltas and settlement emit exactly once without reasoning',()=>{const h=harness();h.append(entry(1,'turn/start'));const a=live(1.1,'你好');h.append(a);h.append(a);h.append(entry(1.2,'assistant/live-chunk',{attemptId:'a',chunk:{type:'reasoning-delta',text:'secret'}}));const settle=entry(2,'assistant/message',{message:{content:[{type:'text',text:'你好世界'},{type:'reasoning',text:'hidden'}]}});h.settle('a',settle);h.settle('a',settle);assert.deepEqual(h.out,['你好','世界']);});
test('history baseline and prepends never read; active baseline prefix avoids replay',()=>{const h=harness([live(1.1,'旧文本')]);h.settle('a',entry(2,'assistant/message',{message:{content:[{type:'text',text:'旧文本新增'}]}}));assert.deepEqual(h.out,['新增']);h.feed.accept({revision:10,change:{kind:'prepend',entries:[entry(0,'assistant/message',{message:{content:[{type:'text',text:'历史'}]}})]}});assert.deepEqual(h.out,['新增']);});
test('retry clears old attempt then allows new attempt and its settlement',()=>{const h=harness();h.append(entry(1,'turn/start'),live(1.1,'失败前'));h.append(entry(2,'llm/retry'));h.append(live(2.1,'恢复','b'));h.settle('b',entry(3,'assistant/message',{message:{content:[{type:'text',text:'恢复成功'}]}}));h.append(entry(4,'turn/end'));assert.deepEqual(h.events,['start','reset','start','end']);assert.deepEqual(h.out,['失败前','恢复','成功']);});
test('replacement rebaselines and interrupted settlement does not emit unseen suffix',()=>{const h=harness();h.append(live(1.1,'已流式'));h.settle('a',entry(2,'assistant/message',{interrupted:true,message:{content:[{type:'text',text:'已流式未播后缀'}]}}));h.feed.accept({revision:9,entries:[entry(3,'assistant/message',{message:{content:[{type:'text',text:'恢复历史'}]}})],change:{kind:'replace'}});assert.deepEqual(h.out,['已流式']);assert.deepEqual(h.events,['reset']);});
test('successful durable append consumes the matching live prefix before retirement',()=>{
  const h=harness();h.append(entry(1,'turn/start'),live(1.1,'你好'));
  const message=entry(2,'assistant/message',{turn:1,step:1,message:{content:[{type:'text',text:'你好世界'}]}});
  h.append(message);h.append(message);h.append(entry(3,'step/end',{turn:1,step:1}));h.settle('a');h.append(entry(4,'turn/end'));
  assert.deepEqual(h.out,['你好','世界']);assert.equal(h.feed.attempts.size,0);assert.equal(h.feed.steps.size,0);
});
test('active history prefix also matches a successful append without reading history again',()=>{
  const h=harness([live(1.1,'旧文本')]);h.append(entry(2,'assistant/message',{turn:1,step:1,message:{content:[{type:'text',text:'旧文本新增'}]}}));
  assert.deepEqual(h.out,['新增']);
});
test('identical text in a later step or a nonstreamed message is still read',()=>{
  const h=harness();h.append(entry(1,'turn/start'),live(1.1,'相同回复'));
  h.append(entry(2,'assistant/message',{turn:1,step:1,message:{content:[{type:'text',text:'相同回复'}]}}));h.settle('a');
  h.append(entry(3,'assistant/message',{turn:1,step:2,message:{content:[{type:'text',text:'相同回复'}]}}));
  assert.deepEqual(h.out,['相同回复','相同回复']);
});

test('only fresh authoritative SuperAgent final publications enter speech', () => {
  const publication = (seq, kind, text, ignorable = true) => {
    const item = entry(seq, 'plugin:benchgo-plugin/chat-publication', { kind, requestId: 'r', text });
    if (ignorable) item.event.ignorable = true;
    return item;
  };
  const h = harness([publication(1, 'final', '历史回复')]);
  h.append(entry(2, 'turn/start'), publication(3, 'ticket-reply', '内部草稿'), publication(4, 'final', '未经标记', false));
  const reply = publication(5, 'final', '你好');
  h.append(reply); h.append(reply);
  h.append(entry(6, 'assistant/message', { message: { content: [{ type: 'text', text: '你好' }] } }), entry(7, 'turn/end'));
  assert.deepEqual(h.out, ['你好']);
  assert.deepEqual(h.events, ['start', 'end']);
});

test('live records retain human input and never expose injected user-role context or model replacements',()=>{
  const records=[],feed=new AgentFeed({onRecord:event=>records.push(event)});
  feed.baseline({revision:0,entries:[]});
  const human=entry(1,'user/message',{id:'human',source:{kind:'user'},content:[{type:'text',text:'我的第一句包含 system/context 词语'}]});
  const injected=['runtime-context','benchgo-voice-context','file-mention','retry'].map((kind,index)=>entry(index+2,'user/message',{source:{kind},content:[{type:'text',text:'仅模型上下文'}]}));
  const replacement=entry(6,'user/message',{source:{kind:'user'},content:[{type:'text',text:'压缩替换副本'}]});replacement.event.surfaceOp={op:'replace',startSeq:1,endSeq:1};
  feed.accept({revision:1,change:{kind:'append',entries:[human,...injected,replacement]}});
  assert.deepEqual(records,[human.event]);
});
