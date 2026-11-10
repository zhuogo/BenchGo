import React, { cloneElement } from 'react';
import { Tooltip as OfficialTooltip } from '@deepseek-ai/dsh-client-ui-primitives';

/** Share product defaults while the host owns bubble rendering and interaction. */
export function Tooltip({ label, children, side = 'top', delayMs = 450, portal = true, maxWidth = 340, disabled = false, ...props }) {
  const child = cloneElement(children, { title: undefined });
  const empty = (label == null || typeof label === 'string' && !label) && !props.shortcutKeys?.length;
  // Disabled native controls cannot receive focus or pointer events themselves.
  // The original child's ref stays attached to the control, not this anchor.
  const anchor = children.props.disabled
    ? <span tabIndex={disabled || empty ? undefined : 0} style={{ display: 'inline-flex', minWidth: 0, maxWidth: '100%', verticalAlign: 'middle' }}>{child}</span>
    : child;
  return <OfficialTooltip {...props} label={label} side={side} delayMs={delayMs} portal={portal} maxWidth={maxWidth} disabled={disabled || empty}>{anchor}</OfficialTooltip>;
}
