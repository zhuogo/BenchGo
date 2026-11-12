export const ticketStates = Object.freeze(['running', 'waiting', 'completed']);
// Read compatibility for a status sentence saved by older runtimes. Preserve
// unknown text and all protocol/model identifiers instead of guessing aliases.
export function executionStatusText(value) {
  return typeof value === 'string' && /^Saved result is awaiting persistence\.?$/i.test(value.trim())
    ? '执行结果已暂存，尚未完成正式保存。' : value;
}
export const ticketStopped = ticket => ticket?.executionControl?.stopRequested === true || ticket?.executionControl?.stopped === true;
export const ticketPaused = ticket => ticket?.executionControl?.pauseRequested === true || ticket?.executionControl?.paused === true;
export const ticketExecutionBlocked = ticket => ticket?.status === 'completed' || ticketStopped(ticket) || ticketPaused(ticket);
export function assertTicketStatus(status) {
  if (!ticketStates.includes(status)) throw new Error('Invalid Ticket status');
  return status;
}
