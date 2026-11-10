import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../../benchgo/package.json', import.meta.url));
const { build } = require('esbuild');
const voiceRoot = fileURLToPath(new URL('../', import.meta.url));
const dependency = '@jitsi/rnnoise-wasm';
const version = '0.2.1';
const wasmSha256 = '4f513a50613de74378331237886138eab52fa2650e8b1a41eb587d932d9b8850';

/** Bundle local preprocessing resources; no network or runtime package lookup is needed by a browser. */
export async function buildNoise({ output = join(voiceRoot, 'lib') } = {}) {
  const packageRoot = dirname(require.resolve(`${dependency}/package.json`));
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  if (manifest.version !== version) throw new Error(`Review RNNoise ${manifest.version} before changing the pinned WASM ABI`);
  // This package's standalone rnnoise.wasm is the legacy 0.1 detector. The
  // synchronous worklet distribution embeds RNNoise 0.2's denoising model.
  const synchronous = await readFile(join(packageRoot, 'dist/rnnoise-sync.js'), 'utf8');
  const binaries = [...synchronous.matchAll(/base64,([A-Za-z0-9+/=]+)/gu)];
  if (binaries.length !== 1) throw new Error('Review the RNNoise synchronous distribution before extracting its model');
  const wasm = Buffer.from(binaries[0][1], 'base64');
  if (createHash('sha256').update(wasm).digest('hex') !== wasmSha256) throw new Error('RNNoise WASM does not match the reviewed build');
  const result = await build({
    entryPoints: [join(voiceRoot, 'client/noise-worklet.mjs')],
    bundle: true, write: false, minify: true, sourcemap: false,
    format: 'esm', platform: 'browser', target: 'es2022',
    nodePaths: [fileURLToPath(new URL('../../benchgo/node_modules/', import.meta.url))],
    metafile: true, logLevel: 'warning',
  });
  if (Object.values(result.metafile.outputs).some(file => file.imports.length)) throw new Error('Noise worklet must be self-contained');
  const [apache, rnnoise, provenance] = await Promise.all([
    readFile(join(packageRoot, 'LICENSE'), 'utf8'),
    readFile(join(voiceRoot, 'licenses/RNNoise.txt'), 'utf8'),
    readFile(join(voiceRoot, 'licenses/SOURCE.md'), 'utf8'),
  ]);
  await mkdir(output, { recursive: true });
  await Promise.all([
    writeFile(join(output, 'noise-worklet.js'), result.outputFiles[0].contents),
    writeFile(join(output, 'rnnoise.wasm'), wasm),
    writeFile(join(output, 'NOISE-LICENSES.txt'), `${provenance}\n\n## ${dependency}@${version} (Apache-2.0)\n\n${apache}\n\n## RNNoise (BSD-3-Clause)\n\n${rnnoise}`),
  ]);
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`BenchGo voice preprocessing built: ${await buildNoise()}`);
}
