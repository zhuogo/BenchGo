import React, { useEffect, useRef, useState } from 'react';
import { Menu, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives';
import { CallStageIcon } from './call-stage.jsx';

const HOLD_MS = 550, MOVE_LIMIT = 10;

/** The shared menu owns placement, pointer grace, dismissal and keyboard navigation. */
export function CallEntry({ available, disabled, hint, onStart, onHistory, children }) {
  const [open, setOpen] = useState(false), [holding, setHolding] = useState(false);
  const button = useRef(null), gesture = useRef(null), suppressClick = useRef(false), quietFocusUntil = useRef(0);
  const latest = useRef(null); latest.current = { disabled, onStart };
  const cancel = (suppress = true) => {
    if (!gesture.current) return;
    clearTimeout(gesture.current.timer); gesture.current = null;
    if (suppress) suppressClick.current = true;
    setHolding(false);
  };
  useEffect(() => {
    const move = event => {
      const current = gesture.current;
      if (current?.id === event.pointerId && Math.hypot(event.clientX - current.x, event.clientY - current.y) > MOVE_LIMIT) cancel();
    };
    const secondPointer = event => { if (gesture.current && event.pointerId !== gesture.current.id) cancel(); };
    const release = event => {
      const current = gesture.current;
      if (current?.id !== event.pointerId) return;
      const activate = event.type === 'pointerup' && !current.activated && !suppressClick.current && !latest.current.disabled;
      cancel();
      if (activate) {
        event.preventDefault(); quietFocusUntil.current = performance.now() + 100; setOpen(false);
        latest.current.onStart({ currentTarget: button.current });
      }
    };
    const abandon = () => cancel();
    const keyboard = () => { quietFocusUntil.current = 0; };
    document.addEventListener('pointerdown', secondPointer, true);
    document.addEventListener('pointermove', move, true);
    document.addEventListener('pointerup', release, true);
    document.addEventListener('pointercancel', release, true);
    document.addEventListener('visibilitychange', abandon);
    document.addEventListener('keydown', keyboard, true);
    window.addEventListener('blur', abandon);
    return () => {
      clearTimeout(gesture.current?.timer); gesture.current = null;
      document.removeEventListener('pointerdown', secondPointer, true);
      document.removeEventListener('pointermove', move, true);
      document.removeEventListener('pointerup', release, true);
      document.removeEventListener('pointercancel', release, true);
      document.removeEventListener('visibilitychange', abandon);
      document.removeEventListener('keydown', keyboard, true);
      window.removeEventListener('blur', abandon);
    };
  }, []);
  const close = () => { quietFocusUntil.current = performance.now() + 100; setOpen(false); };
  const press = event => {
    if (event.pointerType !== 'touch' && event.pointerType !== 'pen') { suppressClick.current = false; return; }
    if (!event.isPrimary || gesture.current) { cancel(); suppressClick.current = true; return; }
    suppressClick.current = false; setOpen(false); setHolding(true);
    const current = { id: event.pointerId, x: event.clientX, y: event.clientY, activated: false };
    current.timer = setTimeout(() => {
      if (gesture.current !== current) return;
      current.activated = true; suppressClick.current = true; setHolding(false); setOpen(true);
    }, HOLD_MS);
    gesture.current = current;
  };
  return <Menu open={open} onClose={close} side="top" align="end" portal compact dense closeOnPointerLeave
    className="voice-call-entry" listClassName="voice-call-entry-menu" items={[{ id: 'history', label: '语音记录', icon: <CallStageIcon name="records" /> }]}
    onSelect={() => { close(); onHistory(); }} anchor={<Tooltip label={hint} disabled={open || holding} side="top" portal delayMs={450}><button ref={button} type="button"
      className={'voice-icon-button voice-call-button' + (holding ? ' is-holding' : '')} data-available={available} aria-label="开始语音通话"
      aria-disabled={disabled} aria-haspopup="menu" aria-expanded={open} onPointerDown={press}
      onPointerEnter={event => { if (event.pointerType === 'mouse') setOpen(true); }} onPointerLeave={event => { if (event.pointerType !== 'mouse') cancel(); }}
      onFocus={event => { if (performance.now() >= quietFocusUntil.current && event.currentTarget.matches(':focus-visible')) setOpen(true); }}
      onKeyDown={event => { if (!open && ['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); setOpen(true); } }}
      onContextMenu={event => { if (gesture.current || suppressClick.current) event.preventDefault(); }}
      onClick={event => {
        if (['touch', 'pen'].includes(event.nativeEvent.pointerType) || suppressClick.current && event.detail !== 0) { event.preventDefault(); event.stopPropagation(); return; }
        if (disabled) { event.preventDefault(); return; }
        close(); onStart(event);
      }}>{children}<svg className="voice-call-hold-ring" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="17" pathLength="1" /></svg></button></Tooltip>} />;
}
