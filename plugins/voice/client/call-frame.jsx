import React, { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import css from './call-frame.css';

const EMPTY = Object.freeze([]), absent = () => EMPTY, noSubscribe = () => () => {};

/** Only portal seats are registered here; conversation data stays in CallStage. */
export function createCallFrameRegistry() {
  let entries = EMPTY;
  const listeners = new Set();
  const publish = () => { entries = [...entries]; for (const listener of listeners) listener(); };
  return {
    getSnapshot: () => entries,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    register(host) { entries = [...entries, host]; publish(); return () => { entries = entries.filter(entry => entry !== host); publish(); }; },
    refresh: publish,
  };
}

export function useCallFrame(registry, sessionId, activityRef) {
  const entries = useSyncExternalStore(registry?.subscribe ?? noSubscribe, registry?.getSnapshot ?? absent);
  const matches = entries.filter(host => host.sessionId() === sessionId && host.visible());
  return matches.find(host => host.content.contains(activityRef.current)) ?? matches[0] ?? null;
}

export function useCallFrameActive(host, active) {
  useLayoutEffect(() => active && host ? host.activate() : undefined, [host, active]);
}

/** Public hero.frame wraps both the official and BenchGo resident conversation body. */
export function CallFrame({ registry, children }) {
  const frame = useRef(null), content = useRef(null), target = useRef(null);
  const [active, setActive] = useState(false);
  useLayoutEffect(() => {
    if (active && (document.activeElement === document.body || content.current?.contains(document.activeElement))) {
      target.current?.querySelector('button:not(:disabled),a[href],[tabindex="0"]')?.focus({ preventScroll: true });
    }
  }, [active]);
  useLayoutEffect(() => {
    const node = frame.current, original = content.current, element = target.current;
    // This is the official content contract, not a CSS-module class or a tree rewrite.
    const owner = node.closest('[data-conversation-session]');
    if (!owner) return;
    let claims = 0, previousFocus;
    const host = { element, content: original,
      sessionId: () => owner.dataset.conversationSession,
      visible: () => node.isConnected && node.getClientRects().length > 0
        && (node.checkVisibility ? node.checkVisibility({ checkVisibilityCSS: true }) : getComputedStyle(node).visibility !== 'hidden'),
      activate() {
        if (!claims++) { previousFocus = original.contains(document.activeElement) ? document.activeElement : null; setActive(true); }
        let released = false;
        return () => {
          if (released) return; released = true;
          if (--claims > 0) return;
          setActive(false);
          // Let the portal's full-screen focus win when this is an expansion.
          if (document.activeElement === document.body || element.contains(document.activeElement)) {
            queueMicrotask(() => { if (claims || !original.isConnected || !(document.activeElement === document.body || element.contains(document.activeElement))) return; (previousFocus?.isConnected ? previousFocus : original.querySelector('button:not(:disabled),[tabindex="0"]'))?.focus({ preventScroll: true }); });
          }
        };
      },
    };
    const unregister = registry.register(host);
    const observer = new ResizeObserver(() => registry.refresh()); observer.observe(node);
    const attributes = new MutationObserver(() => registry.refresh()); attributes.observe(owner, { attributes: true, attributeFilter: ['data-conversation-session', 'hidden', 'style', 'class'] });
    return () => { observer.disconnect(); attributes.disconnect(); unregister(); };
  }, [registry]);
  return <div ref={frame} className={'voice-call-frame' + (active ? ' is-active' : '')}><style>{css}</style><div ref={content} className="voice-call-frame-content" inert={active ? '' : undefined} aria-hidden={active || undefined}>{children}</div><div ref={target} className="voice-call-frame-target" /></div>;
}

export function registerCallFrame(ctx, registry) {
  ctx.slots.inject('conversation.hero.frame', () => ctx.slots.register({ name: 'conversation.hero.frame', id: 'benchgo-voice-call', inject: () => ({ registry }) }, CallFrame));
}
