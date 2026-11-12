import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const SITE_ACTION_CATEGORIES = Object.freeze(['login', 'private-upload']);
export const HIGH_RISK_ACTION_CATEGORIES = Object.freeze(['payment', 'password-change', 'account-delete', 'external-send']);
const fail = (code, message) => Object.assign(new Error(message), { code });
const text = (value, name) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 1024 || /[\u0000-\u001f]/u.test(value)) throw fail('ACTION_INVALID', `无效${name}`);
  return value;
};
export function exactActionOrigin(value) {
  let url; try { url = new URL(value); } catch { throw fail('ACTION_ORIGIN_INVALID', '请输入完整站点 origin'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.hostname.includes('*') || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw fail('ACTION_ORIGIN_INVALID', '站点须为精确协议、主机和端口，不包含路径、凭据或通配符');
  return url.origin;
}
export function canonicalAction(value) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonicalAction);
  if (value && Object.getPrototypeOf(value) === Object.prototype) return Object.fromEntries(Object.keys(value).sort().map(key => {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw fail('ACTION_INVALID', '无效动作字段');
    return [key, canonicalAction(value[key])];
  }));
  throw fail('ACTION_INVALID', '动作仅支持有限 JSON 数据');
}
export const actionHash = value => createHash('sha256').update(JSON.stringify(canonicalAction(value))).digest('hex');
const bindingKeys = ['profileId', 'actorId', 'ticketId', 'assignmentId', 'runId', 'authorizationVersion', 'policyVersion'];
function binding(value) {
  const result = Object.fromEntries(bindingKeys.map(key => [key, text(String(value?.[key] ?? ''), key)]));
  return result;
}

/** Durable task action receipts and decisions from the existing host approval. */
export function createExternalActionStore({ directory, filename, profileId, now = Date.now } = {}) {
  text(profileId, '数据档案');
  if (!filename && !directory) throw new Error('External actions require a data directory');
  if (directory) mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(filename || join(directory, 'assistant.db'));
  db.exec(`PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS sa_external_actions(id TEXT PRIMARY KEY,profile_id TEXT NOT NULL,actor_id TEXT NOT NULL,request_key TEXT NOT NULL,fingerprint TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL,receipt TEXT,UNIQUE(profile_id,actor_id,request_key));
    CREATE TABLE IF NOT EXISTS sa_action_audit(id TEXT PRIMARY KEY,profile_id TEXT NOT NULL,actor_id TEXT NOT NULL,payload TEXT NOT NULL);`);
  const tx = fn => { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  const actor = value => {
    if (value?.profileId !== profileId) throw fail('ACTION_PROFILE_MISMATCH', '授权不属于当前数据档案');
    return { id: text(value.id, '授权人'), label: typeof value.label === 'string' ? value.label.slice(0, 200) : value.id, profileId };
  };
  const audit = (who, phase, data = {}) => {
    const row = { id: randomUUID(), phase, createdAt: new Date(now()).toISOString(), actor: who, ...data };
    db.prepare('INSERT INTO sa_action_audit VALUES (?,?,?,?)').run(row.id, profileId, who.id, JSON.stringify(row));
    return row;
  };
  const readAction = id => {
    const row = db.prepare('SELECT * FROM sa_external_actions WHERE id=? AND profile_id=?').get(text(id, '动作标识'), profileId);
    if (!row) throw fail('ACTION_NOT_FOUND', '动作不存在');
    return { ...JSON.parse(row.payload), state: row.state, ...(row.receipt ? { receipt: JSON.parse(row.receipt) } : {}) };
  };
  const checkBinding = (action, context) => {
    if (actionHash(action.binding) !== actionHash(binding(context))) throw fail('ACTION_BINDING_CHANGED', '工单、运行或当前授权已变化，请重新准备动作');
  };
  return {
    profileId,
    prepare({ requestId, adapterId, category, origin = null, target, content, submission }, context) { return tx(() => {
      const bound = binding(context); if (bound.profileId !== profileId) throw fail('ACTION_PROFILE_MISMATCH', '动作档案不一致');
      const who = actor({ profileId, id: bound.actorId }), requestKey = text(requestId, '请求标识');
      if (![...SITE_ACTION_CATEGORIES, ...HIGH_RISK_ACTION_CATEGORIES].includes(category)) throw fail('ACTION_CATEGORY_INVALID', '未注册的动作类别');
      const payload = canonicalAction({ adapterId: text(adapterId, '能力标识'), category, origin: origin === null ? null : exactActionOrigin(origin), target, content, submission, binding: bound });
      if (JSON.stringify(payload).length > 256000) throw fail('ACTION_TOO_LARGE', '动作内容过大');
      const fingerprint = actionHash(payload), old = db.prepare('SELECT id,fingerprint FROM sa_external_actions WHERE profile_id=? AND actor_id=? AND request_key=?').get(profileId, who.id, requestKey);
      if (old) { if (old.fingerprint !== fingerprint) throw fail('ACTION_IDEMPOTENCY_CONFLICT', '同一请求的目标或内容已变化，请使用新请求并重新批准'); return readAction(old.id); }
      const action = { ...payload, id: randomUUID(), fingerprint, createdAt: new Date(now()).toISOString() };
      db.prepare("INSERT INTO sa_external_actions VALUES (?,?,?,?,?,?,'pending',NULL)").run(action.id, profileId, who.id, requestKey, fingerprint, JSON.stringify(action));
      audit(who, 'prepared', { actionId: action.id, category, origin: payload.origin, fingerprint }); return { ...action, state: 'pending' };
    }); },
    get: readAction,
    decide(id, approved, context, identity) { const who = actor(identity); return tx(() => {
      const action = readAction(id); checkBinding(action, context);
      if (who.id !== action.binding.actorId) throw fail('ACTION_ACTOR_MISMATCH', '批准人不属于此动作授权人');
      const next = approved === true ? 'approved' : 'denied';
      if (action.state === next) return action;
      if (action.state !== 'pending') throw fail('ACTION_STATE_CONFLICT', '动作已决定或提交，不能再次批准');
      db.prepare('UPDATE sa_external_actions SET state=? WHERE id=?').run(next, id);
      audit(who, next, { actionId: id, category: action.category, origin: action.origin, fingerprint: action.fingerprint }); return readAction(id);
    }); },
    consume(id, context) { return tx(() => {
      const action = readAction(id); checkBinding(action, context);
      const who = actor({ profileId, id: action.binding.actorId });
      if (action.state !== 'approved') throw fail('ACTION_ONCE_REQUIRED', '动作未获批准或已提交；未知效果须先核实');
      db.prepare("UPDATE sa_external_actions SET state='submitted' WHERE id=?").run(id);
      audit(who, 'submitted', { actionId: id, category: action.category, origin: action.origin, fingerprint: action.fingerprint }); return readAction(id);
    }); },
    settle(id, { receipt, uncertain = false }) { return tx(() => {
      const action = readAction(id); if (action.state !== 'submitted') throw fail('ACTION_STATE_CONFLICT', '动作尚未提交或已经结算');
      const safeReceipt = receipt === undefined ? null : canonicalAction(receipt);
      if (JSON.stringify(safeReceipt).length > 16000) throw fail('ACTION_RECEIPT_INVALID', '动作回执过大');
      const state = uncertain ? 'uncertain' : 'completed';
      db.prepare('UPDATE sa_external_actions SET state=?,receipt=? WHERE id=?').run(state, JSON.stringify(safeReceipt), id);
      audit(actor({ profileId, id: action.binding.actorId }), state, { actionId: id, category: action.category, origin: action.origin }); return readAction(id);
    }); },
    close() { db.close(); },
  };
}
