import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Commander } from '../src/runtime.mjs';
import { ToolInstaller } from '../../base/src/tool-install.mjs';
import { createSessionRoutes } from '../../base/src/session-routes.mjs';

const live = process.env.COMMANDER_LIVE === '1';
for (const provider of (process.env.COMMANDER_NATIVE_PROVIDERS ?? 'codex,claude').split(',').map(value => value.trim()).filter(Boolean)) {
  test(`real ${provider}: ${live ? 'API request and native restore' : 'CLI launch resolution'}`, { timeout: 300_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), `commander-native-${provider}-`));
    const config = { dataDir: join(directory, 'state'), providers: {} };
    const installer = new ToolInstaller();
    const openCommander = async () => {
      const runtime = await new Commander(config).open();
      runtime.toolInstaller = installer;
      if (live) {
        const prefix = `COMMANDER_${provider.toUpperCase()}_API_`;
        const baseURL = process.env[prefix + 'BASE_URL'], apiKey = process.env[prefix + 'KEY'];
        const protocol = { codex: 'openai-responses', claude: 'anthropic-messages' }[provider];
        runtime.routeService = createSessionRoutes({ directory, providers: { resolve: async () => ({ baseURL, apiKey, protocol }) } });
      }
      return runtime;
    };
    let commander;
    try {
      if (live) {
        assert.ok(['codex', 'claude'].includes(provider), 'Live API routes support Codex and Claude Code');
        const prefix = `COMMANDER_${provider.toUpperCase()}_API_`;
        for (const key of ['BASE_URL', 'KEY', 'MODEL']) assert.ok(process.env[prefix + key], `Set ${prefix + key}`);
      }
      commander = await openCommander();
      if (!live) {
        const result = (await commander.doctor()).find(row => row.name === provider);
        assert.equal(result?.available, true, `${provider}: ${result?.error || 'no executable'}`);
        return;
      }
      const model = process.env[`COMMANDER_${provider.toUpperCase()}_API_MODEL`];
      const session = await commander.create({ provider, cwd: directory, route: { providerId: 'test-api', model } });
      assert.equal(session.status, 'idle');
      {
        await commander.submit(session.id, 'Reply with exactly COMMANDER_OK. Do not call any tools.', { requestId: 'first' });
        let result = await commander.wait(session.id, { timeout: 60_000 });
        if (result.status === 'running') result = await commander.wait(session.id, { timeout: 60_000 });
        assert.equal(result.status, 'idle', 'First API turn must reach idle');
        const text = commander.events(session.id).events.filter(e => e.type === 'text.delta').map(e => e.data.text).join('');
        assert.match(text, /COMMANDER_OK/);
        const nativeId = result.nativeId; assert.ok(nativeId);
        await commander.close(); commander = await openCommander();
        await commander.connect(session.id);
        assert.equal(commander.snapshot(session.id).nativeId, nativeId);
        const cursor = commander.snapshot(session.id).cursor;
        await commander.submit(session.id, 'What exact token did you just reply with? Reply only that token. Do not call tools.', { requestId: 'second' });
        result = await commander.wait(session.id, { timeout: 60_000 });
        if (result.status === 'running') result = await commander.wait(session.id, { timeout: 60_000 });
        assert.equal(result.status, 'idle', 'Resumed API turn must reach idle');
        const after = commander.events(session.id, cursor).events.filter(e => e.type === 'text.delta').map(e => e.data.text).join('');
        assert.match(after, /COMMANDER_OK/);
      }
    } finally { await commander?.close(); await installer.close(); await rm(directory, { recursive: true, force: true }); }
  });
}
