import { useMemo } from 'react';
import { Download } from 'lucide-react';
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, KpiCard, formatEuroCents, formatNumber } from '../ui';
import { useTranslation } from '../../contexts/LanguageContext';
import type { TranslationKey } from '../../i18n';
import type { FullMonthResult } from '../../utils/simulatedRides/fullMonth';
import { verifyMonth, type CheckOutcome, type ExportVerdict, type VerificationCheck } from '../../utils/simulatedRides/monthVerification';
import { SimulatedBadge } from './SimulatedBadge';
import { RoutingSummary } from './RoutingSummary';

/**
 * The calendar-month report on screen. A month whose own read-back found a
 * violation is shown as an error and offers no download: a file is the thing
 * that gets passed on, so it must not exist for a month that broke a rule.
 *
 * Round 6 keeps two answers apart that used to read as one: whether the month
 * was **generated** (its rules held) and whether it is **validated for
 * export** (every mandatory check passed, routes included). A month built on
 * the straight-line estimate is generated and never validated, and the screen
 * says which checks could not be made. The declined orders and the empty
 * drives are counted here as what they are — internal, in the operational
 * report — and never beside the Fahrtenbuch's own figures.
 */
interface Props {
  result: FullMonthResult;
  onDownload: () => void;
  onDownloadOperational: () => void;
}

const VERDICT_TONE: Record<ExportVerdict, 'positive' | 'caution' | 'critical'> = {
  VALIDATED_FOR_EXPORT: 'positive',
  VERIFICATION_INCOMPLETE: 'caution',
  NOT_VALIDATED: 'critical',
};

const VERDICT_KEY: Record<ExportVerdict, TranslationKey> = {
  VALIDATED_FOR_EXPORT: 'simrides.cal.verdict.validated',
  VERIFICATION_INCOMPLETE: 'simrides.cal.verdict.incomplete',
  NOT_VALIDATED: 'simrides.cal.verdict.notValidated',
};

const CHECK_KEY: Record<VerificationCheck['code'], TranslationKey> = {
  rules: 'simrides.cal.check.code.rules',
  shift_limits: 'simrides.cal.check.code.shiftLimits',
  routing_measured: 'simrides.cal.check.code.routingMeasured',
  route_pairs: 'simrides.cal.check.code.routePairs',
  repositioning: 'simrides.cal.check.code.repositioning',
  declined_not_exported: 'simrides.cal.check.code.declinedNotExported',
  reconciliation: 'simrides.cal.check.code.reconciliation',
  amounts_readable: 'simrides.cal.check.code.amountsReadable',
  events_reviewed: 'simrides.cal.check.code.eventsReviewed',
  monthly_share: 'simrides.cal.check.code.monthlyShare',
};

const OUTCOME_KEY: Record<CheckOutcome, TranslationKey> = {
  passed: 'simrides.cal.check.passed',
  failed: 'simrides.cal.check.failed',
  not_verified: 'simrides.cal.check.notVerified',
};

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
    result.basis.includesCancellationFees ? t('simrides.cal.result.basisCancellationFees') : null,
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

function VerificationBlock({ result }: { result: FullMonthResult }) {
  const { t } = useTranslation();
  const verification = useMemo(() => verifyMonth(result), [result]);
  return (
    <Alert tone={VERDICT_TONE[verification.verdict]} title={`${verification.verdict}: ${t(VERDICT_KEY[verification.verdict])}`}>
      <p>{verification.generated ? t('simrides.cal.verdict.generated') : t('simrides.cal.verdict.notGenerated')}</p>
      <ul className="mt-2 grid grid-cols-1 gap-1">
        {verification.checks.map(c => (
          <li key={c.code}>
            <span className="font-medium text-fg">{t(OUTCOME_KEY[c.outcome])}</span> {t(CHECK_KEY[c.code])}: {c.detail}
          </li>
        ))}
      </ul>
    </Alert>
  );
}

function RepositioningBlock({ result }: { result: FullMonthResult }) {
  const { t } = useTranslation();
  const r = result.repositioningSummary;
  const share = r.withRoute === 0 ? 0 : (100 * r.preferredWindow) / r.withRoute;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <KpiCard label={t('simrides.cal.legs.count')} value={String(r.legs)} caption={t('simrides.cal.legs.internal')} />
      <KpiCard label={t('simrides.cal.legs.preferred')} value={`${formatNumber(share, 1)} %`}
        caption={t('simrides.cal.legs.preferredOf', { count: r.preferredWindow, total: r.withRoute })} />
      <KpiCard label={t('simrides.cal.legs.km')} value={formatNumber(r.roadKm, 1)} />
      <KpiCard label={t('simrides.cal.legs.longest')} value={r.longestSeconds === null ? '—' : formatNumber(r.longestSeconds / 60, 1)}
        caption={t('simrides.cal.legs.minutes')} />
    </div>
  );
}

export function CalendarResult({ result, onDownload, onDownloadOperational }: Props) {
  const { t } = useTranslation();
  const { counts } = result.revenue;
  const km = result.days.reduce((sum, d) => sum + d.km, 0);
  const decisions = decisionCounts(result);
  const broken = result.violations.length > 0;
  const declined = result.internal.declined;
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
        <VerificationBlock result={result} />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <KpiCard label={t('simrides.cal.result.days')} value={String(result.days.length)}
            caption={t('simrides.cal.result.zeroDays', { count: result.days.filter(d => d.zeroRideDay).length })} />
          <KpiCard label={t('simrides.cal.result.rides')} value={String(counts.completed + counts.cancelled)} />
          <KpiCard label={t('simrides.cal.result.completed')} value={String(counts.completed)} />
          <KpiCard label={t('simrides.cal.result.cancelled')} value={String(counts.cancelled)}
            caption={t('simrides.cal.result.cancellationFees', { amount: formatEuroCents(result.revenue.cancelledFeeCents) })} />
          <KpiCard label={t('simrides.cal.result.fares')} value={formatEuroCents(result.revenue.fareCents)} />
          <KpiCard label={t('simrides.cal.result.tips')} value={formatEuroCents(result.revenue.tipCents)} />
          <KpiCard label={t('simrides.cal.result.km')} value={formatNumber(km, 1)} />
          <KpiCard label={t('simrides.cal.result.declinedInternal')} value={String(declined.counts.declined)}
            caption={t('simrides.cal.result.declinedInternalFees', { amount: formatEuroCents(declined.declinedFeeCents) })} />
        </div>
        <ShareBlock result={result} />
        <RoutingSummary measured={result.provenance.travel.measured} source={result.provenance.travel.source}
          routing={result.provenance.routing} summary={result.routeSummary} />
        <RepositioningBlock result={result} />
        <div className="grid grid-cols-3 gap-3">
          <KpiCard label={t('simrides.cal.result.accepted')} value={String(decisions.accepted)} />
          <KpiCard label={t('simrides.cal.result.review')} value={String(decisions.review)} />
          <KpiCard label={t('simrides.cal.result.excluded')} value={String(decisions.excluded)} />
        </div>
        <div className="flex flex-wrap gap-3">
          <Button onClick={onDownload} disabled={broken}>
            <Download aria-hidden /> {t('simrides.cal.result.download')}
          </Button>
          <Button variant="secondary" onClick={onDownloadOperational} disabled={broken}>
            <Download aria-hidden /> {t('simrides.cal.result.downloadOperational')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
