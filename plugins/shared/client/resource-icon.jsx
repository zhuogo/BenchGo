import React from 'react';

// Original 24px line icons; shared stroke and geometry, no external asset dependency.
export function ResourceIcon({ name, size = 18 }) {
  const shapes = {
    book: <><path d="M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1Z" /><path d="M12 5v15" /></>,
    document: <><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z" /><path d="M14 3v5h5M9 12h6M9 16h6" /></>,
    video: <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="m10 9 5 3-5 3z" /></>,
    code: <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M3 8h18m-12 4-2 2 2 2m6-4 2 2-2 2" /></>,
    feed: <><rect x="4" y="3" width="16" height="8" rx="2" /><rect x="4" y="15" width="16" height="6" rx="2" /><path d="M8 7h8" /></>,
    key: <><circle cx="8" cy="15" r="3" /><path d="m10.2 12.8 7.8-7.8m-2 2 2 2m-4 0 2 2" /></>,
    shield: <><path d="M12 3 4 6v6c0 4 4 7 8 9 4-2 8-5 8-9V6l-8-3Z" /><path d="m8.5 12 2.5 2.5 4.5-5" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>{shapes[name] || shapes.document}</svg>;
}
