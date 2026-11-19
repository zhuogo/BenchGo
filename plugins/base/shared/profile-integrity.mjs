import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
const { isMap, isSeq, parseDocument } = createRequire(import.meta.url)('yaml');

const failure = (code, message, details = {}) => Object.assign(new Error(message), { code, ...details });
const same = (a, b) => a === null ? b === null : b !== null && a.equals(b);
const readOptional = async path => {
  try { return await readFile(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};

/** Parse the official patch-list shape without evaluating loader expressions. */
export function validateProfilePatch(bytes, path = 'cordis.patch.yml') {
  try {
    const document = parseDocument(Buffer.from(bytes).toString('utf8'), {
      customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }],
    });
    if (document.errors.length || !isSeq(document.contents)
      || document.contents.items.some(item => !isMap(item))) throw new Error('Invalid patch list');
    // Resolve aliases under a finite budget, never execute the custom scalar tag.
    return document.toJS({ maxAliasCount: 100 });
  } catch {
    // Parser diagnostics can contain credentials from the offending source line.
    throw failure('PROFILE_CONFIG_INVALID', '配置文件不是有效的 YAML 补丁数组：' + path, { path });
  }
}

/** Preserve exact known-good bytes; reject malformed edits instead of accepting tool success. */
export async function createProfileIntegrityGuard({ paths, directory, withFileLock, writeFileAtomic }) {
  if (!Array.isArray(paths) || !paths.every(path => typeof path === 'string' && path)
    || typeof directory !== 'string' || !directory || typeof withFileLock !== 'function' || typeof writeFileAtomic !== 'function')
    throw new TypeError('Profile paths, checkpoint directory, and official atomic-write services are required');
  const atomic = (path, bytes) => writeFileAtomic(path, bytes, { mode: 0o600, dirMode: 0o700 });
  const normalized = [...new Set(paths.map(path => resolve(path)))];
  directory = resolve(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const checkpointFor = path => join(directory, 'checkpoints', createHash('sha256')
    .update(process.platform === 'win32' ? path.toLowerCase() : path).digest('hex') + '.yml');
  let pending = Promise.resolve();

  async function evidence(path, bytes, source) {
    const key = createHash('sha256').update(path).digest('hex').slice(0, 16);
    const target = join(directory, 'rejected', key + '-' + Date.now() + '-' + randomUUID()
      + (bytes === null ? '.missing.json' : '.yml'));
    await atomic(target, bytes ?? Buffer.from(JSON.stringify({ path, source, missing: true })));
    return target;
  }

  async function inspect(path, source) {
    // ConfigEditor serializes its writes on this exact profile manifest lock.
    const lock = join(dirname(path), 'package.json');
    // An absent optional profile/home directory must remain absent.
    const initial = await readOptional(path), checkpoint = checkpointFor(path);
    if (initial === null && await readOptional(checkpoint) === null) return false;
    return withFileLock(lock, async () => {
      let recovered = false;
      for (let attempt = 0; attempt < 4; attempt++) {
        const current = await readOptional(path);
        if (current !== null) {
          try {
            validateProfilePatch(current, path);
            if (!same(current, await readOptional(checkpoint))) await atomic(checkpoint, current);
            if (!same(current, await readOptional(path))) continue;
            return recovered;
          } catch (error) {
            if (error.code !== 'PROFILE_CONFIG_INVALID') throw error;
          }
        } else if (await readOptional(checkpoint) === null) return recovered;

        const saved = await readOptional(checkpoint);
        let trusted = saved !== null;
        if (trusted) {
          try { validateProfilePatch(saved, checkpoint); }
          catch { trusted = false; }
        }
        const rejected = await evidence(path, current, source);
        // A concurrent writer may have committed a valid replacement while
        // evidence was being saved. Re-read rather than restoring stale bytes.
        if (!same(current, await readOptional(path))) continue;
        if (!trusted) throw failure('PROFILE_CONFIG_INVALID',
          '配置无效且没有可信快照，已保留原文件，未清空配置：' + path,
          { path, evidence: rejected, source });
        await atomic(path, saved);
        recovered = true;
      }
      throw failure('PROFILE_CONFIG_UNSTABLE', '配置持续被其他写入修改，无法确认恢复结果：' + path, { path, source });
    });
  }

  async function inspectAll({ source = 'check', rejectRecovered = false } = {}) {
    const recovered = [];
    for (const path of normalized) if (await inspect(path, source)) recovered.push(path);
    if (rejectRecovered && recovered.length) throw failure('PROFILE_CONFIG_RESTORED',
      '操作写入了无效配置，已恢复最近有效版本；本次操作不能视为成功。', { recovered, source });
    return { recovered };
  }

  const guard = {
    paths: normalized,
    check(options) {
      const result = pending.then(() => inspectAll(options));
      pending = result.catch(() => {});
      return result;
    },
    async run(operation, { source = 'tool' } = {}) {
      try {
        await guard.check({ source, rejectRecovered: true });
        return await operation();
      } finally {
        await guard.check({ source, rejectRecovered: true });
      }
    },
  };
  await guard.check({ source: 'startup' });
  return guard;
}
