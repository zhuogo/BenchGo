import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';
import { DataOwner } from '../../../../shared/data-owner.mjs';
import { watchdogPublicConfig } from './watchdog-config.mjs';
import { migrateTaskState } from './task-storage-migration.mjs';

const copy = value => structuredClone(value);
export const watchdogDigest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const invalid = () => Object.assign(new Error('监督记录格式无效，已保留原文件'), { code: 'WATCHDOG_STORE_INVALID' });
/** One independent supervisor owns only its observation journal, never the Task ledger. */
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
        lastCheckAt: null, nextProbeAt: null, probeFailures: 0, degraded: [] };
    }
    state = migrateTaskState(state).value;
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
  return store;
}
