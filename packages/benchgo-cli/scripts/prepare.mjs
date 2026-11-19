/** A small CLI carries shared source contracts and signed resource identities, never a stale Linux seed. */
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(new URL('../', import.meta.url));
const root = fileURLToPath(new URL('../../../', import.meta.url));
const resources = join(here, 'resources');
const files = ['workbench-installation.mjs', 'plugin-install.mjs', 'update-feed.mjs', 'server-resources.mjs', 'update-public-key.pem'];
let source;
try { source = await stat(join(root, 'plugins/base/package.json')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (source?.isFile()) {
  const plugin = JSON.parse(await readFile(join(root, 'plugins/base/package.json'), 'utf8'));
  const upstream = JSON.parse(await readFile(join(root, 'upstream.json'), 'utf8'));
  await mkdir(resources, { recursive: true });
  await cp(join(root, 'LICENSE'), join(resources, 'LICENSE'));
  const shared = join(resources, 'shared');
  await rm(shared, { recursive: true, force: true }); await mkdir(shared, { recursive: true });
  for (const name of files) await cp(join(root, 'plugins/base/shared', name), join(shared, name));
  await writeFile(join(resources, 'install.json'), JSON.stringify({ schemaVersion: 1,
    releaseVersion: plugin.benchgo?.releaseVersion || plugin.version, pluginVersion: plugin.version, engineVersion: upstream.version }, null, 2) + '\n');
  const server = join(resources, 'server');
  await rm(server, { recursive: true, force: true });
  const { writeServerResourceDescriptor } = await import(pathToFileURL(join(root, 'scripts/desktop/payload-policy.mjs')).href);
  writeServerResourceDescriptor({ root, output: server, delivery: 'online' });
} else {
  // Repacking an already published CLI uses its verified, self-contained generated resources.
  for (const name of files) await stat(join(resources, 'shared', name));
  await stat(join(resources, 'install.json'));
  await stat(join(resources, 'LICENSE'));
}
console.log('BenchGo CLI: shared contracts and native resource descriptors prepared');
