import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { unwrapClient } from '../scripts/vendor-adapter.mjs';
const require = createRequire(new URL('../../benchgo/package.json', import.meta.url));
test('pinned vendor client factories unwrap without introducing another module registration', async () => {
  for (const name of ['@linxin666/dsh-ssh', 'dsh-better-sidebar', '@huanlin/dsh-plugin-better-sidebar-plugin-audio', 'dsh-video-preview']) {
    const adapted = unwrapClient(await readFile(require.resolve(`${name}/client`), 'utf8'), name);
    assert.match(adapted, /module\.exports =/);
    assert.doesNotMatch(adapted, /^window\.__ModuleLoader__\.load/);
    assert.match(adapted, /return module\.exports/);
    if (name.includes('dsh-ssh')) assert.doesNotMatch(adapted, /reportDailyHeartbeat\(\[\{ name:/);
    if (name === 'dsh-better-sidebar') {
      assert.doesNotMatch(adapted, /function SideCardSection|function AddPluginModal|dsh plugin --profile|ctx\.slots\.inject\("settings\.section/);
      assert.doesNotMatch(adapted, /\[dsh-better-sidebar\]/);
    }
    if (name.endsWith('-audio')) {
      assert.match(adapted, /api\/benchgo\/workbench\/media/);
      assert.match(adapted, /BENCHGO_ANALYSIS_RATE = 16000, BENCHGO_ANALYSIS_SAMPLES = 12000000/);
      assert.match(adapted, /duration > 30 \|\| sourceSize > 8388608/);
      assert.match(adapted, /size > limit/);
    }
    new Function('require', 'module', adapted);
  }
});
test('unknown vendor wrappers fail closed for explicit version review', () => {
  assert.throws(() => unwrapClient('export const apply = () => {};', 'dsh-better-sidebar'), /Unsupported/);
});

test('audio PCM analysis rejects excess allocation before reading channel arrays', async () => {
  const source = await readFile(require.resolve('@huanlin/dsh-plugin-better-sidebar-plugin-audio/client'), 'utf8');
  const adapted = unwrapClient(source, '@huanlin/dsh-plugin-better-sidebar-plugin-audio').replace('exports.apply = apply;', 'exports.apply = apply; exports.testDecode = decodeAudio; exports.testAllowed = benchgoAnalysisAllowed;');
  const module = { exports: {} };
  new Function('require', 'module', adapted)(() => ({}), module);
  const { testDecode, testAllowed } = module.exports;
  assert.equal(typeof testDecode, 'function');
  for (const duration of [0, -1, 90, 600, Infinity, NaN]) assert.equal(testAllowed(duration), false);
  assert.equal(testAllowed(30), true);
  assert.equal(testAllowed(80), true);
  for (const overrides of [{ length: 6000001, numberOfChannels: 1 }, { numberOfChannels: 9 }, { sampleRate: 44100 }, { length: Infinity }]) {
    let read = 0, closed = 0;
    const buffer = { length: 16, numberOfChannels: 1, sampleRate: 16000, getChannelData() { read++; throw Error('must not allocate/read channels'); }, ...overrides };
    await assert.rejects(testDecode(new ArrayBuffer(1), { contextFactory: () => ({ decodeAudioData: async () => buffer, close: async () => { closed++; } }) }), /波形内存预算/);
    assert.equal(read, 0); assert.equal(closed, 1);
  }
  let read = 0, closed = 0;
  const controller = new AbortController(); controller.abort();
  const contextFactory = () => ({ decodeAudioData: async () => ({ length: 16, numberOfChannels: 1, sampleRate: 16000, getChannelData() { read++; return new Float32Array(16); } }), close: async () => { closed++; } });
  await assert.rejects(testDecode(new ArrayBuffer(1), { contextFactory, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(read, 0); assert.equal(closed, 1);
  const decoded = await testDecode(new ArrayBuffer(1), { contextFactory, columns: 4 });
  assert.equal(decoded.sampleRate, 16000); assert.equal(decoded.peaks.length, 1); assert.equal(decoded.mono.length, 16);
  assert.equal(read, 1); assert.equal(closed, 2);
});
