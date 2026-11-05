import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { connectionConfig, channelIds } from './channel-catalog.mjs';

/** Owner-only configuration. Secret values belong to the host credential service. */
export function createAssistantConnections({ directory }) {
  mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(join(directory, 'assistant.db'));
  db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS assistant_connections (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload TEXT NOT NULL)');
  const read = (channel = 'feishu') => {
    const row = db.prepare('SELECT revision,payload FROM assistant_connections WHERE id=?').get(channel);
    return { channel, revision: row?.revision ?? 0, config: connectionConfig(channel, row ? JSON.parse(row.payload) : {}) };
  };
  return {
    read,
    list: () => channelIds.map(channel => read(channel)),
    update(patch, { revision, channel = 'feishu' } = {}) {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('连接配置补丁无效');
      if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('连接配置需要当前版本');
      db.exec('BEGIN IMMEDIATE');
      try {
        const current = read(channel);
        if (current.revision !== revision) throw Object.assign(new Error('连接配置已更新，请重新读取'), { code: 'REVISION_CONFLICT', revision: current.revision });
        const config = connectionConfig(channel, { ...current.config, ...patch });
        db.prepare('INSERT INTO assistant_connections VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload').run(channel, revision + 1, JSON.stringify(config));
        db.exec('COMMIT');
        return { channel, revision: revision + 1, config };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    close() { db.close(); },
  };
}
