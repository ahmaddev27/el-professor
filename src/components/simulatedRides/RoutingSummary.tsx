import { Alert, KpiCard } from '../ui';
import { useTranslation } from '../../contexts/LanguageContext';
import type { RoutingProvenance } from '../../utils/simulatedRides/fullMonth';
import type { RouteCheckSummary } from '../../utils/simulatedRides/routeCheck';

/**
 * How the drive times of a generated month were obtained, and what the route
 * check of the result found. An estimate is said to be one, in words, whatever
 * else the screen shows (decision 2 of 29.10.2026: never a silent fallback).
 */
interface Props {
  measured: boolean;
  source: string;
  routing: RoutingProvenance | null;
  summary: RouteCheckSummary;
}

export function RoutingSummary({ measured, source, routing, summary }: Props) {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-1 gap-3">
      {measured ? (
        <Alert tone="neutral" role="note" title={t('simrides.route.measured', { source })}>
          {routing
            ? t('simrides.route.provenance', {
                kept: routing.addressesKept ?? 0, checked: routing.addressesChecked ?? 0, pairs: routing.routedPairs, failed: routing.failedPairs,
              })
            : null}
        </Alert>
      ) : (
        <Alert tone="caution" role="note" title={t('simrides.route.estimate.title')}>{t('simrides.route.estimate.body', { source })}</Alert>
      )}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard label={t('simrides.route.fits')} value={String(summary.byStatus.route_fits)} />
        <KpiCard label={t('simrides.route.warnings')} value={String(summary.uniqueWarnings)} caption={t('simrides.route.warningsNote')} />
        <KpiCard label={t('simrides.route.unverifiable')} value={String(summary.byStatus.unverifiable)} />
        <KpiCard label={t('simrides.route.sameAddress')} value={String(summary.byStatus.same_address)} />
      </div>
    </div>
  );
}
