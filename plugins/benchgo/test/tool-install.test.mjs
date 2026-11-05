import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ToolInstaller } from '../src/tool-install.mjs';
async function fixture(t, files = ['codex']) { const dir = await mkdtemp(join(tmpdir(), 'benchgo-tools-')); t.after(() => rm(dir, { recursive: true, force: true })); for (const file of files) { const path = join(dir, file); await writeFile(path, '#!/bin/sh\necho codex 1.2.3'); await chmod(path, 0o755); } const calls = []; return { dir, calls, manager: new ToolInstaller({ env: { PATH: dir }, executor: async (command, args) => { calls.push({ command, args }); return { stdout: 'codex 1.2.3' }; } }) }; }
test('discovers system installations and reports source', async t => { const { manager } = await fixture(t); const row = (await manager.list()).find(item => item.id === 'codex'); assert.equal(row.installed, true); assert.equal(row.installations.length, 1); assert.ok(['npm', 'unknown'].includes(row.source)); });
test('unknown source disables destructive actions', async t => { const { manager } = await fixture(t); const row = (await manager.list()).find(item => item.id === 'codex'); assert.equal(row.source, 'unknown'); assert.equal(row.canUpdate, false); assert.equal(row.canUninstall, false); });
test('uninstall rejects changed snapshot', async t => { const { manager } = await fixture(t); const job = manager.uninstall('codex', { snapshot: '/changed' }); await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(manager.job(job.id).status, 'failed'); });
test('install and update are serialized', async t => { const { manager, calls } = await fixture(t, []); const first = manager.install('codex'); assert.throws(() => manager.updateTool('codex'), /进行中的任务/); await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(manager.job(first.id).status, 'failed'); assert.equal(calls[0].command, 'npm'); });
