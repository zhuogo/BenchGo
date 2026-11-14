import { useSyncExternalStore } from 'react';
import { createActivityStore } from './activity-data.mjs';

const stores = new WeakMap(), environments = new WeakMap();
export function configureAssistantActivity(api, environment) {
  environments.set(api, environment);
  stores.get(api)?.setEnvironment(environment);
  return () => {
    // An older plugin's cleanup must not withdraw its replacement's transport.
    if (environments.get(api) !== environment) return;
    environments.delete(api);
    stores.get(api)?.setEnvironment({});
  };
}

export function assistantActivityStore(api) {
  if (!stores.has(api)) stores.set(api, createActivityStore(api, environments.get(api)));
  return stores.get(api);
}

export function useAssistantActivity(api) {
  const store = assistantActivityStore(api);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);

  return { ...snapshot, refresh: store.refresh, refreshTasks: store.refreshTasks };
}
