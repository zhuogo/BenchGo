import { cp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareWorkbenchVendors } from '../../workbench/scripts/vendor-adapter.mjs';
import { buildNoise } from '../../voice/scripts/build-noise.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const pluginsRoot = resolve(packageRoot, '..');
const inside = (root, path) => {
  const child = relative(root, path);
  return !isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`);
};
const modules = {
  harness: ['package.json', 'src'],
  superagent: ['package.json', 'src', 'shared', 'prompts/builtin-layer.md', 'assets/pet'],
  voice: ['package.json', 'src', 'shared', 'prompts/conversation.md', 'client/audio-worklet.js', 'lib', 'locale'],
  interactive: ['package.json', 'src'],
  efficiency: ['package.json', 'src'],
  workbench: ['package.json', 'src', 'lib'],
};

/** Preserve module files and import.meta.url resources; shared code stays at the package root. */
export async function buildModules() {
  await prepareWorkbenchVendors();
  await buildNoise();
  const output = resolve(packageRoot, 'lib/modules');
  const roots = new Map(await Promise.all(Object.keys(modules).map(async name => [name, await realpath(join(pluginsRoot, name))])));
  const destination = path => {
    for (const [name, root] of roots) if (inside(root, path)) return join(output, name, relative(root, path));
    if (inside(packageRoot, path)) return path;
    throw new Error(`Module dependency escapes the BenchGo package: ${path}`);
  };
  const files = [];
  const collect = async path => {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      // Preserve local recovery copies without publishing stale source or editor files.
      if (/\.(?:bak\d*(?:[-.].*)?|orig|rej|tmp|sw[op])$|~$/i.test(entry.name)) continue;
      const file = join(path, entry.name);
      if (entry.isDirectory()) await collect(file);
      else if (entry.isFile()) files.push(file);
      else throw new Error(`Unsupported module source entry: ${file}`);
    }
  };
  for (const [name, parts] of Object.entries(modules)) for (const part of parts) {
    const path = join(roots.get(name), part);
    if (extname(part)) files.push(path);
    else await collect(path);
  }
  const included = new Set(files.map(path => resolve(path)));
  const prepared = await Promise.all(files.map(async source => {
    const target = destination(source);
    if (!/\.(?:[cm]?js|ts)$/.test(source)) return { source, target };
    let text = await readFile(source, 'utf8');
    // These are the module and URL forms used by our source packages. Resolve
    // against the source file before relocating, including cross-module imports.
    const relocate = (match, prefix, quote, specifier) => {
      const dependency = fileURLToPath(new URL(specifier, pathToFileURL(source)));
      const mapped = destination(dependency);
      if (inside(output, mapped) && !included.has(resolve(dependency))) throw new Error(`Module resource omitted from package: ${source} -> ${specifier}`);
      const path = relative(dirname(target), mapped).split(sep).join('/');
      return `${prefix}${quote}${path.startsWith('.') ? path : './' + path}${quote}`;
    };
    text = text.replace(/(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"\r\n]+)\2/g, relocate);
    text = text.replace(/(\bnew\s+URL\(\s*)(['"])(\.{1,2}\/[^'"\r\n]+)\2(?=\s*,\s*import\.meta\.url\s*\))/g, relocate);
    return { source, target, text };
  }));
  // Resolve and validate everything before replacing the generated directory.
  if (!inside(resolve(packageRoot, 'lib'), output) || output === resolve(packageRoot, 'lib')) throw new Error('Invalid module output directory');
  await rm(output, { recursive: true, force: true });
  for (const { source, target, text } of prepared) {
    await mkdir(dirname(target), { recursive: true });
    if (text === undefined) await cp(source, target);
    else await writeFile(target, text);
  }
  console.log('BenchGo modules built');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildModules();
