import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sharedUiStyles } from '../../benchgo/scripts/shared-ui.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const webRequire = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
const { chromium } = webRequire('playwright');
const { build } = createRequire(new URL('../../benchgo/package.json', import.meta.url))('esbuild');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || [chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const captureDir = process.env.BENCHGO_CHAT_SCREENSHOTS;

test('task completion uses the normal reply stream and history takes over the mounted bubble', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const html = await fixture(), browser = await chromium.launch({ headless:true, executablePath });
  try {
    const page = await browser.newPage({ reducedMotion:'reduce' }), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent(html);
    if(captureDir) await mkdir(captureDir,{recursive:true});
    for(const dark of [false,true]) for(const width of [1440,390]) {
      await page.setViewportSize({width,height:800});
      await page.evaluate(dark=>document.body.toggleAttribute('data-ds-dark-theme',dark),dark);
      await page.evaluate(()=>window.renderHandoff('stream','task-result'));
      const message = page.locator('[data-chat-key="message:reply:task-completion:2:1"]');
      await message.getByText('同一条完整回复',{exact:true}).waitFor();
      await page.evaluate(()=>window.taskReplyNode=document.querySelector('[data-chat-key="message:reply:task-completion:2:1"]'));
      for(const phase of ['stream','settled','completed','history']) {
        if(phase!=='stream') await page.evaluate(phase=>window.renderHandoff(phase,'task-result'),phase);
        await message.getByText('同一条完整回复',{exact:true}).waitFor();
        assert.equal(await message.count(),1);
        assert(await message.evaluate(node=>node===window.taskReplyNode),`${phase}: ordinary reply retains its mounted identity`);
        assert.equal(await page.locator('[data-role="user"]').count(),0,'completion signal is never a user bubble');
        assert.equal(await page.getByText(/PRIVATE|交付通知/).count(),0);
        assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
        if(captureDir) await page.screenshot({path:join(captureDir,`task-result-${phase}-${dark?'dark':'light'}-${width}.png`),fullPage:true});
      }
    }
    assert.deepEqual(errors,[]);
  } finally { await browser.close(); }
});

test('Router public text stays mounted across tool and reasoning steps, completion and request boundaries', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const html = await fixture(), browser = await chromium.launch({ headless:true, executablePath });
  try {
    const page = await browser.newPage({ reducedMotion:'reduce' }), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent(html);
    for (const path of ['tool', 'reasoning', 'tool-end']) {
      await page.evaluate(path => window.renderTurn('text',path),path);
      const message = page.locator('[data-chat-key^="message:reply:human"]').first();
      await message.getByText('先看资料。',{exact:true}).waitFor();
      await page.evaluate(() => {
        window.turnMessage = document.querySelector('[data-chat-key^="message:reply:human"]');
        window.turnRemoved = false;
        window.turnObserver = new MutationObserver(records => {
          if(records.some(record => [...record.removedNodes].some(node => node === window.turnMessage || node.contains?.(window.turnMessage)))) window.turnRemoved = true;
        });
        window.turnObserver.observe(document.querySelector('.ba-chat-feed'),{childList:true,subtree:true});
      });
      const phases = path === 'tool-end' ? ['tool','completed','history'] : ['tool','reasoning','reasoning','next-text','settled','completed','history'];
      for(const phase of phases) {
        await page.evaluate(({phase,path}) => window.renderTurn(phase,path),{phase,path});
        await message.getByText('先看资料。',{exact:true}).waitFor();
        if(path !== 'tool-end' && ['next-text','settled','completed','history'].includes(phase)) await page.locator('[data-chat-key^="message:reply:human"]').getByText('找到结果。',{exact:true}).waitFor();
        assert.equal(await message.count(),1);
        assert(await message.evaluate(node => node === window.turnMessage),`${path}/${phase}: the reply article stays mounted`);
        assert.equal(await page.evaluate(() => window.turnRemoved),false,`${path}/${phase}: earlier text never disappears`);
        assert.equal(await page.getByText(/PRIVATE|LATE/).count(),0);
        if(captureDir) {
          await mkdir(captureDir,{recursive:true});
          await page.screenshot({path:join(captureDir,`continuity-${path}-${phase}.png`),fullPage:true});
        }
      }
      await page.evaluate(() => window.turnObserver.disconnect());
    }
    for(const reason of ['aborted','error']) {
      await page.evaluate(() => window.renderTurn('reasoning','tool'));
      await page.getByText('先看资料。',{exact:true}).waitFor();
      await page.evaluate(reason => window.renderTurn(reason,'tool'),reason);
      await page.locator('[data-chat-key^="message:reply:human"]').waitFor({state:'detached'});
      await page.evaluate(reason => window.renderTurn(reason,'published'),reason);
      await page.getByText('已正式发表。',{exact:true}).waitFor();
    }
    for(const phase of ['switch-session','next-request']) {
      await page.evaluate(() => window.renderTurn('reasoning','tool'));
      await page.getByText('先看资料。',{exact:true}).waitFor();
      await page.evaluate(phase => window.renderTurn(phase,'tool'),phase);
      await page.locator('[data-chat-key^="message:reply:human"]').waitFor({state:'detached'});
      assert.equal(await page.getByText(/PRIVATE|LATE/).count(),0);
    }
    assert.deepEqual(errors,[]);
  } finally { await browser.close(); }
});

test('human follow-ups stay below prior replies without unmounting them through queue, steering and history', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const html = await fixture(), browser = await chromium.launch({ headless:true, executablePath });
  try {
    const page = await browser.newPage({ reducedMotion:'reduce' }), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent(html);
    if(captureDir) await mkdir(captureDir,{recursive:true});
    for(const dark of [false,true]) for(const width of [1440,390]) {
      await page.setViewportSize({width,height:800});
      await page.evaluate(dark=>document.body.toggleAttribute('data-ds-dark-theme',dark),dark);
      await page.evaluate(()=>window.renderFollowup('initial'));
      const original = page.locator('[data-chat-key="message:reply:human:2:1"]');
      await original.getByText('先检查连接。',{exact:true}).waitFor();
      await page.evaluate(()=>window.originalReply=document.querySelector('[data-chat-key="message:reply:human:2:1"]'));
      for(const phase of ['pending','inbox','steering','replied','repeated','history']) {
        await page.evaluate(phase=>window.renderFollowup(phase),phase);
        await page.getByText('这么慢吗？',{exact:true}).waitFor();
        assert(await original.evaluate(node=>node===window.originalReply),`${phase}: prior reply remains mounted`);
        const texts = await page.locator('.ba-chat-message').evaluateAll(nodes=>nodes.map(node=>node.querySelector('.ba-chat-content').innerText.trim()));
        assert.deepEqual(texts, ['请连接笔记服务','先检查连接。','这么慢吗？',
          ...(['replied','repeated','history'].includes(phase)?['正在核实认证。']:[]),
          ...(['repeated','history'].includes(phase)?['现在进展呢？','收到补充，继续处理。']:[])],`${phase}: exact conversational event order`);
        assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      }
      if(captureDir) await page.screenshot({path:join(captureDir,`followup-${dark?'dark':'light'}-${width}.png`),fullPage:true});
    }
    assert.deepEqual(errors,[]);
  } finally { await browser.close(); }
});

test('Router streaming message keeps its mounted identity through official settlement and delayed history', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const html = await fixture(), browser = await chromium.launch({ headless:true, executablePath });
  try {
    const page = await browser.newPage({ reducedMotion:'reduce' }), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent(html);
    if(captureDir) await mkdir(captureDir,{recursive:true});
    for (const width of [1440,390]) for (const kind of ['text', 'assistant_reply']) {
      await page.setViewportSize({width,height:500});
      await page.evaluate(kind => window.renderHandoff('stream', kind), kind);
      const message = page.locator('[data-chat-key^="message:reply:human"]').first();
      await message.getByText('同一条完整回复',{exact:true}).waitFor();
      await page.evaluate(() => window.handoffLayout = () => {
        const feed=document.querySelector('.ba-chat-feed');
        const row=feed.querySelector('[data-chat-key^="message:reply:human"]');
        const box=node=>{const r=node.getBoundingClientRect();return {left:r.left,top:r.top+feed.scrollTop,screenTop:r.top,width:r.width,height:r.height}};
        return {scrollTop:feed.scrollTop,distanceFromBottom:feed.scrollHeight-feed.scrollTop-feed.clientHeight,row:box(row),body:box(row.querySelector('.ba-chat-body')),content:box(row.querySelector('.ba-chat-content'))};
      });
      const baseline=await page.evaluate(()=>window.handoffLayout()), frames=[{phase:'stream',...baseline}];
      assert.equal(await message.locator('.ba-message-toolbar').getByRole('button').count(),0,'streaming controls stay inaccessible until the reply settles');
      await page.evaluate(() => {
        window.streamMessage = document.querySelector('[data-chat-key^="message:reply:human"]');
        window.streamParagraph = window.streamMessage.querySelector('p');
        window.streamToolbar = window.streamMessage.querySelector('.ba-message-toolbar');
        window.removedStream = false;
        window.handoffObserver = new MutationObserver(records => {
          if (records.some(record => [...record.removedNodes].some(node => node === window.streamMessage || node.contains?.(window.streamMessage)))) window.removedStream = true;
        });
        window.handoffObserver.observe(document.querySelector('.ba-chat-feed'),{childList:true,subtree:true});
      });
      if(captureDir) await page.screenshot({path:join(captureDir,`handoff-${width}-${kind}-stream.png`),fullPage:true});
      for (const phase of ['settled', 'completed', 'history']) {
        const phaseFrames=await page.evaluate(async ({phase,kind}) => {
          window.renderHandoff(phase,kind);
          const frames=[];
          for(let frame=0;frame<4;frame++) {
            await new Promise(requestAnimationFrame);
            frames.push({phase,frame,...window.handoffLayout(),sameParagraph:window.streamParagraph===window.streamMessage.querySelector('p'),sameToolbar:window.streamToolbar===window.streamMessage.querySelector('.ba-message-toolbar')});
          }
          return frames;
        },{phase,kind});
        await message.getByText('同一条完整回复',{exact:true}).waitFor();
        assert.equal(await message.count(),1);
        assert(await message.evaluate(node=>node===window.streamMessage),`${kind}/${phase}: same mounted article`);
        assert.equal(await page.evaluate(()=>window.removedStream),false,`${kind}/${phase}: message never disappears`);
        assert.equal(await page.getByText('PRIVATE',{exact:true}).count(),0);
        frames.push(...phaseFrames);
        if(captureDir) await writeFile(join(captureDir,`handoff-${width}-${kind}-frames.json`),JSON.stringify(frames,null,2));
        for(const {phase:_,frame,sameParagraph,sameToolbar,...layout} of phaseFrames) {
          assert(sameParagraph&&sameToolbar,`${width}/${kind}/${phase}/${frame}: paragraph and action nodes stay mounted`);
          assert.deepEqual(layout,baseline,`${width}/${kind}/${phase}/${frame}: identical content must retain its body width, height and scroll position`);
        }
        if(captureDir) {
          await mkdir(captureDir,{recursive:true});
          await page.screenshot({path:join(captureDir,`handoff-${width}-${kind}-${phase}.png`),fullPage:true});
        }
      }
      await page.evaluate(()=>window.handoffObserver.disconnect());
    }
    for(const reason of ['aborted','error']) {
      await page.evaluate(reason=>window.renderHandoff(reason,'text'),reason);
      await page.locator('[data-chat-key^="message:reply:human"]').waitFor({state:'detached'});
    }
    assert.deepEqual(errors,[],'no browser runtime errors during the handoff');
  } finally { await browser.close(); }
});

test('streaming reveals only new Markdown blocks without replaying existing text or final handoff', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const html=await fixture(), browser=await chromium.launch({headless:true,executablePath});
  try {
    const page=await browser.newPage({viewport:{width:390,height:700},reducedMotion:'no-preference'});
    await page.setContent(html);
    await page.evaluate(()=>{
      window.blockReveals=[];
      document.addEventListener('animationstart',event=>{if(event.animationName==='ba-chat-reveal') window.blockReveals.push(event.target.tagName)});
      window.renderHandoff('stream','text','第一段正文');
    });
    const message=page.locator('[data-chat-key^="message:reply:human"]').first();
    await message.getByText('第一段正文',{exact:true}).waitFor();
    await page.waitForFunction(()=>window.blockReveals.length===1);
    await page.evaluate(()=>window.firstRevealParagraph=document.querySelector('[data-chat-key^="message:reply:human"] p'));
    await page.evaluate(()=>window.renderHandoff('stream','text','第一段正文，继续补充。'));
    await message.getByText('第一段正文，继续补充。',{exact:true}).waitFor();
    assert(await message.locator('p').evaluate(node=>node===window.firstRevealParagraph),'appending text keeps its actual paragraph node');
    assert.deepEqual(await page.evaluate(()=>window.blockReveals),['P'],'token additions never restart the existing block animation');
    await page.evaluate(()=>window.renderHandoff('stream','text','第一段正文，继续补充。\n\n新增段落。'));
    await message.getByText('新增段落。',{exact:true}).waitFor();
    await page.waitForFunction(()=>window.blockReveals.length===2);
    const wrapperMotion=await message.evaluate(node=>[node,node.querySelector('.ba-chat-content')].map(element=>getComputedStyle(element).animationName));
    assert.deepEqual(wrapperMotion,['none','none'],'the message and bubble never animate as a whole');
    for(const phase of ['completed','history']) {
      await page.evaluate(async phase=>{
        window.renderHandoff(phase,'text','第一段正文，继续补充。\n\n新增段落。');
        await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
      },phase);
      assert.deepEqual(await page.evaluate(()=>window.blockReveals),['P','P'],'final settlement never replays reveal animations');
      await page.waitForFunction(()=>[...document.querySelectorAll('[data-chat-key^="message:reply:human"] p')].every(node=>getComputedStyle(node).opacity==='1'));
      assert.deepEqual(await message.locator('p').evaluateAll(nodes=>nodes.map(node=>getComputedStyle(node).opacity)),['1','1']);
    }
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.evaluate(()=>window.renderHandoff('stream','text','第一段正文，继续补充。\n\n新增段落。\n\n减少动态效果。'));
    await message.getByText('减少动态效果。',{exact:true}).waitFor();
    assert.deepEqual(await message.locator('p').evaluateAll(nodes=>nodes.map(node=>getComputedStyle(node).animationName)),['none','none','none'],'reduced motion disables every reply reveal');
    if(captureDir) {
      await mkdir(captureDir,{recursive:true});
      await page.screenshot({path:join(captureDir,'streaming-reduced-motion.png'),fullPage:true});
      await writeFile(join(captureDir,'streaming-animation-evidence.json'),JSON.stringify(await page.evaluate(()=>({animationStarts:window.blockReveals,firstParagraphRetained:window.firstRevealParagraph===document.querySelector('[data-chat-key^="message:reply:human"] p')})),null,2));
    }
  } finally { await browser.close(); }
});

test('completion keeps the real screen position while its final text and delayed history settle', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const html=await fixture(),browser=await chromium.launch({headless:true,executablePath});
  try {
    for(const width of [1440,390]) for(const dark of [false,true]) for(const reducedMotion of ['no-preference','reduce']) {
      const page=await browser.newPage({viewport:{width,height:500},reducedMotion}),errors=[];
      page.on('pageerror',error=>errors.push(error.message));
      await page.setContent(html);
      const text='完成时保持正在阅读的正文位置，不因为状态改变而重新排列。'.repeat(40)+'\n\n尾部';
      const finalText=text+'完成。';
      await page.evaluate(({text,dark})=>{document.body.toggleAttribute('data-ds-dark-theme',dark);window.renderHandoff('stream','text',text);},{text,dark});
      await page.getByText('尾部',{exact:true}).waitFor();
      await page.evaluate(()=>document.fonts.ready);
      await page.waitForFunction(()=>{const feed=document.querySelector('.ba-chat-feed');return feed.scrollHeight-feed.clientHeight-feed.scrollTop<=1;});
      await page.waitForTimeout(200);
      const frames=await page.evaluate(async finalText=>{
        const feed=document.querySelector('.ba-chat-feed');
        const row=feed.querySelector('[data-chat-key^="message:reply:human"]');
        const paragraph=row.querySelector('p'),body=row.querySelector('.ba-chat-content'),tail=feed.querySelector('.ba-chat-tail');
        const sample=phase=>({phase,top:feed.scrollTop,height:feed.scrollHeight,screenTop:body.getBoundingClientRect().top,
          bodyHeight:body.getBoundingClientRect().height,tailHeight:tail.getBoundingClientRect().height,
          sameRow:row===feed.querySelector('[data-chat-key^="message:reply:human"]'),sameParagraph:paragraph===row.querySelector('p'),
          activities:tail.querySelectorAll('[role="status"]').length});
        window.renderHandoff('stream','text',finalText);
        await new Promise(requestAnimationFrame);
        const frames=[sample('last-text')];
        window.renderHandoff('completed','text',finalText);
        for(let index=0;index<6;index++){await new Promise(requestAnimationFrame);frames.push(sample('completed-'+index));}
        await new Promise(resolve=>setTimeout(resolve,280));frames.push(sample('revealed'));
        window.renderHandoff('history','text',finalText);
        for(let index=0;index<4;index++){await new Promise(requestAnimationFrame);frames.push(sample('history-'+index));}
        return frames;
      },finalText);
      const baseline=frames[0];
      assert(baseline.top>0,'the long message really overflows the viewport');
      assert(baseline.activities>0,'the baseline includes the actual live activity');
      for(const frame of frames) {
        assert(frame.sameRow&&frame.sameParagraph,`${width}/${dark}/${reducedMotion}/${frame.phase}: official text stays mounted`);
        assert(Math.abs(frame.top-baseline.top)<=1,`${frame.phase}: scrollTop never resets`);
        assert(Math.abs(frame.screenTop-baseline.screenTop)<=1,`${frame.phase}: prose stays at the same screen coordinate`);
        assert.equal(frame.height,baseline.height,`${frame.phase}: activity removal never shrinks the transcript`);
        assert.equal(frame.bodyHeight,baseline.bodyHeight);
        assert.equal(frame.tailHeight,baseline.tailHeight);
        if(frame.phase!=='last-text')assert.equal(frame.activities,0,'completed history has no fake live status');
      }
      if(captureDir){
        await mkdir(captureDir,{recursive:true});
        await writeFile(join(captureDir,`completion-${width}-${dark?'dark':'light'}-${reducedMotion}.json`),JSON.stringify(frames,null,2));
        await page.screenshot({path:join(captureDir,`completion-${width}-${dark?'dark':'light'}-${reducedMotion}.png`),fullPage:true});
      }
      await page.setContent(html);
      await page.evaluate(({finalText,dark})=>{document.body.toggleAttribute('data-ds-dark-theme',dark);window.renderHandoff('history','text',finalText);},{finalText,dark});
      await page.getByText('尾部完成。',{exact:true}).waitFor();
      await page.evaluate(()=>document.fonts.ready);
      const loaded=await page.locator('.ba-chat-feed').evaluate(feed=>({height:feed.scrollHeight,tail:feed.querySelector('.ba-chat-tail').getBoundingClientRect().height,status:feed.querySelector('.ba-chat-tail [role="status"]')}));
      assert.equal(loaded.height,baseline.height,'initial history uses the same final geometry');
      assert.equal(loaded.tail,baseline.tailHeight);
      assert.equal(loaded.status,null);
      assert.deepEqual(errors,[]);
      await page.close();
    }
  } finally {await browser.close();}
});

test('a short reply and its last new block finish their entry after business streaming ends', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const html=await fixture(),browser=await chromium.launch({headless:true,executablePath});
  try {
    const page=await browser.newPage({viewport:{width:390,height:500},reducedMotion:'no-preference'});
    await page.setContent(html);
    for(const text of ['短回复。','先出现的正文。\n\n最后新增的段落。']) {
      // Start from a fresh mount so the short reply's actual entry is covered.
      await page.setContent(html);
      if(text.includes('\n\n')) {
        await page.evaluate(()=>window.renderHandoff('stream','text','先出现的正文。'));
        await page.getByText('先出现的正文。',{exact:true}).waitFor();
        await page.waitForTimeout(180);
      }
      const state=await page.evaluate(async text=>{
        window.renderHandoff('stream','text',text);
        await new Promise(requestAnimationFrame);
        const row=document.querySelector('[data-chat-key^="message:reply:human"]');
        const block=[...row.querySelectorAll('p')].at(-1);
        const animation=block.getAnimations().find(animation=>animation.animationName==='ba-chat-reveal');
        if(!animation)return {hasEntry:false};
        // Freeze at an observable in-between frame, then resume before the
        // actual completion so browser scheduling cannot hide a hard cut.
        animation.pause();animation.currentTime=40;
        const before=getComputedStyle(block).opacity;
        window.renderHandoff('completed','text',text);
        await new Promise(requestAnimationFrame);
        const same=block.getAnimations().includes(animation),after=getComputedStyle(block).opacity;
        const businessStreaming=row.dataset.streaming;
        animation.play();
        await animation.finished.catch(()=>{});
        await new Promise(requestAnimationFrame);
        return {hasEntry:true,before,after,same,businessStreaming,opacity:getComputedStyle(block).opacity};
      },text);
      assert(state.hasEntry,'the test observes a real new-block entry');
      assert(state.same,'completion retains the running entry instead of cancelling it');
      assert.equal(state.after,state.before,'completion never jumps directly to full opacity');
      assert.equal(state.businessStreaming,undefined,'business completion and controls are not delayed by presentation');
      assert.equal(state.opacity,'1');
      await page.waitForFunction(()=>!document.querySelector('.ba-chat-content[data-stream-revealing]'));
    }
  } finally {await browser.close();}
});

test('stream growth follows smoothly and yields immediately to reading or reduced motion', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const html=await fixture(), browser=await chromium.launch({headless:true,executablePath});
  try {
    for(const width of [1440,390]) {
      if(captureDir) await mkdir(captureDir,{recursive:true});
      const context=await browser.newContext({viewport:{width,height:800},reducedMotion:'no-preference'});
      const page=await context.newPage(),errors=[];
      page.on('pageerror',error=>errors.push(error.message));
      await page.setContent(html);
      await page.evaluate(()=>{window.preparePerformance(40);window.renderPerformance(0)});
      await page.locator('[data-chat-key="message:reply:human:2:1"]').waitFor();
      await page.evaluate(()=>document.fonts.ready);
      await page.waitForTimeout(220);
      const frames=await page.evaluate(async()=>{
        const feed=document.querySelector('.ba-chat-feed');
        const sample=()=>({time:performance.now(),top:feed.scrollTop,bottom:feed.scrollHeight-feed.clientHeight});
        const frames=[sample()];
        window.renderPerformance(60);frames.push(sample());
        for(let index=0;index<18;index++) {
          await new Promise(requestAnimationFrame);
          if(index===3)window.renderPerformance(90);
          if(index===6)window.renderPerformance(120);
          frames.push(sample());
        }
        const deadline=performance.now()+1000;
        while(feed.scrollHeight-feed.clientHeight-feed.scrollTop>1 && performance.now()<deadline) await new Promise(requestAnimationFrame);
        frames.push(sample());
        return frames;
      });
      assert.equal(frames[1].top,frames[0].top,'a received text chunk does not snap the viewport');
      assert(frames.some((frame,index)=>index>1&&frame.top>frames[index-1].top&&frame.bottom-frame.top>1),'the real container advances through intermediate positions');
      for(let index=1;index<frames.length;index++) {
        assert(frames[index].top>=frames[index-1].top-1,'growing output never oscillates upward');
        assert(frames[index].top<=frames[index].bottom+1,'following never overshoots the live tail');
      }
      assert(Math.abs(frames.at(-1).top-frames.at(-1).bottom)<=1,'following settles at the final tail');
      const held=await page.evaluate(async()=>{
        const feed=document.querySelector('.ba-chat-feed');
        feed.dispatchEvent(new WheelEvent('wheel',{deltaY:-80}));feed.scrollTop-=120;
        await new Promise(requestAnimationFrame);const top=feed.scrollTop;
        window.renderPerformance(160);await new Promise(resolve=>setTimeout(resolve,220));
        return {top,after:feed.scrollTop};
      });
      assert(Math.abs(held.top-held.after)<=1,'new output preserves the reader position after upward intent');
      const bottom=page.getByRole('button',{name:'有新回复，回到最新消息',exact:true});
      await bottom.focus();await page.keyboard.press('Enter');
      assert(await page.locator('.ba-chat-feed').evaluate(feed=>Math.abs(feed.scrollHeight-feed.clientHeight-feed.scrollTop)<=1),'keyboard return is immediate');
      await page.emulateMedia({reducedMotion:'reduce'});
      const reduced=await page.evaluate(()=>{
        window.renderPerformance(200);const feed=document.querySelector('.ba-chat-feed');
        return {top:feed.scrollTop,bottom:feed.scrollHeight-feed.clientHeight};
      });
      assert(Math.abs(reduced.top-reduced.bottom)<=1,'reduced motion follows without a scroll animation');
      if(captureDir) {
        await writeFile(join(captureDir,`scroll-frames-${width}.json`),JSON.stringify({frames,held,reduced},null,2));
        await page.screenshot({path:join(captureDir,`scroll-settled-${width}.png`),fullPage:true});
      }
      assert.deepEqual(errors,[]);
      await context.close();
    }
  } finally {await browser.close();}
});

test('token updates keep history controls cached and leave no global text paints or animation loop', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const html=await fixture(), browser=await chromium.launch({headless:true,executablePath});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'no-preference'}), errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.setContent(html);
    for(const count of [200,600]) {
      const evidence=await page.evaluate(async count=>{
        window.preparePerformance(count);window.renderPerformance(0);
        await document.fonts.ready;await new Promise(requestAnimationFrame);
        const oldParagraph=document.querySelector('[data-chat-key="message:history-1"] p');
        const originalFormat=Date.prototype.toLocaleString,originalFrame=window.requestAnimationFrame,originalCancel=window.cancelAnimationFrame;
        let formats=0,requested=0;const frames=new Set();
        Date.prototype.toLocaleString=function(...args){formats++;return originalFormat.apply(this,args)};
        window.requestAnimationFrame=callback=>{requested++;let id;id=originalFrame.call(window,time=>{frames.delete(id);callback(time)});frames.add(id);return id};
        window.cancelAnimationFrame=id=>{frames.delete(id);return originalCancel.call(window,id)};
        const samples=[];
        try{
          for(let i=1;i<=30;i++){
            const start=performance.now();window.renderPerformance(i);samples.push(performance.now()-start);
            await new Promise(resolve=>originalFrame.call(window,resolve));
          }
          // A continuous trajectory keeps velocity between chunks. Wait for
          // actual frame quiescence within a bound, then verify it stays idle.
          const deadline=performance.now()+1000;
          do { await new Promise(resolve=>originalFrame.call(window,resolve)); }
          while(frames.size && performance.now()<deadline);
          const requestsAfterInput=requested;
          await new Promise(resolve=>setTimeout(resolve,200));
          return {count,formats,requested,requestsAfterInput,pending:frames.size,
            sameParagraph:oldParagraph===document.querySelector('[data-chat-key="message:history-1"] p'),
            highlights:[...CSS.highlights.keys()].filter(name=>name.startsWith('ba-stream-')).length,
            paintStyles:document.querySelectorAll('style[data-benchgo-stream-reveal]').length,
            samples};
        }finally{Date.prototype.toLocaleString=originalFormat;window.requestAnimationFrame=originalFrame;window.cancelAnimationFrame=originalCancel;}
      },count);
      assert.equal(evidence.formats,0,'unchanged timestamps, including the streaming reply, are never formatted per token');
      assert(evidence.sameParagraph,'history retains its actual Markdown nodes');
      assert.equal(evidence.highlights,0);assert.equal(evidence.paintStyles,0);
      assert.equal(evidence.pending,0);assert.equal(evidence.requested,evidence.requestsAfterInput,'idle chat schedules no continuing JavaScript animation');
      if(captureDir){await mkdir(captureDir,{recursive:true});await writeFile(join(captureDir,`token-performance-${count}.json`),JSON.stringify(evidence,null,2));}
    }
    await page.evaluate(()=>window.renderScenario('empty'));
    await page.locator('.ba-home-starters').waitFor();
    assert.equal(await page.locator('style[data-benchgo-stream-reveal]').count(),0);
    assert.deepEqual(errors,[]);
  } finally {await browser.close();}
});

test('cached message controls use current callbacks, saved reaction, text, timestamp and usage', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const html=await fixture(),browser=await chromium.launch({headless:true,executablePath});
  try{
    const page=await browser.newPage({reducedMotion:'reduce'});
    await page.route('http://localhost/',route=>route.fulfill({contentType:'text/html',body:html}));
    await page.goto('http://localhost/');
    await page.context().grantPermissions(['clipboard-read','clipboard-write'],{origin:'http://localhost'});
    await page.evaluate(()=>window.renderActionRevision(1));
    const message=page.locator('[data-chat-key="message:action"]');
    await message.getByText('消息版本1',{exact:true}).waitFor();
    const previousTime=await message.locator('time').getAttribute('datetime');
    await page.evaluate(()=>window.renderActionRevision(2));
    await message.getByText('消息版本2',{exact:true}).waitFor();
    assert.notEqual(await message.locator('time').getAttribute('datetime'),previousTime);
    // The mount-time history reconcile fires about 100ms after the first render; let it land before the click it would race.
    await page.waitForFunction(()=>window.actionCalls.some(call=>call[0]==='refresh'));
    assert.deepEqual(await page.evaluate(()=>window.actionCalls.splice(0).map(call=>call[0])),['refresh']);
    await message.getByRole('button',{name:'取消回应 ❤️',exact:true}).click();
    assert.deepEqual(await page.evaluate(()=>window.actionCalls),[['api',2,'messageReaction',{threadId:'revision-2',messageKey:'message:action',emoji:null}],['refresh',2]]);
    await message.hover();
    await message.getByRole('button',{name:'复制消息',exact:true}).click();
    assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'消息版本2');
    await message.getByRole('button',{name:'本条回复用量',exact:true}).click();
    assert.equal(await page.locator('[data-action-panel=usage] dd').innerText(),'2');
  }finally{await browser.close();}
});

test('Router natural chat excludes execution metadata, deduplicates delivery and retains real questions', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const html = await fixture();
  const browser = await chromium.launch({ headless:true, executablePath });
  const errors = [];
  try {
    const page = await browser.newPage({ reducedMotion:'reduce' });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://localhost/', route => route.fulfill({contentType:'text/html',body:html}));
    await page.goto('http://localhost/');
    for (const dark of [false,true]) for (const width of [1440,390]) {
      await page.setViewportSize({ width,height:900 });
      await page.evaluate(dark => document.body.toggleAttribute('data-ds-dark-theme',dark),dark);
      for (const state of ['state-error','state-reported','router-delivered','send-error']) {
        await page.evaluate(state => window.renderScenario(state),state);
        await page.getByLabel('主助手对话',{exact:true}).waitFor();
        assert.equal(await page.getByText('系统状态',{exact:true}).count(),0);
        assert.equal(await page.getByRole('button',{name:'查看执行会话',exact:true}).count(),0);
        if (state==='state-error') {
          assert.equal(await page.locator('.ba-chat-message').count(),0,'legacy system records and Worker drafts stay in task details');
        } else if(state==='send-error') {
          await page.getByRole('alert').getByText('连接中断，消息发送失败',{exact:true}).waitFor();
          await page.waitForFunction(()=>window.refreshes>=1);
          const refreshes=await page.evaluate(()=>window.refreshes);
          await page.getByRole('button',{name:'重新核实',exact:true}).click();
          assert.equal(await page.evaluate(()=>window.refreshes),refreshes+1,'failed sends can recheck the original receipt without replay');
          assert.deepEqual(await page.evaluate(()=>window.apiCalls),[]);
        } else {
          await page.getByText('调研任务暂时受阻，已有记录已保留。',{exact:true}).waitFor();
          assert.equal(await page.locator('[data-chat-key="notification:old-notification-uuid"]').count(),0);
          assert.equal(await page.getByText('调研任务暂时受阻，已有记录已保留。',{exact:true}).count(),1);
          assert.equal(await page.getByLabel('定时任务状态',{exact:true}).count(),0);
        }
        assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no page overflow');
        assert(await page.locator('.ba-chat-feed').evaluate(node=>node.scrollWidth<=node.clientWidth),'no chat overflow');
        if(captureDir) {
          await mkdir(captureDir,{recursive:true});
          await page.screenshot({path:join(captureDir,`${state}-${dark?'dark':'light'}-${width}.png`),fullPage:true});
        }
      }
    }
    await page.evaluate(()=>window.renderScenario('task-question'));
    await page.getByText('需要你的答复',{exact:true}).waitFor();
    assert.equal(await page.getByLabel('任务问题',{exact:true}).count(),1);
    assert.equal(await page.getByLabel('任务等待状态',{exact:true}).count(),0);
    for (const name of ['查看执行会话','刷新状态','停止任务']) assert.equal(await page.getByRole('button',{name,exact:true}).count(),0);
    await page.getByRole('radio',{name:'B',exact:true}).check();
    if(captureDir) await page.screenshot({path:join(captureDir,'question-B-before-submit.png'),fullPage:true});
    await page.getByRole('button',{name:'提交答复',exact:true}).click();
    await page.getByText('答复已保存 · 原任务继续处理',{exact:true}).waitFor();
    const answer = await page.evaluate(()=>window.apiCalls.find(([name])=>name==='taskAnswer'));
    assert.equal(answer[1].taskId,'task');
    assert.deepEqual(answer[1].answer,{selected:['B']});
    if(captureDir) await page.screenshot({path:join(captureDir,'question-without-status-panel.png'),fullPage:true});
    assert.deepEqual(errors,[]);
  } finally { await browser.close(); }
});

// Real components and host theme; only data/API responses are fixtures. No model or user data is accessed.
async function fixture() {
  const result = await build({
    stdin: { resolveDir: root, loader: 'jsx', contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { flushSync } from 'react-dom';
      import { QuietChat } from './plugins/superagent/client/quiet-chat.jsx';
      import { AssistantHome } from './plugins/superagent/client/home.jsx';
      import { PartialArguments } from '@deepseek-ai/dsh-util-values';
      const root = createRoot(document.getElementById('root'));
      const performanceSession={running:true};
      window.preparePerformance=count=>{
        window.performanceHistory={sessionId:'performance',activeReply:{turn:2,requestId:'human'},messages:Array.from({length:count},(_,i)=>({
          id:'history-'+i,role:i%2?'assistant':'user',kind:i%2?'final':undefined,seq:i,
          text:'历史消息 '+i+'。'+'这一条历史消息包含普通段落和需要阅读的内容。'.repeat(5),time:1793700000000+i*1000
        }))};
        window.performanceHistory.messages.push({id:'human',role:'user',seq:10000,text:'请继续',time:1793808000000});
      };
      window.renderPerformance=index=>{
        const home={sessionId:'performance',threadId:'main',assistantName:'BenchGo',history:window.performanceHistory};
        const chat={legacy:{nodes:[{kind:'user',messageId:'human',seq:10000,source:{kind:'user'}}],turnEnds:new Map(),partial:{turn:2,step:1,blocks:[{kind:'text',text:'流式新增正文：'+'此处新增一段文本。'.repeat(index+1)}]}},timeline:{turnOrder:[2],turns:new Map([[2,{turn:2,start:{seq:9999}}]])}};
        flushSync(()=>root.render(<div className="ba-root ba-official-conversation" data-assistant-chat=""><div className="ba-chat-viewport"><div className="ba-chat-feed" data-assistant-scroll=""><QuietChat home={home} session={performanceSession} chat={chat}/></div></div></div>));
      };
      window.renderActionRevision=revision=>{
        if(revision===1)window.actionCalls=[];
        const home={sessionId:'actions',threadId:'revision-'+revision,assistantName:'BenchGo',
          api:async(name,args)=>window.actionCalls.push(['api',revision,name,args]),onRefresh:async()=>window.actionCalls.push(['refresh',revision]),
          history:{messages:[{id:'action',role:'assistant',kind:'final',text:'消息版本'+revision,time:1793808000000+revision*60000,usage:{outputTokens:revision}}],reactions:{'message:action':revision===1?'👍':'❤️'}}};
        flushSync(()=>root.render(<div className="ba-root ba-official-conversation" data-assistant-chat=""><div className="ba-chat-viewport"><div className="ba-chat-feed" data-assistant-scroll=""><QuietChat home={home} session={{running:false}}/></div></div></div>));
      };
      window.renderFollowup = phase => {
        const user={id:'human',role:'user',seq:8,text:'请连接笔记服务',time:1793808000000};
        const followup={id:'followup',role:'user',seq:12,text:'这么慢吗？',time:1793807990000};
        const later={id:'later',role:'user',seq:16,text:'现在进展呢？',time:1793807980000};
        const first={id:'reply:human:2:1',requestId:'human',segment:true,role:'assistant',kind:'final',seq:10,text:'先检查连接。',time:1793808001000};
        const second={...first,id:'reply:followup:2:2',requestId:'followup',seq:14,text:'正在核实认证。'};
        const third={...first,id:'reply:later:2:3',requestId:'later',seq:18,text:'收到补充，继续处理。'};
        const steering=['steering','replied','repeated','history'].includes(phase),repeated=['repeated','history'].includes(phase);
        const admitted=row=>({kind:row.id==='human'?'user':'steering',messageId:row.id,seq:row.seq,time:row.time,
          source:{kind:'user',rpcId:row.id},content:[{type:'text',text:row.text}]});
        const settled=(row,step)=>({kind:'assistant',messageId:'answer-'+step,turn:2,step,seq:row.seq,time:row.time,blocks:[{kind:'text',text:row.text}]});
        const nodes=[admitted(user),settled(first,1),...(steering?[admitted(followup)]:[]),
          ...(['replied','repeated','history'].includes(phase)?[settled(second,2)]:[]),...(repeated?[admitted(later),settled(third,3)]:[])];
        const messages=phase==='history'?[user,first,followup,second,later,third]:[user,...(steering?[followup]:[]),...(repeated?[later]:[])];
        const history={sessionId:'followup-session',activeReply:{turn:2,requestId:repeated?'later':steering?'followup':'human'},messages};
        const pending=phase==='pending'?[{requestId:followup.id,placement:'steering',text:followup.text,time:followup.time}]:[];
        const inbox=phase==='inbox'?{'next-step':[{id:followup.id,source:{kind:'user',rpcId:followup.id},content:[{type:'text',text:followup.text}]}]}:undefined;
        const chat={legacy:{nodes,turnEnds:new Map()},timeline:{turnOrder:[2],turns:new Map([[2,{turn:2,start:{seq:7}}]])}};
        const home={sessionId:'followup-session',threadId:'main',assistantName:'BenchGo',history};
        flushSync(()=>root.render(<div className="ba-root ba-official-conversation" data-assistant-chat=""><div className="ba-chat-viewport"><div className="ba-chat-feed" data-assistant-scroll=""><QuietChat home={home} session={{running:true,pendingSubmissions:pending}} chat={chat} inbox={inbox}/></div></div></div>));
      };
      window.renderTurn = (phase, path) => {
        const first='先看资料。', second='找到结果。';
        const user={id:'human',role:'user',seq:8,text:'请检查',time:1793808000000};
        const stopped=['aborted','error'].includes(phase);
        const ended=stopped||['completed','history'].includes(phase);
        const end=ended?{seq:18,time:1793808001000,data:{reason:{kind:stopped?phase:'completed'}}}:undefined;
        const turn={turn:2,start:{seq:7},...(end?{end}:{}),steps:[{step:1,start:{seq:7.5},...(phase==='text'?{}:{end:{seq:11}})}]};
        const blocks=[{kind:'text',text:first},...(path==='reasoning'?[]:[{kind:'tool-call',name:'read',argsRaw:'PRIVATE_ARGS'}])];
        const legacy={nodes:[{kind:'user',messageId:'human',seq:8,source:{kind:'user'}}],turnEnds:new Map(end?[[2,18]]:[])};
        if(phase==='text') legacy.partial={turn:2,step:1,blocks:[{kind:'text',text:first}]};
        else {
          legacy.nodes.push({kind:'assistant',messageId:'first-step',seq:10,turn:2,step:1,blocks});
          if(path!=='reasoning') legacy.nodes.push({kind:'tool-result',seq:11,turn:2,step:1,content:[{type:'text',text:'PRIVATE_RESULT'}]});
          if(path!=='tool-end' && phase!=='tool') {
            turn.steps.push({step:2,start:{seq:12},...(['settled','completed','history'].includes(phase)?{end:{seq:16}}:{})});
            if(['settled','completed','history'].includes(phase)) {
              legacy.nodes.push({kind:'assistant',messageId:'second-step',seq:15,turn:2,step:2,blocks:[{kind:'text',text:second}]});
              legacy.partial={turn:2,step:1,blocks:[{kind:'text',text:'LATE_PARTIAL'}]};
            } else legacy.partial={turn:2,step:2,blocks:[{kind:'reasoning',text:'PRIVATE_REASONING'},...(phase==='next-text'?[{kind:'text',text:second}]:[])]};
          }
        }
        if(path==='published') legacy.nodes.push({kind:'tool-result',name:'assistant_reply',turn:2,args:PartialArguments.fromObject({text:'已正式发表。'}),content:[{type:'text',text:JSON.stringify({published:true,requestId:'human'})}]});
        const history={sessionId:'turn-session',activeReply:ended?null:{turn:2,requestId:'human'},messages:[user]};
        if(phase==='history') history.messages.push({id:'reply:human:2:1',requestId:'human',segment:true,role:'assistant',kind:'final',text:first,time:1793808001000},...(path==='tool-end'?[]:[{id:'reply:human:2:2',requestId:'human',segment:true,role:'assistant',kind:'final',text:second,time:1793808001000}]));
        const timeline={turnOrder:[2],turns:new Map([[2,turn]])};
        if(phase==='next-request') {
          const next={id:'next',role:'user',seq:21,text:'下一次问题',time:1793808002000};
          history.messages.push(next); history.activeReply={turn:3,requestId:'next'};
          legacy.nodes.push({kind:'user',messageId:'next',seq:21,source:{kind:'user'}});
          legacy.partial={turn:2,step:2,blocks:[{kind:'text',text:'LATE_OLD_REQUEST'}]};
          timeline.turnOrder.push(3);timeline.turns.set(3,{turn:3,start:{seq:20}});
        }
        const home={sessionId:phase==='switch-session'?'other-session':'turn-session',threadId:'main',assistantName:'BenchGo',history};
        root.render(<div className="ba-root ba-official-conversation" data-assistant-chat=""><div className="ba-chat-viewport"><div className="ba-chat-feed" data-assistant-scroll=""><QuietChat home={home} session={{running:!ended}} chat={{legacy,timeline}} /></div></div></div>);
      };
      window.renderHandoff = (phase, kind, textOverride) => {
        const text = textOverride || '同一条完整回复\\n\\n'+'这是一段完整的长回复，用于核对最终接管前后相同内容的折行与滚动位置。'.repeat(8)+'\\n\\n~~~js\\nconst message = "BenchGo keeps your messages readable";\\nconsole.log(message);\\n~~~\\n\\n| 项目 | 结果 |\\n| --- | --- |\\n| 暗主题 | 文字和气泡清晰可辨 |\\n| 操作 | 复制、表情、用量 |';
        const user = { id:'human', role:'user', seq:8, text:'请回复', time:1793808000000 };
        const internal = kind === 'task-result';
        const requestId = internal ? 'task-completion' : 'human';
        const reply = { id:kind!=='assistant_reply'?'reply:'+requestId+':2:1':'reply:human', requestId, ...(kind!=='assistant_reply'?{segment:true}:{}), role:'assistant', kind:'final', text, time:1793808060000 };
        const running = ['stream','settled'].includes(phase);
        const end = running ? undefined : {seq:12,time:1793808001000,data:{reason:{kind:['aborted','error'].includes(phase)?phase:'completed'}}};
        const turn = {turn:2,start:{seq:7},...(end?{end}:{})};
        const args = PartialArguments.fromObject({text});
        const legacy = {nodes:[{kind:'user',messageId:requestId,seq:8,time:1793808000000,source:internal?{kind:'benchgo-task-reply',replyKind:'result',replyMode:'conversation',eventKey:'result:1',taskId:'task'}:{kind:'user'},content:[{type:'text',text:internal?'PRIVATE_COMPLETION_SIGNAL':'请回复'}]}],turnEnds:new Map(end?[[2,12]]:[])};
        if(phase==='stream') {
          if(kind==='assistant_reply') legacy.runningCalls=[{name:kind,turn:2,args}];
          else legacy.partial={turn:2,step:1,blocks:[{kind:'reasoning',text:'PRIVATE'},{kind:'text',text}]};
        } else if(kind==='assistant_reply') legacy.nodes.push({kind:'tool-result',name:kind,turn:2,args,content:[{type:'text',text:JSON.stringify({published:true,requestId:'human'})}]});
        else legacy.nodes.push({kind:'assistant',messageId:'model-message',seq:10,turn:2,step:1,blocks:[{kind:'reasoning',text:'PRIVATE'},{kind:'text',text}]});
        const home = {sessionId:'handoff',threadId:'main',assistantName:'BenchGo',history:{sessionId:'handoff',activeReply:running?{turn:2,requestId}:null,messages:[...(internal?[]:[user]),...(phase==='history'?[reply]:[])]}};
        flushSync(()=>root.render(<div className="ba-root ba-official-conversation" data-assistant-chat=""><div className="ba-chat-viewport"><div className="ba-chat-feed" data-assistant-scroll=""><QuietChat home={home} session={{running}} chat={{legacy,timeline:{turnOrder:[2],turns:new Map([[2,turn]])}}} /></div></div></div>));
      };
      const messages = [
        { id:'short', role:'user', text:'好的', time:1793808000000 },
        { id:'reply', role:'assistant', kind:'final', text:'已经记下。接下来按计划推进。', usage:{inputTokens:120,outputTokens:32}, time:1793808001000 },
        { id:'question:c1', role:'user', kind:'question-reply', questions:[{id:'use',question:'这台服务器主要用来做什么？',header:'用途'},{id:'old',question:'旧服务器怎么处理？'},{id:'note',question:'还有补充吗？'}], answers:[{id:'use',selected:['网站','文件共享']},{id:'old',selected:[],custom:'先保留观察'},{id:'note',selected:[]}], text:'用途：网站、文件共享', time:1793808001500 },
        { id:'long', role:'user', text:'请检查暗主题下输入消息的可读性。\\n长消息也要清楚显示，工具栏不能遮住文字。'.repeat(3), time:1793808002000 },
        { id:'code', role:'assistant', kind:'final', text:'检查结果：\\n\\n~~~js\\nconst message = "BenchGo keeps your messages readable even when a complete source line extends beyond a narrow conversation viewport";\\nconsole.log(message);\\n~~~\\n\\n| 项目 | 结果 |\\n| --- | --- |\\n| 暗主题 | 文字和气泡清晰可辨 |\\n| 操作 | 复制、表情、用量 |\\n\\n| 供应商模型标识 | 上下文容量 | 输入类型 | 输出类型 | 实际可用状态 |\\n| --- | --- | --- | --- | --- |\\n| provider/model-version-2026-11-preview | 128000 tokens | 文字与文件内容 | 文字与结构化数据 | 已连接并完成真实请求验证 |', time:1793808003000 }
      ];
      window.renderScenario = (state = 'data') => {
        window.apiCalls = [];
        window.executionOpens = [];
        window.resourceOpens = [];
        window.refreshes = 0;
        const api = async (name, args) => {
          window.apiCalls.push([name,args]);
          if (state === 'loading') return new Promise(() => {});
          if (state === 'error') throw new Error('测试连接暂不可用');
          if (name === 'tasks' && ['home-active','home-completed'].includes(state)) return {tasks:[
            {id:'home-done',title:'已完成的历史任务',status:'completed',results:[{version:1,summary:'不应在首页展示的历史交付详情',outcome:'completed'}]},
            ...(state==='home-active'?[{id:'home-running',title:'继续推进当前目标',status:'running'}]:[]),
          ]};
          return { tasks:[], goals:[] };
        };
        const statuses = new Map(state==='question' ? [['test-question',{pendingInteraction:{kind:'question',key:'q',sessionId:'test-question'}}]] : []);
        const home = { api, threadId:'main', assistantName:'BenchGo', sessionId:'test-'+state, sessionStatus:{ subscribe:()=>()=>{}, getSnapshot:()=>statuses },
          assistantConfig:{cardMotion:false}, onOpenResources:(...args)=>window.resourceOpens.push(args),
          onOpenExecution:async execution=>{window.executionOpens.push(execution);if(window.failExecution)throw new Error('执行会话打开失败');if(window.holdExecution)await new Promise(resolve=>window.finishExecution=resolve);},
          onRefresh:async()=>{window.refreshes++}, history:{ messages:state==='data'?messages:state==='state-reported'?[{id:'router-state',role:'assistant',kind:'final',taskStateEventKey:'failure:1',text:'调研任务暂时受阻，已有记录已保留。',time:1793808005000}]:[],
            requests:state==='send-error'?[{threadId:'main',requestId:'failed-send',text:'请整理资料',status:'failed',error:'连接中断，消息发送失败',createdAt:1793808004000}]:[], reactions:{'message:reply':'👍'},
            notifications:state==='task-question'?[{eventId:'ask',type:'task.attention',threadId:'main',taskId:'task',taskStatus:'waiting',instructionRevision:1,currentInstructionRevision:1,currentResultVersion:0,text:'结果选哪个标记？',attention:{id:'attention',state:'waiting',instructionRevision:1,resultVersion:0,question:{question:'结果选哪个标记？',options:[{label:'A'},{label:'B'}]}}}]:state==='data'?[{eventId:'delivery',type:'task.result',origin:'router',publication:{action:'deliver',origin:'router'},threadId:'main',taskId:'task',taskStatus:'completed',executionSession:{available:true,taskId:'task',sessionId:'official-execution',placement:'ungrouped',closed:true},text:'布局已调整，窄容器也保持侧边操作。',createdAt:1793808004000,options:['继续检查']}]:['state-error','state-reported','router-delivered'].includes(state)?[
              {eventId:'old-notification-uuid',taskStateEventKey:'failure:1',type:'task.result',threadId:'main',taskId:'task',title:'AI获客调研',taskStatus:'waiting',publication:{action:'deliver',origin:'system',systemState:{state:'continuation_wait',code:'NETWORK',stage:'execution'},text:'系统状态：执行记录已保留，等待恢复条件。'},origin:'system',text:'系统状态：执行记录已保留，等待恢复条件。',createdAt:1793808004000},
              {eventId:'worker-draft',type:'task.result',threadId:'main',taskId:'task',publication:{action:'deliver',origin:'worker'},text:'旧执行报告：任务状态、验收记录和执行细节',createdAt:1793808004000},
              {eventId:'old-unmarked-worker',type:'task.result',threadId:'main',taskId:'task',publication:{action:'deliver'},text:'旧版Worker原始结果',createdAt:1793808004000},
              {eventId:'schedule',type:'schedule.lifecycle',threadId:'main',origin:'system',text:'系统定时记录',schedule:{phase:'completed'},createdAt:1793808004000},
              ...(state==='state-error'?[]:['router-delivery','router-replay'].map(eventId=>({eventId,taskStateEventKey:'failure:1',type:'task.result',threadId:'main',taskId:'task',origin:'router',publication:{action:'deliver',origin:'router'},text:'调研任务暂时受阻，已有记录已保留。',createdAt:1793808005000})))
            ]:[] } };
        root.render(<div className="ba-root ba-official-conversation" data-assistant-chat="">
          <div className="ba-chat-viewport"><div className="ba-chat-feed" data-assistant-scroll="" tabIndex={0}>
            {!['data','waiting','question','state-error','state-reported','router-delivered','send-error','task-question'].includes(state) && <AssistantHome key={'home-'+state} {...home} input={{phase:'plain',draft:''}} inputActions={{captureInsertion(){},insertText(){return true},persistDraft(){}}}/>}
            <QuietChat key={'chat-'+state} home={home} session={{running:state==='waiting'||state==='question'}} />
          </div></div>
        </div>);
      };
      window.renderScenario(location.hash.slice(1)||'data');
    ` },
    bundle: true, write: false, outdir: join(root, 'artifacts', 'unused-chat-test-output'), format: 'iife', jsx: 'automatic',
    nodePaths: [join(root, 'plugins/benchgo/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
    alias: {
      react: dirname(webRequire.resolve('react/package.json')), 'react-dom': dirname(webRequire.resolve('react-dom/package.json')),
      '@deepseek-ai/dsh-client-ui-primitives': join(root, 'deepseek-harness/packages/client/ui-primitives/src/index.ts'),
    },
    loader: { '.css':'text', '.module.css':'local-css', '.svg':'text', '.woff2':'dataurl', '.woff':'dataurl', '.ttf':'dataurl' },
    plugins: [sharedUiStyles()], define: {'process.env.NODE_ENV':'"production"'}, logLevel:'silent',
  });
  const themeRoot = join(root, 'deepseek-harness/packages/client/ui-theme/src/styles');
  const theme = (await Promise.all(['base.css','design-platform.css','focus.css'].map(name => readFile(join(themeRoot,name),'utf8')))).join('\n');
  const css = result.outputFiles.filter(file=>file.path.endsWith('.css')).map(file=>file.text).join('\n');
  const js = result.outputFiles.find(file=>file.path.endsWith('.js')).text.replaceAll('</script', '<\\/script');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BenchGo 消息布局回归</title><style>${theme}${css}
    *{box-sizing:border-box}body{margin:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:14px/1.6 var(--dsw-font-family)}
    #root,.ba-official-conversation{height:100vh;display:flex;flex-direction:column;min-height:0}.ba-root{--dsh-composer-side-clearance:16px}
  </style></head><body><div id="root"></div><script>${js}</script></body></html>`;
}

test('quiet chat theme, hover geometry, keyboard and touch controls in a real browser', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const html = await fixture();
  if (captureDir) { await mkdir(captureDir, { recursive:true }); await writeFile(join(captureDir,'index.html'),html); }
  const browser = await chromium.launch({ headless:true, executablePath });
  const errors=[];
  const shot = async (page,name) => { if(captureDir) await page.screenshot({path:join(captureDir,name+'.png'),fullPage:true}); };
  try {
    const page = await browser.newPage({ reducedMotion:'reduce' });
    page.on('pageerror',error=>errors.push(error.message));
    await page.setContent(html);
    await page.locator('[data-chat-key="message:short"]').waitFor();
    await page.evaluate(()=>document.fonts.ready);
    const geometry = page => page.locator('.ba-chat-feed').evaluate(feed => {
      const origin=feed.getBoundingClientRect();
      const box=node=>{const r=node.getBoundingClientRect();return {left:r.left-origin.left,top:r.top-origin.top+feed.scrollTop,width:r.width,height:r.height}};
      return {scrollHeight:feed.scrollHeight,rows:[...feed.querySelectorAll('.ba-chat-message')].map(node=>({key:node.dataset.chatKey,message:box(node),body:box(node.querySelector('.ba-chat-body')),toolbar:box(node.querySelector('.ba-message-toolbar'))}))};
    });
    for(const dark of [false,true]) for(const [width,containerWidth] of [[1440,null],[768,null],[390,null],[1440,390]]) {
      await page.setViewportSize({width,height:1000});
      await page.evaluate(({dark,containerWidth})=>{
        document.body.toggleAttribute('data-ds-dark-theme',dark);
        document.querySelector('.ba-official-conversation').style.width=containerWidth?containerWidth+'px':'';
      },{dark,containerWidth});
      await page.locator('.ba-chat-feed').evaluate(node=>node.scrollTop=0);
      await page.mouse.move(1,1);
      await page.locator('.ba-chat-feed').focus();
      const scenario=`${width}${containerWidth?'-container-'+containerWidth:''}/${dark}`;
      const replyFrame=await page.locator('[data-chat-key="message:reply"] .ba-chat-content').evaluate(node=>({label:node.getAttribute('aria-label'),header:getComputedStyle(node,'::before').content,border:getComputedStyle(node).borderLeftWidth,background:getComputedStyle(node).backgroundColor,animation:getComputedStyle(node,'::before').animationName}));
      assert.equal(replyFrame.header,'none',`${scenario}: the reply bubble has no visible assistant identity header`);
      assert.equal(replyFrame.border,'0px');assert.notEqual(replyFrame.background,'rgba(0, 0, 0, 0)');assert.equal(replyFrame.animation,'none');
      const baseline=await geometry(page);
      for(const row of await page.locator('.ba-chat-message').all()) {
        await row.hover();
        assert.deepEqual(await geometry(page),baseline,`${scenario}: hovering any message must leave all message positions and scroll height unchanged`);
        assert.equal(await row.locator('.ba-message-toolbar').evaluate(node=>getComputedStyle(node).opacity),'1','hover reveals side tools');
        await page.mouse.move(width-1,999);
        assert.deepEqual(await geometry(page),baseline,`${scenario}: leaving a message must not collapse or move a toolbar row`);
      }
      const short=page.locator('[data-chat-key="message:short"]');
      await short.hover();
      const measurements=await page.locator('.ba-chat-message').evaluateAll(nodes=>nodes.map(node=>{
        const rect=target=>{const r=target.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width}};
        const content=node.querySelector('.ba-chat-content'), toolbar=node.querySelector('.ba-message-toolbar');
        return {key:node.dataset.chatKey,role:node.dataset.role,body:rect(node.querySelector('.ba-chat-body')),content:rect(content),toolbar:rect(toolbar),feed:rect(node.closest('.ba-chat-feed')),buttons:[...toolbar.querySelectorAll('button')].map(button=>rect(button).width),color:getComputedStyle(content).color,background:getComputedStyle(content).backgroundColor};
      }));
      for(const row of measurements){
        if((containerWidth||width)<=700) {
          assert(row.toolbar.top>=row.content.bottom,`${scenario}: narrow containers keep controls below the full-width bubble`);
          if(['message:long','message:code'].includes(row.key)) assert(row.body.width>=300,`${scenario}: long replies retain at least 300px of reading width`);
        } else {
          assert(row.role==='user'?row.toolbar.right<=row.body.left:row.toolbar.left>=row.body.right,`${scenario}: ${row.role} toolbar must stay on its fixed side`);
          assert(row.toolbar.top<row.content.bottom&&row.toolbar.bottom>row.content.top,`${scenario}: wide containers keep tools beside the text`);
        }
        assert(row.toolbar.left>=row.feed.left&&row.toolbar.right<=row.feed.right,`${scenario}: toolbar outside chat container`);
        assert(row.buttons.every(size=>size>=32),`${scenario}: toolbar buttons must not shrink`);
        if(row.role==='user') {
          const luminance=color=>{const rgb=color.match(/[\d.]+/g).slice(0,3).map(Number).map(x=>x/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4);return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722};
          const a=luminance(row.color),b=luminance(row.background);
          assert((Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=4.5,`${scenario}: user text contrast`);
        }
      }
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no page overflow');
      assert(await page.locator('.ba-chat-feed').evaluate(node=>node.scrollWidth<=node.clientWidth),'no chat horizontal overflow');
      if((containerWidth||width)<=390) {
        const wideTable=page.locator('[data-chat-key="message:code"] .md-table-wide');
        assert(await wideTable.evaluate(node=>node.scrollWidth>node.clientWidth),'comparison tables scroll within the readable bubble');
        await wideTable.focus();
        assert.equal(await wideTable.evaluate(node=>getComputedStyle(node).overflowX),'scroll','the wide table remains keyboard scrollable');
        await page.locator('.ba-chat-feed').focus();
      }
      if((containerWidth||width)<=390) {
        assert.equal(await short.locator('.ba-message-time-label').evaluate(node=>getComputedStyle(node).display),'none','narrow chat uses the time icon even in a wide window');
        assert.notEqual(await short.locator('.ba-message-time-icon').evaluate(node=>getComputedStyle(node).display),'none','full timestamp remains accessible through the time icon');
        assert(await short.locator('time').getAttribute('aria-label'),'time icon has a full accessible timestamp');
      }
      const choice=page.locator('[data-chat-key="message:question:c1"]');
      assert.equal(await choice.getAttribute('data-role'),'user','answered choices sit on the user side');
      assert(await choice.getByText('用途 · 这台服务器主要用来做什么？',{exact:true}).count(),'question keeps its header');
      assert(await choice.getByText('网站、文件共享',{exact:true}).count(),'selected options are shown');
      assert(await choice.getByText('先保留观察',{exact:true}).count(),'custom answer is shown');
      assert(await choice.getByText('已跳过',{exact:true}).count(),'skipped question is explicit');
      const tone=await choice.evaluate(node=>[getComputedStyle(node.querySelector('.ba-chat-question-text')).color,getComputedStyle(node.querySelector('.ba-chat-question-answer')).color]);
      assert.notEqual(tone[0],tone[1],'question is muted relative to the answer');
      const delivery=page.locator('[data-chat-key="notification:delivery"]');
      assert.equal(await delivery.getAttribute('data-role'),'assistant','delivery is a normal assistant message');
      assert(await delivery.getByText('布局已调整，窄容器也保持侧边操作。',{exact:true}).count());
      assert(await delivery.getByRole('button',{name:'继续检查',exact:true}).count());
      assert.equal(await page.getByText('交付通知',{exact:true}).count(),0);
      assert.equal(await page.getByRole('button',{name:'标记已读',exact:true}).count(),0);
      const deliveryStyle=await delivery.evaluate(node=>{const s=getComputedStyle(node);return [s.borderTopWidth,s.borderRightWidth,s.borderBottomWidth,s.borderLeftWidth,s.backgroundColor]});
      assert.deepEqual(deliveryStyle,await page.locator('[data-chat-key="message:reply"]').evaluate(node=>{const s=getComputedStyle(node);return [s.borderTopWidth,s.borderRightWidth,s.borderBottomWidth,s.borderLeftWidth,s.backgroundColor]}),'delivery must not retain a separate card frame');
      const next=page.locator('[data-chat-key="message:reply"]');
      const nextBounds=await next.boundingBox(), shortBounds=await short.boundingBox();
      assert(nextBounds.y-(shortBounds.y+shortBounds.height)<=20,'messages must not retain the old blank toolbar row');
      await short.hover();
      await shot(page,`${dark?'dark':'light'}-${width}${containerWidth?'-container-'+containerWidth:''}`);
      const toolbarBounds=await short.locator('.ba-message-toolbar').boundingBox();
      await page.mouse.move(toolbarBounds.x+toolbarBounds.width/2,toolbarBounds.y+toolbarBounds.height/2,{steps:8});
      assert.equal(await short.locator('.ba-message-toolbar').evaluate(node=>getComputedStyle(node).opacity),'1','side tools remain reachable from the bubble');
      await short.getByRole('button',{name:'表情回应',exact:true}).click();
      const panel=page.locator('[data-action-panel]');
      await panel.waitFor();
      const bounds=await panel.boundingBox();
      assert(bounds.x>=0&&bounds.x+bounds.width<=width&&bounds.y>=0&&bounds.y+bounds.height<=1000,'popover remains in viewport');
      const triggerBounds=await short.getByRole('button',{name:'表情回应',exact:true}).boundingBox();
      assert(bounds.y>=triggerBounds.y+triggerBounds.height||bounds.y+bounds.height<=triggerBounds.y,'popover must not cover its trigger');
      if(width===390) await shot(page,`${dark?'dark':'light'}-reactions`);
      await page.keyboard.press('Escape');
      assert.equal(await short.getByRole('button',{name:'表情回应',exact:true}).evaluate(node=>node===document.activeElement),true,'Escape returns to the real trigger');
      await page.locator('.ba-chat-feed').focus();
      await page.locator('[data-chat-key="message:code"]').hover();
      if(width===390) await shot(page,`${dark?'dark':'light'}-wide-content`);
    }
    await page.locator('[data-chat-key="notification:delivery"]').getByRole('button',{name:'继续检查',exact:true}).click();
    assert.deepEqual(await page.evaluate(()=>window.apiCalls.filter(([name])=>name.startsWith('notification'))),[['notificationOption',{eventId:'delivery',threadId:'main',text:'继续检查'}]],'delivery options retain the validated reply endpoint without a read action');
    assert.equal(await page.getByRole('button',{name:'查看执行会话',exact:true}).count(),0);
    assert.equal(await page.getByLabel('任务等待状态',{exact:true}).count(),0);
    await shot(page,'dark-delivery');
    const reply=page.locator('[data-chat-key="message:reply"]');
    await reply.getByRole('button',{name:'本条回复用量',exact:true}).focus();
    assert.equal(await reply.locator('.ba-message-toolbar').evaluate(node=>getComputedStyle(node).opacity),'1','keyboard focus reveals toolbar');
    await page.keyboard.press('Enter');
    await page.locator('[data-action-panel]').waitFor();
    await shot(page,'dark-usage');
    await page.keyboard.press('Escape');
    assert.equal(await reply.getByRole('button',{name:'本条回复用量',exact:true}).evaluate(node=>node===document.activeElement),true,'usage Escape returns to usage trigger');
    await page.locator('.ba-chat-feed').focus(); await page.mouse.move(1,1);
    assert.equal(await reply.locator('.ba-reaction-chip').evaluate(node=>getComputedStyle(node).opacity),'1','saved reaction stays visible');
    await page.locator('.ba-official-conversation').evaluate(node=>node.style.removeProperty('width'));
    for(const dark of [false,true]) for(const width of [1440,390]) for(const state of ['empty','loading','error','home-completed','home-active','waiting','question']) {
      await page.setViewportSize({width,height:1000});
      await page.evaluate(({dark,state})=>{document.body.toggleAttribute('data-ds-dark-theme',dark);window.renderScenario(state)},{dark,state});
      await page.locator(state==='question'?'.ba-chat-await':state==='waiting'?'.ba-chat-work':state==='error'?'.ba-home-error':state==='loading'?'.ba-home-loading':'.ba-home-starters').waitFor();
      if(state==='home-active') await page.getByText('继续推进当前目标',{exact:true}).waitFor();
      if(state==='home-completed') await page.getByRole('button',{name:'查看任务记录',exact:true}).waitFor();
      await shot(page,`${dark?'dark':'light'}-${state}-${width}`);
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'four states fit the viewport');
      if(state.startsWith('home-')) {
        assert.equal(await page.getByRole('heading',{name:'最近完成',exact:true}).count(),0);
        assert.equal(await page.getByText('已完成的历史任务',{exact:true}).count(),0);
        assert.equal(await page.getByText('不应在首页展示的历史交付详情',{exact:true}).count(),0);
        assert.equal(await page.locator('.ba-home').getAttribute('data-has-work'),String(state==='home-active'));
        assert(await page.getByRole('navigation',{name:'开始一项工作'}).isVisible());
        if(state==='home-completed') {
          await page.getByRole('button',{name:'查看任务记录',exact:true}).click();
          assert.deepEqual(await page.evaluate(()=>window.resourceOpens),[['tasks']]);
        }
      }
      if(state==='error') assert(await page.getByRole('button',{name:'重试',exact:true}).isVisible());
      if(state==='question') { assert.equal(await page.locator('.ba-loading-dots').count(),0,'an open question card replaces the busy dots'); assert(await page.getByText('在下方选项卡中作答后继续',{exact:true}).isVisible()); }
    }
    const touch=await browser.newPage({viewport:{width:390,height:1000},hasTouch:true,isMobile:true,reducedMotion:'reduce'});
    await touch.setContent(html);
    await touch.locator('.ba-message-toolbar').first().waitFor();
    const targets=await touch.locator('.ba-message-toolbar button').evaluateAll(nodes=>nodes.map(node=>({width:node.getBoundingClientRect().width,height:node.getBoundingClientRect().height,opacity:getComputedStyle(node.parentElement).opacity})));
    assert(targets.every(node=>node.width>=44&&node.height>=44&&node.opacity==='1'),'touch targets are visible and 44px');
    const touchSides=await touch.locator('.ba-chat-message').evaluateAll(nodes=>nodes.map(node=>{const body=node.querySelector('.ba-chat-body').getBoundingClientRect(),tools=node.querySelector('.ba-message-toolbar').getBoundingClientRect();return {below:tools.top>=body.bottom,inside:tools.left>=0&&tools.right<=innerWidth}}));
    assert(touchSides.every(row=>row.below&&row.inside),'touch tools remain below readable bubbles without overflow');
    await shot(touch,'touch-390');
    assert.deepEqual(errors,[],'no browser runtime errors');
  } finally { await browser.close(); }
});
