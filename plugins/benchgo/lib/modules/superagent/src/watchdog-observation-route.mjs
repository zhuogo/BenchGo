import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { MAINTENANCE_WATCHDOG_REASONS } from './maintenance-health.mjs';

export const WATCHDOG_OBSERVATION_PATH = '/benchgo/watchdog/observation';
export const WATCHDOG_SIGNAL_PATH = '/benchgo/watchdog/signals';
export const WATCHDOG_SIGNAL_REASONS = Object.freeze(['TARGET_UNREACHABLE', 'TARGET_IDENTITY_MISMATCH',
  'FACTS_STALE', 'SCHEDULER_STALLED', 'EXECUTION_INACTIVE', 'LEASE_EXPIRED', 'REQUEST_DEADLINE_EXCEEDED',
  'STOP_UNCONFIRMED', ...MAINTENANCE_WATCHDOG_REASONS]);
const headerPrefix = 'x-benchgo-watchdog-';
const executionFields = ['ticketId', 'assignmentId', 'runId', 'sessionId', 'fence', 'instructionRevision'];
const signalFields = ['id', 'incidentKey', 'phase', 'kind', 'targetId', 'observedAt', 'checkId', 'evidenceCursor',
  'execution', 'reasonCode', 'summary'];
const localError = Symbol('watchdog-transport-error');
const fail = (code, status = 400) => Object.assign(new Error(code), { code, status, [localError]: true });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max
  && !/[\u0000-\u001f\u007f]/u.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const instant = value => text(value, 32) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const hash = value => createHash('sha256').update(value).digest('hex');
const mac = (token, value) => createHmac('sha256', token).update(value).digest('hex');
const equal = (left, right) => typeof left === 'string' && /^[a-f0-9]{64}$/.test(left)
  && timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
const loopback = address => address === '::1' || /^127(?:\.\d{1,3}){3}$/.test(address || '')
  || /^::ffff:127(?:\.\d{1,3}){3}$/i.test(address || '');

function credentials({ targetId, token } = {}) {
  if (!text(targetId, 200)) throw fail('WATCHDOG_TARGET_INVALID');
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw fail('WATCHDOG_TOKEN_INVALID');
  return { targetId, token };
}

function limit(value, fallback, min, max) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min || result > max) throw fail('WATCHDOG_LIMIT_INVALID');
  return result;
}

/** Validate the complete wire signal. No model-provided control or metadata reaches the callback. */
export function validateWatchdogSignal(value, targetId) {
  if (!object(value) || Object.keys(value).some(key => !signalFields.includes(key))
    || !text(value.id, 200) || !text(value.incidentKey, 512) || !text(value.checkId, 200)
    || !['opened', 'escalated', 'resolved'].includes(value.phase) || !['host', 'execution'].includes(value.kind)
    || value.targetId !== targetId || !instant(value.observedAt)
    || !(value.evidenceCursor === null || integer(value.evidenceCursor))
    || !WATCHDOG_SIGNAL_REASONS.includes(value.reasonCode) || !text(value.summary, 1000)) {
    throw fail('WATCHDOG_SIGNAL_INVALID');
  }
  if (value.execution !== undefined) {
    const execution = value.execution;
    if (!object(execution) || Object.keys(execution).length !== executionFields.length
      || Object.keys(execution).some(key => !executionFields.includes(key))
      || !['ticketId', 'assignmentId', 'runId', 'sessionId'].every(key => text(execution[key], 200))
      || !integer(execution.fence) || !Number.isSafeInteger(execution.instructionRevision) || execution.instructionRevision < 1) {
      throw fail('WATCHDOG_SIGNAL_INVALID');
    }
  }
  if (value.kind === 'execution' && !value.execution) throw fail('WATCHDOG_SIGNAL_INVALID');
  if (MAINTENANCE_WATCHDOG_REASONS.includes(value.reasonCode) && (value.kind !== 'host' || value.execution !== undefined)) {
    throw fail('WATCHDOG_SIGNAL_INVALID');
  }
  return structuredClone(value);
}

function requestMac({ method, path, targetId, timestamp, nonce, instanceId, body }, token) {
  return mac(token, ['v1', method, path, targetId, timestamp, nonce, instanceId, hash(body)].join('\n'));
}

/** Sign a fixed-path machine request. The returned headers contain no reusable owner credential. */
export function createWatchdogSignedRequest({ method, targetId, token, instanceId = '', body = '',
  now = Date.now(), nonce = randomBytes(24).toString('base64url') }) {
  credentials({ targetId, token });
  const path = method === 'GET' ? WATCHDOG_OBSERVATION_PATH : method === 'POST' ? WATCHDOG_SIGNAL_PATH : undefined;
  if (!path || !integer(now) || !/^[A-Za-z0-9_-]{24,100}$/.test(nonce) || typeof body !== 'string'
    || (method === 'GET' && body !== '') || (method === 'POST' && !text(instanceId, 100))) throw fail('WATCHDOG_REQUEST_INVALID');
  const timestamp = String(now);
  const headers = { [headerPrefix + 'target']: targetId, [headerPrefix + 'timestamp']: timestamp,
    [headerPrefix + 'nonce']: nonce, [headerPrefix + 'instance']: instanceId,
    [headerPrefix + 'signature']: requestMac({ method, path, targetId, timestamp, nonce, instanceId, body }, token),
    ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) };
  return { path, method, headers, ...(method === 'POST' ? { body } : {}) };
}

function responseMac(token, nonce, status, body) {
  return mac(token, ['v1', 'response', nonce, String(status), hash(body)].join('\n'));
}

function json(value, maximum) {
  const body = JSON.stringify(value);
  if (typeof body !== 'string' || Buffer.byteLength(body) > maximum) throw fail('WATCHDOG_RESPONSE_TOO_LARGE', 503);
  return body;
}

function readBody(request, maximum, signal) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    const cleanup = () => { request.off('data', data); request.off('end', end); request.off('error', error); signal.removeEventListener('abort', abort); };
    const error = () => { cleanup(); reject(fail('WATCHDOG_REQUEST_ABORTED', 408)); };
    const abort = () => { cleanup(); reject(fail('WATCHDOG_REQUEST_TIMEOUT', 408)); };
    const data = chunk => {
      bytes += chunk.length;
      if (bytes > maximum) { cleanup(); request.pause(); reject(fail('WATCHDOG_REQUEST_TOO_LARGE', 413)); return; }
      chunks.push(chunk);
    };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks).toString('utf8')); };
    if (signal.aborted) { abort(); return; }
    request.on('data', data); request.once('end', end); request.once('error', error);
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function bounded(work, signal) {
  signal.throwIfAborted();
  let abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(fail('WATCHDOG_REQUEST_TIMEOUT', 408));
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(work), cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}

/**
 * Mount two loopback-only machine routes on the existing official WebServer.
 * readFacts must return the shared redacted projection, never a transcript/configuration.
 * acceptSignal must durably deduplicate signal.id before acknowledging it; it receives no control action.
 * The per-install instance challenge rejects old POST signatures after a host restart or route reload.
 */
export function installWatchdogObservationRoute({ ctx, readFacts, acceptSignal, config, now = Date.now }) {
  const { targetId, token } = credentials(config);
  const webServer = ctx.get ? ctx.get('webServer') : ctx.webServer;
  if (!webServer?.register || typeof readFacts !== 'function' || typeof acceptSignal !== 'function') {
    throw fail('WATCHDOG_OBSERVATION_UNAVAILABLE', 503);
  }
  const nonceTtlMs = limit(config.nonceTtlMs, 60_000, 1000, 300_000);
  const maxBodyBytes = limit(config.maxBodyBytes, 16_384, 1024, 65_536);
  const maxResponseBytes = limit(config.maxResponseBytes, 524_288, 4096, 4_194_304);
  const maxNonces = limit(config.maxNonces, 4096, 16, 65_536);
  const timeoutMs = limit(config.timeoutMs, 10_000, 100, 60_000);
  const instanceId = randomUUID(), nonces = new Map(), active = new Set();
  let disposed = false;
  const principal = Object.freeze({ kind: 'watchdog', targetId });

  const handler = expectedMethod => async (request, response) => {
    const nonce = request.headers[headerPrefix + 'nonce'];
    const controller = new AbortController();
    active.add(controller);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();
    const disconnected = () => { if (!response.writableEnded) controller.abort(); };
    response.once('close', disconnected);
    const send = (status, value) => {
      if (response.destroyed || response.writableEnded) return;
      const body = json(value, maxResponseBytes);
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff', 'connection': 'close',
        ...(typeof nonce === 'string' && /^[A-Za-z0-9_-]{24,100}$/.test(nonce)
          ? { [headerPrefix + 'response']: responseMac(token, nonce, status, body) } : {}) });
      response.end(body);
    };
    try {
      if (disposed) throw fail('WATCHDOG_OBSERVATION_UNAVAILABLE', 503);
      if (!loopback(request.socket?.remoteAddress)) throw fail('WATCHDOG_LOCAL_ONLY', 403);
      if (request.method !== expectedMethod) throw fail('WATCHDOG_METHOD_DENIED', 405);
      const expectedPath = expectedMethod === 'GET' ? WATCHDOG_OBSERVATION_PATH : WATCHDOG_SIGNAL_PATH;
      if (request.url !== expectedPath) throw fail('WATCHDOG_PATH_DENIED', 400);
      // Browsers and owner's cookies grant no access to this machine-only capability.
      if (request.headers.origin !== undefined || request.headers['sec-fetch-site'] !== undefined) throw fail('WATCHDOG_ORIGIN_DENIED', 403);
      const target = request.headers[headerPrefix + 'target'];
      const timestamp = request.headers[headerPrefix + 'timestamp'];
      const challenge = request.headers[headerPrefix + 'instance'] ?? '';
      const signature = request.headers[headerPrefix + 'signature'];
      const receivedAt = now();
      if (target !== targetId) throw fail('WATCHDOG_TARGET_MISMATCH', 403);
      if (typeof timestamp !== 'string' || !/^\d{1,16}$/.test(timestamp) || !integer(Number(timestamp))
        || Math.abs(receivedAt - Number(timestamp)) > nonceTtlMs
        || typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{24,100}$/.test(nonce)
        || typeof challenge !== 'string') throw fail('WATCHDOG_AUTH_FAILED', 401);
      if (expectedMethod === 'POST' && challenge !== instanceId) throw fail('WATCHDOG_INSTANCE_CHANGED', 409);
      if (expectedMethod === 'GET' && challenge !== '') throw fail('WATCHDOG_AUTH_FAILED', 401);
      const length = request.headers['content-length'];
      if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maxBodyBytes)) throw fail('WATCHDOG_REQUEST_TOO_LARGE', 413);
      if (expectedMethod === 'POST' && request.headers['content-type'] !== 'application/json') throw fail('WATCHDOG_CONTENT_TYPE_DENIED', 415);
      const body = await readBody(request, expectedMethod === 'GET' ? 0 : maxBodyBytes, controller.signal);
      if (!equal(signature, requestMac({ method: expectedMethod, path: expectedPath, targetId, timestamp, nonce, instanceId: challenge, body }, token))) {
        throw fail('WATCHDOG_AUTH_FAILED', 401);
      }
      // A slow body must not outlive its timestamp while another request prunes its consumed nonce.
      const authenticatedAt = now();
      if (Math.abs(authenticatedAt - Number(timestamp)) > nonceTtlMs) throw fail('WATCHDOG_AUTH_FAILED', 401);
      for (const [id, expiresAt] of nonces) if (expiresAt < authenticatedAt) nonces.delete(id);
      if (nonces.has(nonce)) throw fail('WATCHDOG_REPLAY', 409);
      if (nonces.size >= maxNonces) throw fail('WATCHDOG_AUTH_CAPACITY', 429);
      nonces.set(nonce, Number(timestamp) + nonceTtlMs);
      controller.signal.throwIfAborted();
      if (expectedMethod === 'GET') {
        const facts = await bounded(() => readFacts({ signal: controller.signal, principal }), controller.signal);
        controller.signal.throwIfAborted();
        if (!object(facts)) throw fail('WATCHDOG_RESPONSE_INVALID', 503);
        send(200, { protocolVersion: 1, targetId, instanceId, observedAt: new Date(now()).toISOString(), facts });
      } else {
        let submitted;
        try { submitted = JSON.parse(body); } catch { throw fail('WATCHDOG_SIGNAL_INVALID'); }
        const observation = validateWatchdogSignal(submitted, targetId);
        const receipt = await bounded(() => acceptSignal(observation, { signal: controller.signal, principal }), controller.signal);
        controller.signal.throwIfAborted();
        if (!object(receipt) || typeof receipt.accepted !== 'boolean' || receipt.id !== observation.id
          || (receipt.duplicate !== undefined && typeof receipt.duplicate !== 'boolean')) throw fail('WATCHDOG_RECEIPT_INVALID', 503);
        send(200, { accepted: receipt.accepted, id: observation.id,
          ...(receipt.duplicate === undefined ? {} : { duplicate: receipt.duplicate }) });
      }
    } catch (error) {
      // Callback errors may contain provider bodies or credentials. Only this adapter's fixed codes leave it.
      const own = error?.[localError] === true;
      try { send(own ? error.status || 400 : controller.signal.aborted ? 408 : 503,
        { code: own ? error.code : controller.signal.aborted ? 'WATCHDOG_REQUEST_TIMEOUT' : 'WATCHDOG_OBSERVATION_UNAVAILABLE' }); }
      catch { response.destroy(); }
    } finally {
      clearTimeout(timeout); response.off('close', disconnected); active.delete(controller);
    }
  };

  const disposers = [];
  try {
    disposers.push(webServer.register({ kind: 'exact', path: WATCHDOG_OBSERVATION_PATH, handler: handler('GET') }));
    disposers.push(webServer.register({ kind: 'exact', path: WATCHDOG_SIGNAL_PATH, handler: handler('POST') }));
  } catch (error) { for (const dispose of disposers.reverse()) dispose(); throw error; }
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const abort of active) abort.abort();
    for (const remove of disposers.reverse()) remove();
    nonces.clear();
  };
  try { ctx.effect?.(() => dispose); }
  catch (error) { dispose(); throw error; }
  return { instanceId, dispose };
}

function targetOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw fail('WATCHDOG_ORIGIN_INVALID'); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!['http:', 'https:'].includes(url.protocol) || !(loopback(host) || host === 'localhost')
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw fail('WATCHDOG_ORIGIN_INVALID');
  return url.origin;
}

async function responseBody(response, maximum, signal) {
  if (!response.body) throw fail('WATCHDOG_RESPONSE_INVALID', 502);
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw fail('WATCHDOG_RESPONSE_TOO_LARGE', 502);
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Narrow client for the two routes; it never sends cookies, follows redirects, or accepts unsigned facts. */
export function createWatchdogObservationClient({ origin, targetId, token, timeoutMs = 10_000,
  maxResponseBytes = 524_288, fetcher = fetch, now = Date.now }) {
  credentials({ targetId, token });
  origin = targetOrigin(origin);
  timeoutMs = limit(timeoutMs, 10_000, 100, 60_000);
  maxResponseBytes = limit(maxResponseBytes, 524_288, 4096, 4_194_304);
  let instanceId;
  const request = async (method, body, signal) => {
    signal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]);
    const signed = createWatchdogSignedRequest({ method, targetId, token, instanceId: method === 'POST' ? instanceId : '', body, now: now() });
    const nonce = signed.headers[headerPrefix + 'nonce'];
    const { path, ...options } = signed;
    const response = await fetcher(origin + path, { ...options,
      credentials: 'omit', redirect: 'error', signal });
    const resultBody = await responseBody(response, maxResponseBytes, signal);
    if (!equal(response.headers.get(headerPrefix + 'response'), responseMac(token, nonce, response.status, resultBody))) {
      throw fail('WATCHDOG_RESPONSE_UNVERIFIED', 502);
    }
    let result;
    try { result = JSON.parse(resultBody); } catch { throw fail('WATCHDOG_RESPONSE_INVALID', 502); }
    if (!response.ok) throw fail(/^WATCHDOG_[A-Z_]+$/.test(result?.code) ? result.code : 'WATCHDOG_REQUEST_FAILED', response.status);
    return result;
  };
  const readFacts = async ({ signal } = {}) => {
    const result = await request('GET', '', signal);
    if (!object(result) || result.protocolVersion !== 1 || result.targetId !== targetId
      || !text(result.instanceId, 100) || !instant(result.observedAt) || !object(result.facts)) throw fail('WATCHDOG_RESPONSE_INVALID', 502);
    instanceId = result.instanceId;
    return result;
  };
  const sendSignal = async (value, { signal } = {}) => {
    const observation = validateWatchdogSignal(value, targetId);
    if (!instanceId) await readFacts({ signal });
    const receipt = await request('POST', JSON.stringify(observation), signal);
    if (!object(receipt) || Object.keys(receipt).some(key => !['accepted', 'id', 'duplicate'].includes(key))
      || receipt.id !== observation.id || typeof receipt.accepted !== 'boolean'
      || (receipt.duplicate !== undefined && typeof receipt.duplicate !== 'boolean')) throw fail('WATCHDOG_RECEIPT_INVALID', 502);
    return receipt;
  };
  return { readFacts, sendSignal };
}
