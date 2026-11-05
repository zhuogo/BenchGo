import { mkdir, readFile, writeFile, rename, realpath, stat, readdir, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PET_ASSET_ID, validatePetProfile } from './pet-profile.mjs';

const queues = new Map();
const MAX_BYTES = 8 * 1024 * 1024;
const fail = message => Object.assign(new Error(message), { status: 400 });
export function inspectPetImage(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 24 || bytes.length > MAX_BYTES) throw fail('图片为空或超过 8 MB');
  let width, height, extension, mimeType;
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    if (bytes.toString('ascii', 12, 16) !== 'IHDR' || bytes.readUInt32BE(8) !== 13 || !bytes.includes(Buffer.from('IEND'))) throw fail('PNG 图片不完整');
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20); extension = 'png'; mimeType = 'image/png';
  } else if (bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 255) throw fail('JPEG 图片无效');
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) throw fail('JPEG 图片不完整');
      if ([0xc0,0xc1,0xc2].includes(marker) && length >= 7) { height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5); }
      offset += length;
    }
    if (bytes[bytes.length - 2] !== 255 || bytes[bytes.length - 1] !== 217) throw fail('JPEG 图片不完整');
    extension = 'jpg'; mimeType = 'image/jpeg';
  } else if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    if (bytes.readUInt32LE(4) + 8 !== bytes.length) throw fail('WebP 图片不完整');
    const kind = bytes.toString('ascii', 12, 16);
    if (kind === 'VP8X' && bytes.length >= 30) { width = 1 + bytes.readUIntLE(24, 3); height = 1 + bytes.readUIntLE(27, 3); }
    else if (kind === 'VP8L' && bytes.length >= 25 && bytes[20] === 47) { const bits = bytes.readUInt32LE(21); width = (bits & 16383) + 1; height = ((bits >>> 14) & 16383) + 1; }
    else if (kind === 'VP8 ' && bytes.length >= 30 && bytes.subarray(23, 26).equals(Buffer.from([157,1,42]))) { width = bytes.readUInt16LE(26) & 16383; height = bytes.readUInt16LE(28) & 16383; }
    extension = 'webp'; mimeType = 'image/webp';
  }
  if (!width || !height || width > 8192 || height > 8192 || width * height > 32 * 1024 * 1024) throw fail('请选择有效的 PNG、JPEG 或 WebP 图片，最长边不超过 8192 像素');
  return { width, height, extension, mimeType };
}

export function createAssistantPet({ store, catalogLoader = () => import('../shared/pet-catalog.mjs') }) {
  const directory = join(store.paths.directory, 'pet'), draftPath = join(directory, 'draft.json');
  let expressionEvent = null;
  async function catalog() { const module = await catalogLoader(); let draft = null; try { draft = JSON.parse(await readFile(draftPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; } if (draft && JSON.stringify(draft.pet) === JSON.stringify((await store.getConfig()).pet)) draft = null; return { ...structuredClone(module.PET_CATALOG), draft, expressionEvent: expressionEvent && Date.now() - expressionEvent.createdAt < 10000 ? expressionEvent : null }; }
  async function builtin(value = {}) {
    const module = await catalogLoader(), cat = module.PET_CATALOG;
    const first = values => typeof values[0] === 'string' ? values[0] : values[0].id;
    const pet = { kind: 'builtin', assetId: 'builtin', expression: value.expression ?? first(cat.expressions), decorations: value.decorations ?? [], palette: value.palette ?? first(cat.palettes) };
    validatePetProfile(pet);
    for (const [key, ids] of [['expression', cat.expressions], ['palette', cat.palettes]]) if (!ids.some(row => (typeof row === 'string' ? row : row.id) === pet[key])) throw fail('不支持的宠物 ' + key);
    if (pet.decorations.some(id => !cat.decorations.some(row => (typeof row === 'string' ? row : row.id) === id))) throw fail('不支持的宠物装饰');
    module.validatePetComposition?.(pet);
    const svg = module.composePetSvg(pet);
    return { pet, src: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg) };
  }
  async function saveDraft(value) {
    await mkdir(directory, { recursive: true });
    const draft = { draftId: randomUUID(), ...value }, temporary = draftPath + '.' + draft.draftId + '.tmp';
    try { await writeFile(temporary, JSON.stringify(draft), { mode: 0o600 }); await rename(temporary, draftPath); } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    const config = await store.getConfig();
    const keep = new Set([draft.pet, config.pet, config.petPrevious].filter(Boolean).flatMap(pet => [pet.assetId, ...Object.values(pet.expressions || {})]));
    // A grace period avoids removing an asset being written by another request.
    for (const name of await readdir(directory)) if (PET_ASSET_ID.test(name) && !keep.has(name)) { const path = join(directory, name); if (Date.now() - (await stat(path)).mtimeMs > 60000) await unlink(path); }
    return draft;
  }
  async function upload({ dataUrl, expression }) {
    if (typeof dataUrl !== 'string' || dataUrl.length > MAX_BYTES * 1.4) throw fail('图片超过 8 MB');
    const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/u.exec(dataUrl);
    if (!match || match[2].length % 4) throw fail('仅支持 PNG、JPEG 和 WebP 图片');
    return saveImage(Buffer.from(match[2], 'base64'), expression);
  }
  async function saveImage(bytes, expression) {
    let base = null;
    if (expression !== undefined) {
      base = (await store.getConfig()).pet;
      if (base?.kind !== 'custom' || typeof expression !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/u.test(expression)) throw fail('仅可为当前原创形象添加有效表情');
      if (!Object.hasOwn(base.expressions || {}, expression) && Object.keys(base.expressions || {}).length >= 24) throw fail('当前形象最多保存 24 种自定义表情');
    }
    inspectPetImage(bytes);
    const { default: sharp } = await import('sharp');
    const decoder = sharp(bytes, { limitInputPixels: 32 * 1024 * 1024, failOn: 'warning' });
    const metadata = await decoder.metadata();
    if ((metadata.pages || 1) > 1) throw fail('请上传静态图片，动态效果由宠物动作统一控制');
    bytes = await decoder.rotate().png().toBuffer();
    const { extension } = inspectPetImage(bytes), assetId = randomUUID() + '.' + extension;
    await mkdir(directory, { recursive: true });
    let pet = { kind: 'custom', assetId, expression: 'neutral', decorations: [], palette: 'default' };
    if (base) { pet = { ...base, expressions: { ...base.expressions, [expression]: assetId } }; validatePetProfile(pet); }
    await writeFile(join(directory, assetId), bytes, { flag: 'wx', mode: 0o600 });
    try { return await saveDraft({ pet, src: 'api/commander/assistant/pet-asset?id=' + assetId, ...(expression ? { expression } : {}) }); }
    catch (error) { await unlink(join(directory, assetId)).catch(() => {}); throw error; }
  }
  async function preview({ pet, artifactPath, expression } = {}) {
    if (artifactPath !== undefined) {
      if (typeof artifactPath !== 'string' || !/^artifacts\/[a-zA-Z0-9_-]+\.(?:png|jpg|jpeg|webp)$/u.test(artifactPath)) throw fail('请选择已生成的图片产物');
      const root = await realpath(join(store.paths.workspace, 'artifacts')), path = await realpath(join(store.paths.workspace, artifactPath));
      if (dirname(path) !== root || (await stat(path)).size > MAX_BYTES) throw fail('图片产物路径或大小无效');
      return saveImage(await readFile(path), expression);
    }
    if (pet?.kind && pet.kind !== 'builtin') throw fail('原创形象请上传图片或选择图像产物');
    return saveDraft(await builtin(pet));
  }
  function revision(value) { if (!Number.isSafeInteger(value) || value < 0) throw fail('请刷新形象后重试'); }
  async function apply({ draftId, revision: expected }) {
    revision(expected);
    const current = await store.getConfig();
    if (current.revision !== expected) throw Object.assign(new Error('Assistant data changed; reload before saving'), { code: 'REVISION_CONFLICT', revision: current.revision });
    const draft = JSON.parse(await readFile(draftPath, 'utf8'));
    if (draftId !== draft.draftId) throw fail('预览已更新，请重新预览后应用');
    if (draft.pet.kind === 'builtin') await builtin(draft.pet); else await asset(draft.pet.assetId);
    for (const id of Object.values(draft.pet.expressions || {})) await asset(id);
    if (draft.expression && (await store.getConfig()).pet?.assetId !== draft.pet.assetId) throw fail('当前形象已改变，请重新制作表情');
    const result = await store.updateConfig({ pet: draft.pet }, { revision: expected, petWrite: true });
    await unlink(draftPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
    return result;
  }
  async function restore({ revision: expected, default: reset = false }) {
    revision(expected);
    const current = await store.getConfig();
    if (!reset && !current.petHasPrevious) throw fail('没有可恢复的上一版形象');
    const pet = reset ? null : current.petPrevious;
    if (pet?.kind === 'custom') await asset(pet.assetId);
    for (const id of Object.values(pet?.expressions || {})) await asset(id);
    return store.updateConfig({ pet }, { revision: expected, petWrite: true });
  }
  async function discard({ draftId } = {}) {
    let draft;
    try { draft = JSON.parse(await readFile(draftPath, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return { discarded: true }; throw error; }
    if (typeof draftId !== 'string' || draftId !== draft.draftId) throw fail('预览已更新，请重新载入后取消');
    await unlink(draftPath);
    return { discarded: true };
  }
  async function asset(id) {
    if (typeof id !== 'string' || !PET_ASSET_ID.test(id)) throw fail('无效宠物资源');
    const path = await realpath(join(directory, id));
    if (dirname(path) !== await realpath(directory) || (await stat(path)).size > MAX_BYTES) throw fail('无效宠物资源');
    const bytes = await readFile(path), { mimeType } = inspectPetImage(bytes);
    return { bytes, mimeType };
  }
  async function express({ expression }) {
    const cat = await catalog();
    const current = await store.getConfig();
    if (current.pet?.kind === 'custom' ? !Object.hasOwn(current.pet.expressions || {}, expression) : !cat.expressions.some(row => (typeof row === 'string' ? row : row.id) === expression)) throw fail('当前形象尚未提供该表情素材');
    expressionEvent = { expression, eventId: randomUUID(), revision: current.revision, createdAt: Date.now() };
    return expressionEvent;
  }
  async function fetchAsset(request) {
    try { const { bytes, mimeType } = await asset(new URL(request.url).searchParams.get('id')); return new Response(bytes, { headers: { 'content-type': mimeType, 'cache-control': 'private, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' } }); }
    catch { return new Response('资源不可用', { status: 404 }); }
  }
  const serial = operation => input => {
    const previous = queues.get(directory) || Promise.resolve();
    const current = previous.catch(() => {}).then(() => operation(input));
    queues.set(directory, current);
    return current.finally(() => { if (queues.get(directory) === current) queues.delete(directory); });
  };
  return { catalog, upload: serial(upload), preview: serial(preview), apply: serial(apply), restore: serial(restore), discard: serial(discard), express, fetchAsset, event: () => expressionEvent && Date.now() - expressionEvent.createdAt < 10000 ? expressionEvent : null };
}
