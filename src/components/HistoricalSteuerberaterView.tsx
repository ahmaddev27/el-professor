import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, Save, Download, RefreshCw, Trash2, Info, Users, Filter,
  UserCheck, Calculator, CheckCircle, AlertTriangle, BarChart2, Target,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import {
  normalizeTripServiceDate,
  groupRidesIntoBlocks,
  mergeBlocksIfNeeded,
  timeToMinutes,
} from '../utils/shiftBlockEngine';
import type { FahrtenbuchTrip } from '../hooks/useFahrtenbuch';
import {
  buildCandidateBlocks,
  runGreedySolver,
  runOwnerReliefSolver,
  computeCorrections,
  createSolverController,
  type PlanningResult,
  type DriverTargetSeconds,
  type CorrectionLine,
  type SolverProgress,
  type SolverController,
} from '../utils/historicalPlannerSolver';
import {
  runReconstructionSolver,
  createReconstructionController,
  getHolidaysForYear as getHolidaysReconstruction,
  type ReconstructionResult,
  type ReconstructionController,
  type ReconstructionProgress,
  type ReconstructionDriverTarget,
  type HistoricalBufferMode,
} from '../utils/historicalReconstructionSolver';
import {
  exportStundennachweisAsPdf,
  type StundennachweisExportData,
  type PdfDayRow,
  type PdfTotals,
  type HistoricalPdfCorrectionEntry,
} from '../utils/stundennachweisPdfExport';

// ── Constants ────────────────────────────────────────────────────────────────

// Show legacy solver + optional pre-check only in dev mode with explicit flag
const SHOW_DEBUG_TOOLS =
  import.meta.env.DEV &&
  typeof localStorage !== 'undefined' &&
  localStorage.getItem('showHistoricalDebug') === '1';

const MONTHS_DE = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

interface WageType {
  code: string;
  label: string;
  shortLabel: string;
}

const WAGE_TYPES: WageType[] = [
  { code: '1000', label: 'Stundenlohn',                  shortLabel: '1000 Stundenlohn' },
  { code: '1501', label: 'Nachtzuschlag, 40% frei',      shortLabel: '1501 Nachtzuschlag' },
  { code: '1502', label: 'Nacht 0–4 Uhr',                shortLabel: '1502 Nacht 0–4 Uhr' },
  { code: '1510', label: 'Sonntagszuschlag, 50% frei',   shortLabel: '1510 Sonntagszuschlag' },
  { code: '1520', label: 'Feiertagszuschlag, 125% frei', shortLabel: '1520 Feiertagszuschlag' },
];

// ── Types ────────────────────────────────────────────────────────────────────

interface HistDriver {
  id: string;
  name: string;
  personalnummer: string;
  employment_type: 'employee' | 'company_owner';
  driver_usage_type: 'regular' | 'coverage_only' | null;
  status: string | null;
}

interface TargetValues {
  [wageCode: string]: string; // display string with German comma
}

/** Actual computed minutes per wage-type code for one driver */
interface ActualValues {
  [wageCode: string]: number; // minutes
}

interface AbgleichRow {
  driverId: string;
  driverName: string;
  personalnummer: string;
  wageCode: string;
  wageLabel: string;
  targetSec: number;    // target in whole seconds (from decimal hours × 3600)
  actualSec: number;    // actual in whole seconds (from minutes × 60)
  diffSec: number;      // actualSec - targetSec
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseDecimal(s: string): number | null {
  const normalized = s.replace(',', '.').trim();
  if (normalized === '' || normalized === '-') return null;
  const n = parseFloat(normalized);
  if (isNaN(n) || n < 0) return null;
  return n;
}

function fmtDecimal(n: number): string {
  return n.toFixed(2).replace('.', ',');
}

/** Convert integer seconds to decimal hours, formatted with German comma */
function secToDecimalStr(sec: number): string {
  return fmtDecimal(sec / 3600);
}

/** Convert signed integer seconds to signed decimal hours string for diff display */
function diffSecToStr(sec: number): string {
  if (sec === 0) return '0,00';
  const sign = sec > 0 ? '+' : '-';
  return sign + fmtDecimal(Math.abs(sec) / 3600);
}

function emptyValues(): TargetValues {
  const v: TargetValues = {};
  for (const wt of WAGE_TYPES) v[wt.code] = '';
  return v;
}

function normName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

// ── Holiday helpers (same logic as GenerateStundennachweisModal) ─────────────

function easterSunday(y: number): Date {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100;
  const d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m2 = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m2 + 114) / 31);
  const day = ((h + l - 7 * m2 + 114) % 31) + 1;
  return new Date(y, month - 1, day);
}

function getHolidaysForYear(y: number): Set<string> {
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const add = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const easter = easterSunday(y);
  return new Set([
    fmt(new Date(y, 0, 1)),
    fmt(add(easter, -2)),
    fmt(add(easter, 1)),
    fmt(new Date(y, 4, 1)),
    fmt(add(easter, 39)),
    fmt(add(easter, 50)),
    fmt(new Date(y, 9, 3)),
    fmt(new Date(y, 11, 25)),
    fmt(new Date(y, 11, 26)),
  ]);
}

// ── Shift-time bucketing (same logic as GenerateStundennachweisModal) ─────────

function nightMinsForSeg(from: string, to: string): number {
  if (!from || !to) return 0;
  const f = timeToMinutes(from), t = timeToMinutes(to);
  const absTo = t >= f ? t : t + 1440;
  const seg1 = Math.max(0, Math.min(absTo, 24 * 60) - Math.max(f, 20 * 60));
  const seg2 = Math.max(0, Math.min(absTo, 30 * 60) - Math.max(f, 24 * 60));
  return seg1 + seg2;
}

function night0to4MinsForSeg(from: string, to: string): number {
  if (!from || !to) return 0;
  const f = timeToMinutes(from), t = timeToMinutes(to);
  const absTo = t >= f ? t : t + 1440;
  // 00:00–04:00 window (0–240 min), plus cross-midnight wrap (1440–1680)
  const seg1 = Math.max(0, Math.min(absTo, 240) - Math.max(f, 0));
  const seg2 = Math.max(0, Math.min(absTo, 1680) - Math.max(f, 1440));
  return seg1 + seg2;
}

function segDuration(from: string, to: string): number {
  if (!from || !to) return 0;
  const f = timeToMinutes(from), t = timeToMinutes(to);
  return t >= f ? t - f : 1440 - f + t;
}

function minutesToTime(m: number): string {
  const clamped = ((m % 1440) + 1440) % 1440;
  const h = Math.floor(clamped / 60);
  const min = clamped % 60;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/**
 * Compute actual payroll buckets (in minutes) for a set of trips
 * using the same logic as GenerateStundennachweisModal:
 * - 1000 Grundlohn = total shift minutes
 * - 1501 Nacht = 20:00–06:00 overlap
 * - 1502 Nacht 0–4 = 00:00–04:00 overlap
 * - 1510 Sonntag = total minutes on Sundays (not holidays)
 * - 1520 Feiertag = total minutes on holidays
 */
function computeActualValues(
  trips: FahrtenbuchTrip[],
  driverId: string,
  year: number,
  month: number,
  holidays: Set<string>,
): ActualValues {
  const totals: ActualValues = { '1000': 0, '1501': 0, '1502': 0, '1510': 0, '1520': 0 };
  if (trips.length === 0) return totals;

  // Normalize + group by service date
  const segsByDate = new Map<string, ReturnType<typeof normalizeTripServiceDate>>();
  for (const trip of trips) {
    const segs = normalizeTripServiceDate(trip);
    for (const seg of segs) {
      if (!segsByDate.has(seg.serviceDate)) segsByDate.set(seg.serviceDate, []);
      segsByDate.get(seg.serviceDate)!.push(seg);
    }
  }
  for (const [, segs] of segsByDate) {
    segs.sort((a, b) => a.startMinutes - b.startMinutes);
  }

  // Build Schichten per service date, then accumulate buckets
  for (const [dateStr, daySegs] of segsByDate) {
    const dateObj = new Date(dateStr + 'T12:00:00');
    const dow = dateObj.getDay();
    const isSun = dow === 0;
    const isHol = holidays.has(dateStr);

    // Build blocks → schichten (same pipeline)
    const blocks = groupRidesIntoBlocks(daySegs, driverId, dateStr);
    const { merged } = mergeBlocksIfNeeded(blocks);
    const schichten = merged.slice(0, 3).map(b => ({
      von: minutesToTime(b.startMin),
      bis: minutesToTime(b.endMin),
    }));

    for (const s of schichten) {
      const dur = segDuration(s.von, s.bis);
      if (dur === 0) continue;

      totals['1000'] += dur;
      totals['1501'] += nightMinsForSeg(s.von, s.bis);
      totals['1502'] += night0to4MinsForSeg(s.von, s.bis);
      if (isSun && !isHol) totals['1510'] += dur;
      if (isHol) totals['1520'] += dur;
    }
  }

  return totals;
}

// ── Sub-components ───────────────────────────────────────────────────────────

function ChipBtn({
  onClick,
  children,
  icon,
  disabled,
}: {
  onClick: () => void;
  children: React.ReactNode;
  icon?: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all hover:opacity-80 disabled:opacity-40"
      style={{
        background: 'var(--bg-muted, var(--bg-subtle, rgba(0,0,0,0.06)))',
        color: 'var(--text-secondary)',
        border: '1px solid var(--border)',
      }}
    >
      {icon}
      {children}
    </button>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'primary' | 'warning' }) {
  const color = tone === 'primary' ? 'var(--accent, #2563eb)'
    : tone === 'warning' ? '#b45309'
    : 'var(--text-primary)';
  return (
    <div className="text-center">
      <div className="text-lg font-bold" style={{ color }}>{value}</div>
      <div className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>{label}</div>
    </div>
  );
}

// ── Component ────────────────────────────────────────────────────────────────

interface Props {
  onBack: () => void;
}

function HistoricalSteuerberaterView({ onBack }: Props) {
  const { companyId, user } = useAuth();
  const now = new Date();

  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());

  // All company drivers
  const [allDrivers, setAllDrivers] = useState<HistDriver[]>([]);
  const [driversLoading, setDriversLoading] = useState(false);

  // Driver IDs detected in Fahrtenbuch for this month/year
  const [fahrtenbuchDriverIds, setFahrtenbuchDriverIds] = useState<Set<string>>(new Set());
  const [fahrtenbuchDriverNames, setFahrtenbuchDriverNames] = useState<string[]>([]);
  const [fahrtenbuchLoading, setFahrtenbuchLoading] = useState(false);

  // Selected driver IDs for target table
  const [selectedDriverIds, setSelectedDriverIds] = useState<Set<string>>(new Set());
  const [selectionInitialized, setSelectionInitialized] = useState(false);
  // Tracks whether the user has manually changed selection in the current session
  const [driverSelectionTouched, setDriverSelectionTouched] = useState(false);
  // Manually added supplementary drivers not present in the Fahrtenbuch
  const [zusatzfahrerIds, setZusatzfahrerIds] = useState<Set<string>>(new Set());

  // Target values per driver
  const [targetValues, setTargetValues] = useState<Map<string, TargetValues>>(new Map());

  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [targetsLoading, setTargetsLoading] = useState(false);

  // ── Step 2 state ────────────────────────────────────────────────────────────
  const [actualValues, setActualValues] = useState<Map<string, ActualValues> | null>(null);
  const [abgleichRows, setAbgleichRows] = useState<AbgleichRow[] | null>(null);
  const [calculating, setCalculating] = useState(false);
  const [calcError, setCalcError] = useState<string | null>(null);

  // ── Step 3 state ────────────────────────────────────────────────────────────
  const [planningResult, setPlanningResult] = useState<PlanningResult | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planningError, setPlanningError] = useState<string | null>(null);
  const [solverProgress, setSolverProgress] = useState<SolverProgress | null>(null);
  const solverCtrlRef = useRef<SolverController | null>(null);

  // ── Reconstruction strategy state ──────────────────────────────────────────
  const [strategyMode, setStrategyMode] = useState<'reconstruction' | 'legacy'>('reconstruction');
  const [bufferMode, setBufferMode] = useState<HistoricalBufferMode>('none');
  const [reconstructionResult, setReconstructionResult] = useState<ReconstructionResult | null>(null);
  const [reconProgress, setReconProgress] = useState<ReconstructionProgress | null>(null);
  const reconCtrlRef = useRef<ReconstructionController | null>(null);
  const [finalizationGenerated, setFinalizationGenerated] = useState(false);
  const [showAdvancedSolver, setShowAdvancedSolver] = useState(false);

  // Snapshot of inputs when final documents were last generated — used for stale indicator
  type FinalizationSnapshot = {
    month: number; year: number;
    strategy: string; bufferMode: string;
    driverIds: string; targetHash: string;
    generatedAt: number;
  };
  const [finalizationSnapshot, setFinalizationSnapshot] = useState<FinalizationSnapshot | null>(null);

  // ── Correction state ────────────────────────────────────────────────────────
  const [allowCorrections, setAllowCorrections] = useState(false);
  const [ownerExcluded, setOwnerExcluded] = useState(true);
  const [correctionLines, setCorrectionLines] = useState<CorrectionLine[] | null>(null);

  const yearOptions = useMemo(() => {
    const y = now.getFullYear();
    return Array.from({ length: 8 }, (_, i) => y - 6 + i);
  }, []);

  // Compute a simple target hash for stale detection — just a string of all input values
  const targetHash = useMemo(() => {
    const parts: string[] = [];
    for (const [id, vals] of targetValues) {
      parts.push(`${id}:${vals['1000'] ?? ''}:${vals['1501'] ?? ''}:${vals['1502'] ?? ''}:${vals['1510'] ?? ''}:${vals['1520'] ?? ''}`);
    }
    return parts.sort().join('|');
  }, [targetValues]);

  // ── Load all company drivers ────────────────────────────────────────────────
  useEffect(() => {
    if (!companyId) return;
    let cancelled = false;
    setDriversLoading(true);
    setSelectionInitialized(false);
    setDriverSelectionTouched(false);
    supabase
      .from('drivers')
      .select('id, name, personalnummer, employment_type, driver_usage_type, status')
      .eq('company_id', companyId)
      .order('name')
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) { console.error('[HistoricalSteuerberater] drivers error', error); }
        const rows = (data ?? []) as HistDriver[];
        setAllDrivers(rows.filter(d => d.status !== 'inactive'));
        setDriversLoading(false);
        setZusatzfahrerIds(new Set());
      });
    return () => { cancelled = true; };
  }, [companyId]);

  // ── Load Fahrtenbuch driver IDs for selected month/year ────────────────────
  const loadFahrtenbuchDrivers = useCallback(async () => {
    if (!companyId) return;
    setFahrtenbuchLoading(true);
    try {
      const { data: importData } = await supabase
        .from('fahrtenbuch_imports')
        .select('id')
        .eq('company_id', companyId)
        .eq('month', month)
        .eq('year', year);
      const importIds = (importData ?? []).map((i: { id: string }) => i.id);
      if (importIds.length === 0) {
        setFahrtenbuchDriverIds(new Set());
        setFahrtenbuchDriverNames([]);
        setFahrtenbuchLoading(false);
        return;
      }
      const { data: tripData } = await supabase
        .from('fahrtenbuch_trips')
        .select('original_driver_id, original_driver_name')
        .eq('company_id', companyId)
        .in('import_id', importIds)
        .eq('is_canceled', false);

      const ids = new Set<string>();
      const names: string[] = [];
      for (const t of tripData ?? []) {
        if (t.original_driver_id) ids.add(t.original_driver_id);
        if (t.original_driver_name && !names.includes(t.original_driver_name)) {
          names.push(t.original_driver_name);
        }
      }
      setFahrtenbuchDriverIds(ids);
      setFahrtenbuchDriverNames(names);
    } catch (e) {
      console.error('[HistoricalSteuerberater] fahrtenbuch load error', e);
    } finally {
      setFahrtenbuchLoading(false);
    }
  }, [companyId, month, year]);

  useEffect(() => {
    void loadFahrtenbuchDrivers();
  }, [loadFahrtenbuchDrivers]);

  // ── Compute matched driver IDs ──────────────────────────────────────────────
  const matchedDriverIds = useMemo(() => {
    const nameSet = new Set(fahrtenbuchDriverNames.map(normName).filter(Boolean));
    const matched = new Set<string>();
    for (const d of allDrivers) {
      if (fahrtenbuchDriverIds.has(d.id)) { matched.add(d.id); continue; }
      if (nameSet.has(normName(d.name))) matched.add(d.id);
    }
    return matched;
  }, [allDrivers, fahrtenbuchDriverIds, fahrtenbuchDriverNames]);

  // ── Default selection ────────────────────────────────────────────────────────
  // Compute the smart default: regular payroll employees who appear in the Fahrtenbuch
  const defaultDriverSelection = useMemo(() => {
    const regularEmployees = allDrivers.filter(
      d => d.employment_type !== 'company_owner' && d.driver_usage_type === 'regular',
    );
    if (matchedDriverIds.size > 0) {
      // Intersection: regular employees who have trips in the selected month
      const intersection = new Set(
        regularEmployees.filter(d => matchedDriverIds.has(d.id)).map(d => d.id),
      );
      // If intersection is empty (Fahrtenbuch loaded but no regular match), fall back to all regular
      return intersection.size > 0 ? intersection : new Set(regularEmployees.map(d => d.id));
    }
    // Fahrtenbuch not yet loaded or empty: default to all regular employees
    return new Set(regularEmployees.map(d => d.id));
  }, [allDrivers, matchedDriverIds]);

  useEffect(() => {
    if (selectionInitialized || allDrivers.length === 0 || driverSelectionTouched) return;
    setSelectedDriverIds(defaultDriverSelection);
    setSelectionInitialized(true);
  }, [selectionInitialized, allDrivers, matchedDriverIds, defaultDriverSelection, driverSelectionTouched]);

  // Combined set: Fahrtenbuch selection + manually added Zusatzfahrer
  const allSelectedDriverIds = useMemo(() => {
    const combined = new Set(selectedDriverIds);
    for (const id of zusatzfahrerIds) combined.add(id);
    return combined;
  }, [selectedDriverIds, zusatzfahrerIds]);

  // Candidates for Historische Zusatzfahrer: regular employees NOT in Fahrtenbuch
  const zusatzfahrerCandidates = useMemo(() => {
    return allDrivers.filter(
      d =>
        d.employment_type !== 'company_owner' &&
        d.driver_usage_type === 'regular' &&
        !matchedDriverIds.has(d.id),
    );
  }, [allDrivers, matchedDriverIds]);

  const driverIdsKey = useMemo(
    () => [...allSelectedDriverIds].sort().join(','),
    [allSelectedDriverIds],
  );

  const isFinalizationStale = useMemo<boolean>(() => {
    if (!finalizationGenerated || !finalizationSnapshot) return false;
    return (
      finalizationSnapshot.month !== month ||
      finalizationSnapshot.year !== year ||
      finalizationSnapshot.strategy !== strategyMode ||
      finalizationSnapshot.bufferMode !== bufferMode ||
      finalizationSnapshot.driverIds !== driverIdsKey ||
      finalizationSnapshot.targetHash !== targetHash
    );
  }, [finalizationGenerated, finalizationSnapshot, month, year, strategyMode, bufferMode, driverIdsKey, targetHash]);

  useEffect(() => {
    setSelectionInitialized(false);
    setDriverSelectionTouched(false);
    setZusatzfahrerIds(new Set());
    // Reset Step 2 + Step 3 results when month/year changes
    setActualValues(null);
    setAbgleichRows(null);
    setCalcError(null);
    setPlanningResult(null);
    setPlanningError(null);
    setCorrectionLines(null);
  }, [month, year]);

  // ── Load saved target values ─────────────────────────────────────────────────
  const loadTargets = useCallback(async () => {
    if (!companyId) return;
    setTargetsLoading(true);
    setSaveMsg(null);
    setValidationError(null);
    try {
      const { data, error } = await supabase
        .from('historical_payroll_targets')
        .select('driver_id, wage_type_code, target_hours_decimal')
        .eq('company_id', companyId)
        .eq('month', month)
        .eq('year', year);
      if (error) throw error;

      const newMap = new Map<string, TargetValues>();
      for (const t of data ?? []) {
        const existing = newMap.get(t.driver_id) ?? emptyValues();
        const n = Number(t.target_hours_decimal);
        existing[t.wage_type_code] = n > 0 ? fmtDecimal(n) : '';
        newMap.set(t.driver_id, existing);
      }
      setTargetValues(newMap);
    } catch (e) {
      console.error('[HistoricalSteuerberater] loadTargets error', e);
    } finally {
      setTargetsLoading(false);
    }
  }, [companyId, month, year]);

  useEffect(() => {
    void loadTargets();
  }, [loadTargets]);

  // ── Cell editing ─────────────────────────────────────────────────────────────
  const handleCellChange = (driverId: string, code: string, val: string) => {
    setValidationError(null);
    setTargetValues(prev => {
      const next = new Map(prev);
      const existing = next.get(driverId) ?? emptyValues();
      next.set(driverId, { ...existing, [code]: val });
      return next;
    });
  };

  const getVal = (driverId: string, code: string): string =>
    targetValues.get(driverId)?.[code] ?? '';

  // ── Validation ───────────────────────────────────────────────────────────────
  const validateAll = (): boolean => {
    for (const dId of allSelectedDriverIds) {
      const driver = allDrivers.find(d => d.id === dId);
      for (const wt of WAGE_TYPES) {
        const raw = getVal(dId, wt.code);
        if (raw.trim() === '') continue;
        const n = parseDecimal(raw);
        if (n === null) {
          setValidationError(
            `Bitte gültige Stundenwerte eingeben. Ungültiger Wert bei "${driver?.name ?? dId}" / ${wt.shortLabel}.`,
          );
          return false;
        }
      }
    }
    return true;
  };

  // ── Save ─────────────────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!companyId || !validateAll()) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      const upsertRows = [];
      for (const dId of allSelectedDriverIds) {
        for (const wt of WAGE_TYPES) {
          const raw = getVal(dId, wt.code);
          const n = raw.trim() === '' ? 0 : (parseDecimal(raw) ?? 0);
          upsertRows.push({
            company_id: companyId,
            month,
            year,
            driver_id: dId,
            wage_type_code: wt.code,
            wage_type_label: wt.label,
            target_hours_decimal: n,
            created_by: user?.id ?? null,
            updated_at: new Date().toISOString(),
          });
        }
      }
      const { error } = await supabase
        .from('historical_payroll_targets')
        .upsert(upsertRows, { onConflict: 'company_id,month,year,driver_id,wage_type_code' });
      if (error) throw error;

      setTargetValues(prev => {
        const next = new Map(prev);
        for (const dId of allSelectedDriverIds) {
          const existing = next.get(dId) ?? emptyValues();
          const normalized: TargetValues = {};
          for (const wt of WAGE_TYPES) {
            const raw = existing[wt.code] ?? '';
            const n = raw.trim() === '' ? null : parseDecimal(raw);
            normalized[wt.code] = n !== null && n > 0 ? fmtDecimal(n) : '';
          }
          next.set(dId, normalized);
        }
        return next;
      });
      setSaveMsg({ type: 'success', text: 'Zielwerte wurden gespeichert.' });
    } catch (e) {
      console.error('[HistoricalSteuerberater] save error', e);
      setSaveMsg({ type: 'error', text: 'Zielwerte konnten nicht gespeichert werden.' });
    } finally {
      setSaving(false);
    }
  };

  // ── Bulk actions ─────────────────────────────────────────────────────────────
  const employees = useMemo(
    () => allDrivers.filter(d => d.employment_type !== 'company_owner'),
    [allDrivers],
  );

  const selectAll = () => { setSelectedDriverIds(new Set(employees.map(d => d.id))); setDriverSelectionTouched(true); };
  const selectNone = () => { setSelectedDriverIds(new Set()); setDriverSelectionTouched(true); };
  const selectFahrtenbuchOnly = () => {
    setSelectedDriverIds(new Set([...matchedDriverIds].filter(id => employees.some(d => d.id === id))));
    setDriverSelectionTouched(true);
  };
  const selectRegularOnly = () => {
    setSelectedDriverIds(new Set(employees.filter(d => d.driver_usage_type === 'regular').map(d => d.id)));
    setDriverSelectionTouched(true);
  };
  const selectDefault = () => {
    setSelectedDriverIds(defaultDriverSelection);
    setDriverSelectionTouched(false);
  };

  const handleClearAll = () => {
    setValidationError(null);
    setTargetValues(new Map());
  };

  // ── XLSX Zielwerte export ─────────────────────────────────────────────────────
  const handleExportXlsx = () => {
    const monthStr = String(month).padStart(2, '0');
    const xlsxRows: (string | number)[][] = [
      ['Fahrer', 'Personalnummer', 'Lohnart', 'Bezeichnung', 'Zielwert (Std.)'],
    ];
    for (const dId of allSelectedDriverIds) {
      const driver = allDrivers.find(d => d.id === dId);
      if (!driver) continue;
      for (const wt of WAGE_TYPES) {
        const raw = getVal(dId, wt.code);
        const n = raw.trim() === '' ? 0 : (parseDecimal(raw) ?? 0);
        xlsxRows.push([driver.name, driver.personalnummer, wt.code, wt.label, n]);
      }
    }
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(xlsxRows);
    XLSX.utils.book_append_sheet(wb, ws, 'Zielwerte');
    XLSX.writeFile(wb, `Steuerberater_Zielwerte_${year}-${monthStr}.xlsx`);
  };

  // ── Summary totals (Step 1) ───────────────────────────────────────────────────
  const summary = useMemo(() => {
    const totals: Record<string, number> = {};
    let driversWithValues = 0;
    for (const wt of WAGE_TYPES) totals[wt.code] = 0;
    for (const dId of allSelectedDriverIds) {
      let hasAny = false;
      for (const wt of WAGE_TYPES) {
        const raw = getVal(dId, wt.code);
        const n = raw.trim() === '' ? 0 : (parseDecimal(raw) ?? 0);
        totals[wt.code] += n;
        if (n > 0) hasAny = true;
      }
      if (hasAny) driversWithValues++;
    }
    return { totals, driversWithValues };
  }, [allSelectedDriverIds, targetValues]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Step 2: Calculate Istwerte ────────────────────────────────────────────────
  const handleCalculateIstwerte = useCallback(async () => {
    if (!companyId) return;
    setCalculating(true);
    setCalcError(null);
    setActualValues(null);
    setAbgleichRows(null);

    try {
      // Load all imports for this month/year
      const { data: importData, error: importErr } = await supabase
        .from('fahrtenbuch_imports')
        .select('id')
        .eq('company_id', companyId)
        .eq('month', month)
        .eq('year', year);
      if (importErr) throw importErr;

      const importIds = (importData ?? []).map((i: { id: string }) => i.id);

      let allTrips: FahrtenbuchTrip[] = [];
      if (importIds.length > 0) {
        let offset = 0;
        const BATCH = 1000;
        while (true) {
          const { data: batchData, error: batchErr } = await supabase
            .from('fahrtenbuch_trips')
            .select('*')
            .eq('company_id', companyId)
            .in('import_id', importIds)
            .eq('is_canceled', false)
            .order('trip_date')
            .order('start_time', { nullsFirst: false })
            .range(offset, offset + BATCH - 1);
          if (batchErr) throw batchErr;
          const rows = (batchData ?? []) as FahrtenbuchTrip[];
          allTrips.push(...rows);
          if (rows.length < BATCH) break;
          offset += BATCH;
        }
      }

      if (allTrips.length === 0) {
        setCalcError('Keine Istwerte gefunden. Bitte prüfen Sie den Fahrtenbuch-Import oder die Fahrerzuordnung.');
        setCalculating(false);
        return;
      }

      const holidays = getHolidaysForYear(year);

      // Group trips by effective driver ID (assigned takes priority over original)
      const tripsByDriver = new Map<string, FahrtenbuchTrip[]>();
      for (const trip of allTrips) {
        const dId = trip.assigned_driver_id || trip.original_driver_id;
        if (!dId) continue;
        if (!tripsByDriver.has(dId)) tripsByDriver.set(dId, []);
        tripsByDriver.get(dId)!.push(trip);
      }

      // Compute actual values for selected drivers only
      const newActualValues = new Map<string, ActualValues>();
      for (const dId of allSelectedDriverIds) {
        const trips = tripsByDriver.get(dId) ?? [];
        newActualValues.set(dId, computeActualValues(trips, dId, year, month, holidays));
      }
      setActualValues(newActualValues);

      // Build abgleich rows
      const rows: AbgleichRow[] = [];
      for (const dId of allSelectedDriverIds) {
        const driver = allDrivers.find(d => d.id === dId);
        if (!driver) continue;
        const actual = newActualValues.get(dId) ?? { '1000': 0, '1501': 0, '1502': 0, '1510': 0, '1520': 0 };
        for (const wt of WAGE_TYPES) {
          const rawTarget = getVal(dId, wt.code);
          const targetHours = rawTarget.trim() === '' ? 0 : (parseDecimal(rawTarget) ?? 0);
          const targetSec = Math.round(targetHours * 3600);
          const actualSec = (actual[wt.code] ?? 0) * 60;
          rows.push({
            driverId: dId,
            driverName: driver.name,
            personalnummer: driver.personalnummer,
            wageCode: wt.code,
            wageLabel: wt.label,
            targetSec,
            actualSec,
            diffSec: actualSec - targetSec,
          });
        }
      }
      setAbgleichRows(rows);
    } catch (e) {
      console.error('[HistoricalSteuerberater] calculateIstwerte error', e);
      setCalcError('Fehler bei der Berechnung der Istwerte.');
    } finally {
      setCalculating(false);
    }
  }, [companyId, month, year, allSelectedDriverIds, allDrivers, targetValues]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Abgleich XLSX export ──────────────────────────────────────────────────────
  const handleExportAbgleich = () => {
    if (!abgleichRows) return;
    const monthStr = String(month).padStart(2, '0');

    // Sheet 1: Zielwerte
    const zielRows: (string | number)[][] = [
      ['Fahrer', 'Pers.-Nr.', 'Lohnart', 'Bezeichnung', 'Zielwert (Std.)'],
    ];
    for (const r of abgleichRows) {
      zielRows.push([r.driverName, r.personalnummer, r.wageCode, r.wageLabel, r.targetSec / 3600]);
    }

    // Sheet 2: Istwerte
    const istRows: (string | number)[][] = [
      ['Fahrer', 'Pers.-Nr.', 'Lohnart', 'Bezeichnung', 'Istwert (Std.)'],
    ];
    for (const r of abgleichRows) {
      istRows.push([r.driverName, r.personalnummer, r.wageCode, r.wageLabel, r.actualSec / 3600]);
    }

    // Sheet 3: Abgleich
    const abRows: (string | number)[][] = [
      ['Fahrer', 'Pers.-Nr.', 'Lohnart', 'Bezeichnung', 'Ziel', 'Ist', 'Differenz', 'Status'],
    ];
    for (const r of abgleichRows) {
      abRows.push([
        r.driverName,
        r.personalnummer,
        r.wageCode,
        r.wageLabel,
        r.targetSec / 3600,
        r.actualSec / 3600,
        r.diffSec / 3600,
        r.diffSec === 0 ? 'OK' : 'Abweichung',
      ]);
    }

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(zielRows), 'Zielwerte');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(istRows), 'Istwerte');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(abRows), 'Abgleich');
    XLSX.writeFile(wb, `Steuerberater_Abgleich_${year}-${monthStr}.xlsx`);
  };

  // ── Step 3: Calculate Zielwert-Planung ────────────────────────────────────────
  const handleCalculatePlanung = useCallback(async () => {
    if (!companyId) return;
    setPlanning(true);
    setPlanningError(null);
    setPlanningResult(null);
    setReconstructionResult(null);
    setCorrectionLines(null);
    setSolverProgress(null);
    setReconProgress(null);
    setFinalizationGenerated(false);
    setFinalizationSnapshot(null);

    try {
      // Find owner driver
      const ownerDriver = allDrivers.find(d => d.employment_type === 'company_owner') ?? null;

      // Build targets for selected payroll drivers
      const targets: DriverTargetSeconds[] = [];
      const reconTargets: ReconstructionDriverTarget[] = [];
      for (const dId of allSelectedDriverIds) {
        const driver = allDrivers.find(d => d.id === dId);
        if (!driver || driver.employment_type === 'company_owner') continue;
        const workSec  = Math.round((parseDecimal(getVal(dId, '1000')) ?? 0) * 3600);
        const nightSec = Math.round((parseDecimal(getVal(dId, '1501')) ?? 0) * 3600);
        const night0to4Sec = Math.round((parseDecimal(getVal(dId, '1502')) ?? 0) * 3600);
        const sunSec   = Math.round((parseDecimal(getVal(dId, '1510')) ?? 0) * 3600);
        const holSec   = Math.round((parseDecimal(getVal(dId, '1520')) ?? 0) * 3600);
        targets.push({ driverId: dId, driverName: driver.name, personalnummer: driver.personalnummer, workSec, nightSec, sunSec, holSec });
        reconTargets.push({ driverId: dId, driverName: driver.name, personalnummer: driver.personalnummer, workSec, nightSec, night0to4Sec, sunSec, holSec, isZusatzfahrer: zusatzfahrerIds.has(dId) });
      }

      if (targets.length === 0) {
        setPlanningError('Keine Steuerberater-Fahrer mit Zielwerten ausgewählt. Bitte Fahrer auswählen und Zielwerte eingeben.');
        setPlanning(false);
        return;
      }

      // Load all trips for this month/year
      const { data: importData, error: importErr } = await supabase
        .from('fahrtenbuch_imports')
        .select('id')
        .eq('company_id', companyId)
        .eq('month', month)
        .eq('year', year);
      if (importErr) throw importErr;

      const importIds = (importData ?? []).map((i: { id: string }) => i.id);

      let allTrips: FahrtenbuchTrip[] = [];
      if (importIds.length > 0) {
        let offset = 0;
        const BATCH = 1000;
        while (true) {
          const { data: batchData, error: batchErr } = await supabase
            .from('fahrtenbuch_trips')
            .select('*')
            .eq('company_id', companyId)
            .in('import_id', importIds)
            .order('trip_date')
            .order('start_time', { nullsFirst: false })
            .range(offset, offset + BATCH - 1);
          if (batchErr) throw batchErr;
          const rows = (batchData ?? []) as FahrtenbuchTrip[];
          allTrips.push(...rows);
          if (rows.length < BATCH) break;
          offset += BATCH;
        }
      }

      if (allTrips.length === 0) {
        setPlanningError('Keine Fahrtenbuch-Daten für den gewählten Monat gefunden.');
        setPlanning(false);
        return;
      }

      if (strategyMode === 'reconstruction') {
        // ── Max-Inhaber-Einzelfahrt-Rekonstruktion ──
        const holidays = getHolidaysReconstruction(year);
        const ctrl = createReconstructionController((p) => setReconProgress({ ...p }));
        reconCtrlRef.current = ctrl;
        const result = await runReconstructionSolver(
          allTrips,
          reconTargets,
          ownerDriver?.id ?? null,
          ownerDriver?.name ?? 'Inhaber',
          holidays,
          allowCorrections && ownerExcluded,
          bufferMode,
          ctrl,
        );
        reconCtrlRef.current = null;
        setReconstructionResult(result);
      } else {
        // ── Legacy solver ──
        const holidays = getHolidaysForYear(year);
        const candidateBlocks = buildCandidateBlocks(
          allTrips,
          holidays,
          ownerDriver?.id ?? null,
          allowCorrections && ownerExcluded,
        );

        let result: PlanningResult;
        if (allowCorrections) {
          const ctrl = createSolverController((p) => setSolverProgress({ ...p }));
          solverCtrlRef.current = ctrl;
          result = await runOwnerReliefSolver(
            candidateBlocks,
            targets,
            ownerDriver?.id ?? null,
            ownerDriver?.name ?? 'Inhaber',
            allTrips,
            ctrl,
          );
          solverCtrlRef.current = null;
        } else {
          result = runGreedySolver(
            candidateBlocks,
            targets,
            ownerDriver?.id ?? null,
            ownerDriver?.name ?? 'Inhaber',
          );
        }

        setPlanningResult(result);
        if (allowCorrections) {
          setCorrectionLines(computeCorrections(result.deviations));
        }
      }
    } catch (e) {
      console.error('[HistoricalSteuerberater] calculatePlanung error', e);
      setPlanningError('Fehler bei der Zielwert-Planung.');
    } finally {
      setPlanning(false);
      solverCtrlRef.current = null;
      reconCtrlRef.current = null;
    }
  }, [companyId, month, year, allSelectedDriverIds, allDrivers, targetValues, allowCorrections, ownerExcluded, strategyMode, bufferMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCancelPlanung = useCallback(() => {
    solverCtrlRef.current?.cancel();
    reconCtrlRef.current?.cancel();
  }, []);

  // ── Step 3: Reconstruction XLSX export ────────────────────────────────────────
  const handleExportReconstructionPlanung = () => {
    if (!reconstructionResult) return;
    const rr = reconstructionResult;
    const monthStr = String(month).padStart(2, '0');
    const secToH = (s: number) => +(s / 3600).toFixed(6);
    const fmtMin = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

    // Rebuild targets for export
    const exportTargets: ReconstructionDriverTarget[] = [];
    for (const dId of allSelectedDriverIds) {
      const driver = allDrivers.find(d => d.id === dId);
      if (!driver || driver.employment_type === 'company_owner') continue;
      exportTargets.push({
        driverId: dId, driverName: driver.name, personalnummer: driver.personalnummer,
        workSec:  Math.round((parseDecimal(getVal(dId, '1000')) ?? 0) * 3600),
        nightSec: Math.round((parseDecimal(getVal(dId, '1501')) ?? 0) * 3600),
        night0to4Sec: Math.round((parseDecimal(getVal(dId, '1502')) ?? 0) * 3600),
        sunSec:   Math.round((parseDecimal(getVal(dId, '1510')) ?? 0) * 3600),
        holSec:   Math.round((parseDecimal(getVal(dId, '1520')) ?? 0) * 3600),
        isZusatzfahrer: zusatzfahrerIds.has(dId),
      });
    }

    // Sheet 1: Ergebnis
    const ergebnisRows: (string | number)[][] = [
      ['Historische Zielwert-Planung', `${MONTHS_DE[month - 1]} ${year}`],
      ['Strategie', 'Max-Inhaber-Einzelfahrt-Rekonstruktion'],
      ['Historischer Fahrzeugwechsel-Puffer', bufferMode === 'strict' ? 'Streng anwenden' : bufferMode === 'warning' ? 'Nur Warnung' : '0 Minuten'],
      ['Status', rr.isFinalizable ? 'Finalisierbar mit Korrekturzeilen' : 'Nicht finalisierbar'],
      ['Fahrten gesamt', rr.totalFahrten],
      ['An Inhaber zugewiesen', rr.ownerFahrten],
      ['An Steuerberater-Fahrer', rr.payrollFahrten],
      ['Nicht zugewiesen', rr.unassignedCount],
      ['Inhaber-Originalkonflikte', rr.ownerOriginalCount],
      ['Fahrzeugwechsel-Puffer-Warnungen', rr.bufferWarnings],
      ['Fahrer über Zielwert', rr.driversOverTarget.length > 0 ? rr.driversOverTarget.join(', ') : 'Keine'],
      ['Negative Korrekturen erforderlich', rr.negativeCorrectionsRequired],
      ['Positive Korrekturzeilen', rr.corrections.length],
      ['Berechnungszeit (ms)', Math.round(rr.solverElapsedMs)],
      ['Kandidaten geprüft', rr.candidatesTried],
      ['Berechnungslimit erreicht', rr.solverLimitReached ? 'Ja' : 'Nein'],
      ['Berechnung abgebrochen', rr.solverCancelled ? 'Ja' : 'Nein'],
      ['Inhaber-Ausschluss aktiv', allowCorrections && ownerExcluded ? 'Ja' : 'Nein'],
      ['', ''],
      ['Finalisierungsblockade', rr.finalizationBlockers.length > 0 ? rr.finalizationBlockers.join(' | ') : 'Keine'],
    ];

    // Sheet 2: Zielwerte
    const zielRows: (string | number)[][] = [['Fahrer', 'Pers.-Nr.', 'Lohnart', 'Bezeichnung', 'Ziel (Std.)']];
    for (const t of exportTargets) {
      for (const [code, sec, label] of [
        ['1000', t.workSec, 'Stundenlohn'], ['1501', t.nightSec, 'Nachtzuschlag, 40% frei'],
        ['1502', t.night0to4Sec, 'Nacht 0–4 Uhr'],
        ['1510', t.sunSec, 'Sonntagszuschlag, 50% frei'], ['1520', t.holSec, 'Feiertagszuschlag, 125% frei'],
      ] as [string, number, string][]) {
        zielRows.push([t.driverName, t.personalnummer, code, label, secToH(sec)]);
      }
    }

    // Sheet 3: Fahrt-Rekonstruktion
    const rekRows: (string | number)[][] = [['Fahrt-ID', 'Datum', 'Start', 'Ende', 'Kennzeichen', 'Original Fahrer', 'Rekonstruktions-Fahrer', 'Rolle', '1000 (Std.)', '1501 (Std.)', '1510 (Std.)', '1520 (Std.)', 'Entlastungsgrund', 'Puffer-Warnung']];
    for (const a of rr.assignments) {
      rekRows.push([
        a.unit.fahrtId, a.unit.date, fmtMin(a.unit.startMin), fmtMin(a.unit.endMin),
        a.unit.vehicleKennzeichen ?? '—',
        a.unit.originalDriverName,
        a.assignedDriverName,
        a.role === 'owner' ? 'Inhaber' : 'Steuerberater-Fahrer',
        secToH(a.unit.workSec), secToH(a.unit.nightSec), secToH(a.unit.sunSec), secToH(a.unit.holSec),
        a.entlastungsGrund,
        a.bufferWarning ?? '—',
      ]);
    }
    if (rekRows.length === 1) rekRows.push(['—', '—', '—', '—', '—', '—', '—', '—', '', '', '', '', '—', '—']);

    // Sheet 4: Plan-Istwerte
    const planIstRows: (string | number)[][] = [['Fahrer', 'Pers.-Nr.', 'Lohnart', 'Bezeichnung', 'Plan-Ist (Std.)']];
    for (const t of exportTargets) {
      const actual = rr.driverActuals.get(t.driverId) ?? { workSec: 0, nightSec: 0, night0to4Sec: 0, sunSec: 0, holSec: 0 };
      for (const [code, sec, label] of [
        ['1000', actual.workSec, 'Stundenlohn'], ['1501', actual.nightSec, 'Nachtzuschlag, 40% frei'],
        ['1502', actual.night0to4Sec, 'Nacht 0–4 Uhr'],
        ['1510', actual.sunSec, 'Sonntagszuschlag, 50% frei'], ['1520', actual.holSec, 'Feiertagszuschlag, 125% frei'],
      ] as [string, number, string][]) {
        planIstRows.push([t.driverName, t.personalnummer, code, label, secToH(sec)]);
      }
    }

    // Sheet 5: Korrekturen (positive only)
    const korRows: (string | number)[][] = [['Fahrer', 'Pers.-Nr.', 'Lohnart', 'Bezeichnung', 'Plan-Ist (Std.)', 'Ziel (Std.)', 'Korrektur (Std.)', 'Korrektur (Sek.)', 'Grund']];
    for (const c of rr.corrections) {
      korRows.push([c.driverName, c.personalnummer, c.wageCode, c.wageLabel, secToH(c.planActualSec), secToH(c.targetSec), secToH(c.correctionSec), c.correctionSec, c.reason]);
    }
    if (korRows.length === 1) korRows.push(['—', '—', '—', 'Keine Korrekturzeilen erforderlich', '', '', '', 0, '']);

    // Sheet 6: Korrigierte Istwerte
    const korIstRows: (string | number)[][] = [['Fahrer', 'Pers.-Nr.', 'Lohnart', 'Bezeichnung', 'Plan-Ist (Std.)', 'Korrektur (Std.)', 'Korrigierter Istwert (Std.)', 'Ziel (Std.)', 'Differenz (Std.)', 'Status']];
    for (const t of exportTargets) {
      const actual = rr.driverActuals.get(t.driverId) ?? { workSec: 0, nightSec: 0, night0to4Sec: 0, sunSec: 0, holSec: 0 };
      for (const [code, planSec, targetSec, label] of [
        ['1000', actual.workSec, t.workSec, 'Stundenlohn'],
        ['1501', actual.nightSec, t.nightSec, 'Nachtzuschlag, 40% frei'],
        ['1502', actual.night0to4Sec, t.night0to4Sec, 'Nacht 0–4 Uhr'],
        ['1510', actual.sunSec, t.sunSec, 'Sonntagszuschlag, 50% frei'],
        ['1520', actual.holSec, t.holSec, 'Feiertagszuschlag, 125% frei'],
      ] as [string, number, number, string][]) {
        const corrLine = rr.corrections.find(c => c.driverId === t.driverId && c.wageCode === code);
        const corrSec = corrLine?.correctionSec ?? 0;
        const corrIst = (planSec as number) + corrSec;
        const diff = corrIst - (targetSec as number);
        korIstRows.push([t.driverName, t.personalnummer, code, label, secToH(planSec as number), secToH(corrSec), secToH(corrIst), secToH(targetSec as number), secToH(diff), Math.abs(diff) <= 1 ? 'OK' : 'Abweichung']);
      }
    }

    // Sheet 7: Abgleich
    const abRows: (string | number)[][] = [['Fahrer', 'Pers.-Nr.', 'Lohnart', 'Bezeichnung', 'Ziel (Std.)', 'Korrigierter Istwert (Std.)', 'Differenz (Std.)', 'Status']];
    for (const t of exportTargets) {
      const actual = rr.driverActuals.get(t.driverId) ?? { workSec: 0, nightSec: 0, night0to4Sec: 0, sunSec: 0, holSec: 0 };
      for (const [code, planSec, targetSec, label] of [
        ['1000', actual.workSec, t.workSec, 'Stundenlohn'],
        ['1501', actual.nightSec, t.nightSec, 'Nachtzuschlag, 40% frei'],
        ['1502', actual.night0to4Sec, t.night0to4Sec, 'Nacht 0–4 Uhr'],
        ['1510', actual.sunSec, t.sunSec, 'Sonntagszuschlag, 50% frei'],
        ['1520', actual.holSec, t.holSec, 'Feiertagszuschlag, 125% frei'],
      ] as [string, number, number, string][]) {
        if ((targetSec as number) === 0) continue;
        const corrLine = rr.corrections.find(c => c.driverId === t.driverId && c.wageCode === code);
        const corrIst = (planSec as number) + (corrLine?.correctionSec ?? 0);
        const diff = corrIst - (targetSec as number);
        abRows.push([t.driverName, t.personalnummer, code, label, secToH(targetSec as number), secToH(corrIst), secToH(diff), Math.abs(diff) <= 1 ? 'OK' : 'Abweichung']);
      }
    }

    // Sheet 8: Inhaber-Fahrten
    const ownerRows: (string | number)[][] = [['Fahrt-ID', 'Datum', 'Start', 'Ende', 'Kennzeichen', 'Original Fahrer', 'Inhaber', '1000 (Std.)', '1501 (Std.)', '1510 (Std.)', '1520 (Std.)', 'Entlastungsgrund']];
    for (const a of rr.assignments.filter(x => x.role === 'owner')) {
      ownerRows.push([
        a.unit.fahrtId, a.unit.date, fmtMin(a.unit.startMin), fmtMin(a.unit.endMin),
        a.unit.vehicleKennzeichen ?? '—', a.unit.originalDriverName, a.assignedDriverName,
        secToH(a.unit.workSec), secToH(a.unit.nightSec), secToH(a.unit.sunSec), secToH(a.unit.holSec),
        a.entlastungsGrund,
      ]);
    }
    if (ownerRows.length === 1) ownerRows.push(['—', '—', '—', '—', '—', '—', 'Keine Inhaber-Fahrten', '', '', '', '', '']);

    // Sheet 9: Konflikte
    const koRows: (string | number)[][] = [
      ['Zusammenfassung', ''],
      ['Nicht zugewiesene Fahrten', rr.unassignedCount],
      ['Inhaber-Originalkonflikte', rr.ownerOriginalCount],
      ['Fahrer über Zielwert', rr.driversOverTarget.length],
      ['Negative Korrekturen erforderlich', rr.negativeCorrectionsRequired],
      ['Fahrzeugwechsel-Puffer-Warnungen', rr.bufferWarnings],
      ['', ''],
      ['Art', 'Fahrt-ID', 'Datum', 'Beschreibung'],
    ];
    for (const c of rr.conflicts) {
      const typeLabel =
        c.type === 'unassigned'      ? 'Nicht zugewiesen' :
        c.type === 'owner_original'  ? 'Inhaber-Originalkonflikt' :
        c.type === 'over_target'     ? 'Über Zielwert' :
        c.type === 'buffer_warning'  ? 'Fahrzeugwechsel-Puffer' :
        c.type === 'driver_overlap'  ? 'Fahrer-Überschneidung' :
        c.type === 'vehicle_overlap' ? 'Fahrzeug-Überschneidung' : c.type;
      koRows.push([typeLabel, c.fahrtId || '—', c.date || '—', c.description]);
    }

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(ergebnisRows), 'Ergebnis');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(zielRows), 'Zielwerte');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rekRows), 'Fahrt-Rekonstruktion');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(planIstRows), 'Plan-Istwerte');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(korRows), 'Korrekturen');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(korIstRows), 'Korrigierte Istwerte');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(abRows), 'Abgleich');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(ownerRows), 'Inhaber-Fahrten');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(koRows), 'Konflikte');
    XLSX.writeFile(wb, `Historische_Zielwert_Planung_${year}-${monthStr}.xlsx`);
  };

  // ── Step 3: Historical finalization ──────────────────────────────────────────

  const MONTHS_DE_LOCAL = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];
  const WEEKDAY_SHORT = ['So','Mo','Di','Mi','Do','Fr','Sa'];
  const DISCLAIMER = 'Historischer Abgleich: Die Fahrten bleiben unverändert dokumentiert. Die Stundennachweise wurden auf Basis der Einzelfahrt-Rekonstruktion und der übermittelten Steuerberater-Werte erstellt.';

  function validateFinalization(rr: ReconstructionResult, targets: ReconstructionDriverTarget[]): { ok: boolean; blockers: string[] } {
    const blockers: string[] = [];
    if (!rr.isFinalizable) blockers.push('Ergebnis ist nicht finalisierbar.');
    if (rr.unassignedCount > 0) blockers.push(`${rr.unassignedCount} Fahrt(en) nicht zugewiesen.`);
    if (rr.driversOverTarget.length > 0) blockers.push(`Fahrer über Zielwert: ${rr.driversOverTarget.join(', ')}`);
    if (rr.negativeCorrectionsRequired > 0) blockers.push(`${rr.negativeCorrectionsRequired} negative Korrekturen erforderlich.`);
    if (rr.solverLimitReached || rr.solverCancelled) blockers.push('Berechnung wurde abgebrochen oder Limit erreicht.');
    if (rr.conflicts.some(c => c.type === 'driver_overlap' || c.type === 'vehicle_overlap')) blockers.push('Harte Überschneidungskonflikte vorhanden.');
    // Check no duplicate fahrtId assignments
    const seen = new Set<string>();
    for (const a of rr.assignments) {
      if (seen.has(a.unit.fahrtId)) { blockers.push('Doppelte Fahrt-Zuweisungen gefunden.'); break; }
      seen.add(a.unit.fahrtId);
    }
    // Check corrected values equal targets
    // Check corrected values equal targets, and strict 0,00
    for (const t of targets) {
      const actual = rr.driverActuals.get(t.driverId) ?? { workSec: 0, nightSec: 0, night0to4Sec: 0, sunSec: 0, holSec: 0 };
      const corrLines = rr.corrections.filter(c => c.driverId === t.driverId);
      const corrMap = new Map(corrLines.map(c => [c.wageCode, c.correctionSec]));
      for (const [code, planSec, tgtSec] of [
        ['1000', actual.workSec, t.workSec], ['1501', actual.nightSec, t.nightSec],
        ['1502', actual.night0to4Sec, t.night0to4Sec],
        ['1510', actual.sunSec, t.sunSec], ['1520', actual.holSec, t.holSec],
      ] as [string, number, number][]) {
        if (tgtSec === 0) {
          if (planSec > 1) {
            blockers.push(`${t.driverName} Lohnart ${code}: Zielwert 0,00 aber Plan-Ist ${(planSec/3600).toFixed(4)} h — nicht korrigierbar.`);
          }
          continue;
        }
        const corrIst = planSec + (corrMap.get(code) ?? 0);
        if (Math.abs(corrIst - tgtSec) > 1) {
          blockers.push(`${t.driverName} Lohnart ${code}: Korrigierter Ist-Wert (${(corrIst/3600).toFixed(4)} h) ≠ Ziel (${(tgtSec/3600).toFixed(4)} h).`);
        }
      }
    }
    return { ok: blockers.length === 0, blockers };
  }

  function secToHHMM(totalSec: number): string {
    const mins = Math.round(totalSec / 60);
    const h = Math.floor(Math.abs(mins) / 60);
    const m = Math.abs(mins) % 60;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
  }

  function buildDriverDayRows(
    driverId: string,
    rr: ReconstructionResult,
    holidays: Set<string>,
    yr: number,
    mo: number,
  ): PdfDayRow[] {
    // Group assignments for this driver by date
    const byDate = new Map<string, typeof rr.assignments[0][]>();
    for (const a of rr.assignments) {
      if (a.assignedDriverId !== driverId) continue;
      if (!byDate.has(a.unit.date)) byDate.set(a.unit.date, []);
      byDate.get(a.unit.date)!.push(a);
    }

    // Build a row for every calendar day in the month
    const daysInMonth = new Date(yr, mo, 0).getDate();
    const rows: PdfDayRow[] = [];

    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${yr}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const dateObj = new Date(yr, mo - 1, d);
      const dow = dateObj.getDay();
      const isSun = dow === 0;
      const isSat = dow === 6;
      const isHol = holidays.has(dateStr);
      const weekday = WEEKDAY_SHORT[dow];

      const fahrten = (byDate.get(dateStr) ?? []).sort((a, b) => a.unit.startMin - b.unit.startMin);

      // Aggregate seconds for this day
      let dayWorkSec = 0, dayNightSec = 0, dayNight0to4Sec = 0, daySunSec = 0, dayHolSec = 0;
      for (const a of fahrten) {
        dayWorkSec      += a.unit.workSec;
        dayNightSec     += a.unit.nightSec;
        dayNight0to4Sec += a.unit.night0to4Sec;
        daySunSec       += a.unit.sunSec;
        dayHolSec       += a.unit.holSec;
      }

      // Up to 3 shift slots
      const fmtMins = (m: number) => `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
      const von1 = fahrten[0] ? fmtMins(fahrten[0].unit.startMin) : '';
      const bis1 = fahrten[0] ? fmtMins(fahrten[0].unit.endMin) : '';
      const von2 = fahrten[1] ? fmtMins(fahrten[1].unit.startMin) : '';
      const bis2 = fahrten[1] ? fmtMins(fahrten[1].unit.endMin) : '';
      const von3 = fahrten[2] ? fmtMins(fahrten[2].unit.startMin) : '';
      const bis3 = fahrten[2] ? fmtMins(fahrten[2].unit.endMin) : '';

      rows.push({
        date: dateObj,
        weekday,
        isSat,
        isSun,
        isHol,
        von1, bis1,
        von2, bis2,
        von3, bis3,
        grundlohn:     dayWorkSec > 0 ? secToHHMM(dayWorkSec) : '',
        nachtarbeit:   dayNightSec > 0 ? secToHHMM(dayNightSec) : '',
        nachtarbeit04: dayNight0to4Sec > 0 ? secToHHMM(dayNight0to4Sec) : '',
        sonntag:       daySunSec > 0 ? secToHHMM(daySunSec) : '',
        feiertag:      dayHolSec > 0 ? secToHHMM(dayHolSec) : '',
        weihnachten:   '',
      });
    }
    return rows;
  }

  const handleGenerateFinalDocuments = useCallback(() => {
    if (!reconstructionResult) return;
    const rr = reconstructionResult;

    // Build targets from current state
    const targets: ReconstructionDriverTarget[] = [];
    for (const dId of allSelectedDriverIds) {
      const driver = allDrivers.find(d => d.id === dId);
      if (!driver || driver.employment_type === 'company_owner') continue;
      targets.push({
        driverId: dId, driverName: driver.name, personalnummer: driver.personalnummer,
        workSec:  Math.round((parseDecimal(getVal(dId, '1000')) ?? 0) * 3600),
        nightSec: Math.round((parseDecimal(getVal(dId, '1501')) ?? 0) * 3600),
        night0to4Sec: Math.round((parseDecimal(getVal(dId, '1502')) ?? 0) * 3600),
        sunSec:   Math.round((parseDecimal(getVal(dId, '1510')) ?? 0) * 3600),
        holSec:   Math.round((parseDecimal(getVal(dId, '1520')) ?? 0) * 3600),
        isZusatzfahrer: zusatzfahrerIds.has(dId),
      });
    }

    // Strict validation
    const { ok, blockers } = validateFinalization(rr, targets);
    if (!ok) {
      alert(`Historische Finalisierung blockiert:\n\n${blockers.join('\n')}`);
      return;
    }

    const holidays = getHolidaysReconstruction(year);
    const monthStr = String(month).padStart(2, '0');
    const secToH = (s: number) => +(s / 3600).toFixed(6);

    // ── Generate final XLSX ──────────────────────────────────────────────────
    const ergebnisRows: (string | number)[][] = [
      ['Historische Finalisierung', `${MONTHS_DE_LOCAL[month - 1]} ${year}`],
      ['Strategie', 'Max-Inhaber-Einzelfahrt-Rekonstruktion'],
      ['Status', 'Finalisierbar mit Korrekturzeilen'],
      ['Finalisierung erlaubt', 'Ja'],
      ['Abgleich', 'OK'],
      ['Negative Korrekturen erforderlich', 0],
      ['Fahrer über Zielwert', 0],
      ['Hinweis', DISCLAIMER],
      ['', ''],
      ['Fahrten gesamt', rr.totalFahrten],
      ['An Inhaber', rr.ownerFahrten],
      ['An Steuerberater-Fahrer', rr.payrollFahrten],
      ['Nicht zugewiesen', rr.unassignedCount],
      ['Positive Korrekturzeilen', rr.corrections.length],
      ['Berechnungszeit (ms)', Math.round(rr.solverElapsedMs)],
    ];

    const zielRows: (string | number)[][] = [['Fahrer','Pers.-Nr.','Lohnart','Bezeichnung','Ziel (Std.)']];
    for (const t of targets) {
      for (const [code, sec, label] of [
        ['1000', t.workSec, 'Stundenlohn'], ['1501', t.nightSec, 'Nachtzuschlag, 40% frei'],
        ['1502', t.night0to4Sec, 'Nacht 0–4 Uhr'],
        ['1510', t.sunSec, 'Sonntagszuschlag, 50% frei'], ['1520', t.holSec, 'Feiertagszuschlag, 125% frei'],
      ] as [string, number, string][]) {
        zielRows.push([t.driverName, t.personalnummer, code, label, secToH(sec)]);
      }
    }

    const fmtMin = (m: number) => `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
    const rekRows: (string | number)[][] = [['Fahrt-ID','Datum','Start','Ende','Kennzeichen','Original Fahrer','Rekonstruktions-Fahrer','Rolle','1000 (Std.)','1501 (Std.)','1502 (Std.)','1510 (Std.)','1520 (Std.)','Entlastungsgrund']];
    for (const a of rr.assignments) {
      rekRows.push([
        a.unit.fahrtId, a.unit.date, fmtMin(a.unit.startMin), fmtMin(a.unit.endMin),
        a.unit.vehicleKennzeichen ?? '—', a.unit.originalDriverName, a.assignedDriverName,
        a.role === 'owner' ? 'Inhaber' : 'Steuerberater-Fahrer',
        secToH(a.unit.workSec), secToH(a.unit.nightSec), secToH(a.unit.night0to4Sec), secToH(a.unit.sunSec), secToH(a.unit.holSec),
        a.entlastungsGrund,
      ]);
    }

    const planIstRows: (string | number)[][] = [['Fahrer','Pers.-Nr.','Lohnart','Bezeichnung','Plan-Ist (Std.)']];
    for (const t of targets) {
      const actual = rr.driverActuals.get(t.driverId) ?? { workSec:0, nightSec:0, night0to4Sec:0, sunSec:0, holSec:0 };
      for (const [code, sec, label] of [
        ['1000', actual.workSec, 'Stundenlohn'], ['1501', actual.nightSec, 'Nachtzuschlag, 40% frei'],
        ['1502', actual.night0to4Sec, 'Nacht 0–4 Uhr'],
        ['1510', actual.sunSec, 'Sonntagszuschlag, 50% frei'], ['1520', actual.holSec, 'Feiertagszuschlag, 125% frei'],
      ] as [string, number, string][]) {
        planIstRows.push([t.driverName, t.personalnummer, code, label, secToH(sec)]);
      }
    }

    const korRows: (string | number)[][] = [['Fahrer','Pers.-Nr.','Lohnart','Bezeichnung','Plan-Ist (Std.)','Ziel (Std.)','Korrektur (Std.)','Korrektur (Sek.)','Grund']];
    for (const c of rr.corrections) {
      korRows.push([c.driverName, c.personalnummer, c.wageCode, c.wageLabel, secToH(c.planActualSec), secToH(c.targetSec), secToH(c.correctionSec), c.correctionSec, c.reason]);
    }
    if (korRows.length === 1) korRows.push(['—','—','—','Keine Korrekturzeilen erforderlich','','','',0,'']);

    const korIstRows: (string | number)[][] = [['Fahrer','Pers.-Nr.','Lohnart','Bezeichnung','Plan-Ist (Std.)','Korrektur (Std.)','Korrigierter Istwert (Std.)','Ziel (Std.)','Differenz (Std.)','Status']];
    for (const t of targets) {
      const actual = rr.driverActuals.get(t.driverId) ?? { workSec:0, nightSec:0, night0to4Sec:0, sunSec:0, holSec:0 };
      for (const [code, planSec, tgtSec, label] of [
        ['1000', actual.workSec, t.workSec, 'Stundenlohn'],
        ['1501', actual.nightSec, t.nightSec, 'Nachtzuschlag, 40% frei'],
        ['1502', actual.night0to4Sec, t.night0to4Sec, 'Nacht 0–4 Uhr'],
        ['1510', actual.sunSec, t.sunSec, 'Sonntagszuschlag, 50% frei'],
        ['1520', actual.holSec, t.holSec, 'Feiertagszuschlag, 125% frei'],
      ] as [string, number, number, string][]) {
        const corrLine = rr.corrections.find(c => c.driverId === t.driverId && c.wageCode === code);
        const corrSec = corrLine?.correctionSec ?? 0;
        const corrIst = planSec + corrSec;
        const diff = corrIst - tgtSec;
        korIstRows.push([t.driverName, t.personalnummer, code, label, secToH(planSec), secToH(corrSec), secToH(corrIst), secToH(tgtSec), secToH(diff), Math.abs(diff) <= 1 ? 'OK' : 'ABWEICHUNG']);
      }
    }

    // Sheet: Stundennachweis-Final — one row per driver + Lohnart, final corrected values
    const snFinalRows: (string | number)[][] = [['Fahrer','Pers.-Nr.','Lohnart','Bezeichnung','Plan-Ist (Std.)','Korrektur (Std.)','Finaler Wert (Std.)','Zielwert (Std.)','Differenz (Std.)','Status']];
    for (const t of targets) {
      const actual = rr.driverActuals.get(t.driverId) ?? { workSec:0, nightSec:0, night0to4Sec:0, sunSec:0, holSec:0 };
      for (const [code, planSec, tgtSec, label] of [
        ['1000', actual.workSec, t.workSec, 'Stundenlohn'],
        ['1501', actual.nightSec, t.nightSec, 'Nachtzuschlag, 40% frei'],
        ['1502', actual.night0to4Sec, t.night0to4Sec, 'Nacht 0–4 Uhr'],
        ['1510', actual.sunSec, t.sunSec, 'Sonntagszuschlag, 50% frei'],
        ['1520', actual.holSec, t.holSec, 'Feiertagszuschlag, 125% frei'],
      ] as [string, number, number, string][]) {
        if (tgtSec === 0) continue;
        const corrLine = rr.corrections.find(c => c.driverId === t.driverId && c.wageCode === code);
        const corrSec = corrLine?.correctionSec ?? 0;
        const finalSec = planSec + corrSec;
        const diff = finalSec - tgtSec;
        snFinalRows.push([t.driverName, t.personalnummer, code, label, secToH(planSec), secToH(corrSec), secToH(finalSec), secToH(tgtSec), secToH(diff), Math.abs(diff) <= 1 ? 'OK' : 'ABWEICHUNG']);
      }
    }

    const koRows: (string | number)[][] = [
      ['Art','Fahrt-ID','Datum','Beschreibung'],
    ];
    // Only list hard conflicts (unassigned, over_target, owner_original).
    // Buffer warnings are informational and do not block finalization.
    for (const c of rr.conflicts) {
      if (c.type === 'buffer_warning') continue; // informational only
      const label = c.type === 'unassigned' ? 'Nicht zugewiesen' : c.type === 'owner_original' ? 'Inhaber-Originalkonflikt' : c.type === 'over_target' ? 'Über Zielwert' : c.type;
      koRows.push([label, c.fahrtId || '—', c.date || '—', c.description]);
    }
    if (koRows.length === 1) koRows.push(['—','—','—','Keine Konflikte — Abgleich OK']);

    // ── Historisches Fahrtenbuch: all Fahrten with original + final driver + reason
    const histFbRows: (string | number | null)[][] = [[
      'Fahrt-ID', 'Datum', 'Start', 'Ende', 'Kennzeichen',
      'Original Fahrer', 'Finaler Fahrer', 'Rolle', 'Grund',
      '1000 (Std.)', '1501 (Std.)', '1502 (Std.)', '1510 (Std.)', '1520 (Std.)',
    ]];
    for (const a of rr.assignments) {
      const roleLabel =
        a.role === 'owner' ? 'Inhaber' :
        a.role === 'zusatzfahrer' ? 'Historischer Zusatzfahrer' : 'Steuerberater-Fahrer';
      histFbRows.push([
        a.unit.fahrtId,
        a.unit.date,
        fmtMin(a.unit.startMin),
        fmtMin(a.unit.endMin),
        a.unit.vehicleKennzeichen ?? '—',
        a.unit.originalDriverName,
        a.assignedDriverName,
        roleLabel,
        a.entlastungsGrund,
        secToH(a.unit.workSec),
        secToH(a.unit.nightSec),
        secToH(a.unit.night0to4Sec),
        secToH(a.unit.sunSec),
        secToH(a.unit.holSec),
      ]);
    }
    // Unassigned Fahrten also need to appear
    for (const u of rr.unassigned) {
      histFbRows.push([
        u.fahrtId, u.date, fmtMin(u.startMin), fmtMin(u.endMin),
        u.vehicleKennzeichen ?? '—',
        u.originalDriverName, 'NICHT ZUGEWIESEN', 'Unassigned', 'Nicht zuweisbar',
        secToH(u.workSec), secToH(u.nightSec), secToH(u.night0to4Sec), secToH(u.sunSec), secToH(u.holSec),
      ]);
    }

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(ergebnisRows), 'Ergebnis');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(zielRows), 'Zielwerte');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(histFbRows), 'Historisches Fahrtenbuch');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rekRows), 'Fahrt-Rekonstruktion');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(planIstRows), 'Plan-Istwerte');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(korRows), 'Korrekturen');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(korIstRows), 'Korrigierte Istwerte');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(snFinalRows), 'Stundennachweis-Final');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(koRows), 'Konflikte');
    XLSX.writeFile(wb, `Historische_Finalisierung_${year}-${monthStr}.xlsx`);

    // ── Generate per-driver PDFs ─────────────────────────────────────────────
    for (const t of targets) {
      const dayRows = buildDriverDayRows(t.driverId, rr, holidays, year, month);

      // Totals must equal Zielwerte (corrected values), converted to minutes
      const pdfTotals: PdfTotals = {
        grundlohn:   Math.round((t.workSec) / 60),
        nachtarbeit: Math.round((t.nightSec) / 60),
        nacht04:     Math.round((t.night0to4Sec) / 60),
        sonntag:     Math.round((t.sunSec) / 60),
        feiertag:    Math.round((t.holSec) / 60),
        weihnachten: 0,
      };

      // Build structured correction entries for historical correction table
      const driverCorrs = rr.corrections.filter(c => c.driverId === t.driverId);
      const historicalCorrections: HistoricalPdfCorrectionEntry[] = driverCorrs.map(c => ({
        wageCode:       c.wageCode,
        wageLabel:      c.wageLabel,
        planActualMins: Math.round(c.planActualSec / 60),
        correctionMins: Math.round(c.correctionSec / 60),
        finalMins:      Math.round(c.correctedActualSec / 60),
        targetMins:     Math.round(c.targetSec / 60),
      }));

      const exportData: StundennachweisExportData = {
        driver: { name: t.driverName, personalnummer: t.personalnummer },
        month,
        year,
        rows: dayRows,
        totals: pdfTotals,
        isHistorical: true,
        historicalCorrections,
      };

      const filename = `Historischer_Stundennachweis_${t.driverName.replace(/\s+/g, '_')}_${year}-${monthStr}.pdf`;
      exportStundennachweisAsPdf(exportData, filename);
    }

    setFinalizationGenerated(true);
    setFinalizationSnapshot({
      month, year,
      strategy: strategyMode,
      bufferMode,
      driverIds: driverIdsKey,
      targetHash,
      generatedAt: Date.now(),
    });
  }, [reconstructionResult, allSelectedDriverIds, allDrivers, targetValues, month, year, bufferMode, strategyMode, driverIdsKey, targetHash]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Step 3: XLSX export ────────────────────────────────────────────────────────
  const handleExportPlanung = () => {
    if (!planningResult) return;
    const monthStr = String(month).padStart(2, '0');
    const pr = planningResult;
    const cl = correctionLines; // may be null

    const secToH = (s: number) => +(s / 3600).toFixed(6);

    // Rebuild targets list for sheet data
    const exportTargets: DriverTargetSeconds[] = [];
    for (const dId of selectedDriverIds) {
      const driver = allDrivers.find(d => d.id === dId);
      if (!driver || driver.employment_type === 'company_owner') continue;
      exportTargets.push({
        driverId: dId, driverName: driver.name, personalnummer: driver.personalnummer,
        workSec:  Math.round((parseDecimal(getVal(dId, '1000')) ?? 0) * 3600),
        nightSec: Math.round((parseDecimal(getVal(dId, '1501')) ?? 0) * 3600),
        night0to4Sec: Math.round((parseDecimal(getVal(dId, '1502')) ?? 0) * 3600),
        sunSec:   Math.round((parseDecimal(getVal(dId, '1510')) ?? 0) * 3600),
        holSec:   Math.round((parseDecimal(getVal(dId, '1520')) ?? 0) * 3600),
      });
    }

    const deviationCount   = pr.deviations.filter(d => d.diffSec !== 0).length;
    const hardConflictsFree =
      pr.vehicleOverlapCount === 0 &&
      pr.driverOverlapCount  === 0 &&
      pr.vehicleSwitchCount  === 0;
    const hardConflictsTotal = pr.vehicleOverlapCount + pr.driverOverlapCount + pr.vehicleSwitchCount;
    const correctedFinalizable =
      cl !== null &&
      hardConflictsFree &&
      pr.unassignedCount === 0 &&
      pr.driversOverTarget.length === 0 &&
      pr.ownerOriginalCount === 0 &&
      cl.every(l => l.correctedActualSec === l.targetSec) &&
      deviationCount === cl.length;
    const finalizierbar = pr.isFinalizable || correctedFinalizable;
    const statusLabel =
      pr.isFinalizable ? 'Finalisierbar'
      : correctedFinalizable ? 'Finalisierbar mit Korrekturzeilen'
      : 'Nicht finalisierbar';

    // Sheet 1: Ergebnis
    const ergebnisRows: (string | number)[][] = [
      ['Feld', 'Wert'],
      ['Monat', month],
      ['Jahr', year],
      ['Strategie', cl !== null ? 'Einzel-Inhaber-Entlastung' : 'Greedy-Solver'],
      ['Ausgangsbasis', cl !== null ? 'Fahrtenbuch-Zuweisungen (transfer-basiert)' : 'Greedy-Solver'],
      ['Status', statusLabel],
      ['Exakt aus Fahrten lösbar', pr.isExact ? 'Ja' : 'Nein'],
      ['Korrekturzeilen zugelassen', cl !== null ? 'Ja' : 'Nein'],
      ['Finalisierbar mit Korrekturzeilen', correctedFinalizable ? 'Ja' : 'Nein'],
      ['Anzahl Korrekturzeilen', cl?.length ?? 0],
      ['Original Schichtblöcke', pr.totalBlocks],
      ['Finale Zuordnungseinheiten', pr.finalAssignmentUnits ?? pr.totalBlocks],
      ['Granulare Einzelfahrten', pr.granularEinzelfahrten ?? 0],
      ['Einheiten unverändert (Originalfahrer)', cl !== null ? pr.totalBlocks - pr.ownerAssigned - pr.unassignedCount : '—'],
      ['An Steuerberater-Fahrer', pr.payrollAssigned],
      ['An Inhaber übertragen (gesamt)', pr.ownerAssigned],
      ['  Davon Über-Zielwert-Entlastung (kritisch)', (pr as any).ownerCriticalReliefCount ?? '—'],
      ['  Davon Einzelwagen optional', (pr as any).ownerOptionalEinzelwagenCount ?? '—'],
      ['  Davon Inhaber-Eigenfahrten (Baseline)', (pr as any).ownerBaselineCount ?? '—'],
      ['Nicht zuweisbar wegen Quelldatenfehler', pr.unassignedCount],
      ['Zielabweichungen vor Korrektur', deviationCount],
      ['Harte Konflikte (Überschneidungen / Puffer)', hardConflictsTotal],
      ['Fahrzeug-Überschneidungen', pr.vehicleOverlapCount],
      ['Fahrer-Überschneidungen', pr.driverOverlapCount],
      ['Fahrzeugwechsel-Verstöße', pr.vehicleSwitchCount],
      ['Finalisierung erlaubt', finalizierbar ? 'Ja' : 'Nein'],
      // Owner relief stats
      ['Einzelwagen-Zeiten erkannt', pr.einzelwagenZeitenTotal],
      ['Einzelwagen-Zeiten an Inhaber (Phase B)', pr.einzelwagenZeitenToOwner],
      ['Über-Zielwert-Entlastung an Inhaber (Phase A)', pr.reliefPassTotal],
      ['Über-Zielwert-Entlastung Kandidaten geprüft', pr.reliefCandidatesTried],
      ['Granulare Über-Zielwert-Transfers (Einzelfahrt)', pr.reliefGranularTransfers],
      ['Tauschversuche (Swap)', pr.swapAttemptsTotal ?? 0],
      ['Tausche akzeptiert', pr.swapAcceptedTotal ?? 0],
      ['Granulare Prüfungen gesamt', (pr as any).solverGranularAttempts ?? 0],
      ['Nicht entlastbare Über-Zielwert-Einheiten', pr.unresolvedOverTargetCount],
      ['Fahrer über Zielwert', pr.driversOverTarget.length > 0 ? pr.driversOverTarget.join(', ') : 'Keine'],
      ['Negative Korrekturen erforderlich', pr.negativeCorrectionsRequired],
      ['Inhaber war im Ausgangsmonat Fahrer', ownerExcluded ? 'Nein' : 'Ja'],
      ['Inhaber original (Quelldatenfehler)', pr.ownerOriginalCount],
      ['Berechnungszeit (ms)', Math.round((pr as any).solverElapsedMs ?? 0)],
      ['Berechnungslimit erreicht', (pr as any).solverLimitReached ? 'Ja' : 'Nein'],
      ['Berechnung abgebrochen', (pr as any).solverCancelled ? 'Ja' : 'Nein'],
      ['Diagnosen gekürzt', (pr as any).diagnosticsTruncated ?? 0],
    ];
    ergebnisRows.push(['', '']);
    if (pr.ownerAssigned === 0 && !allDrivers.some(d => d.employment_type === 'company_owner')) {
      ergebnisRows.push(['Warnung', 'Kein Inhaber / Auffangfahrer gefunden. Bitte markieren Sie einen Fahrer als Inhaber / Selbstständig.']);
    }
    if (cl !== null) {
      ergebnisRows.push(['Hinweis', 'Dieser historische Abgleich verwendet transparente Korrekturzeilen. Das Fahrtenbuch bleibt unverändert.']);
    } else if (!pr.isFinalizable) {
      ergebnisRows.push(['Hinweis', 'Dieser Export ist nur ein Prüf-Export und darf nicht als finaler Stundennachweis verwendet werden.']);
    }

    // Sheet 2: Zielwerte
    const zielRows: (string | number)[][] = [['Fahrer', 'Pers.-Nr.', 'Lohnart', 'Bezeichnung', 'Zielwert (Std.)']];
    for (const t of exportTargets) {
      for (const [code, sec, label] of [
        ['1000', t.workSec,  'Stundenlohn'],
        ['1501', t.nightSec, 'Nachtzuschlag, 40% frei'],
        ['1510', t.sunSec,   'Sonntagszuschlag, 50% frei'],
        ['1520', t.holSec,   'Feiertagszuschlag, 125% frei'],
      ] as [string, number, string][]) {
        zielRows.push([t.driverName, t.personalnummer, code, label, secToH(sec)]);
      }
    }

    // Sheet 3: Plan-Istwerte (solver-produced actuals — NOT overwritten by corrections)
    const planIstRows: (string | number)[][] = [['Fahrer', 'Pers.-Nr.', 'Lohnart', 'Bezeichnung', 'Plan-Istwert (Std.)']];
    for (const t of exportTargets) {
      const actual = pr.driverActuals.get(t.driverId) ?? { workSec: 0, nightSec: 0, sunSec: 0, holSec: 0 };
      for (const [code, sec, label] of [
        ['1000', actual.workSec,  'Stundenlohn'],
        ['1501', actual.nightSec, 'Nachtzuschlag, 40% frei'],
        ['1510', actual.sunSec,   'Sonntagszuschlag, 50% frei'],
        ['1520', actual.holSec,   'Feiertagszuschlag, 125% frei'],
      ] as [string, number, string][]) {
        planIstRows.push([t.driverName, t.personalnummer, code, label, secToH(sec)]);
      }
    }

    // Sheet 4: Korrekturen (only when corrections were computed)
    const korRows: (string | number)[][] = [['Fahrer', 'Pers.-Nr.', 'Lohnart', 'Bezeichnung', 'Plan-Ist (Std.)', 'Ziel (Std.)', 'Korrektur (Std.)', 'Korrektur (Sek.)', 'Grund']];
    if (cl) {
      for (const l of cl) {
        korRows.push([l.driverName, l.personalnummer, l.wageCode, l.wageLabel, secToH(l.planActualSec), secToH(l.targetSec), secToH(l.correctionSec), l.correctionSec, l.reason]);
      }
    } else {
      korRows.push(['—', '—', '—', 'Keine Korrekturzeilen berechnet (Checkbox war nicht aktiviert)', '', '', '', '', '']);
    }

    // Sheet 5: Korrigierte Istwerte (plan-actual + correction = target)
    const korIstRows: (string | number)[][] = [['Fahrer', 'Pers.-Nr.', 'Lohnart', 'Bezeichnung', 'Plan-Ist (Std.)', 'Korrektur (Std.)', 'Korrigierter Istwert (Std.)', 'Ziel (Std.)', 'Differenz (Std.)', 'Status']];
    for (const t of exportTargets) {
      const actual = pr.driverActuals.get(t.driverId) ?? { workSec: 0, nightSec: 0, sunSec: 0, holSec: 0 };
      for (const [code, planSec, label] of [
        ['1000', actual.workSec,  'Stundenlohn'],
        ['1501', actual.nightSec, 'Nachtzuschlag, 40% frei'],
        ['1510', actual.sunSec,   'Sonntagszuschlag, 50% frei'],
        ['1520', actual.holSec,   'Feiertagszuschlag, 125% frei'],
      ] as [string, number, string][]) {
        const corrLine = cl?.find(l => l.driverId === t.driverId && l.wageCode === code);
        const corrSec = corrLine?.correctionSec ?? 0;
        const corrIst = planSec + corrSec;
        const targetCode = code === '1000' ? t.workSec : code === '1501' ? t.nightSec : code === '1510' ? t.sunSec : t.holSec;
        const diff = corrIst - targetCode;
        korIstRows.push([t.driverName, t.personalnummer, code, label, secToH(planSec), secToH(corrSec), secToH(corrIst), secToH(targetCode), secToH(diff), diff === 0 ? 'OK' : 'Abweichung']);
      }
    }

    // Sheet 6: Abgleich — uses corrected values when corrections are present
    const abRows: (string | number)[][] = [['Fahrer', 'Pers.-Nr.', 'Lohnart', 'Bezeichnung', 'Ziel (Std.)', cl ? 'Korrigierter Istwert (Std.)' : 'Plan-Ist (Std.)', 'Differenz (Std.)', 'Status']];
    for (const d of pr.deviations) {
      const corrLine = cl?.find(l => l.driverId === d.driverId && l.wageCode === d.wageCode);
      const compareActual = corrLine ? corrLine.correctedActualSec : d.actualSec;
      const diff = compareActual - d.targetSec;
      abRows.push([d.driverName, d.personalnummer, d.wageCode, d.wageLabel, secToH(d.targetSec), secToH(compareActual), secToH(diff), diff === 0 ? 'OK' : 'Abweichung']);
    }

    // Sheet 7: Zuweisungen
    const zuRows: (string | number)[][] = [['Block-ID', 'Datum', 'Start (Min)', 'Ende (Min)', 'Kennzeichen', 'Zugewiesener Fahrer', 'Rolle', 'Stundenlohn (Std.)', 'Nacht (Std.)', 'Sonntag (Std.)', 'Feiertag (Std.)', 'Aktive Fahrzeuge', 'Einzelwagen-Zeit', 'Entlastungsgrund', 'Original Block-ID', 'Granularität', 'Historisch gesplittet']];
    for (const a of pr.assignments) {
      zuRows.push([
        a.id, a.date, a.startMin, a.endMin, a.vehicleKennzeichen ?? '—',
        a.assignedDriverName, a.role === 'payroll' ? 'Steuerberater-Fahrer' : 'Inhaber-Entlastung',
        secToH(a.workSec), secToH(a.nightSec), secToH(a.sunSec), secToH(a.holSec),
        a.activeVehicleCount ?? '—', a.isEinzelwagenZeit ? 'Ja' : 'Nein',
        a.entlastungsGrund ?? '—',
        a.originalBlockId ?? '—', a.granularity, a.isSplit ? 'Ja' : 'Nein',
      ]);
    }

    // Sheet 8: Inhaber-Entlastung
    const afRows: (string | number)[][] = [['Block-ID', 'Datum', 'Kennzeichen', 'Original Fahrer', 'Inhaber', 'Stundenlohn (Std.)', 'Nacht (Std.)', 'Sonntag (Std.)', 'Feiertag (Std.)', 'Einzelwagen-Zeit', 'Entlastungsgrund', 'Original Block-ID', 'Granularität']];
    for (const a of pr.assignments.filter(x => x.role === 'owner')) {
      afRows.push([
        a.id, a.date, a.vehicleKennzeichen ?? '—', a.originalDriverName, a.assignedDriverName,
        secToH(a.workSec), secToH(a.nightSec), secToH(a.sunSec), secToH(a.holSec),
        a.isEinzelwagenZeit ? 'Ja' : 'Nein',
        a.entlastungsGrund ?? 'Inhaber-Entlastung',
        a.originalBlockId ?? '—', a.granularity,
      ]);
    }
    if (afRows.length === 1) {
      afRows.push(['—', '—', '—', '—', 'Kein Inhaber / keine Entlastungsblöcke', '', '', '', '', '', '', '', '']);
    }

    // Sheet 8b: Über-Zielwert-Prüfung (only when over-target drivers exist)
    const overTargetRows: (string | number)[][] = [['Fahrer', 'Pers.-Nr.', 'Lohnart', 'Ziel (Std.)', 'Plan-Ist (Std.)', 'Differenz (Std.)', 'Status']];
    for (const d of pr.deviations.filter(x => x.diffSec > 0)) {
      overTargetRows.push([d.driverName, d.personalnummer, d.wageCode, secToH(d.targetSec), secToH(d.actualSec), secToH(d.diffSec), 'Über Zielwert, nicht korrigierbar']);
    }
    if (overTargetRows.length === 1) {
      overTargetRows.push(['—', '—', '—', '—', '—', '—', 'Kein Fahrer über Zielwert']);
    }

    // Sheet 9: Konflikte — summary + detail rows
    const koRows: (string | number)[][] = [
      ['Zusammenfassung', ''],
      ['Quelldatenfehler (fehlender Fahrer / Null-Dauer)', pr.unassignedCount - pr.ownerOriginalCount],
      ['Ursprünglicher Fahrer unklar (Inhaber-Ausschluss)', pr.ownerOriginalCount],
      ['Harte Konflikte (Überschneidungen / Puffer)', hardConflictsTotal],
      ['Zielabweichungen vor Korrektur', deviationCount],
      ['Fahrer über Zielwert (nicht korrigierbar)', pr.driversOverTarget.length],
      ['', ''],
      ['Art', 'Datum', 'Block-ID', 'Kennzeichen', 'Original Fahrer', 'Granularität', 'Grund / Beschreibung'],
    ];
    for (const d of pr.deviations.filter(x => x.diffSec !== 0)) {
      const isOverTarget = d.diffSec > 0;
      koRows.push([
        isOverTarget ? 'Über Zielwert, nicht korrigierbar' : 'Zielabweichung (unter Zielwert)',
        '—', '—', '—', d.driverName, 'Lohnart',
        `${d.wageCode}: Ziel ${secToH(d.targetSec).toFixed(4)} Std. – Plan-Ist ${secToH(d.actualSec).toFixed(4)} Std. = ${secToH(d.diffSec).toFixed(4)} Std.`,
      ]);
    }
    for (const c of pr.conflicts.filter(x => x.type !== 'unassigned')) {
      const typeLabel =
        c.type === 'vehicle_overlap' ? 'Fahrzeug-Überschneidung' :
        c.type === 'driver_overlap'  ? 'Fahrer-Überschneidung'   :
        c.type === 'vehicle_switch'  ? 'Fahrzeugwechsel-Verstoß' : c.type;
      koRows.push([typeLabel, c.date ?? '—', c.blockId ?? '—', c.kennzeichen ?? '—', c.originalDriverName ?? '—', '—', c.reason ?? c.description]);
    }
    // Data errors (unassigned with Quelldatenfehler reason — not "Über Zielwert")
    for (const c of pr.conflicts.filter(x => x.type === 'unassigned' && x.reason !== 'Über Zielwert, nicht korrigierbar')) {
      const isOwnerConflict = c.reason === 'Ursprünglicher Fahrer unklar, Inhaber darf im Ausgangsmonat nicht Originalfahrer sein';
      koRows.push([
        isOwnerConflict ? 'Ursprünglicher Fahrer unklar' : 'Quelldatenfehler',
        c.date ?? '—', c.blockId ?? '—', c.kennzeichen ?? '—', c.originalDriverName ?? '—', 'Schichtblock', c.reason ?? c.description,
      ]);
    }
    // Rejected transfer candidates (over-target blocks that could not be moved to owner)
    if (pr.rejectedCandidates.length > 0) {
      koRows.push(['', '']);
      koRows.push(['Nicht entlastbare Über-Zielwert-Einheiten', '', '', '', '', '', '']);
      koRows.push(['Fahrer', 'Lohnart', 'Überschuss (Sek.)', 'Block-ID', 'Datum', 'Kennzeichen', 'Beitrag zur Lohnart (Sek.)', 'Als Schichtblock versucht', 'Als Einzelfahrt versucht', 'Ablehnungsgrund']);
      for (const rc of pr.rejectedCandidates) {
        koRows.push([
          rc.driverName, `${rc.overTargetWageCode} ${rc.overTargetWageLabel}`,
          rc.overageSec, rc.blockId, rc.date,
          rc.kennzeichen ?? '—', rc.contributionSec,
          rc.triedAsSchichtblock ? 'Ja' : 'Nein',
          rc.triedAsEinzelfahrt ? 'Ja' : 'Nein',
          rc.rejectionReason,
        ]);
      }
    }

    // Sheet 10b: Nicht entlastbare Über-Zielwert-Einheiten (dedicated sheet)
    const rejectedRows: (string | number)[][] = [
      ['Fahrer', 'Lohnart', 'Überschuss (Sek.)', 'Block-ID', 'Datum', 'Start', 'Ende', 'Kennzeichen', 'Beitrag (Sek.)', 'Als Schichtblock versucht', 'Als Einzelfahrt versucht', 'Tausch versucht', 'Tausch akzeptiert', 'Tausch-Grund', 'Konfliktierende Inhaber-Einheiten', 'Ablehnungsgrund', 'Inhaber-Konfliktgrund'],
    ];
    for (const rc of pr.rejectedCandidates) {
      rejectedRows.push([
        rc.driverName, `${rc.overTargetWageCode} ${rc.overTargetWageLabel}`,
        rc.overageSec, rc.blockId, rc.date,
        `${String(Math.floor(rc.startMin / 60)).padStart(2, '0')}:${String(rc.startMin % 60).padStart(2, '0')}`,
        `${String(Math.floor(rc.endMin / 60)).padStart(2, '0')}:${String(rc.endMin % 60).padStart(2, '0')}`,
        rc.kennzeichen ?? '—', rc.contributionSec,
        rc.triedAsSchichtblock ? 'Ja' : 'Nein',
        rc.triedAsEinzelfahrt ? 'Ja' : 'Nein',
        rc.swapAttempted ? 'Ja' : 'Nein',
        rc.swapAccepted ? 'Ja' : 'Nein',
        rc.swapReason || '—',
        rc.conflictingOwnerUnits?.join(', ') || '—',
        rc.rejectionReason, rc.ownerConflictReason,
      ]);
    }
    if (rejectedRows.length === 1) {
      rejectedRows.push(['—', 'Alle Über-Zielwert-Blöcke wurden erfolgreich entlastet oder kein Fahrer überschritt den Zielwert.', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '']);
    }

    // Sheet 10c: Inhaber-Kapazität
    const kapRows: (string | number)[][] = [
      ['Block-ID', 'Datum', 'Start', 'Ende', 'Kennzeichen', 'Entlastungsgrund', 'Priorität', 'Konfliktierende Kandidaten-ID', 'Tausch versucht', 'Tausch akzeptiert', 'Tausch-Grund'],
    ];
    for (const kap of (pr.ownerCapacityEntries ?? [])) {
      const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
      kapRows.push([
        kap.blockId, kap.date,
        fmt(kap.startMin), fmt(kap.endMin),
        kap.kennzeichen ?? '—',
        kap.entlastungsGrund,
        kap.priority,
        kap.conflictingOverTargetCandidateId ?? '—',
        kap.swapAttempted ? 'Ja' : 'Nein',
        kap.swapAccepted ? 'Ja' : 'Nein',
        kap.swapReason || '—',
      ]);
    }
    if (kapRows.length === 1) {
      kapRows.push(['—', 'Keine Inhaber-Kapazitätseinträge vorhanden.', '', '', '', '', '', '', '', '', '']);
    }

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(ergebnisRows), 'Ergebnis');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(zielRows), 'Zielwerte');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(planIstRows), 'Plan-Istwerte');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(korRows), 'Korrekturen');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(korIstRows), 'Korrigierte Istwerte');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(abRows), 'Abgleich');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(zuRows), 'Zuweisungen');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(afRows), 'Inhaber-Entlastung');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(overTargetRows), 'Über-Zielwert-Prüfung');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rejectedRows), 'Nicht entlastbar');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(kapRows), 'Inhaber-Kapazität');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(koRows), 'Konflikte');
    XLSX.writeFile(wb, `Historische_Zielwert_Planung_${year}-${monthStr}.xlsx`);
  };

  // ── Derived abgleich stats ───────────────────────────────────────────────────
  const abgleichStats = useMemo(() => {
    if (!abgleichRows) return null;
    const deviations = abgleichRows.filter(r => r.diffSec !== 0).length;
    const passed = deviations === 0;
    const driverDeviations = new Map<string, number>();
    for (const r of abgleichRows) {
      if (r.diffSec !== 0) {
        driverDeviations.set(r.driverId, (driverDeviations.get(r.driverId) ?? 0) + 1);
      }
    }
    return { deviations, passed, driverDeviations };
  }, [abgleichRows]);

  // ── Stats ─────────────────────────────────────────────────────────────────────
  const totalEmployees = employees.length;
  const totalRegular = employees.filter(d => d.driver_usage_type === 'regular').length;
  const selectedCount = [...allSelectedDriverIds].filter(id => employees.some(d => d.id === id)).length;
  const inFahrtenbuch = [...matchedDriverIds].filter(id => employees.some(d => d.id === id)).length;

  const loading = driversLoading || fahrtenbuchLoading || targetsLoading;

  const IS: React.CSSProperties = {
    background: 'var(--bg-input, var(--bg-subtle))',
    border: '1px solid var(--border)',
    borderRadius: '0.375rem',
    color: 'var(--text-primary)',
    fontSize: '0.8125rem',
    padding: '0.3rem 0.5rem',
    outline: 'none',
    width: '100%',
    textAlign: 'right',
  };

  // Group abgleich rows by driver for display
  const abgleichByDriver = useMemo(() => {
    if (!abgleichRows) return [];
    const driverMap = new Map<string, AbgleichRow[]>();
    for (const r of abgleichRows) {
      if (!driverMap.has(r.driverId)) driverMap.set(r.driverId, []);
      driverMap.get(r.driverId)!.push(r);
    }
    return [...driverMap.entries()];
  }, [abgleichRows]);

  return (
    <div className="space-y-6">
      {/* Back button */}
      <button
        onClick={onBack}
        className="inline-flex items-center gap-2 text-sm font-medium transition-colors hover:opacity-80"
        style={{ color: 'var(--text-secondary)' }}
      >
        <ArrowLeft size={15} />
        Zurück zur Auswahl
      </button>

      {/* ── Step 1: Target values ── */}
      <div className="space-y-4">

        {/* Month / Year selector */}
        <div className="rounded-xl p-5" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
          <h2 className="text-base font-semibold flex items-center gap-2 mb-4" style={{ color: 'var(--text-primary)' }}>
            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full text-xs font-bold text-white" style={{ background: '#7c3aed' }}>1</span>
            Steuerberater-Zielwerte
          </h2>

          <div className="flex items-end gap-3 flex-wrap">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-tertiary)' }}>
                Monat
              </label>
              <select
                value={month}
                onChange={e => setMonth(Number(e.target.value))}
                className="px-3 py-2 rounded-lg text-sm"
                style={{ background: 'var(--bg-input, var(--bg-subtle))', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
              >
                {MONTHS_DE.map((m, i) => (
                  <option key={i} value={i + 1}>{m}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-tertiary)' }}>
                Jahr
              </label>
              <select
                value={year}
                onChange={e => setYear(Number(e.target.value))}
                className="px-3 py-2 rounded-lg text-sm"
                style={{ background: 'var(--bg-input, var(--bg-subtle))', color: 'var(--text-primary)', border: '1px solid var(--border)' }}
              >
                {yearOptions.map(y => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
            </div>
            <button
              onClick={() => { void loadFahrtenbuchDrivers(); void loadTargets(); }}
              disabled={loading}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all hover:opacity-80 disabled:opacity-50"
              style={{ background: 'var(--bg-muted, var(--bg-subtle))', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
              Zielwerte laden
            </button>
          </div>
        </div>

        {/* ── Driver selection ── */}
        <div className="rounded-xl p-5" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
          <div className="flex items-start justify-between gap-4 mb-4">
            <div>
              <h3 className="text-sm font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                <Users size={15} />
                Fahrer-Auswahl für Steuerberater-Zielwerte
              </h3>
              <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
                Standard: reguläre Fahrer mit Fahrten im gewählten Monat. Inhaber / Selbstständige sind ausgeschlossen.
                {driverSelectionTouched && (
                  <span className="ml-1 font-medium" style={{ color: '#b45309' }}>Manuelle Auswahl aktiv.</span>
                )}
              </p>
            </div>
          </div>

          {/* Quick-select buttons */}
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <ChipBtn onClick={selectAll} disabled={employees.length === 0}>Alle auswählen</ChipBtn>
            <ChipBtn onClick={selectNone}>Alle abwählen</ChipBtn>
            <ChipBtn
              onClick={selectFahrtenbuchOnly}
              icon={<Filter size={12} />}
              disabled={inFahrtenbuch === 0}
            >
              Nur Fahrer mit Fahrten im Fahrtenbuch ({inFahrtenbuch})
            </ChipBtn>
            <ChipBtn onClick={selectRegularOnly} icon={<Filter size={12} />} disabled={employees.length === 0}>
              Nur reguläre Fahrer
            </ChipBtn>
            {driverSelectionTouched && (
              <ChipBtn onClick={selectDefault} icon={<RefreshCw size={12} />}>
                Standardauswahl wiederherstellen
              </ChipBtn>
            )}
          </div>

          {/* Counters */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
            <Stat label="Fahrer gesamt" value={totalEmployees} />
            <Stat label="Im Fahrtenbuch" value={inFahrtenbuch} />
            <Stat label="Reguläre Fahrer" value={totalRegular} />
            <Stat label="Ausgewählt" value={selectedCount} tone="primary" />
          </div>

          {/* Driver list */}
          {driversLoading ? (
            <div className="text-sm py-4" style={{ color: 'var(--text-tertiary)' }}>Lade Fahrer…</div>
          ) : allDrivers.length === 0 ? (
            <div className="text-sm py-4" style={{ color: 'var(--text-tertiary)' }}>Keine aktiven Fahrer gefunden.</div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {allDrivers.map(d => {
                const isOwner = d.employment_type === 'company_owner';
                const inFB = matchedDriverIds.has(d.id);
                const selected = selectedDriverIds.has(d.id);
                return (
                  <button
                    key={d.id}
                    onClick={() => {
                      if (isOwner) return;
                      const next = new Set(selectedDriverIds);
                      if (next.has(d.id)) next.delete(d.id); else next.add(d.id);
                      setSelectedDriverIds(next);
                      setDriverSelectionTouched(true);
                    }}
                    disabled={isOwner}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
                    style={{
                      background: isOwner
                        ? 'var(--bg-subtle, rgba(0,0,0,0.04))'
                        : selected
                          ? 'rgba(124,58,237,0.12)'
                          : 'var(--bg-muted, rgba(0,0,0,0.06))',
                      color: isOwner
                        ? 'var(--text-tertiary)'
                        : selected
                          ? '#6d28d9'
                          : 'var(--text-secondary)',
                      border: `1px solid ${isOwner ? 'transparent' : selected ? 'rgba(124,58,237,0.3)' : 'var(--border)'}`,
                      cursor: isOwner ? 'not-allowed' : 'pointer',
                      opacity: isOwner ? 0.5 : 1,
                    }}
                    title={isOwner ? 'Inhaber / Selbstständig – kein Steuerberater-Lohn' : undefined}
                  >
                    {selected && !isOwner && <UserCheck size={11} />}
                    {d.name}
                    {inFB && !isOwner && (
                      <span className="ml-0.5 text-[10px]" style={{ color: selected ? '#7c3aed' : 'var(--text-tertiary)' }}>
                        ✓FB
                      </span>
                    )}
                    {isOwner && (
                      <span className="ml-0.5 text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
                        Inhaber
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* ── Historische Zusatzfahrer ── */}
        <div className="rounded-xl p-5" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
          <div className="flex items-start justify-between gap-4 mb-3">
            <div>
              <h3 className="text-sm font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                <Users size={15} />
                Historische Zusatzfahrer
                {zusatzfahrerIds.size > 0 && (
                  <span className="text-xs font-normal px-2 py-0.5 rounded-full" style={{ background: '#fef3c7', color: '#92400e', border: '1px solid #fcd34d' }}>
                    {zusatzfahrerIds.size} ausgewählt
                  </span>
                )}
              </h3>
              <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
                Zusätzliche Fahrer für die historische Rekonstruktion. Diese Fahrer waren im Original-Fahrtenbuch nicht enthalten, können aber manuell für den historischen Abgleich verwendet werden.
              </p>
            </div>
          </div>

          {fahrtenbuchLoading ? (
            <div className="text-sm py-3" style={{ color: 'var(--text-tertiary)' }}>Lade Fahrtenbuch…</div>
          ) : zusatzfahrerCandidates.length === 0 ? (
            <div className="text-sm py-3" style={{ color: 'var(--text-tertiary)' }}>
              Alle regulären Fahrer sind im Fahrtenbuch für diesen Monat enthalten — keine Zusatzfahrer verfügbar.
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {zusatzfahrerCandidates.map(d => {
                const selected = zusatzfahrerIds.has(d.id);
                return (
                  <button
                    key={d.id}
                    onClick={() => {
                      const next = new Set(zusatzfahrerIds);
                      if (next.has(d.id)) next.delete(d.id); else next.add(d.id);
                      setZusatzfahrerIds(next);
                    }}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
                    style={{
                      background: selected ? 'rgba(217,119,6,0.10)' : 'var(--bg-muted, rgba(0,0,0,0.06))',
                      color: selected ? '#92400e' : 'var(--text-secondary)',
                      border: `1px solid ${selected ? 'rgba(217,119,6,0.35)' : 'var(--border)'}`,
                    }}
                  >
                    {selected && <UserCheck size={11} />}
                    {d.name}
                    <span className="ml-0.5 text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: selected ? 'rgba(217,119,6,0.15)' : 'rgba(0,0,0,0.06)', color: selected ? '#92400e' : 'var(--text-tertiary)' }}>
                      Nicht im Fahrtenbuch
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* ── Target values table ── */}
        <div className="rounded-xl p-5" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
          <h3 className="text-sm font-semibold mb-4 flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <span style={{ color: '#7c3aed' }}>€</span>
            Steuerberater-Zielwerte
            {allSelectedDriverIds.size > 0 && (
              <span className="text-xs font-normal" style={{ color: 'var(--text-tertiary)' }}>
                — {selectedCount} Fahrer{zusatzfahrerIds.size > 0 ? ` + ${zusatzfahrerIds.size} Zusatzfahrer` : ''}
              </span>
            )}
          </h3>

          {validationError && (
            <div className="mb-4 rounded-lg px-4 py-3 text-sm flex items-start gap-2" style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b' }}>
              <Info size={15} className="shrink-0 mt-0.5" />
              {validationError}
            </div>
          )}

          {saveMsg && (
            <div
              className="mb-4 rounded-lg px-4 py-3 text-sm flex items-center gap-2"
              style={{
                background: saveMsg.type === 'success' ? '#f0fdf4' : '#fef2f2',
                border: `1px solid ${saveMsg.type === 'success' ? '#bbf7d0' : '#fecaca'}`,
                color: saveMsg.type === 'success' ? '#166534' : '#991b1b',
              }}
            >
              {saveMsg.text}
            </div>
          )}

          {allSelectedDriverIds.size === 0 ? (
            <div className="py-6 text-center text-sm" style={{ color: 'var(--text-tertiary)' }}>
              Keine Fahrer ausgewählt. Wähle oben Fahrer aus.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr style={{ borderBottom: '2px solid var(--border)' }}>
                    <th className="text-left py-2 pr-3 text-xs font-semibold uppercase tracking-wider whitespace-nowrap" style={{ color: 'var(--text-tertiary)' }}>
                      Fahrer
                    </th>
                    <th className="text-left py-2 pr-3 text-xs font-semibold uppercase tracking-wider whitespace-nowrap" style={{ color: 'var(--text-tertiary)' }}>
                      Pers.-Nr.
                    </th>
                    {WAGE_TYPES.map(wt => (
                      <th key={wt.code} className="text-right py-2 px-2 text-xs font-semibold uppercase tracking-wider whitespace-nowrap min-w-[110px]" style={{ color: 'var(--text-tertiary)' }}>
                        {wt.shortLabel}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    const orderedIds = [
                      ...allDrivers.filter(d => selectedDriverIds.has(d.id)).map(d => d.id),
                      ...allDrivers.filter(d => zusatzfahrerIds.has(d.id)).map(d => d.id),
                    ];
                    return orderedIds.map((dId, ri) => {
                      const driver = allDrivers.find(d => d.id === dId);
                      if (!driver) return null;
                      const isZusatz = zusatzfahrerIds.has(dId);
                      return (
                        <tr
                          key={dId}
                          style={{
                            borderBottom: '1px solid var(--border)',
                            background: isZusatz
                              ? ri % 2 === 0 ? 'rgba(217,119,6,0.04)' : 'rgba(217,119,6,0.07)'
                              : ri % 2 === 0 ? 'transparent' : 'var(--bg-subtle, rgba(0,0,0,0.02))',
                          }}
                        >
                          <td className="py-1.5 pr-3 font-medium whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>
                            {driver.name}
                            {isZusatz && (
                              <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full font-normal" style={{ background: '#fef3c7', color: '#92400e', border: '1px solid #fcd34d' }}>
                                Zusatzfahrer
                              </span>
                            )}
                          </td>
                          <td className="py-1.5 pr-3 whitespace-nowrap" style={{ color: 'var(--text-tertiary)' }}>
                            {driver.personalnummer || '—'}
                          </td>
                          {WAGE_TYPES.map(wt => (
                            <td key={wt.code} className="py-1.5 px-2">
                              <input
                                type="text"
                                value={getVal(driver.id, wt.code)}
                                onChange={e => handleCellChange(driver.id, wt.code, e.target.value)}
                                placeholder="0,00"
                                style={IS}
                                inputMode="decimal"
                              />
                            </td>
                          ))}
                        </tr>
                      );
                    });
                  })()}
                </tbody>
              </table>
            </div>
          )}

          {allSelectedDriverIds.size > 0 && (
            <div className="mt-4 rounded-lg p-3 flex flex-wrap gap-4 text-xs" style={{ background: 'var(--bg-subtle, rgba(0,0,0,0.03))', border: '1px solid var(--border)' }}>
              <span style={{ color: 'var(--text-secondary)' }}>
                <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>{summary.driversWithValues}</span> Fahrer mit Zielwerten
              </span>
              {WAGE_TYPES.map(wt => (
                <span key={wt.code} style={{ color: 'var(--text-secondary)' }}>
                  <span style={{ color: 'var(--text-tertiary)' }}>{wt.shortLabel}:</span>{' '}
                  <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>
                    {fmtDecimal(summary.totals[wt.code])} Std.
                  </span>
                </span>
              ))}
            </div>
          )}

          <div className="mt-5 flex items-center gap-3 flex-wrap">
            <button
              onClick={handleSave}
              disabled={saving || allSelectedDriverIds.size === 0}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold transition-all hover:brightness-110 active:scale-[0.98] disabled:opacity-50"
              style={{ background: '#7c3aed', color: '#fff' }}
            >
              <Save size={15} />
              {saving ? 'Speichern…' : 'Zielwerte speichern'}
            </button>
            <button
              onClick={handleExportXlsx}
              disabled={allSelectedDriverIds.size === 0}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all hover:opacity-80 disabled:opacity-40"
              style={{ background: 'var(--bg-muted, var(--bg-subtle))', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
            >
              <Download size={14} />
              Zielwerte exportieren
            </button>
            <button
              onClick={handleClearAll}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all hover:opacity-80"
              style={{ color: 'var(--text-tertiary)' }}
            >
              <Trash2 size={14} />
              Alle Werte leeren
            </button>
          </div>
        </div>
      </div>

      {/* ── Step 2: Optionaler Vorab-Check (debug only) ── */}
      {SHOW_DEBUG_TOOLS && (
      <div className="rounded-xl p-5" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
        <h2 className="text-base font-semibold flex items-center gap-2 mb-1" style={{ color: 'var(--text-primary)' }}>
          <span className="inline-flex items-center justify-center w-5 h-5 rounded-full text-xs font-bold text-white" style={{ background: '#94a3b8' }}>2</span>
          Original-Istwerte prüfen
          <span className="text-xs font-normal px-2 py-0.5 rounded-full ml-1" style={{ background: '#f1f5f9', color: '#64748b', border: '1px solid #e2e8f0' }}>
            Optional
          </span>
        </h2>
        <p className="text-xs mb-4" style={{ color: 'var(--text-tertiary)' }}>
          Berechnet die Istwerte aus dem ursprünglichen Fahrtenbuch vor der historischen Rekonstruktion. Dieser Schritt dient nur zur Diagnose und ist für die Finalisierung nicht erforderlich.
        </p>

        {/* Trigger button */}
        <button
          onClick={handleCalculateIstwerte}
          disabled={calculating || selectedCount === 0}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold transition-all hover:brightness-110 active:scale-[0.98] disabled:opacity-50 mb-4"
          style={{ background: '#0ea5e9', color: '#fff' }}
        >
          <Calculator size={15} className={calculating ? 'animate-pulse' : ''} />
          {calculating ? 'Berechne…' : 'Istwerte berechnen'}
        </button>

        {/* Error state */}
        {calcError && (
          <div className="rounded-lg px-4 py-3 text-sm flex items-start gap-2 mb-4" style={{ background: '#fef3c7', border: '1px solid #fcd34d', color: '#92400e' }}>
            <Info size={15} className="shrink-0 mt-0.5" />
            {calcError}
          </div>
        )}

        {/* Results */}
        {abgleichRows && abgleichStats && (
          <div className="space-y-4">
            {/* Overall summary banner */}
            <div
              className="rounded-xl px-4 py-3 flex items-center justify-between gap-4 flex-wrap"
              style={{
                background: abgleichStats.passed ? '#f0fdf4' : '#fef2f2',
                border: `1px solid ${abgleichStats.passed ? '#bbf7d0' : '#fecaca'}`,
              }}
            >
              <div className="flex items-center gap-2">
                {abgleichStats.passed
                  ? <CheckCircle size={18} style={{ color: '#166534' }} />
                  : <AlertTriangle size={18} style={{ color: '#991b1b' }} />
                }
                <span className="font-semibold text-sm" style={{ color: abgleichStats.passed ? '#166534' : '#991b1b' }}>
                  {abgleichStats.passed ? 'Abgleich bestanden' : 'Abgleich fehlgeschlagen'}
                </span>
              </div>
              {!abgleichStats.passed && (
                <span className="text-xs font-medium px-2.5 py-1 rounded-full" style={{ background: '#fee2e2', color: '#991b1b' }}>
                  Abweichungen: {abgleichStats.deviations}
                </span>
              )}
            </div>

            {/* Per-driver grouped table */}
            {abgleichByDriver.map(([driverId, rows]) => {
              const devCount = abgleichStats.driverDeviations.get(driverId) ?? 0;
              return (
                <div key={driverId} className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--border)' }}>
                  {/* Driver header */}
                  <div
                    className="flex items-center justify-between px-4 py-2.5"
                    style={{ background: 'var(--bg-subtle, rgba(0,0,0,0.03)', borderBottom: '1px solid var(--border)' }}
                  >
                    <div className="flex items-center gap-2">
                      <BarChart2 size={14} style={{ color: 'var(--text-tertiary)' }} />
                      <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{rows[0].driverName}</span>
                      {rows[0].personalnummer && (
                        <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>#{rows[0].personalnummer}</span>
                      )}
                    </div>
                    {devCount === 0
                      ? (
                        <span className="inline-flex items-center gap-1 text-xs font-medium px-2.5 py-0.5 rounded-full" style={{ background: '#f0fdf4', color: '#166534', border: '1px solid #bbf7d0' }}>
                          <CheckCircle size={10} /> OK
                        </span>
                      )
                      : (
                        <span className="inline-flex items-center gap-1 text-xs font-medium px-2.5 py-0.5 rounded-full" style={{ background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca' }}>
                          <AlertTriangle size={10} /> Abweichungen: {devCount}
                        </span>
                      )
                    }
                  </div>

                  {/* Lohnart rows */}
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm border-collapse">
                      <thead>
                        <tr style={{ borderBottom: '1px solid var(--border)' }}>
                          <th className="text-left py-2 px-4 text-xs font-semibold uppercase tracking-wider whitespace-nowrap" style={{ color: 'var(--text-tertiary)' }}>Lohnart</th>
                          <th className="text-left py-2 px-3 text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>Bezeichnung</th>
                          <th className="text-right py-2 px-3 text-xs font-semibold uppercase tracking-wider whitespace-nowrap" style={{ color: 'var(--text-tertiary)' }}>Ziel (Std.)</th>
                          <th className="text-right py-2 px-3 text-xs font-semibold uppercase tracking-wider whitespace-nowrap" style={{ color: 'var(--text-tertiary)' }}>Ist (Std.)</th>
                          <th className="text-right py-2 px-3 text-xs font-semibold uppercase tracking-wider whitespace-nowrap" style={{ color: 'var(--text-tertiary)' }}>Differenz</th>
                          <th className="text-center py-2 px-3 text-xs font-semibold uppercase tracking-wider whitespace-nowrap" style={{ color: 'var(--text-tertiary)' }}>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r, ri) => {
                          const isDeviation = r.diffSec !== 0;
                          return (
                            <tr
                              key={r.wageCode}
                              style={{
                                borderBottom: ri < rows.length - 1 ? '1px solid var(--border)' : 'none',
                                background: isDeviation
                                  ? 'rgba(254,242,242,0.5)'
                                  : ri % 2 === 0 ? 'transparent' : 'var(--bg-subtle, rgba(0,0,0,0.02))',
                              }}
                            >
                              <td className="py-2 px-4 font-mono text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>{r.wageCode}</td>
                              <td className="py-2 px-3 text-xs" style={{ color: 'var(--text-secondary)' }}>{r.wageLabel}</td>
                              <td className="py-2 px-3 text-right font-medium tabular-nums text-xs" style={{ color: 'var(--text-primary)' }}>
                                {secToDecimalStr(r.targetSec)}
                              </td>
                              <td className="py-2 px-3 text-right font-medium tabular-nums text-xs" style={{ color: 'var(--text-primary)' }}>
                                {secToDecimalStr(r.actualSec)}
                              </td>
                              <td
                                className="py-2 px-3 text-right font-semibold tabular-nums text-xs"
                                style={{ color: isDeviation ? '#991b1b' : '#166534' }}
                              >
                                {diffSecToStr(r.diffSec)}
                              </td>
                              <td className="py-2 px-3 text-center">
                                {isDeviation
                                  ? (
                                    <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full" style={{ background: '#fee2e2', color: '#991b1b' }}>
                                      <AlertTriangle size={9} /> Abweichung
                                    </span>
                                  )
                                  : (
                                    <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full" style={{ background: '#dcfce7', color: '#166534' }}>
                                      <CheckCircle size={9} /> OK
                                    </span>
                                  )
                                }
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })}

            {/* Export button */}
            <div className="flex items-center gap-3 pt-2">
              <button
                onClick={handleExportAbgleich}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all hover:opacity-80"
                style={{ background: 'var(--bg-muted, var(--bg-subtle))', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
              >
                <Download size={14} />
                Abgleich exportieren
              </button>
              <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                XLSX mit Tabellen: Zielwerte · Istwerte · Abgleich
              </span>
            </div>
          </div>
        )}
      </div>
      )}{/* end SHOW_DEBUG_TOOLS Step 2 */}

      {/* ── Step 2 (main): Historische Rekonstruktion ── */}
      <div className="rounded-xl p-5" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
        <h2 className="text-base font-semibold flex items-center gap-2 mb-2" style={{ color: 'var(--text-primary)' }}>
          <span className="inline-flex items-center justify-center w-5 h-5 rounded-full text-xs font-bold text-white" style={{ background: '#16a34a' }}>3</span>
          Historische Rekonstruktion
        </h2>
        <p className="text-xs mb-4" style={{ color: 'var(--text-tertiary)' }}>
          Jede Fahrt wird einzeln rekonstruiert. Der Inhaber übernimmt so viele reale Fahrten wie möglich. Fehlende Zielstunden werden als positive historische Korrektur ergänzt.
        </p>

        {/* Correction checkbox */}
        <label className="flex items-start gap-3 mb-4 cursor-pointer select-none group">
          <div className="flex-shrink-0 mt-0.5">
            <input
              type="checkbox"
              checked={allowCorrections}
              onChange={e => {
                setAllowCorrections(e.target.checked);
                // Clear stale correction result when toggling
                setCorrectionLines(null);
              }}
              className="w-4 h-4 rounded"
              style={{ accentColor: '#16a34a' }}
            />
          </div>
          <div>
            <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
              Historische Korrekturzeilen zulassen
            </span>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
              Wenn die Zielwerte nicht exakt aus realen Fahrten erreicht werden können, werden transparente Korrekturzeilen im Prüf-Export ergänzt. Das Fahrtenbuch bleibt unverändert.
            </p>
          </div>
        </label>

        {/* Owner exclusion checkbox — only relevant in correction mode */}
        {allowCorrections && (
          <label className="flex items-start gap-3 mb-4 cursor-pointer select-none group ml-6">
            <div className="flex-shrink-0 mt-0.5">
              <input
                type="checkbox"
                checked={ownerExcluded}
                onChange={e => setOwnerExcluded(e.target.checked)}
                className="w-4 h-4 rounded"
                style={{ accentColor: '#0ea5e9' }}
              />
            </div>
            <div>
              <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                Inhaber war im Ausgangsmonat nicht als Fahrer tätig
              </span>
              <p className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                Wenn aktiviert, wird der Inhaber nicht als ursprünglicher Fahrer übernommen. Blöcke, bei denen der einzige bekannte Fahrer der Inhaber ist, werden als Quelldatenfehler markiert und blockieren die Finalisierung.
              </p>
            </div>
          </label>
        )}

        {/* Warn when correction mode is ON but no owner/Auffangfahrer driver exists */}
        {allowCorrections && !allDrivers.some(d => d.employment_type === 'company_owner') && (
          <div className="rounded-lg px-4 py-3 text-xs flex items-start gap-2 mb-4" style={{ background: '#fef3c7', border: '1px solid #fcd34d', color: '#92400e' }}>
            <AlertTriangle size={13} className="shrink-0 mt-0.5" />
            <span>
              <strong>Kein Inhaber / Auffangfahrer gefunden.</strong> Bitte markieren Sie einen Fahrer unter <em>Fahrer</em> → Bearbeiten → Fahrerrolle: <em>Inhaber / Selbstständig</em>. Ohne Auffangfahrer können überzählige Schichtblöcke nicht absorbiert werden.
            </span>
          </div>
        )}

        {/* Strategy: reconstruction is always the primary path */}
        {allowCorrections && (
          <div className="rounded-lg p-4 mb-4" style={{ background: 'var(--bg-subtle, #f8fafc)', border: '1px solid var(--border)' }}>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
                Strategie
              </span>
              <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: '#dcfce7', color: '#166534' }}>
                Max-Inhaber-Einzelfahrt-Rekonstruktion
              </span>
            </div>
            <p className="text-xs mb-3" style={{ color: 'var(--text-tertiary)' }}>
              Jede abgeschlossene Fahrt wird einzeln rekonstruiert. Fehlende Zielstunden werden als positive historische Korrektur ergänzt. Das Fahrtenbuch bleibt unverändert.
            </p>

            {/* Buffer mode */}
            <div className="pt-2" style={{ borderTop: '1px solid var(--border)' }}>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
                  Historischer Fahrzeugwechsel-Puffer
                </span>
                <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: '#e0f2fe', color: '#0369a1' }}>
                  Für historische Monate empfohlen: 0 Minuten
                </span>
              </div>
              <div className="flex flex-wrap gap-3">
                {([
                  { val: 'none' as HistoricalBufferMode, label: '0 Minuten für Rekonstruktion', desc: 'Empfohlen. Kein Puffer angewendet.' },
                  { val: 'warning' as HistoricalBufferMode, label: 'Nur Warnung', desc: 'Zuweisung erlaubt, Hinweis im Export.' },
                  { val: 'strict' as HistoricalBufferMode, label: 'Streng anwenden', desc: 'Puffer-Verletzungen blockieren Zuweisung.' },
                ] as const).map(opt => (
                  <label key={opt.val} className="flex items-center gap-2 cursor-pointer select-none">
                    <input
                      type="radio"
                      name="bufferMode"
                      value={opt.val}
                      checked={bufferMode === opt.val}
                      onChange={() => setBufferMode(opt.val)}
                      style={{ accentColor: '#0ea5e9' }}
                    />
                    <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                      <strong>{opt.label}</strong> — {opt.desc}
                    </span>
                  </label>
                ))}
              </div>
            </div>

            {/* Advanced / debug section — only visible with SHOW_DEBUG_TOOLS */}
            {SHOW_DEBUG_TOOLS && (
            <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--border)' }}>
              <button
                type="button"
                onClick={() => {
                  setShowAdvancedSolver(v => !v);
                  if (strategyMode === 'legacy') { setStrategyMode('reconstruction'); setReconstructionResult(null); setPlanningResult(null); }
                }}
                className="flex items-center gap-1.5 text-xs transition-all"
                style={{ color: '#64748b', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
              >
                <span style={{ fontSize: '10px' }}>{showAdvancedSolver ? '▼' : '▶'}</span>
                Erweiterte Diagnose
              </button>
              {showAdvancedSolver && (
                <div className="mt-2 rounded-lg p-3" style={{ background: '#fef9c3', border: '1px solid #fde68a' }}>
                  <p className="text-xs mb-2 font-medium" style={{ color: '#92400e' }}>
                    Nur zur technischen Diagnose. Für historische Finaldokumente wird die Einzelfahrt-Rekonstruktion empfohlen.
                  </p>
                  <label className="flex items-start gap-3 cursor-pointer select-none">
                    <input
                      type="radio"
                      name="strategyMode"
                      value="legacy"
                      checked={strategyMode === 'legacy'}
                      onChange={() => { setStrategyMode('legacy'); setReconstructionResult(null); setPlanningResult(null); }}
                      className="mt-0.5"
                      style={{ accentColor: '#64748b' }}
                    />
                    <div>
                      <span className="text-xs font-medium" style={{ color: '#92400e' }}>
                        Schichtblock-Solver (Diagnose/Legacy)
                      </span>
                      <p className="text-xs mt-0.5" style={{ color: '#b45309' }}>
                        Gruppenbasierter Block-Solver mit Tausch-Mechanismus. Für Diagnose und Vergleich mit der Einzelfahrt-Rekonstruktion.
                      </p>
                    </div>
                  </label>
                  {strategyMode === 'legacy' && (
                    <div className="mt-2 text-xs px-2 py-1 rounded" style={{ background: '#fde68a', color: '#92400e' }}>
                      Schichtblock-Solver aktiv — Finaldokumente können nur mit Einzelfahrt-Rekonstruktion erstellt werden.
                    </div>
                  )}
                </div>
              )}
              {/* Hidden radio for reconstruction to keep it selected by default */}
              <input
                type="radio"
                name="strategyMode"
                value="reconstruction"
                checked={strategyMode === 'reconstruction'}
                onChange={() => { setStrategyMode('reconstruction'); setReconstructionResult(null); setPlanningResult(null); }}
                style={{ display: 'none' }}
                readOnly
              />
            </div>
            )}{/* end SHOW_DEBUG_TOOLS advanced solver */}
          </div>
        )}

        <div className="flex items-center gap-3 mb-4 flex-wrap">
          <button
            onClick={handleCalculatePlanung}
            disabled={planning || selectedCount === 0}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold transition-all hover:brightness-110 active:scale-[0.98] disabled:opacity-50"
            style={{ background: '#16a34a', color: '#fff' }}
          >
            <Target size={15} className={planning ? 'animate-pulse' : ''} />
            {planning ? 'Berechne Rekonstruktion…' : strategyMode === 'reconstruction' ? 'Historische Rekonstruktion starten' : 'Zielwert-Planung berechnen'}
          </button>

          {planning && allowCorrections && (
            <button
              onClick={handleCancelPlanung}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all hover:brightness-110 active:scale-[0.98]"
              style={{ background: '#dc2626', color: '#fff' }}
            >
              Berechnung abbrechen
            </button>
          )}
        </div>

        {planning && allowCorrections && strategyMode === 'legacy' && solverProgress && (
          <div className="rounded-lg px-4 py-3 text-sm mb-4" style={{ background: '#f0f9ff', border: '1px solid #bae6fd', color: '#0c4a6e' }}>
            <div className="font-semibold mb-1">Berechnung läuft — {solverProgress.phase}</div>
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs" style={{ color: '#0369a1' }}>
              <span>Kandidaten: {solverProgress.candidatesTried.toLocaleString('de-DE')}</span>
              <span>Tauschversuche: {solverProgress.swapAttempts.toLocaleString('de-DE')}</span>
              <span>Granulare Prüfungen: {solverProgress.granularAttempts.toLocaleString('de-DE')}</span>
              {solverProgress.diagnosticsTruncated > 0 && (
                <span style={{ color: '#b45309' }}>Diagnosen gekürzt: {solverProgress.diagnosticsTruncated.toLocaleString('de-DE')}</span>
              )}
            </div>
          </div>
        )}

        {planning && strategyMode === 'reconstruction' && reconProgress && (
          <div className="rounded-lg px-4 py-3 text-sm mb-4" style={{ background: '#f0f9ff', border: '1px solid #bae6fd', color: '#0c4a6e' }}>
            <div className="font-semibold mb-1">Berechnung läuft — {reconProgress.phase}</div>
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs" style={{ color: '#0369a1' }}>
              <span>Kandidaten: {reconProgress.candidatesTried.toLocaleString('de-DE')}</span>
              <span>An Inhaber: {reconProgress.ownerAssigned.toLocaleString('de-DE')}</span>
              <span>An Fahrer: {reconProgress.payrollAssigned.toLocaleString('de-DE')}</span>
              {reconProgress.unassigned > 0 && (
                <span style={{ color: '#b45309' }}>Nicht zugewiesen: {reconProgress.unassigned.toLocaleString('de-DE')}</span>
              )}
            </div>
          </div>
        )}

        {planningError && (
          <div className="rounded-lg px-4 py-3 text-sm flex items-start gap-2 mb-4" style={{ background: '#fef3c7', border: '1px solid #fcd34d', color: '#92400e' }}>
            <Info size={15} className="shrink-0 mt-0.5" />
            {planningError}
          </div>
        )}

        {/* ── Reconstruction result ── */}
        {reconstructionResult && (
          <div className="space-y-4">
            {/* Status banner */}
            <div
              className="rounded-xl px-4 py-4"
              style={{
                background: reconstructionResult.isFinalizable ? '#f0fdf4' : '#fef2f2',
                border: `2px solid ${reconstructionResult.isFinalizable ? '#86efac' : '#fca5a5'}`,
              }}
            >
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                {reconstructionResult.isFinalizable
                  ? <CheckCircle size={18} style={{ color: '#166534' }} />
                  : <AlertTriangle size={18} style={{ color: '#991b1b' }} />
                }
                <span className="font-bold text-sm" style={{ color: reconstructionResult.isFinalizable ? '#166534' : '#991b1b' }}>
                  {reconstructionResult.isFinalizable ? 'Finalisierbar mit Korrekturzeilen' : 'Nicht finalisierbar'}
                </span>
                <span className="text-xs font-medium px-2 py-0.5 rounded-full" style={{ background: '#e0f2fe', color: '#0369a1' }}>
                  Max-Inhaber-Einzelfahrt-Rekonstruktion
                </span>
              </div>
              {reconstructionResult.finalizationBlockers.length > 0 && (
                <ul className="mt-1 space-y-0.5">
                  {reconstructionResult.finalizationBlockers.slice(0, 5).map((b, i) => (
                    <li key={i} className="text-xs" style={{ color: '#991b1b' }}>• {b}</li>
                  ))}
                </ul>
              )}
              {reconstructionResult.solverCancelled && (
                <p className="text-xs mt-1" style={{ color: '#9a3412' }}>
                  <strong>Berechnung abgebrochen.</strong> Ergebnis möglicherweise nicht vollständig.
                </p>
              )}
              {!reconstructionResult.solverCancelled && reconstructionResult.solverLimitReached && (
                <p className="text-xs mt-1" style={{ color: '#92400e' }}>
                  <strong>Berechnungslimit erreicht.</strong> Ergebnis möglicherweise nicht vollständig optimiert.
                </p>
              )}
            </div>

            {/* Stats grid */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {[
                { label: 'Fahrten gesamt', value: reconstructionResult.totalFahrten, color: undefined },
                { label: 'An Inhaber', value: reconstructionResult.ownerFahrten, color: '#0ea5e9' },
                { label: 'An Zusatzfahrer', value: reconstructionResult.zusatzfahrerFahrten, color: reconstructionResult.zusatzfahrerFahrten > 0 ? '#d97706' : undefined },
                { label: 'An Steuerberater-Fahrer', value: reconstructionResult.payrollFahrten, color: '#16a34a' },
                { label: 'Nicht zugewiesen', value: reconstructionResult.unassignedCount, color: reconstructionResult.unassignedCount > 0 ? '#991b1b' : '#166534' },
                { label: 'Fahrer über Zielwert', value: reconstructionResult.driversOverTarget.length, color: reconstructionResult.driversOverTarget.length > 0 ? '#991b1b' : '#166534' },
                { label: 'Positive Korrekturzeilen', value: reconstructionResult.corrections.length, color: undefined },
                { label: 'Neg. Korrekturen erforderlich', value: reconstructionResult.negativeCorrectionsRequired, color: reconstructionResult.negativeCorrectionsRequired > 0 ? '#991b1b' : '#166534' },
                { label: 'Inhaber-Originalkonflikte', value: reconstructionResult.ownerOriginalCount, color: reconstructionResult.ownerOriginalCount > 0 ? '#991b1b' : '#166534' },
                { label: 'Puffer-Warnungen', value: reconstructionResult.bufferWarnings, color: reconstructionResult.bufferWarnings > 0 ? '#b45309' : undefined },
                { label: 'Kandidaten geprüft', value: reconstructionResult.candidatesTried, color: undefined },
                { label: 'Berechnungszeit (ms)', value: Math.round(reconstructionResult.solverElapsedMs), color: undefined },
              ].map(stat => (
                <div key={stat.label} className="rounded-lg px-3 py-2.5" style={{ background: 'var(--bg-subtle, #f8fafc)', border: '1px solid var(--border)' }}>
                  <div className="text-xs mb-0.5" style={{ color: 'var(--text-tertiary)' }}>{stat.label}</div>
                  <div className="text-lg font-bold" style={{ color: stat.color ?? 'var(--text-primary)' }}>
                    {stat.value.toLocaleString('de-DE')}
                  </div>
                </div>
              ))}
            </div>

            {/* Corrections table */}
            {reconstructionResult.corrections.length > 0 && (
              <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--border)' }}>
                <div className="px-4 py-2.5 text-xs font-semibold uppercase tracking-wider" style={{ background: 'var(--bg-subtle)', color: 'var(--text-tertiary)' }}>
                  Positive Korrekturzeilen ({reconstructionResult.corrections.length})
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr style={{ background: 'var(--bg-subtle)' }}>
                        {['Fahrer', 'Lohnart', 'Plan-Ist (Std.)', 'Ziel (Std.)', 'Korrektur (Std.)', 'Grund'].map(h => (
                          <th key={h} className="px-3 py-2 text-left font-semibold" style={{ color: 'var(--text-secondary)' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {reconstructionResult.corrections.map((c, i) => (
                        <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                          <td className="px-3 py-2" style={{ color: 'var(--text-primary)' }}>{c.driverName}</td>
                          <td className="px-3 py-2" style={{ color: 'var(--text-secondary)' }}>{c.wageCode} {c.wageLabel}</td>
                          <td className="px-3 py-2 text-right" style={{ color: 'var(--text-secondary)' }}>{(c.planActualSec / 3600).toFixed(4)}</td>
                          <td className="px-3 py-2 text-right" style={{ color: 'var(--text-secondary)' }}>{(c.targetSec / 3600).toFixed(4)}</td>
                          <td className="px-3 py-2 text-right font-semibold" style={{ color: '#16a34a' }}>+{(c.correctionSec / 3600).toFixed(4)}</td>
                          <td className="px-3 py-2" style={{ color: 'var(--text-tertiary)' }}>{c.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Over-target drivers */}
            {reconstructionResult.driversOverTarget.length > 0 && (
              <div className="rounded-lg px-4 py-3 text-sm flex items-start gap-2" style={{ background: '#fef2f2', border: '1px solid #fca5a5', color: '#991b1b' }}>
                <AlertTriangle size={15} className="shrink-0 mt-0.5" />
                <div>
                  <strong>Fahrer über Zielwert (nicht korrigierbar):</strong> {reconstructionResult.driversOverTarget.join(', ')}
                </div>
              </div>
            )}

            {/* Step 3: Historische Finalisierung */}
            <div className="rounded-xl p-4 space-y-3" style={{ background: 'var(--bg-subtle, #f8fafc)', border: '1px solid var(--border)' }}>
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center justify-center w-5 h-5 rounded-full text-xs font-bold text-white" style={{ background: reconstructionResult.isFinalizable && strategyMode === 'reconstruction' ? '#0369a1' : '#94a3b8' }}>4</span>
                <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Historische Finalisierung</span>
              </div>
              {/* Prüf-Export */}
              <div className="flex items-center gap-3 flex-wrap">
                <button
                  onClick={handleExportReconstructionPlanung}
                  className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all hover:opacity-80"
                  style={{ background: 'var(--bg-muted, #f1f5f9)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
                >
                  <Download size={14} />
                  Prüf-Export herunterladen
                </button>
                <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                  Historische_Zielwert_Planung_{year}-{String(month).padStart(2, '0')}.xlsx
                </span>
              </div>

              {/* Finalization */}
              {reconstructionResult.isFinalizable && strategyMode === 'reconstruction' ? (
                <div className="space-y-2">
                  <div className="rounded-lg px-4 py-3 text-xs" style={{ background: '#f0fdf4', border: '1px solid #86efac', color: '#166534' }}>
                    <strong>Historischer Abgleich:</strong> Die Fahrten bleiben unverändert dokumentiert. Die Stundennachweise wurden auf Basis der Einzelfahrt-Rekonstruktion und der übermittelten Steuerberater-Werte erstellt.
                  </div>
                  <div className="flex items-center gap-3 flex-wrap">
                    <button
                      onClick={handleGenerateFinalDocuments}
                      className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold transition-all hover:brightness-110 active:scale-[0.98]"
                      style={{ background: '#0369a1', color: '#fff' }}
                    >
                      <Download size={15} />
                      Historische Finaldokumente erstellen
                    </button>
                    {finalizationGenerated && !isFinalizationStale && (
                      <span className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full" style={{ background: '#dcfce7', color: '#166534', border: '1px solid #86efac' }}>
                        <CheckCircle size={11} /> Finaldokumente aktuell
                      </span>
                    )}
                    {finalizationGenerated && isFinalizationStale && (
                      <span className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full" style={{ background: '#fef3c7', color: '#92400e', border: '1px solid #fcd34d' }}>
                        <AlertTriangle size={11} /> Nicht aktuell — Rekonstruktion oder Zielwerte wurden geändert.
                      </span>
                    )}
                  </div>
                  <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                    Erstellt: finales Prüf-XLSX (Historische_Finalisierung_{year}-{String(month).padStart(2, '0')}.xlsx) + Stundennachweis-PDF pro Fahrer
                  </p>
                </div>
              ) : (
                <div className="rounded-lg px-4 py-3 text-xs flex items-start gap-2" style={{ background: '#fef3c7', border: '1px solid #fcd34d', color: '#92400e' }}>
                  <AlertTriangle size={13} className="shrink-0 mt-0.5" />
                  {strategyMode !== 'reconstruction'
                    ? 'Finalisierung nicht möglich — bitte Einzelfahrt-Rekonstruktion verwenden.'
                    : 'Finalisierung nicht möglich — bitte Rekonstruktion prüfen.'
                  }
                </div>
              )}
            </div>{/* end Historische Finalisierung wrapper */}
          </div>
        )}

        {planningResult && (
          <div className="space-y-4">
            {/* Overall result banner */}
            {(() => {
              const hardConflictsFree =
                planningResult.vehicleOverlapCount === 0 &&
                planningResult.driverOverlapCount  === 0 &&
                planningResult.vehicleSwitchCount  === 0;
              const correctedFinalizable =
                hardConflictsFree &&
                correctionLines !== null &&
                planningResult.unassignedCount === 0 &&
                planningResult.driversOverTarget.length === 0 &&
                planningResult.ownerOriginalCount === 0 &&
                correctionLines.every(l => l.correctedActualSec === l.targetSec) &&
                planningResult.deviations.filter(d => d.diffSec !== 0).length === correctionLines.length;
              const statusLabel =
                planningResult.isFinalizable ? 'Finalisierbar'
                : correctedFinalizable ? 'Finalisierbar mit Korrekturzeilen'
                : 'Nicht finalisierbar';
              const isGreen = planningResult.isFinalizable || correctedFinalizable;
              const corrValuesOk =
                correctionLines !== null &&
                correctionLines.every(l => l.correctedActualSec === l.targetSec) &&
                planningResult.deviations.filter(d => d.diffSec !== 0).length === correctionLines.length;
              return (
                <div
                  className="rounded-xl px-4 py-4"
                  style={{
                    background: isGreen ? '#f0fdf4' : '#fef2f2',
                    border: `2px solid ${isGreen ? '#86efac' : '#fca5a5'}`,
                  }}
                >
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    {isGreen
                      ? <CheckCircle size={18} style={{ color: '#166534' }} />
                      : <AlertTriangle size={18} style={{ color: '#991b1b' }} />
                    }
                    <span className="font-bold text-sm" style={{ color: isGreen ? '#166534' : '#991b1b' }}>
                      {statusLabel}
                    </span>
                    {corrValuesOk && !correctedFinalizable && (
                      <span className="text-xs font-medium px-2 py-0.5 rounded-full" style={{ background: '#dcfce7', color: '#166534' }}>
                        Korrigierte Zielwerte: OK
                      </span>
                    )}
                    {correctedFinalizable && (
                      <span className="text-xs font-medium px-2 py-0.5 rounded-full" style={{ background: '#dcfce7', color: '#166534' }}>
                        Historische Korrektur: Zielwerte exakt erreicht
                      </span>
                    )}
                  </div>
                  {!isGreen && allowCorrections && planningResult.ownerOriginalCount > 0 && (
                    <p className="text-xs mt-1" style={{ color: '#991b1b' }}>
                      <strong>Inhaber als Originalfahrer:</strong> {planningResult.ownerOriginalCount} Einheit{planningResult.ownerOriginalCount !== 1 ? 'en' : ''} ohne zuweisbaren Fahrer — Inhaber-Ausschluss ist aktiv. Bitte korrigieren Sie die Quelldaten.
                    </p>
                  )}
                  {!isGreen && allowCorrections && planningResult.unassignedCount > 0 && (
                    <p className="text-xs mt-1" style={{ color: '#991b1b' }}>
                      <strong>Quelldatenfehler:</strong> {planningResult.unassignedCount} Einheit{planningResult.unassignedCount !== 1 ? 'en' : ''} mit ungültigen Quelldaten (fehlender Fahrer oder Null-Dauer).
                    </p>
                  )}
                  {!isGreen && !allowCorrections && planningResult.unassignedCount > 0 && (
                    <p className="text-xs mt-1" style={{ color: '#991b1b' }}>
                      <strong>Vollständigkeit: Fehlgeschlagen</strong> — {planningResult.unassignedCount} Schichtblock{planningResult.unassignedCount !== 1 ? 'e' : ''} nicht zuweisbar.
                    </p>
                  )}
                  {!isGreen && planningResult.unassignedCount === 0 && (
                    <p className="text-xs mt-1" style={{ color: '#991b1b' }}>
                      Diese historische Planung darf nicht finalisiert werden. Bitte prüfen Sie die Abweichungen und Konflikte.
                    </p>
                  )}
                  {correctedFinalizable && (
                    <p className="text-xs mt-1" style={{ color: '#166534' }}>
                      Zielwerte wurden durch transparente Korrekturzeilen exakt ausgeglichen. Das Fahrtenbuch bleibt unverändert.
                    </p>
                  )}
                </div>
              );
            })()}

            {/* Solver limit / cancel banners */}
            {(planningResult as any).solverCancelled && (
              <div className="rounded-lg px-4 py-3 text-sm flex items-start gap-2" style={{ background: '#fff7ed', border: '1px solid #fed7aa', color: '#9a3412' }}>
                <AlertTriangle size={15} className="shrink-0 mt-0.5" />
                <div>
                  <span className="font-semibold">Berechnung abgebrochen.</span> Das Ergebnis ist möglicherweise nicht optimal — nicht alle Kandidaten wurden geprüft. Nur Diagnose-Export empfohlen.
                </div>
              </div>
            )}
            {!(planningResult as any).solverCancelled && (planningResult as any).solverLimitReached && (
              <div className="rounded-lg px-4 py-3 text-sm flex items-start gap-2" style={{ background: '#fffbeb', border: '1px solid #fcd34d', color: '#92400e' }}>
                <AlertTriangle size={15} className="shrink-0 mt-0.5" />
                <div>
                  <span className="font-semibold">Berechnungslimit erreicht.</span> Der Solver hat das Zeitlimit oder Iterations-Budget überschritten. Das Ergebnis ist möglicherweise nicht vollständig optimiert.
                </div>
              </div>
            )}
            {(planningResult as any).diagnosticsTruncated > 0 && (
              <div className="rounded-lg px-3 py-2 text-xs" style={{ background: '#f8fafc', border: '1px solid #e2e8f0', color: '#64748b' }}>
                Diagnosen gekürzt: {(planningResult as any).diagnosticsTruncated.toLocaleString('de-DE')} Einträge wurden wegen Speicherlimit nicht erfasst.
              </div>
            )}

            {/* Stats grid */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {[
                { label: 'Original Schichtblöcke', value: planningResult.totalBlocks, color: undefined },
                ...(allowCorrections ? [
                  { label: 'An Steuerberater-Fahrer', value: planningResult.payrollAssigned, color: '#16a34a' },
                  { label: 'An Inhaber gesamt', value: planningResult.ownerAssigned, color: '#0ea5e9' },
                  { label: '  Kritische Entlastung', value: (planningResult as any).ownerCriticalReliefCount ?? 0, color: '#0284c7' },
                  { label: '  Einzelwagen optional', value: (planningResult as any).ownerOptionalEinzelwagenCount ?? 0, color: '#0ea5e9' },
                  { label: 'Quelldatenfehler', value: planningResult.unassignedCount, color: planningResult.unassignedCount > 0 ? '#991b1b' : '#166534' },
                  { label: 'Inhaber original (Ausschluss)', value: planningResult.ownerOriginalCount, color: planningResult.ownerOriginalCount > 0 ? '#991b1b' : '#166534' },
                  { label: 'Abweichungen', value: planningResult.deviations.filter(d => d.diffSec !== 0).length, color: planningResult.deviations.some(d => d.diffSec !== 0) ? '#991b1b' : '#166534' },
                  { label: 'Fahrzeug-Überschneidungen', value: planningResult.vehicleOverlapCount, color: planningResult.vehicleOverlapCount > 0 ? '#991b1b' : '#166534' },
                  { label: 'Fahrer-Überschneidungen', value: planningResult.driverOverlapCount, color: planningResult.driverOverlapCount > 0 ? '#991b1b' : '#166534' },
                  { label: 'Fahrzeugwechsel-Verstöße', value: planningResult.vehicleSwitchCount, color: planningResult.vehicleSwitchCount > 0 ? '#b45309' : '#166534' },
                  { label: 'Einzelwagen-Zeiten erkannt', value: planningResult.einzelwagenZeitenTotal, color: undefined },
                  { label: 'Über Zielwert → Inhaber (Phase A)', value: planningResult.reliefPassTotal, color: '#0ea5e9' },
                  { label: 'Granulare Transfers (Einzelfahrt)', value: planningResult.reliefGranularTransfers, color: planningResult.reliefGranularTransfers > 0 ? '#0ea5e9' : undefined },
                  { label: 'Tauschversuche', value: planningResult.swapAttemptsTotal ?? 0, color: undefined },
                  { label: 'Tausche akzeptiert', value: planningResult.swapAcceptedTotal ?? 0, color: (planningResult.swapAcceptedTotal ?? 0) > 0 ? '#16a34a' : undefined },
                  { label: 'Nicht entlastbar', value: planningResult.unresolvedOverTargetCount, color: planningResult.unresolvedOverTargetCount > 0 ? '#991b1b' : '#166534' },
                  { label: 'Fahrer über Zielwert', value: planningResult.driversOverTarget.length, color: planningResult.driversOverTarget.length > 0 ? '#991b1b' : '#166534' },
                ] : [
                  { label: 'An Steuerberater-Fahrer', value: planningResult.payrollAssigned, color: '#16a34a' },
                  { label: 'An Inhaber', value: planningResult.ownerAssigned, color: '#0ea5e9' },
                  { label: 'Nicht zuweisbar', value: planningResult.unassignedCount, color: planningResult.unassignedCount > 0 ? '#991b1b' : '#166534' },
                  { label: 'Abweichungen', value: planningResult.deviations.filter(d => d.diffSec !== 0).length, color: planningResult.deviations.some(d => d.diffSec !== 0) ? '#991b1b' : '#166534' },
                  { label: 'Fahrzeug-Überschneidungen', value: planningResult.vehicleOverlapCount, color: planningResult.vehicleOverlapCount > 0 ? '#991b1b' : '#166534' },
                  { label: 'Fahrer-Überschneidungen', value: planningResult.driverOverlapCount, color: planningResult.driverOverlapCount > 0 ? '#991b1b' : '#166534' },
                  { label: 'Fahrzeugwechsel-Verstöße', value: planningResult.vehicleSwitchCount, color: planningResult.vehicleSwitchCount > 0 ? '#b45309' : '#166534' },
                ]),
              ].map(s => (
                <div key={s.label} className="rounded-lg p-3 text-center" style={{ background: 'var(--bg-subtle, rgba(0,0,0,0.03))', border: '1px solid var(--border)' }}>
                  <div className="text-base font-bold" style={{ color: s.color ?? 'var(--text-primary)' }}>{s.value}</div>
                  <div className="text-[11px] mt-0.5 leading-tight" style={{ color: 'var(--text-tertiary)' }}>{s.label}</div>
                </div>
              ))}
            </div>

            {/* Inhaber-Entlastung info panel */}
            {allowCorrections && planningResult.ownerAssigned > 0 && (
              <div className="rounded-xl px-4 py-3 flex items-start gap-2" style={{ background: 'rgba(14,165,233,0.06)', border: '1px solid rgba(14,165,233,0.25)' }}>
                <BarChart2 size={14} className="shrink-0 mt-0.5" style={{ color: '#0284c7' }} />
                <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                  <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>Inhaber-Entlastung</span>
                  <span className="ml-1">— {planningResult.ownerAssigned} Schichtblöcke wurden dem Inhaber zugewiesen.</span>
                  <div className="mt-1 flex flex-wrap gap-3">
                    <span>Einzelwagen-Zeiten erkannt: <strong>{planningResult.einzelwagenZeitenTotal}</strong></span>
                    <span>Phase B (Einzelwagen → Inhaber): <strong>{planningResult.einzelwagenZeitenToOwner}</strong></span>
                    <span>Phase A (Über Zielwert → Inhaber): <strong>{planningResult.reliefPassTotal}</strong></span>
                    {(planningResult.swapAttemptsTotal ?? 0) > 0 && (
                      <span>Tausche: <strong>{planningResult.swapAcceptedTotal ?? 0}/{planningResult.swapAttemptsTotal ?? 0}</strong></span>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Over-target driver warning */}
            {allowCorrections && planningResult.driversOverTarget.length > 0 && (
              <div className="rounded-xl overflow-hidden" style={{ border: '1px solid #fca5a5' }}>
                <div className="px-4 py-2.5 flex items-center gap-2" style={{ background: '#fef2f2', borderBottom: '1px solid #fca5a5' }}>
                  <AlertTriangle size={14} style={{ color: '#991b1b' }} />
                  <span className="text-sm font-semibold" style={{ color: '#991b1b' }}>Über Zielwert — nicht korrigierbar</span>
                  <span className="text-xs ml-1 px-2 py-0.5 rounded-full" style={{ background: '#fee2e2', color: '#991b1b' }}>
                    {planningResult.driversOverTarget.length} Fahrer
                  </span>
                </div>
                <div className="px-4 py-3 text-xs" style={{ color: 'var(--text-secondary)' }}>
                  <p className="mb-2">Folgende Fahrer überschreiten ihren Zielwert und können nicht durch Korrekturen ausgeglichen werden. Die Finalisierung ist gesperrt.</p>
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse">
                      <thead>
                        <tr style={{ borderBottom: '1px solid var(--border)' }}>
                          {['Fahrer', 'Lohnart', 'Ziel (Std.)', 'Plan-Ist (Std.)', 'Differenz (Std.)', 'Status'].map(h => (
                            <th key={h} className="text-left py-1.5 px-3 font-semibold uppercase tracking-wider whitespace-nowrap" style={{ color: 'var(--text-tertiary)' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {planningResult.deviations.filter(d => d.diffSec > 0).map((d, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid var(--border)', background: 'rgba(254,242,242,0.4)' }}>
                            <td className="py-1.5 px-3 font-medium whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>{d.driverName}</td>
                            <td className="py-1.5 px-3 font-mono" style={{ color: 'var(--text-secondary)' }}>{d.wageCode}</td>
                            <td className="py-1.5 px-3 tabular-nums text-right">{secToDecimalStr(d.targetSec)}</td>
                            <td className="py-1.5 px-3 tabular-nums text-right">{secToDecimalStr(d.actualSec)}</td>
                            <td className="py-1.5 px-3 tabular-nums text-right font-semibold" style={{ color: '#991b1b' }}>{diffSecToStr(d.diffSec)}</td>
                            <td className="py-1.5 px-3">
                              <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full" style={{ background: '#fee2e2', color: '#991b1b' }}>
                                <AlertTriangle size={9} /> Über Zielwert
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}

            {/* Deviations table (only when not exact) */}
            {planningResult.deviations.some(d => d.diffSec !== 0) && (
              <div className="rounded-xl overflow-hidden" style={{ border: '1px solid #fecaca' }}>
                <div className="px-4 py-2.5 flex items-center gap-2" style={{ background: '#fef2f2', borderBottom: '1px solid #fecaca' }}>
                  <AlertTriangle size={14} style={{ color: '#991b1b' }} />
                  <span className="text-sm font-semibold" style={{ color: '#991b1b' }}>Verbleibende Zielabweichungen</span>
                  {correctionLines !== null && (
                    <span className="text-xs ml-1 px-2 py-0.5 rounded-full" style={{ background: '#dcfce7', color: '#166534' }}>
                      werden durch Korrekturzeilen ausgeglichen
                    </span>
                  )}
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs border-collapse">
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--border)' }}>
                        {['Fahrer', 'Lohnart', 'Ziel (Std.)', 'Plan-Ist (Std.)', 'Differenz (Std.)', 'Differenz (Sek.)'].map(h => (
                          <th key={h} className="text-left py-2 px-3 font-semibold uppercase tracking-wider whitespace-nowrap" style={{ color: 'var(--text-tertiary)' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {planningResult.deviations.filter(d => d.diffSec !== 0).map((d, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid var(--border)', background: 'rgba(254,242,242,0.4)' }}>
                          <td className="py-2 px-3 font-medium" style={{ color: 'var(--text-primary)' }}>{d.driverName}</td>
                          <td className="py-2 px-3 font-mono" style={{ color: 'var(--text-secondary)' }}>{d.wageCode}</td>
                          <td className="py-2 px-3 tabular-nums text-right">{secToDecimalStr(d.targetSec)}</td>
                          <td className="py-2 px-3 tabular-nums text-right">{secToDecimalStr(d.actualSec)}</td>
                          <td className="py-2 px-3 tabular-nums text-right font-semibold" style={{ color: '#991b1b' }}>{diffSecToStr(d.diffSec)}</td>
                          <td className="py-2 px-3 tabular-nums text-right font-mono text-[11px]" style={{ color: '#991b1b' }}>{d.diffSec > 0 ? '+' : ''}{d.diffSec}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ── Historische Korrekturzeilen ── */}
            {correctionLines !== null && (
              <div className="rounded-xl overflow-hidden" style={{ border: '1px solid #86efac' }}>
                <div className="px-4 py-2.5 flex items-center justify-between gap-4 flex-wrap" style={{ background: '#f0fdf4', borderBottom: '1px solid #86efac' }}>
                  <div className="flex items-center gap-2">
                    <CheckCircle size={14} style={{ color: '#166534' }} />
                    <span className="text-sm font-semibold" style={{ color: '#166534' }}>
                      Historische Korrekturzeilen
                    </span>
                    <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: '#dcfce7', color: '#166534' }}>
                      {correctionLines.length} Zeilen
                    </span>
                  </div>
                  <span className="text-xs" style={{ color: '#166534' }}>
                    Fahrtenbuch unverändert · Nur Prüf-Export
                  </span>
                </div>

                {correctionLines.length === 0 ? (
                  <div className="px-4 py-3 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                    Keine Korrekturen erforderlich — Plan-Istwerte stimmen bereits mit Zielwerten überein.
                  </div>
                ) : (
                  <>
                    {/* Summary chips */}
                    <div className="px-4 py-2 flex flex-wrap gap-3 text-xs" style={{ borderBottom: '1px solid var(--border)', background: 'rgba(240,253,244,0.4)' }}>
                      {['1000','1501','1510','1520'].map(code => {
                        const sum = correctionLines.filter(l => l.wageCode === code).reduce((acc, l) => acc + l.correctionSec, 0);
                        if (sum === 0) return null;
                        return (
                          <span key={code} style={{ color: 'var(--text-secondary)' }}>
                            <span className="font-mono font-semibold" style={{ color: 'var(--text-primary)' }}>{code}</span>:{' '}
                            <span style={{ color: sum >= 0 ? '#166534' : '#991b1b' }}>{diffSecToStr(sum)} Std.</span>
                          </span>
                        );
                      })}
                    </div>

                    <div className="overflow-x-auto">
                      <table className="w-full text-xs border-collapse">
                        <thead>
                          <tr style={{ borderBottom: '1px solid var(--border)' }}>
                            {['Fahrer', 'Lohnart', 'Bezeichnung', 'Plan-Ist', 'Ziel', 'Korrektur', 'Ergebnis', 'Status'].map(h => (
                              <th key={h} className="text-left py-2 px-3 font-semibold uppercase tracking-wider whitespace-nowrap" style={{ color: 'var(--text-tertiary)' }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {correctionLines.map((l, i) => {
                            const exact = l.correctedActualSec === l.targetSec;
                            return (
                              <tr key={i} style={{ borderBottom: '1px solid var(--border)', background: i % 2 === 0 ? 'transparent' : 'rgba(240,253,244,0.3)' }}>
                                <td className="py-2 px-3 font-medium whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>{l.driverName}</td>
                                <td className="py-2 px-3 font-mono" style={{ color: 'var(--text-secondary)' }}>{l.wageCode}</td>
                                <td className="py-2 px-3" style={{ color: 'var(--text-secondary)' }}>{l.wageLabel}</td>
                                <td className="py-2 px-3 tabular-nums text-right">{secToDecimalStr(l.planActualSec)}</td>
                                <td className="py-2 px-3 tabular-nums text-right">{secToDecimalStr(l.targetSec)}</td>
                                <td className="py-2 px-3 tabular-nums text-right font-semibold" style={{ color: l.correctionSec >= 0 ? '#166534' : '#991b1b' }}>
                                  {diffSecToStr(l.correctionSec)}
                                </td>
                                <td className="py-2 px-3 tabular-nums text-right font-semibold" style={{ color: exact ? '#166534' : '#991b1b' }}>
                                  {secToDecimalStr(l.correctedActualSec)}
                                </td>
                                <td className="py-2 px-3">
                                  {exact
                                    ? <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full" style={{ background: '#dcfce7', color: '#166534' }}><CheckCircle size={9} /> OK</span>
                                    : <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full" style={{ background: '#fee2e2', color: '#991b1b' }}><AlertTriangle size={9} /> Abweichung</span>
                                  }
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>

                    <div className="px-4 py-2 text-[11px]" style={{ background: '#f0fdf4', color: '#166534' }}>
                      Historische Korrektur laut übermittelter Steuerberater-Werte · Fahrtenbuch bleibt unverändert
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Hard-constraint conflicts (vehicle overlap, driver overlap, vehicle switch) */}
            {planningResult.conflicts.filter(c => c.type !== 'unassigned').length > 0 && (
              <div className="rounded-xl overflow-hidden" style={{ border: '1px solid #fca5a5' }}>
                <div className="px-4 py-2.5 flex items-center gap-2" style={{ background: '#fef2f2', borderBottom: '1px solid #fca5a5' }}>
                  <AlertTriangle size={14} style={{ color: '#991b1b' }} />
                  <span className="text-sm font-semibold" style={{ color: '#991b1b' }}>Sicherheits-Konflikte</span>
                  <span className="text-xs ml-1" style={{ color: '#991b1b' }}>
                    (Fahrzeug-Überschneidungen: {planningResult.vehicleOverlapCount} · Fahrer-Überschneidungen: {planningResult.driverOverlapCount} · Fahrzeugwechsel-Verstöße: {planningResult.vehicleSwitchCount})
                  </span>
                </div>
                <div className="divide-y" style={{ divideColor: 'var(--border)' }}>
                  {planningResult.conflicts.filter(c => c.type !== 'unassigned').slice(0, 15).map((c, i) => (
                    <div key={i} className="px-4 py-2 text-xs flex items-start gap-2">
                      <AlertTriangle size={12} className="shrink-0 mt-0.5" style={{ color: '#991b1b' }} />
                      <span style={{ color: 'var(--text-secondary)' }}>{c.description}</span>
                    </div>
                  ))}
                  {planningResult.conflicts.filter(c => c.type !== 'unassigned').length > 15 && (
                    <div className="px-4 py-2 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                      … und {planningResult.conflicts.filter(c => c.type !== 'unassigned').length - 15} weitere
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Unassigned / data error blocks */}
            {planningResult.unassignedCount > 0 && (
              <div className="rounded-xl overflow-hidden" style={{ border: '1px solid #fcd34d' }}>
                <div className="px-4 py-2.5 flex items-center gap-2" style={{ background: 'rgba(252,211,77,0.15)', borderBottom: '1px solid #fcd34d' }}>
                  <AlertTriangle size={14} style={{ color: '#92400e' }} />
                  <span className="text-sm font-semibold" style={{ color: '#92400e' }}>
                    {allowCorrections
                      ? `Quelldatenfehler (${planningResult.unassignedCount})`
                      : `Nicht zuweisbare Schichtblöcke (${planningResult.unassignedCount})`}
                  </span>
                </div>
                <div className="divide-y" style={{ divideColor: 'var(--border)' }}>
                  {planningResult.conflicts.filter(c => c.type === 'unassigned' && c.reason !== 'Über Zielwert, nicht korrigierbar').slice(0, 10).map((c, i) => (
                    <div key={i} className="px-4 py-2 text-xs flex items-start gap-2">
                      <Info size={12} className="shrink-0 mt-0.5" style={{ color: '#b45309' }} />
                      <span style={{ color: 'var(--text-secondary)' }}>{c.description}</span>
                    </div>
                  ))}
                  {planningResult.unassignedCount > 10 && (
                    <div className="px-4 py-2 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                      … und {planningResult.unassignedCount - 10} weitere
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Owner info */}
            {!allowCorrections && planningResult.ownerAssigned > 0 && (
              <div className="rounded-lg px-4 py-3 text-xs flex items-start gap-2" style={{ background: 'rgba(14,165,233,0.08)', border: '1px solid rgba(14,165,233,0.3)', color: 'var(--text-secondary)' }}>
                <BarChart2 size={13} className="shrink-0 mt-0.5" style={{ color: '#0ea5e9' }} />
                <span>
                  <strong style={{ color: 'var(--text-primary)' }}>{planningResult.ownerAssigned} Schichtblöcke</strong> wurden dem Inhaber zugewiesen, damit die Steuerberater-Zielwerte der ausgewählten Fahrer eingehalten werden.
                </span>
              </div>
            )}

            {planningResult.ownerAssigned === 0 && !allDrivers.some(d => d.employment_type === 'company_owner') && (
              <div className="rounded-lg px-4 py-3 text-xs flex items-start gap-2" style={{ background: '#fef3c7', border: '1px solid #fcd34d', color: '#92400e' }}>
                <AlertTriangle size={13} className="shrink-0 mt-0.5" />
                <span>
                  <strong>Kein Inhaber / Auffangfahrer gefunden.</strong> Bitte markieren Sie einen Fahrer als <em>Inhaber / Selbstständig</em> unter Fahrer → Bearbeiten → Fahrerrolle. Ohne Auffangfahrer können Schichtblöcke nicht absorbiert werden und verbleiben als &ldquo;Nicht zuweisbar&rdquo;.
                </span>
              </div>
            )}

            {/* Export button */}
            <div className="flex items-center gap-3 pt-2 flex-wrap">
              <button
                onClick={handleExportPlanung}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all hover:opacity-80"
                style={{ background: 'var(--bg-muted, var(--bg-subtle))', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
              >
                <Download size={14} />
                Prüf-Export herunterladen
              </button>
              <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                XLSX: Ergebnis · Zielwerte · Plan-Istwerte
                {correctionLines !== null ? ' · Korrekturen · Korrigierte Istwerte' : ''}
                {' '}· Abgleich · Zuweisungen · Inhaber-Entlastung · Über-Zielwert-Prüfung · Konflikte
              </span>
              {!planningResult.isFinalizable && correctionLines === null && (
                <span className="text-xs font-medium px-2.5 py-1 rounded-full" style={{ background: '#fee2e2', color: '#991b1b' }}>
                  Nur Prüf-Export — nicht für finale Abrechnung verwenden
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Keep exactly one default export in this file.
export default HistoricalSteuerberaterView;