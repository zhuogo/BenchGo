import { createHash, createDecipheriv, timingSafeEqual } from 'node:crypto';

const origin = 'https://open.feishu.cn/open-apis';
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/u.test(value);
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Only references enter persisted/public configuration; secrets use Harness credentials. */
export function feishuConfig(input = {}) {
  if (!object(input)) throw fail('飞书配置无效');
  const fields = ['enabled', 'appId', 'appSecretRef', 'verificationTokenRef', 'encryptKeyRef', 'botOpenId', 'ownerOpenIds', 'chatIds', 'admissionMode', 'machineOpenIds', 'enabledRuleIds', 'accessMode', 'directMessages', 'groups', 'otherGroups'];
  if (Object.keys(input).some(key => !fields.includes(key))) throw fail('飞书配置包含未知字段');
  const result = { enabled: false, appId: '', appSecretRef: '', verificationTokenRef: '', encryptKeyRef: '', botOpenId: '', ownerOpenIds: [], chatIds: [], admissionMode: 'manual', machineOpenIds: [], enabledRuleIds: [], accessMode: 'owners', directMessages: true, groups: null, otherGroups: 'disabled', ...structuredClone(input) };
  if (!['owners', 'platform'].includes(result.accessMode) || typeof result.directMessages !== 'boolean' || !['disabled', 'mentions'].includes(result.otherGroups)) throw fail('飞书对话范围无效');
  if (result.groups !== null) {
    if (!Array.isArray(result.groups) || result.groups.length > 1000 || result.groups.some(group => !object(group) || Object.keys(group).some(key => !['chatId', 'name', 'mode'].includes(key)) || !id(group.chatId) || !['mentions', 'all', 'disabled'].includes(group.mode) || (group.name !== undefined && (typeof group.name !== 'string' || group.name.length > 512)))) throw fail('飞书群配置无效');
    if (new Set(result.groups.map(group => group.chatId)).size !== result.groups.length) throw fail('飞书群配置重复');
  }
  if (typeof result.enabled !== 'boolean') throw fail('飞书启用状态无效');
  if (!['manual', 'auto'].includes(result.admissionMode)) throw fail('飞书准入模式无效');
  for (const key of ['appId', 'appSecretRef', 'verificationTokenRef', 'encryptKeyRef', 'botOpenId']) if (result[key] !== '' && !id(result[key])) throw fail(`飞书 ${key} 无效`);
  for (const key of ['ownerOpenIds', 'chatIds', 'machineOpenIds', 'enabledRuleIds']) {
    if (!Array.isArray(result[key]) || result[key].length > 1000 || !result[key].every(id)) throw fail(`飞书 ${key} 无效`);
    result[key] = [...new Set(result[key])];
  }
  if (result.enabled && (!result.appId || !result.appSecretRef)) throw fail('启用飞书前请配置 App ID 和 App Secret 引用');
  return result;
}

/** A single scope check shared by event transport, reads and delivery. */
export function feishuGroupMode(config, chatId) {
  if (config.groups == null) return !config.chatIds?.length || config.chatIds.includes(chatId) ? 'all' : 'disabled';
  return config.groups.find(group => group.chatId === chatId)?.mode || config.otherGroups || 'disabled';
}

export function feishuSourceAllowed(config, source) {
  if (source?.appId !== config.appId || !id(source?.chatId)) return false;
  const direct = source.chatType ? source.chatType === 'p2p' : source.threadId === `feishu:${config.appId}:${source.chatId}:direct`;
  if (direct && config.directMessages === false) return false;
  if (config.groups == null) return !config.chatIds?.length || config.chatIds.includes(source.chatId);
  if (direct) return true;
  return feishuGroupMode(config, source.chatId) !== 'disabled';
}

/** Called only after the transport authenticates the envelope. Gate remains a domain concern. */
export function normalizeFeishuEvent(envelope, config) {
  if (envelope?.header?.event_type !== 'im.message.receive_v1') return null;
  const { header, event } = envelope;
  const message = event?.message, sender = event?.sender;
  if (!id(header.event_id) || !id(message?.message_id) || !id(message.chat_id) || !['group', 'p2p'].includes(message.chat_type) || !['user', 'app'].includes(sender?.sender_type)) throw fail('飞书消息元数据无效');
  const actorId = sender.sender_id?.open_id;
  if (!id(actorId) || !id(message.message_type) || typeof message.content !== 'string') throw fail('飞书消息内容或发送人无效');
  if (actorId === config.botOpenId || actorId === config.appId) return null;
  const time = Number(message.create_time);
  if (!Number.isSafeInteger(time) || time <= 0 || Number.isNaN(new Date(time).getTime())) throw fail('飞书消息时间无效');
  const mentions = message.mentions || [];
  if (!Array.isArray(mentions)) throw fail('飞书 mention 元数据无效');
  let content;
  try { content = JSON.parse(message.content); } catch { throw fail('飞书消息正文不是合法 JSON'); }
  let text;
  if (message.message_type === 'text' && typeof content?.text === 'string') text = content.text;
  else if (message.message_type === 'post') {
    const post = content.content ? content : content.zh_cn || content.en_us || Object.values(content).find(value => value?.content);
    const lines = Array.isArray(post?.content) ? post.content.map(row => Array.isArray(row) ? row.map(part => part.tag === 'text' ? part.text || '' : part.tag === 'a' ? `${part.text || ''} (${part.href || ''})` : part.tag === 'at' ? `@${part.user_name || part.user_id || ''}` : '[附件暂不支持读取]').join('') : '').join('\n') : '';
    text = [post?.title, lines].filter(Boolean).join('\n') || '[飞书富文本消息暂不支持读取，请发送文字描述]';
  } else text = `[飞书 ${message.message_type} 消息暂不支持读取正文，请发送文字描述或使用 BenchGo 工作台]`;
  for (const key of ['thread_id', 'root_id', 'parent_id']) {
    if (message[key] !== undefined && message[key] !== '' && !id(message[key])) throw fail('飞书回复关联标识无效');
  }
  const nativeThreadId = message.chat_type === 'p2p' ? 'direct' : message.thread_id || message.root_id || message.message_id;
  if (!id(nativeThreadId)) throw fail('飞书线程标识无效');
  const threadId = `feishu:${config.appId}:${message.chat_id}:${nativeThreadId}`;
  const source = { channel: 'feishu', appId: config.appId, chatId: message.chat_id, chatType: message.chat_type, messageId: message.message_id, threadId, replyInThread: Boolean(message.thread_id) };
  if (message.parent_id) source.parentMessageId = message.parent_id;
  if (message.root_id) source.rootMessageId = message.root_id;
  return {
    sourceKey: `feishu:${config.appId}:${message.message_id}`,
    channel: 'feishu', threadId, messageId: message.message_id,
    actor: { id: actorId, kind: sender.sender_type === 'user' ? 'human' : 'machine', owner: sender.sender_type === 'user' && config.ownerOpenIds.includes(actorId) },
    kind: message.chat_type === 'p2p' ? 'direct' : 'group', occurredAt: new Date(time).toISOString(), text,
    mentioned: Boolean(config.botOpenId) && mentions.some(mention => mention?.id?.open_id === config.botOpenId),
    source,
    // Authentication tokens never enter the durable event ledger.
    raw: { eventId: header.event_id, eventType: header.event_type, appId: header.app_id, event: structuredClone(event) },
  };
}

/** Official HTTP callback + REST transport. No queue or policy authority is duplicated here. */
export function createFeishuAdapter({ getConfig, credentials, ingest, readLocalContext, fetcher = fetch, now = Date.now, requestTimeoutMs = 15_000 } = {}) {
  if (typeof getConfig !== 'function' || typeof ingest !== 'function') throw fail('飞书适配器缺少配置或统一入口');
  const shutdown = new AbortController();
  let token, tokenPromise, configKey, identityKey;
  let state = { authentication: 'unverified', events: 'unverified', sending: 'unverified', lastEventAt: null, lastSendAt: null, error: null };
  const readConfig = async () => {
    shutdown.signal.throwIfAborted();
    const config = feishuConfig(await getConfig());
    const key = JSON.stringify(config);
    if (key !== configKey) {
      const nextIdentity = JSON.stringify([config.appId, config.appSecretRef]);
      const sameIdentity = identityKey === nextIdentity;
      configKey = key; identityKey = nextIdentity;
      if (!sameIdentity) token = undefined;
      state = { authentication: sameIdentity ? state.authentication : 'unverified', ...(sameIdentity && state.botName ? { botName: state.botName } : {}), events: 'unverified', sending: 'unverified', lastEventAt: null, lastSendAt: null, error: null };
    }
    return config;
  };
  const enabled = config => { if (!config.enabled) throw fail('飞书连接未启用', 409); };
  const secret = async ref => {
    const value = ref && (await credentials?.resolve(ref))?.value;
    if (typeof value !== 'string' || !value) throw fail('飞书凭据不可用，请在资源 → 连接中重新配置', 503);
    return value;
  };
  const request = async (path, options) => {
    let response;
    try { response = await fetcher(origin + path, { ...options, redirect: 'error', signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(requestTimeoutMs), ...(options?.signal ? [options.signal] : [])]) }); }
    catch { throw fail('飞书请求未取得确定回执', 502); }
    let body;
    try { body = await response.json(); } catch { throw fail('飞书返回无效回执', 502); }
    // Do not expose provider error text: it can echo request bodies or credentials.
    if (!response.ok || body?.code !== 0) throw fail(`飞书接口失败（HTTP ${response.status}，code ${Number.isInteger(body?.code) ? body.code : 'unknown'}）`, 502);
    return body;
  };
  const accessToken = async config => {
    const appSecret = await secret(config.appSecretRef);
    const key = createHash('sha256').update(config.appId + '\0' + appSecret).digest('hex');
    if (token?.key === key && token.expiresAt > now()) return token.value;
    if (tokenPromise?.key === key) return tokenPromise.promise;
    const promise = (async () => {
      const body = await request('/auth/v3/tenant_access_token/internal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ app_id: config.appId, app_secret: appSecret }) });
      if (!id(body.tenant_access_token) || !Number.isFinite(body.expire) || body.expire <= 0) throw fail('飞书认证回执无效', 502);
      token = { key, value: body.tenant_access_token, expiresAt: now() + Math.max(0, body.expire - 60) * 1000 };
      state.authentication = 'verified';
      return token.value;
    })();
    tokenPromise = { key, promise };
    try { return await promise; } finally { if (tokenPromise?.promise === promise) tokenPromise = undefined; }
  };
  const stillCurrent = async (config, requireEnabled = true) => {
    const current = await readConfig(); if (requireEnabled) enabled(current);
    if (JSON.stringify(current) !== JSON.stringify(config)) throw fail('飞书连接配置已变更，请重试', 409);
  };
  const api = async (config, path, options = {}, requireEnabled = true) => {
    const bearer = await accessToken(config);
    // Token acquisition may await the network; revocation must take effect before sending.
    await stillCurrent(config, requireEnabled);
    return request(path, { ...options, headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` } });
  };
  return {
    async status() { const config = await readConfig(); return { enabled: config.enabled, transport: 'long-connection', configured: Boolean(config.appId && config.appSecretRef), ...structuredClone(state) }; },
    async verify() {
      const config = await readConfig();
      try {
        const body = await api(config, '/bot/v3/info', { method: 'GET' }, false);
        const botOpenId = body.bot?.open_id;
        if (!id(botOpenId)) throw fail('飞书未返回机器人身份', 502);
        if (config.botOpenId && config.botOpenId !== botOpenId) throw fail('飞书机器人身份与配置不一致', 409);
        await stillCurrent(config, false);
        state.authentication = 'verified';
        state.botName = typeof body.bot?.app_name === 'string' ? body.bot.app_name : '';
        state.error = null;
        return { ...(await this.status()), botOpenId, botName: typeof body.bot?.app_name === 'string' ? body.bot.app_name : '' };
      } catch (error) { state.authentication = 'failed'; state.error = error.message; throw error; }
    },
    async listChats({ pageToken } = {}) {
      const config = await readConfig();
      if (pageToken !== undefined && !id(pageToken)) throw fail('飞书群列表分页标识无效');
      const query = new URLSearchParams({ page_size: '100' });
      if (pageToken) query.set('page_token', pageToken);
      const body = await api(config, `/im/v1/chats?${query}`, { method: 'GET' }, false);
      await stillCurrent(config, false);
      const items = body.data?.items;
      if (!Array.isArray(items) || items.some(item => !id(item.chat_id))) throw fail('飞书群列表回执无效', 502);
      const next = body.data?.has_more ? body.data.page_token : undefined;
      if (body.data?.has_more && (!id(next) || next === pageToken)) throw fail('飞书群列表分页回执无效', 502);
      return { chats: items.map(item => ({ chatId: item.chat_id, name: typeof item.name === 'string' ? item.name : item.chat_id })), ...(next ? { nextPageToken: next } : {}) };
    },
    async readContext({ source, signal } = {}) {
      const config = await readConfig(); enabled(config);
      if (source?.channel !== 'feishu' || !id(source.messageId) || !feishuSourceAllowed(config, source)) throw fail('飞书上下文来源不在当前连接范围', 403);
      const rows = new Map();
      const check = async () => { signal?.throwIfAborted(); await stillCurrent(config); };
      const add = row => {
        if (!id(row?.message_id) || row.chat_id !== source.chatId || row.deleted) return;
        let content;
        try { content = JSON.parse(row.body?.content || '{}'); } catch { return; }
        let text = '';
        if (row.msg_type === 'text') text = typeof content.text === 'string' ? content.text : '';
        else if (row.msg_type === 'post') {
          const post = content.content ? content : content.zh_cn || content.en_us || Object.values(content).find(value => value?.content);
          text = [post?.title, ...(Array.isArray(post?.content) ? post.content.map(line => Array.isArray(line) ? line.map(part => part.tag === 'text' || part.tag === 'a' ? part.text || '' : part.tag === 'at' ? `@${part.user_name || part.user_id || ''}` : '[附件]').join('') : '') : [])].filter(Boolean).join('\n');
        } else text = `[${row.msg_type || '未知'} 消息正文暂不支持读取]`;
        const time = Number(row.create_time);
        if (!Number.isSafeInteger(time) || time <= 0 || Number.isNaN(new Date(time).getTime())) return;
        rows.set(row.message_id, { messageId: row.message_id, text: text.slice(0, 4000), actor: { id: row.sender?.id || '', kind: row.sender?.sender_type === 'user' ? 'human' : 'machine' }, createdAt: new Date(time).toISOString() });
      };
      try {
        await check();
        for (const row of (await readLocalContext?.(source) || []).slice(-20)) {
          if (id(row?.messageId) && typeof row.text === 'string') rows.set(row.messageId, { ...row, text: row.text.slice(0, 4000) });
        }
        await check();
        const anchorBody = await api(config, `/im/v1/messages/${encodeURIComponent(source.messageId)}`, { method: 'GET', signal });
        await check();
        const anchor = anchorBody.data?.items?.find(row => row.message_id === source.messageId);
        if (!anchor || anchor.chat_id !== source.chatId) throw fail('飞书上下文锚点与当前会话不一致', 403);
        add(anchor);
        const timestamp = Number(anchor.create_time);
        if (!Number.isSafeInteger(timestamp) || timestamp <= 0) throw fail('飞书上下文时间无效', 502);
        const query = new URLSearchParams({ container_id_type: 'chat', container_id: source.chatId, end_time: String(Math.floor(timestamp / 1000) + 1), sort_type: 'ByCreateTimeDesc', page_size: '20' });
        if (id(anchor.thread_id)) { query.set('container_id_type', 'thread'); query.set('container_id', anchor.thread_id); }
        const history = await api(config, `/im/v1/messages?${query}`, { method: 'GET', signal });
        await check();
        if (!Array.isArray(history.data?.items)) throw fail('飞书历史回执无效', 502);
        for (const row of history.data.items) if (Number(row.create_time) <= timestamp) add(row);
        const parent = anchor.parent_id || anchor.root_id;
        if (id(parent) && !rows.has(parent)) {
          const reference = await api(config, `/im/v1/messages/${encodeURIComponent(parent)}`, { method: 'GET', signal });
          await check();
          for (const row of reference.data?.items || []) if (row.message_id === parent) add(row);
        }
        return { status: 'available', reason: '仅读取触发消息及同会话的近期讨论，未读取全部历史。', messages: [...rows.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-20) };
      } catch (error) {
        await check();
        if (error.status === 403 || error.status === 409) throw error;
        return { status: rows.size ? 'partial' : 'unavailable', reason: '飞书历史读取受限或失败；仅可参考已返回的消息，不能声称已阅读完整讨论。', messages: [...rows.values()] };
      }
    },
    async handle(request) {
      try {
        const config = await readConfig(); enabled(config);
        if (request.method !== 'POST') throw fail('Method not allowed', 405);
        const reader = request.body?.getReader();
        if (!reader) throw fail('飞书请求体为空');
        const chunks = []; let size = 0;
        try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 1024 * 1024) { await reader.cancel(); throw fail('飞书事件过大', 413); } chunks.push(value); } } finally { reader.releaseLock(); }
        const raw = Buffer.concat(chunks).toString('utf8');
        let body; try { body = JSON.parse(raw); } catch { throw fail('飞书事件不是合法 JSON'); }
        if (config.encryptKeyRef) {
          const encryptKey = await secret(config.encryptKeyRef);
          const timestamp = request.headers.get('x-lark-request-timestamp'), nonce = request.headers.get('x-lark-request-nonce');
          if (!/^\d+$/u.test(timestamp || '') || Math.abs(now() - Number(timestamp) * 1000) > 300_000 || !id(nonce)) throw fail('飞书事件签名已过期或无效', 401);
          const signature = createHash('sha256').update(timestamp + nonce + encryptKey + raw).digest('hex');
          if (!equal(signature, request.headers.get('x-lark-signature'))) throw fail('飞书事件签名无效', 401);
          if (typeof body.encrypt !== 'string') throw fail('飞书事件缺少加密正文', 401);
          try {
            const bytes = Buffer.from(body.encrypt, 'base64');
            const decipher = createDecipheriv('aes-256-cbc', createHash('sha256').update(encryptKey).digest(), bytes.subarray(0, 16));
            body = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(16)), decipher.final()]).toString('utf8'));
          } catch { throw fail('飞书事件无法解密', 401); }
        } else if (body.encrypt) throw fail('请配置飞书 Encrypt Key 引用', 503);
        const verificationToken = await secret(config.verificationTokenRef);
        if (!equal(body.header?.token || body.token, verificationToken)) throw fail('飞书事件认证失败', 401);
        if (body.type === 'url_verification') {
          if (!id(body.challenge)) throw fail('飞书验证挑战无效');
          return Response.json({ challenge: body.challenge });
        }
        if (body.schema !== '2.0' || body.header?.app_id !== config.appId) throw fail('飞书应用或事件版本不匹配', 401);
        const input = normalizeFeishuEvent(body, config);
        if (input && !feishuSourceAllowed(config, input.source)) return Response.json({ code: 0, ignored: 'chat-scope' });
        // Await durable admission before acknowledging. Downstream does not wait for inference.
        await stillCurrent(config);
        if (input) await ingest(input);
        state.events = 'verified'; state.lastEventAt = now(); state.error = null;
        return Response.json({ code: 0 });
      } catch (error) {
        // Domain errors may contain user content; keep the external boundary generic.
        const status = error.status || 503;
        return Response.json({ error: status >= 500 ? '飞书事件暂未持久接收，请重试' : '飞书事件校验失败' }, { status });
      }
    },
    async send({ source, text, idempotencyKey }) {
      const config = await readConfig(); enabled(config);
      if (source?.channel !== 'feishu' || !id(source.messageId) || !feishuSourceAllowed(config, source)) throw fail('飞书交付来源不在当前连接范围', 403);
      if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 20_000 || !id(idempotencyKey)) throw fail('飞书交付内容或幂等键无效');
      const uuid = createHash('sha256').update(config.appId + '\0' + idempotencyKey).digest('hex').slice(0, 32);
      try {
        const body = await api(config, `/im/v1/messages/${encodeURIComponent(source.messageId)}/reply`, { method: 'POST', body: JSON.stringify({ msg_type: 'text', content: JSON.stringify({ text }), uuid, reply_in_thread: source.replyInThread === true }) });
        if (!id(body.data?.message_id)) throw fail('飞书发送回执缺少消息标识', 502);
        state.sending = 'verified'; state.lastSendAt = now(); state.error = null;
        return { status: 'accepted', messageId: body.data.message_id, idempotencyKey, uuid };
      } catch (error) { state.sending = 'failed'; state.error = error.message; throw error; }
    },
    dispose() { shutdown.abort(); token = undefined; },
  };
}
