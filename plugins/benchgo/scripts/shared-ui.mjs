import { compile } from '@tailwindcss/node';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const uiRoot = fileURLToPath(new URL('../../shared/client/ui/', import.meta.url));
const pluginsRoot = fileURLToPath(new URL('../../', import.meta.url));

/** Compile only namespaced utilities; never load Tailwind's global preflight. */
export function sharedUiStyles() {
  let pending;
  return {
    name: 'benchgo-shared-ui',
    setup(build) {
      build.onLoad({ filter: /[/\\]ui[/\\]ui\.css$/ }, async () => {
        pending ??= (async () => {
          const candidates = new Set();
          async function scan(folder) {
            for (const entry of await readdir(folder, { withFileTypes: true })) {
              const path = join(folder, entry.name);
              if (entry.isDirectory()) await scan(path);
              else if (/\.(jsx?|tsx?)$/.test(entry.name)) {
                const source = await readFile(path, 'utf8');
                for (const token of source.matchAll(/bg:[^\s"'`<>;,{}]+/g)) candidates.add(token[0]);
              }
            }
          }
          for (const folder of ['benchgo/client', 'harness/client', 'superagent/client', 'voice/client', 'link/client', 'interactive/client', 'efficiency/client', 'workbench/client', 'shared/client']) {
            try { await scan(join(pluginsRoot, folder)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          }
          const compiler = await compile(await readFile(join(uiRoot, '../theme.css'), 'utf8'), { base: uiRoot, onDependency() {} });
          return `${compiler.build([...candidates])}\n${await readFile(join(uiRoot, 'ui.css'), 'utf8')}`;
        })();
        return { contents: await pending, loader: 'text' };
      });
    },
  };
}

/** Preserve the licenses of bundled UI dependencies in both distributables. */
export async function writeUiLicenses(output) {
  const modules = fileURLToPath(new URL('../node_modules/', import.meta.url));
  const sections = [`## shadcn/ui (adapted component composition)\n\n${await readFile(join(uiRoot, 'licenses/shadcn-ui.txt'), 'utf8')}`];
  const visited = new Set();
  async function collect(name, base = modules) {
    if (visited.has(name) || ['react', 'react-dom'].includes(name)) return;
    visited.add(name);
    const require = createRequire(join(base, '__ui_licenses__.cjs'));
    let root;
    try { root = dirname(require.resolve(`${name}/package.json`)); }
    catch {
      root = dirname(require.resolve(name));
      while (true) {
        try { if (JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).name === name) break; } catch {}
        const parent = dirname(root); if (parent === root) throw new Error(`Cannot locate UI package ${name}`); root = parent;
      }
    }
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    let license;
    for (const file of ['LICENSE', 'license', 'LICENSE.md', 'LICENSE.txt']) {
      try { license = await readFile(join(root, file), 'utf8'); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!license) {
      try { license = await readFile(join(uiRoot, 'licenses', `${name.replaceAll('/', '__')}.txt`), 'utf8'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!license) throw new Error(`Missing UI dependency license: ${name}`);
    sections.push(`## ${name}@${pkg.version}\n\n${license}`);
    for (const dependency of Object.keys(pkg.dependencies || {})) await collect(dependency, root);
  }
  for (const name of ['@radix-ui/react-slot', '@radix-ui/react-collapsible', '@radix-ui/react-dialog', 'class-variance-authority', 'clsx', 'tailwind-merge', 'tailwindcss']) await collect(name);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, sections.join('\n\n'));
}
