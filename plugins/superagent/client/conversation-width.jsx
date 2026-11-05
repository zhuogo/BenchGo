import { useEffect } from 'react';

/** Supply the native main-layout CSS axis without importing private host modules. */
export function ConversationWidth({ container }) {
  useEffect(() => {
    if (!container) return;
    const target = container.parentElement || container;
    const publish = () => {
      const width = container.offsetWidth;
      target.style.setProperty('--dsh-conversation-column-width', `${width}px`);
      let preference = null;
      try { preference = localStorage.getItem('dsh.conversation.contentWidth'); } catch { /* Default native axis works without storage. */ }
      const value = preference === null ? NaN : Number(preference);
      if (Number.isFinite(value) && value > 0) target.style.setProperty('--dsh-chat-user-width', `${Math.min(Math.max(value, 640), Math.max(640, width - 176))}px`);
      else target.style.removeProperty('--dsh-chat-user-width');
    };
    const observer = new ResizeObserver(publish);
    observer.observe(container); publish();
    window.addEventListener('storage', publish);
    return () => { observer.disconnect(); window.removeEventListener('storage', publish); target.style.removeProperty('--dsh-conversation-column-width'); target.style.removeProperty('--dsh-chat-user-width'); };
  }, [container]);
  return null;
}
