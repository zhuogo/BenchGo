import { builtinPetDataUrl } from '../shared/pet-catalog.mjs';
export { petActionForEvent, petActionOptions, petWorkEvents } from '../shared/pet-actions.mjs';
let designIntent = null;
const listeners = new Set();
export const petDesignIntent = {
  getSnapshot: () => designIntent,
  subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  request(threadId = 'main', kind = 'design') { designIntent = { threadId, kind }; for (const listener of listeners) listener(); },
  clear() { designIntent = null; for (const listener of listeners) listener(); },
};
const retiredDesignDraft = '我想设计你的宠物形象：\n\n请先了解我的想法，优先复用可用素材，生成后让我预览再应用。';
/** Remove only the untouched retired preset; never discard edited text or attachments. */
export function isRetiredPetDraft(input) {
  return input?.phase === 'plain' && input.draft === retiredDesignDraft
    && !input.occurrences?.length && !input.attachmentIds?.length;
}
export function petImageUrl(pet, baseURI, expression) {
  const variant = pet?.appearance?.variant;
  const expressionAsset = expression && pet?.expressions?.[expression];
  const variantAsset = variant && (pet.appearance.palettes?.[variant] || pet.appearance.decorations?.[variant]);
  const asset = [expressionAsset, variantAsset, pet?.kind === 'custom' ? pet.assetId : null]
    .find(id => /^[a-f0-9-]{36}\.(?:png|jpg|webp)$/u.test(id || ''));
  if (asset) {
    const url = new URL('api/commander/assistant/pet-asset', baseURI);
    url.searchParams.set('id', asset);
    return url.href;
  }
  if (pet?.kind === 'builtin' || (!pet && expression)) { try { return builtinPetDataUrl({ ...pet, ...(expression ? { expression } : {}) }); } catch { return undefined; } }
  return undefined;
}

// Running is a fact; a reply ending is deliberately not treated as task success.
export function petActionForSession(session = {}) {
  if (session.openState === 'error') return 'idle';
  if (session.pendingInteraction) return 'waiting';
  return session.running ? 'focus' : 'idle';
}

export function petExpressionForAction(pet, action) {
  const custom = pet?.appearance?.actions?.[action];
  if (custom) return custom.expression || null;
  const face = { acknowledge: 'wink', focus: 'think', happy: 'happy', waiting: pet?.kind === 'custom' ? 'waiting' : 'stare' }[action];
  return face && (pet?.kind !== 'custom' || pet.expressions?.[face]) ? face : null;
}

export function latestPetExpression(events, revision, now = Date.now()) {
  return events.filter(event => event && event.revision === revision && typeof event.eventId === 'string'
    && (typeof event.expression === 'string' || typeof event.action === 'string') && Number.isFinite(event.createdAt)
    && now >= event.createdAt && now - event.createdAt < 10000)
    .sort((a, b) => b.createdAt - a.createdAt)[0] || null;
}

export async function applyPetDraft(api, config, draft) {
  try { return await api('petApply', { draftId: draft.draftId, revision: config.revision }); }
  catch (error) {
    if (error.status !== 409) throw error;
    const { config: latest } = await api('state');
    if (JSON.stringify(latest.pet ?? null) !== JSON.stringify(config.pet ?? null)) throw error;
    return api('petApply', { draftId: draft.draftId, revision: latest.revision });
  }
}
