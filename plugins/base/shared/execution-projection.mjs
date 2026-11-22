import { z } from 'zod';
import { publicExecutionActivity } from './worker-progress.mjs';

// Official Session projections own replay. This bounded view never authorizes,
// executes, schedules, or changes the Task/Assignment/Run lifecycle.
export const executionProjectionKey = 'benchgoExecutionFacts';
export const executionActivityTime = value => value != null && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
export const executionStopStatus = reason => reason === 'completed' ? 'completed' : reason === 'aborted' ? 'cancelled'
  : ['error', 'max-tokens', 'refusal'].includes(reason) ? 'failed' : 'unknown';
export const executionActivities = { search: '正在搜索网页', web: '正在读取网页', read: '正在读取文件', write: '正在修改文件',
  command: '正在执行命令', child: '正在协调并行任务', question: '正在等待问题答复', tool: '正在使用工具' };
export const executionToolCategory = name => name === 'web_search' ? 'search' : name === 'web_fetch' ? 'web'
  : ['read', 'read_file', 'glob', 'grep', 'list_directory'].includes(name) ? 'read'
  : ['write', 'write_file', 'edit', 'apply_patch'].includes(name) ? 'write'
  : ['bash', 'pwsh', 'shell', 'exec_command'].includes(name) ? 'command'
  : ['subagent', 'spawn_agent', 'send_message', 'followup_task', 'wait_agent', 'list_agents'].includes(name) ? 'child'
  : name === 'ask_user_question' ? 'question' : 'tool';
const eventSchema = z.object({ seq: z.number().int(), kind: z.string(), time: z.string().nullable(), category: z.string().optional() });
const activitySourceSchema = z.enum(['report', 'runtime']);
const activitySchema = z.object({ seq: z.number().int(), time: z.string().nullable(), status: z.string(), activity: z.string(), activitySource: activitySourceSchema });
const requestSchema = z.object({ state: z.enum(['unknown', 'inflight', 'settled']), startedAt: z.string().nullable(), settledAt: z.string().nullable(), deadline: z.null() });
const stateSchema = z.object({ sessionId: z.string(), parentSessionId: z.string().nullable(), inheritedEventCount: z.number().int(),
  cursor: z.number().int(), status: z.string(), activity: z.string(), activitySource: activitySourceSchema, updatedAt: z.string().nullable(), turn: z.number().int().nullable(), step: z.number().int().nullable(),
  request: requestSchema, tools: z.object({ calls: z.number().int(), results: z.number().int(), errors: z.number().int(),
    incomplete: z.boolean(), active: z.array(z.object({ callId: z.string(), category: z.string(), sourceSeq: z.number().int() })).max(128) }),
  children: z.array(z.object({ sessionId: z.string(), catalogSeq: z.number().int(), createdAt: z.string().nullable(),
    notice: z.object({ seq: z.number().int(), reason: z.string(), messageId: z.string() }).optional() })).max(512),
  childrenTruncated: z.boolean(), milestones: z.array(eventSchema).max(64), lastEvent: eventSchema.nullable(),
  activityHistory: z.array(activitySchema).max(64), activityHistoryTruncated: z.boolean() });
export const initialExecutionProjection = (header, inheritedEventCount) => ({ sessionId: header.id,
  parentSessionId: header.origin === 'subagent' ? header.parentSession || null : null, inheritedEventCount,
  cursor: -1, status: 'unknown', activity: '', activitySource: 'runtime', updatedAt: null, turn: null, step: null,
  request: { state: 'unknown', startedAt: null, settledAt: null, deadline: null },
  tools: { calls: 0, results: 0, errors: 0, active: [], incomplete: false }, children: [], childrenTruncated: false, milestones: [], lastEvent: null,
  activityHistory: [], activityHistoryTruncated: false });

/** Pure, bounded fold. Only marked public status text is retained; tool bodies and reasoning stay private. */
export function applyExecutionEvent(state, event) {
  if (event.seq < state.inheritedEventCount) return state;
  if (!['turn/start', 'turn/end', 'step/start', 'step/end', 'tool/call', 'tool/result', 'assistant/message',
    'assistant/attempt', 'subagent/catalog', 'user/message', 'agent/inbox/spliced'].includes(event.type)) return state;
  const data = event.data || {}, time = executionActivityTime(event.time);
  let children = state.children;
  const notice = message => {
    const source = message?.source;
    if (source?.kind !== 'subagent-settled' || !message.id) return;
    const index = children.findIndex(child => child.sessionId === source.senderSessionId);
    if (index < 0 || children[index].notice?.messageId === message.id) return;
    children = children.map((child, i) => i === index ? { ...child, notice: { seq: event.seq,
      reason: ['completed', 'aborted', 'error', 'max-tokens', 'refusal'].includes(source.stopReason) ? source.stopReason : 'unknown',
      messageId: message.id } } : child);
  };
  if (event.type === 'user/message') notice(data);
  if (event.type === 'agent/inbox/spliced') for (const message of data.inserted || []) notice(message);
  if (['user/message', 'agent/inbox/spliced'].includes(event.type) && children === state.children) return state;
  const next = { ...state, cursor: event.seq, updatedAt: time || state.updatedAt, children };
  let kind = event.type, toolCategory;
  if (event.type === 'subagent/catalog') {
    if (![0, 1, 2, 3].includes(data.version) || typeof data.childId !== 'string') return state;
    if (children.some(child => child.sessionId === data.childId)) return state;
    if (children.length >= 512) next.childrenTruncated = true;
    else next.children = [...children, { sessionId: data.childId, catalogSeq: event.seq, createdAt: executionActivityTime(data.childCreatedAt) || time }];
  } else if (event.type === 'turn/start') {
    next.status = 'running'; next.activity = '正在处理任务'; next.activitySource = 'runtime'; next.turn = Number.isSafeInteger(data.turn) ? data.turn : null;
  } else if (event.type === 'step/start') {
    next.status = 'running'; if (state.activitySource !== 'report') next.activity = '正在处理任务'; next.step = Number.isSafeInteger(data.step) ? data.step : null;
    // Preparation is not proof of an in-flight model request.
    next.request = { state: 'unknown', startedAt: null, settledAt: null, deadline: null };
  } else if (['assistant/message', 'assistant/attempt'].includes(event.type)) {
    next.request = { ...state.request, state: 'settled', settledAt: time };
    const report = publicExecutionActivity(event);
    if (report) { next.activity = report; next.activitySource = 'report'; }
  } else if (event.type === 'tool/call') {
    toolCategory = executionToolCategory(data.name); next.status = 'running';
    if (state.activitySource !== 'report') next.activity = executionActivities[toolCategory];
    const active = state.tools.active;
    next.tools = { ...state.tools, calls: state.tools.calls + 1, incomplete: state.tools.incomplete || active.length >= 128,
      active: active.length < 128 && typeof data.callId === 'string' ? [...active, { callId: data.callId, category: toolCategory, sourceSeq: event.seq }] : active };
  } else if (event.type === 'tool/result') {
    const callId = data.message?.toolCallId || data.message?.callId;
    toolCategory = state.tools.active.find(call => call.callId === callId)?.category || 'tool';
    next.tools = { ...state.tools, results: state.tools.results + 1, errors: state.tools.errors + (data.message?.isError ? 1 : 0),
      active: state.tools.active.filter(call => call.callId !== callId) };
    if (data.message?.isError) { next.activity = '工具调用失败，正在处理'; next.activitySource = 'runtime'; }
    else if (state.activitySource !== 'report') next.activity = '正在处理任务';
  } else if (event.type === 'turn/end') {
    const reason = data.reason?.kind;
    next.status = reason === 'blocked' ? 'waiting' : executionStopStatus(reason);
    next.activitySource = 'runtime';
    next.activity = reason === 'completed' ? '本轮执行已结束' : reason === 'blocked' ? '正在等待处理'
      : next.status === 'cancelled' ? '执行已停止' : next.status === 'failed' ? '执行遇到错误' : '执行状态待核实';
    next.request = { ...state.request, state: 'settled', settledAt: time };
  }
  if (children !== state.children) kind = 'subagent/returned';
  next.lastEvent = { seq: event.seq, kind, time, ...(toolCategory ? { category: toolCategory } : {}) };
  if (event.type !== 'tool/call') next.milestones = [...state.milestones, next.lastEvent].slice(-64);
  // Retain meaningful changes independently from the mutable current activity.
  // Successful tool results and step preparation are generic resets, not progress.
  const history = state.activityHistory || [], previous = history.at(-1);
  if ((next.status !== state.status || next.activity !== state.activity)
    && (event.type !== 'step/start' && (event.type !== 'tool/result' || data.message?.isError))
    && (previous?.status !== next.status || previous?.activity !== next.activity)) {
    next.activityHistory = [...history, { seq: event.seq, time, status: next.status, activity: next.activity, activitySource: next.activitySource }].slice(-64);
    next.activityHistoryTruncated = state.activityHistoryTruncated || history.length >= 64;
  }
  return next;
}
export const executionProjectionDefinition = { key: executionProjectionKey, stateVersion: 3, stateSchema,
  init: initialExecutionProjection, apply: applyExecutionEvent, wire: { viewSchema: stateSchema, view: state => state, summary: false } };
