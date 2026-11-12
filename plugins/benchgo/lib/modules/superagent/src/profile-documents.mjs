/** Reads and edits the six assistant documents; conversation callers only see the privacy-filtered context. */
export async function profileDocuments(store, input, source) {
  const { op = 'list', name, content, expectedHash, versionId } = input;
  const filteredContext = async () => {
    const context = await store.getContext();
    return context.documents.map(row => {
      const content = String(row.content || '');
      return content.length > 12000 ? { ...row, content: content.slice(0, 12000), truncated: true } : row;
    });
  };
  const modelSafe = source?.kind === 'conversation';
  if (op === 'list') return { documents: modelSafe ? await filteredContext() : await store.documents.list() };
  if (op === 'read') {
    if (modelSafe && ['USER.md', 'MEMORY.md', 'TOOLS.md'].includes(name)) {
      const document = (await filteredContext()).find(row => row.name === name);
      if (!document) throw new Error('助手文档不存在');
      return { document };
    }
    return { document: await store.documents.read(name) };
  }
  if (modelSafe && op === 'versions' && ['USER.md', 'MEMORY.md', 'TOOLS.md'].includes(name)) return { versions: [] };
  if (modelSafe && ['update', 'restore'].includes(op) && ['USER.md', 'MEMORY.md', 'TOOLS.md'].includes(name)) {
    const raw = await store.documents.read(name), visible = (await filteredContext()).find(row => row.name === name);
    if (visible?.content !== raw.content) throw new Error('该文档包含受保护记忆，请使用助手记忆工具修改');
  }
  if (op === 'versions') return { versions: await store.documents.versions(name) };
  if (op === 'update') return { document: await store.documents.update(name, { content, expectedHash, source }) };
  if (op === 'restore') return { document: await store.documents.restore(name, { versionId, expectedHash }) };
  throw new Error('未知档案操作');
}
