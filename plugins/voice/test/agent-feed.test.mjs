import test from 'node:test';
import assert from 'node:assert/strict';
import {AgentFeed} from '../client/agent-feed.mjs';
import { projectChatMessages } from '../../superagent/src/chat-publication.mjs';
const entry=(seq,type,data={})=>({type:type==='assistant/live-chunk'?'transient':'event',event:{seq,type,data}});
const user=(seq,id,source={kind:'user'})=>entry(seq,'user/message',{id,source,content:[]});
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
    const item = entry(seq, 'plugin:benchgo-plugin/chat-publication', { kind, requestId: `r:${seq}`, text });
    if (ignorable) item.event.ignorable = true;
    return item;
  };
  const h = harness([user(0,'r:1'),publication(1, 'final', '历史回复')]);
  h.append(entry(2, 'turn/start'), publication(3, 'ticket-reply', '内部草稿'), publication(4, 'final', '未经标记', false));
  const reply = publication(5, 'final', '你好');
  h.append(user(4.5,'r:5'),reply); h.append(reply);
  h.append(entry(6, 'assistant/message', { message: { content: [{ type: 'text', text: '你好' }] } }), entry(7, 'turn/end'));
  assert.deepEqual(h.out, ['你好']);
  assert.deepEqual(h.events, ['start', 'end']);
});

test('formal publications have a separate callback and deduplicate by source identity', () => {
  const publications=[],text=[],records=[];
  const feed=new AgentFeed({onPublication:(value,event)=>publications.push([value,event.data.requestId]),onText:value=>text.push(value),onRecord:event=>{if(event.type!=='user/message')records.push(event);}});
  const publication=(seq,requestId,value)=>({event:{seq,type:'plugin:benchgo-plugin/chat-publication',ignorable:true,data:{kind:'final',requestId,text:value}}});
  feed.baseline({revision:0,entries:[user(0,'history'),publication(1,'history','历史提醒'),user(1.1,'notice-1'),user(1.2,'notice-2')]});
  const first=publication(2,'notice-1','需要你确认。'),second=publication(3,'notice-2','需要你确认。');
  feed.accept({revision:1,change:{kind:'append',entries:[publication(4,'history','历史提醒'),first,first,publication(5,'notice-1','需要你确认。'),second]}});
  assert.deepEqual(publications,[['需要你确认。','notice-1'],['需要你确认。','notice-2']]);
  assert.deepEqual(text,[]);assert.deepEqual(records,[first.event,second.event]);
});

test('several proactive publications each consume one mirror without suppressing later equal replies',()=>{
  const h=harness([user(-2,'n-1'),user(-1,'n-2')]),publication=(seq,requestId,text)=>({event:{seq,type:'plugin:benchgo-plugin/chat-publication',ignorable:true,data:{kind:'final',requestId,text}}});
  const reply=(seq,text)=>entry(seq,'assistant/message',{message:{content:[{type:'text',text}]}});
  h.append(publication(1,'n-1','已完成。'),publication(2,'n-2','需要确认。'));
  h.append(reply(3,'已完成。'),reply(4,'需要确认。'),reply(5,'已完成。'));
  h.append(entry(6,'turn/start'),reply(7,'需要确认。'));
  assert.deepEqual(h.out,['已完成。','需要确认。','已完成。','需要确认。']);
});

test('prepended and replacement publication history stays silent after replay',()=>{
  const h=harness(),publication=(seq,requestId)=>({event:{seq,type:'plugin:benchgo-plugin/chat-publication',ignorable:true,data:{kind:'final',requestId,text:'历史提醒'}}});
  h.feed.accept({revision:1,change:{kind:'prepend',entries:[user(0,'old'),publication(1,'old')]}});
  h.feed.accept({revision:2,change:{kind:'append',entries:[publication(2,'old')]}});
  h.feed.accept({revision:3,entries:[user(2.1,'restored'),publication(3,'restored')],change:{kind:'replace'}});
  h.feed.accept({revision:4,change:{kind:'append',entries:[publication(4,'restored')]}});
  assert.deepEqual(h.out,[]);
});

test('native speech follows public SuperAgent projection across reminders, results and ordinary replies',()=>{
  const events=[],spoken=[],records=[];let seq=0;
  const append=(type,data={},envelope={})=>events.push({seq:++seq,type,data,...envelope});
  const start=(turn,id,source={kind:'user'})=>{append('turn/start',{turn});append('user/message',{id,source,content:[]});};
  const answer=(turn,text)=>{append('assistant/live-chunk',{turn,step:1,attemptId:`a:${turn}`,chunk:{type:'text-delta',text}});append('assistant/message',{turn,step:1,message:{source:{kind:'model'},content:[{type:'reasoning',text:'PRIVATE REASONING'},{type:'text',text}]}});};
  const publish=(requestId,kind,text,extra={})=>append('plugin:benchgo-plugin/chat-publication',{requestId,kind,text,...extra},{ignorable:true});
  start(1,'human');answer(1,'普通正式答复');append('turn/end',{turn:1,reason:{kind:'completed'}});
  start(2,'explicit');answer(2,'PRIVATE PROVISIONAL');publish('explicit','final','正式提醒');append('turn/end',{turn:2,reason:{kind:'interrupted'}});
  for(const [index,kind]of ['approval','recovery','watchdog','result','state'].entries()){
    const turn=index+3,id=`notice:${kind}`;start(turn,id,{kind:'benchgo-ticket-reply',replyKind:kind});answer(turn,`PRIVATE ${kind}`);
    publish(id,'ticket-reply',`公开 ${kind}`);append('turn/end',{turn,reason:{kind:'completed'}});
  }
  start(8,'suppressed',{kind:'benchgo-ticket-reply',replyKind:'approval'});answer(8,'PRIVATE SUPPRESSED');publish('suppressed','ticket-reply','PRIVATE SUPPRESSED',{suppressed:true});append('turn/end',{turn:8,reason:{kind:'completed'}});
  start(9,'execution',{kind:'benchgo-execution-input'});answer(9,'PRIVATE EXECUTION');append('turn/end',{turn:9,reason:{kind:'completed'}});
  start(10,'failed');answer(10,'PRIVATE FAILED');append('turn/end',{turn:10,reason:{kind:'error'}});
  for(const direction of ['inbound','delivery'])append('plugin:benchgo-plugin/channel-message',{mirrorKey:direction,direction,text:direction==='delivery'?'任务结果已交付':'外部输入',source:{channel:'desktop',sourceType:'conversation'}},{ignorable:true});
  publish('missing','final','PRIVATE FOREIGN');publish('human','final','x'.repeat(16001));
  const feed=new AgentFeed({publicOnly:true,onText:text=>spoken.push(text),onPublication:text=>spoken.push(text),onRecord:(_event,message)=>{if(message?.role==='assistant')records.push(message.text);}});
  feed.baseline({revision:0,entries:[]});for(const event of events)feed.accept({revision:event.seq,change:{kind:'append',entries:[{event}]}});
  assert.deepEqual(spoken,projectChatMessages(events).filter(row=>row.role==='assistant').map(row=>row.text));
  assert.deepEqual(records,spoken);assert.doesNotMatch(spoken.join('\n'),/PRIVATE/);
});

test('native question replies require the original admitted call and share its public fallback identity',()=>{
  for(const valid of [true,false]){
    const spoken=[],records=[],feed=new AgentFeed({publicOnly:true,onPublication:(text,event)=>{spoken.push(text);records.push(event);}}),questions=[{id:'q',question:'继续吗？'}];
    const request={id:'question-answer',source:{kind:'user-question-reply',outcome:'answered',callId:'ask'},content:[{type:'text',text:JSON.stringify({kind:'answer_to_pending_question',tool:'ask_user_question',callId:'ask',questions,answers:[{id:'q',selected:['继续']}]})}]};
    const events=[{seq:1,type:'tool/call',data:{name:'ask_user_question',callId:valid?'ask':'other',arguments:JSON.stringify({questions})}},
      {seq:2,type:'turn/start',data:{turn:1}},{seq:3,type:'user/message',data:request},
      {seq:4,type:'assistant/message',data:{turn:1,step:1,message:{source:{kind:'model'},content:[{type:'text',text:'继续处理。'}]}}},
      {seq:5,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}}];
    feed.baseline({revision:0,entries:[]});for(const event of events)feed.accept({revision:event.seq,change:{kind:'append',entries:[{event}]}});
    assert.deepEqual(spoken,projectChatMessages(events).filter(row=>row.role==='assistant').map(row=>row.text));
    if(valid){assert.equal(records[0].data.requestId,'question-answer');feed.accept({revision:6,change:{kind:'append',entries:[{event:{seq:6,type:'plugin:benchgo-plugin/chat-publication',ignorable:true,data:{kind:'final',requestId:'question-answer',text:'继续处理。'}}}]}});assert.equal(spoken.length,1);}
  }
});

test('native completed replies retain the admitted user identity across a verified model fallback',()=>{
  for(const cancelled of [false,true]){
    const spoken=[],records=[],feed=new AgentFeed({publicOnly:true,onPublication:(text,event)=>{spoken.push(text);records.push(event);}});
    const message={id:'continued',source:{kind:'benchgo-model-fallback',fallbackId:'plan'}};
    const events=[{seq:1,type:'turn/start',data:{turn:1}},user(2,'original').event,
      {seq:3,type:'plugin:benchgo-plugin/model-fallback',ignorable:true,data:{id:'plan',requestId:'original',failedTurn:1,message}},
      {seq:4,type:'turn/end',data:{turn:1,reason:{kind:cancelled?'aborted':'error',...(cancelled?{reason:{kind:'user'}}:{})}}},
      {seq:5,type:'turn/start',data:{turn:2}},{seq:6,type:'user/message',data:message},
      {seq:7,type:'assistant/message',data:{turn:2,step:1,message:{source:{kind:'model'},content:[{type:'text',text:'已恢复并完成答复。'}]}}},
      {seq:8,type:'turn/end',data:{turn:2,reason:{kind:'completed'}}}];
    feed.baseline({revision:0,entries:[]});for(const event of events)feed.accept({revision:event.seq,change:{kind:'append',entries:[{event}]}});
    assert.deepEqual(spoken,projectChatMessages(events).filter(row=>row.role==='assistant').map(row=>row.text));
    if(!cancelled)assert.equal(records[0].data.requestId,'original');else assert.deepEqual(spoken,[]);
  }
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
