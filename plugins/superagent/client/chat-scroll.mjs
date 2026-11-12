const NEAR_BOTTOM = 24;
const positions = new Map();

/** Owns one transcript's scrolling. DOM access stays local to its scroll container. */
export function createChatScroll({ scroller, content, sessionKey, onChange, reducedMotion = () => false,
  requestFrame = requestAnimationFrame, cancelFrame = cancelAnimationFrame }) {
  let following = true, unread = false, frame = null, animating = false, disposed = false;
  let anchor = null, previousTop = scroller.scrollTop, initialized = false;
  let latestUser = null, latestReply = null, lastTailKey = null, touchY = null;
  const knownUsers = new Set();
  const floor = () => Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  const emit = () => onChange({ visible: !following && floor() - scroller.scrollTop > NEAR_BOTTOM, unread });
  const elements = () => [...content.querySelectorAll('[data-chat-key]')];
  // Rows stack in document order, so the first one crossing the top edge is a
  // binary search rather than a rectangle read for every message above it.
  function firstVisible(top) {
    const rows = elements();
    let low = 0, high = rows.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (rows[middle].getBoundingClientRect().bottom > top) high = middle; else low = middle + 1;
    }
    return rows[low];
  }
  function capture() {
    const top = scroller.getBoundingClientRect().top;
    const row = firstVisible(top);
    anchor = { key: row?.getAttribute('data-chat-key'), offset: row ? row.getBoundingClientRect().top - top : 0, top: scroller.scrollTop };
  }
  function save() {
    if (!sessionKey) return;
    positions.delete(sessionKey);
    positions.set(sessionKey, { following, anchor });
    if (positions.size > 80) positions.delete(positions.keys().next().value);
  }
  function stopAnimation() {
    if (frame !== null) cancelFrame(frame);
    frame = null; animating = false;
  }
  function restoreAnchor() {
    if (!anchor) return;
    const row = elements().find(element => element.getAttribute('data-chat-key') === anchor.key);
    scroller.scrollTop = row
      ? scroller.scrollTop + row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.offset
      : anchor.top;
    previousTop = scroller.scrollTop;
  }
  function bottom(smooth = false) {
    stopAnimation(); following = true; unread = false;
    if (!smooth || reducedMotion() || Math.abs(floor() - scroller.scrollTop) < 1) {
      scroller.scrollTop = floor(); previousTop = scroller.scrollTop; capture(); emit(); save(); return;
    }
    animating = true;
    const start = scroller.scrollTop;
    let began;
    const tick = time => {
      if (disposed) return;
      began ??= time;
      const progress = Math.min(1, (time - began) / 220);
      scroller.scrollTop = start + (floor() - start) * (1 - (1 - progress) ** 3);
      previousTop = scroller.scrollTop;
      if (progress < 1) frame = requestFrame(tick);
      else { frame = null; animating = false; capture(); emit(); save(); }
    };
    frame = requestFrame(tick); emit();
  }
  function interrupt() {
    stopAnimation(); following = false; capture(); emit(); save();
  }
  function scroll() {
    if (animating) return;
    const top = scroller.scrollTop;
    // Upward intent wins even inside the near-bottom tolerance.
    if (top < previousTop - 1) following = false;
    else if (top > previousTop && floor() - top <= NEAR_BOTTOM) { following = true; unread = false; }
    previousTop = top; capture(); emit(); save();
  }
  function resize() {
    if (!initialized || animating || disposed) return;
    if (following) { scroller.scrollTop = floor(); previousTop = scroller.scrollTop; }
    else restoreAnchor();
    capture(); emit(); save();
  }
  const wheel = event => { if (event.deltaY < 0 || animating) interrupt(); };
  const touchStart = event => { touchY = event.touches[0]?.clientY ?? null; if (animating) interrupt(); };
  const touchMove = event => {
    const y = event.touches[0]?.clientY;
    if (touchY !== null && y > touchY) interrupt();
    touchY = y ?? null;
  };
  const key = event => {
    if (event.target?.closest?.('textarea,input,[contenteditable="true"]')) return;
    if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey) || animating) interrupt();
  };
  const pointer = () => { if (animating) interrupt(); };
  const events = { scroll, wheel, touchstart: touchStart, touchmove: touchMove, keydown: key, pointerdown: pointer };
  for (const [name, handler] of Object.entries(events)) scroller.addEventListener(name, handler, { passive: true });
  return {
    bottom, resize,
    update(rows) {
      const users = rows.filter(row => row.role === 'user');
      const user = users.at(-1);
      const ids = row => [row?.rpcId && `rpc:${row.rpcId}`, Number.isFinite(row?.seq) && `seq:${row.seq}`, row?.key].filter(Boolean);
      const currentUser = ids(user);
      const previousTailIndex = rows.findIndex(row => row.key === lastTailKey);
      const ownInput = initialized && user && rows.indexOf(user) >= previousTailIndex
        && currentUser.every(id => !knownUsers.has(id)) && user.key !== latestUser;
      for (const row of users) for (const id of ids(row)) knownUsers.add(id);
      latestUser = user?.key;
      const reply = rows.findLast(row => row.role === 'assistant');
      const replySignature = reply ? `${reply.key}\0${reply.text || ''}` : null;
      if (!initialized) {
        initialized = true;
        const saved = positions.get(sessionKey);
        if (saved && !saved.following) { following = false; anchor = saved.anchor; restoreAnchor(); capture(); emit(); }
        else bottom();
      } else if (ownInput) bottom(true);
      else {
        if (!following && replySignature !== latestReply && reply && rows.indexOf(reply) >= previousTailIndex) unread = true;
        resize();
      }
      latestReply = replySignature;
      lastTailKey = rows.at(-1)?.key;
    },
    dispose() {
      save(); disposed = true; stopAnimation();
      for (const [name, handler] of Object.entries(events)) scroller.removeEventListener(name, handler);
    },
  };
}
