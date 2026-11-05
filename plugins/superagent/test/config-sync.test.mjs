import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfigSync, saveConfigPatch } from '../client/config-sync.mjs';

test('stale motion setting retries against latest revision without losing unrelated fields', async () => {
  const base = { revision: 1, cardMotion: true, name: '' };
  const latest = { ...base, revision: 2, name: 'User chosen', pet: { kind: 'custom' } };
  const calls = [];
  const api = async (action, args) => {
    calls.push({ action, args });
    if (action === 'state') return { config: latest };
    if (args.revision === 1) throw Object.assign(new Error('conflict'), { status: 409 });
    assert.deepEqual(args, { revision: 2, patch: { cardMotion: false } });
    return { ...latest, ...args.patch, revision: 3 };
  };
  const result = await saveConfigPatch(api, base, { cardMotion: false });
  assert.equal(result.name, latest.name);
  assert.equal(result.pet, latest.pet);
  assert.equal(result.cardMotion, false);
  assert.equal(calls.length, 3);
});

test('concurrent edits to the same field are preserved instead of overwritten', async () => {
  let writes = 0;
  const api = async action => {
    if (action === 'state') return { config: { revision: 2, name: 'Elsewhere' } };
    writes++;
    throw Object.assign(new Error('conflict'), { status: 409 });
  };
  await assert.rejects(saveConfigPatch(api, { revision: 1, name: 'Before' }, { name: 'Mine' }), /其他位置修改/);
  assert.equal(writes, 1);
});

test('already satisfied changes do not write again and transport errors are not retried', async () => {
  let writes = 0;
  const api = async action => {
    if (action === 'state') return { config: { revision: 2, cardMotion: false } };
    writes++;
    throw Object.assign(new Error('conflict'), { status: 409 });
  };
  assert.equal((await saveConfigPatch(api, { revision: 1, cardMotion: true }, { cardMotion: false })).revision, 2);
  assert.equal(writes, 1);
  let requests = 0;
  await assert.rejects(saveConfigPatch(async () => { requests++; throw new Error('offline'); }, { revision: 1 }, { cardMotion: false }), /offline/);
  assert.equal(requests, 1);
});

test('late polls cannot overwrite a saved card, including same-revision identity reads', () => {
  const sync = createConfigSync();
  const poll = sync.begin(), save = sync.begin();
  sync.accept({ revision: 2, cardHtml: '<b>New</b>', cardMotion: false, name: 'New' }, save);
  sync.accept({ revision: 1, cardHtml: 'Old' }, poll);
  assert.equal(sync.getSnapshot().cardHtml, '<b>New</b>');
  sync.accept({ revision: 2, cardHtml: 'Old', name: 'Old' }, poll);
  assert.equal(sync.getSnapshot().name, 'New');
  const next = sync.begin();
  sync.accept({ ...sync.getSnapshot(), name: 'Updated in IDENTITY.md' }, next);
  assert.equal(sync.getSnapshot().name, 'Updated in IDENTITY.md');
  assert.equal(sync.getSnapshot().cardMotion, false);
});

test('subscriptions update on actual changes and higher revision wins over request start order', () => {
  const sync = createConfigSync();
  let calls = 0;
  const unsubscribe = sync.subscribe(() => calls++);
  const earlier = sync.begin(), later = sync.begin();
  sync.accept({ revision: 1, cardHtml: null }, later);
  sync.accept({ revision: 1, cardHtml: null }, sync.begin());
  assert.equal(calls, 1);
  sync.accept({ revision: 2, cardHtml: 'saved' }, earlier);
  assert.equal(sync.getSnapshot().cardHtml, 'saved');
  assert.equal(calls, 2);
  unsubscribe();
  sync.accept({ revision: 3, cardHtml: null }, sync.begin());
  assert.equal(calls, 2);
});
