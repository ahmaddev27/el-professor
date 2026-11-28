import type { HTMLAttributes } from 'react';
import { cn } from './cn';

/** A placeholder shaped like the content it stands in for; hidden from screen readers. */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden className={cn('rounded-tight bg-sunken bg-shimmer bg-[length:400%_100%] motion-safe:animate-ui-shimmer', className)} {...props} />;
}
