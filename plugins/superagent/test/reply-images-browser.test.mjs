import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
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
const labels = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' };
const svg = index => `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="650" viewBox="0 0 900 650"><defs><linearGradient id="sky" x2="1" y2="1"><stop stop-color="${['#c2dce3', '#efd7c8', '#c9d7c1', '#d7d0e6'][index % 4]}"/><stop offset="1" stop-color="${['#507e91', '#af7259', '#54735d', '#797199'][index % 4]}"/></linearGradient></defs><rect width="900" height="650" fill="url(#sky)"/><circle cx="670" cy="170" r="77" fill="#fff8df" opacity=".8"/><path d="M0 540 280 170 510 480 650 290 900 600V650H0" fill="#243c4e" opacity=".36"/><path d="M0 590 320 340 510 600 750 420 900 570V650H0" fill="#203a43" opacity=".4"/><text x="42" y="594" font-family="sans-serif" font-size="32" letter-spacing="4" fill="white">BENCHGO · ${String(index + 1).padStart(2, '0')}</text></svg>`;

async function fixture() {
  const result = await build({
    stdin: { resolveDir: root, loader: 'jsx', contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { ImageGallery } from './plugins/shared/client/image-gallery.jsx';
      import { AssistantReply, ReplyDeliverables } from './plugins/superagent/client/reply-images.jsx';
      import { installIconSprite } from './deepseek-harness/packages/client/ui-theme/src/client/icon-sprite.ts';
      import chatCss from './plugins/superagent/client/quiet-chat.css';
      import typographyCss from './plugins/shared/client/chat-typography.css';
      import iconCss from './plugins/benchgo/client/style.css';
      installIconSprite({effect:effect=>effect(),on(){}}, undefined);
      window.fileSaves = [];
      window.dshDesktop = {fileActions:{save:async request=>{window.fileSaves.push(request);return {status:'saved',path:'E:/saved/'+request.name};}}};
      const root = createRoot(document.getElementById('root'));
      const labels = ${JSON.stringify(labels)};
      const images = Array.from({length:4},(_,i)=>({id:'photo-'+i,url:'https://gallery.test/photo-'+i+'.svg',name:['山谷晨光','沙丘日落','森林薄雾','暮色远山'][i]+'.png',alt:['山谷晨光','沙丘日落','森林薄雾','暮色远山'][i]}));
      let revision = 0;
      window.drawImages = (mode='data', suppliedText, suppliedImages) => {
        window.imageMode = mode;
        const scenario = mode + ':' + ++revision;
        const shown = suppliedImages ?? (mode==='empty'?[]:mode==='single'?images.slice(0,1):mode==='error'?[{...images[0],url:'https://gallery.test/retry.svg'}]:mode==='loading'?[{...images[0],url:'https://gallery.test/loading.svg'}]:images);
        const markdown = suppliedText ?? (mode==='code'?'这里只是代码示例。\\n\\n'+String.fromCharCode(96).repeat(3)+'markdown\\n![示例](https://gallery.test/photo-0.svg)\\n![示例二](https://gallery.test/photo-1.svg)\\n'+String.fromCharCode(96).repeat(3):mode==='files'?'文件准备好了。\\n\\n[研究报告.txt](https://gallery.test/report.txt)\\n\\n[项目资料.zip](https://downloads.test/archive.zip)\\n\\n[本地说明.txt](<E:/workspace/notes.txt>)':'这里是这次整理的四张参考图。\\n\\n'+images.map((image,i)=>'!['+image.alt+']('+image.url+')\\n\\n[来源 '+(i+1)+'](https://example.test/photos/'+i+')').join('\\n\\n')+'\\n\\n可以展开对比色彩，再告诉我你喜欢哪一种。');
        root.render(<div className="ba-root ba-official-conversation" data-assistant-chat=""><style>{chatCss}{typographyCss}{iconCss}</style>
          <header className="image-fixture-header"><span>BenchGo</span><span>主聊天</span></header>
          <div className="ba-chat-viewport"><div className="ba-chat-feed" tabIndex={0}><section className="ba-quiet-chat"><div className="ba-quiet-chat-column">
            <article className="ba-chat-message" data-role="user"><div className="ba-chat-body"><div className="ba-chat-content">帮我找几张配色不同的风景参考图。</div></div></article>
            <article className="ba-chat-message" data-role="assistant"><div className="ba-chat-body">
              {['markdown','code','files','stream'].includes(mode)?<AssistantReply key={mode==='stream'?mode:scenario} text={markdown} labels={labels} streaming={mode==='stream'} onOpenFile={async path=>{window.openedFile=path;if(window.localFileError)throw Error('文件暂不可用，请重试。');}}/>:<><div className="ba-chat-content"><p>这里是这次整理的参考图。</p><p>你可以展开对比，再告诉我你喜欢哪一种。</p></div><ReplyDeliverables key={scenario} images={shown}/></>}
            </div></article>
            <article className="ba-chat-message" data-role="user"><div className="ba-chat-body"><div className="ba-chat-content">我更喜欢第一种。</div></div></article>
          </div></section></div></div>
          <footer className="image-fixture-composer">继续和 BenchGo 聊聊…<button type="button">发送</button></footer>
        </div>);
      };
      window.drawImages();
    ` },
    bundle: true, write: false, outdir: join(root, 'artifacts/unused-image-test-output'), format: 'iife', jsx: 'automatic',
    nodePaths: [join(root, 'plugins/benchgo/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
    alias: {
      react: dirname(webRequire.resolve('react/package.json')), 'react-dom': dirname(webRequire.resolve('react-dom/package.json')),
      '@deepseek-ai/dsh-client-ui-primitives': join(root, 'deepseek-harness/packages/client/ui-primitives/src/index.ts'),
    },
    loader: { '.css': 'text', '.module.css': 'local-css', '.svg': 'text', '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
    plugins: [sharedUiStyles()], define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
  });
  const themeRoot = join(root, 'deepseek-harness/packages/client/ui-theme/src/styles');
  const theme = (await Promise.all(['base.css', 'design-platform.css', 'focus.css'].map(name => readFile(join(themeRoot, name), 'utf8')))).join('\n');
  const css = result.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n');
  const js = result.outputFiles.find(file => file.path.endsWith('.js')).text.replaceAll('</script', '<\\/script');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><base href="https://gallery.test/"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BenchGo 图片回复交互验证</title><style>${theme}${css}
    *{box-sizing:border-box}body{margin:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:14px/1.6 var(--dsw-font-family)}
    #root,.ba-official-conversation{height:100vh;display:flex;flex-direction:column;min-height:0}.ba-root{--dsh-composer-side-clearance:16px}
    .image-fixture-header{display:flex;align-items:center;justify-content:space-between;padding:16px 24px;border-bottom:1px solid var(--dsw-alias-border-l3,#ddd);font-size:13px}.image-fixture-header span:first-child{font-weight:600}.image-fixture-header span:last-child{color:var(--dsw-alias-label-secondary,#666)}
    .image-fixture-composer{margin:12px auto 20px;padding:14px 16px;display:flex;align-items:center;justify-content:space-between;width:min(736px,calc(100% - 40px));border:1px solid var(--dsw-alias-border-l3,#ddd);border-radius:18px;color:var(--dsw-alias-label-secondary,#666)}.image-fixture-composer button{border:0;border-radius:10px;padding:8px 14px;background:var(--dsw-alias-state-business-primary,#4d6bfe);color:white}
  </style></head><body><div id="root"></div><script>${js}</script></body></html>`;
}

async function imageRoutes(page) {
  let releases = [], released = false, retryAttempts = 0;
  const requests = [];
  await page.route('https://gallery.test/**', async route => {
    const url = route.request().url();
    requests.push(url);
    if (url.includes('/report.txt')) return route.fulfill({ contentType: 'text/plain; charset=utf-8', body: '这是一份文件交付预览。' });
    if (url.endsWith('/loading.svg') && !released) await new Promise(resolve => releases.push(resolve));
    if (url.endsWith('/retry.svg') && ++retryAttempts === 1) return route.fulfill({ status: 404, body: 'Image missing' });
    return route.fulfill({ contentType: 'image/svg+xml', body: svg(Number(url.match(/photo-(\d+)/)?.[1] || 0)) });
  });
  return { requests, release() { released = true; releases.splice(0).forEach(resolve => resolve()); } };
}

const album = page => page.getByRole('dialog', { name: '图片预览', exact: true });
async function readyAlbum(page) {
  await album(page).waitFor();
  await page.waitForFunction(() => document.querySelector('.bg-image-viewer')?.dataset.phase === 'open');
  await album(page).locator('.bg-image-viewer-photo > .bg-image-picture[data-current="true"][data-state=ready]').waitFor();
  await page.waitForFunction(() => {
    const strip = document.querySelector('.bg-image-viewer-strip');
    if (!strip) return true;
    const bounds = strip.getBoundingClientRect();
    return [...strip.querySelectorAll('button')].filter(node => {
      const box = node.getBoundingClientRect();
      return box.right > bounds.left && box.left < bounds.right && box.bottom > bounds.top && box.top < bounds.bottom;
    }).every(node => { const image = node.querySelector('img'); return image?.complete && image.naturalWidth > 0; });
  });
}
const currentPhoto = page => album(page).locator('.bg-image-viewer-photo > .bg-image-picture[data-current="true"] img');
const presentedPhoto = page => album(page).locator('.bg-image-viewer-photo > .bg-image-picture[data-presented="true"] img');
async function settledPhoto(page, filename) {
  await page.waitForFunction(filename => {
    const photo = document.querySelector('.bg-image-viewer-photo');
    const layers = photo?.querySelectorAll(':scope > .bg-image-picture');
    const current = photo?.querySelector('[data-current="true"][data-presented="true"][data-state="ready"] img');
    return layers?.length === 1 && current?.src.endsWith('/' + filename) && current.complete && current.naturalWidth > 0 && Number(getComputedStyle(current).opacity) >= .99;
  }, filename);
}
async function controlledPhotoRoutes(page) {
  await imageRoutes(page);
  const gates = new Map(), failures = new Set();
  await page.route('https://gallery.test/full-*.svg', async route => {
    const filename = new URL(route.request().url()).pathname.slice(1);
    const gate = gates.get(filename);
    if (gate) await gate.promise;
    try {
      await route.fulfill(failures.has(filename) ? { status: 404, body: 'Photo unavailable' } : { contentType: 'image/svg+xml', body: svg(filename.charCodeAt(5) - 97) });
    } catch (error) {
      if (!/closed|cancel|abort/i.test(String(error))) throw error;
    }
  });
  return {
    hold(filename) { let resolve; const promise = new Promise(done => { resolve = done; }); gates.set(filename, { promise, resolve }); },
    release(filename) { const gate = gates.get(filename); gates.delete(filename); gate?.resolve(); },
    fail(filename) { failures.add(filename); },
    allow(filename) { failures.delete(filename); },
    releaseAll() { for (const gate of gates.values()) gate.resolve(); gates.clear(); },
  };
}
async function drawFullSizeGallery(page, count = 5) {
  const images = Array.from({ length: count }, (_, index) => ({ id: 'full-' + index, url: 'https://gallery.test/full-' + String.fromCharCode(97 + index) + '.svg', thumbnailUrl: 'https://gallery.test/photo-' + index + '.svg', alt: '原图 ' + index, name: 'photo-' + index + '.svg' }));
  await page.evaluate(images => window.drawImages('layers', undefined, images), images);
  await page.getByRole('button', { name: `展开 ${count} 张图片`, exact: true }).waitFor();
}
async function gateImageDecode(page, filename) {
  await page.evaluate(filename => {
    window.galleryDecodeGates ??= new Map();
    if (!window.galleryNativeDecode) {
      window.galleryNativeDecode = HTMLImageElement.prototype.decode;
      HTMLImageElement.prototype.decode = function() {
        const decoded = window.galleryNativeDecode.call(this), gate = window.galleryDecodeGates.get(new URL(this.src).pathname.slice(1));
        if (!gate) return decoded;
        gate.calls++;
        return decoded.then(() => gate.promise);
      };
    }
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    window.galleryDecodeGates.set(filename, { promise, resolve, calls: 0 });
  }, filename);
}
async function settledFilmstrip(page) {
  await page.evaluate(() => { window.filmstripSettlement = null; });
  await page.waitForFunction(() => {
    const rail = document.querySelector('.bg-image-viewer-strip'), selected = rail?.querySelector('[aria-current="true"]');
    if (!selected) return false;
    const previous = window.filmstripSettlement;
    const stable = previous && Math.abs(previous.left - rail.scrollLeft) < .25 ? previous.stable + 1 : 0;
    window.filmstripSettlement = { left: rail.scrollLeft, stable };
    const bounds = rail.getBoundingClientRect(), photo = selected.getBoundingClientRect();
    return stable >= 5 && Math.abs((photo.left + photo.right) / 2 - (bounds.left + bounds.right) / 2) < 2;
  }, null, { polling: 'raf' });
}

async function assertAlbumToolbar(page, multiple = true) {
  const dialog = album(page), download = dialog.getByRole('button', { name: '下载图片', exact: true });
  assert.equal(await dialog.locator('.bg-image-viewer-footer').count(), 0, 'the redundant footer is removed');
  assert.equal(await dialog.getByText(/左右切换|触屏可滑动|原图预览/).count(), 0, 'gesture instructions do not occupy the album');
  assert(await download.evaluate(node => !!node.closest('.bg-image-viewer-header')), 'download belongs to the album toolbar');
  if (multiple) {
    const order = await dialog.locator('.bg-image-viewer-header').evaluate(header => {
      const link = header.querySelector('button.bg-image-viewer-download'), toggle = header.querySelector('.bg-image-overview-toggle');
      if (!link || !toggle) return false;
      const a = link.getBoundingClientRect(), b = toggle.getBoundingClientRect();
      return !!(link.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING) && a.right <= b.left + 1 && Math.abs(a.top - b.top) < 3;
    });
    assert(order, 'download sits immediately to the left of overview at the same toolbar level');
  }
}

async function assertSavedFile(page, button, expectedUrl) {
  const count = await page.evaluate(() => window.fileSaves.length), pages = page.context().pages().length;
  await button.click();
  await page.waitForFunction(count => window.fileSaves.length === count + 1, count);
  const request = await page.evaluate(() => window.fileSaves.at(-1));
  if (expectedUrl instanceof RegExp) assert.match(request.url, expectedUrl);
  else assert.equal(request.url, expectedUrl);
  assert.equal(request.mode, 'saveAs');
  assert(request.name && !/[\\/]/.test(request.name), 'saving suggests a filename rather than a directory');
  assert.equal(await button.evaluate(node => node.tagName), 'BUTTON', 'save is an action rather than a navigation link');
  assert.equal(page.context().pages().length, pages, 'saving never opens a browser tab');
  return request;
}

const shot = async (page, name) => {
  if (!captureDir) return;
  await mkdir(captureDir, { recursive: true });
  if (await page.locator('.bg-image-viewer').count() && !await page.locator('.bg-image-viewer-overview:visible').count()) await album(page).locator('.bg-image-viewer-photo > .bg-image-picture[data-presented="true"][data-state=ready]').waitFor();
  await page.evaluate(async () => {
    const animations = document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity);
    await Promise.all(animations.map(animation => animation.finished.catch(() => {})));
  });
  await page.screenshot({ path: join(captureDir, name + '.png'), fullPage: true });
};

test('reply stack opens its album in one click without layout shifts and retains overview, navigation and focus', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const html = await fixture(), browser = await chromium.launch({ headless: true, executablePath });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1200 }, reducedMotion: 'no-preference' });
    page.on('pageerror', error => errors.push(error.message));
    await imageRoutes(page);
    await page.setContent(html);
    const gallery = page.locator('.bg-image-gallery');
    const trigger = page.getByRole('button', { name: '展开 4 张图片', exact: true });
    await trigger.waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('.bg-image-gallery img')].filter(image => image.getClientRects().length > 0).every(image => image.complete && image.naturalWidth > 0));
    const layout = () => page.locator('.ba-chat-feed').evaluate(feed => ({ height: feed.scrollHeight, top: feed.scrollTop, rows: [...feed.querySelectorAll('.ba-chat-message')].map(node => { const box = node.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height }; }) }));
    const tiles = () => gallery.locator('.bg-image-tile').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).transform));
    const resting = await tiles(), baseline = await layout();
    await shot(page, 'stack-desktop');
    await trigger.hover();
    await page.waitForFunction(resting => [...document.querySelectorAll('.bg-image-gallery .bg-image-tile')].some((node, index) => getComputedStyle(node).transform !== resting[index]), resting);
    assert.deepEqual(await layout(), baseline, 'hover does not resize or move nearby messages');
    await shot(page, 'stack-hover');
    await page.mouse.move(0, 0);
    await page.waitForFunction(resting => [...document.querySelectorAll('.bg-image-gallery .bg-image-tile')].every((node, index) => getComputedStyle(node).transform === resting[index]), resting);
    await page.evaluate(() => {
      window.photoMotions = [];
      const animate = Element.prototype.animate;
      Element.prototype.animate = function(frames, options) {
        if (this.matches('.bg-image-viewer-photo')) window.photoMotions.push({ frames, options });
        return animate.call(this, frames, options);
      };
    });
    await trigger.click();
    await readyAlbum(page);
    const dialog = album(page);
    assert.equal(await gallery.getAttribute('data-expanded'), 'true');
    assert.equal(await gallery.locator('.bg-image-gallery-card').count(), 3, 'the source stays a bounded three-card stack');
    assert.equal(await page.getByRole('button', { name: '收起图片', exact: true }).count(), 0, 'there is no intermediate chat grid');
    assert.deepEqual(await layout(), baseline, 'opening the floating album leaves chat geometry and scroll position unchanged');
    const motions = await page.evaluate(() => window.photoMotions);
    assert(motions.some(motion => motion.options.duration > 0 && motion.options.duration <= 250), 'the photo uses a short programmatic entrance');
    for (const { frames } of motions) for (const frame of frames) assert(Object.keys(frame).every(key => ['transform', 'opacity', 'offset', 'easing', 'composite'].includes(key)), 'photo motion stays on transform and opacity');
    assert(await page.getByRole('button', { name: '下一张图片', exact: true }).locator('svg').evaluate(node => { const box = node.getBBox(); return box.width > 0 && box.height > 0; }), 'the real Host icon sprite supplies visible navigation glyphs');
    assert.match(await currentPhoto(page).getAttribute('src'), /photo-0/);
    assert.equal(await dialog.getByRole('button', { name: '下载图片', exact: true }).count(), 1);
    await assertAlbumToolbar(page);
    await shot(page, 'album-desktop');
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => document.querySelector('.bg-image-viewer-photo img')?.src.includes('photo-1'));
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(() => document.querySelector('.bg-image-viewer-photo img')?.src.includes('photo-0'));
    await page.getByRole('button', { name: '下一张图片', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.bg-image-viewer-photo img')?.src.includes('photo-1'));
    await dialog.getByRole('button', { name: '查看第 4 张图片', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.bg-image-viewer-photo img')?.src.includes('photo-3'));
    await dialog.getByRole('button', { name: '全部总览', exact: true }).click();
    await dialog.locator('.bg-image-viewer-overview').waitFor();
    assert.equal(await dialog.getByRole('button', { name: /^查看大图 / }).count(), 4);
    await assertSavedFile(page, dialog.getByRole('button', { name: '下载图片 3', exact: true }), /photo-2\.svg$/);
    await shot(page, 'album-overview-desktop');
    await dialog.getByRole('button', { name: '返回大图', exact: true }).click();
    await currentPhoto(page).waitFor();
    assert.match(await currentPhoto(page).getAttribute('src'), /photo-3/, 'overview preserves the selected image');
    await dialog.getByRole('button', { name: '全部总览', exact: true }).click();
    await dialog.getByRole('button', { name: '查看大图 2：沙丘日落', exact: true }).click();
    await currentPhoto(page).waitFor();
    assert.match(await currentPhoto(page).getAttribute('src'), /photo-1/, 'an overview tile returns directly to its large photo');
    assert(await dialog.getByRole('button', { name: '查看第 2 张图片', exact: true }).evaluate(node => node === document.activeElement), 'overview selection hands focus to the chosen filmstrip item');
    await page.keyboard.press('ArrowRight');
    await settledPhoto(page, 'photo-2.svg');
    assert(await dialog.getByRole('button', { name: '查看第 3 张图片', exact: true }).evaluate(node => node === document.activeElement), 'arrow navigation moves filmstrip focus with the selected image');
    await page.keyboard.press('Enter');
    assert.match(await currentPhoto(page).getAttribute('src'), /photo-2\.svg$/, 'Enter cannot reselect the old thumbnail after an arrow key');
    await shot(page, 'preview-desktop');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert(await trigger.evaluate(node => node === document.activeElement), 'dismissal restores focus directly to the stack');
    assert.deepEqual(await layout(), baseline, 'closing preserves the reading position');
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => document.querySelector('.bg-image-stack-trigger').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })));
      await dialog.waitFor();
      await page.evaluate(() => {
        const close = document.querySelector('.bg-image-viewer .bg-ui-dialog-close');
        close.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }));
        close.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
      });
      await dialog.waitFor({ state: 'hidden' });
    }
    assert.equal(await gallery.getAttribute('data-expanded'), 'false', 'rapid reversals settle back into one interactive stack');
    assert.equal(await gallery.locator('.bg-image-gallery-card:visible').count(), 3);
    assert.deepEqual(await layout(), baseline);
    await trigger.focus();
    const beforeKeyboard = await page.evaluate(() => window.photoMotions.length);
    await page.evaluate(() => {
      window.keyboardOverlayMotion = [];
      const record = event => {
        if (!event.target.matches('.bg-ui-dialog-overlay,.bg-image-viewer,.bg-image-viewer *')) return;
        const style = getComputedStyle(event.target, event.pseudoElement || null), durations = event.type === 'animationstart' ? style.animationDuration : style.transitionDuration;
        if (durations.split(',').some(value => parseFloat(value) > 0)) window.keyboardOverlayMotion.push({ type: event.type, target: event.target.className, property: event.propertyName });
      };
      document.addEventListener('animationstart', record, true);
      document.addEventListener('transitionrun', record, true);
    });
    await page.keyboard.press('Enter');
    await readyAlbum(page);
    assert.equal(await page.evaluate(() => window.photoMotions.length), beforeKeyboard, 'keyboard opening skips the spatial photo animation');
    assert.deepEqual(await page.evaluate(() => window.keyboardOverlayMotion), [], 'keyboard opening skips motion across the entire overlay and its contents');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    await trigger.click();
    await readyAlbum(page);
    await page.mouse.click(4, 4);
    await dialog.waitFor({ state: 'hidden' });
    assert(await trigger.evaluate(node => node === document.activeElement), 'backdrop dismissal also returns focus to the stack');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('collapsed image stacks scrub their cover by wheel without opening, scrolling chat or losing the current photo', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await imageRoutes(page);
    await page.setContent(await fixture());
    const gallery = page.locator('.bg-image-gallery'), deck = gallery.locator('.bg-image-gallery-deck');
    const trigger = page.getByRole('button', { name: '展开 4 张图片', exact: true });
    const cover = () => gallery.locator('.bg-image-gallery-card').first().locator('img').getAttribute('src');
    const waitCover = index => page.waitForFunction(index => document.querySelector('.bg-image-gallery-card img')?.src.endsWith('/photo-' + index + '.svg'), index);
    const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const wheel = events => deck.evaluate((node, events) => events.map(options => {
      const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaMode: 0, ...options });
      node.dispatchEvent(event);
      return event.defaultPrevented;
    }), events);
    const layout = () => page.locator('.ba-chat-feed').evaluate(feed => ({ top: feed.scrollTop, height: feed.scrollHeight, rows: [...feed.querySelectorAll('.ba-chat-message')].map(node => { const { x, y, width, height } = node.getBoundingClientRect(); return { x, y, width, height }; }) }));
    await trigger.waitFor();
    await waitCover(0);
    await page.evaluate(() => {
      const spacer = document.createElement('div');
      spacer.style.height = '1000px';
      spacer.setAttribute('aria-hidden', 'true');
      document.querySelector('.ba-quiet-chat-column').append(spacer);
      document.querySelector('.ba-chat-feed').scrollTop = 16;
    });
    assert(await page.locator('.ba-chat-feed').evaluate(node => node.scrollHeight > node.clientHeight), 'the underlying chat can actually scroll during this regression');
    const baseline = await layout();
    for (const position of [{ x: 12, y: 20 }, { x: 160, y: 60 }]) {
      await deck.hover({ position });
      await frames();
      assert.match(await cover(), /photo-0\.svg$/, 'hovering a collapsed stack never changes its cover');
    }
    await page.mouse.wheel(0, 120);
    await waitCover(1);
    await frames();
    assert.equal(await album(page).count(), 0, 'a wheel gesture previews the next cover without clicking or opening an album');
    assert.deepEqual(await layout(), baseline, 'the native non-passive wheel listener prevents chat scrolling and keeps the layout fixed');
    await page.mouse.wheel(0, -120);
    await waitCover(0);
    await page.waitForTimeout(200);
    assert.deepEqual(await wheel([{ deltaY: 10 }, { deltaY: 10 }, { deltaY: 11 }]), [true, true, true]);
    await frames();
    assert.match(await cover(), /photo-0\.svg$/, '31 accumulated trackpad pixels do not advance the cover');
    assert.deepEqual(await wheel([{ deltaY: 1 }]), [true]);
    await waitCover(1);
    await page.waitForTimeout(170);
    assert.deepEqual(await wheel(Array.from({ length: 8 }, () => ({ deltaY: 1000 }))), Array(8).fill(true));
    await waitCover(2);
    await frames();
    assert.match(await cover(), /photo-2\.svg$/, 'one large delta and a rapid same-direction burst advance only one image');
    assert.deepEqual(await wheel([{ deltaY: -1000 }]), [true]);
    await waitCover(1);
    await page.waitForTimeout(170);
    await wheel([{ deltaY: -1000 }]);
    await waitCover(0);
    await page.waitForTimeout(170);
    await wheel([{ deltaY: -1000 }]);
    await waitCover(3);
    await wheel([{ deltaY: 1000 }]);
    await waitCover(0);
    await page.waitForTimeout(170);
    await page.mouse.wheel(120, 0);
    await waitCover(1);
    assert.deepEqual(await wheel([{ deltaY: 1000, ctrlKey: true }, { deltaX: -1000, metaKey: true }]), [false, false], 'Ctrl/Meta wheel remains available to browser zoom and platform gestures');
    await frames();
    assert.match(await cover(), /photo-1\.svg$/, 'modifier wheel gestures preserve the cover');
    assert.equal(await gallery.locator('.bg-image-gallery-card').count(), 3, 'scrubbing keeps the deck bounded to three mounted cards');
    assert.equal(await album(page).count(), 0);
    assert.deepEqual(await layout(), baseline, 'both wheel axes, reversals and wraparound preserve chat position and message geometry');
    await shot(page, 'stack-wheel-preview');
    await trigger.click();
    await readyAlbum(page);
    assert.match(await currentPhoto(page).getAttribute('src'), /photo-1\.svg$/, 'clicking opens the photo currently shown on the cover');
    await album(page).getByRole('button', { name: '下一张图片', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.bg-image-viewer-photo img')?.src.endsWith('/photo-2.svg'));
    await page.keyboard.press('Escape');
    await album(page).waitFor({ state: 'hidden' });
    assert.match(await cover(), /photo-2\.svg$/, 'closing preserves the latest album selection on the collapsed cover');
    assert.deepEqual(await layout(), baseline);
    await page.evaluate(() => window.drawImages('single'));
    await page.waitForFunction(() => document.querySelector('.bg-image-gallery')?.dataset.multiple === 'false');
    assert.deepEqual(await wheel([{ deltaY: 120 }, { deltaX: -120 }]), [false, false], 'a single image never consumes either wheel axis');
    assert.match(await cover(), /photo-0\.svg$/);
    assert.equal(await album(page).count(), 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('reply image gallery renders empty, loading, error, single and Markdown safely across themes and viewports', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const html = await fixture(), browser = await chromium.launch({ headless: true, executablePath });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1200 }, reducedMotion: 'reduce' });
    page.on('pageerror', error => errors.push(error.message));
    const routes = await imageRoutes(page);
    await page.setContent(html);
    await page.getByRole('button', { name: '展开 4 张图片', exact: true }).waitFor();
    await page.evaluate(() => window.drawImages('empty'));
    await page.waitForFunction(() => !document.querySelector('.bg-image-gallery'));
    await shot(page, 'empty');
    await page.evaluate(() => window.drawImages('loading'));
    await page.getByText('正在加载图片', { exact: true }).waitFor();
    await shot(page, 'loading');
    routes.release();
    await page.waitForFunction(() => [...document.querySelectorAll('.bg-image-gallery img')].filter(image => image.getClientRects().length > 0).every(image => image.complete && image.naturalWidth > 0));
    await page.evaluate(() => window.drawImages('error'));
    await page.getByText('图片加载失败', { exact: true }).waitFor();
    await shot(page, 'error');
    await page.getByRole('button', { name: '重试加载图片', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('.bg-image-gallery img')].filter(image => image.getClientRects().length > 0).every(image => image.complete && image.naturalWidth > 0));
    assert.equal(await page.getByText('图片加载失败', { exact: true }).count(), 0);
    await page.evaluate(() => window.drawImages('single'));
    await page.waitForFunction(() => document.querySelector('.bg-image-gallery')?.dataset.multiple === 'false');
    assert.equal(await page.getByRole('button', { name: /展开.*张图片/ }).count(), 0, 'one image never becomes a stack');
    await assertSavedFile(page, page.getByRole('button', { name: '下载图片 1', exact: true }), /photo-0\.svg$/);
    await shot(page, 'single');
    await page.getByRole('button', { name: '放大图片 1：山谷晨光', exact: true }).click();
    await readyAlbum(page);
    await assertAlbumToolbar(page, false);
    await page.keyboard.press('Escape');
    await album(page).waitFor({ state: 'hidden' });
    await page.route('https://gallery.test/stack-error.svg', route => route.fulfill({ status: 404, body: 'Missing stack image' }));
    await page.evaluate(() => window.drawImages('stack-error', undefined, [
      { url: 'https://gallery.test/stack-error.svg', alt: '失败封面' },
      { url: 'https://gallery.test/photo-1.svg', alt: '正常图片' },
    ]));
    await page.locator('.bg-image-gallery [data-state="error"]').waitFor();
    assert.equal(await page.locator('.bg-image-gallery').getByRole('button', { name: '重试加载图片', exact: true }).count(), 0, 'noninteractive stack cards do not expose unreachable retry actions');
    await page.getByRole('button', { name: '展开 2 张图片', exact: true }).click();
    await album(page).locator('[data-current="true"][data-state="error"]').waitFor();
    assert.equal(await album(page).getByRole('button', { name: '重试加载图片', exact: true }).count(), 1, 'opening the failed cover provides its reachable retry action');
    assert(await album(page).getByRole('button', { name: '下载图片', exact: true }).isDisabled());
    await page.keyboard.press('Escape');
    await album(page).waitFor({ state: 'hidden' });
    await page.evaluate(() => window.drawImages('code'));
    await page.locator('pre').waitFor();
    assert.equal(await page.locator('.bg-image-gallery').count(), 0, 'Markdown-looking image examples stay in their code fence');
    assert.equal(await page.locator('.ba-chat-content img').count(), 0);

    for (const dark of [false, true]) for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1200 });
      await page.evaluate(dark => { document.body.toggleAttribute('data-ds-dark-theme', dark); window.drawImages('markdown'); }, dark);
      const gallery = page.locator('.bg-image-gallery');
      const trigger = page.getByRole('button', { name: '展开 4 张图片', exact: true });
      await trigger.waitFor();
      await page.waitForFunction(() => [...document.querySelectorAll('.bg-image-gallery img')].filter(image => image.getClientRects().length > 0).every(image => image.complete && image.naturalWidth > 0));
      assert.equal(await page.locator('.bg-image-gallery').count(), 1, 'source paragraphs no longer split images into separate galleries');
      assert.equal(await page.locator('.ba-chat-content .bg-image-gallery').count(), 0, 'image delivery is outside the prose bubble');
      assert.equal(await page.locator('.ba-chat-content a').count(), 4, 'photographer source links stay in the prose');
      assert(await gallery.evaluate(node => node.closest('.ba-reply-deliverables')?.previousElementSibling?.classList.contains('ba-chat-content')), 'the gallery follows its own reply bubble');
      const transforms = await gallery.locator('.bg-image-tile').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).transform));
      await trigger.hover();
      assert.deepEqual(await gallery.locator('.bg-image-tile').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).transform)), transforms, 'reduced motion leaves static card offsets unchanged');
      await shot(page, `markdown-${width}-${dark ? 'dark' : 'light'}-stack`);
      await trigger.click();
      await readyAlbum(page);
      assert.equal(await gallery.locator('.bg-image-gallery-card').count(), 3);
      assert.equal(await album(page).locator('.bg-image-viewer-photo').evaluate(node => node.getAnimations().length), 0, 'reduced motion skips photo flight');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'the document never overflows horizontally');
      const bounds = await gallery.boundingBox();
      assert(bounds.x >= 0 && bounds.x + bounds.width <= width, 'the source stack stays within the chat column');
      const dialog = album(page);
      await assertAlbumToolbar(page);
      const viewer = await dialog.boundingBox();
      assert(viewer.x >= 0 && viewer.x + viewer.width <= width + 1, 'the image viewer fits a narrow viewport');
      assert(viewer.y >= 0 && viewer.y + viewer.height <= (width === 390 ? 844 : 1200) + 1, 'album chrome and controls fit the viewport height');
      await shot(page, `markdown-${width}-${dark ? 'dark' : 'light'}-preview`);
      await dialog.getByRole('button', { name: '全部总览', exact: true }).click();
      await dialog.locator('.bg-image-viewer-overview').waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await shot(page, `markdown-${width}-${dark ? 'dark' : 'light'}-overview`);
      await page.getByRole('button', { name: '关闭图片预览', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
    }
    const touch = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: 'no-preference' });
    await imageRoutes(touch);
    await touch.setContent(html);
    const touchTrigger = touch.getByRole('button', { name: '展开 4 张图片', exact: true });
    await touchTrigger.waitFor();
    await touchTrigger.tap();
    await readyAlbum(touch);
    const stage = await touch.locator('.bg-image-viewer-stage').boundingBox();
    const touchSession = await touch.context().newCDPSession(touch);
    await touchSession.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: stage.x + stage.width * .8, y: stage.y + stage.height * .5 }] });
    await touchSession.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: stage.x + stage.width * .5, y: stage.y + stage.height * .5 }] });
    await touchSession.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: stage.x + stage.width * .2, y: stage.y + stage.height * .5 }] });
    await touchSession.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await touchSession.detach();
    await touch.waitForFunction(() => document.querySelector('.bg-image-viewer-photo img')?.src.includes('photo-1'));
    await touch.getByRole('button', { name: '下一张图片', exact: true }).tap();
    await touch.waitForFunction(() => document.querySelector('.bg-image-viewer-photo img')?.src.includes('photo-2'));
    await touch.getByRole('button', { name: '上一张图片', exact: true }).tap();
    await touch.waitForFunction(() => document.querySelector('.bg-image-viewer-photo img')?.src.includes('photo-1'));
    await touch.getByRole('button', { name: '查看第 1 张图片', exact: true }).tap();
    await settledFilmstrip(touch);
    const film = await touch.locator('.bg-image-viewer-strip').boundingBox();
    const filmSession = await touch.context().newCDPSession(touch);
    await filmSession.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: film.x + film.width * .8, y: film.y + film.height * .5 }] });
    for (const progress of [.65, .5, .35, .2]) await filmSession.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: film.x + film.width * progress, y: film.y + film.height * .5 }] });
    await filmSession.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await filmSession.detach();
    await touch.waitForFunction(() => !document.querySelector('.bg-image-viewer-photo img')?.src.includes('photo-0'));
    await settledFilmstrip(touch);
    assert.equal(await currentPhoto(touch).getAttribute('src'), await touch.locator('.bg-image-viewer-strip [aria-current="true"]').getAttribute('data-image-url'), 'touch-scrolling the filmstrip changes the large image with its current thumbnail');
    await shot(touch, 'touch-album');
    await touch.getByRole('button', { name: '关闭图片预览', exact: true }).tap();
    await album(touch).waitFor({ state: 'hidden' });
    await touch.waitForFunction(() => document.querySelector('.bg-image-gallery')?.dataset.expanded === 'false');
    assert.equal(await touch.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await shot(touch, 'touch-stack');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('file delivery cards stay outside bubbles and retain preview, download and local open failures', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1200 }, reducedMotion: 'reduce' });
    await imageRoutes(page);
    await page.setContent(await fixture());
    await page.evaluate(() => window.drawImages('files'));
    await page.getByRole('button', { name: '打开 研究报告.txt', exact: true }).waitFor();
    assert.equal(await page.locator('.ba-reply-files .ba-reply-file').count(), 3);
    assert.equal(await page.locator('.ba-chat-content .ba-reply-file').count(), 0);
    assert.equal(await page.locator('.ba-chat-content a').count(), 0, 'delivery links move to cards instead of appearing twice');
    await assertSavedFile(page, page.getByRole('button', { name: '下载 项目资料.zip', exact: true }), 'https://downloads.test/archive.zip');
    await shot(page, 'files-desktop');
    await page.getByRole('button', { name: '打开 研究报告.txt', exact: true }).click();
    await page.getByText('这是一份文件交付预览。', { exact: true }).waitFor();
    await assertSavedFile(page, page.getByRole('button', { name: '下载 研究报告.txt', exact: true }), 'https://gallery.test/report.txt');
    await shot(page, 'file-preview');
    await page.getByRole('button', { name: '← 返回', exact: true }).click();
    await page.evaluate(() => { window.localFileError = true; });
    await page.getByRole('button', { name: '打开 本地说明.txt', exact: true }).click();
    await page.getByText('文件暂不可用，请重试。', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.openedFile), 'E:/workspace/notes.txt');
    await page.evaluate(() => { window.localFileError = false; });
    await page.getByRole('button', { name: '打开 本地说明.txt', exact: true }).click();
    assert.equal(await page.getByText('文件暂不可用，请重试。', { exact: true }).count(), 0);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await shot(page, 'files-mobile-dark');
    await page.evaluate(() => window.drawImages('files', ['doc', 'ppt', 'odt', 'rtf', 'docx', 'pptx', 'xlsx'].map(ext => '[文档.' + ext + '](https://gallery.test/report.' + ext + ')').join('\n\n')));
    for (const ext of ['doc', 'ppt', 'odt', 'rtf']) {
      await page.getByRole('link', { name: '打开 文档.' + ext, exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: '打开 文档.' + ext, exact: true }).count(), 0, 'formats requiring an unavailable conversion endpoint open their original file');
    }
    for (const ext of ['docx', 'pptx', 'xlsx']) await page.getByRole('button', { name: '打开 文档.' + ext, exact: true }).waitFor();
  } finally { await browser.close(); }
});

test('decoded large photos remain visible through delayed loading, stale completions, retry and pending dismissal', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  let routes;
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, reducedMotion: 'no-preference' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    routes = await controlledPhotoRoutes(page);
    routes.hold('full-b.svg');
    routes.hold('full-e.svg');
    routes.fail('full-d.svg');
    await page.setContent(await fixture());
    await gateImageDecode(page, 'full-c.svg');
    await drawFullSizeGallery(page);
    await page.getByRole('button', { name: '展开 5 张图片', exact: true }).click();
    await readyAlbum(page);
    await settledPhoto(page, 'full-a.svg');
    await page.evaluate(() => {
      const photo = document.querySelector('.bg-image-viewer-photo');
      window.savedDecodedPhoto = photo;
      window.savedDecodedImage = photo.querySelector('[data-presented="true"] img');
      window.maxDecodedLayers = 1;
      window.decodedPhotoTransitions = [];
      photo.addEventListener('transitionrun', event => {
        if (!event.target.matches('.bg-image-picture > img') || !event.target.src.endsWith('/full-c.svg')) return;
        window.decodedPhotoTransitions.push({ property: event.propertyName, durations: getComputedStyle(event.target).transitionDuration.split(',').map(value => parseFloat(value) * (value.trim().endsWith('ms') ? 1 : 1000)) });
      });
      window.decodedLayerObserver = new MutationObserver(() => {
        window.maxDecodedLayers = Math.max(window.maxDecodedLayers, photo.querySelectorAll(':scope > .bg-image-picture').length);
      });
      window.decodedLayerObserver.observe(photo, { childList: true });
    });
    const select = number => album(page).getByRole('button', { name: `查看第 ${number} 张图片`, exact: true }).click();
    const assertPresented = async filename => {
      assert.match(await presentedPhoto(page).getAttribute('src'), new RegExp('/' + filename.replaceAll('.', '\\.') + '$'));
      assert(await presentedPhoto(page).evaluate(image => {
        const layer = image.closest('.bg-image-picture'), bounds = image.getBoundingClientRect();
        return image.complete && image.naturalWidth > 0 && Number(getComputedStyle(layer).opacity) >= .99 && Number(getComputedStyle(image).opacity) >= .99 && bounds.width > 0 && bounds.height > 0;
      }), 'the presented photo is decoded, opaque and has a visible painted area');
      assert(await page.evaluate(() => document.querySelector('.bg-image-viewer-photo') === window.savedDecodedPhoto), 'the large-photo parent is stable across selections');
      assert(await album(page).locator('.bg-image-viewer-photo > .bg-image-picture').count() <= 2, 'at most a current request and one decoded previous photo are mounted');
    };
    await select(2);
    assert.match(await currentPhoto(page).getAttribute('src'), /full-b\.svg$/);
    assert(await album(page).getByRole('button', { name: '下载图片', exact: true }).isDisabled(), 'pending image requests cannot save a target that is not presented yet');
    await assertPresented('full-a.svg');
    assert(await presentedPhoto(page).evaluate(image => image === window.savedDecodedImage), 'the previous decoded image is retained as the same DOM node');
    await shot(page, 'album-pending-keeps-decoded-photo');
    await select(3);
    await page.waitForFunction(() => window.galleryDecodeGates.get('full-c.svg').calls > 0 && document.querySelector('.bg-image-viewer-photo [data-current="true"] img')?.complete);
    assert.match(await currentPhoto(page).getAttribute('src'), /full-c\.svg$/);
    await assertPresented('full-a.svg');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await currentPhoto(page).evaluate(image => Number(getComputedStyle(image).opacity)), 0, 'the undecoded target is not painted over the previous image');
    await page.evaluate(() => window.galleryDecodeGates.get('full-c.svg').resolve());
    await settledPhoto(page, 'full-c.svg');
    await assertPresented('full-c.svg');
    const transitions = await page.evaluate(() => window.decodedPhotoTransitions);
    assert(transitions.some(transition => transition.property === 'opacity' && transition.durations.some(duration => duration > 0 && duration <= 160)), 'a pointer selection actually runs a short opacity transition after decode');
    assert(transitions.every(transition => ['opacity', 'transform'].includes(transition.property)), 'the large photo never animates dimensions or layout properties');
    const lateResponse = page.waitForResponse(response => response.url().endsWith('/full-b.svg'));
    routes.release('full-b.svg');
    await lateResponse;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await assertPresented('full-c.svg');
    assert.match(await currentPhoto(page).getAttribute('src'), /full-c\.svg$/, 'a late B completion cannot cover the newer C selection');
    await gateImageDecode(page, 'full-b.svg');
    await select(1);
    await settledPhoto(page, 'full-a.svg');
    await select(2);
    await page.waitForFunction(() => window.galleryDecodeGates.get('full-b.svg').calls > 0);
    await assertPresented('full-a.svg');
    await select(1);
    await settledPhoto(page, 'full-a.svg');
    await page.evaluate(() => window.galleryDecodeGates.get('full-b.svg').resolve());
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await assertPresented('full-a.svg');
    assert.match(await currentPhoto(page).getAttribute('src'), /full-a\.svg$/, 'a rapid A-B-A reversal stays on A when B finishes decoding late');
    await select(3);
    await settledPhoto(page, 'full-c.svg');
    await select(4);
    await album(page).locator('.bg-image-viewer-photo > .bg-image-picture[data-current="true"][data-state="error"]').waitFor();
    assert(await album(page).getByRole('button', { name: '下载图片', exact: true }).isDisabled(), 'failed image requests keep the header save action disabled');
    await assertPresented('full-c.svg');
    assert.equal(await album(page).getByRole('button', { name: '重试加载图片', exact: true }).count(), 1);
    await shot(page, 'album-decoded-photo-error');
    routes.allow('full-d.svg');
    await album(page).getByRole('button', { name: '重试加载图片', exact: true }).click();
    await settledPhoto(page, 'full-d.svg');
    await assertPresented('full-d.svg');
    await assertSavedFile(page, album(page).getByRole('button', { name: '下载图片', exact: true }), /full-d\.svg$/);
    await shot(page, 'album-decoded-photo-after-retry');
    await select(5);
    await page.evaluate(() => {
      document.querySelector('.bg-image-viewer .bg-ui-dialog-close').click();
      for (const animation of document.querySelector('.bg-image-viewer-photo').getAnimations()) animation.pause();
    });
    await page.waitForFunction(() => document.querySelector('.bg-image-viewer')?.dataset.phase === 'closing');
    routes.release('full-e.svg');
    await page.waitForFunction(() => document.querySelector('.bg-image-viewer-photo > [data-current="true"]')?.dataset.state === 'ready');
    await assertPresented('full-d.svg');
    await page.keyboard.press('ArrowRight');
    await settledPhoto(page, 'full-e.svg');
    assert.equal(await album(page).getAttribute('data-phase'), 'open', 'interrupting close can present a photo that decoded while frozen, even at the last-image boundary');
    await select(4);
    await settledPhoto(page, 'full-d.svg');
    await gateImageDecode(page, 'full-e.svg');
    await select(5);
    assert.match(await currentPhoto(page).getAttribute('src'), /full-e\.svg$/);
    await assertPresented('full-d.svg');
    await page.keyboard.press('Escape');
    await album(page).waitFor({ state: 'hidden' });
    assert.match(await page.locator('.bg-image-gallery-card').first().locator('img').getAttribute('src'), /photo-3\.svg$/, 'closing a pending request retains the photo that was actually visible');
    await page.evaluate(() => window.galleryDecodeGates.get('full-e.svg').resolve());
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await album(page).count(), 0, 'a late pending photo does not reopen a dismissed album');
    assert.match(await page.locator('.bg-image-gallery-card').first().locator('img').getAttribute('src'), /photo-3\.svg$/);
    await page.getByRole('button', { name: '展开 5 张图片', exact: true }).click();
    await readyAlbum(page);
    await settledPhoto(page, 'full-d.svg');
    assert(await page.evaluate(() => window.maxDecodedLayers <= 2));
    assert.deepEqual(errors, []);
  } finally { routes?.releaseAll(); await browser.close(); }
});

test('large-photo wheel navigation respects both axes, browser gestures, overview and motion preferences', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, reducedMotion: 'no-preference' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await imageRoutes(page);
    await page.setContent(await fixture());
    await page.getByRole('button', { name: '展开 4 张图片', exact: true }).click();
    await readyAlbum(page);
    await settledPhoto(page, 'photo-0.svg');
    const photo = album(page).locator('.bg-image-viewer-photo');
    const wheel = (target, events) => target.evaluate((node, events) => events.map(options => {
      const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaMode: 0, ...options });
      let consumed;
      // Sample after the photo's native hook, before Radix's document-level scroll lock.
      node.addEventListener('wheel', event => { consumed = event.defaultPrevented; }, { once: true });
      node.dispatchEvent(event);
      return consumed;
    }), events);
    const feedScroll = await page.locator('.ba-chat-feed').evaluate(node => node.scrollTop);
    const bounds = await photo.boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.wheel(0, 120);
    await settledPhoto(page, 'photo-1.svg');
    await page.waitForTimeout(170);
    await page.mouse.wheel(120, 0);
    await settledPhoto(page, 'photo-2.svg');
    await page.waitForTimeout(200);
    assert.deepEqual(await wheel(photo, [{ deltaY: 10 }, { deltaY: 10 }, { deltaY: 11 }]), [true, true, true]);
    assert.match(await currentPhoto(page).getAttribute('src'), /photo-2\.svg$/, 'small trackpad deltas accumulate before selecting');
    await wheel(photo, [{ deltaY: 1 }]);
    await settledPhoto(page, 'photo-3.svg');
    await page.waitForTimeout(170);
    await wheel(photo, [{ deltaY: 1000 }]);
    assert.match(await currentPhoto(page).getAttribute('src'), /photo-3\.svg$/, 'large-photo wheel navigation stops at the album boundary');
    await wheel(photo, [{ deltaY: -1000 }]);
    await settledPhoto(page, 'photo-2.svg');
    await page.waitForTimeout(170);
    await wheel(photo, Array.from({ length: 8 }, () => ({ deltaY: -1000 })));
    await settledPhoto(page, 'photo-1.svg');
    assert.deepEqual(await wheel(photo, [{ deltaY: 120, ctrlKey: true }, { deltaX: -120, metaKey: true }]), [false, false]);
    assert.match(await currentPhoto(page).getAttribute('src'), /photo-1\.svg$/);
    await assertSavedFile(page, album(page).getByRole('button', { name: '下载图片', exact: true }), /photo-1\.svg$/);
    await album(page).getByRole('button', { name: '全部总览', exact: true }).click();
    const overview = album(page).locator('.bg-image-viewer-overview');
    await overview.waitFor();
    assert.deepEqual(await wheel(overview, [{ deltaY: 120 }, { deltaX: -120 }]), [false, false], 'overview keeps ordinary scrolling');
    assert.deepEqual(await wheel(photo, [{ deltaY: 120 }]), [false], 'the hidden photo does not retain an active wheel handler under overview');
    assert.match(await currentPhoto(page).getAttribute('src'), /photo-1\.svg$/);
    await album(page).getByRole('button', { name: '返回大图', exact: true }).click();
    await settledPhoto(page, 'photo-1.svg');
    await page.evaluate(() => {
      const photo = document.querySelector('.bg-image-viewer-photo');
      window.instantPhotoAnimations = [];
      window.instantPhotoObserver = new MutationObserver(() => {
        for (const animation of photo.getAnimations({ subtree: true })) {
          if (Number(animation.effect?.getTiming().duration) > 0 && animation.playState === 'running') window.instantPhotoAnimations.push(animation.effect.getKeyframes());
        }
      });
      window.instantPhotoObserver.observe(photo, { childList: true, subtree: true, attributes: true });
    });
    await page.keyboard.press('ArrowRight');
    await settledPhoto(page, 'photo-2.svg');
    assert.deepEqual(await page.evaluate(() => window.instantPhotoAnimations), [], 'arrow navigation adds no photo transition');
    await album(page).getByRole('button', { name: '查看第 4 张图片', exact: true }).focus();
    await page.keyboard.press('Enter');
    await settledPhoto(page, 'photo-3.svg');
    assert.deepEqual(await page.evaluate(() => window.instantPhotoAnimations), [], 'keyboard thumbnail selection adds no photo transition');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await album(page).getByRole('button', { name: '查看第 1 张图片', exact: true }).click();
    await settledPhoto(page, 'photo-0.svg');
    assert.deepEqual(await page.evaluate(() => window.instantPhotoAnimations), [], 'reduced motion also skips pointer-triggered photo transitions');
    assert.equal(await page.locator('.ba-chat-feed').evaluate(node => node.scrollTop), feedScroll);
    await page.keyboard.press('Escape');
    await album(page).waitFor({ state: 'hidden' });
    await page.evaluate(() => window.drawImages('single'));
    await page.getByRole('button', { name: '放大图片 1：山谷晨光', exact: true }).click();
    await readyAlbum(page);
    await settledPhoto(page, 'photo-0.svg');
    assert.deepEqual(await wheel(photo, [{ deltaY: 120 }, { deltaX: -120 }]), [false, false], 'single-photo viewers do not consume scrolling');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('large filmstrip dragging keeps thumbnail writes bounded and photo surfaces stable without idle work', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, reducedMotion: 'no-preference' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await imageRoutes(page);
    await page.setContent(await fixture());
    const photos = Array.from({ length: 120 }, (_, index) => '![参考图 ' + index + '](https://gallery.test/photo-' + index + '.svg)').join('\n\n');
    await page.evaluate(text => window.drawImages('stream', text), photos);
    await page.getByRole('button', { name: '展开 120 张图片', exact: true }).click();
    await readyAlbum(page);
    await settledFilmstrip(page);
    await settledPhoto(page, 'photo-0.svg');
    await page.evaluate(() => {
      const rail = document.querySelector('.bg-image-viewer-strip'), photo = document.querySelector('.bg-image-viewer-photo');
      const nodes = [...rail.children];
      const stats = window.filmstripBudget = { writes: 0, frameWrites: 0, maxFrameWrites: 0, frames: 0, mutations: 0, stable: true, maxLayers: 1, running: true };
      for (const node of nodes) for (const property of ['transform', 'opacity']) {
        Object.defineProperty(node.style, property, { configurable: true, get() { return this.getPropertyValue(property); }, set(value) {
          stats.writes++; stats.frameWrites++;
          this.setProperty(property, value);
        } });
      }
      window.filmstripBudgetObserver = new MutationObserver(records => {
        stats.mutations += records.filter(record => record.type === 'attributes' && record.attributeName === 'style' && nodes.includes(record.target)).length;
        stats.stable &&= document.querySelector('.bg-image-viewer-photo') === photo && rail.children.length === nodes.length && nodes.every((node, index) => rail.children[index] === node);
        stats.maxLayers = Math.max(stats.maxLayers, photo.querySelectorAll(':scope > .bg-image-picture').length);
      });
      window.filmstripBudgetObserver.observe(rail, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
      window.filmstripBudgetObserver.observe(photo, { childList: true });
      const sample = () => {
        stats.maxFrameWrites = Math.max(stats.maxFrameWrites, stats.frameWrites);
        stats.frameWrites = 0; stats.frames++;
        if (stats.running) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    const rail = album(page).locator('.bg-image-viewer-strip'), bounds = await rail.boundingBox();
    await page.mouse.move(bounds.x + bounds.width * .75, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width * .2, bounds.y + bounds.height / 2, { steps: 45 });
    assert(!/photo-0\.svg$/.test(await currentPhoto(page).getAttribute('src')), 'the large photo advances while dragging the 120-image collection');
    await page.mouse.up();
    await settledFilmstrip(page);
    const selected = await rail.locator('[aria-current="true"]').getAttribute('data-image-url');
    await settledPhoto(page, new URL(selected).pathname.slice(1));
    const stats = await page.evaluate(() => ({ ...window.filmstripBudget }));
    assert(stats.writes > 0 && stats.mutations > 0 && stats.frames > 0, 'both style setters and rendered mutations were observed during real drag frames');
    assert(stats.stable, 'all 120 thumbnail buttons and the large-photo parent retain their DOM identities');
    assert(stats.maxLayers <= 2, 'continuous selection never mounts more than two large-photo layers');
    assert(stats.maxFrameWrites <= 4 * (Math.ceil(bounds.width / 60) + 6), 'per-frame thumbnail writes scale with the visible rail instead of the 120-image collection');
    await page.evaluate(() => { window.filmstripIdleWrites = window.filmstripBudget.writes; window.filmstripIdleFrames = 0; });
    await page.waitForFunction(() => ++window.filmstripIdleFrames >= 15, null, { polling: 'raf' });
    assert.equal(await page.evaluate(() => window.filmstripBudget.writes), await page.evaluate(() => window.filmstripIdleWrites), 'settled rails perform no thumbnail style writes while idle');
    await page.evaluate(() => { window.filmstripBudget.running = false; window.filmstripBudgetObserver.disconnect(); });
    await shot(page, 'filmstrip-decoded-drag-120');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('filmstrip mouse dragging and wheel scrubbing update the large photo and settle without losing explicit navigation', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, reducedMotion: 'no-preference' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await imageRoutes(page);
    await page.setContent(await fixture());
    const photos = Array.from({ length: 12 }, (_, index) => '![参考图 ' + index + '](https://gallery.test/photo-' + index + '.svg)').join('\n\n');
    await page.evaluate(text => window.drawImages('stream', text), photos);
    await page.getByRole('button', { name: '展开 12 张图片', exact: true }).click();
    await readyAlbum(page);
    await settledFilmstrip(page);
    const feedScroll = await page.locator('.ba-chat-feed').evaluate(node => node.scrollTop);
    const rail = album(page).locator('.bg-image-viewer-strip');
    const bounds = await rail.boundingBox(), x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
    const initialScroll = await rail.evaluate(node => node.scrollLeft);
    for (const number of [2, 3]) {
      await album(page).getByRole('button', { name: `查看第 ${number} 张图片`, exact: true }).hover();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.match(await currentPhoto(page).getAttribute('src'), /photo-0\.svg$/, 'moving over a thumbnail without pressing never selects it');
      assert.equal(await rail.evaluate(node => node.scrollLeft), initialScroll, 'hover never recenters the filmstrip under the pointer');
    }
    await assertSavedFile(page, album(page).getByRole('button', { name: '下载图片', exact: true }), /photo-0\.svg$/);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 112, y, { steps: 10 });
    await page.waitForFunction(() => !document.querySelector('.bg-image-viewer-photo img')?.src.includes('photo-0'));
    assert.equal(await currentPhoto(page).getAttribute('src'), await rail.locator('[aria-current="true"]').getAttribute('data-image-url'), 'the main photo follows during a mouse drag, before release');
    const scales = await rail.locator('button').evaluateAll(nodes => nodes.map(node => new DOMMatrix(getComputedStyle(node).transform).a));
    assert(Math.max(...scales) - Math.min(...scales) > .08 && Math.min(...scales) < .99, 'thumbnail emphasis changes continuously around the current center');
    await page.mouse.up();
    await settledFilmstrip(page);
    await readyAlbum(page);
    await shot(page, 'filmstrip-mouse-scrub');
    await album(page).getByRole('button', { name: '查看第 1 张图片', exact: true }).click();
    await settledFilmstrip(page);
    assert.match(await currentPhoto(page).getAttribute('src'), /photo-0\.svg$/);
    const wheelBounds = await rail.boundingBox();
    await page.mouse.move(wheelBounds.x + wheelBounds.width / 2, wheelBounds.y + wheelBounds.height / 2);
    await page.mouse.wheel(0, 160);
    await page.waitForFunction(() => !document.querySelector('.bg-image-viewer-photo img')?.src.includes('photo-0'));
    await settledFilmstrip(page);
    assert.equal(await currentPhoto(page).getAttribute('src'), await rail.locator('[aria-current="true"]').getAttribute('data-image-url'), 'wheel scrubbing and the large photo share one current item');
    await album(page).getByRole('button', { name: '查看第 8 张图片', exact: true }).click();
    await album(page).getByRole('button', { name: '上一张图片', exact: true }).click();
    await settledFilmstrip(page);
    assert.match(await currentPhoto(page).getAttribute('src'), /photo-6\.svg$/, 'arrow navigation wins over any intermediate smooth-scroll positions');
    await assertSavedFile(page, album(page).getByRole('button', { name: '下载图片', exact: true }), /photo-6\.svg$/);
    await page.keyboard.press('ArrowLeft');
    await settledFilmstrip(page);
    assert.match(await currentPhoto(page).getAttribute('src'), /photo-5\.svg$/, 'keyboard navigation remains exact');
    assert.equal(await page.locator('.ba-chat-feed').evaluate(node => node.scrollTop), feedScroll, 'scrubbing never scrolls the underlying chat');
    const closingBounds = await rail.boundingBox();
    await page.mouse.move(closingBounds.x + closingBounds.width / 2, closingBounds.y + closingBounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(closingBounds.x + closingBounds.width / 2 - 128, closingBounds.y + closingBounds.height / 2, { steps: 5 });
    await page.mouse.up();
    await album(page).getByRole('button', { name: '关闭图片预览', exact: true }).evaluate(node => node.addEventListener('click', () => { window.photoAtClosing = document.querySelector('.bg-image-viewer-photo [data-presented="true"] img')?.src; }, { once: true, capture: true }));
    await album(page).getByRole('button', { name: '关闭图片预览', exact: true }).click();
    await album(page).waitFor({ state: 'hidden' });
    await page.evaluate(() => { window.closedAlbumFrames = 0; });
    await page.waitForFunction(() => {
      if (document.querySelector('.bg-image-viewer')) throw Error('filmstrip inertia reopened the closed album');
      return ++window.closedAlbumFrames >= 45;
    }, null, { polling: 'raf' });
    assert.equal(await page.locator('.bg-image-gallery-card').first().locator('img').getAttribute('src'), await page.evaluate(() => window.photoAtClosing), 'closing freezes the current cover instead of accepting delayed inertia selections');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('streamed delivery preserves its open album and current photo while bounded stacks avoid mounting the full collection', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1200 }, reducedMotion: 'reduce' });
    const routes = await imageRoutes(page);
    await page.setContent(await fixture());
    const first = '正在整理。\n\n![第一张](https://gallery.test/photo-0.svg)\n\n说明。\n\n![第二张](https://gallery.test/photo-1.svg)';
    await page.evaluate(text => window.drawImages('stream', text), first);
    await page.getByRole('button', { name: '展开 2 张图片', exact: true }).click();
    await readyAlbum(page);
    await album(page).getByRole('button', { name: '下一张图片', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.bg-image-viewer-photo img')?.src.includes('photo-1'));
    await page.evaluate(() => { window.savedGallery = document.querySelector('.bg-image-gallery'); window.savedBubble = document.querySelector('[data-role=assistant] .ba-chat-content'); window.savedAlbum = document.querySelector('.bg-image-viewer'); window.savedPhoto = document.querySelector('.bg-image-viewer-photo'); });
    await page.evaluate(text => window.drawImages('stream', text), first + '\n\n补充来源。\n\n![第三张](https://gallery.test/photo-2.svg)');
    await page.waitForFunction(() => document.querySelectorAll('.bg-image-gallery-card').length === 3);
    assert(await page.evaluate(() => window.savedGallery === document.querySelector('.bg-image-gallery') && window.savedBubble === document.querySelector('[data-role=assistant] .ba-chat-content')));
    assert(await page.evaluate(() => window.savedAlbum === document.querySelector('.bg-image-viewer') && window.savedPhoto === document.querySelector('.bg-image-viewer-photo')), 'streaming keeps the dialog and photo surface mounted');
    assert.equal(await page.locator('.bg-image-gallery').getAttribute('data-expanded'), 'true', 'appended images never close the album');
    assert.match(await currentPhoto(page).getAttribute('src'), /photo-1/, 'streaming preserves the selected photo');
    await album(page).getByText('2 / 3', { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await album(page).waitFor({ state: 'hidden' });
    await page.evaluate(() => window.drawImages('stream', '![第一张](https://gallery.test/photo-0.svg)'));
    await page.waitForFunction(() => !document.querySelector('[data-role=assistant] .ba-chat-content'));
    assert.equal(await page.locator('.ba-reply-deliverables .bg-image-gallery').count(), 1);
    await shot(page, 'image-only');
    await page.getByRole('button', { name: '放大图片 1：第一张', exact: true }).click();
    await readyAlbum(page);
    assert.equal(await album(page).locator('.bg-image-viewer-strip').count(), 0);
    await page.evaluate(text => window.drawImages('stream', text), first);
    const addedRail = album(page).locator('.bg-image-viewer-strip');
    await addedRail.waitFor();
    await page.waitForFunction(() => parseFloat(document.querySelector('.bg-image-viewer-strip').style.paddingInline) > 0);
    const addedBounds = await addedRail.boundingBox();
    await page.mouse.move(addedBounds.x + addedBounds.width / 2, addedBounds.y + addedBounds.height / 2);
    await page.mouse.wheel(0, 80);
    await page.waitForFunction(() => document.querySelector('.bg-image-viewer-photo img')?.src.includes('photo-1'));
    await settledFilmstrip(page);
    await page.keyboard.press('Escape');
    await album(page).waitFor({ state: 'hidden' });
    assert(await page.getByRole('button', { name: '展开 2 张图片', exact: true }).evaluate(node => node === document.activeElement), 'a single image becoming a stack retains an initialized filmstrip and a live focus return target');
    const many = Array.from({ length: 40 }, (_, index) => '![图片 ' + index + '](https://gallery.test/photo-' + index + '.svg)').join('\n\n');
    await page.evaluate(text => window.drawImages('stream', text), many);
    await page.getByRole('button', { name: '展开 40 张图片', exact: true }).waitFor();
    assert.equal(await page.locator('.bg-image-gallery-card').count(), 3, 'a large delivery still mounts only the three visible stack cards');
    assert.equal(await page.locator('.bg-image-gallery img').count(), 3);
    assert.equal(routes.requests.some(url => url.includes('/photo-39.svg')), false, 'unopened collections do not request their last full image');
    await page.getByRole('button', { name: '展开 40 张图片', exact: true }).click();
    await readyAlbum(page);
    assert.equal(await currentPhoto(page).count(), 1, 'the album has exactly one active large-photo surface');
    assert.equal(routes.requests.some(url => url.includes('/photo-39.svg')), false, 'the distant tail is not eagerly loaded for the initial photo');
    await album(page).locator('.bg-image-viewer-strip').evaluate(node => { node.scrollLeft = node.scrollWidth; });
    await page.waitForFunction(() => document.querySelector('.bg-image-viewer-photo img')?.src.includes('photo-39'));
    await settledFilmstrip(page);
    await readyAlbum(page);
    assert.equal(await album(page).getByRole('button', { name: '查看第 40 张图片', exact: true }).getAttribute('aria-current'), 'true', 'scrolling to the collection end selects and loads its final thumbnail');
    for (const width of [320, 1440]) {
      await page.setViewportSize({ width, height: width === 320 ? 844 : 1200 });
      await settledFilmstrip(page);
      await readyAlbum(page);
      assert.match(await currentPhoto(page).getAttribute('src'), /photo-39\.svg$/, 'resizing the open album preserves its current photo');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'resizing the centered filmstrip never creates document overflow');
      const resized = await album(page).boundingBox();
      assert(resized.x >= 0 && resized.x + resized.width <= width + 1, 'the resized album stays within its viewport');
      await assertAlbumToolbar(page);
      await shot(page, `filmstrip-resize-${width}`);
    }
    await album(page).getByRole('button', { name: '查看第 1 张图片', exact: true }).click();
    await settledFilmstrip(page);
    const rail = album(page).locator('.bg-image-viewer-strip'), dragBounds = await rail.boundingBox();
    await rail.evaluate(node => {
      window.dragPointerId = null;
      node.addEventListener('gotpointercapture', event => { window.dragPointerId = event.pointerId; }, { once: true });
    });
    const dragX = dragBounds.x + dragBounds.width / 2, dragY = dragBounds.y + dragBounds.height / 2;
    await page.mouse.move(dragX, dragY);
    await page.mouse.down();
    await page.mouse.move(dragX - 72, dragY, { steps: 7 });
    await page.waitForFunction(() => window.dragPointerId !== null);
    await page.evaluate(text => window.drawImages('stream', text), many + '\n\n![新增图片](https://gallery.test/photo-40.svg)');
    await album(page).getByRole('button', { name: '查看第 41 张图片', exact: true }).waitFor({ state: 'attached' });
    assert(await rail.evaluate(node => node.hasPointerCapture(window.dragPointerId)), 'streaming an additional image preserves the active drag capture');
    const beforeContinuedDrag = await rail.evaluate(node => node.scrollLeft);
    await page.mouse.move(dragX - 160, dragY, { steps: 8 });
    await page.waitForFunction(previous => document.querySelector('.bg-image-viewer-strip').scrollLeft > previous + 40, beforeContinuedDrag);
    await page.mouse.up();
    await settledFilmstrip(page);
    assert.equal(await currentPhoto(page).getAttribute('src'), await rail.locator('[aria-current="true"]').getAttribute('data-image-url'), 'the same drag continues changing the large photo after streaming append');
    await album(page).getByRole('button', { name: '全部总览', exact: true }).click();
    await album(page).locator('.bg-image-viewer-overview').waitFor();
    assert.equal(await album(page).getByRole('button', { name: /^查看大图 / }).count(), 41);
    assert(await album(page).locator('.bg-image-viewer-overview').evaluate(node => node.scrollHeight > node.clientHeight), 'large overviews scroll inside the album');
    await page.keyboard.press('Escape');
    await album(page).waitFor({ state: 'hidden' });
  } finally { await browser.close(); }
});
