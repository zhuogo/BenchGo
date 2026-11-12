/** Presentation intent outlives any one conversation view; media stays in controller. */
export function createCallPresentation(controller, { title = () => '语音对话', subscribeTitle, openSession } = {}) {
  let snapshot = { sessionId: null, title: '', expanded: false, historyOnly: false, pending: false, error: '', origin: null, position: null };
  let revision = 0, disposed = false;
  const listeners = new Set();
  const patch = next => { if (disposed) return; snapshot = { ...snapshot, ...next }; for (const listener of listeners) listener(); };
  const clear = () => patch({ sessionId: null, expanded: false, historyOnly: false, pending: false, error: '' });
  const stopTitle = subscribeTitle?.(() => {
    if (!snapshot.sessionId) return;
    const currentTitle = title(snapshot.sessionId) || '语音对话';
    if (currentTitle !== snapshot.title) patch({ title: currentTitle });
  });
  const stop = controller.state.subscribe(() => {
    const state = controller.state.getSnapshot();
    if (snapshot.pending || snapshot.sessionId !== state.sessionId || snapshot.historyOnly || state.mode === 'call') return;
    if (state.error) patch({ error: state.error });
    else if (!snapshot.pending && !snapshot.error) clear();
  });
  const api = {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    move(position) {
      if (position && (!Number.isFinite(position.x) || !Number.isFinite(position.y))) return;
      const next = position ? { x: position.x, y: position.y } : null;
      if (snapshot.position?.x === next?.x && snapshot.position?.y === next?.y) return;
      patch({ position: next });
    },
    async start({ sessionId, inputActions, origin } = {}) {
      const state = controller.state.getSnapshot();
      if (snapshot.pending || state.mode === 'call') { api.expand(); return; }
      const current = ++revision;
      patch({ sessionId, title: title(sessionId) || '语音对话', expanded: true, historyOnly: false, pending: true, error: '', origin });
      try { await controller.startCall({ sessionId, inputActions }); }
      catch (error) { if (current === revision) patch({ error: error.message || '通话连接失败' }); }
      finally { if (current === revision) patch({ pending: false }); }
    },
    expand() {
      const state = controller.state.getSnapshot();
      const sessionId = state.mode === 'call' ? state.sessionId : snapshot.sessionId;
      patch({ sessionId, title: title(sessionId) || snapshot.title || '语音对话', expanded: true, historyOnly: false });
    },
    minimize() { if (snapshot.historyOnly) clear(); else patch({ expanded: false }); },
    leave(sessionId) { if (snapshot.sessionId === sessionId) api.minimize(); },
    history(sessionId) {
      if (snapshot.pending || controller.state.getSnapshot().mode === 'call') { api.expand(); return; }
      patch({ sessionId, title: title(sessionId) || '语音对话', historyOnly: true, expanded: true, error: '', pending: false, origin: null });
    },
    async hangup() { ++revision; clear(); await controller.hangup(); },
    retry() { return api.start({ sessionId: snapshot.sessionId, origin: null }); },
    async returnToSession() {
      api.minimize();
      try { if (!openSession) throw Error('请从侧栏返回原会话处理确认'); await openSession(snapshot.sessionId); }
      catch (error) { patch({ error: error.message || '暂时无法返回原会话' }); }
    },
    dispose() { disposed = true; ++revision; stop(); stopTitle?.(); listeners.clear(); },
  };
  return api;
}
