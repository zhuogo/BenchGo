import { build } from 'esbuild';
import { mkdir, copyFile, readFile, writeFile, cp, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
export async function buildPreview() {
  const out = new URL('../lib/preview/', import.meta.url);
  await mkdir(out, { recursive: true });
  await build({ entryPoints: ['markdown', 'docx', 'sheet-worker', 'pdf'].map(name => fileURLToPath(new URL(`../client/preview/${name}.mjs`, import.meta.url))), outdir: fileURLToPath(out), bundle: true, format: 'esm', platform: 'browser', minify: true, target: 'es2022', legalComments: 'eof' });
  await copyFile(require.resolve('pdfjs-dist/build/pdf.worker.min.mjs'), new URL('pdf-worker.js', out));
  const resources = [];
  const pdfRoot = dirname(require.resolve('pdfjs-dist/package.json'));
  for (const folder of ['cmaps', 'standard_fonts', 'wasm']) {
    await cp(join(pdfRoot, folder), new URL(folder + '/', out), { recursive: true });
    for (const file of await readdir(join(pdfRoot, folder))) resources.push(`${folder}/${file}`);
  }
  await writeFile(new URL('resources.json', out), JSON.stringify(resources));
  const licenses = [];
  for (const [name, file] of [['marked', 'LICENSE'], ['dompurify', 'LICENSE'], ['docx-preview', 'LICENSE'], ['jszip', 'LICENSE.markdown'], ['xlsx', 'LICENSE'], ['pdfjs-dist', 'LICENSE'], ['pako', 'LICENSE'], ['lie', 'license.md'], ['immediate', 'LICENSE.txt'], ['setimmediate', 'LICENSE.txt'], ['readable-stream', 'LICENSE'], ['safe-buffer', 'LICENSE'], ['string_decoder', 'LICENSE'], ['core-util-is', 'LICENSE'], ['inherits', 'LICENSE'], ['isarray', 'README.md'], ['process-nextick-args', 'license.md'], ['util-deprecate', 'LICENSE']]) {
    let base;
    try { base = dirname(require.resolve(`${name}/package.json`)); }
    catch (error) {
      if (error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
        base = dirname(require.resolve(name));
        while (true) {
          try { const pkg = JSON.parse(await readFile(join(base, 'package.json'), 'utf8')); if (pkg.name === name) break; } catch {}
          const parent = dirname(base); if (parent === base) throw error; base = parent;
        }
      } else base = dirname(createRequire(require.resolve('jszip')).resolve(`${name}/package.json`));
    }
    licenses.push(`## ${name}\n\n${await readFile(join(base, file), 'utf8')}`);
  }
  await writeFile(new URL('LICENSES.txt', out), licenses.join('\n\n'));
  console.log('BenchGo preview renderers built (lazy assets)');
}
