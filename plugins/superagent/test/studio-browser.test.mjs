import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sharedUiStyles } from '../../base/scripts/shared-ui.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
// Reuse the pinned official ESM client when this worktree shares its built dependency tree.
const checkout = join(root, 'deepseek-harness');
const official = existsSync(join(checkout, 'packages/api/gateway/lib/client.node.js')) ? checkout : dirname(realpathSync(join(checkout, 'node_modules')));
const requireOfficial = createRequire(join(official, 'packages/api/gateway/package.json'));
const { chromium } = require('playwright');
const { build } = createRequire(new URL('../../base/package.json', import.meta.url))('esbuild');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || [chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);

async function fixture() {
  const bundle = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
    import {Studio} from './plugins/superagent/client/index.jsx';
    import {petDesignIntent} from './plugins/superagent/client/pet-state.mjs';
    import {assistantModelCatalog} from './plugins/base/client/model-catalog.mjs';
    import {installIconSprite} from './deepseek-harness/packages/client/ui-theme/src/client/icon-sprite.ts';
    import css from './plugins/superagent/client/style.css';import documentCss from './plugins/superagent/client/documents.css';import hostCss from './plugins/base/client/style.css';
    import tokens from './deepseek-harness/packages/client/ui-theme/src/styles/design-platform.css';import themeBase from './deepseek-harness/packages/client/ui-theme/src/styles/base.css';
    const initial={revision:1,name:'BenchGo',models:[{providerId:'Provider:Exact',modelId:'Model:First/1'}],workerModels:[],auxiliary:{models:[],capabilities:[]},image:{modelId:'Image:Keep/1'}};
    const memories=Array.from({length:30},(_,index)=>({id:'memory-'+index,content:'协作记录 '+(index+1)+'：保留简洁的操作路径与真实状态。',revision:1,document:'MEMORY.md',updatedAt:'2026-11-08T08:00:00Z'}));
    window.config=initial;
    window.designNavigation=[];
    document.addEventListener('benchgo:assistant-thread', event => { window.designNavigation.push({threadId:event.detail, intent:petDesignIntent.getSnapshot()}); });
    window.invalidateAssistantCatalog=assistantModelCatalog.invalidate;
    installIconSprite({effect:effect=>effect(),on(){}},undefined);
    function App(){
      const [snapshot,setSnapshot]=useState({config:initial,memories});
      const [requestedTab,setRequestedTab]=useState(location.hash.slice(1)||undefined);
      window.openResource=setRequestedTab;
      window.acceptConfig=config=>{window.config=config;setSnapshot({config,memories});};
      return <div className='ba-root'><style>{tokens}{themeBase}{hostCss}{css}{documentCss}</style><main className='ba-main'><Studio requestedTab={requestedTab} snapshot={snapshot} ctx={{layout:{selectPanel(){}}}} execute={operation=>operation()} refresh={async()=>window.acceptConfig(window.config)} threadId='main'/></main></div>;
    }
    createRoot(document.getElementById('root')).render(<App/>);
  ` }, bundle: true, write: false, outdir: join(root, 'artifacts', 'unused-studio-ui-test'), format: 'iife', jsx: 'automatic',
    nodePaths: [join(root, 'plugins/base/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
    alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')),
      '@deepseek-ai/dsh-util-workspace-path': join(root, 'deepseek-harness/packages/util/workspace-path/src/index.ts'),
      '@deepseek-ai/dsh-api-gateway/client': requireOfficial.resolve('@deepseek-ai/dsh-api-gateway/client') },
    loader: { '.css': 'text', '.module.css': 'local-css', '.svg': 'text', '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' }, plugins: [{ name: 'official-studio-primitives-source', setup(build) {
      // Use the pinned official components directly when workspace lib outputs are absent.
      build.onResolve({ filter: /^@deepseek-ai\/dsh-client-ui-primitives$/ }, () => ({ path: 'primitives', namespace: 'official-source' }));
      build.onLoad({ filter: /.*/, namespace: 'official-source' }, () => ({ loader: 'ts', resolveDir: root, contents: `
        export {Tooltip} from './deepseek-harness/packages/client/ui-primitives/src/Tooltip.tsx';
        export {Modal} from './deepseek-harness/packages/client/ui-primitives/src/Modal.tsx';
        export {Menu} from './deepseek-harness/packages/client/ui-primitives/src/Menu.tsx';
        export {Switch} from './deepseek-harness/packages/client/ui-primitives/src/Switch.tsx';
        export {MarkdownText} from './deepseek-harness/packages/client/ui-primitives/src/markdown/MarkdownText.tsx';
        export {writeClipboard} from './deepseek-harness/packages/client/ui-primitives/src/clipboard.ts';
        export * from './deepseek-harness/packages/client/ui-primitives/src/icons/index.tsx';
        export {LinkIconRegular} from './deepseek-harness/packages/client/ui-primitives/src/LinkIcon.tsx';
      ` }));
    } }, { name: 'studio-test-export', setup(build) {
      build.onLoad({ filter: /superagent[\\/]client[\\/]index\.jsx$/ }, async ({ path }) => ({ contents: `${await readFile(path, 'utf8')}\nexport { Studio };`, loader: 'jsx', resolveDir: dirname(path) }));
    } }, sharedUiStyles()], define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  const script = bundle.outputFiles.find(file => file.path.endsWith('.js')).text;
  const styles = bundle.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${styles}body{margin:0;font-family:var(--dsw-font-family,Arial,sans-serif);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}#root{height:100vh}.ba-root{min-width:0!important}</style></head><body><div id="root"></div><script>${script.replaceAll('</script', '<\\/script')}</script></body></html>`;
}

test('Studio preserves drafts and scroll, validates collapsed models, recovers saves and offers focused themed navigation', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const screenshots = process.env.BENCHGO_STUDIO_SCREENSHOTS;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  const file = { id: 'note.md', name: 'note.md', path: 'note.md', type: 'file', url: '/api/files/note.md', bytes: 64, hash: 'one', updatedAt: '2026-11-08T08:00:00Z' };
  try {
    const html = await fixture(), markdown = await readFile(join(root, 'plugins/base/lib/preview/markdown.js'), 'utf8');
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 960 }, hasTouch: width < 760 }), errors = [], calls = [];
      page.setDefaultTimeout(7000); page.on('pageerror', error => errors.push(error.message));
      let saveFailures = 1, toolCatalogReads = 0;
      let config = { revision: 1, name: 'BenchGo', models: [{ providerId: 'Provider:Exact', modelId: 'Model:First/1' }], workerModels: [], auxiliary: { models: [], capabilities: [] }, image: { modelId: 'Image:Keep/1' } };
      await page.route('**/*', async route => {
        const url = route.request().url();
        if (url === 'http://localhost/') return route.fulfill({ contentType: 'text/html', body: html });
        if (url.endsWith('/api/benchgo/preview-assets/markdown.js')) return route.fulfill({ contentType: 'application/javascript', body: markdown });
        if (url.endsWith('/api/files/note.md')) return route.fulfill({ contentType: 'text/markdown; charset=utf-8', body: '# 清晰的文件预览\n\n只保留正文和必要操作。' });
        if (url.endsWith('/api/benchgo/vault')) return route.fulfill({ json: { entries: [] } });
        if (url.endsWith('/api/commander/tooling')) {
          assert.deepEqual(route.request().postDataJSON(), { action: 'pickerCatalog' });
          if (++toolCatalogReads === 1) {
            await new Promise(resolve => setTimeout(resolve, 200));
            return route.fulfill({ status: 503, json: { error: '目录暂时不可用' } });
          }
          return route.fulfill({ json: { tools: [{ id: 'codex' }, { id: 'claude', routeReason: 'Claude Code 尚无 API 模型' }],
            providers: [{ id: 'Provider:API', name: '共享供应商' }],
            routes: [{ tool: 'codex', providerId: 'Provider:API', nativeModelId: 'Exact:Native/1', name: '共享模型', reasoning: { efforts: [{ id: 'high', name: 'High' }] } }] } });
        }
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
      assert.match(await workerToggle.innerText(), /跟随身份模型 Router/);
      assert.match(await auxiliaryToggle.innerText(), /跟随身份模型 Router/);
      assert.equal(await page.getByRole('button', { name: '保存更改', exact: true }).count(), 0, 'a clean page has no save bar');
      await checkLayout('models-default');
      const chooseModel = (scope = page) => scope.getByRole('button', { name: '选择工具与模型', exact: true });
      const dialog = page.getByRole('dialog', { name: '工具与模型' });
      const checkHarnessIcon = async (scope, tool) => {
        const icon = scope.locator(`.cmd-tool-brand[data-tool="${tool}"] img`);
        const color = { deepseek: [77, 107, 254], codex: [16, 163, 127], claude: [217, 119, 87] }[tool];
        for (const dark of [false, true, false]) {
          await page.evaluate(dark => document.body.toggleAttribute('data-ds-dark-theme', dark), dark);
          const actual = await icon.evaluate(async image => {
            await image.decode();
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 24;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(image, 0, 0, 24, 24);
            const pixels = ctx.getImageData(0, 0, 24, 24).data;
            const popup = image.closest('.dowork-select-popup');
            const background = popup && getComputedStyle(popup).backgroundColor;
            const panel = getComputedStyle(image.closest('.ba-model-dialog')).backgroundColor;
            for (let i = 0; i < pixels.length; i += 4) {
              if (pixels[i + 3] === 255) return { color: [...pixels.slice(i, i + 3)], background, panel, filter: getComputedStyle(image).filter };
            }
          });
          assert.deepEqual(actual.color, color);
          assert.equal(actual.filter, 'none');
          if (actual.background) assert.equal(actual.background, actual.panel);
        }
      };
      await chooseModel().last().click();
      await checkHarnessIcon(dialog.locator('.ba-model-harness'), 'deepseek');
      await dialog.getByRole('button', { name: '模型', exact: true }).click();
      await page.getByRole('option', { name: '第二模型', exact: true }).click();
      await dialog.getByRole('button', { name: '应用', exact: true }).click();
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
      await chooseModel(worker).waitFor();
      await checkLayout('models-invalid');
      await worker.getByRole('button', { name: '移除模型', exact: true }).click();
      await page.getByRole('button', { name: '保存更改', exact: true }).click();
      const saveError = page.getByRole('alert').filter({ hasText: '模型配置暂时无法保存，请重试。' });
      await saveError.waitFor();
      assert(await saveError.evaluate(element => element === document.activeElement), 'save failure receives keyboard focus');
      assert(await saveError.evaluate(element => { const rect = element.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight; }), 'save failure must be visible without searching elsewhere');
      assert.equal(await chooseModel().last().locator('strong').innerText(), '第二模型');
      await checkLayout('models-save-error');
      await choose('保险库');
      await page.getByText('还没有凭据', { exact: true }).waitFor();
      assert.equal(await page.getByRole('heading', { name: '保险库', exact: true }).count(), 1);
      assert.equal(await page.getByRole('button', { name: '添加凭据', exact: true }).count(), 1);
      await checkLayout('vault');
      await choose('身份');
      assert.equal(await page.getByPlaceholder('未命名（可选）').inputValue(), '保留身份草稿');
      await choose('模型');
      assert.equal(await chooseModel().last().locator('strong').innerText(), '第二模型');
      await page.getByRole('button', { name: /^(保存更改|重试保存)$/ }).click();
      await page.getByText('已保存', { exact: true }).waitFor();
      const saved = calls.find(call => call.action === 'config');
      assert.deepEqual(saved.patch, { models: [{ providerId: 'Provider:Exact', modelId: 'Model:Second/2' }] });
      assert.equal(config.name, 'BenchGo'); assert.deepEqual(config.image, { modelId: 'Image:Keep/1' });
      assert.equal(calls.filter(call => call.action === 'config').length, 2);
      const router = page.getByRole('region', { name: '身份模型 Router 配置', exact: true });
      assert.equal(await router.getByRole('button', { name: '执行 Harness', exact: true }).count(), 0);
      await router.getByRole('button', { name: '添加模型', exact: true }).click();
      const modelRows = router.locator('.ba-model-card');
      const backup = modelRows.nth(1);
      await chooseModel(backup).click();
      await dialog.getByRole('button', { name: '供应商', exact: true }).click();
      await page.getByRole('option', { name: '精确供应商', exact: true }).click();
      await dialog.getByRole('button', { name: '模型', exact: true }).click();
      await page.getByRole('option', { name: '首个模型', exact: true }).click();
      await dialog.getByRole('button', { name: '应用', exact: true }).click();
      assert.equal(await router.getByRole('button', { name: /完整 ID|提高优先级|降低优先级/ }).count(), 0);
      const handles = router.getByRole('button', { name: /^调整模型优先级/ });
      await checkLayout('models-sortable');
      await handles.nth(1).scrollIntoViewIfNeeded();
      const handle = await handles.nth(1).boundingBox(), first = await modelRows.first().boundingBox();
      const x = Math.round(handle.x + handle.width / 2), y = Math.round(handle.y + handle.height / 2);
      const targetY = Math.round(y + first.y - (await backup.boundingBox()).y - 4);
      const order = () => chooseModel(router).locator('strong').allTextContents();
      if (width > 760) {
        await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x, targetY, { steps: 5 });
        await router.locator('[data-dragging]').waitFor();
        assert.notEqual(await backup.evaluate(element => element.style.transform), '');
        assert.notEqual(await modelRows.first().evaluate(element => element.style.transform), '');
        await page.keyboard.press('Escape'); await page.mouse.up();
        assert.deepEqual(await order(), ['第二模型', '首个模型']);
        await router.evaluate(element => Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished)));
        await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x, targetY, { steps: 5 }); await page.mouse.up();
      } else {
        await page.emulateMedia({ reducedMotion: 'reduce' });
        const touch = await page.context().newCDPSession(page);
        try {
          await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
          await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: targetY }] });
          await router.locator('[data-dragging]').waitFor();
          await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        } finally { await touch.detach(); }
      }
      assert.deepEqual(await order(), ['首个模型', '第二模型']);
      assert.equal(await router.locator('[data-dragging]').count(), 0);
      await handles.first().press('ArrowDown');
      assert.deepEqual(await order(), ['第二模型', '首个模型']);
      assert.equal(await handles.nth(1).evaluate(element => element === document.activeElement), true);
      await handles.nth(1).press('ArrowUp');
      await page.getByRole('button', { name: '保存更改', exact: true }).click();
      await page.getByText('已保存', { exact: true }).waitFor();
      assert.deepEqual(calls.filter(call => call.action === 'config').at(-1).patch, { models: [
        { providerId: 'Provider:Exact', modelId: 'Model:First/1' }, { providerId: 'Provider:Exact', modelId: 'Model:Second/2' },
      ] });
      await choose('保险库'); await choose('模型');
      assert.deepEqual(await order(), ['首个模型', '第二模型']);
      if (await workerToggle.getAttribute('aria-expanded') === 'false') await workerToggle.click();
      await worker.getByRole('button', { name: '配置工作模型', exact: true }).click();
      await chooseModel(worker).click();
      assert.equal(await dialog.getByRole('button', { name: '执行 Harness', exact: true }).innerText(), 'DeepSeek Harness');
      const selectHarness = async name => {
        await dialog.getByRole('button', { name: '执行 Harness', exact: true }).click();
        await page.getByRole('option', { name, exact: true }).click();
      };
      await dialog.getByRole('button', { name: '执行 Harness', exact: true }).click();
      await checkHarnessIcon(dialog.getByRole('option', { name: 'DeepSeek Harness', exact: true }), 'deepseek');
      await checkHarnessIcon(dialog.getByRole('option', { name: 'Codex', exact: true }), 'codex');
      await checkHarnessIcon(dialog.getByRole('option', { name: 'Claude Code', exact: true }), 'claude');
      await checkLayout('worker-harness-options');
      await page.keyboard.press('Escape');
      await selectHarness('Codex');
      await checkHarnessIcon(dialog.getByRole('button', { name: '执行 Harness', exact: true }), 'codex');
      await dialog.getByText('正在读取模型目录').waitFor();
      await dialog.getByRole('alert').filter({ hasText: '目录暂时不可用' }).waitFor();
      await checkLayout('worker-catalog-error');
      await dialog.getByRole('button', { name: '重试', exact: true }).click();
      await selectHarness('Claude Code');
      await dialog.getByText('Claude Code 尚无 API 模型', { exact: true }).waitFor();
      await checkLayout('worker-catalog-empty');
      await selectHarness('Codex');
      await dialog.getByRole('button', { name: '供应商', exact: true }).click();
      await page.getByRole('option', { name: '共享供应商', exact: true }).click();
      await dialog.getByRole('button', { name: '模型', exact: true }).click();
      await page.getByRole('option', { name: '共享模型', exact: true }).click();
      const highEffort = dialog.getByRole('radio', { name: '高', exact: true });
      await highEffort.click();
      await checkLayout('worker-catalog-ready');
      await dialog.getByRole('button', { name: '应用', exact: true }).click();
      await page.getByRole('button', { name: '保存更改', exact: true }).click();
      await page.getByText('已保存', { exact: true }).waitFor();
      assert.deepEqual(calls.filter(call => call.action === 'config').at(-1).patch, {
        workerHarness: 'codex', workerModels: [{ providerId: 'Provider:API', modelId: 'Exact:Native/1', options: { reasoningEffort: 'high' } }],
      });
      await chooseModel(worker).click();
      assert.equal(await highEffort.getAttribute('aria-checked'), 'true');
      await dialog.getByRole('button', { name: '取消', exact: true }).click();
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
      for (const name of ['产物', '系统文件']) {
        await choose(name);
        await page.getByRole('button', { name: 'note.md', exact: true }).waitFor();
        assert.equal(await page.getByRole('heading', { name: name === '产物' ? '产物与工作区文件' : '系统文件', exact: true }).count(), 1);
        if (name === '产物') {
          await checkLayout('artifacts-default');
          const artifactScroll = await page.locator('.ba-studio-body').evaluate(element => { element.scrollTop = 520; return element.scrollTop; });
          await choose('身份'); await choose('产物');
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

test('identity page shows a single responsive editor and preserves the identity draft while applying an appearance', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const screenshots = process.env.BENCHGO_STUDIO_SCREENSHOTS;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  try {
    const html = await fixture();
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      let config = { revision: 1, name: '', pet: null, cardHtml: '<b>旧侧栏名片</b>' }, draft = null, reads = 0, exportFails = true;
      const archive = Buffer.from('UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==', 'base64');
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jNV0AAAAASUVORK5CYII=', 'base64');
      const custom = { kind: 'custom', assetId: '12345678-1234-1234-1234-123456789012.png', expressions: {}, appearance: { name: '单张图片形象' } };
      const pack = { kind: 'builtin', assetId: 'builtin', expression: 'standard', palette: 'default', decorations: [], appearance: { version: 1, name: '旅行形象', bindings: { focus: 'happy' } } };
      await page.route('**/*', async route => {
        if (route.request().url() === 'http://localhost/') return route.fulfill({ contentType: 'text/html', body: html });
        if (route.request().url().includes('/api/commander/assistant/pet-asset?')) return route.fulfill({ contentType: 'image/png', body: png });
        if (!route.request().url().endsWith('/api/commander/assistant')) return route.abort();
        const input = route.request().postDataJSON();
        if (input.action === 'petCatalog') {
          if (++reads === 1) {
            await new Promise(resolve => setTimeout(resolve, 500));
            return route.fulfill({ status: 503, json: { error: '测试目录暂不可用' } });
          }
          return route.fulfill({ json: { expressions: [], palettes: [{ id: 'default', label: '默认配色' }], decorations: [], draft } });
        }
        if (input.action === 'petUploadPackage') {
          if (input.base64 === 'YmFk') return route.fulfill({ status: 400, json: { error: '形象包格式无效' } });
          draft = { draftId: 'verified-draft', pet: pack, ...(input.base64 === 'YWk=' ? { source: 'ai' } : {}) };
          return route.fulfill({ json: draft });
        }
        if (input.action === 'petExportPackage') {
          assert.deepEqual(input, { action: 'petExportPackage' });
          assert.equal(draft.draftId, 'verified-draft');
          assert.equal(config.pet, null);
          if (exportFails) { exportFails = false; return route.fulfill({ status: 503, json: { error: '形象包暂时无法导出' } }); }
          return route.fulfill({ json: { filename: '当前形象.zip', base64: archive.toString('base64') } });
        }
        if (input.action === 'petUpload') {
          assert.equal(input.dataUrl, `data:image/png;base64,${png.toString('base64')}`);
          assert.equal(input.expression, config.pet?.kind === 'custom' ? 'wink' : undefined);
          draft = { draftId: 'image-draft', pet: custom };
          return route.fulfill({ json: draft });
        }
        if (input.action === 'petApply') {
          assert.equal(input.draftId, draft.draftId);
          config = { ...config, pet: draft.pet, revision: config.revision + 1 }; draft = null;
          await page.evaluate(value => window.acceptConfig(value), config);
          return route.fulfill({ json: config });
        }
        if (input.action === 'petDiscard') { assert.equal(input.draftId, draft.draftId); draft = null; return route.fulfill({ json: {} }); }
        if (input.action === 'config') {
          assert.deepEqual(input.patch, { name: '未保存的名字' });
          if (input.revision !== config.revision) return route.fulfill({ status: 409, json: { error: '配置已更新' } });
          config = { ...config, ...input.patch, revision: config.revision + 1 };
          await page.evaluate(value => window.acceptConfig(value), config);
          return route.fulfill({ json: config });
        }
        if (input.action === 'state') return route.fulfill({ json: { config } });
        return route.fulfill({ json: {} });
      });
      await page.goto('http://localhost/');
      const saveScreenshot = async state => { if (screenshots) await page.screenshot({ path: join(screenshots, `identity-${width}-${state}.png`) }); };
      await page.evaluate(value => window.acceptConfig(value), config);
      const tabs = page.getByRole('tablist', { name: '形象资产分类' });
      const ai = page.getByRole('button', { name: '生成', exact: true });
      assert.match(await ai.locator('use').getAttribute('href'), /sparkle/);
      const importButton = page.getByRole('button', { name: '导入', exact: true });
      const exportButton = page.getByRole('button', { name: '导出', exact: true });
      const library = tabs.getByRole('tab', { name: '素材库' });
      const actions = tabs.getByRole('tab', { name: '工作动作' });
      const panel = page.locator('.ba-pet-asset-panel');
      const orientation = width > 760 ? 'vertical' : 'horizontal';
      const bell = page.getByRole('button', { name: '回复提示音' });
      assert.equal(await bell.getAttribute('aria-pressed'), 'true');
      assert(await bell.evaluate(button => button.parentElement.contains(button.closest('.ba-studio-heading-row')?.querySelector('h1'))));
      await bell.press('Enter');
      assert.equal(await bell.getAttribute('aria-pressed'), 'false');
      await bell.press('Space');
      assert.equal(await bell.getAttribute('aria-pressed'), 'true');
      assert.equal(await tabs.getAttribute('aria-orientation'), orientation);
      assert.equal(await tabs.getByRole('tab').count(), 2);
      assert.equal(await library.getAttribute('aria-selected'), 'true');
      await page.getByText('正在读取形象资产', { exact: true }).waitFor();
      await saveScreenshot('loading');
      await page.getByText('测试目录暂不可用').waitFor(); await saveScreenshot('error');
      await library.focus(); await library.press(width > 760 ? 'ArrowDown' : 'ArrowRight');
      assert.equal(await actions.getAttribute('aria-selected'), 'true');
      assert.equal(await actions.evaluate(element => element === document.activeElement), true);
      await actions.press('Home'); assert.equal(await library.getAttribute('aria-selected'), 'true');
      await ai.click();
      await page.waitForFunction(() => window.designNavigation.some(({threadId, intent}) => threadId === 'main' && intent?.kind === 'design'));
      await page.getByRole('button', { name: '重试', exact: true }).click();
      await page.getByText('暂无素材').waitFor(); await saveScreenshot('empty');
      await page.getByRole('tab', { name: '配色' }).click();
      await page.getByRole('button', { name: '默认配色' }).waitFor();
      await saveScreenshot('light-library');
      await actions.click(); await library.click();
      assert.equal(await page.getByRole('tab', { name: '配色' }).getAttribute('aria-selected'), 'true');
      await page.getByRole('tab', { name: '表情' }).click();
      await page.getByRole('button', { name: '前往导入' }).click();
      const zipOption = page.getByRole('menuitem', { name: '选择 ZIP 形象包' });
      await zipOption.waitFor();
      await page.waitForFunction(() => document.activeElement?.textContent === '选择 ZIP 形象包');
      await page.keyboard.press('Escape');
      assert.equal(await importButton.evaluate(element => element === document.activeElement), true);
      const name = page.getByRole('textbox', { name: '名字' });
      await name.fill('未保存的名字');
      assert.equal(await page.getByRole('switch', { name: '形象动效' }).count(), 0);
      assert.equal(await page.getByText('侧栏名片').count(), 0);
      assert.equal(await page.locator('iframe[srcdoc]').count(), 0);
      async function chooseZip(name, buffer) {
        await importButton.press('ArrowDown');
        const pendingChooser = page.waitForEvent('filechooser');
        await zipOption.click();
        await (await pendingChooser).setFiles({ name, mimeType: 'application/zip', buffer });
      }
      await chooseZip('bad.zip', Buffer.from('bad'));
      await page.getByText('形象包格式无效').waitFor();
      await chooseZip('valid.zip', Buffer.from('valid'));
      await page.getByRole('button', { name: '取消预览' }).waitFor();
      await exportButton.click();
      await page.getByRole('alert').filter({ hasText: '形象包暂时无法导出' }).waitFor();
      const pendingDownload = page.waitForEvent('download');
      await exportButton.click();
      const download = await pendingDownload;
      assert.equal(download.suggestedFilename(), '当前形象.zip');
      assert.deepEqual(await readFile(await download.path()), archive);
      await page.getByRole('status').filter({ hasText: '已开始下载形象包' }).waitFor();
      assert.equal(await name.inputValue(), '未保存的名字');
      await page.getByRole('button', { name: '取消预览' }).click();
      await page.getByRole('button', { name: '取消预览' }).waitFor({ state: 'hidden' });
      await chooseZip('ai.zip', Buffer.from('ai'));
      await page.getByRole('button', { name: '取消预览' }).waitFor();
      await ai.click();
      await page.waitForFunction(() => window.designNavigation.some(({threadId, intent}) => threadId === 'main' && intent?.kind === 'refine'));
      assert.equal(await name.inputValue(), '未保存的名字');
      await page.getByRole('button', { name: '取消预览' }).click();
      await page.getByRole('button', { name: '取消预览' }).waitFor({ state: 'hidden' });
      await chooseZip('valid.zip', Buffer.from('valid'));
      await library.click();
      await page.getByRole('button', { name: '应用形象' }).click();
      await page.getByText('旅行形象', { exact: true }).waitFor();
      assert.equal(await name.inputValue(), '未保存的名字');
      assert.equal(await page.getByRole('tablist', { name: '身份分类' }).count(), 0);
      await actions.click();
      assert.equal(await page.getByRole('button', { name: '专注', exact: true }).textContent(), '轻跃');
      assert.equal(await panel.getAttribute('aria-labelledby'), await actions.getAttribute('id'));
      const [tabRect, panelRect] = await Promise.all([tabs.boundingBox(), panel.boundingBox()]);
      assert(width > 760 ? tabRect.x + tabRect.width < panelRect.x : tabRect.y + tabRect.height < panelRect.y);
      const rect = await page.locator('.ba-pet-identity-grid').evaluate(element => [...element.children].map(child => child.getBoundingClientRect().toJSON()));
      assert.equal(width > 760 ? rect[0].top === rect[1].top : rect[0].bottom <= rect[1].top, true);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.evaluate(() => { document.body.setAttribute('data-ds-dark-theme', ''); document.documentElement.style.colorScheme = 'dark'; });
      await saveScreenshot('data');
      await page.getByRole('button', { name: '保存更改' }).click();
      await page.getByText('已保存', { exact: true }).waitFor();
      assert.equal(await name.inputValue(), '未保存的名字');
      const chooseImage = async option => {
        const pendingChooser = page.waitForEvent('filechooser');
        await page.getByRole('menuitem', { name: option, exact: true }).click();
        await (await pendingChooser).setFiles({ name: 'pet.png', mimeType: 'image/png', buffer: png });
      };
      await importButton.click();
      await chooseImage('上传单张图片');
      await page.getByRole('button', { name: '应用形象' }).click();
      await page.getByText('单张图片形象', { exact: true }).waitFor();
      await importButton.click();
      await page.getByRole('menuitem', { name: '上传表情图' }).press('ArrowRight');
      await chooseImage('眨眼');
      await page.getByRole('button', { name: '取消预览' }).click();
      await page.getByRole('button', { name: '取消预览' }).waitFor({ state: 'hidden' });
      assert.equal(await name.inputValue(), '未保存的名字');
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser.close(); }
});

test('model settings keep controls aligned through loading, errors and data, with a clear empty state', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const screenshots = process.env.BENCHGO_STUDIO_SCREENSHOTS;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  try {
    const html = await fixture();
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 960 } });
      page.setDefaultTimeout(7000);
      let releaseCatalog, attempts = 0, connected = true, reasoningAvailable = true, savedConfig;
      const pending = new Promise(resolve => { releaseCatalog = resolve; });
      await page.route('**/*', async route => {
        if (route.request().url() === 'http://localhost/') return route.fulfill({ contentType: 'text/html', body: html });
        if (route.request().url().endsWith('/api/commander/assistant')) {
          const input = route.request().postDataJSON();
          if (input.action === 'catalog') {
            if (++attempts === 1) { await pending; return route.fulfill({ status: 503, json: { error: '供应商暂时无法连接' } }); }
            return route.fulfill({ json: {
              providers: [{ id: 'deepseek-account', name: 'DeepSeek Account', available: true }, { id: 'unreachable', name: '连接失败的供应商', available: false },
                ...(connected ? [{ id: 'Provider:Exact', name: '精确供应商', available: true }] : [])],
              models: connected ? [
                { id: 'Model:First/1', name: '首个模型', provider: 'Provider:Exact', ...(reasoningAvailable ? { reasoning: {
                  efforts: ['low', 'medium', 'high'].map(id => ({ id, name: id })), defaultEffort: 'low',
                } } : { reasoningUnavailable: true }) },
                { id: 'Model:Plain/2', name: '无档位模型', provider: 'Provider:Exact' },
              ] : [],
            } });
          }
          if (input.action === 'config') {
            savedConfig = { ...savedConfig, ...input.patch, revision: savedConfig.revision + 1 };
            return route.fulfill({ json: savedConfig });
          }
          if (input.action === 'state') return route.fulfill({ json: { config: savedConfig } });
          return route.fulfill({ json: {} });
        }
        return route.abort();
      });
      await page.goto('http://localhost/');
      if (width > 760) await page.getByRole('navigation', { name: '资源分区', exact: true }).getByRole('button', { name: '模型', exact: true }).click();
      else { await page.getByRole('button', { name: '资源分区', exact: true }).click(); await page.getByRole('option', { name: / · 模型$/ }).click(); }
      const trigger = (scope = page) => scope.getByRole('button', { name: '选择工具与模型', exact: true });
      const dialog = page.getByRole('dialog', { name: '工具与模型' });
      const field = name => dialog.getByRole('button', { name, exact: true });
      const efforts = dialog.getByRole('radiogroup', { name: '推理强度' });
      const effort = name => efforts.getByRole('radio', { name, exact: true });
      await trigger().first().click();
      const check = async state => {
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${state}/${width} must fit the viewport`);
        const row = page.locator('.ba-model-card').first();
        if (await row.count()) {
          const geometry = await row.evaluate(element => {
            const rect = selector => { const bounds = element.querySelector(selector).getBoundingClientRect(); return { y: bounds.y, bottom: bounds.bottom, center: bounds.y + bounds.height / 2, height: bounds.height }; };
            return { wide: element.closest('.ba-model-settings').clientWidth > 660, model: rect('.ba-model-select-trigger'), priority: rect('.ba-model-priority'), actions: rect('.ba-row-actions'), buttons: [...element.querySelectorAll('.ba-row-actions button')].map(button => button.getBoundingClientRect().height) };
          });
          assert(Math.abs(geometry.priority.center - geometry.actions.center) < 1, `${state}/${width}: priority and actions must align`);
          if (geometry.wide) assert(Math.abs(geometry.model.center - geometry.actions.center) < 1, `${state}/${width}: actions must align with controls, excluding labels and feedback`);
          else { assert(geometry.actions.bottom <= geometry.model.y, 'compact rows put actions above the selector'); assert(geometry.buttons.every(height => height >= 44), 'all mobile actions retain their touch target, including disabled buttons'); }
        }
        if (screenshots) {
          for (const theme of ['light', 'dark']) {
            await page.evaluate(theme => { document.body.toggleAttribute('data-ds-dark-theme', theme === 'dark'); document.documentElement.style.colorScheme = theme; }, theme);
            await page.screenshot({ path: join(screenshots, `model-layout-${state}-${theme}-${width}.png`), animations: 'disabled' });
          }
        }
      };
      await page.getByRole('status', { name: '正在读取模型目录', exact: true }).waitFor();
      await check('loading');
      releaseCatalog();
      await page.getByRole('alert').filter({ hasText: '供应商暂时无法连接' }).waitFor();
      await check('error');
      await page.getByRole('button', { name: '重试', exact: true }).click();
      await field('供应商').filter({ hasText: '精确供应商' }).waitFor();
      await check('data');
      await field('供应商').click();
      await page.getByRole('option', { name: '精确供应商', exact: true }).waitFor();
      await page.getByRole('combobox', { name: '搜索供应商' }).fill('精确供应商');
      const firstSupplier = page.getByRole('option').first();
      assert.match(await firstSupplier.innerText(), /RouterGo.*检查模型设置/s);
      assert.equal(await firstSupplier.getAttribute('aria-disabled'), 'true');
      assert.equal(await firstSupplier.locator('[data-provider-brand=routergo] img').count(), 1);
      assert.equal(await page.getByRole('option', { name: 'DeepSeek Account' }).count(), 0);
      assert.equal(await page.getByRole('option', { name: '连接失败的供应商' }).count(), 0);
      await page.keyboard.press('Escape');
      assert(await dialog.isVisible());
      await field('取消').click();
      assert.equal(await trigger().first().evaluate(element => element === document.activeElement), true);
      const baseModel = { providerId: 'Provider:Exact', modelId: 'Model:First/1' };
      savedConfig = { ...await page.evaluate(() => window.config),
        models: [{ ...baseModel, options: { maxTokens: 123, reasoningEffort: 'off' } }],
        workerModels: [baseModel], auxiliary: { models: [baseModel], capabilities: ['review'] },
      };
      await page.evaluate(config => window.acceptConfig(config), savedConfig);
      await page.getByRole('button', { name: /工作模型 Worker/ }).click();
      await page.getByRole('button', { name: /^辅助模型/ }).click();
      const router = page.getByRole('region', { name: '身份模型 Router 配置' });
      const worker = page.getByRole('region', { name: '工作模型 Worker 配置' });
      const auxiliary = page.getByRole('region', { name: '辅助模型配置' });
      for (const [section, label] of [[router, '高'], [worker, '中'], [auxiliary, '低']]) {
        await trigger(section).click();
        if (section === router) assert.match(await dialog.getByRole('alert').innerText(), /原档位已不可用/);
        assert.equal(await field('关闭').count(), 1, 'only the dialog close button uses this label');
        await effort(label).click();
        if (section === worker) await check('efforts');
        await field('应用').click();
      }
      await page.getByRole('button', { name: '保存更改', exact: true }).click();
      await page.getByText('已保存', { exact: true }).waitFor();
      assert.deepEqual(savedConfig.models, [{ ...baseModel, options: { maxTokens: 123, reasoningEffort: 'high' } }]);
      assert.deepEqual(savedConfig.workerModels, [{ ...baseModel, options: { reasoningEffort: 'medium' } }]);
      assert.deepEqual(savedConfig.auxiliary, { models: [{ ...baseModel, options: { reasoningEffort: 'low' } }], capabilities: ['review'] });
      await page.evaluate(config => window.acceptConfig(config), savedConfig);
      for (const [section, label] of [[router, '高'], [worker, '中'], [auxiliary, '低']]) {
        await trigger(section).click();
        assert.equal(await effort(label).getAttribute('aria-checked'), 'true');
        await field('取消').click();
      }
      await trigger(worker).click();
      reasoningAvailable = false;
      await page.evaluate(() => window.invalidateAssistantCatalog());
      await dialog.getByRole('alert').filter({ hasText: '暂时无法读取推理档位' }).waitFor();
      assert.equal(await efforts.count(), 0);
      assert.equal(await field('恢复默认').count(), 0);
      reasoningAvailable = true;
      await field('重试').click();
      await effort('中').waitFor();
      assert.equal(await effort('中').getAttribute('aria-checked'), 'true');
      await effort('中').press('Home');
      assert.equal(await effort('默认').getAttribute('aria-checked'), 'true');
      await field('取消').click();
      assert.equal(await page.getByRole('button', { name: '取消修改', exact: true }).count(), 0);
      await trigger(worker).click();
      assert.equal(await effort('中').getAttribute('aria-checked'), 'true');
      await effort('中').press('Home');
      await field('应用').click();
      await trigger(router).click();
      await field('模型').click();
      await page.getByRole('option', { name: '无档位模型', exact: true }).click();
      assert.equal(await efforts.count(), 0);
      await dialog.getByRole('status').filter({ hasText: '模型目录未提供此模型的推理档位' }).waitFor();
      await field('应用').click();
      await page.getByRole('button', { name: '保存更改', exact: true }).click();
      await page.getByText('已保存', { exact: true }).waitFor();
      assert.deepEqual(savedConfig.models, [{ ...baseModel, modelId: 'Model:Plain/2', options: { maxTokens: 123 } }]);
      assert.deepEqual(savedConfig.workerModels, [baseModel]);
      await page.evaluate(config => window.acceptConfig(config), { ...savedConfig, models: [baseModel], workerModels: [], auxiliary: null });
      connected = false;
      await page.evaluate(() => window.invalidateAssistantCatalog());
      await trigger(router).click();
      await field('供应商').filter({ hasText: 'Provider:Exact · 不可用' }).waitFor();
      assert.equal(await field('模型').isDisabled(), true);
      await field('取消').click();
      await router.getByRole('button', { name: '移除模型', exact: true }).click();
      await page.getByText('为助手选择一个模型', { exact: true }).waitFor();
      await check('empty');
      await page.close();
    }
  } finally { await browser.close(); }
});

test('board document shortcuts open exact files and protect retained drafts across navigation', { skip: !executablePath && 'Chromium/Edge is required' }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const html = await fixture();
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 960 } }), errors = [], calls = [];
      page.setDefaultTimeout(5000); page.on('pageerror', error => errors.push(error.message));
      const documents = ['USER.md', 'SOUL.md', 'IDENTITY.md'].map(name => ({ name, content: `${name} 原始正文`, hash: `${name}:1` }));
      await page.route('**/*', async route => {
        if (route.request().url() === 'http://localhost/') return route.fulfill({ contentType: 'text/html', body: html });
        if (route.request().url().endsWith('/api/commander/assistant')) {
          const input = route.request().postDataJSON(); calls.push(input);
          if (input.action === 'profileDocuments') {
            if (input.op === 'list') return route.fulfill({ json: { documents } });
            const document = documents.find(row => row.name === input.name);
            assert.equal(input.expectedHash, document.hash);
            Object.assign(document, { content: input.content, hash: `${input.name}:2` });
            return route.fulfill({ json: { document } });
          }
          return route.fulfill({ json: {} });
        }
        return route.abort();
      });
      await page.goto('http://localhost/#soul');
      const soul = page.getByRole('textbox', { name: 'SOUL.md 正文', exact: true });
      await soul.waitFor();
      assert.equal(await page.locator('.ba-studio-body').getAttribute('data-section'), 'documents');
      assert.equal(await soul.inputValue(), 'SOUL.md 原始正文');
      await soul.fill('保留 SO 草稿');
      await page.evaluate(() => window.openResource('memory'));
      await page.getByLabel('有什么值得记住？', { exact: true }).waitFor();
      await page.evaluate(() => window.openResource('soul'));
      await soul.waitFor();
      assert.equal(await soul.inputValue(), '保留 SO 草稿');
      assert.equal(await page.getByRole('dialog').count(), 0, 'returning to the same file keeps its draft without prompting');
      await page.evaluate(() => window.openResource('identity-document'));
      const confirmation = page.getByRole('dialog', { name: '切换档案？', exact: true });
      await confirmation.getByRole('button', { name: '继续编辑', exact: true }).click();
      assert.equal(await soul.inputValue(), '保留 SO 草稿', 'cancelled navigation retains the draft');
      assert.equal(calls.filter(call => call.op === 'update').length, 0, 'navigation never saves or discards by itself');
      await page.evaluate(() => window.openResource('memory'));
      await page.getByLabel('有什么值得记住？', { exact: true }).waitFor();
      await page.evaluate(() => window.openResource('identity-document'));
      await confirmation.getByRole('button', { name: '放弃并切换', exact: true }).click();
      const identity = page.getByRole('textbox', { name: 'IDENTITY.md 正文', exact: true });
      await identity.waitFor();
      assert.equal(await identity.inputValue(), 'IDENTITY.md 原始正文');
      await identity.fill('更新 Identity 正文');
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await page.getByText('已保存，下次请求生效', { exact: true }).waitFor();
      assert.deepEqual(calls.filter(call => call.op === 'update').map(({ name, content, expectedHash }) => ({ name, content, expectedHash })), [{ name: 'IDENTITY.md', content: '更新 Identity 正文', expectedHash: 'IDENTITY.md:1' }]);
      await page.evaluate(() => window.openResource('soul')); await soul.waitFor();
      await page.evaluate(() => window.openResource('identity-document')); await identity.waitFor();
      assert.equal(await identity.inputValue(), '更新 Identity 正文', 'the exact saved file reloads through its shortcut');
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'document navigation fits the viewport');
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
