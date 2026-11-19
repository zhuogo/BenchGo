import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { petImageUrl } from '../client/pet-state.mjs';

const { transformSync } = createRequire(new URL('../../base/package.json', import.meta.url))('esbuild');
const code = transformSync(readFileSync(new URL('../client/card.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code;

test('sidebar entry shows the current avatar and name even with legacy HTML', () => {
  const react = { createElement: (type, props, ...children) => ({ type, props, children }) };
  const module = { exports: {} };
  runInNewContext(code, {
    module, exports: module.exports, document: { baseURI: 'https://local/' },
    require: id => id === 'react' ? react : id === './pet-state.mjs' ? { petImageUrl } : { PetAvatar: 'PetAvatar' },
  });
  const onOpen = () => {};
  const pet = { kind: 'custom', assetId: 'existing.png' };
  const card = module.exports.AssistantCard({ name: '助手', pet, html: '<b>旧名片</b>', onOpen, motion: false, current: true });
  assert.equal(card.type, 'button');
  assert.equal(card.props.onClick, onOpen);
  assert.equal(card.props['aria-current'], 'page');
  const [, avatar, name] = card.children;
  assert.equal(avatar.type, 'PetAvatar');
  assert.equal(avatar.props.pet, pet);
  assert.equal(avatar.props.motion, false);
  assert.deepEqual([...name.children], ['助手']);
});
