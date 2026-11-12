import React, { useLayoutEffect, useRef } from 'react';

/** A small projection of the existing live records, never another message store. */
export function FloatingTranscript({ rows }) {
  const root = useRef(null), previous = useRef(new Map()), previousHeight = useRef(0), animations = useRef(new Set());
  useLayoutEffect(() => {
    const node = root.current;
    if (!node) { previous.current.clear(); previousHeight.current = 0; return; }
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const box = node.getBoundingClientRect(), next = new Map();
    const animate = (element, frames, options) => {
      const motion = element.animate(frames, { duration: 240, easing: 'cubic-bezier(.2,.7,.2,1)', ...options });
      animations.current.add(motion);
      motion.finished.catch(() => {}).finally(() => { animations.current.delete(motion); if (element.dataset.leaving) element.remove(); });
    };
    for (const element of node.querySelectorAll('[data-preview-id]')) {
      const id = element.dataset.previewId, rect = element.getBoundingClientRect(), before = previous.current.get(id);
      element.querySelector('.voice-floating-text')?.scrollTo({ top: 100000, behavior: 'instant' });
      if (!reduced) {
        if (!before) animate(element, [{ opacity: 0, transform: 'translateY(10px)', filter: 'blur(2px)' }, { opacity: 1, transform: 'translateY(0)', filter: 'blur(0)' }]);
        else {
          const shift = before.top - (rect.top - box.top) + box.height - previousHeight.current;
          if (Math.abs(shift) > 1) animate(element, [{ transform: `translateY(${shift}px)` }, { transform: 'translateY(0)' }]);
        }
      }
      next.set(id, { element, top: rect.top - box.top, left: rect.left - box.left, width: rect.width });
    }
    if (!reduced) for (const [id, before] of previous.current) {
      if (next.has(id)) continue;
      const ghost = before.element.cloneNode(true);
      ghost.removeAttribute('data-preview-id'); ghost.dataset.leaving = 'true'; ghost.setAttribute('aria-hidden', 'true');
      Object.assign(ghost.style, { position: 'absolute', top: `${before.top}px`, left: `${before.left}px`, width: `${before.width}px`, margin: '0' });
      node.append(ghost);
      ghost.querySelector('.voice-floating-text')?.scrollTo({ top: 100000, behavior: 'instant' });
      while (node.querySelectorAll('[data-leaving]').length > 3) node.querySelector('[data-leaving]').remove();
      animate(ghost, [{ opacity: .5, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(-12px)' }], { duration: 190 });
    }
    previous.current = next; previousHeight.current = box.height;
  }, [rows]);
  useLayoutEffect(() => () => { for (const motion of animations.current) motion.cancel(); animations.current.clear(); }, []);
  if (!rows.length) return null;
  return <div ref={root} className="voice-floating-transcript" role="region" aria-label="最近语音对话" aria-live="off">
    {rows.map((row, index) => <div key={row.renderId || row.id} data-preview-id={row.renderId || row.id} className={'voice-floating-message is-' + row.role + (index === rows.length - 3 ? ' is-oldest' : index === rows.length - 2 ? ' is-previous' : '')}>
      <div className="voice-floating-text" aria-label={row.role === 'user' ? '你' : '回复'}><span>{row.text}</span></div>
    </div>)}
  </div>;
}
