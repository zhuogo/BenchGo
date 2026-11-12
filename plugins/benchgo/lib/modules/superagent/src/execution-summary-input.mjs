import { executionStatusText } from './ticket-lifecycle.mjs';

const kinds = new Set(['turn/start', 'turn/end', 'step/start', 'step/end', 'tool/call', 'tool/result', 'assistant/message', 'assistant/attempt', 'subagent/catalog', 'subagent/returned', 'subagent/start', 'subagent/end', 'execution', 'recovery-unavailable', 'ticket', 'assignment', 'run', 'result', 'delivery', 'attention', 'input', 'requirements', 'goal']);
const statuses = new Set(['queued', 'pending', 'running', 'active', 'waiting', 'blocked', 'pausing', 'paused', 'stopping', 'stopped', 'cancelled', 'completed', 'failed', 'uncertain', 'delivering', 'ready', 'assigned', 'succeeded']);
const activities = new Set(['idle', 'running', 'thinking', 'tool', 'working', 'waiting', 'blocked', 'paused', 'stopping', 'stopped', 'completed', 'failed', 'unknown',
  '正在处理任务', '正在搜索网页', '正在读取网页', '正在读取文件', '正在修改文件', '正在执行命令', '正在协调子 Worker',
  '正在等待问题答复', '正在使用工具', '工具调用失败，正在处理', '本轮执行已结束', '正在等待处理', '执行已停止', '执行遇到错误', '执行状态待核实']);
const count = value => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1_000_000_000) : 0;
const identity = value => typeof value === 'string' && value.length <= 512 ? value : '';
function boundInput(result, maxInputCharacters) {
  const limit = Math.max(1024, Math.min(32000, Number(maxInputCharacters) || 8000));
  while (JSON.stringify(result).length > limit && result.progressReports.length > 1) result.progressReports.shift();
  if (JSON.stringify(result).length > limit && result.progressReports.length) result.progressReports[0].text = result.progressReports[0].text.slice(0, 240);
  const requiredRefs = new Set(result.progressReports.map(row => row.evidenceRef));
  while (JSON.stringify(result).length > limit && result.evidenceRefs.some(ref => !requiredRefs.has(ref))) {
    result.evidenceRefs.splice(result.evidenceRefs.findIndex(ref => !requiredRefs.has(ref)), 1);
  }
  while (JSON.stringify(result).length > limit && result.acceptance.length) result.acceptance.pop();
  if (JSON.stringify(result).length > limit) result.target = result.target.slice(0, 120);
  while (JSON.stringify(result).length > limit && result.events.length) result.events.shift();
  if (JSON.stringify(result).length > limit) throw Object.assign(new Error('辅助输入超过上限'), { code: 'AUXILIARY_INPUT_LIMIT' });
  return result;
}

/** Redact free-text requirements before any background-model request or audit. */
export function redactExecutionText(value, limit = 600) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/-----BEGIN[\s\S]*?-----END[^\r\n]*-----/g, '[秘密已隐藏]')
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;"'<>]+/gi, '[认证已隐藏]')
    .replace(/((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password|passwd|authorization|credential|secret|token|密码|密钥|凭据)\s*["']?\s*[:=：]\s*)(["'])[\s\S]*?\2/gi, '$1[秘密已隐藏]')
    .replace(/((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password|passwd|authorization|credential|secret|token|密码|密钥|凭据)\s*["']?\s*[:=：]\s*)["']?[^\s,;，；"'<>]+["']?/gi, '$1[秘密已隐藏]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, '[秘密已隐藏]')
    .replace(/https?:\/\/[^\s<>"']+/gi, value => { try { const url = new URL(value); return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}${url.pathname}${url.search ? '?[参数已隐藏]' : ''}`; } catch { return '[链接已隐藏]'; } })
    .replace(/\b[A-Za-z]:[\\/][^\s<>"']+|(?:^|\s)\/(?:[^\s/]+\/)+[^\s<>"']*/g, ' [路径已隐藏]')
    .replace(/\b[a-f0-9]{40,64}\b/gi, '[散列已隐藏]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

/** Facts plus bounded, redacted public Worker reports from the official surface. */
export function createExecutionSummaryInput(input = {}, { maxInputCharacters = 8000 } = {}) {
  const facts = input.facts || input;
  const ticketId = identity(input.ticketId), runId = identity(input.runId);
  const instructionRevision = count(input.instructionRevision), watermark = count(input.watermark ?? facts.cursor);
  const projections = (facts.projections || []).filter(row => row.ticketId === ticketId && (!runId || row.runId === runId) && (!instructionRevision || row.instructionRevision === instructionRevision));
  const entries = (facts.entries || []).filter(row => row.ticketId === ticketId && (!runId || row.runId === runId) && (!instructionRevision || row.instructionRevision === instructionRevision) && count(row.seq) <= watermark && kinds.has(row.kind)).slice(-80);
  const events = new Map(), refs = new Set();
  for (const row of entries) {
    events.set(row.kind, (events.get(row.kind) || 0) + 1);
    for (const ref of (row.data?.evidenceRefs || []).slice(0, 4)) {
      if (identity(ref.sessionId) && Number.isSafeInteger(ref.seq) && ref.seq >= 0) refs.add(`${ref.sessionId}:${ref.seq}`);
    }
  }
  const latest = projections.find(row => row.sessionId === facts.runtime?.run?.sessionId)
    || projections.find(row => !row.parentSessionId) || projections.at(-1), state = latest?.state;
  const progressReports = (input.progressReports || []).slice(-8).filter(row => typeof row?.evidenceRef === 'string'
    && projections.some(source => row.evidenceRef.startsWith(`${source.sessionId}:`)
      && Number.isSafeInteger(Number(row.evidenceRef.slice(source.sessionId.length + 1)))
      && Number(row.evidenceRef.slice(source.sessionId.length + 1)) >= (source.state?.inheritedEventCount || 0)
      && Number(row.evidenceRef.slice(source.sessionId.length + 1)) <= source.cursor))
    .map(row => ({ text: redactExecutionText(row.text, 1200), evidenceRef: row.evidenceRef })).filter(row => row.text);
  // Keep every supplied report citeable even when its ref already appeared
  // near the beginning of a busy event window.
  for (const report of progressReports) { refs.delete(report.evidenceRef); refs.add(report.evidenceRef); }
  const status = input.status ?? facts.runtime?.ticket?.status ?? state?.status;
  const control = input.executionControl ?? facts.runtime?.ticket?.executionControl ?? {};
  const result = {
    binding: { ticketId, runId, instructionRevision, watermark, fence: count(facts.runtime?.assignment?.fence) },
    target: redactExecutionText(input.target, 800),
    acceptance: (Array.isArray(input.acceptance) ? input.acceptance : [input.acceptance]).slice(0, 8).map(value => redactExecutionText(value, 240)).filter(Boolean),
    status: statuses.has(status) ? status : 'unknown', activity: activities.has(state?.activity) ? state.activity : 'unknown',
    executionControl: Object.fromEntries(['pauseRequested', 'paused', 'stopRequested', 'stopped'].map(key => [key, control[key] === true])),
    counts: { calls: count(state?.tools?.calls), results: count(state?.tools?.results), errors: count(state?.tools?.errors) },
    countsScope: 'session', events: [...events].map(([kind, count]) => ({ kind, count })),
    progressReports,
    evidenceRefs: [...refs].slice(-24),
    evidenceComplete: projections.length > 0 && projections.every(row => row.complete === true),
    previousSummary: redactExecutionText(input.previousSummary, 80),
  };
  // Counts show activity only. No raw tool names, arguments, results or reasoning are accepted.
  return boundInput(result, maxInputCharacters);
}

export function deterministicExecutionSummary(input) {
  const ticket = input.facts?.runtime?.ticket ?? input.runtime?.ticket ?? {};
  const status = input.status ?? ticket.status;
  const control = input.executionControl ?? ticket.executionControl ?? {};
  if (status === 'completed') return '任务执行已完成';
  if (control.stopped) return '执行已停止';
  if (control.stopRequested) return '已请求停止，等待执行端确认';
  if (control.paused) return '任务已暂停，等待恢复';
  if (control.pauseRequested) return '已请求暂停，等待执行端确认';
  if ((input.continuationWait ?? ticket.continuationWait)?.code === 'EXECUTION_FAILED') return '执行失败，等待调整或重试';
  if (typeof input.progress === 'string' && input.progress.trim()) return redactExecutionText(executionStatusText(input.progress), 80);
  const labels = { waiting: '正在等待所需答复或条件', running: '正在处理' };
  return labels[status] || '正在处理';
}
