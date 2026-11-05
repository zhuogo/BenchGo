import React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { cn } from './utils.js';
import { UiStyles } from './styles.jsx';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;
export const DialogTitle = React.forwardRef(function DialogTitle({ className, ...props }, ref) {
  return <DialogPrimitive.Title ref={ref} className={cn('bg-ui-dialog-title', className)} {...props} />;
});
export const DialogDescription = React.forwardRef(function DialogDescription({ className, ...props }, ref) {
  return <DialogPrimitive.Description ref={ref} className={cn('bg-ui-dialog-description', className)} {...props} />;
});
export const DialogContent = React.forwardRef(function DialogContent({ className, children, closeLabel = '关闭', ...props }, ref) {
  return <><UiStyles /><DialogPrimitive.Portal><DialogPrimitive.Overlay className="bg-ui-dialog-overlay" />
    <DialogPrimitive.Content ref={ref} className={cn('bg-ui-dialog-content', className)} {...props}>
      {children}
      <DialogPrimitive.Close className="bg-ui-dialog-close" aria-label={closeLabel}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6" /></svg></DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal></>;
});
