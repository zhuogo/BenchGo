import { triageWorkerQuestions } from './attention-triage.mjs';
import { attentionReplyText } from './attention-store.mjs';

/** Bridges the official question waterfall to authenticated source replies. */
export function attentionAnswer(database, entry) {
  const trigger = database.getTrigger(entry.answerTriggerId);
  return { id: entry.question.id, ...(['desktop', 'link'].includes(trigger.source.channel) && trigger.source.answer
    ? trigger.source.answer : { selected: [], custom: attentionReplyText(entry.id, trigger.content) }) };
}

export function attentionBatchAnswers(database, taskId, { sessionId, callId, questions }) {
  const resolved = database.attentionResolutions(taskId, { sessionId, callId });
  const entries = database.attentions(taskId).filter(entry => entry.sessionId === sessionId && entry.callId === callId);
  const expected = questions || (resolved.length ? resolved.map(row => row.question) : entries.map(row => row.question));
  if (!expected.length) throw new Error('Attention batch is missing');
  const consumed = [];
  const answers = expected.map(question => {
    const automatic = resolved.find(row => row.questionId === question.id && row.route !== 'user');
    if (automatic) return automatic.answer;
    const entry = entries.find(row => row.question.id === question.id);
    if (!entry?.answerTriggerId) throw new Error('Attention answer is missing');
    consumed.push(entry);
    return attentionAnswer(database, entry);
  });
  for (const entry of consumed) {
    if (!database.taskInputs(taskId).some(row => row.triggerId === entry.answerTriggerId)) continue;
    const assignment = database.getAssignment(entry.assignmentId), run = database.runs(entry.assignmentId).find(row => row.sessionId === sessionId && row.fence === assignment.fence);
    if (!run) throw new Error('Attention answer execution is missing');
    database.applyTaskInput(entry.answerTriggerId, { assignmentId: assignment.id, owner: assignment.owner, fence: assignment.fence,
      runId: run.id, sessionId, boundaryId: `attention:${callId}`, attentionId: entry.id });
  }
  return answers;
}

export function installWorkerAttention(scope, agent, { database, assignment, signal, sessionProjections, llm, readPolicy, pollMs = 250 }) {
  const pending = new Map();
  let sequence = 0;
  scope.on('user-questions/request', async (request, next) => {
    if (request.agent !== agent) return next();
    const task = database.getTask(assignment.taskId);
    if (!['feishu', 'desktop', 'link', 'wecom', 'qq', 'weixin', 'telegram', 'discord', 'slack', 'dingtalk', 'whatsapp', 'email', 'webhook', 'api'].includes(task?.mandate.source?.channel)) return next();
    const waitSignal = AbortSignal.any([signal, ...(request.signal ? [request.signal] : [])]);
    waitSignal.throwIfAborted();
    let hold, holdAbort;
    try {
      const callId = request.wait?.callId || `foreground:${++sequence}`;
      let resolutions = database.attentionResolutions(assignment.taskId, { sessionId: agent.id, callId });
      if (!resolutions.length) {
        if (request.wait?.timed && scope.get?.('userQuestions')?.attachWait) {
          holdAbort = new AbortController();
          hold = scope.get('userQuestions').attachWait(agent, callId, AbortSignal.any([waitSignal, holdAbort.signal]))[Symbol.asyncIterator]();
          await hold.next();
        }
        let policy;
        try { policy = await readPolicy?.() || {}; } catch { policy = {}; }
        const decisions = await triageWorkerQuestions({ llm, task, questions: request.questions, policy, signal: waitSignal });
        waitSignal.throwIfAborted();
        resolutions = database.saveAttentionResolutions(assignment.id, { owner: assignment.owner, fence: assignment.fence,
          sessionId: agent.id, callId, questions: request.questions, decisions });
      }
      if (resolutions.length && (resolutions.length !== request.questions.length || resolutions.some(row =>
        row.instructionRevision !== task.instructionRevision || !request.questions.some(question => JSON.stringify(question) === JSON.stringify(row.question))))) throw new Error('Attention triage batch changed');
      const questions = request.questions.filter(question => !resolutions.some(row => row.questionId === question.id && row.route !== 'user'));
      const entries = questions.length ? database.openAttention(assignment.id, { owner: assignment.owner, fence: assignment.fence,
        sessionId: agent.id, callId, questions }) : [];
      const batch = ++sequence;
      if (entries.length) pending.set(batch, { callId: request.wait?.timed ? callId : null, attentionIds: entries.map(entry => entry.id) });
      holdAbort?.abort();
      await hold?.return?.();
      hold = undefined;
      for (;;) {
        waitSignal.throwIfAborted();
        const current = database.attentions(assignment.taskId);
        const answered = entries.map(entry => current.find(item => item.id === entry.id));
        if (answered.every(entry => entry?.answerTriggerId)) {
          pending.delete(batch);
          return { answers: attentionBatchAnswers(database, assignment.taskId, { sessionId: agent.id, callId, questions: request.questions }) };
        }
        await new Promise((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(waitSignal.reason); };
          const timer = setTimeout(() => { waitSignal.removeEventListener('abort', abort); resolve(); }, pollMs);
          waitSignal.addEventListener('abort', abort, { once: true });
        });
      }
    } finally { holdAbort?.abort(); await hold?.return?.(); }
  }, { prepend: true });
  return { waiting() {
    const entries = [...pending.values()];
    if (entries.some(entry => !entry.callId)) throw new Error('Unkeyed Attention requires session reconciliation');
    const callIds = new Set(entries.map(entry => entry.callId));
    const attentionIds = new Set(entries.flatMap(entry => entry.attentionIds));
    // The worker scope may not expose host-level projection services after a
    // resumed/remote agent is mounted. Prefer the injected host registry and
    // retain the scope lookup for lightweight fixtures and older hosts.
    const projections = sessionProjections || scope.get?.('sessionProjections');
    const questions = projections?.stateOf?.(agent.session, 'userQuestions')?.questions;
    for (const call of questions?.active || []) {
      if (call.state !== 'continued' || !call.callId || !Array.isArray(call.questions) || !call.questions.length) continue;
      const existing = database.attentions(assignment.taskId).filter(entry =>
        entry.sessionId === agent.id && entry.callId === call.callId);
      const existingIds = new Set(existing.map(entry => entry.question.id));
      for (const row of database.attentionResolutions(assignment.taskId, { sessionId: agent.id, callId: call.callId })) {
        if (row.route !== 'user' && row.instructionRevision === database.getTask(assignment.taskId)?.instructionRevision) existingIds.add(row.questionId);
      }
      const missing = call.questions.filter(question => !existingIds.has(question.id));
      const created = missing.length ? database.openAttention(assignment.id, { owner: assignment.owner, fence: assignment.fence,
        sessionId: agent.id, callId: call.callId, questions: missing }) : [];
      const unanswered = existing.filter(entry => !entry.answerTriggerId);
      // A resumed call can remain in the official projection until its queued
      // answer is admitted. Answered durable Attentions must not reject the
      // continuation's next model step.
      if (!created.length && !unanswered.length) continue;
      callIds.add(call.callId);
      for (const entry of [...unanswered, ...created]) attentionIds.add(entry.id);
    }
    return callIds.size ? { callIds: [...callIds], attentionIds: [...attentionIds] } : null;
  } };
}
