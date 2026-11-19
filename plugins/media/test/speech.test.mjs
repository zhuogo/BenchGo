import test from 'node:test';
import assert from 'node:assert/strict';
import {SpeakableChunker,SpeechQueue,speakable} from '../client/speech.mjs';
test('chunker filters code, hidden reasoning, markdown URLs across every character',()=>{
  const c=new SpeakableChunker(),out=[];const text='你好。<think>不应朗读。</think>请看 [文档](https://example.com)。 '+String.fromCharCode(96).repeat(3)+'js\nsecret();\n'+String.fromCharCode(96).repeat(3)+'最后 '+String.fromCharCode(96)+'danger'+String.fromCharCode(96)+' 再见！';
  for(const x of text)out.push(...c.push(x));out.push(...c.finish());const all=out.join('');assert.match(all,/你好/);assert.match(all,/文档/);assert.match(all,/最后/);assert.equal(all.split('代码部分略过。').length-1,1);assert.doesNotMatch(all,/不应|secret|example|danger/);
});
test('chunker limits Chinese sentence size and keeps punctuation across deltas',()=>{const c=new SpeakableChunker({maxChars:50}),out=[];for(const d of ['你好','，今天很好。','很'.repeat(180),'结束！'])out.push(...c.push(d));out.push(...c.finish());assert.ok(out.every(x=>x.length<=50));assert.match(out.join(''),/今天很好/);});
test('secret-looking tokens are redacted',()=>{assert.doesNotMatch(speakable('token=abcdefghijklmnopqrstuvwxyz1234567890 api_key: sk-123456789012345678901234'),/abcdefghijklmnopqrstuvwxyz|sk-123/);});
test('TTS prefetch is concurrent, ordered, and playback starts before stream end',async()=>{
  const requests=[],played=[],ends=[];let finishFirst,firstStarted;
  const first=new ReadableStream({start(c){c.enqueue(new Uint8Array([1,0]));finishFirst=()=>c.close();}});
  const started=new Promise(r=>firstStarted=r);const player={enqueue:async(bytes,id)=>{played.push([id,...bytes]);firstStarted();},segmentEnd:id=>ends.push(id),clear(){}};
  const q=new SpeechQueue({player,synthesize:async text=>{requests.push(text);return new Response(text==='one'?first:new Uint8Array([2,0]));}});
  q.push('one');q.push('two');q.push('three');await started;assert.deepEqual(requests,['one','two','three']);assert.deepEqual(ends,[]);finishFirst();await q.finish();assert.deepEqual(ends,[1,2,3]);assert.deepEqual(played.map(x=>x[0]),[1,2,3]);await q.dispose();
});

test('TTS metrics measure each request first PCM without delaying or exposing its text',async()=>{
  let now=1000;const received=[],metrics=[];
  const q=new SpeechQueue({now:()=>now,onMetrics:event=>metrics.push(event),player:{enqueue:async(_bytes,id)=>received.push(id),segmentEnd(){},clear(){}},synthesize:async()=>{now=1125;return new Response(new Uint8Array([1,0]));}});
  q.push('private spoken text');await q.finish();
  assert.deepEqual(received,[1]);assert.deepEqual(metrics.map(event=>event.type),['tts.queued','tts.start','tts.first_audio','tts.end']);
  assert.deepEqual(metrics[2],{type:'tts.first_audio',id:1,at:1125,queued_at:1000,request_wait_ms:0,elapsed_ms:125,audio_ms:2/48,chunks:1,max_audio_gap_ms:0,backpressure_ms:0,first_byte_ms:125});
  assert.deepEqual(metrics[3],{type:'tts.end',id:1,at:1125,queued_at:1000,request_wait_ms:0,elapsed_ms:125,audio_ms:2/48,chunks:1,max_audio_gap_ms:0,backpressure_ms:0,status:'complete'});
  assert.doesNotMatch(JSON.stringify(metrics),/private|spoken|text/u);await q.dispose();
});
test('TTS cancel aborts synthesis without waiting for uncooperative provider',async()=>{
  let signal;let clear=0;const q=new SpeechQueue({player:{clear(){clear++;}},synthesize:(_t,s)=>{signal=s;return new Promise(()=>{});}});q.push('one');await new Promise(r=>setTimeout(r,0));q.cancel();await q.finish();assert.equal(signal.aborted,true);assert.equal(clear,1);
});
test('late cancelled TTS cannot publish first-audio or completion metrics into a new turn',async()=>{
  const events=[];let resolveResponse;
  const q=new SpeechQueue({onMetrics:event=>events.push(event),player:{clear(){}},synthesize:()=>new Promise(resolve=>resolveResponse=resolve)});
  q.push('old turn');await new Promise(resolve=>setTimeout(resolve,0));q.cancel();
  resolveResponse(new Response(new Uint8Array([1,0])));await q.finish();await new Promise(resolve=>setTimeout(resolve,0));
  assert.deepEqual(events.map(event=>event.type),['tts.queued','tts.start']);await q.dispose();
});
test('TTS metrics separate time waiting for a prefetch slot from request first PCM',async()=>{
  let now=0,finishFirst;const events=[],requests=[];
  const first=new ReadableStream({start(controller){finishFirst=()=>controller.close();}});
  const q=new SpeechQueue({now:()=>now,onMetrics:event=>events.push(event),player:{enqueue:async()=>{},segmentEnd(){},clear(){}},synthesize:async text=>{requests.push(text);return new Response(text==='one'?first:new Uint8Array([1,0]));}});
  for(const text of ['one','two','three','four'])q.push(text);
  for(let i=0;i<20;i++)await Promise.resolve();assert.deepEqual(requests,['one','two','three']);
  now=200;finishFirst();await q.finish();
  const start=events.find(event=>event.id===4&&event.type==='tts.start'),audio=events.find(event=>event.id===4&&event.type==='tts.first_audio');
  assert.equal(start.queued_at,0);assert.equal(start.request_wait_ms,200);assert.equal(audio.first_byte_ms,0);assert.equal(audio.request_wait_ms,200);await q.dispose();
});
test('TTS cumulative audio and observed gaps use throttled progress without per-packet events',async()=>{
  let now=0,index=0;const events=[],times=[0,20,100,150,201];
  const reader={read:async()=>index<times.length?(now=times[index++],{done:false,value:new Uint8Array(480)}):{done:true},cancel:async()=>{},releaseLock(){}};
  const q=new SpeechQueue({now:()=>now,onMetrics:event=>events.push(event),player:{enqueue:async()=>{},segmentEnd(){},clear(){}},synthesize:async()=>({body:{getReader:()=>reader}})});
  q.push('one');await q.finish();
  assert.deepEqual(events.filter(event=>event.type==='tts.audio').map(event=>event.at),[100,201]);
  const end=events.at(-1);assert.equal(end.audio_ms,50);assert.equal(end.chunks,5);assert.equal(end.max_audio_gap_ms,80);assert.equal(end.elapsed_ms,201);assert.equal(end.backpressure_ms,0);await q.dispose();
});
test('prefetch capacity waits are reported separately from observed TTS audio gaps',async()=>{
  let now=0,finishFirst,reads=0;const events=[];
  const first=new ReadableStream({start(controller){controller.enqueue(new Uint8Array([1,0]));finishFirst=()=>controller.close();}});
  const reader={read:async()=>{reads++;if(reads===1)return {done:false,value:new Uint8Array(3840)};if(reads===2){now=1050;return {done:false,value:new Uint8Array(1920)};}return {done:true};},cancel:async()=>{},releaseLock(){}};
  const q=new SpeechQueue({maxPrefetchBytes:1920,now:()=>now,onMetrics:event=>events.push(event),player:{enqueue:async()=>{},segmentEnd(){},clear(){}},synthesize:async text=>text==='one'?new Response(first):{body:{getReader:()=>reader}}});
  q.push('one');q.push('two');for(let i=0;i<30;i++)await Promise.resolve();
  assert.equal(q.items[1].buffered,1920);assert.equal(reads,1);now=1000;finishFirst();await q.finish();
  const end=events.find(event=>event.id===2&&event.type==='tts.end');assert.equal(end.backpressure_ms,1000);assert.equal(end.max_audio_gap_ms,50);assert.equal(end.audio_ms,120);assert.equal(end.chunks,2);await q.dispose();
});
test('TTS queue rejects excess backlog',async()=>{const errors=[];const q=new SpeechQueue({maxQueued:2,player:{clear(){}},synthesize:()=>new Promise(()=>{}),onError:e=>errors.push(e)});assert.equal(q.push('one'),true);assert.equal(q.push('two'),true);assert.equal(q.push('three'),false);assert.equal(errors.length,1);await q.dispose();});
test('first-clause budget flushes safe text without splitting decimals or unfinished English words',()=>{
  let now=0;const c=new SpeakableChunker({now:()=>now});assert.deepEqual(c.push('我会帮你检查这些配置，正在继续确认'),[]);
  now=249;assert.deepEqual(c.flushIdle(),[]);now=250;assert.deepEqual(c.flushIdle(),['我会帮你检查这些配置，']);
  now+=750;assert.deepEqual(c.flushIdle(),[]);assert.deepEqual(c.finish(),['正在继续确认']);
  const c2=new SpeakableChunker({now:()=>now});c2.push('approximately 3.14');now+=300;assert.deepEqual(c2.flushIdle(),['approximately']);assert.deepEqual(c2.finish(),['3.14']);
  const c3=new SpeakableChunker({now:()=>now});c3.push('G');now+=1500;assert.deepEqual(c3.flushIdle(),[]);c3.push('rok');assert.deepEqual(c3.finish(),['Grok']);
});
test('prefetched TTS bodies are consumed concurrently but have bounded PCM queues',async()=>{
  let firstFinish;const first=new ReadableStream({start(c){c.enqueue(new Uint8Array([1,0]));firstFinish=()=>c.close();}}),sent=[];
  const q=new SpeechQueue({maxPrefetchBytes:1920,player:{enqueue:async(bytes,id)=>sent.push(id),segmentEnd(){},clear(){}},synthesize:async text=>new Response(text==='first'?first:new Uint8Array(16000))});q.push('first');q.push('second');q.push('third');await new Promise(r=>setTimeout(r,5));assert.equal(q.items[1].buffered,1920);assert.equal(q.items[2].buffered,1920);assert.deepEqual(sent,[1]);firstFinish();await q.finish();assert.ok(sent.indexOf(2)>0);assert.ok(sent.lastIndexOf(2)<sent.indexOf(3));await q.dispose();
});
const filterChunks = text => { const chunker = new SpeakableChunker(), out = []; for (const character of text) out.push(...chunker.push(character)); out.push(...chunker.finish()); return out.join(' '); };
test('stream filter gives code/URL hints but reads table facts without an omission announcement', () => {
  const fence = String.fromCharCode(96).repeat(3), nl = String.fromCharCode(10);
  const text = '正文。' + fence + 'js' + nl + 'privateCode()' + nl + fence + nl + fence + 'json' + nl + 'anotherCode()' + nl + fence + nl + '| 项目 | 数值 |' + nl + '| --- | --- |' + nl + '| 通话 | 10 |' + nl + nl + '请看 https://private.example/a.b?q=secret 后续。另见 https://second.example/x。结束。';
  const spoken = filterChunks(text);
  for (const hint of ['代码部分略过。', '这个链接。']) assert.equal(spoken.split(hint).length - 1, 1);
  assert.doesNotMatch(spoken, /private|anotherCode|表格.*略过|---|second|\|/u); assert.match(spoken, /项目，数值/u); assert.match(spoken, /通话，10/u); assert.match(spoken, /正文/u); assert.match(spoken, /后续/u); assert.match(spoken, /结束/u);
});

test('table rows retain facts across every split, including a final row without newline', () => {
  for(const text of ['| 项目 | 状态 |\n| :--- | ---: |\n| 语音 | 正常 |', '项目 | 状态\n--- | ---\n语音 | 正常']){
    for(let split=0;split<=text.length;split++){
      const c=new SpeakableChunker(),spoken=[...c.push(text.slice(0,split)),...c.push(text.slice(split)),...c.finish()].join('');
      assert.match(spoken,/项目，状态/u,JSON.stringify({split,spoken}));assert.match(spoken,/语音，正常/u);
      assert.doesNotMatch(spoken,/\||---|略过/u);
    }
  }
});

test('table cells use the existing payload filters and incomplete rows never escape on idle', () => {
  let now=1000;const c=new SpeakableChunker({now:()=>now}),out=[];
  const text='| 文档 | [说明](https://private.example/path) |\n| --- | --- |\n| 设置 | token=abcdefghijklmnopqrstuvwxyz1234567890 |\n| 命令 | `privateCommand()` |\n';
  for(const character of text){out.push(...c.push(character));now+=1600;out.push(...c.flushIdle());}
  out.push(...c.finish());const spoken=out.join('');
  assert.match(spoken,/文档，说明/u);assert.match(spoken,/设置/u);assert.doesNotMatch(spoken,/private|abcdefghijklmnopqrstuvwxyz|\||---|表格.*略过/u);
  const long=new SpeakableChunker();long.push('|');for(let i=0;i<1000;i++)long.push('oversizedCell');assert.ok(long.table.text.length<=2048);assert.doesNotMatch(long.finish().join(''),/oversizedCell/u);
});
test('inline code is not spoken while ordinary parentheses survive and stage directions are removed', () => {
  const tick = String.fromCharCode(96);
  const spoken = filterChunks('(笑着说)你好（挠头），请运行 ' + tick + 'npm run dev' + tick + '。（预计耗时 2 分钟）保留这个说明。*sighs*继续。🙂');
  assert.match(spoken, /预计耗时 2 分钟/u); assert.doesNotMatch(spoken, /npm run dev|笑着说|挠头|sighs|🙂/u);
});
test('incomplete URL and Markdown destination remain silent across idle flushes', () => {
  let now = 1000; const chunker = new SpeakableChunker({ now: () => now }), out = [];
  for (const delta of ['请看 h', 'ttps://priv', 'ate.example/a', '.b']) { out.push(...chunker.push(delta)); now += 1500; out.push(...chunker.flushIdle()); }
  out.push(...chunker.push(' 然后查看 [文档](https://other.example/private) 完成。')); out.push(...chunker.finish());
  const spoken = out.join(' '); assert.doesNotMatch(spoken, /private|example|https|other/u); assert.match(spoken, /文档/u); assert.match(spoken, /完成/u);
});

test('Windows paths are spoken as exact locations across every split, including inline and Markdown labels', () => {
  const tick=String.fromCharCode(96);
  const samples=[
    ['文件在 C:\\Users\\Lin\\报告.md。','C 盘的Users文件夹下，Lin文件夹下，报告 点 md'],
    ['文件在 D:/项目/前端/index.ts:12。','D 盘的项目文件夹下，前端文件夹下，index 点 ts第 12 行'],
    ['请看 '+tick+'C:\\Users\\Lin\\报告.md'+tick+'。','C 盘的Users文件夹下，Lin文件夹下，报告 点 md'],
    ['打开 "C:\\Program Files\\BenchGo\\app.exe"。','C 盘的Program Files文件夹下，BenchGo文件夹下，app 点 exe'],
    ['请看 [C:/Users/Lin/报告.md](C:/Users/Lin/报告.md)。','C 盘的Users文件夹下，Lin文件夹下，报告 点 md'],
    ['打开 file:///D:/BenchGo/%E6%8A%A5%E5%91%8A.md。','D 盘的BenchGo文件夹下，报告 点 md'],
  ];
  for(const [input,expected]of samples)for(let split=0;split<=input.length;split++){
    const c=new SpeakableChunker(),out=[...c.push(input.slice(0,split)),...c.push(input.slice(split)),...c.finish()].join('');
    assert.ok(out.includes(expected),JSON.stringify({input,split,out,expected}));assert.doesNotMatch(out,/[\\/`]/u);
  }
});

test('idle speech never releases a partial Windows drive or code payload', () => {
  let now=1000;const c=new SpeakableChunker({now:()=>now}),out=[];
  for(const delta of ['文件保存在 ','C',':','\\','Users','\\Lin\\','报告','.md']){
    out.push(...c.push(delta));now+=1600;out.push(...c.flushIdle());assert.doesNotMatch(out.join(''),/C|Users|报告|md/u);
  }
  out.push(...c.push('。'));out.push(...c.finish());assert.match(out.join(''),/C 盘的Users文件夹下，Lin文件夹下，报告 点 md/u);
  const code=new SpeakableChunker({now:()=>now}),spoken=[];
  for(const delta of ['`','npm ','run dev','`','。']){spoken.push(...code.push(delta));now+=1600;spoken.push(...code.flushIdle());}
  spoken.push(...code.finish());assert.doesNotMatch(spoken.join(''),/npm|run|dev/u);assert.equal(spoken.join('').split('代码部分略过。').length-1,1);
});

test('link titles survive nested destinations without reading URLs or inline command labels', () => {
  const tick=String.fromCharCode(96);
  const spoken=filterChunks('请看 [官方文档](https://example.com/a(b)/private?q=secret "标题 (说明)")。文件见 [报告](C:/Users/Lin/报告.md)。['+tick+'npm run private-command'+tick+'](https://example.com)。<code>npm run private-command</code>然后继续。');
  assert.match(spoken,/官方文档/u);assert.match(spoken,/文件见 报告/u);assert.match(spoken,/然后继续/u);
  assert.doesNotMatch(spoken,/example|private|secret|Users|npm|run|标题|说明/u);
});

test('backtick and tilde fences remain silent when an idle flush occurs after each character', () => {
  for(const marker of ['~~~',String.fromCharCode(96).repeat(3)]){
    let now=1000;const c=new SpeakableChunker({now:()=>now}),out=[];
    for(const character of marker+'js\nprivateCommand();\n'+marker+'\n完成。'){
      out.push(...c.push(character));now+=1600;out.push(...c.flushIdle());
    }
    out.push(...c.finish());assert.doesNotMatch(out.join(''),/privateCommand|js/u);assert.match(out.join(''),/完成/u);
  }
});

test('unclosed inline code and oversized paths stay bounded and never spill raw tails', () => {
  const c=new SpeakableChunker();c.push('`');for(let i=0;i<1000;i++)c.push('privateCommand');assert.ok(c.raw.length<=8);assert.ok(c.inline.text.length<=2048);assert.doesNotMatch(c.finish().join(''),/privateCommand/u);
  const path=new SpeakableChunker();path.push('C:\\');for(let i=0;i<1000;i++)path.push('privatePath');assert.ok(path.raw.length<=2048);assert.doesNotMatch(path.finish().join(''),/privatePath/u);
});
test('unterminated code and Markdown links have bounded retained text', () => {
  const code = new SpeakableChunker(), fence = String.fromCharCode(96).repeat(3);
  code.push(fence + 'js '); for (let i = 0; i < 1000; i++) code.push('veryLongPrivateCode');
  assert.ok(code.raw.length <= 8); assert.ok(code.text.length <= 120); assert.doesNotMatch(code.finish().join(''), /PrivateCode/u);
  const link = new SpeakableChunker(); link.push('[文档]('); for (let i = 0; i < 1000; i++) link.push('private-link-destination');
  assert.ok(link.raw.length <= 2048); assert.doesNotMatch(link.finish().join(''), /private-link/u);
});
test('natural sentence boundaries start immediately while commas retain prosody and numeric tokens', () => {
  const short=new SpeakableChunker();assert.deepEqual(short.push('你好。'),['你好。']);assert.deepEqual(short.finish(),[]);
  const first=new SpeakableChunker();assert.deepEqual(first.push('我会先检查你的语音配置，'),[]);
  assert.deepEqual(first.push('再核对实际请求，'),[]);
  assert.equal(first.finish().join(''),'我会先检查你的语音配置，再核对实际请求，');
  const number=new SpeakableChunker();assert.deepEqual(number.push('The total amount is 123,456.78'),[]);assert.equal(number.finish().join(''),'The total amount is 123,456.78');
  const privateText=filterChunks('我会先确认你的语音配置，<reasoning>绝不能朗读。</reasoning>请看 https://private.example/path 完成。');
  assert.doesNotMatch(privateText,/绝不能|private|https/u);assert.match(privateText,/完成/u);
});

test('complete buffered sentences merge up to the soft limit without waiting for future deltas', () => {
  let now=0;const c=new SpeakableChunker({now:()=>now});
  assert.deepEqual(c.push('好的。'),['好的。']);now=80;
  assert.deepEqual(c.push('我马上帮你检查页面和配置。'),['我马上帮你检查页面和配置。']);
  assert.deepEqual(c.finish(),[]);
  const text='好的。马上帮你检查这个页面。';assert.deepEqual(new SpeakableChunker().push(text),[text]);
  for(let split=0;split<text.length;split++){
    const chunker=new SpeakableChunker(),out=[];
    out.push(...chunker.push(text.slice(0,split)),...chunker.push(text.slice(split)),...chunker.finish());
    assert.equal(out.join(''),text);
  }
  const long='我'.repeat(38)+'。'+'你'.repeat(38)+'。';assert.equal(new SpeakableChunker().push(long).length,2);
});

test('generation and idle budgets remain distinct and short unpunctuated text stays intact', () => {
  let now=0;const c=new SpeakableChunker({now:()=>now});
  c.push('我先检查');now=300;assert.deepEqual(c.flushIdle(),[]);now=1200;assert.deepEqual(c.flushIdle(),[]);assert.deepEqual(c.finish(),['我先检查']);
  const growing=new SpeakableChunker({now:()=>now});growing.push('我正在检查你的项目');
  now+=250;growing.push('文件');assert.deepEqual(growing.flushIdle(),[]);
  now+=949;growing.push('和配置');assert.deepEqual(growing.flushIdle(),[]);
  now+=1;assert.deepEqual(growing.flushIdle(),['我正在检查你的项目文件和配置']);
  const follow=new SpeakableChunker({now:()=>now});assert.deepEqual(follow.push('先检查。'),['先检查。']);
  follow.push('随后检查你的完整项目配置，再继续确认');now+=649;assert.deepEqual(follow.flushIdle(),[]);now+=1;assert.deepEqual(follow.flushIdle(),['随后检查你的完整项目配置，']);
  const hidden=new SpeakableChunker({now:()=>now});assert.deepEqual(hidden.push('你好。<think>private'),['你好。']);now+=1500;
  assert.deepEqual(hidden.flushIdle(),[]);assert.doesNotMatch(hidden.finish().join(''),/private/);
});
test('soft and hard limits preserve decimal, grouped numbers and English words at every split',()=>{
  const input='Check the approximately correct result of 3.14 with 1,000 records and another extraordinarilylongword before continuing. All done.';
  for(let split=0;split<=input.length;split++){
    const c=new SpeakableChunker(),out=[...c.push(input.slice(0,split)),...c.push(input.slice(split)),...c.finish()];
    assert.equal(out.join(' ').replace(/\s+/gu,' ').trim(),input);
    for(const token of ['3.14','1,000','extraordinarilylongword'])assert(out.some(part=>part.includes(token)),JSON.stringify({split,out,token}));
  }
  const c=new SpeakableChunker(),text='甲'.repeat(34)+'，'+'乙'.repeat(34)+'，'+'丙'.repeat(140);
  const out=[...c.push(text),...c.finish()];assert.equal(out.join(''),text);assert(out.every(part=>part.length<=120));
  assert(out[0].endsWith('，'),'soft limit backs up to an existing clause');
});
test('numeric commas at length thresholds remain provisional across raw lookahead and idle delta boundaries',()=>{
  for(const prefixLength of [59,119])for(const token of ['1,000','123,456.78','3.14','extraordinarilylongword']){
    const input='汉'.repeat(prefixLength)+token+'元。';
    for(let split=0;split<=input.length;split++){
      let now=0;const c=new SpeakableChunker({now:()=>now}),out=[];
      out.push(...c.push(input.slice(0,split)));now=300;out.push(...c.flushIdle());
      out.push(...c.push(input.slice(split)));out.push(...c.finish());
      assert.equal(out.join(''),input,JSON.stringify({prefixLength,token,split,out}));
      assert(out.some(part=>part.includes(token)),JSON.stringify({prefixLength,token,split,out}));
    }
  }
  let now=0;const c=new SpeakableChunker({now:()=>now}),out=[];
  out.push(...c.push('汉'.repeat(59)+'1,'));now=300;out.push(...c.flushIdle());
  assert.deepEqual(out,[],'an unresolved comma must not release a numeric prefix');
  out.push(...c.push('000元。'));out.push(...c.finish());assert(out.some(part=>part.includes('1,000')));
  const prose=new SpeakableChunker();const text='汉'.repeat(59)+'1, 下一项。';
  assert.deepEqual([...prose.push(text),...prose.finish()],['汉'.repeat(59)+'1,','下一项。']);
});
test('arriving PCM is forwarded immediately without a per-packet coalescing timer',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let stream,firstPlayed;const played=[];const started=new Promise(resolve=>firstPlayed=resolve);
  const q=new SpeechQueue({player:{enqueue:async bytes=>{played.push([...bytes]);firstPlayed();},segmentEnd(){},clear(){}},synthesize:async()=>new Response(new ReadableStream({start(controller){stream=controller;controller.enqueue(new Uint8Array([1,0]));}}))});
  try{q.push('one');await started;stream.enqueue(new Uint8Array([2,0]));for(let i=0;i<20;i++)await Promise.resolve();assert.deepEqual(played,[[1,0],[2,0]]);stream.close();await q.finish();}finally{await q.dispose();t.mock.timers.reset();}
});
test('dispose releases local readers when a provider never finishes cancelling', {timeout:1000},async()=>{
  let signal,started;const ready=new Promise(resolve=>started=resolve);let cancelled=0;
  const q=new SpeechQueue({player:{enqueue:async()=>started(),segmentEnd(){},clear(){}},synthesize:async(_text,abort)=>{signal=abort;return new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array([1,0]));},cancel(){cancelled++;return new Promise(()=>{});}}));}});
  q.push('one');await ready;await q.dispose();assert.equal(signal.aborted,true);assert.equal(cancelled,1);assert.equal(q.controllers.size,0);assert.equal(q.readers.size,0);assert.deepEqual(q.items,[]);
});
