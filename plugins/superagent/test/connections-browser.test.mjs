import { officialTooltipSource } from '../../base/test/official-tooltip-source.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadChannelModules, channelDefinition, channelIds } from '../src/channel-catalog.mjs';
import { sharedUiStyles } from '../../base/scripts/shared-ui.mjs';

const require = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
const { chromium } = require('playwright');
const { build } = createRequire(new URL('../../base/package.json', import.meta.url))('esbuild');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || (existsSync(chromium.executablePath()) ? chromium.executablePath() : 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe');
const output = fileURLToPath(new URL('../../../artifacts/channels-fusion/', import.meta.url));

test('Feishu, Slack and DingTalk render four states and preserve verified availability and save/reload semantics', { skip: !existsSync(executablePath) }, async () => {
  await loadChannelModules();
  const catalog = channelIds.map(channelDefinition);
  const reactRequire = createRequire(new URL('../../../deepseek-harness/packages/client/ui-renderer/package.json', import.meta.url));
  const bundle = await build({ stdin: { contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {Connections} from './connections.jsx'; import css from './style.css'; import shellCss from '../../base/client/style.css';
    const style=document.createElement('style');style.textContent=shellCss+css;document.head.append(style);
    const catalog=${JSON.stringify(catalog)};
    const configs=Object.fromEntries(catalog.map(d=>[d.id,{...d.defaults}]));
    configs.feishu={...configs.feishu,enabled:true,appId:'App:Feishu',appSecretRef:'ref:feishu',accessMode:'platform',groups:[]};
    configs.slack={...configs.slack,enabled:true,accountId:'Team:Opaque',botTokenRef:'ref:bot',appTokenRef:'ref:app',ownerIds:['User:Owner']};
    configs.dingtalk={...configs.dingtalk,enabled:true,appId:'App:Opaque',appSecretRef:'ref:secret',robotCode:'Robot:Opaque',ownerIds:['Staff:Owner']};
    configs.telegram={...configs.telegram,enabled:true,botTokenRef:'ref:telegram'};
    const revisions=Object.fromEntries(catalog.map(d=>[d.id,1]));
    if(window.mode==='empty'){
      configs[window.target]={...catalog.find(d=>d.id===window.target).defaults};
      revisions[window.target]=0;
    }
    window.calls=[];
    let tokenRevision=1;
    const integrationEndpoint={url:'https://relay.example.test/link/api/rpc',relay:true,relayTarget:'example-device'};
    const state=channel=>{const c=configs[channel];return {enabled:c.enabled,authentication:c.enabled&&channel!=='feishu'?'verified':'unverified',events:'unverified',sending:'unverified',connection:{state:c.enabled?'connected':'disabled',...(channel==='feishu'?{authenticated:c.enabled}: {})}};};
    window.syncSignals=[];window.pendingSync=[];
    async function api(action,input={},signal){
      window.calls.push({action,input});const channel=input.channel||'feishu';
      if(action==='connectionCatalog'){
        window.syncSignals.push(signal);
        if(window.syncFailure)throw Error('状态服务暂不可用');
        if(window.deferSync)return new Promise(resolve=>window.pendingSync.push(()=>resolve({channels:catalog.map(d=>({...d,status:{enabled:false,connection:{state:'disabled'}}}))})));
        return {channels:catalog.map(d=>({...d,status:state(d.id),...(d.id==='telegram'?{recentSources:[{actorId:'738392',groupId:'-1006482'}]}:{})}))};
      }
      if(action==='connections'){
        if(channel===window.target&&window.mode==='loading')return new Promise(()=>{});
        if(channel===window.target&&window.mode==='error')throw Error('连接配置暂时不可用');
        return {channel,revision:revisions[channel],config:configs[channel]};
      }
      if(action==='connectionStatus')return state(channel);
      if(action==='connectionConfigure'){configs[channel]={...configs[channel],...input.patch};return {channel,revision:++revisions[channel],config:configs[channel]};}
      if(action==='connectionVerify')return state(channel);
      if(action==='connectionCredential')return {ref:'encrypted:new-ref'};
      if(action==='integrationToken'){
        if(input.operation==='rotate') tokenRevision++;
        return {endpoint:integrationEndpoint,...(configs.api.enabled?{token:'example-owner-token-'+tokenRevision,revision:tokenRevision}:{})};
      }
    }
    const root=createRoot(document.getElementById('app'));
    window.setConnectionsActive=active=>root.render(<Connections api={api} active={active}/>);
    window.setConnectionsActive(true);
  `, resolveDir: fileURLToPath(new URL('../client/', import.meta.url)), loader: 'jsx' },
    bundle: true, write: false, outdir: 'unused-connections-ui-test', format: 'iife', platform: 'browser', jsx: 'automatic',
    nodePaths: [fileURLToPath(new URL('../../base/node_modules/', import.meta.url))],
    alias: { react: dirname(reactRequire.resolve('react/package.json')), 'react-dom': dirname(reactRequire.resolve('react-dom/package.json')) },
    loader: { '.css': 'text', '.svg': 'text' }, plugins: [sharedUiStyles(), officialTooltipSource()], logLevel: 'silent',
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
      if(target!=='feishu')await page.getByRole('tab', {name:catalog.find(channel=>channel.id===target).label,exact:true}).click();
    }
    for (const target of ['feishu','slack','dingtalk']) {
      for (const width of [1440,768,390]) {
        for (const mode of ['empty','loading','error','data']) {
          await open(target,mode,width);
          if(mode==='loading')await page.getByText('正在读取连接配置',{exact:true}).waitFor();
          else if(mode==='error')await page.getByRole('alert').filter({hasText:'连接配置暂时不可用'}).waitFor();
          else await page.getByLabel(target==='feishu'?'App ID':target==='slack'?'工作区 ID':'Client ID / AppKey',{exact:false}).waitFor();
          assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${target}/${mode}/${width} overflow`);
          assert(await page.locator('.ba-connections-heading').evaluate(header=>{
            const title=header.querySelector('h1').getBoundingClientRect();
            const buttons=header.querySelector('.ba-row-actions').getBoundingClientRect();
            return buttons.left>title.left && buttons.top<title.bottom && Math.abs(buttons.right-header.getBoundingClientRect().right)<1;
          }),`${target}/${mode}/${width} actions should align to the right of the heading`);
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
      const verification=page.locator('.ba-channel-verification-actions');
      await verification.getByText('验证完成。认证、接收和发送状态分别显示，实际收发请在原渠道确认。',{exact:true}).waitFor();
      assert(await verification.evaluate(node=>node.firstElementChild.getBoundingClientRect().right<node.querySelector('button').getBoundingClientRect().left));
    }
    await open('feishu','empty',390);
    const firstAppId=page.getByLabel('App ID',{exact:false});
    const reload=page.getByRole('button',{name:'重新加载',exact:true});
    const saveChanges=page.getByRole('button',{name:'保存更改',exact:true});
    const slackTab=page.getByRole('tab',{name:'Slack',exact:true});
    const feishuTab=page.getByRole('tab',{name:'飞书',exact:true});
    const dialog=page.getByRole('dialog');
    await firstAppId.waitFor();
    assert(await saveChanges.isDisabled());
    await reload.click();
    await page.waitForFunction(()=>window.calls.filter(c=>c.action==='connections'&&c.input.channel==='feishu').length===2);
    await slackTab.click();
    await page.getByLabel('工作区 ID',{exact:false}).waitFor();
    assert.equal(await dialog.count(),0);
    await feishuTab.click();
    await firstAppId.fill('New:Feishu');
    await slackTab.click();
    await dialog.getByRole('heading',{name:'放弃渠道修改？'}).waitFor();
    await dialog.getByRole('button',{name:'继续编辑'}).click();
    assert.equal(await firstAppId.inputValue(),'New:Feishu');
    await reload.click();
    await dialog.getByRole('heading',{name:'重新加载渠道？'}).waitFor();
    await dialog.getByRole('button',{name:'放弃并加载'}).click();
    await page.waitForFunction(()=>document.getElementById('ba-channel-appId')?.value==='');
    assert(await saveChanges.isDisabled());
    await firstAppId.fill('New:Feishu');
    await saveChanges.click();
    await page.getByText('已保存',{exact:true}).waitFor();
    const firstSave=await page.evaluate(()=>window.calls.find(c=>c.action==='connectionConfigure').input);
    assert.deepEqual(firstSave,{channel:'feishu',revision:0,patch:{appId:'New:Feishu',accessMode:'platform',groups:[]}});
    assert(await saveChanges.isDisabled());
    await open('telegram','data',390);
    await page.getByText('近期收到的来源 ID',{exact:true}).click();
    await page.getByRole('button',{name:'加入账号名单',exact:true}).click();
    await page.getByRole('button',{name:'加入群名单',exact:true}).click();
    assert.equal(await page.getByLabel('允许的账号 ID',{exact:true}).inputValue(),'738392');
    assert.equal(await page.getByLabel('允许的群 ID',{exact:true}).inputValue(),'-1006482');
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'personal scope overflows the narrow panel');
    await page.getByRole('button',{name:'保存更改',exact:true}).click();
    await page.getByText('已保存',{exact:true}).waitFor();
    const scopeSave=await page.evaluate(()=>window.calls.find(c=>c.action==='connectionConfigure'));
    assert.deepEqual(scopeSave.input.patch,{ownerIds:['738392'],chatIds:['-1006482']});
    await open('api','loading',390);
    await page.getByText('正在读取连接配置',{exact:true}).waitFor();
    await open('api','error',390);
    await page.getByRole('alert').filter({hasText:'连接配置暂时不可用'}).waitFor();
    await open('api','data',390);
    const integrationName=page.getByLabel('接入名称',{exact:false});
    await integrationName.waitFor();
    assert.equal(await page.getByRole('tab',{name:/Webhook|API Service/}).count(),0);
    assert.equal(await page.locator('.ba-connection-field').count(),1);
    assert.equal(await page.locator('.ba-channel-status').innerText(),'未启用');
    const docsButton=page.getByRole('button',{name:'API 文档',exact:true});
    const apiDocs=page.getByRole('dialog',{name:'外部集成 API 文档'});
    const preview=apiDocs.getByRole('textbox',{name:'API 文档内容'});
    const copyDocs=apiDocs.getByRole('button',{name:'复制给 AI'});
    await page.evaluate(()=>{
      Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.copiedDocs=value;}}});
    });
    await docsButton.click();
    await apiDocs.getByRole('status').getByText('正在读取 API Token…',{exact:true}).waitFor({state:'hidden'});
    const documentation=await preview.inputValue();
    assert.match(documentation,/POST https:\/\/relay\.example\.test\/link\/api\/rpc/);
    assert.match(documentation,/Authorization: Bearer <启用并保存后显示 API Token>/);
    assert.deepEqual([...documentation.matchAll(/```json\n([\s\S]+?)\n```/g)].map(([,body])=>JSON.parse(body).body.action),['connectionAction','connectionReplies','tasks']);
    await copyDocs.click();
    await apiDocs.getByRole('status').getByText('已复制',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.copiedDocs),documentation);
    for (const width of [390,1440]) {
      await page.setViewportSize({width,height:900});
      assert(await apiDocs.evaluate(node=>{
        const rect=node.getBoundingClientRect();
        const button=node.querySelector('footer button').getBoundingClientRect();
        return rect.left>=0 && rect.right<=innerWidth && node.scrollWidth<=node.clientWidth && button.bottom<=rect.bottom;
      }),`API docs overflow at ${width}px`);
      await page.screenshot({path:join(output,`api-docs-${width}.png`)});
    }
    await page.setViewportSize({width:390,height:900});
    await page.keyboard.press('Escape');
    await apiDocs.waitFor({state:'hidden'});
    await page.waitForFunction(()=>document.activeElement?.textContent==='API 文档');
    await page.evaluate(()=>{
      Object.defineProperty(navigator,'clipboard',{configurable:true,value:undefined});
      document.execCommand=()=>false;
    });
    await docsButton.click();
    await copyDocs.click();
    await apiDocs.getByRole('status').getByText('请手动复制已选中的文档').waitFor();
    assert(await preview.evaluate(node=>node.selectionStart===0 && node.selectionEnd===node.value.length));
    await apiDocs.getByRole('button',{name:'关闭 API 文档'}).click();
    await integrationName.fill('My:Integration');
    await page.getByRole('switch',{name:'启用外部集成'}).check();
    await page.getByRole('button',{name:'保存更改',exact:true}).click();
    await page.getByText('已保存',{exact:true}).waitFor();
    const integrationSave=await page.evaluate(()=>window.calls.find(c=>c.action==='connectionConfigure'));
    assert.deepEqual(integrationSave.input.patch,{enabled:true,accountId:'My:Integration'});
    await page.getByRole('button',{name:'重新加载',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('[role=tabpanel]')?.getAttribute('aria-busy')==='false');
    assert.equal(await integrationName.inputValue(),'My:Integration');
    assert.equal(await page.getByRole('switch',{name:'启用外部集成'}).isChecked(),true);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'integration form overflows the narrow panel');
    await page.evaluate(()=>{
      Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.copiedDocs=value;}}});
    });
    await docsButton.click();
    const rotate=apiDocs.getByRole('button',{name:'轮换 Token'});
    await rotate.waitFor();
    assert.match(await preview.inputValue(),/Authorization: Bearer example-owner-token-1/);
    await rotate.click();
    await apiDocs.getByRole('status').getByText('已轮换',{exact:true}).waitFor();
    await copyDocs.click();
    await apiDocs.getByRole('status').getByText('已复制',{exact:true}).waitFor();
    const copied=await page.evaluate(()=>window.copiedDocs);
    assert.match(copied,/Authorization: Bearer example-owner-token-2/);
    assert.doesNotMatch(copied,/example-owner-token-1/);
    assert.match(copied,/X-BenchGo-Relay-Target: example-device/);
    await page.screenshot({path:join(output,'api-docs-enabled-390.png')});
    await page.keyboard.press('Escape');
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
