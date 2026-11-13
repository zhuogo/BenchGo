import { ASSISTANT_DOCUMENTS } from './documents.mjs';

/** Fixed profiles and recursive memory files are separate; model reads always use the privacy projection. */
export async function profileDocuments(store, input, source) {
  const { op = 'list', name, content, expectedHash, versionId, recursive = false } = input;
  if (typeof recursive !== 'boolean') throw new Error('Invalid document listing mode');
  const filteredContext = async () => {
    const context = await store.getContext();
    const byName = new Map(context.documents.map(row => [row.name, row]));
    const rows = await Promise.all(ASSISTANT_DOCUMENTS.map(name => byName.get(name) || store.memory.readDocument(name)));
    return rows.map(row => {
      const content = String(row.content || '');
      return content.length > 12000 ? { ...row, content: content.slice(0, 12000), truncated: true } : row;
    });
  };
  const modelSafe = source?.kind === 'conversation';
  const protectedDocument = name => ['USER.md', 'MEMORY.md', 'TOOLS.md'].includes(name) || /^(?:memory|dreams)\//u.test(name || '');
  if (op === 'list') {
    if (recursive) return { documents: (await store.documents.list({ recursive: true })).map(({ name, hash, revision }) => ({ name, hash, revision })), recursive: true };
    return { documents: modelSafe ? await filteredContext() : await store.documents.list(), recursive: false };
  }
  if (op === 'read') {
    if (modelSafe && protectedDocument(name)) {
      const document = await store.memory.readDocument(name);
      return { document };
    }
    return { document: await store.documents.read(name) };
  }
  if (modelSafe && op === 'versions' && protectedDocument(name)) return { versions: [] };
  if (modelSafe && ['update', 'restore'].includes(op) && protectedDocument(name)) {
    if (name === 'MEMORY.md' || /^(?:memory|dreams)\//u.test(name)) throw new Error('请使用助手记忆工具修改记忆，派生视图由维护处理器生成');
    const raw = await store.documents.read(name), visible = await store.memory.readDocument(name);
    if (visible?.content !== raw.content) throw new Error('该文档包含受保护记忆，请使用助手记忆工具修改');
  }
  if (op === 'versions') return { versions: await store.documents.versions(name) };
  if (op === 'update') return { document: await store.documents.update(name, { content, expectedHash, source }) };
  if (op === 'restore') return { document: await store.documents.restore(name, { versionId, expectedHash }) };
  throw new Error('未知档案操作');
}
