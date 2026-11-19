/** Shared owner-API boundaries; independent of optional business modules. */
export class HttpError extends Error {
  constructor(message, status = 400, code) { super(message); this.status = status; if (code) this.code = code; }
}

export function assertSameOrigin(request, { allowDesktopOrigin = false } = {}) {
  if (request.headers.get('sec-fetch-site') === 'cross-site') throw new HttpError('Cross-site requests are not allowed', 403);
  const origin = request.headers.get('origin');
  if (!origin) return;
  if (allowDesktopOrigin && origin === 'dsh-app://app') return;
  let parsed; try { parsed = new URL(origin); } catch { throw new HttpError('Invalid request origin', 403); }
  const host = request.headers.get('host') || new URL(request.url).host;
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.host !== host) throw new HttpError('Cross-site requests are not allowed', 403);
}

export async function readLimited(request, limit, signal = request.signal) {
  if (Number(request.headers.get('content-length')) > limit) throw new HttpError('Request is too large', 413);
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader(), chunks = []; let size = 0;
  const abort = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read(); signal.throwIfAborted(); if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new HttpError('Request is too large', 413); }
      chunks.push(value);
    }
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
  const output = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

export async function readJson(request, limit = 32768) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new HttpError('Expected application/json', 415);
  let value; try { value = JSON.parse(new TextDecoder().decode(await readLimited(request, limit))); }
  catch (error) { if (error instanceof HttpError || request.signal.aborted) throw error; throw new HttpError('Invalid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError('Expected JSON object');
  return value;
}
