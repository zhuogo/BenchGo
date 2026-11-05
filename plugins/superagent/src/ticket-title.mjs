export const TICKET_TITLE_MAX_CHARS = 10;

/** A display label only; task target and acceptance stay complete and independent. */
export function normalizeTicketTitle(value, fallback = '') {
  const clean = input => typeof input === 'string'
    ? input.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').replace(/\s+/gu, ' ').trim()
    : '';
  return Array.from(clean(value) || clean(fallback) || '未命名工单').slice(0, TICKET_TITLE_MAX_CHARS).join('');
}
