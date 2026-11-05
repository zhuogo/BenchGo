import { createRequire } from 'node:module';
import { createHash, timingSafeEqual } from 'node:crypto';
import { beforeDelivery, deliveryFailure } from './delivery-outcome.mjs';
const require = createRequire(new URL('../../../../../package.json', import.meta.url));
const field = (key, label, extra = {}) => ({ key, label, type: key.endsWith('SecretRef') ? 'secretRef' : 'text', required: true, ...extra });
export const channelDefinition = {
  id: 'email', label: 'Email',
  defaults: { enabled: false, ownerIds: [], chatIds: [], accountId: '', imapHost: '', imapPort: '993', smtpHost: '', smtpPort: '465', username: '', passwordSecretRef: '', requestSecretRef: '', mailbox: 'INBOX' },
  fields: [field('accountId', '邮箱地址'), field('imapHost', 'IMAP 服务器'), field('smtpHost', 'SMTP 服务器'), field('username', '登录账号'), field('passwordSecretRef', '邮箱密码或授权码'), field('requestSecretRef', '邮件指令校验码'), field('imapPort', 'IMAP 端口', { advanced: true }), field('smtpPort', 'SMTP 端口', { advanced: true }), field('mailbox', '收件文件夹', { advanced: true })],
  capabilities: { direct: true, group: false, text: true, attachments: false, realtimeVoice: false, transport: 'imap-smtp', notes: '邮件正文首行必须为 BenchGo-Token: <邮件指令校验码>，可保存为邮件模板；仅接收允许列表发件人且校验码正确的邮件，校验行不会进入助手。读取 5 MB 以内未读邮件并标记已读，超限邮件保留未读且不阻塞后续邮件；支持邮件线程，附件暂不解析，请使用专用邮箱。IMAP 使用 TLS，SMTP 465 使用 TLS、其他端口要求 STARTTLS。' },
};
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const address = value => typeof value === 'string' && /^[^\s<>@,;]+@[^\s<>@,;]+$/.test(value) && !/[\r\n]/.test(value);
const messageId = value => typeof value === 'string' && /^<[^<>\s]+>$/.test(value) && value.length < 998;
export function emailConfig(input = {}) {
  const c = { ...channelDefinition.defaults, ...input };
  if (Object.keys(input).some(k => !(k in channelDefinition.defaults)) || typeof c.enabled !== 'boolean') throw fail('邮件配置无效');
  for (const key of ['ownerIds', 'chatIds']) if (!Array.isArray(c[key]) || !c[key].every(address)) throw fail('邮件允许列表必须使用邮箱地址');
  for (const f of channelDefinition.fields) if (typeof c[f.key] !== 'string' || /[\r\n\x00]/.test(c[f.key]) || c[f.key].length > 512) throw fail(`${f.label} 无效`);
  for (const key of ['imapPort', 'smtpPort']) if (!/^\d+$/.test(c[key]) || +c[key] < 1 || +c[key] > 65535) throw fail('邮件端口无效');
  if (c.enabled && (channelDefinition.fields.some(f => f.required && !c[f.key]) || !address(c.accountId))) throw fail('请填写完整的邮件连接配置');
  return structuredClone(c);
}
const allowed = (c, sender) => [...c.ownerIds, ...c.chatIds].some(x => x.toLowerCase() === sender.toLowerCase());
export function normalizeEmailEvent(mail, c, requestSecret) {
  if (typeof requestSecret !== 'string' || !requestSecret || /[\r\n]/.test(requestSecret)) return null;
  const bodyText = String(mail.text || '');
  const firstLineEnd = bodyText.indexOf('\n');
  const firstLine = (firstLineEnd < 0 ? bodyText : bodyText.slice(0, firstLineEnd)).replace(/\r$/, '');
  const supplied = firstLine.startsWith('BenchGo-Token: ') ? firstLine.slice('BenchGo-Token: '.length) : '';
  if (!timingSafeEqual(createHash('sha256').update(supplied).digest(), createHash('sha256').update(requestSecret).digest())) return null;
  // Strip the credential before constructing anything delivered to Router or persisted.
  const safeText = firstLineEnd < 0 ? '' : bodyText.slice(firstLineEnd + 1);
  const sender = mail.from?.value?.length === 1 ? mail.from.value[0].address : '';
  const header = name => String(mail.headers?.get(name) || '').toLowerCase();
  if (!address(sender) || sender.toLowerCase() === c.accountId.toLowerCase() || !allowed(c, sender)) return null;
  // Match only email identities case-insensitively, then preserve configured IDs
  // exactly so the common Router's opaque-ID authorization remains consistent.
  const matchesSender = value => value.toLowerCase() === sender.toLowerCase();
  const actorId = c.ownerIds.find(matchesSender) || c.chatIds.find(matchesSender) || sender;
  const chatId = c.chatIds.find(matchesSender) || c.ownerIds.find(matchesSender) || sender;
  if ((header('auto-submitted') && header('auto-submitted') !== 'no') || /bulk|list|junk/.test(header('precedence')) || mail.headers?.has('list-id') || mail.headers?.has('x-autoreply') || mail.headers?.has('x-autorespond')) return null;
  if (!messageId(mail.messageId)) return null;
  const refs = (Array.isArray(mail.references) ? mail.references : [mail.references]).filter(messageId);
  const root = refs[0] || (messageId(mail.inReplyTo) ? mail.inReplyTo : mail.messageId);
  const threadId = `email:${c.accountId}:${chatId}:${root}`;
  const body = safeText.replaceAll(requestSecret, '[已隐藏邮件校验码]').slice(0, 32000);
  return { sourceKey: `email:${c.accountId}:${mail.messageId}`, channel: 'email', threadId, messageId: mail.messageId,
    actor: { id: actorId, kind: 'human', owner: false }, kind: 'direct', mentioned: false,
    occurredAt: mail.date instanceof Date && Number.isFinite(+mail.date) ? mail.date.toISOString() : new Date().toISOString(),
    text: `${mail.subject ? `主题：${String(mail.subject).replaceAll(requestSecret, '[已隐藏邮件校验码]').slice(0, 500)}\n\n` : ''}${body}${mail.attachments?.length ? '\n[邮件附件暂不支持，请使用 BenchGo 工作台提供附件内容]' : ''}`,
    source: { channel: 'email', accountId: c.accountId, chatId, messageId: mail.messageId, threadId,
      ...(messageId(mail.inReplyTo) ? { parentMessageId: mail.inReplyTo } : {}), subject: String(mail.subject || '').replaceAll(requestSecret, '[已隐藏邮件校验码]').replace(/[\r\n]/g, ' ').slice(0, 500), references: [...refs.slice(-19), mail.messageId] }, raw: { messageId: mail.messageId } };
}
export function createEmailAdapter(options) {
  let imap, smtp, timer, reconnect, running, stopped = true, activeConfig;
  const state = { authentication: 'unverified', events: 'unverified', sending: 'unverified', connection: { state: 'stopped' }, error: null };
  const read = async () => emailConfig(await options.getConfig());
  const current = async c => { const latest = await read(); if (stopped || !latest.enabled || JSON.stringify(latest) !== JSON.stringify(c)) throw fail('邮件连接已停用或配置已变更', 409); };
  const status = async () => { const c = await read(); return { enabled: c.enabled, configured: channelDefinition.fields.every(f => !f.required || Boolean(c[f.key])), ...structuredClone(state) }; };
  async function poll() {
    if (running || stopped) return;
    running = (async () => {
      const c = activeConfig; await current(c);
      const lock = await imap.getMailboxLock(c.mailbox);
      try {
        // Filter on the server so an arbitrarily large prefix of oversized unread
        // messages cannot starve eligible mail or require a growing skip cache.
        const ids = await imap.search({ seen: false, smaller: 5 * 1024 * 1024 + 1 }, { uid: true });
        for (const uid of ids.slice(0, 50)) {
          await current(c);
          const meta = await imap.fetchOne(uid, { size: true }, { uid: true });
          if (!meta || meta.size > 5 * 1024 * 1024) { state.error = '存在超过 5 MB 的邮件，未读取，请在邮箱处理'; continue; }
          const item = await imap.fetchOne(uid, { source: true }, { uid: true });
          if (!item?.source || item.source.length > 5 * 1024 * 1024) continue;
          const parse = options.parseMail || require('mailparser').simpleParser;
          const parsed = await parse(item.source, { skipHtmlToText: true, skipTextToHtml: true });
          const requestSecret = (await options.credentials?.resolve(c.requestSecretRef))?.value;
          if (typeof requestSecret !== 'string' || !requestSecret || /[\r\n]/.test(requestSecret)) throw fail('邮件指令校验码不可用', 503);
          const event = normalizeEmailEvent(parsed, c, requestSecret);
          await current(c);
          if (event) { await options.ingest(event); state.events = 'verified'; }
          // Unauthorized and automated mail is not acted on, but must not starve later mail.
          await imap.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
        }
      } finally { lock.release(); }
    })();
    try { await running; } catch { state.error = '邮件读取失败，请检查连接与配置'; state.connection = { state: 'failed' }; }
    finally { running = undefined; }
  }
  async function dispose() { stopped = true; clearInterval(timer); clearTimeout(reconnect); imap?.close(); await running; smtp?.close(); imap = smtp = undefined; state.connection = { state: 'stopped' }; }
  async function start() {
    await dispose(); const c = await read(); if (!c.enabled) return;
    stopped = false; activeConfig = c; Object.assign(state, { authentication: 'unverified', events: 'unverified', sending: 'unverified', error: null, connection: { state: 'connecting' } });
    try {
      const pass = (await options.credentials?.resolve(c.passwordSecretRef))?.value;
      if (typeof pass !== 'string' || !pass) throw fail('邮件凭据不可用', 503);
      const requestSecret = (await options.credentials?.resolve(c.requestSecretRef))?.value;
      if (typeof requestSecret !== 'string' || !requestSecret || /[\r\n]/.test(requestSecret)) throw fail('邮件指令校验码不可用', 503);
      await current(c);
      const ImapFlow = options.ImapFlow || require('imapflow').ImapFlow;
      imap = new ImapFlow({ host: c.imapHost, port: +c.imapPort, secure: true, auth: { user: c.username, pass }, logger: false });
      imap.on?.('error', () => { state.error = 'IMAP 连接失败'; state.connection = { state: 'failed' }; });
      imap.on?.('close', () => { if (!stopped) { state.error = 'IMAP 连接已断开，正在重连'; state.connection = { state: 'reconnecting' }; clearTimeout(reconnect); reconnect = setTimeout(() => { void start(); }, 15000); reconnect.unref?.(); } });
      smtp = (options.createTransport || require('nodemailer').createTransport)({ host: c.smtpHost, port: +c.smtpPort, secure: +c.smtpPort === 465, requireTLS: true, auth: { user: c.username, pass }, connectionTimeout: 15000, socketTimeout: 30000 });
      await imap.connect(); await smtp.verify(); await current(c);
      state.authentication = 'verified'; state.connection = { state: 'connected' };
      await poll(); timer = setInterval(() => { void poll(); }, options.pollIntervalMs || 30000); timer.unref?.();
    } catch { await dispose(); state.authentication = 'failed'; state.connection = { state: 'failed' }; state.error = '邮件认证或依赖不可用，请检查邮箱设置与凭据'; }
  }
  return { start, dispose, status, poll, async verify() { await start(); return status(); },
    async send({ source, text, idempotencyKey }) {
      const c = await beforeDelivery(async () => {
        const config = activeConfig; if (!config) throw fail('邮件连接尚未启动', 503); await current(config);
        if (!smtp || source?.channel !== 'email' || source.accountId !== config.accountId || !address(source.chatId) || !allowed(config, source.chatId) || !messageId(source.messageId)) throw fail('邮件回复来源未获授权', 403);
        if (typeof text !== 'string' || !text.trim() || text.length > 100000 || typeof idempotencyKey !== 'string' || !idempotencyKey) throw fail('邮件内容或幂等键无效');
        return config;
      });
      const id = `<benchgo-${createHash('sha256').update(idempotencyKey).digest('hex')}@${c.accountId.split('@')[1]}>`;
      await beforeDelivery(() => current(c));
      let result;
      try { result = await smtp.sendMail({ from: c.accountId, to: source.chatId, subject: `Re: ${String(source.subject || '').replace(/[\r\n]/g, ' ').slice(0, 500)}`, text, messageId: id, inReplyTo: source.messageId, references: (source.references || []).filter(messageId).slice(-20), headers: { 'Auto-Submitted': 'auto-replied', 'X-Auto-Response-Suppress': 'All' }, disableFileAccess: true, disableUrlAccess: true }); }
      catch (error) { throw deliveryFailure('SMTP 发送未成功', Number.isInteger(error?.responseCode) && error.responseCode >= 400 && error.responseCode < 600 ? 'not_sent' : 'unknown', 502); }
      if (!Array.isArray(result?.accepted) || !result.accepted.some(x => String(x).toLowerCase() === source.chatId.toLowerCase())) throw deliveryFailure('SMTP 未接受目标收件人',
        Array.isArray(result?.rejected) && result.rejected.some(x => String(x).toLowerCase() === source.chatId.toLowerCase()) ? 'not_sent' : 'unknown', 502);
      state.sending = 'verified'; return { status: 'accepted', messageId: result.messageId || id };
    },
  };
}

