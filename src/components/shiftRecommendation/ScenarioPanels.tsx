import { useMemo } from 'react';
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, DataTable, formatDate, formatEuroCents, formatNumber, formatPercent, type DataTableColumn } from '../ui';
import { useTranslation } from '../../contexts/LanguageContext';
import { useColumnPickerExport } from '../../contexts/ExportPickerContext';
import type { ShiftRecommendation } from '../../utils/shiftRecommendation';
import {
  dailyExportOptions,
  dailyVehicleTable,
  tripCrossCheck,
  type DailyExportLabels,
  type DailyVehicleRow,
  type Scenario,
} from '../../utils/shiftRecommendationScenario';
import { MONTH_NAME_KEYS, WEEKDAY_KEYS, minutesToHours } from '../../utils/shiftRecommendationScreens';

const money = (cents: number | null, none: string) => (cents === null ? none : formatEuroCents(cents));

/** The operator's ride count against the revenue target; absent when none was given. */
export function TripCrossCheckAlert({ scenario, referenceRevenueCents }: { scenario: Scenario; referenceRevenueCents: number }) {
  const { t } = useTranslation();
  if (scenario.targetTrips === null) return null;
  const check = tripCrossCheck(scenario, referenceRevenueCents);
  if (check === null) return <Alert tone="caution" title={t('shiftrec.cross.title')}>{t('shiftrec.cross.noFare')}</Alert>;
  const vars = {
    trips: formatNumber(check.targetTrips),
    fare: formatEuroCents(scenario.averageFareCents ?? 0),
    implied: formatEuroCents(check.impliedRevenueCents),
    reference: formatEuroCents(check.referenceRevenueCents),
    diff: formatEuroCents(Math.abs(check.differenceCents)),
    percent: check.differenceShare === null ? '–' : formatPercent(Math.abs(check.differenceShare)),
  };
  const key = !check.material ? 'shiftrec.cross.agree' : check.differenceCents > 0 ? 'shiftrec.cross.more' : 'shiftrec.cross.less';
  return <Alert tone={check.material ? 'caution' : 'brand'} title={t('shiftrec.cross.title')}>{t(key, vars)}</Alert>;
}

/** One row per vehicle and operating day. Every figure after the plan's own sums is an estimate and says so. */
export function DailyVehicleCard({ recommendation, scenario }: { recommendation: ShiftRecommendation; scenario: Scenario }) {
  const { t } = useTranslation();
  const exportPicker = useColumnPickerExport();
  const table = useMemo(() => dailyVehicleTable(recommendation, scenario), [recommendation, scenario]);
  const none = t('shiftrec.kpi.none');
  const hours = (minutes: number) => t('shiftrec.kpi.hours', { value: formatNumber(minutesToHours(minutes), 2) });
  const columns: DataTableColumn<DailyVehicleRow>[] = [
    {
      id: 'date', header: t('shiftrec.shifts.date'), value: r => r.date,
      cell: r => (
        <span className="inline-flex flex-wrap items-center gap-1.5 tabular-nums">
          {t(WEEKDAY_KEYS[r.dayType])} {formatDate(r.date)}
          {r.isHoliday ? <Badge tone="neutral">{t('shiftrec.shifts.holiday')}</Badge> : null}
        </span>
      ),
    },
    { id: 'vehicle', header: t('shiftrec.shifts.vehicle'), value: r => r.vehicle },
    { id: 'shifts', header: t('shiftrec.daily.shifts'), kind: 'number', hideBelow: 'sm', value: r => r.shifts },
    { id: 'hours', header: t('shiftrec.daily.hours'), kind: 'number', hideBelow: 'sm', value: r => r.minutes, cell: r => hours(r.minutes) },
    { id: 'revenue', header: t('shiftrec.daily.revenue'), kind: 'number', value: r => r.expectedRevenueCents, cell: r => formatEuroCents(r.expectedRevenueCents) },
    { id: 'rides', header: t('shiftrec.daily.rides'), kind: 'number', hideBelow: 'md', value: r => r.expectedRides, cell: r => (r.expectedRides === null ? none : formatNumber(r.expectedRides)) },
    { id: 'tips', header: t('shiftrec.daily.tips'), kind: 'number', hideBelow: 'lg', value: r => r.expectedTipCents, cell: r => money(r.expectedTipCents, none) },
    { id: 'cash', header: t('shiftrec.daily.cash'), kind: 'number', hideBelow: 'lg', value: r => r.expectedCashCents, cell: r => money(r.expectedCashCents, none) },
  ];
  const totals = table.totals;
  const exportExcel = () => {
    const { year, month } = recommendation.target;
    const labels: DailyExportLabels = {
      sheetTitle: t('shiftrec.daily.sheet', { month: `${t(MONTH_NAME_KEYS[month - 1])} ${year}` }),
      moduleName: t('shiftrec.title'),
      total: t('shiftrec.daily.total'),
      date: t('shiftrec.shifts.date'),
      weekday: t('shiftrec.export.weekday'),
      vehicle: t('shiftrec.shifts.vehicle'),
      shifts: t('shiftrec.daily.shifts'),
      hours: t('shiftrec.export.hours'),
      revenue: t('shiftrec.daily.revenue'),
      rides: t('shiftrec.daily.rides'),
      tips: t('shiftrec.daily.tips'),
      cash: t('shiftrec.daily.cash'),
      weekdays: WEEKDAY_KEYS.map(key => t(key)),
      holiday: t('shiftrec.shifts.holiday'),
    };
    exportPicker.table('shiftRecommendationDaily', dailyExportOptions(table, `${year}-${String(month).padStart(2, '0')}`, labels));
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('shiftrec.daily.title')}</CardTitle>
        <Button variant="secondary" size="sm" disabled={table.rows.length === 0} onClick={exportExcel}>{t('shiftrec.export.button')}</Button>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-3">
        <p className="text-[13px] text-fg-subtle">{t('shiftrec.daily.hint')}</p>
        <DataTable
          columns={columns}
          rows={table.rows}
          getRowId={r => r.id}
          caption={t('shiftrec.daily.caption')}
          emptyState={<p className="py-6 text-center text-sm text-fg-muted">{t('shiftrec.shifts.empty')}</p>}
          totals={{
            shifts: formatNumber(totals.shifts),
            hours: hours(totals.minutes),
            revenue: formatEuroCents(totals.expectedRevenueCents),
            rides: totals.expectedRides === null ? none : formatNumber(totals.expectedRides),
            tips: money(totals.expectedTipCents, none),
            cash: money(totals.expectedCashCents, none),
          }}
        />
      </CardContent>
    </Card>
  );
}
