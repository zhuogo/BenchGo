import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { compareVersions, validateReleaseManifest } from '../../plugins/base/shared/update-feed.mjs';
import { findPreviousRelease, readChannelBaseline, githubJson, sha256, releaseKind } from './github.mjs';
import { platformDownloadEntries } from './downloads.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const stable = value => typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const ignored = path => /^(?:docs|eval|artifacts|task|概念)\//.test(path) || /(?:^|\/)(?:test|tests)\//.test(path)
  || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) || /(?:^|\/)(?:README[^/]*|AGENTS\.md|NOTICE|LICENSE[^/]*)$/i.test(path)
  || /^(?:plugins\/(?:base\/lib|link\/dist)\/|scripts\/(?:desktop\/(?:smoke-windows|packaged-profile-probe|verify-claude-payload)|server\/(?:smoke-linux|verify-local)|verify-android-release)\.mjs$)/.test(path);
const platformTargets = { macos: ['mac-arm64', 'mac-x64'], linux: ['linux-server'] };

export function classifyChanges(paths) {
  const reasons = { plugin: [], windows: [], android: [], macos: [], linux: [] };
  const all = Object.keys(reasons);
  const mark = (components, path) => components.forEach(component => reasons[component].push(path));
  for (const path of paths) {
    if (ignored(path)) continue;
    if (path === 'deepseek-harness' || path === 'upstream.json' || path === '.gitmodules') mark(all, path);
    else if (path.startsWith('assets/brand/')) mark(['plugin', 'windows', 'android', 'macos'], path);
    else if (path.startsWith('plugins/link/mobile/')) mark(['android'], path);
    else if (path.startsWith('plugins/link/client/') || path.startsWith('plugins/shared/client/') || /^plugins\/link\/(?:package(?:-lock)?\.json|scripts\/(?:build-web|official-ui)\.mjs)$/.test(path)) mark(['plugin', 'android'], path);
    else if (path === 'scripts/server/package-linux.mjs') mark(['linux'], path);
    else if (path.startsWith('scripts/server/')) mark(['plugin', 'android', 'linux'], path);
    else if (/^plugins\/base\/shared\/(?:plugin-install|update-feed|workbench-installation)\.mjs$/.test(path)) mark(['plugin', 'windows', 'macos'], path);
    else if (path === 'plugins/base/shared/update-public-key.pem' || /^scripts\/desktop\/(?:plugin-bundle|payload-policy)\.mjs$/.test(path)) mark(all, path);
    else if (path === 'scripts/desktop/package-plugin-update.mjs') mark(['plugin'], path);
    else if (/^scripts\/desktop\/(?:package-macos|electron-builder\.macos\.config|macos-[^/]+)\.mjs$/.test(path)) mark(['macos'], path);
    else if (/^scripts\/desktop\/(?:package-windows|electron-builder\.config|install-cleanup)\.mjs$/.test(path)) mark(['windows'], path);
    else if (path.startsWith('scripts/desktop/') && !/(?:create-(?:app-update-feed|update-manifest|update-key)|sync-(?:browser-artifacts|dev-plugin)|prepare-dev)\.mjs$/.test(path)) mark(['windows', 'macos'], path);
    else if (path === 'scripts/build-link-android.mjs') mark(['android'], path);
    else if (/^plugins\/base\/(?:scripts\/shared-ui\.mjs|client\/(?:iconsax\.jsx|http-response\.mjs))$/.test(path)) mark(['plugin', 'android'], path);
    else if (path.startsWith('plugins/')) mark(['plugin'], path);
    else if (/^scripts\/(?:source-loader|source-host-loader|harness)\.mjs$/.test(path)) mark(all, path);
  }
  return reasons;
}

export function createReleasePlan({ releaseVersion, sourceSha, previous = null, versions, paths = [], minAppVersion,
  packageChanged = false, channelBaseline = null, now = new Date().toISOString() }) {
  if (!stable(releaseVersion) || !/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error('Release requires a stable X.Y.Z version and immutable source SHA');
  for (const key of ['plugin', 'windows', 'android']) if (!stable(versions[key])) throw new Error(`Invalid ${key} component version`);
  if (!stable(minAppVersion) || compareVersions(minAppVersion, versions.windows) > 0) throw new Error('minAppVersion must not exceed the available Windows version');
  if (!Number.isSafeInteger(versions.androidVersionCode) || versions.androidVersionCode < 1 || versions.androidVersionCode > 2147483647) throw new Error('Invalid Android versionCode');
  const reasons = classifyChanges(paths);
  if (packageChanged) for (const component of Object.keys(reasons)) reasons[component].push('package.json build contract');
  if (previous) {
    validateReleaseManifest(previous.manifest);
    if (!stable(previous.releaseVersion) || compareVersions(releaseVersion, previous.releaseVersion) <= 0) throw new Error('Unified release version must increase');
    if (!/^[a-f0-9]{40}$/.test(previous.sourceSha) || previous.manifest.releaseVersion !== previous.releaseVersion) throw new Error('Invalid unified baseline');
    const old = previous.manifest;
    for (const [component, artifact] of [['plugin', old.plugin], ['windows', old.app], ['android', old.android]]) {
      if (!artifact) { reasons[component].push('missing previous component'); continue; }
      const compared = compareVersions(versions[component], artifact.version);
      if (compared < 0) throw new Error(`${component} component cannot roll back`);
      if (compared > 0) reasons[component].push('component version increased');
      if (reasons[component].length && compared === 0) throw new Error(`${component} changed: increment its component version before release`);
    }
    if (reasons.android.length && old.android && versions.androidVersionCode <= old.android.versionCode) throw new Error('Android rebuild requires an increased versionCode');
  } else for (const component of Object.keys(reasons)) reasons[component].push('first unified release');
  // The released CLI and online deployment resolver require platform seeds for the exact plugin version.
  if (previous && reasons.plugin.length) for (const component of ['macos', 'linux']) reasons[component].push('platform seed requires the new plugin version');
  const plannedVersions = { ...versions };
  for (const [component, targets] of Object.entries(platformTargets)) {
    const downloads = previous?.downloads;
    const catalog = downloads?.sourceSha === previous?.sourceSha && downloads?.releaseVersion === previous?.releaseVersion ? downloads : null;
    const entries = targets.map(target => platformDownloadEntries(catalog, target));
    if (previous && (entries.some(rows => !rows.length) || new Set(entries.flat().map(row => row.version)).size > 1)) {
      reasons[component].push('missing complete previous signed downloads');
    }
    if (reasons[component].length && entries.flat().some(row => compareVersions(releaseVersion, row.version) <= 0)) {
      throw new Error(`${component} component version must increase`);
    }
    plannedVersions[component] = reasons[component].length ? releaseVersion : entries[0][0].version;
  }
  const builds = Object.fromEntries(Object.entries(reasons).map(([key, value]) => [key, value.length > 0]));
  return { schemaVersion: 1, kind: releaseKind, releaseVersion, tag: `v${releaseVersion}`, sourceSha,
    createdAt: now, minAppVersion, versions: plannedVersions, builds, reasons, previous, channelBaseline };
}

export async function currentVersions() {
  const app = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const plugin = JSON.parse(await readFile(resolve(root, 'plugins/base/package.json'), 'utf8'));
  const upstream = JSON.parse(await readFile(resolve(root, 'upstream.json'), 'utf8'));
  const gradle = await readFile(resolve(root, 'plugins/link/mobile/android/app/build.gradle'), 'utf8');
  return { plugin: plugin.version, windows: app.version, android: /versionName\s+['"]([^'"]+)['"]/.exec(gradle)?.[1],
    androidVersionCode: Number(/versionCode\s+(\d+)/.exec(gradle)?.[1]), engine: upstream.version };
}

async function main() {
  const { values } = parseArgs({ options: { version: { type: 'string' }, out: { type: 'string' },
    'previous-file': { type: 'string' }, 'source-sha': { type: 'string' } } });
  if (!stable(values.version)) throw new Error('Unified release version must use stable X.Y.Z');
  const sourceSha = git('rev-parse', 'HEAD');
  const dirty = git('status', '--porcelain=v1', '--untracked-files=all', '--', 'plugins', 'scripts', 'packages', 'assets', '.github', 'bin', 'package.json', 'upstream.json', 'deepseek-harness', '.gitmodules');
  if (dirty) throw new Error('Release planning requires committed product source; commit tracked and untracked product changes first (local artifacts/eval/reference are excluded)');
  if (values['source-sha'] && values['source-sha'] !== sourceSha) throw new Error('Checkout does not match requested source SHA');
  if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== sourceSha) throw new Error('Workflow source differs from checkout');
  if (!values['previous-file']) {
    const tag = `v${values.version}`;
    if (await githubJson(`/git/ref/tags/${tag}`, { missing: true }) || await githubJson(`/releases/tags/${tag}`, { missing: true })) {
      throw new Error('Unified version tag or release already exists; use a new version, or rerun the failed publication job with its original plan');
    }
  }
  const previous = values['previous-file'] ? JSON.parse(await readFile(values['previous-file'], 'utf8')) : await findPreviousRelease();
  if (previous) { try { git('merge-base', '--is-ancestor', previous.sourceSha, sourceSha); } catch { throw new Error('Previous unified release must be an ancestor of this source; fetch full history and do not publish rollback branches'); } }
  const paths = previous ? git('diff', '--name-only', '--no-renames', '-z', previous.sourceSha, sourceSha).split('\0').filter(Boolean) : [];
  const config = JSON.parse(await readFile(resolve(root, 'scripts/release/config.json'), 'utf8'));
  let packageChanged = false;
  if (previous && paths.includes('package.json')) {
    const before = JSON.parse(git('show', `${previous.sourceSha}:package.json`));
    const after = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
    packageChanged = ['packageManager', 'engines', 'dsh', 'dependencies', 'devDependencies'].some(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
  }
  const plan = createReleasePlan({ releaseVersion: values.version, sourceSha, previous, versions: await currentVersions(), paths,
    minAppVersion: config.minAppVersion, packageChanged, channelBaseline: values['previous-file'] ? null : await readChannelBaseline() });
  const output = resolve(values.out || 'artifacts/release/release-plan.json');
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(plan, null, 2)}\n`);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT,
    `${Object.entries(plan.builds).map(([key, value]) => `${key}=${value}`).join('\n')}\nsha=${sourceSha}\n`);
  console.log(JSON.stringify({ releaseVersion: plan.releaseVersion, sourceSha, baseline: previous?.tag ?? null, builds: plan.builds, reasons: plan.reasons, planSha256: sha256(await readFile(output)) }, null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
