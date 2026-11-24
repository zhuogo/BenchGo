import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sharedUiStyles } from '../scripts/shared-ui.mjs';
import { shellUi } from '../scripts/shell-ui.mjs';
import { TOOL_CATALOG } from '../src/tool-catalog.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
const { chromium } = require('playwright');
const { build } = createRequire(import.meta.url)('esbuild');
const executablePath = [process.env.CHROMIUM_EXECUTABLE_PATH, chromium.executablePath(),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(path => path && existsSync(path));

async function settingsFixture() {
  const bundle = await build({
    stdin: { resolveDir: root, loader: 'jsx', contents: `
      import React, {useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import {ToolSettingsSection, mountToolSettingsStyle} from './plugins/base/client/tool-settings.jsx';
      import {SettingsRoot} from './deepseek-harness/packages/client/ui-settings-general/src/client/SettingsRoot.tsx';
      import {GeneralSection} from './deepseek-harness/packages/client/ui-settings-general/src/client/GeneralSection.tsx';
      import {DeveloperToolsRow} from './deepseek-harness/packages/client/ui-settings-general/src/client/DeveloperToolsRow.tsx';
      import {zh} from './deepseek-harness/packages/client/ui-settings-general/src/client/locales.ts';
      import {installThemeStyles} from './deepseek-harness/packages/client/ui-theme/src/client/styles.ts';
      import {installIconSprite} from './deepseek-harness/packages/client/ui-theme/src/client/icon-sprite.ts';
      import hostCss from './plugins/base/client/style.css';
      import mobileCss from './plugins/base/client/mobile-workbench.css';

      const ctx = {effect: run => run(), on() {}};
      installThemeStyles(ctx);
      installIconSprite(ctx);
      mountToolSettingsStyle(ctx);
      document.body.toggleAttribute('data-ds-dark-theme', matchMedia('(prefers-color-scheme: dark)').matches);
      const t = key => zh[key] || key;
      const rows = [
        {id:'general', label:t('general.nav')}, {id:'models', label:'模型'},
        {id:'harness-tools', label:'Harness 工具'}, {id:'plugins', label:'插件'},
      ];
      function App() {
        const [open, setOpen] = useState(false);
        const [activeId, select] = useState('general');
        const actions = {close: () => setOpen(false), open: () => setOpen(true), openSection: id => { select(id); setOpen(true); }, select};
        const renderSlot = (name, props, filter) => {
          if (name === 'settings.header') return t('title');
          if (name === 'settings.close') return t('close');
          if (name === 'settings.trigger') return t('trigger');
          if (name === 'settings.general.item') return <DeveloperToolsRow useDeveloperTools={select => select(false)} setEnabled={async () => {}} t={t}/>;
          if (name === 'settings.section' && filter.only === 'general') return <GeneralSection renderSlot={renderSlot}/>;
          if (name === 'settings.section' && filter.only === 'harness-tools') return <ToolSettingsSection ctx={ctx}/>;
          return filter?.fallback ?? null;
        };
        const renderFactorySlot = (name, {id}) => name === 'settings.section.view' ? renderSlot('settings.section', {}, {only:id}) : null;
        return <><style>{hostCss}{mobileCss}</style><main><h1>BenchGo</h1><SettingsRoot wide
          renderSlot={renderSlot} renderFactorySlot={renderFactorySlot} t={t} reconnect={() => {}}
          useStore={read => read({open, activeId})} actions={actions} useSections={read => read(rows)}
          useConnectionState={read => read('connected')} useOnboardingSteps={read => read([])}
          useSessions={read => read({phase:'ready', byId:{main:{retainedBy:{mainView:1}, blank:false}}})}
          useShortcuts={read => read([])}/></main></>;
      }
      createRoot(document.getElementById('root')).render(<App/>);
    ` },
    bundle: true, write: false, format: 'iife', jsx: 'automatic',
    outdir: join(root, 'artifacts/unused-tool-settings-test'),
    nodePaths: [join(root, 'plugins/base/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
    alias: {
      react: dirname(require.resolve('react/package.json')),
      'react-dom': dirname(require.resolve('react-dom/package.json')),
      '@deepseek-ai/dsh-client-ui-primitives': join(root, 'deepseek-harness/packages/client/ui-primitives/src/index.ts'),
    },
    plugins: [{
      name: 'official-inline-theme',
      setup(build) {
        build.onResolve({ filter: /\.css\?inline$/ }, ({ path, resolveDir }) => ({
          path: resolve(resolveDir, path.slice(0, -'?inline'.length)),
        }));
      },
    }, shellUi(), sharedUiStyles()],
    loader: { '.css': 'text', '.module.css': 'local-css', '.svg': 'text' },
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
  });
  const js = bundle.outputFiles.find(file => file.path.endsWith('.js')).text;
  const css = bundle.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
    body { margin: 0; font: 14px var(--dsw-font-family); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
    main { padding: 24px; }
    ${css}</style><body><div id="root"></div><script>${js.replaceAll('</script', '<\\/script')}</script></body></html>`;
}

function catalog(installedTools) {
  return TOOL_CATALOG.map(({ id, name }) => {
    const installed = installedTools.has(id);
    const available = installed && id !== 'grok';
    return {
      id, name, installed, available,
      version: installed ? '0.169.1' : undefined,
      chatSupported: true, routeSupported: available,
      canInstall: !installed, canUpdate: installed, canUninstall: installed,
      ...(id === 'grok' ? { availabilityReason: '当前安装缺少会话权限' } : {}),
    };
  });
}

test('Harness settings render four states without per-tool model controls', { skip: !executablePath && 'Chromium/Edge required' }, async () => {
  const html = await settingsFixture();
  const screenshots = process.env.BENCHGO_TOOL_SETTINGS_SCREENSHOTS;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 850 }, colorScheme: 'light' });
    page.setDefaultTimeout(6000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let mode = 'data', catalogGate;
    const installedTools = new Set(['codex', 'grok', 'opencode']);
    const operations = [];
    await page.route('http://localhost/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
      if (url.pathname !== '/api/commander/tooling') return route.abort();
      const input = route.request().postDataJSON();
      const failure = error => route.fulfill({ status: 503, json: { error } });
      switch (input.action) {
        case 'catalog':
          await catalogGate;
          return mode === 'error' ? failure('工具服务暂不可用')
            : route.fulfill({ json: { tools: mode === 'empty' ? [] : catalog(installedTools) } });
        case 'install':
          operations.push(input);
          installedTools.add(input.tool);
          return route.fulfill({ json: { job: { id: 'install-job', toolId: input.tool, action: 'install', status: 'succeeded', message: '安装完成' } } });
        case 'update':
          operations.push(input);
          return route.fulfill({ json: { job: { id: 'update-job', toolId: input.tool, action: 'update', status: 'failed', error: '下载源暂不可用' } } });
        case 'uninstallPreview':
          return route.fulfill({ json: { preview: { available: true, path: 'C:/fixture/npm/codex.cmd', snapshot: 'codex-snapshot', description: '将使用 npm 移除此安装' } } });
        case 'uninstall':
          operations.push(input);
          return route.fulfill({ json: { job: { id: 'uninstall-job', toolId: input.tool, action: 'uninstall', status: 'queued', message: '等待执行' } } });
        case 'job':
          installedTools.delete('codex');
          return route.fulfill({ json: { job: { id: input.id, toolId: 'codex', action: 'uninstall', status: 'succeeded', message: '卸载完成' } } });
        default:
          return failure('意外的测试请求 ' + input.action);
      }
    });

    const settingsDialog = page.locator('[data-shortcut-modal="settings"]');
    const openSettings = async () => {
      await page.goto('http://localhost/');
      await page.getByRole('button', { name: '设置', exact: true }).click();
      const nav = page.getByRole('navigation');
      await nav.getByRole('button', { name: '通用设置', exact: true }).waitFor();
      const generalBounds = await settingsDialog.boundingBox();
      await nav.getByRole('button', { name: 'Harness 工具' }).click();
      await page.locator('.cmd-tool-settings').waitFor();
      assert.deepEqual(await settingsDialog.boundingBox(), generalBounds, 'switching sections keeps the settings dialog in place');
    };
    const shot = async name => {
      if (screenshots) await page.screenshot({ path: join(screenshots, name + '.png'), animations: 'disabled' });
    };
    const settingsSection = page.locator('.cmd-tool-settings');
    const cards = settingsSection.locator('.cmd-tool-card');
    const card = name => cards.filter({ has: page.getByRole('heading', { name, exact: true }) });
    const refresh = settingsSection.getByRole('button', { name: '重新检测工具', exact: true });
    const loading = page.getByRole('status', { name: '正在检测 Harness 工具' });
    const codex = card('Codex');
    const claude = card('Claude Code');
    const update = codex.getByRole('button', { name: '更新', exact: true });
    const uninstall = codex.getByRole('button', { name: '卸载', exact: true });
    const columns = async expected => {
      await page.waitForFunction(expected => {
        const cards = [...document.querySelectorAll('.cmd-tool-card')];
        const first = cards[0]?.getBoundingClientRect();
        return first && cards.filter(card => Math.abs(card.getBoundingClientRect().top - first.top) < 1).length === expected;
      }, expected);
      const overflow = await settingsSection.evaluate(section => {
        const options = section.parentElement;
        return document.documentElement.scrollWidth > innerWidth || options.scrollWidth > options.clientWidth;
      });
      assert.equal(overflow, false, 'the settings column has no horizontal overflow');
    };

    let releaseCatalog;
    catalogGate = new Promise(resolve => { releaseCatalog = resolve; });
    await openSettings();
    await loading.waitFor();
    assert.equal(await refresh.isDisabled(), true);
    assert.equal(await cards.count(), 0);
    assert.ok(await loading.locator('.bg-loading-character').count() > 1);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await loading.locator('.bg-loading-character').first().evaluate(node => getComputedStyle(node).animationName), 'none');
    await shot('desktop-loading');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    releaseCatalog();

    await codex.waitFor();
    assert.equal(await cards.count(), TOOL_CATALOG.length);
    assert.equal(await settingsSection.getByRole('button', { name: '工具选项', exact: true }).count(), 0);
    assert.equal(await settingsSection.locator('[data-config-field]').count(), 0);
    await columns(3);
    assert.equal((await settingsDialog.boundingBox()).width, 1040, 'wide screens use the shared desktop dialog width');
    await card('Grok Build').getByText('当前安装缺少会话权限').waitFor();
    await shot('desktop-3-columns-light');
    await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''));
    assert.equal(await codex.locator('.cmd-tool-brand').evaluate(node => getComputedStyle(node).filter), 'none');
    assert.equal(await card('Grok Build').locator('.cmd-tool-brand').evaluate(node => getComputedStyle(node).filter), 'grayscale(1)');
    await shot('desktop-3-columns-dark');
    await page.evaluate(() => document.body.removeAttribute('data-ds-dark-theme'));

    for (const [width, count, name] of [[820, 2, 'desktop-2-columns-light'], [390, 1, 'narrow-1-column-light']]) {
      await page.setViewportSize({ width, height: 850 });
      await columns(count);
      await shot(name);
    }
    await page.setViewportSize({ width: 1280, height: 850 });

    for (const icon of [update, uninstall]) {
      assert.equal((await icon.innerText()).trim(), '', 'card actions use icon-only buttons');
      assert.equal(await icon.getAttribute('title'), null);
      const label = await icon.getAttribute('aria-label');
      await page.keyboard.press('Tab');
      await icon.focus();
      const tooltip = page.getByRole('tooltip').filter({ hasText: label });
      await tooltip.waitFor();
      assert.equal(await tooltip.getAttribute('data-portal'), 'true');
      assert.equal(await icon.evaluate(node => node.matches(':focus-visible')), true);
      if (icon === update) await shot('desktop-keyboard-tooltip');
      await page.keyboard.press('Tab');
      await tooltip.waitFor({ state: 'hidden' });
    }
    await claude.getByRole('button', { name: '安装', exact: true }).click();
    await claude.getByText('安装完成', { exact: true }).waitFor();
    await update.click();
    await codex.getByText('下载源暂不可用').waitFor();
    await shot('desktop-operation-error');
    await uninstall.click();
    const confirm = page.getByRole('dialog', { name: '确认卸载 Codex' });
    const cancel = confirm.getByRole('button', { name: '取消' });
    await cancel.waitFor();
    await page.waitForFunction(() => document.activeElement?.textContent === '取消');
    await confirm.getByText('C:/fixture/npm/codex.cmd', { exact: false }).waitFor();
    await shot('desktop-uninstall-confirmation');
    await page.keyboard.press('Escape');
    await confirm.waitFor({ state: 'hidden' });
    assert.equal(await settingsSection.isVisible(), true, 'Escape closes only the confirmation');
    await uninstall.click();
    await cancel.click();
    assert.equal(operations.length, 2, 'closing the prompt leaves the tool untouched');
    await uninstall.click();
    await confirm.getByRole('button', { name: '确认卸载' }).click();
    await codex.getByText('等待卸载').waitFor();
    await codex.getByText('卸载完成').waitFor();
    assert.deepEqual(operations, [
      { action: 'install', tool: 'claude' }, { action: 'update', tool: 'codex' },
      { action: 'uninstall', tool: 'codex', snapshot: 'codex-snapshot' },
    ]);

    catalogGate = new Promise(resolve => { releaseCatalog = resolve; });
    mode = 'error';
    await refresh.click();
    await page.waitForFunction(() => document.querySelector('.cmd-tool-settings')?.getAttribute('aria-busy') === 'true');
    assert.equal(await cards.count(), TOOL_CATALOG.length, 'refresh keeps existing cards visible');
    assert.equal(await loading.count(), 0, 'refresh does not show the initial loading view');
    releaseCatalog();
    await settingsSection.getByRole('alert').filter({ hasText: '工具服务暂不可用' }).waitFor();
    assert.equal(await cards.count(), TOOL_CATALOG.length, 'a failed refresh keeps existing cards visible');
    await openSettings();
    await settingsSection.getByRole('alert').filter({ hasText: '工具服务暂不可用' }).waitFor();
    assert.equal(await cards.count(), 0);
    await shot('desktop-initial-error');
    mode = 'empty';
    await settingsSection.getByRole('button', { name: '重试', exact: true }).click();
    await settingsSection.getByText('没有可管理的 CLI 工具').waitFor();
    await settingsSection.getByRole('button', { name: '重新检测', exact: true }).waitFor();
    await shot('desktop-empty');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
