import { createHash } from 'node:crypto';
import { rejectModelOverride } from './work-role-policy.mjs';

/** Host-only composition: approved live owner -> durable Tickets -> Goal aggregate. */
export async function createGoalTickets({ goal, exec, ownerAgent, threadId, delegation, scheduler, ctx, database }) {
  // Capture the entire submitted tree before the first asynchronous validation.
  goal = structuredClone(goal);
  if (!ownerAgent || exec.agent !== ownerAgent) throw new Error('目标缺少所属主助手会话');
  if (typeof goal?.requestId !== 'string' || !goal.requestId.trim()) throw new Error('目标缺少稳定请求标识');
  // A leaf's own complete instruction is the compatibility criterion when an
  // older caller omits acceptance. Normalize before matching/reserving so the
  // Goal and its Ticket share an exact contract on every idempotent retry.
  // Never substitute the root owner's entire message for an individual leaf.
  const normalized = new Set();
  const normalize = node => {
    if (!node || typeof node !== 'object' || normalized.has(node) || normalized.size >= 100) throw new Error('目标树无效或超过100项');
    rejectModelOverride(node);
    normalized.add(node);
    if (Array.isArray(node.children) && node.children.length) node.children.forEach(normalize);
    else if ((node.acceptance == null || (typeof node.acceptance === 'string' && !node.acceptance.trim())) && typeof node.text === 'string') node.acceptance = node.text;
  };
  normalize(goal);
  const existing = scheduler.matchGoalRequest(goal);
  if (existing && existing.nextStep !== 'building_children') return existing;
  const seen = new Set();
  const requestIds = new Set();
  const validate = async (node, requestId) => {
    if (!node || typeof node !== 'object' || seen.has(node) || seen.size >= 100) throw new Error('目标树无效或超过100项');
    seen.add(node);
    if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 2048 || requestIds.has(requestId)) throw new Error('目标树请求标识无效或重复');
    requestIds.add(requestId);
    if (typeof node.objective !== 'string' || !node.objective.trim()) throw new Error('目标缺少 objective');
    if (node.scope != null) throw new Error('工单目标尚不支持旧式 scope，请明确执行要求');
    if (node.budget != null) throw new Error('目标预算已移除，目标只记录用量，不设额度');
    if (node.acceptance != null && (typeof node.acceptance !== 'string' || node.acceptance.length > 100000)) throw new Error('验收条件必须为不超过100000字符的原文');
    if (node.children !== undefined && !Array.isArray(node.children)) throw new Error('目标 children 必须为数组');
    if (node.children?.length) {
      for (let index = 0; index < node.children.length; index++) await validate(node.children[index], node.children[index]?.requestId || `${requestId}:child:${index}`);
      return;
    }
    for (const key of ['projectId', 'text']) if (typeof node[key] !== 'string' || !node[key].trim() || node[key].length > 100000) throw new Error(`目标 ${key} 无效或超过长度限制`);
    if (!ctx.workspaceRegistry.list().some(project => project.id === node.projectId)) throw new Error('目标项目不存在');
  };
  await validate(goal, goal.requestId);
  scheduler.reserveGoalRequest(goal);
  // Every Goal node owns a usage ledger shared with its descendants; it records, never limits.
  const budgetIds = new Map();
  if (database?.ensureGoalBudget) {
    const prepare = (node, path = 'root', parentGoalId = null) => {
      const goalId = createHash('sha256').update(JSON.stringify(['goal-budget', ownerAgent.id, goal.requestId, path])).digest('hex');
      database.ensureGoalBudget({ goalId, parentGoalId });
      budgetIds.set(node, goalId);
      node.children?.forEach((child, index) => prepare(child, `${path}:${index}`, goalId));
    };
    prepare(goal);
  }
  const bind = async (node, path = 'root') => {
    const budgetGoalId = budgetIds.get(node);
    if (node.children?.length) {
      const children = [];
      for (let index = 0; index < node.children.length; index++) children.push(await bind(node.children[index], `${path}:${index}`));
      return { children, ...(budgetGoalId ? { budgetGoalId } : {}) };
    }
    const requestId = createHash('sha256').update(JSON.stringify(['goal-ticket', goal.requestId, path])).digest('hex');
    const ticket = await delegation.delegate({ projectId: node.projectId,
      text: node.text, acceptance: node.acceptance || '', requestId }, exec, { ownerAgent, threadId, goalLeaf: path, ...(budgetGoalId ? { budgetGoalId } : {}) });
    if (budgetGoalId && database.ticketGoalBudget(ticket.id)?.goalId !== budgetGoalId) throw new Error('目标工单未原子绑定用量账本');
    return { ticketId: ticket.id, ...(budgetGoalId ? { budgetGoalId } : {}) };
  };
  const binding = await bind(goal);
  return scheduler.createGoal(goal, binding);
}
