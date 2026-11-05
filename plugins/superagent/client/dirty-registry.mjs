import { useRef } from 'react';

// Keep sibling editors from clearing one another's unsaved-change warning.
export function useDirtyRegistry(onDirtyChange) {
  const current = useRef({ flags: new Set(), callbacks: new Map(), notify: onDirtyChange });
  current.current.notify = onDirtyChange;
  return key => {
    const registry = current.current;
    if (!registry.callbacks.has(key)) registry.callbacks.set(key, dirty => {
      if (dirty) registry.flags.add(key); else registry.flags.delete(key);
      registry.notify?.(registry.flags.size > 0, [...registry.flags]);
    });
    return registry.callbacks.get(key);
  };
}
