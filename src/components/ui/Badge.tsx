import type { HTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from './cn';

export const badgeVariants = cva(
  'inline-flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded-full px-2 font-ui text-xs font-[550] before:size-1.5 before:shrink-0 before:rounded-full [&:has(svg)]:before:hidden [&_svg]:size-3.5 [&_svg]:shrink-0',
  {
    variants: {
      tone: {
        neutral: 'bg-neutral-soft text-neutral before:bg-neutral-dot',
        brand: 'bg-brand-soft text-brand-text before:bg-brand',
        positive: 'bg-positive-soft text-positive before:bg-positive-dot',
        caution: 'bg-caution-soft text-caution before:bg-caution-dot',
        critical: 'bg-critical-soft text-critical before:bg-critical-dot',
        info: 'bg-info-soft text-info before:bg-info-dot',
        violet: 'bg-violet-soft text-violet before:bg-violet-dot',
        teal: 'bg-teal-soft text-teal before:bg-teal-dot',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

/**
 * A status label. Colour is never the only signal: always give it words, and
 * an icon when the status matters (expired, overdue).
 */
export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
