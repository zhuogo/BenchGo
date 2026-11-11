/** Browser media promises do not accept AbortSignal; detach safely on cancellation. */
export function waitForMedia(operation, signal, disposeLate) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true; signal.removeEventListener('abort', abort); callback(value);
    };
    const abort = () => finish(reject, signal.reason);
    Promise.resolve(operation).then(value => {
      if (settled) { if (signal.aborted) { try { disposeLate?.(value); } catch {} } return; }
      finish(resolve, value);
    }, error => finish(reject, error));
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
}
