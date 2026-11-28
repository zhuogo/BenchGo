export const projectPickerActions = ['browse', 'project', 'clone', 'folder'];

export function projectInput(action, args) {
  if (action === 'folder') {
    const { operation, directory, path, name, destination } = args ?? {};
    return { operation, directory, path, name, destination };
  }
  if (action === 'clone') return { url: args?.url };
  return args?.path === undefined ? {} : { path: args.path };
}

/** Each frame handles a request ID once and sends the same result on duplicates. */
export function createProjectReceiver(actions, run, send) {
  const requests = new Map();
  return ({ action, args, requestId }) => {
    if (typeof requestId !== 'string' || requestId.length > 200) return;
    let entry = requests.get(requestId);
    if (!entry) {
      if (requests.size >= 128) {
        const retired = [...requests].find(([, pending]) => pending.done);
        if (retired) requests.delete(retired[0]);
        else {
          send({ type: 'benchgo:project:result', requestId, error: '项目操作繁忙，请稍后重试' });
          return;
        }
      }
      entry = { done: false };
      entry.promise = Promise.resolve().then(() => {
        if (!actions.includes(action)) throw Error('目标不支持此项目操作，请更新 BenchGo');
        return run(action, args);
      }).then(
        value => ({ type: 'benchgo:project:result', requestId, value }),
        reason => ({ type: 'benchgo:project:result', requestId, error: reason.message }),
      ).finally(() => { entry.done = true; });
      requests.set(requestId, entry);
    }
    void entry.promise.then(send);
  };
}
