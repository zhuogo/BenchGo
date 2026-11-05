import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantSystemFiles } from '../src/system-files.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'assistant-system-files-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, files: createAssistantSystemFiles({ directory }), request: file => new Request(`http://localhost/api/commander/assistant/system-file?file=${encodeURIComponent(file)}`) };
}

test('system files browse the configuration root and nested workspace with read-only downloads', async t => {
  const { directory, files, request } = await fixture(t);
  await mkdir(join(directory, 'workspace'));
  await writeFile(join(directory, 'IDENTITY.md'), '# Assistant');
  await writeFile(join(directory, 'config.json'), '{"models":[]}');
  await writeFile(join(directory, 'workspace', 'unknown.bin'), 'binary');
  const root = await files.list();
  assert.equal(root.parentPath, null);
  assert.equal(root.files[0].kind, 'directory');
  assert.deepEqual(root.files.map(row => row.name), ['workspace', 'config.json', 'IDENTITY.md']);
  const nested = await files.list({ path: 'workspace' });
  assert.equal(nested.parentPath, '');
  assert.equal(nested.files[0].path, 'workspace/unknown.bin');
  const response = await files.fetch(request('IDENTITY.md'));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '# Assistant');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match((await files.fetch(request('workspace/unknown.bin'))).headers.get('content-disposition'), /^attachment/);
});

test('system files reject traversal, directory reads and oversized content', async t => {
  const { directory, files, request } = await fixture(t);
  for (const path of ['../secret', '/secret', 'C:/secret', 'a\\b', 'a/../b']) {
    await assert.rejects(files.list({ path }), /文件路径无效/);
    assert.equal((await files.fetch(request(path))).status, 400);
  }
  await mkdir(join(directory, 'folder'));
  assert.equal((await files.fetch(request('folder'))).status, 404);
  assert.equal((await files.fetch(request('missing'))).status, 404);
  const handle = await open(join(directory, 'large.db'), 'w');
  await handle.truncate(25 * 1024 * 1024 + 1); await handle.close();
  assert.equal((await files.list()).files.find(row => row.name === 'large.db').available, false);
  assert.equal((await files.fetch(request('large.db'))).status, 413);
});

test('system files exclude directory links outside the configuration root', async t => {
  const { directory, files, request } = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), 'assistant-system-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'secret.txt'), 'private');
  try { await symlink(outside, join(directory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('symlinks unavailable'); throw error; }
  assert.equal((await files.list()).files.length, 0);
  await assert.rejects(files.list({ path: 'linked' }));
  assert.equal((await files.fetch(request('linked/secret.txt'))).status, 404);
});

test('system files expose UI entries and bounded text previews', async t => {
  const { directory, files } = await fixture(t);
  await writeFile(join(directory, 'config.json'), '{"name":"助手"}');
  await writeFile(join(directory, 'large.log'), 'a'.repeat(140000));
  await writeFile(join(directory, 'binary.bin'), Buffer.from([0, 1, 2]));
  const listing = await files.list();
  assert.equal(listing.root, directory);
  assert.equal(listing.entries.find(row => row.name === 'config.json').type, 'file');
  assert.equal((await files.read({ path: 'config.json' })).content, '{"name":"助手"}');
  const large = await files.read({ path: 'large.log' });
  assert.equal(large.truncated, true);
  assert.equal(large.content.length, 128 * 1024);
  assert.equal((await files.read({ path: 'binary.bin' })).content, null);
  await assert.rejects(files.read({ path: '../secret' }));
});

test('system-file PDF preview reuses bounded file access', async t => {
  const { directory, request } = await fixture(t);
  await writeFile(join(directory, 'slides.ppt'), 'source');
  const files = createAssistantSystemFiles({ directory, preview: { async convert({ name, bytes }) { assert.equal(name, 'slides.ppt'); assert.equal(bytes.toString(), 'source'); return Buffer.from('%PDF-test'); } } });
  const response = await files.fetch(new Request(request('slides.ppt').url + '&preview=pdf'));
  assert.equal(response.headers.get('content-type'), 'application/pdf'); assert.equal(await response.text(), '%PDF-test');
});
