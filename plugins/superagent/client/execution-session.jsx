import React, { useEffect, useSyncExternalStore } from 'react';
import { Tooltip } from '../../shared/client/ui/tooltip.jsx';
export { openExecutionSession } from './execution-session-navigation.mjs';

/** Uses the official row extension and navigation service, not another list. */
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
    return <Tooltip label={`工单：${entry.title}`}><span aria-label={`工单：${entry.title}`} tabIndex={0}>工单</span></Tooltip>;
  }
  interval = setInterval(refresh, 10000);
  ctx.effect(() => () => { clearInterval(interval); controller?.abort(); listeners.clear(); });
  return ctx.slots.inject('sidebar.session.row.trailing', () => ctx.slots.register({
    name: 'sidebar.session.row.trailing', id: 'benchgo-execution-ticket', order: 100,
  }, TicketMark));
}
