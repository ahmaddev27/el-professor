import { Badge, Button, Card, CardContent, CardHeader, CardTitle, DataTable, Field, NativeSelect, formatDate, formatEuroCents, type DataTableColumn } from '../ui';
import { useTranslation } from '../../contexts/LanguageContext';
import type { VehiclePlanSummary } from '../../utils/shiftRecommendation';
import { CONFIDENCE_KEYS, WEEKDAY_KEYS, filterShiftRows, formatDuration, timeLabel, type ShiftRow } from '../../utils/shiftRecommendationScreens';

const CONFIDENCE_TONE = { high: 'positive', medium: 'caution', low: 'neutral' } as const;

export function PerVehicleTable({ rows }: { rows: readonly VehiclePlanSummary[] }) {
  const { t } = useTranslation();
  const columns: DataTableColumn<VehiclePlanSummary>[] = [
    { id: 'vehicle', header: t('shiftrec.perVehicle.vehicle'), value: r => r.vehicle },
    { id: 'shifts', header: t('shiftrec.perVehicle.shifts'), kind: 'number', value: r => r.shifts },
    {
      id: 'hours', header: t('shiftrec.perVehicle.hours'), kind: 'number', value: r => r.minutes,
      cell: r => t('shiftrec.duration', { value: formatDuration(r.minutes) }),
    },
    {
      id: 'revenue', header: t('shiftrec.perVehicle.revenue'), kind: 'number', value: r => r.expectedRevenueCents,
      cell: r => formatEuroCents(r.expectedRevenueCents),
    },
    {
      id: 'rate', header: t('shiftrec.perVehicle.rate'), kind: 'number', hideBelow: 'sm', value: r => r.expectedRevenuePerHourCents,
      cell: r => (r.expectedRevenuePerHourCents === null ? t('shiftrec.kpi.none') : formatEuroCents(r.expectedRevenuePerHourCents)),
    },
    { id: 'second', header: t('shiftrec.perVehicle.second'), kind: 'number', hideBelow: 'md', value: r => r.daysWithSecondShift },
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('shiftrec.perVehicle.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <DataTable columns={columns} rows={rows} getRowId={r => r.vehicle} caption={t('shiftrec.perVehicle.title')} />
      </CardContent>
    </Card>
  );
}

interface ShiftTableProps {
  rows: readonly ShiftRow[];
  vehicles: readonly string[];
  vehicleFilter: string;
  onVehicleFilter: (vehicle: string) => void;
  onExport: () => void;
  /** The hour an operating day begins, for the sentence that explains "(+1)". */
  operatingDayStartHour: number;
}

export function ShiftTable({ rows, vehicles, vehicleFilter, onVehicleFilter, onExport, operatingDayStartHour }: ShiftTableProps) {
  const { t } = useTranslation();
  const visible = filterShiftRows(rows, vehicleFilter);
  const columns: DataTableColumn<ShiftRow>[] = [
    {
      id: 'date', header: t('shiftrec.shifts.date'), value: r => r.sortKey,
      cell: r => (
        <span className="inline-flex flex-wrap items-center gap-1.5 tabular-nums">
          {t(WEEKDAY_KEYS[r.dayType])} {formatDate(r.date)}
          {r.isHoliday ? <Badge tone="neutral">{t('shiftrec.shifts.holiday')}</Badge> : null}
        </span>
      ),
    },
    { id: 'vehicle', header: t('shiftrec.shifts.vehicle'), value: r => r.vehicle },
    {
      id: 'time', header: t('shiftrec.shifts.time'),
      cell: r => (
        <span className="whitespace-nowrap tabular-nums">
          {timeLabel(r.startTime, r.startsNextDay)} – {timeLabel(r.endTime, r.endsNextDay)}
        </span>
      ),
    },
    {
      id: 'duration', header: t('shiftrec.shifts.duration'), kind: 'number', hideBelow: 'sm', value: r => r.minutes,
      cell: r => t('shiftrec.duration', { value: formatDuration(r.minutes) }),
    },
    {
      id: 'revenue', header: t('shiftrec.shifts.revenue'), kind: 'number', value: r => r.expectedRevenueCents,
      cell: r => formatEuroCents(r.expectedRevenueCents),
    },
    {
      id: 'rate', header: t('shiftrec.shifts.rate'), kind: 'number', hideBelow: 'md', value: r => r.expectedRevenuePerHourCents,
      cell: r => formatEuroCents(r.expectedRevenuePerHourCents),
    },
    {
      id: 'evidence', header: t('shiftrec.shifts.evidence'), hideBelow: 'lg', value: r => r.evidenceDays,
      cell: r => t('shiftrec.shifts.evidenceDays', { count: r.evidenceDays }),
    },
    {
      id: 'confidence', header: t('shiftrec.shifts.confidence'), hideBelow: 'sm',
      cell: r => <Badge tone={CONFIDENCE_TONE[r.confidence]}>{t(CONFIDENCE_KEYS[r.confidence])}</Badge>,
    },
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('shiftrec.shifts.title')}</CardTitle>
        <Button
          variant="secondary"
          size="sm"
          disabled={visible.length === 0}
          onClick={onExport}
        >
          {t('shiftrec.export.button')}
        </Button>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-3">
        <Field label={t('shiftrec.shifts.filter')} className="sm:max-w-xs">
          <NativeSelect value={vehicleFilter} onChange={e => onVehicleFilter(e.target.value)}>
            <option value="">{t('shiftrec.shifts.allVehicles')}</option>
            {vehicles.map(v => <option key={v} value={v}>{v}</option>)}
          </NativeSelect>
        </Field>
        <p className="text-[13px] text-fg-subtle">
          {t('shiftrec.shifts.nextDayHint', { hour: String(operatingDayStartHour).padStart(2, '0') })}
        </p>
        <DataTable
          columns={columns}
          rows={visible}
          getRowId={r => r.id}
          caption={t('shiftrec.shifts.caption')}
          emptyState={<p className="py-6 text-center text-sm text-fg-muted">{t('shiftrec.shifts.empty')}</p>}
        />
      </CardContent>
    </Card>
  );
}
