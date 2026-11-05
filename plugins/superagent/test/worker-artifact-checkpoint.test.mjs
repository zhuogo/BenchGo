import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { captureArtifactCheckpoint, verifyArtifactCheckpoint } from '../src/worker-artifact-checkpoint.mjs';

const execute = promisify(execFile);
test('ordinary Worker directory checkpoints include hidden files and reject changed contents', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchgo-plain-checkpoint-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, '.hidden'), 'original');
  const checkpoint = await captureArtifactCheckpoint(directory);
  await verifyArtifactCheckpoint(directory, checkpoint);
  await writeFile(join(directory, '.hidden'), 'modified');
  await assert.rejects(verifyArtifactCheckpoint(directory, checkpoint), /no longer matches/);
});
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'benchgo-checkpoint-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'), path = join(root, 'worker'); await mkdir(repo);
  const git = async (...args) => (await execute('git', ['-C', repo, ...args], { windowsHide: true })).stdout.trim();
  await git('init'); await git('config', 'user.name', 'Checkpoint Test'); await git('config', 'user.email', 'checkpoint@example.invalid');
  await writeFile(join(repo, 'tracked.txt'), 'base'); await writeFile(join(repo, '.gitignore'), 'ignored\n');
  await git('add', '.'); await git('commit', '-m', 'base');
  const baseCommit = await git('rev-parse', 'HEAD');
  await git('worktree', 'add', '-b', 'worker', path);
  return { repo, path, git, environment: { path, repositoryRoot: repo, branch: 'worker', baseCommit } };
}

test('checkpoint preserves source changes and detects tracked, untracked, ignored and deleted artifacts', async t => {
  const f = await fixture(t);
  await writeFile(join(f.repo, 'tracked.txt'), 'source dirty');
  await writeFile(join(f.path, 'tracked.txt'), 'worker dirty');
  await writeFile(join(f.path, 'new.txt'), 'new');
  await writeFile(join(f.path, 'ignored'), 'private artifact');
  const checkpoint = await captureArtifactCheckpoint(f.environment);
  assert.equal(checkpoint.head, f.environment.baseCommit);
  await verifyArtifactCheckpoint(f.environment, JSON.parse(JSON.stringify(checkpoint)));
  for (const [name, original] of [['tracked.txt', 'worker dirty'], ['new.txt', 'new'], ['ignored', 'private artifact']]) {
    await writeFile(join(f.path, name), 'changed');
    await assert.rejects(verifyArtifactCheckpoint(f.environment, checkpoint), /no longer matches/);
    await writeFile(join(f.path, name), original);
  }
  await rm(join(f.path, 'new.txt'));
  await assert.rejects(verifyArtifactCheckpoint(f.environment, checkpoint), /no longer matches/);
  assert.match(await f.git('diff'), /source dirty/);
});

test('index changes and branch substitution invalidate checkpoint without file changes', async t => {
  const f = await fixture(t);
  await writeFile(join(f.path, 'tracked.txt'), 'edited');
  const checkpoint = await captureArtifactCheckpoint(f.environment);
  await execute('git', ['-C', f.path, 'add', 'tracked.txt']);
  await assert.rejects(verifyArtifactCheckpoint(f.environment, checkpoint), /no longer matches/);
  await execute('git', ['-C', f.path, 'switch', '-c', 'replacement']);
  await assert.rejects(captureArtifactCheckpoint(f.environment), /branch changed/);
});

test('missing evidence, wrong repository, links and cancellation fail closed', async t => {
  const f = await fixture(t), other = await fixture(t);
  await assert.rejects(verifyArtifactCheckpoint(f.environment, null), /verified artifact checkpoint/);
  await assert.rejects(captureArtifactCheckpoint({ ...f.environment, repositoryRoot: other.repo }), /repository identity/);
  await assert.rejects(captureArtifactCheckpoint(f.environment, { signal: AbortSignal.abort(new Error('stop')) }), /stop/);
  await symlink(other.repo, join(f.path, 'external'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(captureArtifactCheckpoint(f.environment), /symbolic links/);
});

test('internal pnpm junctions are captured without traversal and target tampering is detected', async t => {
  const f = await fixture(t), target = join(f.path, 'node_modules', '.pnpm', 'example', 'node_modules', 'example');
  await mkdir(target, { recursive: true });
  await writeFile(join(target, 'index.js'), 'original');
  await symlink(target, join(f.path, 'node_modules', 'example'), process.platform === 'win32' ? 'junction' : 'dir');
  const checkpoint = await captureArtifactCheckpoint(f.environment);
  await verifyArtifactCheckpoint(f.environment, checkpoint);
  await writeFile(join(target, 'index.js'), 'changed');
  await assert.rejects(verifyArtifactCheckpoint(f.environment, checkpoint), /no longer matches/);
});
