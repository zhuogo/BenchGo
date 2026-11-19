/** Reconcile a saved effort against the exact model's current capabilities. */
export async function reconcileReasoning(llm, selection, signal) {
  if (selection?.reasoningEffort === undefined || !llm?.resolveModelInfo) return selection;
  const { provider, model, reasoningEffort } = selection;
  let info;
  try { info = await llm.resolveModelInfo(provider, model, signal); }
  catch { return selection; }
  if (signal?.aborted || info.reasoning?.efforts?.some(effort => effort.id === reasoningEffort)) return selection;
  return { provider, model };
}

export async function reconcileRoutedReasoning(llm, models, signal) {
  return Promise.all(models.map(async row => {
    if (row.options?.reasoningEffort === undefined) return row;
    const selection = await reconcileReasoning(llm, { provider: row.providerId, model: row.modelId,
      reasoningEffort: row.options.reasoningEffort }, signal);
    if (selection.reasoningEffort !== undefined) return row;
    const { reasoningEffort: _unused, ...options } = row.options;
    return { ...row, options };
  }));
}

export function mountLiveReasoning(ctx) {
  async function refresh(agent, signal) {
    const selection = agent.model.current();
    const next = await reconcileReasoning(ctx.llm, selection, signal);
    if (next === selection || signal?.aborted || agent.status !== 'idle') return;
    const current = agent.model.current();
    if (current?.provider === selection.provider && current.model === selection.model
      && current.reasoningEffort === selection.reasoningEffort) agent.model.select(next);
  }
  const refreshOpen = provider => Promise.all(ctx.agents.list()
    .filter(agent => provider === undefined || agent.model.current()?.provider === provider)
    .map(agent => refresh(agent)));
  const update = provider => { void refreshOpen(provider).catch(error => ctx.logger?.warn?.(error)); };
  ctx.on('agent/created', async ({ agent, signal }) => { await refresh(agent, signal); });
  ctx.on('llm/adapters-updated', () => update());
  ctx.on('llm/models-updated', update);
  ctx.on('settings/document-updated', ns => { if (ns.startsWith('llm-')) update(); });
  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'idle') void refresh(agent).catch(error => ctx.logger?.warn?.(error));
  });
  update();
}
