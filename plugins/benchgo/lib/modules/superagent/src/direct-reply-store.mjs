import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const record = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message) => Object.assign(new Error(message), { code });
const time = value => { if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid delivery time'); return value; };
const ownerId = value => { if (typeof value !== 'string' || !value.trim() || value.length > 512) throw new Error('Invalid delivery owner'); return value; };
const limitValue = (value, fallback) => Number.isSafeInteger(value) && value > 0 ? Math.min(value, 1000) : fallback;
function objectJson(value) {
  if (!record(value)) throw new Error('Direct reply metadata must be an object');
  const encoded = JSON.stringify(value);
  if (!isDeepStrictEqual(JSON.parse(encoded), value)) throw new Error('Direct reply metadata must be JSON data');
  return encoded;
}

/** Durable delivery only. Admission and transport authorization remain host responsibilities. */
export function installDirectReplyStore({ db, tx }) {
  db.exec(`CREATE TABLE IF NOT EXISTS sa_direct_replies(
    id TEXT PRIMARY KEY, candidate_id TEXT UNIQUE REFERENCES sa_candidates(id),
    trigger_id TEXT NOT NULL REFERENCES sa_triggers(id), thread_id TEXT NOT NULL REFERENCES sa_threads(id),
    text TEXT NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL, actor TEXT NOT NULL, gate TEXT NOT NULL,
    policy_version TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    next_at INTEGER NOT NULL, owner TEXT, lease_until INTEGER, last_error TEXT, receipt TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS sa_direct_replies_ready ON sa_direct_replies(state,next_at,created_at);
    CREATE TABLE IF NOT EXISTS sa_direct_reply_reconciliations(
      id INTEGER PRIMARY KEY, reply_id TEXT NOT NULL REFERENCES sa_direct_replies(id), attempts INTEGER NOT NULL,
      outcome TEXT NOT NULL, evidence TEXT NOT NULL, receipt TEXT, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS sa_direct_reply_reconciliation_reply ON sa_direct_reply_reconciliations(reply_id,id);`);
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS sa_direct_reply_owner_trigger ON sa_direct_replies(trigger_id) WHERE kind='owner'");
  const get = id => db.prepare('SELECT * FROM sa_direct_replies WHERE id=?').get(id);
  const value = row => row && ({ id: row.id, candidateId: row.candidate_id, triggerId: row.trigger_id,
    threadId: row.thread_id, text: row.text, kind: row.kind, source: JSON.parse(row.source),
    actor: JSON.parse(row.actor), gate: JSON.parse(row.gate), policyVersion: row.policy_version,
    state: row.state, attempts: row.attempts, nextAt: row.next_at, owner: row.owner,
    leaseUntil: row.lease_until, lastError: row.last_error, receipt: row.receipt ? JSON.parse(row.receipt) : null,
    createdAt: row.created_at, updatedAt: row.updated_at,
    reconciliations: db.prepare('SELECT attempts,outcome,evidence,receipt,created_at FROM sa_direct_reply_reconciliations WHERE reply_id=? ORDER BY id').all(row.id)
      .map(item => ({ attempts: item.attempts, outcome: item.outcome, evidence: item.evidence,
        receipt: item.receipt ? JSON.parse(item.receipt) : null, createdAt: item.created_at })) });
  return {
    enqueue(candidate, trigger, input) {
      const reply = input.reply;
      if (!record(reply) || typeof reply.text !== 'string' || !reply.text.trim() || reply.text.length > 6000) throw new Error('Direct reply requires bounded nonempty text');
      if (JSON.parse(candidate.gate).strength !== 'explicit' || JSON.parse(trigger.actor).kind !== 'human') throw fail('NOT_EXPLICIT', 'Direct replies require an explicit human message');
      const source = objectJson(reply.source), actor = objectJson(reply.actor), gate = objectJson(reply.gate);
      if (reply.policyVersion !== input.policyVersion || !isDeepStrictEqual(reply.source, JSON.parse(trigger.source))
        || !isDeepStrictEqual(reply.actor, JSON.parse(trigger.actor)) || reply.gate.strength !== JSON.parse(candidate.gate).strength) {
        throw fail('DIRECT_REPLY_SOURCE_CONFLICT', 'Direct reply must preserve its admitted source and policy');
      }
      const now = time(input.now ?? Date.now()), at = new Date(now).toISOString();
      db.prepare(`INSERT INTO sa_direct_replies(id,candidate_id,trigger_id,thread_id,text,kind,source,actor,gate,policy_version,state,next_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,'queued',?,?,?)`).run(randomUUID(), candidate.id, candidate.trigger_id, candidate.thread_id,
        reply.text.trim(), input.outcome, source, actor, gate, input.policyVersion, now, at, at);
    },
    api: {
      enqueueChannelOwnerReply({ triggerId, source, text, policyVersion, now = Date.now() }) {
        return tx(() => {
          const trigger = db.prepare('SELECT * FROM sa_triggers WHERE id=?').get(ownerId(triggerId));
          if (!trigger || typeof text !== 'string' || !text.trim() || text.length > 6000 || trigger.content !== text || typeof policyVersion !== 'string' || !policyVersion) throw new Error('Owner reply requires its immutable local original');
          const actor = JSON.parse(trigger.actor), local = JSON.parse(trigger.source);
          if (actor.kind !== 'human' || actor.id !== 'desktop-owner' || local.channel !== 'desktop' || local.kind !== 'channel-owner-reply'
            || !isDeepStrictEqual(local.deliveryTarget, source)) throw new Error('Owner reply source is not a trusted local channel reply');
          const existing = db.prepare("SELECT * FROM sa_direct_replies WHERE trigger_id=? AND kind='owner'").get(triggerId);
          if (existing) {
            if (existing.text !== text || !isDeepStrictEqual(JSON.parse(existing.source), source)) throw fail('DIRECT_REPLY_SOURCE_CONFLICT', 'Owner reply original changed');
            return { ...value(existing), duplicate: true };
          }
          const at = new Date(time(now)).toISOString(), replyId = randomUUID();
          db.prepare(`INSERT INTO sa_direct_replies(id,candidate_id,trigger_id,thread_id,text,kind,source,actor,gate,policy_version,state,next_at,created_at,updated_at)
            VALUES (?,NULL,?,?,?,'owner',?,?,?,?,'queued',?,?,?)`).run(replyId, triggerId, trigger.thread_id, text, objectJson(source), objectJson(actor), objectJson({ strength: 'explicit', ownerAuthored: true }), policyVersion, now, at, at);
          return value(get(replyId));
        });
      },
      enqueueUnavailableReplies({ now = Date.now() } = {}) {
        time(now);
        return tx(() => {
          const rows = db.prepare(`SELECT c.*,t.source,t.actor FROM sa_candidates c JOIN sa_triggers t ON t.id=c.trigger_id
            WHERE c.status='unavailable' AND json_extract(c.gate,'$.strength')='explicit'
            AND json_extract(t.actor,'$.kind')='human'
            AND NOT EXISTS(SELECT 1 FROM sa_direct_replies r WHERE r.candidate_id=c.id)
            ORDER BY c.created_at LIMIT 100`).all();
          const at = new Date(now).toISOString();
          for (const row of rows) db.prepare(`INSERT INTO sa_direct_replies(id,candidate_id,trigger_id,thread_id,text,kind,source,actor,gate,policy_version,state,next_at,created_at,updated_at)
            VALUES (?,?,?,?,?,'answer',?,?,?,?,'queued',?,?,?)`).run(randomUUID(), row.id, row.trigger_id, row.thread_id,
            '这条请求已收到，但暂时未能完成任务分诊，尚未开始执行。原消息已保留，可在任务记录中重试。',
            row.source, row.actor, row.gate, row.policy_version, now, at, at);
          return rows.length;
        });
      },
      claimDirectReplies({ owner, limit = 20, leaseMs = 30000, now = Date.now() } = {}) {
        ownerId(owner); time(now); time(leaseMs);
        if (!leaseMs || !Number.isSafeInteger(now + leaseMs)) throw new Error('Invalid delivery lease');
        return tx(() => {
          const at = new Date(now).toISOString();
          db.prepare("UPDATE sa_direct_replies SET state='uncertain',owner=NULL,lease_until=NULL,last_error='delivery-lease-expired',updated_at=? WHERE state='claimed' AND lease_until<=?").run(at, now);
          const rows = db.prepare("SELECT id FROM sa_direct_replies WHERE state='queued' AND next_at<=? ORDER BY created_at,id LIMIT ?").all(now, limitValue(limit, 20));
          for (const row of rows) db.prepare("UPDATE sa_direct_replies SET state='claimed',owner=?,lease_until=?,attempts=attempts+1,updated_at=? WHERE id=?").run(owner, now + leaseMs, at, row.id);
          return rows.map(row => value(get(row.id)));
        });
      },
      renewDirectReply(id, { owner, leaseMs = 60000, now = Date.now() } = {}) {
        const updated = db.prepare("UPDATE sa_direct_replies SET lease_until=? WHERE id=? AND state='claimed' AND owner=? AND lease_until>?")
          .run(now + leaseMs, id, owner, now);
        if (!updated.changes) throw fail('DIRECT_REPLY_LEASE_CONFLICT', 'Direct reply lease is no longer owned');
      },
      finishDirectReply(id, { owner, sent = false, suppressed = false, uncertain = false, receipt, error, retryMs = 5000, now = Date.now() } = {}) {
        ownerId(owner); time(now); time(retryMs);
        if ([sent, suppressed, uncertain].some(flag => typeof flag !== 'boolean') || [sent, suppressed, uncertain].filter(Boolean).length > 1) throw new Error('Invalid direct reply outcome');
        const receiptJson = receipt === undefined ? null : objectJson(receipt);
        return tx(() => {
          const row = get(id);
          if (!row) throw fail('DIRECT_REPLY_NOT_FOUND', 'Direct reply does not exist');
          const priorReceipt = row.receipt && JSON.parse(row.receipt);
          if (row.state === 'sent' && sent && receipt?.status === 'accepted' && receipt.messageId
            && priorReceipt?.status === receipt.status && priorReceipt.messageId === receipt.messageId) return value(row);
          if (row.state !== 'claimed' || row.owner !== owner || row.lease_until <= now) throw fail('DIRECT_REPLY_LEASE_CONFLICT', 'Direct reply lease is no longer owned');
          const state = sent ? 'sent' : suppressed ? 'suppressed' : uncertain ? 'uncertain' : 'queued';
          db.prepare('UPDATE sa_direct_replies SET state=?,owner=NULL,lease_until=NULL,last_error=?,receipt=COALESCE(?,receipt),next_at=?,updated_at=? WHERE id=?')
            .run(state, sent ? null : String(error || (suppressed ? 'delivery-suppressed' : 'delivery-failed')).slice(0, 1000), receiptJson,
              state === 'queued' ? now + retryMs : row.next_at, new Date(now).toISOString(), id);
          return value(get(id));
        });
      },
      // Only the authenticated owner service may submit external verification.
      reconcileDirectReply(id, { attempts, outcome, evidence, receipt, now = Date.now() } = {}) {
        time(now);
        if (!Number.isSafeInteger(attempts) || attempts < 1 || !['sent', 'not_sent', 'unknown'].includes(outcome)
          || typeof evidence !== 'string' || !evidence.trim() || evidence.length > 2000) throw fail('DELIVERY_RECONCILIATION_INVALID', 'Delivery verification requires an attempt, outcome and evidence');
        if (outcome === 'sent' && (receipt?.status !== 'accepted' || typeof receipt.messageId !== 'string' || !receipt.messageId.trim()
          || receipt.messageId.length > 512)) throw fail('DELIVERY_RECONCILIATION_INVALID', 'Confirmed delivery requires its original receipt');
        if (outcome !== 'sent' && receipt !== undefined) throw fail('DELIVERY_RECONCILIATION_INVALID', 'Only confirmed delivery accepts a receipt');
        const receiptJson = receipt === undefined ? null : objectJson(receipt);
        return tx(() => {
          const row = get(id);
          if (!row) throw fail('DIRECT_REPLY_NOT_FOUND', 'Direct reply does not exist');
          if (row.state !== 'uncertain' || row.attempts !== attempts) throw fail('DELIVERY_RECONCILIATION_CONFLICT', 'Delivery state or attempt changed');
          if (outcome === 'not_sent' && row.receipt && JSON.parse(row.receipt).parts?.length) {
            throw fail('DELIVERY_RECONCILIATION_CONFLICT', 'Partially delivered text cannot be retried as wholly unsent');
          }
          const at = new Date(now).toISOString(), state = outcome === 'sent' ? 'sent' : outcome === 'not_sent' ? 'queued' : 'uncertain';
          db.prepare('INSERT INTO sa_direct_reply_reconciliations(reply_id,attempts,outcome,evidence,receipt,created_at) VALUES (?,?,?,?,?,?)')
            .run(id, attempts, outcome, evidence.trim(), receiptJson, at);
          db.prepare('UPDATE sa_direct_replies SET state=?,owner=NULL,lease_until=NULL,last_error=?,receipt=COALESCE(?,receipt),next_at=?,updated_at=? WHERE id=?')
            .run(state, outcome === 'sent' ? null : outcome === 'not_sent' ? 'verified-not-sent' : 'delivery-still-unknown', receiptJson,
              state === 'queued' ? now + 30000 : row.next_at, at, id);
          return value(get(id));
        });
      },
      directReplies({ channel, threadId, state, limit = 100 } = {}) {
        const where = [], args = [];
        if (channel !== undefined) { ownerId(channel); where.push("json_extract(source,'$.channel')=?"); args.push(channel); }
        if (threadId !== undefined) { ownerId(threadId); where.push('thread_id=?'); args.push(threadId); }
        if (state !== undefined) { ownerId(state); where.push('state=?'); args.push(state); }
        return db.prepare(`SELECT * FROM sa_direct_replies${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC,id LIMIT ?`)
          .all(...args, limitValue(limit, 100)).map(value);
      },
    },
  };
}
