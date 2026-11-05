const validId = value => { if (typeof value !== 'string' || !value.trim() || value.length > 512) throw new Error('Invalid budget identifier'); };
export function validateGoalBudget(budget = {}) {
  if (!budget || typeof budget !== 'object' || Array.isArray(budget) || Object.keys(budget).some(key => !['requests', 'tokens', 'cost', 'deadline'].includes(key))) throw new Error('Invalid goal budget');
  for (const [key, value] of Object.entries(budget)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (key !== 'cost' && !Number.isSafeInteger(value))) throw new Error(`Invalid budget ${key}`);
  }
  return Object.fromEntries(['requests', 'tokens', 'cost', 'deadline'].filter(key => budget[key] !== undefined).map(key => [key, budget[key]]));
}

/** Request admission is hard/atomic. Observed token and cost totals are soft bounds. */
export function installGoalBudgetStore({ db, tx }) {
  db.exec(`CREATE TABLE IF NOT EXISTS sa_goal_budgets(goal_id TEXT PRIMARY KEY,parent_id TEXT REFERENCES sa_goal_budgets(goal_id),budget TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,requests INTEGER NOT NULL DEFAULT 0,tokens INTEGER NOT NULL DEFAULT 0,cost REAL NOT NULL DEFAULT 0,unknown_tokens INTEGER NOT NULL DEFAULT 0,unknown_cost INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS sa_goal_ticket_bindings(ticket_id TEXT PRIMARY KEY,goal_id TEXT NOT NULL REFERENCES sa_goal_budgets(goal_id));
    CREATE TABLE IF NOT EXISTS sa_goal_requests(request_id TEXT PRIMARY KEY,ticket_id TEXT NOT NULL,goal_id TEXT NOT NULL,at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sa_goal_usage(session_id TEXT NOT NULL,seq INTEGER NOT NULL,ticket_id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(session_id,seq));
    CREATE TABLE IF NOT EXISTS sa_goal_request_usage(request_id TEXT PRIMARY KEY REFERENCES sa_goal_requests(request_id),payload TEXT NOT NULL);`);
  const get = goalId => {
    const row = db.prepare('SELECT * FROM sa_goal_budgets WHERE goal_id=?').get(goalId);
    return row && { goalId: row.goal_id, parentGoalId: row.parent_id, budget: JSON.parse(row.budget), version: row.version,
      usage: { requests: row.requests, tokens: row.tokens, cost: row.cost, unknownTokens: row.unknown_tokens, unknownCost: row.unknown_cost } };
  };
  const chain = goalId => {
    const rows = [], seen = new Set();
    while (goalId) {
      if (seen.has(goalId) || seen.size >= 100) throw new Error('Invalid goal budget ancestry');
      seen.add(goalId); const row = get(goalId); if (!row) throw new Error('Goal budget missing');
      rows.push(row); goalId = row.parentGoalId;
    }
    return rows;
  };
  const binding = ticketId => db.prepare('SELECT goal_id FROM sa_goal_ticket_bindings WHERE ticket_id=?').get(ticketId)?.goal_id;
  const bind = ({ ticketId, goalId }) => {
    validId(ticketId); validId(goalId);
    chain(goalId); const prior = binding(ticketId);
    if (prior && prior !== goalId) throw new Error('Ticket budget binding conflict');
    db.prepare('INSERT OR IGNORE INTO sa_goal_ticket_bindings VALUES(?,?)').run(ticketId, goalId);
    return get(goalId);
  };
  const blocked = (rows, now) => {
    for (const row of rows) for (const key of ['deadline', 'requests', 'tokens', 'cost']) {
      if (row.budget[key] !== undefined && (key === 'deadline' ? now : row.usage[key]) >= row.budget[key]) return { allowed: false, goalId: row.goalId, reason: key, budget: row.budget, usage: row.usage };
    }
    return { allowed: true };
  };
  const usagePayload = (tokens, cost) => {
    if ((tokens !== null && (!Number.isSafeInteger(tokens) || tokens < 0)) || (cost !== null && (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0))) throw new Error('Invalid goal usage');
    return JSON.stringify({ tokens, cost });
  };
  const addUsage = (goalId, tokens, cost) => {
    for (const row of chain(goalId)) db.prepare('UPDATE sa_goal_budgets SET tokens=tokens+?,cost=cost+?,unknown_tokens=unknown_tokens+?,unknown_cost=unknown_cost+? WHERE goal_id=?').run(tokens ?? 0, cost ?? 0, Number(tokens === null), Number(cost === null), row.goalId);
  };
  return {
    goalBudget: get,
    ticketGoalBudget(ticketId) { const goalId = binding(ticketId); return goalId ? get(goalId) : null; },
    ensureGoalBudget({ goalId, parentGoalId = null, budget = {} }) {
      validId(goalId); if (parentGoalId !== null) validId(parentGoalId); budget = validateGoalBudget(budget);
      return tx(() => {
        const prior = get(goalId);
        if (prior) {
          if (prior.parentGoalId !== parentGoalId || JSON.stringify(prior.budget) !== JSON.stringify(budget)) throw new Error('Goal budget identity conflict');
          return prior;
        }
        if (parentGoalId && (parentGoalId === goalId || chain(parentGoalId).length >= 100)) throw new Error('Invalid goal budget parent');
        db.prepare('INSERT INTO sa_goal_budgets(goal_id,parent_id,budget) VALUES(?,?,?)').run(goalId, parentGoalId, JSON.stringify(budget)); return get(goalId);
      });
    },
    bindTicketGoal(input) { return tx(() => bind(input)); },
    // Only the trusted Ticket creation transaction may call this entry.
    bindTicketGoalInTransaction(input) {
      if (!db.isTransaction) throw new Error('Budget binding requires an active transaction');
      return bind(input);
    },
    checkGoalBudget({ ticketId, now = Date.now() }) { const goalId = binding(ticketId); return goalId ? blocked(chain(goalId), now) : { allowed: true }; },
    reserveGoalRequest({ ticketId, requestId, now = Date.now() }) {
      validId(ticketId); validId(requestId); if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid budget time');
      return tx(() => {
        const prior = db.prepare('SELECT * FROM sa_goal_requests WHERE request_id=?').get(requestId);
        if (prior) { if (prior.ticket_id !== ticketId) throw new Error('Budget request identity conflict'); return { allowed: true, duplicate: true }; }
        const goalId = binding(ticketId); if (!goalId) return { allowed: true, unbound: true };
        const rows = chain(goalId), decision = blocked(rows, now); if (!decision.allowed) return decision;
        db.prepare('INSERT INTO sa_goal_requests VALUES(?,?,?,?)').run(requestId, ticketId, goalId, now);
        for (const row of rows) db.prepare('UPDATE sa_goal_budgets SET requests=requests+1 WHERE goal_id=?').run(row.goalId);
        return { allowed: true, duplicate: false };
      });
    },
    // One-shot requests have no durable session event. Their reservation is the settlement identity.
    recordGoalRequestUsage({ ticketId, requestId, tokens = null, cost = null }) {
      validId(ticketId); validId(requestId);
      const payload = usagePayload(tokens, cost);
      return tx(() => {
        const request = db.prepare('SELECT * FROM sa_goal_requests WHERE request_id=?').get(requestId);
        if (!request) {
          if (!binding(ticketId)) return { ignored: true };
          throw new Error('Goal request reservation missing');
        }
        if (request.ticket_id !== ticketId) throw new Error('Budget request identity conflict');
        const prior = db.prepare('SELECT payload FROM sa_goal_request_usage WHERE request_id=?').get(requestId);
        if (prior) {
          if (prior.payload !== payload) throw new Error('Budget usage identity conflict');
          return { duplicate: true };
        }
        db.prepare('INSERT INTO sa_goal_request_usage VALUES(?,?)').run(requestId, payload);
        addUsage(request.goal_id, tokens, cost);
        return { duplicate: false };
      });
    },
    recordGoalUsage({ ticketId, sessionId, seq, tokens = null, cost = null, inherited = false }) {
      if (inherited) return { ignored: true };
      validId(ticketId); validId(sessionId);
      if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('Invalid goal usage');
      const payload = usagePayload(tokens, cost);
      return tx(() => {
        const prior = db.prepare('SELECT * FROM sa_goal_usage WHERE session_id=? AND seq=?').get(sessionId, seq);
        if (prior) { if (prior.ticket_id !== ticketId || prior.payload !== payload) throw new Error('Budget usage identity conflict'); return { duplicate: true }; }
        const goalId = binding(ticketId); if (!goalId) return { ignored: true };
        db.prepare('INSERT INTO sa_goal_usage VALUES(?,?,?,?)').run(sessionId, seq, ticketId, payload);
        addUsage(goalId, tokens, cost);
        return { duplicate: false };
      });
    },
    updateGoalBudget({ goalId, budget, expectedVersion }) {
      budget = validateGoalBudget(budget);
      return tx(() => {
        const row = get(goalId); if (!row || row.version !== expectedVersion) throw Object.assign(new Error('Goal budget version conflict'), { code: 'ROW_CONFLICT' });
        db.prepare('UPDATE sa_goal_budgets SET budget=?,version=version+1 WHERE goal_id=?').run(JSON.stringify(budget), goalId); return get(goalId);
      });
    },
  };
}
