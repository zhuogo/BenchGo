import { randomUUID } from 'node:crypto';

const validReply = text => typeof text === 'string' && text.trim().length > 0 && text.length <= 6000;

/** Old host-authored acknowledgements must not be replayed after switching to Router replies. */
export function isRouterTicketAck(event) {
  return event?.type === 'ticket.accepted' && event.origin === 'router'
    && typeof event.ticketId === 'string' && !!event.ticketId
    && typeof event.requestId === 'string' && !!event.requestId && validReply(event.text);
}

/** Called inside the same transaction that creates an explicitly requested Ticket. */
export function enqueueTicketAck({ db, ticket, trigger, text, now = Date.now() }) {
  if (text === undefined) return false;
  if (!validReply(text)) throw new Error('接单回复缺少有效正文');
  if (!ticket || ticket.status !== 'open' || !trigger || trigger.actor?.kind !== 'human') return false;
  const source = ticket.mandate?.source;
  if (!source?.channel || JSON.stringify(source) !== JSON.stringify(trigger.source)) return false;
  const payload = { type: 'ticket.accepted', origin: 'router', ticketId: ticket.id, source,
    requestId: trigger.id, sourceEventId: source.eventId ?? null, text: text.trim() };
  const at = new Date(now).toISOString();
  const inserted = db.prepare("INSERT OR IGNORE INTO sa_outbox(id,unique_key,ticket_id,payload,state,attempts,next_at,created_at,updated_at) VALUES (?,?,?,?,'queued',0,?,?,?)")
    .run(randomUUID(), `ticket-accepted:${ticket.id}`, ticket.id, JSON.stringify(payload), now, at, at);
  return inserted.changes === 1;
}
