import { mkdir, readFile, writeFile, rename, realpath, stat, readdir, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { PET_ASSET_ID, petAssetIds, petVariantAsset, validatePetProfile, validPetBindings } from './pet-profile.mjs';
import { MAX_IMAGE_BYTES as MAX_BYTES, MAX_PACKAGE_BYTES, readPetPackage, validatePetManifest, writePetPackage } from './pet-package.mjs';
import { petActionForEvent, petActionLibrary } from '../shared/pet-actions.mjs';

const queues = new Map();
const fail = message => Object.assign(new Error(message), { status: 400 });
const appearanceHash = pet => createHash('sha256').update(JSON.stringify(pet ?? null)).digest('hex');
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

export function createAssistantPet({ store, readMediaArtifact, catalogLoader = () => import('../shared/pet-catalog.mjs') }) {
  const directory = join(store.paths.directory, 'pet'), draftPath = join(directory, 'draft.json');
  let expressionEvent = null;
  async function readDraft() {
    try { return JSON.parse(await readFile(draftPath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
  }
  const token = (pet, draft) => `${appearanceHash(pet)}:${draft?.draftId || ''}`;
  async function catalog() {
    const [module, config, saved] = await Promise.all([catalogLoader(), store.getConfig(), readDraft()]);
    const draft = saved && appearanceHash(saved.pet) !== appearanceHash(config.pet) ? saved : null;
    return { ...structuredClone(module.PET_CATALOG), actions: petActionLibrary, draft,
      appearanceToken: token(config.pet, draft), expressionEvent: event() };
  }
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
  async function saveDraft(value, config) {
    config ||= await store.getConfig();
    await mkdir(directory, { recursive: true });
    const draft = { draftId: randomUUID(), baseAppearance: appearanceHash(config.pet), ...value }, temporary = draftPath + '.' + draft.draftId + '.tmp';
    try { await writeFile(temporary, JSON.stringify(draft), { mode: 0o600 }); await rename(temporary, draftPath); } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    const keep = new Set([draft.pet, config.pet, config.petPrevious].filter(Boolean).flatMap(petAssetIds));
    // A grace period avoids removing an asset being written by another request.
    for (const name of await readdir(directory).catch(() => [])) if (PET_ASSET_ID.test(name) && !keep.has(name)) {
      const path = join(directory, name), info = await stat(path).catch(() => null);
      if (info && Date.now() - info.mtimeMs > 60000) await unlink(path).catch(() => {});
    }
    return draft;
  }
  async function upload({ dataUrl, expression }) {
    if (typeof dataUrl !== 'string' || dataUrl.length > MAX_BYTES * 1.4) throw fail('图片超过 8 MB');
    const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/u.exec(dataUrl);
    if (!match || match[2].length % 4) throw fail('仅支持 PNG、JPEG 和 WebP 图片');
    return saveImage(Buffer.from(match[2], 'base64'), expression);
  }
  async function saveImage(bytes, expression, source) {
    const config = await store.getConfig();
    const base = expression === undefined ? null : config.pet;
    if (expression !== undefined) {
      if (base?.kind !== 'custom' || typeof expression !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/u.test(expression)) throw fail('仅可为当前原创形象添加有效表情');
      if (!Object.hasOwn(base.expressions || {}, expression) && Object.keys(base.expressions || {}).length >= 24) throw fail('当前形象最多保存 24 种自定义表情');
    }
    bytes = await normalizeImage(bytes);
    const assetId = await writeImage(bytes);
    let pet = { kind: 'custom', assetId, expression: 'neutral', decorations: [], palette: 'default' };
    if (base) pet = { ...base, expressions: { ...base.expressions, [expression]: assetId } };
    try {
      validatePetProfile(pet);
      return await saveDraft({ pet, src: imageUrl(assetId), ...(expression ? { expression } : {}), ...(source && { source }) }, config);
    } catch (error) { await unlink(join(directory, assetId)).catch(() => {}); throw error; }
  }
  async function normalizeImage(bytes) {
    inspectPetImage(bytes);
    const { default: sharp } = await import('sharp');
    try {
      const decoder = sharp(bytes, { limitInputPixels: 32 * 1024 * 1024, failOn: 'warning' });
      const metadata = await decoder.metadata();
      if ((metadata.pages || 1) > 1) throw fail('请上传静态图片，动态效果由形象动作统一控制');
      return await decoder.rotate().png().toBuffer();
    } catch (error) { if (error.status) throw error; throw fail('静态图片无法解码'); }
  }
  const imageUrl = assetId => 'api/commander/assistant/pet-asset?id=' + assetId;
  async function writeImage(bytes) {
    const { extension } = inspectPetImage(bytes), assetId = randomUUID() + '.' + extension;
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, assetId), bytes, { flag: 'wx', mode: 0o600 });
    return assetId;
  }
  async function mediaImage(name) {
    const artifact = await readMediaArtifact?.(name);
    if (!artifact || artifact.bytes > MAX_BYTES) throw fail('图片产物路径或大小无效');
    return Buffer.from(await new Response(artifact.stream()).arrayBuffer());
  }
  async function savePackage(manifest, readImage, config, base, source) {
    const written = new Map();
    let bytesSaved = 0;
    const saveReference = async ref => {
      if (written.has(ref)) return written.get(ref);
      const bytes = await normalizeImage(await readImage(ref));
      bytesSaved += bytes.length;
      if (bytesSaved > MAX_PACKAGE_BYTES) throw fail('形象包处理后的图片超过 24 MiB');
      const id = await writeImage(bytes);
      written.set(ref, id);
      return id;
    };
    try {
      let pet;
      if (manifest.avatar === 'current') pet = base || (await builtin()).pet;
      else if (typeof manifest.avatar === 'string') pet = { kind: 'custom', assetId: await saveReference(manifest.avatar), expression: 'neutral', decorations: [], palette: 'default' };
      else pet = (await builtin(manifest.avatar)).pet;
      const assetMap = async (key, fallback) => {
        if (!manifest[key]) return fallback || {};
        const items = [];
        for (const [id, ref] of Object.entries(manifest[key])) items.push([id, await saveReference(ref)]);
        return Object.fromEntries(items);
      };
      const appearance = { version: 1, name: manifest.name,
        palettes: await assetMap('palettes', pet.appearance?.palettes), decorations: await assetMap('decorations', pet.appearance?.decorations),
        actions: manifest.actions || pet.appearance?.actions || {}, bindings: manifest.bindings || pet.appearance?.bindings || {},
      };
      const variant = manifest.variant ?? pet.appearance?.variant;
      if (variant && (appearance.palettes[variant] || appearance.decorations[variant])) appearance.variant = variant;
      pet = { ...pet, expressions: await assetMap('expressions', pet.expressions), appearance };
      return await previewProfile(pet, config, source);
    } catch (error) {
      await Promise.all([...written.values()].map(id => unlink(join(directory, id)).catch(() => {})));
      throw error;
    }
  }
  async function previewProfile(pet, config, source) {
    validatePetProfile(pet);
    const src = await profileSource(pet);
    return saveDraft({ pet, src, ...(source && { source }) }, config);
  }
  async function profileSource(pet) {
    const { PET_CATALOG } = await catalogLoader();
    for (const action of Object.values(pet.appearance?.actions || {})) if (action.expression && !hasExpression(pet, PET_CATALOG, action.expression)) throw fail('动作引用了当前形象缺少的表情');
    const variant = petVariantAsset(pet, pet.appearance?.variant);
    return variant || pet.kind === 'custom' ? imageUrl(variant || pet.assetId) : (await builtin(pet)).src;
  }
  async function uploadPackage({ base64 }) {
    if (typeof base64 !== 'string' || base64.length > Math.ceil(MAX_PACKAGE_BYTES / 3) * 4) throw fail('形象包不能超过 24 MiB');
    if (base64.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(base64)) throw fail('形象包内容无效');
    const config = await store.getConfig();
    const { manifest, assets } = await readPetPackage(Buffer.from(base64, 'base64'));
    return savePackage(manifest, name => assets.get(name), config);
  }
  async function exportPackage() {
    const { pet: applied } = await store.getConfig();
    const pet = applied ?? (await builtin()).pet;
    const { appearance = {}, expressions = {}, expression, palette, decorations } = pet;
    if (pet.kind === 'builtin' && appearance.variant) await builtin(pet);
    await profileSource(pet);

    const refs = new Map(), ids = new Map();
    const reference = id => {
      if (!refs.has(id)) {
        const name = `assets/${refs.size + 1}${id.slice(id.lastIndexOf('.'))}`;
        refs.set(id, name);
        ids.set(name, id);
      }
      return refs.get(id);
    };
    const assetMap = value => Object.fromEntries(Object.entries(value || {}).map(([key, id]) => [key, reference(id)]));
    const manifest = { version: 1, name: appearance.name ?? 'BenchGo',
      avatar: pet.kind === 'builtin' ? { builtin: 'benchgo', expression, palette, decorations } : reference(pet.assetId),
      expressions: assetMap(expressions), palettes: assetMap(appearance.palettes), decorations: assetMap(appearance.decorations),
      actions: appearance.actions, bindings: appearance.bindings, variant: appearance.variant,
    };
    let normalizedTotal = 0;
    const bytes = await writePetPackage(manifest, async name => {
      let bytes;
      try { ({ bytes } = await asset(ids.get(name))); }
      catch { throw fail('当前形象的图片缺失或无效，无法导出'); }
      const normalized = await normalizeImage(bytes);
      normalizedTotal += normalized.length;
      if (normalized.length > MAX_BYTES || normalizedTotal > MAX_PACKAGE_BYTES) throw fail('形象包处理后的图片大小超出限制');
      return bytes;
    });
    return { filename: 'benchgo-appearance.zip', base64: bytes.toString('base64') };
  }
  async function preview({ pet, artifactPath, expression, manifest, appearanceToken, bindings, variant, draftId } = {}, { source } = {}) {
    if (manifest !== undefined) {
      const config = await store.getConfig(), saved = await readDraft();
      const draft = saved && appearanceHash(saved.pet) !== appearanceHash(config.pet) ? saved : null;
      if (appearanceToken !== token(config.pet, draft)) throw fail('形象或预览已更新，请重新读取形象资产后继续创作');
      validatePetManifest(manifest, { generated: true });
      return savePackage(manifest, name => mediaImage(name.slice('media/'.length)), config, draft?.pet || config.pet, 'ai');
    }
    if (bindings !== undefined || variant !== undefined) {
      const config = await store.getConfig(), saved = await readDraft();
      if (draftId && (saved?.draftId !== draftId || (saved.baseAppearance && saved.baseAppearance !== appearanceHash(config.pet)))) throw fail('预览已更新，请重新载入');
      const base = (draftId ? saved.pet : config.pet) || (await builtin()).pet;
      const appearance = { version: 1, ...base.appearance };
      if (bindings !== undefined) {
        if (!validPetBindings(bindings, appearance.actions || {})) throw fail('形象动作映射无效');
        appearance.bindings = bindings;
      }
      if (variant === null) delete appearance.variant;
      else if (variant !== undefined) appearance.variant = variant;
      return previewProfile({ ...base, appearance }, config, draftId ? saved.source : source);
    }
    if (artifactPath !== undefined) {
      const pathParts = typeof artifactPath === 'string' && /^(artifacts|media)\/([a-zA-Z0-9_-]+\.(?:png|jpg|jpeg|webp))$/u.exec(artifactPath);
      if (!pathParts) throw fail('请选择已生成的静态图片产物');
      if (pathParts[1] === 'media') {
        return saveImage(await mediaImage(pathParts[2]), expression, source);
      }
      const root = await realpath(join(store.paths.workspace, 'artifacts')), path = await realpath(join(store.paths.workspace, artifactPath));
      if (dirname(path) !== root || (await stat(path)).size > MAX_BYTES) throw fail('图片产物路径或大小无效');
      return saveImage(await readFile(path), expression, source);
    }
    if (pet?.kind && pet.kind !== 'builtin') throw fail('原创形象请上传图片或选择图像产物');
    if (pet?.appearance) {
      const config = await store.getConfig(), saved = await readDraft();
      const base = draftId ? saved?.draftId === draftId && saved.pet : config.pet;
      if (base?.kind !== 'builtin' || appearanceHash(base.appearance) !== appearanceHash(pet.appearance)) throw fail('当前形象或预览已更新，请重新选择素材');
      const composed = (await builtin(pet)).pet;
      const appearance = { ...base.appearance };
      delete appearance.variant;
      return previewProfile({ ...composed, expressions: base.expressions, appearance }, config, draftId ? saved.source : source);
    }
    const next = await builtin(pet);
    return saveDraft(source ? { ...next, source } : next);
  }
  function revision(value) { if (!Number.isSafeInteger(value) || value < 0) throw fail('请刷新形象后重试'); }
  async function apply({ draftId, revision: expected }) {
    revision(expected);
    const current = await store.getConfig();
    if (current.revision !== expected) throw Object.assign(new Error('Assistant data changed; reload before saving'), { code: 'REVISION_CONFLICT', revision: current.revision });
    const draft = await readDraft();
    if (!draft || draftId !== draft.draftId || (draft.baseAppearance && draft.baseAppearance !== appearanceHash(current.pet))) throw fail('形象或预览已更新，请重新预览后应用');
    await profileSource(draft.pet);
    for (const id of petAssetIds(draft.pet)) await asset(id);
    if (draft.expression && (await store.getConfig()).pet?.assetId !== draft.pet.assetId) throw fail('当前形象已改变，请重新制作表情');
    const result = await store.updateConfig({ pet: draft.pet }, { revision: expected, petWrite: true });
    await unlink(draftPath).catch(() => {});
    return result;
  }
  async function restore({ revision: expected, default: reset = false }) {
    revision(expected);
    const current = await store.getConfig();
    if (!reset && !current.petHasPrevious) throw fail('没有可恢复的上一版形象');
    const pet = reset ? null : current.petPrevious;
    if (pet) for (const id of petAssetIds(pet)) await asset(id);
    const result = await store.updateConfig({ pet }, { revision: expected, petWrite: true });
    await unlink(draftPath).catch(() => {});
    return result;
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
  function hasExpression(pet, cat, expression) {
    return Object.hasOwn(pet?.expressions || {}, expression)
      || (pet?.kind !== 'custom' && cat.expressions.some(row => (typeof row === 'string' ? row : row.id) === expression));
  }
  async function express({ expression, action }) {
    const { PET_CATALOG } = await catalogLoader();
    const current = await store.getConfig();
    if (action === undefined ? !hasExpression(current.pet, PET_CATALOG, expression) : !Object.hasOwn(petActionLibrary, action) && !Object.hasOwn(current.pet?.appearance?.actions || {}, action)) throw fail('当前形象尚未提供该表情或动作');
    expressionEvent = { ...(action === undefined ? { expression } : { action }), eventId: randomUUID(), revision: current.revision, createdAt: Date.now() };
    return expressionEvent;
  }
  async function taskCompleted(taskId, threadId) {
    const current = await store.getConfig();
    const action = petActionForEvent(current.pet, 'completed');
    expressionEvent = { action, threadId, eventId: `completed:${taskId}`, revision: current.revision, createdAt: Date.now() };
  }
  const event = () => expressionEvent && Date.now() - expressionEvent.createdAt < 10000 ? expressionEvent : null;
  async function fetchAsset(request) {
    try { const { bytes, mimeType } = await asset(new URL(request.url).searchParams.get('id')); return new Response(bytes, { headers: { 'content-type': mimeType, 'cache-control': 'private, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' } }); }
    catch { return new Response('资源不可用', { status: 404 }); }
  }
  const serial = operation => (...args) => {
    const previous = queues.get(directory) || Promise.resolve();
    const current = previous.catch(() => {}).then(() => operation(...args));
    queues.set(directory, current);
    return current.finally(() => { if (queues.get(directory) === current) queues.delete(directory); });
  };
  return { catalog, upload: serial(upload), uploadPackage: serial(uploadPackage), exportPackage: serial(exportPackage), preview: serial(preview),
    apply: serial(apply), restore: serial(restore), discard: serial(discard), express, fetchAsset, event, taskCompleted };
}
