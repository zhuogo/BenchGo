export function sameExecutionApprovalOrigin(a, b) {
  return ['ticketId', 'assignmentId', 'runId', 'sessionId', 'ownerSessionId', 'ownerThreadId'].every(key => a?.[key] && a[key] === b?.[key]);
}

/** One click settles the original PendingApproval; no persistent choice or second request. */
export function executionApprovalResponse({ pending, origin, readOrigins, isCurrent = () => true }) {
  let busy = false, settled = false;
  const canAnswer = () => !busy && !settled && isCurrent() && pending.answerable === true;
  return {
    canAnswer,
    async answer(outcome) {
      if (!['allowed-once', 'rejected'].includes(outcome)) throw new Error('此动作只允许本次批准或拒绝');
      if (!canAnswer()) throw new Error('审批已失效或正在提交');
      busy = true;
      try {
        const origins = await readOrigins();
        if (!isCurrent() || !pending.answerable || !origins.some(value => sameExecutionApprovalOrigin(origin, value))) throw new Error('工单已停止、授权已变化或审批来源已失效');
        await pending.answer(outcome);
        settled = true;
      } finally { busy = false; }
    },
  };
}
