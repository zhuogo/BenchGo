import React, { useEffect, useRef, useState } from 'react';
import mark from '../../../assets/brand/benchgo-mark.svg';
import css from './pet-avatar.css';
const defaultSrc = `data:image/svg+xml,${encodeURIComponent(mark)}`;
const actions = new Set(['acknowledge','focus','happy','waiting']);

/** One identity, arbitrary appearance. Custom images never inherit builtin face overlays. */
export function PetAvatar({pet,src,expression,action='idle',motion=true,size=80,alt='助手形象',className='',style,...props}) {
  const ref = useRef(null);
  const [visible,setVisible] = useState(true);
  const [failed,setFailed] = useState(false);
  const source = src || pet?.url || pet?.src || pet?.assetUrl || defaultSrc;
  useEffect(() => { setFailed(false); },[source]);
  useEffect(() => {
    let intersecting = true;
    const update = () => setVisible(intersecting && !document.hidden);
    const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => { intersecting=entries[0]?.isIntersecting !== false; update(); }) : null;
    if (ref.current) observer?.observe(ref.current);
    document.addEventListener('visibilitychange',update); update();
    return () => { observer?.disconnect(); document.removeEventListener('visibilitychange',update); };
  },[]);
  return <span {...props} ref={ref} className={`benchgo-pet-avatar ${className}`} data-action={motion && visible && actions.has(action) ? action : 'idle'} data-expression={expression || pet?.expression || 'standard'} style={{width:size,height:size,...style}}>
    <style>{css}</style>
    {failed ? <span className="benchgo-pet-unavailable" role="img" aria-label="形象暂时无法加载">形象不可用</span> : <img key={`${source}:${action}`} src={source} alt={alt} draggable={false} onError={() => setFailed(true)}/>}
  </span>;
}
export default PetAvatar;
