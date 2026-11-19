import { fileURLToPath } from 'node:url';
import { mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { build } from 'esbuild';
import { officialModelsUi } from './official-models-ui.mjs';
import { officialModelsStore } from './official-models-store.mjs';
import { shellUi } from './shell-ui.mjs';
import { buildLink } from './build-link.mjs';
import { buildModules } from './build-modules.mjs';
import { buildPreview } from './build-preview.mjs';
import { sharedUiStyles, writeUiLicenses } from './shared-ui.mjs';
import { workbenchClientAdapters } from '../workbench/scripts/vendor-adapter.mjs';
import { copyArtifact, writeArtifact } from './write-artifact.mjs';
// Every exported plugin entry uses the canonical BenchGo app icon.
await copyArtifact(new URL('../../../assets/brand/benchgo-app.svg', import.meta.url), new URL('../assets/icon.svg', import.meta.url));
await mkdir(new URL('../assets/channel-brands/', import.meta.url), { recursive: true });
for (const name of ['SOURCE.md', 'sources.json']) await copyArtifact(new URL(`../../shared/client/assets/channel-brands/${name}`, import.meta.url), new URL(`../assets/channel-brands/${name}`, import.meta.url));
await buildModules();
await buildPreview();
await buildLink();
// React retains the shell's shared module identity.
const out = fileURLToPath(new URL('../lib/client.js', import.meta.url));
const sshChunk = 'client.ssh.js';
// Match the installed official frontend metadata without exposing server environment variables.
let record;
try {
  record = JSON.parse(await readFile(new URL('../../../deepseek-harness/.dsh-build/client-build-environment.json', import.meta.url), 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  // A fresh source checkout can build the plugin before building the entire official app.
  const upstream = JSON.parse(await readFile(new URL('../../../upstream.json', import.meta.url), 'utf8'));
  record = { environment: { DSH_CLIENT_VERSION: upstream.version, DSH_CLIENT_COMMIT_HASH: upstream.commit.slice(0, 7) } };
}
record.environment.DSH_CLIENT_TITLE = 'BenchGo';
const define = Object.fromEntries(['DSH_CLIENT_TITLE', 'DSH_CLIENT_VERSION', 'DSH_CLIENT_COMMIT_HASH', 'DSH_CLIENT_GIT_DIRTY'].map(key => ['process.env.' + key, JSON.stringify(record.environment[key]) ?? 'undefined']));
const result = await build({ entryPoints: { client: fileURLToPath(new URL('../client/index.jsx', import.meta.url)), 'client.ssh': 'benchgo-workbench-vendor:ssh' }, outdir: dirname(out), nodePaths: [fileURLToPath(new URL('../node_modules', import.meta.url))], bundle: true, minify: true, write: false, format: 'cjs', platform: 'browser', define,
  // Pure address helpers ship with this client; never request an extra runtime module.
  alias: { '@deepseek-ai/dsh-util-workspace-path': fileURLToPath(new URL('../../../deepseek-harness/packages/util/workspace-path/src/index.ts', import.meta.url)) },
  external: ['react-dom', 'react', 'react/jsx-runtime', '@deepseek-ai/*'], plugins: [workbenchClientAdapters(), sharedUiStyles(), officialModelsStore(), officialModelsUi(), shellUi()], jsx: 'automatic', target: 'es2022', loader: { '.css': 'text', '.svg': 'text' }, logLevel: 'warning' });
const output = new Map(result.outputFiles.map(file => [basename(file.path), file.text]));
if ([...output.values()].some(source => /\bprocess\.env\.DSH_CLIENT_/.test(source))) throw Error('Unresolved official browser build metadata');
await mkdir(new URL('../lib/', import.meta.url), { recursive: true });
await writeUiLicenses(fileURLToPath(new URL('../lib/UI-LICENSES.txt', import.meta.url)));
const pluginName = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).name;
const factory = (source, chunk) => `window.__ModuleLoader__.load({id: '${pluginName}', ${chunk ? `chunk: '${chunk}', ` : ''}factory: (require) => { const module = {exports:{}}; const exports = module.exports;\n${source}\nreturn module.exports; }});\n`;
const ssh = factory(output.get(sshChunk), sshChunk);
await writeArtifact(join(dirname(out), sshChunk), ssh);
// The official loader revisions package-local chunks with their owning entry.
await writeArtifact(out, `${factory(output.get('client.js'))}// ${sshChunk} ${createHash('sha256').update(ssh).digest('hex')}\n`);
console.log('BenchGo client built');

// Server seed is a release payload, excluded from the running plugin reload.
if (!process.argv.includes('--client')) {
  const { packageServerSeed } = await import('../../../scripts/server/package-seed.mjs');
  await packageServerSeed();
  await (await import('node:fs/promises')).cp(new URL('../../link/dist/server/', import.meta.url), new URL('../lib/server/', import.meta.url), { recursive: true });
}
