// Reuses the repository's real-loader smoke bootstrap, without changing upstream or user data.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { runCases, mockResponse } from './superagent-cases.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const outputIndex = process.argv.indexOf('--output-dir');
if (outputIndex >= 0 && !process.argv[outputIndex + 1]) throw new Error('--output-dir requires a directory');
const out = outputIndex >= 0 ? resolve(root, process.argv[outputIndex + 1]) : join(root, 'eval/superagent-20261103');
await mkdir(out, { recursive: true });
const mode = process.argv.includes('--real') ? 'real' : 'controlled';
const diagnostic = process.argv.includes('--diagnostic');
const extra = process.argv.includes('--extra') || diagnostic;
const caseIndex = process.argv.indexOf('--case');
const caseFilter = caseIndex >= 0 ? process.argv[caseIndex + 1] : undefined;
if (caseIndex >= 0 && !caseFilter) throw new Error('--case requires a scenario ID');
const report = { mode, extra, diagnostic, caseFilter, startedAt: new Date().toISOString(), scenarios: [], requests: [] };
let secret = '';
const redact = value => String(value).replaceAll(secret || '\0', '[REDACTED]').replace(/([?&]token=)[^\s&"']+/g, '$1[REDACTED]');
const save = () => writeFile(join(out, `${mode}${diagnostic ? '-diagnostic' : extra ? '-extra' : ''}-results.json`), redact(JSON.stringify(report, null, 2)));
globalThis.benchgoEval = { report, save, mockResponse: (req, res) => mockResponse(req, res, report), run: context => runCases({ ...context, report, save, mode, out }) };
const runtime = join(root, `eval/.superagent-runtime-${mode}.mjs`);
try {
  if (mode === 'controlled') for (const key of ['BENCHGO_ASSISTANT_SMOKE_MODEL', 'BENCHGO_ASSISTANT_SMOKE_BASE_URL', 'BENCHGO_ASSISTANT_SMOKE_API_KEY']) delete process.env[key];
  if (mode === 'real') {
    const require = createRequire(join(root, 'deepseek-harness/packages/credentials/credentials-local/package.json'));
    const { parse } = require('yaml');
    const home = join(homedir(), '.dsh');
    const patches = parse(await readFile(join(home, 'profiles/desktop/cordis.patch.yml'), 'utf8'));
    const selected = patches.find(x => x.id === 'agent-default-model')?.config;
    assert.ok(selected?.provider && selected?.model, 'No explicit local default model');
    const provider = patches.find(x => x.id === 'llm-pi-ai')?.config.providers[selected.provider];
    assert.equal(provider?.api, 'openai-completions', 'Eval bootstrap supports existing openai-completions only');
    const credentials = parse(await readFile(join(home, '.credentials.yaml'), 'utf8'));
    const entry = credentials.refs?.[provider.apiKeyEnv];
    secret = typeof entry === 'string' ? entry : entry?.value;
    assert.ok(secret, 'Existing provider credential unavailable');
    Object.assign(process.env, { BENCHGO_ASSISTANT_SMOKE_MODEL: selected.model, BENCHGO_ASSISTANT_SMOKE_BASE_URL: provider.baseURL, BENCHGO_ASSISTANT_SMOKE_API_KEY: secret });
    report.provider = { id: selected.provider, model: selected.model, protocol: provider.api, isolatedAlias: 'assistant-smoke' };
  }
  let source = await readFile(join(root, 'plugins/superagent/test/live-startup.mjs'), 'utf8');
  source = source.replace("new URL('../../../', import.meta.url)", "new URL('../', import.meta.url)");
  source = source.replace("const liveModel = configuredModel || 'smoke';", "const liveModel = configuredModel || 'Eval/Route:2026-11+Opaque';");
  const fakeStart = source.indexOf('const fake =');
  const fakeEnd = source.indexOf('if (fake) await', fakeStart);
  assert.ok(fakeStart > 0 && fakeEnd > fakeStart);
  source = source.slice(0, fakeStart) + 'const fake = configuredModel ? null : createServer(globalThis.benchgoEval.mockResponse);\n' + source.slice(fakeEnd);
  const casesStart = source.indexOf("  const state = await call({ action: 'state' });");
  const casesEnd = source.indexOf('\n} finally {', casesStart);
  assert.ok(casesStart > 0 && casesEnd > casesStart);
  source = source.slice(0, casesStart) + '\n  await globalThis.benchgoEval.run({ call, login, cookie, directory, profile, liveModel, loaderLog: safe });\n' + source.slice(casesEnd);
  await writeFile(runtime, source);
  await import(pathToFileURL(runtime).href);
} catch (error) {
  report.fatal = redact(error.stack || error.message);
  process.exitCode = 1;
} finally {
  await rm(runtime, { force: true });
  report.finishedAt = new Date().toISOString();
  await save();
  console.log(JSON.stringify({ mode, scenarios: report.scenarios.length, passed: report.scenarios.filter(x => x.status === 'pass').length, fatal: report.fatal }));
}
