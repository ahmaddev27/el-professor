import { useMemo, useState, type ReactNode } from 'react';
import { Info } from 'lucide-react';
import { Alert, Button, KpiCard, formatEuroCents, formatNumber } from '../ui';
import { useTranslation } from '../../contexts/LanguageContext';
import type { TranslationKey } from '../../i18n';
import { useColumnPickerExport } from '../../contexts/ExportPickerContext';
import type { DemandProfile, ShiftRecommendation } from '../../utils/shiftRecommendation';
import {
  CONFIDENCE_KEYS,
  MONTH_NAME_KEYS,
  WEEKDAY_KEYS,
  filterShiftRows,
  minutesToHours,
  shiftExportOptions,
  shiftRows,
  type ShiftExportLabels,
} from '../../utils/shiftRecommendationScreens';
import { DemandHeatmap } from './DemandHeatmap';
import { PerVehicleTable, ShiftTable } from './ShiftTables';

interface Props {
  profile: DemandProfile;
  recommendation: ShiftRecommendation;
  onBack: () => void;
}

const STATUS_KEYS: Record<Exclude<ShiftRecommendation['status'], 'ok'>, TranslationKey> = {
  invalid_settings: 'shiftrec.result.status.invalid_settings',
  profile_unusable: 'shiftrec.result.status.profile_unusable',
  invalid_target: 'shiftrec.result.status.invalid_target',
  no_vehicles: 'shiftrec.result.status.no_vehicles',
};

/** Step 3. Every figure here is an estimate and is labelled so; nothing is saved. */
export function ResultStep({ profile, recommendation, onBack }: Props) {
  const { t } = useTranslation();
  const exportPicker = useColumnPickerExport();
  const [vehicleFilter, setVehicleFilter] = useState('');
  const rows = useMemo(() => shiftRows(recommendation.shifts), [recommendation]);
  const vehicles = useMemo(() => recommendation.perVehicle.map(v => v.vehicle), [recommendation]);

  const exportExcel = () => {
    const visible = filterShiftRows(rows, vehicleFilter);
    const month = `${t(MONTH_NAME_KEYS[recommendation.target.month - 1])} ${recommendation.target.year}`;
    const labels: ShiftExportLabels = {
      sheetTitle: t('shiftrec.export.sheet', { month }),
      moduleName: t('shiftrec.title'),
      total: t('shiftrec.export.total', { count: visible.length }),
      date: t('shiftrec.shifts.date'),
      weekday: t('shiftrec.export.weekday'),
      vehicle: t('shiftrec.shifts.vehicle'),
      from: t('shiftrec.export.from'),
      to: t('shiftrec.export.to'),
      hours: t('shiftrec.export.hours'),
      revenue: t('shiftrec.shifts.revenue'),
      rate: t('shiftrec.shifts.rate'),
      evidence: t('shiftrec.shifts.evidence'),
      confidence: t('shiftrec.shifts.confidence'),
      weekdays: WEEKDAY_KEYS.map(key => t(key)),
      confidences: { high: t(CONFIDENCE_KEYS.high), medium: t(CONFIDENCE_KEYS.medium), low: t(CONFIDENCE_KEYS.low) },
      holiday: t('shiftrec.shifts.holiday'),
    };
    exportPicker.table('shiftRecommendation', shiftExportOptions(visible, recommendation.target, labels, vehicleFilter ? [vehicleFilter] : []));
  };

  return (
    <div className="grid grid-cols-1 gap-4">
      <Alert tone="brand" icon={Info}>
        {t('shiftrec.result.banner', { count: profile.historyMonths.length })}
      </Alert>

      {recommendation.status !== 'ok' ? (
        <Alert tone="critical">{t(STATUS_KEYS[recommendation.status])}</Alert>
      ) : (
        <>
          <Kpis profile={profile} recommendation={recommendation} />
          {recommendation.totals.shifts === 0 ? <Alert tone="caution">{t('shiftrec.result.noShifts')}</Alert> : null}
          <DemandHeatmap profile={profile} thresholdCents={recommendation.settings.minRevenuePerHourCents} />
          <PerVehicleTable rows={recommendation.perVehicle} />
          <ShiftTable
            rows={rows}
            vehicles={vehicles}
            vehicleFilter={vehicleFilter}
            onVehicleFilter={setVehicleFilter}
            onExport={exportExcel}
            operatingDayStartHour={profile.settings.operatingDayStartHour}
          />
        </>
      )}

      <div>
        <Button variant="secondary" onClick={onBack}>{t('shiftrec.back')}</Button>
      </div>
    </div>
  );
}

function Kpis({ profile, recommendation }: { profile: DemandProfile; recommendation: ShiftRecommendation }) {
  const { t } = useTranslation();
  const hours = (minutes: number) => t('shiftrec.kpi.hours', { value: formatNumber(minutesToHours(minutes)) });
  const rate = (cents: number | null) => (cents === null ? t('shiftrec.kpi.none') : formatEuroCents(cents));
  const { totals, weakHistory } = recommendation;
  return (
    <div className="grid grid-cols-1 gap-4">
      <KpiGroup title={t('shiftrec.kpi.historyTitle')}>
        <KpiCard label={t('shiftrec.kpi.vehicleHours')} value={hours(profile.perMonth.vehicleMinutes)} />
        <KpiCard label={t('shiftrec.kpi.revenue')} value={formatEuroCents(profile.perMonth.revenueCents)} />
        <KpiCard label={t('shiftrec.kpi.rate')} value={rate(profile.perMonth.revenuePerHourCents)} />
      </KpiGroup>
      <KpiGroup title={t('shiftrec.kpi.planTitle')}>
        <KpiCard label={t('shiftrec.kpi.shiftHours')} value={hours(totals.minutes)} caption={`${formatNumber(totals.shifts)} ${t('shiftrec.kpi.shifts')}`} />
        <KpiCard label={t('shiftrec.kpi.expectedRevenue')} value={formatEuroCents(totals.expectedRevenueCents)} />
        <KpiCard label={t('shiftrec.kpi.expectedRate')} value={rate(totals.expectedRevenuePerHourCents)} />
      </KpiGroup>
      <KpiGroup title={t('shiftrec.kpi.weakTitle')}>
        <KpiCard label={t('shiftrec.kpi.vehicleHours')} value={hours(weakHistory.vehicleMinutesPerMonth)} />
        <KpiCard label={t('shiftrec.kpi.revenue')} value={formatEuroCents(weakHistory.revenueCentsPerMonth)} />
        <KpiCard label={t('shiftrec.kpi.rate')} value={rate(weakHistory.revenuePerHourCents)} />
      </KpiGroup>
    </div>
  );
}

function KpiGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid grid-cols-1 gap-2">
      <h3 className="text-[13px] font-semibold text-fg-muted">{title}</h3>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">{children}</div>
    </section>
  );
}
