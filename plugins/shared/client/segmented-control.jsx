import React, { useId, useLayoutEffect, useRef, useState } from 'react';
import css from './segmented-control.css';
import { Tooltip } from './ui/tooltip.jsx';

/** Shared compact tabs, with a measured indicator and roving focus. */
export function SegmentedControl({ options, value, onChange, label, panelId, tabIdPrefix, disabled = false }) {
  const generatedId = useId(), id = tabIdPrefix || panelId || generatedId, track = useRef(null);
  const [indicator, setIndicator] = useState(null);
  useLayoutEffect(() => {
    const element = track.current;
    const measure = () => {
      const selected = element?.querySelector('[aria-selected=true]');
      if (selected) setIndicator({ transform: `translateX(${selected.offsetLeft}px)`, width: selected.offsetWidth, height: selected.offsetHeight, top: selected.offsetTop });
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (element) { observer.observe(element); for (const button of element.querySelectorAll('button')) observer.observe(button); }
    return () => observer.disconnect();
  }, [value, options.map(option => option.value).join('\0')]);
  return <><style>{css}</style><div className="bg-segments-scroll"><div ref={track} className="bg-segments" role="tablist" aria-label={label}>
    <span className="bg-segments-indicator" aria-hidden="true" style={indicator || { opacity: 0 }}><span key={value} className="bg-segments-fill" /></span>
    {options.map((option, index) => {
      const button = <button type="button" key={option.value} id={`${id}-${option.value}`} role="tab" aria-label={option.ariaLabel || (option.iconOnly ? option.label : undefined)} data-icon-only={option.iconOnly || undefined} aria-selected={value === option.value} aria-controls={option.panelId || panelId} tabIndex={value === option.value ? 0 : -1} disabled={disabled} onClick={() => onChange(option.value)} onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : options.length - 1)) % options.length;
      onChange(options[next].value); track.current?.querySelectorAll('button')[next]?.focus();
      }}>{option.icon}{!option.iconOnly && <span>{option.label}</span>}</button>;
      return option.iconOnly ? <Tooltip key={option.value} label={option.tooltip || option.label}>{button}</Tooltip> : button;
    })}
  </div></div></>;
}
