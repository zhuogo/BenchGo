// Headless component integration QA. Only the host Markdown primitive is stubbed;
// interactive components, shared buttons, CSS, validation and retries are real.
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { build } from '../../benchgo/node_modules/esbuild/lib/main.js';
import { sharedUiStyles } from '../../benchgo/scripts/shared-ui.mjs';
import { chromium } from '../../../deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const temp = await mkdtemp(join(tmpdir(),'benchgo-interactive-'));
const artifact = join(root,'artifacts','interactive-qa'); await mkdir(artifact,{recursive:true});
const fixture = `import React from 'react'; import { createRoot } from 'react-dom/client'; import { InteractiveReply } from './plugins/interactive/client/reply.jsx';
const data={version:1,title:'项目需求',blocks:[{id:'form',type:'form',title:'确认需求',fields:[{id:'project',type:'text',label:'项目名称',required:true},{id:'count',type:'number',label:'数量',min:1,max:10,required:true},{id:'platform',type:'select',label:'平台',required:true,options:[{label:'桌面',value:'desktop'},{label:'手机',value:'mobile'}]}]},{id:'choice',type:'choices',title:'下一步',options:[{label:'先看方案',value:'plan'},{label:'开始执行',value:'run'}]},{id:'chart',type:'chart',title:'真实样例数据',kind:'bar',unit:'次',data:[{label:'周一',value:0},{label:'周二',value:4},{label:'周三',value:-2}]},{id:'table',type:'table',columns:['名称','数量'],rows:[['已完成',4],['待确认',null]]}]};
const fence=v=>'\x60\x60\x60benchgo-ui\\n'+JSON.stringify(v)+'\\n\x60\x60\x60';
window.sent=[];window.attempts=0;
const send=async(text,request)=>{window.attempts++;await new Promise(r=>setTimeout(r,80));if(window.attempts===1)throw Error('测试连接中断');window.sent.push(text)};
const display=createRoot(document.getElementById('app'));
window.draw=(mode='data')=>display.render(<main style={{maxWidth:760,margin:'24px auto',padding:'0 16px'}}><h1 style={{fontSize:20}}>BenchGo · 交互回复</h1><InteractiveReply key={mode} text={mode==='data'?'这里是需求确认表。\\n'+fence(data):mode==='empty'?fence({version:1,blocks:[]}):mode==='loading'?'\x60\x60\x60benchgo-ui\\n{':fence({version:1,blocks:[{type:'unknown'}]})} streaming={mode==='loading'} onSubmit={send}/></main>); window.draw();`;
let browser,server;
try {
  await build({stdin:{contents:fixture,resolveDir:root,loader:'jsx'},outfile:join(temp,'app.js'),bundle:true,platform:'browser',format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},nodePaths:[join(root,'plugins/benchgo/node_modules')],alias:{react:join(root,'deepseek-harness/node_modules/.pnpm/react@18.3.1/node_modules/react'),'react-dom':join(root,'deepseek-harness/node_modules/.pnpm/react-dom@18.3.1_react@18.3.1/node_modules/react-dom')},loader:{'.css':'text'},plugins:[{name:'host-markdown',setup(b){b.onResolve({filter:/^@deepseek-ai\/dsh-client-ui-primitives$/},()=>({path:'host-markdown',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:"import React from 'react'; export const MarkdownText=({text})=>React.createElement('div',{'data-markdown':''},text);",loader:'js',resolveDir:root}))}},sharedUiStyles()]});
  server=createServer(async(req,res)=>{res.setHeader('content-type',req.url==='/app.js'?'text/javascript':'text/html; charset=utf-8');res.end(req.url==='/app.js'?await readFile(join(temp,'app.js')):'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0;font-family:Arial,"Microsoft YaHei",sans-serif;color:#202124;background:#fff}body[data-ds-dark-theme]{background:#19191b;color:#ededee}</style><div id="app"></div><script src="/app.js"></script>')});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);await page.getByLabel('项目名称').fill('BenchGo');await page.getByLabel('数量').fill('3');await page.getByLabel('平台').selectOption('desktop');
  await page.getByRole('button',{name:'发送答复',exact:true}).click();await page.getByRole('alert').filter({hasText:'测试连接中断'}).waitFor();assert.equal(await page.getByLabel('项目名称').inputValue(),'BenchGo');
  await page.getByRole('button',{name:'发送答复',exact:true}).click();await page.getByText('已发送答复',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.sent.length),1);assert.match(await page.evaluate(()=>window.sent[0]),/"count":3/);
  await page.getByRole('button',{name:'先看方案',exact:true}).click();await page.getByText('已发送：先看方案').waitFor();assert.equal(await page.evaluate(()=>window.sent.length),2);
  await page.screenshot({path:join(artifact,'data-desktop.png'),fullPage:true});
  for(const mode of ['empty','loading','error']){await page.evaluate(mode=>window.draw(mode),mode);await page.locator('[data-state='+mode+']').waitFor();await page.screenshot({path:join(artifact,mode+'.png'),fullPage:true});}
  await page.evaluate(()=>window.draw('data'));await page.getByLabel('项目名称').waitFor();await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(artifact,'data-mobile.png'),fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.evaluate(()=>document.body.setAttribute('data-ds-dark-theme',''));await page.screenshot({path:join(artifact,'data-dark.png'),fullPage:true,animations:'disabled'});assert.deepEqual(errors,[]);console.log('Interactive browser QA passed: four states, form validation, failed-send retry, choice reply, mobile and dark mode.');
} finally {await browser?.close();if(server)await new Promise(r=>server.close(r));if(relative(tmpdir(),temp).startsWith('..'))throw Error('Unexpected temporary directory');await rm(temp,{recursive:true,force:true});}
