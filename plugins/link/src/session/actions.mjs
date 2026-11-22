import { createHash } from 'node:crypto';

const fail = (message, code, status = 400) => Object.assign(new Error(message), { code, status });
const operations = new Set(['pin', 'unpin', 'archive', 'unarchive', 'rename', 'delete', 'fork']);
const activeArchiveCode = 'workspace/session-active';
const required = (value, label, limit = 200) => {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw fail(`${label}无效`, 'INVALID_SESSION_ACTION');
  return value;
};

/** Paired-human session commands with durable, intent-bound receipts; never arbitrary RPC. */
export function createSessionActions({ store, official, native, authorize, now = Date.now }) {
  const receipts = store.state.sessionActions ??= [], pending = new Map();
  const watermarks = store.state.sessionActionWatermarks ??= [], windowMs = 7 * 86400_000, futureMs = 86400_000;
  for (const receipt of receipts) if (receipt.state === 'applying') receipt.state = 'unknown';
  const issuedAtOf = requestId => {
    const match = /^sa:(\d{1,16}):[A-Za-z0-9_-]{1,100}$/.exec(requestId), issuedAt = match ? Number(match[1]) : NaN;
    if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) throw fail('请求 ID 格式已更新，请刷新入口后重试', 'INVALID_SESSION_ACTION');
    return issuedAt;
  };
  const retire = receipt => {
    let watermark = watermarks.find(row => row.deviceId === receipt.deviceId);
    if (!watermark) watermarks.push(watermark = { deviceId: receipt.deviceId, issuedAt: 0 });
    watermark.issuedAt = Math.max(watermark.issuedAt, receipt.issuedAt ?? receipt.createdAt);
    receipts.splice(receipts.indexOf(receipt), 1);
  };
  const prune = at => {
    for (const receipt of [...receipts]) if (receipt.createdAt < at - windowMs && !pending.has(JSON.stringify([receipt.deviceId, receipt.requestId]))) retire(receipt);
    if (receipts.length >= 2000) {
      const candidate = receipts.filter(row => ['done', 'failed'].includes(row.state) && !pending.has(JSON.stringify([row.deviceId, row.requestId]))).sort((a, b) => (a.issuedAt ?? a.createdAt) - (b.issuedAt ?? b.createdAt))[0];
      if (candidate) retire(candidate);
    }
  };
  const adapterOf = input => input.native ? native : official;
  const capabilities = device => {
    authorize(device);
    return [official, native].map((adapter, index) => {
      const allowed = adapter.managementOperations();
      return { id: index ? 'nativeSessionActions' : 'sessionActions', available: allowed.length > 0, operations: allowed, reason: allowed.length ? null : '目标会话管理服务尚不可用' };
    });
  };
  const dispatch = async (input, device) => {
    authorize(device);
    const id = required(input.id, '会话 ID', 256), requestId = required(input.requestId, '请求 ID');
    if (typeof input.native !== 'boolean') throw fail('缺少明确的会话类型，请刷新入口后重试', 'INVALID_SESSION_ACTION');
    if (!operations.has(input.operation)) throw fail('不支持的会话操作', 'UNSUPPORTED', 422);
    const title = input.operation === 'rename' ? required(input.title, '会话名称', 200) : undefined;
    if (input.operation !== 'rename' && input.title !== undefined) throw fail('此操作不接受会话名称', 'INVALID_SESSION_ACTION');
    if (input.stopActivity !== undefined && (input.operation !== 'archive' || typeof input.stopActivity !== 'boolean')) throw fail('停止活动只适用于会话归档', 'INVALID_SESSION_ACTION');
    const fingerprint = createHash('sha256').update(JSON.stringify([id, input.native, input.operation, title ?? null, ...(input.stopActivity === true ? [true] : [])])).digest('hex');
    const key = JSON.stringify([device.id, requestId]), adapter = adapterOf(input);
    let receipt = receipts.find(row => row.deviceId === device.id && row.requestId === requestId);
    if (receipt && receipt.fingerprint !== fingerprint) throw fail('请求 ID 已用于其他会话操作', 'SESSION_ACTION_CONFLICT', 409);
    const archive = ['archive', 'unarchive'].includes(input.operation);
    const scope = await adapter.managementScope(id, device, receipt?.scope, input.operation === 'delete' && !!receipt, archive);
    authorize(device);
    if (receipt) {
      if (pending.has(key)) return pending.get(key);
      if (receipt.state === 'done') return { ...receipt.result };
      if (receipt.state === 'failed') throw fail(receipt.error.message, receipt.error.code, receipt.error.status);
      throw fail('上次会话操作结果待核实，请刷新所属设备后确认，勿重复提交', 'SESSION_ACTION_UNCERTAIN', 409);
    }
    if (!adapter.managementOperations().includes(input.operation)) throw fail('目标尚不支持此会话操作', 'UNSUPPORTED', 422);
    // A concurrent duplicate can arrive while visibility is being checked.
    receipt = receipts.find(row => row.deviceId === device.id && row.requestId === requestId);
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) throw fail('请求 ID 已用于其他会话操作', 'SESSION_ACTION_CONFLICT', 409);
      await adapter.managementScope(id, device, receipt.scope, input.operation === 'delete', archive);
      authorize(device);
      if (pending.has(key)) return pending.get(key);
      if (receipt.state === 'done') return { ...receipt.result };
      if (receipt.state === 'failed') throw fail(receipt.error.message, receipt.error.code, receipt.error.status);
      throw fail('会话操作结果待核实，请刷新后确认', 'SESSION_ACTION_UNCERTAIN', 409);
    }
    const at = now(), issuedAt = issuedAtOf(requestId);
    if (issuedAt < at - windowMs || issuedAt > at + futureMs) throw fail('会话请求已超出有效时间窗口，请核对设备时间、刷新并发起新操作', 'SESSION_ACTION_EXPIRED', 409);
    if (issuedAt <= (watermarks.find(row => row.deviceId === device.id)?.issuedAt ?? -1)) throw fail('会话请求已超出回执保留范围，请刷新所属设备核实后发起新操作', 'SESSION_ACTION_EXPIRED', 409);
    prune(at);
    if (issuedAt <= (watermarks.find(row => row.deviceId === device.id)?.issuedAt ?? -1)) throw fail('会话请求已超出回执保留范围，请刷新所属设备核实后发起新操作', 'SESSION_ACTION_EXPIRED', 409);
    if (receipts.length >= 2000) throw fail('待核实或执行中的会话操作已达上限，请稍后重试', 'CAPACITY_REACHED', 429);
    receipt = { deviceId: device.id, requestId, fingerprint, scope, issuedAt, state: 'applying', createdAt: at };
    receipts.push(receipt);
    let applied = false;
    const guard = async () => { authorize(device); await adapter.managementScope(id, device, scope, input.operation === 'delete', archive); authorize(device); };
    guard.authorize = () => authorize(device);
    guard.mutation = () => { applied = true; };
    const promise = (async () => {
      try {
        await store.persist();
        await guard();
        const value = await adapter.manage({ id, operation: input.operation, title, stopActivity: input.stopActivity === true }, device, guard);
        applied = true;
        receipt.result = { accepted: true, id, operation: input.operation, requestId, refreshRequired: true, ...value };
        receipt.state = 'done';
        await store.persist();
        return { ...receipt.result };
      } catch (error) {
        if (input.operation === 'archive' && error.code === activeArchiveCode) {
          applied = false;
          error = fail('此会话仍有活动，请确认停止并归档', activeArchiveCode, 409);
        }
        if (applied) error = fail(`操作结果待核实（${error.message}），请刷新所属设备确认，勿重复提交`, 'SESSION_ACTION_UNCERTAIN', 409);
        receipt.state = applied ? 'unknown' : 'failed';
        receipt.error = { message: error.message, code: error.code || 'SESSION_ACTION_FAILED', status: error.status ?? 400 };
        await store.persist().catch(() => { receipt.state = 'unknown'; });
        throw error;
      } finally { pending.delete(key); }
    })();
    pending.set(key, promise);
    return promise;
  };
  return { dispatch, capabilities, async revoke(deviceId) { for (const rows of [receipts, watermarks]) for (let i = rows.length - 1; i >= 0; i--) if (rows[i].deviceId === deviceId) rows.splice(i, 1); await store.persist(); }, async close() { await Promise.allSettled([...pending.values()]); } };
}
