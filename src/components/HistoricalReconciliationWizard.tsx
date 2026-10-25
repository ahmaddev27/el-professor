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

import { importsAreSimulated } from '../utils/simulatedRides/importMarker';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, ArrowRight, Calculator, CheckCircle2, AlertTriangle,
  Download, FileText, RefreshCw, Users, Clock, Info, Save,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
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
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';

// ── Constants ─────────────────────────────────────────────────────────────────

// There are deliberately two month-name tables.
//
// MONTHS_DE is document text: it names the Stundennachweis PDF and the edited
// Fahrtenbuch XLSX handed to the Steuerberater, so it must stay German in both
// UI languages and must never be routed through the dictionary.
const MONTHS_DE = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

// MONTH_NAME_KEYS is the screen-text counterpart, used for the month picker and
// the step headings. It holds TranslationKeys because this list is module-level
// and t() is a hook value; every consumer resolves it at the call site.
const MONTH_NAME_KEYS: TranslationKey[] = [
  'doc.month.january',   'doc.month.february', 'doc.month.march',    'doc.month.april',
  'doc.month.may',       'doc.month.june',     'doc.month.july',     'doc.month.august',
  'doc.month.september', 'doc.month.october',  'doc.month.november', 'doc.month.december',
];

// Document text: the only consumer is PdfDayRow.weekday, which is printed into
// the Stundennachweis PDF. It never reaches the screen.
const WEEKDAY_SHORT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

// Result-table column headers, resolved with t() where the table is rendered.
const RESULT_COLUMN_KEYS: TranslationKey[] = [
  'common.driver', 'rec2.colActualHours', 'rec2.colActualBaseWage', 'rec2.colActualPremiums',
  'rec2.colActualGross', 'rec2.colBalancingHours', 'rec2.colFinalGross', 'rec2.colTargetGross',
  'common.status',
];

/**
 * An export failure whose message is already a complete, user-facing sentence.
 * Other failures get wrapped with a prefix; this marker replaces a substring
 * check against German text, which would have broken under translation.
 */
class PreformattedExportError extends Error {}

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
  const f = timeToMinutes(from), endMin = timeToMinutes(to);
  const absTo = endMin >= f ? endMin : endMin + 1440;
  const seg1 = Math.max(0, Math.min(absTo, 24 * 60) - Math.max(f, 20 * 60));
  const seg2 = Math.max(0, Math.min(absTo, 30 * 60) - Math.max(f, 24 * 60));
  return seg1 + seg2;
}

function night0to4MinsForSeg(from: string, to: string): number {
  if (!from || !to) return 0;
  const f = timeToMinutes(from), endMin = timeToMinutes(to);
  const absTo = endMin >= f ? endMin : endMin + 1440;
  const seg1 = Math.max(0, Math.min(absTo, 240) - Math.max(f, 0));
  const seg2 = Math.max(0, Math.min(absTo, 1680) - Math.max(f, 1440));
  return seg1 + seg2;
}

function segDuration(from: string, to: string): number {
  if (!from || !to) return 0;
  const startMin = timeToMinutes(from), endMin = timeToMinutes(to);
  return endMin >= startMin ? endMin - startMin : 1440 - startMin + endMin;
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
  const trimmed = s.trim();
  if (!trimmed) return null;
  const normalized = trimmed.includes(',')
    ? trimmed.replace(/\./g, '').replace(',', '.')
    : trimmed;
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
  for (const trip of trips) {
    const segs = normalizeTripServiceDate(trip);
    for (const seg of segs) {
      if (!byDate.has(seg.serviceDate)) byDate.set(seg.serviceDate, []);
      byDate.get(seg.serviceDate)!.push(trip);
    }
  }

  const blocks: DayBlock[] = [];
  for (const [date, dayTrips] of byDate) {
    const unique = Array.from(new Map(dayTrips.map(trip => [trip.id, trip])).values());
    let minStart = Infinity, maxEnd = -Infinity;
    for (const trip of unique) {
      const sm = timeToMinutes(trip.start_time);
      const em = timeToMinutes(trip.end_time);
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
  for (const trip of trips) {
    const segs = normalizeTripServiceDate(trip);
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
  const { effectiveCompanyId: companyId } = useSuperAdmin();
  const { t } = useTranslation();
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
        for (const trip of data ?? []) {
          if (trip.original_driver_id) ids.add(trip.original_driver_id);
          if (trip.original_driver_name && !names.includes(trip.original_driver_name)) {
            names.push(trip.original_driver_name);
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
    const timer = setTimeout(() => saveInhaberConfig(reconciliationId), AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
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
      if (included.length === 0) throw new Error(t('rec2.errNoDriversSelected'));

      const allTrips = await fetchAllTrips(companyId, selectedImportId);
      const holidays = getHolidaysForYear(year);

      const driverTrips = new Map<string, FahrtenbuchTrip[]>();

      for (const cfg of included) driverTrips.set(cfg.driverId, []);
      const ownerCfg: DriverConfig | null = useInhaber && inhaberId
        ? {
            driverId: inhaberId,
            // Stays German: this name is written into the edited Fahrtenbuch
            // XLSX as the Fahrername, so it is document text, not a label.
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
            const { totals } = buildDriverPdfRows(driverTrips.get(cfg.driverId) ?? [], cfg.driverId, month, year, holidays);
            return computeGrossBreakdown(totals, cfg.hourlyCents).grossCents;
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
                t('rec2.unmovableOwnerOverlap', { driver: cfg.driverName, date: block.date }),
              );
              continue;
            }

            const tripIds = new Set(block.trips.map(trip => trip.id));
            const remaining = (driverTrips.get(cfg.driverId) ?? []).filter(trip => !tripIds.has(trip.id));
            driverTrips.set(cfg.driverId, remaining);

            const ownerTrips = driverTrips.get(ownerCfg.driverId) ?? [];
            for (const trip of block.trips) {
              if (!ownerTrips.find(ot => ot.id === trip.id)) ownerTrips.push(trip);
            }
            driverTrips.set(ownerCfg.driverId, ownerTrips);

            for (const trip of block.trips) {
              const segs = normalizeTripServiceDate(trip);
              for (const seg of segs) {
                if (!ownerOccupied.has(seg.serviceDate)) ownerOccupied.set(seg.serviceDate, []);
                ownerOccupied.get(seg.serviceDate)!.push({ startMin: seg.startMinutes, endMin: seg.endMinutes });
              }
            }

            const blockMins = block.trips.reduce((acc, trip) => {
              const segs = normalizeTripServiceDate(trip);
              return acc + segs.reduce((s, seg) => s + (seg.endMinutes - seg.startMinutes), 0);
            }, 0);
            diag.movedGroups++;
            diag.movedMinutes += blockMins;

            currentGross = (() => {
              const { totals } = buildDriverPdfRows(driverTrips.get(cfg.driverId) ?? [], cfg.driverId, month, year, holidays);
              return computeGrossBreakdown(totals, cfg.hourlyCents).grossCents;
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
          // Document text: this label is printed in the Stundennachweis PDF's
          // correction table.
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
      setComputeError(e instanceof Error ? e.message : t('rec2.errComputeFailed'));
    } finally {
      setComputing(false);
    }
  }, [companyId, selectedImportId, driverConfigs, allDrivers, month, year, useInhaber, inhaberId, reconciliationId, t]);

  // ── Export helpers ─────────────────────────────────────────────────────────

  // Document text: the whole filename, including the fallback name and the
  // German month, identifies the Stundennachweis PDF for the Steuerberater.
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
        throw new Error(t('rec2.errNoTripsInImport'));
      }

      const { data: importMeta } = await supabase
        .from('fahrtenbuch_imports')
        .select('source_columns_json, source_sheet_name, row_count')
        .eq('id', selectedImportId)
        .maybeSingle();

      // Validate row count against stored import metadata
      const storedRowCount: number | null = (importMeta as { row_count?: number } | null)?.row_count ?? null;
      if (storedRowCount !== null && allTrips.length !== storedRowCount) {
        throw new PreformattedExportError(
          t('rec2.errRowCountMismatch', { original: storedRowCount, exported: allTrips.length }),
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
        // Document text: names the Fahrtenbuch XLSX handed to the Steuerberater.
        importFileName: `Historischer_Abgleich_Fahrtenbuch_${MONTHS_DE[month - 1]}_${year}.xlsx`,
        sourceColumns,
        sourceSheetName: importMeta?.source_sheet_name ?? null,
        skipSort: true,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : t('rec2.errUnknown');
      setExportError(e instanceof PreformattedExportError
        ? msg
        : t('rec2.errFahrtenbuchExport', { message: msg }));
    } finally {
      setExportingFahrtenbuch(false);
    }
  }, [companyId, selectedImportId, tripAssignments, month, year, t]);

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
          simulated: await importsAreSimulated([selectedImportId]),
        }, filename);
        // Small delay between downloads so browsers don't block them
        await new Promise(res => setTimeout(res, 200));
      } catch {
        failed.push(r.driverName);
      }
    }
    if (failed.length > 0) {
      setExportError(t('rec2.errPdfExportList', {
        list: failed.map(n => t('rec2.errPdfExportFor', { driver: n })).join('; '),
      }));
    }
    setExportingAllPdfs(false);
  }, [results, month, year, inhaberGeneratePdf, t]);

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
            // Document text: names the Fahrtenbuch XLSX handed to the Steuerberater.
            importFileName: `Historischer_Abgleich_Fahrtenbuch_${MONTHS_DE[month - 1]}_${year}.xlsx`,
            sourceColumns: Array.isArray(importMeta?.source_columns_json)
              ? (importMeta.source_columns_json as string[])
              : null,
            sourceSheetName: importMeta?.source_sheet_name ?? null,
            skipSort: true,
          });
        }
      } catch {
        setExportError(t('rec2.errFahrtenbuchExportFailed'));
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
          simulated: await importsAreSimulated([selectedImportId]),
        }, filename);
        await new Promise(res => setTimeout(res, 200));
      } catch {
        failed.push(r.driverName);
      }
    }
    if (failed.length > 0) {
      setExportError(t('rec2.errPdfExportList', {
        list: failed.map(n => t('rec2.errPdfExportFor', { driver: n })).join('; '),
      }));
    }
    setExportingAll(false);
  }, [results, companyId, selectedImportId, tripAssignments, month, year, inhaberGeneratePdf, t]);

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
        simulated: await importsAreSimulated([selectedImportId]),
      }, filename);
    } catch (e) {
      const msg = e instanceof Error ? e.message : t('rec2.errUnknown');
      setExportError(t('rec2.errPdfExportForWithReason', { driver: r.driverName, message: msg }));
    } finally {
      setExporting(false);
    }
  }, [month, year, t]);

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
  const monthLabel = t(MONTH_NAME_KEYS[month - 1]);

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
          {t('rec2.ownerBalancingDriver')}
        </span>
      );
    }
    if (r.missingHourlyRate) {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold"
          style={{ background: 'rgba(220,38,38,0.1)', color: '#b91c1c' }}>
          <AlertTriangle size={11} /> {t('rec2.badgeMissingHourlyRate')}
        </span>
      );
    }
    if (r.overTarget) {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold"
          style={{ background: 'rgba(220,38,38,0.1)', color: '#b91c1c' }}>
          <AlertTriangle size={11} /> {t('rec2.badgeOverTarget')}
        </span>
      );
    }
    if (!r.isOwner && !r.overTarget && !r.noTarget && r.targetGrossCents > 0
      && r.finalGrossCents !== r.targetGrossCents) {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold"
          style={{ background: 'rgba(234,179,8,0.1)', color: '#a16207' }}>
          <AlertTriangle size={11} /> {t('rec2.badgeDifference')}
        </span>
      );
    }
    if (r.ausgleichMinutes > 0) {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold"
          style={{ background: 'rgba(124,58,237,0.1)', color: '#6d28d9' }}>
          <CheckCircle2 size={11} /> {t('rec2.badgeBalancingNeeded')}
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold"
        style={{ background: 'rgba(21,128,61,0.1)', color: '#15803d' }}>
        <CheckCircle2 size={11} /> {t('rec2.badgeTargetReached')}
      </span>
    );
  }

  // ── Autosave status badge ──────────────────────────────────────────────────

  function SaveBadge() {
    if (saveStatus === 'idle') return null;
    const cfg = ({
      saving:  { label: 'common.saving',          color: '#6b7280' },
      saved:   { label: 'rec2.saveStatusSaved',   color: '#15803d' },
      unsaved: { label: 'rec2.saveStatusUnsaved', color: '#b45309' },
    } as const)[saveStatus];
    if (!cfg) return null;
    return (
      <span className="inline-flex items-center gap-1 text-xs" style={{ color: cfg.color }}>
        <Save size={11} />
        {t(cfg.label)}
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
          {step === 0 ? t('rec2.backToSelection') : t('common.back')}
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
                <h2 className="font-bold text-base" style={{ color: 'var(--text-primary)' }}>{t('rec2.step1Title')}</h2>
                <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{t('rec2.step1Subtitle')}</p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-tertiary)' }}>{t('common.month')}</label>
                <select
                  value={month}
                  onChange={e => setMonth(Number(e.target.value))}
                  className="w-full px-3 py-2.5 rounded-xl text-sm focus:outline-none"
                  style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                >
                  {MONTH_NAME_KEYS.map((key, i) => <option key={key} value={i + 1}>{t(key)}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-tertiary)' }}>{t('rec2.year')}</label>
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
                <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-tertiary)' }}>{t('rec2.fahrtenbuchImport')}</label>
                <select
                  value={selectedImportId}
                  onChange={e => setSelectedImportId(e.target.value)}
                  disabled={loadingImports || imports.length === 0}
                  className="w-full px-3 py-2.5 rounded-xl text-sm focus:outline-none"
                  style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                >
                  {imports.length === 0 ? (
                    <option value="">{t('rec2.noImportForMonth', { month: monthLabel, year })}</option>
                  ) : imports.map(i => (
                    <option key={i.id} value={i.id}>
                      {t('rec2.importOption', {
                        fileName: i.file_name,
                        rows: i.row_count,
                        date: new Date(i.imported_at).toLocaleDateString('de-DE'),
                      })}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {imports.length === 0 && !loadingImports && (
              <div className="mt-4 px-4 py-3 rounded-xl flex items-center gap-2 text-sm"
                style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)', color: '#b45309' }}>
                <AlertTriangle size={14} />
                {t('rec2.noImportHint', { month: monthLabel, year })}
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
              {t('rec2.next')} <ArrowRight size={15} />
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
                    <h2 className="font-bold text-base" style={{ color: 'var(--text-primary)' }}>{t('rec2.step2Title')}</h2>
                    <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                      {monthLabel} {year} · {selectedImport?.file_name}
                    </p>
                  </div>
                </div>
              </div>
            </div>

            <div className="px-6 pt-3 pb-1">
              <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                {t('rec2.hourlyRateHint')}
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
                        {t('rec2.colDriverEmployed')}
                      </label>
                    </th>
                    <th className="px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)', minWidth: 140 }}>
                      {t('rec2.colHourlyRateEur')}
                    </th>
                    <th className="px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)', minWidth: 160 }}>
                      {t('rec2.colTargetGrossEur')}
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
                        {t('rec2.noEmployedDrivers')}
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
              {t('rec2.ownerBalancingDriver')}
            </h3>
            <p className="text-xs mb-4" style={{ color: 'var(--text-tertiary)' }}>
              {t('rec2.ownerBalancingHint')}
            </p>

            {ownerDrivers.length === 0 && (
              <div className="mb-4 px-4 py-3 rounded-xl flex items-center gap-2 text-sm"
                style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)', color: '#b45309' }}>
                <AlertTriangle size={14} />
                {t('rec2.noOwnerFound')}
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
                  {t('rec2.useOwnerAsBalancingDriver')}
                </span>
              </label>

              {useInhaber && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pl-6">
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-tertiary)' }}>
                      {t('rec2.selectOwner')}
                    </label>
                    <select
                      value={inhaberId}
                      onChange={e => setInhaberId(e.target.value)}
                      className="w-full px-3 py-2 rounded-xl text-sm focus:outline-none"
                      style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                    >
                      <option value="">{t('rec2.pleaseSelect')}</option>
                      {ownerDrivers.map(d => (
                        <option key={d.id} value={d.id}>{t('rec2.driverIsOwnerOption', { name: d.name })}</option>
                      ))}
                      {regularDrivers.filter(d => !driverConfigs.find(c => c.driverId === d.id)?.included).map(d => (
                        <option key={d.id} value={d.id}>{d.name}</option>
                      ))}
                    </select>
                    {inhaberId && (
                      <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
                        {t('rec2.balancingDriverIs', { name: inhaberDriver?.name ?? '' })}
                      </p>
                    )}
                  </div>
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-tertiary)' }}>
                      {t('rec2.ownerTargetGross')}
                    </label>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="text" inputMode="decimal" placeholder={t('rec2.noLimitPlaceholder')}
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
                      {t('rec2.ownerTargetGrossHint')}
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
                    {t('rec2.createOwnerStundennachweis')}
                  </span>
                </label>
              )}
            </div>
          </div>

          {!step1Valid && includedCount > 0 && (
            <div className="px-4 py-3 rounded-xl flex items-center gap-2 text-sm"
              style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)', color: '#b45309' }}>
              <AlertTriangle size={14} />
              {t('rec2.enterRateAndTarget')}
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
              {t('rec2.nextToCalculation')} <ArrowRight size={15} />
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
                <h2 className="font-bold text-base" style={{ color: 'var(--text-primary)' }}>{t('rec2.step3Title')}</h2>
                <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                  {t('rec2.step3Subtitle')}
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
                      {t('rec2.rateAndTargetSummary', {
                        rate: centsToDisplay(cfg.hourlyCents),
                        target: centsToDisplay(cfg.targetGrossCents),
                      })}
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
                      {inhaberDriver?.name ?? t('rec2.owner')}
                    </span>
                    <span className="text-xs ml-2" style={{ color: '#15803d' }}>{t('rec2.balancingDriver')}</span>
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
                  <strong>{t('rec2.ownerRepairActiveTitle')}</strong>{' '}
                  {t('rec2.ownerRepairActiveBody', { name: inhaberDriver?.name ?? t('rec2.owner') })}
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
              {computing ? t('rec2.calculating') : t('rec2.calculateNow')}
            </button>
          </div>
        </div>
      )}

      {/* ── Step 3: Ergebnis prüfen ────────────────────────────────────────── */}
      {step === 3 && results && (
        <div className="space-y-5">
          {repairDiag && useInhaber && inhaberId && (
            <div className="rounded-2xl p-5" style={{ background: 'rgba(124,58,237,0.05)', border: '1px solid rgba(124,58,237,0.2)' }}>
              <h3 className="font-bold text-sm mb-3" style={{ color: '#6d28d9' }}>{t('rec2.ownerBalancing')}</h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div>
                  <div className="text-xs uppercase tracking-wider font-semibold mb-1" style={{ color: 'var(--text-tertiary)' }}>{t('rec2.movedGroups')}</div>
                  <div className="text-xl font-bold" style={{ color: '#7c3aed' }}>{repairDiag.movedGroups}</div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-wider font-semibold mb-1" style={{ color: 'var(--text-tertiary)' }}>{t('rec2.movedTime')}</div>
                  <div className="text-xl font-bold" style={{ color: '#7c3aed' }}>
                    {(repairDiag.movedMinutes / 60).toFixed(2).replace('.', ',')} h
                  </div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-wider font-semibold mb-1" style={{ color: 'var(--text-tertiary)' }}>{t('rec2.reducedOverTarget')}</div>
                  <div className="text-xl font-bold" style={{ color: '#15803d' }}>{repairDiag.reducedOverTargetCount}</div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-wider font-semibold mb-1" style={{ color: 'var(--text-tertiary)' }}>{t('rec2.unmovable')}</div>
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
                    <div className="font-semibold">{t('rec2.unmovableNonBlockingTitle')}</div>
                    <div className="mt-0.5 text-xs opacity-80">
                      {t('rec2.unmovableNonBlockingBody')}
                    </div>
                  </div>
                </div>
              )}

              {unmovableIsBlocking && (
                <div className="mt-3 px-4 py-3 rounded-xl flex items-start gap-2 text-sm"
                  style={{ background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.2)', color: '#b91c1c' }}>
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                  <div>
                    <div className="font-semibold">{t('rec2.unmovableBlockingTitle')}</div>
                    <div className="mt-0.5 text-xs opacity-80">
                      {t('rec2.unmovableBlockingBody')}
                    </div>
                  </div>
                </div>
              )}

              {repairDiag.unmovableReasons.length > 0 && (
                <details className="mt-3">
                  <summary className="text-xs cursor-pointer" style={{ color: 'var(--text-tertiary)' }}>
                    {t('rec2.unmovableGroupsCount', { count: repairDiag.unmovableReasons.length })}
                  </summary>
                  <ul className="mt-2 space-y-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
                    {repairDiag.unmovableReasons.slice(0, 20).map((r, i) => (
                      <li key={i}>• {r} — {unmovableIsBlocking ? t('rec2.exportBlocker') : t('rec2.notExportBlocker')}</li>
                    ))}
                    {repairDiag.unmovableReasons.length > 20 && (
                      <li>{t('rec2.andMore', { count: repairDiag.unmovableReasons.length - 20 })}</li>
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
                  <h2 className="font-bold text-base" style={{ color: 'var(--text-primary)' }}>{t('rec2.step4Title')}</h2>
                  <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                    {monthLabel} {year} · {t('rec2.exportableCount', { count: exportableResults.length })}
                    {blockedResults.length > 0 ? t('rec2.blockedCountSuffix', { count: blockedResults.length }) : ''}
                  </p>
                </div>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ background: 'var(--bg-subtle)' }}>
                    {RESULT_COLUMN_KEYS.map(h => (
                      <th key={h} className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wider whitespace-nowrap" style={{ color: 'var(--text-tertiary)' }}>
                        {t(h)}
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
                                  {t('rec2.owner')}
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
                                {t('rec2.grossBreakdownFor', { driver: r.driverName })}
                              </div>
                              <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-xs max-w-xl" style={{ color: 'var(--text-secondary)' }}>
                                {([
                                  ['rec2.breakdownBaseWage',   `${r.historicalGrossReconciliation.grundlohnH.toFixed(2).replace('.', ',')}h`, `${centsToDisplay(r.historicalGrossReconciliation.grundlohnCents)} €`],
                                  ['rec2.breakdownNight25',    `${r.historicalGrossReconciliation.nachtarbeitH.toFixed(2).replace('.', ',')}h`, `${centsToDisplay(r.historicalGrossReconciliation.nachtarbeitCents)} €`],
                                  ['rec2.breakdownNight04',    `${r.historicalGrossReconciliation.nacht04H.toFixed(2).replace('.', ',')}h`, `${centsToDisplay(r.historicalGrossReconciliation.nacht04Cents)} €`],
                                  ['rec2.breakdownSunday50',   `${r.historicalGrossReconciliation.sonntagH.toFixed(2).replace('.', ',')}h`, `${centsToDisplay(r.historicalGrossReconciliation.sonntagCents)} €`],
                                  ['rec2.breakdownHoliday100', `${r.historicalGrossReconciliation.feiertagH.toFixed(2).replace('.', ',')}h`, `${centsToDisplay(r.historicalGrossReconciliation.feiertagCents)} €`],
                                  ['rec2.breakdownBalancing',  `${r.historicalGrossReconciliation.ausgleichH.toFixed(2).replace('.', ',')}h`, `${centsToDisplay(r.historicalGrossReconciliation.ausgleichCents)} €`],
                                ] as const).map(([labelKey, hours, amount]) => (
                                  <React.Fragment key={labelKey}>
                                    <span>{t(labelKey)}</span>
                                    <span className="font-mono text-right" style={{ color: 'var(--text-primary)' }}>
                                      {hours} · {amount}
                                    </span>
                                  </React.Fragment>
                                ))}
                                <span className="font-semibold pt-1 border-t" style={{ color: 'var(--text-primary)', borderColor: 'var(--border)' }}>{t('rec2.colFinalGross')}</span>
                                <span className="font-semibold font-mono text-right pt-1 border-t" style={{ color: 'var(--text-primary)', borderColor: 'var(--border)' }}>
                                  {centsToDisplay(r.historicalGrossReconciliation.finalGrossCents)} €
                                </span>
                                <span style={{ color: 'var(--text-secondary)' }}>{t('rec2.advisorTargetGross')}</span>
                                <span className="font-mono text-right" style={{ color: 'var(--text-secondary)' }}>
                                  {r.historicalGrossReconciliation.targetGrossCents > 0 ? `${centsToDisplay(r.historicalGrossReconciliation.targetGrossCents)} €` : '—'}
                                </span>
                                <span style={{ color: 'var(--text-secondary)' }}>{t('rec2.difference')}</span>
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
                <span className="font-semibold">{t('rec2.blockedDrivers', { count: blockedResults.length })}</span>
                {blockedResults.filter(r => r.overTarget).length > 0 && (
                  <> {t('rec2.blockedOverTarget', { names: blockedResults.filter(r => r.overTarget).map(r => r.driverName).join(', ') })}</>
                )}
                {blockedResults.filter(r => r.missingHourlyRate).length > 0 && (
                  <> {t('rec2.blockedMissingRate', { names: blockedResults.filter(r => r.missingHourlyRate).map(r => r.driverName).join(', ') })}</>
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
              {t('rec2.nextToDocuments')} <ArrowRight size={15} />
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
                  <h2 className="font-bold text-base" style={{ color: 'var(--text-primary)' }}>{t('rec2.step5Title')}</h2>
                  <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                    {t('rec2.step5Subtitle', { month: monthLabel, year })}
                  </p>
                </div>
              </div>
            </div>

            {/* ── Export actions ────────────────────────────────────────────── */}
            <div className="px-6 py-4 border-b" style={{ borderColor: 'var(--border)', background: 'var(--bg-subtle)' }}>
              <div className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-tertiary)' }}>
                {t('rec2.export')}
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
                  {exportingFahrtenbuch ? t('rec2.creatingFahrtenbuch') : t('rec2.editedFahrtenbuch')}
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
                    ? t('rec2.creatingStundennachweise')
                    : t('rec2.allStundennachweise', { count: exportableResults.length })}
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
                  {exportingAll ? t('rec2.preparingExport') : t('rec2.downloadAll')}
                </button>
              </div>

              {!tripAssignments && (
                <p className="mt-2 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                  {t('rec2.fahrtenbuchExportAfterCalc')}
                </p>
              )}

              {fbValidation && (
                <div className="mt-3 px-4 py-3 rounded-xl text-xs space-y-1"
                  style={{ background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.18)' }}>
                  <div className="font-semibold mb-1" style={{ color: '#047857' }}>
                    {t('rec2.fahrtenbuchCheck')}
                  </div>
                  <div className="grid grid-cols-2 gap-x-6 gap-y-0.5" style={{ color: 'var(--text-secondary)' }}>
                    <span>{t('rec2.checkOriginalRows')}</span>
                    <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{fbValidation.originalCount}</span>
                    <span>{t('rec2.checkExportRows')}</span>
                    <span className="font-medium" style={{ color: fbValidation.exportCount === fbValidation.originalCount ? 'var(--text-primary)' : '#b91c1c' }}>{fbValidation.exportCount}</span>
                    <span>{t('rec2.checkRowOrder')}</span>
                    <span className="font-medium" style={{ color: fbValidation.reihenfolgeOk ? '#047857' : '#b91c1c' }}>
                      {fbValidation.reihenfolgeOk ? t('rec2.ok') : t('rec2.deviation')}
                    </span>
                    <span>{t('rec2.checkChangedAssignments')}</span>
                    <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{fbValidation.changedCount}</span>
                    <span>{t('rec2.checkUnchangedRows')}</span>
                    <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{fbValidation.unchangedCount}</span>
                    <span>{t('rec2.checkCanceledRows')}</span>
                    <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{fbValidation.canceledCount}</span>
                    <span>{t('rec2.checkUnassignedRows')}</span>
                    <span className="font-medium" style={{ color: fbValidation.unassignedCount > 0 ? '#92400e' : 'var(--text-primary)' }}>{fbValidation.unassignedCount}</span>
                  </div>
                  {fbValidation.ok && (
                    <div className="mt-1 font-medium" style={{ color: '#047857' }}>
                      {t('rec2.fahrtenbuchFullyChecked')}
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
                            {t('rec2.owner')}
                          </span>
                        )}
                      </div>
                      <div className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                        {t('rec2.actualHoursValue', { hours: (r.totals.grundlohn / 60).toFixed(2).replace('.', ',') })}
                        {r.ausgleichMinutes > 0 && (
                          <> {t('rec2.plusBalancingValue', { hours: (r.ausgleichMinutes / 60).toFixed(2).replace('.', ',') })}</>
                        )}
                        {' = '}
                        {((r.totals.grundlohn + r.ausgleichMinutes) / 60).toFixed(2).replace('.', ',')}h
                        {r.hourlyCents > 0 && (
                          <> {t('rec2.grossValue', { amount: centsToDisplay(r.finalGrossCents) })}</>
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
