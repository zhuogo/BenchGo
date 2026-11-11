import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { officialModelsUi } from '../scripts/official-models-ui.mjs';
import { officialModelsStore } from '../scripts/official-models-store.mjs';

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
    import {zh} from './deepseek-harness/packages/client/ui-settings-models/src/client/locales.ts';
    import {mountProviderSettings} from './plugins/benchgo/client/provider-settings.jsx';
    let disposers = [];
    const adaptationController={read(){},load(){},ctx:{},schema:{},describeFace:{},store:{getSnapshot:()=>({rows:[]})},generation:0};
    const entry = {options:{id:'models'},children:{'settings.models.provider-card':{}},component:null,inject:()=>({controller:adaptationController})};
    const mount = () => mountProviderSettings({effect:fn=>disposers.push(fn()),slots:{entries:()=>[entry]}});
    mount(); window.remount = () => {for(const dispose of disposers.reverse()) dispose?.();disposers=[];mount();};
    let namespace = {ns:'llm-pi-ai',user:{providers:{routergo:{models:[{id:'opaque/router:model'}]}}},base:{},schema:{},revision:1}; namespace.value=structuredClone(namespace.user);
    const listeners = new Set(); let state;
    const getPath=(value,path)=>path.reduce((at,key)=>at?.[key],value);
    const schema={getPath,hasPath:(value,path)=>getPath(value,path)!==undefined,rehydrate:value=>value,nodeAtPath:(_root,path)=>path.at(-1)==='api'?undefined:{meta:{}},validate:()=>undefined,
      setPath(value,path,next){const copy=structuredClone(value);let at=copy;for(const key of path.slice(0,-1))at=at[key]??={};at[path.at(-1)]=next;return copy;},
      deletePath(value,path){const copy=structuredClone(value);let at=copy;for(const key of path.slice(0,-1))at=at[key];delete at[path.at(-1)];return copy;}};
    const rows=()=>['routergo','stepfun'].map(id=>({entry:{provider:id,displayName:id==='routergo'?'RouterGo':'StepFun',settingsNs:'llm-pi-ai',settingsPath:['providers',id],active:true},
      configured:!!namespace.value.providers[id],removable:true,apiKeyEnv:namespace.value.providers[id]?.apiKeyEnv,
      credential:{configured:true,writable:true,source:'file'}}));
    const publish=next=>{state=next;for(const listener of listeners)listener();};
    window.backgroundLoading=()=>publish({...state,status:'loading'});
    window.setScenario=mode=>publish({status:mode==='loading'?'loading':mode==='error'?'error':'ready',error:mode==='error'?'供应商目录暂不可用':null,writable:true,
      rows:mode==='empty'?rows().map(row=>({...row,configured:false})):mode==='data'?rows():[],namespaces:new Map([['llm-pi-ai',namespace]])});
    window.loads=0; window.writes=[];
    const controller={store:{getSnapshot:()=>state},async load(){window.loads++;publish({...state,status:'loading'});await new Promise(resolve=>setTimeout(resolve,80));publish({...state,status:'ready',rows:rows(),namespaces:new Map([['llm-pi-ai',namespace]])});}};
    const operations={async writeSettings(ns,ops){window.writes.push({ns,ops});for(const op of ops){if(op.op==='set')namespace.user=schema.setPath(namespace.user,op.path,op.value);}namespace.value=structuredClone(namespace.user);namespace.revision++;return{kind:'written',view:namespace};},async storeCredential(){},async discoverModels(){return{kind:'found',models:[]};}};
    const useSnapshot=selector=>selector(React.useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn);},()=>state));
    window.setScenario('loading');
    createRoot(document.getElementById('root')).render(<ModelsSection controller={controller} useSnapshot={useSnapshot} operations={operations} schema={schema} t={key=>zh[key]??key} renderSlot={()=>null}/>);
  ` }, bundle: true, write: false, outdir: join(root, 'artifacts/unused-provider-browser'), format: 'iife', jsx: 'automatic',
    nodePaths: [join(root, 'plugins/benchgo/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
    alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')),
      '@deepseek-ai/dsh-client-store': join(root, 'deepseek-harness/packages/client/store/src/index.ts'),
      '@deepseek-ai/dsh-client-ui-primitives': join(root, 'deepseek-harness/packages/client/ui-primitives/src/index.ts') },
    plugins:[officialModelsStore(),officialModelsUi()],loader: { '.css': 'text', '.module.css': 'local-css', '.svg': 'text' }, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  const script = result.outputFiles.find(file => file.path.endsWith('.js')).text;
  const css = result.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
    :root{color-scheme:light;--dsw-alias-label-primary:#242424;--dsw-alias-label-secondary:#777;--dsw-alias-label-tertiary:#777;--dsw-alias-bg-layer-2:#fff;--dsw-alias-state-business-primary:#4d6bfe;--dsw-alias-settings-card-fill:#fff;--dsw-alias-settings-card-stroke:#e4e4e8;--dsw-radius-xl:12px}html[data-dark=true]{color-scheme:dark;--dsw-alias-label-primary:#eee;--dsw-alias-label-secondary:#aaa;--dsw-alias-label-tertiary:#aaa;--dsw-alias-bg-layer-2:#252525;--dsw-alias-settings-card-fill:#252525;--dsw-alias-settings-card-stroke:#444}body{margin:0;padding:24px;font:13px Arial,"Microsoft YaHei",sans-serif;background:#fafafa;color:var(--dsw-alias-label-primary)}html[data-dark=true] body{background:#191919}#root{max-width:720px;margin:auto}${css}
    </style></head><body><div id="root"></div><script>${script.replaceAll('</script','<\\/script')}</script></body></html>`;
}

test('provider settings render four states, retain rows during refresh, and restore cached CSS after reactivation', {skip:!executablePath&&'Chromium/Edge required'}, async()=>{
  const html=await fixture(), browser=await chromium.launch({executablePath,headless:true}), errors=[];
  const screenshots=process.env.BENCHGO_PROVIDER_SCREENSHOTS;
  if(screenshots)await mkdir(screenshots,{recursive:true});
  try{
    for(const dark of [false,true]){
      const page=await browser.newPage({viewport:{width:1000,height:760}});page.setDefaultTimeout(6000);page.on('pageerror',error=>errors.push(error.message));
      await page.route('**/*',route=>route.request().url()==='http://localhost/'?route.fulfill({contentType:'text/html',body:html}):route.request().url().endsWith('/api/commander/tooling')?route.fulfill({contentType:'application/json',body:JSON.stringify({tools:[],bindings:{}})}):route.abort());
      await page.goto('http://localhost/');await page.evaluate(dark=>document.documentElement.dataset.dark=dark,dark);
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
        if(screenshots)await page.screenshot({path:join(screenshots,`${scenario}-${dark?'dark':'light'}.png`),fullPage:true});
      }
      assert.equal(await page.locator('#commander-official-models-style').count(),1);
      await page.evaluate(()=>window.backgroundLoading());
      await page.getByText('RouterGo',{exact:true}).waitFor();
      assert.equal(await page.getByRole('status',{name:'正在加载供应商与模型…'}).count(),0);
      await page.evaluate(()=>window.setScenario('data'));
      for(let cycle=0;cycle<3;cycle++)await page.evaluate(()=>window.remount());
      assert.equal(await page.locator('#commander-official-models-style').count(),1);
      assert.equal(await page.getByRole('heading').first().evaluate(node=>getComputedStyle(node).marginTop),'0px');
      await page.getByRole('button',{name:'添加模型提供商'}).click();
      await page.getByRole('textbox',{name:'API 密钥',exact:true}).fill('fixture-value');
      await page.getByRole('button',{name:'保存',exact:true}).click();
      await page.getByRole('listitem').filter({hasText:'StepFun'}).waitFor();
      await page.waitForFunction(()=>window.loads===1);
      assert.equal(await page.evaluate(()=>window.writes[0].ns),'llm-pi-ai');
      assert.equal(await page.evaluate(()=>window.writes[0].ops[0].path[1]),'stepfun');
      assert.equal(await page.locator('#commander-official-models-style').count(),1);
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      await page.close();
    }
    assert.deepEqual(errors,[]);
  } finally{await browser.close();}
});
