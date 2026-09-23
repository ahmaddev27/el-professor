import type { KeyboardEvent } from 'react';
import { CalendarRange } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, cn, EmptyState, formatDate } from '../ui';
import { useTranslation } from '../../contexts/LanguageContext';
import type { TranslationKey } from '../../i18n';
import { formatBerlinTime, type TimelineDay, type TimelineLane, type TimelineSegment } from '../../lib/tripAnalysisView';

/**
 * A driver's month as one row per day: the recorded shifts, the trips, the
 * blocks they form and the findings, each in a lane of its own so no mark is
 * drawn over another. Every mark is a button that opens the trips behind it.
 *
 * Drawn in SVG with its geometry in attributes, so the layout needs no inline
 * style, and coloured with the design tokens (fill-positive, fill-brand,
 * stroke-fg-muted, fill-critical / fill-caution), each of which the contrast
 * test holds at 3:1 or more on the raised surface it sits on.
 */

const VIEW_WIDTH = 1000;
const VIEW_HEIGHT = 64;
/** A mark never narrower than this, so a one-minute trip can still be seen and tapped. */
const MIN_WIDTH = 4;

const LANES: Record<TimelineLane, { y: number; height: number }> = {
  shift: { y: 2, height: 12 },
  trip: { y: 18, height: 16 },
  block: { y: 38, height: 10 },
  issue: { y: 52, height: 10 },
};

const LANE_LABEL: Record<TimelineLane, TranslationKey> = {
  shift: 'ta.timeline.shift',
  trip: 'ta.timeline.trip',
  block: 'ta.timeline.block',
  issue: 'ta.timeline.issue',
};

function markClass(segment: TimelineSegment): string {
  switch (segment.lane) {
    case 'shift':
      return 'fill-positive';
    case 'trip':
      return 'fill-brand';
    case 'block':
      return 'fill-transparent stroke-fg-muted';
    case 'issue':
      return segment.status === 'conflict' ? 'fill-critical' : segment.status === 'unverifiable' ? 'fill-caution' : 'fill-positive';
  }
}

const WEEKDAY = new Intl.DateTimeFormat('de-DE', { weekday: 'short', timeZone: 'UTC' });

function weekday(dateKey: string): string {
  const [year, month, day] = dateKey.split('-').map(Number);
  return WEEKDAY.format(new Date(Date.UTC(year, month - 1, day)));
}

interface Props {
  days: readonly TimelineDay[];
  onSelect: (segment: TimelineSegment) => void;
}

export function TripAnalysisTimeline({ days, onSelect }: Props) {
  const { t } = useTranslation();

  const onKey = (segment: TimelineSegment) => (event: KeyboardEvent<SVGRectElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect(segment);
    }
  };

  const legend: Array<{ lane: TimelineLane; swatch: string; label: TranslationKey }> = [
    { lane: 'shift', swatch: 'bg-positive', label: 'ta.timeline.shift' },
    { lane: 'trip', swatch: 'bg-brand', label: 'ta.timeline.trip' },
    { lane: 'block', swatch: 'border border-fg-muted', label: 'ta.timeline.block' },
  ];

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>{t('ta.timeline.title')}</CardTitle>
          <CardDescription>{t('ta.timeline.description')}</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-3">
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-muted" aria-label={t('ta.timeline.title')}>
          {legend.map(item => (
            <li key={item.lane} className="flex items-center gap-1.5">
              <span aria-hidden className={cn('inline-block size-3 rounded-sm', item.swatch)} />
              {t(item.label)}
            </li>
          ))}
          <li className="flex items-center gap-1.5">
            <span aria-hidden className="inline-block size-3 rounded-sm bg-critical" />
            {t('ta.status.conflict')}
          </li>
          <li className="flex items-center gap-1.5">
            <span aria-hidden className="inline-block size-3 rounded-sm bg-caution" />
            {t('ta.status.unverifiable')}
          </li>
        </ul>

        {days.length === 0 ? (
          <EmptyState size="sm" icon={CalendarRange} title={t('ta.timeline.empty')} />
        ) : (
          <div className="grid grid-cols-1 gap-1">
            <div aria-hidden className="grid grid-cols-[4.75rem_1fr] gap-2 sm:grid-cols-[6.5rem_1fr]">
              <span />
              <span className="flex justify-between text-[11px] tabular-nums text-fg-subtle">
                <span>00</span>
                <span>06</span>
                <span>12</span>
                <span>18</span>
                <span>24</span>
              </span>
            </div>
            <ol className="grid grid-cols-1 gap-1.5">
              {days.map(day => (
                <li key={day.dateKey} className="grid grid-cols-[4.75rem_1fr] items-center gap-2 sm:grid-cols-[6.5rem_1fr]">
                  <span className="text-xs tabular-nums text-fg-muted">
                    <span className="block font-semibold text-fg">{weekday(day.dateKey)}</span>
                    {formatDate(day.dateKey)}
                  </span>
                  <svg
                    viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
                    preserveAspectRatio="none"
                    className="h-16 w-full overflow-visible rounded-sm border border-line"
                    role="group"
                    aria-label={formatDate(day.dateKey)}
                  >
                    {[250, 500, 750].map(x => (
                      <line key={x} x1={x} x2={x} y1={0} y2={VIEW_HEIGHT} className="stroke-line" vectorEffect="non-scaling-stroke" />
                    ))}
                    {day.segments.map((segment, index) => {
                      const lane = LANES[segment.lane];
                      const x = segment.from * VIEW_WIDTH;
                      const width = Math.max((segment.to - segment.from) * VIEW_WIDTH, MIN_WIDTH);
                      const label = t('ta.timeline.segment', {
                        lane: t(LANE_LABEL[segment.lane]),
                        from: formatBerlinTime(segment.startMs),
                        to: formatBerlinTime(segment.endMs),
                      });
                      return (
                        <rect
                          key={`${segment.lane}-${segment.refId}-${index}`}
                          x={Math.min(x, VIEW_WIDTH - MIN_WIDTH)}
                          y={lane.y}
                          width={width}
                          height={lane.height}
                          rx={2}
                          vectorEffect="non-scaling-stroke"
                          strokeWidth={segment.lane === 'block' ? 1.5 : 0}
                          className={cn(
                            markClass(segment),
                            'cursor-pointer outline-none focus-visible:stroke-focus focus-visible:[stroke-width:3px]',
                          )}
                          role="button"
                          tabIndex={0}
                          aria-label={label}
                          onClick={() => onSelect(segment)}
                          onKeyDown={onKey(segment)}
                        >
                          <title>{label}</title>
                        </rect>
                      );
                    })}
                  </svg>
                </li>
              ))}
            </ol>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
