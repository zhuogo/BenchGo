import { ModelsSettingsStore } from '../../../deepseek-harness/packages/client/ui-settings-models/src/client/store.ts';

/** Keep the official controller, subscriptions, revisions and store identity. */
export function adaptProviderStore(controller) {
  if (typeof controller?.read !== 'function' || typeof controller?.load !== 'function'
    || !controller.ctx || !controller.schema || !controller.describeFace || !controller.store
    || typeof ModelsSettingsStore.prototype.refreshAccount !== 'function') {
    throw Error('Official Models controller shape changed');
  }
  const keys = ['read', 'refreshAccount', 'accountAvailable', 'accountGeneration', 'accountLoad', 'accountRow', 'accountScope'];
  const originals = Object.fromEntries(keys.map(key => [key, Object.getOwnPropertyDescriptor(controller, key)]));
  const scope = {};
  controller.accountScope = scope;
  controller.accountAvailable = controller.store.getSnapshot().rows.some(row => row.entry.provider === 'deepseek-account' && row.accountAvailable === true);
  controller.accountGeneration = controller.generation;
  controller.accountLoad = undefined;
  controller.accountRow = undefined;
  controller.read = ModelsSettingsStore.prototype.read;
  controller.refreshAccount = ModelsSettingsStore.prototype.refreshAccount;
  let disposed = false;
  return () => {
    if (disposed || controller.accountScope !== scope) return;
    disposed = true;
    for (const key of keys) {
      if (originals[key]) Object.defineProperty(controller, key, originals[key]);
      else delete controller[key];
    }
  };
}
