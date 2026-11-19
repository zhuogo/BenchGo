import React from 'react';
import { PetAvatar } from '../../shared/client/pet-avatar.jsx';
import { petImageUrl } from './pet-state.mjs';
import css from './card.css';

export function AssistantCard({ name, pet, onOpen, action = 'idle', expression, ariaLabel, current, avatarSize = 40 }) {
  return <button type="button" className="ba-card" onClick={onOpen} aria-label={ariaLabel || '打开主聊天'} aria-current={current ? 'page' : undefined}>
    <style>{css}</style>
    <PetAvatar pet={pet} src={petImageUrl(pet, document.baseURI, expression)} expression={expression} action={action} size={avatarSize} alt="" />
    <span className="ba-card-name">{name}</span>
  </button>;
}
