import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync, existsSync, openSync, fsyncSync, closeSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { notifySettings } from '../../benchgo/shared/settings-adapter-utils.mjs';

export const ASSISTANT_DOCUMENTS = Object.freeze(['AGENTS.md', 'SOUL.md', 'USER.md', 'IDENTITY.md', 'TOOLS.md', 'MEMORY.md']);
// TOOLS remains managed for legacy imports and on-demand reading, not injection.
export const ASSISTANT_CONTEXT_DOCUMENTS = Object.freeze(['SOUL.md', 'IDENTITY.md', 'USER.md', 'AGENTS.md', 'MEMORY.md']);
const templates = {
  "AGENTS.md": "# 工作约定\n\n执行用户已交代的工作；发现范围外新事项时先提出建议。\n前台保持可交流，持续工作交由后台任务；默认只报告结果、失败和需要用户决定的事项。\n以真实产物和验证为完成依据，工具与执行权限以当前服务为准。\n",
  "SOUL.md": "# 沟通风格\n\n清晰、简洁、诚实。先给结论，按需要补充依据。\n普通细节自行判断，关键歧义及时澄清；不编造事实、进度或完成状态。\n",
  "USER.md": "# 用户资料与偏好\n\n尚未记录。仅保存用户明确资料和长期偏好；未知项保持空白。\n\n## 不要学习\n\n此处可写不应进入长期记忆的主题和范围。\n",
  "IDENTITY.md": "# 助手身份\n\n我是 BenchGo 中的长期个人助手，以宠物形象陪伴用户，负责理解需求、工作协调与结果交付。\n默认没有名字；用户命名后由本文件顶部的 name 字段管理，空字符串表示未命名。\n默认使用品牌形象，也支持用户自己的形象。更换外观不改变我的身份、权限或记忆。\n自身人设沿用 SOUL.md，用户资料沿用 USER.md，共同经历与长期经验沿用同一套记忆。\n",
  "TOOLS.md": "# 本地工具笔记\n\n记录已核实的环境特点、使用经验及配置入口。\n实际工具可用性以当前运行时服务为准；此文件不保存密钥、令牌或工具注册表。\n",
  "MEMORY.md": "# 长期记忆\n\n记录有来源的长期事实、决定和经验；不保存原始聊天或当前任务状态。\n"
};
// Exact hashes only: preserve user-edited documents.
const brokenTemplateHashes = {
  "AGENTS.md": "308d35adb9ec37a0b97940e63f68d4efc8d8e327448006b19a9b9939238af0e4",
  "SOUL.md": "1bfcec3377948670e05cfbecd35567672a0827065a5c9279e535725a5e692d79",
  "USER.md": "e9753ef2cfd6c635543f442a91b052da3b2e23993775fa1001bcb406bd48daa5",
  "IDENTITY.md": "b09a5922c96decc206084aaa920f9f0e1adf393264a368870f98b3638ad5e82e",
  "TOOLS.md": "2f1a818788f145d76f865f6ec91d69712dbc2112fff28dbd274bb394f795683a",
  "MEMORY.md": "2d2c3074e3e78bb005f0f1292265c38f7ed78ebe4d3c71eb2941fc2bc54c5563"
};
const now = () => new Date().toISOString();
export const documentHash = content => createHash('sha256').update(content, 'utf8').digest('hex');
const decode = value => value ? JSON.parse(value) : null;
const queues = new Map();
const conflict = hash => Object.assign(new Error('Assistant document changed; reload before saving'), { code: 'HASH_CONFLICT', hash });
const validName = name => {
  if (!ASSISTANT_DOCUMENTS.includes(name)) throw new Error('未知助手文档');
  return name;
};
function validText(content) {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > 1024 * 1024 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(content)) throw new Error('文档必须是有效文本且不超过 1 MiB');
}
function sourceValue(source = { type: 'user-edit' }) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('Invalid document source');
  const text = JSON.stringify(source);
  if (text.length > 16000) throw new Error('Document source exceeds limit');
  return text;
}
function atomic(path, content) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, content, 'utf8');
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    renameSync(temporary, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

/** Markdown is authoritative. SQLite holds only journal, history and derived metadata. */
export async function createAssistantDocuments({ directory }) {
  const listeners = new Set();
  directory = resolve(directory);
  mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(join(directory, 'assistant.db'));
  db.exec(`PRAGMA busy_timeout=5000;
    PRAGMA secure_delete=ON;
    CREATE TABLE IF NOT EXISTS document_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS session_context_snapshots (session_id TEXT PRIMARY KEY, context TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS document_lock (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, pid INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS document_current (name TEXT PRIMARY KEY, hash TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL, source TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS document_versions (id TEXT PRIMARY KEY, name TEXT NOT NULL, hash TEXT NOT NULL, content TEXT NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS document_journal (id TEXT PRIMARY KEY, name TEXT NOT NULL, old_hash TEXT, new_hash TEXT NOT NULL, version_id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS document_versions_name ON document_versions(name,revision);
    CREATE INDEX IF NOT EXISTS document_journal_status ON document_journal(status);`);
  let closed = false;
  const tx = fn => { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  const meta = key => decode(db.prepare('SELECT value FROM document_meta WHERE key=?').get(key)?.value);
  const setMeta = (key, value) => db.prepare('INSERT INTO document_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
  const actual = name => {
    try { const value = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(join(directory, name))); validText(value); return value; }
    catch (error) { error.document = name; throw error; }
  };
  function current(name) { return db.prepare('SELECT * FROM document_current WHERE name=?').get(name); }
  function version(name, content, source, revision, status = 'committed') {
    const entry = { id: randomUUID(), name, hash: documentHash(content), content, revision, createdAt: now(), source: JSON.parse(sourceValue(source)), status };
    db.prepare('INSERT INTO document_versions VALUES (?,?,?,?,?,?,?,?)').run(entry.id, name, entry.hash, content, revision, entry.createdAt, JSON.stringify(entry.source), status);
    return entry;
  }
  function adopt(entry) {
    db.prepare('INSERT INTO document_current VALUES (?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET hash=excluded.hash,revision=excluded.revision,updated_at=excluded.updated_at,source=excluded.source').run(entry.name, entry.hash, entry.revision, entry.createdAt, JSON.stringify(entry.source));
  }
  function sync(name) {
    const content = actual(name), hash = documentHash(content), previous = current(name);
    if (!previous || previous.hash !== hash) tx(() => adopt(version(name, content, { type: previous ? 'external-edit' : 'initialization' }, (previous?.revision || 0) + 1)));
    const row = current(name);
    return { name, content, hash, revision: row.revision, updatedAt: row.updated_at, source: decode(row.source) };
  }
  function recover() {
    for (const row of db.prepare("SELECT * FROM document_journal WHERE status='prepared'").all()) {
      let hash;
      try { hash = documentHash(actual(row.name)); } catch { continue; }
      tx(() => {
        const record = db.prepare('SELECT * FROM document_versions WHERE id=?').get(row.version_id);
        const status = hash === row.new_hash ? 'committed' : hash === row.old_hash ? 'aborted' : 'conflict';
        if (status === 'committed') {
          const entry = { ...record, createdAt: record.created_at, source: decode(record.source) };
          adopt(entry);
        }
        db.prepare('UPDATE document_versions SET status=? WHERE id=?').run(status, row.version_id);
        db.prepare('UPDATE document_journal SET status=? WHERE id=?').run(status, row.id);
      });
    }
  }
  async function acquire(owner) {
    const until = Date.now() + 5000;
    do {
      const taken = tx(() => {
        const lock = db.prepare('SELECT * FROM document_lock WHERE id=1').get();
        if (lock) {
          try { process.kill(lock.pid, 0); return false; } catch (error) { if (error.code !== 'ESRCH') return false; }
          db.prepare('DELETE FROM document_lock WHERE id=1 AND owner=?').run(lock.owner);
        }
        db.prepare('INSERT INTO document_lock VALUES (1,?,?)').run(owner, process.pid); return true;
      });
      if (taken) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (Date.now() < until);
    throw Object.assign(new Error('助手文档正由其他进程写入，请稍后重试'), { code: 'DOCUMENT_BUSY' });
  }
  function locked(fn) {
    const previous = queues.get(directory) || Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      if (closed) throw new Error('Document store is closed');
      const owner = randomUUID(); await acquire(owner);
      try { recover(); return fn(); }
      finally { db.prepare('DELETE FROM document_lock WHERE id=1 AND owner=?').run(owner); }
    });
    queues.set(directory, operation);
    return operation.finally(() => { if (queues.get(directory) === operation) queues.delete(directory); });
  }
  function change(name, content, { expectedHash, source, requireHash = true } = {}) {
    validName(name); validText(content); sourceValue(source);
    const previous = sync(name);
    if (requireHash && typeof expectedHash !== 'string') throw new Error('expectedHash is required');
    if (expectedHash !== undefined && expectedHash !== previous.hash) throw conflict(previous.hash);
    if (content === previous.content) {
      return previous;
    }
    const id = randomUUID();
    const pending = tx(() => {
      const entry = version(name, content, source, previous.revision + 1, 'prepared');
      db.prepare('INSERT INTO document_journal VALUES (?,?,?,?,?,?,?)').run(id, name, previous.hash, entry.hash, entry.id, 'prepared', now());
      return entry;
    });
    const path = join(directory, name);
    const beforeHash = documentHash(actual(name));
    if (beforeHash !== previous.hash) { recover(); sync(name); throw conflict(beforeHash); }
    atomic(path, content);
    const persistedHash = documentHash(actual(name));
    if (persistedHash !== pending.hash) { recover(); sync(name); throw conflict(persistedHash); }
    tx(() => {
      adopt(pending);
      db.prepare("UPDATE document_versions SET status='committed' WHERE id=?").run(pending.id);
      db.prepare("UPDATE document_journal SET status='committed' WHERE id=?").run(id);
    });
    notifySettings(listeners, { name });
    return { name, content, hash: pending.hash, revision: pending.revision, updatedAt: pending.createdAt, source: pending.source };
  }
  function initialize() {
    if (!meta('legacy-profile-v1')) {
      const backup = join(directory, 'migration-v1');
      const migrated = [], conflicts = [];
      const names = readdirSync(directory);
      for (const lower of ['identity.md', 'user.md']) {
        const upper = lower.toUpperCase().replace('.MD', '.md');
        // A crash during a case-only rename is recoverable from the migration backup.
        if (!names.includes(lower)) {
          const backupPath = join(backup, lower);
          if (!existsSync(join(directory, upper)) && existsSync(backupPath)) copyFileSync(backupPath, join(directory, upper));
          continue;
        }
        mkdirSync(backup, { recursive: true });
        const backupPath = join(backup, lower);
        if (!existsSync(backupPath)) copyFileSync(join(directory, lower), backupPath);
        if (names.includes(upper)) {
          if (actual(lower) !== actual(upper)) conflicts.push({ legacy: lower, current: upper, backup: `migration-v1/${lower}`, reason: '两份大小写文档并存；当前大写文档有效，旧版保留待合并' });
          continue;
        }
        const temporary = join(directory, `${lower}.${randomUUID()}.migration`);
        renameSync(join(directory, lower), temporary);
        renameSync(temporary, join(directory, upper));
        migrated.push({ from: lower, to: upper, backup: `migration-v1/${lower}` });
      }
      setMeta('legacy-profile-v1', { completedAt: now(), migrated, conflicts });
    }
    for (const name of ASSISTANT_DOCUMENTS) {
      if (!existsSync(join(directory, name))) {
        if (current(name)) throw Object.assign(new Error(`助手文档 ${name} 缺失；请恢复文件，不会用模板覆盖已有资料`), { code: 'DOCUMENT_MISSING', document: name });
        writeFileSync(join(directory, name), templates[name], { flag: 'wx', mode: 0o600 });
      }
      const original = sync(name);
      const header = name === 'IDENTITY.md' ? original.content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n\r?\n/)?.[0] || '' : '';
      if (documentHash(original.content.slice(header.length)) === brokenTemplateHashes[name]) {
        change(name, header + templates[name], { expectedHash: original.hash, source: { type: 'template-encoding-repair' } });
      }
    }
  }
  try { await locked(initialize); } catch (error) { db.close(); throw error; }
  return {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    names: ASSISTANT_DOCUMENTS,
    list: () => locked(() => ASSISTANT_DOCUMENTS.map(sync)),
    read: name => locked(() => sync(validName(name))),
    update: (name, options) => locked(() => change(name, options?.content, options)),
    // Used by legacy profile and entry adapters: transformation happens under the same profile lock.
    mutate: (name, transform, options = {}) => locked(() => {
      const previous = sync(validName(name));
      if (options.expectedHash !== undefined && options.expectedHash !== previous.hash) throw conflict(previous.hash);
      const content = transform(previous.content, previous);
      return change(name, content, { ...options, expectedHash: previous.hash });
    }),
    versions: name => locked(() => {
      sync(validName(name));
      return db.prepare('SELECT * FROM document_versions WHERE name=? ORDER BY revision DESC,rowid DESC LIMIT 100').all(name).map(row => ({ id: row.id, name: row.name, hash: row.hash, content: row.content, revision: row.revision, createdAt: row.created_at, source: decode(row.source), status: row.status }));
    }),
    restore: (name, { versionId, expectedHash }) => locked(() => {
      validName(name);
      const row = db.prepare("SELECT * FROM document_versions WHERE id=? AND name=? AND status='committed'").get(versionId, name);
      if (!row) throw new Error('文档版本不存在或不可恢复');
      return change(name, row.content, { expectedHash, source: { type: 'restore', versionId } });
    }),
    context: () => locked(() => {
      const documents = ASSISTANT_CONTEXT_DOCUMENTS.map(sync);
      const hashes = Object.fromEntries(documents.map(row => [row.name, row.hash]));
      return { documents, hashes, snapshotId: documentHash(JSON.stringify(hashes)) };
    }),
    migration: () => locked(() => meta('legacy-profile-v1')),
    sessionContext: (sessionId, sanitize = value => value) => locked(() => {
      const row = db.prepare('SELECT context FROM session_context_snapshots WHERE session_id=?').get(sessionId);
      if (!row) return null;
      const context = sanitize(decode(row.context));
      const encoded = JSON.stringify(context);
      if (encoded !== row.context) db.prepare('UPDATE session_context_snapshots SET context=? WHERE session_id=?').run(encoded, sessionId);
      return context;
    }),
    freezeSessionContext: (sessionId, context, sanitize = value => value) => locked(() => {
      if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('Session identity is required');
      // First writer wins, including concurrent engines restoring one session.
      db.prepare('INSERT OR IGNORE INTO session_context_snapshots VALUES (?,?,?)').run(sessionId, JSON.stringify(sanitize(context)), now());
      return decode(db.prepare('SELECT context FROM session_context_snapshots WHERE session_id=?').get(sessionId).context);
    }),
    redactSessionContexts: transform => locked(() => tx(() => {
      for (const row of db.prepare('SELECT session_id,context FROM session_context_snapshots').all()) {
        const context = JSON.stringify(transform(decode(row.context)));
        if (context !== row.context) db.prepare('UPDATE session_context_snapshots SET context=? WHERE session_id=?').run(context, row.session_id);
      }
    })),
    // Privacy cleanup applies only to managed history, never restores it into the current file.
    redactHistory: (name, transform) => locked(() => tx(() => {
      validName(name);
      for (const row of db.prepare('SELECT id,content FROM document_versions WHERE name=?').all(name)) {
        const content = transform(row.content);
        if (content !== row.content) db.prepare('UPDATE document_versions SET content=?,hash=? WHERE id=?').run(content, documentHash(content), row.id);
      }
    })),
    close() { if (!closed) { closed = true; listeners.clear(); db.close(); } },
  };
}
