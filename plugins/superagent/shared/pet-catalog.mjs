import data from '../assets/pet/catalog.mjs';

const publicItems = values => values.map(({layer,source,...item}) => item);
export const PET_CATALOG = Object.freeze({
  expressions: publicItems(data.expressions), decorations: publicItems(data.decorations),
  palettes: publicItems(data.palettes), assets: [{id:'benchgo',label:'默认形象',kind:'builtin'}],
});
export const petCatalog = PET_CATALOG;
export function getPetCatalog() { return structuredClone(PET_CATALOG); }
export function renderBuiltinPet({expression='standard',decorations=[],palette='default'} = {}) {
  const face = data.expressions.find(item => item.id === expression);
  const colors = data.palettes.find(item => item.id === palette);
  if (!face || !colors || !Array.isArray(decorations) || decorations.length > 3) throw new Error('不支持的宠物表情、装饰或配色');
  const layers = [...new Set(decorations)].map(id => {
    const item = data.decorations.find(value => value.id === id);
    if (!item) throw new Error('不支持的宠物装饰');
    return item.layer;
  });
  if (decorations.filter(id => id.startsWith('hat-')).length > 1 || decorations.filter(id => id.startsWith('glasses-')).length > 1) throw new Error('同类帽子或眼镜只能选择一个');
  // Every fragment is imported, reviewed static geometry; no input becomes SVG markup.
  let svg = data.mark.replace(/<g data-part="eyes"[\s\S]*?<\/g>/, face.layer);
  svg = svg.replace('</g></g><defs>', `${layers.join('')}</g></g><defs>`);
  return svg.replaceAll('#F3EBDF',colors.body).replaceAll('#D44A36',colors.corner).replaceAll('#222222',colors.ink);
}
export const composePetSvg = renderBuiltinPet;
export const renderPetSvg = renderBuiltinPet;
export function builtinPetDataUrl(options) { return `data:image/svg+xml,${encodeURIComponent(renderBuiltinPet(options))}`; }
