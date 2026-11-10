import React, { cloneElement, createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { placeTooltip } from '../../../../deepseek-harness/packages/client/ui-primitives/src/tooltip-placement.ts';
import { useFeedbackStyle } from './feedback-style.js';
import css from './tooltip.css';

const Suppression = createContext(null);
const chain = (original, next) => event => { original?.(event); if (!event.defaultPrevented) next(event); };

/** A ref-preserving, viewport-fitted bubble usable without a Harness runtime. */
export function Tooltip({ label, children, side = 'top', align = 'center', delayMs = 450, focusDelayMs = 0, gap = 8, maxWidth = 340, disabled = false, portal = true, onlyWhenClipped = false, openOnClick = false }) {
  useFeedbackStyle('benchgo-tooltip-styles', css);
  const id = useId(), anchor = useRef(null), bubble = useRef(null), timer = useRef(null), focused = useRef(false);
  const parentSuppress = useContext(Suppression);
  const [open, setOpen] = useState(false), [suppressed, setSuppressed] = useState(false), [placement, setPlacement] = useState(null);
  const text = typeof label === 'function' ? label() : label;
  const visible = open && !disabled && !suppressed && !!text;
  const hide = useCallback(() => { clearTimeout(timer.current); timer.current = null; setOpen(false); setPlacement(null); }, []);
  const show = delay => {
    clearTimeout(timer.current);
    if (disabled || !text || !anchor.current) return;
    if (onlyWhenClipped && ![anchor.current, ...anchor.current.querySelectorAll('*')].some(node => node.scrollWidth > node.clientWidth)) return;
    timer.current = setTimeout(() => setOpen(true), delay);
  };
  const childRef = children.props.ref || children.ref;
  const setAnchor = useCallback(node => { anchor.current = node; if (typeof childRef === 'function') childRef(node); else if (childRef) childRef.current = node; }, [childRef]);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => { if (disabled || !text) hide(); }, [disabled, text, hide]);
  useEffect(() => { if (!visible) return; parentSuppress?.(true); return () => parentSuppress?.(false); }, [visible, parentSuppress]);
  useLayoutEffect(() => {
    if (!visible || !anchor.current || !bubble.current) return;
    const update = () => {
      if (!anchor.current?.isConnected) { hide(); return; }
      const measured = bubble.current.getBoundingClientRect();
      setPlacement(placeTooltip({ anchor: anchor.current.getBoundingClientRect(), width: measured.width, height: measured.height, viewportWidth: innerWidth, viewportHeight: innerHeight, side, align, gap }));
    };
    update();
    const observer = new ResizeObserver(update); observer.observe(bubble.current); observer.observe(anchor.current);
    const dismiss = event => { if (event.key === 'Escape' || event.key === 'Tab') hide(); };
    const outside = event => { if (!anchor.current?.contains(event.target) && !bubble.current?.contains(event.target)) hide(); };
    window.addEventListener('resize', update); document.addEventListener('scroll', hide, true); document.addEventListener('keydown', dismiss, true); document.addEventListener('pointerdown', outside, true);
    return () => { observer.disconnect(); window.removeEventListener('resize', update); document.removeEventListener('scroll', hide, true); document.removeEventListener('keydown', dismiss, true); document.removeEventListener('pointerdown', outside, true); };
  }, [visible, text, side, align, gap, maxWidth, hide]);
  const wrapped = !!children.props.disabled;
  const childHandlers = wrapped ? {} : children.props;
  const events = {
    onPointerEnter: chain(childHandlers.onPointerEnter, event => { if (event.pointerType !== 'touch') show(delayMs); }),
    onPointerLeave: chain(childHandlers.onPointerLeave, () => { if (!focused.current) hide(); }),
    onFocus: chain(childHandlers.onFocus, () => { focused.current = true; show(focusDelayMs); }),
    onBlur: chain(childHandlers.onBlur, () => { focused.current = false; hide(); }),
    onPointerDown: chain(childHandlers.onPointerDown, () => { if (!openOnClick) hide(); }),
    onClick: chain(childHandlers.onClick, () => { if (openOnClick) { if (open) hide(); else show(0); } else hide(); }),
  };
  const describedBy = [children.props['aria-describedby'], visible && id].filter(Boolean).join(' ') || undefined;
  const anchorNode = wrapped ? <span className="bg-tooltip-disabled-anchor" ref={node => { anchor.current = node; }} tabIndex={disabled || !text ? undefined : 0} aria-describedby={describedBy} {...events}>{cloneElement(children, { title: undefined })}</span> : cloneElement(children, { ...events, ref: setAnchor, title: undefined, 'aria-describedby': describedBy });
  const popup = visible && <span ref={bubble} role="tooltip" id={id} className="bg-tooltip" data-side={placement?.side || side} style={{ maxWidth: `min(${maxWidth}px, calc(100vw - 24px))`, ...(placement ? { left: placement.left, top: placement.top } : { visibility: 'hidden', left: 0, top: 0 }) }}>{text}</span>;
  return <Suppression.Provider value={setSuppressed}>{anchorNode}{popup && (portal ? createPortal(popup, document.body) : popup)}</Suppression.Provider>;
}
