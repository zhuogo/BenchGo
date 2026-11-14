import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { sharedUiStyles } from '../scripts/shared-ui.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
const { chromium } = require('playwright');
const { build } = createRequire(new URL('../package.json', import.meta.url))('esbuild');
const executablePath = [process.env.CHROMIUM_EXECUTABLE_PATH, chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(path => path && existsSync(path));

async function fixture() {
  const bundle = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';
    import {ArtifactPreview} from './plugins/shared/client/artifact-preview.jsx';
    import {installIconSprite} from './deepseek-harness/packages/client/ui-theme/src/client/icon-sprite.ts';
    installIconSprite({effect:fn=>fn(),on:()=>{}},undefined);
    const root=createRoot(document.getElementById('root'));let serial=0;
    window.renderScenario=(mode='data',kind='md',embedded=false)=>{
      window.previewClosed=false;
      const file={name:'版本交付与回归检查记录-保留完整名称用于确认当前文件-2026-11-08.'+kind,url:'/files/content.'+kind+'?mode='+mode,...embedded?{pdfUrl:false}:{}};
      root.render(<main key={++serial}><ArtifactPreview file={file} embedded={embedded} onClose={()=>{window.previewClosed=true;}}/></main>);
    };
  ` }, bundle: true, write: false, outdir: join(root, 'artifacts', 'unused-preview-browser'), format: 'iife', jsx: 'automatic',
    nodePaths: [join(root, 'plugins/benchgo/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
    alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')) },
    loader: { '.css': 'text', '.module.css': 'local-css', '.svg': 'text' }, plugins: [{ name: 'official-preview-primitives-source', setup(build) {
      // The isolated checkout need not have official generated lib/. Exercise
      // the exact upstream components used here, without a substitute or build.
      build.onResolve({ filter: /^@deepseek-ai\/dsh-client-ui-primitives$/ }, () => ({ path: 'preview-primitives', namespace: 'official-source' }));
      build.onLoad({ filter: /.*/, namespace: 'official-source' }, () => ({ loader: 'ts', resolveDir: root, contents: `
        export { Tooltip } from './deepseek-harness/packages/client/ui-primitives/src/Tooltip.tsx';
        export { IconDownloadOutlineRegular, IconCodeOutlineRegular, IconInspectOutlineRegular, ICON_SYMBOLS } from './deepseek-harness/packages/client/ui-primitives/src/icons/index.tsx';
      ` }));
    } }, sharedUiStyles()], define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font:14px/1.5 Arial,sans-serif;--dsw-alias-bg-base:#fff;--dsw-alias-label-primary:#202124;--dsw-alias-label-secondary:#6b6b70;--ba-line:#ddd;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}body[data-ds-dark-theme]{--dsw-alias-bg-base:#19191b;--dsw-alias-label-primary:#ededee;--dsw-alias-label-secondary:#a3a3a8;--ba-line:#3b3b40}main{padding:24px;max-width:1000px;margin:auto;box-sizing:border-box}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script></body></html>`;
}

test('file previews keep theme, long names, four states and recoverable media errors in the real browser', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const screenshots = process.env.BENCHGO_PREVIEW_SCREENSHOTS;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  try {
    const page = await browser.newPage(), errors = [];
    page.setDefaultTimeout(7000);page.on('pageerror', error => errors.push(error.message));
    const html = await fixture(), markdown = await readFile(join(root, 'plugins/benchgo/lib/preview/markdown.js'), 'utf8');
    let mediaAttempts = 0, textAttempts = 0;
    await page.route('**/*', route => {
      const url = new URL(route.request().url()), mode = url.searchParams.get('mode');
      if (url.href === 'http://localhost/') return route.fulfill({ contentType: 'text/html', body: html });
      if (url.pathname.endsWith('/markdown.js')) return route.fulfill({ contentType: 'application/javascript', body: markdown });
      if (mode === 'loading') return;
      if (url.pathname.endsWith('.png')) {
        if (++mediaAttempts === 1) return route.fulfill({ status: 503, body: 'offline' });
        return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR1kAAAAASUVORK5CYII=', 'base64') });
      }
      if (mode === 'error' && ++textAttempts === 1) return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"文件服务暂时不可用"}' });
      if (mode === 'empty') return route.fulfill({ contentType: 'text/plain', body: '' });
      if (url.pathname.endsWith('.json')) return route.fulfill({ contentType: 'application/json', body: '{"状态":"已保存","文件":["文档","图像"]}' });
      return route.fulfill({ contentType: 'text/markdown', body: '# 交付记录\n\n保留完整文件名，清晰查看内容。\n\n> 这是一条备注。\n\n| 项目 | 状态 |\n| --- | --- |\n| 页面检查 | 完成 |\n\n```text\n完整内容仍可切换原文查看。\n```' });
    });
    await page.goto('http://localhost/');
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const dark of [false, true]) {
        await page.evaluate(value => document.body.toggleAttribute('data-ds-dark-theme', value), dark);
        for (const mode of ['loading', 'empty', 'error', 'data']) {
          textAttempts = 0;
          await page.evaluate(mode => window.renderScenario(mode), mode);
          if (mode === 'data') {
            const frame = page.frameLocator('iframe');
            await frame.getByRole('heading', { name: '交付记录' }).waitFor();
            const color = await frame.locator('body').evaluate(node => getComputedStyle(node).backgroundColor);
            assert.equal(color, dark ? 'rgb(25, 25, 27)' : 'rgb(255, 255, 255)');
            assert.equal(await page.locator('iframe').getAttribute('sandbox'), '');
          } else await page.getByText({ loading: '正在打开文件…', empty: '这个文件还是空的', error: '暂时无法预览' }[mode], { exact: true }).waitFor();
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}/${dark}/${mode} overflows`);
          if (screenshots) await page.screenshot({ path: join(screenshots, `${dark ? 'dark' : 'light'}-${width}-${mode}.png`), fullPage: true });
          if (mode === 'error') {
            await page.getByRole('button', { name: '重试', exact: true }).click();
            await page.frameLocator('iframe').getByRole('heading', { name: '交付记录' }).waitFor();
          }
        }
      }
    }
    await page.evaluate(() => document.body.removeAttribute('data-ds-dark-theme'));
    await page.waitForFunction(() => document.querySelector('iframe')?.srcdoc.includes('data-theme="light"'));
    await page.evaluate(() => { document.documentElement.dataset.theme='dark';document.body.style.setProperty('--dsw-alias-bg-base','#19191b'); });
    await page.waitForFunction(() => document.querySelector('iframe')?.srcdoc.includes('data-theme="dark"'));
    await page.getByRole('button', { name: '查看原文', exact: true }).click();
    await page.locator('.bg-preview-text').filter({ hasText: '# 交付记录' }).waitFor();
    assert.equal(await page.getByRole('button', { name: '查看预览', exact: true }).getAttribute('aria-pressed'), 'true');
    await page.getByRole('button', { name: '查看预览', exact: true }).click();
    await page.frameLocator('iframe').getByRole('heading', { name: '交付记录' }).waitFor();
    await page.evaluate(() => window.renderScenario('data', 'json'));
    await page.getByText('已保存', { exact: false }).waitFor();
    await page.evaluate(() => window.renderScenario('data', 'png'));
    await page.getByText('暂时无法预览', { exact: true }).waitFor();
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.bg-preview-media')?.getAttribute('aria-busy') === 'false');
    assert.equal(mediaAttempts, 2);
    await page.getByRole('button', { name: '← 返回', exact: true }).focus();
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => window.previewClosed), true);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

async function presentation({ empty = false } = {}) {
  const JSZip = createRequire(new URL('../package.json', import.meta.url))('jszip'), zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' + (empty ? '' : '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>') + '</Types>');
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>');
  zip.file('ppt/presentation.xml', '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst>' + (empty ? '' : '<p:sldId id="256" r:id="rId1"/>') + '</p:sldIdLst><p:sldSz cx="9144000" cy="5143500"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>');
  zip.file('ppt/_rels/presentation.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + (empty ? '' : '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>') + '</Relationships>');
  if (!empty) {
    zip.file('ppt/slides/slide1.xml', '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="457200"/><a:ext cx="8229600" cy="1828800"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="EDF2FF"/></a:solidFill></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN" sz="2800"/><a:t>BenchGo 演示预览</a:t></a:r></a:p><a:p><a:r><a:rPr lang="zh-CN" sz="1600"/><a:t>本地解析 · 无需安装 Office</a:t></a:r></a:p></p:txBody></p:sp><p:pic><p:nvPicPr><p:cNvPr id="3" name="External picture"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:link="rIdImage"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="457200" y="2743200"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>');
    zip.file('ppt/slides/_rels/slide1.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://preview-external.invalid/tracker.png" TargetMode="External"/></Relationships>');
  }
  return zip.generateAsync({ type: 'nodebuffer' });
}

test('built-in PPTX previews render actual slides in an isolated frame with four states and no converter', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  let server;
  const screenshots = process.env.BENCHGO_PREVIEW_SCREENSHOTS;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  try {
    const page = await browser.newPage(), errors = [], requests = [], outbound = [], assetRequests = [];
    page.context().on('request', request => outbound.push(request.url()));
    page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
    const diagnostics = []; page.on('console', message => { if (message.type() === 'error') diagnostics.push(message.text()); });
    const html = await fixture(), runner = await readFile(join(root, 'plugins/benchgo/lib/preview/pptx.js'));
    const sample = await presentation(), empty = await presentation({ empty: true });
    let runnerFailures = 1;
    server = createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`), mode = url.searchParams.get('mode'); requests.push(url.href);
      if (url.pathname === '/') { res.setHeader('content-type', 'text/html'); res.setHeader('set-cookie', 'benchgo-preview-test=1; HttpOnly; SameSite=Strict; Path=/'); res.end(html); return; }
      if (url.pathname.endsWith('/pptx.js')) {
        const site = req.headers['sec-fetch-site'], source = req.headers.origin, cookie = req.headers.cookie;
        // Mirror the official /api trust fence: opaque sandbox requests must
        // fail; only the authenticated same-origin parent may fetch assets.
        if (site === 'cross-site' || source === 'null' || source && source !== url.origin) { res.writeHead(403); res.end('forbidden'); return; }
        assetRequests.push({ site, source, cookie });
        if (!cookie?.includes('benchgo-preview-test=1')) { res.writeHead(401); res.end('authentication required'); return; }
        if (runnerFailures-- > 0) { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"ok":false,"error":{"message":"组件服务暂时不可用"}}'); return; }
        res.setHeader('content-type', 'application/javascript'); res.end(runner); return;
      }
      if (url.pathname.endsWith('.pptx')) {
        if (mode === 'loading') return;
        res.setHeader('content-type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'); res.end(mode === 'empty' ? empty : mode === 'error' ? Buffer.from('damaged presentation') : sample); return;
      }
      res.writeHead(404); res.end();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const assetPath = origin + '/api/benchgo/preview-assets/pptx.js';
    assert.equal((await fetch(assetPath, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.equal((await fetch(assetPath, { headers: { origin: 'null' } })).status, 403);
    await page.goto(origin + '/');
    await page.evaluate(() => window.renderScenario('data', 'pptx', true));
    await page.getByText('演示预览组件加载失败：组件服务暂时不可用', { exact: true }).waitFor();
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await page.frameLocator('.bg-pptx-frame').getByText('BenchGo 演示预览', { exact: true }).waitFor();
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 850 });
      for (const dark of [false, true]) {
        await page.evaluate(value => document.body.toggleAttribute('data-ds-dark-theme', value), dark);
        for (const mode of ['loading', 'empty', 'error', 'data']) {
          await page.evaluate(mode => window.renderScenario(mode, 'pptx', true), mode);
          if (mode === 'data') {
            const frame = page.frameLocator('.bg-pptx-frame');
            await frame.getByText('BenchGo 演示预览', { exact: true }).waitFor();
            await page.getByText('共 1 页', { exact: false }).waitFor();
            assert.equal(await page.locator('.bg-pptx-frame').getAttribute('sandbox'), 'allow-scripts');
            assert.equal(await frame.locator('body').evaluate(() => { try { return Boolean(parent.document); } catch { return false; } }), false);
          } else {
            try { await page.getByText({ loading: '正在打开文件…', empty: '演示文稿还是空的', error: '暂时无法预览' }[mode], { exact: true }).waitFor(); }
            catch (error) { throw new Error(`${error.message}\n${await page.locator('body').innerText()}\n${errors.join('\n')}\n${requests.join('\n')}\n${diagnostics.join('\n')}\n${await page.locator('iframe').getAttribute('srcdoc')}`); }
          }
          assert.equal(await page.getByRole('button', { name: '← 返回', exact: true }).count(), 0);
          assert.equal(await page.getByRole('button', { name: '尝试 PDF 预览', exact: true }).count(), 0);
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}/${dark}/${mode} overflows`);
          if (screenshots) await page.screenshot({ path: join(screenshots, `pptx-${dark ? 'dark' : 'light'}-${width}-${mode}.png`), fullPage: true });
        }
      }
    }
    assert.equal(requests.some(url => !url.startsWith(origin + '/')), false, 'presentation external media must never be fetched');
    assert.equal(outbound.some(url => !url.startsWith(origin + '/')), false, 'preview must not request remote resources');
    assert.equal(requests.some(url => url.includes('preview=pdf')), false, 'PPTX requires no converter');
    assert(assetRequests.length > 0, 'the authenticated parent must fetch the local renderer');
    assert(assetRequests.every(request => request.site === 'same-origin' && request.source !== 'null' && request.cookie?.includes('benchgo-preview-test=1')), 'renderer fetch preserves same-origin browser markers and credentials');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } }
});
