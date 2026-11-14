import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const webRequire = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
const { chromium } = webRequire('playwright');
const { build } = createRequire(new URL('../../benchgo/package.json', import.meta.url))('esbuild');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || [chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const captureDir = process.env.BENCHGO_ROLE_SCREENSHOTS;

test('owned and unknown sessions hide selectors and diagnostics while ordinary official controls remain usable', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const html = await fixture(), browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 800 }, reducedMotion: 'reduce' }), errors = [];
    page.setDefaultTimeout(5000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.setContent(html);
    const owned = page.locator('[data-fixture-session="owned"]'), ordinary = page.locator('[data-fixture-session="ordinary"]');
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const hidden = async phase => {
      await settle();
      assert.equal(await owned.innerText(), '自有会话', `${phase}: no role, model, status or diagnostic text`);
      assert.equal(await owned.locator('[data-original], .ba-session-role, [title], [aria-label*="preset"]').count(), 0);
      assert.equal(await page.getByRole('tooltip').count(), 0);
      assert.equal(await owned.getByRole('textbox', { name: 'owned 输入框', exact: true }).count(), 1, 'official input remains available');
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (captureDir) { await mkdir(captureDir, { recursive: true }); await page.screenshot({ path: join(captureDir, `${phase}.png`), fullPage: true }); }
    };
    await owned.waitFor();
    await page.getByRole('button', { name: '预设 unbound', exact: true }).waitFor();
    await ordinary.getByRole('button', { name: '权限：read-only', exact: true }).waitFor();
    await hidden('loading');
    assert.equal(await page.evaluate(() => window.injects.filter(row => row[1] === 'owned').length), 0, 'unknown ownership must not consume original preset injection');
    await page.evaluate(() => window.lockOrdinary(true));
    assert(await ordinary.getByRole('button', { name: '权限：read-only', exact: true }).isDisabled(), 'official locked prop survives the private child slot');
    await page.evaluate(() => window.lockOrdinary(false));
    await ordinary.getByRole('button', { name: '权限：read-only', exact: true }).click();
    await page.getByRole('menuitem', { name: 'workspace-write', exact: true }).click();
    await ordinary.getByRole('button', { name: '权限：workspace-write', exact: true }).waitFor();
    await ordinary.getByRole('button', { name: '模型 ordinary A', exact: true }).click();
    await ordinary.getByRole('button', { name: '模型 ordinary B', exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.writes), [['permission', 'ordinary', 'workspace-write'], ['model', 'ordinary', 'B']]);
    await page.evaluate(() => { window.ordinaryModel = document.querySelector('[data-fixture-session="ordinary"] [data-original="model"]'); window.resolveOwned('router'); });
    await hidden('ready');
    for (const phase of ['pending', 'blocked', 'worker', 'error', 'loading']) {
      await page.evaluate(phase => window.showOwned(phase), phase);
      await hidden(phase);
      assert.equal(await page.evaluate(() => window.injects.filter(row => row[1] === 'owned').length), 0, `${phase}: no original selector injection`);
    }
    await page.evaluate(() => window.showOwned('error'));
    const beforeModelChange = await page.evaluate(() => window.roleReads);
    await page.evaluate(() => { window.nextOwned('worker'); window.changeModelProjection(); });
    await page.waitForFunction(previous => window.roleReads > previous, beforeModelChange);
    await hidden('recovered');
    assert(await ordinary.locator('[data-original="model"]').evaluate(node => node === window.ordinaryModel), 'another session role resolution cannot remount ordinary controls');
    await page.evaluate(() => window.hideOwned(true));
    await owned.waitFor({ state: 'detached' });
    await page.evaluate(() => window.hideOwned(false));
    await owned.waitFor(); await hidden('reentry');
    await page.evaluate(() => window.disconnect());
    await hidden('disconnected');
    await page.evaluate(() => window.reconnect());
    await hidden('reconnected');
    await ordinary.getByRole('button', { name: '模型 ordinary B', exact: true }).waitFor();
    await page.evaluate(() => window.showOwned('ordinary'));
    await owned.getByRole('button', { name: /权限：/ }).waitFor();
    await page.evaluate(() => window.showOwned('child-worker'));
    await owned.getByRole('button', { name: /权限：/ }).waitFor();
    await owned.getByRole('button', { name: '模型 owned A', exact: true }).click();
    await owned.getByRole('button', { name: '模型 owned B', exact: true }).waitFor();
    await page.evaluate(() => window.showOwned('router'));
    await hidden('owned-again');
    await page.evaluate(() => window.stopRoleControls());
    await owned.getByRole('button', { name: /权限：/ }).waitFor();
    await page.evaluate(() => window.startRoleControls());
    await hidden('remounted');
    await page.evaluate(() => window.replaceModel());
    await ordinary.getByRole('button', { name: '新模型 ordinary B', exact: true }).waitFor();
    await hidden('hot-replacement');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('native conversation surface protects owned transcripts and preserves ordinary child assembly', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const html = await fixture(true), browser = await chromium.launch({headless:true,executablePath});
  try {
    const page=await browser.newPage({viewport:{width:390,height:800}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.setContent(html);
    try { await page.locator('[data-native="ordinary"] textarea').waitFor({timeout:4000}); } catch(cause) { throw new Error(JSON.stringify({errors,body:await page.locator('body').innerText()}),{cause}); }
    assert.equal(await page.locator('[data-native="ordinary"] h2').textContent(),'原生会话标题');
    assert.equal(await page.locator('[data-native="owned"] textarea').count(),0,'unknown identity must not flash transcript');
    await page.evaluate(()=>window.resolveOwned('worker'));
    await page.locator('[data-native="owned"] textarea').waitFor();
    await page.locator('[data-native="owned"] textarea').fill('直接补充原 Worker');
    assert.equal(await page.locator('[data-native="owned"] textarea').inputValue(),'直接补充原 Worker');
    await page.evaluate(()=>window.showOwned('child-worker'));
    await page.locator('[data-native="owned"] textarea').waitFor();
    await page.evaluate(()=>window.showOwned('router'));
    await page.getByText('此会话由 SuperAgent 管理',{exact:true}).waitFor();
    assert.equal(await page.locator('[data-native="owned"] textarea').count(),0);
    await page.getByRole('button',{name:'在 SuperAgent 中打开',exact:true}).click();
    assert.equal(await page.evaluate(()=>window.opened),'owned');
    await page.evaluate(()=>window.showOwned('ordinary'));
    await page.locator('[data-native="owned"] textarea').waitFor();
    assert.equal(await page.locator('[data-native="owned"] h2').textContent(),'原生会话标题');
    await page.evaluate(()=>window.showOwned('router'));
    await page.getByText('此会话由 SuperAgent 管理',{exact:true}).waitFor();
    assert.equal(await page.locator('[data-native="owned"] textarea').count(),0);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    assert.deepEqual(errors,[]);
  } finally {await browser.close();}
});

async function fixture(native = false) {
  const result = await build({
    stdin: { resolveDir: root, loader: 'jsx', contents: `
      import React, {useSyncExternalStore} from 'react';
      import {createRoot} from 'react-dom/client';
      import {Context} from '@deepseek-ai/cordis';
      import {SlotRegistry} from './deepseek-harness/packages/client/ui-renderer/src/client/registry.ts';
      import {createSlotRenderer} from './deepseek-harness/packages/client/ui-renderer/src/client/scoped-slots.tsx';
      import {renderSessionArea} from './deepseek-harness/packages/client/ui-session/src/client/session-provider.tsx';
      import {PermissionSelect} from './deepseek-harness/packages/client/ui-permission-presets/src/client/PermissionSelect.tsx';
      import {mountSessionRoleControls} from './plugins/superagent/client/session-role-controls.jsx';
      function observable(value) { const listeners = new Set(); return { getSnapshot:()=>value, subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener)}, set:next=>{value=next;for(const listener of listeners)listener()} }; }
      const ctx = new Context(), slots = new SlotRegistry(ctx), generation = observable({id:1}), visibility = observable(true), busy = observable(false);
      const list = observable({byId:{owned:{running:false,blank:false,projectionValues:{}},ordinary:{running:false,blank:false,projectionValues:{}}}});
      ctx.reflect.provide('sessions',{list}); ctx.reflect.provide('connection',{generation});
      slots.install(createSlotRenderer());
      const localeRevision = observable({revision:0});
      slots.installLocale({...localeRevision,bind:ns=>(key,args)=>key==='mode'?'权限：'+args.name:key==='preset.readOnly'?'read-only':key==='preset.workspaceWrite'?'workspace-write':key==='model'?(ns==='fixture-new'?'新模型':'模型'):key});
      const refs = new Map(), sources = new Map(), values = new Map(), permissions = new Map();
      window.writes=[];window.injects=[];window.roleReads=0;
      const absent = observable({key:undefined,hooks:{session:undefined},keyedHooks:{projection:undefined},props:{sessionId:undefined}});
      for(const id of ['owned','ordinary']) {
        const scope = new Context(), ref = {sessionId:id,binding:{ctx:scope,sessionId:id}};
        const model = observable('A'), permission = observable({currentValue:'read-only'});
        refs.set(id,ref);values.set(id,model);permissions.set(id,permission);
        sources.set(ref,observable({key:id,ctx:scope,hooks:{session:observable({sid:id})},keyedHooks:{projection:key=>key==='permissions'?permission:undefined},props:{sessionId:id}}));
      }
      slots.installScope('session',{current:absent,bindingSource:ref=>ref?sources.get(ref):absent,renderArea:renderSessionArea});
      const declarations={
        'conversation.input.permission':{kind:'single',scope:'session'},
        'conversation.input.model':{kind:'single',scope:'session'},
        'conversation.hero.agentPreset':{kind:'single',scope:'session-maybe'},
        'conversation.session.header.actions':{kind:'list',scope:'session'},
        'conversation.input.dock':{kind:'list',scope:'session'},
        'main.conversation':{kind:'single',scope:'session-maybe'},
      };
      slots.register({name:'root',children:declarations},({SessionProvider,renderSlot})=>{
        const show = useSyncExternalStore(visibility.subscribe,visibility.getSnapshot);
        const locked = useSyncExternalStore(busy.subscribe,busy.getSnapshot);
        ${native ? "return <main>{['owned','ordinary'].map(id=><section key={id} data-native={id}><SessionProvider session={refs.get(id)}>{renderSlot('main.conversation',{})}</SessionProvider></section>)}</main>;" : ''}
        return <main>{['owned','ordinary'].filter(id=>id!=='owned'||show).map(id=><section key={id} data-fixture-session={id}><h2>{id==='owned'?'自有会话':'普通会话'}</h2><SessionProvider session={refs.get(id)}>{renderSlot('conversation.input.dock',{})}<div className="controls">{renderSlot('conversation.input.permission',{locked:id==='ordinary'&&locked})}{renderSlot('conversation.input.model',{locked:false})}{renderSlot('conversation.hero.agentPreset',{})}{renderSlot('conversation.session.header.actions',{})}</div><textarea aria-label={id+' 输入框'} defaultValue="保留官方输入区域" /></SessionProvider></section>)}<aside>{renderSlot('conversation.hero.agentPreset',{})}</aside></main>;
      });
      slots.register({name:'main.conversation',children:{'fixture.native.header':{kind:'single',scope:'session-maybe'},'fixture.native.body':{kind:'single',scope:'session-maybe'}}},({sessionId,renderSlot})=><div data-conversation-session={sessionId}>{renderSlot('fixture.native.header',{})}{renderSlot('fixture.native.body',{})}</div>);
      slots.register({name:'fixture.native.body',children:{'fixture.native.frame':{kind:'single',scope:'session-maybe'}}},({renderSlot})=>renderSlot('fixture.native.frame',{}));
      slots.register({name:'fixture.native.frame',children:{'conversation.hero.frame':{kind:'hoc',scope:'root'}}},({sessionId,renderSlot})=>renderSlot('conversation.hero.frame',{hero:false},{children:<textarea aria-label={'native '+sessionId} defaultValue={'原生记录 '+sessionId}/>}));
      slots.register({name:'fixture.native.header'},()=> <h2>原生会话标题</h2>);
      const catalog = observable({value:{options:[{value:'read-only',name:'read-only'},{value:'workspace-write',name:'workspace-write'}]}});
      slots.register({name:'conversation.input.permission',locale:'permission.access',inject:id=>{window.injects.push(['permission',id]);return{hooks:{permissionCatalog:catalog},select:async value=>{window.writes.push(['permission',id,value]);permissions.get(id).set({currentValue:value});return true}}}},props=><div data-original="permission"><PermissionSelect {...props}/></div>);
      function Model({sessionId,useFixtureValue,useSession,select,t}) { const value=useFixtureValue(x=>x), session=useSession(x=>x);if(session.sid!==sessionId)throw Error('Wrong provider scope');return <button data-original="model" onClick={()=>select('B')}>{t('model')} {sessionId} {value}</button>; }
      const modelRegistration=locale=>slots.register({name:'conversation.input.model',priority:-10,locale,inject:id=>{window.injects.push(['model',id]);return{hooks:{fixtureValue:values.get(id)},select:value=>{window.writes.push(['model',id,value]);values.get(id).set(value)}}}},Model);
      let removeModel=modelRegistration('fixture');
      slots.register({name:'conversation.hero.agentPreset',inject:id=>{window.injects.push(['preset',id]);return{label:id||'unbound'}}},({label})=><button data-original="preset">预设 {label}</button>);
      slots.register({name:'conversation.session.header.actions',id:'agent-preset'},()=> <span data-original="header">原预设标签</span>);
      slots.register({name:'conversation.input.dock',id:'commander-model-empty',order:-30},()=> <span data-original="empty">原模型提示</span>);
      let pendingResolve, phase='loading', serial=1;
      const record=kind=>({sessionId:'owned',role:['worker','child-worker'].includes(kind)?kind:'router',status:['pending','blocked'].includes(kind)?kind:'ready',actual:kind==='pending'?null:{agentPreset:'standard',permissionPreset:'danger-full-access',sandbox:'danger-full-access',approval:'never',model:{provider:'opaque-provider',model:'model/EXACT-long-provider-value-2026-11',reasoningEffort:'vendor-effort'},tools:['one','two']},reason:kind==='blocked'?{message:'官方角色服务暂不可用'}:null});
      const api=async(action,{sessionId},signal)=>{window.roleReads++;if(action!=='sessionRole')throw Error('Unexpected action');if(sessionId==='ordinary')return{role:null};if(phase==='loading')return new Promise(resolve=>{pendingResolve=resolve});if(phase==='error')throw Error('服务暂不可用');return{role:phase==='ordinary'?null:record(phase)};};
      const onOpenOwned=${native ? 'role=>{window.opened=role.sessionId}' : 'undefined'};let stop=mountSessionRoleControls(ctx,api,onOpenOwned);
      window.resolveOwned=kind=>{phase=kind;pendingResolve?.({role:record(kind)})};
      window.nextOwned=kind=>{phase=kind};
      window.showOwned=async kind=>{phase=kind;if(kind==='loading'){visibility.set(false);await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));visibility.set(true);return}pendingResolve?.({role:kind==='ordinary'?null:record(kind)});pendingResolve=undefined;const next=list.getSnapshot();list.set({byId:{...next.byId,owned:{...next.byId.owned,running:!next.byId.owned.running}}})};
      window.hideOwned=value=>visibility.set(!value);
      window.lockOrdinary=value=>busy.set(value);
      window.changeModelProjection=()=>{const next=list.getSnapshot();list.set({byId:{...next.byId,owned:{...next.byId.owned,projectionValues:{modelSelection:{provider:'p',model:'new-id'}}}}})};
      window.disconnect=()=>generation.set(undefined);window.reconnect=()=>generation.set({id:++serial});
      window.stopRoleControls=()=>stop();window.startRoleControls=()=>{stop=mountSessionRoleControls(ctx,api,onOpenOwned)};
      window.replaceModel=()=>{removeModel();removeModel=modelRegistration('fixture-new')};
      createRoot(document.getElementById('root')).render(slots.renderSlot('root',{}));
    ` },
    bundle: true, write: false, outdir: join(root, 'artifacts', 'unused-role-test-output'), format: 'iife', jsx: 'automatic',
    nodePaths: [join(root, 'plugins/benchgo/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
    alias: {
      react: dirname(webRequire.resolve('react/package.json')), 'react-dom': dirname(webRequire.resolve('react-dom/package.json')),
      '@deepseek-ai/dsh-client-ui-primitives': join(root, 'deepseek-harness/packages/client/ui-primitives/src/index.ts'),
      '@deepseek-ai/dsh-client-ui-slots': join(root, 'deepseek-harness/packages/client/ui-slots/src/index.ts'),
    },
    loader: { '.css': 'text', '.module.css': 'local-css', '.svg': 'text', '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
  });
  const themeRoot = join(root, 'deepseek-harness/packages/client/ui-theme/src/styles');
  const theme = (await Promise.all(['base.css', 'design-platform.css', 'focus.css'].map(name => readFile(join(themeRoot, name), 'utf8')))).join('\n');
  const css = result.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n');
  const js = result.outputFiles.find(file => file.path.endsWith('.js')).text.replaceAll('</script', '<\\/script');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BenchGo 会话角色</title><style>${theme}${css}
    body{margin:0;padding:20px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#202124);font-family:system-ui}main{display:grid;gap:24px;max-width:960px;margin:auto}section{min-width:0;padding:16px;border:1px solid var(--dsw-alias-border-main,#ddd);border-radius:12px}h2{font-size:16px;margin:0 0 12px}.controls{display:flex;gap:8px;flex-wrap:wrap;align-items:center}textarea{box-sizing:border-box;width:100%;min-height:100px;margin-top:12px;padding:12px;background:transparent;color:inherit;border:1px solid #888;border-radius:8px}.controls>button{font:inherit;color:inherit;background:transparent;border:1px solid #888;border-radius:6px;min-height:32px}
    </style></head><body><div id="root"></div><script>${js}</script></body></html>`;
}
