import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle, cn, formatEuroCents } from '../ui';
import { useTranslation } from '../../contexts/LanguageContext';
import { hourlyGrid, type DemandProfile } from '../../utils/shiftRecommendation';
import { HEAT_LEGEND, HEAT_NO_EVIDENCE_CLASS, WEEKDAY_KEYS, heatClass } from '../../utils/shiftRecommendationScreens';

/**
 * Weekday × hour, shaded by the history's revenue per vehicle hour.
 *
 * A real table, so a screen reader walks it row by row; each cell says its
 * value in words because the shade alone would be the only signal. The grid
 * scrolls sideways inside its own container rather than widening the page —
 * 24 columns do not fit a 375 px phone.
 */
export function DemandHeatmap({ profile, thresholdCents }: { profile: DemandProfile; thresholdCents: number }) {
  const { t } = useTranslation();
  const grid = useMemo(() => hourlyGrid(profile), [profile]);
  const hours = grid.slice(0, 24).map(cell => cell.clockHour);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('shiftrec.grid.title')}</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-3">
        <p className="text-[13px] text-fg-subtle">{t('shiftrec.grid.hint')}</p>
        <div className="overflow-x-auto">
          <table className="border-separate border-spacing-0.5 text-[11px] tabular-nums">
            <caption className="sr-only">{t('shiftrec.grid.caption')}</caption>
            <thead>
              <tr>
                <th scope="col"><span className="sr-only">{t('shiftrec.grid.corner')}</span></th>
                {hours.map((hour, index) => (
                  <th key={index} scope="col" className="min-w-6 font-normal text-fg-subtle">{hour}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {WEEKDAY_KEYS.map((dayKey, day) => (
                <tr key={dayKey}>
                  <th scope="row" className="pr-2 text-left font-semibold text-fg-muted">{t(dayKey)}</th>
                  {grid.slice(day * 24, day * 24 + 24).map(cell => {
                    const text =
                      cell.revenuePerHourCents === null
                        ? t('shiftrec.grid.cellNone', { day: t(dayKey), hour: cell.clockHour })
                        : t('shiftrec.grid.cell', { day: t(dayKey), hour: cell.clockHour, value: formatEuroCents(cell.revenuePerHourCents) });
                    return (
                      <td
                        key={cell.hourIndex}
                        title={text}
                        className={cn('h-7 min-w-6 rounded-sm', heatClass(cell.revenuePerHourCents, thresholdCents))}
                      >
                        <span className="sr-only">{text}</span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-fg-muted">
          <span className="inline-flex items-center gap-1">
            <span className={cn('size-3 rounded-sm', HEAT_NO_EVIDENCE_CLASS)} aria-hidden="true" />
            {t('shiftrec.grid.legendNone')}
          </span>
          <span>{t('shiftrec.grid.legendLow')}</span>
          {HEAT_LEGEND.map(shade => <span key={shade} className={cn('size-3 rounded-sm', shade)} aria-hidden="true" />)}
          <span>{t('shiftrec.grid.legendHigh')}</span>
        </div>
      </CardContent>
    </Card>
  );
}
