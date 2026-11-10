import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
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
    import React from 'react';import {createRoot} from 'react-dom/client';
    import {MemoryPage} from './plugins/superagent/client/memory.jsx';
    import {Artifacts} from './plugins/superagent/client/artifacts.jsx';
    import {SystemFiles} from './plugins/superagent/client/system-files.jsx';
    import {installIconSprite} from './deepseek-harness/packages/client/ui-theme/src/client/icon-sprite.ts';
    import css from './plugins/superagent/client/style.css';import hostCss from './plugins/benchgo/client/style.css';
    installIconSprite({effect:fn=>fn(),on:()=>{}},undefined);
    const root=createRoot(document.getElementById('root'));let serial=0;
    const file={id:'note.md',name:'note.md',path:'note.md',type:'file',url:'/api/files/note.md',bytes:48,hash:'revision-1',updatedAt:'2026-11-08T08:00:00Z'};
    window.renderScenario=(page='memory',mode='data')=>{
      window.calls=[];window.mode=mode;window.previewChanges=[];window.saveFailure=false;
      const rows=mode==='empty'?[]:[{id:'memory-one',content:'偏好简短中文，并保留必要的操作入口。',revision:1,document:'MEMORY.md',updatedAt:'2026-11-08T08:00:00Z',source:{excerpt:'请使用简短中文。'}}];
      const api=async(action,input)=>{
        window.calls.push({action,input});
        if(window.mode==='loading')return new Promise(()=>{});
        if(window.mode==='error')throw Error('资源服务暂时不可用');
        if(action==='artifacts')return {artifacts:window.mode==='empty'?[]:[file],total:window.mode==='empty'?0:1,nextCursor:null};
        if(action==='systemFiles')return {path:'',entries:window.mode==='empty'?[]:[file]};
        if(action==='profileDocuments')return {documents:[{name:'MEMORY.md',content:'共同记忆正文',hash:'revision-1'}]};
        if(action==='memorySave'&&window.saveFailure)throw Error('记忆保存失败');
        return {};
      };
      const preview=value=>window.previewChanges.push(value);
      root.render(<div className='ba-root' key={++serial}><style>{hostCss}{css}</style><main className='ba-studio-body' style={{padding:24,maxWidth:1000,margin:'auto',boxSizing:'border-box'}}>{page==='memory'?<MemoryPage api={api} refresh={async()=>{}} entries={rows} threadId='main'/>:page==='artifacts'?<Artifacts api={api} onPreviewChange={preview}/>:<SystemFiles api={api} onPreviewChange={preview}/>}</main></div>);
    };
  ` }, bundle: true, write: false, outdir: join(root, 'artifacts', 'unused-resource-ui-test'), format: 'iife', jsx: 'automatic',
    nodePaths: [join(root, 'plugins/benchgo/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
    alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')) },
    loader: { '.css': 'text', '.svg': 'text' }, plugins: [sharedUiStyles()], define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font-family:Arial,sans-serif}.ba-root{height:auto!important;min-width:0!important}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script></body></html>`;
}

test('resource pages render four states, compact memory, unified artifact header and focused Markdown previews', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const screenshots = process.env.BENCHGO_RESOURCE_SCREENSHOTS;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  try {
    const page = await browser.newPage(), errors = [];
    page.setDefaultTimeout(7000);page.on('pageerror', error => errors.push(error.message));
    const html = await fixture(), markdown = await readFile(join(root, 'plugins/benchgo/lib/preview/markdown.js'), 'utf8');
    await page.route('**/*', route => {
      const url = route.request().url();
      if (url === 'http://localhost/') return route.fulfill({ contentType: 'text/html', body: html });
      if (url.endsWith('/api/benchgo/preview-assets/markdown.js')) return route.fulfill({ contentType: 'application/javascript', body: markdown });
      if (url.endsWith('/api/files/note.md')) return route.fulfill({ contentType: 'text/markdown; charset=utf-8', body: '# 页面整理\n\n保留清晰的文件内容与返回入口。' });
      return route.abort();
    });
    await page.goto('http://localhost/');
    const scenarios = {
      memory: [['empty', '从一件小事开始'], ['loading', '正在读取档案…'], ['error', '暂时无法读取档案'], ['data', '偏好简短中文，并保留必要的操作入口。']],
      artifacts: [['empty', '暂无文档产物'], ['loading', '正在整理工作区文件…'], ['error', '文件读取或操作未完成'], ['data', 'note.md']],
      system: [['empty', '这个目录还是空的'], ['loading', '正在读取文件…'], ['error', '暂时无法读取此目录'], ['data', 'note.md']],
    };
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 960 });
      for (const [target, states] of Object.entries(scenarios)) {
        for (const [mode, text] of states) {
          await page.evaluate(({ target, mode }) => window.renderScenario(target, mode), { target, mode });
          if (target === 'memory' && ['loading', 'error'].includes(mode)) await page.getByRole('tab', { name: 'MEMORY.md', exact: true }).click();
          await page.getByText(text, { exact: true }).first().waitFor();
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${target}/${mode}/${width} horizontal overflow`);
          if (target === 'artifacts') {
            assert.equal(await page.getByRole('heading', { name: '产物与工作区文件', exact: true }).count(), 1);
            if (mode === 'empty') assert.equal(await page.getByRole('button', { name: /刷新/ }).count(), 1);
          }
          if (target === 'system') assert.equal(await page.getByText(/助手的工作底稿|只读浏览/).count(), 0);
          if (target === 'memory' && mode === 'data') {
            const chip = await page.locator('.ba-memory-source').boundingBox();
            assert(chip.width < 110 && chip.height < 32, 'long-term memory label stays on one compact line');
          }
          if (screenshots) await page.screenshot({ path: join(screenshots, `${target}-${mode}-${width}.png`), fullPage: true });
        }
      }
      for (const target of ['system', 'artifacts']) {
        await page.evaluate(target => window.renderScenario(target, 'data'), target);
        await page.getByRole('button', { name: 'note.md', exact: true }).click();
        await page.frameLocator('iframe').getByRole('heading', { name: '页面整理', exact: true }).waitFor();
        assert.equal(await page.getByRole('region', { name: '文件浏览工具' }).count(), 0);
        assert.equal(await page.getByRole('heading', { name: '产物与工作区文件', exact: true }).count(), 0);
        if (target === 'system') assert.equal((await page.evaluate(() => window.previewChanges)).at(-1), true);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${target}/preview/${width} horizontal overflow`);
        if (screenshots) await page.screenshot({ path: join(screenshots, `${target}-preview-${width}.png`), fullPage: true });
        await page.getByRole('button', { name: '← 返回', exact: true }).click();
        await page.getByRole('button', { name: 'note.md', exact: true }).waitFor();
        if (target === 'system') assert.equal((await page.evaluate(() => window.previewChanges)).at(-1), false);
      }
    }
    await page.evaluate(() => window.renderScenario('memory', 'data'));
    await page.getByLabel('有什么值得记住？', { exact: true }).fill('保留失败后的草稿');
    await page.evaluate(() => { window.saveFailure = true; });
    await page.getByRole('button', { name: '记下来', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '记忆保存失败' }).waitFor();
    assert.equal(await page.getByLabel('有什么值得记住？', { exact: true }).inputValue(), '保留失败后的草稿');
    await page.evaluate(() => { window.saveFailure = false; });
    await page.getByRole('button', { name: '记下来', exact: true }).click();
    await page.getByText('已记住', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('有什么值得记住？', { exact: true }).inputValue(), '');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
