import { assertSameOrigin } from '../../../../shared/http.mjs';

const conflicts = new Set(['ROW_CONFLICT', 'REVISION_CONFLICT', 'HASH_CONFLICT', 'IDEMPOTENCY_CONFLICT',
  'INSTRUCTION_REVISION_CONFLICT', 'EXECUTION_PENDING',
  'DELIVERY_RECONCILIATION_CONFLICT', 'OUTBOX_RECONCILIATION_CONFLICT',
  'SETTINGS_CONFLICT', 'SETTINGS_IDEMPOTENCY_CONFLICT', 'CLEANUP_CONFLICT', 'CLEANUP_PREVIEW_CONSUMED']);
const missing = new Set(['DIRECT_REPLY_NOT_FOUND', 'OUTBOX_NOT_FOUND']);

/** Exact Fetch routes are owner-only in the official shared handler. Unlike RPC
 * interceptors they receive only Request, so use the official browser Peer here.
 * Never derive a principal from JSON or apply this binding to remote RPC calls. */
export function registerAssistantFetchRoute({ connection, dispatch }) {
  return connection.fetch.register({
    path: '/api/commander/assistant', methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      try {
        assertSameOrigin(request);
        return Response.json(await dispatch(await request.json(), connection.browserPeer, { signal: request.signal }), {
          headers: { 'cache-control': 'no-store' },
        });
      } catch (error) {
        return Response.json({ error: error.message, code: error.code,
          ...(error.revision === undefined ? {} : { revision: error.revision }),
          ...(error.hash === undefined ? {} : { hash: error.hash }),
        }, { status: conflicts.has(error.code) ? 409 : missing.has(error.code) ? 404 : error.status || 400 });
      }
    },
  });
}
