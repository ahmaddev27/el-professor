import { AlertOctagon, ChevronRight, ListChecks, Rows3, UserX, Wallet } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DataTable,
  EmptyState,
  formatNumber,
  KpiCard,
  type DataTableColumn,
} from '../ui';
import { useTranslation } from '../../contexts/LanguageContext';
import type { TranslationKey } from '../../i18n';
import type { CheckTally, PriceTotal, TripAnalysisResult } from '../../utils/tripAnalysis/types';
import type { DriverTableRow, UnlinkedDriver } from '../../lib/tripAnalysisView';
import { formatHours, formatMinutesAsHours, formatPriceTotal, formatStoredEuro } from '../../lib/tripAnalysisFormat';
import { ISSUE_STATUS_KEYS } from '../../lib/tripAnalysisLabels';
import { BudgetStateBadge } from './TripAnalysisBadges';
import type { TripEvidence } from './TripEvidenceSheet';

interface Props {
  result: TripAnalysisResult;
  driverRows: readonly DriverTableRow[];
  unlinked: readonly UnlinkedDriver[];
  fares: readonly PriceTotal[];
  onShowTrips: (evidence: TripEvidence) => void;
  onOpenDriver: (driverId: string) => void;
}

const CHECKS: Array<{ key: keyof TripAnalysisResult['checks']; label: TranslationKey }> = [
  { key: 'driverOverlap', label: 'ta.check.driverOverlap' },
  { key: 'vehicleOverlap', label: 'ta.check.vehicleOverlap' },
  { key: 'travelGap', label: 'ta.check.travelGap' },
  { key: 'shiftCoverage', label: 'ta.check.shiftCoverage' },
  { key: 'budget', label: 'ta.check.budget' },
];

function TallyBadges({ tally }: { tally: CheckTally }) {
  const { t } = useTranslation();
  return (
    <span className="flex flex-wrap gap-1.5">
      <Badge tone="positive">{t('ta.statusCount', { label: t(ISSUE_STATUS_KEYS.passed), count: tally.passed })}</Badge>
      <Badge tone="critical">{t('ta.statusCount', { label: t(ISSUE_STATUS_KEYS.conflict), count: tally.conflict })}</Badge>
      <Badge tone="caution">{t('ta.statusCount', { label: t(ISSUE_STATUS_KEYS.unverifiable), count: tally.unverifiable })}</Badge>
    </span>
  );
}

/** A figure that opens the trips behind it. */
function TripsLink({ label, value, tripIds, onShowTrips }: {
  label: string;
  value: string;
  tripIds: readonly string[];
  onShowTrips: (evidence: TripEvidence) => void;
}) {
  const { t } = useTranslation();
  if (tripIds.length === 0) return <span className="tabular-nums">{value}</span>;
  return (
    <Button
      variant="link"
      className="tabular-nums"
      aria-label={`${value} — ${t('ta.showTrips')}: ${label}`}
      onClick={() => onShowTrips({ label, tripIds })}
    >
      {value}
    </Button>
  );
}

export function TripAnalysisOverview({ result, driverRows, unlinked, fares, onShowTrips, onOpenDriver }: Props) {
  const { t, tPlural } = useTranslation();
  const conflicts = result.issues.filter(issue => issue.status === 'conflict').length;
  const unverifiable = result.issues.filter(issue => issue.status === 'unverifiable').length;
  const driversById = new Map(result.drivers.map(driver => [driver.driverId, driver]));
  const dash = <span className="text-fg-subtle">—</span>;

  const hours = (value: number | null, missing: string) =>
    value === null ? <span className="text-fg-subtle">{missing}</span> : <span className="tabular-nums">{formatHours(value)}</span>;

  const columns: DataTableColumn<DriverTableRow>[] = [
    {
      id: 'driver',
      header: t('ta.col.driver'),
      value: row => row.name,
      sortable: true,
      className: 'pl-3 pr-2 sm:px-4',
      cell: row => (
        <span className="block py-1">
          <Button variant="link" onClick={() => onOpenDriver(row.driverId)} aria-label={t('ta.openDriver', { name: row.name })}>
            {row.name}
            <ChevronRight aria-hidden />
          </Button>
          <span className="mt-1 flex flex-wrap gap-1">
            {row.linked ? <BudgetStateBadge state={row.budgetState} /> : <Badge tone="caution">{t('ta.notLinked')}</Badge>}
          </span>
        </span>
      ),
    },
    {
      id: 'salary',
      header: t('ta.col.salary'),
      hideBelow: 'lg',
      cell: row => {
        const min = formatStoredEuro(row.salaryMin);
        const max = formatStoredEuro(row.salaryMax);
        return min || max ? <span className="whitespace-nowrap tabular-nums">{min ?? '—'} – {max ?? '—'}</span> : dash;
      },
    },
    {
      id: 'rate',
      header: t('ta.col.hourlyRate'),
      hideBelow: 'lg',
      kind: 'number',
      cell: row => formatStoredEuro(row.hourlyRate) ?? dash,
    },
    {
      id: 'range',
      header: t('ta.col.hoursRange'),
      hideBelow: 'md',
      kind: 'number',
      cell: row =>
        row.hoursMin === null || row.hoursMax === null ? (
          <span className="text-fg-subtle">{t('ta.notComputable')}</span>
        ) : (
          <span className="tabular-nums">{t('ta.hoursRange', { min: formatNumber(row.hoursMin, 2), max: formatNumber(row.hoursMax, 2) })}</span>
        ),
    },
    { id: 'reserve', header: t('ta.col.reserve'), hideBelow: 'md', kind: 'number', cell: row => hours(row.reservedHours, t('ta.notSetShort')) },
    { id: 'cap', header: t('ta.col.cap'), hideBelow: 'md', kind: 'number', cell: row => hours(row.capHours, t('ta.notComputable')) },
    {
      id: 'shifts',
      header: t('ta.col.shifts'),
      hideBelow: 'sm',
      kind: 'number',
      value: row => row.shiftHours,
      sortable: true,
      cell: row => hours(row.shiftHours, t('ta.kpi.noShifts')),
    },
    {
      id: 'activity',
      header: t('ta.col.activity'),
      kind: 'number',
      value: row => row.activityHours,
      sortable: true,
      className: 'px-2 sm:px-4',
      cell: row => (
        <TripsLink
          label={`${row.name} · ${t('ta.col.activity')}`}
          value={formatHours(row.activityHours)}
          tripIds={driversById.get(row.driverId)?.analysedTripIds ?? []}
          onShowTrips={onShowTrips}
        />
      ),
    },
    {
      id: 'over',
      header: t('ta.col.overBudget'),
      kind: 'number',
      value: row => row.overByMinutes,
      sortable: true,
      className: 'pl-2 pr-3 sm:px-4',
      cell: row =>
        row.overByMinutes === null ? (
          <span className="text-fg-subtle">{t('ta.notComputable')}</span>
        ) : row.overByMinutes > 0 ? (
          <Badge tone="critical">
            <AlertOctagon aria-hidden />
            {formatMinutesAsHours(row.overByMinutes)}
          </Badge>
        ) : (
          <span className="tabular-nums text-fg-muted">{formatMinutesAsHours(0)}</span>
        ),
    },
    {
      id: 'remaining',
      header: t('ta.col.remaining'),
      hideBelow: 'lg',
      kind: 'number',
      cell: row => (row.remainingMinutes === null ? dash : <span className="tabular-nums">{formatMinutesAsHours(row.remainingMinutes)}</span>),
    },
    {
      id: 'fares',
      header: t('ta.col.fares'),
      hideBelow: 'md',
      kind: 'number',
      cell: row =>
        row.fares.length === 0 ? (
          dash
        ) : (
          <span className="grid gap-0.5">
            {row.fares.map(total => (
              <span key={String(total.currency)} className="whitespace-nowrap tabular-nums">{formatPriceTotal(total)}</span>
            ))}
          </span>
        ),
    },
    {
      id: 'findings',
      header: t('ta.col.findings'),
      hideBelow: 'sm',
      cell: row => (
        <span className="flex flex-wrap gap-1">
          {row.conflictCount > 0 ? <Badge tone="critical">{row.conflictCount}</Badge> : null}
          {row.unverifiableCount > 0 ? <Badge tone="caution">{row.unverifiableCount}</Badge> : null}
          {row.conflictCount === 0 && row.unverifiableCount === 0 ? dash : null}
          <span className="sr-only">{t('ta.findingsCount', { conflict: row.conflictCount, unverifiable: row.unverifiableCount })}</span>
        </span>
      ),
    },
  ];

  const reviewIds = result.reviewTripIds;

  return (
    <div className="grid grid-cols-1 gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label={t('ta.kpi.rows')}
          value={formatNumber(result.counts.rows)}
          icon={Rows3}
          caption={t('ta.kpi.rowsCaption', {
            completed: result.counts.byStatus.completed,
            cancelled: result.counts.byStatus.cancelled,
            unknown: result.counts.byStatus.unknown,
          })}
        />
        <KpiCard
          label={t('ta.kpi.review')}
          value={
            <TripsLink label={t('ta.kpi.review')} value={formatNumber(reviewIds.length)} tripIds={reviewIds} onShowTrips={onShowTrips} />
          }
          icon={ListChecks}
          caption={t('ta.kpi.reviewCaption')}
        />
        <KpiCard
          label={t('ta.kpi.conflicts')}
          value={<span className={conflicts > 0 ? 'text-critical' : undefined}>{formatNumber(conflicts)}</span>}
          icon={AlertOctagon}
          caption={t('ta.kpi.conflictsCaption', { unverifiable })}
        />
        <KpiCard
          label={t('ta.kpi.fares')}
          value={fares.length === 0 ? '—' : fares.map(formatPriceTotal).join(' · ')}
          icon={Wallet}
          caption={t('ta.kpi.faresCaption')}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('ta.checks.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {CHECKS.map(check => (
              <div key={check.key} className="grid gap-1.5">
                <dt className="text-[13px] font-medium text-fg-muted">{t(check.label)}</dt>
                <dd>
                  <TallyBadges tally={result.checks[check.key]} />
                </dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>

      {unlinked.length > 0 ? (
        <Alert tone="caution" icon={UserX} title={t('ta.unlinked.title')}>
          <p>{t('ta.unlinked.body')}</p>
          <ul className="mt-2 grid gap-1">
            {unlinked.map(group => (
              <li key={`${group.driverId ?? ''}|${group.name}`} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-semibold text-fg">{group.name || t('ta.unlinked.noName')}</span>
                <Badge tone="caution">{group.driverId === null ? t('ta.unlinked.noId') : t('ta.unlinked.unknownId')}</Badge>
                <Button
                  variant="link"
                  onClick={() => onShowTrips({ label: group.name || t('ta.unlinked.noName'), tripIds: group.tripIds })}
                >
                  {tPlural({ one: 'ta.trips.one', other: 'ta.trips.other' }, group.tripIds.length)}
                </Button>
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}

      <section aria-labelledby="ta-drivers" className="grid grid-cols-1 gap-3 pt-2">
        <div className="flex flex-col gap-1">
          <h2 id="ta-drivers" className="text-[15px] font-semibold text-fg">{t('ta.drivers.title')}</h2>
          <p className="text-xs text-fg-subtle">
            {t('ta.shiftsSource')} · {t('ta.faresSeparate')}
          </p>
        </div>
        <DataTable
          caption={t('ta.drivers.title')}
          columns={columns}
          rows={driverRows}
          getRowId={row => row.driverId}
          initialSort={{ columnId: 'driver', direction: 'asc' }}
          emptyState={<EmptyState size="sm" icon={UserX} title={t('ta.drivers.empty')} />}
        />
      </section>
    </div>
  );
}
