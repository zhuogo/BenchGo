import { createHash } from 'node:crypto';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const actor = Object.freeze({ kind: 'machine', id: 'harness-schedule' });
const failure = message => Object.assign(new Error(message), { code: 'SCHEDULE_BRIDGE_UNAVAILABLE' });

/** Only an existing destination session can be owned; a schedule that opens a new session each time has none. */
export const scheduleTargetSession = entry => ['session', 'new_once'].includes(entry?.target?.kind) ? entry.target.sessionId : undefined;

/** Only the official typed inbox source is eligible; user text cannot impersonate it. */
export function scheduleOccurrences(message) {
  if (message?.source?.kind !== 'schedule') return [];
  const text = (message.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
  const lines = text.split('\n');
  let occurrences;
  try {
    if (lines[0] === '[SCHEDULE REMINDER]' && lines.length === 5 && lines[2].startsWith('schedule_id_json: ') && lines[3].startsWith('occurrence_at: ') && lines[4].startsWith('reminder_prompt_json: ')) occurrences = [{
      schedule_id: JSON.parse(lines[2].slice('schedule_id_json: '.length)),
      occurrence_at: lines[3].slice('occurrence_at: '.length),
      reminder_prompt: JSON.parse(lines[4].slice('reminder_prompt_json: '.length)),
    }];
    else if (lines[0] === '[SCHEDULE REMINDER BATCH]' && lines.length === 3 && lines[2].startsWith('reminders_json: ')) occurrences = JSON.parse(lines[2].slice('reminders_json: '.length));
    if (lines[1] !== 'This is a scheduled message from the user' || !Array.isArray(occurrences) || !occurrences.length
      || occurrences.some(row => typeof row.schedule_id !== 'string' || !row.schedule_id || typeof row.reminder_prompt !== 'string' || !row.reminder_prompt.trim()
        || typeof row.occurrence_at !== 'string' || !Number.isFinite(Date.parse(row.occurrence_at)))) throw Error();
  } catch { throw failure('无法识别宿主 Schedule 投递，已阻止直接执行'); }
  return occurrences;
}

/** Reuses Host timing and delivery history; this is an event bridge, never a timer. */
export function createScheduleBridge({ ctx, store, readPolicy, onOccurrence }) {
  let stopped = false, running, unsubscribe, dirty = false;
  // First installation must not re-execute reminders already handled by the old
  // conversation path. The ledger timestamp survives restarts and hot reloads.
  const activation = store.ledger.append({ id: 'schedule-bridge:v1', sourceKey: 'schedule-bridge:v1', kind: 'schedule-bridge', content: 'Harness Schedule 合成 Trigger 桥接已启用', metadata: { version: 1 } }).createdAt;
  const schedule = () => ctx.get?.('schedule');
  async function ownedSessions() {
    const state = await store.getState();
    return new Map([
      ...(state.mainSessionId ? [[state.mainSessionId, 'main']] : []),
      ...(state.threads || []).filter(row => row.sessionId && !row.archived).map(row => [row.sessionId, row.id]),
    ]);
  }
  async function ingest({ entry, occurrence, threadId, messageId }) {
    if (stopped) throw failure('Schedule 桥接已停止');
    const key = digest([entry.sessionId, entry.id, occurrence.occurrence_at]);
    const triggerId = `schedule:${key}`;
    // The Host can repeat a delivered occurrence with another message ID after a crash.
    const previous = store.orchestration.getTrigger(triggerId);
    if (previous) { await projectOccurrence(entry, occurrence); return { trigger: previous, duplicate: true }; }
    const policy = await readPolicy();
    if (stopped) throw failure('Schedule 桥接已停止');
    const concurrent = store.orchestration.getTrigger(triggerId);
    if (concurrent) { await projectOccurrence(entry, occurrence); return { trigger: concurrent, duplicate: true }; }
    const accepted = store.orchestration.ingest({ id: triggerId, dedupeKey: triggerId,
      thread: { id: triggerId, source: { type: 'schedule', id: key } },
      source: { channel: 'desktop', sessionId: entry.sessionId, threadId, messageId,
        scheduleId: entry.id, occurrenceAt: occurrence.occurrence_at, origin: 'harness-schedule' },
      actor, content: occurrence.reminder_prompt, createdAt: occurrence.occurrence_at,
      policyVersion: policy.version, mode: 'group', subscriptionEligible: false,
      gate: { allowed: true, strength: 'explicit', reason: 'owned-harness-schedule', evidence: { desktopPolicyVersion: policy.desktopVersion } },
    });
    await projectOccurrence(entry, occurrence);
    return accepted;
  }
  async function projectOccurrence(entry, occurrence) {
    try { await onOccurrence?.({ entry, occurrence }); }
    catch (error) { ctx.logger?.warn?.(`SuperAgent Schedule projection: ${error.code || error.name}`); }
  }
  async function ingestMessages({ sessionId, messages }) {
    const scheduled = (messages || []).filter(message => message.source?.kind === 'schedule');
    if (!scheduled.length) return [];
    const host = schedule();
    if (!host?.catalog) throw failure('宿主 Schedule 服务不可用，已阻止直接执行');
    const owned = await ownedSessions();
    if (!owned.has(sessionId)) throw failure('Schedule 来源不是当前总助手会话');
    const catalog = await host.catalog(), accepted = [];
    for (const message of scheduled) for (const occurrence of scheduleOccurrences(message)) {
      const matched = catalog.find(row => row.id === occurrence.schedule_id && scheduleTargetSession(row) === sessionId);
      const entry = matched && { ...matched, sessionId };
      if (!entry) throw failure('Schedule 已删除或会话绑定变化，已阻止直接执行');
      const previous = store.orchestration.getTrigger(`schedule:${digest([sessionId, entry.id, occurrence.occurrence_at])}`);
      if (previous) { await projectOccurrence(entry, occurrence); accepted.push({ trigger: previous, duplicate: true }); continue; }
      // A pre-step can run before the Host commits its receipt. In that window
      // the immutable, typed inbox source and current exact prompt are evidence.
      if (entry.prompt !== occurrence.reminder_prompt) {
        const history = await host.history?.({ id: entry.id, limit: 100 });
        if (!history?.records?.some(row => row.scheduledAt === occurrence.occurrence_at && row.prompt === occurrence.reminder_prompt
          && row.targetSessionId === sessionId)) throw failure('Schedule 指令已变化且缺少原始投递凭据');
      }
      accepted.push(await ingest({ entry, occurrence, threadId: owned.get(sessionId), messageId: message.id }));
    }
    return accepted;
  }
  async function scan() {
    const host = schedule();
    if (stopped || !host?.catalog || !host?.history) return;
    const owned = await ownedSessions();
    for (const row of await host.catalog()) {
      if (stopped) return;
      const entry = { ...row, sessionId: scheduleTargetSession(row) };
      if (!owned.has(entry.sessionId) || !entry.lastDelivery) continue;
      // Official recovery semantics only replay the latest occurrence.
      const history = await host.history({ id: entry.id, limit: 1 });
      const receipt = history.records?.[0];
      if (!receipt || typeof receipt.prompt !== 'string' || Date.parse(receipt.deliveredAt) < Date.parse(activation) || !Number.isFinite(Date.parse(receipt.deliveredAt))
        || receipt.targetSessionId !== entry.sessionId) continue;
      await ingest({ entry, occurrence: { occurrence_at: receipt.scheduledAt, reminder_prompt: receipt.prompt }, threadId: owned.get(entry.sessionId), messageId: receipt.messageId });
    }
  }
  const tick = () => {
    dirty = true;
    return running ||= (async () => { while (dirty && !stopped) { dirty = false; await scan(); } })().finally(() => { running = undefined; });
  };
  return {
    ingestMessages, tick,
    available: () => !!schedule()?.catalog && !!schedule()?.history,
    async start() {
      if (stopped || unsubscribe) return;
      unsubscribe = ctx.on('schedule/changed', () => { void tick().catch(error => ctx.logger?.warn?.(`SuperAgent Schedule: ${error.message}`)); }, { global: true });
      await tick();
    },
    async stop() { stopped = true; unsubscribe?.(); unsubscribe = undefined; await running?.catch(() => {}); },
  };
}

export function isScheduledTrigger(trigger) {
  return trigger?.actor?.kind === 'machine' && trigger.actor.id === actor.id
    && trigger.source?.origin === 'harness-schedule' && trigger.source.channel === 'desktop'
    && typeof trigger.source.sessionId === 'string' && !!trigger.source.sessionId
    && typeof trigger.source.scheduleId === 'string' && !!trigger.source.scheduleId
    && typeof trigger.source.occurrenceAt === 'string' && Number.isFinite(Date.parse(trigger.source.occurrenceAt));
}
