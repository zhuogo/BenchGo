import React from 'react';
import css from './info-disclosure.css';

/** A compact, keyboard accessible way to reveal secondary guidance. */
export function InfoDisclosure({ label = '查看说明', children }) {
  return <details className="ba-info-disclosure"><style>{css}</style>
    <summary aria-label={label}><span aria-hidden="true">i</span></summary>
    <div className="ba-info-disclosure-popover" role="note">{children}</div>
  </details>;
}
