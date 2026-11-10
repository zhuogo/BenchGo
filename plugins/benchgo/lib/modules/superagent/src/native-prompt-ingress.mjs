import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol';

const endpoint = 'session/prompt';
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const badRequest = message => new RemoteError('gateway/bad-request', message, {});
const reply = (rpcId, result) => Response.json({ type: 'server-response', rpcId, result });

/** Adapt the owner Desktop/Web transport without replacing its composer or admission. */
export function registerNativePromptIngress(ctx, engine) {
  if (typeof engine?.nativePrompt !== 'function') throw new Error('Native prompt ingress requires the assistant engine');
  return ctx.connection.fetch.register({
    path: `/api/${endpoint}`, methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 });
      }
      let envelope;
      try { envelope = await request.json(); }
      catch { return new Response('body is not JSON', { status: 400 }); }
      const rpcId = typeof envelope?.rpcId === 'string' ? envelope.rpcId : 'invalid-request';
      try {
        if (!record(envelope) || envelope.type !== 'client-request' || typeof envelope.rpcId !== 'string'
          || envelope.method !== endpoint || !record(envelope.payload) || Object.keys(envelope.payload).length !== 1
          || !record(envelope.payload.args)) {
          throw badRequest('invalid session prompt request envelope');
        }
        request.signal.throwIfAborted();
        const args = envelope.payload.args;
        // Exact Connection Fetch routes admit owner Peers only. Invoke the public
        // Gateway directly: it still validates arguments and owns attachment admission.
        const dispatch = () => ctx.typertGateway.invoke({ namespace: 'session', method: 'prompt', args,
          peer: ctx.connection.browserPeer, signal: request.signal });
        const prompt = args.request;
        const routable = record(prompt) && typeof prompt.sessionId === 'string' && typeof prompt.requestId === 'string';
        const value = routable
          ? await engine.nativePrompt({ request: prompt, dispatch, signal: request.signal })
          : await dispatch();
        // Only official admission may produce this acknowledgement; never ACK
        // a staged attachment or replay an uncertain request in this adapter.
        return reply(rpcId, { ok: true, value });
      } catch (error) {
        const remote = request.signal.aborted
          ? new RemoteError('gateway/cancelled', 'session prompt request was aborted', {}) : remoteErrorOf(error);
        return reply(rpcId, { ok: false, error: remote
          ? { code: remote.code, message: remote.message, details: remote.details }
          : { code: 'gateway/internal', message: error instanceof Error ? error.message : String(error), details: {} } });
      }
    },
  });
}
