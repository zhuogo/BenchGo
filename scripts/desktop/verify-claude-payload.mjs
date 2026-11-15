/** Optional real-CLI handshake smoke. It never submits a user prompt or model request. */
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire, registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const command = process.argv[2];
if (!command) throw new Error('Usage: node scripts/desktop/verify-claude-payload.mjs <installed-claude-executable> [evidence.json]');
const isolated = await mkdtemp(join(tmpdir(), 'benchgo-claude-handshake-'));
let nativeLookups = 0, userPrompts = 0, childCount = 0, query, stop, timer;
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('@anthropic-ai/claude-agent-sdk-')) { nativeLookups++; throw new Error('Bundled native Claude is intentionally absent'); }
  return next(specifier, context);
} });
try {
  const require = createRequire(new URL('../../plugins/benchgo/package.json', import.meta.url));
  const sdkPath = require.resolve('@anthropic-ai/claude-agent-sdk');
  const sdkVersion = JSON.parse(await readFile(join(dirname(sdkPath), 'package.json'), 'utf8')).version;
  const sdk = await import(pathToFileURL(sdkPath).href);
  const env = { ...process.env, CLAUDE_CONFIG_DIR: isolated, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1' };
  const version = (await promisify(execFile)(command, ['--version'], { env, timeout: 15_000, windowsHide: true })).stdout.trim();
  query = sdk.query({ prompt: (async function* () { await new Promise(resolveStop => { stop = resolveStop; }); })(), options: {
    cwd: isolated, env, pathToClaudeCodeExecutable: command, settingSources: [], persistSession: false,
    spawnClaudeCodeProcess(options) {
      childCount++;
      const child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], signal: options.signal, windowsHide: true });
      const write = child.stdin.write.bind(child.stdin);
      let input = '';
      child.stdin.write = (chunk, ...args) => {
        input += Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
        for (;;) { const at = input.indexOf('\n'); if (at < 0) break; const line = input.slice(0, at); input = input.slice(at + 1); if (!line) continue; if (JSON.parse(line).type === 'user') userPrompts++; }
        return write(chunk, ...args);
      };
      return child;
    },
  } });
  const models = await Promise.race([query.supportedModels(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Real Claude CLI initialization timed out')), 30_000); })]);
  if (nativeLookups !== 0 || userPrompts !== 0 || childCount !== 1) throw new Error('Unexpected native fallback or user prompt during no-inference smoke');
  const result = { observedAt: new Date().toISOString(), sdkVersion, cliVersion: version, sdkImport: 'ok',
    realCliInitialization: 'ok', modelCount: models.length, nativeLookups, userPrompts, childCount, submittedModelRequest: false,
    isolatedConfiguration: true, limitations: 'No authenticated inference, real approval execution or provider history resume is performed by this handshake.' };
  if (process.argv[3]) await writeFile(resolve(process.argv[3]), JSON.stringify(result, null, 2) + '\n');
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} finally {
  clearTimeout(timer); stop?.(); query?.close(); hooks.deregister();
  await rm(isolated, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
