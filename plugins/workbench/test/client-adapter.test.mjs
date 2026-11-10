import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { unwrapClient } from '../scripts/vendor-adapter.mjs';
const require = createRequire(new URL('../../benchgo/package.json', import.meta.url));
test('pinned vendor client factories unwrap without introducing another module registration', async () => {
  for (const name of ['@linxin666/dsh-ssh', 'dsh-better-sidebar']) {
    const adapted = unwrapClient(await readFile(require.resolve(`${name}/client`), 'utf8'), name);
    assert.match(adapted, /^module\.exports =/);
    assert.doesNotMatch(adapted, /^window\.__ModuleLoader__\.load/);
    assert.match(adapted, /return module\.exports/);
    if (name.includes('dsh-ssh')) assert.doesNotMatch(adapted, /reportDailyHeartbeat\(\[\{ name:/);
  }
});
test('unknown vendor wrappers fail closed for explicit version review', () => {
  assert.throws(() => unwrapClient('export const apply = () => {};', 'dsh-better-sidebar'), /Unsupported/);
});
