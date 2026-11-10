import { channelSourceAllowed } from './channel-policy.mjs';
import { isScheduledTrigger } from './schedule-bridge.mjs';
/** Exposed only by the authenticated human HTTP action dispatcher, never as a model tool. */
export function createEvaluationDisposition({ database, readPolicy, wake = () => {} }) {
  return {
    list: input => database.unavailableEvaluations(input),
    history: candidateId => ({ events: database.evaluationDispositionHistory(candidateId) }),
    async dispose(input, authority) {
      if (authority?.kind !== 'human') throw new Error('评估人工处置仅供已认证用户操作');
      const candidate = database.getEvaluation(input.candidateId);
      if (!candidate) throw Object.assign(new Error('候选不存在'), { code: 'CANDIDATE_NOT_FOUND' });
      const policy = await readPolicy(candidate.threadId);
      if (input.action === 'retry' && !policy.model) throw new Error('请先配置 Router 模型再重评');
      if (input.action === 'retry') {
        const trigger = database.readIntakeEvent(candidate.triggerId), source = trigger?.source;
        const row = policy.connections?.[source?.channel];
        const config = source?.channel === 'feishu' ? policy.connection : row?.config;
        const currentScope = isScheduledTrigger(trigger) || ['direct', 'group', 'topic', 'system'].includes(source?.sourceType) && channelSourceAllowed(config, source, row);
        if (!currentScope) throw new Error('来源证据已过期或范围已撤销，请重新收取消息');
      }
      const result = database.disposeUnavailableEvaluation(input.candidateId, {
        action: input.action, expectedRevision: input.expectedRevision, expectedUpdatedAt: input.expectedUpdatedAt,
        reason: input.reason, policyVersion: policy.version, actor: authority.actorId || 'desktop-owner',
      });
      if (input.action === 'retry') wake();
      return result;
    },
  };
}
