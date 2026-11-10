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
      window.calls=[];window.mode=mode;window.createFailures=0;window.permissionRead='normal';window.finishPermissionRead=null;
      let grants=mode==='empty'?[]:[{id:'grant-one',origin:'https://accounts.example:8443',categories:['login','private-upload'],expiresAt:'2099-01-01T00:00:00Z',createdAt:'2026-11-08T08:00:00Z',actor:{id:'owner-one',label:'桌面主人',profileId:'profile-one'}}];
      if(mode==='mixed')grants=[...grants,{...grants[0],id:'long-site',origin:'https://'+('international-account-portal'.repeat(2))+'.'+('enterprise-document-upload'.repeat(2))+'.example:8443'}, {...grants[0],id:'expired',origin:'https://expired.example',expiresAt:'2020-01-01T00:00:00Z'}, {...grants[0],id:'revoked',origin:'https://revoked.example',revokedAt:'2026-11-08T08:01:00Z'}];
      let audit=Array.from({length:40},(_,index)=>({id:'audit-'+index,phase:index?'matched':'grant-created',createdAt:'2026-11-08T08:00:00Z',origin:'https://accounts.example:8443',actor:{id:'owner-one',label:'桌面主人'}}));
      const api=async(action,input)=>{
        window.calls.push({action,input});
        if(action==='actionPermissions'){
          if(window.mode==='loading')return new Promise(()=>{});
          if(window.mode==='error')throw Error('授权服务暂时不可用');
          if(window.permissionRead==='delay')await new Promise(resolve=>{window.finishPermissionRead=resolve;});
          if(window.permissionRead==='error')throw Error('授权同步连接中断');
          return {grants,audit};
        }
        if(action==='actionPermissionCreate'){
          if(window.createFailures-->0)throw Error('保存连接中断，请重试');
          grants=[...grants,{...input,id:'grant-new',actor:{id:'owner-one',label:'桌面主人'},createdAt:new Date().toISOString()}];
          audit=[...audit,{id:'audit-new',phase:'grant-created',createdAt:new Date().toISOString(),origin:input.origin}];return grants.at(-1);
        }
        if(action==='actionPermissionRevoke'){
          grants=grants.map(g=>g.id===input.id?{...g,revokedAt:new Date().toISOString()}:g);
          audit=[...audit,{id:'audit-revoke',phase:'grant-revoked',createdAt:new Date().toISOString(),origin:grants.find(g=>g.id===input.id).origin}];return {id:input.id,revokedAt:grants.find(g=>g.id===input.id).revokedAt};
        }
      };
      root.render(<div key={++serial} className='ba-root'><style>{hostCss}{css}</style><main style={{padding:24,maxWidth:1000,margin:'auto',boxSizing:'border-box'}}>{pure?<ActionPermissionsView grants={grants} audit={audit} state='data' now={Date.now()}/>:<ActionPermissions api={api}/>}</main></div>);
    };
  ` }, bundle: true, write: false, outdir: join(root, 'artifacts', 'unused-permission-ui-test'), format: 'iife', jsx: 'automatic',
    nodePaths: [join(root, 'plugins/benchgo/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
    alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')) },
    loader: { '.css': 'text', '.svg': 'text' }, plugins: [sharedUiStyles()], define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font-family:Arial,sans-serif}.ba-root{height:auto!important;min-width:0!important}body[data-ds-dark-theme]{--dsw-alias-label-primary:#ededee;--dsw-alias-label-secondary:#a3a3a8;--dsw-alias-bg-base:#19191b;--dsw-alias-state-business-primary:#7d9dff;background:#19191b;color:#ededee}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script></body></html>`;
}

test('authorization management renders four states and preserves exact permission, retries and revocation in browser', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const screenshots = process.env.BENCHGO_PERMISSION_SCREENSHOTS;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  try {
    const page = await browser.newPage(), errors = [];
    await page.emulateMedia({ reducedMotion: 'reduce' });
    page.setDefaultTimeout(6000); page.on('pageerror', error => errors.push(error.message));
    const html = await fixture();
    await page.route('**/*', route => route.request().url() === 'http://localhost/' ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort());
    await page.goto('http://localhost/');
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 960 });
      for (const [mode, text] of [['loading', '正在读取授权'], ['error', '授权暂时无法读取'], ['empty', '还没有站点许可'], ['data', 'https://accounts.example:8443']]) {
        await page.evaluate(mode => window.renderScenario(mode), mode);
        await page.getByText(text, { exact: true }).first().waitFor();
        if (mode === 'data' || mode === 'empty') await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === '新建站点许可' && !button.disabled));
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${mode}/${width} horizontal overflow`);
        assert.equal(await page.getByText('站点许可仅覆盖登录与私有内容上传，高风险动作仍逐次审批。', { exact: true }).count(), 1);
        assert.equal(await page.getByText(/支付或购买、修改密码、删除账号、另行对外发送始终逐次审批/).count(), 0);
        assert.equal(await page.getByRole('heading', { name: '授权管理', exact: true }).count(), 1);
        assert.equal(await page.getByRole('button', { name: '新建站点许可', exact: true }).count(), 1);
        if (mode === 'error') assert.equal(await page.getByRole('button', { name: '重试', exact: true }).count(), 1);
        if (screenshots) await page.screenshot({ path: join(screenshots, `${mode}-${width}.png`), fullPage: true });
      }
      const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
      await page.getByRole('button', { name: '授权与动作记录', exact: true }).click();
      const auditDialog = page.getByRole('dialog', { name: '授权与动作记录', exact: true });
      await auditDialog.waitFor();
      assert(await auditDialog.locator('.ba-permission-audit').evaluate(element => element.scrollHeight > element.clientHeight));
      assert(await auditDialog.evaluate(element => { const rect=element.getBoundingClientRect();return rect.x>=0&&rect.right<=innerWidth&&rect.y>=0&&rect.bottom<=innerHeight; }), `audit dialog/${width} outside viewport`);
      if (screenshots) await page.screenshot({ path: join(screenshots, `audit-${width}.png`), fullPage: true });
      await page.getByRole('button', { name: '关闭记录', exact: true }).click();
      await auditDialog.waitFor({ state: 'hidden' });
      assert.equal(await page.evaluate(() => document.documentElement.scrollHeight), pageHeight);
    }
    await page.evaluate(() => window.renderScenario('error'));
    await page.getByRole('button', { name: '重试', exact: true }).waitFor();
    await page.evaluate(() => { window.mode = 'data'; });
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await page.getByText('https://accounts.example:8443', { exact: true }).waitFor();
    await page.getByRole('button', { name: '授权与动作记录', exact: false }).click();
    await page.getByText('已创建站点许可', { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert(await page.getByRole('button', { name: '授权与动作记录', exact: true }).evaluate(element => element === document.activeElement));
    await page.getByRole('button', { name: '新建站点许可', exact: true }).click();
    await page.getByRole('dialog', { name: '新建站点许可', exact: true }).waitFor();
    assert.equal(await page.getByRole('dialog').getByText(/支付或购买、修改密码、删除账号、另行对外发送始终逐次审批/).count(), 1);
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert(await page.getByRole('button', { name: '新建站点许可', exact: true }).evaluate(element => element === document.activeElement));
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
    if (screenshots) await page.screenshot({ path: join(screenshots, 'create-error-390.png'), fullPage: true });
    await page.getByRole('button', { name: '保存许可', exact: true }).click();
    await page.getByText('站点许可已保存。高风险动作仍需逐次审批。', { exact: true }).waitFor();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert(await page.getByRole('button', { name: '新建站点许可', exact: true }).evaluate(element => element === document.activeElement));
    const calls = await page.evaluate(() => window.calls.filter(row => row.action === 'actionPermissionCreate'));
    assert.equal(calls.length, 2); assert.deepEqual(calls[0], calls[1]);
    assert.equal(calls[0].input.origin, 'https://new.example:8443');
    assert.deepEqual(calls[0].input.categories, ['login', 'private-upload']);
    assert.equal(calls[0].input.actor, undefined); assert.equal(calls[0].input.authorized, undefined);
    await page.getByRole('button', { name: '撤销 https://new.example:8443 的许可', exact: true }).click();
    await page.getByText('许可已撤销，尚未提交的动作将重新校验授权。', { exact: true }).waitFor();
    await page.locator('.ba-permission-row').filter({ hasText: 'https://new.example:8443' }).waitFor({ state: 'hidden' });
    assert.equal(await page.locator('.ba-permission-row').filter({ hasText: 'https://new.example:8443' }).count(), 0);
    await page.getByRole('group', { name: '许可状态', exact: true }).getByRole('button', { name: /历史许可/ }).click();
    const row = page.locator('.ba-permission-row').filter({ hasText: 'https://new.example:8443' });
    assert.equal(await row.getByText('已撤销', { exact: true }).count(), 1);
    assert.equal(await row.getByRole('button').count(), 0);
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await row.getByText('已撤销', { exact: true }).waitFor();
    await page.evaluate(() => window.renderScenario('data', true));
    await page.getByText('https://accounts.example:8443', { exact: true }).waitFor();
    assert.equal(await page.getByText('有效', { exact: true }).count(), 1);

    for (const colorScheme of ['light', 'dark']) for (const width of [1440, 390]) {
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
      await page.evaluate(dark => document.body.toggleAttribute('data-ds-dark-theme', dark), colorScheme === 'dark');
      await page.setViewportSize({ width, height: 960 });
      await page.evaluate(() => window.renderScenario('mixed'));
      const filters = page.getByRole('group', { name: '许可状态', exact: true });
      const activeFilter = filters.getByRole('button', { name: /有效许可\s*2/ });
      const historyFilter = filters.getByRole('button', { name: /历史许可\s*2/ });
      await activeFilter.waitFor();
      assert.equal(await activeFilter.getAttribute('aria-pressed'), 'true');
      assert.equal(await historyFilter.getAttribute('aria-pressed'), 'false');
      assert.equal(await page.locator('.ba-permission-row').count(), 2);
      assert.equal(await page.getByText('https://expired.example', { exact: true }).count(), 0);
      assert.equal(await page.getByText('https://revoked.example', { exact: true }).count(), 0);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `mixed/${width}/${colorScheme} horizontal overflow`);
      if (screenshots) await page.screenshot({ path: join(screenshots, `mixed-active-${width}-${colorScheme}.png`), fullPage: true });

      await historyFilter.focus();
      await page.keyboard.press('Enter');
      await page.getByText('https://expired.example', { exact: true }).waitFor();
      assert.equal(await historyFilter.getAttribute('aria-pressed'), 'true');
      assert.equal(await activeFilter.getAttribute('aria-pressed'), 'false');
      assert.equal(await page.locator('.ba-permission-row').count(), 2);
      assert.equal(await page.getByText('已过期', { exact: true }).count(), 1);
      assert.equal(await page.getByText('已撤销', { exact: true }).count(), 1);
      assert.equal(await page.getByText('https://accounts.example:8443', { exact: true }).count(), 0);
      if (screenshots) await page.screenshot({ path: join(screenshots, `mixed-history-${width}-${colorScheme}.png`), fullPage: true });
      await activeFilter.focus();
      await page.keyboard.press('Space');
      await page.getByText('https://accounts.example:8443', { exact: true }).waitFor();
      const listPosition = await page.locator('.ba-permission-list').boundingBox();

      await page.evaluate(() => { window.permissionRead = 'delay'; });
      await page.getByRole('button', { name: '刷新', exact: true }).click();
      await page.getByText('正在刷新，当前显示上次读取的许可。', { exact: true }).waitFor();
      assert.equal(await page.locator('.ba-permission-row').count(), 2);
      assert.equal(await page.getByText('正在读取授权', { exact: true }).count(), 0);
      assert.deepEqual(await page.locator('.ba-permission-list').boundingBox(), listPosition, 'refresh changes the existing list position');
      if (screenshots) await page.screenshot({ path: join(screenshots, `refreshing-${width}-${colorScheme}.png`), fullPage: true });
      await page.evaluate(() => { window.permissionRead = 'error'; window.finishPermissionRead(); });
      await page.getByRole('alert').filter({ hasText: '刷新失败，当前显示上次读取的许可。' }).waitFor();
      assert.equal(await page.getByRole('alert').filter({ hasText: '授权同步连接中断' }).count(), 1);
      assert.equal(await page.locator('.ba-permission-row').count(), 2);
      assert.equal(await page.getByRole('button', { name: '重试', exact: true }).count(), 1);
      assert.deepEqual(await page.locator('.ba-permission-list').boundingBox(), listPosition, 'refresh failure changes the existing list position');
      if (screenshots) await page.screenshot({ path: join(screenshots, `refresh-error-${width}-${colorScheme}.png`), fullPage: true });
      await page.evaluate(() => { window.permissionRead = 'normal'; });
      await page.getByRole('button', { name: '重试', exact: true }).click();
      await page.getByRole('alert').waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: '刷新', exact: true }).waitFor();
      assert.equal(await page.locator('.ba-permission-row').count(), 2);

      const recordTrigger = page.getByRole('button', { name: '授权与动作记录', exact: true });
      await recordTrigger.focus();
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', { name: '授权与动作记录', exact: true });
      await dialog.waitFor();
      const close = dialog.getByRole('button', { name: '关闭记录', exact: true });
      const dialogBox = await dialog.boundingBox(), closeBox = await close.boundingBox();
      assert(closeBox.x > dialogBox.x + dialogBox.width / 2 && closeBox.y < dialogBox.y + 64, `close control/${width}/${colorScheme} is not top-right`);
      const records = dialog.locator('.ba-permission-audit');
      await records.focus();
      await page.keyboard.press('End');
      await page.waitForFunction(() => document.querySelector('.ba-permission-audit')?.scrollTop > 0);
      assert.deepEqual(await close.boundingBox(), closeBox, 'audit scrolling moves the close control');
      assert(await dialog.evaluate(element => { const rect=element.getBoundingClientRect();return rect.x>=0&&rect.right<=innerWidth&&rect.y>=0&&rect.bottom<=innerHeight; }), `mixed audit/${width}/${colorScheme} outside viewport`);
      if (screenshots) await page.screenshot({ path: join(screenshots, `mixed-audit-${width}-${colorScheme}.png`), fullPage: true });
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
      assert(await recordTrigger.evaluate(element => element === document.activeElement));

      await page.getByRole('button', { name: '新建站点许可', exact: true }).click();
      const createDialog = page.getByRole('dialog', { name: '新建站点许可', exact: true });
      await createDialog.waitFor();
      assert.equal(await createDialog.getByText(/支付或购买、修改密码、删除账号、另行对外发送始终逐次审批/).count(), 1);
      assert(await createDialog.evaluate(element => element.scrollWidth <= element.clientWidth), `create dialog/${width}/${colorScheme} horizontal overflow`);
      if (screenshots) await page.screenshot({ path: join(screenshots, `mixed-create-${width}-${colorScheme}.png`), fullPage: true });
      await createDialog.getByRole('button', { name: '关闭许可表单', exact: true }).click();
      await createDialog.waitFor({ state: 'hidden' });
      assert(await page.getByRole('button', { name: '新建站点许可', exact: true }).evaluate(element => element === document.activeElement));
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
