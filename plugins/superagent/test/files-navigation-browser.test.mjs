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
    import {Artifacts} from './plugins/superagent/client/artifacts.jsx';
    import {SystemFiles} from './plugins/superagent/client/system-files.jsx';
    import {installIconSprite} from './deepseek-harness/packages/client/ui-theme/src/client/icon-sprite.ts';
    import css from './plugins/superagent/client/style.css';import hostCss from './plugins/benchgo/client/style.css';
    installIconSprite({effect:fn=>fn(),on:()=>{}},undefined);
    const root=createRoot(document.getElementById('root'));let serial=0;
    const name='发布准备与部署回滚记录_长文件名用于核验窄屏布局_20261108.md';window.longName=name;
    const files=Array.from({length:26},(_,i)=>({id:'note-'+i+'.md',name:i===25?name:'note-'+i+'.md',path:'note-'+i+'.md',type:'file',url:'/api/files/note.md'+(i===25?'?revision=opaque%2F1#section':''),bytes:48,hash:'revision-1',updatedAt:'2026-11-08T08:00:00Z'}));
    window.renderScenario=(target='artifacts',mode='data',dark=false)=>{
      window.mode=mode;window.calls=[];window.previewChanges=[];window.failPreview=false;
      document.documentElement.dataset.theme=dark?'dark':'light';
      const api=async(action,input)=>{window.calls.push({action,input});if(window.mode==='loading')return new Promise(()=>{});if(window.mode==='error')throw Error('文件服务暂时不可用');
        if(action==='artifacts')return {artifacts:window.mode==='empty'?[]:files,total:window.mode==='empty'?0:files.length,nextCursor:null};
        if(action==='systemFiles')return {path:input.path,entries:window.mode==='empty'?[]:input.path?[files[25]]:[{name:'archive',path:'archive',type:'directory'},...files]};return {};
      };
      root.render(<div className='ba-root' key={++serial}><style>{hostCss}{css}</style><main className='ba-studio-body'>{target==='artifacts'?<Artifacts api={api}/>:<SystemFiles api={api} onPreviewChange={value=>window.previewChanges.push(value)}/>}</main></div>);
    };
  ` }, bundle: true, write: false, outdir: join(root, 'artifacts', 'unused-files-navigation'), format: 'iife', jsx: 'automatic',
    nodePaths: [join(root, 'plugins/benchgo/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
    alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')) },
    loader: { '.css': 'text', '.svg': 'text' }, plugins: [sharedUiStyles()], define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font:13px/1.5 Arial,sans-serif}.ba-root{height:100dvh!important;min-width:0!important}.ba-studio-body{box-sizing:border-box;height:100%;max-width:1100px;margin:auto!important}[data-theme=dark]{--dsw-alias-bg-base:#19191b;--dsw-alias-label-primary:#ededee;--dsw-alias-label-secondary:#a3a3a8;--ba-muted:#a3a3a8;--ba-line:#ffffff24;--ba-hover:#ffffff0c;--ba-surface:#ffffff08;color-scheme:dark;background:#19191b;color:#ededee}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script></body></html>`;
}

test('file lists preserve filters, scroll and focus through previews, directory navigation and refresh failures', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const screenshots = process.env.BENCHGO_FILES_SCREENSHOTS;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  try {
    const page = await browser.newPage(), errors = [];
    page.setDefaultTimeout(7000);page.on('pageerror', error => errors.push(error.message));
    const html = await fixture(), markdown = await readFile(join(root, 'plugins/benchgo/lib/preview/markdown.js'), 'utf8');
    let failPreview = false;
    await page.route('**/*', route => {
      const url = route.request().url();
      if (url === 'http://localhost/') return route.fulfill({ contentType: 'text/html', body: html });
      if (url.endsWith('/api/benchgo/preview-assets/markdown.js')) return route.fulfill({ contentType: 'application/javascript', body: markdown });
      if (url.includes('/api/files/note.md')) return route.fulfill({ status: failPreview ? 503 : 200, contentType: 'text/markdown; charset=utf-8', body: failPreview ? '暂不可用' : '# 发布记录\n\n文件内容保留原样。' });
      return route.abort();
    });
    await page.goto('http://localhost/');
    const capture = async name => { assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name} overflow`);if(screenshots)await page.screenshot({path:join(screenshots,name+'.png')}); };
    for (const width of [1440,390]) {
      await page.setViewportSize({width,height:900});
      for (const dark of [false,true]) {
        for (const target of ['artifacts','system']) {
          for (const mode of ['empty','loading','error']) {
            await page.evaluate(({target,mode,dark})=>window.renderScenario(target,mode,dark),{target,mode,dark});
            const title=target==='artifacts'?{empty:'暂无文档产物',loading:'正在整理工作区文件…',error:'文件读取或操作未完成'}[mode]:{empty:'这个目录还是空的',loading:'正在读取文件…',error:'暂时无法读取此目录'}[mode];
            await page.getByText(title,{exact:true}).waitFor();await capture(target+'-'+mode+'-'+width+'-'+(dark?'dark':'light'));
          }
        }
        await page.evaluate(({dark})=>window.renderScenario('artifacts','data',dark),{dark});
        const filename=await page.evaluate(()=>window.longName), file=page.getByRole('button',{name:filename,exact:true});
        await page.getByRole('button',{name:'note-0.md',exact:true}).waitFor();await capture(`artifacts-data-${width}-${dark?'dark':'light'}`);
        await file.scrollIntoViewIfNeeded();
        const scroll=await page.locator('.ba-studio-body').evaluate(node=>node.scrollTop);
        assert(scroll>200);
        const plainUrl=new URL(await page.getByRole('link',{name:'下载 note-0.md',exact:true}).getAttribute('href'));
        assert.equal(plainUrl.search,'?download=1');
        const queryUrl=new URL(await page.getByRole('link',{name:'下载 '+filename,exact:true}).getAttribute('href'));
        assert.equal(queryUrl.searchParams.get('revision'),'opaque/1');assert.equal(queryUrl.searchParams.get('download'),'1');assert.equal(queryUrl.hash,'#section');
        await file.click();await page.frameLocator('iframe').getByRole('heading',{name:'发布记录'}).waitFor();
        assert.equal(await page.getByRole('dialog').count(),0,'inline previews are not modal dialogs');
        await capture(`artifacts-preview-${width}-${dark?'dark':'light'}`);
        await page.getByRole('button',{name:'← 返回',exact:true}).click();
        await page.waitForFunction(name=>document.activeElement?.textContent===name,filename);
        assert(Math.abs(await page.locator('.ba-studio-body').evaluate(node=>node.scrollTop)-scroll)<3);
        await page.getByRole('searchbox',{name:'筛选已加载文件'}).fill('发布准备');
        await page.getByRole('button',{name:'全选当前结果',exact:true}).click();assert.equal(await page.getByRole('checkbox',{checked:true}).count(),1);await page.getByRole('button',{name:'取消全选',exact:true}).click();
        await page.evaluate(()=>window.mode='error');await page.getByRole('button',{name:'刷新',exact:true}).click();
        await page.getByRole('alert').filter({hasText:'文件服务暂时不可用'}).waitFor();
        assert.equal(await page.getByRole('searchbox',{name:'筛选已加载文件'}).inputValue(),'发布准备');assert(await file.isVisible());
        assert.equal(await page.getByRole('button',{name:'重试',exact:true}).count(),1);
        await capture(`artifacts-refresh-error-${width}-${dark?'dark':'light'}`);
        await page.evaluate(()=>window.mode='data');await page.getByRole('button',{name:'重试',exact:true}).click();await page.getByText('已加载文件中找到 1 项',{exact:true}).waitFor();
        failPreview=true;await file.click();await page.getByRole('alert').filter({hasText:'暂不可用'}).waitFor();failPreview=false;await page.getByRole('button',{name:'重试',exact:true}).click();await page.frameLocator('iframe').getByRole('heading',{name:'发布记录'}).waitFor();
        await page.getByRole('button',{name:'← 返回',exact:true}).press('Escape');await file.waitFor();
        assert.equal(await page.getByRole('searchbox',{name:'筛选已加载文件'}).inputValue(),'发布准备');
        await page.evaluate(({dark})=>window.renderScenario('system','data',dark),{dark});
        const filter=page.getByRole('searchbox',{name:'筛选当前目录文件'});await filter.fill('archive');await page.getByRole('button',{name:'archive',exact:true}).click();
        await file.waitFor();await page.getByRole('button',{name:'根目录',exact:true}).click();await page.getByRole('button',{name:'archive',exact:true}).waitFor();
        await page.waitForFunction(()=>document.activeElement?.textContent==='archive');assert.equal(await filter.inputValue(),'archive');
        await filter.fill('');await file.scrollIntoViewIfNeeded();const directoryScroll=await page.locator('.ba-studio-body').evaluate(node=>node.scrollTop);
        await page.locator('.ba-system-entry').last().locator('.ba-system-size').click();await page.frameLocator('iframe').getByRole('heading',{name:'发布记录'}).waitFor();
        await capture(`system-preview-${width}-${dark?'dark':'light'}`);await page.getByRole('button',{name:'← 返回',exact:true}).click();
        await page.waitForFunction(name=>document.activeElement?.textContent===name,filename);assert(Math.abs(await page.locator('.ba-studio-body').evaluate(node=>node.scrollTop)-directoryScroll)<3);
        await filter.fill('发布准备');await page.evaluate(()=>window.mode='error');await page.getByRole('button',{name:'刷新系统文件'}).click();await page.getByRole('alert').filter({hasText:'文件服务暂时不可用'}).waitFor();assert(await file.isVisible());assert.equal(await filter.inputValue(),'发布准备');await capture(`system-refresh-error-${width}-${dark?'dark':'light'}`);
      }
    }
    assert.deepEqual(errors,[]);
  } finally { await browser.close(); }
});
