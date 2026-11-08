import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
export async function preflight({ credentials = false } = {}) {
  const require = createRequire(join(root, 'deepseek-harness/packages/credentials/credentials-local/package.json'));
  const { parse } = require('yaml');
  const home = homedir(), configPath = join(home, '.benchgo/assistant/config.json');
  const raw = await readFile(configPath, 'utf8'), assistant = JSON.parse(raw);
  const patches = parse(await readFile(join(home, '.dsh/profiles/desktop/cordis.patch.yml'), 'utf8'));
  const providers = patches.find(row => row.id === 'llm-pi-ai')?.config?.providers || {};
  const routes = [...(assistant.models || []), ...(assistant.workerModels || []), assistant.auxiliary].filter(row => row?.providerId && row?.modelId);
  assert.ok(assistant.models?.[0], 'Existing SuperAgent model route is unavailable');
  const used = {};
  for (const route of routes) {
    const provider = providers[route.providerId];
    assert.ok(provider?.models?.some(model => model.id === route.modelId), 'Configured exact model is not registered');
    assert.ok(provider.baseURL && provider.apiKeyEnv, 'Existing supplier endpoint or credential reference unavailable');
    used[route.providerId] = structuredClone(provider);
  }
  const secrets = {};
  if (credentials) {
    const credentialStore = parse(await readFile(join(home, '.dsh/.credentials.yaml'), 'utf8'));
    for (const provider of Object.values(used)) {
      const entry = credentialStore.refs?.[provider.apiKeyEnv];
      const value = typeof entry === 'string' ? entry : entry?.value;
      assert.ok(value, 'Existing supplier credential unavailable');
      secrets[provider.apiKeyEnv] = value;
    }
  }
  return { assistant, providers: used, secrets, configPath, configHash: createHash('sha256').update(raw).digest('hex'),
    evidence: { checkedAt: new Date().toISOString(), requestMade: false, userConfigurationModified: false,
      configRevision: assistant.revision, models: assistant.models, auxiliary: assistant.auxiliary ?? null,
      workerModels: assistant.workerModels ?? [], providers: Object.entries(used).map(([id, provider]) => ({ id, api: provider.api,
        origin: new URL(provider.baseURL).origin, registeredExactModelIds: provider.models.map(model => model.id) })),
      scopeClarification: 'Development subagents use gpt-6.1-sol per the current user instruction; live acceptance inherits the existing exact supplier configuration.' } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(JSON.stringify((await preflight()).evidence, null, 2));
