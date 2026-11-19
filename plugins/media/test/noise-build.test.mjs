import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { buildNoise } from '../scripts/build-noise.mjs';

test('noise assets build offline, preserve the reviewed WASM and run as a standalone worklet', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-noise-build-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await buildNoise({ output: directory });
  const [wasm, script, licenses] = await Promise.all(['rnnoise.wasm', 'noise-worklet.js', 'NOISE-LICENSES.txt'].map(name => readFile(join(directory, name))));
  assert.equal(createHash('sha256').update(wasm).digest('hex'), '4f513a50613de74378331237886138eab52fa2650e8b1a41eb587d932d9b8850');
  assert.match(licenses.toString(), /Apache License[\s\S]*Version 2\.0[\s\S]*END OF TERMS AND CONDITIONS/);
  for (const name of ['Amazon', 'Mozilla', 'Jean-Marc Valin', 'Xiph.Org Foundation', 'Mark Borgerding']) assert.ok(licenses.includes(name));
  assert.match(licenses.toString(), /Neither the name[\s\S]*THIS SOFTWARE IS PROVIDED/);
  const module = await WebAssembly.compile(wasm), messages = [];
  let Processor;
  vm.runInNewContext(script.toString(), {
    WebAssembly, sampleRate: 48000,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: message => messages.push(message) }; } },
    registerProcessor: (name, implementation) => { assert.equal(name, 'voice-noise-capture'); Processor = implementation; },
    fetch() { throw Error('A worklet must not download remote assets'); },
  });
  const processor = new Processor({ processorOptions: { module } });
  assert.equal(messages[0].type, 'ready');
  for (let i = 0; i < 100; i++) processor.process([[new Float32Array(128)]]);
  assert.ok(messages.some(message => message.type === 'pcm' && message.data.byteLength === 960 && Number.isFinite(message.probability)));
  assert.ok(messages.every(message => message.type !== 'error'));
  processor.port.onmessage({ data: { type: 'destroy' } });
  assert.equal(processor.process([]), false);
  await buildNoise({ output: directory });
  assert.deepEqual(await readFile(join(directory, 'noise-worklet.js')), script);
  assert.deepEqual(await readFile(join(directory, 'rnnoise.wasm')), wasm);
});
