const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const PET_ASSET_ID = /^[a-f0-9-]{36}\.(?:png|jpg|webp)$/u;
export function validatePetProfile(value) {
  if (value === null) return value;
  if (!plain(value) || Object.keys(value).some(key => !['kind', 'assetId', 'expression', 'decorations', 'palette', 'expressions'].includes(key))) throw new Error('Invalid pet profile');
  if (!['builtin', 'custom'].includes(value.kind)) throw new Error('Invalid pet kind');
  if (value.kind === 'custom' ? !PET_ASSET_ID.test(value.assetId) : value.assetId !== 'builtin') throw new Error('Invalid pet asset');
  for (const key of ['expression', 'palette']) if (typeof value[key] !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/u.test(value[key])) throw new Error('Invalid pet ' + key);
  if (!Array.isArray(value.decorations) || value.decorations.length > 8 || new Set(value.decorations).size !== value.decorations.length || value.decorations.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/u.test(id))) throw new Error('Invalid pet decorations');
  if (value.kind === 'custom' && value.decorations.length) throw new Error('原创形象不支持基准角色装饰，请通过图像编辑后上传');
  if (value.expressions !== undefined && (!plain(value.expressions) || Object.keys(value.expressions).length > 24 || Object.entries(value.expressions).some(([id, asset]) => !/^[a-zA-Z0-9_-]{1,64}$/u.test(id) || !PET_ASSET_ID.test(asset)))) throw new Error('Invalid pet expressions');
  return value;
}
