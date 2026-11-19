import { fromBufferPromise } from 'yauzl';
import JSZip from 'jszip';
import { crc32 } from 'node:zlib';
import { petId, petLabel, petMap, petShape, validPetAction, validPetBindings } from './pet-profile.mjs';
import { petActionLibrary } from '../shared/pet-actions.mjs';

export const MAX_PACKAGE_BYTES = 24 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_FILES = 48;
const imageName = /^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(?:png|jpg|jpeg|webp)$/iu;
const badPackage = message => Object.assign(new Error(message), { status: 400 });

export async function writePetPackage(manifest, readImage) {
  const refs = validatePetManifest(manifest);
  if (refs.size + 1 > MAX_FILES) throw badPackage('形象包文件过多');
  const json = Buffer.from(JSON.stringify(manifest));
  if (json.length > MAX_MANIFEST_BYTES) throw badPackage('形象包清单过大');
  const zip = new JSZip();
  zip.file('manifest.json', json);
  let total = json.length;
  for (const name of refs) {
    const bytes = await readImage(name);
    total += bytes.length;
    if (total > MAX_PACKAGE_BYTES || bytes.length > MAX_IMAGE_BYTES) throw badPackage('形象包解压大小超出限制');
    zip.file(name, bytes, { createFolders: false });
  }
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  if (bytes.length > MAX_PACKAGE_BYTES) throw badPackage('形象包不能超过 24 MiB');
  return bytes;
}

export async function readPetPackage(bytes) {
  if (bytes.length > MAX_PACKAGE_BYTES) throw badPackage('形象包不能超过 24 MiB');
  let zip;
  try {
    zip = await fromBufferPromise(bytes, { autoClose: false, strictFileNames: true });
    if (zip.entryCount > MAX_FILES) throw badPackage('形象包文件过多');
    const entries = new Map();
    let total = 0;
    for await (const entry of zip.eachEntry()) {
      const { fileName, uncompressedSize, externalFileAttributes } = entry;
      if (fileName.endsWith('/') && !uncompressedSize) continue;
      const kind = (externalFileAttributes >>> 28) & 15;
      if ((kind && kind !== 8) || (fileName !== 'manifest.json' && !imageName.test(fileName)) || entries.has(fileName.toLowerCase())) throw badPackage('形象包只能包含清单和无重复名称的静态图片');
      total += uncompressedSize;
      if (total > MAX_PACKAGE_BYTES || uncompressedSize > (fileName === 'manifest.json' ? MAX_MANIFEST_BYTES : MAX_IMAGE_BYTES)) throw badPackage('形象包解压大小超出限制');
      entries.set(fileName.toLowerCase(), entry);
    }
    const manifestEntry = entries.get('manifest.json');
    if (manifestEntry?.fileName !== 'manifest.json') throw badPackage('形象包缺少根目录 manifest.json');
    const read = async entry => {
      const stream = await zip.openReadStreamPromise(entry), chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const content = Buffer.concat(chunks);
      if (crc32(content) !== entry.crc32) throw badPackage('形象包文件校验失败');
      return content;
    };
    const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await read(manifestEntry)));
    const refs = validatePetManifest(manifest);
    const assets = new Map();
    for (const name of refs) {
      const entry = entries.get(name.toLowerCase());
      if (entry?.fileName !== name) throw badPackage(`形象包缺少图片 ${name}`);
      assets.set(name, await read(entry));
    }
    return { manifest, assets };
  } catch (error) {
    if (error.status) throw error;
    throw badPackage('无法读取形象包，请检查 ZIP 与 manifest.json 格式');
  } finally { zip?.close(); }
}

export function validatePetManifest(manifest, { generated = false } = {}) {
  if (!petShape(manifest, ['version', 'name', 'avatar', 'expressions', 'palettes', 'decorations', 'actions', 'bindings', 'variant'])) throw badPackage('形象包清单包含无效字段');
  if (manifest.version !== 1 || !petLabel(manifest.name)) throw badPackage('形象包版本应为 1，并包含有效名称');
  const ref = value => typeof value === 'string' && value.length <= 128 && imageName.test(value);
  const local = value => ref(value) && (!generated || /^media\/[a-zA-Z0-9_-]+\.(?:png|jpg|jpeg|webp)$/iu.test(value));
  const avatar = manifest.avatar;
  const builtin = petShape(avatar, ['builtin', 'expression', 'palette', 'decorations']) && avatar.builtin === 'benchgo'
    && (avatar.expression === undefined || petId(avatar.expression)) && (avatar.palette === undefined || petId(avatar.palette))
    && (avatar.decorations === undefined || (Array.isArray(avatar.decorations) && avatar.decorations.every(petId)));
  if (!builtin && !local(avatar) && !(generated && avatar === 'current')) throw badPackage('形象包缺少有效主图');
  const validMap = (value, limit, validate) => value === undefined || petMap(value, limit, validate);
  if (!validMap(manifest.expressions, 24, local) || !validMap(manifest.palettes, 12, local) || !validMap(manifest.decorations, 12, local)) throw badPackage('形象包的表情、配色或装饰引用无效');
  if (!validMap(manifest.actions, 16, (action, id) => !Object.hasOwn(petActionLibrary, id) && !['none', 'idle'].includes(id) && validPetAction(action))
    || (manifest.bindings !== undefined && !validPetBindings(manifest.bindings, manifest.actions || {}))) throw badPackage('形象包的动作或工作状态映射无效');
  if (manifest.variant !== undefined && (!petId(manifest.variant) || !Object.hasOwn({ ...manifest.palettes, ...manifest.decorations }, manifest.variant))) throw badPackage('形象包的默认变体不存在');
  return new Set([...(local(avatar) ? [avatar] : []), ...['expressions', 'palettes', 'decorations'].flatMap(key => Object.values(manifest[key] || {}))]);
}
