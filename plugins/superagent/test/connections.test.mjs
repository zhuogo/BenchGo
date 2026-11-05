import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantConnections } from '../src/connections.mjs';

test('connection edits preserve unrelated fields and reject stale or secret writes across reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-connections-'));
  let store = createAssistantConnections({ directory });
  try {
    store.update({ appId: 'app-opaque', appSecretRef: 'env:FEISHU_SECRET', ownerOpenIds: ['owner'] }, { revision: 0 });
    store.update({ chatIds: ['chat'] }, { revision: 1 });
    assert.throws(() => store.update({ appId: 'stale' }, { revision: 1 }), { code: 'REVISION_CONFLICT' });
    assert.throws(() => store.update({ appSecret: 'must-not-store' }, { revision: 2 }));
    store.update({ enabled: true }, { revision: 2 });
    store.close(); store = createAssistantConnections({ directory });
    assert.equal(store.read().revision, 3);
    assert.equal(store.read().config.appId, 'app-opaque');
    assert.deepEqual(store.read().config.ownerOpenIds, ['owner']);
    assert.deepEqual(store.read().config.chatIds, ['chat']);
    assert.equal(store.read().config.enabled, true);
    assert.ok(!JSON.stringify(store.read()).includes('must-not-store'));
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('automatic admission settings persist exactly and can be revoked without losing identities or rules', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-connections-'));
  let store = createAssistantConnections({ directory });
  try {
    assert.equal(store.read().config.admissionMode, 'manual');
    store.update({ admissionMode: 'auto', machineOpenIds: ['machine:Opaque/X'], enabledRuleIds: ['Rule:Case/X'], ownerOpenIds: ['owner'], chatIds: ['chat'] }, { revision: 0 });
    store.close(); store = createAssistantConnections({ directory });
    assert.equal(store.read().config.admissionMode, 'auto');
    assert.deepEqual(store.read().config.machineOpenIds, ['machine:Opaque/X']);
    assert.deepEqual(store.read().config.enabledRuleIds, ['Rule:Case/X']);
    store.update({ admissionMode: 'manual' }, { revision: 1 });
    assert.deepEqual(store.read().config.machineOpenIds, ['machine:Opaque/X']);
    assert.deepEqual(store.read().config.enabledRuleIds, ['Rule:Case/X']);
    assert.deepEqual(store.read().config.ownerOpenIds, ['owner']);
    assert.deepEqual(store.read().config.chatIds, ['chat']);
    assert.throws(() => store.update({ admissionMode: 'AUTO' }, { revision: 2 }), /准入模式/);
    assert.throws(() => store.update({ machineOpenIds: 'machine' }, { revision: 2 }), /machineOpenIds/);
    assert.throws(() => store.update({ enabledRuleIds: [''] }, { revision: 2 }), /enabledRuleIds/);
    assert.equal(store.read().revision, 2);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
