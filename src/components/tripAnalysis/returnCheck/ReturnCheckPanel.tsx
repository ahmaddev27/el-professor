import { useEffect, useMemo, useState } from 'react';
import { Info } from 'lucide-react';
import { Alert, Card, CardContent, CardHeader, CardTitle, Field, Input, NativeSelect, Button, formatNumber } from '../../ui';
import { useTranslation } from '../../../contexts/LanguageContext';
import { exportTableToExcel } from '../../../utils/excelExport';
import {
  DEFAULT_RETURN_CHECK_SETTINGS,
  checkRideFromRow,
  runReturnCheck,
  suggestBase,
  type BaseSuggestion,
  type CheckRide,
  type ReturnCheckResult,
} from '../../../utils/returnCheck';
import type { TripRowForAnalysis } from '../../../utils/tripAnalysis/types';
import {
  RADIUS_OPTIONS_KM,
  buildAnomalyRows,
  buildReviewRows,
  filterReviewRows,
  formatCoordinate,
  parseBase,
  reviewExportOptions,
  reviewVehicles,
  unverifiableCounts,
  PLACEMENT_KEYS,
  UNVERIFIABLE_KEYS,
  type BaseForm,
  type ReviewPlacement,
} from '../../../utils/returnCheckScreens';
import { ReturnCheckSummary } from './ReturnCheckSummary';
import { AnomalyTable, ReviewTable } from './ReturnCheckTables';

interface Props {
  tripRows: readonly TripRowForAnalysis[];
  /** The company's analysis block gap, the same value `analyzeTrips` uses. */
  blockGapMinutes: number;
  /** Held by the page, so it survives a switch to another tab (an inactive tab is unmounted). */
  baseForm: BaseForm;
  onBaseForm: (patch: Partial<BaseForm>) => void;
}

function guard<T>(label: string, run: () => T): { value: T | null; failed: boolean } {
  try {
    return { value: run(), failed: false };
  } catch (error) {
    console.error(`Rückkehrpflicht: ${label} failed`, error);
    return { value: null, failed: true };
  }
}

/** The fourth Fahrtenanalyse tab. A list to review, never a verdict; nothing is stored. */
export function ReturnCheckPanel({ tripRows, blockGapMinutes, baseForm, onBaseForm }: Props) {
  const { t } = useTranslation();
  const { latText, lonText, radiusKm, edited } = baseForm;
  const [vehicle, setVehicle] = useState('');
  const [placement, setPlacement] = useState<'' | ReviewPlacement>('');

  const mapped = useMemo(() => guard<CheckRide[]>('reading the rides', () => tripRows.map(checkRideFromRow)), [tripRows]);
  const rides = mapped.value;
  const suggestionRun = useMemo(
    () => guard<BaseSuggestion | null>('suggesting a base', () => (rides ? suggestBase(rides, blockGapMinutes) : null)),
    [rides, blockGapMinutes],
  );
  const suggestion = suggestionRun.value;

  // Prefill only while the person has not typed: their entry wins, also across tab switches.
  useEffect(() => {
    if (edited || !suggestion) return;
    const lat = formatCoordinate(suggestion.position.lat);
    const lon = formatCoordinate(suggestion.position.lon);
    if (lat !== latText || lon !== lonText) onBaseForm({ latText: lat, lonText: lon });
  }, [suggestion, edited, latText, lonText, onBaseForm]);

  const parsed = useMemo(() => parseBase(latText, lonText), [latText, lonText]);

  const run = useMemo(
    () =>
      guard<ReturnCheckResult>('the check', () => {
        if (!rides) throw new Error('rides unavailable');
        return runReturnCheck(rides, { ...DEFAULT_RETURN_CHECK_SETTINGS, base: parsed.base, baseRadiusKm: radiusKm, blockGapMinutes });
      }),
    [rides, parsed.base, radiusKm, blockGapMinutes],
  );
  const result = run.value;

  // The tables are derived inside the same guard: a throw here shows the failure, never a half-built screen.
  const derived = useMemo(
    () =>
      guard('building the tables', () => ({
        reviewRows: result && rides ? buildReviewRows(result, rides) : [],
        anomalyRows: result && rides ? buildAnomalyRows(result, rides) : [],
        unverifiable: result ? unverifiableCounts(result) : [],
      })),
    [result, rides],
  );
  const reviewRows = useMemo(() => derived.value?.reviewRows ?? [], [derived]);
  const anomalyRows = derived.value?.anomalyRows ?? [];
  const unverifiable = derived.value?.unverifiable ?? [];
  const unverifiableTotal = unverifiable.reduce((sum, u) => sum + u.count, 0);
  const visibleRows = useMemo(() => filterReviewRows(reviewRows, vehicle, placement), [reviewRows, vehicle, placement]);
  const vehicles = useMemo(() => reviewVehicles(reviewRows), [reviewRows]);

  const exportExcel = () => {
    const filters = [
      vehicle ? `${t('returncheck.review.vehicleFilter')}: ${vehicle}` : '',
      placement ? `${t('returncheck.review.placementFilter')}: ${t(PLACEMENT_KEYS[placement])}` : '',
    ].filter(Boolean);
    exportTableToExcel(
      reviewExportOptions(
        visibleRows,
        {
          sheetTitle: t('returncheck.export.sheet'),
          moduleName: t('returncheck.export.module'),
          date: t('returncheck.col.date'),
          vehicle: t('returncheck.col.vehicle'),
          driver: t('returncheck.col.driver'),
          orderAt: t('returncheck.col.orderAt'),
          previousEnd: t('returncheck.col.previousEnd'),
          wait: t('returncheck.col.wait'),
          distance: t('returncheck.col.distance'),
          placement: t('returncheck.col.type'),
          note: t('returncheck.col.hints'),
          placements: {
            away_from_base: t(PLACEMENT_KEYS.away_from_base),
            block_start_away: t(PLACEMENT_KEYS.block_start_away),
          },
          prebooked: t('returncheck.hint.prebooked'),
          samePostalCode: t('returncheck.hint.samePostalCode'),
        },
        filters,
      ),
    );
  };

  const suggestionText = suggestion
    ? t('returncheck.base.suggestion', { count: formatNumber(suggestion.blockStarts), total: formatNumber(suggestion.ofBlockStarts) })
    : t('returncheck.base.noSuggestion');

  const useSuggestion = () => {
    if (!suggestion) return;
    onBaseForm({
      latText: formatCoordinate(suggestion.position.lat),
      lonText: formatCoordinate(suggestion.position.lon),
      edited: true,
    });
  };

  const radii = RADIUS_OPTIONS_KM.includes(radiusKm) ? RADIUS_OPTIONS_KM : [...RADIUS_OPTIONS_KM, radiusKm].sort((a, b) => a - b);

  let body;
  if (mapped.failed || run.failed || derived.failed) {
    body = <Alert tone="critical" title={t('returncheck.failed.title')}>{t('returncheck.failed.body')}</Alert>;
  } else if (!parsed.base) {
    body = <Alert tone="caution">{t('returncheck.base.missing')}</Alert>;
  } else if (result?.status === 'invalid_settings') {
    body = <Alert tone="critical">{t('returncheck.invalidSettings')}</Alert>;
  } else if (result) {
    body = (
      <>
        <ReturnCheckSummary result={result} />
        <ReviewTable
          rows={visibleRows}
          totalRows={reviewRows.length}
          unverifiableTotal={unverifiableTotal}
          vehicles={vehicles}
          vehicle={vehicle}
          onVehicle={setVehicle}
          placement={placement}
          onPlacement={setPlacement}
          onExport={exportExcel}
        />
        <Card>
          <CardHeader>
            <CardTitle>{t('returncheck.unverifiable.title')}</CardTitle>
          </CardHeader>
          <CardContent>
            {unverifiable.length === 0 ? (
              <p className="text-sm text-fg-muted">{t('returncheck.unverifiable.none')}</p>
            ) : (
              <ul className="grid grid-cols-1 gap-1 text-sm text-fg-muted">
                {unverifiable.map(u => (
                  <li key={u.reason}>{t(UNVERIFIABLE_KEYS[u.reason], { count: formatNumber(u.count) })}</li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <AnomalyTable rows={anomalyRows} />
      </>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4">
      <Alert tone="brand" icon={Info} title={t('returncheck.info.title')}>{t('returncheck.info.body')}</Alert>
      <Card>
        <CardHeader>
          <CardTitle>{t('returncheck.base.title')}</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label={t('returncheck.base.lat')} error={parsed.problem === 'lat' ? t('returncheck.base.latInvalid') : undefined}>
              <Input inputMode="decimal" value={latText} onChange={e => onBaseForm({ latText: e.target.value, edited: true })} />
            </Field>
            <Field label={t('returncheck.base.lon')} error={parsed.problem === 'lon' ? t('returncheck.base.lonInvalid') : undefined}>
              <Input inputMode="decimal" value={lonText} onChange={e => onBaseForm({ lonText: e.target.value, edited: true })} />
            </Field>
            <Field label={t('returncheck.base.radius')}>
              <NativeSelect value={String(radiusKm)} onChange={e => onBaseForm({ radiusKm: Number(e.target.value) })}>
                {radii.map(km => (
                  <option key={km} value={String(km)}>{t('returncheck.base.radiusOption', { km: formatNumber(km, km % 1 === 0 ? 0 : 1) })}</option>
                ))}
              </NativeSelect>
            </Field>
          </div>
          <p className="text-[13px] text-fg-subtle">{suggestionRun.failed ? t('returncheck.base.noSuggestion') : suggestionText}</p>
          {suggestion ? (
            <div>
              <Button variant="secondary" size="sm" onClick={useSuggestion}>{t('returncheck.base.useSuggestion')}</Button>
            </div>
          ) : null}
          <p className="text-[13px] text-fg-subtle">{t('returncheck.base.notSaved')}</p>
        </CardContent>
      </Card>
      {body}
    </div>
  );
}
