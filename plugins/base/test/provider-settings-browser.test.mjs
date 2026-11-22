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
    const protocols=['openai-completions','openai-responses','anthropic-messages','google-generative-ai'];
    const schema={getPath,hasPath:(value,path)=>getPath(value,path)!==undefined,rehydrate:value=>value,
      nodeAtPath:(root,path)=>path.at(-1)==='api'?{type:'union',list:protocols.map(value=>({value}))}:getPath(root?.dict,path)??{meta:{}},validate:()=>undefined,
      setPath(value,path,next){const copy=structuredClone(value);let at=copy;for(const key of path.slice(0,-1))at=at[key]??={};at[path.at(-1)]=next;return copy;},
      deletePath(value,path){const copy=structuredClone(value);let at=copy;for(const key of path.slice(0,-1))at=at[key];delete at[path.at(-1)];return copy;}};
    const officialPresets={stepfun:'StepFun',openai:'OpenAI',anthropic:'Anthropic','kimi-coding':'Kimi Coding','xiaomi-token-plan-cn':'小米 Token 套餐'};
    const rows=()=>[...new Set([...Object.keys(officialPresets),...Object.keys(namespace.value.providers)])].map(id=>({entry:{provider:id,
      displayName:namespace.value.providers[id]?.displayName??officialPresets[id]??(id==='routergo'?'RouterGo':id),
      settingsNs:'llm-pi-ai',settingsPath:['providers',id],active:true,declared:!Object.hasOwn(officialPresets,id)},
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
    window.officialScenario = (source, models = [{id:'opaque/deepseek:model'}]) => {
      official={ns:'llm-deepseek',user:{apiKeyEnv:'SHARED_DEEPSEEK',models},base:{},schema:{},revision:3};
      official.value=structuredClone(official.user);
      keys.clear();
      if(source)keys.set('SHARED_DEEPSEEK',source);
      window.setScenario('data');
    };
    window.getOfficial=()=>({apiKeyEnv:official.value.apiKeyEnv,models:official.user.models,keys:[...keys.keys()]});
    window.loads=0; window.writes=[]; window.discoveries=[];
    window.savedProviders = () => structuredClone(namespace.user.providers);
    window.seedProvider = (id, provider) => {
      namespace.user.providers[id] = provider;
      namespace.value = structuredClone(namespace.user);
      window.setScenario('data');
    };
    const controller={store:{getSnapshot:()=>state},async load(){window.loads++;publish({...state,status:'loading'});await new Promise(resolve=>setTimeout(resolve,80));publish({...state,status:'ready',rows:rows(),namespaces:namespaces()});}};
    const operations={async writeSettings(ns,ops,revision){if(ns===official?.ns){window.writes.push({ns,ops,revision});for(const op of ops){if(op.op==='set')official.user=schema.setPath(official.user,op.path,op.value);}official.value=structuredClone(official.user);official.revision++;return{kind:'written',view:official};}window.writes.push({ns,ops});for(const op of ops){if(op.op==='set')namespace.user=schema.setPath(namespace.user,op.path,op.value);else if(op.op==='unset')namespace.user=schema.deletePath(namespace.user,op.path);}namespace.value=structuredClone(namespace.user);namespace.revision++;return{kind:'written',view:namespace};},async storeCredential(ref){
      if (window.failCredentialOnce) { window.failCredentialOnce = false; window.setScenario('data'); return '凭据暂时无法写入'; }
      keys.set(ref,'file');
    },async removeCredential(ref){keys.delete(ref);},async discoverModels(ns,options){
      window.discoveries.push({ns,options});
      await window.discoveryGate;
      if (window.discoveryFailure) throw Error(window.discoveryFailure);
      return {kind:'found',models:window.fixtureModels??[]};
    }};
    const useSnapshot=selector=>selector(React.useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn);},()=>state));
    window.setScenario('loading');
    function App() {
      const [activeId, select] = React.useState('models');
      const rows = [{id:'general',label:'通用设置'}, {id:'models',label:'模型'}, {id:'harness-tools',label:'Harness 工具'}];
      const renderSlot = (name, props, filter) => {
        if (name === 'settings.header') return '设置';
        if (name === 'settings.close') return '关闭设置';
        return filter?.fallback ?? null;
      };
      const renderFactorySlot = (name, props) => name === 'settings.section.view' && props.id === 'models'
        ? <ModelsSection controller={controller} useSnapshot={useSnapshot} operations={operations} schema={schema} t={key=>zh[key]??key} renderSlot={()=>null}/>
        : null;
      return <><style>{tokens}{base}{hostCss}{mobileCss}</style><main><h1>BenchGo</h1><SettingsRoot wide t={key=>key} renderSlot={renderSlot} renderFactorySlot={renderFactorySlot} reconnect={()=>{}}
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

test('DashScope template adds two independent connections and preserves models on reload', { skip: !executablePath && 'Chromium/Edge required' }, async () => {
  const html = await fixture(), browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 800 }, hasTouch: true });
    page.setDefaultTimeout(6000);
    await page.route('**/*', route => route.request().url() === 'http://localhost/'
      ? route.fulfill({ contentType: 'text/html', body: html })
      : route.fulfill({ json: {} }));
    await page.goto('http://localhost/');
    await page.evaluate(() => {
      window.fixtureModels = ['qwen-flash', 'other/model:Exactly'].map(id => ({ id, name: id }));
      window.setScenario('data');
    });
    const add = page.getByRole('button', { name: '添加模型提供商' });
    const search = page.getByRole('searchbox', { name: '搜索厂商' });
    const baseUrl = page.getByRole('textbox', { name: 'API 地址', exact: true });
    const name = page.getByRole('textbox', { name: '显示名称', exact: true });
    const workspace = 'https://ws-example.cn-beijing.maas.aliyuncs.com';
    const cases = [
      { name: '百炼 · 团队', address: workspace, expected: workspace + '/compatible-mode/v1', key: 'example-team-key' },
      { name: '百炼 · 备用', address: 'https://fixture.example/custom/v1', expected: 'https://fixture.example/custom/v1', key: 'example-backup-key' },
    ];
    for (const [index, connection] of cases.entries()) {
      await add.click();
      await search.fill('no-vendor-match');
      await page.getByRole('status').getByText('没有匹配的厂商').waitFor();
      await search.fill('DashScope');
      await page.getByRole('button', { name: '阿里云百炼', exact: true }).click();
      await name.fill(connection.name);
      await baseUrl.fill(connection.address);
      const key = page.getByLabel('API 密钥', { exact: true });
      const discover = page.getByRole('button', { name: '同步模型' });
      assert.equal(await key.getAttribute('required'), '');
      assert.equal(await discover.isEnabled(), false);
      await key.fill(connection.key);
      assert.equal(await baseUrl.inputValue(), connection.expected);
      await discover.click();
      const picker = page.getByRole('region', { name: '选择模型' });
      const qwen = picker.getByRole('checkbox', { name: 'qwen-flash', exact: true });
      assert.equal(await qwen.isChecked(), false);
      assert.equal(await page.getByRole('dialog').count(), 1);
      assert.equal(await page.getByRole('searchbox', { name: '搜索模型目录' }).count(), 1);
      await page.getByRole('searchbox', { name: '搜索模型目录' }).click();
      await qwen.check();
      await picker.getByRole('button', { name: '更新列表' }).click();
      await picker.waitFor({ state: 'detached' });
      assert.equal(await discover.evaluate(button => document.activeElement === button), true);
      const searchModel = page.getByRole('searchbox', { name: '搜索模型目录' });
      assert((await searchModel.boundingBox()).width >= 80);
      if (process.env.BENCHGO_PROVIDER_SCREENSHOTS && index === 0) {
        await mkdir(process.env.BENCHGO_PROVIDER_SCREENSHOTS, { recursive: true });
        await name.scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(process.env.BENCHGO_PROVIDER_SCREENSHOTS, 'dashscope-form-390.png') });
      }
      const create = page.getByRole('button', { name: '创建提供商' });
      if (index === 0) {
        await page.evaluate(() => { window.failCredentialOnce = true; });
        await create.click();
        await page.getByRole('alert').getByText('凭据暂时无法写入').waitFor();
        assert.equal(await page.evaluate(() => window.writes.length), 1);
      }
      await create.click();
      await page.getByRole('listitem').filter({ hasText: connection.name }).waitFor();
    }
    const { providers, discoveries } = await page.evaluate(() => ({ providers: window.savedProviders(), discoveries: window.discoveries }));
    assert.deepEqual(discoveries.map(({ options }) => options), cases.map(row => ({
      baseURL: row.expected, api: 'openai-completions', apiKey: row.key,
    })));
    const connections = Object.entries(providers).filter(([id]) => id.startsWith('benchgo-dashscope-'));
    assert.equal(connections.length, 2);
    assert.equal(new Set(connections.map(([, provider]) => provider.apiKeyEnv)).size, 2);
    for (const [index, [id, provider]] of connections.entries()) {
      assert.match(id, /^benchgo-dashscope-[0-9a-f]{32}$/u);
      assert.equal(provider.baseURL, cases[index].expected);
      assert.deepEqual(provider.models.map(model => model.id), ['qwen-flash']);
    }
    await page.evaluate(() => window.remount());
    const primary = page.getByRole('listitem').filter({ hasText: cases[0].name });
    await primary.getByRole('button', { name: /^编辑 百炼 · 团队/ }).click();
    assert.equal((await primary.getByRole('button', { name: 'API 协议', exact: true }).innerText()).trim(), 'OpenAI Chat Completions');
    assert.equal(await primary.getByRole('button', { name: '高级连接设置', exact: true }).count(), 0);
    await primary.getByRole('textbox', { name: '显示名称', exact: true }).fill('百炼 · 工作');
    const editedAddress = 'https://ws-edited.cn-beijing.maas.aliyuncs.com';
    await primary.getByRole('textbox', { name: 'API 地址', exact: true }).fill(editedAddress);
    await primary.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('listitem').filter({ hasText: '百炼 · 工作' }).waitFor();
    assert.equal(await page.evaluate(id => window.savedProviders()[id].baseURL, connections[0][0]), editedAddress + '/compatible-mode/v1');
    assert.deepEqual(await page.evaluate(id => window.savedProviders()[id], connections[1][0]), connections[1][1]);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  } finally { await browser.close(); }
});

test('DeepSeek official connections can be removed without altering the shared credential or stored models', { skip: !executablePath && 'Chromium/Edge required' }, async () => {
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
      assert.equal(await page.getByRole('group', { name: '厂商模板' }).getByRole('button', { name: 'DeepSeek', exact: true }).count(), 0);
      await page.getByRole('button', { name: '关闭添加供应商' }).click();
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
          { model_id: 'opaque/router:model', input_modalities: ['text', 'image', 'audio', 'video'], output_modalities: ['text'] },
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
        else if(scenario==='empty')await page.getByRole('button',{name:'添加模型提供商'}).waitFor();
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
      const add = page.locator('.cmd-provider-add-heading');
      const closeAdd = add.getByRole('button', { name: '关闭添加供应商' });
      const bounds = await Promise.all([add.getByRole('heading').boundingBox(), closeAdd.boundingBox()]);
      assert(bounds[0].y < bounds[1].y + bounds[1].height && bounds[1].y < bounds[0].y + bounds[0].height);
      const templates = page.getByRole('group', { name: '厂商模板' });
      assert.equal(await templates.getByRole('button').count(), 22);
      for (const [name, brand] of [
        ['New API', 'new-api'], ['Sub2API', 'sub2api'], ['讯飞星火', 'spark'], ['百度千帆', 'qianfan'],
        ['月之暗面 Kimi', 'kimi'], ['OpenAI', 'openai'], ['Anthropic', 'anthropic'], ['OpenCode', 'opencode'],
        ['Google Gemini', 'google'], ['Meta', 'meta'], ['NVIDIA', 'nvidia'], ['Hugging Face', 'huggingface'],
        ['Mistral', 'mistral'], ['智谱 Z.ai', 'zhipu'],
      ]) {
        const image = templates.getByRole('button', { name, exact: true }).locator(`[data-provider-brand="${brand}"] img`);
        assert(await image.evaluate(async node => { await node.decode(); return node.naturalWidth > 0; }));
      }
      assert.equal(await page.getByRole('group', { name: '其他接入方式' }).count(), 0);
      for (const name of ['RouterGo', 'Kimi Coding', '小米 Token 套餐']) {
        assert.equal(await templates.getByRole('button', { name, exact: true }).count(), 0);
      }
      assert.equal(await templates.getByRole('button', { name: '自定义供应商', exact: true }).count(), 1);
      if(screenshots) await page.screenshot({path:join(screenshots,'provider-templates-'+width+'-'+dark+'.png')});
      await closeAdd.click();
      assert.equal(await page.locator('#commander-official-models-style').count(),1);
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      const router = page.getByRole('listitem').filter({hasText:'RouterGo'});
      const first = await router.boundingBox();
      if(screenshots) await page.screenshot({path:join(screenshots,`providers-${width}-${dark?'dark':'light'}.png`)});
      await router.getByRole('button',{name:/^编辑 RouterGo/}).click();
      if(width > 1000) assert.equal((await router.boundingBox()).width, first.width);
      const endpoint=router.getByRole('textbox',{name:'API 地址',exact:true});
      const protocol=router.getByRole('button',{name:'API 协议',exact:true});
      const protocolMenu=page.getByRole('listbox',{name:'API 协议'});
      assert(await router.getByRole('textbox',{name:'API 密钥',exact:true}).isVisible());
      assert.equal(await endpoint.inputValue(),'https://router.example/v1');
      assert(await protocol.isVisible());
      assert.equal(await router.getByRole('button', {name:'高级连接设置',exact:true}).count(),0);
      assert.equal((await protocol.innerText()).trim(),'OpenAI Chat Completions');
      assert.equal(await router.getByText('自定义设置',{exact:true}).count(),0);
      assert.equal(await router.locator('select[aria-label="API 协议"]').count(),0);
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
      assert.equal((await protocol.innerText()).trim(),'OpenAI 响应');
      await endpoint.fill('https://edited.example/v1');
      const modelActions = router.locator('.cmd-model-catalog-tools .cmd-model-list-actions');
      const save = router.getByRole('button', { name: '保存', exact: true });
      assert.deepEqual((await modelActions.getByRole('button').allTextContents()).map(value=>value.trim()), ['同步模型', '']);
      const optimize = modelActions.getByRole('button', { name: '上下文窗口优化' });
      const computedPaint = node => ({ background: getComputedStyle(node).backgroundColor, shadow: getComputedStyle(node).boxShadow });
      assert.deepEqual(await optimize.evaluate(computedPaint), { background: 'rgba(0, 0, 0, 0)', shadow: 'none' });
      const [saveBox, discoverBox, optimizeBox] = await Promise.all([
        save.boundingBox(),
        modelActions.getByRole('button', { name: '同步模型' }).boundingBox(), optimize.boundingBox(),
      ]);
      assert.equal(optimizeBox.height, discoverBox.height);
      assert.equal(optimizeBox.height, saveBox.height);
      assert.equal(optimizeBox.y, discoverBox.y);
      assert(optimizeBox.y >= saveBox.y + saveBox.height);
      await optimize.hover();
      const hoverPaint = await optimize.evaluate(computedPaint);
      assert.equal(hoverPaint.background, 'rgba(0, 0, 0, 0)');
      assert.notEqual(hoverPaint.shadow, 'none');
      if (screenshots) await page.screenshot({path:join(screenshots,`context-trigger-${width}-${dark?'dark':'light'}.png`),animations:'disabled'});
      assert.equal(await modelActions.getByRole('button', { name: '同步模型' }).locator('svg').count(), 0);
      assert.equal(await modelActions.getByRole('button', { name: '同步模型' }).evaluate(node => getComputedStyle(node).borderRadius),
        await save.evaluate(node => getComputedStyle(node).borderRadius));
      await modelActions.getByRole('button',{name:'同步模型'}).click();
      assert.deepEqual(await page.evaluate(()=>window.discoveries.at(-1)),{ns:'llm-pi-ai',options:{provider:'routergo',baseURL:'https://edited.example/v1',api:'openai-responses'}});
      await router.getByText('该提供商没有列出任何模型，请手动添加。', { exact: true }).waitFor();
      await page.evaluate(() => {
        window.discoveryFailure = '目录暂不可用';
        window.discoveryGate = new Promise(resolve => { window.finishDiscovery = resolve; });
      });
      await modelActions.getByRole('button', { name: '同步模型' }).click();
      assert(await modelActions.getByRole('button', { name: '正在同步…' }).isDisabled());
      await page.evaluate(() => window.finishDiscovery());
      await router.getByRole('alert').getByText('目录暂不可用').waitFor();
      await page.evaluate(() => {
        window.discoveryFailure = undefined;
        window.fixtureModels = [{ id: 'opaque/New:Model' }];
      });
      await modelActions.getByRole('button', { name: '同步模型' }).click();
      const candidates = router.getByRole('region', { name: '选择模型' });
      await candidates.getByRole('checkbox', { name: 'opaque/New:Model' }).waitFor();
      assert.equal(await page.getByRole('dialog').count(), 1);
      await candidates.getByRole('button', { name: '取消' }).click();
      await candidates.waitFor({ state: 'detached' });
      await page.evaluate(() => { window.fixtureModels = undefined; });
      await router.getByRole('button',{name:'保存',exact:true}).click();
      await endpoint.waitFor({state:'detached'});
      await page.waitForFunction(()=>window.loads===1);
      assert.deepEqual(await page.evaluate(()=>window.writes[0]),{ns:'llm-pi-ai',ops:[
        {op:'set',path:['providers','routergo','api'],value:'openai-responses'},
        {op:'set',path:['providers','routergo','baseURL'],value:'https://edited.example/v1'},
        {op:'set',path:['providers','routergo','models'],value:[{id:'opaque/router:model',input:['text','image']}]},
      ]});
      await router.getByRole('button',{name:/^编辑 RouterGo/}).click();
      assert.equal(await endpoint.inputValue(),'https://edited.example/v1');
      assert.equal((await protocol.innerText()).trim(),'OpenAI 响应');
      await router.getByRole('button',{name:'模型选项 1',exact:true}).click();
      assert.equal(await router.getByRole('textbox',{name:'模型 ID 1',exact:true}).inputValue(),'opaque/router:model');
      const inputs = router.getByRole('group', { name: '输入类型 1' });
      await inputs.getByRole('checkbox', { name: '音频' }).waitFor();
      for (const name of ['音频', '视频']) {
        const modality = inputs.getByRole('checkbox', { name });
        assert(await modality.isChecked());
        assert(await modality.isDisabled());
      }
      const pdf = inputs.getByRole('checkbox', { name: 'PDF', exact: true });
      const text = inputs.getByRole('checkbox', { name: '文本', exact: true });
      assert.equal(await pdf.isChecked(), false);
      assert(await pdf.isDisabled());
      assert(await text.isChecked());
      assert(await text.isDisabled());
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
      await page.getByRole('button',{name:'自定义供应商',exact:true}).click();
      const createProtocol=page.getByRole('button',{name:'API 协议',exact:true});
      assert.equal(await page.locator('select[aria-label="API 协议"]').count(),0);
      assert.equal(await page.getByRole('button',{name:'高级连接设置',exact:true}).count(),0);
      assert.equal((await createProtocol.innerText()).trim(),'OpenAI 响应');
      await createProtocol.click();
      await protocolMenu.getByRole('option',{name:'Anthropic Messages'}).click();
      await page.getByRole('textbox',{name:'Provider ID'}).fill('fixture-gateway');
      await page.getByRole('textbox',{name:'API 地址',exact:true}).fill('https://fixture.example');
      await page.getByRole('button',{name:'添加模型',exact:true}).click();
      await page.getByRole('textbox',{name:'模型 ID 1',exact:true}).fill('opaque/gateway:model');
      await page.getByRole('button',{name:'同步模型'}).click();
      assert.deepEqual(await page.evaluate(()=>window.discoveries.at(-1)),{ns:'llm-pi-ai',options:{baseURL:'https://fixture.example',api:'anthropic-messages'}});
      await page.getByRole('button',{name:'创建提供商'}).click();
      const created=page.getByRole('listitem').filter({hasText:'fixture-gateway'});
      await created.getByRole('button',{name:/^编辑 fixture-gateway/}).click();
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
    const inputs = page.getByRole('group', { name: '输入类型 1' });
    const text = page.locator('.cmd-model-capabilities').getByRole('button', { name: '文本', exact: true });
    assert.equal(await inputs.count(), 0);
    await text.click();
    await inputs.waitFor();
    assert.deepEqual(override, ['image-generation', 'text']);
    await text.click();
    await inputs.waitFor({ state: 'hidden' });
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

test('DashScope vision and speech settings use the exact model IDs and save independently of model discovery', { skip: !executablePath && 'Chromium/Edge required' }, async () => {
  const html = await fixture();
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
    page.setDefaultTimeout(6000);
    const providerId = 'benchgo-dashscope-test';
    const vision = 'qwen3.8-flash', asr = 'qwen-audio-3.0-asr-flash', tts = 'qwen3-tts-flash';
    const overrides = new Map();
    let releaseDirectory;
    const directory = new Promise(resolve => { releaseDirectory = resolve; });
    await page.route('http://localhost/', route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.route('**/api/commander/tooling', async route => {
      const input = route.request().postDataJSON();
      if (input.action === 'modelProfiles') return route.fulfill({ json: { success: true, data: [
        { model_id: vision, input_modalities: ['text', 'image', 'video'], output_modalities: ['text'] },
      ] } });
      assert.equal(input.providerId, providerId);
      if (input.action === 'models') { await directory; return route.fulfill({ json: { models: [] } }); }
      if (input.action === 'modelCapabilities') return route.fulfill({ json: {
        overrides: [...overrides].map(([modelId, capabilities]) => ({ modelId, capabilities })),
      } });
      assert.equal(input.action, 'saveModelCapabilities');
      overrides.set(input.modelId, input.capabilities);
      return route.fulfill({ json: { modelId: input.modelId, capabilities: input.capabilities } });
    });
    await page.goto('http://localhost/');
    await page.evaluate(({ providerId, vision, asr, tts }) => window.seedProvider(providerId, {
      displayName: '阿里云百炼', api: 'openai-completions', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      models: [{ id: vision, input: ['text', 'image'] }, { id: asr }, { id: tts }],
    }), { providerId, vision, asr, tts });
    const edit = page.getByRole('button', { name: /^编辑 阿里云百炼/ });
    const option = number => page.getByRole('button', { name: `模型选项 ${number}`, exact: true });
    await edit.click();
    await option(1).click();
    const image = page.getByRole('group', { name: '输入类型 1' }).getByRole('checkbox', { name: '图片' });
    await image.waitFor();
    assert(await image.isChecked());
    await option(1).click();
    for (const [number, id, label, capability] of [[2, asr, '语音识别', 'asr'], [3, tts, '语音合成', 'tts']]) {
      await option(number).click();
      const tag = page.getByRole('button', { name: label, exact: true });
      await tag.click();
      await page.locator('.cmd-model-capabilities[aria-busy=false]').waitFor();
      assert.equal(await tag.getAttribute('aria-pressed'), 'true');
      assert.deepEqual(overrides.get(id), [capability]);
      await option(number).click();
    }
    releaseDirectory();
    await edit.click();
    await edit.click();
    await option(3).click();
    await page.getByRole('button', { name: '语音合成', exact: true, pressed: true }).waitFor();
  } finally {
    await browser.close();
  }
});

test('editing one model collapses the previous model without losing its draft', { skip: !executablePath && 'Chromium/Edge required' }, async () => {
  const html = await fixture();
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    for (const width of [390, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 800 } });
      page.setDefaultTimeout(6000);
      await page.route('**/*', route => route.request().url() === 'http://localhost/'
        ? route.fulfill({ contentType: 'text/html', body: html })
        : route.fulfill({ json: { success: true, data: [], models: [], overrides: [] } }));
      await page.goto('http://localhost/');
      await page.evaluate(dark => {
        document.body.toggleAttribute('data-ds-dark-theme', dark);
        const models = [{ id: 'First/Model' }, { id: 'Second/Model' }];
        window.officialScenario('file', models);
        window.seedProvider('benchgo-dashscope-test', {
          displayName: '阿里云百炼', api: 'openai-completions', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models,
        });
      }, width === 390);
      for (const name of ['阿里云百炼', 'DeepSeek']) {
        const card = page.getByRole('listitem').filter({ hasText: name });
        const edit = card.getByRole('button', { name: new RegExp('^编辑 ' + name) });
        const option = position => card.getByRole('button', { name: `模型选项 ${position}`, exact: true });
        const id = position => card.getByRole('textbox', { name: `模型 ID ${position}`, exact: true });
        await edit.click();
        await option(1).click();
        await id(1).fill('First/Edited');
        await option(2).press('Enter');
        assert.equal(await option(1).getAttribute('aria-expanded'), 'false');
        assert.equal(await option(2).getAttribute('aria-expanded'), 'true');
        assert.equal(await id(1).count(), 0);
        assert.equal(await id(2).inputValue(), 'Second/Model');
        assert(await option(2).evaluate(node => node === document.activeElement));
        if (name === '阿里云百炼' && process.env.BENCHGO_PROVIDER_SCREENSHOTS) {
          await mkdir(process.env.BENCHGO_PROVIDER_SCREENSHOTS, { recursive: true });
          await page.screenshot({ path: join(process.env.BENCHGO_PROVIDER_SCREENSHOTS, `single-model-${width}.png`), animations: 'disabled' });
        }
        await option(1).click();
        assert.equal(await id(1).inputValue(), 'First/Edited');
        assert.equal(await id(2).count(), 0);
        await card.getByRole('button', { name: '添加模型', exact: true }).click();
        assert.equal(await id(1).count(), 0);
        assert.equal(await id(3).inputValue(), '');
        await option(2).click();
        assert.equal(await id(3).count(), 0);
        await option(3).click();
        assert.equal(await id(3).inputValue(), '');
        await card.getByRole('button', { name: '删除模型 3' }).click();
        assert.equal(await card.locator('.cmd-model-row-summary[aria-expanded="true"]').count(), 0);
        await edit.click();
      }
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test('DeepSeek native sync preserves configured models and saves only new exact IDs', { skip: !executablePath && 'Chromium/Edge required' }, async () => {
  const html = await fixture();
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
    page.setDefaultTimeout(6000);
    const existing = { id: 'opaque/current:V1', name: '本地名称', contextWindow: 400000 };
    const added = { id: 'opaque/New:V2', name: '新模型', inputModalities: ['text', 'image'] };
    let models;
    await page.route('http://localhost/', route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.route('**/api/commander/tooling', route => {
      const request = route.request().postDataJSON();
      if (request.action === 'deepSeekModels') {
        assert.deepEqual(request, { action: 'deepSeekModels', providerId: 'deepseek-official' });
        return models ? route.fulfill({ json: { models } }) : route.fulfill({ status: 502, json: {} });
      }
      return route.fulfill({ json: { success: true, data: [], overrides: [] } });
    });
    await page.goto('http://localhost/');
    await page.evaluate(model => window.officialScenario('file', [model]), existing);
    const card = page.getByRole('listitem').filter({ hasText: 'DeepSeek' });
    const edit = card.getByRole('button', { name: /^编辑 DeepSeek/ });
    await edit.click();
    const actions = card.locator('.cmd-model-catalog-tools');
    const sync = actions.getByRole('button', { name: '同步模型' });
    assert(await actions.getByRole('button', { name: '上下文窗口优化' }).isVisible());
    await sync.click();
    await actions.getByRole('alert').getByText('暂时无法同步 DeepSeek 模型，请重试').waitFor();
    models = [];
    await sync.click();
    await actions.getByRole('status').getByText('未找到可同步的模型').waitFor();
    models = [{ id: existing.id, name: '上游名称' }, added, added];
    await sync.click();
    await actions.getByRole('status').getByText('已添加 1 个模型，请保存').waitFor();
    assert.equal(await page.evaluate(() => window.writes.length), 0);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await card.getByRole('button', { name: '保存', exact: true }).click();
    await page.waitForFunction(() => window.loads === 1);
    assert.deepEqual((await page.evaluate(() => window.getOfficial())).models, [existing, added]);
    await edit.click();
    await sync.click();
    await actions.getByRole('status').getByText('模型目录已是最新').waitFor();
  } finally {
    await browser.close();
  }
});

test('model directory applies only the suggested context window without a retry editor', { skip: !executablePath && 'Chromium/Edge required' }, async () => {
  const html = await fixture();
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    for (const [width, dark] of [[390, false], [390, true], [1440, false], [1440, true]]) {
      const page = await browser.newPage({ viewport: { width, height: 800 } });
      page.setDefaultTimeout(6000);
      const model = { id: 'qwen3.8-flash', contextWindow: 1000000, maxTokens: 131072, input: ['text', 'image'] };
      let directoryAvailable = false;
      await page.route('http://localhost/', route => route.fulfill({ contentType: 'text/html', body: html }));
      await page.route('**/api/commander/tooling', async route => {
        const { action } = route.request().postDataJSON();
        if (action === 'modelProfiles') return directoryAvailable
          ? route.fulfill({ json: { success: true, data: [{ model_id: model.id, context: model.contextWindow, max_output: model.maxTokens }] } })
          : route.fulfill({ status: 503 });
        return route.fulfill({ json: { models: [], overrides: [] } });
      });
      await page.goto('http://localhost/');
      await page.evaluate(dark => { document.body.toggleAttribute('data-ds-dark-theme', dark); window.setScenario('empty'); }, dark);
      const operations = page.getByRole('button', { name: '模型运维设置' });
      assert.equal(await operations.count(), 0);
      await page.evaluate(model => window.seedProvider('benchgo-dashscope-example', {
        displayName: '阿里云百炼', api: 'openai-completions', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: [model],
      }), model);
      const provider = page.getByRole('listitem').filter({ hasText: '阿里云百炼' });
      await provider.getByRole('button', { name: /^编辑 阿里云百炼/ }).click();
      assert.equal(await provider.getByText('重试策略', { exact: true }).count(), 0);
      assert.equal(await operations.count(), 0);
      if (process.env.BENCHGO_PROVIDER_SCREENSHOTS) {
        await mkdir(process.env.BENCHGO_PROVIDER_SCREENSHOTS, { recursive: true });
      }

      const optimize = provider.getByRole('button', { name: '上下文窗口优化' });
      if (!await optimize.isVisible()) await provider.getByRole('button', { name: /^编辑 阿里云百炼/ }).click();
      await optimize.click();
      const context = page.getByRole('dialog', { name: '上下文窗口优化' });
      await context.getByRole('alert').getByText('暂时无法读取公开模型目录。').waitFor();
      directoryAvailable = true;
      await context.getByRole('button', { name: '重试' }).click();
      await context.getByText('1,000,000 → 500,000', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.writes.length), 0);
      if (process.env.BENCHGO_PROVIDER_SCREENSHOTS) {
        await page.screenshot({ path: join(process.env.BENCHGO_PROVIDER_SCREENSHOTS, `context-optimization-${width}-${dark ? 'dark' : 'light'}.png`), animations: 'disabled' });
      }
      for (const button of await context.getByRole('button').all()) {
        const box = await button.boundingBox();
        assert(box.x >= 0 && box.x + box.width <= width);
      }
      await context.getByRole('button', { name: '应用到草稿' }).click();
      assert.equal(await page.evaluate(() => window.writes.length), 0);
      await provider.getByRole('button', { name: '保存', exact: true }).click();
      await page.waitForFunction(() => window.loads === 1);
      const saved = await page.evaluate(() => window.savedProviders()['benchgo-dashscope-example']);
      assert.deepEqual(saved.models, [{ ...model, contextWindow: 500000 }]);
      await provider.getByRole('button', { name: /^编辑 阿里云百炼/ }).click();
      await optimize.click();
      await context.getByRole('status').getByText('当前模型没有可应用的上下文调整。').waitFor();
      await page.close();
    }
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
      await page.getByRole('button',{name:'关闭添加供应商'}).click();
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
      assert.equal(await summary.getByRole('button', { name: '同步模型' }).count(), 0);
      const edit = card.getByRole('button', { name: /^编辑 RouterGo/ });
      assert.equal((await edit.textContent()).trim(), '模型');
      await edit.click();
      const sync = card.locator('.cmd-model-catalog-tools').getByRole('button', { name: '同步模型' });
      await sync.click();
      await page.getByRole('alert').getByText('暂时无法同步 RouterGo 模型，已保留现有列表').waitFor();
      syncFails = false;
      await sync.click();
      await page.getByRole('alert').getByText('新增 1、更新 2、移除 3').waitFor();
      assert.equal(await brand.locator('img').evaluate(image => getComputedStyle(image).filter), 'none');
      assert.deepEqual(actions.filter(input => input.action === 'save'), [{ action: 'save', id: 'local-id', replace: true }, { action: 'save', id: 'local-id', replace: true }]);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (screenshots) await page.screenshot({ path: join(screenshots, `routergo-connected-${width}.png`) });
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
    await page.getByRole('button', { name: '同步模型' }).click();
    const picker = page.getByRole('region', { name: '选择模型' });
    for (const id of ids) assert(await picker.getByRole('checkbox', { name: id, exact: true }).isChecked());
    await picker.getByRole('button', { name: '更新列表' }).click();
    await page.getByRole('button', { name: '创建提供商' }).click();
    await router.getByRole('button', { name: /^编辑 RouterGo/ }).click();
    const persisted = await page.evaluate(() => ({ discovery: window.discoveries[0], written: window.writes[0].ops[0].value.models }));
    assert.deepEqual(persisted, {
      discovery: { ns: 'llm-pi-ai', options: { api: 'openai-responses', baseURL: 'https://routergo.cn/api/v1', apiKey: 'manual-example' } },
      written: [
        { id: ids[0], name: ids[0], contextWindow: 50000, input: ['text', 'image'], reasoningEfforts: { high: 'high' } },
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
    assert.equal(await options(1).getAttribute('aria-expanded'), 'false');
    const name = router.getByRole('textbox', { name: '显示名称 2' });
    await name.fill('Alternate display name');
    await options(2).click();
    await page.setViewportSize({ width: 1440, height: 800 });
    const [searchBox, actionsBox, catalogBox, vendorBox] = await Promise.all([
      search.boundingBox(), router.getByRole('button', { name: '保存', exact: true }).boundingBox(),
      router.getByRole('region', { name: '模型目录', exact: true }).boundingBox(), vendorGroup.boundingBox(),
    ]);
    assert(actionsBox.x - (searchBox.x + searchBox.width) <= 8);
    assert(Math.abs(catalogBox.x + catalogBox.width - (actionsBox.x + actionsBox.width)) <= 2);
    assert(vendorBox.y >= searchBox.y + searchBox.height);
    const discovery = router.getByRole('button', { name: '同步模型', exact: true });
    assert.equal(await discovery.locator('svg').count(), 0);
    const syncBox = await discovery.boundingBox();
    assert.equal(syncBox.height, 28);
    assert(Math.abs(vendorBox.y + vendorBox.height / 2 - syncBox.y - syncBox.height / 2) <= 1);
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
