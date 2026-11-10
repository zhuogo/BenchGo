import React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva } from 'class-variance-authority';
import { cn } from './utils.js';
import { UiStyles } from './styles.jsx';
import { Tooltip } from './tooltip.jsx';

export const buttonVariants = cva('bg-ui-button bg:inline-flex bg:items-center bg:justify-center', {
  variants: {
    variant: { default: 'bg-ui-button-primary', secondary: 'bg-ui-button-secondary', ghost: 'bg-ui-button-ghost', destructive: 'bg-ui-button-destructive', outline: 'bg-ui-button-outline', link: 'bg-ui-button-link' },
    size: { default: '', sm: 'bg-ui-button-sm', lg: 'bg-ui-button-lg', icon: 'bg-ui-button-icon' },
  },
  defaultVariants: { variant: 'default', size: 'default' },
});

export const Button = React.forwardRef(function Button({ className, variant, size, asChild = false, type = 'button', title, ...props }, ref) {
  const Component = asChild ? Slot : 'button';
  const button = <Component ref={ref} type={asChild ? undefined : type} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
  return <><UiStyles />{title ? <Tooltip label={title}>{button}</Tooltip> : button}</>;
});
