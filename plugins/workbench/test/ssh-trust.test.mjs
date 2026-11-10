import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ssh2 from 'ssh2';
import { Client, openSshTrust, probeFingerprint } from '../src/ssh-trust.mjs';

test('real SSH handshake probes without authenticating and pins every subsequent connection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-ssh-'));
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  let authenticationAttempts = 0;
  const server = new ssh2.Server({ hostKeys: [privateKey] }, client => {
    client.on('error', () => {});
    client.on('authentication', context => { authenticationAttempts++; context.reject(); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const target = { host: '127.0.0.1', port: server.address().port };
  let trust;
  try {
    trust = await openSshTrust(directory);
    const candidate = await probeFingerprint(target);
    assert.match(candidate.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);
    assert.equal(authenticationAttempts, 0);
    assert.throws(() => new Client().connect({ ...target, username: 'test', password: 'secret' }), /先在 BenchGo 工作台确认/);
    await trust.confirm(candidate);
    const attempt = () => new Promise(resolve => {
      const client = new Client();
      client.on('error', error => { client.destroy(); resolve(error); });
      client.connect({ ...target, username: 'test', password: 'secret', readyTimeout: 2000 });
    });
    assert.match((await attempt()).message, /authentication/i);
    assert.ok(authenticationAttempts > 0);
    const attemptsBeforeMismatch = authenticationAttempts;
    await trust.confirm({ ...candidate, fingerprint: 'SHA256:' + 'A'.repeat(43) });
    assert.match((await attempt()).message, /host.*verification/i);
    assert.equal(authenticationAttempts, attemptsBeforeMismatch, 'changed host key is rejected before credentials are sent');
    await trust.close();
    trust = await openSshTrust(directory);
    assert.equal(trust.list()[0].fingerprint, 'SHA256:' + 'A'.repeat(43));
  } finally {
    await trust?.close();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
