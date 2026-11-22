import { scheduleTargetSession } from './schedule-bridge.mjs';

const string = { type: 'string' };
const boolean = { type: 'boolean' };
const object = { type: 'object', additionalProperties: true };
const timingFields = {
  after_seconds: { type: 'integer', minimum: 1, description: 'Delay in seconds from now.' },
  at: { anyOf: [string, object], description: 'RFC 3339 time with offset, or {date, time, time_zone}.' },
  every_seconds: { type: 'integer', minimum: 1, description: 'Fixed interval in seconds.' },
  daily: { ...object, description: '{time, time_zone}.' },
  weekly: { ...object, description: '{time, time_zone, weekdays: [1..7]}.' },
  cron: { ...object, description: '{expression, time_zone} for a five-field cron.' },
  rrule: { ...string, description: 'Calendar recurrence rule in the official Schedule format.' },
};
const timing = args => {
  const fields = Object.keys(timingFields).filter(key => args[key] !== undefined);
  if (fields.length > 1) throw new Error('只能指定一个定时时间参数');
  const [field] = fields;
  return field && { kind: field.replace(/_seconds$/, ''), [field]: args[field] };
};
const pageSize = { type: 'integer', minimum: 1, maximum: 100 };
const revision = { anyOf: [string, { type: 'null' }], description: 'Reuse updatedAt from the latest result when available.' };

export function registerRouterScheduleTools({ schedule, register, ownerAgent, managementScope, projectSchedules }) {
  if (!schedule?.create || !schedule?.catalog || !schedule?.edit) return;
  const caller = exec => {
    const id = exec.agent === ownerAgent && ownerAgent.session?.id;
    if (!id) throw new Error('当前总助手会话无法管理定时任务');
    return id;
  };
  const matches = (entry, sessionId, global) => global || scheduleTargetSession(entry) === sessionId;
  const find = async (id, exec) => {
    const sessionId = caller(exec);
    const entry = schedule.view ? await schedule.view({ id }) : (await schedule.catalog()).find(row => row.id === id);
    if (!entry || entry.code || !matches(entry, sessionId, await managementScope())) return { id, code: 'schedule_not_found' };
    return entry;
  };
  const edit = async ({ id, expectedUpdatedAt, ...args }, action, exec) => {
    const entry = await find(id, exec);
    if (entry.code) return action === 'delete' ? { ...entry, deleted: false } : { ...entry, updated: false };
    const change = timing(args);
    const patch = Object.fromEntries(['title', 'prompt', 'active'].filter(key => args[key] !== undefined).map(key => [key, args[key]]));
    if (change) patch.timing = change;
    if (action === 'update' && !Object.keys(patch).length) throw new Error('请指定要修改的定时字段');
    return schedule.edit({ id, action, expectedUpdatedAt: expectedUpdatedAt === undefined ? entry.updatedAt ?? null : expectedUpdatedAt,
      ...(action === 'update' ? { patch } : {}) }, caller(exec), exec.signal);
  };
  register('schedule_create', 'Create a scheduled reminder or task in this conversation. Supply title, prompt and exactly one timing field.', {
    title: string, prompt: string, ...timingFields,
  }, ['title', 'prompt'], async (args, exec) => {
    const sessionId = caller(exec), rule = timing(args);
    if (!rule || !args.title?.trim() || !args.prompt?.trim()) throw new Error('请指定标题、内容和一个定时时间');
    const entry = await schedule.create({ title: args.title, prompt: args.prompt, timing: rule,
      target: { kind: 'session', sessionId } }, sessionId, exec.signal);
    await projectSchedules();
    return entry;
  });
  register('schedule_list', 'Find scheduled tasks by title, including other conversations and paused or ended tasks in a local owner conversation. Use the returned exact id; clarify if multiple tasks match. Follow nextOffset for more.', {
    query: string, active: boolean, status: { type: 'string', enum: ['active', 'paused', 'ended'] },
    limit: pageSize, offset: { type: 'integer', minimum: 0 },
  }, [], async ({ query, active, status, limit = 20, offset = 0 }, exec) => {
    const sessionId = caller(exec);
    const catalog = await schedule.catalog(), global = await managementScope(), title = query?.trim().toLowerCase();
    const entries = catalog.filter(entry => matches(entry, sessionId, global)
      && (active === undefined || active === (entry.status === 'active'))
      && (!status || status === entry.status) && (!title || entry.title.toLowerCase().includes(title)));
    return { items: entries.slice(offset, offset + limit), total: entries.length,
      nextOffset: offset + limit < entries.length ? offset + limit : null };
  });
  register('schedule_view', 'Read a scheduled task by its exact id.', { id: string }, ['id'], ({ id }, exec) => find(id, exec));
  register('schedule_update', 'Change a scheduled task by id. Use active=false to pause or active=true to resume. Omitted fields retain their values.', {
    id: string, title: string, prompt: string, active: boolean, expectedUpdatedAt: revision, ...timingFields,
  }, ['id'], (args, exec) => edit(args, 'update', exec));
  register('schedule_delete', 'Delete a scheduled task by its exact id, including one from another conversation on the local host. Messages or work already delivered are separate.', {
    id: string, expectedUpdatedAt: revision,
  }, ['id'], (args, exec) => edit(args, 'delete', exec));
  if (schedule.run) register('schedule_run', 'Deliver a scheduled task now without moving its next planned occurrence.', {
    id: string,
  }, ['id'], async ({ id }, exec) => {
    caller(exec);
    if (!await managementScope()) throw new Error('立即运行定时任务需要当前本机对话中的用户指令');
    return schedule.run({ id }, exec.signal);
  });
  if (schedule.history) register('schedule_history', 'Read saved deliveries for a scheduled task. Pass the returned nextBefore as before to continue.', {
    id: string, limit: pageSize, before: string,
  }, ['id'], async ({ id, limit = 20, before }, exec) => {
    const entry = await find(id, exec);
    return entry.code ? entry : schedule.history({ id, limit, ...(before === undefined ? {} : { before }) });
  });
}
