import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { build } from 'esbuild';
import { sharedUiStyles } from '../scripts/shared-ui.mjs';

const require = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
const { chromium } = require('playwright');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || (existsSync(chromium.executablePath()) ? chromium.executablePath() : 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe');
const output = fileURLToPath(new URL('../../../artifacts/skills-fusion/', import.meta.url));

test('real skill library renders four states and completes preview/install/refresh on desktop and phone', { skip: !existsSync(executablePath) }, async () => {
  const client = fileURLToPath(new URL('../client/', import.meta.url));
  const reactRequire = createRequire(new URL('../../../deepseek-harness/packages/client/ui-renderer/package.json', import.meta.url));
  const script = await build({
    stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {SkillsLibrary} from './skills-library.jsx'; import shellCss from './style.css';
      const style=document.createElement('style');style.textContent=shellCss;document.head.append(style);
      const rows=[{name:'handoff',description:'整理交接文档，让后续会话继续当前工作。',category:'productivity',dependencies:[],status:'not-installed',available:false,installed:false}];
      const meta={repository:'https://github.com/mattpocock/skills',version:'1.3.2',commit:'d1478fcb',license:'MIT',destination:'C:/Users/Example/.dsh/skills'};
      let installed=false;
      async function api(action,args){window.calls.push({action,args});if(action==='list')return {available:true,skills:[],projects:[]};
        if(action==='deckList'){if(window.mode==='loading')return new Promise(()=>{});if(window.mode==='error')throw Error('连接中断');return {...meta,available:true,skills:window.mode==='empty'?[]:rows.map(r=>({...r,installed,status:installed?'installed':r.status}))};}
        if(action==='deckGet')return {...meta,skill:{...rows[0],url:meta.repository,content:'---\\nname: handoff\\n---\\nWrite a handoff.',files:['SKILL.md','agents/openai.yaml'],plan:rows},licenseText:'MIT License — Matt Pocock'};
        if(action==='deckInstall'){if(window.failInstall)throw Error('下载失败，请重试');installed=true;return {installed:['handoff']};}}
      const ownedApi=async()=>({available:true,skills:[]});
      window.calls=[];window.draw=()=>createRoot(document.getElementById('app')).render(<SkillsLibrary api={api} ownedApi={ownedApi}/>);window.draw();`, resolveDir: client, loader: 'jsx' },
    bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
    nodePaths: [fileURLToPath(new URL('../node_modules/', import.meta.url))],
    alias: { react: dirname(reactRequire.resolve('react/package.json')), 'react-dom': dirname(reactRequire.resolve('react-dom/package.json')) },
    loader: { '.css': 'text', '.svg': 'text' }, plugins: [sharedUiStyles()], logLevel: 'silent',
  });
  const browser = await chromium.launch({ headless: true, executablePath });
  await mkdir(output, { recursive: true });
  try {
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    async function open(mode, width = 1440) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('about:blank');
      await page.setContent('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0;padding:24px;font-family:Arial,sans-serif}#app{max-width:1100px;margin:auto}</style></head><body><div id="app"></div></body></html>');
      await page.evaluate(mode => { window.mode = mode; }, mode);
      await page.addScriptTag({ content: script.outputFiles[0].text });
      await page.getByRole('button', { name: '浏览工程技能', exact: true }).click();
    }
    for (const [mode, text] of [['loading', '正在读取工程技能'], ['empty', '没有匹配的工程技能'], ['error', '工程技能目录读取失败：连接中断']]) {
      await open(mode); await page.getByText(text, { exact: mode !== 'error' }).first().waitFor();
      await page.screenshot({ path: output + mode + '.png', fullPage: true });
    }
    await open('data'); await page.getByRole('button', { name: /handoff/ }).click();
    await page.getByText('Write a handoff.', { exact: false }).waitFor();
    await page.evaluate(() => { window.failInstall = true; });
    await page.getByRole('button', { name: '安装技能', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '下载失败' }).waitFor();
    assert.equal(await page.getByRole('button', { name: '安装技能', exact: true }).isEnabled(), true);
    await page.evaluate(() => { window.failInstall = false; });
    await page.getByRole('button', { name: '安装技能', exact: true }).click();
    await page.getByText('已安装 · 待发现', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '安装技能', exact: true }).isDisabled(), true);
    await page.screenshot({ path: output + 'detail-desktop.png', fullPage: true });
    await page.getByRole('button', { name: '返回工程技能', exact: true }).click();
    await page.getByRole('searchbox', { name: '搜索工程技能' }).fill('nonexistent');
    await page.getByText('没有匹配的工程技能', { exact: true }).waitFor();
    await page.getByRole('button', { name: '清除搜索', exact: true }).click();
    await page.getByRole('button', { name: /handoff/ }).waitFor();
    await open('data', 390); await page.getByRole('button', { name: /handoff/ }).waitFor();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: output + 'data-mobile.png', fullPage: true });
    await page.getByRole('button', { name: /handoff/ }).click();
    await page.getByRole('button', { name: '安装技能', exact: true }).waitFor();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: output + 'detail-mobile.png', fullPage: true });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
