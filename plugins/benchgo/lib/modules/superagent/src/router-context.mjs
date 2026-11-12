import { cleanMemoryContext, selectContextMemories } from './memory.mjs';

/** Builds the Router context for one turn: frozen documents plus the memories matching the incoming text. */
export function createRouterContext({ store, sessionId }) {
  let frozenContext, contextRevision;
  return async ({ incoming, messages }) => {
    const revision = store.memory.forgottenRevision();
    const [context, config] = await Promise.all([
      frozenContext && contextRevision === revision ? frozenContext : store.getSessionContext(sessionId),
      store.getConfig(),
    ]);
    // Understanding is frozen for this session; this is never an execution permit.
    // Persisted snapshots retain ordinary edits but may be scrubbed by an explicit forget.
    if (context !== frozenContext) frozenContext = structuredClone(context);
    contextRevision = revision;
    const modelContext = cleanMemoryContext(frozenContext);
    const profile = modelContext.documents || [];
    const memories = modelContext.memories || [];
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
      documents: profile.filter(row => !['MEMORY.md', 'TOOLS.md'].includes(row.name)).map(row => ({ name: row.name, content: String(row.content || '') })),
      documentCatalog: profile.map(row => ({ name: row.name })),
      memories: selectContextMemories(memories.filter(entry => entry.document !== 'USER.md'), incoming),
    });
  };
}
