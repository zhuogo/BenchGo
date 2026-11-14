import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishWebCatalog } from './publish-web-catalog.mjs';
import { sha256 } from './github.mjs';

const version = '0.1.2', source = 'a'.repeat(40), previous = 'b'.repeat(40), baseTree = 'c'.repeat(40);
const tag = `v${version}`, paths = ['downloads.json', 'downloads.json.sig'].map(name => `releases/${tag}/${name}`);
const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });

async function fixture(t, { existing = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-web-catalog-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const catalog = { schemaVersion: 1, releaseVersion: version, sourceSha: source,
    files: [{ url: `https://github.com/zhuogo/BenchGo/releases/download/${tag}/benchgo-0.1.2-android.apk`, size: 10, sha256: 'd'.repeat(64) }] };
  const raw = Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`), signature = Buffer.from(`${sign(null, raw, keys.privateKey).toString('base64')}\n`);
  const bytes = [raw, signature];
  for (const [i, path] of paths.entries()) await writeFile(join(directory, path.split('/').at(-1)), bytes[i]);
  const release = { draft: false, prerelease: false, tag_name: tag, target_commitish: source,
    assets: bytes.map((value, i) => ({ id: i + 1, name: paths[i].split('/').at(-1), size: value.length, digest: `sha256:${sha256(value)}` })) };
  const files = new Map(existing ? [[`releases/v0.1.1/downloads.json`, Buffer.from('historical')]] : []), blobs = new Map(), calls = [];
  const state = { head: existing ? previous : null, release, commitSource: source, files };
  let serial = 1;
  const id = () => (serial++).toString(16).padStart(40, '0');
  const request = async (path, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ path, method: options.method ?? 'GET', body });
    if (path === `/releases/tags/${tag}`) return release;
    if (path === `/commits/${tag}`) return { sha: state.commitSource };
    if (path === '/git/ref/heads/release-metadata') return state.head ? { object: { sha: state.head } } : null;
    if (path.startsWith('/contents/')) {
      const value = files.get(path.slice('/contents/'.length).split('?')[0]);
      return value ? { type: 'file', size: value.length, encoding: 'base64', content: value.toString('base64') } : null;
    }
    if (path === `/git/commits/${previous}`) return { tree: { sha: baseTree } };
    if (path === '/git/blobs') {
      const sha = id(); blobs.set(sha, Buffer.from(body.content, body.encoding)); return { sha };
    }
    if (path === '/git/trees') {
      for (const entry of body.tree) files.set(entry.path, blobs.get(entry.sha));
      return { sha: id() };
    }
    if (path === '/git/commits') return { sha: id() };
    if (path === '/git/refs' || path === '/git/refs/heads/release-metadata') { state.head = body.sha; return {}; }
    throw new Error(`Unexpected mock call ${path}`);
  };
  return { directory, bytes, release, calls, files, state, options: { directory, releaseVersion: version, sourceSha: source, publicKey,
    request, downloadAsset: async asset => bytes[asset.id - 1] } };
}

test('creates a root metadata branch with original signed bytes and becomes idempotent', async t => {
  const f = await fixture(t), result = await publishWebCatalog(f.options);
  assert.equal(result.changed, true);
  for (const [i, path] of paths.entries()) assert.deepEqual(f.files.get(path), f.bytes[i]);
  assert.deepEqual(f.calls.find(call => call.path === '/git/commits').body.parents, []);
  assert.equal(f.calls.find(call => call.path === '/git/refs').body.ref, 'refs/heads/release-metadata');
  const writes = f.calls.filter(call => call.method !== 'GET').length;
  assert.equal((await publishWebCatalog(f.options)).changed, false);
  assert.equal(f.calls.filter(call => call.method !== 'GET').length, writes);
});

test('preserves the existing base tree, history and unrelated releases without force', async t => {
  const f = await fixture(t, { existing: true });
  await publishWebCatalog(f.options);
  assert.equal(f.calls.find(call => call.path === '/git/trees').body.base_tree, baseTree);
  assert.deepEqual(f.calls.find(call => call.path === '/git/commits').body.parents, [previous]);
  assert.equal(f.calls.find(call => call.path === '/git/refs/heads/release-metadata').body.force, false);
  assert.equal(f.files.get('releases/v0.1.1/downloads.json').toString(), 'historical');
});

test('refuses different existing bytes before making any mutation', async t => {
  const f = await fixture(t, { existing: true });
  f.files.set(paths[0], Buffer.from('unknown'));
  await assert.rejects(publishWebCatalog(f.options), /Refusing to overwrite/);
  assert.equal(f.calls.filter(call => call.method !== 'GET').length, 0);
});

test('repairs an incomplete pair while preserving the original existing half', async t => {
  const f = await fixture(t, { existing: true });
  f.files.set(paths[0], f.bytes[0]);
  await publishWebCatalog(f.options);
  assert.deepEqual(f.calls.find(call => call.path === '/git/trees').body.tree.map(row => row.path), [paths[1]]);
});

test('rejects tampered signatures, versions, source and unsafe URLs', async t => {
  for (const change of ['signature', 'version', 'source', 'url']) {
    const f = await fixture(t), catalog = JSON.parse(f.bytes[0]);
    if (change === 'signature') await writeFile(join(f.directory, 'downloads.json.sig'), Buffer.alloc(64).toString('base64'));
    else {
      if (change === 'version') catalog.releaseVersion = '0.1.3';
      if (change === 'source') catalog.sourceSha = previous;
      if (change === 'url') catalog.files[0].url = 'https://untrusted.example/payload';
      const raw = Buffer.from(JSON.stringify(catalog));
      await writeFile(join(f.directory, 'downloads.json'), raw);
      await writeFile(join(f.directory, 'downloads.json.sig'), sign(null, raw, keys.privateKey).toString('base64'));
    }
    await assert.rejects(publishWebCatalog(f.options));
    assert.equal(f.calls.length, 0);
  }
});

test('rejects unpublished releases, tag/source mismatch and asset digest/byte mismatch', async t => {
  for (const change of ['draft', 'prerelease', 'target', 'tag', 'digest', 'bytes']) {
    const f = await fixture(t);
    if (change === 'draft' || change === 'prerelease') f.release[change] = true;
    if (change === 'target') f.release.target_commitish = previous;
    if (change === 'tag') f.state.commitSource = previous;
    if (change === 'digest') f.release.assets[0].digest = `sha256:${'0'.repeat(64)}`;
    if (change === 'bytes') f.options.downloadAsset = async () => Buffer.from('wrong');
    await assert.rejects(publishWebCatalog(f.options));
    assert.equal(f.calls.filter(call => call.method !== 'GET').length, 0);
  }
});

test('fails closed on a concurrent non-fast-forward update', async t => {
  const f = await fixture(t, { existing: true }), original = f.options.request;
  f.options.request = (path, options) => path === '/git/refs/heads/release-metadata'
    ? Promise.reject(new Error('GitHub HTTP 422: not a fast forward')) : original(path, options);
  await assert.rejects(publishWebCatalog(f.options), /not a fast forward/);
  assert.equal(f.state.head, previous);
});
