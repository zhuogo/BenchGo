import { AgentFeed } from '../../voice/client/agent-feed.mjs';
import { retainAssistantSession } from './session-retain.mjs';
import { notificationKeys, notificationSound } from './notification-sound.mjs';

/** Reply identities arrive over the existing fact stream; older Hosts retain the legacy public feed. */
export function mountReplySound(ctx, api, sound = notificationSound) {
  ctx.effect(() => {
    const controller = new AbortController(), retained = new Map();
    let reading = false, pending = false, publicChatNotifications, catalogIds;
    const release = entry => { entry.disposed = true; entry.unsubscribe?.(); entry.reference?.release(); };
    const attach = async (sessionId, threadId) => {
      if (retained.has(sessionId)) return;
      const entry = {}; retained.set(sessionId, entry);
      try {
        entry.reference = await retainAssistantSession(ctx.sessions, sessionId, controller.signal);
        if (entry.disposed || controller.signal.aborted) { entry.reference.release(); return; }
        const binding = await entry.reference.ready;
        if (entry.disposed || controller.signal.aborted) return;
        const source = binding.eventSource;
        const feed = new AgentFeed({ publicOnly: true, onPublication: (_text, event) => sound.notify(notificationKeys(event.data, threadId)) });
        feed.baseline(source.getSnapshot());
        entry.unsubscribe = source.subscribe(() => feed.accept(source.getSnapshot()));
      } catch { release(entry); if (retained.get(sessionId) === entry) retained.delete(sessionId); }
    };
    const refresh = async () => {
      if (controller.signal.aborted) return;
      if (publicChatNotifications !== false || !sound.getSnapshot().enabled) {
        for (const entry of retained.values()) release(entry);
        retained.clear(); return;
      }
      if (reading) { pending = true; return; }
      reading = true;
      try {
        const { state } = await api('state', {}, controller.signal);
        if (controller.signal.aborted || publicChatNotifications !== false || !sound.getSnapshot().enabled) return;
        const sessions = new Map((state?.threads || []).filter(row => row.sessionId && !row.archived).map(row => [row.sessionId, row.id]));
        if (state?.mainSessionId) sessions.set(state.mainSessionId, 'main');
        for (const [id, entry] of retained) if (!sessions.has(id)) { release(entry); retained.delete(id); }
        for (const [id, threadId] of sessions) void attach(id, threadId);
      } catch { /* Existing UI owns transport error reporting; snapshots never become sounds. */ }
      finally { reading = false; if (pending) { pending = false; void refresh(); } }
    };
    const gesture = event => { if (event.isTrusted && !event.target?.closest?.('[data-notification-sound-settings]') && sound.getSnapshot().enabled && sound.getSnapshot().state !== 'ready') void sound.unlock(); };
    const source = event => {
      publicChatNotifications = event.detail?.publicChatNotifications === true;
      if (!publicChatNotifications) catalogIds = JSON.stringify(ctx.sessions.list.getSnapshot().ids);
      void refresh();
    };
    document.addEventListener('pointerdown', gesture); document.addEventListener('keydown', gesture);
    document.addEventListener('benchgo:assistant-notification-source', source);
    document.addEventListener('benchgo:assistant-changed', refresh);
    const unsubscribe = ctx.sessions.list.subscribe(() => {
      if (publicChatNotifications !== false) return;
      const ids = JSON.stringify(ctx.sessions.list.getSnapshot().ids);
      if (ids !== catalogIds) { catalogIds = ids; void refresh(); }
    });
    let enabled = sound.getSnapshot().enabled;
    const unsubscribeSound = sound.subscribe?.(() => {
      const next = sound.getSnapshot().enabled;
      if (next !== enabled) { enabled = next; void refresh(); }
    });
    void refresh();
    return () => {
      controller.abort(); unsubscribe(); unsubscribeSound?.();
      document.removeEventListener('pointerdown', gesture); document.removeEventListener('keydown', gesture);
      document.removeEventListener('benchgo:assistant-notification-source', source);
      document.removeEventListener('benchgo:assistant-changed', refresh);
      for (const entry of retained.values()) release(entry); retained.clear(); sound.dispose();
    };
  });
}
