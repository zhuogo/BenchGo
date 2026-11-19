import { petActionLibrary, petWorkEvents } from '../shared/pet-actions.mjs';

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const PET_ASSET_ID = /^[a-f0-9-]{36}\.(?:png|jpg|webp)$/u;
export const petId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/u.test(value) && !['__proto__', 'prototype', 'constructor'].includes(value);
export const petShape = (value, keys) => plain(value) && Object.keys(value).every(key => keys.includes(key));
export const petLabel = value => typeof value === 'string' && !!value.trim() && value.length <= 80 && !/[\u0000-\u001f\u007f]/u.test(value);

export function petMap(value, limit, validate) {
  return plain(value) && Object.keys(value).length <= limit && Object.entries(value).every(([id, entry]) => petId(id) && validate(entry, id));
}

const bounded = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;
const frameRanges = { x: [-12, 12], y: [-12, 12], rotate: [-18, 18], scale: [0.85, 1.15], opacity: [0.6, 1] };
export function validPetAction(action) {
  return petShape(action, ['label', 'duration', 'frames', 'expression'])
    && (action.label === undefined || petLabel(action.label))
    && Number.isInteger(action.duration) && bounded(action.duration, 120, 1800)
    && (action.expression === undefined || petId(action.expression))
    && Array.isArray(action.frames) && bounded(action.frames.length, 2, 12)
    && action.frames[0]?.at === 0 && action.frames.at(-1)?.at === 1
    && action.frames.every((frame, index) => petShape(frame, ['at', ...Object.keys(frameRanges)]) && bounded(frame.at, 0, 1)
      && (!index || frame.at > action.frames[index - 1].at)
      && Object.entries(frameRanges).every(([key, range]) => frame[key] === undefined || bounded(frame[key], ...range)));
}

export function validPetBindings(value, actions) {
  return petMap(value, Object.keys(petWorkEvents).length, (action, event) => Object.hasOwn(petWorkEvents, event)
    && (action === 'none' || Object.hasOwn(petActionLibrary, action) || Object.hasOwn(actions, action)));
}

export const petVariantAsset = (pet, variant) => pet?.appearance?.palettes?.[variant] ?? pet?.appearance?.decorations?.[variant];
export const petAssetIds = pet => [pet.assetId, ...Object.values(pet.expressions || {}),
  ...Object.values(pet.appearance?.palettes || {}), ...Object.values(pet.appearance?.decorations || {}),
].filter(id => PET_ASSET_ID.test(id));

export function validatePetProfile(value) {
  if (value === null) return value;
  if (!petShape(value, ['kind', 'assetId', 'expression', 'decorations', 'palette', 'expressions', 'appearance'])) throw new Error('Invalid pet profile');
  if (!['builtin', 'custom'].includes(value.kind)) throw new Error('Invalid pet kind');
  if (value.kind === 'custom' ? !PET_ASSET_ID.test(value.assetId) : value.assetId !== 'builtin') throw new Error('Invalid pet asset');
  for (const key of ['expression', 'palette']) if (typeof value[key] !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/u.test(value[key])) throw new Error('Invalid pet ' + key);
  if (!Array.isArray(value.decorations) || value.decorations.length > 8 || new Set(value.decorations).size !== value.decorations.length || value.decorations.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/u.test(id))) throw new Error('Invalid pet decorations');
  if (value.kind === 'custom' && value.decorations.length) throw new Error('原创形象不支持基准角色装饰，请通过图像编辑后上传');
  if (value.expressions !== undefined && (!plain(value.expressions) || Object.keys(value.expressions).length > 24 || Object.entries(value.expressions).some(([id, asset]) => !/^[a-zA-Z0-9_-]{1,64}$/u.test(id) || !PET_ASSET_ID.test(asset)))) throw new Error('Invalid pet expressions');
  if (value.appearance !== undefined) {
    const { appearance } = value;
    if (!petShape(appearance, ['version', 'name', 'palettes', 'decorations', 'actions', 'bindings', 'variant']) || appearance.version !== 1
      || (appearance.name !== undefined && !petLabel(appearance.name))
      || !['palettes', 'decorations'].every(key => petMap(appearance[key] || {}, 12, asset => typeof asset === 'string' && PET_ASSET_ID.test(asset)))
      || !petMap(appearance.actions || {}, 16, (action, id) => !Object.hasOwn(petActionLibrary, id) && !['none', 'idle'].includes(id) && validPetAction(action))
      || !validPetBindings(appearance.bindings || {}, appearance.actions || {})
      || (appearance.variant !== undefined && (!petId(appearance.variant) || !petVariantAsset(value, appearance.variant)))) throw new Error('形象包的素材或动作无效');
  }
  return value;
}
