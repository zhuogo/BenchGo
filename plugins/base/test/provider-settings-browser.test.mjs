import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { officialModelsUi } from '../scripts/official-models-ui.mjs';
import { officialModelsStore } from '../scripts/official-models-store.mjs';
import { shellUi } from '../scripts/shell-ui.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
const { chromium } = require('playwright');
const { build } = createRequire(import.meta.url)('esbuild');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || [chromium.executablePath(),
  'C:/Users/DraftGo/AppData/Local/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-win64/chrome-headless-shell.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);

async function fixture() {
  const result = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {ModelsSection} from './deepseek-harness/packages/client/ui-settings-models/src/client/ModelsSection.tsx';
    import {SettingsRoot} from './deepseek-harness/packages/client/ui-settings-general/src/client/SettingsRoot.tsx';
    import {zh} from './deepseek-harness/packages/client/ui-settings-models/src/client/locales.ts';
    import {mountProviderSettings} from './plugins/base/client/provider-settings.jsx';
    import hostCss from './plugins/base/client/style.css';
    import mobileCss from './plugins/base/client/mobile-workbench.css';
    import tokens from './deepseek-harness/packages/client/ui-theme/src/styles/design-platform.css';
    import base from './deepseek-harness/packages/client/ui-theme/src/styles/base.css';
    import {installIconSprite} from './deepseek-harness/packages/client/ui-theme/src/client/icon-sprite.ts';
    installIconSprite({effect:run=>run(),on() {}});
    let disposers = [];
    const adaptationController={read(){},load(){},ctx:{},schema:{},describeFace:{},store:{getSnapshot:()=>({rows:[]})},generation:0};
    const entry = {options:{id:'models'},children:{'settings.models.provider-card':{}},component:null,inject:()=>({controller:adaptationController})};
    const mount = () => mountProviderSettings({effect:fn=>disposers.push(fn()),slots:{entries:()=>[entry]}});
    mount(); window.remount = () => {for(const dispose of disposers.reverse()) dispose?.();disposers=[];mount();};
    let namespace = {ns:'llm-pi-ai',user:{providers:{routergo:{api:'openai-completions',baseURL:'https://router.example/v1',models:[{id:'opaque/router:model'}]}}},base:{},schema:{},revision:1}; namespace.value=structuredClone(namespace.user);
    let official; const keys = new Map();
    const namespaces=()=>new Map([['llm-pi-ai',namespace], ...(official ? [[official.ns,official]] : [])]);
    const listeners = new Set(); let state;
    const getPath=(value,path)=>path.reduce((at,key)=>at?.[key],value);
    const protocols=['openai-completions','openai-responses','anthropic-messages'];
    const schema={getPath,hasPath:(value,path)=>getPath(value,path)!==undefined,rehydrate:value=>value,
      nodeAtPath:(_root,path)=>path.at(-1)==='api'?{type:'union',list:protocols.map(value=>({value}))}:{meta:{}},validate:()=>undefined,
      setPath(value,path,next){const copy=structuredClone(value);let at=copy;for(const key of path.slice(0,-1))at=at[key]??={};at[path.at(-1)]=next;return copy;},
      deletePath(value,path){const copy=structuredClone(value);let at=copy;for(const key of path.slice(0,-1))at=at[key];delete at[path.at(-1)];return copy;}};
    const rows=()=>[...new Set(['stepfun',...Object.keys(namespace.value.providers)])].map(id=>({entry:{provider:id,
      displayName:namespace.value.providers[id]?.displayName??({routergo:'RouterGo',stepfun:'StepFun'})[id]??id,
      settingsNs:'llm-pi-ai',settingsPath:['providers',id],active:true,declared:id!=='stepfun'},
      configured:!!namespace.value.providers[id],removable:true,apiKeyEnv:namespace.value.providers[id]?.apiKeyEnv,
      credential:{configured:window.invalidCredential !== id,writable:true,source:'file'}})).concat(official ? [{
        entry:{provider:'deepseek-official',displayName:'DeepSeek',settingsNs:official.ns,settingsPath:[],active:true},
        configured:true,removable:false,apiKeyEnv:official.value.apiKeyEnv,
        credential:{configured:keys.has(official.value.apiKeyEnv),writable:true,source:keys.get(official.value.apiKeyEnv)}
      }] : []);
    const publish=next=>{state=next;for(const listener of listeners)listener();};
    window.backgroundLoading=()=>publish({...state,status:'loading'});
    window.routerScenario=mode=>{
      if(mode==='missing') {delete namespace.user.providers.routergo;delete namespace.value.providers.routergo;}
      window.invalidCredential=mode==='invalid'?'routergo':undefined;
      publish({...state,status:'ready',rows:rows()});
    };
    window.storeAccount=()=>{
      window.invalidCredential=undefined;
      const ref='BENCHGO_ROUTERGO_KEY_0123456789abcdef0123456789abcdef';
      const managed={apiKeyEnv:ref,api:'openai-responses',baseURL:'https://routergo.cn/api/v1',displayName:'RouterGo'};
      Object.assign(namespace.user.providers.routergo,managed);
      Object.assign(namespace.value.providers.routergo,managed);
    };
    window.setScenario=mode=>publish({status:mode==='loading'?'loading':mode==='error'?'error':'ready',error:mode==='error'?'供应商目录暂不可用':null,writable:true,
      rows:mode==='empty'?rows().map(row=>({...row,configured:false})):mode==='data'?rows():[],namespaces:namespaces()});
    window.officialScenario = source => {
      official={ns:'llm-deepseek',user:{apiKeyEnv:'SHARED_DEEPSEEK',models:[{id:'opaque/deepseek:model'}]},base:{},schema:{},revision:3};
      official.value=structuredClone(official.user);
      keys.clear();
      if(source)keys.set('SHARED_DEEPSEEK',source);
      window.setScenario('data');
    };
    window.getOfficial=()=>({apiKeyEnv:official.value.apiKeyEnv,models:official.user.models,keys:[...keys.keys()]});
    window.loads=0; window.writes=[]; window.discoveries=[];
    const controller={store:{getSnapshot:()=>state},async load(){window.loads++;publish({...state,status:'loading'});await new Promise(resolve=>setTimeout(resolve,80));publish({...state,status:'ready',rows:rows(),namespaces:namespaces()});}};
    const operations={async writeSettings(ns,ops,revision){if(ns===official?.ns){window.writes.push({ns,ops,revision});for(const op of ops){if(op.op==='set')official.user=schema.setPath(official.user,op.path,op.value);}official.value=structuredClone(official.user);official.revision++;return{kind:'written',view:official};}window.writes.push({ns,ops});for(const op of ops){if(op.op==='set')namespace.user=schema.setPath(namespace.user,op.path,op.value);else if(op.op==='unset')namespace.user=schema.deletePath(namespace.user,op.path);}namespace.value=structuredClone(namespace.user);namespace.revision++;return{kind:'written',view:namespace};},async storeCredential(ref){keys.set(ref,'file');},async removeCredential(ref){keys.delete(ref);},async discoverModels(ns,options){window.discoveries.push({ns,options});return{kind:'found',models:window.fixtureModels??[]};}};
    const useSnapshot=selector=>selector(React.useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn);},()=>state));
    window.setScenario('loading');
    function App() {
      const [activeId, select] = React.useState('models');
      const rows = [{id:'general',label:'通用设置'}, {id:'models',label:'模型'}, {id:'harness-tools',label:'Harness 工具'}];
      const renderSlot = (name, props, filter) => {
        if (name === 'settings.header') return '设置';
        if (name === 'settings.close') return '关闭设置';
        if (name === 'settings.section' && filter.only === 'models') return <ModelsSection controller={controller} useSnapshot={useSnapshot} operations={operations} schema={schema} t={key=>zh[key]??key} renderSlot={()=>null}/>;
        return filter?.fallback ?? null;
      };
      return <><style>{tokens}{base}{hostCss}{mobileCss}</style><main><h1>BenchGo</h1><SettingsRoot wide t={key=>key} renderSlot={renderSlot} reconnect={()=>{}}
        useStore={read=>read({open:true,activeId})} actions={{select,close(){}}} useSections={read=>read(rows)}
        useConnectionState={read=>read('connected')} useOnboardingSteps={read=>read([])}
        useSessions={read=>read({phase:'ready',byId:{main:{retainedBy:{mainView:1},blank:false}}})} useShortcuts={read=>read([])}/></main></>;
    }
    createRoot(document.getElementById('root')).render(<App/>);
  ` }, bundle: true, write: false, outdir: join(root, 'artifacts/unused-provider-browser'), format: 'iife', jsx: 'automatic',
    nodePaths: [join(root, 'plugins/base/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
    alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')),
      '@deepseek-ai/dsh-client-store': join(root, 'deepseek-harness/packages/client/store/src/index.ts'),
      '@deepseek-ai/dsh-client-ui-primitives': join(root, 'deepseek-harness/packages/client/ui-primitives/src/index.ts') },
    plugins:[shellUi(),officialModelsStore(),officialModelsUi()],loader: { '.css': 'text', '.module.css': 'local-css', '.svg': 'text' }, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  const script = result.outputFiles.find(file => file.path.endsWith('.js')).text;
  const css = result.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
    body{margin:0;font:14px var(--dsw-font-family);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}main{padding:24px}${css}
    </style></head><body><div id="root"></div><script>${script.replaceAll('</script','<\\/script')}</script></body></html>`;
}

test('DeepSeek official can be removed and re-added without altering the shared credential or stored models', { skip: !executablePath && 'Chromium/Edge required' }, async () => {
  const html = await fixture(), browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
    page.setDefaultTimeout(6000);
    await page.route('**/*', route => route.request().url() === 'http://localhost/'
      ? route.fulfill({ contentType: 'text/html', body: html })
      : route.fulfill({ json: {} }));
    await page.goto('http://localhost/');
    const remove = page.getByRole('button', { name: '删除 DeepSeek (deepseek-official)', exact: true });
    for (const source of [null, 'env']) {
      await page.evaluate(source => window.officialScenario(source), source);
      await remove.click();
      await page.getByRole('button', { name: '取消', exact: true }).click();
      await remove.click();
      await page.getByText('断开 DeepSeek 官方 API 连接。已有模型参数和凭据会保留。', { exact: true }).waitFor();
      await remove.last().click();
      await remove.waitFor({ state: 'hidden' });
      const disconnected = await page.evaluate(() => window.getOfficial());
      assert.match(disconnected.apiKeyEnv, /^BENCHGO_DEEPSEEK_OFFICIAL_[0-9a-f]{32}$/u);
      assert.deepEqual(disconnected.models, [{ id: 'opaque/deepseek:model' }]);
      assert.deepEqual(disconnected.keys, source ? ['SHARED_DEEPSEEK'] : []);
      assert.deepEqual(await page.evaluate(() => window.writes.at(-1)), {
        ns: 'llm-deepseek', revision: 3, ops: [{ op: 'set', path: ['apiKeyEnv'], value: disconnected.apiKeyEnv }],
      });
      await page.getByRole('button', { name: '添加模型提供商', exact: true }).click();
      const providerPicker = page.getByRole('button', { name: '提供商', exact: false }).filter({ hasNotText: '添加模型提供商' });
      await providerPicker.click();
      await page.getByRole('dialog', { name: '提供商', exact: true }).getByRole('button', { name: 'DeepSeek', exact: true }).click();
      await page.getByRole('textbox', { name: 'API 密钥', exact: true }).fill('fixture-deepseek-key');
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await remove.waitFor();
      assert.deepEqual((await page.evaluate(() => window.getOfficial())).keys, [...disconnected.keys, disconnected.apiKeyEnv]);
    }
  } finally { await browser.close(); }
});

test('provider settings render four states and retain protocol choices through discovery, saving and reload', {skip:!executablePath&&'Chromium/Edge required'}, async()=>{
  const html=await fixture(), browser=await chromium.launch({executablePath,headless:true}), errors=[];
  const screenshots=process.env.BENCHGO_PROVIDER_SCREENSHOTS;
  if(screenshots)await mkdir(screenshots,{recursive:true});
  try{
    for(const [width,dark] of [[1440,false],[1440,true],[390,false],[390,true]]){
      const page=await browser.newPage({viewport:{width,height:800}});page.setDefaultTimeout(6000);page.on('pageerror',error=>errors.push(error.message));
      await page.route('**/*', route => {
        const request = route.request();
        if (request.url() === 'http://localhost/') return route.fulfill({ contentType: 'text/html', body: html });
        if (!request.url().endsWith('/api/commander/tooling')) return route.abort();
        if (request.postDataJSON()?.action === 'modelProfiles') return route.fulfill({ json: { success: true, data: [
          { model_id: 'opaque/router:model', input_modalities: ['text', 'image', 'audio', 'video'] },
          { model_id: 'Opaque/router:model', input_modalities: ['pdf'] },
        ] } });
        return route.fulfill({ json: { tools: [], bindings: {} } });
      });
      await page.goto('http://localhost/');await page.evaluate(dark=>document.body.toggleAttribute('data-ds-dark-theme',dark),dark);
      for(const scenario of ['loading','error','empty','data']){
        await page.evaluate(mode=>window.setScenario(mode),scenario);
        if(scenario==='loading'){
          const loading=page.getByRole('status',{name:'正在加载供应商与模型…'});await loading.waitFor();
          assert.equal(await loading.locator('.bg-loading-character').count(),Array.from('正在加载供应商与模型…').length);
          const layout=await loading.evaluate(node=>({justify:getComputedStyle(node).justifyContent,align:getComputedStyle(node).alignItems,height:node.clientHeight}));
          assert.equal(layout.justify,'center');assert.equal(layout.align,'center');assert(layout.height>=240);
          await page.emulateMedia({reducedMotion:'reduce'});assert.equal(await loading.locator('.bg-loading-character').first().evaluate(node=>getComputedStyle(node).animationName),'none');await page.emulateMedia({reducedMotion:'no-preference'});
        } else if(scenario==='error') {await page.getByText('供应商目录暂不可用',{exact:false}).waitFor();assert.equal(await page.getByRole('button',{name:'重试'}).count(),1);}
        else if(scenario==='empty')assert.equal(await page.getByRole('button',{name:'添加模型提供商'}).count(),1);
        else await page.getByText('RouterGo',{exact:true}).waitFor();
        if(screenshots)await page.screenshot({path:join(screenshots,`${scenario}-${width}-${dark?'dark':'light'}.png`),fullPage:true});
      }
      assert.equal(await page.locator('#commander-official-models-style').count(),1);
      await page.evaluate(()=>window.backgroundLoading());
      await page.getByText('RouterGo',{exact:true}).waitFor();
      assert.equal(await page.getByRole('status',{name:'正在加载供应商与模型…'}).count(),0);
      await page.evaluate(()=>window.setScenario('data'));
      for(let cycle=0;cycle<3;cycle++)await page.evaluate(()=>window.remount());
      assert.equal(await page.locator('#commander-official-models-style').count(),1);
      assert.equal(await page.getByRole('dialog').getByRole('heading').first().evaluate(node=>getComputedStyle(node).marginTop),'0px');
      await page.getByRole('button',{name:'添加模型提供商'}).click();
      await page.getByRole('textbox',{name:'API 密钥',exact:true}).fill('fixture-value');
      await page.getByRole('button',{name:'保存',exact:true}).click();
      await page.getByRole('listitem').filter({hasText:'StepFun'}).waitFor();
      await page.waitForFunction(()=>window.loads===1);
      assert.equal(await page.evaluate(()=>window.writes[0].ns),'llm-pi-ai');
      assert.equal(await page.evaluate(()=>window.writes[0].ops[0].path[1]),'stepfun');
      assert.equal(await page.locator('#commander-official-models-style').count(),1);
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      const router = page.getByRole('listitem').filter({hasText:'RouterGo'});
      const stepfun = page.getByRole('listitem').filter({hasText:'StepFun'});
      const [first, second] = await Promise.all([router.boundingBox(),stepfun.boundingBox()]);
      assert(second.y > first.y);
      if(width > 1000) assert(first.width > second.width);
      if(screenshots) await page.screenshot({path:join(screenshots,`providers-${width}-${dark?'dark':'light'}.png`)});
      await router.getByRole('button',{name:/^编辑 RouterGo/}).click();
      if(width > 1000) assert.equal((await router.boundingBox()).width, first.width);
      const endpoint=router.getByRole('textbox',{name:'API 地址',exact:true});
      const protocol=router.getByRole('button',{name:'API 协议',exact:true});
      const protocolMenu=page.getByRole('listbox',{name:'API 协议'});
      const advanced=router.getByRole('button',{name:'高级连接设置',exact:true});
      assert(await router.getByRole('textbox',{name:'API 密钥',exact:true}).isVisible());
      assert.equal(await endpoint.inputValue(),'https://router.example/v1');
      assert.equal(await protocol.count(),0);
      await advanced.click();
      assert.equal((await protocol.innerText()).trim(),'OpenAI Chat Completions');
      assert.equal(await router.getByText('自定义设置',{exact:true}).count(),0);
      assert.equal(await router.locator('select').count(),0);
      if(screenshots) await page.screenshot({path:join(screenshots,`editor-${width}-${dark?'dark':'light'}.png`)});
      await protocol.scrollIntoViewIfNeeded();
      await protocol.press('ArrowDown');
      await protocolMenu.waitFor();
      await page.waitForFunction(()=>document.activeElement?.getAttribute('role')==='listbox');
      if(screenshots) await page.screenshot({path:join(screenshots,`protocol-${width}-${dark?'dark':'light'}.png`),animations:'disabled'});
      await page.keyboard.press('Escape');
      await protocolMenu.waitFor({state:'detached'});
      assert(await protocol.evaluate(node=>node===document.activeElement));
      await protocol.press('ArrowDown');
      await page.waitForFunction(()=>document.activeElement?.getAttribute('role')==='listbox');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      assert.equal((await protocol.innerText()).trim(),'OpenAI Responses');
      await endpoint.fill('https://edited.example/v1');
      const modelActions = router.locator('.cmd-model-list-actions');
      assert.deepEqual((await modelActions.getByRole('button').allTextContents()).map(value=>value.trim()), ['保存', '获取模型']);
      assert.equal(await modelActions.getByRole('button', { name: '获取模型' }).locator('svg').count(), 0);
      assert.equal(await modelActions.getByRole('button', { name: '获取模型' }).evaluate(node => getComputedStyle(node).borderRadius),
        await modelActions.getByRole('button', { name: '保存' }).evaluate(node => getComputedStyle(node).borderRadius));
      await modelActions.getByRole('button',{name:'获取模型'}).click();
      assert.deepEqual(await page.evaluate(()=>window.discoveries.at(-1)),{ns:'llm-pi-ai',options:{provider:'routergo',baseURL:'https://edited.example/v1',api:'openai-responses'}});
      await router.getByRole('button',{name:'保存',exact:true}).click();
      await endpoint.waitFor({state:'detached'});
      await page.waitForFunction(()=>window.loads===2);
      assert.deepEqual(await page.evaluate(()=>window.writes[1]),{ns:'llm-pi-ai',ops:[
        {op:'set',path:['providers','routergo','api'],value:'openai-responses'},
        {op:'set',path:['providers','routergo','baseURL'],value:'https://edited.example/v1'},
        {op:'set',path:['providers','routergo','models'],value:[{id:'opaque/router:model',input:['text','image']}]},
      ]});
      await router.getByRole('button',{name:/^编辑 RouterGo/}).click();
      assert.equal(await endpoint.inputValue(),'https://edited.example/v1');
      await advanced.click();
      assert.equal((await protocol.innerText()).trim(),'OpenAI Responses');
      await router.getByRole('button',{name:'模型选项 1',exact:true}).click();
      assert.equal(await router.getByRole('textbox',{name:'模型 ID 1',exact:true}).inputValue(),'opaque/router:model');
      const inputs = router.getByRole('group', { name: '输入类型 1' });
      await inputs.getByRole('checkbox', { name: '音频' }).waitFor();
      for (const name of ['音频', '视频']) {
        const modality = inputs.getByRole('checkbox', { name });
        assert(await modality.isChecked());
        assert(await modality.isDisabled());
      }
      assert.equal(await inputs.getByRole('checkbox', { name: 'pdf' }).count(), 0);
      if(screenshots) await page.screenshot({path:join(screenshots,`model-inputs-${width}-${dark?'dark':'light'}.png`)});
      const custom = router.getByRole('button', { name: '自定义档位' });
      await custom.click();
      const editor = router.locator('.cmd-model-reasoning-edit');
      const level = editor.getByRole('button', { name: '映射档位' });
      const wire = editor.getByRole('textbox', { name: '供应商档位值' });
      const [customBox, editorBox, levelBox, wireBox] = await Promise.all([custom.boundingBox(), editor.boundingBox(), level.boundingBox(), wire.boundingBox()]);
      assert(editorBox.y - (customBox.y + customBox.height) >= 7);
      assert(wireBox.x - (levelBox.x + levelBox.width) >= 7);
      assert(Math.abs(levelBox.height - wireBox.height) <= 2);
      for (const name of ['应用档位', '取消编辑']) {
        const box = await editor.getByRole('button', { name }).boundingBox();
        assert(box.x >= editorBox.x && box.x + box.width <= editorBox.x + editorBox.width);
        if (width === 390) assert(box.y > levelBox.y + levelBox.height);
      }
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if(screenshots) await page.screenshot({path:join(screenshots,`reasoning-editor-${width}-${dark?'dark':'light'}.png`)});
      await editor.getByRole('button', { name: '取消编辑' }).click();
      await router.getByRole('button',{name:/^编辑 RouterGo/}).click();

      await page.getByRole('button',{name:'添加模型提供商'}).click();
      await page.getByRole('button',{name:'提供商',exact:true}).click();
      await page.getByRole('button',{name:'自定义供应商',exact:true}).click();
      const createProtocol=page.getByRole('button',{name:'API 协议',exact:true});
      assert.equal(await page.locator('select').count(),0);
      assert.equal(await createProtocol.count(),0);
      await page.getByRole('button',{name:'高级连接设置',exact:true}).click();
      assert.equal((await createProtocol.innerText()).trim(),'OpenAI Responses');
      await createProtocol.click();
      await protocolMenu.getByRole('option',{name:'Anthropic Messages'}).click();
      await page.getByRole('textbox',{name:'Provider ID'}).fill('fixture-gateway');
      await page.getByRole('textbox',{name:'API 地址',exact:true}).fill('https://fixture.example');
      await page.getByRole('button',{name:'添加模型',exact:true}).click();
      await page.getByRole('textbox',{name:'模型 ID 1',exact:true}).fill('opaque/gateway:model');
      await page.getByRole('button',{name:'获取模型'}).click();
      assert.deepEqual(await page.evaluate(()=>window.discoveries.at(-1)),{ns:'llm-pi-ai',options:{baseURL:'https://fixture.example',api:'anthropic-messages'}});
      await page.getByRole('button',{name:'创建提供商'}).click();
      const created=page.getByRole('listitem').filter({hasText:'fixture-gateway'});
      await created.getByRole('button',{name:/^编辑 fixture-gateway/}).click();
      await created.getByRole('button',{name:'高级连接设置',exact:true}).click();
      assert.equal((await created.getByRole('button',{name:'API 协议'}).innerText()).trim(),'Anthropic Messages');
      await created.getByRole('button',{name:'模型选项 1',exact:true}).click();
      assert.equal(await created.getByRole('textbox',{name:'模型 ID 1',exact:true}).inputValue(),'opaque/gateway:model');
      await page.close();
    }
    assert.deepEqual(errors,[]);
  } finally{await browser.close();}
});

test('model capability settings render directory states and persist one exact model override', { skip: !executablePath && 'Chromium/Edge required' }, async () => {
  const html = await fixture();
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
    const modelId = 'opaque/router:model';
    let mode = 'loading';
    let override;
    let rejectWrite = false;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route('http://localhost/', route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.route('**/api/commander/tooling', async route => {
      const input = route.request().postDataJSON();
      if (input.action === 'modelProfiles') return route.fulfill({ json: { success: true, data: [] } });
      if (input.action === 'modelCapabilities') {
        if (mode === 'loading') await gate;
        if (mode === 'error') return route.fulfill({ status: 502, json: { error: '试验错误' } });
        return route.fulfill({ json: { overrides: override ? [{ modelId, capabilities: override }] : [] } });
      }
      if (input.action === 'models') return route.fulfill({
        json: { models: mode === 'empty' ? [] : [{ id: modelId, capabilities: override ?? ['image-generation'], ...(override ? { providerCapabilities: ['image-generation'] } : {}) }] },
      });
      assert.deepEqual(input, { action: 'saveModelCapabilities', providerId: 'routergo', modelId, capabilities: input.capabilities });
      if (rejectWrite) return route.fulfill({ status: 500, json: { error: '标签保存失败' } });
      override = input.capabilities;
      return route.fulfill({ json: { modelId, capabilities: override } });
    });
    await page.goto('http://localhost/');
    await page.evaluate(() => window.setScenario('data'));
    const edit = page.getByRole('button', { name: /^编辑 RouterGo/ });
    const expand = page.getByRole('button', { name: '模型选项 1' });
    await edit.click();
    await expand.click();
    await page.getByRole('status', { name: '正在加载能力标签…' }).waitFor();
    mode = 'error';
    release();
    await page.getByRole('alert').filter({ hasText: '无法加载已保存的能力标签' }).waitFor();
    mode = 'empty';
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await page.locator('.cmd-model-capabilities button[aria-pressed=false]').first().waitFor();
    await edit.click();
    mode = 'data';
    await edit.click();
    await expand.click();
    const generation = page.getByRole('button', { name: '图片生成', exact: true });
    const mask = page.getByRole('button', { name: '遮罩编辑', exact: true });
    await page.waitForFunction(() => [...document.querySelectorAll('button[aria-pressed=true]')].some(button => button.textContent === '图片生成'));
    await mask.click();
    await page.locator('.cmd-model-capabilities[aria-busy=false]').waitFor();
    assert.deepEqual(override, ['image-generation', 'image-mask']);
    await edit.click();
    await edit.click();
    await expand.click();
    await mask.waitFor();
    assert.equal(await mask.getAttribute('aria-pressed'), 'true');
    rejectWrite = true;
    await mask.click();
    await page.getByRole('alert').filter({ hasText: '标签保存失败' }).waitFor();
    assert.equal(await mask.getAttribute('aria-pressed'), 'true');
    rejectWrite = false;
    await mask.click();
    await generation.click();
    await page.locator('.cmd-model-capabilities[aria-busy=false]').waitFor();
    assert.deepEqual(override, []);
    assert.equal(await mask.getAttribute('aria-pressed'), 'false');
    assert.equal(await generation.getAttribute('aria-pressed'), 'false');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  } finally {
    await browser.close();
  }
});

test('RouterGo shows account identity and compact balance, and allows manual credentials after removal', { skip: !executablePath && 'Chromium/Edge required' }, async () => {
  const html = await fixture();
  const browser = await chromium.launch({ executablePath, headless: true });
  const screenshots = process.env.BENCHGO_PROVIDER_SCREENSHOTS;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  try {
    for (const [width, dark] of [[1440, false], [390, true]]) {
      const context = await browser.newContext({ viewport: { width, height: 800 } });
      const page = await context.newPage();
      let loginFails = false, balance = '1008.133945', balanceFails = false, saves = 0, syncFails = true;
      const account = { id: '12', name: '测试账号', username: 'fixture-user' };
      let startGate;
      const actions = [];
      await page.addInitScript(() => {
        window.open = () => ({ opener: window, closed: false, close() {}, location: { replace(url) { window.verification = url; } } });
      });
      await page.route('http://localhost/', route => route.fulfill({ contentType: 'text/html', body: html }));
      await page.route('**/api/benchgo/routergo', async route => {
        const input = route.request().postDataJSON();
        actions.push(input);
        if (input.action === 'start') {
          await startGate;
          if (loginFails) return route.fulfill({ status: 502, json: { error: 'RouterGo 暂时无法启动授权，请重试' } });
          return route.fulfill({ json: { id: 'local-id', verificationURL: 'https://routergo.cn/benchgo/authorize?request=public-id', retryAfter: 1 } });
        }
        if (input.action === 'poll') return route.fulfill({ json: { state: 'authorized', account: { id: '12', name: '测试账号' }, requireSwitch: true } });
        if (input.action === 'cancel') return route.fulfill({ json: { state: 'cancelled' } });
        if (input.action === 'save') {
          if (!saves++) return route.fulfill({ status: 502, json: { error: '暂时无法获取该账号的 RouterGo 模型，请重试' } });
          await page.evaluate(() => window.storeAccount());
          return route.fulfill({ json: { state: 'connected', account, imported: 47 } });
        }
        if (input.action === 'sync') {
          if (syncFails) return route.fulfill({ status: 502, json: { error: '暂时无法同步 RouterGo 模型，已保留现有列表' } });
          return route.fulfill({ json: { state: 'synced', added: 1, updated: 2, removed: 3 } });
        }
        assert.equal(input.action, 'status');
        if (balanceFails) return route.fulfill({ status: 502, json: { error: '暂时无法读取 RouterGo 余额，请重试' } });
        return route.fulfill({ json: { state: 'connected', account, balance: { amount: balance, unit: '额度' } } });
      });
      await page.goto('http://localhost/');
      await page.evaluate(dark => { document.body.toggleAttribute('data-ds-dark-theme', dark); window.setScenario('empty'); }, dark);
      const card = page.getByRole('listitem').filter({ hasText: 'RouterGo' });
      const login = card.getByRole('button', { name: '登录 RouterGo' });
      await login.waitFor();
      const brand = card.getByRole('link', { name: '访问 RouterGo 官网（新窗口）' });
      assert.equal(await brand.getAttribute('href'), 'https://routergo.cn/');
      assert.equal(await brand.getAttribute('target'), '_blank');
      assert.equal(await brand.locator('.cmd-ui-icon').count(), 1);
      assert.equal(await brand.evaluate(node => getComputedStyle(node).fontSize), '18px');
      assert.equal(await brand.locator('img').getAttribute('width'), '42');
      assert.equal(await card.evaluate(node => getComputedStyle(node.parentElement).borderTopWidth), '1px');
      assert.equal(await brand.locator('img').evaluate(image => getComputedStyle(image).filter), 'none');
      assert.equal(await login.textContent(), '登录');
      assert.equal(await login.locator('.cmd-routergo-login-mark .cmd-ui-icon.is-selected').count(), 1);
      assert.equal(await login.evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(96, 97, 102)');
      const manual = card.getByRole('button', { name: '使用密钥' });
      const [brandBox, loginBox, manualBox] = await Promise.all([brand.boundingBox(), login.boundingBox(), manual.boundingBox()]);
      const keyIconBox = await manual.locator('.cmd-ui-icon').boundingBox();
      assert.equal(keyIconBox.y + keyIconBox.height / 2, manualBox.y + manualBox.height / 2);
      assert.equal(await page.getByText('登录 RouterGo 或配置供应商 API 密钥。', { exact: true }).count(), 0);
      assert(brandBox.x + brandBox.width < loginBox.x && loginBox.x + loginBox.width < manualBox.x);
      assert.equal(loginBox.y, manualBox.y);
      if (screenshots) await page.screenshot({ path: join(screenshots, `routergo-empty-${width}.png`) });
      assert(Math.abs(brandBox.y + brandBox.height / 2 - loginBox.y - loginBox.height / 2) <= 1, JSON.stringify({ brandBox, loginBox, manualBox }));
      await login.hover();
      const mark = login.locator('.cmd-routergo-login-mark');
      const markBox = await mark.boundingBox();
      assert.equal(await mark.evaluate(node => getComputedStyle(node).transform), 'none');
      assert.equal(await login.evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(96, 97, 102)');
      await page.mouse.down();
      const loginElement = await login.elementHandle();
      await page.waitForFunction(node => getComputedStyle(node).transform === 'matrix(0.97, 0, 0, 0.97, 0, 0)', loginElement);
      assert.equal(await mark.evaluate(node => getComputedStyle(node).transform), 'none');
      if (screenshots) await page.screenshot({ path: join(screenshots, `routergo-pressed-${width}.png`) });
      const gate = Promise.withResolvers();
      startGate = gate.promise;
      await page.mouse.up();
      try {
        await page.waitForFunction(node => node.getAttribute('aria-busy') === 'true' && getComputedStyle(node).transform === 'none', loginElement);
        assert.deepEqual(await login.boundingBox(), loginBox);
        assert.deepEqual(await mark.boundingBox(), markBox);
        assert.equal(await login.textContent(), '登录');
      } finally { gate.resolve(); }
      await card.getByRole('button', { name: '取消授权' }).click();
      await login.waitFor();
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await login.hover();
      await page.mouse.down();
      assert.equal(await login.evaluate(node => getComputedStyle(node).transform), 'none');
      await page.mouse.move(1, 1);
      await page.mouse.up();
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await manual.click();
      await page.getByRole('textbox', { name: 'API 密钥', exact: true }).waitFor();
      await page.locator('.cmd-model-add-close').click();
      await page.evaluate(() => window.setScenario('data'));
      await card.getByRole('button', { name: /^编辑 RouterGo/ }).waitFor();
      assert.equal(await login.count(), 0);
      assert.equal(await brand.locator('img').evaluate(image => getComputedStyle(image).filter), 'none');
      if (screenshots) await page.screenshot({ path: join(screenshots, `routergo-manual-${width}.png`) });
      await page.evaluate(() => window.routerScenario('invalid'));
      await login.click();
      await card.getByText('等待 RouterGo 授权确认').waitFor();
      const authorization = 'https://routergo.cn/benchgo/authorize?request=public-id';
      assert.equal(await page.evaluate(() => window.verification), authorization);
      assert.equal(await card.getByRole('link', { name: '打开授权页' }).getAttribute('href'), authorization);
      if (screenshots) await page.screenshot({ path: join(screenshots, `routergo-pending-${width}.png`) });
      await card.getByRole('button', { name: '取消授权' }).click();
      await login.waitFor();
      loginFails = true;
      await login.click();
      await page.getByRole('alert').getByText('RouterGo 暂时无法启动授权，请重试').waitFor();
      assert.equal(await card.getByRole('alert').count(), 0);
      if (screenshots) await page.screenshot({ path: join(screenshots, `routergo-error-${width}.png`) });
      loginFails = false;
      await login.click();
      const useAccount = card.getByRole('button', { name: '使用账号凭据' });
      await useAccount.click();
      await page.getByRole('alert').getByText('暂时无法获取该账号的 RouterGo 模型，请重试').waitFor();
      await useAccount.click();
      const summary = card.getByRole('region', { name: 'RouterGo 账号信息' });
      await summary.getByText('测试账号', { exact: true }).waitFor();
      await summary.getByText('1008.13', { exact: true }).waitFor();
      for (const label of ['已连接账号', '可用余额', '刷新余额']) {
        assert.equal(await card.getByText(label, { exact: true }).count(), 0);
        assert.equal(await card.getByRole('button', { name: label, exact: true }).count(), 0);
      }
      assert.equal(await card.getByText('fixture-user', { exact: true }).count(), 1);
      assert.equal(await page.getByText(/^已保存 RouterGo/).count(), 0);
      const recharge = summary.getByRole('link', { name: '充值' });
      assert.equal(await recharge.getAttribute('href'), 'https://routergo.cn/workbench/recharge');
      assert.equal(await recharge.locator('.cmd-ui-icon').count(), 1);
      if (width === 390) {
        const session = await context.newCDPSession(page);
        await session.send('Emulation.setTouchEmulationEnabled', { enabled: true });
      }
      const wallet = summary.locator('.cmd-routergo-wallet');
      const iconBox = await wallet.locator('.cmd-ui-icon').boundingBox();
      const amountBox = await wallet.locator('.cmd-routergo-amount').boundingBox();
      const centerY = box => box.y + box.height / 2;
      assert(Math.abs(centerY(amountBox) - centerY(iconBox)) <= 1);
      assert(amountBox.x > iconBox.x + iconBox.width);
      const [avatarBox, nameBox, usernameBox] = await Promise.all([
        summary.locator('.cmd-routergo-avatar').boundingBox(),
        summary.getByText('测试账号', { exact: true }).boundingBox(),
        summary.getByText('fixture-user', { exact: true }).boundingBox(),
      ]);
      assert(Math.abs(centerY(avatarBox) - centerY(usernameBox)) <= 2);
      assert(usernameBox.x > nameBox.x && nameBox.x > avatarBox.x);
      assert.equal(await summary.locator('.cmd-routergo-amount strong').evaluate(node => getComputedStyle(node).fontSize), '14px');
      assert.match(await card.evaluate(node => getComputedStyle(node).backgroundImage), /^linear-gradient\(/);
      balanceFails = true;
      await page.clock.install({ time: new Date(Date.now() + 4000) });
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await summary.getByRole('status', { name: 'RouterGo 额度读取失败' }).waitFor();
      await summary.getByText('1008.13', { exact: true }).waitFor();
      await page.getByRole('alert').getByText('暂时无法读取 RouterGo 余额，请重试').waitFor();
      if (screenshots) await page.screenshot({ path: join(screenshots, `routergo-balance-error-${width}.png`) });
      balanceFails = false;
      balance = '22.5';
      await page.clock.fastForward(4000);
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await summary.getByText('22.50', { exact: true }).waitFor();
      const sync = summary.getByRole('button', { name: '同步模型' });
      assert.equal(await sync.locator('.cmd-ui-icon').count(), 1);
      await sync.click();
      await page.getByRole('alert').getByText('暂时无法同步 RouterGo 模型，已保留现有列表').waitFor();
      syncFails = false;
      await sync.click();
      await page.getByRole('alert').getByText('新增 1、更新 2、移除 3').waitFor();
      assert.equal(await brand.locator('img').evaluate(image => getComputedStyle(image).filter), 'none');
      assert.deepEqual(actions.filter(input => input.action === 'save'), [{ action: 'save', id: 'local-id', replace: true }, { action: 'save', id: 'local-id', replace: true }]);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (screenshots) await page.screenshot({ path: join(screenshots, `routergo-connected-${width}.png`) });
      const edit = card.getByRole('button', { name: /^编辑 RouterGo/ });
      assert.equal((await edit.textContent()).trim(), '模型');
      await edit.click();
      await card.getByRole('button', { name: '模型选项 1', exact: true }).waitFor();
      for (const name of ['API 密钥', 'API 地址', '显示名称']) {
        assert.equal(await card.getByRole('textbox', { name, exact: true }).count(), 0);
      }
      assert.equal(await card.getByRole('button', { name: '高级连接设置' }).count(), 0);
      assert.equal(await card.getByRole('button', { name: '改用 API 密钥' }).count(), 0);
      await edit.click();
      await card.getByRole('button', { name: /^删除 RouterGo/ }).click();
      await page.getByRole('dialog').getByRole('button', { name: /^删除 RouterGo/ }).last().click();
      await card.getByRole('button', { name: '使用密钥' }).click();
      await page.getByRole('textbox', { name: 'API 密钥', exact: true }).waitFor();
      await context.close();
    }
  } finally {
    await browser.close();
  }
});

test('RouterGo manual credentials can batch-add from an empty model list and recover a missing key', { skip: !executablePath && 'Chromium/Edge required' }, async () => {
  const html = await fixture();
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
    await page.route('http://localhost/', route => route.fulfill({ contentType: 'text/html', body: html }));
    const ids = ['Opaque/Route:a', 'Opaque/Route:A', 'fixture/speech', 'fixture-embedding-2', 'fixture/video'];
    const publicRows = [
      { model_id: ids[0], vendor_name: 'DeepSeek', context: 50000, input_modalities: ['text', 'image'], output_modalities: ['text'], thinking_levels: ['high'] },
      { model_id: ids[1], vendor_name: 'OpenAI', output_modalities: ['image'] },
      { model_id: ids[2], vendor_name: 'OpenAI', output_modalities: ['audio'] },
      { model_id: ids[3], output_modalities: ['text'] },
      { model_id: ids[4], output_modalities: ['video'] },
    ];
    await page.route('**/api/commander/tooling', async route => {
      if (route.request().postDataJSON().action === 'modelProfiles') {
        await new Promise(resolve => setTimeout(resolve, 400));
        return route.fulfill({ json: { success: true, data: publicRows } });
      }
      return route.fulfill({ json: { models: [], overrides: [] } });
    });
    await page.goto('http://localhost/');
    await page.evaluate(ids => { window.fixtureModels = ids.map(id => ({ id, name: id, contextWindow: 24000, inputModalities: ['text'] })); window.routerScenario('missing'); }, ids);
    const router = page.getByRole('listitem').filter({ hasText: 'RouterGo' });
    await router.getByRole('button', { name: '使用密钥' }).click();
    await page.getByRole('textbox', { name: 'API 密钥', exact: true }).fill('manual-example');
    await page.getByRole('button', { name: '获取模型' }).click();
    const picker = page.getByRole('dialog', { name: '选择模型' });
    for (const id of ids) assert(await picker.getByRole('checkbox', { name: id, exact: true }).isChecked());
    await picker.getByRole('button', { name: '更新列表' }).click();
    await page.getByRole('button', { name: '创建提供商' }).click();
    await router.getByRole('button', { name: /^编辑 RouterGo/ }).click();
    const persisted = await page.evaluate(() => ({ discovery: window.discoveries[0], written: window.writes[0].ops[0].value.models }));
    assert.deepEqual(persisted, {
      discovery: { ns: 'llm-pi-ai', options: { api: 'openai-responses', baseURL: 'https://routergo.cn/api/v1', apiKey: 'manual-example' } },
      written: [
        { id: ids[0], name: ids[0], contextWindow: 50000, input: ['text', 'image'], reasoningEfforts: { off: null, high: 'high' } },
        ...ids.slice(1).map(id => ({ id, name: id, contextWindow: 24000, input: ['text'] })),
      ],
    });
    const options = index => router.getByRole('button', { name: '模型选项 ' + index, exact: true });
    const search = router.getByRole('searchbox', { name: '搜索模型目录' });
    const vendorGroup = router.getByRole('group', { name: '模型厂商' });
    const openAI = vendorGroup.getByRole('button', { name: 'OpenAI', exact: true });
    await openAI.waitFor();
    assert.equal(await vendorGroup.innerText(), '');
    assert.equal(await vendorGroup.getByRole('button').count(), 2);
    assert(await openAI.locator('img').evaluate(img => img.complete && img.naturalWidth > 0));
    await openAI.click();
    assert.deepEqual(await router.locator('.cmd-model-row-summary span').allInnerTexts(), [ids[1], ids[2]]);
    await router.getByRole('button', { name: '语音模型', exact: true }).click();
    assert.deepEqual(await router.locator('.cmd-model-row-summary span').allInnerTexts(), [ids[2]]);
    await search.fill('ROUTE');
    await router.getByRole('status').getByText('没有匹配的模型').waitFor();
    await search.fill('speech');
    await options(3).waitFor();
    await search.clear();
    await router.getByRole('button', { name: '语音模型', exact: true }).click();
    await openAI.click();
    assert.equal(await router.getByRole('textbox', { name: '模型 ID 1' }).count(), 0);
    assert.equal(await router.getByText('已自定义模型目录', { exact: true }).count(), 0);
    await search.fill('图片输入');
    await options(2).waitFor({ state: 'hidden' });
    assert.equal(await options(1).count(), 1);
    await search.clear();
    await options(2).waitFor();
    const narrowFirst = await options(1).boundingBox();
    const narrowSecond = await options(2).boundingBox();
    assert.equal(narrowFirst.x, narrowSecond.x);
    assert(narrowSecond.y > narrowFirst.y);
    await search.fill('no-matching-model');
    await router.getByRole('status').getByText('没有匹配的模型').waitFor();
    await search.fill('route:A');
    await options(2).waitFor();
    await search.clear();
    const categoryButtons = router.getByRole('group', { name: '模型分类' }).getByRole('button');
    assert.equal(await categoryButtons.count(), 5);
    for (const [index, label] of ['大语言模型', '图片生成与编辑模型', '语音模型', '知识库模型', '视频模型'].entries()) {
      const category = categoryButtons.and(router.getByRole('button', { name: label, exact: true }));
      await category.click();
      await options(index + 1).waitFor();
      assert.deepEqual(await router.locator('.cmd-model-row-summary span').allInnerTexts(), [ids[index]]);
      assert.equal(await category.getAttribute('aria-pressed'), 'true');
      await category.click();
    }
    await options(1).click();
    assert.equal(await router.getByRole('textbox', { name: '模型 ID 1' }).inputValue(), ids[0]);
    await options(2).click();
    assert.equal(await router.getByRole('textbox', { name: '模型 ID 2' }).inputValue(), ids[1]);
    const name = router.getByRole('textbox', { name: '显示名称 2' });
    await name.fill('Alternate display name');
    await options(2).click();
    await options(1).click();
    await page.setViewportSize({ width: 1440, height: 800 });
    const [searchBox, actionsBox, catalogBox, vendorBox] = await Promise.all([
      search.boundingBox(), router.locator('.cmd-model-list-actions').boundingBox(),
      router.getByRole('region', { name: '模型目录', exact: true }).boundingBox(), vendorGroup.boundingBox(),
    ]);
    assert(actionsBox.x - (searchBox.x + searchBox.width) <= 8);
    assert(Math.abs(catalogBox.x + catalogBox.width - (actionsBox.x + actionsBox.width)) <= 2);
    assert(vendorBox.y >= searchBox.y + searchBox.height);
    const discovery = router.getByRole('button', { name: '获取模型', exact: true });
    assert.equal(await discovery.locator('svg').count(), 0);
    assert.equal((await discovery.boundingBox()).height, 28);
    const wideFirst = await options(1).boundingBox();
    const wideSecond = await options(2).boundingBox();
    assert.equal(wideFirst.y, wideSecond.y);
    assert(wideSecond.x > wideFirst.x);
    const modelRows = router.locator('[data-row-key]:has(.cmd-model-row-summary)');
    const assertCompactGrid = async () => {
      const [first, second] = await Promise.all([modelRows.nth(0).boundingBox(), modelRows.nth(1).boundingBox()]);
      assert(first.height <= 38 && second.height <= 38);
      assert(second.x - (first.x + first.width) >= 5);
    };
    await assertCompactGrid();
    await search.fill('alternate display');
    await options(1).waitFor({ state: 'hidden' });
    await search.clear();
    await options(1).waitFor();
    const secondRow = options(2).locator('xpath=ancestor::*[@data-row-key]');
    const secondRowBox = await secondRow.boundingBox();
    await router.getByRole('button', { name: '调整模型顺序 1', exact: true }).dragTo(secondRow, {
      targetPosition: { x: secondRowBox.width - 5, y: 4 },
    });
    assert.equal(await options(1).locator('span').innerText(), 'Alternate display name');
    assert.equal(await options(2).locator('span').innerText(), ids[0]);
    await assertCompactGrid();
    if (process.env.BENCHGO_PROVIDER_SCREENSHOTS) {
      await page.screenshot({ path: join(process.env.BENCHGO_PROVIDER_SCREENSHOTS, 'model-catalog-grid-1440.png') });
    }
    await router.getByRole('button', { name: /^编辑 RouterGo/ }).click();
    await page.evaluate(() => window.routerScenario('invalid'));
    assert.equal(await router.locator('img').evaluate(image => getComputedStyle(image).filter), 'none');
    assert.equal(await router.getByRole('button', { name: '登录 RouterGo' }).isEnabled(), true);
    await router.getByRole('button', { name: /^编辑 RouterGo/ }).click();
    await router.getByRole('textbox', { name: 'API 密钥', exact: true }).waitFor();
  } finally { await browser.close(); }
});
