import { useLayoutEffect, useRef, useState } from 'react';
import { createChatScroll } from './chat-scroll.mjs';

export function useChatScroll(rows, sessionKey) {
  const root = useRef(null), controller = useRef(null);
  const [host, setHost] = useState(null);
  const [state, setState] = useState({ visible: false, unread: false });
  useLayoutEffect(() => {
    const content = root.current;
    const scroller = content?.closest('[data-assistant-scroll]');
    if (!scroller) return;
    setHost(scroller.parentElement);
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const owner = createChatScroll({ scroller, content, sessionKey,
      reducedMotion: () => motion.matches,
      onChange: next => setState(previous => previous.visible === next.visible && previous.unread === next.unread ? previous : next),
    });
    controller.current = owner;
    const observer = new ResizeObserver(owner.resize);
    observer.observe(content); observer.observe(scroller);
    return () => { observer.disconnect(); owner.dispose(); controller.current = null; };
  }, [sessionKey]);
  useLayoutEffect(() => { controller.current?.update(rows); });
  return { root, host, ...state, returnToBottom: event => {
    root.current?.closest('[data-assistant-scroll]')?.focus({ preventScroll: true });
    controller.current?.bottom(event?.detail > 0);
  } };
}
