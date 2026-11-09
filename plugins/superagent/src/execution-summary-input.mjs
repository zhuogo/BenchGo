const kinds = new Set(['turn/start', 'turn/end', 'step/start', 'step/end', 'tool/call', 'tool/result', 'assistant/message', 'assistant/attempt', 'subagent/catalog', 'subagent/returned', 'subagent/start', 'subagent/end', 'execution', 'recovery-unavailable', 'ticket', 'assignment', 'run', 'result', 'delivery', 'attention', 'input', 'requirements', 'goal', 'artifact-observation']);
const statuses = new Set(['queued', 'pending', 'running', 'active', 'waiting', 'blocked', 'pausing', 'paused', 'stopping', 'stopped', 'cancelled', 'completed', 'failed', 'uncertain', 'delivering', 'ready', 'assigned', 'succeeded']);
const activities = new Set(['idle', 'running', 'thinking', 'tool', 'working', 'waiting', 'blocked', 'paused', 'stopping', 'stopped', 'completed', 'failed', 'unknown']);
const count = value => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1_000_000_000) : 0;
const identity = value => typeof value === 'string' && value.length <= 512 ? value : '';
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : NaN;
const validCount = value => Number.isSafeInteger(value) && value >= 0;
const comparisonKeys = ['beforeFiles', 'afterFiles', 'added', 'modified', 'deleted', 'unchanged'];

// This describes only completed protected file snapshots. It never claims to
// observe conversation deliverables, external effects, or unprotected files.
function outputObservation(entries, runtime, observedAt, watermark, fence) {
  const metadata = runtime?.artifactCoverage;
  if (metadata?.known !== true || metadata.complete !== true || metadata.pending || metadata.failed || metadata.restored) return 'unknown';
  const rows = entries.filter(row => row.kind === 'artifact-observation');
  if (!rows.length || !Number.isFinite(time(observedAt))) return 'unknown';
  const observations = [];
  for (const row of rows) {
    const data = row.data, coverage = data?.coverage, comparison = data?.comparison;
    if (row.fence !== fence || !validCount(row.seq) || row.seq > watermark || !validCount(data?.sequence)
      || coverage?.kind !== 'protected-workspace-files' || coverage.complete !== true || coverage.truncated !== false || coverage.exclusionsVersion !== 1
      || !comparisonKeys.every(key => validCount(comparison?.[key])) || typeof comparison.netChanged !== 'boolean'
      || comparison.netChanged !== (comparison.added + comparison.modified + comparison.deleted > 0)
      || comparison.beforeFiles !== comparison.deleted + comparison.modified + comparison.unchanged
      || comparison.afterFiles !== comparison.added + comparison.modified + comparison.unchanged
      || !Number.isFinite(time(data.startedAt)) || !Number.isFinite(time(data.completedAt))
      || time(data.startedAt) > time(data.completedAt) || time(data.completedAt) > time(observedAt)) return 'unknown';
    const prior = observations.at(-1);
    if (prior && (data.sequence !== prior.sequence + 1 || time(data.startedAt) < time(prior.times.completedAt))) return 'unknown';
    observations.push({ sequence: data.sequence, evidenceRef: `execution:${row.seq}`,
      times: { startedAt: new Date(data.startedAt).toISOString(), completedAt: new Date(data.completedAt).toISOString() },
      comparison: Object.fromEntries([...comparisonKeys, 'netChanged'].map(key => [key, comparison[key]])) });
  }
  const last = observations.at(-1);
  if (last.sequence !== metadata.lastSequence || time(observedAt) - time(last.times.completedAt) > 120_000) return 'unknown';
  const recent = observations.slice(-12), totals = { added: 0, modified: 0, deleted: 0 };
  for (const row of recent) for (const key of Object.keys(totals)) totals[key] += row.comparison[key];
  return { coverage: { kind: 'protected-workspace-files', complete: true, truncated: false, exclusionsVersion: 1,
    externalEffects: 'not-observed', conversationOutputs: 'not-observed' },
    comparison: { ...totals, netChanged: recent.some(row => row.comparison.netChanged) },
    times: { startedAt: recent[0].times.startedAt, completedAt: last.times.completedAt },
    observations: recent };
}

/** Re-allowlist a host-produced model projection received over the signed route. */
function remoteInput(input, maxInputCharacters) {
  const source = input.modelEvidence;
  if (source?.binding?.ticketId !== input.ticketId || source.binding.runId !== input.runId
    || source.binding.instructionRevision !== input.instructionRevision || source.binding.watermark !== input.watermark) throw new Error('Model evidence binding changed');
  // Reuse the same observation validator rather than forwarding remote fields.
  const observation = source.outputObservation;
  const entries = (observation?.observations || []).map(row => ({ seq: Number(String(row.evidenceRef).replace(/^execution:/, '')),
    fence: source.binding.fence, kind: 'artifact-observation', data: { sequence: row.sequence, ...row.times,
      coverage: observation.coverage, comparison: row.comparison } }));
  const safe = { binding: { ticketId: identity(input.ticketId), runId: identity(input.runId), instructionRevision: count(input.instructionRevision),
      watermark: count(input.watermark), fence: count(source.binding.fence) }, target: redactExecutionText(source.target, 800),
    acceptance: (Array.isArray(source.acceptance) ? source.acceptance : []).slice(0, 8).map(value => redactExecutionText(value, 240)).filter(Boolean),
    status: statuses.has(source.status) ? source.status : 'unknown', activity: activities.has(source.activity) ? source.activity : 'unknown',
    counts: { calls: count(source.counts?.calls), results: count(source.counts?.results), errors: count(source.counts?.errors) }, countsScope: 'session',
    events: (Array.isArray(source.events) ? source.events : []).filter(row => kinds.has(row?.kind)).slice(-32).map(row => ({ kind: row.kind, count: count(row.count) })),
    evidenceRefs: (Array.isArray(source.evidenceRefs) ? source.evidenceRefs : []).filter(ref => identity(ref) && !/[\u0000-\u001f\u007f]/.test(ref)).slice(-24),
    outputChanges: [], outputObservation: outputObservation(entries, { artifactCoverage: { known: true, complete: true,
      lastSequence: entries.at(-1)?.data.sequence } }, input.observedAt, input.watermark, source.binding.fence),
    evidenceComplete: source.evidenceComplete === true, previousSummary: redactExecutionText(source.previousSummary, 80) };
  return boundInput(safe, maxInputCharacters);
}

function boundInput(result, maxInputCharacters) {
  const limit = Math.max(1024, Math.min(32000, Number(maxInputCharacters) || 8000));
  while (JSON.stringify(result).length > limit && result.evidenceRefs.length) result.evidenceRefs.shift();
  while (JSON.stringify(result).length > limit && result.acceptance.length) result.acceptance.pop();
  if (JSON.stringify(result).length > limit) result.target = result.target.slice(0, 120);
  while (JSON.stringify(result).length > limit && result.events.length) result.events.shift();
  if (JSON.stringify(result).length > limit) throw Object.assign(new Error('辅助输入超过上限'), { code: 'AUXILIARY_INPUT_LIMIT' });
  return result;
}

/** A candidate is observed unchanged protected files, never a task failure. */
export function zeroFileChangeWindow(input, minimumMs = 120_000) {
  const observation = input?.outputObservation;
  if (!observation || observation === 'unknown' || observation.coverage?.complete !== true) return null;
  const rows = observation.observations || [];
  let first = rows.length;
  while (first > 0 && rows[first - 1].comparison?.netChanged === false) first--;
  const unchanged = rows.slice(first);
  if (unchanged.length < 2 || time(unchanged.at(-1).times.completedAt) - time(unchanged[0].times.startedAt) < minimumMs) return null;
  return { startedAt: unchanged[0].times.startedAt, completedAt: unchanged.at(-1).times.completedAt,
    evidenceRefs: unchanged.map(row => row.evidenceRef) };
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

/** The source is executionFacts.evidence(), never snapshot rows or a transcript. */
export function createExecutionSummaryInput(input = {}, { maxInputCharacters = 8000 } = {}) {
  if (input.modelEvidence) return remoteInput(input, maxInputCharacters);
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
    binding: { ticketId, runId, instructionRevision, watermark, fence: count(facts.runtime?.assignment?.fence) },
    target: redactExecutionText(input.target, 800),
    acceptance: (Array.isArray(input.acceptance) ? input.acceptance : [input.acceptance]).slice(0, 8).map(value => redactExecutionText(value, 240)).filter(Boolean),
    status: statuses.has(status) ? status : 'unknown', activity: activities.has(state?.activity) ? state.activity : 'unknown',
    counts: { calls: count(state?.tools?.calls), results: count(state?.tools?.results), errors: count(state?.tools?.errors) },
    countsScope: 'session', events: [...events].map(([kind, count]) => ({ kind, count })),
    evidenceRefs: [...refs].slice(-24), outputChanges: [], outputObservation: outputObservation(entries, facts.runtime, facts.observedAt, watermark, facts.runtime?.assignment?.fence),
    evidenceComplete: projections.length > 0 && projections.every(row => row.complete === true),
    previousSummary: redactExecutionText(input.previousSummary, 80),
  };
  if (result.outputObservation !== 'unknown') result.evidenceRefs = [...new Set([...result.evidenceRefs,
    ...result.outputObservation.observations.map(row => row.evidenceRef)])].slice(-24);
  // Counts show activity only. No raw tool names, arguments, results or reasoning are accepted.
  return boundInput(result, maxInputCharacters);
}

export function deterministicExecutionSummary(input) {
  const status = input.status ?? input.facts?.runtime?.ticket?.status ?? input.runtime?.ticket?.status;
  const labels = { queued: '已接单，等待开始处理', pending: '已接单，等待开始处理', assigned: '已安排处理，等待执行反馈', waiting: '正在等待所需答复或条件', blocked: '处理受阻，等待解决卡点', pausing: '已请求暂停，等待执行端确认', paused: '任务已暂停，等待恢复', stopping: '已请求停止，等待执行端确认', stopped: '执行已停止', cancelled: '任务已取消', completed: '任务已完成并交付', failed: '任务未完成，已记录失败情况', delivering: '成果已保存，等待交付', uncertain: '执行状态待核实' };
  return labels[status] || '正在处理，尚无可确认的新进展';
}
