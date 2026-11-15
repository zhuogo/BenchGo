/** Retire installer trees without putting recursive deletion on the launch path. */
import { randomUUID } from 'node:crypto';
import { lstat, open, readFile, readdir, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const SUFFIX = '.benchgo-cleanup.json';
const GUID = '\\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\}';
const pathKey = value => process.platform === 'win32' ? value.toLowerCase() : value;
const samePath = (left, right) => pathKey(left) === pathKey(right);
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const invalid = message => new Error(`BenchGo install cleanup: ${message}`);

function absolute(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) throw invalid('expected an absolute path');
  if (value.split(/[\\/]/).some(part => part === '.' || part === '..')) throw invalid('path traversal is not allowed');
  if (process.platform === 'win32' && (/^\\\\[?.]\\/.test(value) || value.slice(parse(value).root.length).split(/[\\/]/).some(part => /[ .:]$/.test(part) || part.includes(':')))) {
    throw invalid('device paths and ambiguous Windows names are not allowed');
  }
  return resolve(value);
}

async function statOrMissing(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// lstat every ancestor: realpath alone would accept a junction that stays inside
// the installation parent. Retired trees may contain links; their root may not.
async function inspect(path, kind, allowMissing = false) {
  const root = parse(path).root;
  const components = path.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  for (let index = -1; index < components.length; index += 1) {
    if (index >= 0) current = join(current, components[index]);
    const final = index === components.length - 1;
    const stat = await statOrMissing(current);
    if (!stat) {
      if (allowMissing && final) return null;
      throw invalid(`missing path: ${current}`);
    }
    if (stat.isSymbolicLink()) throw invalid(`links are not allowed: ${current}`);
    if ((!final || kind === 'directory') ? !stat.isDirectory() : !stat.isFile()) throw invalid(`unexpected path type: ${current}`);
  }
  const actual = await realpath(path);
  if (!samePath(actual, path)) throw invalid(`path escapes its declared location: ${path}`);
  return actual;
}

async function location(resources) {
  resources = absolute(resources);
  if (pathKey(basename(resources)) !== 'resources') throw invalid('resources must name the installation resources directory');
  resources = await inspect(resources, 'directory');
  const installRoot = dirname(resources);
  if (dirname(installRoot) === installRoot) throw invalid('filesystem root is not an installation');
  return {
    resources, installRoot, parent: dirname(installRoot),
    retiredPattern: new RegExp(`^${escape(basename(installRoot))}\\.old-${GUID}$`, process.platform === 'win32' ? 'i' : ''),
  };
}

function retiredPath(context, value) {
  value = absolute(value);
  if (!samePath(dirname(value), context.parent) || !context.retiredPattern.test(basename(value))) throw invalid('unrecognized retired installation path');
  return join(context.parent, basename(value));
}

async function readReceipt(receipt, expected) {
  await inspect(receipt, 'file');
  const stat = await lstat(receipt);
  if (stat.size > 16 * 1024) throw invalid('receipt is too large');
  const value = JSON.parse(await readFile(receipt, 'utf8'));
  if (!value || Object.keys(value).sort().join(',') !== 'installRoot,retiredDirectory,schemaVersion'
    || value.schemaVersion !== 1 || value.installRoot !== expected.installRoot || value.retiredDirectory !== expected.retiredDirectory
    || receipt !== `${value.retiredDirectory}${SUFFIX}`) throw invalid('receipt does not match this installation and filename');
}

// Delete one entry at a time rather than letting recursive rm queue a large
// batch of filesystem work while the newly visible workspace is starting.
async function removeRetiredTree(context, retiredDirectory) {
  let removed = 0;
  const inspectEntry = async path => {
    const inside = relative(retiredDirectory, path);
    if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw invalid('cleanup entry escapes the retired installation');
    await location(context.resources);
    retiredPath(context, retiredDirectory);
    // Only the final entry may be a link; all ancestors must be real dirs.
    await inspect(dirname(path), 'directory');
    const stat = await statOrMissing(path);
    if (path === retiredDirectory && stat?.isSymbolicLink()) throw invalid('retired root became a link');
    return stat;
  };
  const visit = async path => {
    const stat = await inspectEntry(path);
    if (!stat) return;
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      for (const name of await readdir(path)) await visit(join(path, name));
      const current = await inspectEntry(path);
      if (!current) return;
      if (!current.isDirectory() || current.isSymbolicLink()) throw invalid('retired directory changed during cleanup');
      await rmdir(path);
    } else {
      // unlink removes a directory junction itself, never its target.
      await unlink(path);
    }
    if (++removed % 32 === 0) await delay(4);
  };
  await visit(retiredDirectory);
}

/** Persist an exact deletion authorization after the new installation commits. */
export async function queueRetiredInstall({ resources, retiredDirectory }, { commit = rename } = {}) {
  const context = await location(resources);
  retiredDirectory = retiredPath(context, retiredDirectory);
  const actual = await inspect(retiredDirectory, 'directory', true);
  if (!actual) return { queued: false, retiredDirectory };
  retiredDirectory = actual;
  const receipt = `${retiredDirectory}${SUFFIX}`;
  const value = { schemaVersion: 1, installRoot: context.installRoot, retiredDirectory };
  if (await statOrMissing(receipt)) {
    await readReceipt(receipt, value);
    return { queued: true, receipt, retiredDirectory };
  }
  const temporary = `${receipt}.tmp-${randomUUID()}`;
  let handle;
  let created = false;
  try {
    handle = await open(temporary, 'wx', 0o600);
    created = true;
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
    await handle.close();
    handle = undefined;
    // Revalidate the installation parent before committing the sidecar.
    await location(context.resources);
    await inspect(retiredDirectory, 'directory');
    if (await statOrMissing(receipt)) throw invalid('receipt appeared while queuing cleanup');
    await commit(temporary, receipt);
    return { queued: true, receipt, retiredDirectory };
  } finally {
    await handle?.close();
    if (created) await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

/** Call without awaiting only after the workspace becomes visible. No child process. */
export async function cleanupRetiredInstalls({ resources }, { remove } = {}) {
  const context = await location(resources);
  const names = (await readdir(context.parent)).filter(name => name.endsWith(SUFFIX) && context.retiredPattern.test(name.slice(0, -SUFFIX.length))).sort();
  const results = [];
  for (const name of names) {
    const receipt = join(context.parent, name);
    const retiredDirectory = receipt.slice(0, -SUFFIX.length);
    try {
      await location(context.resources);
      retiredPath(context, retiredDirectory);
      await readReceipt(receipt, { installRoot: context.installRoot, retiredDirectory });
      const exists = await inspect(retiredDirectory, 'directory', true);
      if (exists) {
        if (remove) await remove(retiredDirectory, { recursive: true, force: true });
        else await removeRetiredTree(context, retiredDirectory);
      }
      await inspect(receipt, 'file');
      await unlink(receipt);
      results.push({ receipt, retiredDirectory, status: exists ? 'removed' : 'missing' });
    } catch (error) {
      results.push({ receipt, retiredDirectory, status: 'failed', error: error.message });
    }
  }
  return results;
}
