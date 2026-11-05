import React, { useInsertionEffect } from 'react';
import css from './ui.css';

/** Share one sheet across mounts and replace its contents during plugin reloads. */
export function UiStyles() {
  useInsertionEffect(() => {
    let style = document.getElementById('benchgo-ui-styles');
    if (!style) {
      style = document.createElement('style');
      style.id = 'benchgo-ui-styles';
      document.head.append(style);
    }
    if (style.textContent !== css) style.textContent = css;
    style.dataset.users = String(Number(style.dataset.users || 0) + 1);
    return () => {
      const users = Math.max(0, Number(style.dataset.users || 1) - 1);
      style.dataset.users = String(users);
      if (!users) style.remove();
    };
  }, []);
  return null;
}
