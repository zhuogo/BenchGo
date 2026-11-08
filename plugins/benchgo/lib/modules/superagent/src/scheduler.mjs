import { createHash, randomUUID } from 'node:crypto';
import { createAssistantRuntimeStore } from './runtime-store.mjs';
import { ticketGoalRecord, assertGoalTicketBinding } from './goal-ticket-record.mjs';

const TERMINAL_GOAL = new Set(['completed', 'failed', 'cancelled']);

const iso = value => new Date(value).toISOString();
const asObject = value => value && typeof value === 'object' ? value : {};
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const creation = input => ({ objective: input.objective, title: input.title || String(input.objective).slice(0, 120),
  acceptance: input.acceptance || null, scope: input.scope || null, budget: input.budget || null,
  projectId: input.projectId ?? null, provider: input.provider ?? null, model: input.model ?? null, text: input.text ?? null,
  threadId: input.threadId || 'main', ownerSessionId: input.ownerSessionId ?? null,
  children: (input.children || []).map(child => ({ ...creation({ ...child, threadId: child.threadId || input.threadId, ownerSessionId: input.ownerSessionId }), requestId: child.requestId ?? null })) });
const fingerprint = input => createHash('sha256').update(JSON.stringify(canonical(creation(input)))).digest('hex');

export function createAssistantScheduler({ store, database, owner = `scheduler-${randomUUID()}` } = {}) {
  if (!store?.paths?.database) throw new Error('Scheduler database is required');
  const db = database || createAssistantRuntimeStore({ filename: store.paths.database });
  const ownsDb = !database;
  let closed = false;
  let activeTick = null;
  const scheduleQueue = new Map();
  const serialize = (key, operation) => {
    const previous = scheduleQueue.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    scheduleQueue.set(key, current);
    return current.finally(() => { if (scheduleQueue.get(key) === current) scheduleQueue.delete(key); });
  };
  const taskDelivered = task => task.status === 'completed' && task.result?.outcome === 'completed'
    && (task.instructionRevision === undefined || task.result.instructionRevision === task.instructionRevision);
  function validateGoal(input, seen = new Set()) {
    if (!input || typeof input !== 'object' || seen.has(input) || seen.size >= 100) throw new Error('目标树无效或超过100项');
    seen.add(input);
    const children = Array.isArray(input?.children) ? input.children : [];
    if (!input?.objective || (!children.length && (!input.projectId || !input.provider || !input.text))) throw new Error('目标缺少 objective、projectId、provider 或 text');
    for (const child of children) validateGoal(child, seen);
  }
  function validateRequests(input, requestId, seen = new Set()) {
    if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 2048 || seen.has(requestId)) throw new Error('目标树请求标识无效或重复');
    seen.add(requestId);
    (input.children || []).forEach((child, index) => validateRequests(child, child.requestId || `${requestId}:child:${index}`, seen));
  }
  async function createGoal(input = {}, ticketBinding) {
    validateGoal(input);
    const children = Array.isArray(input.children) ? input.children : [];
    if (!input.objective || (!children.length && (!input.projectId || !input.provider || !input.text))) throw new Error('目标缺少 objective、projectId、provider 或 text');
    const requestId = input.requestId || randomUUID();
    validateRequests(input, requestId);
    if (!ticketBinding) throw new Error('新目标必须关联已授权工单');
    {
      const validateBinding = (node, binding, parentBudgetId) => {
        if (node.budget != null && !binding?.budgetGoalId) throw new Error('目标缺少原子预算绑定');
        if (binding?.budgetGoalId) {
          const budget = store.orchestration.goalBudget(binding.budgetGoalId);
          if (!budget || (parentBudgetId !== undefined && budget.parentGoalId !== parentBudgetId)) throw new Error('目标预算祖先绑定不一致');
        } else if (parentBudgetId) throw new Error('子目标缺少共享预算绑定');
        if (node.children?.length) {
          if (binding?.children?.length !== node.children.length) throw new Error('目标工单绑定不完整');
          node.children.forEach((child, index) => validateBinding({ ...child, ownerSessionId: input.ownerSessionId }, binding.children[index], binding.budgetGoalId || null));
        } else {
          assertGoalTicketBinding(store.orchestration, binding?.ticketId, node);
          if (binding?.budgetGoalId && store.orchestration.ticketGoalBudget(binding.ticketId)?.goalId !== binding.budgetGoalId) throw new Error('工单预算绑定不一致');
        }
      };
      validateBinding(input, ticketBinding);
    }
    const requestFingerprint = createHash('sha256').update(JSON.stringify([fingerprint(input), canonical(ticketBinding)])).digest('hex');
    return serialize(`goal-request:${requestId}`, async () => {
      const existing = db.goalByRequest(requestId);
      if (existing) {
        if (existing.requestFingerprint !== requestFingerprint || existing.parentGoalId !== (input.parentGoalId || null)) throw Object.assign(new Error('目标请求标识已使用或旧请求内容无法核实，请读取原目标'), { code: 'IDEMPOTENCY_CONFLICT' });
        if (existing.nextStep !== 'building_children') return existing;
      }
      const goal = existing || db.insertGoal({ id: randomUUID(), budgetGoalId: ticketBinding.budgetGoalId || null, requestId, requestFingerprint, inputFingerprint: fingerprint(input), executionKind: 'ticket', ticketIds: ticketBinding.ticketId ? [ticketBinding.ticketId] : [], ticketRevisions: ticketBinding.ticketId ? { [ticketBinding.ticketId]: store.orchestration.getTicket(ticketBinding.ticketId).instructionRevision } : {}, ownerSessionId: input.ownerSessionId || null, status: 'active', title: input.title || String(input.objective).slice(0, 120), objective: input.objective, acceptance: input.acceptance || null, scope: input.scope || null, budget: input.budget || null, projectId: input.projectId, provider: input.provider, model: input.model, text: input.text, threadId: input.threadId || 'main', parentGoalId: input.parentGoalId || null, childGoalIds: [], nextStep: children.length ? 'building_children' : 'verify', createdAt: iso(Date.now()), updatedAt: iso(Date.now()) });

      if (children.length) {
        if (existing) db.updateGoal(goal.id, { status: 'active', error: null, waitReason: null });
        const childGoalIds = [];
        for (const child of children) {
          const childGoal = await createGoal({ ...child, ownerSessionId: goal.ownerSessionId, parentGoalId: goal.id, threadId: child.threadId || goal.threadId, requestId: child.requestId || `${requestId}:child:${childGoalIds.length}` }, ticketBinding?.children?.[childGoalIds.length]);
          childGoalIds.push(childGoal.id);
          db.updateGoal(goal.id, { childGoalIds });
        }
        return db.updateGoal(goal.id, { childGoalIds, nextStep: 'verify' });
      }
      return advanceGoal(goal.id);
    });
  }
  async function advanceGoal(id) {
    return serialize(`goal:${id}`, async () => {
      let goal = db.goal(id); if (!goal) throw new Error('目标不存在');
      if (['cancelling', 'pausing', 'resuming'].includes(goal.status)) return goal;
      if (TERMINAL_GOAL.has(goal.status) || goal.status === 'paused') return goal;
      // A process may stop while a goal tree is being created. Never dispatch
      // the incomplete parent as a leaf or claim its partial children complete.
      if (goal.nextStep === 'building_children' || (goal.nextStep === 'children' && !goal.childGoalIds?.length)) return db.updateGoal(id, { status: 'waiting', waitReason: 'incomplete', error: '目标创建未完成，请重新创建' });
      const childGoals = (goal.childGoalIds || []).map(childId => db.goal(childId)).filter(Boolean);
      if (childGoals.length !== (goal.childGoalIds || []).length) return db.updateGoal(id, { status: 'waiting', waitReason: 'incomplete', nextStep: 'children', error: '子目标记录缺失，无法同步状态' });
      if (childGoals.length) {
        for (const child of childGoals) if (['active', 'waiting'].includes(child.status)) await advanceGoal(child.id);
        const refreshed = (goal.childGoalIds || []).map(childId => db.goal(childId)).filter(Boolean);
        if (refreshed.some(child => child.status === 'failed' || child.status === 'cancelled')) return db.updateGoal(id, { status: 'failed', nextStep: 'awaiting_adjustment', error: '子目标未完成' });
        if (refreshed.length && refreshed.every(child => child.status === 'completed')) return db.updateGoal(id, { status: 'completed', nextStep: null, completedAt: iso(Date.now()) });
        if (refreshed.some(child => child.status === 'waiting' || child.status === 'paused')) return db.updateGoal(id, { status: 'waiting', waitReason: 'children', nextStep: 'children' });
        return db.updateGoal(id, { status: 'active', waitReason: null, nextStep: 'children' });
      }
      const rows = (goal.ticketIds || []).map(ticketId => ticketGoalRecord(store.orchestration, ticketId));
        if (!rows.length || rows.some(row => !row)) return db.updateGoal(id, { status: 'waiting', waitReason: 'incomplete', error: '目标工单记录缺失，禁止重新派发' });
        for (const row of rows) {
          try {
            assertGoalTicketBinding(store.orchestration, row.id, goal);
            if (goal.ticketRevisions?.[row.id] !== row.instructionRevision) throw new Error('工单要求版本已变化或缺少原始版本绑定');
          } catch (error) {
            return db.updateGoal(id, { status: 'waiting', waitReason: 'requirements', nextStep: 'awaiting_adjustment', error: error.message });
          }
        }
        if (rows.some(row => ['failed', 'cancelled'].includes(row.status))) return db.updateGoal(id, { status: 'failed', error: '目标工单失败或已停止', nextStep: 'awaiting_adjustment' });
        if (rows.every(row => row.status === 'completed' && taskDelivered(row))) return db.updateGoal(id, { status: 'completed', nextStep: null, waitReason: null, error: null, completedAt: iso(Date.now()) });
        const waiting = rows.find(row => ['waiting', 'uncertain', 'blocked', 'completed', 'cancelling'].includes(row.status));
      return db.updateGoal(id, { status: waiting ? 'waiting' : 'active', waitReason: waiting ? waiting.waitReason || 'delivery' : null, nextStep: 'verify' });
    });
  }
  async function cancelGoal(id, { rowVersion } = {}) {
    return serialize(`goal:${id}`, async () => {
      let goal = db.goal(id);
      if (!goal) throw new Error('目标不存在');
      if (TERMINAL_GOAL.has(goal.status)) return goal;
      // Persist intent before external cancellation; a restart finishes it instead of dispatching.
      goal = db.updateGoal(id, { status: 'cancelling', nextStep: 'cancel' }, { rowVersion });
      try {
        for (const childId of goal.childGoalIds || []) await cancelGoal(childId);
        let pending = (goal.childGoalIds || []).some(childId => db.goal(childId)?.status === 'cancelling');
        for (const ticketId of goal.ticketIds || []) {
            const ticket = store.orchestration.getTicket(ticketId);
            if (!ticket) throw new Error('目标关联工单缺失，停止状态待核实');
            if (!['completed', 'failed', 'cancelled', 'closed'].includes(ticket.status)) {
              const stopped = store.orchestration.cancelTicket(ticketId);
              if (stopped.status === 'cancelling') pending = true;
            }
          }
        if (pending) return db.updateGoal(id, { status: 'cancelling', nextStep: 'cancel', waitReason: 'cancellation' });
        return db.updateGoal(id, { status: 'cancelled', nextStep: null, waitReason: null, error: null });
      } catch (error) {
        db.updateGoal(id, { error: String(error.message || error), waitReason: 'cancellation' });
        throw error;
      }
    });
  }
  async function changeGoalPause(id, paused, options = {}, title) {
    return serialize(`goal:${id}`, async () => {
      let goal = db.goal(id);
      if (!goal) throw new Error('Goal does not exist');
      if (TERMINAL_GOAL.has(goal.status) || goal.status === 'cancelling') throw new Error('Goal cannot change execution state');
      if (goal.executionKind !== 'ticket') throw new Error('Goal must be associated with a Ticket');
      if (goal.nextStep === 'building_children') throw new Error('Goal creation is incomplete');
      if (!paused && !['paused', 'resuming'].includes(goal.status)) throw new Error('Wait for pause confirmation before resuming');
      if (paused && goal.status === 'paused') return goal;
      goal = db.updateGoal(id, { status: paused ? 'pausing' : 'resuming', ...(title !== undefined ? { title } : {}), waitReason: 'user' }, options);
      let pending = false;
      for (const childId of goal.childGoalIds || []) {
        const child = db.goal(childId);
        if (!child) throw new Error('Child Goal is missing');
        if (TERMINAL_GOAL.has(child.status) || (!paused && ['active', 'waiting'].includes(child.status))) continue;
        const changed = await changeGoalPause(childId, paused);
        if (changed.status === 'pausing') pending = true;
      }
      for (const ticketId of goal.ticketIds || []) {
        const ticket = store.orchestration.getTicket(ticketId);
        if (!ticket) throw new Error('Goal Ticket is missing');
        if (['completed', 'failed', 'cancelled', 'closed'].includes(ticket.status)) continue;
        const changed = paused ? store.orchestration.pauseTicket(ticketId) : store.orchestration.resumeTicket(ticketId);
        if (changed.status !== 'paused' && paused) pending = true;
      }
      return db.updateGoal(id, { status: paused ? pending ? 'pausing' : 'paused' : 'active', waitReason: paused ? 'user' : null, error: null });
    });
  }
  async function tick(at = Date.now()) {
    if (closed) return { acquired: false, goals: [], skipped: true };
    if (activeTick) return activeTick;
    activeTick = (async () => {
    const lease = db.lease(owner, at, 30000); if (!lease) return { acquired: false, goals: [] };
    try {
      const goals = [];
      for (const goal of db.goals()) if (['pausing', 'resuming'].includes(goal.status)) {
        try { goals.push(await changeGoalPause(goal.id, goal.status === 'pausing')); }
        catch (error) { goals.push(db.updateGoal(goal.id, { error: String(error.message || error) })); }
      }
      for (const goal of db.goals()) if (goal.status === 'cancelling') {
        try { goals.push(await cancelGoal(goal.id)); }
        catch { goals.push(db.goal(goal.id)); }
      }
      for (const goal of db.goals()) if (goal.status === 'active' || goal.status === 'waiting') {
        try { goals.push(await advanceGoal(goal.id)); }
        catch (error) { goals.push(db.updateGoal(goal.id, { status: 'waiting', waitReason: 'error', error: String(error.message || error) })); }
      }
      return { acquired: true, goals };
    } finally { db.releaseLease(owner); }
    })();
    try { return await activeTick; } finally { activeTick = null; }
  }
  const api = {
    createGoal, advanceGoal, cancelGoal,
    getGoalBudget(id) {
      const goal = db.goal(id);
      if (!goal) throw new Error('目标不存在');
      return goal.budgetGoalId ? store.orchestration?.goalBudget(goal.budgetGoalId) || null : null;
    },

    matchGoalRequest(input) {
      const goal = db.goalByRequest(input.requestId);
      if (goal && (goal.inputFingerprint !== fingerprint(input) || goal.parentGoalId !== (input.parentGoalId || null))) throw Object.assign(new Error('目标请求标识已用于不同内容或历史请求无法核实'), { code: 'IDEMPOTENCY_CONFLICT' });
      return goal;
    },
    reserveGoalRequest(input) {
      const key = `goal-ticket-intent:${createHash('sha256').update(input.requestId).digest('hex')}`;
      const value = fingerprint(input), prior = db.meta(key);
      if (prior && prior.fingerprint !== value) throw Object.assign(new Error('目标请求已冻结，不能改变部分派发中的目标'), { code: 'IDEMPOTENCY_CONFLICT' });
      if (!prior) db.setMeta(key, { fingerprint: value });
    },
    goals: () => db.goals().map(goal => ({ ...goal, budgetState: goal.budgetGoalId ? api.getGoalBudget(goal.id) : null })),
    getGoal: id => { const goal = db.goal(id); return goal && { ...goal, budgetState: goal.budgetGoalId ? api.getGoalBudget(id) : null }; },
    updateGoal: (id, patch = {}, options) => {
      if (patch.status === 'completed') throw new Error('目标必须在工单完成交付后完成，不能直接标记完成');
      if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key => !['title', 'status'].includes(key))) throw new Error('目标只允许修改标题或暂停、恢复状态；执行身份与任务关联不可修改');
      if (patch.title !== undefined && (typeof patch.title !== 'string' || !patch.title.trim() || patch.title.length > 120)) throw new Error('无效目标标题');
      if (patch.status !== undefined && !['paused', 'active'].includes(patch.status)) throw new Error('仅支持暂停或恢复目标调度');
      const goal = db.goal(id);
      if (!goal) throw new Error('目标不存在');
      if (goal.status === 'cancelling') throw new Error('目标正在停止，不能恢复调度');
      if (patch.status && TERMINAL_GOAL.has(goal.status)) throw new Error('终态目标不能重新调度，请创建新目标');
      if (patch.status === 'active') {
        const seen = new Set([id]);
        let ancestor = goal.parentGoalId;
        while (ancestor) {
          if (seen.has(ancestor)) throw new Error('Invalid Goal hierarchy');
          seen.add(ancestor);
          const parent = db.goal(ancestor);
          if (!parent || ['paused', 'pausing', 'cancelling'].includes(parent.status)) throw new Error('Resume the parent Goal first');
          ancestor = parent.parentGoalId;
        }
      }
      if (patch.status) return changeGoalPause(id, patch.status === 'paused', options, patch.title);
      return db.updateGoal(id, patch, options);
    },
    tick,
    async dispose() { if (closed) return; closed = true; if (activeTick) await activeTick.catch(() => {}); if (ownsDb) db.close(); },
  };
  return api;
}

