import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** Replace generated files without truncating a module currently mapped by Windows. */
export async function writeArtifact(path, contents) {
  const bytes = Buffer.from(contents);
  try { if ((await readFile(path)).equals(bytes)) return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(temporary, bytes);
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, path); return; }
      catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY', 'UNKNOWN'].includes(error.code) || attempt >= 19) throw error;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
  } finally { await rm(temporary, { force: true }); }
}

export async function copyArtifact(source, destination) {
  await writeArtifact(destination instanceof URL ? fileURLToPath(destination) : destination, await readFile(source));
}

/** Publish an asset directory through the same unchanged-content and atomic-write path. */
export async function copyArtifacts(source, destination) {
  source = source instanceof URL ? fileURLToPath(source) : source;
  destination = destination instanceof URL ? fileURLToPath(destination) : destination;
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name), to = join(destination, entry.name);
    if (entry.isDirectory()) await copyArtifacts(from, to);
    else await copyArtifact(from, to);
  }
}
