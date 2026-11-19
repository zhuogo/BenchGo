/** Produce the pinned sidebar's actual host and lazy assets, not its npm build graph. */
import { createHash } from 'node:crypto';
import { builtinModules, createRequire } from 'node:module';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const require = createRequire(new URL('../../package.json', import.meta.url));
const { build } = require('esbuild');
const chunks = ['editor', 'mermaid', 'locale', 'terminal'];
const sharedImports = new Set([
  'ws', 'yaml', '@deepseek-ai/dsh-settings', '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-session/surface', '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-subagent',
]);
const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, '')));
const purePackages = new Set(['@deepseek-ai/schemastery', '@deepseek-ai/cosmokit']);
const digest = value => createHash('sha256').update(value).digest('hex');
const fileRecord = (path, bytes) => ({ path, bytes: bytes.length, sha256: digest(bytes) });
const inside = (root, path) => {
  const child = relative(root, path);
  return !isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`);
};

async function dependencyRoot(name, from) {
  for (let root = from; ; root = dirname(root)) {
    const candidate = join(root, 'node_modules', name);
    try { await readFile(join(candidate, 'package.json')); return realpath(candidate); }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
    if (dirname(root) === root) return undefined;
  }
}

/** Lazy chunks already bundle libraries; retain their notices when omitting the npm graph. */
async function sidebarNotices(source) {
  const queue = [source], visited = new Set(), sections = [];
  for (let index = 0; index < queue.length; index++) {
    const root = queue[index];
    if (visited.has(root)) continue;
    visited.add(root);
    const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const entries = await readdir(root, { withFileTypes: true });
    const licenseFiles = entries.filter(entry => entry.isFile() && /^(?:licen[sc]e|copying|notice)(?:$|[._-])/i.test(entry.name)).map(entry => entry.name).sort();
    let text = '';
    for (const path of licenseFiles) text += `\n${path}\n${await readFile(join(root, path), 'utf8')}\n`;
    if (!licenseFiles.length) {
      // These pinned libraries publish the complete MIT notice in their README.
      for (const entry of entries.filter(entry => entry.isFile() && /^readme(?:$|\.)/i.test(entry.name))) {
        const readme = await readFile(join(root, entry.name), 'utf8');
        const heading = /^#{1,6}\s+Licen[sc]e\b.*$/im.exec(readme);
        if (heading) { text = `\n${entry.name}\n${readme.slice(heading.index)}\n`; break; }
      }
    }
    if (!text) throw new Error(`Missing sidebar bundled dependency license: ${metadata.name}@${metadata.version}`);
    sections.push({ name: metadata.name, version: metadata.version, text: `## ${metadata.name}@${metadata.version} (${metadata.license})\n${text}` });
    for (const name of Object.keys({ ...metadata.dependencies, ...metadata.optionalDependencies })) {
      const dependency = await dependencyRoot(name, root);
      if (dependency) queue.push(dependency);
      else if (!Object.hasOwn(metadata.optionalDependencies ?? {}, name)) throw new Error(`Missing sidebar build dependency ${name}`);
    }
  }
  return sections.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version)).map(section => section.text).join('\n\n');
}

export async function prepareSidebarRuntime({ output, source = dirname(require.resolve('dsh-better-sidebar/package.json')) } = {}) {
  if (!output) throw new Error('A workbench output directory is required');
  source = await realpath(source);
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  if (manifest.name !== 'dsh-better-sidebar' || manifest.version !== '0.30.1') throw new Error('Sidebar package version requires integration review');
  const entry = join(source, 'lib/index.js');
  const original = await readFile(entry, 'utf8');
  const allowedChunks = original.match(/const CHUNK_NAMES = \[([\s\S]*?)\];/);
  if (!allowedChunks || JSON.stringify([...allowedChunks[1].matchAll(/"([a-z-]+)"/g)].map(match => match[1])) !== JSON.stringify(chunks) || !original.includes('const LIB_DIR = dirname(fileURLToPath(import.meta.url));')) {
    throw new Error('Sidebar resource lookup changed; review its deployment closure');
  }
  const packages = new Map([[source, manifest]]);
  const result = await build({
    absWorkingDir: source, entryPoints: [entry], bundle: true, packages: 'external', platform: 'node',
    format: 'esm', target: 'node22', write: false, metafile: true, legalComments: 'eof',
    plugins: [{ name: 'benchgo-sidebar-pure-schema', setup(builder) {
      // Preserve this vendor's exact pure validator. Host services remain external
      // so Cordis, sessions and model services keep the official module identity.
      builder.onResolve({ filter: /^@deepseek-ai\/(?:schemastery|cosmokit)(?:\/.*)?$/ }, async args => {
        if (!purePackages.has(args.path)) throw new Error(`Review sidebar pure dependency ${args.path}`);
        const root = await realpath(dirname(createRequire(args.importer).resolve(`${args.path}/package.json`)));
        const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
        if (metadata.name !== args.path || typeof metadata.version !== 'string') throw new Error(`Sidebar dependency identity mismatch: ${args.path}`);
        const exports = metadata.exports?.['.'];
        const module = typeof exports === 'object' ? exports.import : undefined;
        const path = resolve(root, module ?? metadata.module ?? metadata.main);
        if (!inside(root, path)) throw new Error(`Sidebar dependency escapes its package: ${args.path}`);
        packages.set(root, metadata);
        return { path };
      });
    } }],
  });
  const built = Object.values(result.metafile.outputs);
  if (built.length !== 1 || result.outputFiles.length !== 1) throw new Error('Sidebar host must be a self-contained ESM artifact');
  const externalImports = [...new Set(built[0].imports.map(item => {
    if (!item.external || (!builtins.has(item.path.replace(/^node:/, '')) && !sharedImports.has(item.path))) throw new Error(`Undeclared sidebar runtime import: ${item.path}`);
    return item.path;
  }))].sort();
  const files = new Map([['sidebar-host.mjs', result.outputFiles[0].contents]]);
  for (const chunk of chunks) files.set(`client-${chunk}.js`, await readFile(join(source, `lib/client-${chunk}.js`)));
  const inputFiles = await Promise.all(Object.keys(result.metafile.inputs).map(path => realpath(resolve(source, path))));
  const sources = [];
  for (const [root, metadata] of [...packages].sort(([, a], [, b]) => a.name.localeCompare(b.name))) {
    const paths = new Set(['package.json', 'LICENSE']);
    for (const input of inputFiles.filter(path => inside(root, path) && !relative(root, path).split(sep).includes('node_modules'))) paths.add(relative(root, input).split(sep).join('/'));
    if (root === source) for (const chunk of chunks) paths.add(`lib/client-${chunk}.js`);
    const sourceFiles = await Promise.all([...paths].sort().map(async path => fileRecord(path, await readFile(join(root, path)))));
    sources.push({ name: metadata.name, version: metadata.version, files: sourceFiles });
  }
  // A surprise bundled library must not silently lose its notices or version identity.
  for (const input of inputFiles) if (![...packages.keys()].some(root => inside(root, input) && !relative(root, input).split(sep).includes('node_modules'))) throw new Error(`Unreviewed sidebar bundled input: ${input}`);
  files.set('SIDEBAR-RUNTIME-LICENSES.txt', Buffer.from(await sidebarNotices(source)));
  const closure = {
    schemaVersion: 1, vendor: { name: manifest.name, version: manifest.version },
    externalImports, sources, files: [...files].map(([path, bytes]) => fileRecord(path, bytes)),
  };
  // Validate and build every artifact before replacing any generated file.
  await mkdir(output, { recursive: true });
  for (const [path, bytes] of files) await writeFile(join(output, path), bytes);
  await writeFile(join(output, 'sidebar-runtime.json'), JSON.stringify(closure, null, 2) + '\n');
  return closure;
}
