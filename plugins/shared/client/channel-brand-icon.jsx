import React from 'react';
import brands from './assets/channel-brands/catalog.json';
import { UIIcon } from '../../benchgo/client/iconsax.jsx';

// Vendor-hosted, unmodified marks. Provenance: assets/channel-brands/SOURCE.md.
// Saved availability controls brand color independently of navigation selection.
export function ChannelBrandIcon({ channel, size = 18, available = false, className = '' }) {
  const id = ({ wechat: 'weixin', 'whatsapp-business': 'whatsapp', 'api-service': 'api' })[channel] || channel;
  const src = brands[id];
  const lit = available;
  const style = { display: 'inline-flex', width: size, height: size, flexShrink: 0, alignItems: 'center', justifyContent: 'center', verticalAlign: 'middle', filter: lit ? undefined : 'grayscale(1)', opacity: lit ? 1 : 0.65 };
  if (src) return <span className={className} aria-hidden="true" data-available={available} style={style}><img src={src} alt="" width={size} height={size} draggable={false} style={{ display: 'block', objectFit: 'contain' }} /></span>;
  return <span className={className} aria-hidden="true" style={style}><UIIcon name={id === 'api' ? 'server' : id === 'email' ? 'email' : 'link'} size={size} selected={available} /></span>;
}
