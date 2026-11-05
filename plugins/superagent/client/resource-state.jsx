import React from 'react';
import { Button } from '../../shared/client/ui/button.jsx';
import { UIIcon } from '../../benchgo/client/iconsax.jsx';
import { ResourceIcon } from '../../shared/client/resource-icon.jsx';
import css from './resource-state.css';

/** Shared first-load, empty and recovery treatment for SuperAgent resources. */
export function ResourceState({ kind = 'empty', icon = 'document', title, description, actionLabel, onAction, children }) {
  return <div className="ba-resource-state" data-kind={kind} role={kind === 'error' ? 'alert' : 'status'} aria-busy={kind === 'loading' || undefined}>
    <style>{css}</style>
    <span className="ba-resource-state-icon" aria-hidden="true">{kind === 'error' ? <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v6m0 4h.01" /></svg> : icon === 'document' && kind !== 'loading' ? <ResourceIcon name="document" size={26} /> : <UIIcon name={kind === 'loading' ? 'refresh' : icon} size={26} />}</span>
    <strong>{title}</strong>
    {description && <p>{description}</p>}
    {kind === 'loading' && <div className="ba-resource-state-skeleton" aria-hidden="true"><i /><i /><i /></div>}
    {onAction && <Button type="button" variant="outline" onClick={onAction}>{actionLabel || '重试'}</Button>}
    {children}
  </div>;
}
