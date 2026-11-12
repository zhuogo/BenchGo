import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { assistantConfigSync } from '../../superagent/client/config-sync.mjs';
import { petImageUrl } from '../../superagent/client/pet-state.mjs';
import { renderBuiltinPet } from '../../superagent/shared/pet-catalog.mjs';
import { PetAvatar } from '../../shared/client/pet-avatar.jsx';
import css from './session-mascot.css';

function SessionMascot({ config }) {
  const ref = useRef(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    let intersecting = true;
    const update = () => setVisible(intersecting && !document.hidden);
    const observer = new IntersectionObserver(([entry]) => { intersecting = entry.isIntersecting; update(); });
    observer.observe(ref.current);
    document.addEventListener('visibilitychange', update);
    update();
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', update); };
  }, []);
  const pet = config?.pet;
  let artwork;
  if (pet?.kind !== 'custom') {
    // Only reviewed local SVG fragments enter this inline surface; custom uploads remain images.
    try { artwork = renderBuiltinPet(pet); } catch { artwork = renderBuiltinPet(); }
  }
  return <div ref={ref} className="bg-session-mascot" data-motion={visible && config?.cardMotion !== false ? 'on' : 'off'} aria-hidden="true">
    <style>{css}</style>
    <div className="bg-session-mascot-arrival"><div className="bg-session-mascot-body">
      {artwork ? <span className="bg-session-mascot-art" dangerouslySetInnerHTML={{ __html: artwork }} /> : <PetAvatar pet={pet} src={petImageUrl(pet, document.baseURI)} size={60} motion={false} alt="" />}
    </div></div>
  </div>;
}

/** Keep the resident composer tree intact and anchor decoration to its own card, including cold start. */
export function SessionMascotFrame({ hero, children }) {
  const frame = useRef(null);
  const [card, setCard] = useState(null);
  const config = useSyncExternalStore(assistantConfigSync.subscribe, assistantConfigSync.getSnapshot);
  useLayoutEffect(() => {
    if (!hero) { setCard(null); return; }
    const findCard = () => setCard(frame.current?.querySelector('[data-composer-card]') || null);
    findCard();
    const observer = new MutationObserver(findCard);
    observer.observe(frame.current, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [hero]);
  return <div ref={frame} style={{ display: 'contents' }}>{children}{hero && card && createPortal(<SessionMascot config={config} />, card)}</div>;
}

export function mountSessionMascot(ctx) {
  // Same-id priority is the public replacement mechanism for an official HOC occupant.
  ctx.slots.inject('conversation.hero.frame', () => ctx.slots.register({ name: 'conversation.hero.frame', id: 'pixel-whale', priority: -10 }, SessionMascotFrame));
}
