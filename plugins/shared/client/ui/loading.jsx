import React from 'react';
import css from './loading.css';

/** A quiet loading beat: one readable phrase, with characters lifted in order. */
export function Loading({ label = '加载中', className = '', compact = false, ...props }) {
  const text = String(label || '加载中');
  const characters = typeof Intl.Segmenter === 'function'
    ? Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), part => part.segment)
    : Array.from(text);
  return <div {...props} className={`bg-loading${compact ? ' bg-loading-compact' : ''}${className ? ' ' + className : ''}`} role="status" aria-label={text} aria-live="polite" aria-atomic="true" aria-busy="true">
    <style>{css}</style>
    <span className="bg-loading-text" aria-hidden="true" style={{ '--loading-cycle': `${Math.max(1.6, characters.length * .075 + .8)}s` }}>
      {characters.map((character, index) => <span key={index} className="bg-loading-character" style={{ animationDelay: `${index * .075}s` }}>{character}</span>)}
    </span>
  </div>;
}
