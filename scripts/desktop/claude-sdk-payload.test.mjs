/** Exercise the real pinned SDK with its native fallback disabled, without model requests. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire, registerHooks } from 'node:module';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const requirePlugin = createRequire(new URL('../../plugins/base/package.json', import.meta.url));
const sdkPath = requirePlugin.resolve('@anthropic-ai/claude-agent-sdk');
let nativeLookups = 0;
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('@anthropic-ai/claude-agent-sdk-')) { nativeLookups++; throw new Error('Bundled native Claude is intentionally absent'); }
  return next(specifier, context);
} });
const sdk = await import(pathToFileURL(sdkPath).href);
const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; };

function wireProcess() {
  const child = new EventEmitter(), calls = [], permission = deferred();
  const output = value => child.stdout.write(JSON.stringify(value) + '\n');
  const success = (requestId, response = {}) => output({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
  let pending = '';
  Object.assign(child, {
    stdin: new Writable({ write(chunk, _encoding, callback) {
      pending += chunk.toString();
      for (;;) {
        const at = pending.indexOf('\n'); if (at < 0) break;
        const line = pending.slice(0, at); pending = pending.slice(at + 1); if (!line) continue;
        const message = JSON.parse(line); calls.push(message);
        if (message.type === 'control_request') {
          const response = message.request.subtype === 'initialize' ? {
            commands: [{ name: 'fixture', description: 'local fixture', argumentHint: '' }], agents: [], output_style: 'default', available_output_styles: ['default'],
            models: [{ value: 'opaque-fixture-model', displayName: 'Fixture', description: 'No remote model is used' }], account: { apiProvider: 'firstParty', apiKeySource: 'none', subscriptionType: 'max' },
          } : {};
          queueMicrotask(() => success(message.request_id, response));
        } else if (message.type === 'control_response') permission.resolve(message.response);
      }
      callback();
    } }),
    stdout: new PassThrough(), stderr: new PassThrough(), pid: 999999, exitCode: null, signalCode: null, killed: false,
    kill() { this.killed = true; this.exitCode = 0; this.stdout.end(); this.stderr.end(); this.emit('exit', 0, null); return true; },
  });
  return { child, calls, permission, output };
}

test('real SDK initializes, lists models, resumes, changes opaque model and routes approvals without bundled native', async () => {
  const process = wireProcess(), stop = deferred(), approvals = [];
  let captured;
  const query = sdk.query({ prompt: (async function* () { await stop.promise; })(), options: {
    pathToClaudeCodeExecutable: 'selected-system-claude.exe', resume: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
    permissionMode: 'default', settingSources: [], env: { PATH: '' },
    spawnClaudeCodeProcess(options) { captured = options; return process.child; },
    canUseTool: async (name, input) => { approvals.push({ name, input }); return { behavior: 'deny', message: 'Denied by test user' }; },
  } });
  try {
    const initialized = await query.initializationResult();
    assert.equal(initialized.models[0].value, 'opaque-fixture-model');
    assert.equal((await query.supportedModels())[0].value, 'opaque-fixture-model');
    assert.equal((await query.supportedCommands())[0].name, 'fixture');
    assert.equal(captured.command, 'selected-system-claude.exe');
    assert(captured.args.some(arg => arg === '--resume' || arg.startsWith('--resume=')));
    assert(captured.args.some(arg => arg.includes('aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa')));
    await query.setModel('provider/opaque:custom-model');
    await query.setPermissionMode('default');
    process.output({ type: 'control_request', request_id: 'approval-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'local fixture' }, tool_use_id: 'tool-1' } });
    const approval = await Promise.race([process.permission.promise, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('SDK approval was not routed')), 3000); timer.unref(); })]);
    assert.equal(approval.response.behavior, 'deny');
    assert.deepEqual(approvals, [{ name: 'Bash', input: { command: 'local fixture' } }]);
    await query.interrupt();
    assert(process.calls.some(call => call.request?.subtype === 'set_model' && call.request.model === 'provider/opaque:custom-model'));
    assert.equal(nativeLookups, 0);
  } finally { stop.resolve(); query.close(); for (const stream of [process.child.stdin, process.child.stdout, process.child.stderr]) stream.destroy(); }
});

test('real SDK history APIs read valid local transcripts with no native executable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-claude-history-'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = directory;
  try {
    const cwd = join(directory, 'project'); await mkdir(cwd);
    const project = join(directory, 'projects', resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-')); await mkdir(project, { recursive: true });
    const sessionId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
    const rows = [
      { type: 'user', uuid: 'cccccccc-cccc-4ccc-cccc-cccccccccccc', parentUuid: null, sessionId, cwd, version: '2.1.80', timestamp: new Date().toISOString(), message: { role: 'user', content: 'History fixture prompt' } },
      { type: 'assistant', uuid: 'dddddddd-dddd-4ddd-dddd-dddddddddddd', parentUuid: 'cccccccc-cccc-4ccc-cccc-cccccccccccc', sessionId, cwd, version: '2.1.80', timestamp: new Date().toISOString(), message: { id: 'fixture-message', role: 'assistant', type: 'message', model: 'opaque-fixture-model', content: [{ type: 'text', text: 'History fixture response' }], stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } } },
    ];
    await writeFile(join(project, sessionId + '.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    const messages = await sdk.getSessionMessages(sessionId, { dir: cwd });
    assert.equal(messages.length, 2); assert.equal(messages[0].message.content, 'History fixture prompt');
    const info = await sdk.getSessionInfo(sessionId, { dir: cwd });
    assert.equal(info.sessionId, sessionId);
    assert((await sdk.listSessions({ dir: cwd, limit: 10 })).some(session => session.sessionId === sessionId));
    assert.equal(nativeLookups, 0);
  } finally { if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous; await rm(directory, { recursive: true, force: true }); }
});

test('missing explicitly selected CLI reports its spawn failure instead of trying bundled native', async () => {
  const query = sdk.query({ prompt: (async function* () {})(), options: { pathToClaudeCodeExecutable: join(tmpdir(), 'benchgo-definitely-missing-claude-executable'), settingSources: [], env: { PATH: '' } } });
  try { await assert.rejects(query.initializationResult(), /spawn|ENOENT|not found|Claude Code process/i); }
  finally { query.close(); }
  assert.equal(nativeLookups, 0);
});

test.after(() => hooks.deregister());
