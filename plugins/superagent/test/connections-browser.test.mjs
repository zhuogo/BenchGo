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

test('Feishu, Slack and DingTalk render four states and preserve verified availability and save/reload semantics', { skip: !existsSync(executablePath) }, async () => {
  await loadChannelModules();
  const catalog = channelIds.map(channelDefinition);
  const reactRequire = createRequire(new URL('../../../deepseek-harness/packages/client/ui-renderer/package.json', import.meta.url));
  const bundle = await build({ stdin: { contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {Connections} from './connections.jsx'; import css from './style.css'; import shellCss from '../../benchgo/client/style.css';
    const style=document.createElement('style');style.textContent=shellCss+css;document.head.append(style);
    const catalog=${JSON.stringify(catalog)};
    const configs=Object.fromEntries(catalog.map(d=>[d.id,{...d.defaults}]));
    configs.feishu={...configs.feishu,enabled:true,appId:'App:Feishu',appSecretRef:'ref:feishu',accessMode:'platform',groups:[]};
    configs.slack={...configs.slack,enabled:true,accountId:'Team:Opaque',botTokenRef:'ref:bot',appTokenRef:'ref:app',ownerIds:['User:Owner']};
    configs.dingtalk={...configs.dingtalk,enabled:true,appId:'App:Opaque',appSecretRef:'ref:secret',robotCode:'Robot:Opaque',ownerIds:['Staff:Owner']};
    let revision=1;window.calls=[];
    const state=channel=>{const c=window.mode==='empty'&&channel===window.target?catalog.find(d=>d.id===channel).defaults:configs[channel];return {enabled:c.enabled,authentication:c.enabled&&channel!=='feishu'?'verified':'unverified',events:'unverified',sending:'unverified',connection:{state:c.enabled?'connected':'disabled',...(channel==='feishu'?{authenticated:c.enabled}: {})}};};
    window.syncSignals=[];window.pendingSync=[];
    async function api(action,input={},signal){
      window.calls.push({action,input});const channel=input.channel||'feishu';
      if(action==='connectionCatalog'){
        window.syncSignals.push(signal);
        if(window.syncFailure)throw Error('状态服务暂不可用');
        if(window.deferSync)return new Promise(resolve=>window.pendingSync.push(()=>resolve({channels:catalog.map(d=>({...d,status:{enabled:false,connection:{state:'disabled'}}}))})));
        return {channels:catalog.map(d=>({...d,status:state(d.id)}))};
      }
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
    const root=createRoot(document.getElementById('app'));
    window.setConnectionsActive=active=>root.render(<Connections api={api} active={active}/>);
    window.setConnectionsActive(true);
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
    await page.emulateMedia({reducedMotion:'reduce'});
    page.on('pageerror', error => errors.push(error.message));
    async function open(target, mode, width) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('about:blank');
      await page.setContent('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0;padding:20px;font-family:Arial,sans-serif;color:#242424;box-sizing:border-box}#app{max-width:1080px;margin:auto;height:auto}.ba-root{height:auto!important;min-width:0}</style></head><body><div id="app" class="ba-root"></div></body></html>');
      await page.evaluate(({target,mode}) => { window.target=target;window.mode=mode; }, {target,mode});
      await page.addScriptTag({content:bundle.outputFiles[0].text});
      if(target!=='feishu')await page.getByRole('tab', {name:target==='slack'?'Slack':'钉钉',exact:true}).click();
    }
    for (const target of ['feishu','slack','dingtalk']) {
      for (const width of [1440,768,390]) {
        for (const mode of ['empty','loading','error','data']) {
          await open(target,mode,width);
          if(mode==='loading')await page.getByText('正在读取连接配置',{exact:true}).waitFor();
          else if(mode==='error')await page.getByRole('alert').filter({hasText:'连接配置暂时不可用'}).waitFor();
          else await page.getByLabel(target==='feishu'?'App ID':target==='slack'?'工作区 ID':'Client ID / AppKey',{exact:false}).waitFor();
          assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${target}/${mode}/${width} overflow`);
          await page.screenshot({path:join(output,`${target}-${mode}-${width}.png`),fullPage:true});
        }
      }
      await open(target,'data',1440);
      const field=page.getByLabel(target==='feishu'?'App ID':target==='slack'?'工作区 ID':'Robot Code',{exact:false});
      await field.waitFor();
      if(target==='feishu'){
        const brand=page.getByRole('tab',{name:'飞书',exact:true}).locator('[data-available]');
        assert.equal(await brand.getAttribute('data-available'),'true');
        assert.equal(await brand.evaluate(node=>getComputedStyle(node).filter),'none');
        assert.equal(await page.locator('.ba-channel-status').getAttribute('data-tone'),'success');
        assert.equal(await page.locator('.ba-channel-status .ba-connection-dot').evaluate(node=>getComputedStyle(node).backgroundColor),await page.locator('.ba-channel-status').evaluate(node=>getComputedStyle(node).color));
        assert.deepEqual(await page.locator('.ba-connection-check').evaluateAll(nodes=>nodes.map(node=>node.dataset.tone)),['success','neutral','neutral']);
        await page.getByRole('tab',{name:'Slack',exact:true}).click();
        await page.getByLabel('工作区 ID',{exact:false}).waitFor();
        assert.equal(await brand.getAttribute('data-available'),'true');
        assert.equal(await brand.evaluate(node=>getComputedStyle(node).filter),'none');
        await page.getByRole('tab',{name:'飞书',exact:true}).click();
        await field.waitFor();
      }
      await field.fill('Changed:Case/X');
      await page.getByRole('button',{name:'保存更改',exact:true}).click();
      await page.getByText('已保存',{exact:true}).waitFor();
      const save=await page.evaluate(()=>window.calls.find(c=>c.action==='connectionConfigure'));
      assert.deepEqual(save.input.patch,target==='feishu'?{appId:'Changed:Case/X'}:target==='slack'?{accountId:'Changed:Case/X'}:{robotCode:'Changed:Case/X'});
      await page.getByRole('button',{name:'重新加载',exact:true}).click();
      await page.waitForFunction(()=>!document.querySelector('[role=tabpanel]')?.getAttribute('aria-busy')||document.querySelector('[role=tabpanel]').getAttribute('aria-busy')==='false');
      assert.equal(await field.inputValue(),'Changed:Case/X');
      assert.equal(await page.locator('input[type=password]').first().getAttribute('placeholder'),'已配置，留空保持不变');
      await page.getByRole('button',{name:'验证连接',exact:true}).click();
      await page.getByText('验证完成；认证、接收和发送状态分别显示，实际收发请在原渠道确认。',{exact:true}).waitFor();
    }
    await open('feishu','data',1440);
    const appId=page.getByLabel('App ID',{exact:false});
    await appId.fill('Unsaved:App/ID');
    await page.evaluate(()=>window.setConnectionsActive(false));
    await page.waitForFunction(()=>window.syncSignals.at(-1)?.aborted);
    const inactiveCalls=await page.evaluate(()=>window.calls.length);
    await page.waitForTimeout(5100);
    assert.equal(await page.evaluate(()=>window.calls.length),inactiveCalls,'hidden resource must stop polling');
    await page.evaluate(()=>{window.syncFailure=true;window.setConnectionsActive(true);});
    await page.locator('.ba-connection-sync').getByText('同步失败，稍后自动重试',{exact:true}).waitFor();
    assert.equal(await appId.inputValue(),'Unsaved:App/ID');
    assert.equal(await page.locator('.ba-channel-status').innerText(),'状态待确认');
    assert.equal(await page.getByRole('tab',{name:'飞书',exact:true}).locator('[data-available]').getAttribute('data-available'),'false');
    assert.match(await page.locator('.ba-connection-sync').innerText(),/上次同步/);
    await page.screenshot({path:join(output,'feishu-stale-draft-1440.png'),fullPage:true,animations:'disabled'});
    await page.evaluate(()=>{window.syncFailure=false;});
    await page.getByRole('button',{name:'同步状态',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.ba-channel-status')?.dataset.tone==='success');
    assert.equal(await appId.inputValue(),'Unsaved:App/ID');
    await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'));});
    await page.waitForFunction(()=>window.syncSignals.at(-1)?.aborted);
    const backgroundCalls=await page.evaluate(()=>window.calls.length);
    await page.waitForTimeout(5100);
    assert.equal(await page.evaluate(()=>window.calls.length),backgroundCalls,'background tab must stop polling');
    await page.evaluate(()=>{window.deferSync=true;Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});document.dispatchEvent(new Event('visibilitychange'));});
    await page.waitForFunction(()=>window.pendingSync.length===1);
    await page.evaluate(()=>window.setConnectionsActive(false));
    await page.waitForFunction(()=>window.syncSignals.at(-1)?.aborted);
    await page.evaluate(()=>{window.pendingSync.shift()();});
    assert.equal(await appId.inputValue(),'Unsaved:App/ID');
    await page.evaluate(()=>{window.deferSync=false;window.setConnectionsActive(true);});
    await page.waitForFunction(()=>document.querySelector('.ba-channel-status')?.dataset.tone==='success');
    assert.equal(await appId.inputValue(),'Unsaved:App/ID');
    assert.equal(await page.getByRole('tab',{name:'飞书',exact:true}).locator('[data-available]').getAttribute('data-available'),'true');
    await page.setViewportSize({width:390,height:900});
    await page.addStyleTag({content:'body{--dsw-alias-label-primary:#ededee;--dsw-alias-label-secondary:#a3a3a8;--dsw-alias-bg-base:#19191b;background:#19191b;color:#ededee}'});
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'dark mobile sync row overflow');
    await page.screenshot({path:join(output,'feishu-resumed-dark-390.png'),fullPage:true,animations:'disabled'});
    assert.deepEqual(errors,[]);
  } finally {await browser.close();}
});
