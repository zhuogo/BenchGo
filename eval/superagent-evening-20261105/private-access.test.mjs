import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertPrivateAccess, createPrivateDirectory } from './private-access.mjs';

test('new directory is private before use', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'benchgo-acl-test-'));
  try {
    const directory = join(parent, 'private');
    await createPrivateDirectory(directory);
    await assertPrivateAccess(directory);
  } finally { await rm(parent, { recursive: true, force: true }); }
});
