import { createAssessmentSourceReader } from './assessment-source.mjs';
import { conciseTaskSummary } from './desktop-task-access.mjs';
import { randomUUID } from 'node:crypto';
import { assessCandidates } from './assessment.mjs';
import { buildAssessmentContextWindow, readSourceReference } from './assessment-context.mjs';

function abortable(operation, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(operation).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Host supplies current policy and authority; model output never becomes permission. */
export function createAssessmentRunner({ database, llm, readPolicy, authorize, readContext, readAssistantContext, assess = assessCandidates, timeoutMs = 120000 }) {
  const owner = `router:${randomUUID()}`, shutdown = new AbortController();
  const inFlight = new Map();
  async function assessThread(threadId) {
    shutdown.signal.throwIfAborted();
    const policy = await readPolicy(threadId);
    shutdown.signal.throwIfAborted();
    if (!policy?.model) return;
    const lease = database.claimEval(threadId, { owner, policyVersion: policy.version, timeoutMs, limit: 8 });
    if (!lease) return;
    const candidates = database.candidates({ threadId, status: 'evaluating', limit: 1000 }).filter(row => lease.candidateIds.includes(row.id));
    const tasks = database.listTasks({ threadId }).map(task => ({ id: task.id, title: task.title,
      status: task.status, instructionRevision: task.instructionRevision, summary: conciseTaskSummary(task),
      target: task.target?.slice(0, 1000), acceptance: task.acceptance?.slice(0, 1000),
      result: task.resultVersion > 0 ? { taskId: task.id, version: task.resultVersion } : null }));
    const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(timeoutMs)]);
    const cards = await abortable(Promise.all(candidates.map(async row => {
      const context = buildAssessmentContextWindow({ ...database.assessmentContext(row.triggerId), triggerId: row.triggerId,
        maxContentLength: Math.min(4000, Math.floor(68000 / (17 * candidates.length))) });
      context.recentReplies = database.directReplies({ threadId, limit: 6 }).filter(reply => reply.state === 'sent')
        .map(({ triggerId, kind, text, createdAt }) => ({ triggerId, kind, text: text.slice(0, 2000), createdAt })).reverse();
      const target = context.messages.find(message => message.triggerId === row.triggerId);
      const original = database.readIntakeEvent(row.triggerId);
      context.freshness = { assessedAt: new Date().toISOString(), sourceCreatedAt: original.createdAt,
        newerSourceMessageExists: database.sourceMessageSuperseded(original) };
      const externalReference = await readSourceReference({ readContext, source: target?.pointer?.source, signal, maxCharacters: Math.floor(12000 / candidates.length) });
      if (externalReference) context.externalReference = externalReference;
      return { candidateId: row.id, trigger: { id: row.triggerId, threadId, ...target }, context, gate: row.gate, tasks };
    })), signal);
    const assistantContext = readAssistantContext ? await abortable(readAssistantContext(), signal) : undefined;
    const decisions = await abortable(assess({ llm, model: policy.model, models: policy.models, routingConfig: policy.routingConfig, rules: policy.rules, projects: policy.projects, candidates: cards, signal, assistantContext, readSource: createAssessmentSourceReader({ database, candidates: cards }) }), signal);
    signal.throwIfAborted();
    for (const decision of decisions) {
      const current = await readPolicy(threadId);
      if (current.version !== lease.policyVersion) break;
      const candidate = candidates.find(row => row.id === decision.candidateId);
      if (!candidate) throw new Error('Assessment returned an unknown candidate');
      const originalProject = ['revise', 'adjustment'].includes(decision.outcome) && decision.taskId ? database.getTask(decision.taskId)?.mandate.project : undefined;
      const authorityDecision = originalProject && decision.projectId === undefined ? { ...decision, projectId: originalProject.id } : decision;
      const trigger = database.readIntakeEvent(candidate.triggerId);
      const permission = await authorize({ policy: current, candidate, trigger, decision: authorityDecision, task: decision.taskId ? database.getTask(decision.taskId) : undefined });
      signal.throwIfAborted();
      // Recheck after asynchronous authorization; an old authorization cannot commit.
      if ((await readPolicy(threadId)).version !== lease.policyVersion) break;
      database.decide(candidate.id, {
        evalId: lease.id, owner, policyVersion: current.version,
        outcome: permission?.allowed === true ? permission.outcome || decision.outcome : 'notExplicit',
        assessment: { ...(permission?.routerAttention ? { requestedOutcome: decision.outcome, routerAttention: true } : {}), reason: decision.reason, ruleIds: decision.ruleIds || [], authorizationReason: permission?.reason },
        mode: current.mode, enabledRuleIds: current.enabledRuleIds || [], taskId: decision.taskId,
        ...(['answer', 'ask'].includes(decision.outcome) && permission?.allowed === true ? { reply: { text: decision.replyText, source: trigger.source, actor: trigger.actor, gate: candidate.gate, policyVersion: current.version } } : {}),
        ...(decision.outcome === 'accept' && permission?.allowed === true ? { replyText: decision.replyText, task: { title: decision.title, target: decision.target, mandate: { ...permission.mandate, acceptance: decision.acceptance, policyVersion: current.version, triggerId: candidate.triggerId } } } : {}),
        ...(['revise', 'adjustment'].includes(decision.outcome) && permission?.allowed === true ? { change: { expectedInstructionRevision: decision.expectedInstructionRevision,
          target: decision.target, acceptance: decision.acceptance, model: database.assignments(decision.taskId).at(-1)?.model || current.workerModels?.[0] || current.model,
          mandate: { ...permission.mandate, policyVersion: current.version, triggerId: candidate.triggerId } } } : {}),
      });
    }
  }
  return {
    async tick() {
      shutdown.signal.throwIfAborted();
      database.requeueExpiredEvals();
      const threads = new Set(database.candidates({ status: 'queued', limit: 1000 }).map(row => row.threadId));
      for (const threadId of threads) {
        if (inFlight.has(threadId)) continue;
        // Reserve the thread before asynchronous policy/model work can resume.
        const operation = assessThread(threadId).finally(() => inFlight.delete(threadId));
        inFlight.set(threadId, operation);
      }
      const results = await Promise.allSettled([...inFlight.values()]);
      shutdown.signal.throwIfAborted();
      const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, '部分线程研判未完成');
    },
    async stop() {
      shutdown.abort();
      await Promise.allSettled([...inFlight.values()]);
    },
  };
}
