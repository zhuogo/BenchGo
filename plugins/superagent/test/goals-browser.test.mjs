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
  const result = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';
    import {Goals} from './plugins/superagent/client/goals.jsx';
    import css from './plugins/superagent/client/style.css';import hostCss from './plugins/benchgo/client/style.css';
    const root=createRoot(document.getElementById('root'));let serial=0;
    const api=async(action,input)=>{
      window.calls.push({action,input});
      if(action==='goalList'){
        if(window.mode==='loading')return new Promise(()=>{});
        if(window.mode==='error')throw Error('目标服务暂时不可用');
        return {goals:window.rows.filter(row=>!row.deleted)};
      }
      if(window.failNext){window.failNext=false;throw Error('保存失败，请重试');}
      if(action==='goalUpdate'){const row=window.rows.find(row=>row.id===input.id);if(row.rowVersion!==input.rowVersion)throw Error('目标已更新，请刷新');Object.assign(row,input.patch,{rowVersion:row.rowVersion+1});return row;}
      throw Error('Unexpected action: '+action);
    };
    window.remount=()=>root.render(<div className='ba-root' key={++serial}><style>{hostCss}{css}</style><main className='ba-studio-body'><Goals api={api}/></main></div>);
    window.renderScenario=(mode='data')=>{window.calls=[];window.mode=mode;window.rows=mode==='empty'?[]:[{id:'goal-one',objective:'推进发布准备',status:'active',rowVersion:7}];window.remount();};
  ` }, bundle: true, write: false, outdir: join(root, 'artifacts/unused-goals-ui-test'), format: 'iife', jsx: 'automatic',
    nodePaths: [join(root, 'plugins/benchgo/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
    alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')),
      '@deepseek-ai/dsh-client-ui-primitives': join(root, 'deepseek-harness/packages/client/ui-primitives/src/index.ts') },
    loader: { '.css': 'text', '.svg': 'text' }, plugins: [sharedUiStyles()], define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>body{margin:0;font-family:Arial,sans-serif}.ba-root{height:auto!important;min-width:0!important}</style></head><body><div id="root"></div><script>${result.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script></body></html>`;
}

test('goal checklist renders four states without creation and completes, reopens, edits and deletes existing goals', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath }), screenshots = process.env.BENCHGO_GOALS_SCREENSHOTS;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  try {
    const page = await browser.newPage(), errors = [];
    page.setDefaultTimeout(6000); page.on('pageerror', error => errors.push(error.message));
    const html = await fixture();
    await page.route('**/*', route => route.request().url() === 'http://localhost/' ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
    await page.goto('http://localhost/');
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const [mode, title] of [['loading','正在读取目标'],['error','目标暂时无法读取'],['empty','还没有目标'],['data','推进发布准备']]) {
        await page.evaluate(mode => window.renderScenario(mode), mode);
        await page.getByText(title, { exact: true }).waitFor();
        assert.equal(await page.getByRole('heading', { level: 1, name: '目标', exact: true }).count(), 1);
        assert.equal(await page.getByRole('combobox').count(), 0);
        assert.equal(await page.getByRole('form', { name: '添加目标', exact: true }).count(), 0);
        assert.equal(await page.getByRole('textbox', { name: '新目标', exact: true }).count(), 0);
        assert.equal(await page.getByRole('button', { name: /^(添加|添加目标)$/ }).count(), 0);
        if (mode === 'empty') await page.getByText('在 SuperAgent 对话中提出目标，让助手记录并持续跟进。', { exact: true }).waitFor();
        if (mode === 'data') {
          assert.equal(await page.getByText(/历史执行目标|关联工单/).count(), 0, 'every goal is a plain checklist item');
          assert.equal(await page.getByRole('button', { name: '查看工单', exact: true }).count(), 0);
          assert(await page.getByRole('checkbox', { name: '完成：推进发布准备', exact: true }).isEnabled());
        }
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        if (screenshots) await page.screenshot({ path: join(screenshots, `${mode}-${width}.png`), fullPage: true });
      }
    }
    await page.getByRole('checkbox', { name: '完成：推进发布准备', exact: true }).check();
    await page.getByRole('checkbox', { name: '取消完成：推进发布准备', exact: true }).waitFor();
    await page.evaluate(() => window.remount());
    assert(await page.getByRole('checkbox', { name: '取消完成：推进发布准备', exact: true }).isChecked());
    await page.getByRole('checkbox', { name: '取消完成：推进发布准备', exact: true }).uncheck();
    const row = page.getByRole('listitem').filter({ hasText: '推进发布准备' });
    await row.getByRole('button', { name: '编辑目标', exact: true }).click();
    await row.getByRole('textbox', { name: '目标内容', exact: true }).fill('长期维护发布质量');
    await page.evaluate(() => { window.failNext = true; });
    await page.getByRole('form', { name: '编辑目标', exact: true }).getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('alert').getByText('保存失败，请重试', { exact: true }).waitFor();
    assert.equal(await page.getByRole('form', { name: '编辑目标', exact: true }).getByRole('textbox', { name: '目标内容', exact: true }).inputValue(), '长期维护发布质量');
    await page.getByRole('form', { name: '编辑目标', exact: true }).getByRole('button', { name: '保存', exact: true }).click();
    const edited = page.getByRole('listitem').filter({ hasText: '长期维护发布质量' });
    await edited.getByRole('button', { name: '删除目标', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
    assert(await edited.isVisible());
    await edited.getByRole('button', { name: '删除目标', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click();
    await page.getByText('长期维护发布质量', { exact: true }).waitFor({ state: 'hidden' });
    assert.equal((await page.evaluate(() => window.calls)).some(row => row.action === 'goalCreate'), false);
    assert.equal((await page.evaluate(() => window.calls)).some(row => row.action === 'catalog'), false);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
