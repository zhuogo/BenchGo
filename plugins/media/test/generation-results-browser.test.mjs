import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sharedUiStyles } from '../../base/scripts/shared-ui.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
const { chromium } = require('playwright');
const { build } = createRequire(new URL('../../base/package.json', import.meta.url))('esbuild');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || [chromium.executablePath(),
  'C:/Users/DraftGo/AppData/Local/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-win64/chrome-headless-shell.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const pageUrl = 'http://localhost/bench/';
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC6kAAAAASUVORK5CYII=', 'base64');

function audioFixture() {
  const samples = 12 * 8_000;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8_000, 24);
  wav.writeUInt32LE(16_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(samples * 2, 40);
  return wav;
}

function serveAudio(route, wav) {
  const headers = { 'content-type': 'audio/wav', 'accept-ranges': 'bytes' };
  const range = /^bytes=(\d+)-(\d*)$/u.exec(route.request().headers().range ?? '');
  if (!range) return route.fulfill({ headers, body: wav });
  const start = Number(range[1]);
  const end = range[2] ? Math.min(Number(range[2]), wav.length - 1) : wav.length - 1;
  if (start > end) return route.fulfill({ status: 416, headers: { ...headers, 'content-range': `bytes */${wav.length}` } });
  return route.fulfill({ status: 206, headers: { ...headers, 'content-range': `bytes ${start}-${end}/${wav.length}` }, body: wav.subarray(start, end + 1) });
}

async function fixture() {
  const bundle = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { registerMediaGenerationResults } from './plugins/media/client/generation-results.jsx';
    import { installIconSprite } from './deepseek-harness/packages/client/ui-theme/src/client/icon-sprite.ts';
    installIconSprite({ effect: callback => callback(), on() {} }, undefined);
    const root = createRoot(document.getElementById('root'));
    let definition, Result;
    registerMediaGenerationResults({
      effect: callback => callback(),
      uiConversation: { events: { register(value) { definition = value; } } },
      slots: { inject(name, callback) { callback(); }, register(info, view) { Result = view; } },
    });
    window.renderArtifact = options => {
      const { filename, mimeType, externalUrl, modelId, modelName, name = 'generate_image', native, replace, isError, second, metadata,
        url = externalUrl ?? 'api/benchgo/media/artifact?file=' + filename } = options;
      const payload = { url, filename, mimeType, externalUrl, modelId, modelName };
      const location = { kind: 'turn', turn: 1 };
      const call = native ? { type: 'plugin:benchgo-plugin/media-result', seq: 8, ignorable: true, data: payload }
        : { type: 'tool/call', seq: 7, data: { turn: 1, name, callId: 'call-1' } };
      const result = { type: 'tool/result', surfaceOp: replace ? 'replace' : 'append', seq: 8, data: {
        turn: 1, ...(metadata ? { meta: { benchgoMedia: payload } } : {}), message: {
        source: { callId: 'call-1' }, isError, content: [{ type: 'text', text: JSON.stringify(metadata ? { filename } : payload) }],
      } } };
      const startMatch = definition.match[call.type](call);
      const resultMatch = definition.match[result.type](result);
      let node = null;
      if (startMatch && (native || startMatch.id === resultMatch?.id)) {
        const start = { ...startMatch, event: call, location };
        const context = { key: 'render-1', id: startMatch.id, start, current: new Map() };
        context.state = definition.start(context, start);
        if (!native) context.state = definition.update(context, { ...resultMatch, event: result, location });
        if (second) {
          const nextCall = { ...call, seq: 9, data: { ...call.data, callId: 'call-2' } };
          const nextResult = { ...result, seq: 10, data: { ...result.data, meta: undefined, message: {
            source: { callId: 'call-2' }, content: [{ type: 'text', text: JSON.stringify(second) }],
          } } };
          for (const event of [nextCall, nextResult, { ...nextResult, seq: 11 }]) {
            const match = definition.match[event.type](event);
            if (match?.id === start.id) context.state = definition.update(context, { ...match, event, location });
          }
        }
        node = definition.buildViewNode(context);
      }
      root.render(<main aria-label="聊天"><p>{mimeType?.startsWith('audio/') ? '这是生成的故事音频。' : '这是生成的媒体。'}</p>
        {node ? <Result key={url} node={node} /> : <span data-empty />}
      </main>);
      return node && { groupTree: node.groupTree, seq: node.anchorSeq };
    };
  ` }, bundle: true, write: false, outdir: join(root, 'artifacts/unused-media-result-ui'), format: 'iife', jsx: 'automatic',
    nodePaths: [join(root, 'plugins/base/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
    alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')),
      '@deepseek-ai/dsh-client-ui-primitives': join(root, 'deepseek-harness/packages/client/ui-primitives/src/index.ts') },
    loader: { '.css': 'text', '.module.css': 'local-css', '.svg': 'text' }, plugins: [sharedUiStyles()],
    define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  const script = bundle.outputFiles.find(file => file.path.endsWith('.js')).text;
  const styles = bundle.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n');
  const themeRoot = join(root, 'deepseek-harness/packages/client/ui-theme/src/styles');
  const theme = (await Promise.all(['base.css', 'design-platform.css', 'focus.css'].map(name => readFile(join(themeRoot, name), 'utf8')))).join('\n');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${theme}${styles}
    body{margin:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:14px/1.6 var(--dsw-font-family)}
    main{box-sizing:border-box;margin-inline:auto;width:min(100%,736px);padding:16px}
  </style></head><body><div id="root"></div><script>${script.replaceAll('</script', '<\\/script')}</script></body></html>`;
}

test('chat renders generated media outside the folded process and downloads through the session base', { skip: !executablePath && 'Chromium/Edge required' }, async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 780 } });
    const screenshots = process.env.BENCHGO_MEDIA_RESULT_SCREENSHOTS;
    if (screenshots) await mkdir(screenshots, { recursive: true });
    const shot = name => screenshots && page.screenshot({ path: join(screenshots, name + '.png'), animations: 'disabled' });
    const scriptErrors = [];
    page.on('pageerror', error => scriptErrors.push(error.message));
    page.setDefaultTimeout(6000);
    const html = await fixture();
    const wav = audioFixture();
    const cdnImage = 'https://pub-13fd1d3607a441b4a9d232b3a223f5f6.r2.dev/generated/image?signature=a%2Fb';
    const { promise: imageReady, resolve: releaseImage } = Promise.withResolvers();
    const { promise: audioReady, resolve: releaseAudio } = Promise.withResolvers();
    let audioRequests = 0, retryRequests = 0;
    await page.route('**/*', async route => {
      const target = new URL(route.request().url());
      if (target.href === pageUrl) return route.fulfill({ contentType: 'text/html', body: html });
      if (target.href === cdnImage) {
        assert.equal(route.request().headers().referer, undefined);
        return route.fulfill({ contentType: 'image/png', body: pixel });
      }
      if (target.pathname !== '/bench/api/benchgo/media/artifact') return route.abort();
      if (['cover.png', 'other.png'].includes(target.searchParams.get('file'))) {
        await imageReady;
        return route.fulfill({ contentType: 'image/png', body: pixel });
      }
      if (target.searchParams.get('file') === 'narration.wav') {
        audioRequests++;
        await audioReady;
        return serveAudio(route, wav);
      }
      if (target.searchParams.get('file') === 'retry.wav' && ++retryRequests > 1) return serveAudio(route, wav);
      return route.fulfill({ status: 404 });
    });
    await page.goto(pageUrl);
    const render = options => page.evaluate(value => window.renderArtifact(value), options);
    const image = { filename: 'cover.png', mimeType: 'image/png', modelId: 'image/exact', modelName: 'Fixture Image Model' };
    for (const input of [{ ...image, name: 'other_tool' }, { ...image, url: 'https://invalid.test/cover.png' }, { ...image, isError: true }, { ...image, replace: true }, {}]) {
      assert.equal(await render(input), null);
      await page.locator('[data-empty]').waitFor({ state: 'attached' });
      assert.equal(await page.locator('[data-media-result]').count(), 0);
    }
    await shot('generated-empty');
    assert.deepEqual(await render(image), { groupTree: 'turn', seq: 8 });
    await page.getByRole('status').filter({ hasText: '正在加载图片' }).waitFor();
    await shot('generated-loading');
    releaseImage();
    await page.locator('.bg-image-picture[data-state="ready"] img').waitFor();
    assert.equal(await page.locator('.bg-image-model-name').textContent(), 'Fixture Image Model');
    assert.equal(await page.getByRole('link', { name: '打开原图' }).getAttribute('href'), 'api/benchgo/media/artifact?file=cover.png');
    await page.getByRole('button', { name: '下载图片 1' }).waitFor();
    await shot('generated-data');
    const open = page.getByRole('button', { name: '放大图片 1：cover.png' });
    await open.press('Enter');
    const viewer = page.getByRole('dialog', { name: '图片预览' });
    await viewer.getByRole('img', { name: 'cover.png' }).waitFor();
    const download = page.waitForEvent('download');
    await viewer.getByRole('button', { name: '下载图片', exact: true }).click();
    assert.equal((await download).suggestedFilename(), 'cover.png');
    await shot('generated-viewer');
    await page.keyboard.press('Escape');
    await viewer.waitFor({ state: 'hidden' });
    assert(await open.evaluate(element => element === document.activeElement));
    await render({ ...image, metadata: true, second: { ...image, filename: 'other.png', url: 'api/benchgo/media/artifact?file=other.png' } });
    await page.getByRole('button', { name: '展开 2 张图片' }).click();
    await viewer.getByRole('button', { name: '下一张图片' }).click();
    await viewer.getByRole('img', { name: 'other.png' }).waitFor();
    await page.keyboard.press('Escape');
    await viewer.waitFor({ state: 'hidden' });
    await render({ native: true, filename: 'missing.png', mimeType: 'image/png' });
    await page.getByRole('alert').filter({ hasText: '图片加载失败' }).waitFor();
    await page.getByRole('button', { name: '重试加载图片' }).waitFor();
    await shot('generated-error');
    for (const native of [false, true]) {
      assert.deepEqual(await render({ native, externalUrl: cdnImage, mimeType: 'image/*' }), { groupTree: 'turn', seq: 8 });
      await page.locator('.bg-image-picture[data-state="ready"] img').waitFor();
      assert.equal(await page.getByRole('link', { name: '打开原图' }).getAttribute('href'), cdnImage);
      assert.equal(await page.locator('.bg-image-model-name').count(), 0);
      assert.equal(await page.getByText('生成图片', { exact: true }).count(), 0);
    }
    await shot('generated-cdn');
    assert.deepEqual(await render({ native: true, filename: 'narration.wav', mimeType: 'audio/wav' }), { groupTree: 'turn', seq: 8 });
    const audioCard = page.locator('.bg-conversation-media[data-kind="audio"]');
    const player = audioCard.locator('audio');
    const progress = audioCard.getByRole('slider', { name: '播放进度' });
    const start = audioCard.getByRole('button', { name: '播放 narration.wav', exact: true });
    const pause = audioCard.getByRole('button', { name: '暂停 narration.wav', exact: true });
    const replay = audioCard.getByRole('button', { name: '重新播放 narration.wav', exact: true });
    const speed = audioCard.getByRole('button', { name: /播放速度/u });
    const speedOptions = page.getByRole('listbox', { name: /播放速度/u });
    const rateOption = rate => speedOptions.getByRole('option', { name: `${rate}×`, exact: true });
    const layoutShot = async name => {
      if (!screenshots) return;
      await shot(`${name}-narrow-dark`);
      await page.setViewportSize({ width: 1000, height: 720 });
      await page.evaluate(() => document.body.removeAttribute('data-ds-dark-theme'));
      await shot(`${name}-desktop-light`);
      await page.setViewportSize({ width: 390, height: 780 });
      await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''));
    };
    await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''));
    await start.waitFor();
    assert.equal(await audioCard.getAttribute('data-state'), 'idle');
    const playGlyph = start.locator('.bg-conversation-audio-glyph');
    assert.notEqual(await playGlyph.evaluate(element => getComputedStyle(element).clipPath), 'none');
    assert.equal(audioRequests, 0);
    assert.equal(await player.getAttribute('src'), null);
    await layoutShot('audio-idle');
    await start.click();
    await audioCard.and(page.locator('[data-state="loading"]')).waitFor();
    await layoutShot('audio-loading');
    releaseAudio();
    await pause.waitFor();
    const pauseGlyph = pause.locator('.bg-conversation-audio-glyph');
    assert(await pauseGlyph.evaluate(element => {
      const style = getComputedStyle(element);
      return style.clipPath === 'none' && parseFloat(style.borderInlineStartWidth) > 0
        && parseFloat(style.borderInlineEndWidth) > 0;
    }));
    await audioCard.and(page.locator('[data-state="ready"]')).waitFor();
    assert.equal(await player.evaluate(element => element.duration), 12);
    await pause.click();
    await start.waitFor();
    await progress.press('Home');
    await progress.press('ArrowRight');
    await page.waitForFunction(() => Math.abs(document.querySelector('audio').currentTime - 5) < 0.1);
    const track = await progress.boundingBox();
    await page.mouse.move(track.x + track.width * 0.2, track.y + track.height / 2);
    await page.mouse.down();
    await page.mouse.move(track.x + track.width * 0.65, track.y + track.height / 2, { steps: 4 });
    await page.mouse.up();
    assert(await player.evaluate(element => element.currentTime > 6 && element.currentTime < 10));
    await speed.press('Enter');
    await speedOptions.waitFor();
    assert.equal(await rateOption(1).getAttribute('aria-selected'), 'true');
    await speedOptions.press('ArrowDown');
    await speedOptions.press('Escape');
    await speedOptions.waitFor({ state: 'hidden' });
    assert(await speed.evaluate(element => element === document.activeElement));
    assert.equal(await player.evaluate(element => element.playbackRate), 1);

    await speed.press('Enter');
    await speedOptions.waitFor();
    await speedOptions.press('ArrowDown');
    await speedOptions.press('ArrowDown');
    await speedOptions.press('Enter');
    await speedOptions.waitFor({ state: 'hidden' });
    assert(await speed.evaluate(element => element === document.activeElement));
    assert.equal(await player.evaluate(element => element.playbackRate), 1.5);

    await speed.click();
    await speedOptions.waitFor();
    assert.equal(await rateOption(1.5).getAttribute('aria-selected'), 'true');
    assert(await rateOption(1.5).evaluate(element => {
      const style = getComputedStyle(element);
      return parseFloat(style.paddingLeft) >= 8 && parseFloat(style.paddingRight) >= 8;
    }));
    await layoutShot('audio-speed-menu');
    await rateOption(2).click();
    await speedOptions.waitFor({ state: 'hidden' });
    assert(await speed.evaluate(element => element === document.activeElement));
    assert.equal(await player.evaluate(element => element.playbackRate), 2);
    await layoutShot('audio-ready');
    await progress.press('End');
    await start.or(replay).click();
    await pause.waitFor();
    assert(await player.evaluate(element => element.currentTime < 5));
    await pause.click();
    await render({ native: true, filename: 'retry.wav', mimeType: 'audio/wav' });
    await audioCard.getByRole('button', { name: '播放 retry.wav', exact: true }).click();
    const retry = audioCard.getByRole('button', { name: '重试播放 retry.wav', exact: true });
    await retry.waitFor();
    await retry.locator('svg').waitFor();
    assert.equal(await audioCard.getAttribute('data-state'), 'error');
    await audioCard.getByRole('button', { name: '下载 retry.wav', exact: true }).waitFor();
    await layoutShot('audio-error');
    await retry.click();
    await audioCard.getByRole('button', { name: '暂停 retry.wav', exact: true }).waitFor();
    assert.equal(retryRequests, 2);
    await render({ name: 'media_video_status', filename: 'missing.mp4', mimeType: 'video/mp4' });
    await page.getByRole('button', { name: '播放 missing.mp4' }).click();
    await page.getByText('视频暂时无法播放').waitFor();
    await page.getByRole('button', { name: '下载 missing.mp4' }).waitFor();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(scriptErrors, []);
  } finally { await browser.close(); }
});
