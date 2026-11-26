// From the repo root: node --import ./scripts/source-loader.mjs --test plugins/harness/test/native-loopback.mjs
// Set BENCHGO_NATIVE_LOOPBACK_TARGET=published to use the built Harness module.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { mountTooling } from '../../base/src/tooling.mjs';
import { nativeModelConfig } from '../../base/shared/runtime-setting-fields.mjs';
import { ToolInstaller } from '../../base/src/tool-install.mjs';

const runFile = promisify(execFile);
const target = process.env.BENCHGO_NATIVE_LOOPBACK_TARGET ?? 'source';
const tools = (process.env.BENCHGO_NATIVE_LOOPBACK_TOOLS ?? 'codex,claude').split(',');
const openCodeCommand = process.env.BENCHGO_NATIVE_LOOPBACK_OPENCODE;
const png = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAK0lEQVR4nGO4oFBAU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWKAwRCwCAdYBMwvKL0QAAAABJRU5ErkJggg==';
const prompt = 'Reply with BENCHGO_LOOPBACK_OK.';
const resumedPrompt = 'Repeat BENCHGO_LOOPBACK_OK.';
const output = 'BENCHGO_LOOPBACK_OK';
const fileMarker = 'BENCHGO_LOOPBACK_FILE_CONTENT';
const filePrompt = 'Read the attachment at';
const question = 'Which loopback option should the session use?';
const answer = 'Use the second option';
const questionToolId = 'toolu_loopback';
const routes = {
  codex: {
    model: 'Vendor/Exact-Codex:Build_03',
    apiKey: 'sk-benchgo-loopback-codex',
    protocol: 'openai-responses',
    basePath: '/codex-gateway/v1',
    requestPath: '/codex-gateway/v1/responses',
    effort: 'xhigh',
    nextEffort: 'low',
  },
  claude: {
    model: 'Vendor/claude-opus-4-8-Route_Probe',
    apiKey: 'sk-ant-benchgo-loopback-claude',
    protocol: 'anthropic-messages',
    basePath: '/claude-gateway',
    requestPath: '/claude-gateway/v1/messages',
    effort: 'low',
    nextEffort: 'high',
  },
};
for (const tool of ['pi', 'opencode']) routes[tool] = {
  model: 'Vendor/Exact:Vision',
  apiKey: 'sk-benchgo-loopback-' + tool,
  protocol: 'openai-responses',
  basePath: `/${tool}-gateway/v1`,
  requestPath: `/${tool}-gateway/v1/responses`,
};

function* responsesEvents(model, sequence, call) {
  const part = { type: 'output_text', text: output, annotations: [] };
  const item = call
    ? { type: 'function_call', id: `fc_${sequence}`, call_id: `call_${sequence}`, name: call.name, arguments: JSON.stringify(call.input), status: 'completed' }
    : { id: `msg_${sequence}`, type: 'message', role: 'assistant', status: 'completed', content: [part] };
  const response = { id: `resp_${sequence}`, object: 'response', created_at: 0, status: 'in_progress', model, output: [] };
  yield { type: 'response.created', response };
  const pending = call ? { ...item, status: 'in_progress', arguments: '' } : { ...item, status: 'in_progress', content: [] };
  yield { type: 'response.output_item.added', output_index: 0, item: pending };
  if (call) {
    yield { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: item.arguments };
    yield { type: 'response.function_call_arguments.done', item_id: item.id, output_index: 0, arguments: item.arguments, name: call.name };
  } else {
    yield { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: output };
  }
  yield { type: 'response.output_item.done', output_index: 0, item };
  yield {
    type: 'response.completed',
    response: {
      ...response, status: 'completed', output: [item],
      usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
    },
  };
}

function* messagesEvents(model, sequence, requestQuestion, call) {
  const usage = { input_tokens: 8, output_tokens: 0 };
  yield { type: 'message_start', message: { id: `msg_${sequence}`, type: 'message', role: 'assistant', content: [], model, stop_reason: null, stop_sequence: null, usage } };
  if (call) {
    yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_read_${sequence}`, name: call.name, input: {} } };
    yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) } };
  } else if (requestQuestion) {
    const options = ['Use the first option', answer].map(label => ({ label, description: label }));
    const input = { questions: [{ question, header: 'Loopback', multiSelect: false, options }] };
    yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: questionToolId, name: 'AskUserQuestion', input: {} } };
    yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } };
  } else {
    yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: output } };
  }
  yield { type: 'content_block_stop', index: 0 };
  yield { type: 'message_delta', delta: { stop_reason: call || requestQuestion ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { ...usage, output_tokens: 3 } };
  yield { type: 'message_stop' };
}

async function openLoopback(attachmentPath) {
  const requests = [];
  const server = createServer(async (req, res) => {
    if (!req.url.startsWith('/')) { res.writeHead(403).end(); return; }
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    const request = { pathname, method: req.method };
    requests.push(request);
    const tool = Object.keys(routes).find(key => routes[key].requestPath === pathname);
    if (req.method !== 'POST' || !tool) { res.writeHead(404).end(); return; }
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      Object.assign(request, {
        body,
        authorization: req.headers.authorization,
        apiKey: req.headers['x-api-key'],
        anthropicVersion: req.headers['anthropic-version'],
      });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const sequence = requests.indexOf(request) + 1;
      const requestQuestion = tool === 'claude' && !requests.slice(0, sequence - 1).some(row => row.pathname === pathname && row.body);
      let call;
      const transcript = JSON.stringify(body.messages ?? body.input);
      const alreadyAsked = requests.slice(0, sequence - 1).some(row => row.pathname === pathname && row.fileTool);
      if (transcript?.includes(filePrompt) && !transcript.includes(fileMarker) && !alreadyAsked) {
        const names = body.tools?.map(definition => definition.name ?? definition.function?.name) ?? [];
        const read = names.find(name => /^(read|read_file)$/i.test(name));
        if (read) {
          const name = tool === 'claude' ? 'file_path' : tool === 'opencode' ? 'filePath' : 'path';
          call = { name: read, input: { [name]: attachmentPath } };
        } else {
          const name = names.find(value => value === 'exec_command' || value === 'shell_command');
          if (name) call = { name, input: { [name === 'exec_command' ? 'cmd' : 'command']: "node -p \"require('node:fs').readFileSync('../attachment.txt','utf8')\"" } };
        }
        if (call) request.fileTool = call.name;
      }
      const events = tool === 'claude' ? messagesEvents(body.model, sequence, requestQuestion, call) : responsesEvents(body.model, sequence, call);
      for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    } catch {
      res.writeHead(400).end();
    }
  });
  server.on('connect', (req, socket) => { requests.push({ pathname: req.url, method: req.method }); socket.destroy(); });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  return {
    origin: 'http://127.0.0.1:' + server.address().port,
    requests,
    close: () => new Promise(done => { server.close(done); server.closeAllConnections(); }),
  };
}

async function isolateEnvironment(directory, origin) {
  // The runner starts this file in a dedicated process. Keep executable discovery
  // and OS plumbing while removing inherited credentials and per-user locations.
  const systemKeys = new Set(['path', 'pathext', 'systemroot', 'windir', 'comspec', 'os', 'systemdrive', 'processor_architecture', 'number_of_processors', 'lang', 'lc_all']);
  for (const key of Object.keys(process.env)) {
    if (!systemKeys.has(key.toLowerCase())) delete process.env[key];
  }
  const profile = join(directory, 'profile');
  const appData = join(profile, 'appdata');
  const localAppData = join(profile, 'local-appdata');
  await Promise.all([mkdir(appData, { recursive: true }), mkdir(localAppData, { recursive: true })]);
  Object.assign(process.env, {
    HOME: profile, USERPROFILE: profile, APPDATA: appData, LOCALAPPDATA: localAppData,
    XDG_CONFIG_HOME: appData, XDG_CACHE_HOME: localAppData, XDG_DATA_HOME: localAppData,
    TMP: directory, TEMP: directory, TMPDIR: directory,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CODEX_DISABLE_TELEMETRY: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    HTTP_PROXY: origin, HTTPS_PROXY: origin, ALL_PROXY: origin, NO_PROXY: '127.0.0.1',
    http_proxy: origin, https_proxy: origin, all_proxy: origin, no_proxy: '127.0.0.1',
  });
  assert.equal(resolve(tmpdir()), resolve(directory));
}

test(`installed native CLI requests through BenchGo (${target})`, { timeout: 120_000 }, async t => {
  assert.ok(['source', 'published'].includes(target), 'Unknown BENCHGO_NATIVE_LOOPBACK_TARGET');
  const { Commander } = await (target === 'published'
    ? import('../../base/lib/modules/harness/src/runtime.mjs')
    : import('../src/runtime.mjs'));
  const scratch = resolve(tmpdir());
  const directory = await mkdtemp(join(scratch, 'benchgo-native-loopback-'));
  assert.equal(resolve(directory, '..'), scratch);
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 3 }));

  const attachmentPath = join(directory, 'attachment.txt');
  await writeFile(attachmentPath, fileMarker);
  const loopback = await openLoopback(attachmentPath);
  try {
    await isolateEnvironment(directory, loopback.origin);
    const cwd = join(directory, 'project');
    await mkdir(cwd);
    const imagePath = join(cwd, 'attachment.png');
    await writeFile(imagePath, Buffer.from(png, 'base64'));
    const providers = { resolve: async tool => {
      const { basePath, apiKey, protocol } = routes[tool];
      return { baseURL: loopback.origin + basePath, apiKey, protocol };
    }, models: async tool => [{ id: routes[tool].model, inputModalities: ['text', 'image'] }] };
    const { routeService } = await mountTooling({ effect() {} }, undefined, providers, { directory, installer: {} });
    for (const tool of tools) {
      const expected = routes[tool];
      await t.test(tool, { timeout: 50_000 }, async subtest => {
        const previousRequests = loopback.requests.length;
        const installer = new ToolInstaller();
        const explicit = tool === 'opencode' && openCodeCommand ? { command: openCodeCommand, args: [] } : null;
        const openCommander = async () => {
          const runtime = await new Commander({ dataDir: join(directory, tool), routeService,
            ...(explicit ? { providers: { opencode: { command: explicit.command } } } : {}),
          }).open();
          runtime.toolInstaller = installer;
          return runtime;
        };
        let commander;
        try {
          const launch = explicit ?? await installer.resolveLaunch(tool);
          assert.ok(launch, 'Install the vendor CLI and add it to PATH');
          const version = await runFile(launch.command, [...launch.args, '--version'], { cwd, timeout: 8000, windowsHide: true });
          subtest.diagnostic(version.stdout.trim());

          const reasoning = { efforts: [expected.effort, expected.nextEffort].filter(Boolean).map(id => ({ id })) };
          const defaults = await routeService.defaultConfig(tool, tool, expected.model);
          const firstConfig = nativeModelConfig(tool, defaults, reasoning, { reasoningEffort: expected.effort });
          commander = await openCommander();
          const session = await commander.prepareExecution({ executionId: `${tool}-loopback`, sessionId: randomUUID(), provider: tool, cwd, route: { providerId: tool, model: expected.model }, advancedConfig: firstConfig });
          assert.equal(session.status, 'idle');
          assert.deepEqual(session.route.advancedConfig ?? {}, firstConfig);
          let nativeQuestion;
          const release = commander.registerExecutionHandler(session.id, request => {
            nativeQuestion = request;
            return { allow: true, answers: { [question]: answer } };
          });
          const first = { text: prompt, images: [{ id: 'fixture-image', path: imagePath, data: png, mediaType: 'image/png', name: 'attachment.png' }] };
          await commander.submit(session.id, first, { requestId: 'loopback-first' });
          const result = await commander.wait(session.id, { timeout: 25_000 });
          release();
          const events = commander.events(session.id).events;
          const requests = loopback.requests.slice(previousRequests);
          const paths = requests.map(({ method, pathname }) => [method, pathname]);
          subtest.diagnostic(JSON.stringify({ paths, status: result.status }));
          if (result.status !== 'idle') subtest.diagnostic(JSON.stringify(events.filter(event => event.type === 'turn.completed').map(event => event.data)).slice(0, 1200));
          const actual = requests.find(request => request.pathname === expected.requestPath && JSON.stringify(request.body)?.includes(prompt));
          assert.ok(actual, 'Expected the first prompt at the configured protocol endpoint');
          assert.equal(actual.method, 'POST');
          assert.equal(actual.body.model, expected.model);
          assert.equal(actual.body.stream, true);
          const blocks = (actual.body.messages ?? actual.body.input).filter(item => item.role === 'user').flatMap(item => item.content);
          assert.ok(blocks.some(block => block.type === (tool === 'claude' ? 'image' : 'input_image')),
            'Expected image input, received ' + JSON.stringify(blocks.map(({ type, text }) => ({ type, text })).filter(block => block.type)).slice(0, 500));
          if (tool !== 'claude') {
            assert.equal(actual.authorization, 'Bearer ' + expected.apiKey);
            if (expected.effort) assert.equal(actual.body.reasoning?.effort, expected.effort);
          } else {
            assert.ok(actual.authorization || actual.apiKey);
            if (actual.authorization) assert.equal(actual.authorization, 'Bearer ' + expected.apiKey);
            if (actual.apiKey) assert.equal(actual.apiKey, expected.apiKey);
            assert.ok(actual.anthropicVersion);
            assert.equal(actual.body.output_config?.effort, expected.effort);
            assert.ok(['enabled', 'adaptive'].includes(actual.body.thinking?.type));
            assert.ok(actual.body.tools?.some(tool => tool.name === 'AskUserQuestion'));
            assert.equal(nativeQuestion?.kind, 'question');
            assert.equal(nativeQuestion.nativeRequestId, questionToolId);
            const toolResults = requests.flatMap(row => row.body?.messages ?? []).flatMap(message => message.content).filter(block => block?.type === 'tool_result' && block.tool_use_id === questionToolId);
            assert.ok(toolResults.some(block => block.is_error !== true && JSON.stringify(block.content).includes(answer)), 'The provider must receive the answer as the original tool result');
          }
          assert.equal(result.status, 'idle');
          assert.ok(result.nativeId);
          assert.equal(events.filter(event => event.type === 'text.delta').map(event => event.data.text).join(''), output);
          assert.ok(events.some(event => event.type === 'turn.completed' && event.data.status === 'completed'));
          subtest.diagnostic(JSON.stringify({ path: actual.pathname, model: actual.body.model, reasoning: actual.body.reasoning, outputConfig: actual.body.output_config, thinking: actual.body.thinking, firstOutput: output }));

          await commander.close();
          commander = await openCommander();
          const restored = await commander.connect(session.id);
          assert.equal(restored.nativeId, result.nativeId);
          const beforeResume = loopback.requests.length;
          await commander.submit(restored.id, first, { requestId: 'loopback-first' });
          assert.equal(loopback.requests.length, beforeResume);
          await commander.submit(restored.id, resumedPrompt, { requestId: 'loopback-resume' });
          const resumed = await commander.wait(restored.id, { timeout: 25_000 });
          assert.equal(resumed.status, 'idle');
          assert.equal(resumed.nativeId, result.nativeId);
          assert.equal(commander.events(restored.id, restored.cursor).events.filter(event => event.type === 'text.delta').map(event => event.data.text).join(''), output);
          const resumedRequest = loopback.requests.slice(beforeResume).find(row => row.pathname === expected.requestPath);
          assert.equal(resumedRequest?.body.model, expected.model);
          assert.ok(JSON.stringify(resumedRequest.body).includes(resumedPrompt));
          assert.ok(JSON.stringify(resumedRequest.body).includes(prompt), 'The resumed request must carry the original turn');
          const beforeImageOnly = loopback.requests.length;
          await commander.submit(restored.id, { ...first, text: '' }, { requestId: 'loopback-image-only' });
          assert.equal((await commander.wait(restored.id, { timeout: 25_000 })).status, 'idle');
          const imageOnly = loopback.requests.slice(beforeImageOnly).find(row => row.pathname === expected.requestPath);
          const lastUser = (imageOnly.body.messages ?? imageOnly.body.input).findLast(item => item.role === 'user');
          assert.ok(lastUser.content.some(part => part.type === (tool === 'claude' ? 'image' : 'input_image')), 'Image-only turn must reach the provider');
          const beforeFile = loopback.requests.length;
          await commander.submit(restored.id, filePrompt + ' ' + JSON.stringify(attachmentPath), { requestId: 'loopback-file' });
          assert.equal((await commander.wait(restored.id, { timeout: 25_000 })).status, 'idle');
          const fileRequests = loopback.requests.slice(beforeFile);
          assert.ok(fileRequests.some(row => row.fileTool), 'The driver must advertise a file reading tool: ' + JSON.stringify(
            fileRequests.find(row => row.body)?.body.tools?.map(item => ({ name: item.name, type: item.type, nested: item.tools?.map(tool => tool.name) })),
          ));
          assert.ok(fileRequests.some(row => JSON.stringify(row.body)?.includes(fileMarker)), 'The native tool must return the attachment contents');
          if (!expected.nextEffort) return;
          const advancedConfig = nativeModelConfig(tool, restored.route.advancedConfig, reasoning, { reasoningEffort: expected.nextEffort });
          const nextRoute = await routeService.capture({ tool, providerId: tool, model: expected.model, advancedConfig });
          await commander.disconnect(restored.id);
          commander.get(restored.id).route = nextRoute;
          await commander.persist();
          await commander.connect(restored.id);
          const beforeSwitch = loopback.requests.length;
          await commander.submit(restored.id, resumedPrompt, { requestId: 'loopback-switch-effort' });
          const switched = await commander.wait(restored.id, { timeout: 25_000 });
          assert.equal(switched.status, 'idle');
          assert.equal(switched.nativeId, result.nativeId);
          const switchedRequest = loopback.requests.slice(beforeSwitch).find(row => row.pathname === expected.requestPath);
          assert.equal(tool === 'codex' ? switchedRequest?.body.reasoning?.effort : switchedRequest?.body.output_config?.effort, expected.nextEffort);
          subtest.diagnostic(JSON.stringify({ resumed: true, answerReturned: tool === 'claude' }));
        } finally {
          await commander?.close();
          await installer.close();
        }
      });
    }
  } finally {
    await loopback.close();
  }
});
