import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '../../../deepseek-harness/vendor/cordis/lib/index.js';
import { recoveryStorage } from '../src/execution-evidence.mjs';
import { createSessionRoleAssembly } from '../src/session-role-assembly.mjs';
import { createWatchdogScheduleBridge } from '../src/watchdog-schedule.mjs';
import { installWatchdogObservationRoute } from '../src/watchdog-observation-route.mjs';

test('optional services missing in a real plugin scope preserve domain availability errors', async t => {
  const root = new Context();
  t.after(() => root.fiber.dispose());
  await root.plugin({ name: 'benchgo-optional-service-probe', async apply(ctx) {
    assert.equal(recoveryStorage(ctx), undefined);
    assert.throws(() => createWatchdogScheduleBridge({ ctx }), { code: 'WATCHDOG_SCHEDULE_INVALID' });
    assert.throws(() => installWatchdogObservationRoute({ ctx, config: { targetId: 'test', token: 'a'.repeat(32) },
      readFacts() {}, acceptSignal() {} }), { code: 'WATCHDOG_OBSERVATION_UNAVAILABLE' });
    const role = await createSessionRoleAssembly({ ctx, identity: { sessionId: 'test', role: 'router' },
      database: { bindSessionRole: () => ({}), recordSessionRole() {} } });
    await assert.rejects(role.mount(ctx, { session: {}, model: { current: () => null } }), { code: 'ROLE_SERVICES_UNAVAILABLE' });
  } });
});

test('recovery reads an installed optional service without adding a hard plugin dependency', async t => {
  const root = new Context();
  t.after(() => root.fiber.dispose());
  const storage = { open() {} };
  await root.plugin({ name: 'recovery-storage-provider', apply(ctx) { ctx.provide('sessionPersistence', storage); } });
  await root.plugin({ name: 'benchgo-recovery-service-probe', apply(ctx) {
    assert.throws(() => ctx.sessionPersistence, /without inject/);
    assert.equal(recoveryStorage(ctx).open, storage.open);
  } });
});
