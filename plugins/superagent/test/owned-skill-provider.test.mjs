import test from 'node:test';
import assert from 'node:assert/strict';
import { registerOwnedSkillProvider, OWNED_SKILL_PROVIDER } from '../src/owned-skill-provider.mjs';

function fixture() {
  const rows = new Map([
    ['check-build', { id: 'check-build', state: 'active', hash: 'one', body: 'Procedure', source: { description: 'Verify builds' } }],
    ['old', { id: 'old', state: 'stale', hash: 'two', body: 'Old', source: {} }],
    ['gone', { id: 'gone', state: 'archived', hash: 'three', body: 'Gone', source: {} }],
  ]);
  const abort = new AbortController(), uses = [], listeners = new Map();
  let provider, invalidations = 0, disposed = 0;
  const adapter = registerOwnedSkillProvider({
    ctx: { on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name); } },
    skills: { registerProvider(factory) {
      provider = factory({ signal: abort.signal, invalidate() { invalidations++; } });
      return () => { disposed++; abort.abort(); };
    } },
    database: {
      listOwnedSkills: () => [...rows.values()], getOwnedSkill: id => rows.get(id),
      recordOwnedSkillUse: (id, input) => uses.push({ id, ...input }),
    },
  });
  return { adapter, provider, rows, uses, listeners, stats: () => ({ invalidations, disposed }) };
}

test('official provider projects only available owned skills; catalog and preview do not count use', async () => {
  const f = fixture(), catalog = await f.provider.list({});
  assert.deepEqual(catalog.map(x => x.name), ['benchgo-check-build', 'benchgo-old']);
  assert.equal(catalog[0].provider, OWNED_SKILL_PROVIDER);
  assert.equal(catalog[0].rank, 700);
  assert.equal((await f.provider.get(catalog[0], {})).content, 'Procedure');
  assert.deepEqual(f.uses, []);
});

test('official final tool outcomes count successful owned loads with stable session/call identities', () => {
  const f = fixture(), result = { isError: false, value: { name: 'benchgo-check-build', provider: OWNED_SKILL_PROVIDER, content: 'Procedure' } };
  const exec = { name: 'skill', arguments: { name: 'benchgo-check-build' }, callId: 'call:1', agent: { session: { id: 'session:1' } } };
  const observe = f.listeners.get('tools/result');
  observe(exec, result); observe(exec, result);
  assert.equal(f.uses.length, 2);
  assert.equal(f.uses[0].eventId, f.uses[1].eventId); // Store deduplicates durable event IDs.
  observe({ ...exec, agent: { session: { id: 'session:2' } } }, result);
  assert.notEqual(f.uses[0].eventId, f.uses[2].eventId);
  observe({ ...exec, parent: Symbol('ptc'), callId: 'call:1:ptc:1' }, result);
  assert.notEqual(f.uses[0].eventId, f.uses[3].eventId);
});

test('errors, unrelated tools/providers, mismatched bodies and missing execution identity never count', () => {
  const f = fixture(), value = { name: 'benchgo-check-build', provider: OWNED_SKILL_PROVIDER, content: 'Procedure' };
  const exec = { name: 'skill', arguments: { name: value.name }, callId: 'call', agent: { session: { id: 'session' } } };
  const observe = f.listeners.get('tools/result');
  observe(exec, { isError: true, value });
  observe({ ...exec, name: 'read' }, { isError: false, value });
  observe(exec, { isError: false, value: { ...value, provider: 'filesystem' } });
  observe(exec, { isError: false, value: { ...value, content: 'changed' } });
  observe({ ...exec, arguments: { name: 'other' } }, { isError: false, value });
  observe({ ...exec, agent: undefined }, { isError: false, value });
  observe({ ...exec, callId: '' }, { isError: false, value });
  assert.deepEqual(f.uses, []);
  f.adapter.dispose();
  assert.equal(f.listeners.size, 0);
  observe(exec, { isError: false, value });
  assert.deepEqual(f.uses, []);
});

test('stale catalog cannot load changed or archived body', async () => {
  const f = fixture(), [candidate] = await f.provider.list({});
  f.rows.get('check-build').hash = 'changed';
  assert.equal(await f.provider.get(candidate, {}), undefined);
  const [fresh] = await f.provider.list({});
  f.rows.get('check-build').state = 'archived';
  assert.equal(await f.provider.get(fresh, {}), undefined);
  assert.equal(f.stats().invalidations, 2);
});

test('explicit invocation counts only a step-local owned provider load followed by durable injection', async () => {
  const f = fixture(), session = { id: 'session' }, agent = { session };
  const [candidate] = await f.provider.list({});
  const inject = f.listeners.get('session/event');
  const event = { type: 'user/message', data: { id: 'invocation', source: { kind: 'skill-invocation', name: candidate.name }, content: [{ type: 'text', text: '<skill_instructions>\nProcedure\n</skill_instructions>' }] } };
  await f.provider.get(candidate, { scope: agent });
  inject(session, event);
  assert.equal(f.uses.length, 0, 'preview has no step provenance');
  await f.listeners.get('agent/pre-step')({ agent }, async () => ({ kind: 'enter' }));
  await f.provider.get(candidate, { scope: agent });
  assert.equal(f.uses.length, 0, 'loading alone is not a use');
  inject(session, event);
  assert.equal(f.uses.length, 1);
  await f.listeners.get('agent/pre-step')({ agent }, async () => ({ kind: 'enter' }));
  inject(session, { ...event, data: { ...event.data, id: 'foreign-invocation' } });
  assert.equal(f.uses.length, 1, 'previous step does not authenticate a foreign load');
  f.adapter.dispose();
  assert.equal(f.listeners.size, 0);
});

test('usage requires exact provider and available identity; event identity passes unchanged', () => {
  const f = fixture();
  assert.equal(f.adapter.recordUse({ name: 'benchgo-check-build', provider: 'filesystem', eventId: 'event' }), false);
  assert.equal(f.adapter.recordUse({ name: 'benchgo-gone', provider: OWNED_SKILL_PROVIDER, eventId: 'event' }), false);
  assert.equal(f.adapter.recordUse({ name: 'benchgo-check-build', provider: OWNED_SKILL_PROVIDER, eventId: 'session:42', now: 123 }), true);
  assert.deepEqual(f.uses, [{ id: 'check-build', eventId: 'session:42', now: 123 }]);
});

test('cancellation and idempotent teardown prohibit further provider work', async () => {
  const f = fixture(), abort = new AbortController(); abort.abort();
  await assert.rejects(f.provider.list({ signal: abort.signal }));
  f.adapter.dispose(); f.adapter.dispose();
  await assert.rejects(f.provider.list({}));
  assert.equal(f.adapter.recordUse({ name: 'benchgo-check-build', provider: OWNED_SKILL_PROVIDER, eventId: 'late' }), false);
  assert.equal(f.stats().disposed, 1);
});
