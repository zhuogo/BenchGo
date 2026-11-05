import { lastAssistantStreamChunk } from '@deepseek-ai/dsh-llm';

/** Use durable attempt settlements, never UI projections or inherited parent usage. */
export function goalBudgetUsage(event, { inheritedEventCount = 0 } = {}) {
  if (!Number.isSafeInteger(inheritedEventCount) || inheritedEventCount < 0) throw new Error('Invalid inherited event boundary');
  if (!['assistant/message', 'assistant/attempt'].includes(event?.type)) return null;
  if (!Number.isSafeInteger(event.seq) || event.seq < 0) throw new Error('Invalid usage event sequence');
  if (event.seq < inheritedEventCount) return null;
  const usage = event.type === 'assistant/message' && event.data?.usage !== undefined
    ? event.data.usage : lastAssistantStreamChunk(event.data?.stream || [], 'usage')?.usage;
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  // Missing aggregate usage is unknown. Cache buckets and reasoning may overlap;
  // the official adapters supply totalTokens only when the aggregate is known.
  return { seq: event.seq, tokens: count(usage?.totalTokens), cost: null };
}

/** Safe to replay the full stored log: the budget store deduplicates session + seq. */
export function recordGoalBudgetEvents({ database, ticketId, sessionId, events, inheritedEventCount = 0 }) {
  for (const event of events) {
    const usage = goalBudgetUsage(event, { inheritedEventCount });
    if (usage) database.recordGoalUsage({ ticketId, sessionId, ...usage });
  }
}

export function installGoalBudgetUsage(scope, agent, { database, ticketId }) {
  if (!database.ticketGoalBudget(ticketId)) return;
  const record = events => recordGoalBudgetEvents({ database, ticketId, sessionId: agent.id, events, inheritedEventCount: agent.session.inheritedEventCount });
  record(agent.session.snapshotEvents());
  return scope.on('session/event', (session, event) => {
    if (session === agent.session) record([event]);
  });
}
