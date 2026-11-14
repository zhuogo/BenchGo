import { workbenchUrl } from './device-state.mjs';
import { deviceRequest } from './resource-state.mjs';

const actions = ['browse', 'project', 'clone'];
let bridgeSequence = 0;

/** Project forms remain in the owner; requests run inside the authorized device frame. */
export function createProjectBridge({ deviceId, onEntry, getFrame, window = globalThis.window, origin = globalThis.location.origin, request = deviceRequest, timeout = 15_000 }) {
  const prefix = `project-${++bridgeSequence}`;
  const pending = new Map();
  const schedule = (callback, delay) => (window.setTimeout || globalThis.setTimeout).call(window, callback, delay);
  const cancel = timer => (window.clearTimeout || globalThis.clearTimeout).call(window, timer);
  let disposed = false, ready = false, remoteOrigin = '', connecting = null, generation = 0, sequence = 0;
  const closed = () => Error('项目窗口已关闭');
  const failConnection = (connection, error) => {
    if (connecting !== connection) return;
    connecting = null; ready = false; remoteOrigin = '';
    cancel(connection.timer); connection.controller.abort();
    if (!disposed) onEntry('');
    connection.reject(error);
  };
  const probe = () => {
    if (disposed || !remoteOrigin) return;
    getFrame()?.contentWindow?.postMessage({ type: 'benchgo:resource:probe' }, remoteOrigin);
  };
  const connect = () => {
    if (disposed) return Promise.reject(closed());
    if (ready) return Promise.resolve();
    if (connecting) return connecting.promise;
    const connection = { controller: new AbortController(), generation: ++generation };
    connection.promise = new Promise((resolve, reject) => { connection.resolve = resolve; connection.reject = reject; });
    connecting = connection;
    connection.timer = schedule(() => failConnection(connection, Error('目标设备连接超时，请重试或检查设备连接')), timeout);
    Promise.resolve().then(() => request('select', { deviceId }, connection.controller.signal)).then(value => {
      if (disposed || connecting !== connection || connection.generation !== generation) return;
      if (typeof value?.url !== 'string' || !value.url) throw Error('目标设备未返回工作台地址');
      const url = new URL(workbenchUrl(value.url, origin));
      url.hash = new URLSearchParams({ resourceParentOrigin: origin }).toString();
      remoteOrigin = url.origin;
      onEntry(url.href);
      probe();
    }).catch(error => failConnection(connection, error));
    return connection.promise;
  };
  const receive = event => {
    if (disposed || !remoteOrigin || event.source !== getFrame()?.contentWindow || event.origin !== remoteOrigin) return;
    if (event.data?.type === 'benchgo:resource:ready') {
      if (!connecting) return;
      if (!Array.isArray(event.data.projectActions) || !actions.every(action => event.data.projectActions.includes(action))) {
        failConnection(connecting, Error('目标设备尚不支持同窗添加项目，请升级该设备的 BenchGo 后重试'));
        return;
      }
      const connection = connecting;
      connecting = null; ready = true; cancel(connection.timer); connection.resolve();
      return;
    }
    if (event.data?.type !== 'benchgo:project:result') return;
    const item = pending.get(event.data.requestId);
    if (!item) return;
    pending.delete(event.data.requestId); cancel(item.timer);
    if (event.data.error) item.reject(Error(typeof event.data.error === 'string' ? event.data.error : event.data.error.message || '目标设备项目操作失败'));
    else item.resolve(event.data.value);
  };
  window.addEventListener('message', receive);
  return {
    async api(action, args = {}) {
      if (!actions.includes(action)) throw Error('不支持的项目操作');
      await connect();
      if (disposed) throw closed();
      const requestId = `${prefix}-${++sequence}`;
      return new Promise((resolve, reject) => {
        const timer = schedule(() => { pending.delete(requestId); reject(Error(action === 'clone' ? '目标设备克隆超时，请检查目标项目后重试' : '目标设备项目操作超时，请重试')); }, action === 'clone' ? 5 * 60_000 + timeout : timeout);
        pending.set(requestId, { resolve, reject, timer });
        try {
          const target = getFrame()?.contentWindow;
          if (!target) throw Error('目标设备工作台已关闭，请重试');
          target.postMessage({ type: 'benchgo:project:call', action, args, requestId }, remoteOrigin);
        } catch (error) { pending.delete(requestId); cancel(timer); reject(error); }
      });
    },
    probe,
    dispose() {
      if (disposed) return;
      disposed = true; generation++; ready = false; remoteOrigin = '';
      window.removeEventListener('message', receive);
      if (connecting) failConnection(connecting, closed());
      for (const item of pending.values()) { cancel(item.timer); item.reject(closed()); }
      pending.clear();
    },
  };
}
