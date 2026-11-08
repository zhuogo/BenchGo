import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const script = `
import assert from 'node:assert/strict';
import { Context, Service } from './deepseek-harness/vendor/cordis/src/index.ts';
import * as hostScopes from './deepseek-harness/packages/core/scope/src/index.ts';
import SystemPrompt from './deepseek-harness/packages/core/system-prompt/src/index.ts';
import Tools from './deepseek-harness/packages/core/tools/src/index.ts';
import { loadScopes } from './plugins/benchgo/node_modules/dsh-ops/lib/adapter/dsh/host.js';
import { integration } from './plugins/benchgo/node_modules/dsh-ops/lib/integration/index.js';
const opsScopes = await loadScopes();
assert.equal(opsScopes, hostScopes, 'OPS must load the exact host scope module');
const root = new Context();
try {
  await root.plugin(SystemPrompt, {});
  await root.plugin(Tools);
  // Publication needs availability, but this fixture must never execute a tool.
  await root.plugin(class extends Service { constructor(ctx) { super(ctx, 'sandboxPolicy'); } });
  await root.plugin(class extends Service { constructor(ctx) { super(ctx, 'subprocess'); } });
  const agent = { id: 'scope-identity-probe', session: { header: { agentPreset: 'identity-probe' } } };
  await root.plugin({ inject: ['tools', 'systemPrompt', 'sandboxPolicy', 'subprocess'], apply(ctx) {
    agent.ctx = hostScopes.createScope(ctx, agent).ctx;
  } });
  assert.equal(opsScopes.scopeOf(agent.ctx), agent);
  await root.plugin(integration({ preset: 'identity-probe', profile: 'native', discovery: false,
    residentNames: ['read_files'], replaceOfficial: false, promptPolicy: false }));
  // Injected publication mounts asynchronously after the integration fiber.
  for (const deadline = Date.now() + 2000; !root.tools.get('ops_read_files', agent) && Date.now() < deadline;) {
    await new Promise(resolve => setTimeout(resolve, 10));
    await root.parallel('agent/created', { agent });
  }
  assert.ok(root.tools.get('ops_read_files', agent), 'OPS public integration must publish a scoped native read tool');
  assert.equal(root.tools.get('ops_read_files'), undefined, 'scoped publication must not leak globally');
  const sibling = {};
  assert.equal(root.tools.get('ops_read_files', sibling), undefined, 'scoped publication must not leak to sibling agents');
  console.log('shared scope identity and public OPS scoped publication passed');
} finally { await root.fiber.dispose(); }
`;

function run(script, withLoader = true) {
  return spawnSync(process.execPath, [...(withLoader ? ['--import', new URL('./source-host-loader.mjs', import.meta.url).href] : []),
    '--import', new URL('../deepseek-harness/node_modules/tsx/dist/esm/index.mjs', import.meta.url).href,
    '--input-type=module', '--eval', script], {
    cwd: fileURLToPath(root), encoding: 'utf8', timeout: 30000,
    env: { ...process.env, TSX_TSCONFIG_PATH: fileURLToPath(new URL('deepseek-harness/tsconfig.json', root)) },
  });
}

test('source host shares scope identity with installed OPS and publishes native tools', () => {
  const result = run(script);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /public OPS scoped publication passed/);
});

test('without the source-host loader installed OPS cannot read the host scope tag', () => {
  const result = run(`
    import assert from 'node:assert/strict';
    import { Context } from './deepseek-harness/vendor/cordis/src/index.ts';
    import * as host from './deepseek-harness/packages/core/scope/src/index.ts';
    import { loadScopes } from './plugins/benchgo/node_modules/dsh-ops/lib/adapter/dsh/host.js';
    const ops = await loadScopes();
    assert.notEqual(ops, host);
    const root = new Context(), agent = {};
    try {
      agent.ctx = host.createScope(root, agent).ctx;
      assert.equal(host.scopeOf(agent.ctx), agent);
      assert.equal(ops.scopeOf(agent.ctx), undefined);
    } finally { await root.fiber.dispose(); }
  `, false);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr + result.stdout);
});
