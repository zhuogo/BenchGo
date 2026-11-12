import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../../deepseek-harness/apps/web/package.json', import.meta.url));
const { chromium } = require('playwright');
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || [chromium.executablePath(), 'C:/Users/DraftGo/AppData/Local/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-win64/chrome-headless-shell.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);

test('real Web Audio cues are quiet, brief, ascending/descending and release their nodes/context', async () => {
  const browser = await chromium.launch({ headless: true, executablePath, args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    const page = await browser.newPage();
    const source = await readFile(new URL('../client/call-cues.mjs', import.meta.url), 'utf8');
    const result = await page.evaluate(async source => {
      const { playCallCue } = await import(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
      const samples = [];
      for (const kind of ['connected', 'disconnected', 'cancelled']) {
        const offline = new OfflineAudioContext(1, 48000 * .4, 48000);
        const context = { state: 'running', currentTime: 0, destination: offline.destination, createOscillator: () => offline.createOscillator(), createGain: () => offline.createGain() };
        const cue = playCallCue(kind, { context });
        if (kind === 'cancelled') cue.cancel();
        const buffer = await offline.startRendering(); await cue.finished;
        const data = buffer.getChannelData(0);
        let peak = 0, first = -1, last = -1;
        for (let i = 0; i < data.length; i++) { const value = Math.abs(data[i]); peak = Math.max(peak, value); if (value > .00001) { if (first < 0) first = i; last = i; } }
        const frequency = (from, to) => { let crossings = 0; for (let i = Math.floor(from * 48000); i < Math.floor(to * 48000); i++) if (data[i] <= 0 && data[i + 1] > 0) crossings++; return crossings / (to - from); };
        samples.push({ kind, peak, first: first / 48000, last: last / 48000, frequencies: [frequency(.025, .1), frequency(.15, .225)] });
      }
      const Original = window.AudioContext, contexts = [];
      window.AudioContext = class extends Original { constructor() { super(); contexts.push(this); } };
      const ended = playCallCue('disconnected'); await ended.finished;
      await new Promise(resolve => setTimeout(resolve, 10));
      const ownedState = contexts[0].state;
      const shared = new Original(); await shared.resume();
      const connected = playCallCue('connected', { context: shared }); await connected.finished;
      const sharedState = shared.state; await shared.close();
      window.AudioContext = Original;
      return { samples, ownedState, sharedState };
    }, source);
    for (const row of result.samples.slice(0, 2)) {
      assert.ok(row.peak > .03 && row.peak <= .046, JSON.stringify(row));
      assert.ok(row.first >= .007 && row.last < .26, JSON.stringify(row));
    }
    assert.ok(result.samples[0].frequencies[0] < result.samples[0].frequencies[1]);
    assert.ok(result.samples[1].frequencies[0] > result.samples[1].frequencies[1]);
    assert.equal(result.samples[2].peak, 0);
    assert.equal(result.ownedState, 'closed'); assert.equal(result.sharedState, 'running');
  } finally { await browser.close(); }
});
