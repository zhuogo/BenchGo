import { createHash, randomUUID } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { mkdir, lstat, realpath, readdir, readFile, writeFile, rename, unlink, rmdir, chmod, open } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join, dirname } from 'node:path';

const hash = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const inside = (root, path) => { const part = relative(root, path); return part && !isAbsolute(part) && part !== '..' && !part.startsWith('../') && !part.startsWith('..\\'); };
const fail = (code, message) => Object.assign(new Error(message), { code });
const ignored = name => ['.git', 'node_modules', '.pnpm-store'].includes(name) || /^\.env(?:\.|$)/i.test(name) || /(?:^id_(?:rsa|ed25519)$|\.(?:pem|key|p12|pfx)$)/i.test(name);

/** Separate, valid Git object storage; never opens or changes the project's Git index. */
export function createWorkerCheckpointStore({ directory, onObservation, onObservationError, maxFiles = 10000, maxBytes = 128 * 1024 * 1024, maxFileBytes = 32 * 1024 * 1024 } = {}) {
  if (!isAbsolute(directory || '')) throw new Error('Checkpoint storage requires an absolute directory');
  const root = resolve(directory), queues = new Map(), coverageCache = new Map(), observing = new Map();
  let ready;
  const init = () => ready ||= (async () => {
    await mkdir(join(root, 'objects'), { recursive: true, mode: 0o700 });
    await mkdir(join(root, 'records'), { recursive: true, mode: 0o700 });
    await mkdir(join(root, 'refs', 'heads'), { recursive: true, mode: 0o700 });
    await writeFile(join(root, 'HEAD'), 'ref: refs/heads/checkpoints\n', { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    await writeFile(join(root, 'config'), '[core]\n\trepositoryformatversion = 0\n\tbare = true\n', { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  })();
  async function locked(key, action) {
    const previous = queues.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(action); queues.set(key, next);
    try { return await next; } finally { if (queues.get(key) === next) queues.delete(key); }
  }
  async function blob(content) {
    const raw = Buffer.concat([Buffer.from(`blob ${content.length}\0`), content]);
    const id = createHash('sha1').update(raw).digest('hex');
    await mkdir(join(root, 'objects', id.slice(0, 2)), { recursive: true });
    await writeFile(join(root, 'objects', id.slice(0, 2), id.slice(2)), deflateSync(raw), { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    return id;
  }
  async function content(id) {
    if (!/^[a-f0-9]{40}$/.test(id || '')) throw new Error('Invalid checkpoint blob');
    const raw = inflateSync(await readFile(join(root, 'objects', id.slice(0, 2), id.slice(2))), { maxOutputLength: maxFileBytes + 100 });
    if (createHash('sha1').update(raw).digest('hex') !== id) throw new Error('Corrupt checkpoint blob');
    const end = raw.indexOf(0), bytes = raw.subarray(end + 1);
    if (end < 0 || raw.subarray(0, end).toString() !== `blob ${bytes.length}`) throw new Error('Invalid checkpoint blob header');
    return bytes;
  }
  async function save(record) {
    const path = join(root, 'records', `${record.id}.json`), temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    try { await rename(temporary, path); } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  async function scan(directory, persist = true) {
    if (!isAbsolute(directory || '')) throw new Error('Checkpoint workspace requires an absolute path');
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Checkpoint workspace must be a real directory');
    const actual = await realpath(directory);
    if (actual === root || inside(actual, root)) throw new Error('Checkpoint storage must be outside the workspace');
    const files = Object.create(null); let count = 0, total = 0;
    const sameStat = (before, after) => ['ino', 'dev', 'size', 'mode', 'nlink', 'ctimeMs', 'mtimeMs'].every(key => before[key] === after[key]);
    async function walk(path, prefix, before) {
      if (!before.isDirectory() || before.isSymbolicLink()) throw fail('CHECKPOINT_UNSAFE_PATH', 'Checkpoint requires a real directory');
      for (const name of (await readdir(path)).sort()) {
        if (ignored(name)) continue;
        const file = join(path, name), key = prefix ? `${prefix}/${name}` : name, stat = await lstat(file);
        if (++count > maxFiles) throw fail('CHECKPOINT_LIMIT', 'Checkpoint file limit exceeded');
        if (stat.isSymbolicLink()) throw fail('CHECKPOINT_UNSAFE_PATH', 'Checkpoint cannot follow symbolic links');
        if (stat.isDirectory()) { await walk(file, key, stat); continue; }
        if (!stat.isFile() || stat.nlink > 1) throw fail('CHECKPOINT_UNSAFE_PATH', 'Checkpoint requires regular, unlinked files');
        total += stat.size;
        if (stat.size > maxFileBytes || total > maxBytes) throw fail('CHECKPOINT_LIMIT', 'Checkpoint byte limit exceeded');
        const handle = await open(file, 'r');
        try {
          const opened = await handle.stat();
          if (!opened.isFile() || !sameStat(stat, opened)) throw fail('CHECKPOINT_CHANGED', 'Workspace changed while checkpointing');
          const bytes = await handle.readFile(), after = await handle.stat();
          if (bytes.length !== stat.size || !after.isFile() || !sameStat(opened, after)) throw fail('CHECKPOINT_CHANGED', 'Workspace changed while checkpointing');
          files[key] = { hash: hash(bytes), mode: stat.mode & 0o777, size: bytes.length, ...(persist ? { blob: await blob(bytes) } : {}) };
        } finally { await handle.close(); }
      }
      // Detect names added/removed or directory replacement during this same
      // traversal; a partial manifest must never become complete evidence.
      const after = await lstat(path);
      if (!after.isDirectory() || after.isSymbolicLink() || !sameStat(before, after)) throw fail('CHECKPOINT_CHANGED', 'Workspace changed while checkpointing');
    }
    await walk(actual, '', info);
    return { directory: actual, files };
  }
  const comparable = file => file ? { hash: file.hash, mode: file.mode, size: file.size } : null;
  const identical = (a, b) => same(comparable(a), comparable(b));
  function observation(record) {
    const before = record.before.files, after = record.after.files;
    let added = 0, modified = 0, deleted = 0, unchanged = 0;
    for (const path of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (!before[path]) added++;
      else if (!after[path]) deleted++;
      else if (identical(before[path], after[path])) unchanged++;
      else modified++;
    }
    return { observationId: record.id, ticketId: record.ticketId, assignmentId: record.assignmentId, runId: record.runId,
      fence: record.fence, instructionRevision: record.instructionRevision, callId: record.callId ?? null, sequence: record.sequence,
      startedAt: new Date(record.createdAt).toISOString(), completedAt: new Date(record.completedAt).toISOString(), directory: record.before.directory,
      coverage: { kind: 'protected-workspace-files', complete: true, truncated: false, exclusionsVersion: 1,
        externalEffects: 'not-observed', conversationOutputs: 'not-observed' },
      comparison: { beforeFiles: Object.keys(before).length, afterFiles: Object.keys(after).length, added, modified, deleted, unchanged,
        netChanged: added + modified + deleted > 0 } };
  }
  const unknownCoverage = () => ({ known: false, complete: false, firstSequence: null, lastSequence: null, pending: 0, failed: 0, restored: false });
  function rememberCoverage(rows, runId) {
    const runs = new Set(rows.map(row => row.runId));
    if (runId) runs.add(runId);
    for (const id of runs) {
      const records = rows.filter(row => row.runId === id), actions = records.filter(row => row.kind === 'action').sort((a, b) => a.sequence - b.sequence);
      const pending = actions.filter(row => row.state !== 'complete').length;
      let failed = actions.filter(row => row.state === 'complete' && row.observationState !== 'recorded').length;
      if (actions.some((row, index) => row.sequence !== index)) failed = Math.max(failed, 1);
      const restored = records.some(row => row.kind === 'restore' || row.restoredAt);
      const value = { known: true, complete: actions.length > 0 && !pending && !failed && !restored,
        firstSequence: actions[0]?.sequence ?? null, lastSequence: actions.at(-1)?.sequence ?? null, pending, failed, restored };
      coverageCache.delete(id); coverageCache.set(id, value);
      // This is a bounded derived cache, never a second durable execution ledger.
      if (coverageCache.size > 256) coverageCache.delete(coverageCache.keys().next().value);
    }
  }
  async function list({ ticketId, runId } = {}) {
    await init();
    const rows = [];
    for (const name of await readdir(join(root, 'records'))) {
      if (!/^[a-f0-9-]+\.json$/.test(name)) continue;
      const row = JSON.parse(await readFile(join(root, 'records', name), 'utf8'));
      if ((!ticketId || row.ticketId === ticketId) && (!runId || row.runId === runId)) rows.push(row);
    }
    rememberCoverage(rows, runId);
    return rows.sort((a, b) => a.createdAt - b.createdAt || a.sequence - b.sequence);
  }
  async function preview(runId) {
    if (typeof runId !== 'string' || !runId) throw new Error('Checkpoint run identity is required');
    const records = (await list({ runId })).filter(row => row.kind === 'action');
    if (!records.length) throw fail('CHECKPOINT_MISSING', 'No action checkpoint is available');
    if (records.some(row => row.state !== 'complete')) throw fail('CHECKPOINT_UNCERTAIN', 'An unfinished action must be reconciled before rollback');
    if (records.some(row => row.restoredAt)) throw fail('CHECKPOINT_RESTORED', 'This round has already been restored');
    const directory = records[0].before.directory;
    if (records.some(row => row.before.directory !== directory || row.after.directory !== directory)) throw new Error('Checkpoint workspace identity changed');
    const current = await scan(directory, false), desired = { ...current.files }, conflicts = new Set(), changed = new Set();
    if (current.directory !== directory) throw fail('CHECKPOINT_UNSAFE_PATH', 'Checkpoint workspace identity changed');
    // Reverse each action independently. Edits made between actions remain intact;
    // touching the same path between actions is a conflict, never a forced overwrite.
    for (const row of [...records].reverse()) {
      for (const path of new Set([...Object.keys(row.before.files), ...Object.keys(row.after.files)])) {
        const before = row.before.files[path], after = row.after.files[path];
        if (identical(before, after)) continue;
        changed.add(path);
        if (!identical(desired[path], after)) { conflicts.add(path); continue; }
        if (before) desired[path] = before; else delete desired[path];
      }
    }
    // A later user file below a directory that would become a file cannot be
    // retained alongside that file. Report this before changing any path.
    for (const path of Object.keys(desired)) {
      const parts = path.split('/');
      while (parts.length > 1) { parts.pop(); const parent = parts.join('/'); if (desired[parent]) conflicts.add(parent); }
    }
    const changes = [...changed].sort().filter(path => !identical(current.files[path], desired[path])).map(path => ({ path, action: !desired[path] ? 'delete' : !current.files[path] ? 'restore' : 'replace', before: comparable(current.files[path]), after: comparable(desired[path]) }));
    const token = hash(JSON.stringify({ records: records.map(row => row.id), current, changes, conflicts: [...conflicts].sort() }));
    return { runId, directory, changes, conflicts: [...conflicts].sort(), token, excluded: ['.git', 'node_modules', '.pnpm-store', '.env*', '*.pem', '*.key', '*.p12', '*.pfx', 'id_rsa', 'id_ed25519'], externalEffectsReverted: false, desired, records };
  }
  const publicPreview = ({ desired, records, ...result }) => result;
  return {
    observationCoverage(runId) {
      const value = coverageCache.get(runId) || unknownCoverage(), pending = Math.max(value.pending, observing.get(runId) || 0);
      return { ...value, pending, complete: value.complete && pending === 0 };
    },
    async assertRunnable(runId) {
      if ((await list({ runId })).some(row => row.restoredAt || row.kind === 'restore')) throw fail('CHECKPOINT_RESTORED', 'Restored execution cannot continue; create a new execution');
    },
    async protect({ runId, ticketId, assignmentId, directory, callId, fence, instructionRevision }, dispatch) {
      if (![runId, ticketId, assignmentId].every(value => typeof value === 'string' && value)) throw new Error('Checkpoint requires execution ownership');
      // Include callers waiting for the existing per-run lock in tail coverage.
      observing.set(runId, (observing.get(runId) || 0) + 1);
      try { return await locked(runId, async () => {
        await init();
        const existing = await list({ runId });
        if (existing.some(row => row.kind === 'action' && row.state !== 'complete')) throw fail('CHECKPOINT_UNCERTAIN', 'Previous action checkpoint is unfinished');
        if (existing.some(row => row.restoredAt || row.kind === 'restore')) throw fail('CHECKPOINT_RESTORED', 'Restored execution cannot continue');
        const record = { id: randomUUID(), kind: 'action', runId, ticketId, assignmentId, callId, fence, instructionRevision,
          createdAt: Date.now(), sequence: existing.length, state: 'pending', before: await scan(directory) };
        const remember = () => rememberCoverage([...existing, record], runId);
        remember();
        await save(record);
        try { return await dispatch(); }
        finally {
          // Failure/cancellation may already have changed files. Record its after-state
          // too; a process crash leaves pending state and intentionally blocks restore.
          record.after = await scan(directory);
          if (record.after.directory !== record.before.directory) throw fail('CHECKPOINT_UNSAFE_PATH', 'Checkpoint workspace identity changed');
          record.state = 'complete'; record.completedAt = Date.now(); await save(record);
          remember();
          if (onObservation) {
            try {
              await onObservation(observation(record));
              record.observationState = 'recorded'; await save(record); remember();
            }
            catch (error) {
              // The official dispatch already happened. A journal outage is an
              // observation gap, never a reason to fail or replay that action.
              record.observationState = 'failed';
              remember();
              await save(record).catch(() => {});
              try { await onObservationError?.({ observationId: record.id, runId, code: 'CHECKPOINT_OBSERVATION_FAILED' }, error); } catch { /* Isolate diagnostics too. */ }
            }
          }
        }
      }); } finally {
        const pending = observing.get(runId) - 1;
        if (pending) observing.set(runId, pending); else observing.delete(runId);
      }
    },
    async list(filter) { return (await list(filter)).map(({ before, after, ...row }) => ({ ...row, directory: before?.directory, files: Object.keys(before?.files || {}).length })); },
    async preview(runId) { return locked(runId, async () => publicPreview(await preview(runId))); },
    async restore(runId, { token, beforeWrite } = {}) {
      return locked(runId, async () => {
        const plan = await preview(runId);
        if (!token || token !== plan.token) throw fail('CHECKPOINT_CHANGED', 'Rollback preview changed; review it again');
        if (plan.conflicts.length) throw fail('CHECKPOINT_CONFLICT', `Later changes must be preserved: ${plan.conflicts.join(', ')}`);
        const backup = { id: randomUUID(), kind: 'restore', runId, ticketId: plan.records[0].ticketId, assignmentId: plan.records[0].assignmentId, createdAt: Date.now(), sequence: plan.records.length, state: 'pending', before: await scan(plan.directory) };
        rememberCoverage([...plan.records, backup], runId);
        await save(backup);
        // Verify again after the recovery backup has been persisted.
        if ((await preview(runId)).token !== token) throw fail('CHECKPOINT_CHANGED', 'Workspace changed while preparing rollback');
        const bytes = new Map();
        for (const change of plan.changes) if (plan.desired[change.path]) bytes.set(change.path, await content(plan.desired[change.path].blob));
        // Delete children before recreating a former file at their parent path.
        // Delete former files before recreating directories below those paths.
        const ordered = [...plan.changes].sort((a, b) => Number(a.action !== 'delete') - Number(b.action !== 'delete') || (a.action === 'delete' ? b.path.length - a.path.length : a.path.length - b.path.length));
        for (const change of ordered) {
          const path = resolve(plan.directory, ...change.path.split('/'));
          if (!inside(plan.directory, path)) throw new Error('Invalid checkpoint path');
          // Whole-workspace preflight catches symlink replacements and changed files.
          const observed = await scan(plan.directory, false);
          if (observed.directory !== plan.directory || !identical(observed.files[change.path], backup.before.files[change.path])) throw fail('CHECKPOINT_CHANGED', 'Workspace changed during rollback; recovery backup retained');
          await beforeWrite?.();
          if (!plan.desired[change.path]) await unlink(path);
          else {
            const existing = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
            // A directory replaced a former file. Only remove it if all recorded
            // children are gone; unrelated user files keep it nonempty and safe.
            if (existing?.isDirectory() && !existing.isSymbolicLink()) {
              const children = ordered.filter(row => row.action === 'delete' && row.path.startsWith(`${change.path}/`));
              const empty = new Set([path]);
              for (const child of children) {
                let folder = dirname(resolve(plan.directory, ...child.path.split('/')));
                while (folder !== path && inside(path, folder)) { empty.add(folder); folder = dirname(folder); }
              }
              for (const folder of [...empty].sort((a, b) => b.length - a.length)) await rmdir(folder).catch(error => { if (error.code !== 'ENOENT') throw error; });
            }
            await mkdir(dirname(path), { recursive: true });
            const temporary = join(dirname(path), `.benchgo-restore-${randomUUID()}`);
            try { await writeFile(temporary, bytes.get(change.path), { flag: 'wx', mode: plan.desired[change.path].mode }); await rename(temporary, path); await chmod(path, plan.desired[change.path].mode); }
            finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
          }
        }
        backup.after = await scan(plan.directory); backup.state = 'complete'; await save(backup);
        for (const row of plan.records) { row.restoredAt = Date.now(); row.restoreId = backup.id; await save(row); }
        rememberCoverage([...plan.records, backup], runId);
        return { runId, restored: plan.changes.map(row => row.path), backupId: backup.id, externalEffectsReverted: false };
      });
    },
  };
}
