import { lstat, mkdir, readFile, rename } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { withFileLock } from '@deepseek-ai/dsh-atomic-write';

const failure = (code, message, cause) => Object.assign(new Error(message, { cause }), { code });

async function metadata(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
}

async function checkOwner(directory) {
  const path = join(directory, 'owner.lock');
  const lock = await metadata(path);
  if (!lock) return;
  if (!lock.isFile() || lock.isSymbolicLink()) throw failure('BENCHGO_LOCK_UNREADABLE', 'BenchGo owner lock is not a regular file; existing data was preserved');
  let owner;
  try { owner = JSON.parse(await readFile(path, 'utf8')); }
  catch (cause) { throw failure('BENCHGO_LOCK_UNREADABLE', 'BenchGo owner lock is unreadable; existing data was preserved', cause); }
  if (!owner || !Number.isInteger(owner.pid) || owner.pid <= 0 || owner.pid > 2147483647 || typeof owner.host !== 'string' || !owner.host) {
    throw failure('BENCHGO_LOCK_UNREADABLE', 'BenchGo owner lock has an invalid PID or host; existing data was preserved');
  }
  if (owner.host !== hostname()) throw failure('BENCHGO_LOCK_OTHER_HOST', 'BenchGo data directory is owned by another host');
  try { process.kill(owner.pid, 0); }
  catch (cause) {
    if (cause.code === 'ESRCH') return;
    throw failure('BENCHGO_LOCK_PROBE_FAILED', 'BenchGo cannot verify the owner process; existing data was preserved', cause);
  }
  throw failure('BENCHGO_DATA_LOCKED', 'BenchGo data directory is already in use; close the existing BenchGo before migration');
}

async function migrateDirectory(source, target, guard) {
  return withFileLock(guard, async () => {
    const existing = await metadata(target);
    if (existing) {
      if (!existing.isDirectory() || existing.isSymbolicLink()) throw failure('BENCHGO_DATA_INVALID', 'BenchGo data directory must be a regular directory');
      return target;
    }
    const previous = await metadata(source);
    if (previous) {
      if (!previous.isDirectory() || previous.isSymbolicLink()) throw failure('BENCHGO_DATA_INVALID', 'Previous BenchGo data directory must be a regular directory');
      await checkOwner(source);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await rename(source, target);
    } else {
      await mkdir(target, { recursive: true, mode: 0o700 });
    }
    return target;
  });
}

export async function prepareDefaultDataDirectory(home = homedir()) {
  return migrateDirectory(join(home, '.dowork', 'commander'), join(home, '.benchgo'), join(home, '.benchgo-data-migration'));
}

export async function prepareVoiceDataDirectory({ home = homedir(), dshHome = process.env.DSH_HOME || join(home, '.dsh') } = {}) {
  await prepareDefaultDataDirectory(home);
  return migrateDirectory(join(dshHome, 'voice'), join(home, '.benchgo', 'voice'), join(home, '.benchgo-data-migration'));
}
