import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sharedUiStyles } from '../../benchgo/scripts/shared-ui.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
const { chromium } = require('playwright');
const { build } = createRequire(new URL('../../benchgo/package.json', import.meta.url))('esbuild');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || [chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);

async function fixture() {
  const bundle = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React,{useState,useCallback,useRef} from 'react';import {createRoot} from 'react-dom/client';
    import {MemoryPage} from './plugins/superagent/client/memory.jsx';
    import css from './plugins/superagent/client/style.css';import hostCss from './plugins/benchgo/client/style.css';
    const root=createRoot(document.getElementById('root'));let serial=0;
    const longText='项目沟通习惯：先说明结论，再补充必要的操作和依据。'+
      '涉及模型配置时，保留供应商原始模型 ID，不根据名称猜测别名。'.repeat(8)+'\\n第二段：这个结尾必须能在展开后完整阅读。';
    const rows=()=>[
      {id:'memory-long',content:longText,revision:4,document:'MEMORY.md',updatedAt:'2026-11-08T08:00:00Z',source:{excerpt:'用户原话：保留原始模型 ID，说明结论和必要依据。',messageId:'message:Exact/07',sessionId:'session:Original'},versionChain:[{id:'memory-long',revision:3,updatedAt:'2026-11-07T08:00:00Z'}]},
      {id:'memory-plain',content:'没有保存来源的独立记忆，展开后直接阅读和编辑。',revision:2,document:'USER.md',updatedAt:'2026-11-08T07:00:00Z'},
      ...Array.from({length:10},(_,i)=>({id:'memory-'+i,content:'工作偏好 '+(i+1)+'：保留简短清晰的操作入口，避免重复说明。',revision:1,document:i%2?'TOOLS.md':'MEMORY.md',updatedAt:'2026-11-07T0'+(i%8)+':00:00Z'}))
    ];
    function Fixture({mode}){
      const [entries,setEntries]=useState(()=>mode==='empty'?[]:rows());
      const records=useRef(entries);
      const api=useCallback(async(action,input)=>{
        window.calls.push({action,input});
        if(action==='profileDocuments'){
          if(window.mode==='loading')return new Promise(()=>{});
          if(window.mode==='error')throw Error('记忆档案暂时不可用');
          return {documents:[{name:'MEMORY.md',content:'共同记忆正文',hash:'revision-1'}]};
        }
        if(action==='memorySave'){
          if(window.saveFailures-->0)throw Error('记忆保存失败，请重试');
          const current=records.current.find(row=>row.id===input.memory.id);
          records.current=current?records.current.map(row=>row.id===current.id?{...row,content:input.memory.content,revision:row.revision+1}:row):[{...input.memory,id:'memory-created',revision:1,document:'MEMORY.md',updatedAt:'2026-11-08T10:00:00Z'},...records.current];
          return records.current.find(row=>row.id===(current?.id||'memory-created'));
        }
        if(action==='memoryDelete'){
          if(window.deleteFailures-->0)throw Error('记忆删除失败，请重试');
          records.current=records.current.filter(row=>row.id!==input.id);return {deleted:true};
        }
        return {};
      },[]);
      const refresh=useCallback(async()=>{window.calls.push({action:'refresh'});setEntries([...records.current]);},[]);
      return <MemoryPage api={api} refresh={refresh} entries={entries} threadId='main'/>;
    }
    window.renderScenario=(mode='data',theme='light')=>{
      window.calls=[];window.mode=mode;window.saveFailures=0;window.deleteFailures=0;
      document.body.toggleAttribute('data-ds-dark-theme',theme==='dark');document.documentElement.dataset.theme=theme;
      root.render(<div className='ba-root' key={++serial}><style>{hostCss}{css}</style><main className='ba-studio-body' style={{padding:24,maxWidth:1000,margin:'auto',boxSizing:'border-box'}}><Fixture mode={mode}/></main></div>);
    };
  ` }, bundle: true, write: false, outdir: join(root, 'artifacts', 'unused-memory-ui-test'), format: 'iife', jsx: 'automatic',
    nodePaths: [join(root, 'plugins/benchgo/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
    alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')) },
    loader: { '.css': 'text', '.svg': 'text' }, plugins: [sharedUiStyles()], define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
    :root{--dsw-alias-bg-base:#fff;--dsw-alias-label-primary:#202124;--dsw-alias-label-secondary:#6b6b70;--dsw-alias-state-business-primary:#315be8;color-scheme:light}
    :root[data-theme=dark]{--dsw-alias-bg-base:#19191b;--dsw-alias-label-primary:#ededee;--dsw-alias-label-secondary:#a3a3a8;--dsw-alias-state-business-primary:#7b9bff;color-scheme:dark}
    body{margin:0;font-family:Arial,sans-serif;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}.ba-root{height:auto!important;min-width:0!important}
    </style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script></body></html>`;
}

test('memory compact rows reveal full content, preserve edit drafts and return to saved entries across themes and widths', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const screenshots = process.env.BENCHGO_MEMORY_SCREENSHOTS;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  try {
    const page = await browser.newPage(), errors = [];
    page.setDefaultTimeout(7000);page.on('pageerror', error => errors.push(error.message));
    const nativeDialogs = []; page.on('dialog', dialog => { nativeDialogs.push(dialog.message()); void dialog.dismiss(); });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const html = await fixture();
    await page.route('**/*', route => route.request().url() === 'http://localhost/' ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
    await page.goto('http://localhost/');
    const shot = async name => {
      if (!screenshots) return;
      await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))));
      await page.screenshot({ path: join(screenshots, name+'.png'), fullPage: true });
    };
    const noOverflow = async label => assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), label+' horizontal overflow');
    for (const theme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: theme });
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 960 });
        for (const [mode, title] of [['empty', '从一件小事开始'], ['loading', '正在读取档案…'], ['error', '暂时无法读取档案']]) {
          await page.evaluate(({ mode, theme }) => window.renderScenario(mode, theme), { mode, theme });
          if (mode !== 'empty') await page.getByRole('tab', { name: 'MEMORY.md', exact: true }).click();
          await page.getByText(title, { exact: true }).waitFor();
          await noOverflow(`${mode}/${theme}/${width}`);await shot(`${mode}-${theme}-${width}`);
        }
        await page.evaluate(theme => window.renderScenario('data', theme), theme);
        await page.getByText('12 条 · 按最近更新', { exact: true }).waitFor();
        const rows = page.locator('.ba-memory-post');
        assert.equal(await rows.count(), 12);
        const longRow = rows.filter({ hasText: '项目沟通习惯：' }).first();
        const trigger = longRow.locator('.ba-memory-toggle');
        assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
        const rowBox = await longRow.boundingBox();
        assert(rowBox.height <= (width < 600 ? 142 : 110), 'collapsed row stays compact');
        assert.equal(await longRow.getByText('用户原话：保留原始模型 ID，说明结论和必要依据。', { exact: true }).count(), 0);
        await noOverflow(`data/${theme}/${width}`);await shot(`data-${theme}-${width}`);
        await trigger.focus();await page.keyboard.press('Enter');
        await page.waitForFunction(() => document.querySelector('.ba-memory-post .ba-memory-toggle')?.getAttribute('aria-expanded') === 'true');
        await longRow.getByText(/第二段：这个结尾必须能在展开后完整阅读。/).last().waitFor();
        await longRow.getByRole('button', { name: '来源原文', exact: true }).click();
        await longRow.getByText('用户原话：保留原始模型 ID，说明结论和必要依据。', { exact: true }).waitFor();
        await longRow.getByRole('button', { name: /替代版本/ }).click();
        await longRow.getByText('版本 3', { exact: false }).waitFor();
        await noOverflow(`expanded/${theme}/${width}`);await shot(`expanded-${theme}-${width}`);
        await trigger.focus();await page.keyboard.press('Space');
        assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
        const plainRow = rows.filter({ hasText: '没有保存来源的独立记忆' }).first();
        await plainRow.locator('.ba-memory-toggle').click();
        assert.equal(await plainRow.getByRole('button', { name: '来源原文', exact: true }).count(), 0);
        assert.equal(await plainRow.getByText(/未保存来源/).count(), 0);
        await plainRow.getByRole('button', { name: '编辑记忆', exact: true }).click();
        const editor = page.getByRole('textbox').first();
        await editor.fill('更新后的简短记忆，保存后应定位到这条记录。');
        await page.evaluate(() => { window.saveFailures = 1; });
        await page.getByRole('button', { name: '保存修改', exact: true }).click();
        await page.getByRole('alert').filter({ hasText: '记忆保存失败，请重试' }).waitFor();
        assert.equal(await editor.inputValue(), '更新后的简短记忆，保存后应定位到这条记录。');
        assert.equal(await page.locator('.ba-memory-post[data-editing=true]').count(), 1);
        await noOverflow(`editing/${theme}/${width}`);await shot(`editing-error-${theme}-${width}`);
        await page.getByRole('button', { name: '保存修改', exact: true }).click();
        await page.getByText('记忆已修改', { exact: true }).waitFor();
        const saved = page.locator('.ba-memory-post').filter({ hasText: '更新后的简短记忆，保存后应定位到这条记录。' }).first();
        await saved.waitFor();
        assert.equal(await editor.inputValue(), '');
        assert.equal(await page.locator('.ba-memory-post[data-editing=true]').count(), 0);
        await page.waitForFunction(() => document.activeElement?.closest('.ba-memory-post')?.textContent.includes('更新后的简短记忆'));
        const savedBox = await saved.boundingBox();assert(savedBox.y >= 0 && savedBox.y < 960, 'saved entry returns into view');
        await shot(`saved-${theme}-${width}`);
        await saved.getByRole('button', { name: '编辑记忆', exact: true }).click();
        await editor.fill('取消编辑时不要覆盖已保存内容。');
        await page.getByRole('button', { name: '取消', exact: true }).click();
        const discard = page.getByRole('dialog', { name: '放弃未保存的记忆？', exact: true });
        await discard.getByRole('button', { name: '继续编辑', exact: true }).click();
        assert.equal(await editor.inputValue(), '取消编辑时不要覆盖已保存内容。', 'cancelling the custom confirmation preserves the draft');
        await page.getByRole('button', { name: '取消', exact: true }).click();
        await discard.getByRole('button', { name: '放弃修改', exact: true }).click();
        await page.waitForFunction(() => document.activeElement?.closest('.ba-memory-post')?.dataset.memoryId === 'memory-plain');
        assert.equal(await editor.inputValue(), '');
        assert.equal(await saved.locator('.ba-memory-summary').textContent(), '更新后的简短记忆，保存后应定位到这条记录。');
        await saved.getByRole('button', { name: '编辑记忆', exact: true }).click();
        await editor.fill('删除失败时必须保留这段未保存草稿。');
        await page.evaluate(() => { window.deleteFailures = 1; });
        await saved.getByRole('button', { name: '忘记这条记忆', exact: true }).click();
        await page.getByRole('alert').filter({ hasText: '记忆删除失败，请重试' }).waitFor();
        assert.equal(await editor.inputValue(), '删除失败时必须保留这段未保存草稿。');
        assert.equal(await page.locator('.ba-memory-post[data-editing=true]').count(), 1);
        assert.equal(await page.locator('.ba-memory-post').count(), 12);
        await noOverflow(`deleting-error/${theme}/${width}`);await shot(`deleting-error-${theme}-${width}`);
        await saved.getByRole('button', { name: '忘记这条记忆', exact: true }).click();
        await page.getByText('已忘记这条记忆', { exact: true }).waitFor();
        assert.equal(await page.locator('.ba-memory-post').count(), 11);
        assert.equal(await page.locator('.ba-memory-post').filter({ hasText: '更新后的简短记忆' }).count(), 0);
        assert.equal(await editor.inputValue(), '');
        await page.waitForFunction(() => document.activeElement?.closest('.ba-memory-post')?.dataset.memoryId === 'memory-0');
        const calls = await page.evaluate(() => window.calls);
        assert.deepEqual(calls.filter(call => call.action === 'memorySave').map(call => [call.input.memory.id,call.input.revision]), [['memory-plain',2],['memory-plain',2]]);
        assert.deepEqual(calls.filter(call => call.action === 'memoryDelete').map(call => call.input), [{ id: 'memory-plain', revision: 3 }, { id: 'memory-plain', revision: 3 }]);
        await noOverflow(`deleted/${theme}/${width}`);
      }
    }
    assert.deepEqual(errors, []); assert.deepEqual(nativeDialogs, [], 'memory flows never use native confirmation');
  } finally { await browser.close(); }
});
