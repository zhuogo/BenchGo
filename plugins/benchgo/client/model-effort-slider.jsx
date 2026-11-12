import React, { useLayoutEffect, useRef } from 'react';

const clamp = value => Math.max(0, Math.min(1, value));

/** Preview only this small control; the official directory is written on release. */
export function ModelEffortSlider({ options, value, disabled, onCommit }) {
  const track = useRef(null), rail = useRef(null), fill = useRef(null), thumb = useRef(null), label = useRef(null), scale = useRef(null), ticks = useRef(null);
  const drag = useRef(null), frame = useRef(null), width = useRef(1);
  const steps = Math.max(1, options.length - 1);
  const index = Math.max(0, options.findIndex(option => option.id === value));
  const committed = options.length > 1 ? index / steps : 1;
  const stopFrame = () => { if (frame.current !== null) cancelAnimationFrame(frame.current); frame.current = null; };
  const paint = (ratio, moving = false) => {
    const current = options.length > 1 ? Math.round(ratio * steps) : 0, option = options[current] || options[0];
    const off = !moving && (!option || option.id === 'off' || (options.length > 1 && current === 0 && /off|关|无/i.test(option.id + ' ' + option.name)));
    const intensity = off ? 0 : moving ? Math.max(0.45, ratio) : options.length > 1 ? Math.max(0.2, ratio) : 1;
    const usable = Math.max(1, width.current - 32);
    track.current?.classList.toggle('is-dragging', moving); track.current?.classList.toggle('is-off', off);
    track.current?.setAttribute('aria-valuenow', String(current)); track.current?.setAttribute('aria-valuetext', option?.name || '');
    if (label.current) { label.current.textContent = option?.name || ''; label.current.dataset.off = String(off); }
    if (thumb.current) thumb.current.style.transform = `translate(${usable * ratio}px, -50%) translateX(-50%)`;
    if (fill.current) {
      const filled = Math.min(width.current, 16 + usable * ratio + 16 * Math.max(0, (ratio - 0.85) / 0.15));
      fill.current.style.transform = `scaleX(${filled / width.current})`;
      fill.current.style.opacity = off ? '0' : String(0.12 + 0.88 * intensity);
    }
    [...(ticks.current?.children || [])].forEach((node, position) => node.classList.toggle('is-active', ratio + 0.001 >= (options.length > 1 ? position / steps : 1)));
    [...(scale.current?.children || [])].forEach((node, position) => node.classList.toggle('is-current', position === current));
  };
  const releaseDrag = () => {
    const active = drag.current; drag.current = null;
    if (active && track.current?.hasPointerCapture(active.id)) track.current.releasePointerCapture(active.id);
  };
  const cancel = () => { stopFrame(); releaseDrag(); paint(committed); };
  useLayoutEffect(() => {
    width.current = Math.max(1, rail.current.getBoundingClientRect().width);
    cancel();
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.max(1, entry.contentRect.width);
      if (next === width.current) return;
      width.current = next; cancel();
    });
    observer.observe(rail.current);
    return () => { stopFrame(); releaseDrag(); observer.disconnect(); };
  }, [options, value, disabled]);
  const ratioAt = clientX => clamp((clientX - drag.current.left - 16) / Math.max(1, width.current - 32));
  return <div className="cmd-model-effort-section">
    <div className="cmd-model-effort-heading"><span>推理强度</span><strong ref={label}>{options[index]?.name || options[0]?.name}</strong></div>
    <div ref={track} className="cmd-model-effort-track" role="slider" tabIndex={disabled ? -1 : 0} aria-disabled={disabled} aria-label="推理强度档位" aria-valuemin={0} aria-valuemax={Math.max(0, options.length - 1)} aria-valuenow={index} aria-valuetext={options[index]?.name || options[0]?.name}
      onPointerDown={event => {
        if (disabled || event.button !== 0 || drag.current) return;
        event.preventDefault(); event.stopPropagation();
        const rect = rail.current.getBoundingClientRect(); width.current = Math.max(1, rect.width);
        drag.current = { id: event.pointerId, left: rect.left, ratio: committed };
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current.ratio = ratioAt(event.clientX); paint(drag.current.ratio, true);
      }}
      onPointerMove={event => {
        if (drag.current?.id !== event.pointerId) return;
        event.stopPropagation(); drag.current.ratio = ratioAt(event.clientX);
        frame.current ??= requestAnimationFrame(() => { frame.current = null; if (drag.current) paint(drag.current.ratio, true); });
      }}
      onPointerUp={event => {
        if (drag.current?.id !== event.pointerId) return;
        event.stopPropagation(); const ratio = ratioAt(event.clientX), target = options.length > 1 ? Math.round(ratio * steps) : 0;
        stopFrame(); drag.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        paint(options.length > 1 ? target / steps : 1); void onCommit(target);
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
        event.preventDefault(); event.stopPropagation(); cancel(); void onCommit(target);
      }}>
      <div ref={rail} className="cmd-model-effort-rail">
        <div ref={ticks} className="cmd-model-effort-ticks" aria-hidden="true">{options.map((option, position) => <span key={option.id} className="cmd-model-effort-tick" style={{ left: `calc(16px + (100% - 32px) * ${options.length > 1 ? position / steps : 1})` }} />)}</div>
        <div ref={fill} className="cmd-model-effort-fill" aria-hidden="true"><span className="cmd-model-effort-ions cmd-model-effort-ions-a" /><span className="cmd-model-effort-ions cmd-model-effort-ions-b" /><span className="cmd-model-effort-glow" /></div>
        <div ref={thumb} className="cmd-model-effort-thumb" aria-hidden="true" />
      </div>
    </div>
    {options.length > 1 && <div ref={scale} className="cmd-model-effort-scale">{options.map((option, position) => <button key={option.id} type="button" tabIndex={-1} disabled={disabled} className="cmd-model-effort-step" onClick={event => { event.stopPropagation(); cancel(); void onCommit(position); }}>{option.name}</button>)}</div>}
  </div>;
}
