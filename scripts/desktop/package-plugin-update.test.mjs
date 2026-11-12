import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertPluginArchiveSize } from './package-plugin-update.mjs';

test('plugin packaging accepts the exact bound and removes oversized or empty archives', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-archive-size-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, 'plugin.tar.gz');
  await writeFile(filename, '12345678');
  assert.equal(await assertPluginArchiveSize(filename, 8), 8);
  assert.equal((await stat(filename)).size, 8);
  await writeFile(filename, '123456789');
  await assert.rejects(assertPluginArchiveSize(filename, 8), /exceeds.*1\.\.8/);
  await assert.rejects(stat(filename), { code: 'ENOENT' });
  await writeFile(filename, '');
  await assert.rejects(assertPluginArchiveSize(filename, 8), /size 0/);
  await assert.rejects(stat(filename), { code: 'ENOENT' });
});
