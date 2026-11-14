/** Build BenchGo on a native Mac without changing official engine source. */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareMacDmgTool } from './macos-dmg-tool.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

export function validateMacFileLimit(value) {
  const limit = String(value).trim();
  if (limit !== 'unlimited' && (!/^\d+$/.test(limit) || Number(limit) < 65536)) {
    throw new Error(`macOS packaging requires ulimit -n >= 65536 before starting Node.js (received ${JSON.stringify(limit)}). Raise the runner's kern.maxfiles/kern.maxfilesperproc and shell file limit before building.`);
  }
  return limit;
}

export function macSigningNodeOptions(existing = '') {
  const preload = new URL('./macos-signing-fs.mjs', import.meta.url).href;
  return `${existing} --import=${preload}`.trim();
}

function preflightMacPackaging() {
  const softOpenFiles = validateMacFileLimit(execFileSync('/bin/sh', ['-c', 'ulimit -S -n'], { encoding: 'utf8' }));
  const maxFilesPerProcess = execFileSync('/usr/sbin/sysctl', ['-n', 'kern.maxfilesperproc'], { encoding: 'utf8' }).trim();
  const desktopRequire = createRequire(new URL('../../deepseek-harness/apps/desktop/package.json', import.meta.url));
  const builderRequire = createRequire(desktopRequire.resolve('app-builder-lib'));
  // Fail before the full runtime build if the locked retry-queue dependency is absent.
  builderRequire.resolve('graceful-fs');
  console.log(`[BenchGo packaging] descriptor preflight ${JSON.stringify({ softOpenFiles, maxFilesPerProcess })}`);
}

export async function recordMacArtifacts(directory, { version, arch, sourceSha }) {
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error('macOS artifact source must be an immutable Git SHA');
  const prefix = `benchgo-${version}-mac-${arch}`;
  const expected = ['dmg', 'zip'].map(extension => `${prefix}.${extension}`);
  const present = await readdir(directory);
  for (const name of expected) if (!present.includes(name)) throw new Error(`Missing macOS artifact: ${name}`);
  const names = present.filter(name => expected.includes(name) || expected.some(expectedName => name === `${expectedName}.blockmap`)).sort();
  const files = await Promise.all(names.map(async name => {
    const bytes = await readFile(join(directory, name));
    if (!bytes.length) throw new Error(`Empty macOS artifact: ${name}`);
    return { name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  }));
  const receipt = { schemaVersion: 1, sourceSha, version, platform: 'darwin', arch, signing: 'ad-hoc', notarized: false,
    verified: ['packaged-runtime', 'external-plugin-seed', 'enrollment-source-match', 'startup-brand'], files };
  await writeFile(join(directory, 'build-source.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

export function resolveMacPackageTarget(arch, platform = process.platform, hostArch = process.arch) {
  if (!['arm64', 'x64'].includes(arch)) throw new Error('Usage: node scripts/desktop/package-macos.mjs arm64|x64');
  if (platform !== 'darwin') throw new Error('BenchGo macOS packaging requires a native macOS build host.');
  if (arch !== hostArch) throw new Error(`BenchGo macOS ${arch} packaging requires a matching ${arch} Node.js runner; cross-architecture runtime qualification is not supported.`);
  return { name: `mac-${arch}`, arch, platform: 'darwin' };
}

export async function packageMacOS(arch) {
  const target = resolveMacPackageTarget(arch);
  preflightMacPackaging();
  const dmgTool = await prepareMacDmgTool(arch);
  const engine = join(root, 'deepseek-harness');
  const desktop = join(engine, 'apps/desktop');
  const build = join(desktop, '.desktop-build/targets', target.name);
  const pnpm = join(desktop, 'node_modules/pnpm/bin/pnpm.cjs');
  // These artifacts are intentionally ad-hoc signed, with no Developer ID or notarization claim.
  const env = { ...process.env, DSH_TELEMETRY_DISABLED: '1', DSH_DESKTOP_APP_ID: 'cn.draftgo.benchgo',
    DSH_DESKTOP_UNSIGNED: '1', DSH_DESKTOP_TARGET_PLATFORM: target.platform, DSH_DESKTOP_TARGET_ARCH: target.arch,
    CSC_IDENTITY_AUTO_DISCOVERY: 'false' };
  for (const key of Object.keys(env)) if (/^(?:DSH_DESKTOP_WINDOWS_|DSH_DESKTOP_MACOS_|(?:WIN_)?CSC_(?!IDENTITY_AUTO_DISCOVERY)|APPLE_)/.test(key)) delete env[key];
  const run = (args, cwd = engine, overrides = {}) => new Promise((resolveRun, reject) => {
    console.log(`\n[BenchGo macOS packaging] ${args.join(' ')}`);
    const child = spawn(process.execPath, args, { cwd, env: { ...env, ...overrides }, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolveRun() : reject(new Error(`Packaging failed (${signal ?? code}): ${args.join(' ')}`)));
  });
  const pm = (args, cwd = engine, overrides) => run([pnpm, ...args], cwd, overrides);
  await pm(['run', 'build:official']);
  await run([join(root, 'scripts/desktop/prepare-tray.mjs')], root);
  for (const [family, directory] of [['dsh', 'dsh'], ['vendor', 'vendor']]) {
    await pm(['run', 'release:pack', '--family', family, '--out', join(build, 'packed', directory)]);
    if (family === 'dsh') await pm(['--dir', 'apps/desktop-host', 'pack', '--pack-destination', join(build, 'packed/dsh')]);
  }
  await mkdir(join(build, 'packed/landlock'), { recursive: true });
  await pm(['--dir', 'native/system', 'run', 'build:ts']);
  await pm(['--dir', 'native/system/packages/entry', 'pack', '--pack-destination', join(build, 'packed/landlock')]);
  for (const stage of ['runtime', 'packages', 'dsh']) await pm(['run', `prepare:${stage}`], desktop);
  await rm(join(build, 'plus-seed'), { recursive: true, force: true });
  await run([join(root, 'scripts/desktop/plugin-bundle.mjs'), 'stage', '--runtime', join(build, 'dsh'), '--output', join(build, 'plus-seed')], root);
  await pm(['exec', 'tsx', join(root, 'scripts/desktop/seal-runtime.mjs'), join(build, 'dsh')], desktop);
  // NODE_OPTIONS is inherited through pnpm exec's Node child; only this build
  // subprocess gets the preload. It is never copied into the app or runtime.
  await pm(['exec', 'electron-builder', '--config', join(root, 'scripts/desktop/electron-builder.macos.config.mjs'), '--mac', `--${arch}`, '--publish', 'never'], desktop,
    { NODE_OPTIONS: macSigningNodeOptions(env.NODE_OPTIONS), CUSTOM_DMGBUILD_PATH: dmgTool });
  const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  await recordMacArtifacts(join(root, `artifacts/macos-${arch}`), { version, arch, sourceSha });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/desktop/package-macos.mjs arm64|x64');
  await packageMacOS(process.argv[2]);
}
