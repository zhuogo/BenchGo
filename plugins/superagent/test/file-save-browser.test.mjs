import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sharedUiStyles } from '../../benchgo/scripts/shared-ui.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const webRequire = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
const { chromium } = webRequire('playwright');
const { build } = createRequire(new URL('../../benchgo/package.json', import.meta.url))('esbuild');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || [chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const captureDir = process.env.BENCHGO_IMAGE_SCREENSHOTS || join(root, 'artifacts/reply-images-qa');
const original = { url: 'https://download.test/original.bin', name: '原始图片.png', mimeType: 'image/png' };
let fixturePromise;

async function fixture() {
  return fixturePromise ??= (async () => {
    const result = await build({
      stdin: { resolveDir: root, loader: 'jsx', contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { FileSaveButton } from './plugins/shared/client/file-save-button.jsx';
        import { installIconSprite } from './deepseek-harness/packages/client/ui-theme/src/client/icon-sprite.ts';
        installIconSprite({effect:effect=>effect(),on(){}}, undefined);
        window.fileSaves=[];window.nativeMode='saved';window.saveResolvers=[];
        window.dshDesktop={fileActions:{save:async request=>{
          window.fileSaves.push(request);
          if(window.nativeMode==='pending')return new Promise((resolve,reject)=>window.saveResolvers.push({resolve,reject}));
          if(window.nativeMode==='error')throw Error('Native save failed');
          return window.nativeMode==='cancelled'?{status:'cancelled'}:{status:'saved',path:'E:/saved/'+request.name};
        }}};
        const root=createRoot(document.getElementById('root'));
        window.showFile=(file=${JSON.stringify(original)})=>root.render(<main><h1>保存原文件</h1><div className="save-toolbar"><span id="current-file">{file?.name||'暂无可保存文件'}</span>{file&&<FileSaveButton file={file} label="下载图片"><span>下载图片</span></FileSaveButton>}</div><p>继续聊天</p></main>);
        window.showFile();
      ` },
      bundle: true, write: false, outdir: join(root, 'artifacts/unused-save-test-output'), format: 'iife', jsx: 'automatic',
      nodePaths: [join(root, 'plugins/benchgo/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
      alias: {
        react: dirname(webRequire.resolve('react/package.json')), 'react-dom': dirname(webRequire.resolve('react-dom/package.json')),
        '@deepseek-ai/dsh-client-ui-primitives': join(root, 'deepseek-harness/packages/client/ui-primitives/src/index.ts'),
      },
      loader: { '.css': 'text', '.module.css': 'local-css', '.svg': 'text', '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
      plugins: [sharedUiStyles()], define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
    });
    const css = result.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n');
    const js = result.outputFiles.find(file => file.path.endsWith('.js')).text.replaceAll('</script', '<\\/script');
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}*{box-sizing:border-box}body{margin:0;font:14px/1.5 system-ui,sans-serif;background:#f6f7f9;color:#222}main{margin:24px 16px;padding:16px;border:1px solid #ddd;border-radius:16px;background:white;min-height:280px}h1{font-size:17px;margin:0 0 20px}.save-toolbar{display:flex;gap:12px;align-items:center;min-width:0}.save-toolbar>span:first-child{flex:1;min-width:0;overflow-wrap:anywhere}.save-toolbar>.bg-file-save{margin-left:auto}p{margin-top:80px;color:#666}</style></head><body><div id="root"></div><script>${js}</script></body></html>`;
  })();
}

async function start(page) {
  const html = await fixture();
  await page.route('https://download.test/fixture', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
  await page.goto('https://download.test/fixture');
  await page.getByRole('button', { name: '下载图片', exact: true }).waitFor();
}
const saveButton = page => page.getByRole('button', { name: '下载图片', exact: true });
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function assertNoOverflow(page) {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'save feedback never overflows the page');
  for (const note of await page.locator('.bg-file-save-note').all()) {
    const box = await note.boundingBox();
    assert(box && box.x >= -1 && box.x + box.width <= page.viewportSize().width + 1, 'narrow-screen feedback remains within the viewport');
  }
}
async function shot(page, name) {
  if (!captureDir) return;
  await mkdir(captureDir, { recursive: true });
  await frames(page);
  await page.screenshot({ path: join(captureDir, name + '.png'), fullPage: true });
}

test('native save reports success, cancellation and retry without browser fallback across narrow-screen states', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: 320, height: 640 }, reducedMotion: 'reduce' });
    const popups = [], errors = [];
    page.on('popup', popup => popups.push(popup));
    page.on('pageerror', error => errors.push(error.message));
    await start(page);
    await page.evaluate(() => { window.fallbackFetches = 0; window.fetch = async () => { window.fallbackFetches++; throw Error('Unexpected native fallback'); }; });
    await page.evaluate(() => window.showFile(null));
    await page.getByText('暂无可保存文件', { exact: true }).waitFor();
    assert.equal(await saveButton(page).count(), 0);
    await assertNoOverflow(page);
    await shot(page, 'file-save-empty-320');
    await page.evaluate(() => window.showFile());
    await saveButton(page).waitFor();
    assert.equal(await saveButton(page).getAttribute('href'), null);
    assert.equal(await page.locator('a[target="_blank"]').count(), 0);
    await shot(page, 'file-save-ready-320');
    await page.evaluate(() => { window.nativeMode = 'pending'; });
    await saveButton(page).click();
    await page.getByRole('status').filter({ hasText: '正在选择保存位置或保存文件' }).waitFor();
    assert(await saveButton(page).isDisabled());
    assert.equal(await saveButton(page).getAttribute('aria-busy'), 'true');
    await assertNoOverflow(page);
    await shot(page, 'file-save-pending-320');
    await page.evaluate(() => window.saveResolvers[0].resolve({ status: 'saved', path: 'E:/saved/original.png' }));
    await page.getByRole('status').filter({ hasText: '已保存' }).waitFor();
    assert.equal(await saveButton(page).isEnabled(), true);
    assert.deepEqual(await page.evaluate(() => window.fileSaves[0]), { url: original.url, name: original.name, mode: 'saveAs', mediaType: original.mimeType });
    await assertNoOverflow(page);
    await shot(page, 'file-save-saved-320');
    await page.evaluate(() => { window.nativeMode = 'cancelled'; });
    await saveButton(page).click();
    await frames(page);
    assert.equal(await page.locator('.bg-file-save-note').count(), 0, 'native cancellation does not claim that a file was saved');
    assert(await saveButton(page).isEnabled());
    assert.equal(await page.evaluate(() => window.fileSaves.length), 2, 'cancelled save is not retried automatically');
    await page.evaluate(() => { window.nativeMode = 'error'; });
    await saveButton(page).click();
    await page.getByRole('alert').filter({ hasText: '保存文件失败，请重试。' }).waitFor();
    assert(await saveButton(page).isEnabled());
    await assertNoOverflow(page);
    await shot(page, 'file-save-error-320');
    await page.evaluate(() => { window.nativeMode = 'saved'; });
    await saveButton(page).click();
    await page.getByRole('status').filter({ hasText: '已保存' }).waitFor();
    assert.equal(await page.getByRole('alert').count(), 0, 'an explicit retry clears the previous failure');
    assert.equal(await page.evaluate(() => window.fileSaves.length), 4);
    assert.equal(await page.evaluate(() => window.fallbackFetches), 0, 'native errors and cancellation never fall back to browser fetching');
    assert.equal(page.url(), 'https://download.test/fixture');
    assert.equal(popups.length, 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('pending saves deduplicate clicks and capture their target without leaking results to a different image', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 700 }, reducedMotion: 'reduce' });
    await start(page);
    await page.evaluate(() => { window.nativeMode = 'pending'; });
    await saveButton(page).evaluate(button => { button.click(); button.click(); button.click(); });
    assert.equal(await page.evaluate(() => window.fileSaves.length), 1, 'repeated clicks in one event turn create only one native request');
    assert(await saveButton(page).isDisabled());
    const next = { url: 'https://download.test/next.jpg', name: '下一张.jpg' };
    await page.evaluate(file => window.showFile(file), next);
    await page.getByText(next.name, { exact: true }).waitFor();
    assert(await saveButton(page).isEnabled(), 'switching images does not transfer the old pending state');
    await page.evaluate(() => window.saveResolvers[0].resolve({ status: 'saved', path: 'E:/saved/original.png' }));
    await frames(page);
    assert.equal(await page.locator('.bg-file-save-note').count(), 0, 'the old image completion does not appear on the newly selected image');
    assert.equal((await page.evaluate(() => window.fileSaves[0])).url, original.url, 'the request retains the original target after the UI switches');
    await saveButton(page).click();
    assert.deepEqual(await page.evaluate(() => window.fileSaves[1]), { ...next, mode: 'saveAs' });
    await page.evaluate(() => window.saveResolvers[1].resolve({ status: 'saved', path: 'E:/saved/next.jpg' }));
    await page.getByRole('status').filter({ hasText: '已保存' }).waitFor();
    await assertNoOverflow(page);
  } finally { await browser.close(); }
});

test('web saving downloads the exact original bytes and filename without a popup, and exposes CORS and HTTP failures', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: 320, height: 640 }, reducedMotion: 'reduce', acceptDownloads: true });
    const popups = [], downloads = [];
    page.on('popup', popup => popups.push(popup));
    page.on('download', download => downloads.push(download));
    const bytes = Buffer.from([0, 255, 13, 10, 128, 42, 0, 195, 169, 70, 73, 76, 69]);
    await page.route(original.url, route => route.fulfill({ contentType: 'image/png', body: bytes }));
    await page.route('https://blocked.test/file.png', route => route.fulfill({ contentType: 'image/png', headers: { 'access-control-allow-origin': 'https://not-allowed.test' }, body: bytes }));
    await page.route('https://download.test/missing.bin', route => route.fulfill({ status: 404, body: 'Missing' }));
    await start(page);
    await page.evaluate(() => { delete window.dshDesktop; });
    const downloading = page.waitForEvent('download');
    await saveButton(page).click();
    const download = await downloading;
    assert.equal(download.suggestedFilename(), original.name);
    const chunks = [], stream = await download.createReadStream();
    for await (const chunk of stream) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), bytes, 'the browser saves the fetched bytes without canvas or image re-encoding');
    await page.getByRole('status').filter({ hasText: '已发起下载，保存位置由浏览器设置决定。' }).waitFor();
    await assertNoOverflow(page);
    await shot(page, 'file-save-browser-requested-320');
    await page.evaluate(() => window.showFile({ url: 'https://blocked.test/file.png', name: '跨域图片.png' }));
    await page.getByText('跨域图片.png', { exact: true }).waitFor();
    await saveButton(page).click();
    await page.getByRole('alert').filter({ hasText: '跨域访问' }).waitFor();
    await assertNoOverflow(page);
    await shot(page, 'file-save-cors-error-320');
    await page.evaluate(() => window.showFile({ url: 'https://download.test/missing.bin', name: '丢失文件.bin' }));
    await page.getByText('丢失文件.bin', { exact: true }).waitFor();
    await saveButton(page).click();
    await page.getByRole('alert').filter({ hasText: 'HTTP 404' }).waitFor();
    assert.equal(downloads.length, 1, 'failed fetches do not navigate or initiate an empty download');
    assert.equal(popups.length, 0);
    assert.equal(page.url(), 'https://download.test/fixture');
    assert.equal(await page.evaluate(() => window.fileSaves.length), 0);
    await assertNoOverflow(page);
  } finally { await browser.close(); }
});
