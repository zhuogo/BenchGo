import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { platform, arch } from 'node:process';
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';
import manifest from '../package.json' with { type: 'json' };

const endpoint = 'https://benchgo.cn/api/x/feedback/faults/';
const intervalMs = 60_000;
const maxAgeMs = 7 * 24 * 60 * 60 * 1000;
const capacity = 50;
const faults = {
  SIDEBAR_STATE_INTERNAL: { component: 'workbench', stage: 'sidebar.state' },
};

export function createFaultFeedback({ directory, send = fetch, now = Date.now } = {}) {
  const path = join(directory, 'fault-feedback.json');
  const controller = new AbortController();
  const { signal } = controller;
  let sending;

  async function read() {
    try {
      const state = JSON.parse(await readFile(path, 'utf8'));
      if (state.version !== 1 || typeof state.installationId !== 'string'
        || !Array.isArray(state.pending) || typeof state.lastQueued !== 'object' || !state.lastQueued) {
        throw new Error('Invalid fault feedback queue');
      }
      return state;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { version: 1, installationId: randomUUID(), pending: [], lastQueued: {} };
    }
  }

  const write = state => writeFileAtomic(path, JSON.stringify(state) + '\n', { mode: 0o600 });

  async function enqueue(code) {
    if (signal.aborted || !Object.hasOwn(faults, code)) return false;
    return withFileLock(path, async () => {
      const state = await read(), at = now();
      const key = `${manifest.version}/${code}`;
      state.pending = state.pending.filter(report => at - report.occurredAt < maxAgeMs);
      for (const [fault, date] of Object.entries(state.lastQueued)) {
        if (at - date >= intervalMs) delete state.lastQueued[fault];
      }
      if (Object.hasOwn(state.lastQueued, key) || state.pending.length >= capacity) return false;
      state.lastQueued[key] = at;
      state.pending.push({
        schemaVersion: 1, reportId: randomUUID(), installationId: state.installationId,
        code, ...faults[code], pluginVersion: manifest.version, platform, arch, occurredAt: at,
      });
      await write(state);
      return true;
    }, { signal });
  }

  function flush() {
    if (signal.aborted) return Promise.resolve();
    sending ??= withFileLock(path, async () => {
      const state = await read();
      const pending = state.pending.filter(report => now() - report.occurredAt < maxAgeMs);
      if (pending.length !== state.pending.length) {
        state.pending = pending;
        await write(state);
      }
      for (let count = 0; count < 8 && state.pending.length && !signal.aborted; count += 1) {
        const [report] = state.pending;
        let response;
        try {
          const { schemaVersion, reportId, installationId, code, component, stage, pluginVersion, occurredAt } = report;
          response = await send(endpoint, {
            method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
            headers: { 'content-type': 'application/json', 'idempotency-key': reportId },
            body: JSON.stringify({ schemaVersion, reportId, installationId, code, component, stage, pluginVersion,
              platform: report.platform, arch: report.arch, occurredAt }),
          });
        } catch { break; }
        await response.body?.cancel();
        if (!response.ok) break;
        state.pending.shift();
        await write(state);
      }
    }, { signal, waitMs: 12_000 }).finally(() => { sending = undefined; });
    return sending;
  }

  return { enqueue, flush, close: () => controller.abort() };
}

export function mountFaultFeedback(ctx, { directory }) {
  const feedback = createFaultFeedback({ directory });
  const warn = () => ctx.logger?.warn?.('BenchGo fault feedback queue is unavailable');
  ctx.effect(() => {
    void feedback.flush().catch(warn);
    const timer = setInterval(() => { void feedback.flush().catch(warn); }, intervalMs);
    timer.unref?.();
    return () => { clearInterval(timer); feedback.close(); };
  });
  return code => { void feedback.enqueue(code).catch(warn); };
}
