const errors = new Set(['failed', 'uncertain']);
const draftKey = draft => JSON.stringify([draft.draft, (draft.occurrences || []).map(({ source, ref, offset, length, invalid }) => ({ source, ref, offset, length, invalid }))]);

/** Serialize the existing official reference chips; never submit their labels as authority. */
export async function serializeComposerText(draft, controller, signal) {
  const refs = [...(draft.occurrences || [])].sort((a, b) => a.offset - b.offset);
  let text = '', cursor = 0;
  for (const ref of refs) {
    if (ref.invalid || !controller || !Number.isSafeInteger(ref.offset) || !Number.isSafeInteger(ref.length)
      || ref.offset < cursor || ref.length < 0 || ref.offset + ref.length > draft.draft.length) throw new Error('输入中的引用暂不可解析，草稿已保留');
    text += draft.draft.slice(cursor, ref.offset) + await controller.serializeReference(ref.source, ref.ref, signal);
    cursor = ref.offset + ref.length;
  }
  return (text + draft.draft.slice(cursor)).trim();
}

/** A prop adapter for the official composer, backed only by the host's durable inbox. */
export function createComposerInboxBridge({ threadId, getDraft, clearDraft, submitCommand, serialize, send, requests,
  onAccepted = () => {}, onSystemError = () => {}, storage, storageKey, uuid = () => globalThis.crypto.randomUUID() }) {
  const pending = new Map(), flights = new Map();
  let disposed = false;
  try {
    const saved = JSON.parse(storage?.getItem(storageKey) || '[]');
    if (Array.isArray(saved)) for (const row of saved) {
      if (row?.threadId === threadId && typeof row.requestId === 'string' && typeof row.text === 'string' && typeof row.draftKey === 'string') pending.set(row.draftKey, row);
    }
  } catch { /* Storage is optional; durable acceptance lives on the host. */ }
  const persist = () => {
    try { if (pending.size) storage?.setItem(storageKey, JSON.stringify([...pending.values()])); else storage?.removeItem(storageKey); }
    catch { /* Private browsing/storage quotas do not bypass host persistence. */ }
  };
  const report = error => { if (!disposed) onSystemError(error?.message || String(error)); };
  async function reconcile() {
    if (!pending.size || !requests) return;
    try {
      const rows = await requests();
      for (const [key, row] of pending) {
        const receipt = rows.find(item => item.requestId === row.requestId);
        if (!receipt) { report(new Error('上次消息的接收状态尚未确认；再次发送同一草稿会沿用原请求标识核对')); continue; }
        pending.delete(key);
        if (errors.has(receipt.status)) report(new Error(receipt.error || `消息状态：${receipt.status}`));
      }
      persist();
      await onAccepted();
    } catch (error) { report(error); }
  }
  function submit(mode = 'queue', source) {
    if (disposed) return Promise.resolve();
    const draft = getDraft();
    if (!draft || !['plain', 'claimed'].includes(draft.phase) || !draft.draft.trim() && !draft.attachmentIds?.length) return Promise.resolve();
    // Keep upstream commands on their existing command plane. /clear must also
    // cancel this assistant's durable requests, so it goes through engine.send.
    if (draft.draft.trim().startsWith('/') && draft.draft.trim() !== '/clear') return Promise.resolve(submitCommand(mode, source));
    if (draft.attachmentIds?.length) { report(new Error('持久收件暂不支持附件；附件与文字草稿已保留，请先移除附件再发送')); return Promise.resolve(); }
    const key = draftKey(draft);
    if (flights.has(key)) return flights.get(key);
    const operation = (async () => {
      const text = await serialize(draft);
      if (disposed) return;
      let row = pending.get(key);
      if (row && row.text !== text) throw new Error('原请求的引用内容已变化，请调整草稿后发送');
      row ||= { threadId, text, requestId: uuid(), draftKey: key };
      // A clear command is not replayed after a lost reply or a page restart.
      if (text !== '/clear') { pending.set(key, row); persist(); }
      const receipt = await send({ threadId, text, requestId: row.requestId });
      pending.delete(key); persist();
      if (!disposed && draftKey(getDraft()) === key) clearDraft();
      if (errors.has(receipt?.status)) report(new Error(receipt.error || `消息状态：${receipt.status}`));
      await onAccepted(receipt);
      return receipt;
    })().catch(error => { report(error); }).finally(() => { if (flights.get(key) === operation) flights.delete(key); });
    flights.set(key, operation);
    return operation;
  }
  return { submit, reconcile, dispose() { disposed = true; } };
}

/** Only the retained assistant session gets this composer; approvals keep precedence. */
export function mountComposerInboxAdapter(slots, sessionId, component) {
  return slots.inject('conversation.composer', () => slots.register({
    name: 'conversation.composer', priority: 100,
    select: owner => owner.sessionId === sessionId && !owner.pendingInteraction ? { sessionId } : null,
  }, component));
}
