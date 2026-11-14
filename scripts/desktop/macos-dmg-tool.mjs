/** Add bounded clean-detach patience through dmg-builder's supported tool override. */
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const desktopRequire = createRequire(new URL('../../deepseek-harness/apps/desktop/package.json', import.meta.url));
const builderRequire = createRequire(desktopRequire.resolve('app-builder-lib'));

// Match the pinned official dmg-builder 26.17.0 vendor exactly. Any engine
// upgrade must review this adapter rather than silently select another binary.
export const dmgVendor = Object.freeze({ releaseName: 'dmg-builder@1.2.5', checksums: Object.freeze({
  'dmgbuild-bundle-arm64-75c8a6c.tar.gz': '793404d0c96687e27d5ee40a668d498c92e36a64d6c2906df511031adb33cbeb',
  'dmgbuild-bundle-x86_64-75c8a6c.tar.gz': '1664972f9cc2d6e8fce3b63e42cd30078aff602669c5856939c4519921200433',
}) });

export function renderDmgWrapper(binary) {
  if (!binary || /[\r\n\0]/.test(binary)) throw new Error('Invalid official dmgbuild binary path');
  const quoted = `'${binary.replaceAll("'", "'\"'\"'")}'`;
  // The pinned CLI defaults to five attempts (~20 seconds). Ten attempts allow
  // transient Spotlight/filesystem activity up to ~170 seconds, then still fail.
  // exec preserves the real tool's exit status and receives signals directly.
  return `#!/bin/sh\nexec ${quoted} --detach-retries 10 "$@"\n`;
}

export async function prepareMacDmgTool(arch) {
  if (!['arm64', 'x64'].includes(arch)) throw new Error('Unsupported dmgbuild architecture');
  const vendorArch = arch === 'arm64' ? 'arm64' : 'x86_64';
  const filenameWithExt = `dmgbuild-bundle-${vendorArch}-75c8a6c.tar.gz`;
  const source = await readFile(builderRequire.resolve('dmg-builder/out/dmgUtil.js'), 'utf8');
  if (!source.includes(dmgVendor.releaseName) || !source.includes('CUSTOM_DMGBUILD_PATH')
    || Object.entries(dmgVendor.checksums).some(([name, checksum]) => !source.includes(name) || !source.includes(checksum))) {
    throw new Error('Official dmg-builder tool contract changed; review the BenchGo clean-detach adapter before packaging.');
  }
  const { downloadBuilderToolset } = builderRequire('app-builder-lib/out/util/electronGet');
  const directory = await downloadBuilderToolset({ ...dmgVendor, filenameWithExt });
  const binary = join(directory, 'dmgbuild');
  const help = execFileSync(binary, ['--help'], { encoding: 'utf8' });
  if (!help.includes('--detach-retries')) throw new Error('Official dmgbuild does not support the reviewed clean-detach option.');
  const output = join(root, '.local/desktop');
  await mkdir(output, { recursive: true });
  const wrapper = join(output, `dmgbuild-${arch}`);
  await writeFile(wrapper, renderDmgWrapper(binary), { mode: 0o755 });
  await chmod(wrapper, 0o755);
  console.log('[BenchGo packaging] official dmgbuild clean-detach attempts: 10');
  return wrapper;
}
