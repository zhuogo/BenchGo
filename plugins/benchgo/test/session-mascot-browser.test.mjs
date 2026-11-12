import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
const { chromium } = require('playwright');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || [chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const screenshots = join(root, 'artifacts/session-mascot');

test('new-session mascot follows the resident official composer and respects appearance, motion and lifecycle', { skip: !executablePath }, async () => {
  const result = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
    import {ConversationContent} from './deepseek-harness/packages/client/ui-conversation/src/client/skeleton/ConversationContent.tsx';
    import conversationCss from './deepseek-harness/packages/client/ui-conversation/src/client/skeleton/ConversationRoot.module.css';
    import inputCss from './deepseek-harness/packages/client/ui-conversation/src/client/skeleton/InputBar.module.css';
    import benchgoCss from './plugins/benchgo/client/style.css';
    import {SessionMascotFrame,mountSessionMascot} from './plugins/benchgo/client/session-mascot.jsx';
    import {assistantConfigSync} from './plugins/superagent/client/config-sync.mjs';
    let revision=1;window.config=patch=>assistantConfigSync.accept({revision:revision++,...patch},assistantConfigSync.begin());window.config({});
    let registration;mountSessionMascot({slots:{inject:(name,fn)=>fn(),register:(options,Component)=>{registration={options,Component};return()=>{}}}});window.registration=registration.options;
    function Input({variant,placeholder}){return <div className={inputCss.root+' '+(variant==='hero'?inputCss.hero:'')}><div data-composer-card className={inputCss.card}><div className={inputCss.scroll}><textarea aria-label="消息" className={inputCss.input} placeholder={placeholder||'继续输入'} defaultValue="" rows={2}/></div><div className={inputCss.row}><span>＋　工具　项目</span><span>DeepSeek　↑</span></div></div></div>}
    const Mode=React.createContext('empty');
    function Views(){return React.useContext(Mode)!=='data'?null:<article style={{padding:'24px',maxWidth:660,margin:'auto'}}>你好，帮我整理一下这个项目。<p>我会先查看项目结构，再整理需要关注的内容。</p></article>}
    const translations={'hero.headline':'有什么可以帮你？','hero.preview':'预览','hero.chooseWorkspace':'选择项目','workspace.defaultName':'最近','placeholder.workspace':'选择项目以开始','placeholder.hero':'发送消息，开始新的会话'};
    const useFactorySlot=(name,fallback)=>name==='views'?Views:fallback;
    function App(){const [mode,setMode]=useState('empty');window.mode=setMode;const hero=mode!=='data';const renderSlot=(name,props={},opts={})=>name==='conversation.hero.frame'?<SessionMascotFrame {...props}>{opts.children}</SessionMascotFrame>:name==='conversation.composer.bar'?<Input {...props}/>:name==='conversation.hero.brand.mark'?null:null;return <Mode.Provider value={mode}><style>{benchgoCss}</style><aside className="fixture-sidebar"><b>BenchGo</b><p>＋ 新增会话</p><p>SuperAgent</p><p>最近会话</p></aside><main className={conversationCss.root} data-phase={mode==='loading'?'settling':hero?'hero':'active'}><header style={{padding:'16px 24px',fontSize:13,borderBottom:'1px solid #8882'}}>新会话</header>{mode==='loading'&&<div role="status" className="fixture-notice">正在准备会话…</div>}{mode==='error'&&<div role="alert" className="fixture-notice">会话连接暂时中断 <button onClick={()=>setMode('empty')}>重试</button></div>}<ConversationContent sessionId="fixture" phase={mode==='loading'?'settling':hero?'hero':'active'} hero={hero} variant="standalone" useSession={fn=>fn({id:'fixture'})} useSessions={fn=>fn({byId:{fixture:{cwd:'E:/BenchGo'}}})} useSessionStatus={fn=>fn(new Map())} useWorkspaces={fn=>fn({phase:'ready',items:[{workspaceId:'recent',title:'BenchGo',sessionIds:['fixture']}]})} useInput={fn=>fn({draft:''})} useComposerBlock={fn=>fn(undefined)} renderSlot={renderSlot} renderSlotChain={(name,props,opts)=>opts.fallback} selectWorkspace={async()=>{}} t={key=>translations[key]||key} useFactorySlot={useFactorySlot}/></main></Mode.Provider>}
    const app=createRoot(document.getElementById('root'));app.render(<App/>);window.unmount=()=>app.unmount();
  ` }, bundle: true, write: false, outfile: 'fixture.js', format: 'iife', jsx: 'automatic',
    alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')) },
    nodePaths: [join(root, 'plugins/benchgo/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
    loader: { '.css': 'text', '.module.css': 'local-css', '.svg': 'text' },
    plugins: [{ name: 'official-leaf-fixtures', setup(builder) {
      builder.onResolve({ filter: /^@deepseek-ai\/dsh-client-ui-primitives$/ }, args => ({ path: args.path, namespace: 'fixture' }));
      builder.onResolve({ filter: /^@deepseek-ai\/dsh-api-workspace-controller\/default-workspace$/ }, args => ({ path: args.path, namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'jsx', contents: args.path.includes('default-workspace') ? 'export const workspaceDisplayTitle=(title)=>title;' : "import React from 'react';export const FISH_LOGO_PATH='';export const FISH_LOGO_VIEWBOX={width:24,height:24};export const IconChevronDownOutlineRegular=()=> <span>⌄</span>;export const IconFolderCloseRegular=()=> <span>▱</span>;export const IconFolderOpenRegular=IconFolderCloseRegular;" }));
    } }], define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    await mkdir(screenshots, { recursive: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent(`<!doctype html><html><head><base href="http://benchgo.test/"><style>
      *{box-sizing:border-box}body{margin:0;font-family:'Segoe UI','Microsoft YaHei',sans-serif;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);--dsw-alias-bg-base:#fff;--dsw-alias-label-primary:#202124;--dsw-alias-label-secondary:#74777e;--dsw-specific-input-major:#f7f8fa;--dsw-radius-panel:20px;--dsh-composer-card-max-width:660px;--dsh-composer-side-clearance:12px;--dsw-alias-state-business-primary:#315be8;--dsw-alias-interactive-bg-hover:#8881}body[data-ds-dark-theme]{--dsw-alias-bg-base:#19191b;--dsw-alias-label-primary:#ededee;--dsw-alias-label-secondary:#a3a3a8;--dsw-specific-input-major:#252528}#root{display:grid;grid-template-columns:230px minmax(0,1fr);height:100dvh}.fixture-sidebar{padding:24px;background:#8881;font-size:13px}.fixture-sidebar b{font-size:20px}.fixture-sidebar p{margin-top:26px}.fixture-notice{position:absolute;top:64px;left:24px;font-size:13px}textarea{resize:none;width:100%;border:0;background:none;font:inherit;min-height:76px}button{font:inherit}@media(max-width:540px){#root{grid-template-columns:minmax(0,1fr)}.fixture-sidebar{display:none}}
    </style></head><body><div id="root"></div></body></html>`);
    await page.addStyleTag({ content: result.outputFiles.find(file => file.path.endsWith('.css')).text });
    await page.addScriptTag({ content: result.outputFiles.find(file => file.path.endsWith('.js')).text });
    const mascot = page.locator('.bg-session-mascot');
    await mascot.waitFor();
    await page.waitForFunction(() => document.querySelector('.bg-session-mascot')?.dataset.motion === 'on');
    assert.deepEqual(await page.evaluate(() => window.registration), { name: 'conversation.hero.frame', id: 'pixel-whale', priority: -10 });
    assert.equal(await mascot.getAttribute('aria-hidden'), 'true');
    assert.equal(await page.locator('[data-home-whale]').count(), 0);
    assert.equal(await mascot.evaluate(node => getComputedStyle(node).pointerEvents), 'none');
    assert.match(await page.locator('.bg-session-mascot-body').evaluate(node => getComputedStyle(node).animationName), /pet-play/);
    assert.match(await mascot.locator('[data-part=eyes]').evaluate(node => getComputedStyle(node).animationName), /pet-eyes/);
    await page.getByRole('textbox', { name: '消息' }).fill('保留这段草稿');
    await page.evaluate(() => { window.draftNode = document.querySelector('textarea'); });
    for (const dark of [false, true]) for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 820 });
      await page.evaluate(dark => document.body.toggleAttribute('data-ds-dark-theme', dark), dark);
      for (const state of ['empty', 'loading', 'error', 'data']) {
        await page.evaluate(state => window.mode(state), state);
        if (state === 'data') { await mascot.waitFor({ state: 'detached' }); await page.getByText('你好，帮我整理一下这个项目。').waitFor(); }
        else if (state === 'loading') await page.getByRole('status').waitFor();
        else await mascot.waitFor();
        assert(await page.evaluate(() => window.draftNode === document.querySelector('textarea')), 'draft DOM survives hero transitions');
        assert.equal(await page.locator('textarea').inputValue(), '保留这段草稿');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await page.screenshot({ path: join(screenshots, `${dark ? 'dark' : 'light'}-${width}-${state}.png`), animations: 'disabled' });
        if (state === 'empty' || state === 'error') {
          const geometry = await mascot.evaluate(node => { const m=node.getBoundingClientRect(),c=node.closest('[data-composer-card]').getBoundingClientRect();return{right:m.right,cardRight:c.right,bottom:m.bottom,cardTop:c.top,left:m.left}; });
          assert(geometry.bottom <= geometry.cardTop && geometry.cardRight - geometry.right <= 16 && geometry.left >= 0, JSON.stringify(geometry));
        }
      }
    }
    await page.evaluate(() => { window.mode('empty'); window.config({cardMotion:false}); });
    await mascot.waitFor();
    assert.equal(await page.locator('.bg-session-mascot-body').evaluate(node => getComputedStyle(node).animationName), 'none');
    await page.evaluate(() => window.config({pet:{kind:'builtin',expression:'happy',palette:'default',decorations:[]}}));
    await page.waitForFunction(() => document.querySelector('.bg-session-mascot [data-part=eyes] path'));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.locator('.bg-session-mascot-body').evaluate(node => getComputedStyle(node).animationName), 'none');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.evaluate(() => { Object.defineProperty(document,'hidden',{configurable:true,value:true}); document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForFunction(() => document.querySelector('.bg-session-mascot')?.dataset.motion === 'off');
    await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForFunction(() => document.querySelector('.bg-session-mascot')?.dataset.motion === 'on');
    await page.route('**/pet-asset?**', route => route.abort());
    await page.evaluate(() => window.config({pet:{kind:'custom',assetId:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.png'}}));
    await mascot.getByText('形象不可用').waitFor();
    await page.screenshot({ path: join(screenshots, 'custom-image-error.png'), animations: 'disabled' });
    await page.evaluate(() => window.config({}));
    await mascot.locator('svg').waitFor();
    await page.evaluate(() => window.unmount());
    assert.equal(await mascot.count(), 0);
    assert.equal(await page.evaluate(() => document.getAnimations().length), 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
