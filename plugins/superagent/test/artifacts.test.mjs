import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtemp, mkdir, writeFile, rm, symlink, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const requireHarness = createRequire(new URL('../../../deepseek-harness/packages/compaction/compaction-basic/package.json', import.meta.url));
const compactionUrl = pathToFileURL(requireHarness.resolve('@deepseek-ai/dsh-compaction-basic')).href;
const hook = registerHooks({ resolve(specifier, context, next) { return specifier === '@deepseek-ai/dsh-compaction-basic' ? { url: compactionUrl, shortCircuit: true } : next(specifier, context); } });
const { createAssistantArtifacts } = await import('../src/service.mjs');
hook.deregister();

async function fixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), 'assistant-artifacts-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await mkdir(join(workspace, 'artifacts'));
  const files = createAssistantArtifacts({ workspace });
  return { workspace, files, request: (name, options = '') => new Request(`http://localhost/api/commander/assistant/artifact?file=${encodeURIComponent(name)}${options}`) };
}

test('artifact management copies, renames and deletes nested Unicode files without overwriting', async t => {
  const { workspace, files, request } = await fixture(t);
  await mkdir(join(workspace, 'artifacts', '报告'));
  await writeFile(join(workspace, 'artifacts', '报告', '原稿.md'), 'original');
  const hash = (await files.list()).artifacts[0].hash;
  await assert.rejects(files.manage({ op: 'delete', file: '报告/原稿.md', expectedHash: 'stale' }), /已变化/);
  assert.equal((await files.manage({ op: 'copy', file: '报告/原稿.md', name: '副本.md', expectedHash: hash })).file, '报告/副本.md');
  await assert.rejects(files.manage({ op: 'rename', file: '报告/原稿.md', name: '副本.md' }), /同名/);
  assert.equal(await (await files.fetch(request('报告/原稿.md'))).text(), 'original');
  await files.manage({ op: 'rename', file: '报告/原稿.md', name: '完成.md', expectedHash: hash });
  assert.equal((await files.fetch(request('报告/原稿.md'))).status, 404);
  assert.equal(await (await files.fetch(request('报告/完成.md'))).text(), 'original');
  const renamed = (await files.list()).artifacts.find(file => file.name === '报告/完成.md');
  await files.manage({ op: 'delete', file: renamed.name, expectedHash: renamed.hash });
  assert.deepEqual((await files.list()).artifacts.map(row => row.name), ['报告/副本.md']);
});

test('artifact mutations reject traversal, invalid destinations and directory links', async t => {
  const { workspace, files } = await fixture(t);
  await writeFile(join(workspace, 'artifacts', 'safe.md'), 'safe');
  for (const name of ['../escape.md', 'folder/name.md', 'CON.md', 'bad?.md', 'unsupported.exe', 'safe.md ']) {
    await assert.rejects(files.manage({ op: 'copy', file: 'safe.md', name }), /文件名/);
  }
  await assert.rejects(files.manage({ op: 'delete', file: '../safe.md' }), /不存在/);
  const outside = await mkdtemp(join(tmpdir(), 'artifact-mutation-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'secret.md'), 'secret');
  try { await symlink(outside, join(workspace, 'artifacts', 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') return; throw error; }
  await assert.rejects(files.manage({ op: 'delete', file: 'linked/secret.md' }), /不存在/);
});

test('artifact mutations preserve a file modified since the list was loaded', async t => {
  const { workspace, files, request } = await fixture(t);
  await writeFile(join(workspace, 'artifacts', 'draft.md'), 'draft');
  const { hash } = (await files.list()).artifacts[0];
  await writeFile(join(workspace, 'artifacts', 'draft.md'), 'newer draft');
  for (const op of ['delete', 'rename', 'copy']) {
    await assert.rejects(files.manage({ op, file: 'draft.md', name: 'other.md', expectedHash: hash }), /已变化/);
  }
  assert.equal(await (await files.fetch(request('draft.md'))).text(), 'newer draft');
  assert.deepEqual((await files.list()).artifacts.map(row => row.name), ['draft.md']);
});

test('artifacts list real nested files by category with stable pagination', async t => {
  const { workspace, files } = await fixture(t);
  await mkdir(join(workspace, 'artifacts', '报告'));
  const names = ['报告/说明 文档.md', 'report.pdf', 'table.xlsx', 'picture.png', 'clip.mp4', 'podcast.mp3', 'index.html', 'app.tsx', 'ignore.exe'];
  for (const name of names) await writeFile(join(workspace, 'artifacts', name), name);
  const all = await files.list(); assert.equal(all.total, 8);
  assert.deepEqual(new Set(all.artifacts.map(row => row.category)), new Set(['document', 'image', 'video', 'audio', 'web']));
  const documents = await files.list({ category: 'document', limit: 2 });
  assert.equal(documents.total, 3); assert.equal(documents.artifacts.length, 2); assert.ok(documents.nextCursor);
  const remainder = await files.list({ category: 'document', limit: 2, after: documents.nextCursor });
  assert.equal(remainder.artifacts.length, 1); assert.equal(remainder.nextCursor, null);
  assert.equal(new Set([...documents.artifacts, ...remainder.artifacts].map(row => row.name)).size, 3);
  assert.equal((await files.list({ category: 'image' })).artifacts[0].mimeType, 'image/png');
  assert.equal((await files.list({ category: 'video' })).artifacts[0].mimeType, 'video/mp4');
  assert.equal((await files.list({ category: 'audio' })).artifacts[0].mimeType, 'audio/mpeg');
  await assert.rejects(files.list({ category: 'unknown' }), /分类/);
  await assert.rejects(files.list({ limit: 0 }), /分页/);
  await assert.rejects(files.list({ after: 'bad-cursor' }), /游标/);
  await assert.rejects(files.list({ category: 'image', after: documents.nextCursor }), /游标/);
});

test('office and Markdown extensions belong to the document category', async t => {
  const { workspace, files } = await fixture(t);
  const names = ['notes.md', 'report.docx', 'table.xlsx', 'slides.pptx', 'legacy.doc', 'legacy.xls', 'legacy.ppt', 'UPPER.DOCX', 'data.csv'];
  for (const name of names) await writeFile(join(workspace, 'artifacts', name), name);
  const result = await files.list({ category: 'document' });
  assert.deepEqual(new Set(result.artifacts.map(row => row.name)), new Set(names));
  assert.ok(result.artifacts.every(row => row.category === 'document'));
});

test('artifact download preserves MIME and Unicode names, and isolates active web content', async t => {
  const { workspace, files, request } = await fixture(t);
  const html = '<script>fetch("/api/private")</script>';
  await writeFile(join(workspace, 'artifacts', '网页.html'), html);
  await writeFile(join(workspace, 'artifacts', 'sound.mp3'), 'audio-bytes');
  await writeFile(join(workspace, 'artifacts', 'logo.svg'), '<svg/>');
  let response = await files.fetch(request('网页.html'));
  assert.equal(response.status, 200); assert.equal(await response.text(), html);
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.match(response.headers.get('content-disposition'), /^attachment;/);
  assert.ok(response.headers.get('content-disposition').includes(encodeURIComponent('网页.html')));
  assert.match(response.headers.get('content-security-policy'), /sandbox/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  response = await files.fetch(request('sound.mp3')); assert.equal(response.headers.get('content-type'), 'audio/mpeg'); assert.equal(await response.text(), 'audio-bytes');
  response = await files.fetch(request('sound.mp3', '&download=1')); assert.match(response.headers.get('content-disposition'), /^attachment;/); await response.arrayBuffer();
  response = await files.fetch(request('logo.svg')); assert.match(response.headers.get('content-disposition'), /^attachment;/); await response.arrayBuffer();
  for (const name of ['../config.json', '/report.pdf', 'folder/../report.pdf', 'folder\\report.pdf', 'C:/report.pdf', 'bad\u0000.png', 'program.exe']) assert.equal((await files.fetch(request(name))).status, 400, name);
  assert.equal((await files.fetch(request('missing.pdf'))).status, 404);
});

test('artifact directory links never expose files outside the workspace and retain the size limit', async t => {
  const { workspace, files, request } = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), 'assistant-artifact-outside-')); t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'private.txt'), 'private');
  const large = await open(join(workspace, 'artifacts', 'large.mp4'), 'w'); await large.truncate(25 * 1024 * 1024 + 1); await large.close();
  assert.equal((await files.list()).total, 0); assert.equal((await files.fetch(request('large.mp4'))).status, 404);
  try { await symlink(outside, join(workspace, 'artifacts', 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.diagnostic('Directory links are unavailable in this environment'); return; } throw error; }
  assert.equal((await files.list()).total, 0); assert.equal((await files.fetch(request('linked/private.txt'))).status, 404);
  const linkedWorkspace = join(workspace, 'linked-workspace'); await mkdir(linkedWorkspace);
  await symlink(outside, join(linkedWorkspace, 'artifacts'), process.platform === 'win32' ? 'junction' : 'dir');
  const linkedFiles = createAssistantArtifacts({ workspace: linkedWorkspace });
  assert.equal((await linkedFiles.list()).total, 0); assert.equal((await linkedFiles.fetch(request('private.txt'))).status, 404);
});

test('artifact PDF preview passes only verified bytes and preserves download route', async t => {
  const { workspace, request } = await fixture(t);
  await writeFile(join(workspace, 'artifacts', 'slides.pptx'), 'source');
  let calls = 0;
  const files = createAssistantArtifacts({ workspace, preview: { async convert(input) { calls++; assert.equal(input.name, 'slides.pptx'); assert.equal(input.bytes.toString(), 'source'); return Buffer.from('%PDF-test'); } } });
  const response = await files.fetch(request('slides.pptx', '&preview=pdf'));
  assert.equal(response.headers.get('content-type'), 'application/pdf'); assert.equal(await response.text(), '%PDF-test');
  assert.equal(await (await files.fetch(request('slides.pptx', '&download=1'))).text(), 'source');
  assert.equal((await files.fetch(request('../slides.pptx', '&preview=pdf'))).status, 400); assert.equal(calls, 1);
  const unavailable = createAssistantArtifacts({ workspace, preview: { async convert() { throw Object.assign(new Error('missing'), { status: 503, code: 'PREVIEW_CONVERTER_UNAVAILABLE' }); } } });
  assert.equal((await unavailable.fetch(request('slides.pptx', '&preview=pdf'))).status, 503);
});
