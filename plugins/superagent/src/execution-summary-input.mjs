const kinds = new Set(['turn/start', 'turn/end', 'step/start', 'step/end', 'tool/call', 'tool/result', 'assistant/message', 'assistant/attempt', 'subagent/catalog', 'subagent/returned', 'execution', 'recovery-unavailable', 'ticket', 'assignment', 'run', 'result', 'delivery', 'attention', 'input', 'requirements', 'goal']);
const statuses = new Set(['queued', 'pending', 'running', 'active', 'waiting', 'blocked', 'pausing', 'paused', 'stopping', 'stopped', 'cancelled', 'completed', 'failed', 'uncertain', 'delivering', 'ready', 'assigned', 'succeeded']);
const activities = new Set(['idle', 'running', 'thinking', 'tool', 'working', 'waiting', 'blocked', 'paused', 'stopping', 'stopped', 'completed', 'failed', 'unknown']);
const count = value => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1_000_000_000) : 0;
const identity = value => typeof value === 'string' && value.length <= 512 ? value : '';

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
    .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

/** The source is executionFacts.evidence(), never snapshot rows or a transcript. */
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
  const latest = projections.at(-1), state = latest?.state;
  const status = input.status ?? facts.runtime?.ticket?.status ?? state?.status;
  const result = {
    binding: { ticketId, runId, instructionRevision, watermark },
    target: redactExecutionText(input.target, 800),
    acceptance: (Array.isArray(input.acceptance) ? input.acceptance : [input.acceptance]).slice(0, 8).map(value => redactExecutionText(value, 240)).filter(Boolean),
    status: statuses.has(status) ? status : 'unknown', activity: activities.has(state?.activity) ? state.activity : 'unknown',
    counts: { calls: count(state?.tools?.calls), results: count(state?.tools?.results), errors: count(state?.tools?.errors) },
    countsScope: 'session', events: [...events].map(([kind, count]) => ({ kind, count })),
    evidenceRefs: [...refs].slice(-24), outputChanges: [], outputObservation: 'unknown',
    evidenceComplete: projections.length > 0 && projections.every(row => row.complete === true),
    previousSummary: redactExecutionText(input.previousSummary, 80),
  };
  // Counts show activity only. No raw tool names, arguments, results or reasoning are accepted.
  const limit = Math.max(1024, Math.min(32000, Number(maxInputCharacters) || 8000));
  while (JSON.stringify(result).length > limit && result.evidenceRefs.length) result.evidenceRefs.shift();
  while (JSON.stringify(result).length > limit && result.acceptance.length) result.acceptance.pop();
  if (JSON.stringify(result).length > limit) result.target = result.target.slice(0, 120);
  while (JSON.stringify(result).length > limit && result.events.length) result.events.shift();
  if (JSON.stringify(result).length > limit) throw Object.assign(new Error('辅助输入超过上限'), { code: 'AUXILIARY_INPUT_LIMIT' });
  return result;
}

export function deterministicExecutionSummary(input) {
  const status = input.status ?? input.facts?.runtime?.ticket?.status ?? input.runtime?.ticket?.status;
  const labels = { queued: '已接单，等待开始处理', pending: '已接单，等待开始处理', assigned: '已安排处理，等待执行反馈', waiting: '正在等待所需答复或条件', blocked: '处理受阻，等待解决卡点', pausing: '已请求暂停，等待执行端确认', paused: '任务已暂停，等待恢复', stopping: '已请求停止，等待执行端确认', stopped: '执行已停止', cancelled: '任务已取消', completed: '任务已完成并交付', failed: '任务未完成，已记录失败情况', delivering: '成果已保存，等待交付', uncertain: '执行状态待核实' };
  return labels[status] || '正在处理，尚无可确认的新进展';
}
