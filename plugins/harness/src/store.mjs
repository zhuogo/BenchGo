import { open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DataOwner } from '../../benchgo/shared/data-owner.mjs';

export class Store extends DataOwner {
  constructor(directory) { super(directory); this.writes = Promise.resolve(); }

  async open() {
    await super.open();
    this.closing = false;
    try {
      return JSON.parse(await readFile(join(this.directory, 'sessions.json'), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, sessions: [] };
      await this.close();
      throw error;
    }
  }

  save(sessions) {
    if (this.closing) return Promise.reject(new Error('BenchGo store is closing'));
    if (this.pending) {
      this.pending.sessions = sessions;
      return this.pending.promise;
    }
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    this.pending = { sessions, promise, resolve, reject };
    if (!this.writing) {
      this.writing = true;
      this.writes = this.flush();
    }
    return promise;
  }

  async flush() {
    while (this.pending) {
      const batch = this.pending;
      this.pending = undefined;
      // Do not serialize waiting snapshots: only the latest state needs a write.
      // Each batch's callers remain behind its own durable write barrier.
      try { await this.writeSnapshot(batch.sessions); batch.resolve(); }
      catch (error) { batch.reject(error); }
    }
    this.writing = false;
  }

  async writeSnapshot(sessions) {
    const payload = JSON.stringify({ version: 1, sessions });
    const target = join(this.directory, 'sessions.json');
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      const file = await open(temp, 'wx', 0o600);
      try { await file.writeFile(payload); await file.sync(); } finally { await file.close(); }
      await rename(temp, target);
      if (process.platform !== 'win32') {
        const directory = await open(this.directory, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } finally { await rm(temp, { force: true }); }
  }

  async close() {
    this.closing = true;
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
