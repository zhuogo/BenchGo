import { clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

const merge = extendTailwindMerge({ prefix: 'bg' });

export function cn(...inputs) {
  return merge(clsx(inputs));
}
