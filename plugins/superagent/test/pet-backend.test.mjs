import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantStore } from '../src/store.mjs';
import { createAssistantDispatch } from '../src/assistant-dispatch.mjs';
import { registerAssistantFetchRoute } from '../src/assistant-fetch-route.mjs';
import { createAssistantPet, inspectPetImage } from '../src/pet.mjs';
import { MAX_IMAGE_BYTES, readPetPackage, writePetPackage } from '../src/pet-package.mjs';

async function fixture(t) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'benchgo-pet-'));
  const store = await createAssistantStore({ dataDirectory });
  t.after(async () => { store.close(); await rm(dataDirectory, { recursive: true, force: true }); });
  return { store, pet: createAssistantPet({ store }) };
}
test('pet preview apply reload restore preserves identity and opaque settings with revision protection', async t => {
  const { store, pet } = await fixture(t);
  await store.updateConfig({ name: 'One identity', models: [{providerId:'opaque/P',modelId:'Exact/M'}] });
  const before = await store.getConfig();
  const cat = await pet.catalog();
  const draft = await pet.preview({ pet: { expression: cat.expressions[0].id, decorations: [], palette: cat.palettes[0].id } });
  assert.equal((await store.getConfig()).pet, null);
  const results = await Promise.allSettled([pet.apply({draftId:draft.draftId,revision:before.revision}), pet.apply({draftId:draft.draftId,revision:before.revision})]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(results.find(x=>x.status==='rejected').reason.code,'REVISION_CONFLICT');
  const current = await store.getConfig();
  assert.equal(current.name,before.name); assert.deepEqual(current.models,before.models);
  assert.equal(current.petHasPrevious,true); assert.equal(current.petPrevious,null);
  assert.equal((await pet.catalog()).draft,null);
  const reset = await pet.restore({revision:current.revision}); assert.equal(reset.pet,null);
  const restored = await pet.restore({revision:reset.revision}); assert.deepEqual(restored.pet,current.pet);
  await assert.rejects(store.updateConfig({pet:null}),/预览/);
  await assert.rejects(pet.preview({pet:{expression:'missing'}}),/不支持/);
  await assert.rejects(pet.preview({artifactPath:'../../secret.png'}),/图片产物/);
  assert.equal((await pet.fetchAsset(new Request('http://local/pet?id=../../secret'))).status,404);
});
test('corrupt images and active content are rejected before asset creation', async t => {
  const { pet } = await fixture(t);
  for(const dataUrl of ['data:image/svg+xml;base64,PHN2Zy8+', 'data:image/png;base64,YWJj', 'https://remote/pet.png']) await assert.rejects(pet.upload({dataUrl}));
  assert.throws(()=>inspectPetImage(Buffer.alloc(40)),/有效/);
});
test('expression events are bounded to available resources and current config revision', async t=>{
  const { store,pet }=await fixture(t); const cat=await pet.catalog();
  const event=await pet.express({expression:cat.expressions[0].id});
  assert.equal(event.revision,(await store.getConfig()).revision); assert.equal(pet.event().eventId,event.eventId);
  await assert.rejects(pet.express({expression:'invented'}),/尚未提供/);
});

test('discard is bound to the latest draft and survives service recreation without changing the appearance', async t => {
  const { store, pet } = await fixture(t);
  const old = await pet.preview({ pet: { expression: 'happy' } });
  const current = await pet.preview({ pet: { expression: 'think' } });
  await assert.rejects(pet.discard({ draftId: old.draftId }), /预览已更新/);
  assert.equal((await pet.catalog()).draft.draftId, current.draftId);
  await pet.discard({ draftId: current.draftId });
  const reloaded = createAssistantPet({ store });
  assert.equal((await reloaded.catalog()).draft, null);
  assert.equal((await store.getConfig()).pet, null);
  assert.equal((await store.getConfig()).revision, 0);
});

test('default and legacy builtin appearances export without consuming drafts and follow queued apply and restore', async t => {
  const { store, pet } = await fixture(t);
  const original = await store.getConfig();
  const draft = await pet.preview({ pet: { expression: 'happy', decorations: ['scarf'] } }, { source: 'ai' });
  assert.equal(draft.source, 'ai');
  const draftPath = join(store.paths.directory, 'pet', 'draft.json');
  const before = await readFile(draftPath, 'utf8');
  const exported = await pet.exportPackage();
  assert.equal(exported.filename, 'benchgo-appearance.zip');
  assert.equal(await readFile(draftPath, 'utf8'), before);
  assert.deepEqual(await store.getConfig(), original);
  const defaultDraft = await pet.uploadPackage(exported);
  assert.equal(defaultDraft.pet.expression, 'standard');
  assert.deepEqual(defaultDraft.pet.decorations, []);
  assert.equal(defaultDraft.pet.appearance.name, 'BenchGo');

  const selected = await pet.preview({ pet: { expression: 'happy', decorations: ['scarf'], palette: 'default' } });
  const [applied, builtinZip] = await Promise.all([
    pet.apply({ draftId: selected.draftId, revision: original.revision }), pet.exportPackage(),
  ]);
  assert.equal(applied.pet.appearance, undefined);
  const imported = await pet.uploadPackage(builtinZip);
  assert.equal(imported.pet.expression, 'happy');
  assert.deepEqual(imported.pet.decorations, ['scarf']);
  assert.equal(imported.pet.palette, selected.pet.palette);
  const [, resetZip] = await Promise.all([
    pet.restore({ revision: applied.revision, default: true }), pet.exportPackage(),
  ]);
  assert.equal((await pet.uploadPackage(resetZip)).pet.expression, 'standard');
});

test('assistant POST exports and reimports the applied appearance for the authenticated owner', async t => {
  const { store, pet } = await fixture(t);
  const draft = await pet.preview({ pet: { expression: 'happy', decorations: ['scarf'] } });
  const applied = await pet.apply({ draftId: draft.draftId, revision: 0 });
  const dispatch = createAssistantDispatch({ pet, shutdown: new AbortController() });
  let route;
  const connection = { fetch: { register: value => { route = value; } } };
  registerAssistantFetchRoute({ connection, dispatch });
  assert.equal(route.path, '/api/commander/assistant');
  assert.deepEqual(route.methods, ['POST']);
  const post = input => route.fetch(new Request('http://localhost' + route.path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
  }));
  for (const peer of [undefined, { principal: { kind: 'device' } }]) {
    connection.browserPeer = peer;
    const rejected = await post({ action: 'petExportPackage', principal: { kind: 'owner' } });
    assert.equal(rejected.status, 403);
    assert.equal((await rejected.json()).code, 'OWNER_REQUIRED');
  }
  connection.browserPeer = { principal: { kind: 'owner' } };
  const response = await post({ action: 'petExportPackage' });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const { filename, base64 } = await response.json();
  assert.equal(filename, 'benchgo-appearance.zip');
  const imported = await post({ action: 'petUploadPackage', base64 });
  assert.equal(imported.status, 200, await imported.clone().text());
  const { pet: preview } = await imported.json();
  assert.equal(preview.expression, applied.pet.expression);
  assert.deepEqual(preview.decorations, applied.pet.decorations);
  assert.deepEqual(await store.getConfig(), applied);
});

test('decoded custom images support personal expressions and changing appearance clears old expression bindings', async t => {
  const { store, pet } = await fixture(t);
  const { createRequire } = await import('node:module');
  const sharp = createRequire(new URL('../../base/package.json', import.meta.url))('sharp');
  const bytes = await sharp({create:{width:16,height:16,channels:4,background:'#abc'}}).png().toBuffer();
  const dataUrl = 'data:image/png;base64,' + bytes.toString('base64');
  let draft = await pet.upload({dataUrl});
  let config = await pet.apply({draftId:draft.draftId,revision:0});
  const main = config.pet.assetId;
  draft = await pet.upload({dataUrl,expression:'happy'});
  assert.equal(draft.pet.assetId,main);
  config = await pet.apply({draftId:draft.draftId,revision:config.revision});
  assert.ok(config.pet.expressions.happy);
  assert.equal((await pet.express({expression:'happy'})).revision,config.revision);
  const response = await pet.fetchAsset(new Request('http://local/pet?id='+config.pet.expressions.happy));
  assert.equal(response.status,200); assert.equal(response.headers.get('content-type'),'image/png');
  draft = await pet.upload({dataUrl});
  config = await pet.apply({draftId:draft.draftId,revision:config.revision});
  assert.equal(config.pet.expressions,undefined);
  await assert.rejects(pet.express({expression:'happy'}));
  assert.equal((await pet.catalog()).draft,null);
  const corrupt=Buffer.from(bytes); corrupt.fill(0,40,Math.min(50,corrupt.length));
  await assert.rejects(pet.upload({dataUrl:'data:image/png;base64,'+corrupt.toString('base64')}));
});

test('legacy custom main images and expression files can be exported and reimported', async t => {
  const { store, pet } = await fixture(t);
  const { createRequire } = await import('node:module');
  const sharp = createRequire(new URL('../../base/package.json', import.meta.url))('sharp');
  const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#a12' } }).jpeg().toBuffer();
  const { pet: uploaded } = await pet.upload({ dataUrl: 'data:image/jpeg;base64,' + jpeg.toString('base64') });
  const oldId = uploaded.assetId.replace('.png', '.jpg');
  const oldPath = join(store.paths.directory, 'pet', oldId);
  await writeFile(oldPath, jpeg);
  await store.updateConfig({ pet: { ...uploaded, assetId: oldId, expressions: { hello: oldId } } }, { petWrite: true });
  const exported = await pet.exportPackage();
  const archive = await readPetPackage(Buffer.from(exported.base64, 'base64'));
  assert.equal(archive.assets.size, 1);
  assert.deepEqual(archive.assets.get(archive.manifest.avatar), jpeg);
  const { pet: imported } = await pet.uploadPackage(exported);
  assert.equal(imported.kind, 'custom');
  assert.equal(imported.expressions.hello, imported.assetId);
  assert.match(imported.assetId, /\.png$/);
  await unlink(oldPath);
  await assert.rejects(pet.exportPackage(), { status: 400, message: /图片缺失/ });
});

test('export rejects packages outside existing ZIP file-count and image-size limits', async () => {
  const entries = (key, count) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`${key}${index}`, `${key}${index}.png`]));
  const manifest = { version: 1, name: 'Too large', avatar: 'main.png' };
  await assert.rejects(writePetPackage({ ...manifest, expressions: entries('e', 24),
    palettes: entries('p', 12), decorations: entries('d', 12) }, assert.fail), /文件过多/);
  await assert.rejects(writePetPackage(manifest, () => Buffer.alloc(MAX_IMAGE_BYTES + 1)), /大小超出限制/);
  const bytes = Buffer.alloc(MAX_IMAGE_BYTES);
  await assert.rejects(writePetPackage({ ...manifest, expressions: entries('e', 2) }, () => bytes), /大小超出限制/);
});

test('shape package previews verified assets and bounded actions while preserving identity updates and previous appearance', async t => {
  const { store, pet } = await fixture(t);
  const { createRequire } = await import('node:module');
  const require = createRequire(new URL('../../base/package.json', import.meta.url));
  const sharp = require('sharp'), Zip = require('jszip');
  const png = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#540' } }).png().toBuffer();
  const pose = { duration: 500, frames: [{ at: 0 }, { at: .5, x: 5, scale: 1.03 }, { at: 1 }], expression: 'hello' };
  const manifest = { version: 1, name: 'Custom pack', avatar: 'assets/main.png', expressions: { hello: 'assets/main.png' },
    palettes: { gold: 'assets/main.png' }, decorations: { badge: 'assets/badge.png' },
    actions: { wave: pose }, bindings: { focus: 'wave', completed: 'wave' }, variant: 'gold' };
  const encode = async (value, name = 'assets/main.png') => {
    const zip = new Zip();
    zip.file('manifest.json', JSON.stringify(value)); zip.file(name, png);
    zip.file('assets/badge.png', png);
    return zip.generateAsync({ type: 'base64', compression: 'DEFLATE' });
  };
  const staleToken = (await pet.catalog()).appearanceToken;
  const draft = await pet.uploadPackage({ base64: await encode(manifest) });
  assert.equal(draft.source, undefined);
  assert.equal(draft.pet.appearance.bindings.focus, 'wave');
  assert.equal(draft.pet.expressions.hello, draft.pet.assetId);
  assert.equal((await store.getConfig()).pet, null);
  await assert.rejects(pet.preview({ manifest: { version: 1, name: 'Stale', avatar: 'current' }, appearanceToken: staleToken }), /已更新/);
  await assert.rejects(pet.uploadPackage({ base64: await encode({ ...manifest, avatar: '../main.png' }) }), /主图/);
  await assert.rejects(pet.uploadPackage({ base64: await encode({ ...manifest, actions: { wave: { ...pose, duration: 99999 } } }) }), /动作/);
  assert.equal((await pet.catalog()).draft.draftId, draft.draftId);
  const identity = await store.updateConfig({ name: 'Keep' });
  const applied = await pet.apply({ draftId: draft.draftId, revision: identity.revision });
  assert.equal(applied.name, 'Keep');
  assert.equal((await createAssistantPet({ store }).catalog()).draft, null);
  assert.equal((await pet.express({ action: 'wave' })).action, 'wave');
  await pet.taskCompleted('task:1', 'side');
  assert.equal(pet.event().threadId, 'side');
  assert.equal(pet.event().action, 'wave');
  const token = (await pet.catalog()).appearanceToken;
  const refined = await pet.preview({ manifest: { version: 1, name: 'Refined', avatar: 'current' }, appearanceToken: token });
  assert.equal(refined.pet.assetId, applied.pet.assetId);
  assert.equal(refined.source, 'ai');
  const adjusted = await pet.preview({ bindings: { focus: 'none' }, draftId: refined.draftId });
  assert.equal((await pet.catalog()).draft.source, 'ai');
  const exported = await pet.exportPackage();
  assert.equal((await pet.catalog()).draft.draftId, adjusted.draftId);
  assert.deepEqual(await store.getConfig(), applied);
  const archive = await readPetPackage(Buffer.from(exported.base64, 'base64'));
  assert.equal(archive.assets.size, 2);
  assert.equal(archive.manifest.avatar, archive.manifest.expressions.hello);
  assert.equal(archive.manifest.avatar, archive.manifest.palettes.gold);
  const imported = await pet.uploadPackage(exported);
  assert.equal(imported.pet.appearance.name, manifest.name);
  assert.deepEqual(imported.pet.appearance.actions, manifest.actions);
  assert.deepEqual(imported.pet.appearance.bindings, manifest.bindings);
  assert.equal(imported.pet.appearance.variant, manifest.variant);
  assert.equal(imported.pet.appearance.palettes.gold, imported.pet.assetId);
  assert.notEqual(imported.pet.appearance.decorations.badge, imported.pet.assetId);
  assert.equal((await pet.restore({ revision: applied.revision })).pet, null);
});
