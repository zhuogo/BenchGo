import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { build, transformSync } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { shellUi } from '../scripts/shell-ui.mjs';

const require = createRequire(new URL('../../../deepseek-harness/packages/client/ui-sidebar/package.json', import.meta.url));
const React = createRequire(new URL('../../../deepseek-harness/packages/client/ui-sidebar/package.json', import.meta.url))('react');
const { renderToStaticMarkup } = createRequire(new URL('../../../deepseek-harness/packages/client/ui-renderer/package.json', import.meta.url))('react-dom/server');
const { chromium } = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url))('playwright');
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const settings = '../../../deepseek-harness/packages/client/ui-settings-general/src/client/';
const primitives = '../../../deepseek-harness/packages/client/ui-primitives/src/';
const executablePath = [process.env.CHROMIUM_EXECUTABLE_PATH, chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(path => path && existsSync(path));
const cssModule = () => ({ __esModule: true, default: new Proxy({}, { get: (_value, key) => 'test_' + key }) });

async function moduleCss(path, prefix) {
  const result = await build({ entryPoints: [fileURLToPath(new URL(path, import.meta.url))], bundle: true, write: false, outdir: fileURLToPath(new URL('../../../artifacts/footer-layout-memory', import.meta.url)), logLevel: 'silent' });
  return result.outputFiles.find(file => file.path.endsWith('.css')).text.replace(new RegExp('\\.' + prefix + '_', 'g'), '.test_');
}

test('all six footer launchers request tooltip space above their buttons', () => {
  const source = read('../client/index.jsx');
  const settingsLauncher = source.slice(source.indexOf('function SettingsLauncher('), source.indexOf('function Hint('));
  assert.match(settingsLauncher, /<Tooltip label="设置" side="top" gap=\{10\}/);
  assert.match(settingsLauncher, /<Hint side="top" gap=\{10\}/);
  assert.match(settingsLauncher, /<Tooltip label="GitHub" side="top" gap=\{10\}/);
  for (const file of ['theme-launcher.jsx', 'updates.jsx', 'usage.jsx']) assert.match(read('../client/' + file), /<Tooltip[^>]*side="top" gap=\{10\}/);
});

test('connection recovery and the sole BenchGo update entry fit wide, narrow, rail and mobile footers', {
  skip: !executablePath && 'Requires Chromium or Edge',
}, async () => {
  const code = transformSync(read(primitives + 'ConnectionIndicator.tsx'), { loader: 'tsx', format: 'cjs', jsx: 'automatic' }).code;
  const module = { exports: {} };
  runInNewContext(code, { module, exports: module.exports, require: id => id === 'react/jsx-runtime' ? require('react/jsx-runtime') : id === 'react' ? React : id.endsWith('.css') ? cssModule() : { IconCheckOutlineRegular: () => React.createElement('svg'), IconRefreshOutlineRegular: () => React.createElement('svg'), StateDot: () => React.createElement('svg') } });
  const reconnect = renderToStaticMarkup(React.createElement(module.exports.ConnectionIndicator, { state: 'disconnected', disconnectedLabel: '连接已断开，点击重连', reconnectActionLabel: '重新连接', onReconnect() {} }));
  const css = await moduleCss(settings + 'SettingsRoot.module.css', 'SettingsRoot');
  const connectionCss = await moduleCss(primitives + 'ConnectionIndicator.module.css', 'ConnectionIndicator');
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage();
    for (const [width, rail, viewport] of [[280, false, 1024], [180, false, 1024], [36, true, 1024], [260, false, 390]]) {
      await page.setViewportSize({ width: viewport, height: 780 });
      await page.setContent(`<style>*{box-sizing:border-box}body{margin:0}${css}${connectionCss}${read('../client/style.css')}</style><aside style="position:absolute;bottom:10px;left:12px;width:${width}px"><div class="test_triggerRow ${rail ? 'test_railRow' : ''} cmd-sidebar-footer"><div class="cmd-sidebar-status">${rail ? '' : reconnect}</div><div class="cmd-settings-row ${rail ? 'cmd-settings-row-rail' : ''}">${['设置', '主题', '更新', '用量', '归档', 'GitHub'].map(label => `<button class="cmd-archive-launcher" aria-label="${label}">${label}</button>`).join('')}</div></div></aside>`);
      const state = await page.evaluate(() => {
        const rect = node => { const value = node.getBoundingClientRect(); return { top: value.top, bottom: value.bottom, left: value.left, right: value.right, width: value.width }; };
        return { action: document.querySelector('.cmd-sidebar-status button') && rect(document.querySelector('.cmd-sidebar-status button')), row: rect(document.querySelector('.cmd-settings-row')), buttons: [...document.querySelectorAll('.cmd-settings-row > button')].map(rect), sidebar: rect(document.querySelector('aside')), scroll: document.documentElement.scrollWidth };
      });
      if (rail) assert.equal(state.action, null, 'the rail retains the single update icon without a duplicate status control');
      else { assert(state.action.bottom + 5 <= state.row.top, `${width}: connection recovery reserves a separate line`); assert(state.action.width > 0); }
      assert.equal(await page.getByRole('button', { name: '更新', exact: true }).count(), 1);
      assert.equal(await page.getByRole('button', { name: '重试更新', exact: true }).count(), 0);
      for (const button of state.buttons) {
        assert(button.top >= state.row.top && button.bottom <= state.row.bottom);
        assert(button.left >= state.sidebar.left - 3 && button.right <= state.sidebar.right + 3);
      }
      assert(state.scroll <= viewport, `${width}/${rail}: footer does not overflow viewport`);
    }
    await page.close();
  } finally { await browser.close(); }
});

test('the adapted official settings render no duplicate native update action after check failures', async () => {
  const handlers=[]; shellUi().setup({ onLoad: (meta, callback) => handlers.push({ ...meta, callback }) });
  const path=fileURLToPath(new URL(settings + 'SettingsRoot.tsx',import.meta.url));
  const {contents}=await handlers.find(handler=>handler.filter.test(path)).callback({path});
  const module={exports:{}}, icon=()=>null;
  const ui = new Proxy({ Tooltip:({children})=>children, ConnectionIndicator:({state})=>state ? React.createElement('button',{'aria-label':'重新连接'},state) : null },{get:(target,key)=>target[key]||icon});
  runInNewContext(transformSync(contents,{loader:'tsx',format:'cjs',jsx:'automatic'}).code,{module,exports:module.exports,require:id=>id==='react'?{...React,useLayoutEffect(){}}:id==='react/jsx-runtime'?require('react/jsx-runtime'):id==='clsx'?((...values)=>values.filter(Boolean).join(' ')):id.includes('ui-primitives')?ui:id.endsWith('.css')?cssModule():{}});
  for(const connection of ['connected','disconnected']) for(const phase of ['error','installing']){
    const html=renderToStaticMarkup(React.createElement(module.exports.SettingsRoot,{wide:true,reconnect(){},useConnectionState:select=>select(connection),useSections:select=>select([]),useOnboardingSteps:select=>select([]),useSessions:select=>select({phase:'ready',byId:{}}),useStore:select=>select({open:false}),useShortcuts:select=>select([]),actions:{close(){},openSection(){}},t:key=>key,useDesktopUpdate(){assert.fail('native update presentation must not add a second entry');},openDesktopUpdate(){assert.fail('the status row must not open native updates');},renderSlot:key=>key==='settings.launcher'?React.createElement('button',{'aria-label':'更新'},'更新'):null,nativeState:{phase}}));
    assert.equal((html.match(/aria-label="更新"/g)||[]).length,1);
    assert.doesNotMatch(html,/重试更新|desktop\.update\.retry/);
    assert.equal(html.includes('aria-label="重新连接"'),connection==='disconnected',`${phase} does not suppress reconnection`);
  }
});
