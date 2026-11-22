import { createAssessmentSourceReader } from './assessment-source.mjs';
import { conciseTaskSummary } from './desktop-task-access.mjs';
import { randomUUID } from 'node:crypto';
import { assessCandidates } from './assessment.mjs';
import { buildAssessmentContextWindow, readSourceReference } from './assessment-context.mjs';
import { roleModels } from './routing.mjs';

function abortable(operation, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(operation).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Host supplies current policy and authority; model output never becomes permission. */
export function createAssessmentRunner({ database, llm, readPolicy, authorize, readContext, readAssistantContext, readDevices, resolveRemoteExecution, assess = assessCandidates, timeoutMs = 120000 }) {
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
      ...(task.mandate?.execution ? { remoteExecution: true } : {}),
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
    // The device center is routing context only; an unreadable directory never blocks local work.
    const devices = readDevices ? await abortable(Promise.resolve().then(() => readDevices(signal)).catch(() => []), signal) : [];
    const decisions = await abortable(assess({ llm, model: policy.model, models: policy.models, routingConfig: policy.routingConfig, rules: policy.rules, projects: policy.projects, devices, candidates: cards, signal, assistantContext, readSource: createAssessmentSourceReader({ database, candidates: cards }) }), signal);
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
      // Remote work is frozen from the target device's own catalog. A device that cannot take it is reported to the
      // requester when the source may be answered; it is never silently dropped or run somewhere else.
      let allowed = permission?.allowed === true, mandate = permission?.mandate, effective = decision, remoteFailure;
      let replyText = decision.replyText;
      if (allowed && decision.outcome === 'accept' && typeof decision.deviceId === 'string' && decision.deviceId && decision.deviceId !== 'local') {
        try {
          if (!resolveRemoteExecution) throw new Error('当前宿主不支持派发到其他设备');
          const remote = await abortable(resolveRemoteExecution({ deviceId: decision.deviceId, projectId: decision.projectId, signal }), signal);
          const { project: _local, ...rest } = mandate;
          mandate = { ...rest, ...(remote.project ? { project: remote.project } : {}), execution: remote.execution };
          if (remote.versionWarning) replyText = replyText
            ? `${replyText.slice(0, 5999 - remote.versionWarning.length)}\n${remote.versionWarning}`
            : `已受理。 ${remote.versionWarning}`;
        } catch (error) {
          if (signal.aborted) throw error;
          remoteFailure = error;
          effective = { ...decision, outcome: 'answer', replyText: `这项工作没有派出去：目标设备暂时不能执行（${String(error.message || error).slice(0, 500)}）。设备恢复后再发一次即可。` };
          allowed = (await authorize({ policy: current, candidate, trigger, decision: { outcome: 'answer' } }))?.allowed === true;
        }
        if ((await readPolicy(threadId)).version !== lease.policyVersion) break;
      }
      database.decide(candidate.id, {
        evalId: lease.id, owner, policyVersion: current.version,
        outcome: allowed ? remoteFailure ? 'answer' : permission.outcome || decision.outcome : 'notExplicit',
        assessment: { ...(permission?.routerAttention ? { requestedOutcome: decision.outcome, routerAttention: true } : {}), reason: decision.reason, ruleIds: decision.ruleIds || [], authorizationReason: permission?.reason },
        mode: current.mode, enabledRuleIds: current.enabledRuleIds || [], taskId: decision.taskId,
        ...(['answer', 'ask'].includes(effective.outcome) && allowed ? { reply: { text: effective.replyText, source: trigger.source, actor: trigger.actor, gate: candidate.gate, policyVersion: current.version } } : {}),
        ...(effective.outcome === 'accept' && allowed ? { replyText, task: { title: decision.title, target: decision.target, mandate: { ...mandate, acceptance: decision.acceptance, policyVersion: current.version, triggerId: candidate.triggerId } } } : {}),
        ...(['revise', 'adjustment'].includes(decision.outcome) && permission?.allowed === true ? { change: { expectedInstructionRevision: decision.expectedInstructionRevision,
          target: decision.target, acceptance: decision.acceptance, model: permission.mandate?.execution?.config?.models?.[0]
            || database.assignments(decision.taskId).at(-1)?.model || roleModels(undefined, current, 'worker')[0],
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
