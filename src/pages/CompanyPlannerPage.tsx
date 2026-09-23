import React, { useEffect, useMemo, useState } from 'react';
import { Play, AlertTriangle, CheckCircle2, Car as CarIcon, Clock, FileSearch, Info, ChevronRight, ChevronDown, ArrowLeft, CalendarDays, History, Euro, ListChecks, type LucideIcon } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Alert, Badge, Button, Card, CardContent, CardTitle, Field, Input, NativeSelect, PageHeader } from '../components/ui';
import { supabase } from '../lib/supabase';
import { useFahrtenbuch, type FahrtenbuchTrip } from '../hooks/useFahrtenbuch';
import {
  buildPhase1VehicleBlocks,
  type Phase1Result,
  type Phase1Trip,
  VEHICLE_BLOCK_GAP_MINUTES,
  DEFAULT_MAX_VEHICLE_BLOCK_DURATION_MINUTES,
  MIN_VEHICLE_BLOCK_DURATION_MINUTES,
  MAX_BLOCK_DURATION_LOWER_BOUND,
  MAX_BLOCK_DURATION_UPPER_BOUND,
} from '../utils/monatsplanungPhase1';
import { DEFAULT_VEHICLE_SWITCH_BUFFER_MINUTES } from '../utils/monatsplanungPhase3';
import { resolveActualRideWindow } from '../utils/planningQualityChecks';
import MonatsplanungDriverPool, { type PlanningDriver } from '../components/MonatsplanungDriverPool';
import MonatsplanungAssignmentPreview from '../components/MonatsplanungAssignmentPreview';
import MonatsplanungAppliedRuns from '../components/MonatsplanungAppliedRuns';
import HistoricalReconciliationWizard from '../components/HistoricalReconciliationWizard';
import HistoricalWorkingHoursWizard from '../components/HistoricalWorkingHoursWizard';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';

// Month names are TranslationKeys: this list is module-level and t() is a hook
// value. Every consumer resolves it.
const MONTH_KEYS: TranslationKey[] = [
  'doc.month.january', 'doc.month.february', 'doc.month.march', 'doc.month.april',
  'doc.month.may', 'doc.month.june', 'doc.month.july', 'doc.month.august',
  'doc.month.september', 'doc.month.october', 'doc.month.november', 'doc.month.december',
];

const BATCH_SIZE = 1000;

/** Show full technical debug panels only when ?debug=1 is in the URL (developer mode). */
const DEBUG_MODE = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('debug') === '1';

function formatDuration(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

function formatTime(iso: string): string {
  const m = /T(\d{2}):(\d{2})/.exec(iso);
  return m ? `${m[1]}:${m[2]}` : iso;
}

function formatDate(d: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : d;
}

// `reason` is a Phase 1 split code — data. Only the rendered label is translated.
function splitReasonLabel(
  reason: string,
  blockSeparatorMin: number,
  maxBlockMin: number,
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string,
): string {
  if (reason === 'gap_gt_60') return t('mp.planner.splitGap', { minutes: blockSeparatorMin });
  if (reason === 'max_duration_4_5h') {
    if (maxBlockMin % 60 === 0) return t('mp.planner.splitMaxHours', { hours: maxBlockMin / 60 });
    return t('mp.planner.splitMaxMinutes', { minutes: maxBlockMin });
  }
  if (reason === 'end_of_vehicle_day') return t('mp.planner.splitEndOfDay');
  return reason;
}

async function fetchAllTripsForImport(companyId: string, importId: string): Promise<FahrtenbuchTrip[]> {
  const all: FahrtenbuchTrip[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from('fahrtenbuch_trips')
      .select('*')
      .eq('company_id', companyId)
      .eq('import_id', importId)
      .order('trip_date', { ascending: true })
      .order('start_time', { ascending: true, nullsFirst: false })
      .order('id', { ascending: true })
      .range(offset, offset + BATCH_SIZE - 1);
    if (error) throw error;
    const rows = (data as FahrtenbuchTrip[]) ?? [];
    all.push(...rows);
    if (rows.length < BATCH_SIZE) break;
    offset += BATCH_SIZE;
  }
  return all;
}

export default function CompanyPlannerPage() {
  const { effectiveCompanyId: companyId } = useSuperAdmin();
  const { t } = useTranslation();
  const now = new Date();
  const [planningMode, setPlanningMode] = useState<'selection' | 'new_month' | 'historical' | 'hist_mode_selection' | 'historical_reconciliation' | 'hist_working_hours'>('selection');
  const [reconciliationMode, setReconciliationMode] = useState<'brutto_salary' | 'working_hours' | null>(null);
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [selectedImportId, setSelectedImportId] = useState<string>('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Phase1Result | null>(null);
  const [originalDriverNames, setOriginalDriverNames] = useState<string[]>([]);
  const [originalDriverIds, setOriginalDriverIds] = useState<string[]>([]);
  const [selectedDriverIds, setSelectedDriverIds] = useState<Set<string>>(new Set());
  const [poolDrivers, setPoolDrivers] = useState<PlanningDriver[]>([]);
  const [rawTrips, setRawTrips] = useState<FahrtenbuchTrip[]>([]);
  const [blockSeparatorGap, setBlockSeparatorGap] = useState<number>(VEHICLE_BLOCK_GAP_MINUTES);
  const [minBlockDuration, setMinBlockDuration] = useState<number>(MIN_VEHICLE_BLOCK_DURATION_MINUTES);
  const [maxBlockDuration, setMaxBlockDuration] = useState<number>(DEFAULT_MAX_VEHICLE_BLOCK_DURATION_MINUTES);
  const [vehicleSwitchBuffer, setVehicleSwitchBuffer] = useState<number>(DEFAULT_VEHICLE_SWITCH_BUFFER_MINUTES);
  const [appliedRunsReloadToken, setAppliedRunsReloadToken] = useState(0);

  const { imports, fetchImports, loadingImports } = useFahrtenbuch();

  useEffect(() => {
    void fetchImports();
  }, [fetchImports]);

  const filteredImports = useMemo(
    () => imports.filter(i => i.month === month && i.year === year),
    [imports, month, year],
  );

  useEffect(() => {
    if (filteredImports.length === 0) {
      setSelectedImportId('');
      return;
    }
    if (!filteredImports.some(i => i.id === selectedImportId)) {
      setSelectedImportId(filteredImports[0].id);
    }
  }, [filteredImports, selectedImportId]);

  // Invalidate downstream phases (Phase 3-7) when block inputs change so the
  // user has to re-run Phase 1 with the new parameters.
  useEffect(() => {
    setResult(null);
    setOriginalDriverNames([]);
    setOriginalDriverIds([]);
    setSelectedDriverIds(new Set());
    setPoolDrivers([]);
    setRawTrips([]);
  }, [blockSeparatorGap, minBlockDuration, maxBlockDuration, selectedImportId, month, year]);

  const yearOptions = useMemo(() => {
    const y = now.getFullYear();
    return [y - 1, y, y + 1];
  }, [now]);

  const handleRun = async () => {
    if (!companyId) {
      setError(t('mp.planner.noCompany'));
      return;
    }
    if (!selectedImportId) {
      setError(t('mp.planner.noImportSelected'));
      return;
    }
    setRunning(true);
    setError(null);
    setResult(null);
    setOriginalDriverNames([]);
    setOriginalDriverIds([]);
    setSelectedDriverIds(new Set());
    setPoolDrivers([]);
    setRawTrips([]);
    try {
      const rawTrips = await fetchAllTripsForImport(companyId, selectedImportId);
      setRawTrips(rawTrips);

      // Pre-compute actual ride timestamps from raw_data_json so Phase 1 can
      // sort and group by real calendar dates instead of service date + HH:MM.
      const phase1Trips: Phase1Trip[] = rawTrips.map(trip => {
        if (trip.is_canceled) {
          return {
            id: trip.id,
            trip_date: trip.trip_date,
            start_time: trip.start_time,
            end_time: trip.end_time,
            car_id: trip.car_id,
            car_identifier: trip.car_identifier,
            is_canceled: true,
            source_row_index: trip.source_row_index,
          };
        }
        const rw = resolveActualRideWindow(trip);
        return {
          id: trip.id,
          trip_date: trip.trip_date,
          start_time: trip.start_time,
          end_time: trip.end_time,
          car_id: trip.car_id,
          car_identifier: trip.car_identifier,
          is_canceled: false,
          source_row_index: trip.source_row_index,
          actual_start_ms: rw.actualStartMs > 0 ? rw.actualStartMs : undefined,
          actual_end_ms:   rw.actualEndMs   > 0 ? rw.actualEndMs   : undefined,
        };
      });
      const res = buildPhase1VehicleBlocks(phase1Trips, {
        blockSeparatorGapMinutes: blockSeparatorGap,
        minBlockDurationMinutes: minBlockDuration,
        maxBlockDurationMinutes: maxBlockDuration,
      });

      setResult(res);

      const names = new Set<string>();
      const ids = new Set<string>();
      for (const trip of rawTrips) {
        if (trip.is_canceled) continue;
        if (trip.original_driver_name && trip.original_driver_name.trim()) {
          names.add(trip.original_driver_name.trim());
        }
        if (trip.original_driver_id) ids.add(trip.original_driver_id);
      }
      setOriginalDriverNames(Array.from(names));
      setOriginalDriverIds(Array.from(ids));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('mp.unknownError'));
    } finally {
      setRunning(false);
    }
  };

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // Everything above is the page's logic and is unchanged. Below, the frame —
  // the header, the mode cards and Phase 1's parameter form — only draws; the
  // parameter fields keep their onChange handlers, bounds and fallbacks
  // character for character, and the planning components further down are
  // mounted with the same props as before.
  const subtitle =
    planningMode === 'selection' ? t('mp.planner.pickMode')
    : planningMode === 'new_month' ? t('mp.planner.phase1Title')
    : planningMode === 'historical' ? t('mp.planner.historicalTitle')
    : null;

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        className="font-ui"
        title={t('mp.title')}
        description={subtitle}
        actions={
          /* The Fahrtenanalyse explains the month's imported rides. It plans
             nothing and writes no trip, so it is a link out of the planner
             rather than a step in it. */
          <Button variant="secondary" asChild>
            <Link to="/fahrtenanalyse">
              <FileSearch aria-hidden />
              {t('ta.link.open')}
            </Link>
          </Button>
        }
      />

      {/* ── Mode selection ── */}
      {planningMode === 'selection' && (
        <div className="grid grid-cols-1 gap-4 font-ui md:grid-cols-2">
          <ModeCard
            icon={CalendarDays}
            title={t('mp.planner.newPlanTitle')}
            description={t('mp.planner.newPlanDesc')}
            action={
              <Button onClick={() => setPlanningMode('new_month')}>
                <Play aria-hidden />
                {t('mp.planner.newPlanStart')}
              </Button>
            }
          />
          <ModeCard
            icon={History}
            title={t('mp.planner.oldMonthTitle')}
            description={t('mp.planner.oldMonthDesc')}
            action={
              <Button onClick={() => setPlanningMode('hist_mode_selection')}>
                <History aria-hidden />
                {t('mp.planner.historicalStart')}
              </Button>
            }
          />
        </div>
      )}

      {/* ── Historical reconciliation wizard ── */}
      {planningMode === 'historical_reconciliation' && (
        <HistoricalReconciliationWizard onBack={() => setPlanningMode('hist_mode_selection')} />
      )}

      {/* ── Historical mode selection ── */}
      {planningMode === 'hist_mode_selection' && (
        <div className="mx-auto grid max-w-3xl grid-cols-1 gap-5 font-ui">
          <div>
            <Button variant="ghost" size="sm" className="-ml-2" onClick={() => setPlanningMode('selection')}>
              <ArrowLeft aria-hidden />
              {t('mp.planner.backToSelection')}
            </Button>
          </div>

          <div>
            <h2 className="text-lg font-semibold text-fg">{t('mp.planner.histModeTitle')}</h2>
            <p className="mt-1 text-sm text-fg-muted">{t('mp.planner.histModeDesc')}</p>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {/* Card 1 — Mit Brutto-Gehältern */}
            <ModeCard
              icon={Euro}
              headingLevel="h3"
              title={t('mp.planner.bruttoTitle')}
              badge={
                <Badge tone="positive">
                  <CheckCircle2 aria-hidden />
                  {t('mp.planner.badgeAvailable')}
                </Badge>
              }
              description={t('mp.planner.bruttoDesc')}
              action={
                <Button
                  onClick={() => {
                    setReconciliationMode('brutto_salary');
                    setPlanningMode('historical_reconciliation');
                  }}
                >
                  <Euro aria-hidden />
                  {t('mp.planner.bruttoStart')}
                </Button>
              }
            />

            {/* Card 2 — Mit Arbeitsstunden */}
            <ModeCard
              icon={ListChecks}
              headingLevel="h3"
              title={t('mp.planner.hoursTitle')}
              badge={<Badge tone="brand">{t('mp.planner.badgeNew')}</Badge>}
              description={t('mp.planner.hoursDesc')}
              action={
                <Button
                  onClick={() => {
                    setReconciliationMode('working_hours');
                    setPlanningMode('hist_working_hours');
                  }}
                >
                  <ListChecks aria-hidden />
                  {t('mp.planner.hoursStart')}
                </Button>
              }
            />
          </div>

          <Alert tone="neutral" role="note">
            <strong className="font-semibold text-fg">{t('mp.planner.noteLabel')}</strong>{' '}
            {t('mp.planner.histModeHint')}
          </Alert>
        </div>
      )}

      {/* ── Working hours reconciliation wizard ── */}
      {planningMode === 'hist_working_hours' && (
        <HistoricalWorkingHoursWizard onBack={() => setPlanningMode('hist_mode_selection')} />
      )}

      {/* ── Normal planning workflow (new_month) ── */}
      {planningMode === 'new_month' && (
        <div>
          <Button variant="ghost" size="sm" className="-ml-2 mb-3 font-ui" onClick={() => setPlanningMode('selection')}>
            <ArrowLeft aria-hidden />
            {t('mp.planner.backToSelection')}
          </Button>

      <Card className="mb-6 font-ui">
        <CardContent className="grid gap-5 pt-5">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
            <Field label={t('common.month')}>
              <NativeSelect
                value={month}
                onChange={e => setMonth(Number(e.target.value))}
              >
                {MONTH_KEYS.map((key, i) => (
                  <option key={key} value={i + 1}>{t(key)}</option>
                ))}
              </NativeSelect>
            </Field>
            <Field label={t('mp.planner.year')}>
              <NativeSelect
                value={year}
                onChange={e => setYear(Number(e.target.value))}
              >
                {yearOptions.map(y => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </NativeSelect>
            </Field>
            <Field label={t('mp.planner.importFile')} className="md:col-span-2">
              <NativeSelect
                value={selectedImportId}
                onChange={e => setSelectedImportId(e.target.value)}
                disabled={loadingImports || filteredImports.length === 0}
              >
                {filteredImports.length === 0 ? (
                  <option value="">{t('mp.planner.noImportFound', { month: t(MONTH_KEYS[month - 1]), year })}</option>
                ) : (
                  filteredImports.map(i => (
                    <option key={i.id} value={i.id}>
                      {i.file_name} ({t('mp.planner.importRows', { rows: i.row_count })}, {new Date(i.imported_at).toLocaleDateString('de-DE')})
                    </option>
                  ))
                )}
              </NativeSelect>
            </Field>
          </div>

          {/* The four block parameters. Each field keeps its bounds and its
              fallback for an empty or unreadable entry exactly as before. */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label={t('mp.planner.blockSeparator')}>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={1}
                  max={720}
                  step={1}
                  value={blockSeparatorGap}
                  onChange={e => {
                    const v = parseInt(e.target.value, 10);
                    setBlockSeparatorGap(Number.isFinite(v) && v > 0 ? v : VEHICLE_BLOCK_GAP_MINUTES);
                  }}
                  className="w-24 text-right"
                />
                <span className="text-[13px] text-fg-muted">{t('mp.minShort')}</span>
              </div>
            </Field>
            <Field label={t('mp.planner.minBlockDuration')}>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={0}
                  max={120}
                  step={1}
                  value={minBlockDuration}
                  onChange={e => {
                    const v = parseInt(e.target.value, 10);
                    if (!Number.isFinite(v)) {
                      setMinBlockDuration(MIN_VEHICLE_BLOCK_DURATION_MINUTES);
                    } else {
                      setMinBlockDuration(Math.max(0, Math.min(120, v)));
                    }
                  }}
                  className="w-24 text-right"
                />
                <span className="text-[13px] text-fg-muted">
                  {t('mp.minShort')}{minBlockDuration === 0 ? ` ${t('mp.planner.disabledSuffix')}` : ''}
                </span>
              </div>
            </Field>
            <Field label={t('mp.planner.maxBlockDuration')}>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={MAX_BLOCK_DURATION_LOWER_BOUND}
                  max={MAX_BLOCK_DURATION_UPPER_BOUND}
                  step={1}
                  value={maxBlockDuration}
                  onChange={e => {
                    const v = parseInt(e.target.value, 10);
                    if (!Number.isFinite(v)) {
                      setMaxBlockDuration(DEFAULT_MAX_VEHICLE_BLOCK_DURATION_MINUTES);
                    } else {
                      setMaxBlockDuration(Math.max(MAX_BLOCK_DURATION_LOWER_BOUND, Math.min(MAX_BLOCK_DURATION_UPPER_BOUND, v)));
                    }
                  }}
                  className="w-24 text-right"
                />
                <span className="text-[13px] text-fg-muted">{t('mp.minShort')}</span>
              </div>
            </Field>
            <Field label={t('mp.vehicleSwitchBuffer')}>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={0}
                  max={240}
                  step={5}
                  value={vehicleSwitchBuffer}
                  onChange={e => {
                    const v = parseInt(e.target.value, 10);
                    setVehicleSwitchBuffer(Number.isFinite(v) && v >= 0 ? v : DEFAULT_VEHICLE_SWITCH_BUFFER_MINUTES);
                  }}
                  className="w-24 text-right"
                />
                <span className="text-[13px] text-fg-muted">{t('mp.minShort')}</span>
              </div>
            </Field>
          </div>

          <p className="flex items-start gap-2 text-[13px] text-fg-muted">
            <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-fg-subtle" />
            <span>
            {t('mp.planner.defaultsHint', {
              gap: VEHICLE_BLOCK_GAP_MINUTES,
              minBlock: MIN_VEHICLE_BLOCK_DURATION_MINUTES,
              maxBlock: DEFAULT_MAX_VEHICLE_BLOCK_DURATION_MINUTES,
              lower: MAX_BLOCK_DURATION_LOWER_BOUND,
              upper: MAX_BLOCK_DURATION_UPPER_BOUND,
              buffer: DEFAULT_VEHICLE_SWITCH_BUFFER_MINUTES,
            })}
            </span>
          </p>

          <Alert tone="brand" role="note">
              <strong className="font-semibold text-fg">{t('mp.planner.safetyRulesLabel')}</strong>{' '}
              {t('mp.planner.safetyRulesBody', { buffer: vehicleSwitchBuffer })}
          </Alert>

          {error && <Alert tone="critical">{error}</Alert>}

          <div>
            <Button
            onClick={handleRun}
            disabled={running || !selectedImportId}
            >
              <Play aria-hidden />
            {running ? t('mp.planner.loadingTrips') : t('mp.planner.buildBlocks')}
            </Button>
          </div>
        </CardContent>
      </Card>

      {result && <BlockStatusBanner result={result} />}
      {DEBUG_MODE && result && <ResultPanels result={result} blockSeparatorMin={blockSeparatorGap} maxBlockMin={maxBlockDuration} />}
      {result && companyId && (
        <div className="mt-6">
          <MonatsplanungDriverPool
            companyId={companyId}
            originalDriverNames={originalDriverNames}
            originalDriverIds={originalDriverIds}
            selectedIds={selectedDriverIds}
            onSelectedChange={setSelectedDriverIds}
            onDriversLoaded={setPoolDrivers}
          />
        </div>
      )}

      {result && poolDrivers.length > 0 && (
        <div className="mt-6">
          <MonatsplanungAssignmentPreview
            blocks={result.blocks}
            selectedDrivers={poolDrivers.filter(d => selectedDriverIds.has(d.id))}
            trips={rawTrips}
            importId={selectedImportId}
            month={month}
            year={year}
            blockSeparatorMinutes={blockSeparatorGap}
            minBlockDurationMinutes={minBlockDuration}
            maxBlockDurationMinutes={maxBlockDuration}
            vehicleSwitchBufferMinutes={vehicleSwitchBuffer}
            sourceFileName={filteredImports.find(i => i.id === selectedImportId)?.file_name ?? ''}
            companyId={companyId}
            onApplied={() => setAppliedRunsReloadToken(token => token + 1)}
          />
        </div>
      )}

      {companyId && (
        <div className="mt-8">
          <MonatsplanungAppliedRuns companyId={companyId} reloadToken={appliedRunsReloadToken} />
        </div>
      )}
        </div>
      )}
    </div>
  );
}

function BlockStatusBanner({ result }: { result: Phase1Result }) {
  const { t } = useTranslation();
  const s = result.summary;
  const observedMax = s.observed_max_block_duration_minutes;
  const hasProblems = s.coverage_issues > 0 || observedMax > s.max_block_duration_minutes;

  if (hasProblems) {
    return null;
  }

  return (
    <Alert tone="positive" className="mt-4" title={t('mp.planner.blocksCreated')}>
      {t('mp.planner.blocksCreatedDetail', {
        blocks: s.blocks_total,
        vehicles: s.vehicles,
        trips: s.abgeschlossen,
      })}
    </Alert>
  );
}

function ResultPanels({ result, blockSeparatorMin, maxBlockMin }: { result: Phase1Result; blockSeparatorMin: number; maxBlockMin: number }) {
  const { t } = useTranslation();
  const s = result.summary;
  const observedMax = s.observed_max_block_duration_minutes;
  const validationOk = s.coverage_issues === 0 && observedMax <= s.max_block_duration_minutes;
  const [blocksOpen, setBlocksOpen] = useState(true);

  return (
    <div className="space-y-6">
      {/* Overall summary */}
      <div
        className="rounded-xl p-5"
        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
      >
        <h2 className="text-base font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>
          {t('mp.planner.overview')}
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <StatCard label={t('mp.planner.blockSeparator')} value={`${s.block_separator_gap_minutes} ${t('mp.minShort')}`} highlight />
          <StatCard label={t('mp.planner.minBlockDuration')} value={s.min_block_duration_minutes === 0 ? t('mp.planner.off') : `${s.min_block_duration_minutes} ${t('mp.minShort')}`} highlight />
          <StatCard label={t('mp.planner.maxBlockDuration')} value={`${s.max_block_duration_minutes} ${t('mp.minShort')}`} highlight />
          <StatCard label={t('mp.totalTrips')} value={s.total_trips} />
          <StatCard label={t('mp.completed')} value={s.abgeschlossen} />
          <StatCard label={t('mp.canceled')} value={s.storniert} />
          <StatCard label={t('mp.vehicles')} value={s.vehicles} />
          <StatCard label={t('mp.vehicleBlocks')} value={s.blocks_total} highlight />
          <StatCard label={t('mp.planner.splitByGap', { minutes: blockSeparatorMin })} value={s.blocks_split_by_gap} />
          <StatCard label={t('mp.planner.splitByMax', { minutes: maxBlockMin })} value={s.blocks_split_by_max_duration} />
          <StatCard
            label={t('mp.planner.observedMaxDuration')}
            value={formatDuration(observedMax)}
            tone={observedMax > s.max_block_duration_minutes ? 'danger' : undefined}
          />
          <StatCard label={t('mp.planner.shortBlocksDetected')} value={s.short_blocks_detected} />
          <StatCard label={t('mp.planner.shortBlocksMerged')} value={s.short_blocks_merged} tone={s.short_blocks_merged > 0 ? 'ok' : undefined} />
          <StatCard
            label={t('mp.planner.shortBlocksRemaining')}
            value={s.short_blocks_remaining}
            tone={s.short_blocks_remaining > 0 ? 'warning' : 'ok'}
          />
          <StatCard
            label={t('mp.planner.coverageIssues')}
            value={s.coverage_issues}
            tone={s.coverage_issues > 0 ? 'danger' : 'ok'}
          />
          <div className="flex items-center">
            {validationOk ? (
              <span className="inline-flex items-center gap-1.5 text-sm font-semibold"
                style={{ color: 'var(--success, #15803d)' }}>
                <CheckCircle2 size={16} /> {t('mp.validationOk')}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-sm font-semibold"
                style={{ color: 'var(--danger, #b91c1c)' }}>
                <AlertTriangle size={16} /> {t('mp.planner.problemsDetected')}
              </span>
            )}
          </div>
        </div>

        {result.coverageIssues.length > 0 && (
          <details className="mt-4">
            <summary className="text-sm cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
              {t('mp.planner.showCoverageIssues', { count: result.coverageIssues.length })}
            </summary>
            <ul className="mt-2 space-y-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
              {result.coverageIssues.slice(0, 50).map((c, i) => (
                <li key={i}>• [{c.type}] {c.detail}</li>
              ))}
              {result.coverageIssues.length > 50 && (
                <li>{t('mp.andMore', { count: result.coverageIssues.length - 50 })}</li>
              )}
            </ul>
          </details>
        )}

        {result.skippedTrips.length > 0 && (
          <details className="mt-3">
            <summary className="text-sm cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
              {t('mp.planner.skippedTrips', { count: result.skippedTrips.length })}
            </summary>
            <ul className="mt-2 space-y-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
              {result.skippedTrips.slice(0, 30).map((trip, i) => (
                <li key={i}>• {trip.id}: {trip.reason}</li>
              ))}
            </ul>
          </details>
        )}
      </div>

      {/* Per-vehicle summary */}
      <div
        className="rounded-xl overflow-hidden"
        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
      >
        <div className="px-5 py-4 border-b" style={{ borderColor: 'var(--border)' }}>
          <h2 className="text-base font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <CarIcon size={16} /> {t('mp.planner.perVehicle')}
          </h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: 'var(--bg-subtle)' }}>
                <Th>{t('mp.licensePlate')}</Th>
                <Th align="right">{t('mp.planner.colBlocks')}</Th>
                <Th align="right">{t('mp.trips')}</Th>
                <Th align="right">{t('mp.planner.colAvgTripsPerBlock')}</Th>
                <Th align="right">{t('mp.planner.colAvgBlockDuration')}</Th>
                <Th align="right">{t('mp.planner.maxBlockDuration')}</Th>
              </tr>
            </thead>
            <tbody>
              {result.perVehicle.map(v => (
                <tr key={v.vehicle_id} style={{ borderTop: '1px solid var(--border)' }}>
                  <Td><span className="font-mono">{v.vehicle_identifier}</span></Td>
                  <Td align="right">{v.blocks}</Td>
                  <Td align="right">{v.trips}</Td>
                  <Td align="right">{v.avg_trips_per_block.toFixed(2)}</Td>
                  <Td align="right">{formatDuration(Math.round(v.avg_block_duration_minutes))}</Td>
                  <Td align="right">{formatDuration(v.max_block_duration_minutes)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Block table */}
      <div
        className="rounded-xl overflow-hidden"
        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
      >
        <button
          type="button"
          onClick={() => setBlocksOpen(o => !o)}
          className="w-full px-5 py-4 border-b flex items-center justify-between text-left transition-colors hover:bg-[color:var(--bg-subtle)]"
          style={{ borderColor: 'var(--border)' }}
          aria-expanded={blocksOpen}
        >
          <h2 className="text-base font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            {blocksOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            <Clock size={16} /> {t('mp.vehicleBlocks')} ({result.blocks.length})
          </h2>
          <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
            {blocksOpen ? t('mp.collapse') : t('mp.expand')}
          </span>
        </button>
        {blocksOpen && (
        <div className="overflow-x-auto max-h-[600px]">
          <table className="w-full text-xs">
            <thead className="sticky top-0" style={{ background: 'var(--bg-subtle)' }}>
              <tr>
                <Th>{t('mp.planner.colActualDate')}</Th>
                <Th>{t('mp.licensePlate')}</Th>
                <Th>{t('mp.planner.colActualStart')}</Th>
                <Th>{t('mp.planner.colActualEnd')}</Th>
                <Th align="right">{t('mp.duration')}</Th>
                <Th align="right">{t('mp.trips')}</Th>
                <Th>{t('mp.planner.colSplit')}</Th>
                <Th>{t('mp.planner.minBlockDuration')}</Th>
                <Th>{t('mp.planner.colExcelRows')}</Th>
              </tr>
            </thead>
            <tbody>
              {result.blocks.map(b => {
                // Detect cross-midnight block (end date > start date)
                const endDate = b.block_end_datetime.slice(0, 10);
                const crossMidnight = endDate > b.service_date;
                return (
                <tr key={b.block_id} style={{ borderTop: '1px solid var(--border)' }}>
                  <Td>
                    <span title={crossMidnight ? t('mp.planner.endsOn', { date: formatDate(endDate) }) : undefined}>
                      {formatDate(b.service_date)}
                      {crossMidnight && (
                        <span className="ml-1 text-[9px] font-semibold px-1 rounded"
                          style={{ background: 'rgba(234,88,12,0.12)', color: '#c2410c' }}>
                          →{formatDate(endDate)}
                        </span>
                      )}
                    </span>
                  </Td>
                  <Td><span className="font-mono">{b.vehicle_identifier}</span></Td>
                  <Td>{formatTime(b.block_start_datetime)}</Td>
                  <Td>{formatTime(b.block_end_datetime)}</Td>
                  <Td align="right">{formatDuration(b.duration_minutes)}</Td>
                  <Td align="right">{b.trip_count}</Td>
                  <Td>
                    <span
                      className="px-1.5 py-0.5 rounded text-[10px] font-semibold"
                      style={{
                        background:
                          b.split_reason === 'max_duration_4_5h'
                            ? 'rgba(234, 88, 12, 0.12)'
                            : b.split_reason === 'gap_gt_60'
                            ? 'rgba(2, 132, 199, 0.12)'
                            : 'var(--bg-muted)',
                        color:
                          b.split_reason === 'max_duration_4_5h'
                            ? '#c2410c'
                            : b.split_reason === 'gap_gt_60'
                            ? '#0369a1'
                            : 'var(--text-tertiary)',
                      }}
                    >
                      {splitReasonLabel(b.split_reason, blockSeparatorMin, maxBlockMin, t)}
                    </span>
                  </Td>
                  <Td>
                    {b.merge_status === 'merged_short' ? (
                      <span
                        className="px-1.5 py-0.5 rounded text-[10px] font-semibold"
                        style={{ background: 'rgba(21, 128, 61, 0.12)', color: '#15803d' }}
                      >
                        {t('mp.planner.shortMerged')}
                      </span>
                    ) : b.merge_status === 'short_warning' ? (
                      <span
                        className="px-1.5 py-0.5 rounded text-[10px] font-semibold"
                        style={{ background: 'rgba(234, 88, 12, 0.12)', color: '#c2410c' }}
                        title={t('mp.planner.shortBlockTitle', { minutes: result.summary.min_block_duration_minutes })}
                      >
                        {t('mp.planner.shortBelow', { minutes: result.summary.min_block_duration_minutes })}
                      </span>
                    ) : (
                      <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>—</span>
                    )}
                  </Td>
                  <Td>
                    <span className="font-mono text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
                      {b.first_excel_row != null && b.last_excel_row != null
                        ? t('mp.planner.rowsRange', { from: b.first_excel_row, to: b.last_excel_row })
                        : `${b.first_trip_id.slice(0, 8)}…${b.last_trip_id.slice(0, 8)}`}
                    </span>
                  </Td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        )}
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  highlight,
  tone,
}: {
  label: string;
  value: number | string;
  highlight?: boolean;
  tone?: 'ok' | 'danger' | 'warning';
}) {
  const color =
    tone === 'danger' ? 'var(--danger, #b91c1c)' :
    tone === 'warning' ? '#c2410c' :
    tone === 'ok' ? 'var(--success, #15803d)' :
    highlight ? 'var(--primary)' :
    'var(--text-primary)';
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider font-semibold mb-1"
        style={{ color: 'var(--text-tertiary)' }}>
        {label}
      </div>
      <div className="text-xl font-bold" style={{ color }}>
        {value}
      </div>
    </div>
  );
}

function Th({ children, align }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th
      className="px-3 py-2 text-[11px] uppercase tracking-wider font-semibold"
      style={{ color: 'var(--text-tertiary)', textAlign: align ?? 'left' }}
    >
      {children}
    </th>
  );
}

function Td({ children, align }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <td className="px-3 py-2" style={{ color: 'var(--text-primary)', textAlign: align ?? 'left' }}>
      {children}
    </td>
  );
}

/** One planning mode to choose: what it is for, and the button that starts it (phase 5). */
function ModeCard({
  icon: Icon,
  title,
  description,
  action,
  badge,
  headingLevel = 'h2',
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  action: React.ReactNode;
  badge?: React.ReactNode;
  headingLevel?: 'h2' | 'h3';
}) {
  return (
    <Card className="flex flex-col gap-4 p-6">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-control bg-brand-soft text-brand-text">
          <Icon aria-hidden className="size-5" />
        </span>
        <div className="grid justify-items-start gap-1.5 pt-1.5">
          <CardTitle as={headingLevel} className="text-base">{title}</CardTitle>
          {badge}
        </div>
      </div>
      <p className="flex-1 text-sm leading-relaxed text-fg-muted">{description}</p>
      <div>{action}</div>
    </Card>
  );
}
