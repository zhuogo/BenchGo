/** Ticket review budgets are independent of Worker execution and other auxiliary jobs. */
export const TICKET_REVIEW_TIMEOUT_MS = 360_000;
export const TICKET_REVIEW_REQUEST_POLICY = Object.freeze({
  attemptTimeoutMs: 45_000,
  mainTimeoutMs: 120_000,
  maxAttempts: 3,
  preferMainFallback: true,
  repairQuality: true,
});
export const ticketReviewRequestBudget = () => ({ remaining: 6, attempts: [], switched: false, mainQualityRepaired: false });
