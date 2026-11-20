/** Only the transport boundary can prove that a request was not sent. */
export function deliveryFailure(message, outcome = 'unknown', status) {
  return Object.assign(new Error(message), { deliveryOutcome: outcome,
    code: outcome === 'not_sent' ? 'DELIVERY_NOT_SENT' : 'DELIVERY_UNCERTAIN',
    ...(outcome === 'unknown' ? { deliveryUncertain: true } : {}), ...(status ? { status } : {}) });
}

export const knownNotSent = error => error?.deliveryOutcome === 'not_sent';
export function replyWindowExpired(message) {
  return Object.assign(deliveryFailure(message, 'not_sent', 409), { code: 'REPLY_WINDOW_EXPIRED' });
}
export const waitsForReplyWindow = error => knownNotSent(error) && error.code === 'REPLY_WINDOW_EXPIRED';
export const httpRejected = status => Number.isInteger(status) && status >= 400 && status < 500 && status !== 408;

/** Safe only around validation/authentication, before the outbound message call. */
export async function beforeDelivery(operation) {
  try { return await operation(); }
  catch (error) {
    throw deliveryFailure(error?.message || '发送前检查失败', 'not_sent', error?.status);
  }
}
