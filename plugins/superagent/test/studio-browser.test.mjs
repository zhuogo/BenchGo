import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sharedUiStyles } from '../../benchgo/scripts/shared-ui.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
const { chromium } = require('playwright');
const { build } = createRequire(new URL('../../benchgo/package.json', import.meta.url))('esbuild');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || [chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);

async function fixture() {
  const bundle = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
    import {Studio} from './plugins/superagent/client/index.jsx';
    import {installIconSprite} from './deepseek-harness/packages/client/ui-theme/src/client/icon-sprite.ts';
    import css from './plugins/superagent/client/style.css';import hostCss from './plugins/benchgo/client/style.css';
    import tokens from './deepseek-harness/packages/client/ui-theme/src/styles/design-platform.css';import themeBase from './deepseek-harness/packages/client/ui-theme/src/styles/base.css';
    const initial={revision:1,name:'BenchGo',models:[{providerId:'Provider:Exact',modelId:'Model:First/1'}],workerModels:[],auxiliary:{models:[],capabilities:[]},image:{modelId:'Image:Keep/1'}};
    const memories=Array.from({length:30},(_,index)=>({id:'memory-'+index,content:'协作记录 '+(index+1)+'：保留简洁的操作路径与真实状态。',revision:1,document:'MEMORY.md',updatedAt:'2026-11-08T08:00:00Z'}));
    window.config=initial;
    installIconSprite({effect:effect=>effect(),on(){}},undefined);
    function App(){
      const [snapshot,setSnapshot]=useState({config:initial,memories});
      window.acceptConfig=config=>{window.config=config;setSnapshot({config,memories});};
      return <div className='ba-root'><style>{tokens}{themeBase}{hostCss}{css}</style><main className='ba-main'><Studio snapshot={snapshot} ctx={{layout:{selectPanel(){}}}} execute={operation=>operation()} refresh={async()=>window.acceptConfig(window.config)} threadId='main'/></main></div>;
    }
    createRoot(document.getElementById('root')).render(<App/>);
  ` }, bundle: true, write: false, outdir: join(root, 'artifacts', 'unused-studio-ui-test'), format: 'iife', jsx: 'automatic',
    nodePaths: [join(root, 'plugins/benchgo/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
    alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')) },
    loader: { '.css': 'text', '.svg': 'text' }, plugins: [{ name: 'studio-test-export', setup(build) {
      build.onLoad({ filter: /superagent[\\/]client[\\/]index\.jsx$/ }, async ({ path }) => ({ contents: `${await readFile(path, 'utf8')}\nexport { Studio };`, loader: 'jsx', resolveDir: dirname(path) }));
    } }, sharedUiStyles()], define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font-family:var(--dsw-font-family,Arial,sans-serif);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}#root{height:100vh}.ba-root{min-width:0!important}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script></body></html>`;
}

test('Studio preserves drafts and scroll, validates collapsed models, recovers saves and offers focused themed navigation', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const screenshots = process.env.BENCHGO_STUDIO_SCREENSHOTS;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  const file = { id: 'note.md', name: 'note.md', path: 'note.md', type: 'file', url: '/api/files/note.md', bytes: 64, hash: 'one', updatedAt: '2026-11-08T08:00:00Z' };
  try {
    const html = await fixture(), markdown = await readFile(join(root, 'plugins/benchgo/lib/preview/markdown.js'), 'utf8');
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 960 } }), errors = [], calls = [];
      page.setDefaultTimeout(7000); page.on('pageerror', error => errors.push(error.message));
      let saveFailures = 1;
      let config = { revision: 1, name: 'BenchGo', models: [{ providerId: 'Provider:Exact', modelId: 'Model:First/1' }], workerModels: [], auxiliary: { models: [], capabilities: [] }, image: { modelId: 'Image:Keep/1' } };
      await page.route('**/*', async route => {
        const url = route.request().url();
        if (url === 'http://localhost/') return route.fulfill({ contentType: 'text/html', body: html });
        if (url.endsWith('/api/benchgo/preview-assets/markdown.js')) return route.fulfill({ contentType: 'application/javascript', body: markdown });
        if (url.endsWith('/api/files/note.md')) return route.fulfill({ contentType: 'text/markdown; charset=utf-8', body: '# 清晰的文件预览\n\n只保留正文和必要操作。' });
        if (url.endsWith('/api/benchgo/vault')) return route.fulfill({ json: { entries: [] } });
        if (url.endsWith('/api/commander/assistant')) {
          const input = route.request().postDataJSON(); calls.push(input);
          if (input.action === 'catalog') return route.fulfill({ json: { providers: [{ id: 'Provider:Exact', name: '精确供应商', available: true }], models: [{ id: 'Model:First/1', name: '首个模型', provider: 'Provider:Exact' }, { id: 'Model:Second/2', name: '第二模型', provider: 'Provider:Exact' }] } });
          if (input.action === 'config') {
            if (saveFailures-- > 0) return route.fulfill({ status: 500, json: { error: '模型配置暂时无法保存，请重试。' } });
            config = { ...config, ...input.patch, revision: config.revision + 1 }; await page.evaluate(value => window.acceptConfig(value), config); return route.fulfill({ json: config });
          }
          if (input.action === 'state') return route.fulfill({ json: { config } });
          if (input.action === 'artifacts') {
            await new Promise(resolve => setTimeout(resolve, 120));
            const artifacts = [file, ...Array.from({ length: 30 }, (_, index) => ({ ...file, id: `report-${index}.md`, name: `report-${index}.md`, path: `report-${index}.md` }))];
            return route.fulfill({ json: { artifacts, total: artifacts.length, nextCursor: null } });
          }
          if (input.action === 'systemFiles') return route.fulfill({ json: { path: '', entries: [file] } });
          if (input.action === 'actionPermissions') return route.fulfill({ json: { grants: [], audit: [] } });
          return route.fulfill({ json: {} });
        }
        return route.abort();
      });
      await page.goto('http://localhost/');
      const choose = async name => {
        if (width > 760) {
          const nav = page.getByRole('navigation', { name: '资源分区', exact: true });
          if (name === '系统文件' && !(await nav.getByRole('button', { name: /^系统文件/ }).isVisible())) {
            await nav.getByRole('button', { name: /^高级/ }).focus(); await page.keyboard.press('Enter');
            assert.equal(await nav.getByRole('button', { name: /^高级/ }).getAttribute('aria-expanded'), 'true');
          }
          await nav.getByRole('button', { name: new RegExp(`^${name}`) }).click();
        }
        else { await page.getByRole('button', { name: '资源分区', exact: true }).click(); await page.getByRole('option', { name: new RegExp(` · ${name}(?: · 未保存)?$`) }).click(); }
      };
      const checkLayout = async name => {
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name}/${width} horizontal overflow`);
        if (screenshots) {
          for (const theme of ['light', 'dark']) {
            await page.evaluate(theme => { document.body.toggleAttribute('data-ds-dark-theme', theme === 'dark'); document.documentElement.style.colorScheme = theme; }, theme);
            await page.screenshot({ path: join(screenshots, `${name}-${theme}-${width}.png`), animations: 'disabled' });
          }
          await page.evaluate(() => { document.body.removeAttribute('data-ds-dark-theme'); document.documentElement.style.colorScheme = 'light'; });
        }
      };
      await page.getByRole('heading', { name: '身份', exact: true }).waitFor();
      assert.equal(await page.getByRole('tab', { name: '模型', exact: true }).count(), 0);
      await page.getByPlaceholder('未命名（可选）').fill('保留身份草稿');
      if (width > 760) {
        await page.getByRole('navigation', { name: '资源分区', exact: true }).getByRole('button', { name: /^身份/ }).focus();
        await page.keyboard.press('Tab');
        assert.match(await page.locator(':focus').innerText(), /^模型/);
        await page.keyboard.press('Enter');
      } else {
        await page.getByRole('button', { name: '资源分区', exact: true }).focus();
        await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
      }
      await page.getByRole('heading', { name: '模型', exact: true }).waitFor();
      const workerToggle = page.getByRole('button', { name: /工作模型 Worker/ });
      const auxiliaryToggle = page.getByRole('button', { name: /^辅助模型/ });
      assert.equal(await workerToggle.getAttribute('aria-expanded'), 'false');
      assert.equal(await auxiliaryToggle.getAttribute('aria-expanded'), 'false');
      assert.equal(await page.getByRole('button', { name: '保存更改', exact: true }).count(), 0, 'a clean page has no save bar');
      await checkLayout('models-default');
      await page.getByRole('button', { name: '模型', exact: true }).last().click();
      await page.getByRole('option', { name: '第二模型', exact: true }).click();
      await checkLayout('models-draft');
      await workerToggle.click();
      await page.getByRole('button', { name: '配置工作模型', exact: true }).click();
      await workerToggle.click();
      await page.getByRole('button', { name: /^(保存更改|重试保存)$/ }).click();
      const localError = page.locator('.ba-identity-error').filter({ hasText: /工作模型|Worker/ });
      await localError.waitFor();
      assert(await localError.evaluate(element => {
        const rect = element.querySelector('span:last-child').getBoundingClientRect();
        return element.contains(document.elementFromPoint((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2));
      }), 'local validation text must not be covered by the sticky save bar');
      assert.equal(calls.filter(call => call.action === 'config').length, 0, 'incomplete collapsed models must never reach the API');
      assert.equal(await workerToggle.getAttribute('aria-expanded'), 'true');
      const worker = page.getByRole('region', { name: '工作模型 Worker 配置', exact: true });
      await worker.getByRole('button', { name: '供应商', exact: true }).waitFor();
      await checkLayout('models-invalid');
      await worker.getByRole('button', { name: '移除模型', exact: true }).click();
      await page.getByRole('button', { name: '保存更改', exact: true }).click();
      const saveError = page.getByRole('alert').filter({ hasText: '模型配置暂时无法保存，请重试。' });
      await saveError.waitFor();
      assert(await saveError.evaluate(element => element === document.activeElement), 'save failure receives keyboard focus');
      assert(await saveError.evaluate(element => { const rect = element.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight; }), 'save failure must be visible without searching elsewhere');
      assert.equal(await page.getByRole('button', { name: '模型', exact: true }).last().innerText(), '第二模型');
      await checkLayout('models-save-error');
      await choose('保险库');
      await page.getByText('还没有凭据', { exact: true }).waitFor();
      assert.equal(await page.getByRole('heading', { name: '保险库', exact: true }).count(), 1);
      assert.equal(await page.getByRole('button', { name: '添加凭据', exact: true }).count(), 1);
      await checkLayout('vault');
      await choose('身份');
      assert.equal(await page.getByPlaceholder('未命名（可选）').inputValue(), '保留身份草稿');
      await choose('模型');
      assert.equal(await page.getByRole('button', { name: '模型', exact: true }).last().innerText(), '第二模型');
      await page.getByRole('button', { name: /^(保存更改|重试保存)$/ }).click();
      await page.getByText('已保存', { exact: true }).waitFor();
      const saved = calls.find(call => call.action === 'config');
      assert.deepEqual(saved.patch, { models: [{ providerId: 'Provider:Exact', modelId: 'Model:Second/2' }] });
      assert.equal(config.name, 'BenchGo'); assert.deepEqual(config.image, { modelId: 'Image:Keep/1' });
      assert.equal(calls.filter(call => call.action === 'config').length, 2);
      await choose('身份');
      assert.equal(await page.getByPlaceholder('未命名（可选）').inputValue(), '保留身份草稿');
      await choose('记忆');
      await page.getByLabel('有什么值得记住？', { exact: true }).fill('保留跨页记忆草稿');
      const scroll = await page.locator('.ba-studio-body').evaluate(element => { element.scrollTop = 420; return element.scrollTop; });
      assert(scroll > 200, 'memory fixture supplies real scrollable content');
      await choose('保险库');
      assert.equal(await page.locator('.ba-studio-body').evaluate(element => element.scrollTop), 0, 'new short page begins at its own top');
      await choose('记忆');
      await page.waitForFunction(scroll => Math.abs(document.querySelector('.ba-studio-body').scrollTop - scroll) < 3, scroll);
      assert.equal(await page.getByLabel('有什么值得记住？', { exact: true }).inputValue(), '保留跨页记忆草稿');
      await checkLayout('memory-restored');
      await choose('授权管理');
      await page.getByText('还没有站点许可', { exact: true }).waitFor();
      assert.equal(await page.getByRole('heading', { name: '授权管理', exact: true }).count(), 1);
      await checkLayout('permissions');
      for (const name of ['产物', '系统文件']) {
        await choose(name);
        await page.getByRole('button', { name: 'note.md', exact: true }).waitFor();
        assert.equal(await page.getByRole('heading', { name: name === '产物' ? '产物与工作区文件' : '系统文件', exact: true }).count(), 1);
        if (name === '产物') {
          await checkLayout('artifacts-default');
          const artifactScroll = await page.locator('.ba-studio-body').evaluate(element => { element.scrollTop = 520; return element.scrollTop; });
          await choose('授权管理'); await choose('产物');
          await page.getByRole('button', { name: 'note.md', exact: true }).waitFor();
          await page.waitForFunction(scroll => Math.abs(document.querySelector('.ba-studio-body').scrollTop - scroll) < 3, artifactScroll);
        }
        if (name === '系统文件') await page.getByRole('searchbox', { name: '筛选当前目录文件', exact: true }).fill('note');
        await checkLayout(name === '产物' ? 'artifacts' : 'system-files');
        await page.getByRole('button', { name: 'note.md', exact: true }).click();
        await page.frameLocator('iframe').getByRole('heading', { name: '清晰的文件预览', exact: true }).waitFor();
        assert.equal(await page.getByRole('dialog', { name: '预览 note.md', exact: true }).count(), 0, 'inline preview is a region, not a modal');
        assert.equal(await page.locator(':focus').innerText(), '← 返回');
        assert.equal(await page.locator('.ba-studio-heading').count(), 0);
        assert.equal(await page.getByRole('region', { name: '文件浏览工具' }).count(), 0);
        await checkLayout(name === '产物' ? 'artifact-preview' : 'system-preview');
        await page.getByRole('button', { name: '← 返回', exact: true }).click();
        await page.getByRole('button', { name: 'note.md', exact: true }).waitFor();
        assert.equal(await page.locator(':focus').innerText(), 'note.md');
        if (name === '系统文件') assert.equal(await page.getByRole('searchbox', { name: '筛选当前目录文件', exact: true }).inputValue(), 'note');
      }
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser.close(); }
});

test('Studio restores scroll after an asynchronously mounted long resource list', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const html = await fixture();
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    page.setDefaultTimeout(4000);
    await page.route('**/*', async route => {
      if (route.request().url() === 'http://localhost/') return route.fulfill({ contentType: 'text/html', body: html });
      if (route.request().url().endsWith('/api/benchgo/vault')) return route.fulfill({ json: { entries: [] } });
      if (route.request().url().endsWith('/api/commander/assistant')) {
        if (route.request().postDataJSON().action === 'artifacts') {
          await new Promise(resolve => setTimeout(resolve, 160));
          const artifacts = Array.from({ length: 40 }, (_, index) => ({ id: `report-${index}.md`, name: `report-${index}.md`, type: 'file', bytes: 64, updatedAt: '2026-11-08T08:00:00Z', url: '/api/files/note.md' }));
          return route.fulfill({ json: { artifacts, total: artifacts.length, nextCursor: null } });
        }
        return route.fulfill({ json: {} });
      }
      return route.abort();
    });
    await page.goto('http://localhost/');
    const nav = page.getByRole('navigation', { name: '资源分区', exact: true });
    await nav.getByRole('button', { name: '产物', exact: true }).click();
    await page.getByRole('button', { name: 'report-39.md', exact: true }).waitFor();
    const scroll = await page.locator('.ba-studio-body').evaluate(element => { element.scrollTop = 700; return element.scrollTop; });
    assert(scroll >= 700);
    await nav.getByRole('button', { name: '保险库', exact: true }).click();
    await page.getByText('还没有凭据', { exact: true }).waitFor();
    await nav.getByRole('button', { name: '产物', exact: true }).click();
    await page.getByRole('button', { name: 'report-39.md', exact: true }).waitFor();
    await page.waitForFunction(scroll => Math.abs(document.querySelector('.ba-studio-body').scrollTop - scroll) < 3, scroll, { timeout: 3000 });
    await page.close();
  } finally { await browser.close(); }
});
