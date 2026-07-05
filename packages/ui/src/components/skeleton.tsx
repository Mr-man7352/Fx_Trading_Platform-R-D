import type { ComponentProps } from 'react';
import { cn } from '../lib/cn';

/** FE-010 — shadcn-style Skeleton (vendored). Loading placeholder — never blank screens (FE-121). */
export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('animate-pulse rounded-md bg-muted', className)} {...props} />;
}
