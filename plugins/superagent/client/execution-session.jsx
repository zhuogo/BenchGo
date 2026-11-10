import React, { useEffect, useSyncExternalStore } from 'react';
export { openExecutionSession } from './execution-session-navigation.mjs';

/** Both sidebar views share this projection and component, never another list. */
export function registerExecutionSessionRows(ctx, loadSessions) {
  let state = { phase: 'loading', entries: [] }, controller, interval, pending;
  const listeners = new Set();
  const refresh = () => {
    if (pending || !listeners.size || document.hidden) return;
    controller = new AbortController();
    pending = Promise.resolve(loadSessions(controller.signal)).then(entries => {
      if (!controller.signal.aborted) state = { phase: 'ready', entries };
    }, () => { if (!controller.signal.aborted) state = { ...state, phase: 'error' }; }).finally(() => {
      pending = null;
      for (const listener of listeners) listener();
    });
  };
  const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };
  function TicketMark({ sessionId }) {
    const value = useSyncExternalStore(subscribe, () => state);
    useEffect(() => {
      refresh();
    }, []);
    const entry = value.entries.find(item => item.sessionId === sessionId);
    if (!entry) return null;
    return <span aria-label={`工单：${entry.title}`} title={`工单：${entry.title}`}>工单</span>;
  }
  interval = setInterval(refresh, 10000);
  ctx.effect(() => () => { clearInterval(interval); controller?.abort(); listeners.clear(); });
  const dispose = ['sidebar.session.row.trailing', 'benchgo.sidebar.session.row.trailing'].map(name => ctx.slots.inject(name, () => ctx.slots.register({
    name, id: 'benchgo-execution-ticket', order: 100,
  }, TicketMark)));
  return () => { for (const cleanup of dispose) cleanup(); };
}
