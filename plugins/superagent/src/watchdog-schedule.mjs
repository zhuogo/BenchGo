export const watchdogSchedulePrompt = 'BenchGo Watchdog: perform the registered read-only observation check. This scheduled message grants no task, configuration, or recovery authority.';
const targetSession = entry => entry?.target?.kind === 'session' ? entry.target.sessionId : null;
const failure = message => Object.assign(new Error(message), { code: 'WATCHDOG_SCHEDULE_INVALID' });

/** Observe official durable delivery receipts; this bridge owns no clock or task scheduler. */
export function createWatchdogScheduleBridge({ ctx, watchdog, store, config, ensureSession }) {
  const schedule = ctx.get ? ctx.get('schedule') : ctx.schedule;
  if (!schedule?.catalog || !schedule?.history || !schedule?.create || !schedule?.edit) throw failure('官方 Schedule 服务不可用');
  let pending, starting, dirty = false, stopped = false, unsubscribe;
  async function configure() {
    const agent = await ensureSession(), state = store.snapshot();
    if (agent.id !== state.sessionId) throw failure('监督会话身份不一致');
    const all = await schedule.catalog();
    let entry = state.scheduleId ? all.find(row => row.id === state.scheduleId) : undefined;
    if (state.scheduleId && !entry) throw failure('已保存的监督 Schedule 不存在，请通过维护配置明确处理');
    if (!entry) {
      const matches = all.filter(row => targetSession(row) === state.sessionId && row.prompt === watchdogSchedulePrompt);
      if (matches.length > 1) throw failure('同一监督会话存在重复 Schedule');
      entry = matches[0] ?? await schedule.create({ title: 'BenchGo Watchdog', prompt: watchdogSchedulePrompt,
        timing: { kind: 'every', every_seconds: config.intervalSeconds }, target: { kind: 'session', sessionId: state.sessionId } });
      await store.update(next => { next.scheduleId = entry.id; });
    }
    if (targetSession(entry) !== state.sessionId || entry.prompt !== watchdogSchedulePrompt) throw failure('监督 Schedule 的会话或检查指令已变化');
    // Only a maintainer config revision or our own disposal changes this task;
    // an ordinary Schedule pause is not silently undone by a change notice.
    if (state.scheduleConfigRevision !== state.configRevision || state.scheduleSuspended) {
      const result = await schedule.edit({ id: entry.id, action: 'update', patch: {
        timing: { kind: 'every', every_seconds: config.intervalSeconds }, active: config.enabled && !config.paused,
      } });
      if (result?.code) throw failure('监督 Schedule 配置未保存');
      await store.update(next => { next.scheduleConfigRevision = next.configRevision; next.scheduleSuspended = false; });
    }
  }
  async function scan() {
    const state = store.snapshot();
    if (!state.scheduleId || stopped || !config.enabled || config.paused) return;
    const entry = (await schedule.catalog()).find(row => row.id === state.scheduleId);
    if (!entry || targetSession(entry) !== state.sessionId || entry.prompt !== watchdogSchedulePrompt) throw failure('监督 Schedule 绑定不可核实');
    const history = await schedule.history({ id: entry.id, limit: 1 });
    const receipt = history.records?.[0];
    if (!receipt) return;
    if (receipt.targetSessionId !== state.sessionId || receipt.prompt !== watchdogSchedulePrompt) throw failure('监督 Schedule 投递凭据不匹配');
    await watchdog.check({ scheduleId: entry.id, ...receipt });
  }
  const reconcile = () => {
    if (stopped) return Promise.resolve();
    dirty = true;
    return pending ||= (async () => { while (dirty && !stopped) { dirty = false; await scan(); } })().finally(() => { pending = undefined; });
  };
  return {
    reconcile,
    start() {
      if (stopped || unsubscribe) return Promise.resolve();
      return starting ||= (async () => {
        await configure();
        if (stopped) return;
        unsubscribe = ctx.on('schedule/changed', () => { void reconcile().catch(error => ctx.logger?.warn?.(`Watchdog Schedule: ${error.code || 'UNAVAILABLE'}`)); }, { global: true });
        await reconcile();
      })().finally(() => { starting = undefined; });
    },
    async stop() {
      if (stopped) return;
      stopped = true; unsubscribe?.(); unsubscribe = undefined;
      await starting?.catch(() => {});
      await pending?.catch(() => {});
      const state = store.snapshot();
      if (!state.scheduleId) return;
      const entry = (await schedule.catalog()).find(row => row.id === state.scheduleId);
      if (entry?.status !== 'active' || targetSession(entry) !== state.sessionId || entry.prompt !== watchdogSchedulePrompt) return;
      await store.update(next => { next.scheduleSuspended = true; });
      const result = await schedule.edit({ id: entry.id, action: 'update', patch: { active: false } });
      if (result?.code) throw failure('监督 Schedule 暂停未保存');
    },
  };
}
