import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sharedUiStyles } from '../scripts/shared-ui.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
const { chromium } = require('playwright');
const { build } = createRequire(new URL('../package.json', import.meta.url))('esbuild');
const executablePath = [process.env.CHROMIUM_EXECUTABLE_PATH, chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(path => path && existsSync(path));

async function fixture() {
  const bundle = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React,{useRef} from 'react';import {createRoot} from 'react-dom/client';
    import {Button} from './plugins/shared/client/ui/button.jsx';
    import {Tooltip} from './plugins/shared/client/ui/tooltip.jsx';
    import {Loading} from './plugins/shared/client/ui/loading.jsx';
    import {useConfirmation} from './plugins/shared/client/ui/confirmation.jsx';
    import typography from './plugins/shared/client/chat-typography.css';
    const root=createRoot(document.getElementById('root'));let serial=0;window.results=[];
    function Demo({mode}){
      const [confirm,dialog]=useConfirmation(),control=useRef(null);
      window.readOwnerRef=()=>control.current?.textContent;
      return <main><style>{typography}</style><header>共享反馈</header>
        {mode==='loading'?<Loading label='正在加载内容'/>:mode==='error'?<p role='alert'>读取失败，请重试</p>:mode==='empty'?<p>还没有内容</p>:<>
          <div className='tooltip-row'><Tooltip label='保留官方提示交互' delayMs={10}><button ref={control}>按钮提示</button></Tooltip>
          <Tooltip label='禁用原因' delayMs={10}><button disabled>不可用按钮</button></Tooltip>
          <Tooltip><button>没有提示</button></Tooltip></div>
          <Button title='普通操作提示' onClick={()=>window.results.push('ordinary-action')}>普通操作</Button>
          <Button onClick={async()=>{const allowed=await confirm({title:'删除测试草稿',description:'此操作只用于本地普通确认。',confirmLabel:'删除',destructive:true});window.results.push(allowed);}}>删除草稿</Button>
          <div className='ba-chat-content'><p>消息正文保持清楚易读。</p><pre><code>const code = true;</code></pre></div>
        </>}{dialog}</main>;
    }
    window.renderMode=mode=>root.render(<Demo key={++serial} mode={mode}/>);window.unmount=()=>root.render(null);
  ` }, bundle: true, write: false, outdir: join(root, 'artifacts/unused-feedback-test'), format: 'iife', jsx: 'automatic',
    nodePaths: [join(root, 'plugins/benchgo/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
    alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')),
      '@deepseek-ai/dsh-client-ui-primitives': join(root, 'deepseek-harness/packages/client/ui-primitives/src/Tooltip.tsx') },
    loader: { '.css': 'text', '.module.css': 'local-css' }, plugins: [sharedUiStyles()],
    define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  const script = bundle.outputFiles.find(file => file.path.endsWith('.js')).text;
  const css = bundle.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n');
  return `<!doctype html><html lang='zh-CN'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><style>
    :root{--dsw-alias-bg-base:#fff;--dsw-alias-label-primary:#202124;--dsw-alias-label-secondary:#6b6b70;--dsw-alias-tooltip-bg:#242832;--dsw-static-neutral-bluish-00:#fff;--dsw-radius-sm:6px;--ds-ease-in-out:ease;--ds-font-family-code:Consolas,monospace}
    body{margin:0;font:14px/1.5 Arial,sans-serif;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}main{padding:24px;box-sizing:border-box;max-width:900px;margin:auto}header{font-size:18px;margin-bottom:20px}.tooltip-row{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:24px}body[data-ds-dark-theme]{--dsw-alias-bg-base:#19191b;--dsw-alias-label-primary:#ededee;--dsw-alias-label-secondary:#a3a3a8}pre{overflow:auto}${css}
  </style></head><body><div id='root'></div><script>${script.replaceAll('</script', '<\\/script')}</script></body></html>`;
}

test('shared feedback preserves official tooltip, cancellation, focus, reduced motion and readable prose in the real browser', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const screenshots = process.env.BENCHGO_FEEDBACK_SCREENSHOTS;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  try {
    const page = await browser.newPage(), errors = []; page.setDefaultTimeout(6000);
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://localhost/', route => route.fulfill({ contentType: 'text/html', body: '' }));
    await page.goto('http://localhost/'); await page.setContent(await fixture());
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 850 });
      for (const dark of [false, true]) {
        await page.evaluate(dark => dark ? document.body.setAttribute('data-ds-dark-theme', '') : document.body.removeAttribute('data-ds-dark-theme'), dark);
        for (const mode of ['empty', 'loading', 'error', 'data']) {
          await page.evaluate(mode => window.renderMode(mode), mode);
          if (mode === 'loading') {
            await page.getByRole('status', { name: '正在加载内容' }).waitFor();
            await page.emulateMedia({ reducedMotion: 'reduce' });
            assert.equal(await page.locator('.bg-loading-character').first().evaluate(node => getComputedStyle(node).animationName), 'none');
            await page.emulateMedia({ reducedMotion: 'no-preference' });
          } else if (mode === 'error') await page.getByRole('alert').waitFor();
          else if (mode === 'empty') await page.getByText('还没有内容', { exact: true }).waitFor();
          else {
            const prompt = page.getByRole('button', { name: '按钮提示', exact: true }); await prompt.waitFor();
            await prompt.hover(); await page.getByRole('tooltip', { name: '保留官方提示交互' }).waitFor();
            assert.equal(await page.evaluate(() => window.readOwnerRef()), '按钮提示');
            const bounds = await page.getByRole('tooltip').boundingBox(); assert(bounds.x >= 0 && bounds.x + bounds.width <= width);
            await page.mouse.move(0, 0); await page.getByRole('tooltip').waitFor({ state: 'hidden' });
            const disabledAnchor = page.getByRole('button', { name: '不可用按钮', exact: true }).locator('..');
            await disabledAnchor.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
            await page.getByRole('tooltip', { name: '禁用原因' }).waitFor();
            await page.keyboard.press('Tab'); await page.getByRole('tooltip').waitFor({ state: 'hidden' });
            await page.getByRole('button', { name: '没有提示', exact: true }).hover(); await page.waitForTimeout(500);
            assert.equal(await page.getByRole('tooltip').count(), 0);
            const prose = await page.locator('.ba-chat-content p').evaluate(node => ({ font: getComputedStyle(node).fontSize, line: getComputedStyle(node).lineHeight }));
            assert.equal(prose.font, '15px'); assert.equal(prose.line, '27px');
            assert.match(await page.locator('.ba-chat-content code').evaluate(node => getComputedStyle(node).fontFamily), /Consolas/);
          }
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), mode+'/'+width);
          if (screenshots) await page.screenshot({ path: join(screenshots, `${mode}-${width}-${dark ? 'dark' : 'light'}.png`), animations: 'disabled' });
        }
      }
    }
    await page.setViewportSize({ width: 390, height: 850 }); await page.evaluate(() => window.renderMode('data'));
    const opener = page.getByRole('button', { name: '删除草稿', exact: true });
    await opener.click(); await page.getByRole('dialog', { name: '删除测试草稿' }).waitFor();
    assert(await page.getByRole('button', { name: '取消', exact: true }).evaluate(node => node === document.activeElement));
    assert.deepEqual(await page.evaluate(() => window.results), []);
    if (screenshots) await page.screenshot({ path: join(screenshots, 'confirmation-default-cancel.png'), animations: 'disabled' });
    await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.deepEqual(await page.evaluate(() => window.results), [false]); assert(await opener.evaluate(node => node === document.activeElement));
    await opener.click(); await page.getByRole('button', { name: '删除', exact: true }).click(); await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.deepEqual(await page.evaluate(() => window.results), [false, true]);
    await opener.click(); await page.getByRole('dialog').waitFor(); await page.evaluate(() => window.unmount());
    await page.waitForFunction(() => window.results.length === 3); assert.deepEqual(await page.evaluate(() => window.results), [false, true, false]);
    assert.equal(await page.getByRole('dialog').count(), 0); assert.equal(await page.locator('#benchgo-confirmation-styles').count(), 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
