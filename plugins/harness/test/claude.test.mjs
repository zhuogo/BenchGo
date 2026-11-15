import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { ClaudeProvider } from '../src/providers/claude.mjs';
import { calls, reset } from './claude-sdk-fixture.mjs';

const sdkURL = new URL('./claude-sdk-fixture.mjs', import.meta.url).href;
const hooks = registerHooks({ resolve(specifier, context, next) { return specifier === '@anthropic-ai/claude-agent-sdk' && context.parentURL?.endsWith('/providers/claude.mjs') ? { url: sdkURL, shortCircuit: true } : next(specifier, context); } });
after(() => hooks.deregister());
const host = { event() {}, failure(error) { throw error; }, approval: async () => ({ allow: false }) };

test('Claude new independent sessions request the supported Full mode and preserve the native permission callback', async () => {
  reset();
  const requests = [];
  const driver = await new ClaudeProvider().connect({ cwd: process.cwd() }, { ...host, approval: async request => { requests.push(request); return { allow: false }; } });
  try {
    assert.equal(calls[0].options.permissionMode, 'bypassPermissions');
    assert.equal(calls[0].options.allowDangerouslySkipPermissions, true);
    const answer = await calls[0].options.canUseTool('Bash', { command: 'echo test' }, { toolUseID: 'tool' });
    assert.equal(requests[0].kind, 'permission'); assert.equal(answer.behavior, 'deny');
    await calls[0].options.canUseTool('AskUserQuestion', { questions: [] }, { toolUseID: 'question' });
    assert.equal(requests[1].kind, 'question');
  } finally { await driver.close(); }
});

test('Claude does not silently approximate unsupported lower sandbox modes or send another tool turn', async () => {
  reset();
  const provider = new ClaudeProvider();
  await assert.rejects(provider.connect({ cwd: process.cwd(), permission: { sandbox: 'workspace-write', approval: 'ask' } }, host), { code: 'NATIVE_PERMISSION' });
  assert.equal(calls.length, 0);
  const driver = await provider.connect({ cwd: process.cwd() }, host);
  try {
    await assert.rejects(driver.setPermission({ sandbox: 'read-only', approval: 'ask' }), /无法精确同步/);
    assert.deepEqual(calls[0].permissionChanges, []);
  } finally { await driver.close(); }
});

test('Claude imported history keeps manual native permissions when its old policy is unknown', async () => {
  reset();
  const driver = await new ClaudeProvider().connect({ cwd: process.cwd(), nativeId: 'old-native' }, host);
  try {
    assert.equal(calls[0].options.resume, 'old-native');
    assert.equal(calls[0].options.permissionMode, 'default');
    assert.equal(Object.hasOwn(calls[0].options, 'allowDangerouslySkipPermissions'), false);
  } finally { await driver.close(); }
});

test('Claude Full initialization rejection is propagated without a lower-mode retry', async () => {
  reset(new Error('Full mode disabled by administrator'));
  await assert.rejects(new ClaudeProvider().connect({ cwd: process.cwd() }, host), /disabled by administrator/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.permissionMode, 'bypassPermissions');
  reset();
});
