export const calls = [];
export let initializationError;
export function reset(error) { calls.length = 0; initializationError = error; }
export const getSessionInfo = async id => ({ sessionId: id });
export function query({ options }) {
  let stopped = false, wake;
  const call = { options, permissionChanges: [] };
  calls.push(call);
  return {
    async initializationResult() { if (initializationError) throw initializationError; return {}; },
    async setPermissionMode(mode) { call.permissionChanges.push(mode); },
    async setModel() {},
    async supportedCommands() { return []; },
    close() { stopped = true; wake?.(); },
    async *[Symbol.asyncIterator]() { while (!stopped) await new Promise(resolve => { wake = resolve; }); },
  };
}
