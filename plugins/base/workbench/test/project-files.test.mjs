import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { mountProjectFiles } from '../src/project-files.mjs';

test('project file actions mutate the owning workspace without replacing existing entries', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-project-files-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = join(directory, 'project');
  await mkdir(workspace);
  let selected = workspace, route;
  mountProjectFiles({
    effect: setup => setup(),
    connection: { fetch: { register: value => { route = value; } } },
    workspaceFiles: { scopeOf: async id => id === 'session' ? { workspaceRoot: selected } : undefined },
    fs: { processPathFromHostPath: path => resolve(path) },
  });
  const call = async (action, path, extra = {}) => {
    const response = await route.fetch(new Request('https://device.test' + route.path, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://device.test' },
      body: JSON.stringify({ action, path, sessionId: 'session', workspace, ...extra }),
    }));
    return { status: response.status, body: await response.json() };
  };

  assert.equal((await call('new-folder', workspace, { name: '目录' })).status, 200);
  assert.equal((await call('new-folder', workspace, { name: '备份' })).status, 200);
  assert.equal((await call('new-file', workspace, { name: '草稿.txt' })).status, 200);
  await writeFile(join(workspace, '草稿.txt'), '保留编辑保存的内容');
  assert.equal((await call('rename', '草稿.txt', { name: '最终.txt' })).status, 200);
  assert.equal((await call('move', '最终.txt', { destination: '目录' })).status, 200);
  assert.equal(await readFile(join(workspace, '目录', '最终.txt'), 'utf8'), '保留编辑保存的内容');
  assert.equal((await call('copy', '目录', { destination: '备份' })).status, 200);
  assert.deepEqual(await readdir(join(workspace, '备份')), ['目录']);
  assert.equal(await readFile(join(workspace, '备份', '目录', '最终.txt'), 'utf8'), '保留编辑保存的内容');
  assert.equal((await call('copy', '目录', { destination: '备份' })).status, 409);
  assert.equal((await call('move', '目录', { destination: '目录' })).status, 409);
  assert.equal((await call('move', '目录', { destination: '备份' })).status, 409);
  const competing = await Promise.all([call('new-file', '目录', { name: '竞争.txt' }), call('new-file', '目录', { name: '竞争.txt' })]);
  assert.deepEqual(competing.map(result => result.status).sort(), [200, 409]);
  assert.equal((await call('delete', workspace)).status, 400);
  assert.equal((await call('delete', '..')).status, 403);
  const outside = join(directory, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'keep.txt'), '保留');
  await symlink(outside, join(workspace, '外部'), 'junction');
  assert.equal((await call('delete', '外部/keep.txt')).status, 409);
  assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), '保留');
  selected = outside;
  assert.equal((await call('delete', '目录')).status, 409);
  selected = workspace;
  assert.equal((await call('delete', '目录')).status, 200);
  assert.equal((await call('delete', '备份/目录/最终.txt')).status, 200);
  assert.deepEqual(await readdir(join(workspace, '备份', '目录')), []);
});
