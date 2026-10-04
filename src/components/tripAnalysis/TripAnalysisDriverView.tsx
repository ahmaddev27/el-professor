import { useMemo } from 'react';
import { Activity, Blocks, CalendarClock, Gauge, UserRound } from 'lucide-react';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DataTable,
  EmptyState,
  Field,
  KpiCard,
  NativeSelect,
  type DataTableColumn,
} from '../ui';
import { useTranslation } from '../../contexts/LanguageContext';
import type { AnalysisShift, BudgetResult, TripAnalysisResult, TripBlock } from '../../utils/tripAnalysis/types';
import {
  driverTimeline,
  formatBerlinDateTime,
  type BudgetRow,
  type CompanyDriver,
  type DriverTableRow,
  type TimelineSegment,
} from '../../lib/tripAnalysisView';
import { formatHours, formatMinutesAsHours } from '../../lib/tripAnalysisFormat';
import { START_REASON_KEYS } from '../../lib/tripAnalysisLabels';
import { TripAnalysisBudgetCard } from './TripAnalysisBudgetCard';
import { TripAnalysisIssues } from './TripAnalysisIssues';
import { TripAnalysisTimeline } from './TripAnalysisTimeline';
import type { TripEvidence } from './TripEvidenceSheet';

const MS_PER_HOUR = 3_600_000;

interface Props {
  result: TripAnalysisResult;
  shifts: readonly AnalysisShift[];
  driverRows: readonly DriverTableRow[];
  drivers: readonly CompanyDriver[];
  budgetRows: readonly BudgetRow[];
  selectedDriverId: string | null;
  onSelectDriver: (driverId: string) => void;
  canEdit: boolean;
  onSaveReserve: (driverId: string, hours: number | null) => Promise<boolean>;
  onConfirmBudget: (driverId: string) => Promise<boolean>;
  onShowTrips: (evidence: TripEvidence) => void;
}

/**
 * One driver's month: the figures, the budget, the timeline, the blocks the
 * trips form and the findings about them. Every figure opens the trips behind
 * it; nothing here changes a trip.
 */
export function TripAnalysisDriverView({
  result,
  shifts,
  driverRows,
  drivers,
  budgetRows,
  selectedDriverId,
  onSelectDriver,
  canEdit,
  onSaveReserve,
  onConfirmBudget,
  onShowTrips,
}: Props) {
  const { t } = useTranslation();

  const row = driverRows.find(candidate => candidate.driverId === selectedDriverId) ?? null;
  const driver = drivers.find(candidate => candidate.id === selectedDriverId);
  const budgetRow = budgetRows.find(candidate => candidate.driver_id === selectedDriverId);
  const analysis = result.drivers.find(candidate => candidate.driverId === selectedDriverId) ?? null;
  const budget: BudgetResult | null = analysis?.budget ?? null;

  const days = useMemo(
    () => (selectedDriverId ? driverTimeline(result, selectedDriverId, shifts) : []),
    [result, selectedDriverId, shifts],
  );
  const blocks = useMemo(
    () => result.blocks.filter(block => block.driverId === selectedDriverId),
    [result.blocks, selectedDriverId],
  );
  const issues = useMemo(
    () => result.issues.filter(issue => issue.driverId === selectedDriverId),
    [result.issues, selectedDriverId],
  );
  const driverNames = useMemo(
    () => new Map(driverRows.map(candidate => [candidate.driverId, candidate.name])),
    [driverRows],
  );

  const picker = (
    <Field label={t('ta.driver.choose')}>
      <NativeSelect
        value={selectedDriverId ?? ''}
        onChange={event => onSelectDriver(event.target.value)}
        containerClassName="max-w-sm"
      >
        <option value="">{t('ta.driver.choose')}</option>
        {driverRows.map(option => (
          <option key={option.driverId} value={option.driverId}>
            {option.name}
          </option>
        ))}
      </NativeSelect>
    </Field>
  );

  if (!row || !analysis) {
    return (
      <div className="grid grid-cols-1 gap-4">
        {picker}
        <EmptyState icon={UserRound} title={t('ta.driver.empty')} />
      </div>
    );
  }

  const blockColumns: DataTableColumn<TripBlock>[] = [
    {
      id: 'start',
      header: t('ta.col.start'),
      value: block => block.startMs,
      sortable: true,
      className: 'pl-3 pr-2 sm:px-4',
      cell: block => <span className="block py-1 tabular-nums">{formatBerlinDateTime(block.startMs)}</span>,
    },
    {
      id: 'end',
      header: t('ta.col.end'),
      hideBelow: 'sm',
      cell: block => <span className="tabular-nums">{formatBerlinDateTime(block.endMs)}</span>,
    },
    { id: 'vehicle', header: t('ta.col.vehicle'), value: block => block.vehicle ?? '', hideBelow: 'md' },
    {
      id: 'span',
      header: t('ta.col.span'),
      kind: 'number',
      cell: block => <span className="tabular-nums">{formatHours(block.metrics.spanMs / MS_PER_HOUR)}</span>,
    },
    {
      id: 'trips',
      header: t('ta.col.trips'),
      kind: 'number',
      className: 'pl-2 pr-3 sm:px-4',
      cell: block => (
        <Button
          variant="link"
          className="tabular-nums"
          onClick={() => onShowTrips({ label: `${row.name} · ${t('ta.col.block')} ${block.index + 1}`, tripIds: block.tripIds })}
        >
          {block.tripIds.length}
        </Button>
      ),
    },
    {
      id: 'reason',
      header: t('ta.col.startReason'),
      hideBelow: 'lg',
      cell: block => t(START_REASON_KEYS[block.startReason]),
    },
  ];

  return (
    <div className="grid grid-cols-1 gap-4">
      {picker}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label={t('ta.kpi.activity')}
          value={formatHours(row.activityHours)}
          icon={Activity}
          caption={t('ta.kpi.activityCaption')}
        />
        <KpiCard
          label={t('ta.kpi.shifts')}
          value={row.shiftHours === null ? t('ta.kpi.noShiftsShort') : formatHours(row.shiftHours)}
          icon={CalendarClock}
          caption={t('ta.kpi.shiftsCaption')}
        />
        <KpiCard
          label={t('ta.kpi.cap')}
          value={row.capHours === null ? t('ta.notComputable') : formatHours(row.capHours)}
          icon={Gauge}
          caption={t('ta.kpi.capCaption')}
        />
        <KpiCard
          label={t('ta.col.overBudget')}
          value={
            row.overByMinutes === null
              ? t('ta.notComputable')
              : row.overByMinutes > 0
                ? t('ta.kpi.overBudget', { value: formatMinutesAsHours(row.overByMinutes) })
                : t('ta.kpi.remaining', { value: formatMinutesAsHours(row.remainingMinutes ?? 0) })
          }
          icon={Gauge}
          caption={t('ta.kpi.overBudgetCaption')}
        />
      </div>

      <TripAnalysisBudgetCard
        row={row}
        driver={driver}
        budgetRow={budgetRow}
        budget={budget}
        state={row.budgetState}
        canEdit={canEdit}
        onSaveReserve={hours => onSaveReserve(row.driverId, hours)}
        onConfirm={() => onConfirmBudget(row.driverId)}
      />

      <TripAnalysisTimeline
        days={days}
        onSelect={(segment: TimelineSegment) =>
          onShowTrips({
            label: `${row.name} · ${formatBerlinDateTime(segment.startMs)}`,
            tripIds: tripIdsOfSegment(result, segment),
          })
        }
      />

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Blocks aria-hidden className="size-4 text-fg-subtle" />
            <CardTitle>{t('ta.blocks.title')}</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <DataTable
            caption={t('ta.blocks.title')}
            columns={blockColumns}
            rows={blocks}
            getRowId={block => block.id}
            density="compact"
            emptyState={<EmptyState size="sm" icon={Blocks} title={t('ta.blocks.empty')} />}
          />
        </CardContent>
      </Card>

      <TripAnalysisIssues issues={issues} driverNames={driverNames} onShowTrips={onShowTrips} singleDriver />
    </div>
  );
}

/** The trips a timeline mark stands for: a trip itself, a block's, or a finding's evidence. */
function tripIdsOfSegment(result: TripAnalysisResult, segment: TimelineSegment): string[] {
  if (segment.lane === 'trip') return [segment.refId];
  if (segment.lane === 'block') return [...(result.blocks.find(block => block.id === segment.refId)?.tripIds ?? [])];
  if (segment.lane === 'issue') return [...(result.issues.find(issue => issue.id === segment.refId)?.tripIds ?? [])];
  // A shift is a Stundennachweis line: the analysis has no trip behind it.
  return [];
}
