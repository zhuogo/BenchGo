import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { compareVersions, validateReleaseManifest } from '../../plugins/benchgo/shared/update-feed.mjs';
import { findPreviousRelease, readChannelBaseline, githubJson, sha256, releaseKind } from './github.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const stable = value => typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const ignored = path => /^(?:docs|eval|artifacts|task|概念)\//.test(path) || /(?:^|\/)(?:test|tests)\//.test(path)
  || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) || /(?:^|\/)(?:README[^/]*|AGENTS\.md|NOTICE|LICENSE[^/]*)$/i.test(path);

export function classifyChanges(paths) {
  const reasons = { plugin: [], windows: [], android: [] };
  const mark = (components, path) => components.forEach(component => reasons[component].push(path));
  for (const path of paths) {
    if (ignored(path)) continue;
    if (path === 'deepseek-harness' || path === 'upstream.json' || path.startsWith('assets/brand/')) mark(['plugin', 'windows', 'android'], path);
    else if (path.startsWith('plugins/link/mobile/')) mark(['android'], path);
    else if (path.startsWith('plugins/link/') || path.startsWith('plugins/shared/client/') || path.startsWith('scripts/server/')) mark(['plugin', 'android'], path);
    else if (path === 'scripts/desktop/plugin-bundle.mjs') mark(['plugin', 'windows', 'android'], path);
    else if (path === 'scripts/desktop/package-plugin-update.mjs') mark(['plugin'], path);
    else if (path.startsWith('scripts/desktop/') && !/(?:create-(?:app-update-feed|update-manifest)|sync-(?:browser-artifacts|dev-plugin)|prepare-dev)\.mjs$/.test(path)) mark(['windows'], path);
    else if (path === 'scripts/build-link-android.mjs' || path === 'scripts/verify-android-release.mjs') mark(['android'], path);
    else if (path.startsWith('plugins/')) mark(['plugin'], path);
    else if (/^scripts\/(?:source-loader|source-host-loader|harness)\.mjs$/.test(path)) mark(['plugin', 'windows', 'android'], path);
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
  const builds = Object.fromEntries(Object.entries(reasons).map(([key, value]) => [key, value.length > 0]));
  return { schemaVersion: 1, kind: releaseKind, releaseVersion, tag: `v${releaseVersion}`, sourceSha,
    createdAt: now, minAppVersion, versions, builds, reasons, previous, channelBaseline };
}

export async function currentVersions() {
  const app = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const plugin = JSON.parse(await readFile(resolve(root, 'plugins/benchgo/package.json'), 'utf8'));
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
  const dirty = git('status', '--porcelain=v1', '--untracked-files=all', '--', 'plugins', 'scripts', 'packages', 'assets', '.github', 'bin', 'package.json', 'upstream.json', '.gitmodules');
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
  const paths = previous ? git('diff', '--name-only', previous.sourceSha, sourceSha).split(/\r?\n/).filter(Boolean) : [];
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
