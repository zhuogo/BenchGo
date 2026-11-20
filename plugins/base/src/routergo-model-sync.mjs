import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';
import { applyModelProfile } from '../shared/model-profile-match.mjs';

const empty = () => ({ models: [], excluded: [] });
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const fingerprint = models => createHash('sha256').update(canonical(models)).digest('hex');

function modelConfig(model) {
  return applyModelProfile({ id: model.id, name: model.name }, {
    context: model.contextWindow, max_output: model.maxTokens,
    capabilities: model.capabilities?.length ? model.capabilities : undefined,
    output_modalities: model.outputModalities,
    input_modalities: model.inputModalities, thinking_levels: model.thinkingLevels,
  }, { reasoning: true }).model;
}

function updateModel(local, previous, remote) {
  const model = { ...local }, managed = { ...previous };
  for (const field of new Set([...Object.keys(previous), ...Object.keys(remote)])) {
    if (canonical(local[field]) !== canonical(previous[field])) continue;
    if (Object.hasOwn(remote, field)) {
      model[field] = managed[field] = remote[field];
    } else {
      delete model[field];
      delete managed[field];
    }
  }
  return { model, managed };
}

export function reconcileRouterGoModels(existing, catalog, managed, protectedIds = new Set()) {
  const expected = new Map(managed.models.map(model => [model.id, model]));
  const offered = new Map(catalog.map(model => [model.id, modelConfig(model)]));
  const excluded = new Set(managed.excluded);
  const next = [], automatic = [];
  let added = 0, updated = 0, removed = 0;
  for (const row of existing) {
    const nextRow = offered.get(row.id), prior = expected.get(row.id);
    offered.delete(row.id);
    expected.delete(row.id);
    if (prior && nextRow) {
      const merged = updateModel(row, prior, nextRow);
      next.push(merged.model);
      automatic.push(merged.managed);
      if (canonical(row) !== canonical(merged.model)) updated++;
    } else if (!prior || protectedIds.has(row.id) || canonical(prior) !== canonical(row)) {
      next.push(row);
    } else removed++;
  }
  // A user may remove a previously imported model from the settings list.
  for (const id of expected.keys()) excluded.add(id);
  for (const [id, row] of offered) {
    if (excluded.has(id)) continue;
    next.push(row);
    automatic.push(row);
    added++;
  }
  return { next, managed: { models: automatic, excluded: [...excluded] }, changes: { added, updated, removed } };
}

export function createRouterGoModelState(directory) {
  const volatile = new Map();
  const file = ref => join(directory, `routergo-models-${ref}.json`);
  const write = (ref, value) => directory
    ? writeFileAtomic(file(ref), JSON.stringify(value) + '\n', { mode: 0o600, dirMode: 0o700 })
    : volatile.set(ref, value);
  const read = async ref => {
    if (!directory) return volatile.get(ref);
    try {
      const value = JSON.parse(await readFile(file(ref), 'utf8'));
      const valid = state => Array.isArray(state?.models) && state.models.every(model => typeof model?.id === 'string')
        && Array.isArray(state.excluded) && state.excluded.every(id => typeof id === 'string');
      if (!valid(value?.saved) || (value.pending && (!valid(value.pending.managed) || typeof value.pending.fingerprint !== 'string'))) throw Error('RouterGo model state is invalid');
      return value;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
  return {
    lock: (ref, action) => directory ? withFileLock(file(ref), action) : action(),
    async load(ref, models) {
      const state = await read(ref);
      // A crash between settings commit and finalizing the record is recoverable.
      if (state?.pending && state.pending.fingerprint === fingerprint(models)) return state.pending.managed;
      return state?.saved ?? empty();
    },
    async commit(ref, prior, result, apply) {
      const changed = result.changes.added || result.changes.updated || result.changes.removed;
      if (changed) {
        await write(ref, { saved: prior, pending: { managed: result.managed, fingerprint: fingerprint(result.next) } });
      }
      await apply();
      if (changed || canonical(prior) !== canonical(result.managed)) await write(ref, { saved: result.managed });
    },
  };
}
