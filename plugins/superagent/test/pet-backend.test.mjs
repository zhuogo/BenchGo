import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantStore } from '../src/store.mjs';
import { createAssistantPet, inspectPetImage } from '../src/pet.mjs';

async function fixture(t) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'benchgo-pet-'));
  const store = await createAssistantStore({ dataDirectory });
  t.after(async () => { store.close(); await rm(dataDirectory, { recursive: true, force: true }); });
  return { store, pet: createAssistantPet({ store }) };
}
test('pet preview apply reload restore preserves identity, HTML and opaque settings with revision protection', async t => {
  const { store, pet } = await fixture(t);
  await store.updateConfig({ name: 'One identity', cardHtml: '<b>keep</b>', models: [{providerId:'opaque/P',modelId:'Exact/M'}] });
  const before = await store.getConfig();
  const cat = await pet.catalog();
  const draft = await pet.preview({ pet: { expression: cat.expressions[0].id, decorations: [], palette: cat.palettes[0].id } });
  assert.equal((await store.getConfig()).pet, null);
  const results = await Promise.allSettled([pet.apply({draftId:draft.draftId,revision:before.revision}), pet.apply({draftId:draft.draftId,revision:before.revision})]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(results.find(x=>x.status==='rejected').reason.code,'REVISION_CONFLICT');
  const current = await store.getConfig();
  assert.equal(current.cardHtml,before.cardHtml); assert.equal(current.name,before.name); assert.deepEqual(current.models,before.models);
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
test('decoded custom images support personal expressions and changing appearance clears old expression bindings', async t => {
  const { store, pet } = await fixture(t);
  const { createRequire } = await import('node:module');
  const sharp = createRequire(new URL('../../benchgo/package.json', import.meta.url))('sharp');
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
