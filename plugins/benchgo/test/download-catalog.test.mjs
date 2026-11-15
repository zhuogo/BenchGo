import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchReleaseArtifact, fetchUpdateArtifact, fetchVerifiedDownloadCatalog, releaseDownloadUrl } from '../shared/update-feed.mjs';

const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
const contents = Buffer.from('native platform archive');
const artifact = () => ({ target: 'mac-arm64', version: '1.0.0', url: releaseDownloadUrl('benchgo-1.0.0-mac-arm64.zip', 'v1.0.0'), size: contents.length, sha256: createHash('sha256').update(contents).digest('hex') });
const catalog = () => ({ schemaVersion: 1, releaseVersion: '1.1.0', sourceSha: 'a'.repeat(40), files: [artifact()] });
const signed = value => {
  const bytes = Buffer.from(JSON.stringify(value)), signature = sign(null, bytes, keys.privateKey).toString('base64');
  return url => new Response(url.endsWith('.sig') ? signature : bytes);
};

test('fixed download catalogs are verified with the existing key and support explicitly reused immutable component URLs', async () => {
  const value = catalog(), urls = [], fetcher = signed(value);
  const result = await fetchVerifiedDownloadCatalog({ releaseVersion: value.releaseVersion, publicKey, config: { source: 'github' }, fetcher: url => { urls.push(url); return fetcher(url); } });
  assert.deepEqual(result.catalog, value);
  assert.deepEqual(urls, ['downloads.json', 'downloads.json.sig'].map(name => releaseDownloadUrl(name, 'v1.1.0')));
  assert.equal(Buffer.isBuffer(result.bytes), true); assert.equal(Buffer.isBuffer(result.signatureBytes), true);
});

test('a signed download catalog still rejects the wrong release, unsafe URLs, missing hashes and duplicates', async () => {
  for (const change of [
    value => { value.releaseVersion = '1.2.0'; },
    value => { value.sourceSha = 'unknown'; },
    value => { value.files[0].url = 'https://untrusted.example/program.zip'; },
    value => { value.files[0].url = releaseDownloadUrl('program.zip', 'latest'); },
    value => { delete value.files[0].sha256; },
    value => { value.files.push(value.files[0]); },
  ]) {
    const value = catalog(); change(value);
    await assert.rejects(fetchVerifiedDownloadCatalog({ releaseVersion: '1.1.0', publicKey, fetcher: signed(value) }));
  }
});

test('missing fixed catalog is unpublished while a missing signature remains an authentication failure', async () => {
  const value = catalog(), fetcher = signed(value);
  await assert.rejects(fetchVerifiedDownloadCatalog({ releaseVersion: '1.1.0', publicKey, fetcher: url => url.endsWith('.sig') ? fetcher(url) : new Response('', { status: 404 }) }), { code: 'UPDATE_UNPUBLISHED' });
  await assert.rejects(fetchVerifiedDownloadCatalog({ releaseVersion: '1.1.0', publicKey, fetcher: url => url.endsWith('.sig') ? new Response('', { status: 404 }) : fetcher(url) }), { code: 'UPDATE_HTTP' });
});

test('native zip distributions use the same streaming hash verification without weakening plugin package validation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-native-download-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'native.zip');
  await fetchReleaseArtifact(artifact(), { file, fetcher: async () => new Response(contents) });
  assert.deepEqual(await readFile(file), contents);
  await assert.rejects(fetchUpdateArtifact(artifact(), { file: join(directory, 'not-a-plugin.zip') }), { code: 'UPDATE_MANIFEST' });
  assert.deepEqual(await readdir(directory), ['native.zip']);
});

test('large native resource descriptors are bounded independently of the existing 512 MiB plugin cap', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-native-limit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const value = { ...artifact(), size: 650 * 1024 * 1024 };
  let calls = 0;
  await assert.rejects(fetchReleaseArtifact(value, { file: join(directory, 'large.zip'), fetcher: async () => { calls++; return new Response(contents); } }), { code: 'UPDATE_SIZE' });
  assert.equal(calls, 1, 'native descriptor is allowed before streamed content is checked');
  await assert.rejects(fetchReleaseArtifact({ ...value, size: 1024 * 1024 * 1024 + 1 }, { file: join(directory, 'too-large.zip') }), { code: 'UPDATE_SIZE' });
  const plugin = { ...value, url: releaseDownloadUrl('benchgo-1.0.0-plugin.tar.gz', 'v1.0.0') };
  await assert.rejects(fetchUpdateArtifact(plugin, { file: join(directory, 'too-large-plugin.tar.gz') }), { code: 'UPDATE_MANIFEST' });
  assert.deepEqual(await readdir(directory), []);
});
