export const notificationSoundStorageKey = 'benchgo.assistant.notificationSound';

/** Local device preference; browser permission is always reported separately. */
export function createNotificationSound(environment = globalThis) {
  const listeners = new Set();
  let enabled = true, context, disposed = false, unlocking = false, lastPlayed = -Infinity;
  const nodes = new Set(), seen = new Set();
  try { enabled = environment.localStorage?.getItem(notificationSoundStorageKey) !== 'false'; } catch {}
  let snapshot = { enabled, state: 'locked', error: '' };
  const publish = patch => { snapshot = { ...snapshot, ...patch }; for (const listener of listeners) listener(); };
  const stateChanged = () => { if (snapshot.state === 'ready' && context?.state !== 'running') publish({ state: 'locked' }); };
  const remember = keys => {
    const duplicate = keys.some(key => seen.has(key));
    for (const key of keys) seen.add(key);
    while (seen.size > 4096) seen.delete(seen.values().next().value);
    return !duplicate;
  };
  const stop = () => { for (const node of nodes) { try { node.stop(); } catch {} } nodes.clear(); };
  const tone = () => {
    if (disposed || !snapshot.enabled || context?.state !== 'running') return false;
    try {
      const oscillator = context.createOscillator(), gain = context.createGain(), start = context.currentTime;
      oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(740, start);
      oscillator.frequency.setValueAtTime(988, start + .09);
      gain.gain.setValueAtTime(0, start); gain.gain.linearRampToValueAtTime(.065, start + .012);
      gain.gain.exponentialRampToValueAtTime(.001, start + .23);
      oscillator.connect(gain); gain.connect(context.destination); nodes.add(oscillator);
      oscillator.onended = () => { nodes.delete(oscillator); oscillator.disconnect(); gain.disconnect(); };
      oscillator.start(start); oscillator.stop(start + .24); return true;
    } catch (cause) { publish({ state: 'error', error: cause.message || '声音播放失败，请重试' }); return false; }
  };
  async function unlock(preview = false) {
    if (disposed || !snapshot.enabled || unlocking) return false;
    unlocking = true;
    try {
      const Audio = environment.AudioContext || environment.webkitAudioContext;
      if (!Audio) throw new Error('当前浏览器不支持提示音');
      if (!context || context.state === 'closed') { context = new Audio(); context.addEventListener('statechange', stateChanged); }
      publish({ state: 'unlocking', error: '' });
      // Called directly from trusted user gestures. Never queue a missed notification.
      let timer;
      await Promise.race([context.resume(), new Promise((_, reject) => { timer = environment.setTimeout(() => reject(new Error('浏览器尚未允许播放，请点击试听重试')), 1500); })]).finally(() => environment.clearTimeout(timer));
      if (disposed) return false;
      if (context.state !== 'running') throw new Error('浏览器尚未允许播放，请点击试听重试');
      publish({ state: 'ready', error: '' });
      return preview ? tone() : true;
    } catch (cause) { if (!disposed) publish({ state: 'error', error: cause.message || '声音不可用，请重试' }); return false; }
    finally { unlocking = false; }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    unlock,
    setEnabled(value) {
      publish({ enabled: !!value }); if (!value) stop();
      try { environment.localStorage?.setItem(notificationSoundStorageKey, String(!!value)); } catch { publish({ error: '浏览器未允许保存偏好，本次设置仅在当前页面有效' }); }
    },
    notify(keys) {
      if (!keys.length || !remember(keys)) return false;
      const now = environment.performance?.now() ?? Date.now();
      if (now - lastPlayed < 400) return false;
      if (!tone()) return false;
      lastPlayed = now; return true;
    },
    dispose() { disposed = true; stop(); context?.removeEventListener('statechange', stateChanged); void context?.close().catch(() => {}); listeners.clear(); },
  };
}

export const notificationSound = createNotificationSound();

export function notificationKeys(data = {}, scope = '') {
  return [data.eventId && `event:${data.eventId}`, data.ticketReplyEventKey && `ticket-event:${data.ticketReplyEventKey}`,
    data.ticketStateEventKey && `ticket-event:${data.ticketStateEventKey}`, data.sourceEventId && `ticket-event:${data.sourceEventId}`,
    data.requestId && `request:${scope}:${data.requestId}`, data.mirrorKey && `channel:${data.mirrorKey}`].filter(Boolean);
}

/** A fresh snapshot is a silent cut, including every reconnect. */
export function createNotificationFactGate(sound = notificationSound) {
  let cursor = null;
  return {
    replace(snapshot) { cursor = snapshot.cursor; },
    disconnect() { cursor = null; },
    update(frame) {
      if (cursor === null) return;
      const entries = (frame.entries || []).filter(entry => entry.seq > cursor);
      let next = cursor;
      for (const entry of entries) if (entry.seq !== ++next) { cursor = null; return; }
      if (frame.cursor > next) { cursor = null; return; }
      cursor = next;
      for (const entry of entries) {
        if (entry.kind === 'chat' && entry.data?.operation === 'insert') sound.notify(notificationKeys(entry.data, entry.data.threadId || 'main'));
      }
    },
  };
}
