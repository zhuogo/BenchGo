/** Package the complete production dependency closure, never an npm source-only pack. */
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { stagePluginBundle } from './plugin-bundle.mjs';
import { MAX_PLUGIN_BYTES } from '../../plugins/benchgo/shared/update-feed.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

/** Publishing and downloading enforce the same bound; never leave an unusable archive behind. */
export async function assertPluginArchiveSize(filename, maxBytes = MAX_PLUGIN_BYTES) {
  const { size } = await stat(filename);
  if (!size || size > maxBytes) {
    await rm(filename, { force: true });
    throw new Error(`BenchGo plugin archive size ${size} exceeds the supported range 1..${maxBytes}; no update package was retained`);
  }
  return size;
}

export async function packagePluginUpdate({ out, runtime } = {}) {
  const plugin = join(root, 'plugins/benchgo');
  const manifest = JSON.parse(await readFile(join(plugin, 'package.json')));
  const output = resolve(out || join(root, 'artifacts/plugins'));
  const tar = createRequire(join(plugin, 'package.json'))('tar');
  const temporary = await mkdtemp(join(tmpdir(), 'benchgo-release-'));
  try {
    const seed = join(temporary, 'seed');
    stagePluginBundle({ runtime, plugin, output: seed });
    await mkdir(output, { recursive: true });
    const filename = join(output, `benchgo-${manifest.version}-plugin.tar.gz`);
    await tar.c({ file: filename, cwd: seed, gzip: true, portable: true, noMtime: true }, ['release.json', 'node_modules']);
    await assertPluginArchiveSize(filename);
    return filename;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { out: { type: 'string' }, runtime: { type: 'string' } } });
  console.log(`BenchGo complete plugin payload: ${await packagePluginUpdate(values)}`);
}
