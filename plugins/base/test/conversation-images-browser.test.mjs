import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
const { chromium } = require('playwright');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || [chromium.executablePath(),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);

async function fixture() {
  const bundle = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { mountConversationImages } from './plugins/base/client/conversation-images.jsx';
    import { UserContent } from './deepseek-harness/packages/client/ui-chat/src/client/chat/UserContent.tsx';
    import { AssistantMarkdown } from './deepseek-harness/packages/client/ui-chat/src/client/chat/AssistantMarkdown.tsx';
    import { installIconSprite } from './deepseek-harness/packages/client/ui-theme/src/client/icon-sprite.ts';
    installIconSprite({ effect: fn => fn(), on() {} });
    const registry = new Map();
    mountConversationImages({ effect: fn => fn(), slots: { inject: (_name, fn) => fn(), register: ({ name, priority }, Component) => {
      if (priority >= 100) throw Error('Official gallery priority would win');
      registry.set(name, Component);
    } } });
    window.imageSlots = [...registry.keys()];
    const root = createRoot(document.getElementById('root'));
    const t = key => key;
    const attachment = (id, name) => ({ attachmentId: id, mediaType: 'image/png', name, bytes: 68, width: 1, height: 1 });
    const cache = new Map();
    const loadImage = Object.assign(async reference => {
      const response = await fetch('/attachment/' + reference.attachmentId);
      if (!response.ok) throw Error('Unavailable attachment');
      const url = URL.createObjectURL(await response.blob());
      cache.set(reference.attachmentId, url);
      return url;
    }, { peek: reference => cache.get(reference.attachmentId) });
    const renderFactorySlot = (name, props) => name === 'conversation.images.content'
      ? <span data-official-thumbnail>{props.images[0].attachment.name}</span> : <span>{props.text}</span>;
    const renderSlot = (name, props) => {
      const Component = registry.get(name);
      return Component && <Component {...props} renderFactorySlot={renderFactorySlot} />;
    };
    const picture = (id, name) => ({ kind: 'image', attachment: attachment(id, name) });
    const userPicture = (id, name) => ({ type: 'image', image: { attachment: attachment(id, name) } });
    window.renderChat = (mode = 'data') => root.render(<main className="fixture-chat" aria-label="聊天记录">
      <article className="fixture-user" aria-label="用户消息"><UserContent t={t} facts={{}} loadImage={loadImage}
        renderSlot={renderSlot} renderFactorySlot={renderFactorySlot}
        content={{ text: '查看这几张图片', attachments: mode === 'empty' ? [] : [
          userPicture('upload', '上传.png'), { type: 'file', file: { name: '说明.txt', bytes: 12 } }, userPicture('upload2', '上传二.png'),
        ], extraBlocks: [] }} /></article>
      {mode === 'data' && <article className="fixture-user" aria-label="另一条用户消息"><UserContent t={t} facts={{}} loadImage={loadImage}
        renderSlot={renderSlot} renderFactorySlot={renderFactorySlot}
        content={{ text: '还有一张图片', attachments: [userPicture('upload3', '补充.png')], extraBlocks: [] }} /></article>}
      <article aria-label="助手消息"><AssistantMarkdown t={t} streaming={false} loadImage={loadImage} renderSlot={renderSlot}
        blocks={[{ kind: 'text', text: '这里是图片。' }, ...(mode === 'empty' ? [] : [picture('one', '第一张.png'), picture('two', '第二张.png')])]} /></article>
      {mode === 'data' && <aside aria-label="轨迹附件">{renderSlot('conversation.trajectory.images', {
        images: [{ attachment: attachment('thumb', '轨迹缩略图.png') }], thumbnail: true, loadImage, align: 'start',
      })}</aside>}
    </main>);
  ` }, bundle: true, write: false, outdir: join(root, 'artifacts/unused-conversation-images'), format: 'iife', jsx: 'automatic',
    nodePaths: [join(root, 'plugins/base/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
    alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')),
      '@deepseek-ai/dsh-client-ui-primitives': join(root, 'deepseek-harness/packages/client/ui-primitives/src/index.ts'),
      '@deepseek-ai/dsh-util-workspace-path': join(root, 'deepseek-harness/packages/util/workspace-path/src/index.ts'),
      '@deepseek-ai/dsh-brand': join(root, 'deepseek-harness/packages/util/brand/src/index.ts'),
      '@deepseek-ai/dsh-util-code-language': join(root, 'deepseek-harness/packages/util/code-language/src/index.ts') },
    loader: { '.css': 'text', '.module.css': 'local-css', '.svg': 'text' }, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  const theme = (await Promise.all(['base.css', 'design-platform.css', 'focus.css'].map(name => readFile(
    join(root, 'deepseek-harness/packages/client/ui-theme/src/styles', name), 'utf8')))).join('\n');
  const script = bundle.outputFiles.find(file => file.path.endsWith('.js')).text;
  const styles = bundle.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>${theme}${styles}body{margin:0;font-family:Arial,sans-serif;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#202124)}
    .fixture-chat{max-width:760px;margin:auto;padding:16px}.fixture-user{display:flex;justify-content:flex-end}
    html[data-dark=true]{--dsw-alias-bg-base:#19191b;--dsw-alias-label-primary:#ededee;--dsw-alias-label-secondary:#a3a3a8}</style>
    </head><body><div id="root"></div><script>${script.replaceAll('</script', '<\\/script')}</script></body></html>`;
}

test('official message slots reuse the gallery and group user images within each message', { skip: !executablePath }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: 1024, height: 760 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(6000);
    const screenshots = process.env.BENCHGO_CHAT_IMAGE_SCREENSHOTS;
    if (screenshots) await mkdir(screenshots, { recursive: true });
    const shot = name => screenshots && page.screenshot({ path: join(screenshots, name + '.png') });
    const html = await fixture();
    const photo = await readFile(join(root, 'assets/brand/benchgo-mark.png'));
    const errors = [], attempts = new Map();
    const { promise, resolve } = Promise.withResolvers();
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
      const id = url.pathname.split('/').at(-1);
      const attempt = (attempts.get(id) || 0) + 1;
      attempts.set(id, attempt);
      if (id === 'one') await promise;
      if (id === 'two' && attempt === 1) return route.fulfill({ status: 404 });
      return route.fulfill({ contentType: 'image/png', body: photo });
    });
    await page.goto('http://localhost/');
    assert.deepEqual(await page.evaluate(() => window.imageSlots), [
      'conversation.chat.message.images', 'conversation.chat.user.images', 'conversation.trajectory.images', 'tool.call.images',
    ]);
    await page.evaluate(() => window.renderChat('empty'));
    await page.getByText('这里是图片。').waitFor();
    assert.equal(await page.locator('.bg-conversation-images').count(), 0);
    await shot('empty');
    await page.evaluate(() => window.renderChat());
    const assistant = page.getByRole('article', { name: '助手消息' });
    await assistant.getByRole('status', { name: '正在加载图片…' }).waitFor();
    await shot('loading');
    resolve();
    await assistant.getByText('图片加载失败').waitFor();
    await shot('error');
    await assistant.getByRole('button', { name: '重试加载图片' }).click();
    const open = assistant.getByRole('button', { name: '展开 2 张图片' });
    await open.waitFor();
    const user = page.getByRole('article', { name: '用户消息', exact: true });
    const userOpen = user.getByRole('button', { name: '展开 2 张图片' });
    await userOpen.waitFor();
    assert.equal(await user.locator('.bg-image-gallery').count(), 1);
    await user.getByText('说明.txt').waitFor();
    await page.getByRole('article', { name: '另一条用户消息' }).getByRole('button', { name: '放大图片 1：补充.png' }).waitFor();
    assert.deepEqual([...attempts.entries()].sort(), [['one', 1], ['two', 2], ['upload', 1], ['upload2', 1], ['upload3', 1]]);
    assert.equal(await page.locator('[data-official-thumbnail]').textContent(), '轨迹缩略图.png');
    await userOpen.press('Enter');
    const userViewer = page.getByRole('dialog', { name: '图片预览' });
    await userViewer.getByRole('img', { name: '上传.png', exact: true }).waitFor();
    await userViewer.getByRole('button', { name: '下一张图片' }).click();
    await userViewer.locator('.bg-image-picture[data-state=ready]').getByRole('img', { name: '上传二.png' }).waitFor();
    await page.keyboard.press('Escape');
    await userViewer.waitFor({ state: 'hidden' });
    for (const width of [1024, 390]) {
      await page.setViewportSize({ width, height: 760 });
      await page.evaluate(dark => document.body.toggleAttribute('data-ds-dark-theme', dark), width === 390);
      assert(await user.locator('.bg-image-gallery-deck').evaluate(deck => deck.clientWidth > 64));
      await shot('data-' + width);
      const overflow = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth - innerWidth,
        elements: [...document.querySelectorAll('.fixture-chat *')].filter(node => node.getBoundingClientRect().right > innerWidth)
          .map(node => [node.className, node.getBoundingClientRect().right]),
      }));
      assert(overflow.scroll <= 0, JSON.stringify(overflow));
      await open.press('Enter');
      const viewer = page.getByRole('dialog', { name: '图片预览' });
      if (width === 390) {
        await viewer.getByRole('img', { name: '第二张.png' }).waitFor();
        await viewer.getByRole('button', { name: '上一张图片' }).click();
      }
      await viewer.getByRole('img', { name: '第一张.png' }).waitFor();
      await viewer.getByRole('button', { name: '下一张图片' }).click();
      await viewer.locator('.bg-image-picture[data-state=ready]').getByRole('img', { name: '第二张.png' }).waitFor();
      await shot('viewer-' + width);
      await page.keyboard.press('Escape');
      await viewer.waitFor({ state: 'hidden' });
      await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '展开 2 张图片');
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
