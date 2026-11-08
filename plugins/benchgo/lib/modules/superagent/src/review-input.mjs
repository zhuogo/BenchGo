import { createHash } from 'node:crypto';

/** Fingerprints review inputs, excluding previous verdict/delivery metadata. */
export function reviewInputHash({ ticket, result, model, rules, routingConfig, answeredAttentions }) {
  const { review, delivery, version, committedAt, reviewedFromVersion, ticketId, ...evidence } = result || {};
  return createHash('sha256').update(JSON.stringify({
    reviewProtocol: 6,
    target: ticket.target, acceptance: ticket.acceptance, instructionRevision: ticket.instructionRevision,
    mandate: ticket.mandate, evidence, model, rules, routingConfig, answeredAttentions,
  })).digest('hex');
}
