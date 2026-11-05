import test from 'node:test';
import assert from 'node:assert/strict';
import { getPetCatalog, renderBuiltinPet } from '../shared/pet-catalog.mjs';
import { readFile } from 'node:fs/promises';
test('expression names and rendered faces are unique', () => {
  const expressions = getPetCatalog().expressions;
  for (const values of [expressions.map(item => item.id), expressions.map(item => item.label), expressions.map(item => renderBuiltinPet({ expression: item.id }))]) {
    assert.equal(new Set(values).size, expressions.length);
  }
});
test('each supported motion has its own animation and trajectory', async () => {
  const css = await readFile(new URL('../../shared/client/pet-avatar.css', import.meta.url), 'utf8');
  const motions = [...css.matchAll(/\[data-action=([^\]]+)\]>img\{animation:([^ ]+)/g)];
  assert.deepEqual(motions.map(match => match[1]).sort(), ['acknowledge', 'focus', 'happy', 'waiting']);
  assert.equal(new Set(motions.map(match => match[2])).size, motions.length);
  const trajectories = [...css.matchAll(/@keyframes [^{]+\{(.*)\}/g)].map(match => match[1]);
  assert.equal(trajectories.length, motions.length);
  assert.equal(new Set(trajectories).size, motions.length);
});
test('all imported expressions preserve the formal body and editor strip',()=>{
  const catalog=getPetCatalog();
  assert.equal(catalog.expressions.length,21);
  for(const expression of catalog.expressions){
    const svg=renderBuiltinPet({expression:expression.id});
    assert.match(svg,/data-part="editor-strip"/);
    assert.match(svg,/data-part="body"/);
    assert.match(svg,/#F3EBDF/);
    assert.doesNotMatch(svg,/<script|foreignObject|(?:href)=|#EFE6D6|#C95543|#303632/);
  }
});
test('all decoration and palette combinations use controlled layers',()=>{
  const catalog=getPetCatalog();
  for(const decoration of catalog.decorations) for(const palette of catalog.palettes){
    const svg=renderBuiltinPet({decorations:[decoration.id],palette:palette.id,expression:'happy'});
    assert.match(svg,/data-part="editor-strip"/);
    assert.ok(svg.includes(palette.body));
  }
  assert.throws(()=>renderBuiltinPet({expression:'<script>'}));
  assert.throws(()=>renderBuiltinPet({decorations:['../../file']}));
  assert.throws(()=>renderBuiltinPet({decorations:['hat-cap','hat-santa']}));
});
