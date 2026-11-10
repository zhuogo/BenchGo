import { officialTooltipSource } from './official-tooltip-source.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { sharedUiStyles } from '../scripts/shared-ui.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
const { chromium } = require('playwright');
const executablePath = [chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);

test('shared bubbles and confirmations preserve anchors, cancel safely and fit narrow screens', { skip: !executablePath }, async () => {
  const result = await build({ stdin: { loader: 'jsx', resolveDir: root, contents: `
    import React,{useState,useRef} from 'react';import {createRoot} from 'react-dom/client';
    import {Tooltip} from './plugins/shared/client/ui/tooltip.jsx';
    import {Button} from './plugins/shared/client/ui/button.jsx';
    import {useConfirmation} from './plugins/shared/client/ui/confirmation.jsx';
    import {Dialog,DialogContent,DialogTitle} from './plugins/shared/client/ui/dialog.jsx';
    function Child(){const [confirm,confirmation]=useConfirmation();return <><button id="pending" onClick={async()=>{window.result=await confirm({title:'卸载确认',description:'保留配置与历史。',destructive:true,confirmLabel:'卸载'});}}>子确认</button>{confirmation}</>}
    function App(){const [confirm,confirmation]=useConfirmation(),[label,setLabel]=useState('不可用原因'),[child,setChild]=useState(true),[outer,setOuter]=useState(false);const ref=useRef();window.setLabel=setLabel;window.removeChild=()=>setChild(false);
      return <><div style={{display:'flex',justifyContent:'flex-end'}}><Tooltip label={label} delayMs={10}><button ref={ref} id="tip" title="不该出现" onClick={()=>window.clicks=(window.clicks||0)+1}>提示</button></Tooltip><Tooltip label={'长说明'.repeat(80)} delayMs={10}><button id="disabled" disabled onClick={()=>window.disabledClick=true}>禁用</button></Tooltip></div>
      <Tooltip label="图表" delayMs={10}><svg id="svg" tabIndex={0} width="40" height="20"><rect width="40" height="20"/></svg></Tooltip>
      <button id="open" onClick={async()=>window.result=await confirm({title:'停止任务',description:'已完成的操作仍会保留。',confirmLabel:'停止',destructive:true})}>询问</button>
      <button id="outer" onClick={()=>setOuter(true)}>外层</button><Dialog open={outer} onOpenChange={setOuter}><DialogContent><DialogTitle>详情</DialogTitle><button id="inner" onClick={async()=>window.innerResult=await confirm({title:'放弃草稿',description:'未保存内容会丢失。'})}>内层确认</button></DialogContent></Dialog>
      <Button id="shared-button" title="共享按钮说明" onClick={()=>window.sharedClick=true}>共享按钮</Button><Button id="shared-disabled" title="等待连接" disabled>暂不可用</Button>
      {child&&<Child/>}{confirmation}</>;
    }createRoot(document.getElementById('app')).render(<App/>);
  ` }, bundle: true, write: false, outdir: join(root, 'artifacts/unused-feedback-test'), format: 'iife', jsx: 'automatic', nodePaths: [join(root, 'plugins/benchgo/node_modules')], alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')) }, loader: { '.css': 'text', '.module.css': 'local-css' }, plugins: [officialTooltipSource(), sharedUiStyles()], logLevel: 'silent' });
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 760 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<!doctype html><html><body style="margin:0;font-family:Arial"><div id="app"></div></body></html>');
    await page.addStyleTag({ content: result.outputFiles.filter(file=>file.path.endsWith('.css')).map(file=>file.text).join('\n') });
    await page.addScriptTag({ content: result.outputFiles.find(file=>file.path.endsWith('.js')).text });
    assert.equal(await page.locator('#tip').getAttribute('title'), null);
    await page.locator('#tip').hover(); await page.getByRole('tooltip').waitFor();
    assert.equal(await page.getByRole('tooltip').innerText(), '不可用原因');
    await page.evaluate(() => window.setLabel('新说明')); await page.getByRole('tooltip').getByText('新说明').waitFor();
    await page.mouse.move(0, 200); await page.getByRole('tooltip').waitFor({ state: 'hidden' });
    await page.locator('#tip').click(); assert.equal(await page.evaluate(() => window.clicks), 1);
    await page.keyboard.press('Tab'); await page.locator('#disabled').locator('..').focus(); await page.getByRole('tooltip').waitFor();
    const bounds = await page.getByRole('tooltip').boundingBox(); assert(bounds.x >= 12 && bounds.x + bounds.width <= 378.1);
    await page.keyboard.press('Enter'); assert.equal(await page.evaluate(() => window.disabledClick), undefined);
    await page.keyboard.press('Escape');
    await page.locator('#svg').focus(); await page.getByRole('tooltip').waitFor(); assert.equal(await page.getByRole('tooltip').innerText(), '图表');
    await page.locator('#open').click(); await page.getByRole('dialog', { name: '停止任务' }).waitFor();
    assert(await page.getByRole('button', { name: '取消', exact: true }).evaluate(node => node === document.activeElement));
    await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => window.result), false);
    await page.waitForFunction(() => document.activeElement?.id === 'open');
    await page.locator('#open').click(); await page.getByRole('button', { name: '停止', exact: true }).click(); assert.equal(await page.evaluate(() => window.result), true);
    await page.locator('#outer').click(); await page.locator('#inner').click(); await page.getByRole('dialog', { name: '放弃草稿' }).waitFor();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('dialog', { name: '放弃草稿' }).waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => window.innerResult), false); await page.waitForFunction(() => document.activeElement?.id === 'inner');
    await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.locator('#pending').click(); await page.getByRole('dialog', { name: '卸载确认' }).waitFor();
    await page.evaluate(() => window.removeChild()); await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => window.result), false);
    assert.equal(await page.locator('#shared-button').getAttribute('title'), null);
    await page.keyboard.press('Tab'); await page.locator('#shared-button').focus(); await page.getByRole('tooltip').getByText('共享按钮说明').waitFor();
    await page.locator('#shared-button').click(); assert.equal(await page.evaluate(() => window.sharedClick), true);
    assert.equal(await page.locator('#shared-disabled').getAttribute('title'), null);
    await page.keyboard.press('Tab'); await page.locator('#shared-disabled').locator('..').focus();
    await page.getByRole('tooltip').getByText('等待连接').waitFor();
    await page.keyboard.press('Escape');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
