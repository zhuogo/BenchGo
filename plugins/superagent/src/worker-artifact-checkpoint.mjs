import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, readdir, open, realpath, readlink } from 'node:fs/promises';
import { join, resolve, isAbsolute, relative as relativePath, sep } from 'node:path';

const execute = promisify(execFile);
const digest = value => createHash('sha256').update(value).digest('hex');
const limits = { files: 100_000, bytes: 512 * 1024 * 1024 };

async function git(directory, args, signal) {
  const result = await execute('git', ['-c', 'core.fsmonitor=false', '-C', directory, ...args], {
    signal, windowsHide: true, timeout: 30_000, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' },
  });
  return result.stdout;
}

async function identity(environment, signal) {
  if (typeof environment === 'string') {
    signal?.throwIfAborted();
    if (!isAbsolute(environment)) throw new Error('Artifact checkpoint directory must be absolute');
    const stat = await lstat(environment);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Artifact checkpoint requires a real directory');
    return { path: await realpath(environment), kind: 'directory' };
  }
  if (!environment || !isAbsolute(environment.path || '') || !isAbsolute(environment.repositoryRoot || '')
    || typeof environment.branch !== 'string' || !environment.branch || !/^[a-f0-9]{40,64}$/i.test(environment.baseCommit || '')) {
    throw new Error('Invalid artifact checkpoint environment');
  }
  const path = await realpath(environment.path), repositoryRoot = await realpath(environment.repositoryRoot);
  if ((await lstat(environment.path)).isSymbolicLink() || path === repositoryRoot) throw new Error('Artifact checkpoint requires an isolated worktree');
  const top = await realpath((await git(path, ['rev-parse', '--show-toplevel'], signal)).trim());
  if (top !== path) throw new Error('Artifact checkpoint directory is not a worktree root');
  const commonDir = await realpath(resolve(path, (await git(path, ['rev-parse', '--git-common-dir'], signal)).trim()));
  const sourceCommonDir = await realpath(resolve(repositoryRoot, (await git(repositoryRoot, ['rev-parse', '--git-common-dir'], signal)).trim()));
  if (commonDir !== sourceCommonDir) throw new Error('Artifact checkpoint repository identity changed');
  const branch = (await git(path, ['symbolic-ref', '--short', 'HEAD'], signal)).trim();
  if (branch !== environment.branch) throw new Error('Artifact checkpoint branch changed');
  const head = (await git(path, ['rev-parse', '--verify', 'HEAD'], signal)).trim();
  await git(path, ['merge-base', '--is-ancestor', environment.baseCommit, head], signal);
  const indexHash = digest(await git(path, ['ls-files', '--stage', '-z'], signal));
  return { path, repositoryRoot, commonDir, branch, baseCommit: environment.baseCommit, head, indexHash };
}

async function snapshot(environment, signal) {
  signal?.throwIfAborted();
  const before = await identity(environment, signal);
  const entries = []; let bytes = 0;
  async function walk(directory, prefix = '') {
    for (const name of (await readdir(directory)).sort()) {
      if (!prefix && name === '.git' && typeof environment !== 'string') continue;
      signal?.throwIfAborted();
      const path = join(directory, name), relative = prefix ? `${prefix}/${name}` : name;
      const stat = await lstat(path);
      entries.push(undefined);
      if (entries.length > limits.files) throw new Error('Artifact checkpoint file limit exceeded');
      const slot = entries.length - 1;
      if (stat.isSymbolicLink()) {
        // Internal pnpm links are covered by the target's ordinary tree entry.
        // Never traverse links or accept targets outside the captured tree.
        const target = await realpath(path), child = relativePath(before.path, target);
        if (isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`) || child.split(sep)[0] === '.git') throw new Error('Artifact checkpoint cannot verify external symbolic links');
        entries[slot] = { path: relative, type: 'link', target: await readlink(path), resolved: child };
        continue;
      }
      if (stat.isDirectory()) { entries[slot] = { path: relative, type: 'directory' }; await walk(path, relative); continue; }
      if (!stat.isFile()) throw new Error('Artifact checkpoint cannot verify special files');
      bytes += stat.size;
      if (bytes > limits.bytes) throw new Error('Artifact checkpoint byte limit exceeded');
      const file = await open(path, 'r');
      try {
        const opened = await file.stat();
        if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error('Artifact changed while checkpointing');
        const hash = createHash('sha256'); let actual = 0;
        for await (const chunk of file.createReadStream({ autoClose: false })) {
          signal?.throwIfAborted(); actual += chunk.length;
          if (actual > stat.size) throw new Error('Artifact changed while checkpointing');
          hash.update(chunk);
        }
        const after = await file.stat();
        if (actual !== stat.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw new Error('Artifact changed while checkpointing');
        entries[slot] = { path: relative, type: 'file', size: actual, executable: Boolean(stat.mode & 0o111), hash: hash.digest('hex') };
      } finally { await file.close(); }
    }
  }
  await walk(before.path);
  if (JSON.stringify(before) !== JSON.stringify(await identity(environment, signal))) throw new Error('Artifact Git identity changed while checkpointing');
  return { version: 1, ...before, files: entries.length, bytes, manifestHash: digest(JSON.stringify(entries)) };
}

/** Read-only evidence, not a backup or filesystem lock. Includes ignored files. */
export async function captureArtifactCheckpoint(environment, { signal } = {}) {
  signal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(60000)]);
  const first = await snapshot(environment, signal), second = await snapshot(environment, signal);
  if (JSON.stringify(first) !== JSON.stringify(second)) throw new Error('Artifacts changed while checkpointing');
  return second;
}

export async function verifyArtifactCheckpoint(environment, checkpoint, { signal } = {}) {
  if (!checkpoint || checkpoint.version !== 1) throw new Error('Project execution recovery requires a verified artifact checkpoint');
  const current = await captureArtifactCheckpoint(environment, { signal });
  for (const key of Object.keys(current)) if (current[key] !== checkpoint[key]) throw new Error('Artifact checkpoint no longer matches retained worktree');
  return current;
}
