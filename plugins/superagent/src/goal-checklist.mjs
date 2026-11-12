import { createHash, randomUUID } from 'node:crypto';
import { rejectModelOverride } from './work-role-policy.mjs';

const objectiveText = value => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 2000) throw new Error('目标须为 1 至 2000 字');
  return value.trim();
};

/** The user's persistent goal checklist: one sentence and a done flag. It never dispatches work. */
export function createGoalChecklist({ database }) {
  if (!database?.insertGoal) throw new Error('Goal checklist database is required');
  const visible = goal => goal && !goal.deleted ? goal : null;
  return {
    createGoal(input = {}) {
      rejectModelOverride(input);
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['objective', 'requestId', 'ownerSessionId', 'threadId'].includes(key))) throw new Error('清单目标只需要目标文字');
      const objective = objectiveText(input.objective);
      if (typeof input.requestId !== 'string' || !input.requestId.trim() || input.requestId.length > 2048) throw new Error('目标请求标识无效');
      return database.transaction(() => {
        const previous = database.goalByRequest(input.requestId);
        const inputFingerprint = createHash('sha256').update(JSON.stringify(['checklist', objective])).digest('hex');
        if (previous) {
          if (previous.inputFingerprint !== inputFingerprint) throw Object.assign(new Error('目标请求标识已用于不同内容'), { code: 'IDEMPOTENCY_CONFLICT' });
          return previous;
        }
        return database.insertGoal({ id: randomUUID(), requestId: input.requestId, inputFingerprint, objective, title: objective,
          status: 'active', ownerSessionId: input.ownerSessionId || null, threadId: input.threadId || 'main' });
      });
    },
    goals: () => database.goals().filter(goal => !goal.deleted),
    getGoal: id => visible(database.goal(id)),
    updateGoal(id, patch = {}, options) {
      const goal = visible(database.goal(id));
      if (!goal) throw new Error('目标不存在');
      if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length || Object.keys(patch).some(key => !['objective', 'status', 'deleted'].includes(key))) throw new Error('目标只允许编辑文字、完成或删除');
      if (!Number.isSafeInteger(options?.rowVersion) || options.rowVersion < 1) throw new Error('修改目标需要当前 rowVersion');
      if (patch.status !== undefined && !['active', 'completed'].includes(patch.status)) throw new Error('目标状态仅支持未完成或已完成');
      if (patch.deleted !== undefined && patch.deleted !== true) throw new Error('无效目标删除操作');
      const next = { ...patch };
      if (patch.objective !== undefined) next.title = next.objective = objectiveText(patch.objective);
      if (patch.status !== undefined) next.completedAt = patch.status === 'completed' ? goal.completedAt || new Date().toISOString() : null;
      if (patch.deleted) next.deletedAt = new Date().toISOString();
      return database.updateGoal(id, next, options);
    },
  };
}
