import { useInsertionEffect } from 'react';

/** Keep standalone and desktop feedback on one scoped sheet per document. */
export function useFeedbackStyle(id, css) {
  useInsertionEffect(() => {
    let element = document.getElementById(id);
    if (!element) { element = document.createElement('style'); element.id = id; document.head.append(element); }
    if (element.textContent !== css) element.textContent = css;
    element.dataset.users = String(Number(element.dataset.users || 0) + 1);
    return () => { const users = Math.max(0, Number(element.dataset.users || 1) - 1); element.dataset.users = String(users); if (!users) element.remove(); };
  }, [id, css]);
}
