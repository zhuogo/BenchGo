// Isolated real-loader smoke. Provider requests require explicit environment configuration.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:http';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const configuredModel = process.env.BENCHGO_ASSISTANT_SMOKE_MODEL;
const configuredBase = process.env.BENCHGO_ASSISTANT_SMOKE_BASE_URL;
const configuredKey = process.env.BENCHGO_ASSISTANT_SMOKE_API_KEY;
if ([configuredModel, configuredBase, configuredKey].some(Boolean) && ![configuredModel, configuredBase, configuredKey].every(Boolean)) throw new Error('Live model smoke requires MODEL, BASE_URL and API_KEY');
let observedTools;
let observedBody;
const fake = configuredModel ? null : createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  if (body.tools?.length) {
    observedBody = body;
    observedTools = body.tools.map(tool => tool.function?.name || tool.name);
  }
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const event = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: 'smoke', object: 'chat.completion.chunk', created: 1, model: 'smoke', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  response.end(event({ role: 'assistant', content: 'BENCHGO_OK' }) + event({}, 'stop') + 'data: [DONE]\n\n');
});
if (fake) await new Promise(resolve => fake.listen(0, '127.0.0.1', resolve));
const liveModel = configuredModel || 'smoke';
const liveBase = configuredBase || `http://127.0.0.1:${fake.address().port}/v1`;
const liveKey = configuredKey || 'smoke';
const directory = await mkdtemp(join(tmpdir(), 'benchgo-assistant-live-'));
const home = join(directory, 'user'), dshHome = join(home, '.dsh'), profile = join(dshHome, 'profiles/web');
let child, ended, output = '';
const safe = () => output.replace(/([?&]token=)[^\s&]+/g, '$1[redacted]').slice(-6000);
try {
  await mkdir(join(profile, 'node_modules'), { recursive: true });
  for (const [name, source] of [
    ['@deepseek-ai', join(root, 'deepseek-harness/apps/cli/node_modules/@deepseek-ai')],
    ['benchgo-plugin', join(root, 'plugins/benchgo')],
  ]) await symlink(source, join(profile, 'node_modules', name), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'benchgo-assistant-live', private: true, dependencies: { 'benchgo-plugin': `link:${join(root, 'plugins/benchgo')}` }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'benchgo-plugin'] } } }));
  await writeFile(join(profile, 'cordis.yml'), '[]\n');
  const patch = [{ id: 'session-log-deepseek', config: { enabled: false } }, { id: 'session-telemetry-otel', disabled: true }, { id: 'commander-link', disabled: true }];
  if (liveModel) patch.push({ id: 'llm-pi-ai', config: { providers: { 'assistant-smoke': { api: 'openai-completions', baseURL: liveBase, apiKeyEnv: 'ASSISTANT_SMOKE_KEY', models: [{ id: liveModel, name: liveModel }] } } } });
  await writeFile(join(profile, 'cordis.patch.yml'), JSON.stringify(patch));
  child = spawn(process.execPath, ['--import', pathToFileURL(join(root, 'deepseek-harness/node_modules/tsx/dist/esm/index.mjs')).href, join(root, 'deepseek-harness/apps/cli/src/bin.ts'), '--profile', 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
    cwd: directory, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: directory, TMP: directory, HOME: home, USERPROFILE: home, DSH_HOME: dshHome, DSH_AGENTS_HOME: join(home, 'agents'), TSX_TSCONFIG_PATH: join(root, 'deepseek-harness/tsconfig.json'), DSH_TELEMETRY_DISABLED: '1', NO_COLOR: '1', ...(liveKey ? { ASSISTANT_SMOKE_KEY: liveKey } : {}) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  ended = new Promise(resolve => { child.once('exit', resolve); child.once('error', error => { output += error.message; resolve(); }); });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk.toString(); });
  let login;
  for (const deadline = Date.now() + 90000; Date.now() < deadline;) {
    const match = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/);
    if (match) { login = new URL(match[1]); break; }
    if (child.exitCode !== null || child.signalCode !== null) throw Error(`Harness exited: ${safe()}`);
    await delay(100);
  }
  assert.ok(login, `Harness ready deadline: ${safe()}`);
  const signed = await fetch(login, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
  const cookie = signed.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  assert.ok(cookie);
  const commander = await fetch(new URL('/api/commander', login), { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'state' }) });
  assert.equal(commander.status, 200, `Commander route: ${await commander.text()}; loader: ${safe()}`);
  const call = async input => {
    let response;
    for (const deadline = Date.now() + 15000;;) {
      response = await fetch(new URL('/api/commander/assistant', login), { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(15000) });
      if (response.status !== 404 || Date.now() >= deadline) break;
      await response.text(); await delay(100);
    }
    const text = await response.text();
    assert.match(response.headers.get('content-type') || '', /application\/json/, `HTTP ${response.status}: ${text}; loader: ${safe()}`);
    const body = JSON.parse(text);
    assert.equal(response.status, 200, JSON.stringify(body));
    return body;
  };
  const state = await call({ action: 'state' });
  assert.deepEqual(await call({ action: 'connectionReplies', channel: 'feishu' }), { replies: [] });
  assert.ok(Array.isArray(state.state.threads));
  const configured = await call({ action: 'config', revision: state.config.revision, patch: { name: 'Loader smoke' } });
  assert.equal(configured.name, 'Loader smoke');
  const main = await call({ action: 'ensure' });
  assert.ok(main.sessionId);
  assert.equal((await call({ action: 'ensure' })).sessionId, main.sessionId);
  assert.deepEqual((await call({ action: 'history' })).messages, []);
  assert.ok(Array.isArray((await call({ action: 'catalog' })).providers));
  {
    await call({ action: 'config', patch: { models: [{ providerId: 'assistant-smoke', modelId: liveModel }] } });
    await call({ action: 'send', text: 'Reply with exactly BENCHGO_OK.', requestId: 'live-smoke' });
    let result;
    for (const deadline = Date.now() + 120000; Date.now() < deadline;) {
      result = await call({ action: 'history' });
      if (result.error || !result.running && result.messages.some(message => message.role === 'assistant')) break;
      await delay(500);
    }
    const detail = JSON.stringify(result.error || '').replaceAll(liveKey, '[redacted]').slice(0, 1500);
    assert.ok(!result.error, `Live request failed: ${detail}`);
    assert.ok(result.messages.some(message => message.role === 'assistant' && message.text.includes('BENCHGO_OK')), 'Live response did not complete as expected');
    const { quietChatRows } = await import('../client/quiet-chat.mjs');
    const user = result.messages.find(message => message.role === 'user');
    assert.ok(Number.isSafeInteger(user.seq), 'HTTP history must preserve event identity');
    const projected = quietChatRows(result, 'main', {}, { legacy: { nodes: [{ kind: 'user', seq: user.seq, time: user.time, source: { kind: 'user', rpcId: user.rpcId }, content: user.content }] } });
    assert.equal(projected.filter(row => row.role === 'user').length, 1, 'HTTP history plus live echo must show one user message');
    assert.equal(result.model.modelId, liveModel);
    if (fake) {
      for (const name of ['assistant_delegate', 'assistant_tickets']) assert.ok(observedTools?.includes(name), `Expected ${name} in actual Router tools: ${observedTools?.join(', ')}; request keys: ${Object.keys(observedBody || {})}`);
    }
    console.log(fake ? 'PASS: real Harness Router preset exposes coordination tools and keeps execution tools out.' : 'PASS: real provider response through assistant Harness session.');
  }
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill(); await Promise.race([ended, delay(10000)]);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await ended; }
  }
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  if (fake) await new Promise(resolve => fake.close(resolve));
}
