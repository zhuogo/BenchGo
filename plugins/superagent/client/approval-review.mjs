export function sameReviewOrigin(a, b) {
  if (a?.kind !== b?.kind) return false;
  if (a?.kind === 'worker') return ['taskId', 'assignmentId', 'runId', 'sessionId', 'ownerSessionId', 'ownerThreadId'].every(key => a[key] && a[key] === b[key]);
  return a?.kind === 'router' && ['sessionId', 'ownerSessionId', 'ownerThreadId'].every(key => a[key] && a[key] === b[key]);
}

/** Only a human decision settles the original official PendingApproval. */
export function reviewApprovalResponse({ pending, origin, readOrigins, isCurrent = () => true }) {
  let busy = false, settled = false;
  const canAnswer = () => !busy && !settled && isCurrent() && pending.answerable === true;
  return { canAnswer, async answer(outcome) {
    if (!['allowed-once', 'rejected'].includes(outcome)) throw new Error('此动作只允许本次批准或拒绝');
    if (!canAnswer()) throw new Error('审批已失效或正在提交');
    busy = true;
    try {
      const origins = await readOrigins();
      if (!isCurrent() || !pending.answerable || !origins.some(value => sameReviewOrigin(origin, value))) throw new Error('审批来源已失效，请刷新审核列表');
      await pending.answer(outcome); settled = true;
    } finally { busy = false; }
  } };
}

/** Format only BenchGo's own frozen-action reason; this never grants authority. */
export function reviewActionDetails(pending) {
  const reason = pending?.reason;
  if (pending?.toolName !== 'assistant_external_action' || typeof reason !== 'string'
    || !reason.startsWith('批准本次具体外部动作（仅本次有效）：\n')) return null;
  try {
    const value = JSON.parse(reason.slice(reason.indexOf('\n') + 1));
    if (!value || typeof value !== 'object' || !value.target || !value.content) return null;
    return reviewDisplayValue({ category: value.category, origin: value.origin, target: value.target, content: value.content });
  } catch { return null; }
}

/** Display-only redaction; the official request and its frozen action stay untouched. */
export function reviewDisplayText(value = '') {
  return String(value)
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gu, '[凭据已隐藏]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/=_\-.]+/giu, '$1 [凭据已隐藏]')
    .replace(/((?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization|cookie|密码|密钥)\s*[=:：]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}\]]+)/giu, '$1[凭据已隐藏]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu, '$1[凭据已隐藏]@');
}

export function reviewDisplayValue(value) {
  if (typeof value === 'string') return reviewDisplayText(value);
  if (Array.isArray(value)) return value.map(reviewDisplayValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
    /^(?:password|passwd|secret|credential|credentials|token|apikey|accesstoken|refreshtoken|clientsecret|privatekey|authorization|cookie|setcookie|密码|密钥)$/iu.test(key.replace(/[_\-\s]/gu, ''))
      ? '[凭据已隐藏]' : reviewDisplayValue(entry)]));
}

export function reviewRequestKey(origin, pending) { return `${origin.kind}:${origin.sessionId}:${pending.key}`; }

/** Preserve the reported cause chain without replacing it with an empty state. */
export function reviewConnectionError(cause) {
  const messages = [], seen = new Set();
  for (let current = cause; current != null && !seen.has(current); current = current?.cause) {
    seen.add(current);
    const message = reviewDisplayText(typeof current?.message === 'string' ? current.message : String(current));
    if (!messages.includes(message)) messages.push(message);
  }
  return messages.join('；原因：');
}

/** Official ready settles an opening attempt, including an unsuccessful one. */
export function reviewSessionOpenError(reference) {
  const state = reference.binding.session.getSnapshot();
  return state.openState === 'open' ? '' : reviewConnectionError(state.openError ?? new Error(`会话尚未打开（${state.openState}）`));
}

/** The host binding identifies a reminder; never compare its durable id to PendingApproval.key. */
export function reviewReminderMatches(row, entry) {
  const binding = row?.approval, { origin, pending } = entry || {};
  if (row?.role !== 'assistant' || !row.requestId || !binding || !origin || !pending?.answerable) return false;
  if (!binding.approvalId || binding.eventKey !== `approval:${binding.sessionId}:${binding.approvalId}`) return false;
  if (!pending.callId || binding.callId !== pending.callId || binding.sessionId !== pending.sessionId
    || binding.sessionId !== origin.sessionId || binding.ownerThreadId !== origin.ownerThreadId) return false;
  if (origin.kind === 'worker' && !['taskId', 'assignmentId', 'runId'].every(key => origin[key] && binding[key] === origin[key])) return false;
  if (pending.toolName !== 'assistant_external_action') return false;
  try {
    const reason = pending.reason;
    if (!reason?.startsWith('批准本次具体外部动作（仅本次有效）：\n')) return false;
    const action = JSON.parse(reason.slice(reason.indexOf('\n') + 1));
    return !!binding.actionId && action.actionId === binding.actionId;
  } catch { return false; }
}

/** Read the existing publication history without creating or changing any approval. */
export async function findReviewReminder(api, entry) {
  let before;
  const seen = new Set();
  for (let page = 0; page < 20; page++) {
    const history = await api('history', { threadId: entry.origin.ownerThreadId, ...(before == null ? {} : { before }) });
    const row = (history.messages || []).find(value => reviewReminderMatches(value, entry));
    if (row) return row;
    if (!history.hasMore || history.nextBefore == null || seen.has(history.nextBefore)) break;
    before = history.nextBefore; seen.add(before);
  }
  throw new Error('暂未找到这次审批对应的对话提醒，请稍后重试。');
}
