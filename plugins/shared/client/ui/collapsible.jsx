import React from 'react';
import * as CollapsiblePrimitive from '@radix-ui/react-collapsible';
import { cn } from './utils.js';
import { UiStyles } from './styles.jsx';

export const Collapsible = React.forwardRef(function Collapsible(props, ref) {
  return <><UiStyles /><CollapsiblePrimitive.Root ref={ref} {...props} /></>;
});
export const CollapsibleTrigger = React.forwardRef(function CollapsibleTrigger({ className, children, ...props }, ref) {
  return <CollapsiblePrimitive.Trigger ref={ref} className={cn('bg-ui-disclosure-trigger', className)} {...props}>
    <span className="bg-ui-disclosure-label">{children}</span>
    <svg className="bg-ui-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>
  </CollapsiblePrimitive.Trigger>;
});
export const CollapsibleContent = React.forwardRef(function CollapsibleContent({ className, children, ...props }, ref) {
  return <CollapsiblePrimitive.Content ref={ref} className={cn('bg-ui-disclosure-content', className)} {...props}><div className="bg-ui-disclosure-inner">{children}</div></CollapsiblePrimitive.Content>;
});

export function Disclosure({ title, description, children, className, ...props }) {
  return <Collapsible className={cn('bg-ui-disclosure', className)} {...props}>
    <CollapsibleTrigger><span>{title}</span>{description && <span className="bg-ui-disclosure-description">{description}</span>}</CollapsibleTrigger>
    <CollapsibleContent>{children}</CollapsibleContent>
  </Collapsible>;
}
