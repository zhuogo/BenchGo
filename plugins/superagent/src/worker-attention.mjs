/** Bridges the official question waterfall to authenticated source replies. */
export function attentionAnswer(database, entry) {
  const trigger = database.getTrigger(entry.answerTriggerId);
  return { id: entry.question.id, ...(trigger.source.channel === 'desktop' && trigger.source.answer
    ? trigger.source.answer : { selected: [], custom: trigger.content }) };
}

export function installWorkerAttention(scope, agent, { database, assignment, signal, pauseDeadline, resumeDeadline, sessionProjections, pollMs = 250 }) {
  const pending = new Map();
  let sequence = 0, waiting = 0;
  scope.on('user-questions/request', async (request, next) => {
    if (request.agent !== agent) return next();
    const ticket = database.getTicket(assignment.ticketId);
    if (!['feishu', 'desktop'].includes(ticket?.mandate.source?.channel)) return next();
    const waitSignal = AbortSignal.any([signal, ...(request.signal ? [request.signal] : [])]);
    waitSignal.throwIfAborted();
    const entries = database.openAttention(assignment.id, { owner: assignment.owner, fence: assignment.fence,
      sessionId: agent.id, callId: request.wait?.callId || `foreground:${++sequence}`, questions: request.questions });
    const batch = ++sequence;
    pending.set(batch, { callId: request.wait?.timed ? request.wait.callId : null, attentionIds: entries.map(entry => entry.id) });
    if (++waiting === 1) pauseDeadline();
    try {
      for (;;) {
        waitSignal.throwIfAborted();
        const current = database.attentions(assignment.ticketId);
        const answered = entries.map(entry => current.find(item => item.id === entry.id));
        if (answered.every(entry => entry?.answerTriggerId)) {
          pending.delete(batch);
          return { answers: answered.map(entry => attentionAnswer(database, entry)) };
        }
        await new Promise((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(waitSignal.reason); };
          const timer = setTimeout(() => { waitSignal.removeEventListener('abort', abort); resolve(); }, pollMs);
          waitSignal.addEventListener('abort', abort, { once: true });
        });
      }
    } finally { if (--waiting === 0) resumeDeadline(); }
  });
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
      const existing = database.attentions(assignment.ticketId).filter(entry =>
        entry.sessionId === agent.id && entry.callId === call.callId);
      const existingIds = new Set(existing.map(entry => entry.question.id));
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
