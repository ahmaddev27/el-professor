import { Download } from 'lucide-react';
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, KpiCard, formatEuroCents, formatNumber } from '../ui';
import { useTranslation } from '../../contexts/LanguageContext';
import type { FullMonthResult } from '../../utils/simulatedRides/fullMonth';
import { SimulatedBadge } from './SimulatedBadge';
import { RoutingSummary } from './RoutingSummary';

/**
 * The calendar-month report on screen. A month whose own read-back found a
 * violation is shown as an error and offers no download: a file is the thing
 * that gets passed on, so it must not exist for a month that broke a rule.
 */
interface Props {
  result: FullMonthResult;
  onDownload: () => void;
}

function decisionCounts(result: FullMonthResult) {
  const out = { accepted: 0, review: 0, excluded: 0 };
  for (const d of result.decisions) {
    if (d.outcome === 'accepted') out.accepted += d.count;
    else if (d.outcome === 'accepted_with_review') out.review += d.count;
    else out.excluded += d.count;
  }
  return out;
}

function ShareBlock({ result }: { result: FullMonthResult }) {
  const { t } = useTranslation();
  if (!result.share) return null;
  const { rate, result: share } = result.share;
  const parts = [
    t('simrides.cal.result.basisFares'),
    result.basis.includesTips ? t('simrides.cal.result.basisTips') : null,
    result.basis.includesDeclinedFees ? t('simrides.cal.result.basisFees') : null,
  ].filter(Boolean).join(', ');
  return (
    <div className="grid grid-cols-1 gap-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard label={t('simrides.cal.result.shareBasis')} value={formatEuroCents(share.basisCents)} caption={parts} />
        <KpiCard label={t('simrides.cal.result.shareRate')} value={`${formatNumber(rate.ratePercent, 2)} %`} />
        <KpiCard label={t('simrides.cal.result.shareAmount')} value={formatEuroCents(share.amountCents)} />
        <KpiCard label={t('simrides.cal.result.shareRemainder')} value={formatEuroCents(share.remainderCents)} caption={t('simrides.cal.result.shareRemainderNote')} />
      </div>
      <p className="text-xs text-fg-subtle">{t('simrides.cal.share.simulationOnly')}</p>
    </div>
  );
}

export function CalendarResult({ result, onDownload }: Props) {
  const { t } = useTranslation();
  const { counts } = result.revenue;
  const km = result.days.reduce((sum, d) => sum + d.km, 0);
  const decisions = decisionCounts(result);
  const broken = result.violations.length > 0;
  const declinedFees = result.revenue.declinedFeeCents + result.revenue.cancelledFeeCents;
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-3">
          <CardTitle>{t('simrides.cal.result.title')}</CardTitle>
          <SimulatedBadge />
        </div>
        <CardDescription>{t('simrides.cal.result.note')}</CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-4">
        {broken ? (
          <Alert tone="critical" title={t('simrides.cal.result.violations', { count: result.violations.length })}>
            <ul className="grid grid-cols-1 gap-1">{result.violations.map(v => <li key={v}>{v}</li>)}</ul>
          </Alert>
        ) : null}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <KpiCard label={t('simrides.cal.result.days')} value={String(result.days.length)}
            caption={t('simrides.cal.result.zeroDays', { count: result.days.filter(d => d.zeroRideDay).length })} />
          <KpiCard label={t('simrides.cal.result.orders')} value={String(counts.total)} />
          <KpiCard label={t('simrides.cal.result.completed')} value={String(counts.completed)} />
          <KpiCard label={t('simrides.cal.result.cancelled')} value={String(counts.cancelled)} />
          <KpiCard label={t('simrides.cal.result.declined')} value={String(counts.declined)}
            caption={t('simrides.cal.result.declinedFees', { amount: formatEuroCents(declinedFees) })} />
          <KpiCard label={t('simrides.cal.result.fares')} value={formatEuroCents(result.revenue.fareCents)} />
          <KpiCard label={t('simrides.cal.result.tips')} value={formatEuroCents(result.revenue.tipCents)} />
          <KpiCard label={t('simrides.cal.result.km')} value={formatNumber(km, 1)} />
        </div>
        <ShareBlock result={result} />
        <RoutingSummary measured={result.provenance.travel.measured} source={result.provenance.travel.source}
          routing={result.provenance.routing} summary={result.routeSummary} />
        <div className="grid grid-cols-3 gap-3">
          <KpiCard label={t('simrides.cal.result.accepted')} value={String(decisions.accepted)} />
          <KpiCard label={t('simrides.cal.result.review')} value={String(decisions.review)} />
          <KpiCard label={t('simrides.cal.result.excluded')} value={String(decisions.excluded)} />
        </div>
        <div>
          <Button onClick={onDownload} disabled={broken}>
            <Download aria-hidden /> {t('simrides.cal.result.download')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
