const isPlain = value => {
  // A root prototype from any realm; class instances, Maps and Dates are never merged.
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || Object.getPrototypeOf(prototype) === null;
};
const identity = value => value !== null && typeof value === 'object' ? value.id ?? value.eventId : undefined;

/**
 * Returns `next` with every unchanged branch replaced by its `previous` identity,
 * and `previous` itself when nothing changed. Polled JSON then re-renders only
 * the rows whose data moved. Array items with an `id`/`eventId` match by that
 * identity, so a prepended page or a sliding window keeps its settled items.
 */
export function structuralShare(previous, next) {
  if (Object.is(previous, next) || previous === null || next === null
    || typeof previous !== 'object' || typeof next !== 'object') return next;
  if (Array.isArray(next)) {
    if (!Array.isArray(previous)) return next;
    let byIdentity, same = previous.length === next.length;
    const shared = next.map((value, index) => {
      let candidate = previous[index];
      const id = identity(value);
      if (id !== undefined && identity(candidate) !== id) {
        byIdentity ||= new Map(previous.map(item => [identity(item), item]));
        candidate = byIdentity.get(id);
      }
      const result = structuralShare(candidate, value);
      if (result !== previous[index]) same = false;
      return result;
    });
    return same ? previous : shared;
  }
  if (Array.isArray(previous) || !isPlain(previous) || !isPlain(next)) return next;
  const keys = Object.keys(next), shared = {};
  let same = keys.length === Object.keys(previous).length;
  for (const key of keys) {
    shared[key] = structuralShare(previous[key], next[key]);
    if (shared[key] !== previous[key] || !Object.hasOwn(previous, key)) same = false;
  }
  return same ? previous : shared;
}
