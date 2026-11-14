const fields = ['sessionId', 'callId', 'approvalId', 'actionId', 'taskId', 'assignmentId', 'runId', 'ownerThreadId', 'eventKey'];
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 512;

/** Presentation identity from a host signal, never authority to answer an approval. */
export function approvalChatBinding(value) {
  if (!value || !fields.every(field => identity(value[field]))
    || value.eventKey !== `approval:${value.sessionId}:${value.approvalId}`) return null;
  return Object.fromEntries(fields.map(field => [field, value[field]]));
}

/** Called only by the durable host inbox with its already validated signal. */
export function approvalSignalBinding(signal, ownerThreadId) {
  return signal?.kind === 'approval' ? approvalChatBinding({ ...signal, ownerThreadId }) : null;
}
