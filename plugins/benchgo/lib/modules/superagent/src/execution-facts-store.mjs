const fail = (code, message) => Object.assign(new Error(message), { code });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = (value, label) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) throw fail('EXECUTION_FACT_INPUT', `Invalid ${label}`);
  return value;
};
const integer = (value, label, minimum = 0) => {
  if (!Number.isSafeInteger(value) || value < minimum) throw fail('EXECUTION_FACT_INPUT', `Invalid ${label}`);
  return value;
};
const text = (value, length = 128) => typeof value === 'string' ? value.slice(0, length) : null;
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const seq = value => Number.isSafeInteger(value) && value >= -1 ? value : -1;
const stable = value => JSON.stringify(value, (_key, item) => object(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const request = value => ({ state: ['unknown', 'inflight', 'settled'].includes(value?.state) ? value.state : 'unknown',
  startedAt: date(value?.startedAt), settledAt: date(value?.settledAt), deadline: null });
const milestone = value => ({ seq: seq(value?.seq), kind: text(value?.kind, 64), time: date(value?.time),
  ...(typeof value?.category === 'string' ? { category: text(value.category, 64) } : {}) });

// Only host-generated facts enter this projection. Keep an explicit allowlist
// here as well, so adding an upstream field cannot export private tool content.
function safeState(value, sessionId, parentSessionId, cursor) {
  if (!object(value)) throw fail('EXECUTION_FACT_INPUT', 'Execution projection requires a state');
  return { sessionId, parentSessionId, inheritedEventCount: count(value.inheritedEventCount), cursor,
    status: text(value.status, 32), activity: text(value.activity), updatedAt: date(value.updatedAt),
    turn: Number.isSafeInteger(value.turn) ? value.turn : null, step: Number.isSafeInteger(value.step) ? value.step : null,
    request: request(value.request),
    tools: { calls: count(value.tools?.calls), results: count(value.tools?.results), errors: count(value.tools?.errors),
      active: (Array.isArray(value.tools?.active) ? value.tools.active : []).slice(0, 128).filter(object).map(row => ({
        callId: text(row.callId, 512), category: text(row.category, 64), sourceSeq: seq(row.sourceSeq),
      })), incomplete: value.tools?.incomplete === true || (value.tools?.active?.length || 0) > 128 },
    children: (Array.isArray(value.children) ? value.children : []).slice(0, 512).filter(object).map(row => ({
      sessionId: text(row.sessionId, 512), catalogSeq: seq(row.catalogSeq), createdAt: date(row.createdAt),
      ...(object(row.notice) ? { notice: { seq: seq(row.notice.seq), reason: text(row.notice.reason, 64), messageId: text(row.notice.messageId, 512) } } : {}),
    })), childrenTruncated: value.childrenTruncated === true || (value.children?.length || 0) > 512,
    milestones: (Array.isArray(value.milestones) ? value.milestones : []).slice(-64).map(milestone),
    activityHistory: (Array.isArray(value.activityHistory) ? value.activityHistory : []).slice(-64).filter(object).map(row => ({
      seq: seq(row.seq), time: date(row.time), status: text(row.status, 32), activity: text(row.activity),
    })), activityHistoryTruncated: value.activityHistoryTruncated === true || (value.activityHistory?.length || 0) > 64,
    lastEvent: object(value.lastEvent) ? milestone(value.lastEvent) : null };
}
function safeLive(value) {
  if (!object(value)) return null;
  return { status: ['running', 'idle', 'disposed', 'unknown'].includes(value.status) ? value.status : 'unknown',
    observedAt: date(value.observedAt), bootId: text(value.bootId, 512),
    ...(typeof value.activationId === 'string' ? { activationId: text(value.activationId, 512) } : {}),
    ...(typeof value.settledReason === 'string' ? { settledReason: text(value.settledReason, 64) } : {}),
    ...(object(value.request) ? { request: request(value.request) } : {}) };
}
function safeFact(value) {
  if (!object(value)) return {};
  return { ...(typeof value.kind === 'string' ? { kind: text(value.kind, 64) } : {}),
    ...(typeof value.category === 'string' ? { category: text(value.category, 64) } : {}),
    ...(value.counterScope === 'session' ? { counterScope: 'session' } : {}),
    ...(object(value.counts) ? { counts: { calls: count(value.counts.calls), results: count(value.counts.results), errors: count(value.counts.errors) } } : {}),
    ...(Array.isArray(value.evidenceRefs) ? { evidenceRefs: value.evidenceRefs.slice(0, 64).filter(row => object(row) && typeof row.sessionId === 'string' && Number.isSafeInteger(row.seq) && row.seq >= 0)
      .map(row => ({ sessionId: text(row.sessionId, 512), seq: row.seq })) } : {}) };
}
/** Rebuildable execution projections and a display journal in the existing DB.
 * Ticket/Assignment/Run retain every lifecycle decision; this store only observes.
 */
export function installExecutionFactsStore({ db, tx }) {
  db.exec(`CREATE TABLE IF NOT EXISTS sa_execution_projection(session_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sa_execution_facts(
      seq INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id TEXT, assignment_id TEXT, run_id TEXT,
      fence INTEGER, instruction_revision INTEGER, session_id TEXT, source_seq INTEGER,
      kind TEXT NOT NULL, observed_at TEXT NOT NULL, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS sa_execution_facts_ticket ON sa_execution_facts(ticket_id,seq);
    CREATE INDEX IF NOT EXISTS sa_execution_facts_run ON sa_execution_facts(run_id,seq);
    CREATE UNIQUE INDEX IF NOT EXISTS sa_execution_facts_chat_publication
      ON sa_execution_facts(session_id,json_extract(data,'$.publicationKey')) WHERE kind='chat' AND source_seq IS NOT NULL;
    CREATE INDEX IF NOT EXISTS sa_execution_projection_run ON sa_execution_projection(json_extract(payload,'$.runId'));
    CREATE INDEX IF NOT EXISTS sa_execution_projection_ticket ON sa_execution_projection(json_extract(payload,'$.ticketId'));`);
  db.exec("CREATE INDEX IF NOT EXISTS sa_runs_execution_session ON sa_runs(json_extract(payload,'$.sessionId'))");
  const cursor = () => Number(db.prepare('SELECT COALESCE(MAX(seq),0) AS cursor FROM sa_execution_facts').get().cursor);
  const listeners = new Set();
  let published = cursor(), queued = false, disposed = false;
  const flush = () => {
    if (disposed || queued || !listeners.size) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (disposed || !listeners.size) return;
      let next;
      try { next = cursor(); } catch { return; } // The owning DB may already be closed.
      if (next === published) return;
      published = next;
      for (const listener of [...listeners]) { try { listener(next); } catch { /* Read observers cannot fail the committing transaction. */ } }
    });
  };
  const bindingQuery = `SELECT r.id AS runId,r.assignment_id AS assignmentId,r.fence,r.state AS runState,
    a.ticket_id AS ticketId,json_extract(r.payload,'$.sessionId') AS sessionId,
    COALESCE(json_extract(r.payload,'$.instructionRevision'),json_extract(a.payload,'$.instructionRevision'),1) AS instructionRevision
    FROM sa_runs r JOIN sa_assignments a ON a.id=r.assignment_id`;
  const binding = sessionId => db.prepare(`${bindingQuery} WHERE json_extract(r.payload,'$.sessionId')=?
    ORDER BY (r.fence=a.fence) DESC,r.created_at DESC,r.rowid DESC LIMIT 1`).get(id(sessionId, 'sessionId')) || null;
  const get = sessionId => {
    const row = db.prepare('SELECT payload FROM sa_execution_projection WHERE session_id=?').get(id(sessionId, 'sessionId'));
    return row ? JSON.parse(row.payload) : null;
  };
  const decode = row => ({ seq: row.seq, ticketId: row.ticket_id, assignmentId: row.assignment_id, runId: row.run_id,
    fence: row.fence, instructionRevision: row.instruction_revision, sessionId: row.session_id, sourceSeq: row.source_seq,
    kind: row.kind, observedAt: row.observed_at, data: JSON.parse(row.data) });
  const projections = ({ runId, ticketId } = {}) => {
    const where = [], args = [];
    if (runId !== undefined) { where.push("json_extract(payload,'$.runId')=?"); args.push(id(runId, 'runId')); }
    if (ticketId !== undefined) { where.push("json_extract(payload,'$.ticketId')=?"); args.push(id(ticketId, 'ticketId')); }
    return db.prepare(`SELECT payload FROM sa_execution_projection${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY rowid`).all(...args).map(row => JSON.parse(row.payload));
  };

  // SQL triggers run inside the domain transaction, including writes performed
  // by an extension. Payloads contain no domain text, request body or output.
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
  const definitions = [
    ['sa_tickets', 'ticket', row => `${row}.id`],
    ['sa_assignments', 'assignment', row => `${row}.ticket_id`],
    ['sa_runs', 'run', row => `(SELECT ticket_id FROM sa_assignments WHERE id=${row}.assignment_id)`],
    ['sa_results', 'result', row => `${row}.ticket_id`],
    ['sa_outbox', 'delivery', row => `${row}.ticket_id`],
    ['sa_attentions', 'attention', row => `${row}.ticket_id`],
    ['sa_attention_resolutions', 'attention', row => `${row}.ticket_id`],
    ['sa_ticket_inputs', 'input', row => `${row}.ticket_id`],
    ['sa_ticket_boundaries', 'requirements', row => `(SELECT ticket_id FROM sa_assignments WHERE id=${row}.assignment_id)`],
  ];
  for (const [table, kind, ticketExpression] of definitions) {
    if (!tables.has(table)) continue;
    const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
    for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
      const row = operation === 'DELETE' ? 'OLD' : 'NEW', ticket = ticketExpression(row);
      const latestRun = `(SELECT r.id FROM sa_runs r JOIN sa_assignments a ON a.id=r.assignment_id WHERE a.ticket_id=${ticket} ORDER BY (r.fence=a.fence) DESC,r.created_at DESC,r.rowid DESC LIMIT 1)`;
      const run = table === 'sa_runs' ? `${row}.id` : columns.has('run_id') ? `${row}.run_id` : latestRun;
      const assignment = table === 'sa_assignments' ? `${row}.id` : columns.has('assignment_id') ? `${row}.assignment_id` : `(SELECT assignment_id FROM sa_runs WHERE id=${run})`;
      const fence = columns.has('fence') ? `${row}.fence` : `(SELECT fence FROM sa_runs WHERE id=${run})`;
      const revision = columns.has('instruction_revision') ? `${row}.instruction_revision`
        : table === 'sa_assignments' || table === 'sa_runs' ? `COALESCE(json_extract(${row}.payload,'$.instructionRevision'),(SELECT instruction_revision FROM sa_tickets WHERE id=${ticket}),1)`
          : table === 'sa_ticket_boundaries' ? `json_extract(${row}.snapshot,'$.instructionRevision')`
            : `(SELECT instruction_revision FROM sa_tickets WHERE id=${ticket})`;
      const session = columns.has('session_id') ? `${row}.session_id` : table === 'sa_runs' ? `json_extract(${row}.payload,'$.sessionId')`
        : `(SELECT json_extract(payload,'$.sessionId') FROM sa_runs WHERE id=${run})`;
      const changed = operation === 'UPDATE' ? ` AND (${[...columns].map(column => `OLD.${column} IS NOT NEW.${column}`).join(' OR ')})` : '';
      db.exec(`CREATE TRIGGER IF NOT EXISTS sa_execution_fact_${table}_${operation.toLowerCase()}
        AFTER ${operation} ON ${table} WHEN ${ticket} IS NOT NULL${changed}
        BEGIN INSERT INTO sa_execution_facts(ticket_id,assignment_id,run_id,fence,instruction_revision,session_id,source_seq,kind,observed_at,data)
        VALUES (${ticket},${assignment},${run},${fence},${revision},${session},NULL,'${kind}',strftime('%Y-%m-%dT%H:%M:%fZ','now'),json_object('operation','${operation.toLowerCase()}')); END;`);
    }
  }
  function installRuntimeSources() {
    const currentTables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    // Runtime notifications can commit after the official Session turn ends.
    // Reuse the existing fact stream to wake chat readers without exporting text.
    if (currentTables.has('task_events')) {
      for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
        const row = operation === 'DELETE' ? 'OLD' : 'NEW';
        const payload = `CASE WHEN json_valid(${row}.payload) THEN ${row}.payload ELSE '{}' END`;
        // Replace only these projection triggers so existing databases gain identities;
        // the durable journal and historical notification rows remain untouched.
        db.exec(`DROP TRIGGER IF EXISTS sa_execution_fact_task_events_${operation.toLowerCase()};
          CREATE TRIGGER sa_execution_fact_task_events_${operation.toLowerCase()}
          AFTER ${operation} ON task_events
          BEGIN INSERT INTO sa_execution_facts(ticket_id,kind,observed_at,data)
          VALUES (NULL,'chat',strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          json_patch(json_object('operation','${operation.toLowerCase()}','eventId',${row}.id), json_object(
            'threadId',json_extract(${payload},'$.threadId'),
            'requestId',json_extract(${payload},'$.requestId'),
            'sourceEventId',json_extract(${payload},'$.sourceEventId'),
            'ticketStateEventKey',json_extract(${payload},'$.ticketStateEventKey')))); END;`);
      }
    }
    for (const table of ['task_meta', 'assistant_goals']) {
      if (!currentTables.has(table)) continue;
      for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
        const row = operation === 'DELETE' ? 'OLD' : 'NEW';
        const presentation = table === 'task_meta';
        const ticket = presentation ? `substr(${row}.key,26)` : 'NULL';
        const condition = presentation ? `${row}.key LIKE 'task-presentation:ticket:%'` : '1';
        const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name);
        const changed = operation === 'UPDATE' ? ` AND (${columns.map(column => `OLD.${column} IS NOT NEW.${column}`).join(' OR ')})` : '';
        const data = presentation ? `json_object('operation','${operation.toLowerCase()}')`
          : `json_object('goalId',${row}.id,'operation','${operation.toLowerCase()}')`;
        db.exec(`CREATE TRIGGER IF NOT EXISTS sa_execution_fact_${table}_${operation.toLowerCase()}
          AFTER ${operation} ON ${table} WHEN ${condition}${changed}
          BEGIN INSERT INTO sa_execution_facts(ticket_id,kind,observed_at,data)
          VALUES (${ticket},'${presentation ? 'presentation' : 'goal'}',strftime('%Y-%m-%dT%H:%M:%fZ','now'),${data}); END;`);
      }
    }
  }
  installRuntimeSources();
  return {
    executionFactCursor: cursor,
    recordChatPublication(input) {
      if (!object(input)) throw fail('EXECUTION_FACT_INPUT', 'Chat publication identity is required');
      const sessionId = id(input.sessionId, 'sessionId'), sourceSeq = integer(input.sourceSeq, 'sourceSeq');
      const threadId = id(input.threadId, 'threadId');
      const identity = input.mirrorKey !== undefined ? { mirrorKey: id(input.mirrorKey, 'mirrorKey') } : { requestId: id(input.requestId, 'requestId') };
      const publicationKey = JSON.stringify(identity);
      return tx(() => {
        const prior = db.prepare("SELECT seq FROM sa_execution_facts WHERE kind='chat' AND session_id=? AND source_seq IS NOT NULL AND json_extract(data,'$.publicationKey')=?").get(sessionId, publicationKey);
        if (prior) return { seq: prior.seq, duplicate: true };
        const inserted = db.prepare("INSERT INTO sa_execution_facts(session_id,source_seq,kind,observed_at,data) VALUES (?,?,'chat',?,?)")
          .run(sessionId, sourceSeq, new Date().toISOString(), JSON.stringify({ operation: 'insert', publicationKey, threadId, ...identity }));
        return { seq: Number(inserted.lastInsertRowid), duplicate: false };
      });
    },
    getExecutionBinding: binding,
    executionTicketCursor(ticketId) {
      return Number(db.prepare("SELECT COALESCE(MAX(seq),0) AS cursor FROM sa_execution_facts WHERE ticket_id=? AND kind<>'summary'").get(id(ticketId, 'ticketId')).cursor);
    },
    executionBindings() {
      const rows = db.prepare(`${bindingQuery} WHERE json_extract(r.payload,'$.sessionId') IS NOT NULL ORDER BY r.created_at,r.rowid`).all();
      return [...new Set(rows.map(row => row.sessionId))].map(binding);
    },
    getExecutionProjection: get,
    executionProjections: projections,
    recordExecutionDisplayChange(input) {
      if (!object(input) || input.kind !== 'summary') throw fail('EXECUTION_FACT_INPUT', 'Only summary display changes are supported');
      const ticketId = id(input.ticketId, 'ticketId');
      return tx(() => {
        const ticket = db.prepare('SELECT instruction_revision FROM sa_tickets WHERE id=?').get(ticketId);
        if (!ticket) throw fail('EXECUTION_FACT_BINDING', 'Display change has no persisted Ticket');
        const bound = db.prepare(`${bindingQuery} WHERE a.ticket_id=?
          ORDER BY (r.fence=a.fence) DESC,r.created_at DESC,r.rowid DESC LIMIT 1`).get(ticketId);
        const inserted = db.prepare('INSERT INTO sa_execution_facts(ticket_id,assignment_id,run_id,fence,instruction_revision,session_id,source_seq,kind,observed_at,data) VALUES (?,?,?,?,?,?,NULL,?,?,?)')
          .run(ticketId, bound?.assignmentId ?? null, bound?.runId ?? null, bound?.fence ?? null,
            bound?.instructionRevision ?? ticket.instruction_revision, bound?.sessionId ?? null, 'summary', new Date().toISOString(), '{}');
        return decode(db.prepare('SELECT * FROM sa_execution_facts WHERE seq=?').get(inserted.lastInsertRowid));
      });
    },
    recordExecutionProjection(input) {
      if (!object(input)) throw fail('EXECUTION_FACT_INPUT', 'Execution projection is required');
      const sessionId = id(input.sessionId, 'sessionId'), rootSessionId = id(input.rootSessionId || sessionId, 'rootSessionId');
      const parentSessionId = input.parentSessionId == null ? null : id(input.parentSessionId, 'parentSessionId');
      const sourceCursor = integer(input.cursor, 'cursor', -1), flushedCursor = integer(input.flushedCursor ?? -1, 'flushedCursor', -1);
      if (flushedCursor > sourceCursor || sessionId !== rootSessionId && parentSessionId !== rootSessionId
        || sessionId === rootSessionId && parentSessionId !== null) throw fail('EXECUTION_FACT_BINDING', 'Execution parent or source cursor is inconsistent');
      return tx(() => {
        const bound = binding(rootSessionId);
        if (!bound) throw fail('EXECUTION_FACT_BINDING', 'Execution has no persisted Run');
        for (const key of ['ticketId', 'assignmentId', 'runId', 'fence', 'instructionRevision']) {
          if (input[key] !== undefined && input[key] !== bound[key]) throw fail('EXECUTION_FACT_BINDING', `Execution ${key} changed`);
        }
        const previous = get(sessionId);
        if (previous && (previous.rootSessionId !== rootSessionId || previous.parentSessionId !== parentSessionId)) throw fail('EXECUTION_FACT_BINDING', 'Execution parent cannot be rewritten');
        if (previous && sourceCursor < previous.cursor) return { ...previous, stale: true };
        const payload = { sessionId, rootSessionId, parentSessionId, ticketId: bound.ticketId, assignmentId: bound.assignmentId,
          runId: bound.runId, fence: bound.fence, instructionRevision: bound.instructionRevision, cursor: sourceCursor,
          flushedCursor: Math.max(flushedCursor, previous?.flushedCursor ?? -1), complete: input.complete === true,
          missingReason: text(input.missingReason, 64), sourceDurability: input.sourceDurability === 'persisted'
            || previous?.sourceDurability === 'persisted' && previous.cursor === sourceCursor ? 'persisted' : 'observed',
          state: safeState(input.state, sessionId, parentSessionId, sourceCursor), live: safeLive(input.live) };
        const encoded = stable(payload);
        if (previous && stable(previous) === encoded) return { ...previous, duplicate: true };
        db.prepare('INSERT INTO sa_execution_projection(session_id,payload) VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET payload=excluded.payload').run(sessionId, encoded);
        db.prepare('INSERT INTO sa_execution_facts(ticket_id,assignment_id,run_id,fence,instruction_revision,session_id,source_seq,kind,observed_at,data) VALUES (?,?,?,?,?,?,?,?,?,?)')
          .run(bound.ticketId, bound.assignmentId, bound.runId, bound.fence, bound.instructionRevision, sessionId, sourceCursor,
            text(input.kind, 64) || 'execution', new Date().toISOString(), stable(safeFact(input.fact)));
        return payload;
      });
    },
    executionFactPage({ after = 0, through = cursor(), limit = 100 } = {}) {
      integer(after, 'after'); integer(through, 'through'); integer(limit, 'limit', 1);
      const current = cursor();
      if (after > through || through > current) throw fail('EXECUTION_FACT_CURSOR', 'Execution fact cursor is outside this journal');
      const entries = db.prepare('SELECT * FROM sa_execution_facts WHERE seq>? AND seq<=? ORDER BY seq LIMIT ?').all(after, through, Math.min(limit, 200)).map(decode);
      const next = entries.at(-1)?.seq ?? after;
      return { cursor: next, through, entries, hasMore: next < through };
    },
    executionEvidence({ ticketId, runId, instructionRevision, after = 0, limit = 80 } = {}) {
      id(ticketId, 'ticketId'); integer(after, 'after'); integer(limit, 'limit', 1);
      const currentCursor = cursor();
      if (after > currentCursor) throw fail('EXECUTION_FACT_CURSOR', 'Execution fact cursor is outside this journal');
      const where = ['ticket_id=?', 'seq>?', 'seq<=?'], args = [ticketId, after, currentCursor];
      if (runId !== undefined) { where.push('run_id=?'); args.push(id(runId, 'runId')); }
      if (instructionRevision !== undefined) { where.push('instruction_revision=?'); args.push(integer(instructionRevision, 'instructionRevision', 1)); }
      const rows = db.prepare(`SELECT * FROM sa_execution_facts WHERE ${where.join(' AND ')} ORDER BY seq LIMIT ?`).all(...args, Math.min(limit, 200) + 1);
      const hasMore = rows.length > Math.min(limit, 200), entries = rows.slice(0, Math.min(limit, 200)).map(decode);
      return { cursor: hasMore ? entries.at(-1).seq : currentCursor, currentCursor, entries, hasMore,
        projections: projections({ ticketId, runId }).filter(row => instructionRevision === undefined || row.instructionRevision === instructionRevision) };
    },
    onExecutionFacts(listener) {
      if (typeof listener !== 'function') throw fail('EXECUTION_FACT_INPUT', 'Execution fact listener is required');
      if (disposed) throw fail('EXECUTION_FACT_CLOSED', 'Execution facts are disposed');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    flushExecutionFactChanges: flush,
    installExecutionFactRuntimeSources: installRuntimeSources,
    disposeExecutionFacts() { disposed = true; listeners.clear(); },
  };
}
