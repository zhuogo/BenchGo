export const ticketStates = Object.freeze(['running', 'waiting', 'completed']);
export const ticketStopped = ticket => ticket?.executionControl?.stopRequested === true || ticket?.executionControl?.stopped === true;
export const ticketPaused = ticket => ticket?.executionControl?.pauseRequested === true || ticket?.executionControl?.paused === true;
export const ticketExecutionBlocked = ticket => ticket?.status === 'completed' || ticketStopped(ticket) || ticketPaused(ticket);
export function assertTicketStatus(status) {
  if (!ticketStates.includes(status)) throw new Error('Invalid Ticket status');
  return status;
}
