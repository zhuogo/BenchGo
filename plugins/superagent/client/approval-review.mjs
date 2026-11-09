export function sameReviewOrigin(a, b) {
  if (a?.kind !== b?.kind) return false;
  if (a?.kind === 'worker') return ['ticketId', 'assignmentId', 'runId', 'sessionId', 'ownerSessionId', 'ownerThreadId'].every(key => a[key] && a[key] === b[key]);
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
    return { category: value.category, origin: value.origin, target: value.target, content: value.content };
  } catch { return null; }
}

export function reviewRequestKey(origin, pending) { return `${origin.kind}:${origin.sessionId}:${pending.key}`; }
