import { assertSameOrigin, HttpError, readJson } from '../shared/http.mjs';
import { feedbackCategories, feedbackLimit, feedbackPath } from '../shared/feedback.mjs';

const endpoint = 'https://benchgo.cn/api/x/feedback/';

export function createFeedbackHandler(send = fetch) {
  return async request => {
    const reply = (value, status) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
    let submission;
    try {
      assertSameOrigin(request, { allowDesktopOrigin: true });
      const { category, requestId, text } = await readJson(request, 16_384);
      if (typeof requestId !== 'string' || !/^[a-f0-9]{32}$/.test(requestId)
        || typeof category !== 'string' || !Object.hasOwn(feedbackCategories, category)
        || typeof text !== 'string' || !text.trim() || Array.from(text.trim()).length > feedbackLimit) {
        throw new HttpError('请检查反馈内容', 400);
      }
      submission = { category, requestId, text: text.trim() };
    } catch (error) {
      return reply({ code: 'invalid_feedback' }, error.status ?? 400);
    }

    try {
      const result = await send(endpoint, {
        method: 'POST', body: JSON.stringify(submission),
        headers: { 'content-type': 'application/json', 'idempotency-key': submission.requestId },
        redirect: 'error', signal: AbortSignal.any([request.signal, AbortSignal.timeout(12_000)]),
      });
      if (result.status === 429) return reply({ code: 'feedback_rate_limited' }, 429);
      if (result.ok) {
        const { ticketId } = await result.json();
        if (Number.isSafeInteger(ticketId) && ticketId > 0) return reply({ ticketId }, 200);
      }
    } catch {
      // The form keeps its draft and submission id for a retry.
    }
    return reply({ code: 'feedback_unavailable' }, 502);
  };
}

export function mountFeedbackRoute(ctx) {
  ctx.effect(() => ctx.connection.fetch.register({
    path: feedbackPath, methods: ['POST'], requestBody: 'buffered', fetch: createFeedbackHandler(),
  }));
}
