import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { mountModelRetryDefaults } from '../src/model-retry-defaults.mjs';

test('retry migration retries revision conflicts and only touches retry settings', async () => {
  const providers = {
    'example.route/opaque': { retryPolicy: { mode: 'always' }, models: [{ id: 'opaque:model' }] },
    untouched: { baseURL: 'https://example.test' },
  };
  const views = [
    { ns: 'llm-pi-ai', revision: 2, user: { providers }, base: {} },
    { ns: 'llm-deepseek', revision: 4, user: { models: [{ id: 'native' }], retryPolicy: { mode: 'normal', maxRetries: 2 } } },
    { ns: 'llm-deepseek-account', revision: 7, user: {}, base: { retryPolicy: { mode: 'always' } } },
    { ns: 'other', revision: 0, user: { retryPolicy: { mode: 'always' } } },
  ];
  let listener;
  const writes = [], warnings = [];
  const dispose = mountModelRetryDefaults({
    on(event, fn) { assert.equal(event, 'settings/document-updated'); listener = fn; },
    logger: { warn(...args) { warnings.push(args); } },
    settings: {
      describe: () => views,
      async mutate(ns, ops, revision) {
        writes.push({ ns, ops, revision });
        const view = views.find(row => row.ns === ns);
        assert.equal(revision, view.revision++);
        if (ns === 'llm-pi-ai' && revision === 2) {
          providers['example.route/opaque'].models.push({ id: 'concurrent:model' });
          listener(ns);
          throw Object.assign(Error('revision conflict'), { code: 'SETTINGS_CONFLICT' });
        }
        for (const { op, path, value } of ops) {
          const target = path.slice(0, -1).reduce((parent, key) => parent[key], view.user);
          if (op === 'set') target[path.at(-1)] = value;
          else delete target[path.at(-1)];
        }
        listener(ns);
      },
    },
  });
  await setImmediate();
  assert.deepEqual(warnings, []);
  assert.equal(writes.length, 4);
  assert.deepEqual(writes.filter(({ ns }) => ns === 'llm-pi-ai'), [2, 3].map(revision => ({
    ns: 'llm-pi-ai', revision, ops: [{ op: 'unset', path: ['providers', 'example.route/opaque', 'retryPolicy'] }],
  })));
  assert.deepEqual(providers, {
    'example.route/opaque': { models: [{ id: 'opaque:model' }, { id: 'concurrent:model' }] },
    untouched: { baseURL: 'https://example.test' },
  });
  assert.deepEqual(views[1].user, { models: [{ id: 'native' }] });
  assert.deepEqual(views[2].user, { retryPolicy: { mode: 'normal' } });

  for (const { ns } of views) listener(ns);
  await setImmediate();
  assert.equal(writes.length, 4);
  dispose();
});
