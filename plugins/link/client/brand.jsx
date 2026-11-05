import React from 'react';
import appIcon from '../../../assets/brand/benchgo-app.svg';
import mark from '../../../assets/brand/benchgo-mark.svg';

export const brandIcon = `data:image/svg+xml,${encodeURIComponent(appIcon)}`;
const markIcon = `data:image/svg+xml,${encodeURIComponent(mark)}`;

export function BrandLogo({ size = 32, className = '', decorative = false }) {
  return <img src={markIcon} width={size} height={size} className={className} alt={decorative ? '' : 'BenchGo'} style={{ display: 'block', flex: 'none', objectFit: 'contain' }} />;
}

/** Keep both official light/dark favicon nodes branded; restore them when the plugin unloads. */
export function mountBrand(ctx) {
  ctx.effect(() => {
    const links = [...document.querySelectorAll('link[rel~="icon"]')];
    const previous = links.map(link => [link, link.getAttribute('href'), link.getAttribute('type')]);
    const created = !links.length;
    if (created) { const link = document.createElement('link'); link.rel = 'icon'; document.head.append(link); links.push(link); }
    for (const link of links) { link.href = markIcon; link.type = 'image/svg+xml'; }
    return () => {
      if (created) links[0].remove();
      for (const [link, href, type] of previous) {
        if (href === null) link.removeAttribute('href'); else link.setAttribute('href', href);
        if (type === null) link.removeAttribute('type'); else link.setAttribute('type', type);
      }
    };
  });
}
