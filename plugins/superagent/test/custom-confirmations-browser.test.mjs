import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import {sharedUiStyles} from '../../benchgo/scripts/shared-ui.mjs';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const require=createRequire(new URL('../../../deepseek-harness/apps/web/package.json',import.meta.url));
const {chromium}=require('playwright'),{build}=createRequire(new URL('../../benchgo/package.json',import.meta.url))('esbuild');
const executablePath=[chromium.executablePath(),'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
test('custom task confirmations retain drafts on cancel and require approval before deletion',{skip:!executablePath},async()=>{
 const bundle=await build({stdin:{resolveDir:root,loader:'jsx',contents:`
 import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
 import {TaskDetail,TaskListRow} from './plugins/superagent/client/task-list.jsx';
 import {Button} from './plugins/shared/client/ui/button.jsx';
 function App(){const [open,setOpen]=useState(false),[text,setText]=useState('保留这段草稿');window.calls=[];
 return <><button onClick={()=>setOpen(true)}>打开任务</button><TaskDetail open={open} title='编辑任务' dirty onClose={()=>setOpen(false)}><label>任务草稿<textarea value={text} onChange={event=>setText(event.target.value)}/></label></TaskDetail><TaskListRow api={async(...args)=>window.calls.push(args)} kind='task' row={{id:'one',taskCanOrganize:true,taskMeta:{version:3}}} title='已结束任务'/></>};createRoot(document.getElementById('root')).render(<App/>);
 `},bundle:true,write:false,format:'iife',jsx:'automatic',nodePaths:[join(root,'plugins/benchgo/node_modules'),join(root,'deepseek-harness/apps/web/node_modules')],alias:{react:dirname(require.resolve('react/package.json')),'react-dom':dirname(require.resolve('react-dom/package.json'))},loader:{'.css':'text','.svg':'text'},plugins:[sharedUiStyles()],define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
 const browser=await chromium.launch({headless:true,executablePath});
 try{const page=await browser.newPage();page.setDefaultTimeout(5000);const errors=[],nativeDialogs=[];page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>{nativeDialogs.push(dialog.message());void dialog.dismiss();});
 await page.setContent('<html><body><div id="root"></div></body></html>');await page.addScriptTag({content:bundle.outputFiles[0].text});
 for(const width of [1440,390]){
  await page.setViewportSize({width,height:900});await page.getByRole('button',{name:'打开任务',exact:true}).click();
  const detail=page.getByRole('dialog',{name:'编辑任务',exact:true});await detail.getByRole('textbox').fill('尚未保存的任务草稿');
  await page.keyboard.press('Escape');const discard=page.getByRole('dialog',{name:'放弃未保存的修改？',exact:true});await discard.waitFor();
  assert.equal(await discard.getByRole('button',{name:'继续编辑',exact:true}).evaluate(node=>node===document.activeElement),true,'the safe choice has initial focus');
  await discard.getByRole('button',{name:'继续编辑',exact:true}).click();assert.equal(await detail.getByRole('textbox').inputValue(),'尚未保存的任务草稿');
  await page.keyboard.press('Escape');await discard.getByRole('button',{name:'放弃并关闭',exact:true}).click();await detail.waitFor({state:'hidden'});
  await page.getByRole('button',{name:'删除',exact:true}).click();const remove=page.getByRole('dialog',{name:'删除“已结束任务”？',exact:true});await remove.waitFor();await page.keyboard.press('Escape');await remove.waitFor({state:'hidden'});assert.equal((await page.evaluate(()=>window.calls)).length,0);
  await page.getByRole('button',{name:'删除',exact:true}).click();await remove.getByRole('button',{name:'删除',exact:true}).click();await page.waitForFunction(()=>window.calls.length===1);
  assert.deepEqual(await page.evaluate(()=>window.calls[0]),['taskUpdate',{kind:'task',id:'one',operation:'delete',version:3}]);await page.evaluate(()=>window.calls=[]);
 }
 assert.deepEqual(errors,[]);assert.deepEqual(nativeDialogs,[]);
 }finally{await browser.close();}
});
