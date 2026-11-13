import { cleanMemoryContext, selectContextMemories } from './memory.mjs';

/** The Router refreshes bounded understanding each turn; Worker snapshots remain independent. */
export function createRouterContext({ store, sessionId }) {
  return async ({ incoming = '', messages = [] }) => {
    const [context, config] = await Promise.all([
      store.getContext ? store.getContext() : store.getSessionContext(sessionId),
      store.getConfig(),
    ]);
    const modelContext = cleanMemoryContext(context);
    const profile = modelContext.documents || [];
    const memories = modelContext.memories || [];
    let budget = 12000;
    const documents = profile.filter(row => row.name !== 'TOOLS.md').map(row => {
      const maximum = row.name === 'MEMORY.md' ? 3500 : row.name.endsWith('/INDEX.md') ? 800 : row.name.endsWith('ALIGNMENT_SYNTHESIS.md') ? 1500 : 2000;
      const raw = String(row.content || ''), content = raw.slice(0, Math.max(0, Math.min(maximum, budget)));
      budget -= content.length;
      return { name: row.name, content, ...(content.length < raw.length ? { truncated: true } : {}) };
    });
    const overview = documents.find(row => row.name === 'MEMORY.md')?.content || '';
    const sourceKey = source => JSON.stringify([source?.sessionId || '', source?.messageId || '', source?.eventId || '', source?.taskId || '', source?.callId || '']);
    const injected = new Set(memories.filter(entry => overview.includes(`[[memory:${entry.id}]]`)).map(entry => sourceKey(entry.source)));
    const selected = selectContextMemories(memories.filter(entry => entry.document !== 'USER.md' && !overview.includes(`[[memory:${entry.id}]]`)), incoming, { maxEntries: 6, maxCharacters: 4000 }).filter(entry => {
      const key = sourceKey(entry.source);
      if (key === '["","","","",""]') return true;
      if (injected.has(key)) return false;
      injected.add(key); return true;
    });
    let proactiveContext = {};
    if (config.capabilities?.proactive === true && typeof incoming === 'string' && incoming.trim() && messages.some(message => message.source?.kind === 'user') && store.ideas?.list) {
      const ideas = (await store.ideas.list({ status: 'pending', limit: 20 })).filter(idea => idea.status === 'pending');
      const [relevant] = selectContextMemories(ideas.map(idea => ({ id: idea.id, content: `${idea.title}\n${idea.content}` })), incoming, { maxEntries: 1, maxCharacters: 1400 });
      const idea = relevant && ideas.find(idea => idea.id === relevant.id);
      if (idea) {
        const preference = store.memory?.readDocument ? await store.memory.readDocument('PROACTIVE_PREFERENCES.md') : await store.documents.read('PROACTIVE_PREFERENCES.md');
        const content = cleanMemoryContext({ documents: [preference] }).documents[0].content;
        proactiveContext = {
          ideaProposal: { id: idea.id, title: idea.title, content: idea.content, expiresAt: idea.expiresAt, memoryIds: idea.memoryIds || [], proposalOnly: true, requiresUserInstruction: true },
          proactivePreferences: { name: 'PROACTIVE_PREFERENCES.md', content: content.slice(0, 1500), ...(content.length > 1500 ? { truncated: true } : {}) },
        };
      }
    }
    return JSON.stringify({
      assistantName: config.name ?? '',
      assistantPet: config.pet ? {
        kind: config.pet.kind, assetId: config.pet.assetId,
        expression: config.pet.expression, decorations: config.pet.decorations,
        palette: config.pet.palette,
        availableExpressions: Object.keys(config.pet.expressions || {}),
      } : { kind: 'default' },
      ...(/\u540d\u7247|card(?:html|\s+design)?/iu.test(incoming) ? { assistantCardHtml: config.cardHtml ?? null } : {}),
      assistantCardMotion: config.cardMotion ?? true,
      notificationReply: messages.findLast(message => message.source?.kind === 'user' && message.source.replyContext)?.source.replyContext ?? null,
      documents,
      documentCatalog: profile.map(row => ({ name: row.name })),
      memories: selected,
      ...proactiveContext,
    });
  };
}
