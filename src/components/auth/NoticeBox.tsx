import React from 'react';
import { AlertCircle, CheckCircle2 } from 'lucide-react';
import { cn } from '../ui';

interface NoticeBoxProps {
  tone: 'success' | 'error';
  /**
   * Give the box its own live-region role. Leave it off inside a container that
   * is already a live region, or screen readers announce the message twice.
   */
  announce?: boolean;
  children: React.ReactNode;
}

/**
 * A result inside a signed-out card: a code sent, a code refused.
 *
 * It looks like the design system's Alert and cannot be one: Alert always
 * carries a live-region role, and the one-time-code block puts these boxes
 * inside regions that already announce them. The `surface` prop is gone —
 * since phase 5 batch 4 the tokens follow the theme, so the box looks right on
 * the signed-out card and inside Mein Konto alike.
 */
const NoticeBox: React.FC<NoticeBoxProps> = ({ tone, announce = false, children }) => {
  const Icon = tone === 'error' ? AlertCircle : CheckCircle2;
  const role = announce ? (tone === 'error' ? 'alert' : 'status') : undefined;

  return (
    <div
      role={role}
      className={cn(
        'flex items-start gap-3 rounded-control border p-3.5 font-ui text-sm leading-relaxed',
        tone === 'error' ? 'border-critical/30 bg-critical-soft' : 'border-positive/30 bg-positive-soft',
      )}
    >
      <Icon aria-hidden className={cn('mt-0.5 size-4 shrink-0', tone === 'error' ? 'text-critical' : 'text-positive')} />
      <div className="min-w-0 text-fg">{children}</div>
    </div>
  );
};

export default NoticeBox;
