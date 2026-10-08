import { Card, CardContent, CardHeader, CardTitle, KpiCard, formatNumber } from '../../ui';
import { useTranslation } from '../../../contexts/LanguageContext';
import type { ReturnCheckResult } from '../../../utils/returnCheck';
import { ANOMALY_KEYS, ANOMALY_ORDER, PLACEMENT_KEYS, SUMMARY_PLACEMENT_ORDER } from '../../../utils/returnCheckScreens';

/** Counts per placement and per finding type; only ever rendered for a result that was calculated. */
export function ReturnCheckSummary({ result }: { result: ReturnCheckResult }) {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('returncheck.summary.title')}</CardTitle>
        <span className="text-[13px] text-fg-subtle tabular-nums">
          {t('returncheck.summary.rides', { count: formatNumber(result.checkedRides) })}
        </span>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {SUMMARY_PLACEMENT_ORDER.map(key => (
            <KpiCard key={key} label={t(PLACEMENT_KEYS[key])} value={formatNumber(result.counts.byPlacement[key])} />
          ))}
        </div>
        <div className="grid grid-cols-1 gap-2">
          <p className="text-[13px] font-medium text-fg-muted">{t('returncheck.summary.anomalies')}</p>
          <ul className="grid grid-cols-1 gap-1 text-sm text-fg-muted sm:grid-cols-2">
            {ANOMALY_ORDER.map(key => (
              <li key={key} className="flex items-baseline justify-between gap-3 border-b border-line py-1">
                <span>{t(ANOMALY_KEYS[key])}</span>
                <span className="font-semibold text-fg tabular-nums">{formatNumber(result.counts.byAnomaly[key])}</span>
              </li>
            ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}
