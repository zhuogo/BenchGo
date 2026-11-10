import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmailAdapter, emailConfig, normalizeEmailEvent } from '../src/channels/email/index.mjs';
const config = () => emailConfig({ enabled: true, accountId: 'bot@example.com', imapHost: 'imap.example.com', smtpHost: 'smtp.example.com', username: 'bot', passwordSecretRef: 'vault/email', requestSecretRef: 'vault/request', chatIds: ['alice@example.com'] });
const mail = (extra = {}) => ({ from: { value: [{ address: 'alice@example.com' }] }, messageId: '<m1@example.com>', text: 'BenchGo-Token: secret\n帮我处理', headers: new Map(), ...extra });
test('email preserves unlisted and automated source facts without granting owner', () => {
  const c = config(); c.ownerIds = ['alice@example.com'];
  assert.equal(normalizeEmailEvent(mail(), c, 'secret').actor.owner, undefined);
  assert.equal(normalizeEmailEvent(mail({ headers: new Map([['auto-submitted', 'auto-replied']]) }), c, 'secret').actor.kind, 'machine');
  assert.equal(normalizeEmailEvent(mail({ headers: new Map([['list-id', 'list']]) }), c, 'secret').actor.kind, 'machine');
  assert.equal(normalizeEmailEvent(mail({ from: { value: [{ address: 'stranger@example.com' }] } }), c, 'secret').actor.id, 'stranger@example.com');
});
test('email uses References thread and excludes attachment payload', () => {
  const a = normalizeEmailEvent(mail(), config(), 'secret');
  const b = normalizeEmailEvent(mail({ messageId: '<m2@example.com>', inReplyTo: '<m1@example.com>', references: ['<m1@example.com>'], attachments: [{ content: 'SECRET' }] }), config(), 'secret');
  assert.equal(b.source.parentMessageId, '<m1@example.com>');
  assert.equal(a.threadId, b.threadId); assert.match(b.text, /附件暂不支持/); assert.ok(!JSON.stringify(b).includes('SECRET'));
});
test('email rejects missing/wrong/rotated tokens and strips token before Router', () => {
  const c = config();
  assert.equal(normalizeEmailEvent(mail({ text: 'forged request' }), c, 'secret'), null);
  assert.equal(normalizeEmailEvent(mail({ text: 'BenchGo-Token: wrong\nrequest' }), c, 'secret'), null);
  assert.equal(normalizeEmailEvent(mail(), c, 'rotated-secret'), null);
  const event = normalizeEmailEvent(mail({ text: 'BenchGo-Token: secret\r\nrequest\nquoted secret', subject: 'secret subject' }), c, 'secret');
  assert.ok(event); assert.ok(!JSON.stringify(event).includes('secret')); assert.ok(!event.text.includes('BenchGo-Token:'));
});
test('email polls through IMAP, sends threaded SMTP and honors revocation', async () => {
  let c = config(), seen = [], events = [], sent, failure;
  class Imap {
    on() {} async connect() {} close() {} async getMailboxLock() { return { release() {} }; }
    async search() { return seen.length ? [] : [7]; }
    async fetchOne(uid, fields) { return fields.size ? { size: 40 } : fields.envelope ? { envelope: { from: mail().from.value, messageId: mail().messageId } } : { source: Buffer.from('mail') }; }
    async messageFlagsAdd(uid) { seen.push(uid); }
  }
  const adapter = createEmailAdapter({ allowUnboundAuthorization: true, getConfig: () => c, credentials: { resolve: async () => ({ value: 'secret' }) }, ImapFlow: Imap, parseMail: async () => mail(),
    createTransport: () => ({ verify: async () => true, close() {}, sendMail: async value => { sent = value; if (failure) throw failure; return { accepted: [value.to], messageId: value.messageId }; } }), ingest: async event => events.push(await event.normalize()) });
  try {
    await adapter.start(); assert.equal(events.length, 1); assert.deepEqual(seen, [7]);
    assert.equal((await adapter.status()).connection.state, 'connected');
    const result = await adapter.send({ source: events[0].source, text: '完成', idempotencyKey: 'reply1' });
    assert.equal(result.status, 'accepted'); assert.equal(sent.inReplyTo, '<m1@example.com>'); assert.equal(sent.headers['Auto-Submitted'], 'auto-replied');
    failure = { responseCode: 550 }; await assert.rejects(adapter.send({ source: events[0].source, text: '完成', idempotencyKey: 'reject' }), { deliveryOutcome: 'not_sent' });
    failure = Error('timeout'); await assert.rejects(adapter.send({ source: events[0].source, text: '完成', idempotencyKey: 'unknown' }), { deliveryOutcome: 'unknown' });
    c = { ...c, chatIds: [] };
    await assert.rejects(adapter.send({ source: events[0].source, text: '完成', idempotencyKey: 'reply2' }), /变更/);
  } finally { await adapter.dispose(); }
});
test('email does not consume mail when Router ingestion fails', async () => {
  let marked = false;
  class Imap { on() {} async connect() {} close() {} async getMailboxLock() { return { release() {} }; } async search() { return [1]; } async fetchOne(uid, fields) { return fields.size ? { size: 10 } : fields.envelope ? { envelope: { from: mail().from.value, messageId: mail().messageId } } : { source: Buffer.from('mail') }; } async messageFlagsAdd() { marked = true; } }
  const adapter = createEmailAdapter({ allowUnboundAuthorization: true, getConfig: config, credentials: { resolve: async () => ({ value: 'secret' }) }, ImapFlow: Imap, parseMail: async () => mail(), createTransport: () => ({ verify: async () => {}, close() {} }), ingest: async () => { throw Error('offline'); } });
  try { await adapter.start(); assert.equal(marked, false); assert.equal((await adapter.status()).connection.state, 'failed'); } finally { await adapter.dispose(); }
});
test('email preserves native sender identity without configuration remapping', () => {
  const c = { ...config(), ownerIds: ['Alice@EXAMPLE.com'], chatIds: ['ALICE@example.COM'] };
  const event = normalizeEmailEvent(mail(), c, 'secret');
  assert.equal(event.actor.id, 'alice@example.com');
  assert.equal(event.source.conversationId, 'alice@example.com');
  assert.equal(event.source.accountId, c.accountId);
});
test('email server size filter leaves 50 oversized mails unread and handles later normal mail', async () => {
  const marked = [], events = [], fetched = [];
  const sizes = new Map(Array.from({ length: 51 }, (_, index) => [index + 1, index < 50 ? 6 * 1024 * 1024 : 100]));
  class Imap {
    on() {} async connect() {} close() {} async getMailboxLock() { return { release() {} }; }
    async search(query) { assert.equal(query.seen, false); assert.equal(query.smaller, 5 * 1024 * 1024 + 1); return [...sizes].filter(([uid, size]) => !marked.includes(uid) && size < query.smaller).map(([uid]) => uid); }
    async fetchOne(uid, fields) { fetched.push(uid); return fields.size ? { size: sizes.get(uid) } : fields.envelope ? { envelope: { from: mail().from.value, messageId: mail().messageId } } : { source: Buffer.from('mail') }; }
    async messageFlagsAdd(uid) { marked.push(uid); }
  }
  const adapter = createEmailAdapter({ allowUnboundAuthorization: true, getConfig: config, credentials: { resolve: async () => ({ value: 'secret' }) }, ImapFlow: Imap, parseMail: async () => mail(), createTransport: () => ({ verify: async () => {}, close() {} }), ingest: async event => events.push(await event.normalize()) });
  try { await adapter.start(); await adapter.poll(); assert.equal(events.length, 1); assert.deepEqual(marked, [51]); assert.ok(fetched.every(uid => uid === 51)); } finally { await adapter.dispose(); }
});

test('email checks source before body normalization and rechecks revoked history authorization', async () => {
  let bodyReads = 0, parsed = 0, envelope, revoked = false;
  class Imap {
    on() {} async connect() {} close() {} async getMailboxLock() { return { release() {} }; }
    async search() { return [1]; }
    async fetchOne(uid, fields) {
      if (fields.size) return { size: 40 };
      if (fields.envelope) return { envelope: { from: mail().from.value, messageId: mail().messageId } };
      bodyReads++; return { source: Buffer.from('mail') };
    }
    async messageFlagsAdd() {}
  }
  const adapter = createEmailAdapter({ getConfig: config, ImapFlow: Imap,
    credentials: { resolve: async () => ({ value: 'secret' }) },
    createTransport: () => ({ verify: async () => {}, close() {} }),
    parseMail: async () => { parsed++; return mail({ from: { value: [{ address: 'spoof@example.com' }] } }); },
    authorizeConnection: ({ operation }) => { if (revoked && operation === 'history') return false; },
    ingest: async event => {
      envelope = event; assert.equal(bodyReads, 0); assert.equal(parsed, 0);
      const normalized = await event.normalize();
      assert.deepEqual(normalized.source, event.source); assert.deepEqual(normalized.actor, event.actor);
      revoked = true; await assert.rejects(event.normalize(), /授权/);
    } });
  try { await adapter.start(); assert.ok(envelope); assert.equal(bodyReads, 1); assert.equal(parsed, 1); }
  finally { await adapter.dispose(); }
});

test('email refuses network access without the unified authorization callback', async () => {
  let connected = false;
  class Imap { on() {} close() {} async connect() { connected = true; } }
  const adapter = createEmailAdapter({ getConfig: config, ImapFlow: Imap,
    credentials: { resolve: async () => ({ value: 'secret' }) },
    createTransport: () => ({ close() {}, verify: async () => {} }), ingest: async () => {} });
  try { await adapter.start(); assert.equal(connected, false); assert.equal((await adapter.status()).connection.state, 'failed'); }
  finally { await adapter.dispose(); }
});

