import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createUpdateManifest } from '../desktop/create-update-manifest.mjs';
import { releaseDownloadUrl, resolveUpdateUrl, DEFAULT_UPDATE_CONFIG, validateReleaseManifest } from '../../plugins/benchgo/shared/update-feed.mjs';
import { fileDigest } from './record-artifact.mjs';
import { releaseKind, sha256 } from './github.mjs';

export const requiredVerification = {
  plugin: ['update-feed', 'plugin-entry-closure', 'production-dependency-closure'],
  windows: ['packaged-runtime', 'fresh-install', 'legacy-plugin-shadow-repair', 'actual-plugin-resolution'],
  android: ['android-release-signature', 'android-current-resources', 'android-non-debuggable', 'android-update-signature-tests'],
};

export function immutableArtifact(artifact) {
  if (!artifact || !/^https:\/\/github\.com\/zhuogo\/BenchGo\/releases\/download\/v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(artifact.url)
    || !/^[a-f0-9]{64}$/.test(artifact.sha256) || !Number.isSafeInteger(artifact.size) || artifact.size < 1) throw new Error('Component must use an immutable unified release URL and complete checksum');
  return artifact;
}

export function validateReceipt(receipt, plan, component) {
  if (!receipt || receipt.schemaVersion !== 1 || receipt.component !== component || receipt.sourceSha !== plan.sourceSha
    || receipt.releaseVersion !== plan.releaseVersion || receipt.version !== plan.versions[component]
    || component === 'android' && receipt.versionCode !== plan.versions.androidVersionCode) throw new Error(`Wrong ${component} artifact source or version`);
  if (!Array.isArray(receipt.verified) || requiredVerification[component].some(item => !receipt.verified.includes(item))) throw new Error(`${component} artifact lacks required completed verification`);
  if (JSON.stringify(receipt.staged) !== JSON.stringify([{ path: 'plugins/benchgo/package.json', field: 'benchgo.releaseVersion', value: plan.releaseVersion }])) throw new Error('Unexpected build staging changes');
  if (!Array.isArray(receipt.files) || !receipt.files.length || new Set(receipt.files.map(row => row.name)).size !== receipt.files.length) throw new Error('Invalid build inventory');
  for (const row of receipt.files) if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(row.name) || !/^[a-f0-9]{64}$/.test(row.sha256)
    || !Number.isSafeInteger(row.size) || row.size < 1) throw new Error('Invalid artifact inventory entry');
  const expected = component === 'plugin' ? `benchgo-${receipt.version}-plugin.tar.gz` : component === 'windows'
    ? `benchgo-${receipt.version}-win-x64-setup.exe` : `benchgo-${receipt.version}-android.apk`;
  if (receipt.artifact !== expected || !receipt.files.some(row => row.name === expected)) throw new Error('Artifact name does not match component version');
  return receipt;
}

async function loadBuild(directory, plan, component, output) {
  const receipt = validateReceipt(JSON.parse(await readFile(resolve(directory, 'component-source.json'), 'utf8')), plan, component);
  const actualNames = (await readdir(directory)).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify([...receipt.files.map(row => row.name), 'component-source.json'].sort())) throw new Error(`Unaccounted files in ${component} artifact`);
  for (const row of receipt.files) {
    const path = resolve(directory, row.name);
    if ((await stat(path)).size !== row.size || await fileDigest(path) !== row.sha256) throw new Error(`${component} artifact checksum mismatch: ${row.name}`);
    if (component === 'windows' && /(?:\.exe|\.blockmap)$/.test(row.name)
      || component === 'plugin' && row.name.endsWith('.tar.gz') || component === 'android' && /\.apk(?:\.sha256)?$/.test(row.name)) await cp(path, resolve(output, row.name));
  }
  if (component === 'windows') {
    const old = JSON.parse(await readFile(resolve(directory, 'build-source.json'), 'utf8'));
    if (old.schemaVersion !== 1 || old.sourceSha !== plan.sourceSha || old.version !== receipt.version
      || requiredVerification.windows.some(item => !old.verified?.includes(item))) throw new Error('Windows installer verification receipt is inconsistent');
  }
  await cp(resolve(directory, 'component-source.json'), resolve(output, `${component}-source.json`));
  const file = receipt.files.find(row => row.name === receipt.artifact);
  return { artifact: { version: receipt.version, url: releaseDownloadUrl(file.name, plan.tag), sha256: file.sha256, size: file.size,
    ...(component === 'android' ? { versionCode: receipt.versionCode } : {}) },
  source: { version: receipt.version, sourceSha: plan.sourceSha, releaseVersion: plan.releaseVersion,
    receiptUrl: releaseDownloadUrl(`${component}-source.json`, plan.tag) } };
}

export async function assembleRelease({ plan, buildRoot, outDir, notes, privateKey, publicKey, enforceSource = true }) {
  if (plan.schemaVersion !== 1 || plan.kind !== releaseKind || plan.tag !== `v${plan.releaseVersion}`) throw new Error('Invalid release plan');
  if (enforceSource && execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== plan.sourceSha) throw new Error('Release assembly checkout differs from build source');
  if (notes !== undefined && (typeof notes !== 'string' || notes.length > 16_384)) throw new Error('Release notes must be at most 16384 characters');
  const output = resolve(outDir);
  await mkdir(output, { recursive: true });
  if ((await readdir(output)).length) throw new Error('Release output must be empty');
  const components = {}, artifacts = {};
  const folders = { plugin: 'benchgo-plugin-update', windows: 'benchgo-windows-x64', android: `benchgo-${plan.versions.android}-android.apk` };
  for (const component of ['plugin', 'windows', 'android']) {
    if (plan.builds[component]) {
      const built = await loadBuild(resolve(buildRoot, folders[component]), plan, component, output);
      artifacts[component] = immutableArtifact(built.artifact); components[component] = built.source;
    } else {
      const previous = plan.previous?.manifest;
      artifacts[component] = immutableArtifact(component === 'windows' ? previous?.app : previous?.[component]);
      components[component] = plan.previous?.source?.components?.[component];
      if (!components[component] || components[component].version !== artifacts[component].version
        || !/^[a-f0-9]{40}$/.test(components[component].sourceSha)) throw new Error(`Missing previous ${component} provenance`);
    }
  }
  const manifest = await createUpdateManifest({ plugin: artifacts.plugin, engine: plan.builds.plugin
    ? { min: plan.versions.engine, max: plan.versions.engine } : plan.previous.manifest.engine,
  app: artifacts.windows, android: artifacts.android, releaseVersion: plan.releaseVersion, minAppVersion: plan.minAppVersion,
  sourceSha: plan.sourceSha, outDir: output, notes, privateKey, publicKey });
  validateReleaseManifest(manifest);
  const receipt = { schemaVersion: 1, kind: releaseKind, releaseVersion: plan.releaseVersion, sourceSha: plan.sourceSha,
    manifestSha256: sha256(await readFile(resolve(output, 'benchgo-update.json'))), baseline: plan.previous
      ? { tag: plan.previous.tag, sourceSha: plan.previous.sourceSha, manifestSha256: plan.previous.manifestSha256 } : null,
    components, builds: plan.builds };
  await writeFile(resolve(output, 'release-source.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  const summaries = Object.entries(artifacts).map(([key, value]) => `- ${key}: ${value.version}${key === 'android' ? ` (${value.versionCode})` : ''}${plan.builds[key] ? '，本次构建' : '，复用已验证不可变产物'}`);
  await writeFile(resolve(output, 'release-notes.md'), `${notes || `BenchGo ${plan.releaseVersion}`}\n\n${summaries.join('\n')}\n\n源码：${plan.sourceSha}\n最低 Windows 应用版本：${plan.minAppVersion}\n`);
  if (plan.builds.windows) {
    const artifact = artifacts.windows, filename = basename(new URL(artifact.url).pathname);
    const sha512 = await fileDigest(resolve(output, filename), 'sha512');
    const nativeDownloadUrl = resolveUpdateUrl(artifact.url, DEFAULT_UPDATE_CONFIG);
    const feed = { version: artifact.version, files: [{ url: nativeDownloadUrl, sha512, size: artifact.size }], path: nativeDownloadUrl,
      sha512, releaseDate: plan.createdAt };
    await writeFile(resolve(output, 'latest.yml'), `${JSON.stringify(feed, null, 2)}\n`);
  }
  return { manifest, receipt };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { plan: { type: 'string' }, builds: { type: 'string' }, out: { type: 'string' } } });
  const plan = JSON.parse(await readFile(values.plan, 'utf8'));
  assembleRelease({ plan, buildRoot: values.builds, outDir: values.out, notes: process.env.RELEASE_NOTES,
    privateKey: process.env.BENCHGO_UPDATE_PRIVATE_KEY }).then(result => console.log(`Signed BenchGo ${result.manifest.releaseVersion} from ${result.receipt.sourceSha}`))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
