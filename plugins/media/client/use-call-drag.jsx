import { useLayoutEffect, useRef } from 'react';

const distance = 6;
function bounds(node) {
  const viewport = window.visualViewport, style = getComputedStyle(node), rect = node.getBoundingClientRect();
  const inset = side => Math.max(12, parseFloat(style.getPropertyValue('--voice-safe-' + side)) || 0);
  const titlebar = document.documentElement.hasAttribute('data-windows-titlebar') ? (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dsh-windows-titlebar-height')) || 36) + 8 : 0;
  const x = viewport?.offsetLeft || 0, y = viewport?.offsetTop || 0;
  const left = x + inset('left'), top = y + Math.max(inset('top'), titlebar);
  return { left, top, right: Math.max(left, x + (viewport?.width || innerWidth) - rect.width - inset('right')), bottom: Math.max(top, y + (viewport?.height || innerHeight) - rect.height - inset('bottom')) };
}
const clamp = (point, box) => ({ x: Math.min(box.right, Math.max(box.left, point.x)), y: Math.min(box.bottom, Math.max(box.top, point.y)) });
const draw = (node, point) => {
  if (!node) return;
  if (point) { node.style.left = point.x + 'px'; node.style.top = point.y + 'px'; node.style.right = 'auto'; node.style.bottom = 'auto'; }
  else for (const name of ['left', 'top', 'right', 'bottom']) node.style.removeProperty(name);
};

/** Move only the presentation; commit once per gesture, never rebuild the audio graph. */
export function useCallDrag({ dock, position, onMove, enabled }) {
  const gesture = useRef(null), suppressClick = useRef(false);
  const cancel = () => {
    const current = gesture.current;
    if (!current) return;
    gesture.current = null; suppressClick.current = true;
    current.node.removeAttribute('data-dragging'); draw(current.node, position);
    if (current.handle.hasPointerCapture?.(current.id)) current.handle.releasePointerCapture(current.id);
  };
  useLayoutEffect(() => {
    const node = dock.current;
    if (!enabled || !node) return;
    const fit = () => { cancel(); if (position) onMove(clamp(position, bounds(node))); };
    fit();
    const resize = new ResizeObserver(fit); resize.observe(node);
    window.addEventListener('resize', fit);
    window.visualViewport?.addEventListener('resize', fit);
    window.visualViewport?.addEventListener('scroll', fit);
    return () => {
      cancel(); resize.disconnect(); window.removeEventListener('resize', fit);
      window.visualViewport?.removeEventListener('resize', fit); window.visualViewport?.removeEventListener('scroll', fit);
    };
  }, [enabled, position, onMove]);
  const onPointerDown = event => {
    if (event.isPrimary === false) { cancel(); return; }
    if (event.button !== 0 || !dock.current) return;
    cancel(); suppressClick.current = false;
    const node = dock.current, rect = node.getBoundingClientRect(), handle = event.currentTarget;
    gesture.current = { id: event.pointerId, startX: event.clientX, startY: event.clientY, x: rect.left, y: rect.top, node, handle, box: bounds(node), moved: false };
    handle.setPointerCapture(event.pointerId);
  };
  const onPointerMove = event => {
    const current = gesture.current;
    if (!current || current.id !== event.pointerId) return;
    const dx = event.clientX - current.startX, dy = event.clientY - current.startY;
    if (!current.moved && Math.hypot(dx, dy) < distance) return;
    current.moved = true; suppressClick.current = true; event.preventDefault();
    current.point = clamp({ x: current.x + dx, y: current.y + dy }, current.box);
    current.node.setAttribute('data-dragging', 'true'); draw(current.node, current.point);
  };
  const onPointerUp = event => {
    const current = gesture.current;
    if (!current || current.id !== event.pointerId) return;
    gesture.current = null; current.node.removeAttribute('data-dragging');
    if (current.moved) { event.preventDefault(); onMove(clamp(current.point, bounds(current.node))); }
    if (current.handle.hasPointerCapture?.(current.id)) current.handle.releasePointerCapture(current.id);
  };
  const onKeyDown = event => {
    if (event.altKey || event.ctrlKey || event.metaKey || !dock.current) return;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation(); cancel();
    if (event.key === 'Home') { onMove(null); return; }
    const rect = dock.current.getBoundingClientRect(), step = event.shiftKey ? 40 : 10;
    onMove(clamp({ x: rect.left + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0), y: rect.top + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0) }, bounds(dock.current)));
  };
  return {
    style: position ? { left: position.x, top: position.y, right: 'auto', bottom: 'auto' } : undefined,
    handle: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: cancel, onLostPointerCapture: cancel, onKeyDown },
    open(event, action) {
      if (suppressClick.current && event.detail !== 0) { suppressClick.current = false; event.preventDefault(); event.stopPropagation(); return; }
      suppressClick.current = false; action();
    },
  };
}
