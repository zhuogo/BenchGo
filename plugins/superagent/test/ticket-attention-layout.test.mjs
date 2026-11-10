import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sharedUiStyles } from '../../benchgo/scripts/shared-ui.mjs';
import { officialUiEntries, officialUiLoaders } from '../../link/scripts/official-ui.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const webRequire = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
const { chromium } = webRequire('playwright');
const { build } = createRequire(new URL('../../benchgo/package.json', import.meta.url))('esbuild');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || [chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const captureDir = process.env.BENCHGO_QUESTION_SCREENSHOTS;

// Real component, shared controls and official theme; only ticket data/API are fixtures.
async function fixture() {
  const result = await build({
    stdin: { resolveDir: root, loader: 'jsx', contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {TicketAttention} from './plugins/superagent/client/ticket-attention.jsx';
      import hostCss from './plugins/benchgo/client/style.css';
      const root=createRoot(document.getElementById('root'));let serial=0;
      window.renderScenario=(mode='single')=>{
        window.apiCalls=[];window.answerRefreshes=0;
        window.control={hold:mode==='busy',failures:mode==='error'?1:0};
        const ticket={id:'original-ticket',status:mode==='closed'?'completed':'waiting',instructionRevision:7,
          mandate:{source:{channel:mode==='external'?'email':'desktop'}}};
        const question={question:mode==='free'?'你希望接下来怎样处理？':'这次先处理哪个范围？',
          detail:'按你的选择继续；补充说明可以稍后填写。',multiSelect:mode==='multi',
          options:mode==='free'?[]:[{label:'A',description:'先整理已有资料，保留当前范围。'},{label:'B',description:'同时核对关键来源，并补齐缺失内容。'}]};
        const attention={id:'question-one',state:mode==='answered'?'answered':'waiting',instructionRevision:mode==='stale'?6:7,resultVersion:2,question};
        const api=async(name,input)=>{
          window.apiCalls.push([name,input]);
          if(window.control.hold)await new Promise(resolve=>window.finishAnswer=resolve);
          if(window.control.failures-->0)throw Error('连接暂时中断，已保留你的选择和补充说明。');
          return {attention:{...attention,state:'answered'}};
        };
        root.render(<main key={++serial} className='ba-root'><style>{hostCss}</style><TicketAttention api={api} ticket={ticket} attention={attention} onAnswered={()=>{window.answerRefreshes++;if(mode==='refresh-error')throw Error('会话更新暂时不可用');}}/></main>);
      };
      window.renderScenario();
    ` },
    bundle:true,write:false,outdir:join(root,'artifacts','unused-question-test-output'),format:'iife',jsx:'automatic',
    nodePaths:[join(root,'plugins/benchgo/node_modules'),join(root,'deepseek-harness/apps/web/node_modules')],
    alias:{...await officialUiEntries(),react:dirname(webRequire.resolve('react/package.json')),'react-dom':dirname(webRequire.resolve('react-dom/package.json'))},
    loader:{...officialUiLoaders,'.css':'text','.svg':'text'},plugins:[sharedUiStyles()],define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent',
  });
  const themeRoot=join(root,'deepseek-harness/packages/client/ui-theme/src/styles');
  const theme=(await Promise.all(['base.css','design-platform.css','focus.css'].map(name=>readFile(join(themeRoot,name),'utf8')))).join('\n');
  const css=result.outputFiles.filter(file=>file.path.endsWith('.css')).map(file=>file.text).join('\n');
  const js=result.outputFiles.find(file=>file.path.endsWith('.js')).text.replaceAll('</script','<\\/script');
  return `<!doctype html><html lang='zh-CN'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>BenchGo 提问卡交互验证</title><style>${theme}${css}
    body{margin:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:14px/1.6 var(--dsw-font-family)}
    .ba-root{box-sizing:border-box;width:100%;max-width:720px;margin:48px auto;padding:0 20px;min-width:0}
    @media(max-width:480px){.ba-root{margin:20px auto;padding:0 12px}}
  </style></head><body><div id='root'></div><script>${js}</script></body></html>`;
}

test('question cards remain compact, accessible and version-bound across themes and widths', {skip:!executablePath&&'Chromium/Edge is required'}, async()=>{
  const html=await fixture();
  if(captureDir){await mkdir(captureDir,{recursive:true});await writeFile(join(captureDir,'index.html'),html);}
  const browser=await chromium.launch({headless:true,executablePath});
  try {
    const page=await browser.newPage({reducedMotion:'reduce'}),errors=[];
    page.setDefaultTimeout(6000);page.on('pageerror',error=>errors.push(error.message));
    await page.route('http://localhost/',route=>route.fulfill({contentType:'text/html',body:html}));
    await page.goto('http://localhost/');
    const card=page.getByLabel('工单问题',{exact:true});
    const button=name=>page.getByRole('button',{name,exact:true});
    const scenario=async mode=>{await page.evaluate(mode=>window.renderScenario(mode),mode);await card.waitFor();await page.evaluate(()=>document.fonts.ready);};
    const capture=async name=>{
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      if(captureDir)await page.screenshot({path:join(captureDir,name+'.png'),fullPage:true,animations:'disabled'});
    };
    const fits=async name=>{
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${name}: no page overflow`);
      assert(await card.evaluate(node=>node.scrollWidth<=node.clientWidth),`${name}: no card overflow`);
      for(const row of await card.locator('.ba-attention-option').all())assert((await row.boundingBox()).height>=44,`${name}: option touch target`);
    };
    const supplementVisible=async name=>{
      // Wait for the real Disclosure to finish opening, independently of optional screenshots.
      // A permanently clipped input still fails the same complete-visibility requirement.
      await page.waitForFunction(()=>{
        const node=document.querySelector('.ba-attention-supplement textarea');
        if(!node)return false;
        const input=node.getBoundingClientRect(),panel=node.closest('.bg-ui-disclosure-content').getBoundingClientRect();
        return input.width>0&&input.height>0&&input.top>=panel.top&&input.bottom<=panel.bottom;
      },undefined,{timeout:2000});
      assert(await page.getByRole('textbox').evaluate(node=>{
        const input=node.getBoundingClientRect(),panel=node.closest('.bg-ui-disclosure-content').getBoundingClientRect();
        return input.top>=panel.top&&input.bottom<=panel.bottom;
      }),`${name}: expanded supplementary input is fully visible`);
    };
    for(const dark of [false,true])for(const width of [1440,390]){
      await page.setViewportSize({width,height:900});
      await page.evaluate(dark=>document.body.toggleAttribute('data-ds-dark-theme',dark),dark);
      const key=`${dark?'dark':'light'}-${width}`;
      await scenario('single');
      assert.equal(await page.getByRole('radio',{checked:true}).count(),0,'no default choice');
      assert(await button('提交答复').isDisabled());
      assert.equal(await page.getByRole('textbox').count(),0,'optional input starts collapsed');
      await fits(key);await capture(`${key}-unselected`);
      await page.keyboard.press('Tab');
      await page.getByRole('radio',{name:'A',exact:true}).focus();
      assert.equal(await page.locator('.ba-attention-option').first().evaluate(node=>getComputedStyle(node).outlineStyle),'solid','keyboard focus is visible');
      await page.keyboard.press('ArrowRight');
      assert(await page.getByRole('radio',{name:'B',exact:true}).isChecked(),'native arrow navigation selects B');
      assert.equal(await page.locator('.ba-attention-option[data-selected=true]').count(),1);
      await capture(`${key}-keyboard-focus`);
      await page.mouse.click(2,2);
      await capture(`${key}-selected-B`);
      await button('补充说明').click();
      await page.getByRole('textbox',{name:'补充内容',exact:true}).fill('  请保留来源链接  ');
      await button('补充说明 · 已填写').click();
      await page.getByRole('textbox').waitFor({state:'hidden'});
      await button('补充说明 · 已填写').click();
      assert.equal(await page.getByRole('textbox').inputValue(),'  请保留来源链接  ','collapse preserves draft');
      await supplementVisible(`${key}-reduce`);
      assert.equal(await card.locator('.bg-ui-disclosure-content').evaluate(node=>getComputedStyle(node).animationName),'none','reduced motion disables the actual Disclosure animation');
      await capture(`${key}-supplement`);
      await button('补充说明 · 已填写').click();await page.getByRole('textbox').waitFor({state:'hidden'});
      await page.emulateMedia({reducedMotion:'no-preference'});
      await button('补充说明 · 已填写').click();
      await supplementVisible(`${key}-normal-motion`);
      assert.equal(await page.getByRole('textbox').inputValue(),'  请保留来源链接  ','normal-motion reopening retains the same draft');
      await capture(`${key}-supplement-motion`);
      await page.emulateMedia({reducedMotion:'reduce'});
      await button('补充说明 · 已填写').click();
      await button('提交答复').click();
      await page.getByText('答复已保存 · 原工单继续处理',{exact:true}).waitFor();
      const call=await page.evaluate(()=>window.apiCalls[0]);
      assert.equal(call[0],'ticketAnswer');
      assert.equal(call[1].ticketId,'original-ticket');assert.equal(call[1].attentionId,'question-one');
      assert.equal(call[1].instructionRevision,7);assert(call[1].requestId);
      assert.deepEqual(call[1].answer,{selected:['B'],custom:'请保留来源链接'});
      assert.equal(await page.evaluate(()=>window.answerRefreshes),1);
      assert.equal(await page.getByRole('button').count(),0,'saved answers cannot be submitted again');
      await capture(`${key}-answered`);

      await scenario('multi');
      assert.equal(await page.getByRole('checkbox',{checked:true}).count(),0);
      await page.getByRole('checkbox',{name:'A',exact:true}).check();
      await page.getByRole('checkbox',{name:'B',exact:true}).focus();await page.keyboard.press('Space');
      assert.equal(await page.getByRole('checkbox',{checked:true}).count(),2,'multiselect works by keyboard');
      await fits(`${key}-multi`);await capture(`${key}-multi`);
      await button('提交答复').click();await page.getByText('答复已保存 · 原工单继续处理',{exact:true}).waitFor();
      assert.deepEqual(await page.evaluate(()=>window.apiCalls[0][1].answer),{selected:['A','B']});

      await scenario('free');
      await page.getByRole('textbox',{name:'你的答复',exact:true}).fill('  先整理资料，再和我确认下一步。  ');
      assert.equal(await button('补充说明').count(),0);
      await fits(`${key}-free`);await capture(`${key}-free`);
      await button('提交答复').click();await page.getByText('答复已保存 · 原工单继续处理',{exact:true}).waitFor();
      assert.deepEqual(await page.evaluate(()=>window.apiCalls[0][1].answer),{selected:[],custom:'先整理资料，再和我确认下一步。'});

      await scenario('busy');await page.getByRole('radio',{name:'B',exact:true}).check();await button('提交答复').click();
      await button('提交中…').waitFor();assert(await button('提交中…').isDisabled());
      assert(await page.getByRole('radio',{name:'B',exact:true}).isDisabled());
      assert.equal(await card.locator('form').getAttribute('aria-busy'),'true');
      await capture(`${key}-busy`);
      await page.evaluate(()=>window.finishAnswer());await page.getByText('答复已保存 · 原工单继续处理',{exact:true}).waitFor();
      assert.equal(await page.evaluate(()=>window.apiCalls.length),1,'pending request submits once');

      await scenario('error');await page.getByRole('radio',{name:'B',exact:true}).check();await button('提交答复').click();
      await page.getByRole('alert').getByText('答复未提交，请重试',{exact:true}).waitFor();
      assert(await page.getByRole('radio',{name:'B',exact:true}).isChecked());
      await fits(`${key}-error`);await capture(`${key}-error-retry`);
      await button('重试提交').click();await page.getByText('答复已保存 · 原工单继续处理',{exact:true}).waitFor();
      const retries=await page.evaluate(()=>window.apiCalls);
      assert.equal(retries.length,2);assert.deepEqual(retries[0],retries[1],'retry retains idempotency key and exact answer');
      await capture(`${key}-retry-saved`);

      await scenario('stale');await page.getByText('旧版本的问题 · 已失效',{exact:true}).waitFor();
      assert.equal(await page.getByRole('button').count(),0);assert.equal(await page.getByRole('radio').count(),0);
      await fits(`${key}-stale`);await capture(`${key}-stale`);
      await scenario('closed');await page.getByText('工单已结束',{exact:true}).waitFor();
      assert.equal(await page.getByRole('button').count(),0);await capture(`${key}-closed`);
    }
    await scenario('external');await page.getByText('请在原会话中回复这条问题。',{exact:true}).waitFor();
    assert.equal(await page.getByRole('button').count(),0,'authorization remains desktop-only');
    await scenario('refresh-error');await page.getByRole('radio',{name:'B',exact:true}).check();await button('提交答复').click();
    await page.getByText('答复已保存 · 原工单继续处理',{exact:true}).waitFor();
    await page.getByRole('alert').getByText('答复已保存，但显示暂未更新：会话更新暂时不可用',{exact:true}).waitFor();
    assert.equal(await page.getByRole('button').count(),0,'a display refresh failure cannot resubmit the saved answer');
    assert.deepEqual(errors,[],'no browser runtime errors');
  }finally{await browser.close();}
});
