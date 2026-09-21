import type { ReactNode } from 'react';
import { cva } from 'class-variance-authority';
import { AlertTriangle, CheckCircle2, Info, type LucideIcon } from 'lucide-react';
import { cn } from './cn';

export type AlertTone = 'neutral' | 'brand' | 'positive' | 'caution' | 'critical';

const alertVariants = cva('flex items-start gap-3 rounded-surface border p-4 font-ui text-sm', {
  variants: {
    tone: {
      neutral: 'border-line bg-sunken',
      brand: 'border-brand/30 bg-brand-soft',
      positive: 'border-positive/30 bg-positive-soft',
      caution: 'border-caution/30 bg-caution-soft',
      critical: 'border-critical/30 bg-critical-soft',
    },
  },
  defaultVariants: { tone: 'neutral' },
});

// The icon and the title carry the tone's colour; the body stays fg-muted, so a
// long explanation reads as text rather than as one block of red. Both pairs
// are held to 4.5:1 on every soft fill by tokens.contrast.test.ts.
const TONE_TEXT: Record<AlertTone, string> = {
  neutral: 'text-fg',
  brand: 'text-brand-text',
  positive: 'text-positive',
  caution: 'text-caution',
  critical: 'text-critical',
};

const TONE_ICON: Record<AlertTone, LucideIcon> = {
  neutral: Info,
  brand: Info,
  positive: CheckCircle2,
  caution: AlertTriangle,
  critical: AlertTriangle,
};

export interface AlertProps {
  tone?: AlertTone;
  title?: ReactNode;
  children?: ReactNode;
  /** Replaces the tone's default icon, e.g. a car for a vehicle limit. */
  icon?: LucideIcon;
  action?: ReactNode;
  /**
   * Defaults to `alert` for a critical message and `status` otherwise. Pass
   * `note` for standing guidance that is not news.
   */
  role?: 'alert' | 'status' | 'note';
  id?: string;
  className?: string;
}

/**
 * A message in the page flow: a limit reached, a load that failed, a hint.
 * Colour is never the only signal — every tone has an icon and words.
 */
export function Alert({ tone = 'neutral', title, children, icon, action, role, id, className }: AlertProps) {
  const Icon = icon ?? TONE_ICON[tone];
  return (
    <div id={id} role={role ?? (tone === 'critical' ? 'alert' : 'status')} className={cn(alertVariants({ tone }), className)}>
      <Icon aria-hidden className={cn('mt-0.5 size-4 shrink-0', TONE_TEXT[tone])} />
      <div className="grid min-w-0 gap-1">
        {title ? <p className={cn('font-semibold', TONE_TEXT[tone])}>{title}</p> : null}
        {children ? <div className="text-fg-muted">{children}</div> : null}
        {action ? <div className="mt-1">{action}</div> : null}
      </div>
    </div>
  );
}
