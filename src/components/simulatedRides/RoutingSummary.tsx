import { Alert, KpiCard } from '../ui';
import { useTranslation } from '../../contexts/LanguageContext';
import type { RoutingProvenance } from '../../utils/simulatedRides/fullMonth';
import type { RouteCheckSummary } from '../../utils/simulatedRides/routeCheck';

/**
 * How the drive times of a generated month were obtained, and what the route
 * check of the result found. An estimate is said to be one, in words, whatever
 * else the screen shows (decision 2 of 29.10.2026: never a silent fallback).
 *
 * Round 6: a month built on the estimate shows **no** route counters at all,
 * because "0 conflicts, 0 unverifiable" on a month nobody routed reads as
 * safe. It shows how many pairs were only estimated instead.
 */
interface Props {
  measured: boolean;
  source: string;
  routing: RoutingProvenance | null;
  summary: RouteCheckSummary;
}

export function RoutingSummary({ measured, source, routing, summary }: Props) {
  const { t } = useTranslation();
  if (!measured) {
    return (
      <div className="grid grid-cols-1 gap-3">
        <Alert tone="caution" role="note" title={t('simrides.route.estimate.title')}>
          {t('simrides.route.estimate.body', { source })} {t('simrides.route.estimate.notVerified', { count: summary.byStatus.ESTIMATE_ONLY })}
        </Alert>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-3">
      <Alert tone="neutral" role="note" title={t('simrides.route.measured', { source })}>
        {routing
          ? t('simrides.route.provenance', {
              kept: routing.addressesKept ?? 0, checked: routing.addressesChecked ?? 0, pairs: routing.routedPairs, failed: routing.failedPairs,
            })
          : null}
      </Alert>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard label={t('simrides.route.verified')} value={String(summary.byStatus.ROUTE_VERIFIED)} />
        <KpiCard label={t('simrides.route.conflicts')} value={String(summary.uniqueConflicts)} caption={t('simrides.route.perPair')} />
        <KpiCard label={t('simrides.route.unverifiable')} value={String(summary.uniqueUnverifiable)} caption={t('simrides.route.perPair')} />
        <KpiCard label={t('simrides.route.sameAddress')} value={String(summary.sameAddress)} />
      </div>
    </div>
  );
}
