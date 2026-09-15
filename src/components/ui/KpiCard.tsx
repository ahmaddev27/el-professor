import type { ReactNode } from 'react';
import { Minus, TrendingDown, TrendingUp, type LucideIcon } from 'lucide-react';
import { useTranslation } from '../../contexts/LanguageContext';
import { Card } from './Card';
import { Skeleton } from './Skeleton';
import { cn } from './cn';

export interface KpiTrend {
  direction: 'up' | 'down' | 'flat';
  /** Already formatted, e.g. `+6,8 %`. */
  value: ReactNode;
  /** What the change is measured against, e.g. "vs. Vormonat". */
  label?: ReactNode;
  /**
   * Whether the change is good news. Rising revenue is, rising costs are not,
   * so direction alone cannot pick the colour.
   */
  sentiment?: 'positive' | 'negative' | 'neutral';
}

export interface KpiCardProps {
  label: ReactNode;
  /** Already formatted, e.g. `48.216,40 €`. */
  value: ReactNode;
  icon?: LucideIcon;
  trend?: KpiTrend;
  caption?: ReactNode;
  loading?: boolean;
  className?: string;
}

const TREND_ICON = { up: TrendingUp, down: TrendingDown, flat: Minus } as const;
const TREND_LABEL_KEY = { up: 'ui.kpi.trendUp', down: 'ui.kpi.trendDown', flat: 'ui.kpi.trendFlat' } as const;
const SENTIMENT_CLASS = { positive: 'text-positive', negative: 'text-critical', neutral: 'text-fg-muted' } as const;

export function KpiCard({ label, value, icon: Icon, trend, caption, loading = false, className }: KpiCardProps) {
  const { t } = useTranslation();
  const TrendIcon = trend ? TREND_ICON[trend.direction] : null;

  return (
    <Card className={cn('flex flex-col gap-3 p-5 font-ui', className)} aria-busy={loading || undefined}>
      <div className="flex items-center justify-between gap-3">
        <p className="text-[13px] font-medium text-fg-muted">{label}</p>
        {Icon ? <Icon aria-hidden className="size-4 text-fg-subtle" /> : null}
      </div>

      {loading ? (
        <>
          <Skeleton className="h-7 w-36" />
          <Skeleton className="h-4 w-24" />
        </>
      ) : (
        <>
          <p className="text-[28px] font-semibold leading-none tracking-tight text-fg tabular-nums">{value}</p>
          {trend || caption ? (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
              {trend && TrendIcon ? (
                <span className={cn('inline-flex items-center gap-1 font-semibold tabular-nums', SENTIMENT_CLASS[trend.sentiment ?? 'neutral'])}>
                  <TrendIcon aria-hidden className="size-3.5" />
                  <span className="sr-only">{t(TREND_LABEL_KEY[trend.direction])} </span>
                  {trend.value}
                </span>
              ) : null}
              {trend?.label ? <span className="text-fg-subtle">{trend.label}</span> : null}
              {caption ? <span className="text-fg-subtle">{caption}</span> : null}
            </div>
          ) : null}
        </>
      )}
    </Card>
  );
}
