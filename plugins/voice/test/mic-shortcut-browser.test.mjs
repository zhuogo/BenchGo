import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
const { chromium } = require('playwright');
const { build } = createRequire(new URL('../../benchgo/package.json', import.meta.url))('esbuild');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || [chromium.executablePath(), 'C:/Users/DraftGo/AppData/Local/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-win64/chrome-headless-shell.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);

// The official keyboard adapter and registry are the production code; only the Voice controller is a recorder.
async function fixture() {
  const result = await build({ stdin: { resolveDir: root, loader: 'js', contents: `
    import {installKeyboard,detectEnvironment} from './deepseek-harness/packages/client/shortcuts/src/client/dom.ts';
    import {ShortcutRegistry} from './deepseek-harness/packages/client/shortcuts/src/client/registry.ts';
    import {createMicTargets,installMicShortcut} from './plugins/voice/client/mic-shortcut.mjs';
    const environment=detectEnvironment(document,navigator),registry=new ShortcutRegistry(environment.runtime,environment.platform),listeners=new Set();
    installKeyboard(window,registry,input=>{for(const listener of listeners)listener(input);});
    const shortcuts={registerFixed:command=>registry.registerFixed(command),observeFixedInput:listener=>{listeners.add(listener);return()=>listeners.delete(listener);}};
    window.actions=[];window.voice={mode:'idle',phase:'idle',sessionId:'s'};
    const targets=createMicTargets();
    targets.add({element:()=>document.getElementById('activity'),actions:()=>({sessionId:'s',ready:()=>true,
      start:()=>{window.actions.push('start');window.voice.mode='dictation';},keep:()=>window.actions.push('keep'),
      send:()=>{window.actions.push('send');window.voice.mode='idle';},stop:()=>{window.actions.push('stop');window.voice.mode='idle';}})});
    installMicShortcut({shortcuts,controller:{state:{getSnapshot:()=>window.voice},toggleMute:()=>window.actions.push('mute')},targets,holdMs:250});
    window.fixedRows=()=>registry.fixedCatalog.getSnapshot().map(row=>[row.id,row.keys.join('+')]);
  ` }, bundle: true, write: false, format: 'iife', logLevel: 'silent',
    nodePaths: [join(root, 'plugins/benchgo/node_modules'), join(root, 'deepseek-harness/apps/web/node_modules')],
    alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')), '@deepseek-ai/dsh-client-ui-primitives': join(root, 'deepseek-harness/packages/client/ui-primitives/src/index.ts') },
    outdir: join(root, 'artifacts/unused-mic-shortcut'), jsx: 'automatic', loader: { '.css': 'text', '.module.css': 'local-css', '.svg': 'text' }, define: { 'process.env.NODE_ENV': '"production"' } });
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body>
    <main data-conversation-session="s"><p id="page" tabindex="0">对话内容</p><button id="other">其他按钮</button>
      <div id="editor" contenteditable="true" role="textbox"></div><input id="field"><div id="activity">语音</div></main>
    <script>
      // Dialogs mount and unmount like the product's portals; the official adapter reads the live DOM.
      window.dialog = (name, open) => {
        document.getElementById(name)?.remove(); if (!open) return;
        const node = document.createElement('section'); node.id = name; node.setAttribute('role', 'dialog'); node.setAttribute('aria-modal', 'true');
        node.dataset.shortcutModal = name; node.innerHTML = '<button id="' + name + '-button">按钮</button>'; document.body.append(node);
      };
    </script>
    <script>${result.outputFiles.find(file => file.path.endsWith('.js')).text.replaceAll('</script>', '<\\/script>')}</script></body></html>`;
}

test('bare M through the official keyboard adapter: page focus acts, text input types, hold sends on release', { timeout: 60000 }, async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage(), errors = []; page.setDefaultTimeout(6000); page.on('pageerror', failure => errors.push(failure.message));
    const html = await fixture(); await page.route('**/*', route => route.request().url() === 'http://localhost/' ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort()); await page.goto('http://localhost/');
    const actions = () => page.evaluate(() => window.actions), reset = state => page.evaluate(state => { window.actions = []; window.voice = { mode: 'idle', phase: 'idle', sessionId: 's', ...state }; }, state || {});
    assert.deepEqual(await page.evaluate(() => window.fixedRows()), [['voice.microphone', 'M']]);

    // In text input M is a letter, in both the composer and an ordinary field.
    await page.locator('#editor').click(); await page.keyboard.type('mm');
    await page.locator('#field').click(); await page.keyboard.type('m');
    assert.equal(await page.locator('#editor').innerText(), 'mm'); assert.equal(await page.locator('#field').inputValue(), 'm');
    assert.deepEqual(await actions(), []);

    // Outside text input a tap dictates into the draft; the next tap stops.
    await page.locator('#page').focus(); await page.keyboard.press('m');
    assert.deepEqual(await actions(), ['start', 'keep']);
    await page.locator('#other').focus(); await page.keyboard.press('m');
    assert.deepEqual(await actions(), ['start', 'keep', 'stop']);
    for (const chord of ['Control+m', 'Shift+m', 'Alt+m']) await page.keyboard.press(chord);
    assert.deepEqual(await actions(), ['start', 'keep', 'stop']);

    // Holding sends once on release; the browser's key repeat neither restarts nor types.
    await reset(); await page.locator('#page').focus();
    await page.keyboard.down('m'); await page.keyboard.down('m'); await page.keyboard.down('m');
    await page.waitForTimeout(400); await page.keyboard.down('m'); await page.keyboard.up('m');
    assert.deepEqual(await actions(), ['start', 'send']);

    // A release that lands while the window is unfocused must not send.
    await reset(); await page.locator('#page').focus(); await page.keyboard.down('m'); await page.waitForTimeout(400);
    await page.evaluate(() => window.dispatchEvent(new Event('blur'))); await page.keyboard.up('m');
    assert.deepEqual(await actions(), ['start', 'stop']);

    // In a call M mutes, including inside the call stage dialog, but not under another dialog or while typing.
    await reset({ mode: 'call', phase: 'listening', sessionId: 'elsewhere' });
    await page.locator('#page').focus(); await page.keyboard.press('m');
    await page.evaluate(() => window.dialog('voice-call', true)); await page.locator('#voice-call-button').focus(); await page.keyboard.press('m');
    assert.deepEqual(await actions(), ['mute', 'mute']);
    await page.evaluate(() => window.dialog('settings', true)); await page.locator('#settings-button').focus(); await page.keyboard.press('m');
    await page.evaluate(() => { window.dialog('settings', false); window.dialog('voice-call', false); });
    await page.locator('#editor').click(); await page.keyboard.type('m');
    assert.deepEqual(await actions(), ['mute', 'mute']); assert.equal(await page.locator('#editor').innerText(), 'mmm');

    // Dictation never starts under a dialog, and works again once it closes.
    await reset(); await page.evaluate(() => window.dialog('settings', true));
    await page.locator('#settings-button').focus(); await page.keyboard.press('m');
    assert.deepEqual(await actions(), []);
    await page.evaluate(() => window.dialog('settings', false)); await page.locator('#page').focus(); await page.keyboard.press('m');
    assert.deepEqual(await actions(), ['start', 'keep']);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
