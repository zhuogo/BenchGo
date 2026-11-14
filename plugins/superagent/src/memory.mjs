import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { documentHash, isAssistantDocument } from './documents.mjs';
import { applySettingsOps, assertSettingsExpected, settingsSnapshot } from '../../benchgo/shared/settings-adapter-utils.mjs';
import { LEARNING_CONFIG_SCHEMA } from './settings-schema.mjs';

const now = () => new Date().toISOString();
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const copy = value => structuredClone(value);
const normalized = value => value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, ' ').trim();
const fingerprint = value => documentHash(normalized(value));
const sourceFingerprint = source => documentHash(JSON.stringify([source?.sessionId || '', source?.messageId || '', source?.eventId || '', source?.taskId || '', source?.callId || '']));
const sourceAliases = source => {
  if (!object(source)) return [];
  return [source.messageId && ['message', source.sessionId || '', source.messageId],
    source.eventId && ['event', source.channel || '', source.eventId]].filter(Boolean).map(value => documentHash(JSON.stringify(value)));
};
const hasSource = source => object(source) && Boolean(source.messageId || source.eventId || source.taskId || source.callId || source.type === 'user-edit' || source.type === 'external-edit');
const trustedSource = source => hasSource(source) && source.role === 'user' && Boolean(source.messageId || source.eventId);
const blockPattern = () => /<!-- benchgo-memory (\{[^\n]*\}) -->\r?\n([\s\S]*?)\r?\n<!-- \/benchgo-memory -->/gu;
const learningPattern = /<!-- benchgo-learning (\{[^\n]*\}) -->/u;
const curatedPattern = () => /<!-- benchgo-curation (\{[^\n]*\}) -->\r?\n[\s\S]*?\r?\n<!-- \/benchgo-curation -->/gu;
const derivedPattern = /^<!-- benchgo-derived (\{[^\n]*\}) -->\r?\n/u;
export const MEMORY_CATEGORIES = Object.freeze(['world', 'experience', 'opinions', 'reflections']);
export const MEMORY_OUTLINE_LIMIT = 6000;
const memoryDocument = name => ['MEMORY.md', 'USER.md', 'TOOLS.md'].includes(name) || /^memory\/\d{4}-\d{2}-\d{2}\.md$/u.test(name);
const dailyDocument = timestamp => `memory/${String(timestamp || now()).slice(0, 10)}.md`;
const derivedDocument = name => /^memory\/(?:people|groups)\//u.test(name) || /^dreams\//u.test(name);
const limit = (value, fallback, max) => Number.isSafeInteger(value) && value > 0 ? Math.min(value, max) : fallback;
const cleanText = value => String(value || '').replace(/<!--[\s\S]*?(?:-->|$)/gu, '');
const sourceFields = new Set(['type', 'kind', 'role', 'sessionId', 'messageId', 'eventId', 'taskId', 'callId', 'threadId', 'channel', 'document', 'reviewId', 'resultVersion', 'profileId', 'turnId', 'entry', 'resultHash', 'artifactId']);
// Journals and derived receipts retain citations, never raw evidence text or arbitrary payloads.
const sourceReference = source => ({
  ...Object.fromEntries(Object.entries(source || {}).filter(([key, value]) => sourceFields.has(key) && ['string', 'number', 'boolean'].includes(typeof value))),
  ...(Array.isArray(source?.references) ? { references: source.references.map(sourceReference) } : {}),
});

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
  if (input.document !== undefined && (!isAssistantDocument(input.document) || !memoryDocument(input.document))) throw new Error('Invalid memory document');
  if (input.category !== undefined && !MEMORY_CATEGORIES.includes(input.category)) throw new Error('Invalid memory category');
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
  const entries = [], spans = [...content.matchAll(curatedPattern())].map(match => [match.index, match.index + match[0].length]);
  for (const match of content.matchAll(blockPattern())) {
    let data;
    try { data = JSON.parse(match[1]); } catch { throw Object.assign(new Error(`记忆标识损坏：${document}`), { code: 'MEMORY_PARSE_ERROR', document }); }
    if (!object(data) || typeof data.id !== 'string' || !data.id || !object(data.source) || !Number.isSafeInteger(data.revision) || data.revision < 1) throw Object.assign(new Error(`记忆元数据损坏：${document}`), { code: 'MEMORY_PARSE_ERROR', document });
    entries.push({ ...data, content: match[2].trim(), document, start: match.index, end: match.index + match[0].length });
    spans.push([match.index, match.index + match[0].length]);
  }
  // Human edits to daily records receive stable derived IDs. MEMORY is an outline, never a detail bank.
  if (/^memory\/\d{4}-\d{2}-\d{2}\.md$/u.test(document)) {
    for (const match of content.matchAll(/[^\r\n]+(?:\r?\n(?!\s*(?:\r?\n|#|<!--))[^\r\n]+)*/gu)) {
      const text = match[0].trim();
      if (!text || /^#|^<!--/u.test(text) || spans.some(([start, end]) => match.index < end && match.index + match[0].length > start)) continue;
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

/** Relevant excerpts only; full bodies remain available through memory/document tools. */
export function selectContextMemories(entries, query, { maxEntries = 8, maxCharacters = 8000 } = {}) {
  const terms = memorySearchTerms(String(query || ''));
  if (!terms.length) return [];
  const ranked = entries.map(entry => {
    const content = normalized(entry.content);
    return { entry, score: terms.reduce((sum, term) => sum + (content.includes(term) ? term.length : 0), 0) };
  })
    .filter(row => row.score > 0).sort((a, b) => b.score - a.score);
  const result = [], seen = new Set();
  for (const { entry } of ranked) {
    const key = normalized(entry.content);
    if (seen.has(key)) continue;
    seen.add(key);
    const content = cleanText(entry.content).slice(0, Math.min(2000, maxCharacters));
    if (!content) continue;
    result.push({ id: entry.id, content, scope: entry.scope,
      source: object(entry.source) ? sourceReference(entry.source) : entry.source,
      ...(content.length < cleanText(entry.content).length ? { truncated: true } : {}) });
    maxCharacters -= content.length;
    if (result.length >= maxEntries || maxCharacters <= 0) break;
  }
  return result;
}

export async function createAssistantMemory({ directory, documents }) {
  const db = new DatabaseSync(join(directory, 'assistant.db'));
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;
    CREATE TABLE IF NOT EXISTS memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS memory_index (id TEXT PRIMARY KEY, document TEXT NOT NULL, hash TEXT NOT NULL, source_hash TEXT NOT NULL, scope TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS memory_index_sources (entry_id TEXT PRIMARY KEY, source TEXT NOT NULL, clean_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS memory_terms (term TEXT NOT NULL, entry_id TEXT NOT NULL, PRIMARY KEY(term,entry_id));
    CREATE TABLE IF NOT EXISTS memory_tombstones (entry_id TEXT NOT NULL, hash TEXT NOT NULL, source_hash TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(entry_id,hash));
    CREATE TABLE IF NOT EXISTS memory_source_tombstones (source_hash TEXT PRIMARY KEY, reason TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS memory_candidates (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL UNIQUE, status TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS memory_learning_slots (slot TEXT PRIMARY KEY, candidate_id TEXT, memory_id TEXT);
    CREATE TABLE IF NOT EXISTS memory_derived (document TEXT PRIMARY KEY, dependencies TEXT NOT NULL, source TEXT NOT NULL, invalidated INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS memory_terms_entry ON memory_terms(entry_id);
    CREATE INDEX IF NOT EXISTS memory_tombstone_hash ON memory_tombstones(hash);
    CREATE INDEX IF NOT EXISTS memory_tombstone_source ON memory_tombstones(source_hash);`);
  const tx = fn => { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  const meta = key => { const row = db.prepare('SELECT value FROM memory_meta WHERE key=?').get(key); return row ? JSON.parse(row.value) : null; };
  const setMeta = (key, value) => db.prepare('INSERT INTO memory_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
  let closed = false;
  const listeners = new Set();
  const emitChange = async event => { for (const listener of listeners) await listener(copy(event)); };
  const parsedFiles = new Map();
  let invalidating = false;
  const unavailable = entry => Boolean(db.prepare("SELECT 1 FROM memory_tombstones WHERE entry_id=? AND reason='forgotten' LIMIT 1").get(entry.id)
    || db.prepare('SELECT 1 FROM memory_tombstones WHERE hash=? LIMIT 1').get(fingerprint(entry.content)));
  const references = source => [source, ...(Array.isArray(source?.references) ? source.references : [])].filter(hasSource);
  function outline(entries, ids) {
    const byId = new Map(entries.map(entry => [entry.id, entry])), selected = [];
    const usedSources = new Set();
    let content = '# 精选长期记忆\n\n';
    for (const id of [...new Set(ids)].slice(0, 40)) {
      const entry = byId.get(id);
      if (!entry || unavailable(entry)) continue;
      const sourceKey = entry.source?.messageId ? `message:${entry.source.sessionId || ''}:${entry.source.messageId}` : entry.source?.eventId ? `event:${entry.source.channel || ''}:${entry.source.eventId}` : entry.source?.taskId ? `task:${entry.source.taskId}` : null;
      if (sourceKey && usedSources.has(sourceKey)) continue;
      const text = cleanText(entry.content).replace(/\s+/gu, ' ').trim().slice(0, 180);
      const ref = entry.source?.messageId || entry.source?.eventId || entry.source?.taskId || entry.source?.callId || entry.source?.type || 'document';
      const line = `- ${text} [[memory:${entry.id}]]（来源：${String(ref).slice(0, 100)}）\n`;
      const dependency = { id: entry.id, revision: entry.revision, hash: fingerprint(entry.content) };
      const metadata = `<!-- benchgo-curation ${JSON.stringify({ entries: [...selected, dependency] })} -->\n`;
      if (content.length + line.length + metadata.length + 40 > MEMORY_OUTLINE_LIMIT) break;
      selected.push(dependency); content += line;
      if (sourceKey) usedSources.add(sourceKey);
    }
    return `<!-- benchgo-curation ${JSON.stringify({ entries: selected })} -->\n${content.trimEnd()}\n<!-- /benchgo-curation -->\n`;
  }
  function tombstone(entry, reason = 'corrected') {
    const put = db.prepare("INSERT INTO memory_tombstones VALUES (?,?,?,?,?) ON CONFLICT(entry_id,hash) DO UPDATE SET reason=CASE WHEN excluded.reason='forgotten' THEN excluded.reason ELSE memory_tombstones.reason END");
    for (const hash of new Set([fingerprint(entry.content), fingerprint(cleanText(entry.content))])) {
      put.run(entry.id, hash, hasSource(entry.source) ? sourceFingerprint(entry.source) : '', reason, now());
    }
    for (const alias of sourceAliases(entry.source)) db.prepare("INSERT INTO memory_source_tombstones VALUES (?,?) ON CONFLICT(source_hash) DO UPDATE SET reason=CASE WHEN excluded.reason='forgotten' THEN excluded.reason ELSE memory_source_tombstones.reason END").run(alias, reason);
  }
  function denied(input) {
    const byHash = db.prepare('SELECT 1 FROM memory_tombstones WHERE hash=? LIMIT 1').get(fingerprint(input.content));
    const bySource = hasSource(input.source) && (input.source.messageId || input.source.eventId || input.source.taskId || input.source.callId) && db.prepare('SELECT 1 FROM memory_tombstones WHERE source_hash=? LIMIT 1').get(sourceFingerprint(input.source));
    return Boolean(byHash || bySource || sourceAliases(input.source).some(alias => db.prepare('SELECT 1 FROM memory_source_tombstones WHERE source_hash=?').get(alias)));
  }
  function redactForgottenContext(context) {
    const forgotten = db.prepare("SELECT entry_id,hash FROM memory_tombstones WHERE reason='forgotten'").all();
    const ids = new Set(forgotten.map(row => row.entry_id)), hashes = new Set(forgotten.map(row => row.hash));
    const documents = (context.documents || []).map(row => {
      const derived = db.prepare('SELECT invalidated FROM memory_derived WHERE document=?').get(row.name);
      if (derivedDocument(row.name) && (!derived || derived.invalidated)) return { ...row, content: '', hash: documentHash('') };
      if (!memoryDocument(row.name)) return row;
      const removed = parseMemoryDocument(row.content, row.name).filter(entry => ids.has(entry.id));
      let content = row.content;
      for (const entry of removed.reverse()) content = content.slice(0, entry.start) + content.slice(entry.end);
      content = content.replace(curatedPattern(), block => {
        const data = JSON.parse(/<!-- benchgo-curation (\{[^\n]*\}) -->/u.exec(block)[1]);
        if (!(data.entries || []).some(entry => ids.has(entry.id))) return block;
        return block.split('\n').filter(line => !line.startsWith('<!-- benchgo-curation ') && !line.startsWith('<!-- /benchgo-curation') && ![...ids].some(id => line.includes(`[[memory:${id}]]`))).join('\n');
      });
      content = content.split('\n').filter(line => ![...ids].some(id => line.includes(`[[memory:${id}]]`))).join('\n');
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
    const memories = (context.memories || []).filter(entry => !ids.has(entry.id));
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
  async function invalidateDerived(entries) {
    if (invalidating) return;
    invalidating = true;
    try {
      const byId = new Map(entries.map(entry => [entry.id, entry]));
      for (const row of db.prepare('SELECT * FROM memory_derived WHERE invalidated<>2').all()) {
        const dependencies = JSON.parse(row.dependencies), source = JSON.parse(row.source);
        const stale = row.invalidated || dependencies.some(dependency => {
          const entry = byId.get(dependency.id);
          return !entry || entry.revision !== dependency.revision || fingerprint(entry.content) !== dependency.hash;
        }) || references(source).some(ref => denied({ content: '', source: ref }));
        if (!stale) continue;
        // Invalidate receipt first so even an interrupted cleanup cannot expose stale content.
        db.prepare('UPDATE memory_derived SET invalidated=1 WHERE document=?').run(row.document);
        await documents.mutate(row.document, () => '', { source: { type: 'derived-invalidation' } });
        await documents.redactHistory(row.document, () => '');
        await documents.redactSessionContexts(context => ({ ...context, documents: (context.documents || []).map(document => document.name === row.document ? { ...document, content: '', hash: documentHash('') } : document) }));
        db.prepare('UPDATE memory_derived SET invalidated=2 WHERE document=?').run(row.document);
      }
    } finally { invalidating = false; }
  }
  function registerDerived(rows, entries) {
    const byId = new Map(entries.map(entry => [entry.id, entry]));
    for (const row of rows.filter(row => derivedDocument(row.name))) {
      const previous = db.prepare('SELECT * FROM memory_derived WHERE document=?').get(row.name);
      let metadata;
      try {
        const match = derivedPattern.exec(row.content);
        if (!match || match[1].length > 40000) throw new Error('Missing derived evidence');
        metadata = JSON.parse(match[1]);
        if (!object(metadata) || !object(metadata.source) || !Array.isArray(metadata.memoryIds) || metadata.memoryIds.length > 100
          || metadata.memoryIds.some(dependency => !object(dependency) || typeof dependency.id !== 'string' || !dependency.id || dependency.id.length > 200
            || !Number.isSafeInteger(dependency.revision) || dependency.revision < 1 || !/^[a-f0-9]{64}$/u.test(dependency.hash))) throw new Error('Invalid derived evidence');
        metadata.source = sourceReference(metadata.source);
        if ((!metadata.memoryIds.length && !references(metadata.source).length) || JSON.stringify(metadata.source).length > 16000) throw new Error('Missing derived evidence');
      } catch {
        // A handwritten page without provenance remains available to its editor, but is never injected.
        // Removing provenance from a previously managed page revokes its former receipt.
        if (previous && previous.invalidated !== 2) db.prepare('UPDATE memory_derived SET invalidated=1 WHERE document=?').run(row.name);
        continue;
      }
      const stale = metadata.memoryIds.some(dependency => {
        const entry = byId.get(dependency.id);
        return !entry || entry.revision !== dependency.revision || fingerprint(entry.content) !== dependency.hash;
      }) || references(metadata.source).some(ref => denied({ content: '', source: ref }));
      const dependencies = JSON.stringify(metadata.memoryIds), source = JSON.stringify(metadata.source);
      if (!previous || previous.dependencies !== dependencies || previous.source !== source || previous.invalidated !== (stale ? 1 : 0)) {
        db.prepare('INSERT INTO memory_derived VALUES (?,?,?,?) ON CONFLICT(document) DO UPDATE SET dependencies=excluded.dependencies,source=excluded.source,invalidated=excluded.invalidated').run(row.name, dependencies, source, stale ? 1 : 0);
      }
    }
  }
  async function snapshot() {
    const allRows = await documents.list({ recursive: true });
    const rows = allRows.filter(row => memoryDocument(row.name) && row.name !== 'MEMORY.md');
    const externalChanges = [];
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index], cached = parsedFiles.get(row.name);
      if (cached?.hash !== row.hash) parsedFiles.set(row.name, { hash: row.hash, entries: parseMemoryDocument(row.content, row.name) });
      const forbidden = parsedFiles.get(row.name).entries.filter(unavailable);
      if (!forbidden.length) continue;
      rows[index] = await documents.mutate(row.name, body => {
        let content = body;
        for (const entry of parseMemoryDocument(body, row.name).filter(unavailable).reverse()) content = content.slice(0, entry.start) + content.slice(entry.end);
        return content;
      }, { source: { type: 'memory-tombstone-cleanup' } });
      await documents.redactHistory(row.name, body => {
        let content = body;
        for (const entry of parseMemoryDocument(body, row.name).filter(unavailable).reverse()) content = content.slice(0, entry.start) + content.slice(entry.end);
        return content;
      });
    }
    const entries = rows.flatMap(row => {
      const previous = parsedFiles.get(row.name);
      if (previous?.hash !== row.hash) parsedFiles.set(row.name, { hash: row.hash, entries: parseMemoryDocument(row.content, row.name) });
      return parsedFiles.get(row.name).entries;
    }).filter(entry => !unavailable(entry));
    if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw Object.assign(new Error('多个文档存在重复记忆 ID'), { code: 'MEMORY_PARSE_ERROR' });
    const hashes = Object.fromEntries(rows.map(row => [row.name, row.hash]));
    if (JSON.stringify(meta('index-hashes')) !== JSON.stringify(hashes)) tx(() => {
      const byId = new Map(entries.map(entry => [entry.id, entry]));
      for (const previous of db.prepare('SELECT * FROM memory_index').all()) {
        const next = byId.get(previous.id);
        if (!next || fingerprint(next.content) !== previous.hash) {
          const known = db.prepare('SELECT 1 FROM memory_tombstones WHERE entry_id=? AND hash=?').get(previous.id, previous.hash);
          const provenance = db.prepare('SELECT source,clean_hash FROM memory_index_sources WHERE entry_id=?').get(previous.id);
          const source = provenance ? JSON.parse(provenance.source) : null;
          for (const hash of new Set([previous.hash, provenance?.clean_hash].filter(Boolean))) db.prepare('INSERT OR IGNORE INTO memory_tombstones VALUES (?,?,?,?,?)').run(previous.id, hash, previous.source_hash, 'external-edit', now());
          for (const alias of sourceAliases(source)) db.prepare('INSERT OR IGNORE INTO memory_source_tombstones VALUES (?,?)').run(alias, 'external-edit');
          if (!known) externalChanges.push({ kind: 'corrected', memoryIds: [previous.id], references: source ? [source] : [] });
        }
      }
      const before = meta('index-hashes') || {};
      const changed = new Set([...Object.keys(before), ...Object.keys(hashes)].filter(name => before[name] !== hashes[name]));
      // File-local updates retain unaffected term rows and do not rebuild a global bank.
      for (const name of changed) {
        db.prepare('DELETE FROM memory_terms WHERE entry_id IN (SELECT id FROM memory_index WHERE document=?)').run(name);
        db.prepare('DELETE FROM memory_index_sources WHERE entry_id IN (SELECT id FROM memory_index WHERE document=?)').run(name);
        db.prepare('DELETE FROM memory_index WHERE document=?').run(name);
      }
      for (const entry of entries.filter(entry => changed.has(entry.document))) {
        db.prepare('INSERT INTO memory_index VALUES (?,?,?,?,?)').run(entry.id, entry.document, fingerprint(entry.content), hasSource(entry.source) ? sourceFingerprint(entry.source) : '', entry.scope || 'personal');
        db.prepare('INSERT INTO memory_index_sources VALUES (?,?,?)').run(entry.id, JSON.stringify(sourceReference(entry.source)), fingerprint(cleanText(entry.content)));
        for (const token of memorySearchTerms(entry.content)) db.prepare('INSERT OR IGNORE INTO memory_terms VALUES (?,?)').run(token, entry.id);
      }
      setMeta('index-hashes', hashes);
    });
    registerDerived(allRows, entries);
    await invalidateDerived(entries);
    const overview = await documents.read('MEMORY.md');
    if (overview) {
      const selected = [...overview.content.matchAll(curatedPattern())].flatMap(match => JSON.parse(match[1]).entries || []);
      if (selected.some(dependency => { const entry = entries.find(entry => entry.id === dependency.id); return !entry || entry.revision !== dependency.revision || fingerprint(entry.content) !== dependency.hash; })) {
        await documents.mutate('MEMORY.md', () => outline(entries, selected.map(entry => entry.id)), { source: { type: 'curation-refresh' } });
      }
    }
    for (const change of externalChanges) await emitChange(change);
    return { rows, entries };
  }
  async function learning() {
    const row = await documents.read('USER.md');
    return learningFromDocument(row);
  }
  function learningFromDocument(row) {
    const match = learningPattern.exec(row.content);
    const config = match ? JSON.parse(match[1]) : {};
    const heading = /(?:^|\n)##\s+不要学习\s*\r?\n([\s\S]*?)(?=\n##\s|$)/u.exec(row.content)?.[1] || '';
    const writtenTerms = [...heading.matchAll(/^\s*[-*]\s+(.+?)\s*$/gmu)].map(match => match[1]);
    return { enabled: config.enabled !== false, excludedScopes: config.excludedScopes || [], excludedTerms: [...new Set([...(config.excludedTerms || []), ...writtenTerms])], hash: row.hash };
  }
  const excludedByPolicy = (entry, settings) => settings.excludedScopes.includes(entry.scope || 'personal') || settings.excludedTerms.some(term => normalized(entry.content).includes(normalized(term)));
  function filteredDocument(row, entries, settings) {
    const visible = entries.filter(entry => !excludedByPolicy(entry, settings));
    if (row.name === 'MEMORY.md') {
      const ids = [...row.content.matchAll(curatedPattern())].flatMap(match => JSON.parse(match[1]).entries || []).map(entry => entry.id);
      return { ...row, content: ids.length ? outline(visible, ids) : row.content.slice(0, MEMORY_OUTLINE_LIMIT) };
    }
    if (derivedDocument(row.name)) {
      const derived = db.prepare('SELECT * FROM memory_derived WHERE document=?').get(row.name);
      if (!derived || derived.invalidated || JSON.parse(derived.dependencies).some(dependency => !visible.some(entry => entry.id === dependency.id))) return { ...row, content: '', hash: documentHash('') };
      if (!settings.enabled || settings.excludedTerms.some(term => normalized(row.content).includes(normalized(term)))) return { ...row, content: '', hash: documentHash('') };
      return row;
    }
    if (!memoryDocument(row.name)) return row;
    const removed = parseMemoryDocument(row.content, row.name).filter(entry => unavailable(entry) || excludedByPolicy(entry, settings));
    let content = row.content;
    for (const entry of removed.reverse()) content = content.slice(0, entry.start) + content.slice(entry.end);
    return { ...row, content, excludedEntries: removed.length };
  }
  async function save(input, { revision, expectedHash, explicit = true, candidateId } = {}) {
    inputValue(input);
    const { entries } = await snapshot();
    if (unavailable({ id: input.id || '', content: input.content })) throw Object.assign(new Error('该记忆已被纠正或遗忘，请使用新的有效事实与来源'), { code: 'MEMORY_EXCLUDED' });
    const previous = input.id ? entries.find(entry => entry.id === input.id) : null;
    if (input.id && !previous) throw new Error('Memory not found');
    if (!explicit && denied(input)) throw Object.assign(new Error('该来源或内容已被用户纠正、拒绝或遗忘'), { code: 'MEMORY_EXCLUDED' });
    const document = previous?.document || (input.document && input.document !== 'MEMORY.md' ? input.document : dailyDocument());
    let saved;
    await documents.mutate(document, (body, current) => {
      if (!explicit && denied(input)) throw Object.assign(new Error('该来源或内容已被用户纠正、拒绝或遗忘'), { code: 'MEMORY_EXCLUDED' });
      const rows = parseMemoryDocument(body, document);
      // The candidate mapping is durable in Markdown before its DB receipt is updated.
      const accepted = candidateId && rows.find(entry => entry.candidateId === candidateId || fingerprint(entry.content) === fingerprint(input.content));
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
        category: input.category || existing?.category || 'world',
        ...(candidateId || existing?.candidateId ? { candidateId: candidateId || existing.candidateId } : {}),
        ...(supersedes ? { supersedes, versionChain: [...(existing.versionChain || []), supersedes] } : {}),
      };
      if (existing && existing.content !== saved.content) tombstone(existing);
      if (existing) return body.slice(0, existing.start) + annotation(saved) + body.slice(existing.end);
      return body.trimEnd() + '\n\n' + annotation(saved) + '\n';
    }, { expectedHash, source: sourceReference(input.source) });
    await snapshot();
    if (previous && previous.content !== saved.content) await emitChange({ kind: 'corrected', memoryIds: [previous.id], references: [sourceReference(previous.source)] });
    return saved;
  }
  async function remove(id, { revision, purgeHistory = false } = {}) {
    const { entries } = await snapshot();
    const previous = entries.find(entry => entry.id === id);
    if (previous) await documents.mutate(previous.document, body => {
      const existing = parseMemoryDocument(body, previous.document).find(entry => entry.id === id);
      if (!existing) return body;
      if (revision !== undefined && existing.revision !== revision) throw Object.assign(new Error('Assistant data changed; reload before saving'), { code: 'REVISION_CONFLICT', revision: existing.revision });
      tombstone(existing, 'forgotten');
      db.prepare("UPDATE memory_tombstones SET reason='forgotten' WHERE entry_id=?").run(id);
      return body.slice(0, existing.start) + body.slice(existing.end);
    }, { source: { type: 'forget', entryId: id } });
    await snapshot();
    if (previous || purgeHistory) {
      const redact = (body, document) => {
        const matched = parseMemoryDocument(body, document).filter(entry => entry.id === id);
        let result = body;
        for (const entry of matched.reverse()) result = result.slice(0, entry.start) + result.slice(entry.end);
        return result;
      };
      for (const { name } of await documents.list({ recursive: true })) if (memoryDocument(name)) await documents.redactHistory(name, body => {
        const result = redact(body, name);
        return result.replace(curatedPattern(), block => block.includes(`[[memory:${id}]]`) ? '' : block);
      });
      await documents.redactSessionContexts(redactForgottenContext);
      for (const row of db.prepare('SELECT * FROM memory_candidates').all()) {
        const candidate = JSON.parse(row.payload);
        if (candidate.memoryId === id || candidate.input?.id === id || candidate.id === previous?.candidateId || (previous && fingerprint(candidate.input?.content || '') === fingerprint(previous.content))) db.prepare('DELETE FROM memory_candidates WHERE id=?').run(row.id);
      }
    }
    if (previous) await emitChange({ kind: 'forgotten', memoryIds: [id], references: [sourceReference(previous.source)] });
    return Boolean(previous);
  }
  const candidateRow = row => row ? { ...JSON.parse(row.payload), status: row.status } : null;
  const updateCandidate = candidate => {
    db.prepare('UPDATE memory_candidates SET status=?,payload=? WHERE id=?').run(candidate.status, JSON.stringify(candidate), candidate.id);
    return candidate;
  };
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
  try { await recoverCandidates(); } catch (error) { db.close(); throw error; }
  return {
    onChange(listener) { if (typeof listener !== 'function') throw new Error('Memory listener is required'); listeners.add(listener); return () => listeners.delete(listener); },
    list: async () => (await snapshot()).entries.map(publicEntry),
    save, remove, redactForgottenContext,
    forgottenRevision: () => db.prepare("SELECT COUNT(*) AS n FROM memory_tombstones WHERE reason='forgotten'").get().n,
    contextRevision: () => documentHash(JSON.stringify(db.prepare('SELECT name,hash FROM document_current ORDER BY name').all())),
    forget: (id, options) => remove(id, { ...options, purgeHistory: true }),
    async curate({ ids, source = { type: 'memory-curation' } } = {}) {
      if (!Array.isArray(ids) || ids.length > 100 || ids.some(id => typeof id !== 'string' || !id || id.length > 200)) throw new Error('Invalid curation IDs');
      const snapshotValue = await snapshot(), settings = await learning();
      const entries = snapshotValue.entries.filter(entry => !excludedByPolicy(entry, settings));
      if (ids.some(id => !entries.some(entry => entry.id === id))) throw new Error('Curation references unavailable memory');
      return documents.mutate('MEMORY.md', () => outline(entries, ids), { source: sourceReference(source) });
    },
    async writeDerived({ document, content, memoryIds = [], source } = {}) {
      if (!isAssistantDocument(document) || !derivedDocument(document) || typeof content !== 'string' || content.length > 16000 || !object(source) || JSON.stringify(source).length > 16000
        || !Array.isArray(memoryIds) || memoryIds.length > 100 || memoryIds.some(id => typeof id !== 'string' || !id || id.length > 200)) throw new Error('Invalid derived memory document');
      const { entries } = await snapshot(), byId = new Map(entries.map(entry => [entry.id, entry]));
      const refs = references(source);
      if ((!memoryIds.length && !refs.length) || refs.some(ref => denied({ content: '', source: ref }))) throw Object.assign(new Error('Derived memory requires current evidence'), { code: 'MEMORY_EXCLUDED' });
      const dependencies = [...new Set(memoryIds)].map(id => {
        const entry = byId.get(id);
        if (!entry) throw Object.assign(new Error('Derived memory source is unavailable'), { code: 'MEMORY_EXCLUDED' });
        return { id, revision: entry.revision, hash: fingerprint(entry.content) };
      });
      const provenance = { ...sourceReference(source), ...(Array.isArray(source.references) ? { references: source.references.map(sourceReference) } : {}) };
      // Stage an invalid receipt first. A crash may leave an empty view, never an untracked derived claim.
      db.prepare('INSERT INTO memory_derived VALUES (?,?,?,1) ON CONFLICT(document) DO UPDATE SET dependencies=excluded.dependencies,source=excluded.source,invalidated=1').run(document, JSON.stringify(dependencies), JSON.stringify(provenance));
      const metadata = `<!-- benchgo-derived ${JSON.stringify({ memoryIds: dependencies, source: provenance }).replace(/</gu, '\\u003c').replace(/>/gu, '\\u003e')} -->\n`;
      const result = await documents.write(document, { content: metadata + content.trim() + '\n', source: { type: 'derived-memory', ...provenance } });
      db.prepare('UPDATE memory_derived SET invalidated=0 WHERE document=?').run(document);
      return result;
    },
    async search({ query = '', limit: count, scope, category } = {}) {
      if (typeof query !== 'string' || query.length > 2000) throw new Error('Invalid memory query');
      if (category !== undefined && !MEMORY_CATEGORIES.includes(category)) throw new Error('Invalid memory category');
      const snapshotValue = await snapshot(), settings = await learning();
      const entries = snapshotValue.entries.filter(entry => !excludedByPolicy(entry, settings) && (!category || (entry.category || 'world') === category)), amount = limit(count, 8, 100), text = normalized(query);
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
      return { ...result, documents: result.documents.map(row => filteredDocument(row, snapshotValue.entries, settings)),
      // Keep the structured projection under the same policy as the Markdown
      // projection. The raw list() API is intentionally reserved for
      // management and correction workflows; runtime callers must use this
      // privacy-filtered context.
      memories: snapshotValue.entries.filter(entry => !excludedByPolicy(entry, settings)).map(publicEntry),
      learning: settings };
    },
    async readDocument(name) {
      const snapshotValue = await snapshot(), settings = await learning(), row = await documents.read(name);
      return filteredDocument(row, snapshotValue.entries, settings);
    },
    learning,
    async learningSettingsSnapshot() {
      const row = await documents.read('USER.md'), { hash, ...value } = learningFromDocument(row);
      const match = learningPattern.exec(row.content), user = match ? JSON.parse(match[1]) : {};
      const { hash: ignored, ...base } = learningFromDocument({ ...row, content: row.content.replace(learningPattern, '') });
      return settingsSnapshot(value, hash, { user, base });
    },
    async configureLearning(patch, { expectedHash, ops, expected, signal } = {}) {
      const validate = value => {
        if (!object(value) || Object.keys(value).some(key => !Object.hasOwn(LEARNING_CONFIG_SCHEMA.properties, key))) throw new Error('Invalid learning configuration');
        if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw new Error('Invalid learning enabled');
        for (const key of ['excludedScopes', 'excludedTerms']) if (value[key] !== undefined && (!Array.isArray(value[key]) || value[key].length > LEARNING_CONFIG_SCHEMA.properties[key].maxItems || value[key].some(value => typeof value !== 'string' || !value.trim() || value.length > LEARNING_CONFIG_SCHEMA.properties[key].items.maxLength))) throw new Error('Invalid learning exclusions');
      };
      validate(patch);
      await documents.mutate('USER.md', (body, row) => {
        if (expected || ops) { const { hash, ...value } = learningFromDocument(row); assertSettingsExpected(settingsSnapshot(value, hash), expected, signal); }
        const match = learningPattern.exec(body), previous = match ? JSON.parse(match[1]) : {};
        const next = ops ? { enabled: true, excludedScopes: [], excludedTerms: [], ...applySettingsOps(previous, ops) } : { ...previous, ...patch };
        validate(next);
        const text = `<!-- benchgo-learning ${JSON.stringify(next).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')} -->`;
        return match ? body.replace(learningPattern, text) : body.trimEnd() + '\n\n' + text + '\n';
      }, { expectedHash, source: { type: 'learning-settings' } });
      return learning();
    },
    async propose(input, { verifiedSource, idempotencyKey } = {}) {
      inputValue(input);
      if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || !idempotencyKey || idempotencyKey.length > 500)) throw new Error('记忆学习去重标识无效');
      const stableId = idempotencyKey && `learning-${createHash('sha256').update(idempotencyKey).digest('hex')}`;
      const current = await snapshot();
      const settings = await learning();
      const verifiedInput = { ...input, source: verifiedSource || input.source };
      const excluded = !trustedSource(verifiedSource) || !settings.enabled || denied(verifiedInput) || excludedByPolicy(input, settings);
      if (excluded) return { status: 'excluded', reason: '学习已停用，或内容/来源不符合当前学习规则' };
      const previous = stableId && candidateRow(db.prepare('SELECT payload,status FROM memory_candidates WHERE id=?').get(stableId));
      if (previous) return ['accepted', 'rejected', 'excluded'].includes(previous.status) ? previous : resolveCandidate(previous.id);
      const savedSlot = stableId && db.prepare('SELECT * FROM memory_learning_slots WHERE slot=?').get(stableId);
      if (savedSlot) {
        const saved = savedSlot.candidate_id && candidateRow(db.prepare('SELECT payload,status FROM memory_candidates WHERE id=?').get(savedSlot.candidate_id));
        if (saved) return ['accepted', 'rejected', 'excluded'].includes(saved.status) ? saved : resolveCandidate(saved.id);
        return savedSlot.memory_id && current.entries.some(entry => entry.id === savedSlot.memory_id)
          ? { status: 'duplicate', memoryId: savedSlot.memory_id } : { status: 'excluded', reason: '该学习槽位已处理或遗忘' };
      }
      const key = fingerprint(input.content);
      const known = candidateRow(db.prepare('SELECT payload,status FROM memory_candidates WHERE fingerprint=?').get(key));
      if (known) {
        if (stableId) db.prepare('INSERT OR IGNORE INTO memory_learning_slots VALUES (?,?,?)').run(stableId, known.id, null);
        return ['accepted', 'rejected', 'excluded'].includes(known.status) ? known : resolveCandidate(known.id);
      }
      const existing = current.entries.find(entry => fingerprint(entry.content) === key);
      if (existing) {
        if (stableId) db.prepare('INSERT OR IGNORE INTO memory_learning_slots VALUES (?,?,?)').run(stableId, null, existing.id);
        return { status: 'duplicate', memoryId: existing.id };
      }
      const candidate = { id: stableId || randomUUID(), status: 'saving', input: copy(verifiedInput), evidence: copy(verifiedSource), createdAt: now() };
      db.prepare('INSERT OR IGNORE INTO memory_candidates VALUES (?,?,?,?,?)').run(candidate.id, key, candidate.status, JSON.stringify(candidate), candidate.createdAt);
      const persisted = (stableId && db.prepare('SELECT id FROM memory_candidates WHERE id=?').get(stableId)) || db.prepare('SELECT id FROM memory_candidates WHERE fingerprint=?').get(key);
      return resolveCandidate(persisted.id);
    },
    close() { if (!closed) { closed = true; listeners.clear(); db.close(); } },
  };
}
