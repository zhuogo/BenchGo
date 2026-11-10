import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

const failure = message => Object.assign(new Error(message), { code: 'WATCHDOG_CONFIG_INVALID' });
const integer = (value, fallback, minimum, maximum) => {
  value ??= fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw failure('监督配置数值超出范围');
  return value;
};
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(value);

/** Deployment settings are maintained outside the Agent tool surface. */
export function resolveWatchdogConfig(input = {}) {
  const keys = new Set(['enabled', 'targetId', 'targetUrl', 'tokenFile', 'intervalSeconds', 'probeTimeoutMs', 'observationWindowMs',
    'backoffMaxMs', 'escalationAttempts', 'paused', 'maintenanceUntil', 'retentionChecks', 'sessionId', 'scheduleId']);
  if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).some(key => !keys.has(key))) throw failure('未知监督配置字段');
  if (!identifier(input.targetId)) throw failure('监督目标标识无效');
  let url;
  try { url = new URL(input.targetUrl); } catch { throw failure('监督目标地址无效'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw failure('监督仅支持明确的本机 HTTP origin');
  if (typeof input.tokenFile !== 'string' || !isAbsolute(input.tokenFile)) throw failure('监督凭据必须引用绝对文件路径');
  for (const key of ['enabled', 'paused']) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw failure('监督开关必须为布尔值');
  for (const key of ['sessionId', 'scheduleId']) if (input[key] !== undefined && !identifier(input[key])) throw failure('监督持久标识无效');
  const intervalSeconds = integer(input.intervalSeconds, 60, 60, 86400);
  const maintenanceUntil = input.maintenanceUntil ?? null;
  if (maintenanceUntil !== null && (typeof maintenanceUntil !== 'string' || !Number.isFinite(Date.parse(maintenanceUntil)))) throw failure('维护结束时间无效');
  return Object.freeze({ enabled: input.enabled ?? true, targetId: input.targetId, targetUrl: url.origin, tokenFile: input.tokenFile,
    intervalSeconds, probeTimeoutMs: integer(input.probeTimeoutMs, 5000, 100, 60000),
    observationWindowMs: integer(input.observationWindowMs, 120000, 1000, 86400000),
    backoffMaxMs: integer(input.backoffMaxMs, 900000, intervalSeconds * 1000, 86400000),
    escalationAttempts: integer(input.escalationAttempts, 3, 1, 100), paused: input.paused ?? false, maintenanceUntil,
    retentionChecks: integer(input.retentionChecks, 200, 10, 10000),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}), ...(input.scheduleId ? { scheduleId: input.scheduleId } : {}) });
}

/** Never return a credential through logs, state snapshots, or model tools. */
export async function readWatchdogToken(filename) {
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) throw failure('监督凭据文件无效');
  const token = (await readFile(filename, 'utf8')).trim();
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw failure('监督凭据须为 32–256 位 base64url 字符');
  return token;
}

export function watchdogPublicConfig(config) {
  const { tokenFile, ...safe } = config;
  return safe;
}
