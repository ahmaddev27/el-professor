import { Card, CardContent, CardHeader, CardTitle, formatEuroCents, formatNumber, formatPercent } from '../ui';
import { useTranslation } from '../../contexts/LanguageContext';
import type { ReferenceStats } from '../../utils/shiftRecommendationReference';
import { MONTH_NAME_KEYS } from '../../utils/shiftRecommendationScreens';

/**
 * What the chosen history months look like, measured from their rows: the
 * months and their row counts, the split between cash and online payment, the
 * tip share and the cancellation share. None of it is typed in.
 */
export function ReferencePanel({ stats }: { stats: ReferenceStats }) {
  const { t } = useTranslation();
  const percent = (ratio: number | null) => (ratio === null ? t('shiftrec.kpi.none') : formatPercent(ratio));
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('shiftrec.ref.title')}</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-4">
        <p className="text-[13px] text-fg-subtle">{t('shiftrec.ref.note')}</p>
        <ul className="grid grid-cols-1 gap-1 text-sm text-fg-muted sm:grid-cols-2 lg:grid-cols-3">
          {stats.months.map(m => (
            <li key={`${m.year}-${m.month}`} className="tabular-nums">
              {t('shiftrec.ref.monthRow', {
                month: `${t(MONTH_NAME_KEYS[m.month - 1])} ${m.year}`,
                rows: formatNumber(m.rows),
              })}
            </li>
          ))}
        </ul>
        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label={`${t('shiftrec.ref.payment')}: ${t('shiftrec.ref.cash')}`}
            value={stats.cashShare === null ? t('shiftrec.ref.noPayment') : `${percent(stats.cashShare)} · ${formatEuroCents(stats.cashCents)}`}
          />
          <Stat
            label={`${t('shiftrec.ref.payment')}: ${t('shiftrec.ref.online')}`}
            value={stats.onlineShare === null ? t('shiftrec.ref.noPayment') : `${percent(stats.onlineShare)} · ${formatEuroCents(stats.onlineCents)}`}
          />
          <Stat label={t('shiftrec.ref.tip')} value={`${percent(stats.tipShare)} · ${formatEuroCents(stats.tipCents)}`} />
          <Stat label={t('shiftrec.ref.cancel')} value={`${percent(stats.cancellationShare)} · ${formatNumber(stats.cancelledRows)}`} />
        </dl>
        {stats.unreadableRows > 0 ? (
          <p className="text-[13px] text-caution">{t('shiftrec.ref.unreadable', { count: formatNumber(stats.unreadableRows) })}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[13px] text-fg-subtle">{label}</dt>
      <dd className="font-semibold tabular-nums text-fg">{value}</dd>
    </div>
  );
}
