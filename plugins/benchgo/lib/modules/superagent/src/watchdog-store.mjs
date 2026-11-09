import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';
import { DataOwner } from '../../../../shared/data-owner.mjs';
import { watchdogPublicConfig } from './watchdog-config.mjs';
import { redactExecutionText } from './execution-summary-input.mjs';

const copy = value => structuredClone(value);
export const watchdogDigest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const invalid = () => Object.assign(new Error('监督记录格式无效，已保留原文件'), { code: 'WATCHDOG_STORE_INVALID' });
const classifications = new Set(['no-progress', 'off-target', 'waiting', 'insufficient-evidence']);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const count = (value, fallback = 0) => Number.isSafeInteger(value) && value >= 0 ? value : fallback;
function auxiliaryRecord(value) {
  if (value?.kind !== 'judgement' || !text(value.ticketId) || !text(value.runId)
    || !Number.isSafeInteger(value.instructionRevision) || value.instructionRevision < 1
    || !Number.isSafeInteger(value.watermark) || value.watermark < 0) throw invalid();
  const result = value.result || {}, tracking = value.tracking || {};
  return { kind: 'judgement', ticketId: value.ticketId, runId: value.runId,
    instructionRevision: value.instructionRevision, watermark: value.watermark,
    status: ['running', 'judged', 'skipped', 'degraded'].includes(value.status) ? value.status : 'degraded',
    code: /^[A-Z][A-Z0-9_]{0,79}$/.test(value.code || '') ? value.code : 'UNKNOWN',
    startedAt: Number.isFinite(value.startedAt) ? value.startedAt : null,
    completedAt: Number.isFinite(value.completedAt) ? value.completedAt : null,
    result: { classification: classifications.has(result.classification) ? result.classification : 'insufficient-evidence',
      outputRelevance: ['relevant', 'irrelevant'].includes(result.outputRelevance) ? result.outputRelevance : 'unknown',
      reason: redactExecutionText(String(result.reason || ''), 300), signalEligible: result.signalEligible === true,
      evidenceWatermark: count(result.evidenceWatermark, null),
      evidenceRefs: Array.isArray(result.evidenceRefs) ? result.evidenceRefs.filter(text).slice(0, 24) : [],
      uncertainty: ['low', 'medium', 'high'].includes(result.uncertainty) ? result.uncertainty : 'high', hits: count(result.hits) },
    tracking: { lastAttemptAt: Number.isFinite(tracking.lastAttemptAt) ? tracking.lastAttemptAt : null,
      lastJudgedWatermark: count(tracking.lastJudgedWatermark, -1),
      lastEvidenceFingerprint: /^[a-f0-9]{64}$/.test(tracking.lastEvidenceFingerprint || '') ? tracking.lastEvidenceFingerprint : null,
      classification: classifications.has(tracking.classification) ? tracking.classification : null, hits: count(tracking.hits) } };
}

/** One independent supervisor owns only its observation journal, never the Ticket ledger. */
export async function createWatchdogStore({ directory, config, now = Date.now }) {
  const root = join(directory, 'watchdog'), filename = join(root, 'state.json');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const owner = new DataOwner(root);
  await owner.open();
  let state, chain = Promise.resolve(), closed = false;
  const persist = value => writeFileAtomic(filename, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, dirMode: 0o700 });
  try {
    try {
      const metadata = await lstat(filename);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 64 * 1024 * 1024) throw invalid();
      state = JSON.parse(await readFile(filename, 'utf8'));
      if (state.schemaVersion !== 1 || state.targetId !== config.targetId || !state.sessionId || !Array.isArray(state.checks)
        || !Array.isArray(state.incidents) || !Array.isArray(state.signals) || !state.candidates || !Array.isArray(state.configHistory)
        || !Number.isSafeInteger(state.configRevision)) throw invalid();
      if (config.sessionId && config.sessionId !== state.sessionId || config.scheduleId && state.scheduleId && config.scheduleId !== state.scheduleId) throw invalid();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      state = { schemaVersion: 1, targetId: config.targetId, sessionId: config.sessionId || `benchgo-watchdog-${randomUUID()}`,
        scheduleId: config.scheduleId || null, configRevision: 0, configHistory: [], checks: [], incidents: [], signals: [], candidates: {},
        lastCheckAt: null, nextProbeAt: null, probeFailures: 0, degraded: ['MODEL_JUDGE_UNCONFIGURED'] };
    }
    state.auxiliaryActivity ??= [];
    if (!Array.isArray(state.auxiliaryActivity)) throw invalid();
    const current = watchdogPublicConfig(config), hash = watchdogDigest(current);
    if (state.configHistory.at(-1)?.hash !== hash) {
      state.configRevision++;
      state.configHistory.push({ revision: state.configRevision, at: new Date(now()).toISOString(), hash, config: current });
      state.configHistory = state.configHistory.slice(-20);
    }
    // A crash cannot turn an unfinished probe into a healthy completed check.
    for (const check of state.checks) if (check.status === 'running') Object.assign(check, { status: 'interrupted', completedAt: null, code: 'WATCHDOG_RESTARTED' });
    await persist(state);
  } catch (error) { await owner.close(); throw error; }
  const store = {
    filename,
    snapshot: () => copy(state),
    update(operation) {
      if (closed) return Promise.reject(new Error('监督记录已关闭'));
      const pending = chain.then(async () => {
        const next = copy(state), result = operation(next);
        if (result?.then) throw new Error('监督记录事务不能等待外部操作');
        await persist(next); state = next; return copy(result);
      });
      chain = pending.catch(() => {});
      return pending;
    },
    async close() { if (closed) return; closed = true; await chain; await owner.close(); },
  };
  store.recordAuxiliaryActivity = record => {
    const safe = auxiliaryRecord(record);
    return store.update(next => {
      next.auxiliaryActivity.push(safe);
      next.auxiliaryActivity = next.auxiliaryActivity.slice(-config.retentionChecks * 4);
      return safe;
    });
  };
  store.latestAuxiliaryActivity = ({ kind, ticketId, runId, instructionRevision }) => copy(state.auxiliaryActivity.findLast(row =>
    row.kind === kind && row.ticketId === ticketId && row.runId === runId && row.instructionRevision === instructionRevision) ?? null);
  return store;
}
