import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
const { chromium } = require('playwright');
const { build } = createRequire(new URL('../../benchgo/package.json', import.meta.url))('esbuild');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || [chromium.executablePath(),
  'C:/Users/DraftGo/AppData/Local/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-win64/chrome-headless-shell.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);

async function fixture() {
  const result = await build({ stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';
    import {MediaSettings} from './plugins/voice/client/index.jsx';
    import {moduleSource} from './plugins/benchgo/client/modules.mjs';
    import {installIconSprite} from './deepseek-harness/packages/client/ui-theme/src/client/icon-sprite.ts';
    installIconSprite({effect:fn=>fn(),on:()=>{}},undefined);
    moduleSource.update({base:true,voice:true,superagent:true});
    const root=createRoot(document.getElementById('root'));let serial=0;
    window.renderSettings=(scenario='data')=>{
      window.scenario=scenario;window.saved=[];window.loads=0;
      let state={config:['loading','error'].includes(scenario)?null:{dictation:true,readAloud:true,call:true,
        asr:{providerId:'Cloud/@01',model:'ASR/@01',configured:true,apiType:scenario==='legacy'?'auto':scenario==='unconfigured'?'':'openai',protocol:scenario==='legacy'?'auto':scenario==='unconfigured'?'':'transcriptions-sse'},
        tts:{providerId:'Cloud/@01',model:'TTS/@01',configured:true,apiType:'openai',protocol:'speech-stream',stream:true,voice:'original-voice',speed:1.2},
        conversation:scenario==='empty'?{}:{providerId:'Cloud/@01',model:'Exact Model:01',configured:true}},error:scenario==='error'?'语音配置暂不可用':''};
      if(scenario==='saved')state.config=window.voiceSnapshot;
      const listeners=new Set(),controller={state:{getSnapshot:()=>state,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)}},
        load:async()=>{window.loads++},configure:async patch=>{window.saved.push(patch);state={...state,config:{...state.config,...patch,conversation:{...state.config.conversation,...patch.conversation},asr:{...state.config.asr,...patch.asr},tts:{...state.config.tts,...patch.tts}}};window.voiceSnapshot=structuredClone(state.config);listeners.forEach(fn=>fn());return state.config}};
      root.render(<MediaSettings key={++serial} controller={controller}/>);
    };
  ` }, bundle: true, write: false, outdir: join(root, 'artifacts/unused-voice-settings'), format: 'iife', jsx: 'automatic',
    nodePaths: [join(root, 'plugins/benchgo/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
    alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')),
      '@deepseek-ai/dsh-client-ui-primitives': join(root, 'deepseek-harness/packages/client/ui-primitives/src/index.ts') },
    plugins: [{ name: 'fixture-export', setup(build) { build.onLoad({ filter: /voice[\\/]client[\\/]index\.jsx$/ }, async args => ({ contents: await readFile(args.path, 'utf8') + '\nexport { MediaSettings };', loader: 'jsx' })); } }],
    loader: { '.css': 'text', '.module.css': 'local-css', '.svg': 'text' }, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  const script = result.outputFiles.find(file => file.path.endsWith('.js')).text;
  const css = await readFile(new URL('../../benchgo/client/style.css', import.meta.url), 'utf8') + await readFile(new URL('../client/style.css', import.meta.url), 'utf8') + await readFile(new URL('../client/media-settings.css', import.meta.url), 'utf8') + result.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n');
  const theme = (await Promise.all(['base.css', 'design-platform.css', 'focus.css'].map(name => readFile(join(root, 'deepseek-harness/packages/client/ui-theme/src/styles', name), 'utf8')))).join('\n');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
    ${theme}:root,body{color-scheme:light;--dsw-alias-bg-base:#fafafa;--dsw-alias-bg-layer-2:#fff;--dsw-alias-label-primary:#242424;--dsw-alias-label-secondary:#797b83;--dsw-alias-state-business-primary:#4d6bfe}html[data-dark=true],html[data-dark=true] body{color-scheme:dark;--dsw-alias-bg-base:#191a1e;--dsw-alias-bg-layer-2:#202126;--dsw-alias-label-primary:#ededee;--dsw-alias-label-secondary:#a3a5af}body{margin:0;padding:24px;font-family:Arial,"Microsoft YaHei",sans-serif;background:var(--dsw-alias-bg-base)}.voice-settings{margin:auto}${css}
    </style></head><body><div id="root"></div><script>${script.replaceAll('</script', '<\\/script')}</script></body></html>`;
}

test('voice settings render four states and save exact conversation model without replacing ASR or TTS', { skip: !executablePath && 'Chromium/Edge required' }, async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  const screenshots = process.env.BENCHGO_VOICE_SETTINGS_SCREENSHOTS;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  try {
    const page = await browser.newPage(), errors = []; page.setDefaultTimeout(6000); page.on('pageerror', failure => errors.push(failure.message));
    const html = await fixture();
    await page.route('**/*', async route => {
      if (route.request().url() === 'http://localhost/') return route.fulfill({ contentType: 'text/html', body: html });
      if (route.request().url().endsWith('/api/commander/tooling')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ providers: await page.evaluate(() => window.scenario) === 'empty' ? [] : [{id:'Cloud/@01',name:'已配置供应商',configured:true}], models: [
        { id: 'Exact Model:01', name: '轻量模型一', kinds: ['text'] }, { id: 'Exact Model:02/@raw', name: '轻量模型二', kinds: ['text'] },
        { id: 'ASR/@01', name: '语音识别', kinds: ['asr'] }, { id: 'TTS/@01', name: '语音合成', kinds: ['tts'] }] }) });
      if (route.request().url().endsWith('/api/commander/assistant')) {
        const scenario = await page.evaluate(() => window.scenario);
        if (scenario === 'loading') return route.fulfill({ contentType: 'application/json', body: '{}' });
        if (scenario === 'error') return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({error:'图片配置暂不可用'}) });
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({config:{revision:8,image:scenario==='empty'?null:{providerId:'Cloud/@01',modelId:'Exact Model:01'}},media:{image:{available:scenario!=='empty'}}}) });
      }
      return route.abort();
    });
    await page.goto('http://localhost/');
    for (const width of [1440, 390]) for (const dark of [false, true]) {
      await page.setViewportSize({ width, height: 900 }); await page.evaluate(dark => document.documentElement.dataset.dark = dark, dark);
      for (const scenario of ['loading', 'error', 'empty', 'data']) {
        await page.evaluate(scenario => window.renderSettings(scenario), scenario);
        if (scenario === 'loading') await page.getByRole('status', { name: '正在加载图片设置…' }).waitFor();
        else if (scenario === 'error') await page.getByText('图片配置暂不可用', {exact:true}).waitFor();
        else await page.getByRole('switch', {name:'在对话中生成图片',exact:false}).waitFor();
        if (screenshots) await page.screenshot({path:join(screenshots, `image-${scenario}-${width}-${dark?'dark':'light'}.png`),fullPage:true});
        await page.getByRole('tab', {name:'语音',exact:true}).click();
        const navPositions = await page.evaluate(() => [...document.querySelectorAll('.media-settings-navigation [role=tablist]')].map(el => ({top:el.getBoundingClientRect().top,left:el.getBoundingClientRect().left})));
        assert.equal(navPositions.length, 2);
        if (width > 600) assert.equal(navPositions[0].top, navPositions[1].top);
        else assert(navPositions[1].top > navPositions[0].top);
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
            await page.getByRole('tab', {name:'图片',exact:true}).click();
            await page.getByRole('tab', {name:'语音',exact:true}).click();
            assert.equal(await page.getByRole('textbox', {name:'音色',exact:true}).inputValue(), 'New Voice/@raw');
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
        if (route.request().url().endsWith('/api/commander/assistant')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ config: { revision: 8 }, media: {} }) });
        return route.abort();
      });
      await page.goto('http://localhost/');
      await page.evaluate(() => { window.renderSettings('data'); document.getElementById('root').setAttribute('role', 'dialog'); });
      await page.addStyleTag({ content: 'body{padding:0;overflow:hidden}#root{position:fixed;inset:16px;overflow:hidden}.media-settings{height:100%;overflow:auto;padding:16px 24px}.media-settings .voice-settings-content>footer{position:sticky;bottom:0;z-index:200;background:var(--dsw-alias-bg-base);padding:18px 0}.voice-settings-content{padding-bottom:12px}' });
      await page.getByRole('tab', { name: '语音', exact: true }).click();
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
      if (url.endsWith('/api/commander/assistant')) return route.fulfill({ json: { config: { revision: 8 }, media: {} } });
      if (url.endsWith('/api/voice')) {
        const input = route.request().postDataJSON(); requests.push(input);
        const result = { status: input.action === 'protocol.test' ? 'inconclusive' : 'supported', apiType: 'stepfun', protocol: 'stepfun-sse', message: input.action === 'protocol.test' ? '认证失败，请检查密钥' : '已按首输出延迟选择', attempts: input.action === 'protocol.test' ? [{ protocol: 'stepfun-sse', status: 'inconclusive', message: '认证失败' }] : [{ protocol: 'stepfun-sse', status: 'supported', firstOutputMs: 127, completionMs: 200, message: '接口可用' }, { protocol: 'transcriptions', status: 'not-tested', message: '用途限制，未测试' }] };
        if (hold) { hold = false; pending = () => route.fulfill({ json: { result } }).catch(() => {}); return; }
        return route.fulfill({ json: { result } });
      }
      return route.abort();
    });
    await page.goto('http://localhost/'); await page.evaluate(() => window.renderSettings('legacy'));
    await page.getByRole('tab', { name: '语音', exact: true }).click();
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
    await page.getByRole('tab', { name: '语音', exact: true }).click();
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
      if (url.endsWith('/api/commander/assistant')) return route.fulfill({ json: { config: { revision: 8 }, media: {} } });
      if (url.endsWith('/api/voice')) {
        const input = route.request().postDataJSON(); requests.push(input);
        const result = { status: 'supported', apiType: 'openai', protocol: input.kind === 'tts' ? 'speech' : 'transcriptions-sse', attempts: [] };
        if (hold) { hold = false; pending = () => route.fulfill({ json: { result } }).catch(() => {}); return; }
        return route.fulfill({ json: { result } });
      }
      return route.abort();
    });
    await page.goto('http://localhost/'); await page.evaluate(() => window.renderSettings('unconfigured'));
    await page.getByRole('tab', { name: '语音', exact: true }).click();
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

test('media model icon tools align with every model field, preserve opaque IDs and retain loading and save guards', { skip: !executablePath && 'Chromium/Edge required' }, async () => {
  const browser = await chromium.launch({ executablePath, headless: true }), html = await fixture();
  const screenshots = process.env.BENCHGO_VOICE_SETTINGS_SCREENSHOTS;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  try {
    const page = await browser.newPage({ reducedMotion: 'reduce' }), errors = [];
    page.setDefaultTimeout(6000); page.on('pageerror', error => errors.push(error.message));
    let holdModels = false, pendingModels = [], pendingSave, holdSave = false;
    let imageConfig = { revision: 8, name: '保留其他配置', image: { providerId: 'Cloud/@01', modelId: 'Exact Model:01', protocol: 'openai-compatible' }, auxiliary: { opaque: 'untouched/@' } };
    const requests = [];
    await page.route('**/*', async route => {
      const url = route.request().url();
      if (url === 'http://localhost/') return route.fulfill({ contentType: 'text/html', body: html });
      if (url.endsWith('/api/commander/tooling')) {
        const input = route.request().postDataJSON();
        const json = { providers: [{ id: 'Cloud/@01', name: '已配置供应商', configured: true }], models: [
          { id: 'Exact Model:01', name: '轻量模型一', kinds: ['text'] },
          { id: 'ASR/@01', name: '语音识别', kinds: ['asr'] }, { id: 'TTS/@01', name: '语音合成', kinds: ['tts'] },
        ] };
        if (input.action === 'models' && holdModels) { pendingModels.push(() => route.fulfill({ json }).catch(() => {})); return; }
        return route.fulfill({ json });
      }
      if (url.endsWith('/api/commander/assistant')) {
        const input = route.request().postDataJSON(); requests.push(input);
        if (input.action === 'config') {
          const finish = () => { imageConfig = { ...imageConfig, ...input.patch, image: { ...imageConfig.image, ...input.patch.image }, revision: imageConfig.revision + 1 }; return route.fulfill({ json: imageConfig }).catch(() => {}); };
          if (holdSave) { pendingSave = finish; return; }
          return finish();
        }
        return route.fulfill({ json: { config: imageConfig, media: { image: { available: true } } } });
      }
      return route.abort();
    });
    await page.goto('http://localhost/');
    const navigate = async target => {
      if (target === 'image') return page.getByRole('tab', { name: '图片', exact: true }).click();
      await page.getByRole('tab', { name: '语音', exact: true }).click();
      await page.getByRole('tab', { name: target === 'asr' ? '语音转文本' : target === 'tts' ? '朗读' : '实时通话', exact: true }).click();
      if (target.startsWith('call-')) await page.getByRole('tab', { name: target === 'call-asr' ? '语音识别' : target === 'call-tts' ? '语音合成' : '交互模型', exact: true }).click();
    };
    const row = () => page.locator('.voice-model-field:visible');
    const shot = async name => { if (screenshots) await page.screenshot({ path: join(screenshots, name + '.png'), fullPage: true }); };
    for (const width of [1100, 390]) for (const dark of [false, true]) {
      await page.setViewportSize({ width, height: 900 }); await page.evaluate(dark => { document.documentElement.dataset.dark = dark; window.renderSettings('data'); }, dark);
      const title = page.getByRole('heading', { name: '媒体', exact: true }); await title.waitFor();
      const titleBox = await title.boundingBox(), tabsBox = await page.getByRole('tablist', { name: '媒体类型', exact: true }).boundingBox();
      assert(Math.abs(titleBox.y + titleBox.height / 2 - tabsBox.y - tabsBox.height / 2) < 2, 'media title and primary tabs align vertically');
      for (const target of ['image', 'asr', 'tts', 'call-conversation', 'call-asr', 'call-tts']) {
        await navigate(target); await row().waitFor();
        const refresh = row().getByRole('button', { name: '刷新列表', exact: true });
        await page.waitForFunction(() => { const buttons = [...document.querySelectorAll('.voice-model-field button[aria-label="刷新列表"]')].filter(button => button.checkVisibility()); return buttons.length > 0 && buttons.every(button => !button.disabled); });
        assert.equal((await refresh.textContent()).trim(), '');
        assert.equal((await row().getByRole('button', { name: '手动填写', exact: true }).textContent()).trim(), '');
        const positions = await row().evaluate(node => {
          const field = node.querySelector('.voice-select-trigger,input'), tool = node.querySelector('[aria-label="刷新列表"]');
          const a = field.getBoundingClientRect(), b = tool.getBoundingClientRect();
          return { fieldBottom: a.bottom, toolBottom: b.bottom, fieldRight: a.right, toolLeft: b.left };
        });
        assert(Math.abs(positions.fieldBottom - positions.toolBottom) <= 4 && positions.fieldRight <= positions.toolLeft, JSON.stringify({ target, width, positions }));
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), target + ' must fit narrow screens');
        await shot(`tools-${target}-${width}-${dark ? 'dark' : 'light'}`);
      }
    }
    await navigate('image');
    const refresh = row().getByRole('button', { name: '刷新列表', exact: true });
    await refresh.hover(); await page.getByRole('tooltip').getByText('刷新列表', { exact: true }).waitFor();
    assert.equal(await page.getByRole('tooltip').evaluate(node => getComputedStyle(node).position), 'fixed');
    await shot('tools-tooltip-mobile-dark');
    holdModels = true; await refresh.click();
    await page.waitForFunction(() => document.querySelector('.voice-model-field button[aria-label="刷新列表"]')?.disabled === true);
    assert.equal(await refresh.getAttribute('aria-busy'), 'true');
    await row().getByRole('button', { name: '手动填写', exact: true }).click();
    assert.equal(await row().getByRole('textbox').inputValue(), 'Exact Model:01');
    holdModels = false; await Promise.all(pendingModels.splice(0).map(finish => finish()));
    await page.waitForFunction(() => document.querySelector('.voice-model-field button[aria-label="刷新列表"]')?.disabled === false);
    await row().getByRole('textbox').fill('Image: opaque/@Raw 01');
    await row().getByRole('button', { name: '从列表选择', exact: true }).click();
    await row().getByRole('button', { name: '手动填写', exact: true }).click();
    assert.equal(await row().getByRole('textbox').inputValue(), 'Image: opaque/@Raw 01');
    holdSave = true; await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await page.getByRole('button', { name: '保存中…', exact: true }).waitFor();
    assert(await refresh.isDisabled()); assert(await row().getByRole('button', { name: '从列表选择', exact: true }).isDisabled());
    holdSave = false; await pendingSave(); await page.getByText('已保存', { exact: true }).waitFor();
    assert.deepEqual(requests.find(input => input.action === 'config').patch, { image: { modelId: 'Image: opaque/@Raw 01' } });
    assert.deepEqual(imageConfig.auxiliary, { opaque: 'untouched/@' });
    await page.evaluate(() => window.renderSettings('data')); await row().waitFor();
    await row().getByRole('button', { name: '手动填写', exact: true }).click();
    assert.equal(await row().getByRole('textbox').inputValue(), 'Image: opaque/@Raw 01');
    imageConfig = { ...imageConfig, image: null };
    await page.evaluate(() => window.renderSettings('data'));
    await page.getByRole('switch', { name: '在对话中生成图片', exact: false }).click(); await row().waitFor();
    assert(await row().getByRole('button', { name: '刷新列表', exact: true }).isDisabled(), 'refresh needs a provider');
    assert(await row().getByRole('button', { name: '手动填写', exact: true }).isEnabled(), 'manual model input remains available');
    for (const [target, field, original] of [['asr', 'asr', 'ASR/@01'], ['tts', 'tts', 'TTS/@01'], ['call-conversation', 'conversation', 'Exact Model:01']]) {
      await page.evaluate(() => window.renderSettings('data')); await navigate(target); await row().waitFor();
      await row().getByRole('button', { name: '手动填写', exact: true }).click();
      assert.equal(await row().getByRole('textbox').inputValue(), original);
      const exact = `${field}: Exact/@Raw 02`;
      await row().getByRole('textbox').fill(exact);
      await row().getByRole('button', { name: '从列表选择', exact: true }).click();
      await row().getByRole('button', { name: '手动填写', exact: true }).click();
      assert.equal(await row().getByRole('textbox').inputValue(), exact);
      await page.getByRole('button', { name: '保存设置', exact: true }).click(); await page.getByText('已保存', { exact: true }).waitFor();
      assert.deepEqual(await page.evaluate(() => window.saved), [{ [field]: { model: exact } }]);
      await page.evaluate(() => window.renderSettings('saved')); await navigate(target); await row().waitFor();
      await row().getByRole('button', { name: '手动填写', exact: true }).click();
      assert.equal(await row().getByRole('textbox').inputValue(), exact);
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
