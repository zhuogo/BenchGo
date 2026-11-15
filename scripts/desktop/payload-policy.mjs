/** Build-time payload identity and budget checks; never changes the official engine. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const normalized = path => path.replaceAll('\\', '/');
const safePath = path => typeof path === 'string' && path !== '' && !/^[\/]|[:\\]/.test(path) && !path.split('/').some(part => part === '..' || part === '');
export const SERVER_PAYLOAD_FILES = Object.freeze(['bootstrap.sh', 'bootstrap.mjs', 'manifest.json', 'server-seed.tar.gz']);
export const SIDEBAR_PAYLOAD_FILES = Object.freeze(['sidebar-host.mjs', 'client-editor.js', 'client-mermaid.js', 'client-locale.js', 'client-terminal.js', 'SIDEBAR-RUNTIME-LICENSES.txt']);
// Match the existing updater's extraction contract. The nested archive has an
// independent budget so an old, pre-dedup seed cannot quietly inflate the app.
export const PAYLOAD_BUDGET = Object.freeze({ unpackedBytes: 1024 ** 3, entries: 60_000, serverSeedBytes: 128 * 1024 ** 2 });
export const DESKTOP_ELECTRON_LANGUAGES = Object.freeze(['en-US', 'zh-CN', 'ja', 'es', 'fr', 'de', 'ru', 'pt-BR']);
export const isLinuxX64Elf = bytes => bytes.length >= 20 && bytes.subarray(0, 4).toString('hex') === '7f454c46' && bytes[4] === 2 && bytes[5] === 1 && bytes.readUInt16LE(18) === 62;
export const SERVER_BUILD_INPUTS = Object.freeze(['upstream.json', 'scripts/server/bootstrap.sh', 'scripts/server/bootstrap.mjs', 'scripts/server/package-seed.mjs',
  'scripts/desktop/plugin-bundle.mjs', 'scripts/desktop/payload-policy.mjs', 'plugins/benchgo/scripts/build-modules.mjs',
  'plugins/benchgo/scripts/build-client.mjs', 'plugins/workbench/scripts/vendor-adapter.mjs', 'plugins/workbench/scripts/sidebar-runtime.mjs']);

export function serverResourceDelivery(value = 'full') {
  if (!['full', 'online'].includes(value)) throw new Error('Server resource delivery must be full or online');
  return value;
}

export function packedPluginFiles(plugin) {
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: plugin, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`Plus bundle: npm pack failed: ${result.stderr}`);
  const files = JSON.parse(result.stdout)[0].files.map(file => file.path);
  if (files.some(file => !safePath(file) || file.split('/').includes('node_modules'))) throw new Error('Plus bundle: invalid published file path');
  return files;
}

/** Local freshness identity, not a promise of cross-platform archive equality. */
export function serverInputDigest({ plugin, files = packedPluginFiles(plugin), root = repositoryRoot }) {
  const hash = createHash('sha256');
  const add = (name, path) => { hash.update(name + '\0'); hash.update(digest(readFileSync(path)) + '\n'); };
  for (const file of [...files].sort()) if (!file.startsWith('lib/server/')) add(`plugin/${file}`, join(plugin, file));
  for (const file of ['package-lock.json', 'npm-shrinkwrap.json']) if (existsSync(join(plugin, file))) add(`plugin-lock/${file}`, join(plugin, file));
  for (const file of SERVER_BUILD_INPUTS) add(`build/${file}`, join(root, file));
  return hash.digest('hex');
}

/** CLI prepack may publish the exact online descriptor without rebuilding the Linux archive. */
export function serverResourceDescriptor({ root = repositoryRoot, plugin = join(root, 'plugins/benchgo'), files, delivery = 'full' } = {}) {
  delivery = serverResourceDelivery(delivery);
  const metadata = json(join(plugin, 'package.json')), upstream = json(join(root, 'upstream.json'));
  return { schemaVersion: 1, delivery, releaseVersion: metadata.benchgo?.releaseVersion ?? metadata.version, pluginVersion: metadata.version,
    harnessVersion: upstream.version, harnessCommit: upstream.commit, sourceDigest: serverInputDigest({ plugin, files, root }) };
}

export function writeServerResourceDescriptor({ output, root = repositoryRoot, plugin = join(root, 'plugins/benchgo'), files, delivery = 'full' } = {}) {
  if (typeof output !== 'string' || !output) throw new Error('Server resource descriptor requires an output directory');
  const descriptor = serverResourceDescriptor({ root, plugin, files, delivery });
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, 'resources.json'), JSON.stringify(descriptor, null, 2) + '\n');
  copyFileSync(join(root, 'plugins/benchgo/shared/update-public-key.pem'), join(output, 'update-public-key.pem'));
  return descriptor;
}

/** Only the SDK's unused optional executable packages may be omitted. */
export function omitClaudeNative(metadata, name) {
  if (metadata.name !== '@anthropic-ai/claude-agent-sdk' || !/^@anthropic-ai\/claude-agent-sdk-(?:win32|darwin|linux)-/.test(name)) return false;
  if (!Object.hasOwn(metadata.optionalDependencies ?? {}, name)) throw new Error('Claude SDK native payload must remain optional');
  if (metadata.version !== '0.3.300') throw new Error(`Claude SDK ${metadata.version} requires payload compatibility verification before native executables can be omitted`);
  return true;
}

export function assertSidebarPayload(plugin) {
  const directory = join(plugin, 'lib/modules/workbench/lib');
  const receipt = json(join(directory, 'sidebar-runtime.json'));
  if (receipt.schemaVersion !== 1 || receipt.vendor?.name !== 'dsh-better-sidebar' || typeof receipt.vendor.version !== 'string' || !Array.isArray(receipt.files))
    throw new Error('Plus bundle: invalid sidebar runtime receipt; rebuild the Workbench adapters');
  const paths = receipt.files.map(file => file.path);
  if (new Set(paths).size !== paths.length || SIDEBAR_PAYLOAD_FILES.some(file => !paths.includes(file))) throw new Error('Plus bundle: sidebar runtime receipt omits required assets');
  for (const file of receipt.files) {
    if (!safePath(file.path) || file.path === 'sidebar-runtime.json' || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Plus bundle: invalid sidebar runtime asset identity');
    const path = join(directory, file.path), info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== file.bytes || digest(readFileSync(path)) !== file.sha256) throw new Error(`Plus bundle: stale sidebar runtime asset ${file.path}; rebuild the Workbench adapters`);
  }
  return receipt;
}

/** A damaged full payload never silently falls back to a network download. */
export function assertEmbeddedServerSeed({ plugin, files, root = repositoryRoot, delivery = 'full', budget = PAYLOAD_BUDGET, required = true }) {
  serverResourceDelivery(delivery);
  const directory = join(plugin, 'lib/server');
  if (!existsSync(directory)) {
    if (required) throw new Error('Plus bundle: server resources are missing; run the full build:plus release build');
    return null; // Only the explicit internal seed-build path omits its own nested resources.
  }
  if (!required) throw new Error('Plus bundle: a server seed build cannot contain nested server resources');
  const descriptorFile = join(directory, 'resources.json');
  if (!existsSync(descriptorFile)) throw new Error('Plus bundle: stale server resources have no descriptor; run the full build:plus release build');
  const descriptor = json(descriptorFile), metadata = json(join(plugin, 'package.json')), upstream = json(join(root, 'upstream.json'));
  if (descriptor.schemaVersion !== 1 || !['full', 'online'].includes(descriptor.delivery) || descriptor.pluginVersion !== metadata.version || descriptor.harnessVersion !== upstream.version
    || descriptor.harnessCommit !== upstream.commit || descriptor.releaseVersion !== (metadata.benchgo?.releaseVersion ?? metadata.version) || !/^[a-f0-9]{64}$/.test(descriptor.sourceDigest))
    throw new Error('Plus bundle: stale server resource descriptor; run the full build:plus release build');
  if (!readFileSync(join(directory, 'update-public-key.pem')).equals(readFileSync(join(root, 'plugins/benchgo/shared/update-public-key.pem')))) throw new Error('Plus bundle: server resource public key differs from the application trust root');
  const present = SERVER_PAYLOAD_FILES.filter(file => existsSync(join(directory, file)));
  if (present.length && present.length !== SERVER_PAYLOAD_FILES.length) throw new Error('Plus bundle: incomplete full server payload; rebuild instead of falling back to the network');
  const sourceDigest = serverInputDigest({ plugin, files, root });
  if (sourceDigest !== descriptor.sourceDigest) throw new Error('Plus bundle: server seed inputs have changed; run the full build:plus release build');
  if (!present.length) {
    if (descriptor.delivery !== 'online') throw new Error('Plus bundle: full server payload is missing; rebuild instead of falling back to the network');
    if (delivery !== 'online') throw new Error('Plus bundle: full delivery requires the complete offline server payload');
    return { ...descriptor, delivery };
  }
  const manifest = json(join(directory, 'manifest.json'));
  if (manifest.schemaVersion !== 1 || manifest.pluginVersion !== metadata.version || manifest.harnessVersion !== upstream.version
    || manifest.harnessCommit !== upstream.commit || manifest.sourceDigest !== sourceDigest || !/^[a-f0-9]{64}$/.test(manifest.sha256))
    throw new Error('Plus bundle: server seed identity is stale; run the full build:plus release build');
  const payload = join(directory, 'server-seed.tar.gz'), info = lstatSync(payload);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > budget.serverSeedBytes) throw new Error(`Plus bundle: server seed exceeds its explicit ${budget.serverSeedBytes}-byte budget`);
  if (digest(readFileSync(payload)) !== manifest.sha256) throw new Error('Plus bundle: server seed checksum mismatch');
  for (const file of ['bootstrap.sh', 'bootstrap.mjs']) if (!readFileSync(join(directory, file)).equals(readFileSync(join(root, 'scripts/server', file)))) throw new Error(`Plus bundle: stale server bootstrap ${file}`);
  return { ...descriptor, delivery, bytes: info.size };
}

/** Inventory only the staged payload, never the development node_modules graph. */
export function inspectPluginPayload(directory, { budget = PAYLOAD_BUDGET } = {}) {
  const result = { schemaVersion: 1, bytes: 0, entries: 0, categories: {}, largestFiles: [], budgets: budget };
  const files = [];
  const walk = path => {
    for (const name of readdirSync(path)) {
      const child = join(path, name), info = lstatSync(child), file = normalized(relative(directory, child));
      if (file === 'payload-inventory.json') continue;
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new Error(`Plus bundle: unsupported staged entry ${file}`);
      result.entries++;
      if (info.isDirectory()) { walk(child); continue; }
      const category = file === 'node_modules/benchgo-plugin/lib/server/server-seed.tar.gz' ? 'serverSeed'
        : file.startsWith('node_modules/benchgo-plugin/node_modules/') ? 'dependencies'
          : file.startsWith('node_modules/benchgo-plugin/') ? 'plugin' : 'composition';
      const section = result.categories[category] ??= { bytes: 0, files: 0 };
      section.bytes += info.size; section.files++; result.bytes += info.size;
      files.push({ path: file, bytes: info.size });
    }
  };
  walk(resolve(directory));
  if (result.bytes > budget.unpackedBytes || result.entries > budget.entries) throw new Error(`Plus bundle: staged payload exceeds the updater budget (${result.bytes} bytes, ${result.entries} entries)`);
  result.largestFiles = files.sort((a, b) => b.bytes - a.bytes).slice(0, 20);
  return result;
}
