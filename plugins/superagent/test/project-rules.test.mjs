import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadProjectRules } from '../src/project-rules.mjs';

const fs = {
  resolve: async path => ({ path: resolve(path), targetKey: resolve(path) }),
  stat: async target => { try { const value = await stat(target.path); return { type: value.isFile() ? 'file' : value.isDirectory() ? 'directory' : 'other', size: value.size, version: value.mtimeMs }; } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; } },
  streamText: async target => (async function* () { yield await readFile(target.path, 'utf8'); })(),
};

test('first-match selects one source across the root-to-cwd chain and merges only the same name', async t => {
  const root = await mkdtemp(join(tmpdir(), 'benchgo-project-rules-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const nested = join(root, 'nested');
  await mkdir(nested); await mkdir(join(root, '.git'));
  await writeFile(join(root, 'AGENTS.md'), 'root-agents');
  await writeFile(join(root, 'CLAUDE.md'), 'discarded-claude');
  await writeFile(join(nested, 'AGENTS.md'), 'nested-agents');
  let rules = await loadProjectRules({ fs, cwd: nested });
  assert.equal(rules.selected, 'AGENTS.md');
  assert.match(rules.text, /root-agents[\s\S]+nested-agents/);
  assert.doesNotMatch(rules.text, /discarded-claude/);
  await writeFile(join(nested, '.hermes.md'), 'preferred-hermes');
  rules = await loadProjectRules({ fs, cwd: nested });
  assert.equal(rules.selected, '.hermes.md');
  assert.match(rules.text, /preferred-hermes/);
  assert.doesNotMatch(rules.text, /root-agents|nested-agents|discarded-claude/);
  await rm(join(nested, '.hermes.md'));
  await writeFile(join(root, 'AGENTS.override.md'), 'preferred-override');
  rules = await loadProjectRules({ fs, cwd: nested });
  assert.equal(rules.selected, 'AGENTS.override.md');
  assert.match(rules.text, /preferred-override/);
});

test('empty first candidate remains authoritative; SOUL is never a project competitor', async t => {
  const root = await mkdtemp(join(tmpdir(), 'benchgo-project-rules-empty-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, '.hermes.md'), '');
  await writeFile(join(root, 'AGENTS.md'), 'must-not-load');
  await writeFile(join(root, 'SOUL.md'), 'not-a-project-candidate');
  const rules = await loadProjectRules({ fs, cwd: root });
  assert.equal(rules.selected, '.hermes.md');
  assert.doesNotMatch(rules.text, /must-not-load|not-a-project-candidate/);
  await assert.rejects(loadProjectRules({ fs: { ...fs, streamText: async target => {
    if (target.path === join(root, '.hermes.md')) throw new Error('permission denied');
    return fs.streamText(target);
  } }, cwd: root }), /首选项目规则读取失败/);
  await assert.rejects(loadProjectRules({ fs, cwd: tmpdir(), projectRoot: root }), /超出/);
});

test('first-match preserves both host global instruction roots and refuses oversized selected rules', async t => {
  const root = await mkdtemp(join(tmpdir(), 'benchgo-project-globals-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dshHome = join(root, 'dsh'), agentsHome = join(root, 'agents'), cwd = join(root, 'project');
  for (const path of [dshHome, agentsHome, cwd]) await mkdir(path);
  await writeFile(join(dshHome, 'AGENTS.md'), 'host-global-rule');
  await writeFile(join(agentsHome, 'AGENTS.md'), 'shared-global-rule');
  await writeFile(join(cwd, 'CLAUDE.md'), 'selected-project-rule');
  const rules = await loadProjectRules({ fs, cwd, dshHome, agentsHome });
  assert.equal(rules.selected, 'CLAUDE.md');
  assert.match(rules.text, /host-global-rule[\s\S]+shared-global-rule[\s\S]+selected-project-rule/);
  await writeFile(join(cwd, '.hermes.md'), 'x'.repeat(1024 * 1024 + 1));
  await assert.rejects(loadProjectRules({ fs, cwd, dshHome, agentsHome }), /读取上限/);
});
