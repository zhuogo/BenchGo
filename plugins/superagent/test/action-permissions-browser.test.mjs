import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sharedUiStyles } from '../../benchgo/scripts/shared-ui.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
const { chromium } = require('playwright');
const { build } = createRequire(new URL('../../benchgo/package.json', import.meta.url))('esbuild');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || [chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);

async function fixture() {
  const bundle = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';
    import {ActionPermissions,ActionPermissionsView} from './plugins/superagent/client/action-permissions.jsx';
    import css from './plugins/superagent/client/style.css';import hostCss from './plugins/benchgo/client/style.css';
    const root=createRoot(document.getElementById('root'));let serial=0;
    window.renderScenario=(mode='data',pure=false)=>{
      window.calls=[];window.mode=mode;window.createFailures=0;
      let grants=mode==='empty'?[]:[{id:'grant-one',origin:'https://accounts.example:8443',categories:['login','private-upload'],expiresAt:'2099-01-01T00:00:00Z',createdAt:'2026-11-08T08:00:00Z',actor:{id:'owner-one',label:'桌面主人',profileId:'profile-one'}}];
      let audit=[{id:'audit-one',phase:'grant-created',createdAt:'2026-11-08T08:00:00Z',origin:'https://accounts.example:8443',actor:{id:'owner-one',label:'桌面主人'}}];
      const api=async(action,input)=>{
        window.calls.push({action,input});
        if(action==='actionPermissions'){
          if(window.mode==='loading')return new Promise(()=>{});
          if(window.mode==='error')throw Error('授权服务暂时不可用');
          return {grants,audit};
        }
        if(action==='actionPermissionCreate'){
          if(window.createFailures-->0)throw Error('保存连接中断，请重试');
          grants=[...grants,{...input,id:'grant-new',actor:{id:'owner-one',label:'桌面主人'},createdAt:new Date().toISOString()}];
          audit=[...audit,{id:'audit-new',phase:'grant-created',createdAt:new Date().toISOString(),origin:input.origin}];return {grant:grants.at(-1)};
        }
        if(action==='actionPermissionRevoke'){
          grants=grants.map(g=>g.id===input.id?{...g,revokedAt:new Date().toISOString()}:g);
          audit=[...audit,{id:'audit-revoke',phase:'grant-revoked',createdAt:new Date().toISOString(),origin:grants.find(g=>g.id===input.id).origin}];return {revoked:true};
        }
      };
      root.render(<div key={++serial} className='ba-root'><style>{hostCss}{css}</style><main style={{padding:24,maxWidth:1000,margin:'auto',boxSizing:'border-box'}}>{pure?<ActionPermissionsView grants={grants} audit={audit} state='data' now={Date.now()}/>:<ActionPermissions api={api}/>}</main></div>);
    };
  ` }, bundle: true, write: false, outdir: join(root, 'artifacts', 'unused-permission-ui-test'), format: 'iife', jsx: 'automatic',
    nodePaths: [join(root, 'plugins/benchgo/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
    alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')) },
    loader: { '.css': 'text', '.svg': 'text' }, plugins: [sharedUiStyles()], define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font-family:Arial,sans-serif}.ba-root{height:auto!important;min-width:0!important}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script></body></html>`;
}

test('authorization management renders four states and preserves exact permission, retries and revocation in browser', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const screenshots = process.env.BENCHGO_PERMISSION_SCREENSHOTS;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  try {
    const page = await browser.newPage(), errors = [];
    page.setDefaultTimeout(6000); page.on('pageerror', error => errors.push(error.message));
    const html = await fixture();
    await page.route('**/*', route => route.request().url() === 'http://localhost/' ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
    await page.goto('http://localhost/');
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 960 });
      for (const [mode, text] of [['loading', '正在读取授权'], ['error', '授权暂时无法读取'], ['empty', '还没有站点许可'], ['data', 'https://accounts.example:8443']]) {
        await page.evaluate(mode => window.renderScenario(mode), mode);
        await page.getByText(text, { exact: true }).first().waitFor();
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${mode}/${width} horizontal overflow`);
        assert.equal(await page.getByText(/支付或购买、修改密码、删除账号、另行对外发送始终逐次审批/).count(), 1);
        if (screenshots) await page.screenshot({ path: join(screenshots, `${mode}-${width}.png`), fullPage: true });
      }
    }
    await page.evaluate(() => window.renderScenario('error'));
    await page.getByRole('button', { name: '重试', exact: true }).waitFor();
    await page.evaluate(() => { window.mode = 'data'; });
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await page.getByText('https://accounts.example:8443', { exact: true }).waitFor();
    await page.getByRole('button', { name: '授权与动作记录', exact: false }).click();
    await page.getByText('已创建站点许可', { exact: true }).waitFor();
    await page.getByRole('button', { name: '新建站点许可', exact: true }).click();
    await page.getByLabel('精确站点', { exact: true }).fill('https://new.example/path');
    await page.getByLabel('有效期限', { exact: true }).fill('2098-12-31T20:00');
    await page.getByRole('button', { name: '保存许可', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '站点只填写协议' }).waitFor();
    assert.equal((await page.evaluate(() => window.calls)).filter(row => row.action === 'actionPermissionCreate').length, 0);
    await page.getByLabel('精确站点', { exact: true }).fill('https://new.example:8443');
    await page.getByRole('checkbox', { name: '上传私有内容', exact: true }).check();
    await page.evaluate(() => { window.createFailures = 1; });
    await page.getByRole('button', { name: '保存许可', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '保存连接中断' }).waitFor();
    assert.equal(await page.getByLabel('精确站点', { exact: true }).inputValue(), 'https://new.example:8443');
    await page.getByRole('button', { name: '保存许可', exact: true }).click();
    await page.getByText('站点许可已保存。高风险动作仍需逐次审批。', { exact: true }).waitFor();
    const calls = await page.evaluate(() => window.calls.filter(row => row.action === 'actionPermissionCreate'));
    assert.equal(calls.length, 2); assert.deepEqual(calls[0], calls[1]);
    assert.equal(calls[0].input.origin, 'https://new.example:8443');
    assert.deepEqual(calls[0].input.categories, ['login', 'private-upload']);
    assert.equal(calls[0].input.actor, undefined); assert.equal(calls[0].input.authorized, undefined);
    await page.getByRole('button', { name: '撤销 https://new.example:8443 的许可', exact: true }).click();
    await page.getByText('许可已撤销，尚未提交的动作将重新校验授权。', { exact: true }).waitFor();
    const row = page.locator('.ba-permission-row').filter({ hasText: 'https://new.example:8443' });
    assert.equal(await row.getByText('已撤销', { exact: true }).count(), 1);
    assert.equal(await row.getByRole('button').count(), 0);
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await row.getByText('已撤销', { exact: true }).waitFor();
    await page.evaluate(() => window.renderScenario('data', true));
    await page.getByText('https://accounts.example:8443', { exact: true }).waitFor();
    assert.equal(await page.getByText('有效', { exact: true }).count(), 1);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
