/**
 * Read-only Abnahme diagnostic page for the stable V1 Planning Run.
 * Checks Fahrtenbuch integrity, driver distribution, Stundennachweis
 * consistency, and the max-3-Schichten compression rule.
 *
 * IMPORTANT: This page performs NO writes and changes NO data.
 */

import React, { useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { CheckCircle, AlertTriangle, XCircle, RefreshCw, ClipboardList } from 'lucide-react';
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

// ── Status badge ──────────────────────────────────────────────────────────
function Badge({ ok, warn, label }: { ok?: boolean; warn?: boolean; label: string }) {
  const bg = ok ? 'rgba(22,163,74,0.12)' : warn ? 'rgba(234,179,8,0.15)' : 'rgba(220,38,38,0.12)';
  const border = ok ? '1px solid rgba(22,163,74,0.35)' : warn ? '1px solid rgba(234,179,8,0.35)' : '1px solid rgba(220,38,38,0.35)';
  const color = ok ? '#4ade80' : warn ? '#facc15' : '#f87171';
  const Icon = ok ? CheckCircle : warn ? AlertTriangle : XCircle;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: bg, border, borderRadius: 6, padding: '2px 8px', fontSize: 12, fontWeight: 600, color }}>
      <Icon style={{ width: 12, height: 12 }} />
      {label}
    </span>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 style={{ fontSize: 13, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 12, marginTop: 0 }}>
      {children}
    </h3>
  );
}

function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      background: '#0d1117', border: '1px solid rgba(255,255,255,0.07)',
      borderRadius: 12, padding: 20, marginBottom: 16,
      ...style,
    }}>
      {children}
    </div>
  );
}

function Row({ label, value, ok, warn, error }: { label: string; value: string | number; ok?: boolean; warn?: boolean; error?: boolean }) {
  const color = error ? '#f87171' : warn ? '#facc15' : ok ? '#4ade80' : '#e2e8f0';
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
      <span style={{ fontSize: 13, color: '#94a3b8' }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 700, color }}>{value}</span>
    </div>
  );
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

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 16px', color: '#e2e8f0' }}>

      {/* Page header */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
          <div style={{ width: 40, height: 40, borderRadius: 10, background: 'rgba(6,182,212,0.12)', border: '1px solid rgba(6,182,212,0.25)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <ClipboardList style={{ width: 20, height: 20, color: '#06b6d4' }} />
          </div>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 800, color: '#f1f5f9', margin: 0 }}>{t('diag.pageTitle')}</h1>
            <p style={{ fontSize: 12, color: '#475569', margin: 0 }}>{t('diag.pageSubtitle')} · {STABLE_RUN_ID}</p>
          </div>
        </div>
        <p style={{ fontSize: 13, color: '#64748b', margin: 0 }}>
          {t('diag.readOnlyNote')}
        </p>
      </div>

      {/* Run button */}
      <button
        onClick={runDiagnostic}
        disabled={loading}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '10px 20px', borderRadius: 10, fontSize: 14, fontWeight: 700,
          background: loading ? 'rgba(6,182,212,0.08)' : 'rgba(6,182,212,0.15)',
          border: '1px solid rgba(6,182,212,0.3)',
          color: loading ? '#475569' : '#06b6d4',
          cursor: loading ? 'not-allowed' : 'pointer',
          transition: 'all 0.18s',
          marginBottom: 24,
        }}
      >
        <RefreshCw style={{ width: 16, height: 16, animation: loading ? 'spin 1s linear infinite' : 'none' }} />
        {loading ? t('diag.running') : t('diag.start')}
      </button>
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>

      {error && (
        <Card style={{ border: '1px solid rgba(220,38,38,0.35)', background: 'rgba(220,38,38,0.06)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#f87171' }}>
            <XCircle style={{ width: 16, height: 16 }} />
            <strong>{t('common.error')}:</strong> {error}
          </div>
        </Card>
      )}

      {result && (
        <>
          {/* ── Final Summary ─────────────────────────────────────────────── */}
          <Card style={{ background: 'rgba(6,182,212,0.04)', border: '1px solid rgba(6,182,212,0.15)' }}>
            <SectionTitle>{t('common.summary')}</SectionTitle>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
              {([
                { label: 'diag.fahrtenbuchClean', val: result.criticalErrors.length === 0 && result.duplicateTripIds.length === 0 && result.missingBlockId === 0 },
                { label: 'diag.stundennachweisClean', val: result.stundennachweis.every(s => !s.maxShiftsViolation) },
              ] as const).map(({ label, val }) => (
                <div key={label} style={{ background: val ? 'rgba(22,163,74,0.08)' : 'rgba(220,38,38,0.08)', border: `1px solid ${val ? 'rgba(22,163,74,0.25)' : 'rgba(220,38,38,0.25)'}`, borderRadius: 10, padding: '14px 16px' }}>
                  <p style={{ fontSize: 11, color: '#64748b', margin: '0 0 6px' }}>{t(label)}</p>
                  <Badge ok={val} label={val ? t('diag.yes') : t('diag.no')} />
                </div>
              ))}
              <div style={{ background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.25)', borderRadius: 10, padding: '14px 16px' }}>
                <p style={{ fontSize: 11, color: '#64748b', margin: '0 0 6px' }}>{t('diag.criticalErrors')}</p>
                <span style={{ fontSize: 22, fontWeight: 900, color: result.criticalErrors.length > 0 ? '#f87171' : '#4ade80' }}>{result.criticalErrors.length}</span>
              </div>
              <div style={{ background: 'rgba(234,179,8,0.06)', border: '1px solid rgba(234,179,8,0.2)', borderRadius: 10, padding: '14px 16px' }}>
                <p style={{ fontSize: 11, color: '#64748b', margin: '0 0 6px' }}>{t('diag.warnings')}</p>
                <span style={{ fontSize: 22, fontWeight: 900, color: result.warnings.length > 0 ? '#facc15' : '#4ade80' }}>{result.warnings.length}</span>
              </div>
              <div style={{ background: 'rgba(6,182,212,0.06)', border: '1px solid rgba(6,182,212,0.2)', borderRadius: 10, padding: '14px 16px' }}>
                <p style={{ fontSize: 11, color: '#64748b', margin: '0 0 6px' }}>{t('diag.productionReadiness')}</p>
                <span style={{ fontSize: 22, fontWeight: 900, color: productionReadiness >= 95 ? '#4ade80' : productionReadiness >= 70 ? '#facc15' : '#f87171' }}>{productionReadiness} %</span>
              </div>
            </div>

            {result.criticalErrors.length > 0 && (
              <div style={{ marginTop: 16, background: 'rgba(220,38,38,0.07)', border: '1px solid rgba(220,38,38,0.25)', borderRadius: 8, padding: '12px 14px' }}>
                <p style={{ fontSize: 12, fontWeight: 700, color: '#f87171', margin: '0 0 8px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{t('diag.criticalErrors')}</p>
                {result.criticalErrors.map((e, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#fca5a5', marginBottom: 4 }}>
                    <XCircle style={{ width: 13, height: 13, flexShrink: 0 }} />
                    {e}
                  </div>
                ))}
              </div>
            )}
            {result.warnings.length > 0 && (
              <div style={{ marginTop: 12, background: 'rgba(234,179,8,0.06)', border: '1px solid rgba(234,179,8,0.2)', borderRadius: 8, padding: '12px 14px' }}>
                <p style={{ fontSize: 12, fontWeight: 700, color: '#facc15', margin: '0 0 8px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{t('diag.warnings')}</p>
                {result.warnings.map((w, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#fde68a', marginBottom: 4 }}>
                    <AlertTriangle style={{ width: 13, height: 13, flexShrink: 0 }} />
                    {w}
                  </div>
                ))}
              </div>
            )}
          </Card>

          {/* ── 1. Planning Run Integrity ──────────────────────────────────── */}
          <Card>
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
                <div style={{ marginTop: 12, borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 12 }}>
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
          <Card>
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
              <div style={{ marginTop: 10, padding: '10px 12px', background: 'rgba(220,38,38,0.07)', border: '1px solid rgba(220,38,38,0.2)', borderRadius: 8 }}>
                <p style={{ fontSize: 12, fontWeight: 700, color: '#f87171', margin: '0 0 6px' }}>{t('diag.duplicateIdsSample')}</p>
                {result.duplicateTripIds.slice(0, 5).map(id => (
                  <p key={id} style={{ fontSize: 11, color: '#fca5a5', margin: '2px 0', fontFamily: 'monospace' }}>{id}</p>
                ))}
              </div>
            )}

            <div style={{ marginTop: 12, padding: '10px 12px', background: result.criticalErrors.length === 0 && result.warnings.length === 0 ? 'rgba(22,163,74,0.06)' : 'rgba(234,179,8,0.06)', border: `1px solid ${result.criticalErrors.length === 0 && result.warnings.length === 0 ? 'rgba(22,163,74,0.2)' : 'rgba(234,179,8,0.2)'}`, borderRadius: 8 }}>
              <Badge
                ok={result.criticalErrors.length === 0 && result.duplicateTripIds.length === 0 && result.missingBlockId === 0}
                warn={result.warnings.length > 0 && result.criticalErrors.length === 0}
                label={result.criticalErrors.length === 0 && result.duplicateTripIds.length === 0 && result.missingBlockId === 0
                  ? t('diag.fahrtenbuchOk')
                  : result.criticalErrors.length > 0 ? t('diag.errorsFound') : t('diag.warningsPresent')}
              />
            </div>
          </Card>

          {/* ── 3. Driver Distribution ─────────────────────────────────────── */}
          <Card>
            <SectionTitle>{t('diag.section3')}</SectionTitle>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                    {DRIVER_TABLE_KEYS.map(h => (
                      <th key={h} style={{ textAlign: 'left', padding: '6px 10px', color: '#64748b', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t(h)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.driverStats.map(d => (
                    <tr key={d.name} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.03)')}
                      onMouseLeave={e => (e.currentTarget.style.background = '')}>
                      <td style={{ padding: '7px 10px', fontWeight: 700, color: '#e2e8f0' }}>{d.name}</td>
                      <td style={{ padding: '7px 10px', color: '#94a3b8' }}>{d.fahrten}</td>
                      <td style={{ padding: '7px 10px', color: '#94a3b8' }}>{d.blocks.size}</td>
                      <td style={{ padding: '7px 10px', color: '#94a3b8' }}>{d.workMinutes}</td>
                      <td style={{ padding: '7px 10px', color: '#94a3b8' }}>{minsToHHMM(d.workMinutes)}</td>
                      <td style={{ padding: '7px 10px', color: '#94a3b8' }}>{fmtDate(d.firstDate)}</td>
                      <td style={{ padding: '7px 10px', color: '#94a3b8' }}>{fmtDate(d.lastDate)}</td>
                    </tr>
                  ))}
                  <tr style={{ borderTop: '1px solid rgba(255,255,255,0.1)', background: 'rgba(6,182,212,0.04)' }}>
                    <td style={{ padding: '7px 10px', fontWeight: 800, color: '#06b6d4' }}>{t('diag.total')}</td>
                    <td style={{ padding: '7px 10px', fontWeight: 700, color: '#06b6d4' }}>
                      {result.driverStats.reduce((s, d) => s + d.fahrten, 0)}
                    </td>
                    <td style={{ padding: '7px 10px', color: '#06b6d4' }}>
                      {result.distinctBlocks}
                    </td>
                    <td style={{ padding: '7px 10px', color: '#06b6d4' }}>
                      {result.driverStats.reduce((s, d) => s + d.workMinutes, 0)}
                    </td>
                    <td style={{ padding: '7px 10px', color: '#06b6d4' }}>
                      {minsToHHMM(result.driverStats.reduce((s, d) => s + d.workMinutes, 0))}
                    </td>
                    <td colSpan={2} />
                  </tr>
                </tbody>
              </table>
            </div>
          </Card>

          {/* ── 4. Stundennachweis Integrity ───────────────────────────────── */}
          <Card>
            <SectionTitle>{t('diag.section4')}</SectionTitle>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                    {SHEET_TABLE_KEYS.map(h => (
                      <th key={h} style={{ textAlign: 'left', padding: '6px 10px', color: '#64748b', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t(h)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.stundennachweis.map(d => (
                    <tr key={d.name} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.03)')}
                      onMouseLeave={e => (e.currentTarget.style.background = '')}>
                      <td style={{ padding: '7px 10px', fontWeight: 700, color: '#e2e8f0' }}>{d.name}</td>
                      <td style={{ padding: '7px 10px', color: '#94a3b8' }}>{d.fahrten}</td>
                      <td style={{ padding: '7px 10px', color: '#94a3b8' }}>{d.shiftsBeforeCompression}</td>
                      <td style={{ padding: '7px 10px', color: '#94a3b8' }}>{d.shiftsAfterCompression}</td>
                      <td style={{ padding: '7px 10px', color: '#94a3b8' }}>{minsToHHMM(d.totalMins)}</td>
                      <td style={{ padding: '7px 10px', color: '#94a3b8' }}>{d.nightMins > 0 ? minsToHHMM(d.nightMins) : '—'}</td>
                      <td style={{ padding: '7px 10px', color: '#94a3b8' }}>{d.sundayMins > 0 ? minsToHHMM(d.sundayMins) : '—'}</td>
                      <td style={{ padding: '7px 10px' }}>
                        <Badge ok={!d.maxShiftsViolation}
                          label={d.maxShiftsViolation ? t('diag.violated', { count: d.daysWith4Plus.length }) : t('diag.ok')} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {/* ── 5. Max-3-Schichten Check ───────────────────────────────────── */}
          <Card>
            <SectionTitle>{t('diag.section5')}</SectionTitle>
            {result.stundennachweis.every(d => !d.maxShiftsViolation) ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', background: 'rgba(22,163,74,0.08)', border: '1px solid rgba(22,163,74,0.25)', borderRadius: 8 }}>
                <CheckCircle style={{ width: 18, height: 18, color: '#4ade80' }} />
                <span style={{ fontSize: 14, fontWeight: 700, color: '#4ade80' }}>{t('diag.maxShiftsAllOk')}</span>
              </div>
            ) : (
              <div>
                {result.stundennachweis.filter(d => d.maxShiftsViolation).map(d => (
                  <div key={d.name} style={{ marginBottom: 12 }}>
                    <p style={{ fontSize: 13, fontWeight: 700, color: '#f87171', marginBottom: 6 }}>
                      <XCircle style={{ width: 13, height: 13, display: 'inline', marginRight: 6 }} />
                      {t('diag.driverViolationDays', { driver: d.name, count: d.daysWith4Plus.length })}
                    </p>
                    {d.daysWith4Plus.map(day => (
                      <p key={day.date} style={{ fontSize: 12, color: '#fca5a5', margin: '2px 0 2px 20px' }}>
                        {t('diag.dayShiftCount', { date: fmtDate(day.date), count: day.shifts })}
                      </p>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </Card>

          {/* ── 6. Totals Consistency ─────────────────────────────────────── */}
          <Card>
            <SectionTitle>{t('diag.section6')}</SectionTitle>
            <Row label={t('diag.rowTripsTotal')} value={result.totalTrips} />
            <Row label={t('diag.rowTripsNotCanceled')} value={result.nonCanceled} />
            <Row label={t('diag.rowTripsInStundennachweis')} value={result.stundennachweis.reduce((s, d) => s + d.fahrten, 0)}
              ok={result.stundennachweis.reduce((s, d) => s + d.fahrten, 0) === result.nonCanceled}
              error={result.stundennachweis.reduce((s, d) => s + d.fahrten, 0) !== result.nonCanceled} />
            <Row label={t('diag.rowShiftsBeforeCompression')} value={result.stundennachweis.reduce((s, d) => s + d.shiftsBeforeCompression, 0)} />
            <Row label={t('diag.rowShiftsAfterCompression')} value={result.stundennachweis.reduce((s, d) => s + d.shiftsAfterCompression, 0)} />
            <Row label={t('diag.rowCompressionChangesTripCount')} value={t('diag.compressionNeverChangesTrips')} ok={true} />
            <div style={{ marginTop: 12, padding: '10px 12px', background: 'rgba(6,182,212,0.05)', border: '1px solid rgba(6,182,212,0.15)', borderRadius: 8 }}>
              <p style={{ fontSize: 12, color: '#64748b', margin: 0 }}>
                {t('diag.compressionNote')}
              </p>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
