import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { documentHash } from './documents.mjs';

const now = () => new Date().toISOString();
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const copy = value => structuredClone(value);
const normalized = value => value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, ' ').trim();
const fingerprint = value => documentHash(normalized(value));
const sourceFingerprint = source => documentHash(JSON.stringify([source?.sessionId || '', source?.messageId || '', source?.eventId || '', source?.taskId || '', source?.callId || '']));
const hasSource = source => object(source) && Boolean(source.messageId || source.eventId || source.taskId || source.callId || source.type === 'user-edit' || source.type === 'external-edit');
const trustedSource = source => hasSource(source) && source.role === 'user' && Boolean(source.messageId || source.eventId);
const blockPattern = () => /<!-- benchgo-memory (\{[^\n]*\}) -->\r?\n([\s\S]*?)\r?\n<!-- \/benchgo-memory -->/gu;
const learningPattern = /<!-- benchgo-learning (\{[^\n]*\}) -->/u;
const intro = '记录有来源的长期事实、决定和经验；不保存原始聊天或当前任务状态。';
const limit = (value, fallback, max) => Number.isSafeInteger(value) && value > 0 ? Math.min(value, max) : fallback;
const matchesId = (entry, id) => entry.id === id || entry.legacyIds?.includes(id);
const cleanText = value => String(value || '').replace(/<!--[\s\S]*?(?:-->|$)/gu, '');
const sourceReference = ({ excerpt, excerptTruncated, ...source }) => source;

/** Model projection only: stored Markdown and frozen snapshots retain their edit/forget metadata. */
export function cleanMemoryContext(context) {
  return { ...context,
    documents: (context.documents || []).map(row => ({ ...row, content: cleanText(row.content) })),
    memories: (context.memories || []).map(entry => ({ ...entry, content: cleanText(entry.content),
      source: entry.source?.excerpt === undefined ? entry.source : { ...entry.source, excerpt: cleanText(entry.source.excerpt) } })),
    ...(typeof context.userProfile === 'string' ? { userProfile: cleanText(context.userProfile) } : {}),
    ...(typeof context.assistantIdentity === 'string' ? { assistantIdentity: cleanText(context.assistantIdentity) } : {}),
  };
}

function inputValue(input) {
  if (!object(input) || typeof input.content !== 'string' || !input.content.trim() || input.content.length > 16000 || /<!--\s*\/?benchgo-memory/u.test(input.content) || !object(input.source)) throw new Error('Memory requires content and source');
  if (typeof input.scope !== 'undefined' && (typeof input.scope !== 'string' || !input.scope || input.scope.length > 256)) throw new Error('Invalid memory scope');
  if (input.document !== undefined && !['MEMORY.md', 'USER.md', 'TOOLS.md'].includes(input.document)) throw new Error('Invalid memory document');
  if (input.source.excerpt !== undefined && (typeof input.source.excerpt !== 'string' || input.source.excerpt.length > 6000)) throw new Error('Invalid memory source excerpt');
  if (input.source.excerptTruncated !== undefined && typeof input.source.excerptTruncated !== 'boolean') throw new Error('Invalid memory source excerpt truncation');
  if (JSON.stringify(input.source).length > 16000) throw new Error('Memory source exceeds limit');
  if (JSON.stringify(input).length > 64000) throw new Error('Memory input exceeds limit');
  return input;
}
function annotation(entry) {
  const { content, document, start, end, manual, score, ...metadata } = entry;
  return `<!-- benchgo-memory ${JSON.stringify(metadata).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')} -->\n${content.trim()}\n<!-- /benchgo-memory -->`;
}
function publicEntry({ start, end, ...entry }) { return entry; }
export function parseMemoryDocument(content, document = 'MEMORY.md') {
  const entries = [], spans = [];
  for (const match of content.matchAll(blockPattern())) {
    let data;
    try { data = JSON.parse(match[1]); } catch { throw Object.assign(new Error(`记忆标识损坏：${document}`), { code: 'MEMORY_PARSE_ERROR', document }); }
    if (!object(data) || typeof data.id !== 'string' || !data.id || !object(data.source) || !Number.isSafeInteger(data.revision) || data.revision < 1) throw Object.assign(new Error(`记忆元数据损坏：${document}`), { code: 'MEMORY_PARSE_ERROR', document });
    entries.push({ ...data, content: match[2].trim(), document, start: match.index, end: match.index + match[0].length });
    spans.push([match.index, match.index + match[0].length]);
  }
  // Human Markdown remains editable: unannotated paragraphs in MEMORY receive stable derived IDs.
  if (document === 'MEMORY.md') {
    for (const match of content.matchAll(/[^\r\n]+(?:\r?\n(?!\s*(?:\r?\n|#|<!--))[^\r\n]+)*/gu)) {
      const text = match[0].trim();
      if (!text || /^#|^<!--/u.test(text) || text === intro || spans.some(([start, end]) => match.index < end && match.index + match[0].length > start)) continue;
      const id = `manual-${fingerprint(text).slice(0, 24)}`;
      if (entries.some(entry => entry.id === id)) continue;
      entries.push({ id, content: text, source: { type: 'external-edit', document, excerpt: text.slice(0, 6000), excerptTruncated: text.length > 6000 }, scope: 'personal', createdAt: null, updatedAt: null, revision: 1, document, manual: true, start: match.index, end: match.index + match[0].length });
    }
  }
  if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw Object.assign(new Error(`记忆 ID 重复：${document}`), { code: 'MEMORY_PARSE_ERROR', document });
  return entries.sort((a, b) => a.start - b.start);
}
export function memorySearchTerms(text) {
  const tokens = new Set();
  for (const match of normalized(text).matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[\p{L}\p{N}_@./:-]+/gu)) {
    const value = match[0];
    if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u.test(value)) {
      const chars = [...value];
      for (let index = 0; index < chars.length - 1; index++) tokens.add(chars[index] + chars[index + 1]);
      if (chars.length === 1) tokens.add(value);
    } else tokens.add(value);
  }
  return [...tokens];
}

export async function createAssistantMemory({ directory, documents }) {
  const db = new DatabaseSync(join(directory, 'assistant.db'));
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;
    CREATE TABLE IF NOT EXISTS memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS memory_index (id TEXT PRIMARY KEY, document TEXT NOT NULL, hash TEXT NOT NULL, source_hash TEXT NOT NULL, scope TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS memory_terms (term TEXT NOT NULL, entry_id TEXT NOT NULL, PRIMARY KEY(term,entry_id));
    CREATE TABLE IF NOT EXISTS memory_tombstones (entry_id TEXT NOT NULL, hash TEXT NOT NULL, source_hash TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(entry_id,hash));
    CREATE TABLE IF NOT EXISTS memory_candidates (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL UNIQUE, status TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS memory_terms_entry ON memory_terms(entry_id);
    CREATE INDEX IF NOT EXISTS memory_tombstone_hash ON memory_tombstones(hash);
    CREATE INDEX IF NOT EXISTS memory_tombstone_source ON memory_tombstones(source_hash);`);
  const tx = fn => { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  const meta = key => { const row = db.prepare('SELECT value FROM memory_meta WHERE key=?').get(key); return row ? JSON.parse(row.value) : null; };
  const setMeta = (key, value) => db.prepare('INSERT INTO memory_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
  let closed = false;
  function tombstone(entry, reason = 'corrected') {
    const put = db.prepare("INSERT INTO memory_tombstones VALUES (?,?,?,?,?) ON CONFLICT(entry_id,hash) DO UPDATE SET reason=CASE WHEN excluded.reason='forgotten' THEN excluded.reason ELSE memory_tombstones.reason END");
    for (const id of new Set([entry.id, ...(entry.legacyIds || [])])) for (const hash of new Set([fingerprint(entry.content), fingerprint(cleanText(entry.content))])) {
      put.run(id, hash, hasSource(entry.source) ? sourceFingerprint(entry.source) : '', reason, now());
    }
  }
  function denied(input) {
    const byHash = db.prepare('SELECT 1 FROM memory_tombstones WHERE hash=? LIMIT 1').get(fingerprint(input.content));
    const bySource = hasSource(input.source) && (input.source.messageId || input.source.eventId || input.source.taskId || input.source.callId) && db.prepare('SELECT 1 FROM memory_tombstones WHERE source_hash=? LIMIT 1').get(sourceFingerprint(input.source));
    return Boolean(byHash || bySource);
  }
  function redactForgottenContext(context) {
    const forgotten = db.prepare("SELECT entry_id,hash FROM memory_tombstones WHERE reason='forgotten'").all();
    const ids = new Set(forgotten.map(row => row.entry_id)), hashes = new Set(forgotten.map(row => row.hash));
    if (!ids.size) return context;
    const documents = (context.documents || []).map(row => {
      if (!['MEMORY.md', 'USER.md', 'TOOLS.md'].includes(row.name)) return row;
      const removed = parseMemoryDocument(row.content, row.name).filter(entry => [entry.id, ...(entry.legacyIds || [])].some(id => ids.has(id)));
      let content = row.content;
      for (const entry of removed.reverse()) content = content.slice(0, entry.start) + content.slice(entry.end);
      // Runtime projections contain no HTML markers. Match full bounded paragraph ranges
      // against hashes, including memories omitted/truncated by the structured selection.
      if (!/<!--\s*benchgo-memory/u.test(content)) {
        const spans = [...content.matchAll(/\S[\s\S]*?(?=\r?\n\s*\r?\n|$)/gu)];
        const removals = [];
        for (let start = 0; start < spans.length; start++) for (let end = start; end < spans.length; end++) {
          const from = spans[start].index, to = spans[end].index + spans[end][0].length;
          if (to - from > 16000) break;
          if (hashes.has(fingerprint(content.slice(from, to)))) { removals.push([from, to]); start = end; break; }
        }
        for (const [from, to] of removals.reverse()) content = content.slice(0, from) + content.slice(to);
      }
      return content === row.content ? row : { ...row, content, hash: documentHash(content) };
    });
    const memories = (context.memories || []).filter(entry => ![entry.id, ...(entry.legacyIds || [])].some(id => ids.has(id)));
    if (documents.every((row, index) => row === context.documents[index]) && memories.length === (context.memories || []).length) return context;
    const result = { ...context, documents, memories };
    // Runtime context also carries USER.md under its historical profile alias.
    if (typeof context.userProfile === 'string') {
      const user = documents.find(row => row.name === 'USER.md');
      if (user) result.userProfile = user.content;
    }
    if (context.hashes) {
      result.hashes = Object.fromEntries(documents.map(row => [row.name, row.hash]));
      result.snapshotId = documentHash(JSON.stringify(result.hashes));
    }
    return result;
  }
  async function snapshot() {
    const rows = (await documents.list()).filter(row => ['MEMORY.md', 'USER.md', 'TOOLS.md'].includes(row.name));
    const entries = rows.flatMap(row => parseMemoryDocument(row.content, row.name));
    if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw Object.assign(new Error('多个文档存在重复记忆 ID'), { code: 'MEMORY_PARSE_ERROR' });
    const hashes = Object.fromEntries(rows.map(row => [row.name, row.hash]));
    if (JSON.stringify(meta('index-hashes')) !== JSON.stringify(hashes)) tx(() => {
      const byId = new Map(entries.flatMap(entry => [entry.id, ...(entry.legacyIds || [])].map(id => [id, entry])));
      for (const previous of db.prepare('SELECT * FROM memory_index').all()) {
        const next = byId.get(previous.id);
        if (!next || fingerprint(next.content) !== previous.hash) db.prepare('INSERT OR IGNORE INTO memory_tombstones VALUES (?,?,?,?,?)').run(previous.id, previous.hash, previous.source_hash, 'external-edit', now());
      }
      db.exec('DELETE FROM memory_terms; DELETE FROM memory_index;');
      for (const entry of entries) {
        db.prepare('INSERT INTO memory_index VALUES (?,?,?,?,?)').run(entry.id, entry.document, fingerprint(entry.content), hasSource(entry.source) ? sourceFingerprint(entry.source) : '', entry.scope || 'personal');
        for (const token of memorySearchTerms(entry.content)) db.prepare('INSERT OR IGNORE INTO memory_terms VALUES (?,?)').run(token, entry.id);
      }
      setMeta('index-hashes', hashes);
    });
    return { rows, entries };
  }
  async function learning() {
    const row = await documents.read('USER.md');
    const match = learningPattern.exec(row.content);
    const config = match ? JSON.parse(match[1]) : {};
    const heading = /(?:^|\n)##\s+不要学习\s*\r?\n([\s\S]*?)(?=\n##\s|$)/u.exec(row.content)?.[1] || '';
    const writtenTerms = [...heading.matchAll(/^\s*[-*]\s+(.+?)\s*$/gmu)].map(match => match[1]);
    return { enabled: config.enabled !== false, excludedScopes: config.excludedScopes || [], excludedTerms: [...new Set([...(config.excludedTerms || []), ...writtenTerms])], hash: row.hash };
  }
  const excludedByPolicy = (entry, settings) => settings.excludedScopes.includes(entry.scope || 'personal') || settings.excludedTerms.some(term => normalized(entry.content).includes(normalized(term)));
  async function save(input, { revision, expectedHash, explicit = true, candidateId } = {}) {
    inputValue(input);
    const { entries } = await snapshot();
    const previous = input.id ? entries.find(entry => matchesId(entry, input.id)) : null;
    if (input.id && !previous) throw new Error('Memory not found');
    if (!explicit && denied(input)) throw Object.assign(new Error('该来源或内容已被用户纠正、拒绝或遗忘'), { code: 'MEMORY_EXCLUDED' });
    const document = previous?.document || input.document || 'MEMORY.md';
    let saved;
    await documents.mutate(document, (body, current) => {
      if (!explicit && denied(input)) throw Object.assign(new Error('该来源或内容已被用户纠正、拒绝或遗忘'), { code: 'MEMORY_EXCLUDED' });
      const rows = parseMemoryDocument(body, document);
      // The candidate mapping is durable in Markdown before its DB receipt is updated.
      const accepted = candidateId && rows.find(entry => entry.candidateId === candidateId || entry.id === `candidate-${candidateId}` || fingerprint(entry.content) === fingerprint(input.content));
      if (accepted) {
        saved = publicEntry(accepted.candidateId ? accepted : { ...accepted, candidateId });
        return accepted.candidateId ? body : body.slice(0, accepted.start) + annotation(saved) + body.slice(accepted.end);
      }
      const existing = previous ? rows.find(entry => entry.id === previous.id) : null;
      if (previous && (!existing || (revision !== undefined && existing.revision !== revision))) throw Object.assign(new Error('Assistant data changed; reload before saving'), { code: 'REVISION_CONFLICT', revision: existing?.revision });
      const timestamp = now();
      const source = copy(input.source);
      if (source.type === 'user-edit' || source.kind === 'user') Object.assign(source, { excerpt: input.content.slice(0, 6000), excerptTruncated: input.content.length > 6000 });
      const supersedes = existing ? { id: existing.id, revision: existing.revision, updatedAt: existing.updatedAt || existing.createdAt || null } : undefined;
      saved = { id: existing?.id || randomUUID(), content: input.content.trim(), source, scope: input.scope || existing?.scope || 'personal', createdAt: existing?.createdAt || timestamp, updatedAt: timestamp, revision: (existing?.revision || 0) + 1, document,
        ...(candidateId || existing?.candidateId ? { candidateId: candidateId || existing.candidateId } : {}),
        ...(existing?.legacyIds ? { legacyIds: existing.legacyIds } : {}),
        ...(supersedes ? { supersedes, versionChain: [...(existing.versionChain || []), supersedes] } : {}),
      };
      if (existing && existing.content !== saved.content) tombstone(existing);
      if (existing) return body.slice(0, existing.start) + annotation(saved) + body.slice(existing.end);
      return body.trimEnd() + '\n\n' + annotation(saved) + '\n';
    }, { expectedHash, source: sourceReference(input.source) });
    await snapshot();
    return saved;
  }
  async function remove(id, { revision, purgeHistory = false } = {}) {
    const { entries } = await snapshot();
    const previous = entries.find(entry => matchesId(entry, id));
    const aliases = new Set([id, ...(previous ? [previous.id, ...(previous.legacyIds || [])] : [])]);
    if (previous) await documents.mutate(previous.document, body => {
      const existing = parseMemoryDocument(body, previous.document).find(entry => matchesId(entry, id));
      if (!existing) return body;
      if (revision !== undefined && existing.revision !== revision) throw Object.assign(new Error('Assistant data changed; reload before saving'), { code: 'REVISION_CONFLICT', revision: existing.revision });
      tombstone(existing, 'forgotten');
      for (const alias of aliases) db.prepare("UPDATE memory_tombstones SET reason='forgotten' WHERE entry_id=?").run(alias);
      return body.slice(0, existing.start) + body.slice(existing.end);
    }, { source: { type: 'forget', entryId: id } });
    await snapshot();
    if (purgeHistory) {
      const redact = (body, document) => {
        const matched = parseMemoryDocument(body, document).filter(entry => [entry.id, ...(entry.legacyIds || [])].some(value => aliases.has(value)));
        let result = body;
        for (const entry of matched.reverse()) result = result.slice(0, entry.start) + result.slice(entry.end);
        return result;
      };
      for (const document of ['MEMORY.md', 'USER.md', 'TOOLS.md']) await documents.redactHistory(document, body => redact(body, document));
      await documents.redactSessionContexts(redactForgottenContext);
      for (const row of db.prepare('SELECT * FROM memory_candidates').all()) {
        const candidate = JSON.parse(row.payload);
        if (aliases.has(candidate.memoryId) || aliases.has(candidate.input?.id) || candidate.id === previous?.candidateId || (previous && fingerprint(candidate.input?.content || '') === fingerprint(previous.content))) db.prepare('DELETE FROM memory_candidates WHERE id=?').run(row.id);
      }
      const backup = join(directory, 'migration-v1', 'entries.json');
      if (existsSync(backup)) {
        const data = JSON.parse(readFileSync(backup, 'utf8'));
        if (Array.isArray(data.entries)) { data.entries = data.entries.filter(entry => !aliases.has(entry?.id)); writeFileSync(backup, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 }); }
      }
    }
    return Boolean(previous);
  }
  async function migrate() {
    if (meta('entries-v1')) return;
    const path = join(directory, 'memory', 'entries.json');
    if (!existsSync(path)) {
      mkdirSync(join(directory, 'memory'), { recursive: true });
      writeFileSync(path, JSON.stringify({ schemaVersion: 1, revision: 0, entries: [], migratedTo: '../MEMORY.md' }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      setMeta('entries-v1', { completedAt: now(), imported: 0 }); return;
    }
    const directoryBackup = join(directory, 'migration-v1'); mkdirSync(directoryBackup, { recursive: true });
    const backup = join(directoryBackup, 'entries.json');
    if (!existsSync(backup)) copyFileSync(path, backup);
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (data.schemaVersion !== 1 || !Array.isArray(data.entries)) throw new Error('旧版记忆格式不受支持；原文件与备份已保留');
    const invalid = [], ids = new Set();
    const valid = data.entries.filter((entry, index) => {
      try { inputValue(entry); if (typeof entry.id !== 'string' || !entry.id || ids.has(entry.id)) throw new Error('Invalid id'); ids.add(entry.id); return true; }
      catch (error) { invalid.push({ index, reason: error.message }); return false; }
    });
    const result = await documents.mutate('MEMORY.md', body => {
      const existing = new Set(parseMemoryDocument(body).map(entry => entry.id));
      const added = valid.filter(entry => !existing.has(entry.id)).map(entry => annotation({ ...entry, document: 'MEMORY.md', revision: Number.isSafeInteger(entry.revision) && entry.revision > 0 ? entry.revision : 1, scope: entry.scope || 'personal' }));
      return added.length ? body.trimEnd() + '\n\n' + added.join('\n\n') + '\n' : body;
    }, { source: { type: 'migration', path: 'memory/entries.json' } });
    // Leave a non-authoritative compatibility marker; never maintain a second editable body.
    const marker = JSON.stringify({ schemaVersion: 1, revision: data.revision || 0, entries: [], migratedTo: '../MEMORY.md', backup: '../migration-v1/entries.json' }, null, 2) + '\n';
    const temporary = `${path}.${randomUUID()}.tmp`; writeFileSync(temporary, marker, { mode: 0o600 }); renameSync(temporary, path);
    setMeta('entries-v1', { completedAt: now(), imported: valid.length, invalid, hash: result.hash, backup: 'migration-v1/entries.json' });
  }
  const candidateRow = row => row ? { ...JSON.parse(row.payload), status: row.status } : null;
  const updateCandidate = candidate => {
    db.prepare('UPDATE memory_candidates SET status=?,payload=? WHERE id=?').run(candidate.status, JSON.stringify(candidate), candidate.id);
    return candidate;
  };
  async function migrateCandidateIds() {
    for (const document of ['MEMORY.md', 'USER.md', 'TOOLS.md']) await documents.mutate(document, body => {
      let result = body;
      for (const entry of parseMemoryDocument(body, document).filter(row => row.id.startsWith('candidate-')).reverse()) {
        const migrated = { ...entry, id: randomUUID(), candidateId: entry.candidateId || entry.id.slice('candidate-'.length), legacyIds: [...new Set([...(entry.legacyIds || []), entry.id])] };
        result = result.slice(0, entry.start) + annotation(migrated) + result.slice(entry.end);
      }
      return result;
    }, { source: { type: 'memory-id-migration' } });
    // Markdown is the durable receipt. Repair DB mappings even if an earlier startup
    // stopped after the file write, without changing the entry's content or revision.
    const { entries } = await snapshot();
    for (const entry of entries) {
      if (!entry.candidateId) continue;
      const candidate = candidateRow(db.prepare('SELECT payload,status FROM memory_candidates WHERE id=?').get(entry.candidateId));
      if (candidate && candidate.status !== 'rejected' && (candidate.memoryId !== entry.id || candidate.status !== 'accepted')) {
        const { error, reason, ...saved } = candidate;
        updateCandidate({ ...saved, status: 'accepted', memoryId: entry.id, resolvedAt: saved.resolvedAt || now() });
      }
    }
  }
  async function resolveCandidate(id, patch = {}) {
    const candidate = candidateRow(db.prepare('SELECT payload,status FROM memory_candidates WHERE id=?').get(id));
    if (!candidate) throw new Error('记忆候选不存在');
    if (candidate.status === 'accepted') return candidate;
    if (candidate.status === 'rejected') throw new Error('记忆候选已拒绝');
    const input = { ...candidate.input, ...patch, source: candidate.evidence || candidate.input?.source };
    inputValue(input);
    const settings = await learning();
    if (!trustedSource(candidate.evidence) || !settings.enabled || excludedByPolicy(input, settings) || denied(input)) {
      return updateCandidate({ ...candidate, status: 'excluded', reason: '学习已停用，或内容/来源不符合当前学习规则', resolvedAt: now() });
    }
    try {
      const entry = await save(input, { candidateId: id, explicit: false });
      const { error, reason, ...saved } = candidate;
      return updateCandidate({ ...saved, status: 'accepted', memoryId: entry.id, resolvedAt: now() });
    } catch (error) {
      // Keep a durable retry record; storage failures are never disguised as a request for approval.
      updateCandidate({ ...candidate, status: error.code === 'MEMORY_EXCLUDED' ? 'excluded' : 'saving', error: error.message });
      throw error;
    }
  }
  async function recoverCandidates() {
    for (const row of db.prepare("SELECT id,payload FROM memory_candidates WHERE status IN ('pending','saving') ORDER BY created_at").all()) {
      const candidate = JSON.parse(row.payload);
      try { inputValue(candidate.input); }
      catch (error) { updateCandidate({ ...candidate, id: row.id, status: 'excluded', reason: error.message, resolvedAt: now() }); continue; }
      await resolveCandidate(row.id);
    }
  }
  try { await migrate(); await migrateCandidateIds(); await recoverCandidates(); } catch (error) { db.close(); throw error; }
  return {
    list: async () => (await snapshot()).entries.map(publicEntry),
    save, remove, redactForgottenContext,
    forgottenRevision: () => db.prepare("SELECT COUNT(*) AS n FROM memory_tombstones WHERE reason='forgotten'").get().n,
    forget: (id, options) => remove(id, { ...options, purgeHistory: true }),
    async search({ query = '', limit: count, scope } = {}) {
      if (typeof query !== 'string' || query.length > 2000) throw new Error('Invalid memory query');
      const snapshotValue = await snapshot(), settings = await learning();
      const entries = snapshotValue.entries.filter(entry => !excludedByPolicy(entry, settings)), amount = limit(count, 8, 100), text = normalized(query);
      if (!text) return entries.filter(entry => !scope || entry.scope === scope).slice(-amount).reverse().map(entry => ({ ...publicEntry(entry), score: 0 }));
      const terms = memorySearchTerms(query).slice(0, 64), scores = new Map();
      for (const token of terms) for (const row of db.prepare('SELECT entry_id FROM memory_terms WHERE term=? LIMIT 2000').all(token)) scores.set(row.entry_id, (scores.get(row.entry_id) || 0) + 1);
      const phrases = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[^\s]+/gu) || [];
      return entries.filter(entry => !scope || entry.scope === scope).map(entry => ({ ...publicEntry(entry), score: scores.get(entry.id) || 0 }))
        .filter(entry => { const body = normalized(entry.content); return phrases.some(phrase => body.includes(phrase)) && (entry.score || [...text].length === 1); })
        .sort((a, b) => b.score - a.score || String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))).slice(0, amount);
    },
    async context() {
      const snapshotValue = await snapshot(), result = await documents.context(), settings = await learning();
      return { ...result, documents: result.documents.map(row => {
        if (!['USER.md', 'MEMORY.md', 'TOOLS.md'].includes(row.name)) return row;
        const removed = parseMemoryDocument(row.content, row.name).filter(entry => excludedByPolicy(entry, settings));
        let content = row.content;
        for (const entry of removed.reverse()) content = content.slice(0, entry.start) + content.slice(entry.end);
        return { ...row, content, excludedEntries: removed.length };
      }),
      // Keep the structured projection under the same policy as the Markdown
      // projection. The raw list() API is intentionally reserved for
      // management and correction workflows; runtime callers must use this
      // privacy-filtered context.
      memories: snapshotValue.entries.filter(entry => !excludedByPolicy(entry, settings)).map(publicEntry),
      learning: settings };
    },
    learning,
    async configureLearning(patch, { expectedHash } = {}) {
      if (!object(patch) || Object.keys(patch).some(key => !['enabled', 'excludedScopes', 'excludedTerms'].includes(key))) throw new Error('Invalid learning configuration');
      if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') throw new Error('Invalid learning enabled');
      for (const key of ['excludedScopes', 'excludedTerms']) if (patch[key] !== undefined && (!Array.isArray(patch[key]) || patch[key].length > 100 || patch[key].some(value => typeof value !== 'string' || !value.trim() || value.length > 256))) throw new Error('Invalid learning exclusions');
      await documents.mutate('USER.md', body => {
        const match = learningPattern.exec(body), previous = match ? JSON.parse(match[1]) : {};
        const next = { ...previous, ...patch };
        const text = `<!-- benchgo-learning ${JSON.stringify(next).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')} -->`;
        return match ? body.replace(learningPattern, text) : body.trimEnd() + '\n\n' + text + '\n';
      }, { expectedHash, source: { type: 'learning-settings' } });
      return learning();
    },
    async propose(input, { verifiedSource } = {}) {
      inputValue(input);
      const current = await snapshot();
      const settings = await learning();
      const verifiedInput = { ...input, source: verifiedSource || input.source };
      const excluded = !trustedSource(verifiedSource) || !settings.enabled || denied(verifiedInput) || excludedByPolicy(input, settings);
      if (excluded) return { status: 'excluded', reason: '学习已停用，或内容/来源不符合当前学习规则' };
      const key = fingerprint(input.content);
      const known = candidateRow(db.prepare('SELECT payload,status FROM memory_candidates WHERE fingerprint=?').get(key));
      if (known) return ['accepted', 'rejected', 'excluded'].includes(known.status) ? known : resolveCandidate(known.id);
      const existing = current.entries.find(entry => fingerprint(entry.content) === key);
      if (existing) return { status: 'duplicate', memoryId: existing.id };
      const candidate = { id: randomUUID(), status: 'saving', input: copy(verifiedInput), evidence: copy(verifiedSource), createdAt: now() };
      db.prepare('INSERT OR IGNORE INTO memory_candidates VALUES (?,?,?,?,?)').run(candidate.id, key, candidate.status, JSON.stringify(candidate), candidate.createdAt);
      const persisted = db.prepare('SELECT id FROM memory_candidates WHERE fingerprint=?').get(key);
      return resolveCandidate(persisted.id);
    },
    candidates: async ({ status = 'pending' } = {}) => db.prepare('SELECT payload,status FROM memory_candidates WHERE status=? ORDER BY created_at DESC LIMIT 200').all(status).map(row => ({ ...JSON.parse(row.payload), status: row.status })),
    // Deprecated compatibility entry point; uses the same automatic policy, never an approval bypass.
    accept: resolveCandidate,
    async reject(id) {
      const row = db.prepare('SELECT * FROM memory_candidates WHERE id=?').get(id);
      if (!row) throw new Error('记忆候选不存在');
      const candidate = JSON.parse(row.payload);
      if (row.status === 'accepted') throw new Error('记忆已保存，请使用遗忘操作删除');
      if (row.status === 'rejected') return candidate;
      tombstone({ id, ...candidate.input }, 'rejected');
      const result = { id, status: 'rejected', createdAt: candidate.createdAt, resolvedAt: now() };
      db.prepare('UPDATE memory_candidates SET status=?,payload=? WHERE id=?').run(result.status, JSON.stringify(result), id);
      return result;
    },
    migration: async () => meta('entries-v1'),
    close() { if (!closed) { closed = true; db.close(); } },
  };
}
