import { createHash } from 'node:crypto';

const forbidden = new Set(['__proto__', 'prototype', 'constructor', '__jsExpr']);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!plain(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}
export const settingsFingerprint = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export const settingsSnapshot = (value, revision, extra = {}) => ({ value: structuredClone(value), ...(revision === undefined ? {} : { revision }), fingerprint: settingsFingerprint({ value, revision }), ...extra });
export function assertSettingsExpected(snapshot, expected, signal) {
  signal?.throwIfAborted();
  if (!expected || (expected.fingerprint === undefined && expected.revision === undefined)
    || expected.fingerprint !== undefined && expected.fingerprint !== snapshot.fingerprint
    || expected.revision !== undefined && expected.revision !== snapshot.revision) {
    throw Object.assign(new Error('配置已变化，请重新读取'), { code: 'REVISION_CONFLICT', status: 409 });
  }
}
function safeJSON(value, depth = 0) {
  if (depth > 32 || value === undefined || typeof value === 'number' && !Number.isFinite(value)) throw new Error('配置值无效');
  if (value === null || ['string', 'boolean', 'number'].includes(typeof value)) return;
  if (!plain(value) && !Array.isArray(value)) throw new Error('配置值必须为 JSON');
  for (const [key, entry] of Object.entries(value)) { if (forbidden.has(key)) throw new Error('配置路径无效'); safeJSON(entry, depth + 1); }
}
/** Trusted adapters still validate paths before entering their original validators. */
export function applySettingsOps(value, ops, { sensitivePaths = [], blockedPaths = [], base } = {}) {
  if (!Array.isArray(ops) || !ops.length || ops.length > 128) throw new Error('配置操作无效');
  let next = structuredClone(value);
  for (const operation of ops) {
    let { op, path } = operation || {}, replacement = operation?.value;
    if (!['set', 'unset'].includes(op) || !Array.isArray(path) || path.length > 32 || path.some(key => typeof key !== 'string' || !key || key.length > 512 || forbidden.has(key))) throw new Error('配置路径无效');
    for (const denied of [...sensitivePaths, ...blockedPaths]) if (path.slice(0, denied.length).every((key, index) => key === denied[index]) || denied.slice(0, path.length).every((key, index) => key === path[index])) throw Object.assign(new Error('该字段须使用专用安全入口'), { code: 'SETTINGS_PATH_BLOCKED', status: 409 });
    if (op === 'unset' && base !== undefined) {
      let inherited = base, present = true;
      for (const key of path) { if (inherited === null || typeof inherited !== 'object' || !Object.hasOwn(inherited, key)) { present = false; break; } inherited = inherited[key]; }
      if (present) { op = 'set'; replacement = inherited; }
    }
    if (!path.length) { if (op === 'set') { safeJSON(replacement); if (!plain(replacement)) throw new Error('配置根必须为对象'); next = structuredClone(replacement); } else next = {}; continue; }
    let target = next, missing = false;
    for (const key of path.slice(0, -1)) {
      if (!plain(target) && !Array.isArray(target)) throw new Error('配置路径不存在');
      if (Array.isArray(target) && (!/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= target.length)) throw new Error('配置数组下标无效');
      if (!Object.hasOwn(target, key)) { if (op === 'unset') { missing = true; break; } target[key] = {}; }
      target = target[key];
    }
    if (missing) continue;
    if (!plain(target) && !Array.isArray(target)) throw new Error('配置路径不存在');
    const key = path.at(-1);
    if (Array.isArray(target) && (!/^(0|[1-9]\d*)$/u.test(key) || Number(key) > target.length || Number(key) === target.length && op === 'unset')) throw new Error('配置数组下标无效');
    if (op === 'set') { safeJSON(replacement); target[key] = structuredClone(replacement); }
    else if (Array.isArray(target)) target.splice(Number(key), 1);
    else delete target[key];
  }
  return next;
}
/** Normalize only caller-selected values; implicit sibling changes must be explicit. */
export function normalizeSettingsOps(current, ops, actual, { base } = {}) {
  const normalized = ops.map(operation => {
    if (operation.op !== 'set') return structuredClone(operation);
    let value = actual;
    for (const key of operation.path) { if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) throw Object.assign(new Error('该变更会隐式删除其他配置，请明确选择相关字段'), { code: 'SETTINGS_IMPLICIT_CHANGE' }); value = value[key]; }
    return { ...operation, value: structuredClone(value) };
  });
  if (settingsFingerprint(applySettingsOps(current, normalized, { base })) !== settingsFingerprint(actual)) throw Object.assign(new Error('该变更会隐式修改其他字段，请明确选择完整变更范围'), { code: 'SETTINGS_IMPLICIT_CHANGE' });
  return normalized;
}
export function notifySettings(listeners, event) {
  for (const listener of listeners) { try { listener(event); } catch {} }
}
