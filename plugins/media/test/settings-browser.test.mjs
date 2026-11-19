import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { shellUi } from '../../base/scripts/shell-ui.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
const { chromium } = require('playwright');
const { build } = createRequire(new URL('../../base/package.json', import.meta.url))('esbuild');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || [chromium.executablePath(),
  'C:/Users/DraftGo/AppData/Local/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-win64/chrome-headless-shell.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);

async function fixture({ inShell = false, showGeneration = false } = {}) {
  const result = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
    import {MediaSettings, selectSettingsTab} from './plugins/media/client/index.jsx';
    import {SettingsRoot} from './deepseek-harness/packages/client/ui-settings-general/src/client/SettingsRoot.tsx';
    import mobileCss from './plugins/base/client/mobile-workbench.css';
    import {moduleSource} from './plugins/base/client/modules.mjs';
    import {installIconSprite} from './deepseek-harness/packages/client/ui-theme/src/client/icon-sprite.ts';
    installIconSprite({effect:fn=>fn(),on:()=>{}},undefined);
    moduleSource.update({base:true,voice:true,superagent:true});
    const root=createRoot(document.getElementById('root'));let serial=0;
    window.renderSettings=(scenario='data')=>{
      selectSettingsTab(${showGeneration} ? 'generation' : 'voice');
      window.scenario=scenario;window.saved=[];window.loads=0;
      let state={config:['loading','error'].includes(scenario)?null:{dictation:true,readAloud:true,call:true,
        asr:{providerId:'Cloud/@01',model:'ASR/@01',configured:true,apiType:scenario==='legacy'?'auto':scenario==='unconfigured'?'':'openai',protocol:scenario==='legacy'?'auto':scenario==='unconfigured'?'':'transcriptions-sse'},
        tts:{providerId:'Cloud/@01',model:'TTS/@01',configured:true,apiType:'openai',protocol:'speech-stream',stream:true,voice:'original-voice',speed:1.2},
        conversation:scenario==='empty'?{}:{providerId:'Cloud/@01',model:'Exact Model:01',configured:true},
        listening:{enabled:false,endpoint:scenario==='empty'?'':'https://example.test/v1/decision',model:'',wakeSource:'custom',wakeWord:scenario==='empty'?'':'小舟',apiKeyConfigured:scenario!=='empty',superagentAvailable:scenario!=='empty',superagentName:scenario==='empty'?'':'小蓝',configured:scenario!=='empty'}},error:scenario==='error'?'语音配置暂不可用':''};
      if(scenario==='saved')state.config=window.voiceSnapshot;
      const listeners=new Set(),controller={state:{getSnapshot:()=>state,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)}},
        load:async()=>{window.loads++},configure:async patch=>{window.saved.push(patch);state={...state,config:{...state.config,...patch,conversation:{...state.config.conversation,...patch.conversation},asr:{...state.config.asr,...patch.asr},tts:{...state.config.tts,...patch.tts},listening:{...state.config.listening,...patch.listening}}};if(Object.hasOwn(patch.listening||{},'apiKey'))state.config.listening.apiKeyConfigured=!!patch.listening.apiKey;delete state.config.listening.apiKey;window.voiceSnapshot=structuredClone(state.config);listeners.forEach(fn=>fn());return state.config}};
      window.patchListeningSnapshot=patch=>{state={...state,config:{...state.config,listening:{...state.config.listening,...patch}}};listeners.forEach(fn=>fn())};
      function SettingsFixture() {
        const [section, openSection] = useState(${showGeneration} ? 'general' : 'media');
        window.openSettingsSection = openSection;
        const active = section === 'media' ? <MediaSettings controller={controller} openModels={() => openSection('models')} /> : <h2>通用设置</h2>;
        if (!${inShell}) return active;
        const renderSlot = (name, props, filter) => {
          if (name === 'settings.header') return '设置';
          if (name === 'settings.close') return '关闭设置';
          if (name === 'settings.section' && filter.only === section) return active;
          return filter?.fallback ?? null;
        };
        return <><style>{mobileCss}</style><main><h1>BenchGo</h1><SettingsRoot wide t={key=>key} renderSlot={renderSlot} reconnect={()=>{}}
          useStore={read=>read({open:true,activeId:section})} actions={{close(){},openSection,select:openSection}}
          useSections={read=>read([{id:'general',label:'通用设置'},{id:'models',label:'模型'},{id:'media',label:'媒体'},{id:'harness-tools',label:'Harness 工具'}])}
          useConnectionState={read=>read('connected')} useOnboardingSteps={read=>read([])}
          useSessions={read=>read({phase:'ready',byId:{main:{retainedBy:{mainView:1},blank:false}}})} useShortcuts={read=>read([])}/></main></>;
      }
      root.render(<SettingsFixture key={++serial}/>);
    };
  ` }, bundle: true, write: false, outdir: join(root, 'artifacts/unused-voice-settings'), format: 'iife', jsx: 'automatic',
    nodePaths: [join(root, 'plugins/base/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
    alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')),
      '@deepseek-ai/dsh-client-ui-primitives': join(root, 'deepseek-harness/packages/client/ui-primitives/src/index.ts') },
    plugins: [shellUi(), { name: 'fixture-export', setup(build) { build.onLoad({ filter: /media[\\/]client[\\/]index\.jsx$/ }, async args => ({ contents: await readFile(args.path, 'utf8') + '\nexport { MediaSettings, selectSettingsTab };', loader: 'jsx' })); } }],
    loader: { '.css': 'text', '.module.css': 'local-css', '.svg': 'text' }, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  const script = result.outputFiles.find(file => file.path.endsWith('.js')).text;
  const css = await readFile(new URL('../../base/client/style.css', import.meta.url), 'utf8') + await readFile(new URL('../client/style.css', import.meta.url), 'utf8') + await readFile(new URL('../client/media-settings.css', import.meta.url), 'utf8') + result.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n');
  const theme = (await Promise.all(['base.css', 'design-platform.css', 'focus.css'].map(name => readFile(join(root, 'deepseek-harness/packages/client/ui-theme/src/styles', name), 'utf8')))).join('\n');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
    ${theme}:root,body{color-scheme:light;--dsw-alias-bg-base:#fafafa;--dsw-alias-bg-layer-2:#fff;--dsw-alias-label-primary:#242424;--dsw-alias-label-secondary:#797b83;--dsw-alias-state-business-primary:#4d6bfe}html[data-dark=true],html[data-dark=true] body{color-scheme:dark;--dsw-alias-bg-base:#191a1e;--dsw-alias-bg-layer-2:#202126;--dsw-alias-label-primary:#ededee;--dsw-alias-label-secondary:#a3a5af}body{margin:0;padding:24px;font-family:Arial,"Microsoft YaHei",sans-serif;background:var(--dsw-alias-bg-base)}.voice-settings{margin:auto}${css}
    ${inShell ? 'body{padding:0}main{padding:24px}' : ''}</style></head><body><div id="root"></div><script>${script.replaceAll('</script', '<\\/script')}</script></body></html>`;
}

test('decision settings are neutral, preserve selections and credentials, and render four states', { skip: !executablePath && 'Chromium/Edge required' }, async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  const screenshots = process.env.BENCHGO_DECISION_SCREENSHOTS;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  try {
    const page = await browser.newPage(), errors = [], requests = []; let testMode = 'ok', release;
    page.setDefaultTimeout(6000); page.on('pageerror', failure => errors.push(failure.message)); const html = await fixture();
    await page.route('**/*', async route => {
      if (route.request().url() === 'http://localhost/') return route.fulfill({ contentType: 'text/html', body: html });
      if (route.request().url().endsWith('/api/commander/tooling')) return route.fulfill({ json: { providers: [], models: [] } });
      if (route.request().url().endsWith('/api/voice')) {
        const input = route.request().postDataJSON(); requests.push(input);
        if (testMode === 'hold') await new Promise(resolve => { release = resolve; });
        if (testMode === 'error') return route.fulfill({ status: 502, json: { error: '决策服务暂不可用，请重试。' } });
        return route.fulfill({ json: { result: { supported: true, decision: 'addressed', probability: .99, latencyMs: 122 } } }).catch(() => {});
      }
      return route.abort();
    });
    await page.goto('http://localhost/');
    const navigate = async scenario => { await page.evaluate(scenario => window.renderSettings(scenario), scenario); await page.getByRole('tab', { name: '实时通话', exact: true }).click();
      // Decision settings stay collapsed under the interaction model until the call uses them.
      const entry = page.getByRole('button', { name: '决策（未接入通话）', exact: true });
      assert.equal(await page.getByRole('tab', { name: '决策', exact: true }).count(), 0); assert.equal(await entry.getAttribute('aria-expanded'), 'false');
      assert.equal(await page.getByLabel('决策接口地址', { exact: true }).count(), 0);
      await entry.click(); };
    for (const width of [1440, 390]) for (const dark of [false, true]) {
      await page.setViewportSize({ width, height: 1000 }); await page.evaluate(dark => document.documentElement.dataset.dark = dark, dark);
      await navigate('empty');
      assert.equal(await page.getByLabel('决策接口地址', { exact: true }).inputValue(), '');
      assert.equal(await page.getByLabel('决策模型 ID', { exact: true }).inputValue(), '');
      assert.equal(await page.getByLabel('唤醒词', { exact: true }).inputValue(), '');
      assert.doesNotMatch(await page.locator('.voice-listening-settings').innerText(), /Jev|Bivia|TypeSafe|SystemOne|姓名/i);
      assert.doesNotMatch((await page.locator('.voice-listening-settings input').evaluateAll(inputs => inputs.map(input => input.placeholder))).join(' '), /Jev|Bivia|TypeSafe|SystemOne|articul8|https?:/i);
      assert(await page.getByRole('button', { name: '测试连接', exact: true }).isDisabled());
      await page.getByRole('button', { name: '唤醒词来源 自定义', exact: true }).click();
      assert(await page.getByRole('option', { name: /跟随 SuperAgent 称呼/ }).isDisabled()); await page.keyboard.press('Escape');
      if (screenshots) await page.screenshot({ path: join(screenshots, `empty-${width}-${dark?'dark':'light'}.png`), fullPage: true });
      await navigate('data'); testMode = 'hold'; await page.getByRole('button', { name: '测试连接', exact: true }).click();
      await page.getByText('正在判断固定示例', { exact: true }).waitFor();
      if (screenshots) await page.screenshot({ path: join(screenshots, `loading-${width}-${dark?'dark':'light'}.png`), fullPage: true });
      await page.getByRole('button', { name: '取消', exact: true }).click(); testMode = 'error'; release();
      await page.getByRole('button', { name: '测试连接', exact: true }).click(); await page.getByRole('alert').getByText('决策服务暂不可用，请重试。').waitFor();
      if (screenshots) await page.screenshot({ path: join(screenshots, `error-${width}-${dark?'dark':'light'}.png`), fullPage: true });
      testMode = 'ok'; await page.getByRole('button', { name: '测试连接', exact: true }).click(); await page.getByText('连接可用 · 122ms', { exact: true }).waitFor();
      if (screenshots) await page.screenshot({ path: join(screenshots, `data-${width}-${dark?'dark':'light'}.png`), fullPage: true });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    await page.setViewportSize({ width: 1280, height: 1000 }); await navigate('data');
    await page.getByRole('switch', { name: /判断是否在对我说话/ }).click();
    await page.getByLabel('唤醒词', { exact: true }).fill('小白');
    await page.getByRole('button', { name: '唤醒词来源 自定义', exact: true }).click();
    await page.getByRole('option', { name: /跟随 SuperAgent 称呼/ }).click(); await page.getByText('当前称呼：小蓝', { exact: true }).waitFor();
    await page.getByRole('button', { name: '保存设置', exact: true }).click(); await page.getByText('已保存', { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.saved), [{ listening: { enabled: true, wakeSource: 'superagent', wakeWord: '小白' } }]);
    await navigate('saved'); await page.getByText('当前称呼：小蓝', { exact: true }).waitFor();
    await page.evaluate(() => window.patchListeningSnapshot({ superagentAvailable: false, superagentName: '' }));
    await page.getByText('SuperAgent 称呼暂不可用，请设置称呼或选择自定义。', { exact: true }).waitFor();
    await page.getByRole('button', { name: /^唤醒词来源 跟随/ }).click(); await page.getByRole('option', { name: '自定义', exact: true }).click();
    assert.equal(await page.getByLabel('唤醒词', { exact: true }).inputValue(), '小白');
    await page.getByLabel('决策接口地址', { exact: true }).fill('https://other.example.test/v1/decision');
    assert(await page.getByRole('button', { name: '测试连接', exact: true }).isDisabled());
    await page.getByLabel('决策 API Key', { exact: true }).fill('test-only-key'); await page.getByLabel('决策模型 ID', { exact: true }).fill('decision-1.14/@opaque');
    await page.getByRole('button', { name: '测试连接', exact: true }).click(); await page.getByText('连接可用 · 122ms', { exact: true }).waitFor();
    assert.equal(requests.at(-1).config.endpoint, 'https://other.example.test/v1/decision'); assert.equal(requests.at(-1).config.model, 'decision-1.14/@opaque'); assert.equal(requests.at(-1).config.apiKey, 'test-only-key');
    assert(!requests.some(row => 'text' in row || 'context' in row || 'sessionId' in row));
    await page.getByRole('button', { name: '保存设置', exact: true }).click(); await page.getByText('已保存', { exact: true }).waitFor();
    await navigate('saved'); assert.equal(await page.getByLabel('决策模型 ID', { exact: true }).inputValue(), 'decision-1.14/@opaque'); assert.equal(await page.getByLabel('决策 API Key', { exact: true }).inputValue(), '');
    await page.getByRole('button', { name: '清除密钥', exact: true }).click(); await page.getByRole('button', { name: '保存设置', exact: true }).click(); await page.getByText('已保存', { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.saved), [{ listening: { apiKey: '' } }]);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('voice settings render four states and save exact conversation model without replacing ASR or TTS', { skip: !executablePath && 'Chromium/Edge required' }, async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  const screenshots = process.env.BENCHGO_VOICE_SETTINGS_SCREENSHOTS;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  try {
    const page = await browser.newPage(), errors = []; page.setDefaultTimeout(6000); page.on('pageerror', failure => errors.push(failure.message));
    const html = await fixture({ inShell: true });
    await page.route('**/*', async route => {
      if (route.request().url() === 'http://localhost/') return route.fulfill({ contentType: 'text/html', body: html });
      if (route.request().url().endsWith('/api/commander/tooling')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ providers: await page.evaluate(() => window.scenario) === 'empty' ? [] : [{id:'Cloud/@01',name:'已配置供应商',configured:true}], models: [
        { id: 'Exact Model:01', name: '轻量模型一', kinds: ['text'] }, { id: 'Exact Model:02/@raw', name: '轻量模型二', kinds: ['text'] },
        { id: 'ASR/@01', name: '语音识别', kinds: ['asr'] }, { id: 'TTS/@01', name: '语音合成', kinds: ['tts'] }] }) });
      return route.abort();
    });
    await page.goto('http://localhost/');
    for (const width of [1440, 390]) for (const dark of [false, true]) {
      await page.setViewportSize({ width, height: 900 }); await page.evaluate(dark => { document.documentElement.dataset.dark = dark; document.body.toggleAttribute('data-ds-dark-theme', dark); }, dark);
      for (const scenario of ['loading', 'error', 'empty', 'data']) {
        await page.evaluate(scenario => window.renderSettings(scenario), scenario);
        if (scenario === 'loading') await page.getByRole('status', { name: '正在加载语音设置…' }).waitFor();
        else if (scenario === 'error') { await page.getByText('语音配置暂不可用', { exact: true }).waitFor(); await page.getByRole('button', { name: '重新加载', exact: true }).click(); assert.equal(await page.evaluate(() => window.loads), 1); }
        else {
          await page.getByRole('tab', { name: '实时通话', exact: true }).click();
          await page.locator('legend').filter({ hasText: /^交互模型$/ }).waitFor();
          if (scenario === 'empty') await page.getByText('未配置，使用原会话模型。', { exact: true }).waitFor();
          else {
            const interaction = page.locator('fieldset').filter({ has: page.locator('legend').filter({ hasText: /^交互模型$/ }) });
            await interaction.getByRole('button', { name: '交互模型 轻量模型一', exact: true }).click();
            await page.getByRole('option', { name: '轻量模型二 Exact Model:02/@raw', exact: true }).click();
            await page.getByRole('button', { name: '保存设置', exact: true }).click();
            await page.getByText('已保存', { exact: true }).waitFor();
            assert.deepEqual(await page.evaluate(() => window.saved), [{ conversation: { model: 'Exact Model:02/@raw' } }]);
            await page.getByRole('tab', {name:'语音合成',exact:true}).click();
            await page.getByRole('textbox', {name:'音色',exact:true}).fill('New Voice/@raw');
            await page.getByRole('tab', {name:'语音识别',exact:true}).click();
            assert.equal(await page.getByRole('textbox', {name:'音色',exact:true}).count(), 0);
            await page.getByRole('tab', {name:'语音合成',exact:true}).click();
            await page.getByRole('button', {name:'保存设置',exact:true}).click();
            await page.getByText('已保存', {exact:true}).waitFor();
            assert.deepEqual(await page.evaluate(() => window.saved), [{conversation:{model:'Exact Model:02/@raw'}},{tts:{voice:'New Voice/@raw'}}]);
          }
        }
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        if (screenshots) { await page.evaluate(() => Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})))); await page.screenshot({ path: join(screenshots, `${scenario}-${width}-${dark ? 'dark' : 'light'}.png`), fullPage: true }); }
      }
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});


test('voice protocol picker escapes the scroll panel and sticky save bar on desktop and touch', { skip: !executablePath && 'Chromium/Edge required' }, async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  const screenshots = process.env.BENCHGO_VOICE_SETTINGS_SCREENSHOTS;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  const html = await fixture();
  try {
    for (const viewport of [{ width: 1100, height: 760 }, { width: 760, height: 460 }, { width: 390, height: 620 }]) {
      const touch = viewport.width === 390;
      const context = await browser.newContext({ viewport, hasTouch: touch, isMobile: touch });
      const page = await context.newPage(), errors = [];
      page.setDefaultTimeout(6000); page.on('pageerror', failure => errors.push(failure.message));
      await page.route('**/*', async route => {
        if (route.request().url() === 'http://localhost/') return route.fulfill({ contentType: 'text/html', body: html });
        if (route.request().url().endsWith('/api/commander/tooling')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ providers: [{ id: 'Cloud/@01', name: '已配置供应商', configured: true }], models: [{ id: 'ASR/@01', name: '语音识别', kinds: ['asr'] }] }) });
        return route.abort();
      });
      await page.goto('http://localhost/');
      await page.evaluate(() => { window.renderSettings('data'); document.getElementById('root').setAttribute('role', 'dialog'); });
      await page.addStyleTag({ content: 'body{padding:0;overflow:hidden}#root{position:fixed;inset:16px;overflow:hidden}.media-settings{height:100%;overflow:auto;padding:16px 24px}.media-settings .voice-settings-content>footer{position:sticky;bottom:0;z-index:200;background:var(--dsw-alias-bg-base);padding:18px 0}.voice-settings-content{padding-bottom:12px}' });
      await page.getByRole('tab', { name: '语音转文本', exact: true }).click();
      await page.getByRole('button', { name: '高级设置', exact: true }).click();
      const trigger = page.getByRole('button', { name: '协议 增量转录（SSE）', exact: true });
      await trigger.scrollIntoViewIfNeeded();
      if (touch) await trigger.tap(); else await trigger.click();
      const options = page.getByRole('listbox'), popup = page.locator('.dowork-select-popup');
      await popup.waitFor();
      await page.waitForFunction(() => document.getAnimations().every(animation => animation.effect?.getComputedTiming().iterations === Infinity || animation.playState === 'finished'));
      const bounds = await popup.boundingBox();
      assert(bounds.y >= 0 && bounds.y + bounds.height <= viewport.height, 'menu stays inside the viewport');
      assert.equal(await popup.evaluate(node => node.parentElement.id), 'root', 'menu portals outside the scrolled settings content');
      for (const option of await options.getByRole('option').all()) {
        await option.scrollIntoViewIfNeeded();
        assert(await option.evaluate(node => { const rect = node.getBoundingClientRect(); return node.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)); }), 'each protocol can receive pointer input above the save bar');
      }
      if (screenshots) await page.screenshot({ path: join(screenshots, `protocol-popup-${viewport.width}x${viewport.height}.png`) });
      const selected = options.getByRole('option', { name: '整段转录（HTTP）', exact: true });
      if (touch) await selected.tap(); else await selected.click();
      await page.getByRole('button', { name: '保存设置', exact: true }).click();
      await page.getByText('已保存', { exact: true }).waitFor();
      assert.deepEqual(await page.evaluate(() => window.saved), [{ asr: { protocol: 'transcriptions' } }]);
      await page.getByRole('button', { name: '协议 整段转录（HTTP）', exact: true }).click();
      const search = page.getByRole('combobox');
      await search.fill('no-such-protocol'); await page.getByText('没有可选项', { exact: true }).waitFor();
      await search.fill('SSE'); await search.press('Enter');
      await page.getByRole('button', { name: '保存设置', exact: true }).click();
      await page.getByText('已保存', { exact: true }).waitFor();
      assert.deepEqual(await page.evaluate(() => window.saved), [{ asr: { protocol: 'transcriptions' } }, { asr: { protocol: 'transcriptions-sse' } }]);
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally { await browser.close(); }
});

test('matching is explicit, fills a concrete draft and preserves the choice after saving and reopening', { skip: !executablePath && 'Chromium/Edge required' }, async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 850 } }); page.setDefaultTimeout(6000);
    const html = await fixture(), requests = []; let pending, hold = true;
    await page.route('**/*', async route => {
      const url = route.request().url();
      if (url === 'http://localhost/') return route.fulfill({ contentType: 'text/html', body: html });
      if (url.endsWith('/api/commander/tooling')) return route.fulfill({ json: { providers: [{ id: 'Cloud/@01', name: '已配置供应商', configured: true }], models: [{ id: 'ASR/@01', name: '语音识别', kinds: ['asr'] }] } });
      if (url.endsWith('/api/voice')) {
        const input = route.request().postDataJSON(); requests.push(input);
        const result = { status: input.action === 'protocol.test' ? 'inconclusive' : 'supported', apiType: 'stepfun', protocol: 'stepfun-sse', message: input.action === 'protocol.test' ? '认证失败，请检查密钥' : '已按首输出延迟选择', attempts: input.action === 'protocol.test' ? [{ protocol: 'stepfun-sse', status: 'inconclusive', message: '认证失败' }] : [{ protocol: 'stepfun-sse', status: 'supported', firstOutputMs: 127, completionMs: 200, message: '接口可用' }, { protocol: 'transcriptions', status: 'not-tested', message: '用途限制，未测试' }] };
        if (hold) { hold = false; pending = () => route.fulfill({ json: { result } }).catch(() => {}); return; }
        return route.fulfill({ json: { result } });
      }
      return route.abort();
    });
    await page.goto('http://localhost/'); await page.evaluate(() => window.renderSettings('legacy'));
    await page.getByText('待匹配协议', { exact: true }).waitFor();
    await page.waitForTimeout(850); assert.equal(requests.length, 0, 'opening settings never probes');
    await page.getByRole('button', { name: '自动匹配', exact: true }).click();
    await page.getByText('正在匹配协议…', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '自动匹配', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: '手动填写', exact: true }).click();
    await page.getByRole('textbox', { name: '语音识别模型', exact: true }).fill('Step Model/@Exact'); await pending();
    await page.getByText('待匹配协议', { exact: true }).waitFor();
    await page.waitForTimeout(850); assert.equal(requests.length, 1, 'typing never probes');
    await page.getByRole('button', { name: '自动匹配', exact: true }).click();
    await page.getByText('已匹配 · 阶跃增量转录（SSE） · 待保存', { exact: true }).waitFor();
    assert.equal(requests.length, 2); assert.equal(requests.at(-1).requirement, 'any', 'dictation ignores the globally enabled call toggle');
    await page.getByRole('button', { name: '高级设置', exact: true }).click();
    await page.getByRole('button', { name: '接口类型 阶跃星辰原生', exact: true }).waitFor();
    await page.getByRole('button', { name: '协议 阶跃增量转录（SSE）', exact: true }).waitFor();
    await page.getByText('可用 · 首输出 127 ms · 完成 200 ms · 接口可用', { exact: true }).waitFor();
    await page.getByText('未测试 · 用途限制，未测试', { exact: true }).waitFor();
    const screenshots = process.env.BENCHGO_VOICE_SETTINGS_SCREENSHOTS;
    if (screenshots) { await page.evaluate(() => Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})))); await page.screenshot({ path: join(screenshots, 'matched-draft.png'), fullPage: true }); }
    await page.getByRole('button', { name: '测试当前协议', exact: true }).click();
    await page.getByText('认证失败，请检查密钥', { exact: true }).waitFor();
    await page.getByRole('button', { name: '协议 阶跃增量转录（SSE）', exact: true }).waitFor();
    if (screenshots) await page.screenshot({ path: join(screenshots, 'matched-test-error.png'), fullPage: true });
    await page.getByRole('button', { name: '保存设置', exact: true }).click(); await page.getByText('已保存', { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.saved), [{ asr: { apiType: 'stepfun', protocol: 'stepfun-sse', model: 'Step Model/@Exact' } }]);
    await page.waitForTimeout(850); assert.equal(requests.length, 3, 'saving never probes');
    await page.evaluate(() => window.renderSettings('saved'));
    await page.getByText('已选择 · 阶跃增量转录（SSE）', { exact: true }).waitFor();
    await page.waitForTimeout(850); assert.equal(requests.length, 3);
    await page.getByRole('button', { name: '高级设置', exact: true }).click();
    await page.getByRole('button', { name: '协议 阶跃增量转录（SSE）', exact: true }).click();
    assert.equal(await page.getByRole('option', { name: '自动识别', exact: true }).count(), 0);
  } finally { await browser.close(); }
});

test('matching uses the current mode, supports cancellation and requires usable credentials', { skip: !executablePath && 'Chromium/Edge required' }, async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } }); page.setDefaultTimeout(6000);
    const html = await fixture(), requests = []; let pending, hold = false;
    await page.route('**/*', async route => {
      const url = route.request().url();
      if (url === 'http://localhost/') return route.fulfill({ contentType: 'text/html', body: html });
      if (url.endsWith('/api/commander/tooling')) return route.fulfill({ json: { providers: [{ id: 'Cloud/@01', name: '已配置供应商', configured: true }], models: [{ id: 'ASR/@01', name: '语音识别', kinds: ['asr'] }, { id: 'TTS/@01', name: '语音合成', kinds: ['tts'] }] } });
      if (url.endsWith('/api/voice')) {
        const input = route.request().postDataJSON(); requests.push(input);
        const result = { status: 'supported', apiType: 'openai', protocol: input.kind === 'tts' ? 'speech' : 'transcriptions-sse', attempts: [] };
        if (hold) { hold = false; pending = () => route.fulfill({ json: { result } }).catch(() => {}); return; }
        return route.fulfill({ json: { result } });
      }
      return route.abort();
    });
    await page.goto('http://localhost/'); await page.evaluate(() => window.renderSettings('unconfigured'));
    await page.getByRole('button', { name: '高级设置', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '测试当前协议', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: '测试当前协议', exact: true }).evaluate(button => button.click()); assert.equal(requests.length, 0);
    hold = true; await page.getByRole('button', { name: '自动匹配', exact: true }).click();
    await page.getByText('正在匹配协议…', { exact: true }).waitFor();
    if (process.env.BENCHGO_VOICE_SETTINGS_SCREENSHOTS) { await page.evaluate(() => Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})))); await page.screenshot({ path: join(process.env.BENCHGO_VOICE_SETTINGS_SCREENSHOTS, 'match-disabled-mobile.png'), fullPage: true }); }
    await page.getByRole('button', { name: '取消检测', exact: true }).click(); await pending();
    await page.getByText('待匹配协议', { exact: true }).waitFor();
    hold = true; await page.getByRole('button', { name: '自动匹配', exact: true }).click();
    await page.getByText('正在匹配协议…', { exact: true }).waitFor();
    await page.getByRole('tab', { name: '朗读', exact: true }).click(); await pending();
    assert.equal(await page.getByText('已匹配', { exact: false }).count(), 0);
    await page.getByRole('button', { name: '自动匹配', exact: true }).click();
    await page.getByText(/已匹配 · .*待保存/).waitFor(); assert.equal(requests.at(-1).requirement, 'any');
    await page.getByRole('slider', { name: '语速', exact: true }).fill('1.65');
    await page.waitForTimeout(850); assert.equal(requests.length, 3);
    await page.getByRole('tab', { name: '实时通话', exact: true }).click();
    await page.getByRole('tab', { name: '语音识别', exact: true }).click();
    await page.getByRole('button', { name: '自动匹配', exact: true }).click();
    await page.getByText(/已匹配 · .*待保存/).waitFor(); assert.equal(requests.at(-1).requirement, 'streaming');
    await page.getByRole('button', { name: '模型供应商 已配置供应商', exact: true }).click(); await page.getByRole('option', { name: /独立配置/ }).click();
    await page.getByRole('textbox', { name: '语音识别模型', exact: true }).fill('ASR/@Exact');
    await page.getByRole('textbox', { name: 'API 地址', exact: true }).fill('https://asr.example/v1');
    assert.equal(await page.getByRole('button', { name: '自动匹配', exact: true }).isDisabled(), true);
    await page.getByRole('textbox', { name: 'API Key', exact: true }).fill('FIXTURE_KEY');
    await page.waitForTimeout(850); assert.equal(requests.length, 4, 'credentials do not trigger a request');
    assert.equal(await page.getByRole('button', { name: '自动匹配', exact: true }).isEnabled(), true);
    hold = true; await page.getByRole('button', { name: '自动匹配', exact: true }).click(); await page.getByText('正在匹配协议…', { exact: true }).waitFor();
    await page.getByRole('button', { name: '保存设置', exact: true }).click(); await page.getByText('已保存', { exact: true }).waitFor(); await pending();
    await page.getByText('待匹配协议', { exact: true }).waitFor();
    assert.equal(await page.locator('body').innerText().then(text => text.includes('FIXTURE_KEY')), false);
    await page.getByRole('textbox', { name: 'API Key', exact: true }).fill('FIXTURE_KEY');
    await page.getByRole('button', { name: '自动匹配', exact: true }).click(); await page.getByText(/已匹配 · .*待保存/).waitFor();
    await page.getByRole('button', { name: '保存设置', exact: true }).click(); await page.getByText('已保存', { exact: true }).waitFor();
    await page.getByText('已保存 · 增量转录（SSE）', { exact: true }).waitFor();
    assert.equal(await page.getByRole('textbox', { name: 'API Key', exact: true }).inputValue(), '');
  } finally { await browser.close(); }
});

test('media settings render four states and round-trip three ordered routes', { skip: !executablePath && 'Chromium/Edge required' }, async () => {
  const browser = await chromium.launch({ executablePath, headless: true }), html = await fixture({ inShell: true, showGeneration: true });
  const screenshots = process.env.BENCHGO_MEDIA_SETTINGS_SCREENSHOTS;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  try {
    const page = await browser.newPage({ reducedMotion: 'reduce' }), errors = [], requests = [];
    page.setDefaultTimeout(6000); page.on('pageerror', error => errors.push(error.message));
    const providerId = 'Cloud/@01';
    const image = { enabled: true, routes: [{ providerId, modelId: 'Image:/@Primary' }] };
    const video = { enabled: true, routes: [{ providerId, modelId: 'Video:/@Exact' }] };
    const audio = { enabled: false, routes: [] };
    let saved = { revision: 8, image, video, audio };
    let scenario = 'loading', finishLoad, finishSave;
    await page.route('**/*', async route => {
      const url = route.request().url();
      if (url === 'http://localhost/') return route.fulfill({ contentType: 'text/html', body: html });
      if (url.endsWith('/api/commander/tooling')) return route.fulfill({ json: {
        providers: [{ id: providerId, name: 'RouterGo 测试', configured: true }],
        models: [
          { id: 'Image:/@Primary', name: '图片首选', capabilities: ['image-generation'] },
          { id: 'Image:/@Edit', name: '图片编辑', capabilities: ['image-edit'] },
          { id: 'Video:/@Exact', name: '视频模型', capabilities: ['video'] },
          { id: 'Audio:/@Exact', name: '合成语音', capabilities: ['tts'] },
        ],
      } });
      if (url.endsWith('/api/benchgo/media/settings')) {
        if (route.request().method() === 'POST') {
          const input = route.request().postDataJSON();
          requests.push(input);
          finishSave = () => {
            saved = { ...saved, ...input.settings, revision: input.revision + 1 };
            return route.fulfill({ json: { settings: saved } });
          };
          return;
        }
        if (scenario === 'loading') { finishLoad = () => route.fulfill({ status: 503, json: { error: '接入暂不可用' } }); return; }
        if (scenario === 'empty') return route.fulfill({ json: { settings: { ...saved, image: { enabled: false, routes: [] } } } });
        return route.fulfill({ json: { settings: saved } });
      }
      return route.abort();
    });
    await page.goto('http://localhost/');
    const media = () => page.getByRole('heading', { name: '媒体', exact: true });
    const ordered = position => page.getByRole('group', { name: '顺位 ' + position, exact: true });
    const modelOpener = position => ordered(position).getByRole('button', { name: /模型操作$/ });
    const chooseAction = async (position, name) => {
      await modelOpener(position).click();
      await page.getByRole('menuitem', { name, exact: true }).click();
    };
    const shot = async (state, width, dark) => {
      if (screenshots) await page.screenshot({ path: join(screenshots, `${state}-${width}-${dark ? 'dark' : 'light'}.png`), fullPage: true });
    };
    const openMedia = async () => {
      await page.evaluate(() => window.renderSettings('data'));
      await page.getByRole('heading', { name: '通用设置', exact: true }).waitFor();
      await page.getByRole('button', { name: '媒体', exact: true }).click();
      await media().waitFor();
      await page.getByRole('tab', { name: '媒体生成', exact: true, selected: true }).waitFor();
    };
    const device = await page.context().newCDPSession(page);
    for (const width of [1100, 390]) for (const dark of [false, true]) {
      await page.setViewportSize({ width, height: 900 });
      await device.send('Emulation.setTouchEmulationEnabled', { enabled: width === 390 });
      await page.evaluate(dark => { document.documentElement.dataset.dark = dark; document.body.toggleAttribute('data-ds-dark-theme', dark); }, dark);
      scenario = 'loading'; await openMedia();
      await page.getByRole('status', { name: '正在加载媒体设置…' }).waitFor();
      await shot('loading', width, dark);
      await finishLoad();
      await page.getByRole('alert').getByText('接入暂不可用', { exact: true }).waitFor();
      await shot('error', width, dark);
      scenario = 'empty';
      await page.getByRole('button', { name: '重新加载', exact: true }).click();
      await page.getByRole('switch', { name: '在对话中生成图片', exact: true }).click();
      await page.getByText('还没有图片生成模型', { exact: true }).waitFor();
      await page.getByRole('button', { name: '添加模型', exact: true }).waitFor();
      await shot('empty', width, dark);
      await page.getByRole('tab', { name: '音频', exact: true }).click();
      await page.getByText('还没有音频生成模型', { exact: true }).waitFor();
      await shot('audio-empty', width, dark);
      scenario = 'data'; await openMedia();
      const model = ordered(1).getByRole('button', { name: /^模型 ID / });
      await model.waitFor();
      await page.getByRole('button', { name: '添加备用模型', exact: true }).click();
      for (const position of [1, 2]) {
        const row = ordered(position);
        const [dropdown, supplier, menu, label] = await Promise.all([
          row.getByRole('button', { name: /^模型 ID / }).boundingBox(),
          row.getByRole('button', { name: /^模型供应商 / }).boundingBox(),
          modelOpener(position).boundingBox(), row.getByText('顺位 ' + position, { exact: true }).boundingBox(),
        ]);
        assert(label.x + label.width <= supplier.x);
        assert(supplier.x + supplier.width <= dropdown.x && dropdown.x + dropdown.width <= menu.x);
        for (const box of [supplier, menu, label]) assert(Math.abs(dropdown.y + dropdown.height / 2 - box.y - box.height / 2) <= 2);
        assert((await row.boundingBox()).height <= 56);
        if (width === 390) assert(dropdown.height >= 44 && menu.height >= 44);
      }
      assert.equal(await page.getByText('模型 ID', { exact: true }).count(), 1);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await shot('data', width, dark);
      await modelOpener(2).click();
      const remove = page.getByRole('menuitem', { name: '移除模型', exact: true });
      await remove.waitFor();
      if (width === 390) assert((await remove.boundingBox()).height >= 44);
      await shot('menu', width, dark);
      await remove.click();
      await ordered(2).waitFor({ state: 'detached' });
    }

    await chooseAction(1, '刷新列表');
    await ordered(1).getByRole('button', { name: /^模型 ID / }).click();
    await page.getByRole('option', { name: /图片编辑/ }).waitFor();
    assert.equal(await page.getByRole('option', { name: /视频模型|合成语音/ }).count(), 0);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '添加备用模型', exact: true }).click();
    await ordered(2).getByRole('button', { name: /^模型供应商 / }).click();
    const supplierSearch = page.getByRole('combobox', { name: /^搜索模型供应商/ });
    await supplierSearch.fill('RouterGo 测试');
    const firstSupplier = page.getByRole('option').first();
    assert.match(await firstSupplier.innerText(), /RouterGo.*配置 RouterGo/s);
    assert.equal(await firstSupplier.getAttribute('aria-disabled'), 'true');
    assert.equal(await firstSupplier.locator('[data-provider-brand=routergo] img').count(), 1);
    await page.getByRole('option', { name: 'RouterGo 测试', exact: true }).click();
    await ordered(2).getByRole('button', { name: /^模型 ID / }).click();
    await page.getByRole('option', { name: /图片编辑/ }).click();
    await page.getByRole('button', { name: '添加备用模型', exact: true }).click();
    await ordered(3).getByRole('button', { name: /^模型供应商 / }).click();
    await page.getByRole('option', { name: 'RouterGo 测试', exact: true }).click();
    await chooseAction(3, '手动填写');
    await ordered(3).getByRole('textbox', { name: '模型 ID', exact: true }).fill('Image: opaque/@Raw 01');
    await page.getByRole('tab', { name: '语音', exact: true }).click();
    await page.getByRole('tab', { name: '实时通话', exact: true }).click();
    await page.getByRole('tab', { name: '媒体生成', exact: true }).click();
    assert.equal(await ordered(3).getByRole('textbox', { name: '模型 ID', exact: true }).inputValue(), 'Image: opaque/@Raw 01');
    await chooseAction(3, '上移');
    assert.equal(await page.getByRole('button', { name: '添加备用模型', exact: true }).count(), 0);

    await page.getByRole('tab', { name: '视频', exact: true }).click();
    await page.getByRole('button', { name: /模型 ID 视频模型/ }).waitFor();
    await page.getByRole('tab', { name: '音频', exact: true }).click();
    await page.getByRole('switch', { name: '在对话中生成音频', exact: true }).waitFor();
    await page.getByText('还没有音频生成模型', { exact: true }).waitFor();
    assert.equal(await page.getByRole('textbox', { name: '音色', exact: true }).count(), 0);
    await page.getByRole('tab', { name: '图片', exact: true }).click();
    await chooseAction(2, '手动填写');
    assert.equal(await ordered(2).getByRole('textbox').inputValue(), 'Image: opaque/@Raw 01');
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await page.getByRole('button', { name: '保存中…', exact: true }).waitFor();
    assert(await modelOpener(1).isDisabled());
    assert.equal(typeof finishSave, 'function');
    await finishSave(); await page.getByText('已保存', { exact: true }).waitFor();
    assert.deepEqual(requests, [{ revision: 8, settings: {
      image: { enabled: true, routes: [...image.routes, { providerId, modelId: 'Image: opaque/@Raw 01' }, { providerId, modelId: 'Image:/@Edit' }] },
    } }]);
    assert.deepEqual(saved.video, video);
    assert.deepEqual(saved.audio, audio);
    await openMedia();
    await chooseAction(2, '手动填写');
    assert.equal(await ordered(2).getByRole('textbox').inputValue(), 'Image: opaque/@Raw 01');

    await page.getByRole('tab', { name: '音频', exact: true }).click();
    await page.getByRole('button', { name: '添加模型', exact: true }).click();
    const voice = ordered(1).getByRole('textbox', { name: '音色名称 1', exact: true });
    assert.equal(await ordered(1).getByRole('button', { name: '添加音色' }).count(), 0);
    await ordered(1).getByRole('button', { name: /^模型供应商 / }).click();
    await page.getByRole('option', { name: 'RouterGo 测试', exact: true }).click();
    await ordered(1).getByRole('button', { name: /^模型 ID / }).click();
    await page.getByRole('option', { name: /合成语音/ }).click();
    const addVoice = ordered(1).getByRole('button', { name: '添加音色', exact: true });
    await addVoice.click();
    await voice.focus();
    await voice.pressSequentially('Exact/Voice-v2');
    await ordered(1).getByRole('textbox', { name: '听感说明 1' }).fill('低音女声，适合故事');
    await addVoice.click();
    await ordered(1).getByRole('textbox', { name: '音色名称 2' }).fill('Exact/Voice-v3');
    await ordered(1).getByRole('textbox', { name: '听感说明 2' }).fill('清亮男声');
    const secondDefault = ordered(1).getByRole('radio', { name: '将音色 2设为默认' });
    await secondDefault.check();
    await page.getByRole('switch', { name: '在对话中生成音频', exact: true }).click();
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await page.getByRole('button', { name: '保存中…', exact: true }).waitFor();
    assert(await voice.isDisabled());
    await finishSave();
    await page.getByText('已保存', { exact: true }).waitFor();
    assert.deepEqual(requests.at(-1), { revision: 9, settings: {
      audio: { enabled: true, routes: [{ providerId, modelId: 'Audio:/@Exact', voices: [
        { name: 'Exact/Voice-v2', description: '低音女声，适合故事' }, { name: 'Exact/Voice-v3', description: '清亮男声' },
      ], defaultVoice: 'Exact/Voice-v3' }] },
    } });
    await openMedia();
    await page.getByRole('tab', { name: '音频', exact: true }).click();
    await voice.waitFor();
    assert.equal(await voice.inputValue(), 'Exact/Voice-v2');
    assert(await secondDefault.isChecked());
    for (const width of [1100, 390]) for (const dark of [false, true]) {
      await page.setViewportSize({ width, height: 900 });
      await device.send('Emulation.setTouchEmulationEnabled', { enabled: width === 390 });
      await page.evaluate(dark => { document.documentElement.dataset.dark = dark; document.body.toggleAttribute('data-ds-dark-theme', dark); }, dark);
      const input = await voice.boundingBox();
      const model = await ordered(1).getByRole('button', { name: /^模型 ID / }).boundingBox();
      assert(input.y >= model.y + model.height);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (width === 390) assert(input.height >= 44);
      await shot('audio-data', width, dark);
    }
    await ordered(1).getByRole('button', { name: '移除音色 2' }).click();
    assert(await ordered(1).getByRole('radio', { name: '将音色 1设为默认' }).isChecked());
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await page.getByRole('button', { name: '保存中…', exact: true }).waitFor();
    await finishSave();
    await page.getByText('已保存', { exact: true }).waitFor();
    assert.equal(requests.at(-1).settings.audio.routes[0].defaultVoice, 'Exact/Voice-v2');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
