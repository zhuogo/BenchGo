import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { unwrapClient, workbenchClientAdapters } from '../scripts/vendor-adapter.mjs';
import { sharedUiStyles } from '../../benchgo/scripts/shared-ui.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const webRequire = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
const require = createRequire(new URL('../../benchgo/package.json', import.meta.url));
const { chromium } = webRequire('playwright');
const { build } = require('esbuild');
const executablePath = [process.env.CHROMIUM_EXECUTABLE_PATH, chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(path => path && existsSync(path));

async function fixture() {
  const primitivesSource = { name: 'workbench-official-primitives-source', setup(build) {
    build.onResolve({ filter: /^@deepseek-ai\/dsh-client-ui-primitives$/ }, () => ({ path: 'workbench-primitives', namespace: 'official-source' }));
    build.onLoad({ filter: /.*/, namespace: 'official-source' }, () => ({ loader: 'ts', resolveDir: root, contents: `export {Tooltip} from './deepseek-harness/packages/client/ui-primitives/src/Tooltip.tsx';export * from './deepseek-harness/packages/client/ui-primitives/src/icons/index.tsx';` }));
  } };
  // The real product supplies these through its ModuleLoader. Share exactly
  // one React instance with the published CJS vendor factories in this fixture.
  const runtime = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `import * as React from 'react';import * as DOM from 'react-dom';import * as Client from 'react-dom/client';import * as JSX from 'react/jsx-runtime';import * as Primitives from '@deepseek-ai/dsh-client-ui-primitives';const modules={'react':React,'react-dom':DOM,'react-dom/client':Client,'react/jsx-runtime':JSX,'@deepseek-ai/dsh-client-ui-primitives':Primitives};globalThis.require=name=>{if(!modules[name])throw Error('Unknown fixture module '+name);return modules[name];};` }, bundle: true, write: false, outdir: join(root, 'artifacts', 'unused-workbench-runtime'), format: 'iife', jsx: 'automatic', nodePaths: [join(root, 'plugins/benchgo/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')], alias: { react: dirname(webRequire.resolve('react/package.json')), 'react-dom': dirname(webRequire.resolve('react-dom/package.json')) }, loader: { '.css': 'text', '.module.css': 'local-css', '.svg': 'text' }, plugins: [primitivesSource], define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  const result = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React,{useEffect,useState} from 'react';import {createRoot} from 'react-dom/client';
    import {WorkbenchPage} from './plugins/workbench/client/index.jsx';
    import {mountWorkbenchPreviews} from './plugins/workbench/client/previews.jsx';
    import {Loading} from './plugins/shared/client/ui/loading.jsx';
    import {installIconSprite} from './deepseek-harness/packages/client/ui-theme/src/client/icon-sprite.ts';
    installIconSprite({effect:fn=>fn(),on:()=>{}},undefined);
    const raf=requestAnimationFrame.bind(window),cancel=cancelAnimationFrame.bind(window);
    window.animationStats={pending:new Set(),executed:0};
    window.requestAnimationFrame=callback=>{const id=raf(time=>{window.animationStats.pending.delete(id);window.animationStats.executed++;callback(time);});window.animationStats.pending.add(id);return id;};
    window.cancelAnimationFrame=id=>{window.animationStats.pending.delete(id);cancel(id);};
    window.playbackContexts=[];window.audioElements=[];
    window.AudioContext=new Proxy(window.AudioContext,{construct(target,args){const context=Reflect.construct(target,args);window.playbackContexts.push(context);return context;}});
    window.Audio=new Proxy(window.Audio,{construct(target,args){const element=Reflect.construct(target,args);window.audioElements.push(element);return element;}});
    const canvasClear=CanvasRenderingContext2D.prototype.clearRect,canvasText=CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.clearRect=function(...args){if(this.canvas.parentElement?.classList.contains('dsh-audio__ruler'))window.rulerLabels=[];return canvasClear.apply(this,args);};
    CanvasRenderingContext2D.prototype.fillText=function(text,x,y,...args){if(this.canvas.parentElement?.classList.contains('dsh-audio__ruler'))window.rulerLabels.push({text,x,width:this.measureText(text).width});return canvasText.call(this,text,x,y,...args);};
    const viewers=new Map(),effects=[];
    const service={hostRouteUrl:path=>new URL(path,document.baseURI).href,registerFileViewer:descriptor=>{viewers.set(descriptor.id,descriptor);return()=>viewers.delete(descriptor.id);}};
    const ctx={effect:fn=>{const dispose=fn();if(typeof dispose==='function')effects.push(dispose);},get:()=>undefined};
    mountWorkbenchPreviews(ctx,service);
    window.viewerInventory=[...viewers.values()].map(({id,exts,fetchStrategy})=>({id,exts,fetchStrategy}));
    const host={connection:{isLoopback:true},sessions:{list:{getSnapshot:()=>({byId:{project:{retainedBy:{mainView:1}}}})}},layout:{selectPanel:value=>window.lastPanel=value}};
    const version={sidebar:true,ssh:true,error:''};
    const runtime={snapshot:()=>version,subscribe:()=>()=>{},sidebar:{getTab:()=>({}),openTab:(...args)=>window.openedTab=args}};
    const app=createRoot(document.getElementById('root'));let serial=0;
    function Viewer({id,path}){const descriptor=viewers.get(id),[data,setData]=useState(null);useEffect(()=>{const c=new AbortController();if(descriptor.load)descriptor.load(path,{sessionId:'project'},c.signal).then(value=>{if(!c.signal.aborted)setData(value)});return()=>c.abort();},[id,path]);
      if(descriptor.load&&!data)return <Loading label="正在打开文件…"/>;
      const Component=descriptor.component;return <Component scope={{sessionId:'project'}} path={path} title={path.split('/').at(-1)} customData={data}/>;}
    function Shell({children}){return <div className="fixture-shell"><aside><strong>BenchGo</strong><p>项目工作台</p><p>文件 · Git · 终端</p></aside><main><nav aria-label="工作台导航">项目 / 本地文件</nav>{children}<footer>项目资料保留在本机 · 文件预览</footer></main></div>;}
    window.renderWorkbench=()=>app.render(<Shell key={++serial}><WorkbenchPage host={host} runtime={runtime}/></Shell>);
    window.renderViewer=(id,path)=>app.render(<Shell key={++serial}><section className="fixture-preview" aria-label="项目文件预览"><Viewer id={id} path={path}/></section></Shell>);
  ` }, bundle: true, write: false, outdir: join(root, 'artifacts', 'unused-workbench-browser'), format: 'iife', jsx: 'automatic',
    nodePaths: [join(root, 'plugins/benchgo/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'],
    loader: { '.css': 'text', '.module.css': 'local-css', '.svg': 'text' },
    plugins: [workbenchClientAdapters(), sharedUiStyles()], define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
    *{box-sizing:border-box}body{margin:0;font:14px/1.6 Arial,sans-serif;--dsw-alias-bg-base:#fff;--dsw-alias-label-primary:#202124;--dsw-alias-label-secondary:#6b6b70;--dsw-alias-state-business-primary:#315be8;--ba-line:#ddd;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}body[data-ds-dark-theme]{--dsw-alias-bg-base:#19191b;--dsw-alias-label-primary:#ededee;--dsw-alias-label-secondary:#a3a3a8;--ba-line:#3b3b40;color-scheme:dark}.fixture-shell{display:grid;grid-template-columns:160px minmax(0,1fr);min-height:100vh}.fixture-shell>aside{padding:24px 16px;border-right:1px solid #8883}.fixture-shell>main{min-width:0;padding:20px;overflow:hidden}.fixture-shell nav,.fixture-shell footer{font-size:12px;color:var(--dsw-alias-label-secondary);padding:12px 0}.fixture-shell nav{border-bottom:1px solid #8883}.fixture-shell footer{border-top:1px solid #8883;margin-top:20px}.fixture-preview{height:650px;min-width:0;overflow:auto;margin-top:20px}.fixture-preview>.dsh-audio{height:100%}button,input,select{font:inherit}.cmd-search-toggle{border:0;background:none;color:inherit;padding:8px}@media(max-width:650px){.fixture-shell{grid-template-columns:minmax(0,1fr)}.fixture-shell>aside{display:none}.fixture-shell>main{padding:12px}.fixture-preview{height:720px}}
  </style><style>${[...runtime.outputFiles, ...result.outputFiles].filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n')}</style></head><body><div id="root"></div><script>${runtime.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script><script>${result.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script></body></html>`;
}

function wav() {
  const rate = 22050, samples = rate * 8, bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) bytes.writeInt16LE(Math.round(Math.sin(index / rate * Math.PI * 880) * 12000 * (.7 + .3 * Math.sin(index / rate * Math.PI * 4))), 44 + index * 2);
  return bytes;
}

async function docx() {
  const JSZip = require('jszip'), zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:b/><w:sz w:val="36"/></w:rPr><w:t>BenchGo 项目文档</w:t></w:r></w:p><w:p><w:r><w:t>工作台内置文档预览，无需额外安装。</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="720" w:bottom="720" w:left="720" w:right="720"/></w:sectPr></w:body></w:document>');
  return zip.generateAsync({ type: 'nodebuffer' });
}

// A tiny VP8 WebM container from a real browser-encoded WebP keyframe. This
// also works on headless machines whose canvas captureStream produces no frames.
function videoFromWebp(webp) {
  let frame;
  for (let offset = 12; offset + 8 < webp.length;) { const size = webp.readUInt32LE(offset + 4); if (webp.toString('ascii', offset, offset + 4) === 'VP8 ') { frame = webp.subarray(offset + 8, offset + 8 + size); break; } offset += 8 + size + (size & 1); }
  assert(frame, 'browser must encode a VP8 keyframe');
  const element = (id, value) => { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value); let width = 1; while (bytes.length >= 2 ** (7 * width) - 1) width++; const size = Buffer.alloc(width); let n = bytes.length; for (let index = width - 1; index >= 0; index--) { size[index] = n & 255; n = Math.floor(n / 256); } size[0] |= 1 << (8 - width); return Buffer.concat([Buffer.from(id, 'hex'), size, bytes]); };
  const combine = (...items) => Buffer.concat(items), duration = Buffer.alloc(8); duration.writeDoubleBE(1000);
  const ebml = element('1a45dfa3', combine(element('4286', [1]), element('42f7', [1]), element('42f2', [4]), element('42f3', [8]), element('4282', Buffer.from('webm')), element('4287', [2]), element('4285', [2])));
  const info = element('1549a966', combine(element('2ad7b1', [15, 66, 64]), element('4489', duration), element('4d80', Buffer.from('BenchGo fixture')), element('5741', Buffer.from('BenchGo fixture'))));
  const tracks = element('1654ae6b', element('ae', combine(element('d7', [1]), element('73c5', [1]), element('83', [1]), element('9c', [0]), element('86', Buffer.from('V_VP8')), element('e0', combine(element('b0', [240]), element('ba', [135]))))));
  const cluster = element('1f43b675', combine(element('e7', [0]), element('a3', combine(Buffer.from([129, 0, 0, 128]), frame)), element('a3', combine(Buffer.from([129, 3, 232, 128]), frame))));
  return combine(ebml, element('18538067', combine(info, tracks, cluster)));
}

// Browser fixture only: real published clients/renderers and codecs, mocked
// transport and host registry. This does not start BenchGo or claim installed E2E.
test('audio build adapter adds bounded retries and non-overlapping time labels', async () => {
  const source = await readFile(require.resolve('@huanlin/dsh-plugin-better-sidebar-plugin-audio/client'), 'utf8');
  const adapted = unwrapClient(source, '@huanlin/dsh-plugin-better-sidebar-plugin-audio');
  assert.match(adapted, /function BenchGoAudioViewer/); assert.match(adapted, /loadAudioSource\(props\.path, props\.scope, controller\.signal\)/); assert.match(adapted, /request\.current\?\.abort/); assert.match(adapted, /labelX >= benchgoLabelEnd \+ 8/); assert.match(adapted, /g\.measureText\(label\)/);
});

test('built-in workbench renders four states and real audio/video/Office previews', { skip: !executablePath && 'Chromium/Edge is required', timeout: 120000 }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  let server;
  const screenshots = process.env.BENCHGO_WORKBENCH_SCREENSHOTS;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  try {
    const html = await fixture(), xlsx = require('xlsx'), workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, xlsx.utils.aoa_to_sheet([['项目', '状态', '数量'], ['内置预览', '完成', 3], ['媒体回放', '可用', 2]]), '项目资料');
    const files = new Map([['wav', { bytes: wav(), mime: 'audio/wav' }], ['docx', { bytes: await docx(), mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }], ['xlsx', { bytes: xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' }), mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }]]);
    let mode = 'data', mediaMode = 'data'; const pending = [];
    const errors = [], requests = [];
    server = createServer(async (req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`); requests.push(url.pathname + url.search);
      if (url.pathname === '/') { res.setHeader('content-type', 'text/html'); res.end(html); return; }
      if (url.pathname === '/api/benchgo/workbench') {
        if (mode === 'loading') { pending.push(res); return; }
        res.setHeader('content-type', 'application/json');
        if (mode === 'error') { res.writeHead(503); res.end(JSON.stringify({ error: '工作台连接暂时中断' })); return; }
        res.end(JSON.stringify({ sidebar: { available: true }, ssh: { available: true }, trustedHosts: mode === 'empty' ? [] : [{ id: 'host', host: 'server.example', port: 22, fingerprint: 'SHA256:BenchGoFixtureHostFingerprint' }] })); return;
      }
      if (url.pathname.startsWith('/api/benchgo/preview-assets/')) {
        const name = url.pathname.slice('/api/benchgo/preview-assets/'.length);
        if (!/^[\w./-]+$/.test(name) || name.includes('..')) { res.writeHead(400); res.end(); return; }
        try { res.setHeader('content-type', name.endsWith('.js') ? 'text/javascript' : 'application/octet-stream'); res.end(await readFile(join(root, 'plugins/benchgo/lib/preview', name))); } catch { res.writeHead(404); res.end(); } return;
      }
      if (url.pathname.startsWith('/api/benchgo/workbench/media')) {
        if (mediaMode === 'loading') return;
        if (mediaMode === 'error') { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: { message: '文件读取暂时失败' } })); return; }
        const path = url.searchParams.get('path'), ext = path?.split('.').at(-1), file = files.get(ext);
        if (!file) { res.writeHead(404); res.end(); return; }
        if (url.pathname.endsWith('/meta')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, value: { path, name: path.split('/').at(-1), size: file.bytes.length, mime: file.mime } })); return; }
        const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || ''), start = range ? Number(range[1]) : 0, end = range && range[2] ? Math.min(Number(range[2]), file.bytes.length - 1) : file.bytes.length - 1;
        if (start >= file.bytes.length) { res.writeHead(416, { 'content-range': `bytes */${file.bytes.length}` }); res.end(); return; }
        res.writeHead(range ? 206 : 200, { 'content-type': file.mime, 'accept-ranges': 'bytes', 'content-length': end - start + 1, ...(range ? { 'content-range': `bytes ${start}-${end}/${file.bytes.length}` } : {}) }); res.end(req.method === 'HEAD' ? undefined : file.bytes.subarray(start, end + 1)); return;
      }
      res.writeHead(404); res.end();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const page = await browser.newPage({ locale: 'zh-CN' }); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    // Browser-encode a real VP8 frame, then decode a real WebM response through
    // HTTP. No synthetic loadedmetadata or other DOM media events are dispatched.
    const webp = await page.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 135;
      const context = canvas.getContext('2d'); context.fillStyle = '#315be8'; context.fillRect(0, 0, 240, 135); context.fillStyle = '#fff'; context.font = '22px sans-serif'; context.fillText('BenchGo', 65, 75);
      return [...new Uint8Array(await (await fetch(canvas.toDataURL('image/webp', .8))).arrayBuffer())];
    });
    files.set('webm', { bytes: videoFromWebp(Buffer.from(webp)), mime: 'video/webm' });
    const inventory = await page.evaluate(() => window.viewerInventory);
    assert(inventory, `fixture did not initialize: ${errors.join('; ')}`);
    for (const id of ['dsh-audio-preview:audio', 'video', 'benchgo-document', 'benchgo-spreadsheet', 'benchgo-presentation']) assert(inventory.some(item => item.id === id), `${id} must register`);
    await page.evaluate(() => window.renderWorkbench()); await page.getByText('server.example:22', { exact: true }).waitFor();
    assert.equal(requests.some(url => url.includes('/preview-assets/') || url.includes('/workbench/media')), false, 'opening the populated workbench must not fetch media or parsers');
    const shot = async name => { assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name} horizontally overflows`); if (screenshots) await page.screenshot({ path: join(screenshots, name + '.png'), fullPage: true }); };
    for (const width of [1280, 390]) for (const dark of [false, true]) {
      await page.setViewportSize({ width, height: 940 }); await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' }); await page.evaluate(value => document.body.toggleAttribute('data-ds-dark-theme', value), dark);
      const theme = `${width}-${dark ? 'dark' : 'light'}`;
      for (const state of ['loading', 'empty', 'error', 'data']) {
        mode = state; for (const response of pending.splice(0)) { response.writeHead(503, { 'content-type': 'application/json' }); response.end('{"error":"fixture loading completed"}'); } await page.evaluate(() => window.renderWorkbench());
        await page.getByText({ loading: '正在读取工作台状态', empty: '尚未确认服务器', error: '工作台暂时不可用', data: 'server.example:22' }[state], { exact: true }).waitFor().catch(async error => { throw new Error(`${error.message}\n${await page.locator('body').innerText()}\n${errors.join('; ')}`); });
        await shot(`workbench-${theme}-${state}`);
        if (state === 'error') { mode = 'data'; await page.getByRole('button', { name: '重试', exact: true }).click(); await page.getByText('server.example:22', { exact: true }).waitFor(); }
      }
      await page.getByRole('button', { name: '文件', exact: true }).click(); assert.equal(await page.evaluate(() => window.openedTab[0].type), 'editor');
      for (const [id, ext] of [['dsh-audio-preview:audio', 'wav'], ['video', 'webm'], ['benchgo-document', 'docx'], ['benchgo-spreadsheet', 'xlsx']]) {
        mediaMode = 'data'; await page.evaluate(({ id, ext }) => window.renderViewer(id, `/project/BenchGo-项目资料.${ext}`), { id, ext });
        if (ext === 'wav') { await page.locator('.dsh-audio__meta').filter({ hasText: '分析 16.0 kHz' }).waitFor(); assert(await page.locator('.dsh-audio__lane>canvas').first().evaluate(canvas => canvas.width > 50 && canvas.height > 50)); await page.waitForFunction(() => window.rulerLabels?.length > 1); const labels = await page.evaluate(() => window.rulerLabels); for (let index = 1; index < labels.length; index++) assert(labels[index].x >= labels[index-1].x + labels[index-1].width + 7, 'painted time labels must not overlap'); }
        if (ext === 'webm') { await page.waitForFunction(() => { const video = document.querySelector('video'); return video?.readyState >= 1 && video.videoWidth === 240; }).catch(async error => { throw new Error(`${error.message}\n${await page.locator('body').innerText()}\n${JSON.stringify(await page.locator('video').evaluateAll(nodes=>nodes.map(v=>({src:v.src,state:v.readyState,error:v.error?.message,width:v.videoWidth}))))}\n${requests.slice(-8).join('; ')}\n${errors.join('; ')}`); }); assert.equal(await page.locator('.bg-preview-media').getAttribute('aria-busy'), 'false'); }
        if (ext === 'docx') await page.frameLocator('.bg-preview-frame').getByText('BenchGo 项目文档', { exact: true }).waitFor();
        if (ext === 'xlsx') await page.getByRole('button', { name: '内置预览', exact: true }).waitFor();
        assert.equal(await page.getByRole('button', { name: '← 返回', exact: true }).count(), 0); await shot(`preview-${ext}-${theme}`);
      }
    }
    // Observe the actual animation scheduler, codec and Web Audio lifecycle.
    // Waiting here measures idle work; it never dispatches synthetic media events.
    mediaMode = 'data'; await page.evaluate(() => window.renderViewer('dsh-audio-preview:audio', '/project/lifecycle.wav'));
    await page.locator('.dsh-audio__meta').filter({ hasText: '分析 16.0 kHz' }).waitFor();
    const idleFrames = async () => {
      await page.waitForFunction(() => window.animationStats.pending.size === 0);
      const before = await page.evaluate(() => window.animationStats.executed);
      await page.waitForTimeout(180);
      assert.equal(await page.evaluate(() => window.animationStats.executed), before, 'idle/hidden audio must not run animation frames');
    };
    await idleFrames(); assert.equal(await page.evaluate(() => window.playbackContexts.length), 0, 'analysis must not create a playback AudioContext');
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await page.waitForFunction(() => window.audioElements.at(-1).currentTime > .1 && window.playbackContexts.at(-1)?.state === 'running' && window.animationStats.pending.size > 0);
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    await page.waitForFunction(() => window.playbackContexts.at(-1)?.state === 'suspended'); await idleFrames();
    const lane = page.locator('.dsh-audio__lane');
    const frameBeforeSeek = await page.evaluate(() => window.animationStats.executed);
    await lane.click({ position: { x: 100, y: 30 } });
    await page.waitForFunction(() => window.audioElements.at(-1).currentTime > 1);
    await page.waitForFunction(before => window.animationStats.executed > before, frameBeforeSeek); await idleFrames();
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await page.waitForFunction(() => window.playbackContexts.at(-1)?.state === 'running' && window.animationStats.pending.size > 0);
    const beforeHidden = await page.evaluate(() => { document.querySelector('.fixture-preview').style.display='none'; return window.audioElements.at(-1).currentTime; });
    await idleFrames();
    assert(await page.evaluate(before => !window.audioElements.at(-1).paused && window.audioElements.at(-1).currentTime > before, beforeHidden), 'hiding the visualization must preserve streaming playback');
    await page.evaluate(() => { document.querySelector('.fixture-preview').style.display=''; });
    await page.waitForFunction(() => window.animationStats.pending.size > 0); await shot('audio-visible-recovered');
    await page.evaluate(() => window.renderWorkbench()); await page.getByText('server.example:22', { exact: true }).waitFor();
    await page.waitForFunction(() => window.playbackContexts.length > 0 && window.playbackContexts.every(context => context.state === 'closed'));
    await idleFrames();
    for (const [id, ext] of [['benchgo-document', 'doc'], ['benchgo-presentation', 'ppt']]) {
      const before = requests.length;
      await page.evaluate(({ id, ext }) => window.renderViewer(id, `/project/legacy.${ext}`), { id, ext });
      await page.getByText('此旧版文档格式需下载后打开，或另存为 DOCX、XLSX、PPTX 后预览', { exact: true }).waitFor();
      assert.equal(requests.slice(before).some(url => url.includes('preview=pdf') || url.includes('/workbench/media')), false, 'legacy Office hints must not start conversion or file parsing');
      await shot(`preview-legacy-${ext}`);
    }
    mediaMode = 'loading'; await page.evaluate(() => window.renderViewer('video', '/project/loading.webm')); await page.getByText('正在打开文件…', { exact: true }).waitFor(); await shot('video-loading');
    mediaMode = 'error'; await page.evaluate(() => window.renderViewer('video', '/project/error.webm')); await page.getByText('暂时无法预览', { exact: true }).waitFor(); await shot('video-error');
    mediaMode = 'data'; await page.getByRole('button', { name: '重试', exact: true }).click(); await page.waitForFunction(() => document.querySelector('video')?.readyState >= 1); await shot('video-recovered');
    mediaMode = 'error'; await page.evaluate(() => window.renderViewer('dsh-audio-preview:audio', '/project/error.wav')); await page.getByText('音频读取失败，请重试。', { exact: true }).waitFor(); await shot('audio-error');
    mediaMode = 'data'; const beforeRetry = requests.filter(url => url.includes('/media/meta')).length; await page.getByRole('button', { name: '重试', exact: true }).click(); await page.locator('.dsh-audio__meta').filter({ hasText: 'kHz' }).waitFor(); assert.equal(requests.filter(url => url.includes('/media/meta')).length, beforeRetry + 1); await shot('audio-recovered');
    assert.equal(requests.some(url => url.startsWith('/audio-preview') || url.startsWith('/video?')), false, 'all media must use the BenchGo service');
    assert.equal(requests.some(url => url.includes('preview=pdf')), false, 'built-in Office paths do not require a converter');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } }
});
