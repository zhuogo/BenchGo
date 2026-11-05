import { builtinPetDataUrl } from '../shared/pet-catalog.mjs';
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
  if (pet?.kind === 'builtin' || (!pet && expression)) { try { return builtinPetDataUrl({ ...pet, ...(expression ? { expression } : {}) }); } catch { return undefined; } }
  if (pet?.kind !== 'custom' || !/^[a-f0-9-]{36}\.(?:png|jpg|webp)$/u.test(pet.assetId || '')) return undefined;
  const url = new URL('api/commander/assistant/pet-asset', baseURI);
  const expressionAsset = expression && pet.expressions?.[expression];
  url.searchParams.set('id', /^[a-f0-9-]{36}\.(?:png|jpg|webp)$/u.test(expressionAsset || '') ? expressionAsset : pet.assetId);
  return url.href;
}

// Running is a fact; a reply ending is deliberately not treated as task success.
export function petActionForSession(session = {}) {
  if (session.openState === 'error') return 'idle';
  if (session.pendingInteraction) return 'waiting';
  return session.running ? 'focus' : 'idle';
}

export function petExpressionForAction(pet, action) {
  const face = { acknowledge: 'wink', focus: 'think', happy: 'happy', waiting: pet?.kind === 'custom' ? 'waiting' : 'stare' }[action];
  return face && (pet?.kind !== 'custom' || pet.expressions?.[face]) ? face : null;
}

export function latestPetExpression(events, revision, now = Date.now()) {
  return events.filter(event => event && event.revision === revision && typeof event.eventId === 'string'
    && typeof event.expression === 'string' && Number.isFinite(event.createdAt)
    && now >= event.createdAt && now - event.createdAt < 10000)
    .sort((a, b) => b.createdAt - a.createdAt)[0] || null;
}
