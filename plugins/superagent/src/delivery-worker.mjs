/**
 * Durable notification delivery worker.
 *
 * The task store is the source of truth. A transport only needs to provide
 * `send(event, { deviceId, idempotencyKey })`; a successful return means the
 * transport accepted the event. Device receipts are recorded separately by
 * the notification acknowledgement endpoint, so acceptance is never treated
 * as receipt on another device.
 */
export function createAssistantDeliveryWorker({ database, send, targets, logger = console, now = Date.now, intervalMs = 30_000 } = {}) {
  if (!database) throw new Error('通知投递需要任务数据库');
  let timer;
  let running = false;
  let active = null;
  let stopped = false;
  const targetList = async () => {
    if (typeof targets !== 'function') return [];
    const value = await targets();
    return Array.isArray(value) ? value.map(String).filter(Boolean).slice(0, 500) : [];
  };
  async function sendOne(row, deviceId = null) {
    if (typeof send !== 'function') return false;
    try {
      const accepted = await send(row.event, { deviceId, idempotencyKey: `${row.eventId}:${deviceId || 'server'}` });
      if (deviceId) database.deliveryTargetAttempt(row.eventId, deviceId, { delivered: accepted !== false });
      else database.deliveryAttempt(row.eventId, { delivered: accepted !== false });
      return accepted !== false;
    } catch (error) {
      try {
        if (deviceId) database.deliveryTargetAttempt(row.eventId, deviceId, { error: String(error?.message || error).slice(0, 2000) });
        else database.deliveryAttempt(row.eventId, { error: String(error?.message || error).slice(0, 2000) });
      } catch (recordError) { logger?.warn?.(`通知失败状态无法保存：${recordError.message}`); }
      return false;
    }
  }
  async function tick() {
    if (running || stopped) return { delivered: 0, failed: 0, skipped: true };
    running = true;
    active = (async () => {
      let delivered = 0, failed = 0;
      try {
        const direct = database.pendingOutbox(now());
        for (const row of direct) {
          const known = database.deliveryTargets(row.eventId);
          if (!known.length) {
            const ids = await targetList();
            if (ids.length) database.registerDeliveryTargets(row.eventId, ids);
            // When a target provider is present, an empty list means the
            // devices are currently offline or not yet paired. Keep the
            // durable outbox row so a later reconnect can receive it via
            // target registration or cursor sync. Direct server delivery is
            // only valid when no target provider was configured.
            else if (typeof targets !== 'function' && await sendOne(row)) delivered++;
          }
        }
        for (const row of database.pendingDeliveries(now(), 100)) {
          if (await sendOne(row, row.deviceId)) delivered++;
          else failed++;
        }
        return { delivered, failed, skipped: false };
      } finally {
        running = false;
      }
    })();
    try { return await active; } finally { active = null; }
  }
  function start() {
    if (timer || stopped) return;
    timer = setInterval(() => { tick().catch(error => logger?.warn?.(`通知投递失败：${error.message}`)); }, intervalMs);
    timer.unref?.();
  }
  async function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = undefined;
    if (active) await active.catch(() => {});
  }
  return { tick, start, stop, get running() { return running; } };
}
