import { workerAppliedTask } from './worker-permissions.mjs';
import { taskExecutionBlocked } from './task-lifecycle.mjs';

const object = value => {
  try { value = typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
};

function liveWorker(database, identity, now) {
  const assignment = database.getAssignment(identity.assignmentId), task = assignment && database.getTask(assignment.taskId);
  if (!task || task.mandate?.source?.channel !== 'desktop' || task.mandate.actorId !== 'desktop-owner'
    || taskExecutionBlocked(task) || assignment.state !== 'claimed'
    || !assignment.owner || !Number.isFinite(assignment.leaseUntil) || assignment.leaseUntil <= now) return null;
  const run = database.runs(assignment.id).find(row => row.id === identity.runId);
  if (!run || run.sessionId !== identity.sessionId || !['submitted', 'running'].includes(run.state)
    || run.owner !== assignment.owner || run.fence !== assignment.fence) return null;
  try { workerAppliedTask(database, assignment, { name: 'assistant_external_action' }); } catch { return null; }
  return { assignment, task, run };
}

/** Only an unpaired official ask for this exact live Worker submit is a reminder. */
export function approvalReminderSignal(database, identity, events, now = Date.now()) {
  const live = liveWorker(database, identity, now);
  if (!live) return null;
  const { assignment, task, run } = live;
  const call = events.flatMap(event => event.type === 'assistant/message' ? event.data?.message?.content || []
    : event.type === 'tool/ptc-dispatch-start' ? [{ type: 'tool-call', id: event.data.subCallId, name: event.data.name, arguments: event.data.arguments }] : [])
    .findLast(block => block.type === 'tool-call' && block.id === identity.callId && block.name === 'assistant_external_action');
  const args = object(call?.arguments);
  if (args?.operation !== 'submit' || args.actionId !== identity.actionId) return null;
  const asked = events.findLast(event => event.type === 'approval/asked' && event.data?.toolName === 'assistant_external_action'
    && event.data.callId === identity.callId && (!identity.approvalId || event.data.id === identity.approvalId));
  if (!asked?.data.id || events.some(event => event.type === 'approval/decided' && event.data?.id === asked.data.id)) return null;
  return { kind: 'approval', eventKey: `approval:${identity.sessionId}:${asked.data.id}`, taskId: task.id,
    title: task.title, status: task.status, source: task.mandate.source, instructionRevision: task.instructionRevision,
    assignmentId: assignment.id, runId: run.id, sessionId: run.sessionId, approvalId: asked.data.id,
    callId: identity.callId, actionId: identity.actionId };
}

export async function currentApprovalReminderSignal({ database, signal, readSession, now = Date.now() }) {
  if (signal?.kind !== 'approval' || !liveWorker(database, signal, now)) return null;
  let events;
  try { ({ events } = await readSession(signal.sessionId)); } catch { return null; }
  const current = approvalReminderSignal(database, signal, events, now);
  const identity = value => JSON.stringify({ ...value, title: undefined, status: undefined });
  return current && identity(current) === identity(signal) ? current : null;
}
