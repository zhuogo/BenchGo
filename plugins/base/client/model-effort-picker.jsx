import React, { useId, useRef, useState } from 'react';
import { UIIcon } from './iconsax.jsx';
import { reasoningLevels } from './model-reasoning-state.mjs';

const activeLevels = reasoningLevels.filter(level => level !== 'off');

function EffortIcon({ effort }) {
  const strength = activeLevels.indexOf(effort);
  if (strength < 0) return <UIIcon name={effort === 'off' ? 'close' : effort === '' ? 'settings' : 'bulb'} size={15} className="cmd-model-effort-icon" />;
  return <span className="cmd-model-effort-icon cmd-model-effort-meter" aria-hidden="true">
    {activeLevels.map((level, index) => <i key={level} data-filled={index <= strength || undefined} style={{ height: 3 + index * 2 }} />)}
  </span>;
}

export function ModelEffortPicker({ options, value, disabled, saving = false, onCommit }) {
  const label = useId();
  const surface = useRef(null);
  const motion = useRef(null);
  const [animate, setAnimate] = useState(false);
  const selected = options.findIndex(option => option.id === value);
  const select = (index, pointer) => {
    if (disabled || saving || index === selected) return;
    setAnimate(pointer);
    motion.current?.cancel();
    if (pointer && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      motion.current = surface.current.animate([
        { transform: 'scale(1)' },
        { transform: 'scale(1.1, .88)', offset: .32 },
        { transform: 'scale(.97, 1.03)', offset: .68 },
        { transform: 'scale(1)' },
      ], { duration: 220, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
    }
    void onCommit(options[index].id);
  };
  const navigate = (event, index) => {
    let next;
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowUp': next = (index - 1 + options.length) % options.length; break;
      case 'ArrowRight':
      case 'ArrowDown': next = (index + 1) % options.length; break;
      case 'Home': next = 0; break;
      case 'End': next = options.length - 1; break;
      default: return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (disabled || saving) return;
    event.currentTarget.parentElement.querySelectorAll('button')[next]?.focus({ preventScroll: true });
    select(next, false);
  };

  return <div className="cmd-model-effort-section">
    <span id={label} className="cmd-model-effort-heading">推理强度</span>
    <div className="cmd-model-effort-track" role="radiogroup" aria-labelledby={label} aria-disabled={disabled || saving} data-unavailable={disabled || undefined}
      data-animate={animate || undefined} data-dense={options.length > 5 || undefined} style={{ '--effort-count': options.length }}>
      <span className="cmd-model-effort-highlight" aria-hidden="true" data-empty={selected < 0 || undefined}
        style={{ transform: `translateX(${Math.max(0, selected) * 100}%)` }}><span ref={surface} /></span>
      {options.map((option, index) => (
        <button key={option.id} type="button" role="radio" aria-checked={index === selected}
          aria-disabled={disabled || saving} tabIndex={index === Math.max(0, selected) ? 0 : -1}
          className="cmd-model-effort-step" title={option.description}
          onClick={event => { event.stopPropagation(); select(index, event.detail > 0); }} onKeyDown={event => navigate(event, index)}>
          <EffortIcon effort={option.id} /><span className="cmd-model-effort-label">{option.name}</span>
        </button>
      ))}
    </div>
  </div>;
}
