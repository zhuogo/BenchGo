import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseSmokePrivateJson, safeSmokeDiagnostic, validateSmokeConnection, verifySmokeInput } from './smoke-linux.mjs';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

test('private installer response validates version, token, certificate pin and port without exposing values', () => {
  const value = { version: '0.1.2', port: 12345, token: 'a'.repeat(43), pin: 'b'.repeat(43) + '=', deviceId: 'test-device', persistent: true };
  assert.equal(validateSmokeConnection(value, '0.1.2'), value);
  for (const change of [{ version: '0.1.1' }, { port: 0 }, { token: 'private-secret' }, { pin: '' }, { persistent: undefined }]) {
    assert.throws(() => validateSmokeConnection({ ...value, ...change }, '0.1.2'), error => !error.message.includes('private-secret') && /Invalid private/.test(error.message));
  }
});

test('safe diagnostics and malformed private JSON never reproduce bearer tokens or secret content', () => {
  const privateText = 'Bearer hidden-secret token=hidden-secret {"token":"hidden-secret"} ERR_MODULE_NOT_FOUND ECONNREFUSED E404';
  assert.equal(safeSmokeDiagnostic(privateText), 'ERR_MODULE_NOT_FOUND, ECONNREFUSED, E404');
  assert.equal(safeSmokeDiagnostic('hidden-secret'), '');
  assert.throws(() => parseSmokePrivateJson('hidden-secret invalid-json'), error => error.message === 'Private installer metadata is invalid JSON');
  assert.deepEqual(parseSmokePrivateJson('{"version":"0.1.2"}'), { version: '0.1.2' });
});

test('native smoke rejects a changed archive or source before privileged account setup', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-smoke-input-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const name = 'benchgo-0.1.2-linux-server.tar.gz', bytes = Buffer.from('fixture-archive');
  await writeFile(join(directory, name), bytes);
  await writeFile(join(directory, name + '.sha256'), `${sha256(bytes)}  ${name}\n`);
  const files = [];
  for (const file of [name, name + '.sha256']) { const data = await readFile(join(directory, file)); files.push({ name: file, size: data.length, sha256: sha256(data) }); }
  const receipt = { schemaVersion: 1, sourceSha: 'a'.repeat(40), version: '0.1.2', pluginVersion: '0.1.2', platform: 'linux', arch: 'x64', kind: 'server', verified: ['distribution-inventory'], files };
  await writeFile(join(directory, 'build-source.json'), JSON.stringify(receipt));
  assert.equal((await verifySmokeInput(directory, 'a'.repeat(40))).archive, name);
  await assert.rejects(verifySmokeInput(directory, 'b'.repeat(40)), /source or identity/);
  await writeFile(join(directory, name), 'modified');
  await assert.rejects(verifySmokeInput(directory, 'a'.repeat(40)), /checksum mismatch/);
});
