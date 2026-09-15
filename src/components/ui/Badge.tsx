import type { HTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from './cn';

export const badgeVariants = cva(
  'inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 font-ui text-xs font-semibold [&_svg]:size-3.5 [&_svg]:shrink-0',
  {
    variants: {
      tone: {
        neutral: 'bg-sunken text-fg-muted',
        brand: 'bg-brand-soft text-brand-text',
        positive: 'bg-positive-soft text-positive',
        caution: 'bg-caution-soft text-caution',
        critical: 'bg-critical-soft text-critical',
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
