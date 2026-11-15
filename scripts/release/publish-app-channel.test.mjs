import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { publishAppChannel, publishRelease, repairAppChannel, stagePreviousAppBlockmap } from './publish.mjs';
import { releaseKind, sha256 } from './github.mjs';

const json = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const source = 'a'.repeat(40), originalSource = 'b'.repeat(40);

function fixture(t) {
  const keys = generateKeyPairSync('ed25519', { privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const releases = new Map(), bytesById = new Map(), calls = [];
  let serial = 1;
  const release = (tag, sha) => {
    const value = { id: serial++, tag_name: tag, target_commitish: sha, draft: false, prerelease: false, assets: [],
      upload_url: `https://uploads.github.com/repos/zhuogo/BenchGo/releases/${tag}/assets{?name,label}` };
    releases.set(tag, value); return value;
  };
  const setAsset = (release, name, bytes) => {
    const asset = { id: serial++, name, size: bytes.length, digest: `sha256:${sha256(bytes)}`,
      browser_download_url: `https://github.com/zhuogo/BenchGo/releases/download/${release.tag_name}/${name}` };
    release.assets = [...release.assets.filter(row => row.name !== name), asset]; bytesById.set(asset.id, bytes); return asset;
  };
  const installer = Buffer.from('MZ-verified-native-installer');
  const app = { version: '1.0.0', url: 'https://github.com/zhuogo/BenchGo/releases/download/v1.0.0/benchgo-1.0.0-win-x64-setup.exe', size: installer.length, sha256: sha256(installer) };
  const manifest = (version, sha) => ({ schemaVersion: 1, version, releaseVersion: version, sourceSha: sha,
    engine: { min: '0.2.2-rc.1', max: '0.2.2-rc.1' }, plugin: { version, url: `https://github.com/zhuogo/BenchGo/releases/download/v${version}/benchgo-${version}-plugin.tar.gz`, size: 10, sha256: 'c'.repeat(64) }, app: { ...app } });
  const seal = (release, value) => {
    const raw = json(value);
    setAsset(release, 'benchgo-update.json', raw);
    setAsset(release, 'benchgo-update.json.sig', Buffer.from(`${sign(null, raw, keys.privateKey).toString('base64')}\n`));
    setAsset(release, 'release-source.json', json({ schemaVersion: 1, kind: releaseKind, releaseVersion: value.releaseVersion, sourceSha: value.sourceSha, manifestSha256: sha256(raw) }));
  };
  const original = release('v1.0.0', originalSource), current = release('v1.1.0', source), apps = release('app-updates', originalSource);
  const currentManifest = manifest('1.1.0', source), originalManifest = manifest('1.0.0', originalSource);
  seal(current, currentManifest); seal(original, originalManifest);
  const exe = setAsset(original, 'benchgo-1.0.0-win-x64-setup.exe', installer);
  const sha512 = createHash('sha512').update(installer).digest('base64'), url = `https://ghfast.top/${app.url}`;
  const feed = { version: app.version, files: [{ url, size: app.size, sha512 }], path: url, sha512, releaseDate: '2026-11-14T15:09:03.969Z' };
  const feedBytes = json(feed);
  setAsset(original, 'latest.yml', feedBytes); setAsset(apps, 'latest.yml', feedBytes);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(url), path = parsed.pathname.replace('/repos/zhuogo/BenchGo', ''), method = options.method || 'GET';
    calls.push({ method, path, name: parsed.searchParams.get('name') });
    const response = (body, status = 200) => { const result = new Response(body, { status }); Object.defineProperty(result, 'url', { value: parsed.href }); return result; };
    if (method === 'GET' && path.startsWith('/releases/tags/')) {
      const value = releases.get(decodeURIComponent(path.slice('/releases/tags/'.length)));
      return value ? response(JSON.stringify(value)) : response('missing', 404);
    }
    if (method === 'GET' && path.startsWith('/commits/')) return response(JSON.stringify({ sha: releases.get(path.slice('/commits/'.length))?.target_commitish }));
    if (method === 'GET' && path.startsWith('/releases/assets/')) {
      const id = Number(path.split('/').at(-1));
      assert.notEqual(id, exe.id, 'repair must reuse the released SHA512, never download the installer');
      assert(bytesById.has(id), 'requested metadata asset must exist'); return response(bytesById.get(id));
    }
    if (method === 'DELETE' && path.startsWith('/releases/assets/')) {
      const id = Number(path.split('/').at(-1));
      assert(apps.assets.some(row => row.id === id), 'only mutable application-channel metadata may be replaced');
      apps.assets = apps.assets.filter(row => row.id !== id); bytesById.delete(id); return response(null, 204);
    }
    if (method === 'POST' && parsed.hostname === 'uploads.github.com') {
      assert.equal(path, '/releases/app-updates/assets', 'immutable release assets must never be uploaded or replaced');
      const chunks = []; for await (const chunk of options.body) chunks.push(Buffer.from(chunk));
      const asset = setAsset(apps, parsed.searchParams.get('name'), Buffer.concat(chunks)); return response(JSON.stringify(asset));
    }
    assert.fail(`Unexpected fixture request: ${method} ${path}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  return { ...keys, releases, bytesById, calls, setAsset, seal, original, originalManifest, current, currentManifest, apps, feed, feedBytes, exe,
    repair: () => repairAppChannel({ releaseVersion: '1.1.0', publicKey: keys.publicKey }),
    mutations: () => calls.filter(row => row.method !== 'GET') };
}

async function blockmapFixture(t) {
  const f = fixture(t), directory = await mkdtemp(resolve(tmpdir(), 'benchgo-previous-blockmap-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from('original immutable blockmap bytes');
  const name = 'benchgo-1.0.0-win-x64-setup.exe.blockmap', asset = f.setAsset(f.original, name, bytes);
  const plan = { builds: { windows: true }, previous: { tag: 'v1.1.0', manifest: f.currentManifest } };
  const manifest = { ...f.currentManifest, app: { version: '1.1.0', url: 'https://github.com/zhuogo/BenchGo/releases/download/v1.2.0/benchgo-1.1.0-win-x64-setup.exe', size: 100, sha256: 'd'.repeat(64) } };
  return { ...f, directory, bytes, name, asset, plan, manifest,
    stage: () => stagePreviousAppBlockmap({ plan, manifest, directory, publicKey: f.publicKey }) };
}

test('a new Windows release stages the previous app owner blockmap unchanged in the derived current directory', async t => {
  const f = await blockmapFixture(t);
  assert.deepEqual(await f.stage(), { status: 'staged', name: f.name, size: f.bytes.length, sha256: sha256(f.bytes) });
  assert.deepEqual(await readFile(resolve(f.directory, f.name)), f.bytes);
  assert.deepEqual(await readdir(f.directory), [f.name]);
  assert.ok(f.calls.some(row => row.path === '/releases/tags/v1.0.0'), 'the app owner predates the previous unified v1.1.0 release');
  assert.equal(f.calls.some(row => row.path === '/releases/tags/v1.1.0'), false);
  const originalAssets = JSON.stringify(f.original.assets);
  assert.equal((await f.stage()).status, 'staged', 'a publication retry accepts the same bytes');
  assert.equal(JSON.stringify(f.original.assets), originalAssets);
  assert.deepEqual(f.mutations(), [], 'staging never modifies a release or channel');
});

test('reused applications and first releases do not invent previous blockmap assets or issue requests', async t => {
  const f = await blockmapFixture(t);
  f.plan.builds.windows = false;
  assert.equal(await f.stage(), null);
  f.plan.builds.windows = true; f.plan.previous = null;
  assert.equal(await f.stage(), null);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(await readdir(f.directory), []);
});

test('GenericProvider tag substitution outside the new directory retains full-download fallback', async t => {
  const f = await blockmapFixture(t);
  f.manifest.app.version = '1.2.0';
  f.manifest.app.url = 'https://github.com/zhuogo/BenchGo/releases/download/v1.2.0/benchgo-1.2.0-win-x64-setup.exe';
  assert.deepEqual(await f.stage(), { status: 'fallback', reason: 'old-blockmap-is-in-another-directory' });
  assert.deepEqual(f.calls, []);
  assert.deepEqual(await readdir(f.directory), []);
});

test('missing previous blockmaps explicitly retain native fallback without modifying historical assets', async t => {
  const f = await blockmapFixture(t);
  f.original.assets = f.original.assets.filter(row => row.id !== f.asset.id);
  assert.deepEqual(await f.stage(), { status: 'fallback', reason: 'previous-blockmap-is-unavailable' });
  assert.deepEqual(await readdir(f.directory), []);
  assert.deepEqual(f.mutations(), []);
});

for (const mode of ['digest', 'bytes', 'missing-digest', 'url', 'duplicate', 'oversized', 'owner-signature', 'owner-app', 'installer-digest']) test(`previous blockmap ${mode} errors fail before staging or publication`, async t => {
  const f = await blockmapFixture(t);
  if (mode === 'digest') f.asset.digest = `sha256:${'f'.repeat(64)}`;
  if (mode === 'bytes') f.bytesById.set(f.asset.id, Buffer.alloc(f.bytes.length));
  if (mode === 'missing-digest') delete f.asset.digest;
  if (mode === 'url') f.asset.browser_download_url = f.asset.browser_download_url.replace('v1.0.0/', 'v1.1.0/');
  if (mode === 'duplicate') f.original.assets.push({ ...f.asset, id: 999 });
  if (mode === 'oversized') f.asset.size = 8 * 1024 * 1024 + 1;
  if (mode === 'owner-signature') f.setAsset(f.original, 'benchgo-update.json.sig', Buffer.from('invalid-signature'));
  if (mode === 'owner-app') { f.originalManifest.app.sha256 = 'f'.repeat(64); f.seal(f.original, f.originalManifest); }
  if (mode === 'installer-digest') f.exe.digest = `sha256:${'f'.repeat(64)}`;
  await assert.rejects(f.stage());
  assert.deepEqual(await readdir(f.directory), []);
  assert.deepEqual(f.mutations(), []);
});

test('publication never overwrites different previously staged blockmap bytes', async t => {
  const f = await blockmapFixture(t), existing = Buffer.from('preserved unexpected content');
  await writeFile(resolve(f.directory, f.name), existing);
  await assert.rejects(f.stage(), /Refusing to replace/);
  assert.deepEqual(await readFile(resolve(f.directory, f.name)), existing);
  assert.deepEqual(f.mutations(), []);
});

test('repair copies original native-release bytes for a reused EXE, preserves latest and is idempotent', async t => {
  const f = fixture(t), latestId = f.apps.assets.find(row => row.name === 'latest.yml').id;
  assert.equal(f.current.assets.some(row => row.name === 'latest.yml'), false, 'plugin-only releases need no new native feed or EXE');
  assert.deepEqual(await f.repair(), { releaseVersion: '1.1.0', appVersion: '1.0.0', changed: ['stable.yml'] });
  assert.deepEqual(f.bytesById.get(f.apps.assets.find(row => row.name === 'stable.yml').id), f.feedBytes);
  assert.equal(f.apps.assets.find(row => row.name === 'latest.yml').id, latestId);
  const writes = f.mutations().length;
  assert.deepEqual((await f.repair()).changed, []);
  assert.equal(f.mutations().length, writes, 'identical stable bytes must not be deleted and uploaded again');
  assert.equal(f.apps.assets.some(row => row.name === 'nightly.yml'), false);
});

test('ordinary publication synchronizes both native names even when Windows is not rebuilt', async t => {
  const f = fixture(t); f.apps.assets = [];
  const result = await publishAppChannel({ manifest: f.currentManifest, windowsBuilt: false, publicKey: f.publicKey });
  assert.deepEqual(result.changed, ['latest.yml', 'stable.yml']);
  for (const name of result.changed) assert.deepEqual(f.bytesById.get(f.apps.assets.find(row => row.name === name).id), f.feedBytes);
  assert.equal(f.apps.assets.some(row => row.name === 'nightly.yml'), false);
});

test('a new Windows build preserves the original locally calculated native feed bytes', async t => {
  const f = fixture(t), directory = await mkdtemp(resolve(tmpdir(), 'benchgo-native-feed-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(resolve(directory, 'latest.yml'), f.feedBytes); f.apps.assets = [];
  await publishAppChannel({ manifest: f.currentManifest, directory, windowsBuilt: true });
  assert.deepEqual(await readFile(resolve(directory, 'latest.yml')), f.feedBytes);
  for (const asset of f.apps.assets) assert.deepEqual(f.bytesById.get(asset.id), f.feedBytes);
});

for (const location of ['current', 'original']) test(`repair rejects an invalid ${location} release signature before any write`, async t => {
  const f = fixture(t); f.setAsset(f[location], 'benchgo-update.json.sig', Buffer.from('invalid-signature\n'));
  await assert.rejects(f.repair(), /signature is invalid/); assert.deepEqual(f.mutations(), []);
});

for (const field of ['draft', 'prerelease']) test(`repair rejects a ${field} source release`, async t => {
  const f = fixture(t); f.current[field] = true;
  await assert.rejects(f.repair(), /public stable release/); assert.deepEqual(f.mutations(), []);
});

test('repair rejects tag/source receipt drift and mismatched signed native artifact references', async t => {
  for (const mode of ['receipt', 'native-manifest', 'native-size', 'native-digest', 'feed-digest', 'missing-feed-digest']) {
    await t.test(mode, async t => {
      const f = fixture(t);
      if (mode === 'receipt') f.setAsset(f.current, 'release-source.json', json({ schemaVersion: 1, kind: releaseKind, releaseVersion: '1.1.0', sourceSha: originalSource, manifestSha256: 'f'.repeat(64) }));
      if (mode === 'native-manifest') { f.originalManifest.app.sha256 = 'f'.repeat(64); f.seal(f.original, f.originalManifest); }
      if (mode === 'native-size') f.exe.size++;
      if (mode === 'native-digest') f.exe.digest = `sha256:${'f'.repeat(64)}`;
      if (mode === 'feed-digest') f.original.assets.find(row => row.name === 'latest.yml').digest = `sha256:${'f'.repeat(64)}`;
      if (mode === 'missing-feed-digest') delete f.original.assets.find(row => row.name === 'latest.yml').digest;
      await assert.rejects(f.repair()); assert.deepEqual(f.mutations(), []);
    });
  }
});

test('repair validates the original feed version, URL, size and canonical consistent SHA512', async t => {
  const cases = [feed => { feed.version = '1.0.1'; }, feed => { feed.files[0].url = feed.path = 'https://untrusted.example/installer.exe'; },
    feed => { feed.path = 'relative.exe'; }, feed => { feed.files[0].size++; }, feed => { feed.files[0].sha512 = feed.sha512 = 'not-a-sha512'; },
    feed => { feed.sha512 = Buffer.alloc(64, 1).toString('base64'); }, feed => { feed.files.push({ ...feed.files[0] }); }];
  for (const [index, change] of cases.entries()) await t.test(String(index), async t => {
    const f = fixture(t), feed = structuredClone(f.feed); change(feed); f.setAsset(f.original, 'latest.yml', json(feed));
    await assert.rejects(f.repair(), /does not match/); assert.deepEqual(f.mutations(), []);
  });
});

for (const name of ['latest.yml', 'stable.yml']) {
  test(`repair refuses a newer ${name} and same-version different metadata`, async t => {
    for (const mode of ['newer', 'different']) await t.test(mode, async t => {
      const f = fixture(t), feed = { ...f.feed, ...(mode === 'newer' ? { version: '2.0.0' } : { releaseDate: '2026-11-15T00:00:00Z' }) };
      f.setAsset(f.apps, name, json(feed));
      await assert.rejects(f.repair(), mode === 'newer' ? /cannot roll back/ : /same application version/); assert.deepEqual(f.mutations(), []);
    });
  });
}

test('maintenance repair never creates or rewrites a missing legacy latest feed', async t => {
  const f = fixture(t); f.apps.assets = [];
  await assert.rejects(f.repair(), /existing latest.yml/); assert.deepEqual(f.mutations(), []);
});

test('repair can advance an older stable alias while preserving the original latest metadata', async t => {
  const f = fixture(t), old = f.setAsset(f.apps, 'stable.yml', json({ ...f.feed, version: '0.9.0' }));
  assert.deepEqual((await f.repair()).changed, ['stable.yml']);
  assert(f.mutations().some(row => row.method === 'DELETE' && row.path.endsWith('/' + old.id)));
  assert.deepEqual(f.bytesById.get(f.apps.assets.find(row => row.name === 'stable.yml').id), f.feedBytes);
  assert.equal(f.mutations().filter(row => row.method === 'POST').length, 1);
});

test('normal unified publication retains its explicit workflow gate', async t => {
  const previous = process.env.GITHUB_EVENT_NAME;
  process.env.GITHUB_EVENT_NAME = 'push';
  t.after(() => { if (previous === undefined) delete process.env.GITHUB_EVENT_NAME; else process.env.GITHUB_EVENT_NAME = previous; });
  await assert.rejects(publishRelease({ plan: { sourceSha: 'not-a-valid-github-sha' }, directory: '.' }), /restricted to explicit main-branch/);
});
