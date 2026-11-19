import React, { useLayoutEffect, useRef } from 'react';

const clamp = value => Math.max(0, Math.min(1, value));
const resistance = ratio => {
  const edge = clamp(ratio);
  const excess = ratio - edge;
  return edge + excess * .16 / (1 + Math.abs(excess) * 5);
};

/** Preview only this small control; the official directory is written on release. */
export function ModelEffortSlider({ options, value, disabled, onCommit }) {
  const track = useRef(null), rail = useRef(null), fill = useRef(null), thumb = useRef(null), label = useRef(null), scale = useRef(null), ticks = useRef(null);
  const drag = useRef(null), frame = useRef(null), width = useRef(1);
  const position = useRef(0), landing = useRef(null);
  const steps = Math.max(1, options.length - 1);
  const index = Math.max(0, options.findIndex(option => option.id === value));
  const committed = options.length > 1 ? index / steps : 1;
  const resetPosition = useRef(null);
  const stopFrame = () => { if (frame.current !== null) cancelAnimationFrame(frame.current); frame.current = null; };
  const paint = (ratio, moving = false, selected = ratio) => {
    position.current = ratio;
    const current = options.length > 1 ? Math.round(clamp(selected) * steps) : 0, option = options[current];
    const off = option?.id === 'off';
    const usable = Math.max(1, width.current - 32);
    track.current?.classList.toggle('is-dragging', moving); track.current?.classList.toggle('is-off', off);
    track.current?.setAttribute('aria-valuenow', String(current)); track.current?.setAttribute('aria-valuetext', option?.name || '');
    if (label.current) { label.current.textContent = option?.name || ''; label.current.dataset.off = String(off); }
    if (thumb.current) thumb.current.style.transform = `translate(${usable * ratio}px, -50%) translateX(-50%)`;
    if (fill.current) {
      const progress = clamp(ratio);
      const filled = Math.min(width.current, 16 + usable * progress + 16 * progress);
      fill.current.style.transform = `scaleX(${filled / width.current})`;
      fill.current.style.opacity = moving || !off ? String(.35 + .65 * progress) : '0';
    }
    [...(ticks.current?.children || [])].forEach((node, index) => node.classList.toggle('is-active', index === current));
    [...(scale.current?.children || [])].forEach((node, index) => node.classList.toggle('is-current', index === current));
  };
  const settle = (target, velocity = 0) => {
    stopFrame();
    const start = performance.now(), offset = position.current - target;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || Math.abs(offset) < .002) {
      landing.current = null;
      paint(target);
      return;
    }
    const speed = Math.max(-4, Math.min(4, velocity));
    const coefficient = speed + 24 * offset;
    landing.current = target;
    paint(position.current, false, target);
    const tick = now => {
      const seconds = (now - start) / 1000;
      const delta = (offset + coefficient * seconds) * Math.exp(-24 * seconds);
      if (seconds >= .26 || (seconds > .10 && Math.abs(delta) < .001)) {
        frame.current = landing.current = null;
        paint(target);
        return;
      }
      paint(target + delta, false, target);
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
  };
  const releaseDrag = () => {
    const active = drag.current; drag.current = null;
    if (active && track.current?.hasPointerCapture(active.id)) track.current.releasePointerCapture(active.id);
  };
  const cancel = () => { stopFrame(); landing.current = null; releaseDrag(); paint(committed); };
  resetPosition.current = cancel;
  useLayoutEffect(() => {
    width.current = Math.max(1, rail.current.getBoundingClientRect().width);
    cancel();
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.max(1, entry.contentRect.width);
      if (next === width.current) return;
      width.current = next; resetPosition.current();
    });
    observer.observe(rail.current);
    return () => { stopFrame(); releaseDrag(); observer.disconnect(); };
  }, [steps]);
  useLayoutEffect(() => {
    if (landing.current !== null) {
      if (landing.current === committed) return;
      settle(committed);
    } else if (!drag.current || disabled) cancel();
  }, [options, committed, disabled]);
  const ratioAt = clientX => resistance((clientX - drag.current.left - 16 - drag.current.offset) / Math.max(1, width.current - 32));
  return <div className="cmd-model-effort-section">
    <div className="cmd-model-effort-heading"><span>推理强度</span><strong ref={label}>{options[index]?.name || options[0]?.name}</strong></div>
    <div ref={track} className="cmd-model-effort-track" role="slider" tabIndex={disabled ? -1 : 0} aria-disabled={disabled} aria-label="推理强度档位" aria-valuemin={0} aria-valuemax={Math.max(0, options.length - 1)} aria-valuenow={index} aria-valuetext={options[index]?.name || options[0]?.name}
      onPointerDown={event => {
        if (disabled || options.length < 2 || event.button !== 0 || drag.current) return;
        event.preventDefault(); event.stopPropagation(); event.currentTarget.focus({ preventScroll: true });
        stopFrame(); landing.current = null;
        const rect = rail.current.getBoundingClientRect(); width.current = Math.max(1, rect.width);
        const distance = event.clientX - (rect.left + 16 + (width.current - 32) * position.current);
        drag.current = { id: event.pointerId, left: rect.left, offset: Math.abs(distance) <= 14 ? distance : 0,
          ratio: position.current, time: event.timeStamp, velocity: 0, moved: false };
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current.ratio = ratioAt(event.clientX); paint(drag.current.ratio, true);
      }}
      onPointerMove={event => {
        if (drag.current?.id !== event.pointerId) return;
        event.stopPropagation();
        const active = drag.current, next = ratioAt(event.clientX);
        const elapsed = Math.max(1, event.timeStamp - active.time);
        active.velocity = (next - active.ratio) * 1000 / elapsed;
        active.ratio = next; active.time = event.timeStamp; active.moved = true;
        frame.current ??= requestAnimationFrame(() => { frame.current = null; if (drag.current) paint(drag.current.ratio, true); });
      }}
      onPointerUp={event => {
        if (drag.current?.id !== event.pointerId) return;
        event.stopPropagation();
        const active = drag.current, ratio = ratioAt(event.clientX), target = Math.round(clamp(ratio) * steps);
        const velocity = active.moved && event.timeStamp - active.time < 70 ? active.velocity : 0;
        releaseDrag();
        paint(ratio, false, target / steps);
        settle(target / steps, velocity);
        if (target !== index) void onCommit(target);
      }}
      onPointerCancel={event => { if (drag.current?.id === event.pointerId) cancel(); }}
      onLostPointerCapture={event => { if (drag.current?.id === event.pointerId) cancel(); }}
      onClick={event => event.stopPropagation()}
      onKeyDown={event => {
        if (disabled) return;
        let target = index;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') target = Math.max(0, index - 1);
        else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') target = Math.min(options.length - 1, index + 1);
        else if (event.key === 'Home') target = 0;
        else if (event.key === 'End') target = Math.max(0, options.length - 1);
        else return;
        event.preventDefault(); event.stopPropagation(); cancel(); if (target !== index) void onCommit(target);
      }}>
      <div ref={rail} className="cmd-model-effort-rail">
        <div ref={ticks} className="cmd-model-effort-ticks" aria-hidden="true">{options.map((option, position) => <span key={option.id} className="cmd-model-effort-tick" style={{ left: `calc(16px + (100% - 32px) * ${options.length > 1 ? position / steps : 1})` }} />)}</div>
        <div ref={fill} className="cmd-model-effort-fill" aria-hidden="true" />
        <div ref={thumb} className="cmd-model-effort-thumb" aria-hidden="true" />
      </div>
    </div>
    {options.length > 1 && <div ref={scale} className="cmd-model-effort-scale">{options.map((option, position) => <button key={option.id} type="button" tabIndex={-1} disabled={disabled} className="cmd-model-effort-step" onClick={event => { event.stopPropagation(); if (position !== index) { settle(position / steps); void onCommit(position); } }}>{option.name}</button>)}</div>}
  </div>;
}
