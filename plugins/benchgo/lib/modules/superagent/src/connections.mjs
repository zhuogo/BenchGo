import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { connectionConfig, channelIds } from './channel-catalog.mjs';
import { applySettingsOps, assertSettingsExpected, notifySettings, settingsSnapshot } from '../../../../shared/settings-adapter-utils.mjs';

/** Owner-only configuration. Secret values belong to the host credential service. */
export function createAssistantConnections({ directory }) {
  mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(join(directory, 'assistant.db'));
  const listeners = new Set();
  db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS assistant_connections (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload TEXT NOT NULL)');
  const read = (channel = 'feishu') => {
    const row = db.prepare('SELECT revision,payload FROM assistant_connections WHERE id=?').get(channel);
    return { channel, revision: row?.revision ?? 0, config: connectionConfig(channel, row ? JSON.parse(row.payload) : {}) };
  };
  return {
    read,
    list: () => channelIds.map(channel => read(channel)),
    settingsSnapshot(channel) { const row = read(channel); return settingsSnapshot(row.config, row.revision, { base: connectionConfig(channel, {}) }); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    update(patch, { revision, channel = 'feishu', ops, expected, signal } = {}) {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('连接配置补丁无效');
      if (!expected && (!Number.isSafeInteger(revision) || revision < 0)) throw new Error('连接配置需要当前版本');
      db.exec('BEGIN IMMEDIATE');
      try {
        const current = read(channel);
        if (expected) assertSettingsExpected(settingsSnapshot(current.config, current.revision), expected, signal);
        if (revision !== undefined && current.revision !== revision) throw Object.assign(new Error('连接配置已更新，请重新读取'), { code: 'REVISION_CONFLICT', revision: current.revision });
        const config = connectionConfig(channel, ops ? applySettingsOps(current.config, ops) : { ...current.config, ...patch });
        db.prepare('INSERT INTO assistant_connections VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload').run(channel, current.revision + 1, JSON.stringify(config));
        db.exec('COMMIT');
        notifySettings(listeners, { namespace: `superagent-connections:${channel}` });
        return { channel, revision: current.revision + 1, config };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    close() { listeners.clear(); db.close(); },
  };
}
