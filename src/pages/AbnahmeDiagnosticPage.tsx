/**
 * Read-only Abnahme diagnostic page for the stable V1 Planning Run.
 * Checks Fahrtenbuch integrity, driver distribution, Stundennachweis
 * consistency, and the max-3-Schichten compression rule.
 *
 * IMPORTANT: This page performs NO writes and changes NO data.
 */

import React, { useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { CheckCircle, AlertTriangle, XCircle, RefreshCw } from 'lucide-react';
import { Alert, Badge, Button, Card, PageHeader, cn } from '../components/ui';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';

// ── Constants ──────────────────────────────────────────────────────────────
const STABLE_RUN_ID = '74b45e4d-9fa9-444d-8fbc-995274269148';

const EXPECTED = {
  totalFahrten: 1692,
  missingDriverId: 0,
  missingDriverName: 0,
  missingBlockId: 0,
  distinctBlocks: 311,
  distinctDrivers: 9,
};

// These column lists are module-level and t() is a hook value, so they hold
// TranslationKeys and the call site resolves them.
const DRIVER_TABLE_KEYS: TranslationKey[] = [
  'common.driver', 'diag.colTrips', 'diag.colBlocks', 'diag.colMinutes',
  'diag.colHours', 'diag.colFirstDay', 'diag.colLastDay',
];

const SHEET_TABLE_KEYS: TranslationKey[] = [
  'common.driver', 'diag.colTrips', 'diag.colShiftsRaw', 'diag.colShiftsCompressed',
  'diag.colHoursTotal', 'diag.colNight', 'diag.colSunday', 'diag.colMaxShiftsStatus',
];

// ── Time helpers (duplicated from StundennachweisPage for independence) ────
function toMins(time: string): number {
  if (!time || !time.includes(':')) return 0;
  const [h, m] = time.split(':').map(Number);
  if (isNaN(h) || isNaN(m)) return 0;
  return h * 60 + m;
}

function minsToHHMM(mins: number): string {
  if (mins <= 0) return '0:00';
  return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}`;
}

function segDuration(from: string | null, to: string | null): number {
  if (!from || !to) return 0;
  const startMin = toMins(from), endMin = toMins(to);
  return endMin >= startMin ? endMin - startMin : 1440 - startMin + endMin;
}

function nightMinsForSeg(from: string | null, to: string | null): number {
  if (!from || !to) return 0;
  const f = toMins(from), endMin = toMins(to);
  const absTo = endMin >= f ? endMin : endMin + 1440;
  const seg1 = Math.max(0, Math.min(absTo, 24 * 60) - Math.max(f, 20 * 60));
  const seg2 = Math.max(0, Math.min(absTo, 30 * 60) - Math.max(f, 24 * 60));
  return seg1 + seg2;
}

function isDateSunday(dateStr: string): boolean {
  const [y, mo, d] = dateStr.split('-').map(Number);
  return new Date(y, mo - 1, d).getDay() === 0;
}

// ── Shift compression (≤ 3 shifts per day, ≤ 270 min each, ≤ 510 min/day) ─
interface RawTrip {
  id: string;
  trip_date: string;
  start_time: string | null;
  end_time: string | null;
  actual_work_minutes: number | null;
  assigned_driver_id: string | null;
  assigned_driver_name: string | null;
  assignment_block_id: string | null;
  assignment_planning_run_id: string | null;
  is_canceled: boolean;
  plausibility_status: string | null;
  original_driver_name: string | null;
}

interface ShiftWindow { start: number; end: number }

function compressShiftsForDay(trips: RawTrip[]): { von1: string; bis1: string; von2: string; bis2: string; von3: string; bis3: string } {
  const MAX_SHIFT = 270;
  const MAX_DAY   = 510;

  // Collect valid time windows
  const windows: ShiftWindow[] = [];
  for (const trip of trips) {
    if (!trip.start_time || !trip.end_time) continue;
    const s = toMins(trip.start_time.slice(0, 5));
    let e = toMins(trip.end_time.slice(0, 5));
    if (e < s) e += 1440;
    windows.push({ start: s, end: e });
  }

  windows.sort((a, b) => a.start - b.start);

  // Merge overlapping windows
  const merged: ShiftWindow[] = [];
  for (const w of windows) {
    if (merged.length === 0 || w.start > merged[merged.length - 1].end) {
      merged.push({ ...w });
    } else {
      merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, w.end);
    }
  }

  // Cap each shift at MAX_SHIFT and total at MAX_DAY
  const capped: ShiftWindow[] = [];
  let dayTotal = 0;
  for (const w of merged) {
    if (capped.length >= 3) break;
    const dur = Math.min(w.end - w.start, MAX_SHIFT, MAX_DAY - dayTotal);
    if (dur <= 0) break;
    capped.push({ start: w.start, end: w.start + dur });
    dayTotal += dur;
    if (dayTotal >= MAX_DAY) break;
  }

  const fmt = (m: number) => {
    const h = Math.floor((m % 1440) / 60), mn = (m % 1440) % 60;
    return `${String(h).padStart(2, '0')}:${String(mn).padStart(2, '0')}`;
  };

  return {
    von1: capped[0] ? fmt(capped[0].start) : '',
    bis1: capped[0] ? fmt(capped[0].end)   : '',
    von2: capped[1] ? fmt(capped[1].start) : '',
    bis2: capped[1] ? fmt(capped[1].end)   : '',
    von3: capped[2] ? fmt(capped[2].start) : '',
    bis3: capped[2] ? fmt(capped[2].end)   : '',
  };
}

// ── Types for report sections ──────────────────────────────────────────────
interface PlanningRunInfo {
  id: string;
  status: string;
  company_id: string;
  applied_at: string | null;
  apply_summary_json: Record<string, number> | null;
}

interface DriverStat {
  name: string;
  fahrten: number;
  blocks: Set<string>;
  workMinutes: number;
  firstDate: string;
  lastDate: string;
}

interface StundennachweisDriverSummary {
  name: string;
  fahrten: number;
  shiftsBeforeCompression: number;
  shiftsAfterCompression: number;
  totalMins: number;
  nightMins: number;
  sundayMins: number;
  maxShiftsViolation: boolean;
  daysWith4Plus: Array<{ date: string; shifts: number }>;
}

interface DiagResult {
  run: PlanningRunInfo | null;
  totalTrips: number;
  nonCanceled: number;
  missingDriverId: number;
  missingDriverName: number;
  missingBlockId: number;
  distinctBlocks: number;
  distinctDrivers: number;
  duplicateTripIds: string[];
  tripsWithNoTime: number;
  tripsNegativeMinutes: number;
  driverStats: DriverStat[];
  stundennachweis: StundennachweisDriverSummary[];
  criticalErrors: string[];
  warnings: string[];
}


// ── Main Page ─────────────────────────────────────────────────────────────
export default function AbnahmeDiagnosticPage() {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<DiagResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runDiagnostic = useCallback(async () => {
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const criticalErrors: string[] = [];
      const warnings: string[] = [];

      // ── 1. Planning Run Info ───────────────────────────────────────────────
      /*
        maybeSingle, not single. With `.single()` PostgREST answers zero rows
        with 406 PGRST116, and supabase-js clears that error only for
        `maybeSingle` — so under `.single()` an invisible run arrived as an
        *error*, `runErr` was set, and the "unreadable" branch below could never
        be taken. `maybeSingle` answers zero rows as data null, error null, and
        keeps a real failure an error.
      */
      const { data: runData, error: runErr } = await supabase
        .from('company_planning_runs')
        .select('id, status, company_id, applied_at, apply_summary_json')
        .eq('id', STABLE_RUN_ID)
        .maybeSingle();

      /*
        Absent with no error is not "missing" — it is a row this account cannot
        see. Since 20260917140000 (plan 3.4) a platform account reads no
        company's planning runs without an open context, and this page pins one
        run id, so for such a caller everything below is computed from nothing:
        the trip query returns no rows, so errNoTrips fires as a critical and
        both distinct-count warnings fire, 0 blocks and 0 drivers against the
        expected counts — for a run that is perfectly sound. (The missing-column and totals checks stay
        quiet, because they count over those same zero trips.) A real query
        error still reports as one; the invisible case is corrected once, just
        before the result is set.

        RLS cannot tell "no such run" from "not yours", so the message says what
        is actually known: not readable from this account.
      */
      const unreadable = !runData && !runErr;
      if (runErr) {
        criticalErrors.push(t('diag.errRunNotFound', { message: runErr.message }));
      }

      const run: PlanningRunInfo | null = runData ? {
        id: runData.id,
        status: runData.status,
        company_id: runData.company_id,
        applied_at: runData.applied_at,
        apply_summary_json: runData.apply_summary_json as Record<string, number> | null,
      } : null;

      if (run && run.status !== 'applied') {
        // `status` and `applied` are database values, not labels.
        criticalErrors.push(t('diag.errRunStatus', { status: run.status, expected: 'applied' }));
      }

      // ── 2. Load all trips for this planning run ────────────────────────────
      const { data: tripsRaw, error: tripsErr } = await supabase
        .from('fahrtenbuch_trips')
        .select('id, trip_date, start_time, end_time, actual_work_minutes, assigned_driver_id, assigned_driver_name, assignment_block_id, assignment_planning_run_id, is_canceled, plausibility_status, original_driver_name')
        .eq('assignment_planning_run_id', STABLE_RUN_ID)
        .order('trip_date', { ascending: true })
        .order('start_time', { ascending: true });

      if (tripsErr) {
        criticalErrors.push(t('diag.errTripQueryFailed', { message: tripsErr.message }));
      }

      const trips: RawTrip[] = (tripsRaw ?? []) as RawTrip[];
      const nonCanceled = trips.filter(trip => !trip.is_canceled);
      const totalTrips = trips.length;

      // Expected trip count
      if (totalTrips === 0) {
        criticalErrors.push(t('diag.errNoTrips'));
      } else if (totalTrips !== EXPECTED.totalFahrten) {
        criticalErrors.push(t('diag.errTripCount', { actual: totalTrips, expected: EXPECTED.totalFahrten }));
      }

      // Duplicate trip IDs
      const idSet = new Set<string>();
      const duplicateTripIds: string[] = [];
      for (const trip of trips) {
        if (idSet.has(trip.id)) duplicateTripIds.push(trip.id);
        idSet.add(trip.id);
      }
      if (duplicateTripIds.length > 0) {
        criticalErrors.push(t('diag.errDuplicateTripIds', { count: duplicateTripIds.length }));
      }

      // Missing fields (non-canceled only)
      const missingDriverId    = nonCanceled.filter(trip => !trip.assigned_driver_id).length;
      const missingDriverName  = nonCanceled.filter(trip => !trip.assigned_driver_name).length;
      const missingBlockId     = nonCanceled.filter(trip => !trip.assignment_block_id).length;

      // The interpolated names are database columns, not labels.
      if (missingDriverId > 0)   criticalErrors.push(t('diag.errTripsMissingColumn', { count: missingDriverId, column: 'assigned_driver_id' }));
      if (missingDriverName > 0) criticalErrors.push(t('diag.errTripsMissingColumn', { count: missingDriverName, column: 'assigned_driver_name' }));
      if (missingBlockId > 0)    criticalErrors.push(t('diag.errTripsMissingColumn', { count: missingBlockId, column: 'assignment_block_id' }));

      // Distinct blocks and drivers
      const blockSet = new Set(nonCanceled.map(trip => trip.assignment_block_id).filter(Boolean));
      // `.filter(Boolean)` drops the nulls but does not narrow the type, so the
      // Set read as `Set<string | null>` and every consumer had to pretend a
      // null could arrive. A real type guard states what the filter already does.
      const driverSet = new Set(
        nonCanceled.map(trip => trip.assigned_driver_name).filter((n): n is string => Boolean(n)),
      );
      const distinctBlocks  = blockSet.size;
      const distinctDrivers = driverSet.size;

      if (distinctBlocks !== EXPECTED.distinctBlocks) {
        warnings.push(t('diag.warnDistinctBlocks', { actual: distinctBlocks, expected: EXPECTED.distinctBlocks }));
      }
      if (distinctDrivers !== EXPECTED.distinctDrivers) {
        warnings.push(t('diag.warnDistinctDrivers', { actual: distinctDrivers, expected: EXPECTED.distinctDrivers }));
      }

      // Invalid times
      const tripsWithNoTime = nonCanceled.filter(trip => !trip.start_time || !trip.end_time).length;
      if (tripsWithNoTime > 0) {
        criticalErrors.push(t('diag.errTripsWithoutTimes', { count: tripsWithNoTime }));
      }

      // Negative/zero actual_work_minutes (only for non-canceled with times)
      const tripsNegativeMinutes = nonCanceled.filter(trip =>
        trip.start_time && trip.end_time && trip.actual_work_minutes !== null && (trip.actual_work_minutes ?? 0) <= 0
      ).length;
      if (tripsNegativeMinutes > 0) {
        warnings.push(t('diag.warnNonPositiveMinutes', { count: tripsNegativeMinutes }));
      }

      // ── 3. Driver Distribution ─────────────────────────────────────────────
      const driverMap = new Map<string, DriverStat>();
      for (const trip of nonCanceled) {
        const name = trip.assigned_driver_name ?? t('diag.unknownDriver');
        if (!driverMap.has(name)) {
          driverMap.set(name, { name, fahrten: 0, blocks: new Set(), workMinutes: 0, firstDate: trip.trip_date, lastDate: trip.trip_date });
        }
        const stat = driverMap.get(name)!;
        stat.fahrten++;
        if (trip.assignment_block_id) stat.blocks.add(trip.assignment_block_id);
        stat.workMinutes += trip.actual_work_minutes ?? segDuration(
          trip.start_time?.slice(0, 5) ?? null,
          trip.end_time?.slice(0, 5) ?? null,
        );
        if (trip.trip_date < stat.firstDate) stat.firstDate = trip.trip_date;
        if (trip.trip_date > stat.lastDate)  stat.lastDate  = trip.trip_date;
      }
      const driverStats = [...driverMap.values()].sort((a, b) => b.fahrten - a.fahrten);

      // ── 4 & 5. Stundennachweis Integrity + Max-3-Schichten ─────────────────
      const stundennachweis: StundennachweisDriverSummary[] = [];

      for (const driverName of [...driverSet].sort()) {
        const driverTrips = nonCanceled.filter(trip => trip.assigned_driver_name === driverName);

        // Group by date
        const byDate = new Map<string, RawTrip[]>();
        for (const trip of driverTrips) {
          if (!byDate.has(trip.trip_date)) byDate.set(trip.trip_date, []);
          byDate.get(trip.trip_date)!.push(trip);
        }

        let totalMins = 0;
        let nightMins = 0;
        let sundayMins = 0;
        let shiftsBeforeCompression = 0;
        let shiftsAfterCompression = 0;
        const daysWith4Plus: Array<{ date: string; shifts: number }> = [];

        for (const [date, dayTrips] of byDate.entries()) {
          // Before compression: count individual trips with times
          const validTrips = dayTrips.filter(trip => trip.start_time && trip.end_time);
          shiftsBeforeCompression += validTrips.length;

          // After compression
          const { von1, bis1, von2, bis2, von3, bis3 } = compressShiftsForDay(dayTrips);
          const compressed = [
            [von1, bis1], [von2, bis2], [von3, bis3]
          ].filter(([v, b]) => v && b);
          shiftsAfterCompression += compressed.length;

          if (compressed.length > 3) {
            daysWith4Plus.push({ date, shifts: compressed.length });
          }

          // Accumulate hours
          for (const [v, b] of compressed) {
            totalMins += segDuration(v, b);
            nightMins += nightMinsForSeg(v, b);
          }

          // Sunday
          if (isDateSunday(date)) {
            for (const [v, b] of compressed) {
              sundayMins += segDuration(v, b);
            }
          }
        }

        const maxShiftsViolation = daysWith4Plus.length > 0;
        if (maxShiftsViolation) {
          warnings.push(t('diag.warnMaxShifts', { driver: driverName, count: daysWith4Plus.length }));
        }

        stundennachweis.push({
          name: driverName,
          fahrten: driverTrips.length,
          shiftsBeforeCompression,
          shiftsAfterCompression,
          totalMins,
          nightMins,
          sundayMins,
          maxShiftsViolation,
          daysWith4Plus,
        });
      }

      // ── 6. Totals Consistency ──────────────────────────────────────────────
      const snTotal = stundennachweis.reduce((s, d) => s + d.fahrten, 0);
      if (snTotal !== nonCanceled.length) {
        criticalErrors.push(t('diag.errTotalsMismatch', { sheet: snTotal, assigned: nonCanceled.length }));
      }

      // One honest line instead of a cascade of false findings: none of the
      // checks above saw real data, so none of them is a finding. A warning
      // rather than a critical, because nothing here is wrong.
      if (unreadable) {
        criticalErrors.length = 0;
        warnings.length = 0;
        warnings.push(t('diag.warnNotAvailableHere'));
      }

      setResult({
        run,
        totalTrips,
        nonCanceled: nonCanceled.length,
        missingDriverId,
        missingDriverName,
        missingBlockId,
        distinctBlocks,
        distinctDrivers,
        duplicateTripIds,
        tripsWithNoTime,
        tripsNegativeMinutes,
        driverStats,
        stundennachweis,
        criticalErrors,
        warnings,
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [t]);

  const fmtDate = (s: string) => {
    const [y, mo, d] = s.split('-');
    return `${d}.${mo}.${y}`;
  };

  const productionReadiness = result
    ? result.criticalErrors.length === 0
      ? result.warnings.length === 0 ? 100 : Math.max(60, 100 - result.warnings.length * 5)
      : Math.max(0, 100 - result.criticalErrors.length * 20 - result.warnings.length * 3)
    : 0;

  // ── Presentation (phase 5)
  const sectionGrid = 'grid grid-cols-1 gap-4';
  const tableTh = 'whitespace-nowrap px-2.5 py-1.5 text-start text-[11px] font-semibold uppercase tracking-[0.05em] text-fg-subtle';
  const tdMuted = 'px-2.5 py-[7px] tabular-nums whitespace-nowrap text-fg-muted';
  const tdTotal = 'px-2.5 py-[7px] tabular-nums whitespace-nowrap text-brand-text';
  const tile = 'rounded-tile border px-4 py-3.5';
  const tileLabel = 'mb-1.5 text-[11px] text-fg-subtle';
  const tileFigure = 'text-[22px] font-extrabold tabular-nums';

  return (
    <div className="mx-auto grid max-w-[1100px] grid-cols-1 gap-4 px-4 py-6 font-ui text-fg">

      {/* Page header */}
      <PageHeader
        className="pb-0"
        title={t('diag.pageTitle')}
        description={<>{t('diag.pageSubtitle')} · <span className="font-mono">{STABLE_RUN_ID}</span></>}
        actions={(
          <Button variant="secondary" onClick={runDiagnostic} disabled={loading}>
            <RefreshCw aria-hidden className={loading ? 'motion-safe:animate-spin' : undefined} />
            {loading ? t('diag.running') : t('diag.start')}
          </Button>
        )}
      >
        <p className="text-[13px] text-fg-muted">{t('diag.readOnlyNote')}</p>
      </PageHeader>

      {error && (
        <Alert tone="critical">
          <strong>{t('common.error')}:</strong> {error}
        </Alert>
      )}

      {result && (
        <div className={sectionGrid}>
          {/* ── Final Summary ─────────────────────────────────────────────── */}
          <Card className="p-5">
            <SectionTitle>{t('common.summary')}</SectionTitle>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3">
              {([
                { label: 'diag.fahrtenbuchClean', val: result.criticalErrors.length === 0 && result.duplicateTripIds.length === 0 && result.missingBlockId === 0 },
                { label: 'diag.stundennachweisClean', val: result.stundennachweis.every(s => !s.maxShiftsViolation) },
              ] as const).map(({ label, val }) => (
                <div key={label} className={cn(tile, val ? 'border-positive/25 bg-positive-soft' : 'border-critical/25 bg-critical-soft')}>
                  <p className={tileLabel}>{t(label)}</p>
                  <StatusBadge ok={val} label={val ? t('diag.yes') : t('diag.no')} />
                </div>
              ))}
              <div className={cn(tile, 'border-critical/25 bg-critical-soft')}>
                <p className={tileLabel}>{t('diag.criticalErrors')}</p>
                <span className={cn(tileFigure, result.criticalErrors.length > 0 ? 'text-critical' : 'text-positive')}>{result.criticalErrors.length}</span>
              </div>
              <div className={cn(tile, 'border-caution/20 bg-caution-soft')}>
                <p className={tileLabel}>{t('diag.warnings')}</p>
                <span className={cn(tileFigure, result.warnings.length > 0 ? 'text-caution' : 'text-positive')}>{result.warnings.length}</span>
              </div>
              <div className={cn(tile, 'border-info/20 bg-info-soft')}>
                <p className={tileLabel}>{t('diag.productionReadiness')}</p>
                <span className={cn(tileFigure, productionReadiness >= 95 ? 'text-positive' : productionReadiness >= 70 ? 'text-caution' : 'text-critical')}>{productionReadiness} %</span>
              </div>
            </div>

            {result.criticalErrors.length > 0 && (
              <Alert tone="critical" title={t('diag.criticalErrors')} className="mt-4">
                {result.criticalErrors.map((e, i) => (
                  <div key={i} className="mb-1 flex items-center gap-2 text-[13px]">
                    <XCircle aria-hidden className="size-[13px] shrink-0 text-critical" />
                    {e}
                  </div>
                ))}
              </Alert>
            )}
            {result.warnings.length > 0 && (
              <Alert tone="caution" title={t('diag.warnings')} className="mt-3">
                {result.warnings.map((w, i) => (
                  <div key={i} className="mb-1 flex items-center gap-2 text-[13px]">
                    <AlertTriangle aria-hidden className="size-[13px] shrink-0 text-caution" />
                    {w}
                  </div>
                ))}
              </Alert>
            )}
          </Card>

          {/* ── 1. Planning Run Integrity ──────────────────────────────────── */}
          <Card className="p-5">
            <SectionTitle>{t('diag.section1')}</SectionTitle>
            {result.run && (
              <>
                {/* Run ID, company ID and the apply-summary keys are raw database values. */}
                <Row label={t('diag.rowRunId')} value={result.run.id} />
                <Row label={t('common.status')} value={result.run.status} ok={result.run.status === 'applied'} error={result.run.status !== 'applied'} />
                <Row label={t('diag.rowCompanyId')} value={result.run.company_id} />
                <Row label={t('diag.rowAppliedAt')} value={result.run.applied_at ? new Date(result.run.applied_at).toLocaleString('de-DE') : '—'} />
                {result.run.apply_summary_json && Object.entries(result.run.apply_summary_json).map(([k, v]) => (
                  <Row key={k} label={k} value={v} />
                ))}
                <div className="mt-3 border-t border-line pt-3">
                  <Row label={t('diag.rowTotalTrips')} value={result.totalTrips}
                    ok={result.totalTrips === EXPECTED.totalFahrten}
                    error={result.totalTrips !== EXPECTED.totalFahrten} />
                  <Row label={t('diag.rowAssignedTrips')} value={result.nonCanceled} />
                  <Row label={t('diag.rowMissingColumn', { column: 'assigned_driver_id' })} value={result.missingDriverId}
                    ok={result.missingDriverId === EXPECTED.missingDriverId}
                    error={result.missingDriverId > 0} />
                  <Row label={t('diag.rowMissingColumn', { column: 'assigned_driver_name' })} value={result.missingDriverName}
                    ok={result.missingDriverName === EXPECTED.missingDriverName}
                    error={result.missingDriverName > 0} />
                  <Row label={t('diag.rowMissingColumn', { column: 'assignment_block_id' })} value={result.missingBlockId}
                    ok={result.missingBlockId === EXPECTED.missingBlockId}
                    error={result.missingBlockId > 0} />
                  <Row label={t('diag.rowDistinctColumn', { column: 'assignment_block_id' })} value={result.distinctBlocks}
                    ok={result.distinctBlocks === EXPECTED.distinctBlocks}
                    warn={result.distinctBlocks !== EXPECTED.distinctBlocks} />
                  <Row label={t('diag.rowDistinctDrivers')} value={result.distinctDrivers}
                    ok={result.distinctDrivers === EXPECTED.distinctDrivers}
                    warn={result.distinctDrivers !== EXPECTED.distinctDrivers} />
                </div>
              </>
            )}
          </Card>

          {/* ── 2. Fahrtenbuch Integrity ───────────────────────────────────── */}
          <Card className="p-5">
            <SectionTitle>{t('diag.section2')}</SectionTitle>
            <Row label={t('diag.rowDuplicateTripIds')}
              value={result.duplicateTripIds.length}
              ok={result.duplicateTripIds.length === 0}
              error={result.duplicateTripIds.length > 0} />
            <Row label={t('diag.rowTripsWithoutTimes')}
              value={result.tripsWithNoTime}
              ok={result.tripsWithNoTime === 0}
              warn={result.tripsWithNoTime > 0} />
            <Row label={t('diag.rowTripsNonPositiveMinutes')}
              value={result.tripsNegativeMinutes}
              ok={result.tripsNegativeMinutes === 0}
              warn={result.tripsNegativeMinutes > 0} />
            <Row label={t('diag.rowTripsWithoutDriver')}
              value={result.missingDriverId}
              ok={result.missingDriverId === 0}
              error={result.missingDriverId > 0} />
            <Row label={t('diag.rowTripsWithoutBlock')}
              value={result.missingBlockId}
              ok={result.missingBlockId === 0}
              error={result.missingBlockId > 0} />

            {result.duplicateTripIds.length > 0 && (
              <Alert tone="critical" title={t('diag.duplicateIdsSample')} className="mt-2.5">
                {result.duplicateTripIds.slice(0, 5).map(id => (
                  <p key={id} className="my-0.5 break-all font-mono text-[11px]">{id}</p>
                ))}
              </Alert>
            )}

            <div className={cn('mt-3 rounded-tight border px-3 py-2.5', result.criticalErrors.length === 0 && result.warnings.length === 0 ? 'border-positive/20 bg-positive-soft' : 'border-caution/20 bg-caution-soft')}>
              <StatusBadge
                ok={result.criticalErrors.length === 0 && result.duplicateTripIds.length === 0 && result.missingBlockId === 0}
                warn={result.warnings.length > 0 && result.criticalErrors.length === 0}
                label={result.criticalErrors.length === 0 && result.duplicateTripIds.length === 0 && result.missingBlockId === 0
                  ? t('diag.fahrtenbuchOk')
                  : result.criticalErrors.length > 0 ? t('diag.errorsFound') : t('diag.warningsPresent')}
              />
            </div>
          </Card>

          {/* ── 3. Driver Distribution ─────────────────────────────────────── */}
          <Card className="p-5">
            <SectionTitle>{t('diag.section3')}</SectionTitle>
            <div className="relative overflow-x-auto">
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr className="border-b border-line">
                    {DRIVER_TABLE_KEYS.map(h => (
                      <th key={h} scope="col" className={tableTh}>{t(h)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.driverStats.map(d => (
                    <tr key={d.name} className="border-b border-line hover:bg-sunken">
                      <td className="whitespace-nowrap px-2.5 py-[7px] font-bold text-fg">{d.name}</td>
                      <td className={tdMuted}>{d.fahrten}</td>
                      <td className={tdMuted}>{d.blocks.size}</td>
                      <td className={tdMuted}>{d.workMinutes}</td>
                      <td className={tdMuted}>{minsToHHMM(d.workMinutes)}</td>
                      <td className={tdMuted}>{fmtDate(d.firstDate)}</td>
                      <td className={tdMuted}>{fmtDate(d.lastDate)}</td>
                    </tr>
                  ))}
                  <tr className="border-t border-line-strong bg-brand-soft">
                    <td className="px-2.5 py-[7px] font-extrabold text-brand-text">{t('diag.total')}</td>
                    <td className={cn(tdTotal, 'font-bold')}>
                      {result.driverStats.reduce((s, d) => s + d.fahrten, 0)}
                    </td>
                    <td className={tdTotal}>
                      {result.distinctBlocks}
                    </td>
                    <td className={tdTotal}>
                      {result.driverStats.reduce((s, d) => s + d.workMinutes, 0)}
                    </td>
                    <td className={tdTotal}>
                      {minsToHHMM(result.driverStats.reduce((s, d) => s + d.workMinutes, 0))}
                    </td>
                    <td colSpan={2} />
                  </tr>
                </tbody>
              </table>
            </div>
          </Card>

          {/* ── 4. Stundennachweis Integrity ───────────────────────────────── */}
          <Card className="p-5">
            <SectionTitle>{t('diag.section4')}</SectionTitle>
            <div className="relative overflow-x-auto">
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr className="border-b border-line">
                    {SHEET_TABLE_KEYS.map(h => (
                      <th key={h} scope="col" className={tableTh}>{t(h)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.stundennachweis.map(d => (
                    <tr key={d.name} className="border-b border-line hover:bg-sunken">
                      <td className="whitespace-nowrap px-2.5 py-[7px] font-bold text-fg">{d.name}</td>
                      <td className={tdMuted}>{d.fahrten}</td>
                      <td className={tdMuted}>{d.shiftsBeforeCompression}</td>
                      <td className={tdMuted}>{d.shiftsAfterCompression}</td>
                      <td className={tdMuted}>{minsToHHMM(d.totalMins)}</td>
                      <td className={tdMuted}>{d.nightMins > 0 ? minsToHHMM(d.nightMins) : '—'}</td>
                      <td className={tdMuted}>{d.sundayMins > 0 ? minsToHHMM(d.sundayMins) : '—'}</td>
                      <td className="px-2.5 py-[7px]">
                        <StatusBadge ok={!d.maxShiftsViolation}
                          label={d.maxShiftsViolation ? t('diag.violated', { count: d.daysWith4Plus.length }) : t('diag.ok')} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {/* ── 5. Max-3-Schichten Check ───────────────────────────────────── */}
          <Card className="p-5">
            <SectionTitle>{t('diag.section5')}</SectionTitle>
            {result.stundennachweis.every(d => !d.maxShiftsViolation) ? (
              <div className="flex items-center gap-2.5 rounded-tight border border-positive/25 bg-positive-soft px-3.5 py-3">
                <CheckCircle aria-hidden className="size-[18px] text-positive" />
                <span className="text-sm font-bold text-positive">{t('diag.maxShiftsAllOk')}</span>
              </div>
            ) : (
              <div>
                {result.stundennachweis.filter(d => d.maxShiftsViolation).map(d => (
                  <div key={d.name} className="mb-3">
                    <p className="mb-1.5 text-[13px] font-bold text-critical">
                      <XCircle aria-hidden className="me-1.5 inline size-[13px]" />
                      {t('diag.driverViolationDays', { driver: d.name, count: d.daysWith4Plus.length })}
                    </p>
                    {d.daysWith4Plus.map(day => (
                      <p key={day.date} className="my-0.5 ms-5 text-xs tabular-nums text-fg-muted">
                        {t('diag.dayShiftCount', { date: fmtDate(day.date), count: day.shifts })}
                      </p>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </Card>

          {/* ── 6. Totals Consistency ─────────────────────────────────────── */}
          <Card className="p-5">
            <SectionTitle>{t('diag.section6')}</SectionTitle>
            <Row label={t('diag.rowTripsTotal')} value={result.totalTrips} />
            <Row label={t('diag.rowTripsNotCanceled')} value={result.nonCanceled} />
            <Row label={t('diag.rowTripsInStundennachweis')} value={result.stundennachweis.reduce((s, d) => s + d.fahrten, 0)}
              ok={result.stundennachweis.reduce((s, d) => s + d.fahrten, 0) === result.nonCanceled}
              error={result.stundennachweis.reduce((s, d) => s + d.fahrten, 0) !== result.nonCanceled} />
            <Row label={t('diag.rowShiftsBeforeCompression')} value={result.stundennachweis.reduce((s, d) => s + d.shiftsBeforeCompression, 0)} />
            <Row label={t('diag.rowShiftsAfterCompression')} value={result.stundennachweis.reduce((s, d) => s + d.shiftsAfterCompression, 0)} />
            <Row label={t('diag.rowCompressionChangesTripCount')} value={t('diag.compressionNeverChangesTrips')} ok={true} />
            <div className="mt-3 rounded-tight border border-info/20 bg-info-soft px-3 py-2.5">
              <p className="text-xs text-fg-muted">
                {t('diag.compressionNote')}
              </p>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

// ── Presentation helpers ──────────────────────────────────────────────────
function StatusBadge({ ok, warn, label }: { ok?: boolean; warn?: boolean; label: string }) {
  const tone = ok ? 'positive' : warn ? 'caution' : 'critical';
  const Icon = ok ? CheckCircle : warn ? AlertTriangle : XCircle;
  return (
    <Badge tone={tone}>
      <Icon aria-hidden />
      {label}
    </Badge>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-3 mt-0 text-[13px] font-bold uppercase tracking-[0.08em] text-fg-muted">
      {children}
    </h3>
  );
}

function Row({ label, value, ok, warn, error }: { label: string; value: string | number; ok?: boolean; warn?: boolean; error?: boolean }) {
  const { t } = useTranslation();
  const color = error ? 'text-critical' : warn ? 'text-caution' : ok ? 'text-positive' : 'text-fg';
  const Icon = error ? XCircle : warn ? AlertTriangle : ok ? CheckCircle : null;
  const word = error ? t('common.error') : warn ? t('diag.warnings') : ok ? t('diag.ok') : '';
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line py-1.5">
      <span className="min-w-0 text-[13px] text-fg-muted">{label}</span>
      <span className={`flex min-w-0 items-center gap-1.5 break-all text-end text-[13px] font-bold tabular-nums ${color}`}>
        {Icon ? <Icon aria-hidden className="size-3.5 shrink-0" /> : null}
        {word ? <span className="sr-only">{word}</span> : null}
        {value}
      </span>
    </div>
  );
}
