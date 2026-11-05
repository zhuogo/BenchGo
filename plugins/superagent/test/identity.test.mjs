import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantStore } from '../src/store.mjs';
import { identityName, withIdentityName } from '../src/identity.mjs';

async function fixture(t) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'assistant-identity-'));
  const stores = [];
  const open = async () => { const store = await createAssistantStore({ dataDirectory }); stores.push(store); return store; };
  t.after(async () => { for (const store of stores) store.close(); await rm(dataDirectory, { recursive: true, force: true }); });
  return { store: await open(), open };
}

test('identity parser reads only frontmatter and preserves unrelated fields', () => {
  assert.equal(identityName('# My name is not metadata\nname: prose'), null);
  const text = '---\navatar: benchgo\nname: "Before"\n---\n\nBody';
  assert.equal(identityName(text), 'Before');
  assert.equal(withIdentityName(text, 'After'), '---\navatar: benchgo\nname: "After"\n---\n\nBody');
  assert.throws(() => identityName('---\nname: A\nname: B\n---\n'), /duplicate/);
});

test('name edits write IDENTITY.md and new sessions read the new identity', async t => {
  const { store } = await fixture(t);
  const oldSession = await store.getSessionContext('old-session');
  await store.updateConfig({ name: 'BenchGo Assistant' });
  const current = await store.documents.read('IDENTITY.md');
  assert.equal(identityName(current.content), 'BenchGo Assistant');
  assert.equal((await store.getConfig()).name, 'BenchGo Assistant');
  assert.equal(identityName(oldSession.documents.find(row => row.name === 'IDENTITY.md').content), null);
  const nextSession = await store.getSessionContext('new-session');
  assert.equal(identityName(nextSession.documents.find(row => row.name === 'IDENTITY.md').content), 'BenchGo Assistant');
  assert.equal((await store.documents.versions('IDENTITY.md')).length > 1, true);
});

test('profile import adapts a legacy display name without a dedicated identity migration', async t => {
  const { store } = await fixture(t);
  const bundle = await store.profileExport();
  bundle.config.name = 'Imported Assistant';
  await store.profileImport(bundle, { apply: true, overwrite: true });
  assert.equal((await store.getConfig()).name, 'Imported Assistant');
  assert.equal(identityName((await store.documents.read('IDENTITY.md')).content), 'Imported Assistant');
});

test('explicit unnamed identity differs from missing metadata and preserves profile text', () => {
  assert.equal(identityName('---\nname: ""\n---\nBody'), '');
  assert.equal(identityName('---\nname:\n---\nBody'), '');
  const named = '---\nname: "Existing"\navatar: custom\n---\nPersonality';
  const unnamed = withIdentityName(named, '   ');
  assert.equal(identityName(unnamed), '');
  assert.match(unnamed, /avatar: custom/);
  assert.match(unnamed, /Personality/);
  assert.throws(() => withIdentityName(named, '\n'), /Invalid/);
  assert.throws(() => withIdentityName(named, null), /Invalid/);
});

test('clearing a name remains explicitly unnamed after reload without changing memories', async t => {
  const { store, open } = await fixture(t);
  await store.updateConfig({ name: 'Keep me until cleared' });
  const memory = (await store.documents.read('MEMORY.md')).content;
  await store.updateConfig({ name: '' });
  assert.equal((await store.getConfig()).name, '');
  assert.equal(identityName((await store.documents.read('IDENTITY.md')).content), '');
  assert.equal((await (await open()).getConfig()).name, '');
  assert.equal((await store.documents.read('MEMORY.md')).content, memory);
});
