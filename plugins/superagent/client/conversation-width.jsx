import { useLayoutEffect } from 'react';

const WIDTH_PREFERENCE = 'dsh.conversation.contentWidth';

/** Publish the resolved native content axis, only when its visible width changes. */
export function ConversationWidth({ container }) {
  useLayoutEffect(() => {
    if (!container) return;
    const property = '--dsh-chat-content-width';
    const previous = container.style.getPropertyValue(property), priority = container.style.getPropertyPriority(property);
    let preference, published;
    const readPreference = () => {
      let raw = null;
      try { raw = localStorage.getItem(WIDTH_PREFERENCE); } catch { /* Default native axis works without storage. */ }
      const value = raw === null ? NaN : Number(raw);
      preference = Number.isFinite(value) && value > 0 ? value : null;
    };
    const publish = width => {
      // The host's adaptive axis clamps to 680–920px. Changing its inherited raw
      // column width inside a clamped interval still invalidates every message.
      const resolved = preference === null ? Math.max(680, Math.min(width * .64, 920))
        : Math.min(Math.max(preference, 640), Math.max(640, width - 176));
      if (resolved === published) return;
      published = resolved;
      container.style.setProperty(property, `${resolved}px`);
    };
    const storage = event => {
      if (event.key !== null && event.key !== WIDTH_PREFERENCE) return;
      readPreference(); publish(container.offsetWidth);
    };
    // Same-window native controls persist without a storage event; preserve the
    // previous adapter's resize-time refresh for those preference changes.
    const observer = new ResizeObserver(() => { readPreference(); publish(container.offsetWidth); });
    readPreference(); publish(container.offsetWidth); observer.observe(container);
    window.addEventListener('storage', storage);
    return () => {
      observer.disconnect(); window.removeEventListener('storage', storage);
      if (previous) container.style.setProperty(property, previous, priority);
      else container.style.removeProperty(property);
    };
  }, [container]);
  return null;
}
