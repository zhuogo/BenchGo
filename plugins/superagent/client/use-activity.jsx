import { useSyncExternalStore } from 'react';
import { createActivityStore } from './activity-data.mjs';

const stores = new WeakMap();
export function useAssistantActivity(api) {
  if (!stores.has(api)) stores.set(api, createActivityStore(api));
  const store = stores.get(api);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return { ...snapshot, refresh: store.refresh };
}
