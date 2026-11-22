import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { HttpError } from './http.mjs';

const tokenPattern = /^bg_owner_[A-Za-z0-9_-]{43}$/u;
const digest = token => createHash('sha256').update(token).digest();
export function integrationBearer(headers) {
  const value = headers.get?.('authorization') ?? headers.authorization;
  const token = typeof value === 'string' && /^Bearer (.+)$/i.exec(value)?.[1];
  return tokenPattern.test(token || '') ? token : undefined;
}

export async function useIntegrationToken(credentials, scope, operation, { token, revision } = {}) {
  const key = `benchgo-plugin/integration-${digest(scope).toString('hex')}`;
  const snapshot = current => ({ token: current.token, revision: current.revision });
  if (operation === 'verify') {
    const current = (await credentials.readRecord(key))?.payload;
    return { valid: Boolean(tokenPattern.test(token || '') && current?.token && timingSafeEqual(digest(token), digest(current.token))) };
  }
  if (operation !== 'read' && operation !== 'rotate') throw new HttpError('未知 API Token 操作', 400);
  let result;
  await credentials.modifyRecord(key, existing => {
    const current = existing?.payload;
    if (operation === 'rotate' && current?.revision !== revision) throw new HttpError('API Token 已轮换，请重新打开文档', 409);
    if (operation === 'read' && current) { result = snapshot(current); return undefined; }
    result = { token: 'bg_owner_' + randomBytes(32).toString('base64url'), revision: (current?.revision ?? 0) + 1 };
    return { kind: 'grant', payload: result };
  });
  return result;
}
