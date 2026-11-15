import test from 'node:test';
import assert from 'node:assert/strict';
import { installResourceOpener, openRemoteResource } from '../client/resource-navigation-store.mjs';

test('reply file navigation checks the current chat before querying devices and immediately before opening', async t => {
  const device = { id: 'device-b', hostId: 'host-b', authorizationId: 'auth-b', kind: 'remote' };
  const resource = { kind: 'sessions', resourceId: 'worker-session', file: { path: '/b/output.md', line: 7 } };
  const calls = [];
  t.after(installResourceOpener((device, resource) => calls.push([device, resource])));
  let current = false, release, queries = 0;
  const options = { isCurrent: () => current, request: () => { queries++; return new Promise(resolve => { release = resolve; }); } };
  await assert.rejects(openRemoteResource({ device, resource }, options), /当前聊天已切换/);
  assert.equal(queries, 0);
  current = true;
  const pending = openRemoteResource({ device, resource }, options);
  current = false; release({ devices: [device] });
  await assert.rejects(pending, /当前聊天已切换/);
  assert.deepEqual(calls, [], 'a late device-directory response cannot switch the new chat');
  await openRemoteResource({ device, resource }, { request: async () => ({ devices: [device] }) });
  assert.deepEqual(calls, [[device, resource]], 'existing callers retain their unguarded navigation behavior');
});
