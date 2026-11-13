import { createHash } from 'node:crypto';
import { projectChatMessages } from './chat-publication.mjs';
import { privateRouterSessionIds } from './execution-session.mjs';

const fail = (code, message) => Object.assign(new Error(message), { code });
const check = signal => signal?.throwIfAborted();
const integer = (value, fallback, max, min = 0) => {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw fail('SESSION_QUERY_INVALID_LIMIT', '读取数量或位置无效');
  return value;
};
const normalize = value => value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
const codePointLength = (text, end = text.length) => {
  let length = 0;
  for (let index = 0; index < end; length++) index += text.codePointAt(index) > 0xffff ? 2 : 1;
  return length;
};
const textOf = event => (event?.data?.message?.content || []).filter(block => block.type === 'text').map(block => block.text || '').join('\n');
const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('base64url');
const pageSize = 20, maxCandidates = 80, cacheSize = 8, cacheCharacters = 2_000_000;
const eventFilters = [{ kind: 'type', values: ['user/message', 'assistant/message'] }];
const searchCoverage = { matchMode: 'official-phrase', coverage: 'official-message-text', limitations: [
  '官方 Unicode61 词或短语匹配不保证中文句内子串命中。',
  '仅插件发布且未出现在原始用户或助手正文中的文字，当前官方索引不覆盖。',
] };

/** Adapts official search and point observations; owns neither an index nor transcript. */
export function createHistorySearch({ ctx, store }) {
  const query = ctx.sessionQuery, cache = new Map(), textLengths = new WeakMap();
  if (!query?.searchSessions || !query?.searchEvents || !query?.observeSession || !query?.readEvent) {
    throw fail('SESSION_QUERY_SEARCH_DISABLED', '官方历史检索服务不可用');
  }
  async function scope(signal) {
    check(signal);
    const ids = privateRouterSessionIds(await store.getState()).sort();
    check(signal);
    return { ids, hash: fingerprint(ids) };
  }
  function authorize(id, owned) {
    if (typeof id !== 'string' || !owned.ids.includes(id)) throw fail('SESSION_QUERY_FORBIDDEN', '该会话不在当前公开对话检索范围内');
  }
  function cursorOf(value, binding) {
    if (value === undefined || value === null) return {};
    try {
      if (typeof value !== 'string' || value.length > 262144) throw Error();
      const parsed = JSON.parse(Buffer.from(value, 'base64url').toString());
      if (parsed.version !== 1 || parsed.binding !== binding || typeof parsed.position !== 'object' || !parsed.position) throw Error();
      return parsed.position;
    } catch { throw fail('SESSION_QUERY_INVALID_CURSOR', '查询范围或分页位置已改变，请重新搜索'); }
  }
  const next = (binding, position) => encoded({ version: 1, binding, position });
  async function observed(id, signal) {
    check(signal);
    const observation = await query.observeSession(id, { signal, projectionMode: 'none' });
    try {
      check(signal);
      const signature = `${observation.source}:${observation.cursor}:${String(observation.revision ?? '')}`;
      const previous = cache.get(id);
      if (previous?.signature === signature) { cache.delete(id); cache.set(id, previous); return previous; }
      const events = observation.events;
      const rows = projectChatMessages(events).filter(row => row.kind !== 'channel-message' && typeof row.text === 'string' && row.text.trim());
      const bySeq = new Map(rows.map(row => [row.seq, row]));
      const candidateTexts = new Map();
      // Raw assistant text may be published later at turn/end or a Host record.
      // Map only text actually preserved in that public row, never tool arguments.
      const final = new Map(rows.filter(row => row.role === 'assistant').map(row => [row.requestId, row]));
      let requestId;
      for (const event of events) {
        if (event.type === 'turn/start') requestId = undefined;
        if (event.type === 'user/message') requestId = event.data?.id;
        if (event.type === 'user/message' && bySeq.has(event.seq)) candidateTexts.set(event.seq, bySeq.get(event.seq).text);
        if (event.type === 'assistant/message' && !event.data?.interrupted && !event.data?.parentCallId) {
          const row = final.get(requestId), text = textOf(event);
          if (row && text.trim() && row.text.includes(text)) { bySeq.set(event.seq, row); candidateTexts.set(event.seq, text); }
        }
      }
      const characters = rows.reduce((sum, row) => sum + row.text.length, 0)
        + [...candidateTexts.values()].reduce((sum, text) => sum + text.length, 0);
      const value = { signature, header: observation.header, rows, bySeq, candidateTexts, characters };
      cache.delete(id);
      // Short-lived presentation cache only; very large conversations stay in
      // the official observation cache rather than being retained twice.
      if (characters <= cacheCharacters / 2) cache.set(id, value);
      while (cache.size > cacheSize || [...cache.values()].reduce((sum, item) => sum + item.characters, 0) > cacheCharacters) cache.delete(cache.keys().next().value);
      return value;
    } finally { observation[Symbol.dispose](); }
  }
  function result(row, sessionId, { offset = 0, textLimit = 4000 } = {}) {
    let fullLength = textLengths.get(row);
    if (fullLength === undefined) { fullLength = codePointLength(row.text); textLengths.set(row, fullLength); }
    if (offset > fullLength) throw fail('SESSION_QUERY_INVALID_WINDOW', '原文分段位置无效');
    const end = Math.min(fullLength, offset + textLimit);
    let startIndex = 0, endIndex = row.text.length;
    if (offset || end < fullLength) {
      let index = 0;
      for (let position = 0; position < end; position++) {
        if (position === offset) startIndex = index;
        index += row.text.codePointAt(index) > 0xffff ? 2 : 1;
      }
      endIndex = index;
      if (offset === end) startIndex = endIndex;
    }
    return { sessionId, seq: row.seq, time: row.time, role: row.role, text: row.text.slice(startIndex, endIndex),
      fullLength, offset, nextOffset: end < fullLength ? end : null, complete: offset === 0 && end === fullLength, source: 'official' };
  }
  function excerpt(row, id, value, header) {
    const index = row.text.toLowerCase().indexOf(value.toLowerCase().trim());
    const offset = index < 0 ? 0 : Math.max(0, codePointLength(row.text, index) - 120);
    const hit = result(row, id, { offset, textLimit: 500 });
    return { ...hit, snippet: hit.text, title: header.title ?? null };
  }
  const isGone = error => error?.code === 'SESSION_QUERY_SESSION_NOT_FOUND';

  return {
    /** Host-only maintenance input, resolved through the same private/public boundary. */
    async maintenanceSources({ references = [], limit = 20, maxChars = 24000, signal } = {}) {
      if (!Array.isArray(references) || references.length > 100) throw fail('SESSION_QUERY_INVALID_LIMIT', '维护引用数量无效');
      limit = integer(limit, 20, 100, 1); maxChars = integer(maxChars, 24000, 100000, 1000);
      const owned = await scope(signal), items = [], seen = new Set();
      let consumedReferences = 0;
      for (const reference of references) {
        check(signal);
        if (!owned.ids.includes(reference.sessionId)) { consumedReferences++; continue; }
        let view;
        try { view = await observed(reference.sessionId, signal); }
        catch (error) { if (isGone(error)) { consumedReferences++; continue; } throw error; }
        const index = view.rows.findIndex(row => row.role === 'user' && row.id === reference.messageId);
        if (index < 0) { consumedReferences++; continue; }
        const first = view.rows[index], feedback = [];
        for (let i = index + 1; i < view.rows.length && feedback.length < 2; i++) {
          const row = view.rows[i];
          if (row.role === 'user') break;
          if (row.role === 'assistant' && row.requestId === first.id) feedback.push(row);
        }
        const additions = [];
        for (const row of [first, ...feedback]) {
          const id = `${reference.sessionId}:${row.seq}`;
          if (seen.has(id)) continue;
          const item = { id, kind: row.role === 'user' ? 'user' : 'feedback', text: row.text.slice(0, 4000), truncated: row.text.length > 4000,
            source: { role: row.role, sessionId: reference.sessionId, messageId: row.id, seq: row.seq,
              ...(reference.threadId ? { threadId: reference.threadId } : {}) } };
          additions.push(item);
        }
        if (items.length + additions.length > limit || JSON.stringify([...items, ...additions]).length > maxChars) {
          if (items.length) return { items, consumedReferences, hasMore: true };
          // A long first source still makes bounded progress. Original pointers
          // remain available for verification; never relabel truncated text as full.
          const characters = Math.max(100, Math.floor((maxChars - 2400) / Math.max(1, additions.length)));
          for (const item of additions) { item.truncated ||= item.text.length > characters; item.text = item.text.slice(0, characters); }
          if (additions.length > limit || JSON.stringify(additions).length > maxChars) throw fail('MAINTENANCE_SOURCE_LIMIT', '维护材料上限不足以读取一条来源');
        }
        for (const item of additions) { seen.add(item.id); items.push(item); }
        consumedReferences++;
      }
      check(signal); return { items, consumedReferences };
    },
    async search(input = {}, { signal } = {}) {
      const { query: value, sessionId, cursor } = input;
      if (typeof value !== 'string' || !value.trim() || value.length > 2000) throw fail('SESSION_QUERY_INVALID_QUERY', '搜索词无效');
      const limit = integer(input.limit, pageSize, 100, 1), owned = await scope(signal);
      if (sessionId !== undefined) authorize(sessionId, owned);
      const binding = fingerprint(['search', owned.hash, value, sessionId ?? null, limit]);
      const state = cursorOf(cursor, binding), results = [], keyword = normalize(value);
      const matches = new WeakMap();
      function matchedRow(view, hit, unique = false) {
        let match = matches.get(view);
        if (!match) {
          const rows = new Map(), earliest = new Map(), publicMatches = new Map();
          // Official FTS also indexes tool payloads. Validate public text once
          // per view and query, retaining no query index between requests.
          for (const [seq, text] of view.candidateTexts) {
            const row = view.bySeq.get(seq);
            if (!row) continue;
            if (!publicMatches.has(row)) publicMatches.set(row, normalize(row.text).includes(keyword));
            if (!publicMatches.get(row) || !normalize(text).includes(keyword)) continue;
            rows.set(seq, row);
            if (!earliest.has(row) || seq < earliest.get(row)) earliest.set(row, seq);
          }
          match = { rows, earliest }; matches.set(view, match);
        }
        const row = match.rows.get(hit.seq);
        return row && (!unique || match.earliest.get(row) === hit.seq) ? row : null;
      }
      let officialCursor = state.cursor, pending = Array.isArray(state.pending) ? state.pending : [], inspected = 0;
      if (!owned.ids.length) return { query: value, results, nextCursor: null, truncated: false, source: 'official', ...searchCoverage };
      while (results.length < limit && inspected < maxCandidates) {
        check(signal);
        if (sessionId || pending.length) {
          const entry = pending[0], id = sessionId || entry.id;
          authorize(id, owned);
          let page, view;
          try {
            page = await query.searchEvents({ sessionId: id, query: value, filters: eventFilters,
              limit: Math.min(pageSize, limit - results.length), ...(entry?.cursor || sessionId && officialCursor ? { cursor: entry?.cursor || officialCursor } : {}) }, { signal });
            view = await observed(id, signal);
          } catch (error) {
            if (!isGone(error) || sessionId) throw error;
            pending.shift(); inspected++;
            if (!pending.length && !officialCursor) break;
            continue;
          }
          check(signal); inspected++;
          let accepted = false;
          for (const hit of page.items) {
            inspected++;
            const row = matchedRow(view, hit, !!sessionId);
            if (!row) continue;
            results.push(excerpt(row, id, value, view.header));
            accepted = true;
            if (!sessionId) break;
          }
          if (sessionId) { officialCursor = page.nextCursor; if (!officialCursor) break; }
          else if (accepted || !page.nextCursor) { pending.shift(); if (!pending.length && !officialCursor) break; }
          else pending[0] = { id, cursor: page.nextCursor };
        } else {
          const page = await query.searchSessions({ query: value, sessionFilters: [{ kind: 'id', values: owned.ids }], eventFilters,
            limit: Math.min(pageSize, limit - results.length), ...(officialCursor ? { cursor: officialCursor } : {}) }, { signal });
          check(signal);
          officialCursor = page.nextCursor;
          if (!page.items.length) break;
          for (const candidate of page.items) {
            const id = candidate.header.id;
            authorize(id, owned);
            inspected++;
            let view;
            try { view = await observed(id, signal); } catch (error) { if (!isGone(error)) throw error; continue; }
            const row = matchedRow(view, candidate.bestMatch);
            if (row) results.push(excerpt(row, id, value, view.header));
            else pending.push({ id });
          }
          if (!pending.length && !officialCursor) break;
        }
      }
      check(signal);
      const hasMore = !!(officialCursor || pending.length);
      return { query: value, results, nextCursor: hasMore ? next(binding, { cursor: officialCursor, pending }) : null,
        truncated: hasMore, source: 'official', ...searchCoverage };
    },
    async history(input = {}, { signal } = {}) {
      const owned = await scope(signal), { sessionId, seq } = input;
      authorize(sessionId, owned);
      const limit = integer(input.limit, 30, 100, 1), textLimit = integer(input.textLimit, 4000, 16000, 1);
      const binding = fingerprint(['history', owned.hash, sessionId, limit, textLimit]);
      const position = cursorOf(input.cursor, binding);
      if (seq !== undefined) {
        integer(seq, undefined, Number.MAX_SAFE_INTEGER);
        await query.readEvent({ sessionId, seq, before: 0, after: 0 }, signal);
      }
      const view = await observed(sessionId, signal);
      let rows = view.rows, hasMore = false, nextCursor = null;
      if (seq !== undefined) {
        check(signal);
        const target = view.bySeq.get(seq);
        if (!target) throw fail('SESSION_QUERY_EVENT_NOT_PUBLIC', '指定事件不是可读取的公开对话');
        const index = rows.indexOf(target), before = integer(input.before, 0, 30), after = integer(input.after, 0, 30);
        rows = rows.slice(Math.max(0, index - before), index + after + 1);
      } else {
        const before = position.before ?? input.before;
        if (before !== undefined) integer(before, undefined, Number.MAX_SAFE_INTEGER);
        const eligible = rows.filter(row => before === undefined || row.seq < before);
        hasMore = eligible.length > limit;
        rows = eligible.slice(-limit);
        if (hasMore) nextCursor = next(binding, { before: rows[0].seq });
      }
      const offset = integer(input.offset, 0, Number.MAX_SAFE_INTEGER);
      if (offset && (seq === undefined || rows.length !== 1)) throw fail('SESSION_QUERY_INVALID_WINDOW', '原文分段须指定单一事件');
      const rowLimit = Math.min(textLimit, Math.floor(32000 / Math.max(1, rows.length)));
      const messages = rows.map(row => result(row, sessionId, { offset, textLimit: rowLimit }));
      check(signal);
      return { sessionId, events: messages, hasMore, nextCursor, source: 'official' };
    },
    async sessions(input = {}, { signal } = {}) {
      const owned = await scope(signal), limit = integer(input.limit, pageSize, 100, 1);
      // Official metadata listing reads headers, never cold conversation logs.
      const headers = owned.ids.length ? await query.filterSessions([{ kind: 'id', values: owned.ids }], signal) : [];
      const ordered = headers.map(item => item.header).sort((a, b) => a.id.localeCompare(b.id));
      const binding = fingerprint(['sessions', owned.hash, ordered.map(header => header.id), limit]);
      const position = cursorOf(input.cursor, binding), index = integer(position.index, 0, ordered.length);
      const sessions = ordered.slice(index, index + limit).map(header => ({ id: header.id, title: header.title ?? null, createdAt: header.createdAt }));
      check(signal);
      return { sessions, nextCursor: index + limit < ordered.length ? next(binding, { index: index + limit }) : null };
    },
    dispose() { cache.clear(); },
  };
}
