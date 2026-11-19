import React, { useId, useLayoutEffect, useRef, useState } from 'react';
import css from './segmented-control.css';
import { Tooltip } from './ui/tooltip.jsx';

/** Shared compact tabs, with a measured indicator and roving focus. */
export function SegmentedControl({ options, value, onChange, label, panelId, tabIdPrefix, disabled = false, orientation = 'horizontal', navigation = false }) {
  const generatedId = useId(), id = tabIdPrefix || panelId || generatedId, track = useRef(null);
  const [indicator, setIndicator] = useState(null);
  useLayoutEffect(() => {
    if (navigation) return;
    const element = track.current;
    const measure = () => {
      const selected = element?.querySelector('[aria-selected=true]');
      if (selected) {
        const next = { transform: `translateX(${selected.offsetLeft}px)`, width: selected.offsetWidth, height: selected.offsetHeight, top: selected.offsetTop };
        setIndicator(previous => previous && Object.keys(next).every(key => previous[key] === next[key]) ? previous : next);
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (element) { observer.observe(element); for (const button of element.querySelectorAll('button')) observer.observe(button); }
    return () => observer.disconnect();
  }, [navigation, value, options.map(option => option.value).join('\0')]);
  const [previousKey, nextKey] = orientation === 'vertical' ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight'];
  return <><style>{css}</style><div className="bg-segments-scroll" data-navigation={navigation || undefined}><div ref={track} className="bg-segments" role="tablist" aria-label={label} aria-orientation={orientation}>
    {!navigation && <span className="bg-segments-indicator" aria-hidden="true" style={indicator || { opacity: 0 }}><span key={value} className="bg-segments-fill" /></span>}
    {options.map((option, index) => {
      const button = <button type="button" key={option.value} id={`${id}-${option.value}`} role="tab" aria-label={option.ariaLabel || (option.iconOnly ? option.label : undefined)} data-icon-only={option.iconOnly || undefined} aria-selected={value === option.value} aria-controls={option.panelId || panelId} tabIndex={value === option.value ? 0 : -1} disabled={disabled || option.disabled} onClick={() => onChange(option.value)} onKeyDown={event => {
      if (![previousKey, nextKey, 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const available = options.map((item, position) => item.disabled ? -1 : position).filter(position => position >= 0);
      if (!available.length) return;
      const current = available.indexOf(index);
      const next = event.key === 'Home' ? available[0] : event.key === 'End' ? available.at(-1) : available[(current + (event.key === nextKey ? 1 : available.length - 1)) % available.length];
      onChange(options[next].value); track.current?.querySelectorAll('button')[next]?.focus();
      }}>{option.icon}{!option.iconOnly && <span>{option.label}</span>}</button>;
      return option.iconOnly ? <Tooltip key={option.value} label={option.tooltip || option.label}>{button}</Tooltip> : button;
    })}
  </div></div></>;
}
