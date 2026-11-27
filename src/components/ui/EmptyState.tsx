import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from './cn';

export interface EmptyStateProps {
  icon?: LucideIcon;
  title: ReactNode;
  /** What the user can do to fill this space. */
  description?: ReactNode;
  action?: ReactNode;
  size?: 'md' | 'sm';
  className?: string;
}

export function EmptyState({ icon: Icon, title, description, action, size = 'md', className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center px-5 text-center font-ui',
        size === 'md' ? 'py-11' : 'py-8',
        className,
      )}
    >
      {Icon ? (
        <div className="mb-4 flex size-12 items-center justify-center rounded-[14px] bg-sunken shadow-hi text-fg-subtle">
          <Icon aria-hidden className="size-5" />
        </div>
      ) : null}
      <p className="text-[15px] font-semibold text-fg">{title}</p>
      {description ? <p className="mt-1 max-w-[46ch] text-sm text-fg-muted">{description}</p> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}
