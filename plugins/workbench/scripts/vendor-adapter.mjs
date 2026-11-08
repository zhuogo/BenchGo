import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../../benchgo/package.json', import.meta.url));
const vendors = { '@linxin666/dsh-ssh': '0.4.15', 'dsh-better-sidebar': '0.30.1' };
export function unwrapClient(source, name) {
  const start = /^window\.__ModuleLoader__\.load\(\{\s*id:\s*(["'])([^"']+)\1,\s*factory:\s*\(require\)\s*=>\s*\{/;
  const match = source.match(start);
  if (!match || match[2] !== name || !/\n\s*}\s*\n\}\);\s*(?:\/\/# sourceMappingURL=[^\n]*\s*)?$/.test(source)) throw new Error(`Unsupported ${name} client wrapper`);
  let result = source.replace(start, 'module.exports = ((require) => {').replace(/\n\s*}\s*\n\}\);\s*(?:\/\/# sourceMappingURL=[^\n]*\s*)?$/, '\n})(require);\n');
  // Respect the upstream opt-out by excluding its optional reporting call from
  // this product's build, without mutating global storage or vendor sources.
  if (name === '@linxin666/dsh-ssh') {
    const call = 'reportDailyHeartbeat([{ name: "@linxin666/dsh-ssh" }]);';
    if (result.split(call).length !== 2) throw new Error('SSH telemetry call changed; review integration');
    result = result.replace(call, '/* BenchGo does not send third-party installation telemetry. */');
  }
  return result;
}
export function workbenchClientAdapters() {
  return { name: 'benchgo-workbench-vendors', setup(build) {
    build.onResolve({ filter: /^benchgo-workbench-vendor:(ssh|sidebar)$/ }, args => ({ path: args.path, namespace: 'benchgo-workbench-vendor' }));
    build.onLoad({ filter: /.*/, namespace: 'benchgo-workbench-vendor' }, async args => {
      const name = args.path.endsWith(':ssh') ? '@linxin666/dsh-ssh' : 'dsh-better-sidebar';
      const path = require.resolve(`${name}/client`), root = dirname(dirname(path));
      const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
      if (manifest.version !== vendors[name]) throw new Error(`Review ${name} ${manifest.version} before updating the workbench adapter`);
      return { contents: unwrapClient(await readFile(path, 'utf8'), name), loader: 'js', resolveDir: dirname(path) };
    });
  } };
}

export async function prepareWorkbenchVendors() {
  const root = dirname(require.resolve('@linxin666/dsh-ssh/package.json'));
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (pkg.version !== vendors[pkg.name]) throw new Error('SSH package version requires integration review');
  const original = await readFile(join(root, 'lib/index.js'), 'utf8');
  const needle = 'import { Client } from "ssh2";';
  if (original.split(needle).length !== 2) throw new Error('SSH transport import changed; host key verification cannot be installed');
  const output = fileURLToPath(new URL('../lib/', import.meta.url));
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'ssh-host.mjs'), original.replace(needle, 'import { Client } from "../src/ssh-trust.mjs";').replace(/\/\/# sourceMappingURL=[^\n]*/g, ''));
  await copyFile(join(root, 'LICENSE'), join(output, 'DSH-SSH-LICENSE'));
  const sidebarRoot = dirname(require.resolve('dsh-better-sidebar/package.json'));
  await copyFile(join(sidebarRoot, 'LICENSE'), join(output, 'BETTER-SIDEBAR-LICENSE'));
  await writeFile(join(output, 'NOTICE'), 'BenchGo composes @linxin666/dsh-ssh 0.4.15 (Apache-2.0), https://github.com/zhu1090093659/dsh-web, and dsh-better-sidebar 0.30.1 (MIT), https://github.com/omdsh-dev/DSH-better-sidebar.\nSSH transport is adapted at build time to require an explicitly confirmed host key. Client factories are bundled under benchgo-plugin; optional installation telemetry is omitted. Original packages and upstream Harness sources are not modified.\n');
  return output;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await prepareWorkbenchVendors();
