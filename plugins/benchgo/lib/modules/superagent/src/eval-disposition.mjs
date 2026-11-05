/** Exposed only by the authenticated human HTTP action dispatcher, never as a model tool. */
export function createEvaluationDisposition({ database, readPolicy, wake = () => {} }) {
  return {
    list: input => database.unavailableEvaluations(input),
    history: candidateId => ({ events: database.evaluationDispositionHistory(candidateId) }),
    async dispose(input, authority) {
      if (authority?.kind !== 'human') throw new Error('评估人工处置仅供已认证用户操作');
      const policy = await readPolicy();
      if (input.action === 'retry' && !policy.model) throw new Error('请先配置 Router 模型再重评');
      const result = database.disposeUnavailableEvaluation(input.candidateId, {
        action: input.action, expectedRevision: input.expectedRevision, expectedUpdatedAt: input.expectedUpdatedAt,
        reason: input.reason, policyVersion: policy.version, actor: authority.actorId || 'desktop-owner',
      });
      if (input.action === 'retry') wake();
      return result;
    },
  };
}
