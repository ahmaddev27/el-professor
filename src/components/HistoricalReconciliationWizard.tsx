/**
 * HistoricalReconciliationWizard
 *
 * 5-step wizard for "Alter Monat / Steuerberater-Abgleich":
 *  Step 0 – Monat & Fahrtenbuch-Import auswählen
 *  Step 1 – Fahrer zuweisen + Stundensatz + Steuerberater-Ziel-Brutto
 *            + Inhaber / Ausgleichsfahrer konfigurieren
 *  Step 2 – Berechnung starten (review before running)
 *  Step 3 – Ergebnis prüfen (table + Inhaber-Ausgleich diagnostic)
 *  Step 4 – Dokumente erstellen (PDF export)
 *
 * Persistence:
 *   Step 2 driver configs (hourly rate, target gross, inclusion) are saved to
 *   historical_reconciliation_drivers per reconciliation_id. On re-open the saved
 *   values are loaded; driver profile planning_hourly_rate is used as fallback only
 *   when no saved value exists. The driver profile is NEVER overwritten.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, ArrowRight, Calculator, CheckCircle2, AlertTriangle,
  Download, FileText, RefreshCw, Users, Clock, Info, Save,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import {
  normalizeTripServiceDate,
  groupRidesIntoBlocks,
  mergeBlocksIfNeeded,
  timeToMinutes,
} from '../utils/shiftBlockEngine';
import type { FahrtenbuchTrip } from '../hooks/useFahrtenbuch';
import { exportFahrtenbuch } from '../utils/fahrtenbuchExport';
import {
  exportStundennachweisAsPdf,
  type PdfDayRow,
  type PdfTotals,
  type HistoricalPdfCorrectionEntry,
  type HistoricalGrossReconciliation,
} from '../utils/stundennachweisPdfExport';

// ── Constants ─────────────────────────────────────────────────────────────────

const MONTHS_DE = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

const WEEKDAY_SHORT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

const BATCH_SIZE = 1000;
const AUTOSAVE_DELAY_MS = 800;

// Zuschlag rates applied to hourly rate for gross calculation.
// Nacht 0-4 is treated as an ADDITIONAL surcharge on top of Nachtarbeit for that window.
const HIST_ZUSCHLAG_RATES = {
  nachtarbeit: 0.25,  // 20:00–06:00 window: +25 %
  nacht04:     0.25,  // 00:00–04:00 additional: +25 % on top of Nachtarbeit
  sonntag:     0.50,  // Sunday: +50 %
  feiertag:    1.00,  // Holiday: +100 %
} as const;

// ── Types ─────────────────────────────────────────────────────────────────────

interface FbImport {
  id: string;
  file_name: string;
  row_count: number;
  imported_at: string;
}

interface DriverRow {
  id: string;
  name: string;
  personalnummer: string | null;
  employment_type: string;
  driver_usage_type: string | null;
  status: string | null;
  planning_hourly_rate: number | null;
}

interface DriverConfig {
  driverId: string;
  driverName: string;
  personalnummer: string | null;
  isOwner: boolean;
  /** Euro-cents per hour */
  hourlyCents: number;
  /** Target gross brutto in euro-cents; 0 means "not set" */
  targetGrossCents: number;
  included: boolean;
}

/** Represents one calendar-day's worth of trips for a driver */
interface DayBlock {
  date: string;                  // YYYY-MM-DD
  trips: FahrtenbuchTrip[];
  startMin: number;
  endMin: number;
}

/** Occupied intervals already assigned to a driver, per date */
type OccupiedMap = Map<string, Array<{ startMin: number; endMin: number }>>;

interface DriverResult {
  driverId: string;
  driverName: string;
  personalnummer: string | null;
  isOwner: boolean;
  hourlyCents: number;
  targetGrossCents: number;
  grossFromRidesCents: number;
  grundlohnCents: number;
  zuschlaegeCents: number;
  nachtarbeitCents: number;
  nacht04Cents: number;
  sonntagCents: number;
  feiertagCents: number;
  ausgleichMinutes: number;
  finalGrossCents: number;
  overTarget: boolean;
  missingHourlyRate: boolean;
  noTarget: boolean;
  rows: PdfDayRow[];
  totals: PdfTotals;
  corrections: HistoricalPdfCorrectionEntry[];
  historicalGrossReconciliation: HistoricalGrossReconciliation | null;
}

interface RepairDiagnostic {
  movedGroups: number;
  movedMinutes: number;
  reducedOverTargetCount: number;
  unmovableGroups: number;
  unmovableReasons: string[];
}

type SaveStatus = 'saved' | 'saving' | 'unsaved' | 'idle';

// ── Helpers ───────────────────────────────────────────────────────────────────

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
  const seg1 = Math.max(0, Math.min(absTo, 240) - Math.max(f, 0));
  const seg2 = Math.max(0, Math.min(absTo, 1680) - Math.max(f, 1440));
  return seg1 + seg2;
}

function segDuration(from: string, to: string): number {
  if (!from || !to) return 0;
  const f = timeToMinutes(from), t = timeToMinutes(to);
  return t >= f ? t - f : 1440 - f + t;
}

function minutesToTimeStr(m: number): string {
  const clamped = ((m % 1440) + 1440) % 1440;
  const h = Math.floor(clamped / 60);
  const min = clamped % 60;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function parseCents(s: string): number {
  const normalized = s.replace(',', '.').trim();
  if (!normalized) return 0;
  const n = parseFloat(normalized);
  return isNaN(n) ? 0 : Math.round(n * 100);
}

function centsToDisplay(cents: number): string {
  return (cents / 100).toFixed(2).replace('.', ',');
}

/** Parse a German-style decimal string to euro-cents, or null if empty/invalid. */
function parseGermanDecimal(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const normalized = t.includes(',')
    ? t.replace(/\./g, '').replace(',', '.')
    : t;
  const n = parseFloat(normalized);
  if (isNaN(n) || n < 0) return null;
  return Math.round(n * 100);
}

/** Format cents as German decimal for display on blur. */
function formatCentsForDisplay(cents: number): string {
  return (cents / 100).toFixed(2).replace('.', ',');
}

function normName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

async function fetchAllTrips(companyId: string, importId: string): Promise<FahrtenbuchTrip[]> {
  const all: FahrtenbuchTrip[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from('fahrtenbuch_trips')
      .select('*')
      .eq('company_id', companyId)
      .eq('import_id', importId)
      .eq('is_canceled', false)
      .order('trip_date', { ascending: true })
      .order('start_time', { ascending: true, nullsFirst: false })
      .order('id', { ascending: true })
      .range(offset, offset + BATCH_SIZE - 1);
    if (error) throw error;
    const rows = (data ?? []) as FahrtenbuchTrip[];
    all.push(...rows);
    if (rows.length < BATCH_SIZE) break;
    offset += BATCH_SIZE;
  }
  return all;
}

// Fetches ALL trips for export — including canceled rows — paginated to bypass PostgREST 1000-row default cap.
async function fetchAllTripsForExport(companyId: string, importId: string): Promise<FahrtenbuchTrip[]> {
  const all: FahrtenbuchTrip[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from('fahrtenbuch_trips')
      .select('*')
      .eq('company_id', companyId)
      .eq('import_id', importId)
      .order('source_row_index', { ascending: true, nullsFirst: false })
      .order('trip_date', { ascending: true })
      .order('start_time', { ascending: true, nullsFirst: false })
      .order('id', { ascending: true })
      .range(offset, offset + BATCH_SIZE - 1);
    if (error) throw error;
    const rows = (data ?? []) as FahrtenbuchTrip[];
    all.push(...rows);
    if (rows.length < BATCH_SIZE) break;
    offset += BATCH_SIZE;
  }
  return all;
}

function buildDayBlocks(trips: FahrtenbuchTrip[]): DayBlock[] {
  const byDate = new Map<string, FahrtenbuchTrip[]>();
  for (const t of trips) {
    const segs = normalizeTripServiceDate(t);
    for (const seg of segs) {
      if (!byDate.has(seg.serviceDate)) byDate.set(seg.serviceDate, []);
      byDate.get(seg.serviceDate)!.push(t);
    }
  }

  const blocks: DayBlock[] = [];
  for (const [date, dayTrips] of byDate) {
    const unique = Array.from(new Map(dayTrips.map(t => [t.id, t])).values());
    let minStart = Infinity, maxEnd = -Infinity;
    for (const t of unique) {
      const sm = timeToMinutes(t.start_time);
      const em = timeToMinutes(t.end_time);
      if (sm < minStart) minStart = sm;
      if (em > maxEnd) maxEnd = em;
    }
    blocks.push({ date, trips: unique, startMin: minStart === Infinity ? 0 : minStart, endMin: maxEnd === -Infinity ? 0 : maxEnd });
  }
  blocks.sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin);
  return blocks;
}

function buildOccupied(trips: FahrtenbuchTrip[]): OccupiedMap {
  const map: OccupiedMap = new Map();
  for (const t of trips) {
    const segs = normalizeTripServiceDate(t);
    for (const seg of segs) {
      if (!map.has(seg.serviceDate)) map.set(seg.serviceDate, []);
      map.get(seg.serviceDate)!.push({ startMin: seg.startMinutes, endMin: seg.endMinutes });
    }
  }
  return map;
}

function intervalsOverlap(startA: number, endA: number, startB: number, endB: number): boolean {
  const TOLERANCE = 1;
  const effectiveEndA = endA > 0 && endA <= startA ? endA + 1440 : endA;
  const effectiveEndB = endB > 0 && endB <= startB ? endB + 1440 : endB;
  return startA < effectiveEndB - TOLERANCE && effectiveEndA > startB + TOLERANCE;
}

function canMoveToOwner(block: DayBlock, ownerOccupied: OccupiedMap): boolean {
  const existing = ownerOccupied.get(block.date) ?? [];
  for (const interval of existing) {
    if (intervalsOverlap(block.startMin, block.endMin, interval.startMin, interval.endMin)) {
      return false;
    }
  }
  return true;
}

function computeGrossFromTrips(trips: FahrtenbuchTrip[], driverId: string, hourlyCents: number): number {
  if (hourlyCents <= 0 || trips.length === 0) return 0;
  let totalMins = 0;
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
    const blocks = groupRidesIntoBlocks(segs, driverId, segs[0]?.serviceDate ?? '');
    const { merged } = mergeBlocksIfNeeded(blocks);
    for (const b of merged) {
      const start = minutesToTimeStr(b.startMin);
      const end = minutesToTimeStr(b.endMin);
      totalMins += segDuration(start, end);
    }
  }
  return Math.round((totalMins / 60) * hourlyCents);
}

interface GrossBreakdown {
  grossCents:       number;
  grundlohnCents:   number;
  nachtarbeitCents: number;
  nacht04Cents:     number;
  sonntagCents:     number;
  feiertagCents:    number;
  zuschlaegeCents:  number;
}

function computeGrossBreakdown(totals: PdfTotals, hourlyCents: number): GrossBreakdown {
  const zero: GrossBreakdown = { grossCents: 0, grundlohnCents: 0, nachtarbeitCents: 0, nacht04Cents: 0, sonntagCents: 0, feiertagCents: 0, zuschlaegeCents: 0 };
  if (hourlyCents <= 0) return zero;
  const grundlohnCents   = Math.round((totals.grundlohn   / 60) * hourlyCents);
  const nachtarbeitCents = Math.round((totals.nachtarbeit / 60) * hourlyCents * HIST_ZUSCHLAG_RATES.nachtarbeit);
  const nacht04Cents     = Math.round((totals.nacht04     / 60) * hourlyCents * HIST_ZUSCHLAG_RATES.nacht04);
  const sonntagCents     = Math.round((totals.sonntag     / 60) * hourlyCents * HIST_ZUSCHLAG_RATES.sonntag);
  const feiertagCents    = Math.round((totals.feiertag    / 60) * hourlyCents * HIST_ZUSCHLAG_RATES.feiertag);
  const zuschlaegeCents  = nachtarbeitCents + nacht04Cents + sonntagCents + feiertagCents;
  return { grossCents: grundlohnCents + zuschlaegeCents, grundlohnCents, nachtarbeitCents, nacht04Cents, sonntagCents, feiertagCents, zuschlaegeCents };
}

function buildDriverPdfRows(
  trips: FahrtenbuchTrip[],
  driverId: string,
  month: number,
  year: number,
  holidays: Set<string>,
): { rows: PdfDayRow[]; totals: PdfTotals; grundlohnMinutes: number } {
  const totals: PdfTotals = {
    grundlohn: 0, nachtarbeit: 0, nacht04: 0, sonntag: 0, feiertag: 0, weihnachten: 0,
  };

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

  const daysInMonth = new Date(year, month, 0).getDate();
  const rows: PdfDayRow[] = [];
  let grundlohnMinutes = 0;

  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const dateObj = new Date(year, month - 1, day);
    const dow = dateObj.getDay();
    const isSun = dow === 0;
    const isSat = dow === 6;
    const isHol = holidays.has(dateStr);

    const daySegs = segsByDate.get(dateStr) ?? [];
    const blocks = groupRidesIntoBlocks(daySegs, driverId, dateStr);
    const { merged } = mergeBlocksIfNeeded(blocks);
    const schichten = merged.slice(0, 3).map(b => ({
      von: minutesToTimeStr(b.startMin),
      bis: minutesToTimeStr(b.endMin),
    }));

    const [s1, s2, s3] = schichten;
    let gl = 0, na = 0, na04 = 0, sun = 0, hol = 0;

    for (const s of schichten) {
      const dur = segDuration(s.von, s.bis);
      gl += dur;
      na += nightMinsForSeg(s.von, s.bis);
      na04 += night0to4MinsForSeg(s.von, s.bis);
      if (isSun && !isHol) sun += dur;
      if (isHol) hol += dur;
    }

    const minsToHrs = (m: number) => m === 0 ? '' : (m / 60).toFixed(2).replace('.', ',');

    totals.grundlohn += gl;
    totals.nachtarbeit += na;
    totals.nacht04 += na04;
    totals.sonntag += sun;
    totals.feiertag += hol;
    grundlohnMinutes += gl;

    rows.push({
      date: dateObj,
      weekday: WEEKDAY_SHORT[dow],
      isSat,
      isSun,
      isHol,
      von1: s1?.von ?? '', bis1: s1?.bis ?? '',
      von2: s2?.von ?? '', bis2: s2?.bis ?? '',
      von3: s3?.von ?? '', bis3: s3?.bis ?? '',
      grundlohn:     minsToHrs(gl),
      nachtarbeit:   minsToHrs(na),
      nachtarbeit04: minsToHrs(na04),
      sonntag:       minsToHrs(sun),
      feiertag:      minsToHrs(hol),
      weihnachten:   '',
    });
  }

  return { rows, totals, grundlohnMinutes };
}

// ── Step indicator ────────────────────────────────────────────────────────────

function StepDots({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center gap-2">
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          className="h-2 rounded-full transition-all"
          style={{
            width: i === current ? 24 : 8,
            background: i === current
              ? 'var(--accent, #06b6d4)'
              : i < current ? 'rgba(6,182,212,0.4)' : 'var(--border)',
          }}
        />
      ))}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  onBack: () => void;
}

export default function HistoricalReconciliationWizard({ onBack }: Props) {
  const { companyId } = useAuth();
  const now = new Date();
  const yearOptions = useMemo(() => {
    const y = now.getFullYear();
    return Array.from({ length: 8 }, (_, i) => y - 6 + i);
  }, []);

  const [step, setStep] = useState(0);
  const [month, setMonth] = useState(now.getMonth() === 0 ? 12 : now.getMonth());
  const [year, setYear] = useState(now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear());

  // Reconciliation DB record id (set after upsert when advancing from Step 0)
  const [reconciliationId, setReconciliationId] = useState<string | null>(null);

  // Autosave status
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Step 0 state
  const [imports, setImports] = useState<FbImport[]>([]);
  const [loadingImports, setLoadingImports] = useState(false);
  const [selectedImportId, setSelectedImportId] = useState('');

  // Driver state — includes planning_hourly_rate for prefill
  const [allDrivers, setAllDrivers] = useState<DriverRow[]>([]);
  const [loadingDrivers, setLoadingDrivers] = useState(false);
  const [fbDriverIds, setFbDriverIds] = useState<Set<string>>(new Set());
  const [fbDriverNames, setFbDriverNames] = useState<string[]>([]);
  const [driverConfigs, setDriverConfigs] = useState<DriverConfig[]>([]);

  // Draft input strings for Step 1 numeric fields (keyed by driverId)
  const [hourlyDrafts, setHourlyDrafts] = useState<Record<string, string>>({});
  const [targetDrafts, setTargetDrafts] = useState<Record<string, string>>({});
  const [inhaberTargetDraft, setInhaberTargetDraft] = useState<string | null>(null);

  // Inhaber config
  const [useInhaber, setUseInhaber] = useState(true);
  const [inhaberId, setInhaberId] = useState<string>('');
  const [inhaberGeneratePdf, setInhaberGeneratePdf] = useState(true);

  // Compute state
  const [computing, setComputing] = useState(false);
  const [computeError, setComputeError] = useState<string | null>(null);
  const [results, setResults] = useState<DriverResult[] | null>(null);
  const [repairDiag, setRepairDiag] = useState<RepairDiagnostic | null>(null);

  // Export state
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportingFahrtenbuch, setExportingFahrtenbuch] = useState(false);
  const [exportingAllPdfs, setExportingAllPdfs] = useState(false);
  const [exportingAll, setExportingAll] = useState(false);

  // Expanded driver row in Step 3 table
  const [expandedDriverId, setExpandedDriverId] = useState<string | null>(null);

  // Trip assignment snapshot from last computation (tripId → final driver name)
  const [tripAssignments, setTripAssignments] = useState<Map<string, string> | null>(null);

  // Fahrtenbuch export validation diagnostics
  const [fbValidation, setFbValidation] = useState<{
    originalCount: number;
    exportCount: number;
    changedCount: number;
    unchangedCount: number;
    unassignedCount: number;
    canceledCount: number;
    reihenfolgeOk: boolean;
    ok: boolean;
  } | null>(null);

  // ── Derived ────────────────────────────────────────────────────────────────

  const ownerDrivers = useMemo(() => allDrivers.filter(d => d.employment_type === 'company_owner'), [allDrivers]);
  const regularDrivers = useMemo(() => allDrivers.filter(d => d.employment_type !== 'company_owner'), [allDrivers]);

  // Auto-select Inhaber when drivers load
  useEffect(() => {
    if (ownerDrivers.length === 1 && !inhaberId) {
      setInhaberId(ownerDrivers[0].id);
    }
  }, [ownerDrivers, inhaberId]);

  // ── Step 0: load imports ───────────────────────────────────────────────────

  useEffect(() => {
    if (!companyId) return;
    setLoadingImports(true);
    setSelectedImportId('');
    // When month/year changes, reset reconciliation context
    setReconciliationId(null);
    setDriverConfigs([]);
    setSaveStatus('idle');
    supabase
      .from('fahrtenbuch_imports')
      .select('id, file_name, row_count, imported_at')
      .eq('company_id', companyId)
      .eq('month', month)
      .eq('year', year)
      .order('imported_at', { ascending: false })
      .then(({ data }) => {
        const rows = (data ?? []) as FbImport[];
        setImports(rows);
        if (rows.length > 0) setSelectedImportId(rows[0].id);
        setLoadingImports(false);
      });
  }, [companyId, month, year]);

  // ── Load all company drivers (includes planning_hourly_rate for prefill) ───

  useEffect(() => {
    if (!companyId) return;
    setLoadingDrivers(true);
    supabase
      .from('drivers')
      .select('id, name, personalnummer, employment_type, driver_usage_type, status, planning_hourly_rate')
      .eq('company_id', companyId)
      .order('name')
      .then(({ data }) => {
        setAllDrivers(((data ?? []) as DriverRow[]).filter(d => d.status !== 'inactive'));
        setLoadingDrivers(false);
      });
  }, [companyId]);

  // ── Load Fahrtenbuch driver matches ────────────────────────────────────────

  useEffect(() => {
    if (!companyId || !selectedImportId) {
      setFbDriverIds(new Set());
      setFbDriverNames([]);
      return;
    }
    supabase
      .from('fahrtenbuch_trips')
      .select('original_driver_id, original_driver_name')
      .eq('company_id', companyId)
      .eq('import_id', selectedImportId)
      .eq('is_canceled', false)
      .then(({ data }) => {
        const ids = new Set<string>();
        const names: string[] = [];
        for (const t of data ?? []) {
          if (t.original_driver_id) ids.add(t.original_driver_id);
          if (t.original_driver_name && !names.includes(t.original_driver_name)) {
            names.push(t.original_driver_name);
          }
        }
        setFbDriverIds(ids);
        setFbDriverNames(names);
      });
  }, [companyId, selectedImportId]);

  // ── Build default driver configs (profile hourly rate as fallback) ─────────

  const buildDefaultConfigs = useCallback((): DriverConfig[] => {
    const nameSet = new Set(fbDriverNames.map(normName).filter(Boolean));
    const matched = new Set<string>();
    for (const d of allDrivers) {
      if (fbDriverIds.has(d.id)) { matched.add(d.id); continue; }
      if (nameSet.has(normName(d.name))) matched.add(d.id);
    }

    return regularDrivers.map(d => ({
      driverId: d.id,
      driverName: d.name,
      personalnummer: d.personalnummer ?? null,
      isOwner: false,
      // Prefill from driver profile (planning_hourly_rate is in euros, convert to cents)
      hourlyCents: d.planning_hourly_rate != null && d.planning_hourly_rate > 0
        ? Math.round(d.planning_hourly_rate * 100)
        : 0,
      targetGrossCents: 0,
      included: matched.has(d.id) && d.driver_usage_type === 'regular',
    }));
  }, [allDrivers, regularDrivers, fbDriverIds, fbDriverNames]);

  // ── Upsert reconciliation record and load saved Step 2 configs ─────────────

  const initOrLoadReconciliation = useCallback(async () => {
    if (!companyId || !selectedImportId) return;

    // 1. Upsert the reconciliation record for this company/month/year
    const { data: reconData, error: reconError } = await supabase
      .from('historical_reconciliations')
      .upsert(
        {
          company_id: companyId,
          month,
          year,
          import_id: selectedImportId,
          use_inhaber: useInhaber,
          inhaber_driver_id: inhaberId || null,
          inhaber_generate_pdf: inhaberGeneratePdf,
        },
        { onConflict: 'company_id,month,year', ignoreDuplicates: false }
      )
      .select('id, use_inhaber, inhaber_driver_id, inhaber_generate_pdf')
      .single();

    if (reconError || !reconData) {
      // Try to fetch the existing record if upsert failed
      const { data: existing } = await supabase
        .from('historical_reconciliations')
        .select('id, use_inhaber, inhaber_driver_id, inhaber_generate_pdf')
        .eq('company_id', companyId)
        .eq('month', month)
        .eq('year', year)
        .maybeSingle();
      if (existing) {
        setReconciliationId(existing.id);
        if (existing.inhaber_driver_id) setInhaberId(existing.inhaber_driver_id);
        if (typeof existing.use_inhaber === 'boolean') setUseInhaber(existing.use_inhaber);
        if (typeof existing.inhaber_generate_pdf === 'boolean') setInhaberGeneratePdf(existing.inhaber_generate_pdf);
        await loadDriverConfigs(existing.id);
      }
      return;
    }

    setReconciliationId(reconData.id);
    // Restore Inhaber settings from DB (only if they were previously saved)
    if (reconData.inhaber_driver_id) setInhaberId(reconData.inhaber_driver_id);
    if (typeof reconData.use_inhaber === 'boolean') setUseInhaber(reconData.use_inhaber);
    if (typeof reconData.inhaber_generate_pdf === 'boolean') setInhaberGeneratePdf(reconData.inhaber_generate_pdf);

    await loadDriverConfigs(reconData.id);
  }, [companyId, selectedImportId, month, year, useInhaber, inhaberId, inhaberGeneratePdf]);

  const loadDriverConfigs = useCallback(async (reconId: string) => {
    // Load saved driver configs for this reconciliation
    const { data: savedRows } = await supabase
      .from('historical_reconciliation_drivers')
      .select('driver_id, hourly_rate_cents, target_gross_cents, include_in_reconciliation, is_owner_driver')
      .eq('reconciliation_id', reconId);

    const savedMap = new Map<string, {
      hourly_rate_cents: number;
      target_gross_cents: number;
      include_in_reconciliation: boolean;
      is_owner_driver: boolean;
    }>();
    for (const row of savedRows ?? []) {
      savedMap.set(row.driver_id, row);
    }

    // Build default configs (with profile hourly rate as fallback)
    const defaults = buildDefaultConfigs();

    // Merge: saved values win over defaults
    const merged = defaults.map(cfg => {
      const saved = savedMap.get(cfg.driverId);
      if (!saved) return cfg;
      return {
        ...cfg,
        hourlyCents: saved.hourly_rate_cents > 0 ? saved.hourly_rate_cents : cfg.hourlyCents,
        targetGrossCents: saved.target_gross_cents,
        included: saved.include_in_reconciliation,
      };
    });

    // Also restore Inhaber config entry if saved
    for (const [driverId, saved] of savedMap.entries()) {
      if (saved.is_owner_driver && !merged.find(c => c.driverId === driverId)) {
        const d = allDrivers.find(d => d.id === driverId);
        if (d) {
          merged.push({
            driverId: d.id,
            driverName: d.name,
            personalnummer: d.personalnummer ?? null,
            isOwner: true,
            hourlyCents: saved.hourly_rate_cents,
            targetGrossCents: saved.target_gross_cents,
            included: false,
          });
        }
      }
    }

    setDriverConfigs(merged);
    setSaveStatus('saved');
  }, [buildDefaultConfigs, allDrivers]);

  // ── Autosave driverConfigs to DB ───────────────────────────────────────────

  const saveDriverConfigs = useCallback(async (reconId: string, configs: DriverConfig[]) => {
    setSaveStatus('saving');
    try {
      const rows = configs.map(cfg => ({
        reconciliation_id: reconId,
        driver_id: cfg.driverId,
        driver_name: cfg.driverName,
        personalnummer: cfg.personalnummer ?? null,
        hourly_rate_cents: cfg.hourlyCents,
        target_gross_cents: cfg.targetGrossCents,
        include_in_reconciliation: cfg.included,
        is_owner_driver: cfg.isOwner,
        updated_at: new Date().toISOString(),
      }));

      const { error } = await supabase
        .from('historical_reconciliation_drivers')
        .upsert(rows, { onConflict: 'reconciliation_id,driver_id' });

      setSaveStatus(error ? 'unsaved' : 'saved');
    } catch {
      setSaveStatus('unsaved');
    }
  }, []);

  const saveInhaberConfig = useCallback(async (reconId: string) => {
    await supabase
      .from('historical_reconciliations')
      .update({
        use_inhaber: useInhaber,
        inhaber_driver_id: inhaberId || null,
        inhaber_generate_pdf: inhaberGeneratePdf,
      })
      .eq('id', reconId);
  }, [useInhaber, inhaberId, inhaberGeneratePdf]);

  // Debounced autosave whenever driverConfigs changes while on Step 1
  useEffect(() => {
    if (!reconciliationId || step !== 1 || driverConfigs.length === 0) return;
    setSaveStatus('unsaved');
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(() => {
      saveDriverConfigs(reconciliationId, driverConfigs);
    }, AUTOSAVE_DELAY_MS);
    return () => {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    };
  }, [driverConfigs, reconciliationId, step]);

  // Autosave Inhaber config when it changes
  useEffect(() => {
    if (!reconciliationId || step !== 1) return;
    const t = setTimeout(() => saveInhaberConfig(reconciliationId), AUTOSAVE_DELAY_MS);
    return () => clearTimeout(t);
  }, [useInhaber, inhaberId, inhaberGeneratePdf, reconciliationId, step]);

  // ── Step 0 → Step 1: upsert reconciliation and load saved data ─────────────

  const handleAdvanceToStep1 = useCallback(async () => {
    await initOrLoadReconciliation();
    setStep(1);
  }, [initOrLoadReconciliation]);

  // ── Step 3: Inhaber-Ausgleichs-Reparatur + compute ─────────────────────────

  const handleCompute = useCallback(async () => {
    if (!companyId || !selectedImportId) return;
    setComputing(true);
    setComputeError(null);
    setResults(null);
    setRepairDiag(null);

    // Flush pending autosave before computing
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    if (reconciliationId) await saveDriverConfigs(reconciliationId, driverConfigs);

    try {
      const included = driverConfigs.filter(c => c.included);
      if (included.length === 0) throw new Error('Keine Fahrer ausgewählt.');

      const allTrips = await fetchAllTrips(companyId, selectedImportId);
      const holidays = getHolidaysForYear(year);

      const driverTrips = new Map<string, FahrtenbuchTrip[]>();

      for (const cfg of included) driverTrips.set(cfg.driverId, []);
      const ownerCfg: DriverConfig | null = useInhaber && inhaberId
        ? {
            driverId: inhaberId,
            driverName: allDrivers.find(d => d.id === inhaberId)?.name ?? 'Inhaber',
            personalnummer: allDrivers.find(d => d.id === inhaberId)?.personalnummer ?? null,
            isOwner: true,
            hourlyCents: 0,
            targetGrossCents: driverConfigs.find(c => c.driverId === inhaberId)?.targetGrossCents ?? 0,
            included: true,
          }
        : null;
      if (ownerCfg) driverTrips.set(ownerCfg.driverId, []);

      for (const trip of allTrips) {
        let assigned = false;
        for (const cfg of included) {
          if (trip.original_driver_id === cfg.driverId) {
            driverTrips.get(cfg.driverId)!.push(trip);
            assigned = true;
            break;
          }
        }
        if (!assigned) {
          const tripNameNorm = normName(trip.original_driver_name ?? '');
          for (const cfg of included) {
            if (tripNameNorm && normName(cfg.driverName) === tripNameNorm) {
              driverTrips.get(cfg.driverId)!.push(trip);
              assigned = true;
              break;
            }
          }
        }
        if (!assigned && ownerCfg) {
          if (
            trip.original_driver_id === ownerCfg.driverId ||
            normName(trip.original_driver_name ?? '') === normName(ownerCfg.driverName)
          ) {
            driverTrips.get(ownerCfg.driverId)!.push(trip);
          }
        }
      }

      const diag: RepairDiagnostic = {
        movedGroups: 0, movedMinutes: 0, reducedOverTargetCount: 0,
        unmovableGroups: 0, unmovableReasons: [],
      };

      if (ownerCfg) {
        const ownerOccupied = buildOccupied(driverTrips.get(ownerCfg.driverId) ?? []);

        for (const cfg of included) {
          if (cfg.targetGrossCents <= 0 || cfg.hourlyCents <= 0) continue;

          let currentGross = (() => {
            const { totals: t } = buildDriverPdfRows(driverTrips.get(cfg.driverId) ?? [], cfg.driverId, month, year, holidays);
            return computeGrossBreakdown(t, cfg.hourlyCents).grossCents;
          })();

          if (currentGross <= cfg.targetGrossCents) continue;

          const dayBlocks = buildDayBlocks(driverTrips.get(cfg.driverId) ?? []);
          dayBlocks.sort((a, b) => b.trips.length - a.trips.length);

          let wasOverBefore = true;

          for (const block of dayBlocks) {
            if (currentGross <= cfg.targetGrossCents) break;

            if (!canMoveToOwner(block, ownerOccupied)) {
              diag.unmovableGroups++;
              diag.unmovableReasons.push(
                `${cfg.driverName} @ ${block.date}: Überlappung mit Inhaber-Schicht`,
              );
              continue;
            }

            const tripIds = new Set(block.trips.map(t => t.id));
            const remaining = (driverTrips.get(cfg.driverId) ?? []).filter(t => !tripIds.has(t.id));
            driverTrips.set(cfg.driverId, remaining);

            const ownerTrips = driverTrips.get(ownerCfg.driverId) ?? [];
            for (const t of block.trips) {
              if (!ownerTrips.find(ot => ot.id === t.id)) ownerTrips.push(t);
            }
            driverTrips.set(ownerCfg.driverId, ownerTrips);

            for (const t of block.trips) {
              const segs = normalizeTripServiceDate(t);
              for (const seg of segs) {
                if (!ownerOccupied.has(seg.serviceDate)) ownerOccupied.set(seg.serviceDate, []);
                ownerOccupied.get(seg.serviceDate)!.push({ startMin: seg.startMinutes, endMin: seg.endMinutes });
              }
            }

            const blockMins = block.trips.reduce((acc, t) => {
              const segs = normalizeTripServiceDate(t);
              return acc + segs.reduce((s, seg) => s + (seg.endMinutes - seg.startMinutes), 0);
            }, 0);
            diag.movedGroups++;
            diag.movedMinutes += blockMins;

            currentGross = (() => {
              const { totals: t } = buildDriverPdfRows(driverTrips.get(cfg.driverId) ?? [], cfg.driverId, month, year, holidays);
              return computeGrossBreakdown(t, cfg.hourlyCents).grossCents;
            })();
          }

          const nowOver = currentGross > cfg.targetGrossCents;
          if (wasOverBefore && !nowOver) diag.reducedOverTargetCount++;
        }
      }

      const resultList: DriverResult[] = [];

      const buildResult = (cfg: DriverConfig, isOwner: boolean): DriverResult => {
        const trips = driverTrips.get(cfg.driverId) ?? [];
        const { rows, totals, grundlohnMinutes } = buildDriverPdfRows(
          trips, cfg.driverId, month, year, holidays,
        );

        const bd = computeGrossBreakdown(totals, cfg.hourlyCents);
        const grossFromRidesCents = bd.grossCents;

        const missingHourlyRate = !isOwner && cfg.hourlyCents <= 0;
        const noTarget = isOwner && cfg.targetGrossCents <= 0;

        let ausgleichCents = 0;
        let ausgleichMinutes = 0;
        const overTarget = !noTarget && cfg.targetGrossCents > 0 && grossFromRidesCents > cfg.targetGrossCents + 1;

        if (!overTarget && !missingHourlyRate && cfg.targetGrossCents > 0 && cfg.hourlyCents > 0) {
          const diff = cfg.targetGrossCents - grossFromRidesCents;
          if (diff > 0) {
            ausgleichCents = diff; // cent-exact — no rounding
            ausgleichMinutes = Math.round((diff / cfg.hourlyCents) * 60); // display only
          }
        }

        const finalGrossCents = overTarget
          ? grossFromRidesCents
          : grossFromRidesCents + ausgleichCents;

        const historicalGrossReconciliation: HistoricalGrossReconciliation | null =
          (!isOwner || cfg.targetGrossCents > 0) && cfg.hourlyCents > 0 ? {
            grundlohnH:       totals.grundlohn / 60,
            grundlohnCents:   bd.grundlohnCents,
            nachtarbeitH:     totals.nachtarbeit / 60,
            nachtarbeitCents: bd.nachtarbeitCents,
            nacht04H:         totals.nacht04 / 60,
            nacht04Cents:     bd.nacht04Cents,
            sonntagH:         totals.sonntag / 60,
            sonntagCents:     bd.sonntagCents,
            feiertagH:        totals.feiertag / 60,
            feiertagCents:    bd.feiertagCents,
            ausgleichH:       ausgleichMinutes / 60,
            ausgleichCents,
            finalGrossCents,
            targetGrossCents: cfg.targetGrossCents,
            differenzCents:   finalGrossCents - cfg.targetGrossCents,
            overTarget,
          } : null;

        const corrections: HistoricalPdfCorrectionEntry[] = !isOwner || cfg.targetGrossCents > 0 ? [{
          wageCode: '1000',
          wageLabel: 'Grundlohn (Ist)',
          planActualMins: grundlohnMinutes,
          correctionMins: ausgleichMinutes,
          finalMins: grundlohnMinutes + ausgleichMinutes,
          targetMins: cfg.hourlyCents > 0 && cfg.targetGrossCents > 0
            ? Math.round((cfg.targetGrossCents / cfg.hourlyCents) * 60)
            : 0,
        }] : [];

        return {
          driverId: cfg.driverId,
          driverName: cfg.driverName,
          personalnummer: cfg.personalnummer,
          isOwner,
          hourlyCents: cfg.hourlyCents,
          targetGrossCents: cfg.targetGrossCents,
          grossFromRidesCents,
          grundlohnCents: bd.grundlohnCents,
          zuschlaegeCents: bd.zuschlaegeCents,
          nachtarbeitCents: bd.nachtarbeitCents,
          nacht04Cents: bd.nacht04Cents,
          sonntagCents: bd.sonntagCents,
          feiertagCents: bd.feiertagCents,
          ausgleichMinutes,
          finalGrossCents,
          overTarget,
          missingHourlyRate,
          noTarget,
          rows,
          totals,
          corrections,
          historicalGrossReconciliation,
        };
      };

      for (const cfg of included) resultList.push(buildResult(cfg, false));
      if (ownerCfg) resultList.push(buildResult(ownerCfg, true));

      // Capture assignment snapshot for the edited Fahrtenbuch export
      const newAssignments = new Map<string, string>();
      const allCfgs = [...included, ...(ownerCfg ? [ownerCfg] : [])];
      for (const cfg of allCfgs) {
        for (const trip of driverTrips.get(cfg.driverId) ?? []) {
          newAssignments.set(trip.id, cfg.driverName);
        }
      }
      setTripAssignments(newAssignments);

      setResults(resultList);
      setRepairDiag(diag);
      setStep(3);
    } catch (e) {
      setComputeError(e instanceof Error ? e.message : 'Berechnungsfehler');
    } finally {
      setComputing(false);
    }
  }, [companyId, selectedImportId, driverConfigs, allDrivers, month, year, useInhaber, inhaberId, reconciliationId]);

  // ── Export helpers ─────────────────────────────────────────────────────────

  function buildExportFilename(driverName: string, m: number, y: number): string {
    const safeName = (driverName ?? 'Fahrer').replace(/[/\\:*?"<>|\s]+/g, '_');
    return `Historischer_Stundennachweis_${safeName}_${MONTHS_DE[m - 1]}_${y}.pdf`;
  }

  // ── Edited Fahrtenbuch export ──────────────────────────────────────────────

  const handleExportFahrtenbuch = useCallback(async () => {
    if (!companyId || !selectedImportId) return;
    setExportingFahrtenbuch(true);
    setExportError(null);
    setFbValidation(null);
    try {
      // Paginated fetch — includes canceled rows — bypasses PostgREST 1000-row default cap
      const allTrips = await fetchAllTripsForExport(companyId, selectedImportId);

      if (allTrips.length === 0) {
        throw new Error('Keine Fahrten im Import gefunden.');
      }

      const { data: importMeta } = await supabase
        .from('fahrtenbuch_imports')
        .select('source_columns_json, source_sheet_name, row_count')
        .eq('id', selectedImportId)
        .maybeSingle();

      // Validate row count against stored import metadata
      const storedRowCount: number | null = (importMeta as { row_count?: number } | null)?.row_count ?? null;
      if (storedRowCount !== null && allTrips.length !== storedRowCount) {
        throw new Error(
          `Bearbeitetes Fahrtenbuch konnte nicht erstellt werden: Zeilenanzahl stimmt nicht mit dem Original überein (Original: ${storedRowCount}, Export: ${allTrips.length}).`
        );
      }

      // Apply reconciliation assignments — only update non-canceled trips; preserve original Fahrername otherwise
      const editedTrips: FahrtenbuchTrip[] = allTrips.map(trip => {
        if (trip.is_canceled) return trip;
        const finalDriverName = tripAssignments?.get(trip.id);
        if (finalDriverName != null) {
          return { ...trip, assigned_driver_name: finalDriverName };
        }
        return trip;
      });

      // Build diagnostics
      let changedCount = 0;
      let unassignedCount = 0;
      let canceledCount = 0;
      for (const trip of allTrips) {
        if (trip.is_canceled) { canceledCount++; continue; }
        const finalDriverName = tripAssignments?.get(trip.id);
        if (finalDriverName != null) {
          if (finalDriverName !== trip.original_driver_name) changedCount++;
        } else {
          unassignedCount++;
        }
      }

      // Row-order fingerprint: verify editedTrips are in same order as allTrips (by id)
      let reihenfolgeOk = editedTrips.length === allTrips.length;
      if (reihenfolgeOk) {
        for (let i = 0; i < allTrips.length; i++) {
          if (editedTrips[i].id !== allTrips[i].id) { reihenfolgeOk = false; break; }
        }
      }

      setFbValidation({
        originalCount: allTrips.length,
        exportCount: editedTrips.length,
        changedCount,
        unchangedCount: allTrips.length - changedCount - unassignedCount - canceledCount,
        unassignedCount,
        canceledCount,
        reihenfolgeOk,
        ok: true,
      });

      const sourceColumns = Array.isArray(importMeta?.source_columns_json)
        ? (importMeta.source_columns_json as string[])
        : null;

      exportFahrtenbuch({
        trips: editedTrips,
        month,
        year,
        importFileName: `Historischer_Abgleich_Fahrtenbuch_${MONTHS_DE[month - 1]}_${year}.xlsx`,
        sourceColumns,
        sourceSheetName: importMeta?.source_sheet_name ?? null,
        skipSort: true,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unbekannter Fehler';
      setExportError(msg.includes('Zeilenanzahl') ? msg : `Bearbeitetes Fahrtenbuch konnte nicht erstellt werden: ${msg}`);
    } finally {
      setExportingFahrtenbuch(false);
    }
  }, [companyId, selectedImportId, tripAssignments, month, year]);

  // ── All PDFs export ────────────────────────────────────────────────────────

  const handleExportAllPdfs = useCallback(async () => {
    if (!results) return;
    const exportable = results.filter(r => isExportable(r, inhaberGeneratePdf));
    setExportingAllPdfs(true);
    setExportError(null);
    const failed: string[] = [];
    for (const r of exportable) {
      try {
        const filename = buildExportFilename(r.driverName, month, year);
        exportStundennachweisAsPdf({
          driver: { name: r.driverName, personalnummer: r.personalnummer },
          month,
          year,
          rows: r.rows,
          totals: r.totals,
          isHistorical: true,
          historicalCorrections: r.corrections,
          historicalGrossReconciliation: r.historicalGrossReconciliation ?? undefined,
        }, filename);
        // Small delay between downloads so browsers don't block them
        await new Promise(res => setTimeout(res, 200));
      } catch {
        failed.push(r.driverName);
      }
    }
    if (failed.length > 0) {
      setExportError(`PDF-Fehler für: ${failed.map(n => `PDF für ${n} konnte nicht erstellt werden`).join('; ')}`);
    }
    setExportingAllPdfs(false);
  }, [results, month, year, inhaberGeneratePdf]);

  // ── All items export (XLSX + all PDFs) ─────────────────────────────────────

  const handleExportAllItems = useCallback(async () => {
    if (!results) return;
    setExportingAll(true);
    setExportError(null);
    // 1. Fahrtenbuch XLSX
    if (companyId && selectedImportId) {
      try {
        // Paginated fetch — includes canceled rows — bypasses PostgREST 1000-row default cap
        const allTrips = await fetchAllTripsForExport(companyId, selectedImportId);

        if (allTrips.length > 0) {
          const { data: importMeta } = await supabase
            .from('fahrtenbuch_imports')
            .select('source_columns_json, source_sheet_name')
            .eq('id', selectedImportId)
            .maybeSingle();

          const editedTrips: FahrtenbuchTrip[] = allTrips.map(trip => {
            if (trip.is_canceled) return trip;
            const finalDriverName = tripAssignments?.get(trip.id);
            if (finalDriverName != null) {
              return { ...trip, assigned_driver_name: finalDriverName };
            }
            return trip;
          });

          exportFahrtenbuch({
            trips: editedTrips,
            month,
            year,
            importFileName: `Historischer_Abgleich_Fahrtenbuch_${MONTHS_DE[month - 1]}_${year}.xlsx`,
            sourceColumns: Array.isArray(importMeta?.source_columns_json)
              ? (importMeta.source_columns_json as string[])
              : null,
            sourceSheetName: importMeta?.source_sheet_name ?? null,
            skipSort: true,
          });
        }
      } catch {
        setExportError('Fahrtenbuch-Export fehlgeschlagen.');
      }
    }

    // Small pause between XLSX and PDFs
    await new Promise(res => setTimeout(res, 300));

    // 2. All PDFs
    const exportable = results.filter(r => isExportable(r, inhaberGeneratePdf));
    const failed: string[] = [];
    for (const r of exportable) {
      try {
        const filename = buildExportFilename(r.driverName, month, year);
        exportStundennachweisAsPdf({
          driver: { name: r.driverName, personalnummer: r.personalnummer },
          month,
          year,
          rows: r.rows,
          totals: r.totals,
          isHistorical: true,
          historicalCorrections: r.corrections,
          historicalGrossReconciliation: r.historicalGrossReconciliation ?? undefined,
        }, filename);
        await new Promise(res => setTimeout(res, 200));
      } catch {
        failed.push(r.driverName);
      }
    }
    if (failed.length > 0) {
      setExportError(`PDF-Fehler für: ${failed.map(n => `PDF für ${n} konnte nicht erstellt werden`).join('; ')}`);
    }
    setExportingAll(false);
  }, [results, companyId, selectedImportId, tripAssignments, month, year, inhaberGeneratePdf]);

  const handleExport = useCallback(async (r: DriverResult) => {
    setExporting(true);
    setExportError(null);
    try {
      const filename = buildExportFilename(r.driverName, month, year);
      exportStundennachweisAsPdf({
        driver: { name: r.driverName, personalnummer: r.personalnummer },
        month,
        year,
        rows: r.rows,
        totals: r.totals,
        isHistorical: true,
        historicalCorrections: r.corrections,
        historicalGrossReconciliation: r.historicalGrossReconciliation ?? undefined,
      }, filename);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unbekannter Fehler';
      setExportError(`PDF für ${r.driverName} konnte nicht erstellt werden: ${msg}`);
    } finally {
      setExporting(false);
    }
  }, [month, year]);

  // ── Helper: is a driver exportable? ───────────────────────────────────────

  function isExportable(r: DriverResult, includePdfForInhaber: boolean): boolean {
    if (r.isOwner) return includePdfForInhaber && r.totals.grundlohn > 0;
    return !r.overTarget && !r.missingHourlyRate && r.targetGrossCents > 0
      && r.finalGrossCents === r.targetGrossCents;
  }

  // ── Derived result counts ──────────────────────────────────────────────────

  const exportableResults = results?.filter(r => isExportable(r, inhaberGeneratePdf)) ?? [];
  const blockedResults = results?.filter(r => !isExportable(r, inhaberGeneratePdf) && !r.isOwner) ?? [];
  const includedCount = driverConfigs.filter(c => c.included).length;
  const step1Valid = includedCount > 0 &&
    driverConfigs.filter(c => c.included).every(c => c.hourlyCents > 0 && c.targetGrossCents > 0);

  const selectedImport = imports.find(i => i.id === selectedImportId);
  const inhaberDriver = allDrivers.find(d => d.id === inhaberId);

  // Whether any regular driver remains over target after the repair pass.
  // This determines if unmovable groups are export-blocking or just informational.
  const anyRegularOverTarget = results?.some(r => !r.isOwner && r.overTarget) ?? false;
  const unmovableIsBlocking = (repairDiag?.unmovableGroups ?? 0) > 0 && anyRegularOverTarget;
  const unmovableIsNonBlocking = (repairDiag?.unmovableGroups ?? 0) > 0 && !anyRegularOverTarget;

  // ── Result status label ────────────────────────────────────────────────────

  function resultStatusBadge(r: DriverResult) {
    if (r.isOwner) {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold"
          style={{ background: 'rgba(16,185,129,0.1)', color: '#047857' }}>
          Inhaber / Ausgleichsfahrer
        </span>
      );
    }
    if (r.missingHourlyRate) {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold"
          style={{ background: 'rgba(220,38,38,0.1)', color: '#b91c1c' }}>
          <AlertTriangle size={11} /> Stundensatz fehlt
        </span>
      );
    }
    if (r.overTarget) {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold"
          style={{ background: 'rgba(220,38,38,0.1)', color: '#b91c1c' }}>
          <AlertTriangle size={11} /> Über Ziel-Brutto
        </span>
      );
    }
    if (!r.isOwner && !r.overTarget && !r.noTarget && r.targetGrossCents > 0
      && r.finalGrossCents !== r.targetGrossCents) {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold"
          style={{ background: 'rgba(234,179,8,0.1)', color: '#a16207' }}>
          <AlertTriangle size={11} /> Differenz vorhanden
        </span>
      );
    }
    if (r.ausgleichMinutes > 0) {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold"
          style={{ background: 'rgba(124,58,237,0.1)', color: '#6d28d9' }}>
          <CheckCircle2 size={11} /> Ausgleich nötig
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold"
        style={{ background: 'rgba(21,128,61,0.1)', color: '#15803d' }}>
        <CheckCircle2 size={11} /> Ziel erreicht
      </span>
    );
  }

  // ── Autosave status badge ──────────────────────────────────────────────────

  function SaveBadge() {
    if (saveStatus === 'idle') return null;
    const cfg = {
      saving:  { label: 'Speichern…', color: '#6b7280' },
      saved:   { label: 'Gespeichert', color: '#15803d' },
      unsaved: { label: 'Ungespeicherte Änderungen', color: '#b45309' },
    }[saveStatus];
    if (!cfg) return null;
    return (
      <span className="inline-flex items-center gap-1 text-xs" style={{ color: cfg.color }}>
        <Save size={11} />
        {cfg.label}
      </span>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div>
      {/* Back + step indicator */}
      <div className="flex items-center justify-between mb-5">
        <button
          onClick={step > 0 ? () => setStep(s => s - 1) : onBack}
          className="inline-flex items-center gap-2 text-sm font-medium transition-colors hover:opacity-80"
          style={{ color: 'var(--text-secondary)' }}
        >
          <ArrowLeft size={15} />
          {step === 0 ? 'Zurück zur Auswahl' : 'Zurück'}
        </button>
        <div className="flex items-center gap-4">
          {step === 1 && <SaveBadge />}
          <StepDots current={step} total={5} />
        </div>
      </div>

      {/* ── Step 0: Monat & Import ─────────────────────────────────────────── */}
      {step === 0 && (
        <div className="space-y-5">
          <div className="rounded-2xl p-6" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
            <div className="flex items-center gap-3 mb-5">
              <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: 'rgba(124,58,237,0.1)' }}>
                <Clock size={18} style={{ color: '#7c3aed' }} />
              </div>
              <div>
                <h2 className="font-bold text-base" style={{ color: 'var(--text-primary)' }}>Schritt 1 — Monat & Fahrtenbuch</h2>
                <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>Wähle den abzugleichenden Monat und den zugehörigen Import.</p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-tertiary)' }}>Monat</label>
                <select
                  value={month}
                  onChange={e => setMonth(Number(e.target.value))}
                  className="w-full px-3 py-2.5 rounded-xl text-sm focus:outline-none"
                  style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                >
                  {MONTHS_DE.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-tertiary)' }}>Jahr</label>
                <select
                  value={year}
                  onChange={e => setYear(Number(e.target.value))}
                  className="w-full px-3 py-2.5 rounded-xl text-sm focus:outline-none"
                  style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                >
                  {yearOptions.map(y => <option key={y} value={y}>{y}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-tertiary)' }}>Fahrtenbuch-Import</label>
                <select
                  value={selectedImportId}
                  onChange={e => setSelectedImportId(e.target.value)}
                  disabled={loadingImports || imports.length === 0}
                  className="w-full px-3 py-2.5 rounded-xl text-sm focus:outline-none"
                  style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                >
                  {imports.length === 0 ? (
                    <option value="">Kein Import für {MONTHS_DE[month - 1]} {year}</option>
                  ) : imports.map(i => (
                    <option key={i.id} value={i.id}>
                      {i.file_name} ({i.row_count} Zeilen, {new Date(i.imported_at).toLocaleDateString('de-DE')})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {imports.length === 0 && !loadingImports && (
              <div className="mt-4 px-4 py-3 rounded-xl flex items-center gap-2 text-sm"
                style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)', color: '#b45309' }}>
                <AlertTriangle size={14} />
                Kein Import für {MONTHS_DE[month - 1]} {year} gefunden. Bitte zuerst importieren.
              </div>
            )}
          </div>

          <div className="flex justify-end">
            <button
              onClick={handleAdvanceToStep1}
              disabled={!selectedImportId || loadingImports || loadingDrivers}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold transition-all hover:brightness-110 active:scale-[0.98] disabled:opacity-40"
              style={{ background: 'linear-gradient(135deg, #7c3aed, #6d28d9)', color: '#fff' }}
            >
              Weiter <ArrowRight size={15} />
            </button>
          </div>
        </div>
      )}

      {/* ── Step 1: Fahrer & Zielwerte ────────────────────────────────────── */}
      {step === 1 && (
        <div className="space-y-5">
          {/* Regular drivers table */}
          <div className="rounded-2xl overflow-hidden" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
            <div className="px-6 py-4 border-b" style={{ borderColor: 'var(--border)' }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: 'rgba(124,58,237,0.1)' }}>
                    <Users size={18} style={{ color: '#7c3aed' }} />
                  </div>
                  <div>
                    <h2 className="font-bold text-base" style={{ color: 'var(--text-primary)' }}>Schritt 2 — Fahrer & Steuerberater-Zielwerte</h2>
                    <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                      {MONTHS_DE[month - 1]} {year} · {selectedImport?.file_name}
                    </p>
                  </div>
                </div>
              </div>
            </div>

            <div className="px-6 pt-3 pb-1">
              <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                Der Stundensatz wird aus dem Fahrerprofil übernommen und kann für diesen Abgleich angepasst werden.
              </p>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ background: 'var(--bg-subtle)' }}>
                    <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
                      <label className="inline-flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={driverConfigs.length > 0 && driverConfigs.every(c => c.included)}
                          onChange={e => setDriverConfigs(prev => prev.map(c => ({ ...c, included: e.target.checked })))}
                        />
                        Fahrer (Angestellt)
                      </label>
                    </th>
                    <th className="px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)', minWidth: 140 }}>
                      Stundensatz (€/h)
                    </th>
                    <th className="px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)', minWidth: 160 }}>
                      Ziel-Brutto (€)
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {driverConfigs.map((cfg, idx) => (
                    <tr key={cfg.driverId} style={{ borderTop: '1px solid var(--border)', opacity: cfg.included ? 1 : 0.45 }}>
                      <td className="px-4 py-2.5">
                        <label className="flex items-center gap-2.5 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={cfg.included}
                            onChange={e => setDriverConfigs(prev =>
                              prev.map((c, i) => i === idx ? { ...c, included: e.target.checked } : c)
                            )}
                          />
                          <div>
                            <div className="font-medium" style={{ color: 'var(--text-primary)' }}>{cfg.driverName}</div>
                            {cfg.personalnummer && <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>#{cfg.personalnummer}</div>}
                          </div>
                        </label>
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-1.5 justify-end">
                          <input
                            type="text" inputMode="decimal" placeholder="0,00"
                            value={
                              hourlyDrafts[cfg.driverId] !== undefined
                                ? hourlyDrafts[cfg.driverId]
                                : cfg.hourlyCents > 0 ? formatCentsForDisplay(cfg.hourlyCents) : ''
                            }
                            onChange={e => {
                              const raw = e.target.value;
                              setHourlyDrafts(prev => ({ ...prev, [cfg.driverId]: raw }));
                            }}
                            onFocus={() => {
                              setHourlyDrafts(prev => ({
                                ...prev,
                                [cfg.driverId]: cfg.hourlyCents > 0 ? formatCentsForDisplay(cfg.hourlyCents) : '',
                              }));
                            }}
                            onBlur={() => {
                              const raw = hourlyDrafts[cfg.driverId] ?? '';
                              const cents = parseGermanDecimal(raw);
                              const finalCents = cents ?? 0;
                              setDriverConfigs(prev => prev.map(d =>
                                d.driverId === cfg.driverId ? { ...d, hourlyCents: finalCents } : d
                              ));
                              setHourlyDrafts(prev => {
                                const next = { ...prev };
                                delete next[cfg.driverId];
                                return next;
                              });
                            }}
                            disabled={!cfg.included}
                            className="w-24 px-2.5 py-1.5 rounded-lg text-sm text-right focus:outline-none"
                            style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                          />
                          <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>€/h</span>
                        </div>
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-1.5 justify-end">
                          <input
                            type="text" inputMode="decimal" placeholder="0,00"
                            value={
                              targetDrafts[cfg.driverId] !== undefined
                                ? targetDrafts[cfg.driverId]
                                : cfg.targetGrossCents > 0 ? formatCentsForDisplay(cfg.targetGrossCents) : ''
                            }
                            onChange={e => {
                              const raw = e.target.value;
                              setTargetDrafts(prev => ({ ...prev, [cfg.driverId]: raw }));
                            }}
                            onFocus={() => {
                              setTargetDrafts(prev => ({
                                ...prev,
                                [cfg.driverId]: cfg.targetGrossCents > 0 ? formatCentsForDisplay(cfg.targetGrossCents) : '',
                              }));
                            }}
                            onBlur={() => {
                              const raw = targetDrafts[cfg.driverId] ?? '';
                              const cents = parseGermanDecimal(raw);
                              const finalCents = cents ?? 0;
                              setDriverConfigs(prev => prev.map(d =>
                                d.driverId === cfg.driverId ? { ...d, targetGrossCents: finalCents } : d
                              ));
                              setTargetDrafts(prev => {
                                const next = { ...prev };
                                delete next[cfg.driverId];
                                return next;
                              });
                            }}
                            disabled={!cfg.included}
                            className="w-28 px-2.5 py-1.5 rounded-lg text-sm text-right focus:outline-none"
                            style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                          />
                          <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>€</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {driverConfigs.length === 0 && (
                    <tr>
                      <td colSpan={3} className="px-4 py-8 text-center text-sm" style={{ color: 'var(--text-tertiary)' }}>
                        Keine angestellten Fahrer gefunden.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Inhaber / Ausgleichsfahrer section */}
          <div className="rounded-2xl p-5" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
            <h3 className="font-bold text-sm mb-1" style={{ color: 'var(--text-primary)' }}>
              Inhaber / Ausgleichsfahrer
            </h3>
            <p className="text-xs mb-4" style={{ color: 'var(--text-tertiary)' }}>
              Der Inhaber kann überschüssige Fahrten übernehmen, damit angestellte Fahrer ihr Steuerberater-Ziel nicht überschreiten.
            </p>

            {ownerDrivers.length === 0 && (
              <div className="mb-4 px-4 py-3 rounded-xl flex items-center gap-2 text-sm"
                style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)', color: '#b45309' }}>
                <AlertTriangle size={14} />
                Kein Inhaber gefunden. Bitte wählen Sie einen Ausgleichsfahrer aus.
              </div>
            )}

            <div className="space-y-3">
              <label className="flex items-center gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={useInhaber}
                  onChange={e => setUseInhaber(e.target.checked)}
                  className="w-4 h-4"
                />
                <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                  Inhaber als Ausgleichsfahrer verwenden
                </span>
              </label>

              {useInhaber && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pl-6">
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-tertiary)' }}>
                      Inhaber auswählen
                    </label>
                    <select
                      value={inhaberId}
                      onChange={e => setInhaberId(e.target.value)}
                      className="w-full px-3 py-2 rounded-xl text-sm focus:outline-none"
                      style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                    >
                      <option value="">— Bitte wählen —</option>
                      {ownerDrivers.map(d => (
                        <option key={d.id} value={d.id}>{d.name} (Inhaber)</option>
                      ))}
                      {regularDrivers.filter(d => !driverConfigs.find(c => c.driverId === d.id)?.included).map(d => (
                        <option key={d.id} value={d.id}>{d.name}</option>
                      ))}
                    </select>
                    {inhaberId && (
                      <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
                        {inhaberDriver?.name ?? ''} wird als Ausgleichsfahrer verwendet.
                      </p>
                    )}
                  </div>
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-tertiary)' }}>
                      Ziel-Brutto für Inhaber (optional)
                    </label>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="text" inputMode="decimal" placeholder="— kein Limit —"
                        value={
                          inhaberTargetDraft !== null
                            ? inhaberTargetDraft
                            : (driverConfigs.find(c => c.driverId === inhaberId)?.targetGrossCents ?? 0) > 0
                              ? formatCentsForDisplay(driverConfigs.find(c => c.driverId === inhaberId)?.targetGrossCents ?? 0)
                              : ''
                        }
                        onChange={e => setInhaberTargetDraft(e.target.value)}
                        onFocus={() => {
                          const cur = driverConfigs.find(c => c.driverId === inhaberId)?.targetGrossCents ?? 0;
                          setInhaberTargetDraft(cur > 0 ? formatCentsForDisplay(cur) : '');
                        }}
                        onBlur={() => {
                          const raw = inhaberTargetDraft ?? '';
                          const cents = parseGermanDecimal(raw);
                          const finalCents = cents ?? 0;
                          setDriverConfigs(prev => {
                            const existing = prev.find(d => d.driverId === inhaberId);
                            if (existing) {
                              return prev.map(d => d.driverId === inhaberId ? { ...d, targetGrossCents: finalCents } : d);
                            }
                            const ownerD = allDrivers.find(d => d.id === inhaberId);
                            if (!ownerD) return prev;
                            return [...prev, {
                              driverId: inhaberId,
                              driverName: ownerD.name,
                              personalnummer: ownerD.personalnummer ?? null,
                              isOwner: true,
                              hourlyCents: 0,
                              targetGrossCents: finalCents,
                              included: false,
                            }];
                          });
                          setInhaberTargetDraft(null);
                        }}
                        className="w-28 px-2.5 py-1.5 rounded-lg text-sm text-right focus:outline-none"
                        style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                      />
                      <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>€</span>
                    </div>
                    <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
                      Wenn leer, wird kein Export blockiert.
                    </p>
                  </div>
                </div>
              )}

              {useInhaber && inhaberId && (
                <label className="flex items-center gap-2.5 cursor-pointer pl-6">
                  <input
                    type="checkbox"
                    checked={inhaberGeneratePdf}
                    onChange={e => setInhaberGeneratePdf(e.target.checked)}
                    className="w-4 h-4"
                  />
                  <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                    Stundennachweis für Inhaber erstellen
                  </span>
                </label>
              )}
            </div>
          </div>

          {!step1Valid && includedCount > 0 && (
            <div className="px-4 py-3 rounded-xl flex items-center gap-2 text-sm"
              style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)', color: '#b45309' }}>
              <AlertTriangle size={14} />
              Bitte Stundensatz und Ziel-Brutto für alle ausgewählten Fahrer eingeben.
            </div>
          )}

          <div className="flex justify-end">
            <button
              onClick={async () => {
                if (reconciliationId) {
                  await saveDriverConfigs(reconciliationId, driverConfigs);
                  await saveInhaberConfig(reconciliationId);
                }
                setStep(2);
              }}
              disabled={!step1Valid}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold transition-all hover:brightness-110 active:scale-[0.98] disabled:opacity-40"
              style={{ background: 'linear-gradient(135deg, #7c3aed, #6d28d9)', color: '#fff' }}
            >
              Weiter zur Berechnung <ArrowRight size={15} />
            </button>
          </div>
        </div>
      )}

      {/* ── Step 2: Berechnung starten ─────────────────────────────────────── */}
      {step === 2 && (
        <div className="space-y-5">
          <div className="rounded-2xl p-6" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
            <div className="flex items-center gap-3 mb-5">
              <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: 'rgba(124,58,237,0.1)' }}>
                <Calculator size={18} style={{ color: '#7c3aed' }} />
              </div>
              <div>
                <h2 className="font-bold text-base" style={{ color: 'var(--text-primary)' }}>Schritt 3 — Abgleich berechnen</h2>
                <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                  Fahrten auswerten, Brutto berechnen, Ausgleichsstunden ermitteln.
                </p>
              </div>
            </div>

            <div className="space-y-2 mb-5">
              {driverConfigs.filter(c => c.included).map(cfg => (
                <div key={cfg.driverId} className="px-4 py-3 rounded-xl flex items-center justify-between"
                  style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
                  <div>
                    <span className="font-medium text-sm" style={{ color: 'var(--text-primary)' }}>{cfg.driverName}</span>
                    <span className="text-xs ml-2" style={{ color: 'var(--text-tertiary)' }}>
                      {centsToDisplay(cfg.hourlyCents)} €/h · Ziel: {centsToDisplay(cfg.targetGrossCents)} €
                    </span>
                  </div>
                  <CheckCircle2 size={15} style={{ color: '#15803d' }} />
                </div>
              ))}
              {useInhaber && inhaberId && (
                <div className="px-4 py-3 rounded-xl flex items-center justify-between"
                  style={{ background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.2)' }}>
                  <div>
                    <span className="font-medium text-sm" style={{ color: '#047857' }}>
                      {inhaberDriver?.name ?? 'Inhaber'}
                    </span>
                    <span className="text-xs ml-2" style={{ color: '#15803d' }}>Ausgleichsfahrer</span>
                  </div>
                  <CheckCircle2 size={15} style={{ color: '#15803d' }} />
                </div>
              )}
            </div>

            {useInhaber && inhaberId && (
              <div className="mb-4 px-4 py-3 rounded-xl flex items-start gap-2 text-sm"
                style={{ background: 'rgba(124,58,237,0.06)', border: '1px solid rgba(124,58,237,0.2)', color: '#6d28d9' }}>
                <Info size={14} className="mt-0.5 shrink-0" />
                <span>
                  <strong>Inhaber-Ausgleichs-Reparatur aktiv:</strong> Überschüssige Fahrten werden
                  automatisch an {inhaberDriver?.name ?? 'Inhaber'} übertragen, sofern keine Überlappung
                  mit bestehenden Inhaber-Schichten besteht.
                </span>
              </div>
            )}

            {computeError && (
              <div className="mb-4 px-4 py-3 rounded-xl flex items-center gap-2 text-sm"
                style={{ background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.2)', color: '#b91c1c' }}>
                <AlertTriangle size={14} /> {computeError}
              </div>
            )}

            <button
              onClick={handleCompute}
              disabled={computing}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold transition-all hover:brightness-110 active:scale-[0.98] disabled:opacity-50"
              style={{ background: 'linear-gradient(135deg, #7c3aed, #6d28d9)', color: '#fff' }}
            >
              {computing ? <RefreshCw size={14} className="animate-spin" /> : <Calculator size={14} />}
              {computing ? 'Berechne…' : 'Abgleich jetzt berechnen'}
            </button>
          </div>
        </div>
      )}

      {/* ── Step 3: Ergebnis prüfen ────────────────────────────────────────── */}
      {step === 3 && results && (
        <div className="space-y-5">
          {repairDiag && useInhaber && inhaberId && (
            <div className="rounded-2xl p-5" style={{ background: 'rgba(124,58,237,0.05)', border: '1px solid rgba(124,58,237,0.2)' }}>
              <h3 className="font-bold text-sm mb-3" style={{ color: '#6d28d9' }}>Inhaber-Ausgleich</h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div>
                  <div className="text-xs uppercase tracking-wider font-semibold mb-1" style={{ color: 'var(--text-tertiary)' }}>Übernommene Gruppen</div>
                  <div className="text-xl font-bold" style={{ color: '#7c3aed' }}>{repairDiag.movedGroups}</div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-wider font-semibold mb-1" style={{ color: 'var(--text-tertiary)' }}>Übernommene Zeit</div>
                  <div className="text-xl font-bold" style={{ color: '#7c3aed' }}>
                    {(repairDiag.movedMinutes / 60).toFixed(2).replace('.', ',')} h
                  </div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-wider font-semibold mb-1" style={{ color: 'var(--text-tertiary)' }}>Reduzierte Über-Ziel</div>
                  <div className="text-xl font-bold" style={{ color: '#15803d' }}>{repairDiag.reducedOverTargetCount}</div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-wider font-semibold mb-1" style={{ color: 'var(--text-tertiary)' }}>Nicht verschiebbar</div>
                  <div className="text-xl font-bold" style={{
                    color: unmovableIsBlocking ? '#b91c1c'
                      : unmovableIsNonBlocking ? '#b45309'
                      : 'var(--text-tertiary)',
                  }}>
                    {repairDiag.unmovableGroups}
                  </div>
                </div>
              </div>

              {unmovableIsNonBlocking && (
                <div className="mt-3 px-4 py-3 rounded-xl flex items-start gap-2 text-sm"
                  style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)', color: '#b45309' }}>
                  <Info size={14} className="mt-0.5 shrink-0" />
                  <div>
                    <div className="font-semibold">Nicht verschiebbar, aber kein Export-Blocker</div>
                    <div className="mt-0.5 text-xs opacity-80">
                      Diese Gruppen konnten wegen Inhaber-Überlappungen nicht verschoben werden. Da alle Fahrer unter Ziel-Brutto liegen, verhindert dies den Export nicht.
                    </div>
                  </div>
                </div>
              )}

              {unmovableIsBlocking && (
                <div className="mt-3 px-4 py-3 rounded-xl flex items-start gap-2 text-sm"
                  style={{ background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.2)', color: '#b91c1c' }}>
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                  <div>
                    <div className="font-semibold">Nicht verschiebbar — Export blockiert</div>
                    <div className="mt-0.5 text-xs opacity-80">
                      Diese Gruppen konnten nicht verschoben werden und mindestens ein Fahrer bleibt über Ziel-Brutto.
                    </div>
                  </div>
                </div>
              )}

              {repairDiag.unmovableReasons.length > 0 && (
                <details className="mt-3">
                  <summary className="text-xs cursor-pointer" style={{ color: 'var(--text-tertiary)' }}>
                    Nicht verschiebbare Gruppen ({repairDiag.unmovableReasons.length})
                  </summary>
                  <ul className="mt-2 space-y-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
                    {repairDiag.unmovableReasons.slice(0, 20).map((r, i) => (
                      <li key={i}>• {r} — {unmovableIsBlocking ? 'Export-Blocker' : 'kein Export-Blocker'}</li>
                    ))}
                    {repairDiag.unmovableReasons.length > 20 && (
                      <li>… und {repairDiag.unmovableReasons.length - 20} weitere</li>
                    )}
                  </ul>
                </details>
              )}
            </div>
          )}

          <div className="rounded-2xl overflow-hidden" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
            <div className="px-6 py-4 border-b" style={{ borderColor: 'var(--border)' }}>
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: 'rgba(124,58,237,0.1)' }}>
                  <CheckCircle2 size={18} style={{ color: '#7c3aed' }} />
                </div>
                <div>
                  <h2 className="font-bold text-base" style={{ color: 'var(--text-primary)' }}>Schritt 4 — Ergebnis prüfen</h2>
                  <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                    {MONTHS_DE[month - 1]} {year} · {exportableResults.length} exportierbar
                    {blockedResults.length > 0 ? `, ${blockedResults.length} gesperrt` : ''}
                  </p>
                </div>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ background: 'var(--bg-subtle)' }}>
                    {['Fahrer', 'Stunden Ist', 'Grundlohn Ist', 'Zuschläge Ist', 'Brutto Ist inkl. Zuschläge', 'Ausgleich H', 'Finales Brutto', 'Ziel-Brutto', 'Status'].map(h => (
                      <th key={h} className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wider whitespace-nowrap" style={{ color: 'var(--text-tertiary)' }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {results.map(r => {
                    const grundlohnMins = r.totals.grundlohn;
                    const isExpanded = expandedDriverId === r.driverId;
                    return (
                      <React.Fragment key={r.driverId}>
                        <tr
                          onClick={() => setExpandedDriverId(isExpanded ? null : r.driverId)}
                          style={{
                            borderTop: '1px solid var(--border)',
                            background: r.isOwner ? 'rgba(16,185,129,0.04)' : undefined,
                            cursor: 'pointer',
                          }}>
                          <td className="px-3 py-2.5">
                            <div className="font-medium" style={{ color: 'var(--text-primary)' }}>
                              {r.driverName}
                              {r.isOwner && (
                                <span className="ml-1.5 text-xs px-1.5 py-0.5 rounded-full"
                                  style={{ background: 'rgba(16,185,129,0.12)', color: '#047857' }}>
                                  Inhaber
                                </span>
                              )}
                            </div>
                            {r.personalnummer && <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>#{r.personalnummer}</div>}
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono text-xs" style={{ color: 'var(--text-secondary)' }}>
                            {(grundlohnMins / 60).toFixed(2).replace('.', ',')}h
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono text-xs" style={{ color: 'var(--text-secondary)' }}>
                            {r.hourlyCents > 0 ? `${centsToDisplay(r.grundlohnCents)} €` : '—'}
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono text-xs" style={{ color: r.zuschlaegeCents > 0 ? '#b45309' : 'var(--text-tertiary)' }}>
                            {r.hourlyCents > 0 ? `${centsToDisplay(r.zuschlaegeCents)} €` : '—'}
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono text-xs font-semibold" style={{ color: r.overTarget ? '#dc2626' : 'var(--text-secondary)' }}>
                            {r.hourlyCents > 0 ? `${centsToDisplay(r.grossFromRidesCents)} €` : '—'}
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono text-xs"
                            style={{ color: r.ausgleichMinutes > 0 ? '#7c3aed' : 'var(--text-tertiary)' }}>
                            {(r.ausgleichMinutes / 60).toFixed(2).replace('.', ',')}h
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
                            {r.hourlyCents > 0 ? `${centsToDisplay(r.finalGrossCents)} €` : '—'}
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono text-xs" style={{ color: 'var(--text-tertiary)' }}>
                            {r.targetGrossCents > 0 ? `${centsToDisplay(r.targetGrossCents)} €` : '—'}
                          </td>
                          <td className="px-3 py-2.5">
                            {resultStatusBadge(r)}
                          </td>
                        </tr>
                        {isExpanded && r.historicalGrossReconciliation && (
                          <tr style={{ borderTop: '1px solid var(--border)' }}>
                            <td colSpan={9} className="px-6 py-3" style={{ background: 'var(--bg-subtle)' }}>
                              <div className="text-xs font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>
                                Brutto-Aufschlüsselung — {r.driverName}
                              </div>
                              <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-xs max-w-xl" style={{ color: 'var(--text-secondary)' }}>
                                {[
                                  ['Grundlohn aus Fahrten', `${r.historicalGrossReconciliation.grundlohnH.toFixed(2).replace('.', ',')}h`, `${centsToDisplay(r.historicalGrossReconciliation.grundlohnCents)} €`],
                                  ['Nachtarbeit-Zuschlag (25%)', `${r.historicalGrossReconciliation.nachtarbeitH.toFixed(2).replace('.', ',')}h`, `${centsToDisplay(r.historicalGrossReconciliation.nachtarbeitCents)} €`],
                                  ['Nacht 0–4-Zuschlag (+25%)', `${r.historicalGrossReconciliation.nacht04H.toFixed(2).replace('.', ',')}h`, `${centsToDisplay(r.historicalGrossReconciliation.nacht04Cents)} €`],
                                  ['Sonntag-Zuschlag (50%)', `${r.historicalGrossReconciliation.sonntagH.toFixed(2).replace('.', ',')}h`, `${centsToDisplay(r.historicalGrossReconciliation.sonntagCents)} €`],
                                  ['Feiertag-Zuschlag (100%)', `${r.historicalGrossReconciliation.feiertagH.toFixed(2).replace('.', ',')}h`, `${centsToDisplay(r.historicalGrossReconciliation.feiertagCents)} €`],
                                  ['Ausgleichsstunden', `${r.historicalGrossReconciliation.ausgleichH.toFixed(2).replace('.', ',')}h`, `${centsToDisplay(r.historicalGrossReconciliation.ausgleichCents)} €`],
                                ].map(([label, hours, amount]) => (
                                  <React.Fragment key={label}>
                                    <span>{label}</span>
                                    <span className="font-mono text-right" style={{ color: 'var(--text-primary)' }}>
                                      {hours} · {amount}
                                    </span>
                                  </React.Fragment>
                                ))}
                                <span className="font-semibold pt-1 border-t" style={{ color: 'var(--text-primary)', borderColor: 'var(--border)' }}>Finales Brutto</span>
                                <span className="font-semibold font-mono text-right pt-1 border-t" style={{ color: 'var(--text-primary)', borderColor: 'var(--border)' }}>
                                  {centsToDisplay(r.historicalGrossReconciliation.finalGrossCents)} €
                                </span>
                                <span style={{ color: 'var(--text-secondary)' }}>Steuerberater Ziel-Brutto</span>
                                <span className="font-mono text-right" style={{ color: 'var(--text-secondary)' }}>
                                  {r.historicalGrossReconciliation.targetGrossCents > 0 ? `${centsToDisplay(r.historicalGrossReconciliation.targetGrossCents)} €` : '—'}
                                </span>
                                <span style={{ color: 'var(--text-secondary)' }}>Differenz</span>
                                <span className="font-mono text-right font-semibold" style={{
                                  color: r.historicalGrossReconciliation.differenzCents === 0 ? '#047857'
                                    : r.historicalGrossReconciliation.differenzCents > 0 ? '#dc2626' : '#b45309',
                                }}>
                                  {r.historicalGrossReconciliation.differenzCents > 0 ? '+' : ''}{centsToDisplay(r.historicalGrossReconciliation.differenzCents)} €
                                </span>
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {blockedResults.length > 0 && (
            <div className="px-4 py-3 rounded-xl flex items-start gap-2 text-sm"
              style={{ background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.2)', color: '#b91c1c' }}>
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <div>
                <span className="font-semibold">{blockedResults.length} Fahrer gesperrt:</span>
                {blockedResults.filter(r => r.overTarget).length > 0 && (
                  <> Über Ziel-Brutto: {blockedResults.filter(r => r.overTarget).map(r => r.driverName).join(', ')}.</>
                )}
                {blockedResults.filter(r => r.missingHourlyRate).length > 0 && (
                  <> Fehlender Stundensatz: {blockedResults.filter(r => r.missingHourlyRate).map(r => r.driverName).join(', ')}.</>
                )}
              </div>
            </div>
          )}

          <div className="flex justify-end">
            <button
              onClick={() => setStep(4)}
              disabled={exportableResults.length === 0}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold transition-all hover:brightness-110 active:scale-[0.98] disabled:opacity-40"
              style={{ background: 'linear-gradient(135deg, #7c3aed, #6d28d9)', color: '#fff' }}
            >
              Weiter zu Dokumente <ArrowRight size={15} />
            </button>
          </div>
        </div>
      )}

      {/* ── Step 4: Dokumente erstellen ────────────────────────────────────── */}
      {step === 4 && results && (
        <div className="space-y-5">
          <div className="rounded-2xl overflow-hidden" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
            <div className="px-6 py-4 border-b" style={{ borderColor: 'var(--border)' }}>
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: 'rgba(124,58,237,0.1)' }}>
                  <FileText size={18} style={{ color: '#7c3aed' }} />
                </div>
                <div>
                  <h2 className="font-bold text-base" style={{ color: 'var(--text-primary)' }}>Schritt 5 — Dokumente erstellen</h2>
                  <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                    Stundennachweise mit Ist-Stunden + Ausgleichsstunden für {MONTHS_DE[month - 1]} {year}
                  </p>
                </div>
              </div>
            </div>

            {/* ── Export actions ────────────────────────────────────────────── */}
            <div className="px-6 py-4 border-b" style={{ borderColor: 'var(--border)', background: 'var(--bg-subtle)' }}>
              <div className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-tertiary)' }}>
                Export
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={handleExportFahrtenbuch}
                  disabled={exportingFahrtenbuch || exportingAll || !tripAssignments}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold transition-all hover:brightness-110 active:scale-[0.98] disabled:opacity-40"
                  style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                >
                  {exportingFahrtenbuch
                    ? <RefreshCw size={13} className="animate-spin" />
                    : <Download size={13} />}
                  {exportingFahrtenbuch ? 'Fahrtenbuch wird erstellt…' : 'Bearbeitetes Fahrtenbuch'}
                </button>

                <button
                  onClick={handleExportAllPdfs}
                  disabled={exportingAllPdfs || exportingAll || exportableResults.length === 0}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold transition-all hover:brightness-110 active:scale-[0.98] disabled:opacity-40"
                  style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                >
                  {exportingAllPdfs
                    ? <RefreshCw size={13} className="animate-spin" />
                    : <Download size={13} />}
                  {exportingAllPdfs
                    ? 'Stundennachweise werden erstellt…'
                    : `Alle Stundennachweise (${exportableResults.length})`}
                </button>

                <button
                  onClick={handleExportAllItems}
                  disabled={exportingAll || exportingFahrtenbuch || exportingAllPdfs || exportableResults.length === 0 || !tripAssignments}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold transition-all hover:brightness-110 active:scale-[0.98] disabled:opacity-40"
                  style={{ background: 'linear-gradient(135deg, #7c3aed, #6d28d9)', color: '#fff' }}
                >
                  {exportingAll
                    ? <RefreshCw size={13} className="animate-spin" />
                    : <Download size={13} />}
                  {exportingAll ? 'Export wird vorbereitet…' : 'Alles herunterladen'}
                </button>
              </div>

              {!tripAssignments && (
                <p className="mt-2 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                  Fahrtenbuch-Export verfügbar nach Ausführen der Berechnung.
                </p>
              )}

              {fbValidation && (
                <div className="mt-3 px-4 py-3 rounded-xl text-xs space-y-1"
                  style={{ background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.18)' }}>
                  <div className="font-semibold mb-1" style={{ color: '#047857' }}>
                    Fahrtenbuch-Prüfung
                  </div>
                  <div className="grid grid-cols-2 gap-x-6 gap-y-0.5" style={{ color: 'var(--text-secondary)' }}>
                    <span>Original-Zeilen</span>
                    <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{fbValidation.originalCount}</span>
                    <span>Export-Zeilen</span>
                    <span className="font-medium" style={{ color: fbValidation.exportCount === fbValidation.originalCount ? 'var(--text-primary)' : '#b91c1c' }}>{fbValidation.exportCount}</span>
                    <span>Reihenfolge geprüft</span>
                    <span className="font-medium" style={{ color: fbValidation.reihenfolgeOk ? '#047857' : '#b91c1c' }}>
                      {fbValidation.reihenfolgeOk ? 'OK' : 'Abweichung'}
                    </span>
                    <span>Geänderte Fahrer-Zuordnungen</span>
                    <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{fbValidation.changedCount}</span>
                    <span>Unveränderte Zeilen</span>
                    <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{fbValidation.unchangedCount}</span>
                    <span>Stornierte (unverändert)</span>
                    <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{fbValidation.canceledCount}</span>
                    <span>Nicht zuordenbare Zeilen</span>
                    <span className="font-medium" style={{ color: fbValidation.unassignedCount > 0 ? '#92400e' : 'var(--text-primary)' }}>{fbValidation.unassignedCount}</span>
                  </div>
                  {fbValidation.ok && (
                    <div className="mt-1 font-medium" style={{ color: '#047857' }}>
                      Fahrtenbuch vollständig geprüft.
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* ── Per-driver PDF list ───────────────────────────────────────── */}
            <div className="px-6 py-4 space-y-2">
              {results.map(r => {
                const canExport = isExportable(r, inhaberGeneratePdf);
                return (
                  <div key={r.driverId}
                    className="flex items-center justify-between px-4 py-3 rounded-xl"
                    style={{
                      background: r.isOwner ? 'rgba(16,185,129,0.06)' : 'var(--bg-subtle)',
                      border: `1px solid ${r.isOwner ? 'rgba(16,185,129,0.2)' : 'var(--border)'}`,
                      opacity: canExport ? 1 : 0.5,
                    }}>
                    <div>
                      <div className="font-medium text-sm flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                        {r.driverName}
                        {r.isOwner && (
                          <span className="text-xs px-1.5 py-0.5 rounded-full"
                            style={{ background: 'rgba(16,185,129,0.12)', color: '#047857' }}>
                            Inhaber
                          </span>
                        )}
                      </div>
                      <div className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                        Ist: {(r.totals.grundlohn / 60).toFixed(2).replace('.', ',')}h
                        {r.ausgleichMinutes > 0 && (
                          <> + Ausgleich: {(r.ausgleichMinutes / 60).toFixed(2).replace('.', ',')}h</>
                        )}
                        {' = '}
                        {((r.totals.grundlohn + r.ausgleichMinutes) / 60).toFixed(2).replace('.', ',')}h
                        {r.hourlyCents > 0 && (
                          <> · Brutto: {centsToDisplay(r.finalGrossCents)} €</>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={() => handleExport(r)}
                      disabled={!canExport || exporting}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all hover:opacity-80 disabled:opacity-40"
                      style={{ background: 'var(--accent, #06b6d4)', color: '#fff' }}
                    >
                      <Download size={12} /> PDF
                    </button>
                  </div>
                );
              })}
            </div>

            {exportError && (
              <div className="mx-6 mb-4 px-4 py-3 rounded-xl flex items-center gap-2 text-sm"
                style={{ background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.2)', color: '#b91c1c' }}>
                <AlertTriangle size={14} /> {exportError}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
