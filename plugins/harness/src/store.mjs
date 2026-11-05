import { open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DataOwner } from '../../benchgo/shared/data-owner.mjs';

export class Store extends DataOwner {
  constructor(directory) { super(directory); this.writes = Promise.resolve(); }

  async open() {
    await super.open();
    try {
      return JSON.parse(await readFile(join(this.directory, 'sessions.json'), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, sessions: [] };
      await this.close();
      throw error;
    }
  }

  save(sessions) {
    const payload = JSON.stringify({ version: 1, sessions }, null, 2);
    const write = this.writes.then(async () => {
      const target = join(this.directory, 'sessions.json');
      const temp = `${target}.${randomUUID()}.tmp`;
      const file = await open(temp, 'wx', 0o600);
      try { await file.writeFile(payload); await file.sync(); } finally { await file.close(); }
      try { await rename(temp, target); } finally { await rm(temp, { force: true }); }
      if (process.platform !== 'win32') {
        const directory = await open(this.directory, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      }
    });
    this.writes = write.catch(() => {});
    return write;
  }

  async close() {
    await this.writes;
    await super.close();
  }
}

export async function workingDirectory(value) {
  const { resolve } = await import('node:path');
  const cwd = resolve(value ?? process.cwd());
  if (!(await stat(cwd)).isDirectory()) throw new Error('cwd must be a directory');
  return cwd;
}
