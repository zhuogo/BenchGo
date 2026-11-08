import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadChannelModules, channelDefinition, channelIds } from '../src/channel-catalog.mjs';
import { sharedUiStyles } from '../../benchgo/scripts/shared-ui.mjs';

const require = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
const { chromium } = require('playwright');
const { build } = createRequire(new URL('../../benchgo/package.json', import.meta.url))('esbuild');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || (existsSync(chromium.executablePath()) ? chromium.executablePath() : 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe');
const output = fileURLToPath(new URL('../../../artifacts/channels-fusion/', import.meta.url));

test('Slack and DingTalk real connection forms render four states and preserve save/reload semantics', { skip: !existsSync(executablePath) }, async () => {
  await loadChannelModules();
  const catalog = channelIds.map(channelDefinition);
  const reactRequire = createRequire(new URL('../../../deepseek-harness/packages/client/ui-renderer/package.json', import.meta.url));
  const bundle = await build({ stdin: { contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {Connections} from './connections.jsx'; import css from './style.css'; import shellCss from '../../benchgo/client/style.css';
    const style=document.createElement('style');style.textContent=shellCss+css;document.head.append(style);
    const catalog=${JSON.stringify(catalog)};
    const configs=Object.fromEntries(catalog.map(d=>[d.id,{...d.defaults}]));
    configs.slack={...configs.slack,enabled:true,accountId:'Team:Opaque',botTokenRef:'ref:bot',appTokenRef:'ref:app',ownerIds:['User:Owner']};
    configs.dingtalk={...configs.dingtalk,enabled:true,appId:'App:Opaque',appSecretRef:'ref:secret',robotCode:'Robot:Opaque',ownerIds:['Staff:Owner']};
    let revision=1;window.calls=[];
    const state=channel=>{const c=window.mode==='empty'&&channel===window.target?catalog.find(d=>d.id===channel).defaults:configs[channel];return {enabled:c.enabled,authentication:c.enabled?'verified':'unverified',events:'unverified',sending:'unverified',connection:{state:c.enabled?'connected':'disabled'}};};
    async function api(action,input={}){
      window.calls.push({action,input});const channel=input.channel||'feishu';
      if(action==='connectionCatalog')return {channels:catalog.map(d=>({...d,status:state(d.id)}))};
      if(action==='connections'){
        if(channel===window.target&&window.mode==='loading')return new Promise(()=>{});
        if(channel===window.target&&window.mode==='error')throw Error('连接配置暂时不可用');
        return {channel,revision,config:window.mode==='empty'&&channel===window.target?catalog.find(d=>d.id===channel).defaults:configs[channel]};
      }
      if(action==='connectionStatus')return state(channel);
      if(action==='connectionConfigure'){configs[channel]={...configs[channel],...input.patch};revision++;return {channel,revision,config:configs[channel]};}
      if(action==='connectionVerify')return state(channel);
      if(action==='connectionCredential')return {ref:'encrypted:new-ref'};
    }
    createRoot(document.getElementById('app')).render(<Connections api={api}/>);
  `, resolveDir: fileURLToPath(new URL('../client/', import.meta.url)), loader: 'jsx' },
    bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
    nodePaths: [fileURLToPath(new URL('../../benchgo/node_modules/', import.meta.url))],
    alias: { react: dirname(reactRequire.resolve('react/package.json')), 'react-dom': dirname(reactRequire.resolve('react-dom/package.json')) },
    loader: { '.css': 'text', '.svg': 'text' }, plugins: [sharedUiStyles()], logLevel: 'silent',
  });
  const browser = await chromium.launch({ headless: true, executablePath });
  await mkdir(output, { recursive: true });
  try {
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    async function open(target, mode, width) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('about:blank');
      await page.setContent('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0;padding:20px;font-family:Arial,sans-serif;color:#242424;box-sizing:border-box}#app{max-width:1080px;margin:auto;height:auto}.ba-root{height:auto!important;min-width:0}</style></head><body><div id="app" class="ba-root"></div></body></html>');
      await page.evaluate(({target,mode}) => { window.target=target;window.mode=mode; }, {target,mode});
      await page.addScriptTag({content:bundle.outputFiles[0].text});
      await page.getByRole('tab', {name:target==='slack'?'Slack':'钉钉',exact:true}).click();
    }
    for (const target of ['slack','dingtalk']) {
      for (const width of [1440,768,390]) {
        for (const mode of ['empty','loading','error','data']) {
          await open(target,mode,width);
          if(mode==='loading')await page.getByText('正在读取连接配置',{exact:true}).waitFor();
          else if(mode==='error')await page.getByRole('alert').filter({hasText:'连接配置暂时不可用'}).waitFor();
          else await page.getByLabel(target==='slack'?'工作区 ID':'Client ID / AppKey',{exact:false}).waitFor();
          assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${target}/${mode}/${width} overflow`);
          await page.screenshot({path:join(output,`${target}-${mode}-${width}.png`),fullPage:true});
        }
      }
      await open(target,'data',1440);
      const field=page.getByLabel(target==='slack'?'工作区 ID':'Robot Code',{exact:false});
      await field.fill('Changed:Case/X');
      await page.getByRole('button',{name:'保存更改',exact:true}).click();
      await page.getByText('已保存',{exact:true}).waitFor();
      const save=await page.evaluate(()=>window.calls.find(c=>c.action==='connectionConfigure'));
      assert.deepEqual(save.input.patch,target==='slack'?{accountId:'Changed:Case/X'}:{robotCode:'Changed:Case/X'});
      await page.getByRole('button',{name:'重新加载',exact:true}).click();
      await page.waitForFunction(()=>!document.querySelector('[role=tabpanel]')?.getAttribute('aria-busy')||document.querySelector('[role=tabpanel]').getAttribute('aria-busy')==='false');
      assert.equal(await field.inputValue(),'Changed:Case/X');
      assert.equal(await page.locator('input[type=password]').first().getAttribute('placeholder'),'已配置，留空保持不变');
      await page.getByRole('button',{name:'验证连接',exact:true}).click();
      await page.getByText('验证完成；认证、接收和发送状态分别显示，实际收发请在原渠道确认。',{exact:true}).waitFor();
    }
    assert.deepEqual(errors,[]);
  } finally {await browser.close();}
});
