import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Link runs without the desktop module loader. Bundle only the original public
// source roots explicitly exported by the pinned official packages; never copy
// a primitive or reach through one of its private component files.
export async function officialUiEntries() {
  const entries = {};
  for (const directory of ['client/ui-primitives', 'client/store', 'util/workspace-path', 'util/code-language']) {
    const root = new URL(`../../../deepseek-harness/packages/${directory}/`, import.meta.url);
    const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
    if (manifest.exports?.['./src/*'] !== './src/*') throw new Error(`官方 UI 包不再公开源入口：${manifest.name}`);
    const entry = new URL('src/index.ts', root);
    await readFile(entry);
    entries[manifest.name] = fileURLToPath(entry);
  }
  return entries;
}

export const officialUiLoaders = { '.module.css': 'local-css', '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl', '.png': 'dataurl' };
