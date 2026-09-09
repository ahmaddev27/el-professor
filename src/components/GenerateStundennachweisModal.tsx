import React, { useState, useEffect, useCallback } from 'react';
import {
  X, Clock, AlertTriangle, CheckCircle, ChevronDown, ChevronUp,
  FileText, Users, User, Download, ExternalLink, Loader2, Info,
  Car as CarIcon,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useCompanySettings } from '../contexts/CompanySettingsContext';
import { FahrtenbuchTrip } from '../hooks/useFahrtenbuch';
import {
  BLOCK_SEPARATOR_GAP_MINUTES, BUFFER_MIN_MINUTES, BUFFER_MAX_MINUTES,
  timeToMinutes, minutesToTime,
  normalizeTripServiceDate,
  groupRidesIntoBlocks, mergeBlocksIfNeeded,
  detectOverlaps, detectTransferWarnings, checkRidesOutsidePreferredWindow,
  validateCoverage, buildCoverageSummary, insertPflichtnotiz,
  extendShiftsForSalary,
  enforceBlockCoverageInvariant,
  detectAndSplitLongShifts,
  summarizeTransferWarnings,
  compressSchichtenByDate,
  type NormalizedTrip, type DriverShiftConfig, type OverlapWarning,
  type TransferWarning, type WindowWarning, type CoverageResult, type CoverageSummary,
  type Schicht, type GenerationSettings, type LongShiftWarning, type TransferWarningSummary,
  type SchichtCompressionResult,
} from '../utils/shiftBlockEngine';
import {
  buildCarBlocksFromTrips, resolveCarBlocks,
  buildTripAssignmentMap, validateResolvedFahrtenbuch,
  MIN_VEHICLE_SWITCH_BUFFER_MINUTES,
  type CarBlockResolverResult, type PoolDriver,
  type ResolvedFahrtenbuchValidation,
} from '../utils/carBlockResolver';

// ─── Constants ──────────────────────────────────────────────────────────────

const MONTH_NAMES_DE = [
  'Januar', 'Februar', 'Maerz', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

const WEEKDAY_SHORT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

// ─── Types ──────────────────────────────────────────────────────────────────

interface DriverOption {
  id: string;
  name: string;
  personalnummer?: string;
  planning_hourly_rate?: number | null;
  planning_target_salary?: number | null;
  target_monthly_hours?: number | null;
  max_monthly_hours?: number | null;
  work_window_start?: string | null;
  work_window_end?: string | null;
  preferred_shift_start_time?: string | null;
  preferred_shift_end_time?: string | null;
  allow_extra_hours_before_first_ride?: boolean;
  allow_extra_hours_after_last_ride?: boolean;
}

interface DriverNote {
  id: string;
  driver_id: string;
  note_date: string;
  note_text: string;
  note_planning_behavior?: string;
  is_full_day?: boolean;
  start_time?: string | null;
  end_time?: string | null;
  start_date?: string | null;
  end_date?: string | null;
}

interface DayRow {
  dayIndex: number;
  date: Date;
  weekday: string;
  isSat: boolean;
  isSun: boolean;
  isHol: boolean;
  von1: string; bis1: string; bis1Display?: string;
  von2: string; bis2: string; bis2Display?: string;
  von3: string; bis3: string; bis3Display?: string;
  grundlohn: string;
  nachtarbeit: string;
  nachtarbeit04: string;
  samstag: string;
  sonntag: string;
  feiertag: string;
  weihnachten: string;
  noteHighlight: boolean;
}

interface Totals {
  grundlohn: number;
  nachtarbeit: number;
  nacht04: number;
  samstag: number;
  sonntag: number;
  feiertag: number;
  weihnachten: number;
}

interface DriverResult {
  driver: DriverOption;
  rows: DayRow[];
  totals: Totals;
  workingDays: number;
  tripCount: number;
  coverageResults: CoverageResult[];
  coverageSummary: CoverageSummary;
  overlapWarnings: OverlapWarning[];
  transferWarnings: TransferWarning[];
  transferSummary: TransferWarningSummary;
  windowWarnings: WindowWarning[];
  longShiftWarnings: LongShiftWarning[];
  extraMinutesAdded: number;
  generationSettings: GenerationSettings;
  compressionResult: SchichtCompressionResult | null;
  warnings: string[];
  existingRecord: boolean;
  status: 'ready' | 'warnings' | 'conflict';
  hourlyRate: number | null;
  targetSalary: number | null;
  calculatedSalary: number | null;
}

type ExistingBehavior = 'skip' | 'overwrite';

interface Props {
  open: boolean;
  onClose: () => void;
  importId: string;
  month: number;
  year: number;
  importFileName?: string;
  planRunId?: string | null;
}

// ─── Holiday helpers ────────────────────────────────────────────────────────

const BUNDESLAND_ALIASES: Record<string, string> = {
  'BW': 'BW', 'BADEN': 'BW', 'BY': 'BY', 'BAYER': 'BY',
  'BE': 'BE', 'BERLIN': 'BE', 'BB': 'BB', 'BRANDEN': 'BB',
  'HB': 'HB', 'BREMEN': 'HB', 'HH': 'HH', 'HAMBURG': 'HH',
  'HE': 'HE', 'HESSEN': 'HE', 'MV': 'MV', 'MECKLEN': 'MV',
  'NI': 'NI', 'NIEDER': 'NI', 'NW': 'NW', 'NORDRHEIN': 'NW', 'NRW': 'NW',
  'RP': 'RP', 'RHEINLAND': 'RP', 'SL': 'SL', 'SAARLAND': 'SL',
  'SN': 'SN', 'SACHSEN': 'SN', 'ST': 'ST', 'SACHSEN-A': 'ST',
  'SH': 'SH', 'SCHLESWIG': 'SH', 'TH': 'TH', 'THUERINGEN': 'TH',
};

function parseBundesland(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const up = raw.trim().toUpperCase();
  if (up.length <= 3) return BUNDESLAND_ALIASES[up] ?? null;
  for (const [prefix, code] of Object.entries(BUNDESLAND_ALIASES)) {
    if (up.startsWith(prefix)) return code;
  }
  return null;
}

function easterSunday(year: number): Date {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m2 = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m2 + 114) / 31);
  const day = ((h + l - 7 * m2 + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

function getHolidaysForYear(year: number, bl: string | null): Set<string> {
  const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const add = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const easter = easterSunday(year);
  const h = new Set<string>([
    fmt(new Date(year, 0, 1)), fmt(add(easter, -2)), fmt(add(easter, 1)),
    fmt(new Date(year, 4, 1)), fmt(add(easter, 39)), fmt(add(easter, 50)),
    fmt(new Date(year, 9, 3)), fmt(new Date(year, 11, 25)), fmt(new Date(year, 11, 26)),
  ]);
  if (!bl) return h;
  if (['BW', 'BY', 'ST'].includes(bl)) h.add(fmt(new Date(year, 0, 6)));
  if (bl === 'BE' && year >= 2019) h.add(fmt(new Date(year, 2, 8)));
  if (bl === 'BB') h.add(fmt(easter));
  if (['BW', 'BY', 'HE', 'NW', 'RP', 'SL'].includes(bl)) h.add(fmt(add(easter, 60)));
  if (['BY', 'SL'].includes(bl)) h.add(fmt(new Date(year, 7, 15)));
  if (bl === 'TH') h.add(fmt(new Date(year, 8, 20)));
  if (['BB', 'HB', 'HH', 'MV', 'NI', 'SN', 'ST', 'SH', 'TH'].includes(bl)) h.add(fmt(new Date(year, 9, 31)));
  if (['BW', 'BY', 'NW', 'RP', 'SL'].includes(bl)) h.add(fmt(new Date(year, 10, 1)));
  if (bl === 'SN') {
    const nov23 = new Date(year, 10, 23);
    const bbt = add(nov23, -(((nov23.getDay() + 4) % 7) + 1));
    h.add(fmt(bbt));
  }
  return h;
}

// ─── Row / totals / salary helpers ──────────────────────────────────────────

function minutesToHHMM(m: number): string {
  if (m <= 0) return '';
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function nightMinsForSeg(from: string, to: string): number {
  if (!from || !to) return 0;
  const f = timeToMinutes(from), t = timeToMinutes(to);
  const absTo = t >= f ? t : t + 1440;
  const seg1 = Math.max(0, Math.min(absTo, 24 * 60) - Math.max(f, 20 * 60));
  const seg2 = Math.max(0, Math.min(absTo, 30 * 60) - Math.max(f, 24 * 60));
  return seg1 + seg2;
}

function nacht04MinsForSeg(from: string, to: string): number {
  if (!from || !to) return 0;
  const f = timeToMinutes(from), t = timeToMinutes(to);
  const absTo = t >= f ? t : t + 1440;
  const sameDayPart = Math.max(0, Math.min(absTo, 4 * 60) - Math.max(f, 0));
  const crossPart = Math.max(0, Math.min(absTo, 24 * 60 + 4 * 60) - Math.max(f, 24 * 60));
  return sameDayPart + crossPart;
}

function segDuration(from: string, to: string): number {
  if (!from || !to) return 0;
  const f = timeToMinutes(from), t = timeToMinutes(to);
  return t >= f ? t - f : 1440 - f + t;
}

function calcRow(row: DayRow): DayRow {
  const dur1 = segDuration(row.von1, row.bis1);
  const dur2 = segDuration(row.von2, row.bis2);
  const dur3 = segDuration(row.von3, row.bis3);
  const total = dur1 + dur2 + dur3;
  if (total === 0) {
    return { ...row, grundlohn: '', nachtarbeit: '', nachtarbeit04: '', samstag: '', sonntag: '', feiertag: '', weihnachten: '' };
  }
  const nightMins = nightMinsForSeg(row.von1, row.bis1) + nightMinsForSeg(row.von2, row.bis2) + nightMinsForSeg(row.von3, row.bis3);
  const nacht04Mins = nacht04MinsForSeg(row.von1, row.bis1) + nacht04MinsForSeg(row.von2, row.bis2) + nacht04MinsForSeg(row.von3, row.bis3);
  const samstag = (row.isSat && !row.isHol) ? total : 0;
  const sonntag = (row.isSun && !row.isHol) ? total : 0;
  const feiertag = row.isHol ? total : 0;
  const d = row.date;
  const isXmas = (d.getMonth() === 11 && (d.getDate() === 25 || d.getDate() === 26))
    || (d.getMonth() === 4 && d.getDate() === 1);
  const weihnachten = (isXmas && total > 0) ? total : 0;
  return {
    ...row,
    grundlohn: minutesToHHMM(total),
    nachtarbeit: nightMins > 0 ? minutesToHHMM(nightMins) : '',
    nachtarbeit04: nacht04Mins > 0 ? minutesToHHMM(nacht04Mins) : '',
    samstag: samstag > 0 ? minutesToHHMM(samstag) : '',
    sonntag: sonntag > 0 ? minutesToHHMM(sonntag) : '',
    feiertag: feiertag > 0 ? minutesToHHMM(feiertag) : '',
    weihnachten: weihnachten > 0 ? minutesToHHMM(weihnachten) : '',
  };
}

function calcTotals(rows: DayRow[]): Totals {
  const toMins = (t: string) => {
    if (!t || !t.includes(':')) return 0;
    const [h, m] = t.split(':').map(Number);
    return (isNaN(h) || isNaN(m)) ? 0 : h * 60 + m;
  };
  return {
    grundlohn: rows.reduce((s, r) => s + toMins(r.grundlohn), 0),
    nachtarbeit: rows.reduce((s, r) => s + toMins(r.nachtarbeit), 0),
    nacht04: rows.reduce((s, r) => s + toMins(r.nachtarbeit04), 0),
    samstag: rows.reduce((s, r) => s + toMins(r.samstag), 0),
    sonntag: rows.reduce((s, r) => s + toMins(r.sonntag), 0),
    feiertag: rows.reduce((s, r) => s + toMins(r.feiertag), 0),
    weihnachten: rows.reduce((s, r) => s + toMins(r.weihnachten), 0),
  };
}

const PREM_NIGHT = 0.40;
const PREM_SUN = 0.50;
const PREM_HOLIDAY = 1.25;

function calcSalaryEuros(rows: DayRow[], hourlyRate: number): number {
  const hourlyRateCents = Math.round(hourlyRate * 100);
  let totalCents = 0;
  for (const row of rows) {
    const totalMins = timeToMinutes(row.grundlohn);
    if (totalMins === 0) continue;
    totalCents += (totalMins * hourlyRateCents) / 60;
    const nightMins = timeToMinutes(row.nachtarbeit);
    totalCents += (nightMins * hourlyRateCents * Math.round(PREM_NIGHT * 100)) / (60 * 100);
    if (row.isSun && !row.isHol) {
      totalCents += (totalMins * hourlyRateCents * Math.round(PREM_SUN * 100)) / (60 * 100);
    }
    if (row.isHol) {
      totalCents += (totalMins * hourlyRateCents * Math.round(PREM_HOLIDAY * 100)) / (60 * 100);
    }
  }
  return Math.round(totalCents) / 100;
}

// ─── Note helpers ───────────────────────────────────────────────────────────

function noteCoversDate(note: DriverNote, dateStr: string): boolean {
  const sd = note.start_date ?? note.note_date?.split('T')[0];
  const ed = note.end_date ?? sd;
  if (!sd) return false;
  return dateStr >= sd && dateStr <= ed;
}

function isDriverBlockedOnDate(notes: DriverNote[], dateStr: string): string | null {
  for (const note of notes) {
    if (note.note_planning_behavior !== 'exclude_from_plan') continue;
    if (!noteCoversDate(note, dateStr)) continue;
    if (note.is_full_day || (!note.start_time && !note.end_time)) {
      return note.note_text || 'Abwesend';
    }
  }
  return null;
}

// ─── Main Component ─────────────────────────────────────────────────────────

export default function GenerateStundennachweisModal({ open, onClose, importId, month, year, importFileName, planRunId }: Props) {
  const { companyId } = useAuth();
  const { settings: companySettings } = useCompanySettings();
  const bundesland = parseBundesland(companySettings?.state);

  const [phase, setPhase] = useState<'config' | 'preview' | 'saving' | 'done'>('config');
  const [existingBehavior, setExistingBehavior] = useState<ExistingBehavior>('skip');
  const [driverFilter, setDriverFilter] = useState<'all' | 'single'>('all');
  const [selectedDriverId, setSelectedDriverId] = useState<string>('');
  const [forceConfirm, setForceConfirm] = useState(false);

  const [drivers, setDrivers] = useState<DriverOption[]>([]);
  const [results, setResults] = useState<DriverResult[]>([]);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveProgress, setSaveProgress] = useState({ done: 0, total: 0, skipped: 0 });
  const [error, setError] = useState<string | null>(null);
  const [expandedDriver, setExpandedDriver] = useState<string | null>(null);
  const [carResolverResult, setCarResolverResult] = useState<CarBlockResolverResult | null>(null);
  const [fahrtenbuchValidation, setFahrtenbuchValidation] = useState<ResolvedFahrtenbuchValidation | null>(null);
  const [showCarPreview, setShowCarPreview] = useState(false);

  useEffect(() => {
    if (!open || !companyId) return;
    supabase
      .from('drivers')
      .select('id, name, personalnummer, planning_hourly_rate, planning_target_salary, target_monthly_hours, max_monthly_hours, work_window_start, work_window_end, preferred_shift_start_time, preferred_shift_end_time, allow_extra_hours_before_first_ride, allow_extra_hours_after_last_ride')
      .eq('company_id', companyId)
      .eq('status', 'active')
      .order('name')
      .then(({ data }) => setDrivers((data || []) as DriverOption[]));
  }, [open, companyId]);

  useEffect(() => {
    if (open) {
      setPhase('config');
      setResults([]);
      setError(null);
      setForceConfirm(false);
      setSaveProgress({ done: 0, total: 0, skipped: 0 });
      setCarResolverResult(null);
      setFahrtenbuchValidation(null);
      setShowCarPreview(false);
    }
  }, [open]);

  // ── GENERATION ──────────────────────────────────────────────────────────────

  const handleGenerate = useCallback(async () => {
    if (!companyId) return;
    setGenerating(true);
    setError(null);
    try {
      // 1. Load non-canceled trips
      const allTrips: FahrtenbuchTrip[] = [];
      let offset = 0;
      const BATCH = 1000;
      while (true) {
        const { data, error: fetchErr } = await supabase
          .from('fahrtenbuch_trips')
          .select('*')
          .eq('company_id', companyId)
          .eq('import_id', importId)
          .eq('is_canceled', false)
          .order('trip_date')
          .order('start_time', { nullsFirst: false })
          .order('id', { ascending: true })
          .range(offset, offset + BATCH - 1);
        if (fetchErr) throw new Error(fetchErr.message);
        const rows = (data ?? []) as FahrtenbuchTrip[];
        allTrips.push(...rows);
        if (rows.length < BATCH) break;
        offset += BATCH;
      }

      // 2. Load driver notes
      const daysInMonth = new Date(year, month, 0).getDate();
      const dateFrom = `${year}-${String(month).padStart(2, '0')}-01`;
      const dateTo = `${year}-${String(month).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;
      const { data: notesData } = await supabase
        .from('driver_notes')
        .select('id, driver_id, note_date, note_text, note_planning_behavior, is_full_day, start_time, end_time, start_date, end_date')
        .eq('company_id', companyId)
        .or(`note_date.gte.${dateFrom}T00:00:00,start_date.lte.${dateTo}`)
        .or(`note_date.lte.${dateTo}T23:59:59,end_date.gte.${dateFrom}`);
      const allNotes = (notesData || []) as DriverNote[];

      // 3. Check existing records
      const { data: existingData } = await supabase
        .from('saved_stundennachweise')
        .select('driver_id')
        .eq('company_id', companyId)
        .eq('month', month)
        .eq('year', year);
      const existingDriverIds = new Set((existingData || []).map((r: { driver_id: string }) => r.driver_id));

      // 3b. Car block resolution (global driver pool) + validation
      let carResult: CarBlockResolverResult | null = null;
      let validation: ResolvedFahrtenbuchValidation | null = null;
      {
        const { data: carsData } = await supabase
          .from('cars')
          .select('id, kennzeichen')
          .eq('company_id', companyId);

        const carMap = new Map<string, string>();
        for (const c of carsData ?? []) carMap.set(c.id, c.kennzeichen);

        const hasCarTrips = allTrips.some(t => t.car_id);

        if (hasCarTrips && carMap.size > 0) {
          const allNormForCars: NormalizedTrip[] = [];
          for (const trip of allTrips) {
            if (!trip.car_id) continue;
            allNormForCars.push(...normalizeTripServiceDate(trip));
          }

          const carBlocks = buildCarBlocksFromTrips(allNormForCars, carMap);

          const poolDrivers: PoolDriver[] = drivers.map(d => ({
            id: d.id,
            name: d.name,
            hourlyRate: d.planning_hourly_rate ?? null,
            targetSalary: d.planning_target_salary ?? null,
            currentMonthMinutes: 0,
          }));

          carResult = resolveCarBlocks(carBlocks, poolDrivers);

          const assignmentMap = buildTripAssignmentMap(carResult, allNormForCars);
          validation = validateResolvedFahrtenbuch(assignmentMap);
        }
      }
      setCarResolverResult(carResult);
      setFahrtenbuchValidation(validation);

      // 4. Group trips by driver
      const tripsByDriver = new Map<string, { driverName: string; trips: FahrtenbuchTrip[] }>();
      const noDriverTrips: FahrtenbuchTrip[] = [];

      for (const trip of allTrips) {
        const driverId = trip.assigned_driver_id || trip.original_driver_id;
        const driverName = trip.assigned_driver_name || trip.original_driver_name;
        if (!driverId) { noDriverTrips.push(trip); continue; }
        if (!tripsByDriver.has(driverId)) tripsByDriver.set(driverId, { driverName, trips: [] });
        tripsByDriver.get(driverId)!.trips.push(trip);
      }

      const holidays = getHolidaysForYear(year, bundesland);
      const driverResults: DriverResult[] = [];

      const targetDriverIds = driverFilter === 'single' && selectedDriverId
        ? [selectedDriverId]
        : [...tripsByDriver.keys()];

      for (const driverId of targetDriverIds) {
        const entry = tripsByDriver.get(driverId);
        if (!entry) continue;

        const dbDriver = drivers.find(d => d.id === driverId);
        const driver: DriverOption = dbDriver || { id: driverId, name: entry.driverName };
        const driverNotes = allNotes.filter(n => n.driver_id === driverId);

        // 5. Build DriverShiftConfig
        const config: DriverShiftConfig = {
          driverId,
          workWindowStart: dbDriver?.work_window_start ? timeToMinutes(dbDriver.work_window_start) : null,
          workWindowEnd: dbDriver?.work_window_end ? timeToMinutes(dbDriver.work_window_end) : null,
          preferredStart: dbDriver?.preferred_shift_start_time ? timeToMinutes(dbDriver.preferred_shift_start_time) : null,
          preferredEnd: dbDriver?.preferred_shift_end_time ? timeToMinutes(dbDriver.preferred_shift_end_time) : null,
          allowExtraBefore: dbDriver?.allow_extra_hours_before_first_ride ?? true,
          allowExtraAfter: dbDriver?.allow_extra_hours_after_last_ride ?? true,
          targetSalary: dbDriver?.planning_target_salary ?? null,
          hourlyRate: dbDriver?.planning_hourly_rate ?? null,
          targetMonthlyHours: dbDriver?.target_monthly_hours ?? null,
          maxMonthlyHours: dbDriver?.max_monthly_hours ?? null,
        };

        // 6. Normalize trips (cross-midnight splitting + actual start date detection)
        const allNormalized: NormalizedTrip[] = [];
        for (const trip of entry.trips) {
          const segments = normalizeTripServiceDate(trip);
          for (const seg of segments) {
            if (seg.reason === 'actual_start_date_differs') {
              console.log(`[Stundennachweis] Ride ${trip.id} moved: trip_date=${trip.trip_date} -> serviceDate=${seg.serviceDate} (actual start datetime differs)`);
            }
          }
          allNormalized.push(...segments);
        }

        // 7. Group normalized segments by service date
        const segsByDate = new Map<string, NormalizedTrip[]>();
        for (const seg of allNormalized) {
          if (!segsByDate.has(seg.serviceDate)) segsByDate.set(seg.serviceDate, []);
          segsByDate.get(seg.serviceDate)!.push(seg);
        }
        for (const [, segs] of segsByDate) {
          segs.sort((a, b) => a.startMinutes - b.startMinutes);
        }

        // 8. Detect overlaps and transfer warnings (using normalized service dates)
        const overlapWarnings = detectOverlaps(segsByDate);
        const transferWarnings = detectTransferWarnings(segsByDate);
        const windowWarnings = checkRidesOutsidePreferredWindow(segsByDate, config);

        // 9. Build blocks and Schichten per day
        const blockedDates = new Map<string, string>();
        const schichtenByDate = new Map<string, Schicht[]>();

        for (let day = 1; day <= daysInMonth; day++) {
          const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          const blocked = isDriverBlockedOnDate(driverNotes, dateStr);
          if (blocked) {
            blockedDates.set(dateStr, blocked);
            continue;
          }

          const daySegs = segsByDate.get(dateStr);
          if (!daySegs || daySegs.length === 0) continue;

          const blocks = groupRidesIntoBlocks(daySegs, driverId, dateStr);
          const { merged } = mergeBlocksIfNeeded(blocks);

          const schichten: Schicht[] = merged.slice(0, 3).map((b, i) => {
            // Detect cross-midnight: find any seg in this block that is a day-D cross-midnight segment
            const crossSeg = b.tripIds
              .map(sid => daySegs.find(s => s.id === sid))
              .find(s => s?.reason === 'cross_midnight_day_d' && s.crossMidnightActualEndMinutes != null);
            let bisDisplay: string | undefined;
            if (crossSeg && crossSeg.crossMidnightActualEndMinutes != null && crossSeg.crossMidnightNextDate) {
              const endMins = crossSeg.crossMidnightActualEndMinutes;
              const h = Math.floor(endMins / 60);
              const m = endMins % 60;
              const endTimeStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
              const [, mo, dd] = crossSeg.crossMidnightNextDate.split('-');
              bisDisplay = `${endTimeStr}+ (${dd}.${mo}.)`;
            }
            return { von: minutesToTime(b.startMin), bis: minutesToTime(b.endMin), blockIndex: i, bisDisplay };
          });

          schichtenByDate.set(dateStr, schichten);
        }

        // 10. Insert Pflichtnotiz coverage
        const mustNotes = driverNotes.filter(n => n.note_planning_behavior === 'must_include_in_plan');
        for (const mn of mustNotes) {
          const nd = new Date(mn.note_date);
          const noteMin = nd.getHours() * 60 + nd.getMinutes();
          if (noteMin === 0 && !mn.note_date.includes('T')) continue;

          const noteDate = `${nd.getFullYear()}-${String(nd.getMonth() + 1).padStart(2, '0')}-${String(nd.getDate()).padStart(2, '0')}`;
          if (blockedDates.has(noteDate)) continue;

          if (!schichtenByDate.has(noteDate)) schichtenByDate.set(noteDate, []);
          insertPflichtnotiz(schichtenByDate, noteDate, noteMin);
        }

        // 11. Salary-first extension
        let currentTotalMinutes = 0;
        for (const [, shifts] of schichtenByDate) {
          for (const s of shifts) {
            currentTotalMinutes += timeToMinutes(s.bis) - timeToMinutes(s.von);
          }
        }

        const { extraMinutesAdded, warnings: salaryWarnings } = extendShiftsForSalary(
          schichtenByDate, config, currentTotalMinutes, holidays,
        );

        // 11b. Long shift detection + safe break splitting
        const longShiftWarnings = detectAndSplitLongShifts(schichtenByDate, segsByDate);

        // 11c. ENFORCE BLOCK COVERAGE INVARIANT (after all modifications)
        // Ensures every ride segment is inside at least one Schicht.
        enforceBlockCoverageInvariant(schichtenByDate, segsByDate, blockedDates);

        // 11d. Compress Schichten to max 3 per day (display compression)
        const compressionResult = compressSchichtenByDate(schichtenByDate);

        // 12. Generate DayRows from final Schichten (recalculated after all adjustments)
        const rows: DayRow[] = [];
        for (let day = 1; day <= daysInMonth; day++) {
          const date = new Date(year, month - 1, day);
          const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          const dayOfWeek = date.getDay();
          const isSat = dayOfWeek === 6;
          const isSun = dayOfWeek === 0;
          const isHol = holidays.has(dateStr);

          const shifts = schichtenByDate.get(dateStr) ?? [];
          shifts.sort((a, b) => timeToMinutes(a.von) - timeToMinutes(b.von));

          const hasMustNote = mustNotes.some(n => noteCoversDate(n, dateStr));

          const baseRow: DayRow = {
            dayIndex: day, date,
            weekday: WEEKDAY_SHORT[dayOfWeek],
            isSat, isSun, isHol,
            von1: shifts[0]?.von ?? '', bis1: shifts[0]?.bis ?? '', bis1Display: shifts[0]?.bisDisplay,
            von2: shifts[1]?.von ?? '', bis2: shifts[1]?.bis ?? '', bis2Display: shifts[1]?.bisDisplay,
            von3: shifts[2]?.von ?? '', bis3: shifts[2]?.bis ?? '', bis3Display: shifts[2]?.bisDisplay,
            grundlohn: '', nachtarbeit: '', nachtarbeit04: '',
            samstag: '', sonntag: '', feiertag: '', weihnachten: '',
            noteHighlight: hasMustNote,
          };
          rows.push(calcRow(baseRow));
        }

        // 13. Validate coverage (AFTER all modifications - single authoritative pass)
        const coverageResults = validateCoverage(segsByDate, schichtenByDate, blockedDates);
        const coverageSummary = buildCoverageSummary(coverageResults);

        // 13b. Build FRESH warnings from scratch (never reuse old warnings)
        const freshWarnings: string[] = [];

        // Overlap warnings
        for (const ow of overlapWarnings) {
          freshWarnings.push(`${ow.date}: Ueberlappende Fahrten ${ow.tripA.start}-${ow.tripA.end} und ${ow.tripB.start}-${ow.tripB.end}`);
        }

        // Transfer warnings (only critical for main warning list)
        const transferSummary = summarizeTransferWarnings(transferWarnings);
        if (transferSummary.criticalCount > 0) {
          for (const tw of transferSummary.topWarnings.filter(w => w.severity === 'critical').slice(0, 5)) {
            freshWarnings.push(`${tw.date}: ${tw.reason} (${tw.fromTrip.end} -> ${tw.toTrip.start})`);
          }
          if (transferSummary.criticalCount > 5) {
            freshWarnings.push(`Weitere ${transferSummary.criticalCount - 5} kritische Transfer-Warnungen`);
          }
        }
        if (transferSummary.warningCount > 0) {
          freshWarnings.push(`${transferSummary.warningCount} knappe Anschlussfahrten (5-10 Min.)`);
        }

        // Window warnings (summarized)
        if (windowWarnings.length > 0) {
          freshWarnings.push(`${windowWarnings.length} Fahrten ausserhalb bevorzugter Arbeitszeit`);
        }

        // Salary warnings
        for (const sw of salaryWarnings) freshWarnings.push(sw);

        // Long shift warnings
        for (const lw of longShiftWarnings) freshWarnings.push(lw.message);

        // Pflichtnotiz warnings
        for (const mn of mustNotes) {
          const nd = new Date(mn.note_date);
          const noteMin = nd.getHours() * 60 + nd.getMinutes();
          if (noteMin === 0 && !mn.note_date.includes('T')) continue;
          const noteDate2 = `${nd.getFullYear()}-${String(nd.getMonth() + 1).padStart(2, '0')}-${String(nd.getDate()).padStart(2, '0')}`;
          const shifts3 = schichtenByDate.get(noteDate2) ?? [];
          const winStart = Math.max(0, noteMin - 30);
          const winEnd = Math.min(1439, noteMin + 30);
          const covered = shifts3.some(s => winStart >= timeToMinutes(s.von) && winEnd <= timeToMinutes(s.bis));
          if (!covered) {
            freshWarnings.push(`${noteDate2}: Pflichtnotiz nicht vollstaendig abgedeckt`);
          }
        }

        // Coverage warnings
        for (const cr of coverageResults) {
          if (cr.status === 'uncovered') {
            freshWarnings.push(`${cr.date}: ${cr.reason}`);
          } else if (cr.status === 'partially_covered') {
            freshWarnings.push(`${cr.date}: ${cr.reason}`);
          }
        }

        // 14. Calculate salary and finalize
        const totals = calcTotals(rows);
        const workingDays = rows.filter(r => r.grundlohn !== '').length;
        const existing = existingDriverIds.has(driverId);

        if (existing) freshWarnings.push('Bestehender Stundennachweis vorhanden');
        if (!dbDriver) freshWarnings.push('Fahrer nicht in aktiver Fahrerliste gefunden');

        const planHourlyRate = config.hourlyRate;
        const planTargetSalary = config.targetSalary;
        const calculatedSalary = planHourlyRate && planHourlyRate > 0
          ? calcSalaryEuros(rows, planHourlyRate)
          : null;

        const genSettings: GenerationSettings = {
          block_separator_gap_minutes: BLOCK_SEPARATOR_GAP_MINUTES,
          buffer_min_minutes: BUFFER_MIN_MINUTES,
          buffer_max_minutes: BUFFER_MAX_MINUTES,
          salary_priority_enabled: !!(planTargetSalary && planTargetSalary > 0),
          target_salary: planTargetSalary,
          target_hours: config.targetMonthlyHours,
          hourly_rate: planHourlyRate,
        };

        const hasUncovered = coverageSummary.uncovered > 0;
        const hasPartial = coverageSummary.partially_covered > 0;
        const hasAbsenceConflict = coverageResults.some(cr => cr.reason.startsWith('Abwesenheit'));

        driverResults.push({
          driver, rows, totals, workingDays,
          tripCount: entry.trips.length,
          coverageResults, coverageSummary,
          overlapWarnings, transferWarnings, transferSummary,
          windowWarnings, longShiftWarnings,
          extraMinutesAdded,
          generationSettings: genSettings,
          compressionResult,
          warnings: freshWarnings,
          existingRecord: existing,
          status: hasAbsenceConflict ? 'conflict'
            : (hasUncovered || hasPartial || overlapWarnings.length > 0 || freshWarnings.length > 0) ? 'warnings'
            : 'ready',
          hourlyRate: planHourlyRate,
          targetSalary: planTargetSalary,
          calculatedSalary,
        });
      }

      driverResults.sort((a, b) => a.driver.name.localeCompare(b.driver.name));

      if (noDriverTrips.length > 0) {
        setError(`${noDriverTrips.length} Fahrten ohne Fahrerzuordnung werden ignoriert.`);
      }

      setResults(driverResults);
      setForceConfirm(false);
      setPhase('preview');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unbekannter Fehler');
    } finally {
      setGenerating(false);
    }
  }, [companyId, importId, month, year, bundesland, drivers, driverFilter, selectedDriverId]);

  // ── SAVE ────────────────────────────────────────────────────────────────────

  const handleSave = useCallback(async () => {
    if (!companyId) return;
    setSaving(true);
    setPhase('saving');
    const toSave = results.filter(r => !(r.existingRecord && existingBehavior === 'skip'));
    setSaveProgress({ done: 0, total: toSave.length, skipped: results.length - toSave.length });

    try {
      for (let i = 0; i < toSave.length; i++) {
        const r = toSave[i];
        const rowsForStorage = r.rows.map(({ date: _date, ...rest }) => ({
          ...rest,
          date_key: `${year}-${String(month).padStart(2, '0')}-${String(rest.dayIndex).padStart(2, '0')}`,
        }));

        const allWarnings = [...r.warnings];

        const { error: upsertErr } = await supabase
          .from('saved_stundennachweise')
          .upsert({
            company_id: companyId,
            driver_id: r.driver.id,
            driver_name: r.driver.name,
            personalnummer: r.driver.personalnummer ?? null,
            month, year,
            grundlohn_min: r.totals.grundlohn,
            nachtarbeit_min: r.totals.nachtarbeit,
            nacht04_min: r.totals.nacht04,
            samstag_min: r.totals.samstag,
            sonntag_min: r.totals.sonntag,
            feiertag_min: r.totals.feiertag,
            weihnachten_min: r.totals.weihnachten,
            working_days: r.workingDays,
            rows_json: rowsForStorage,
            generation_source: 'fahrtenbuch',
            generation_mode: 'fahrtenbuch',
            source_import_id: importId,
            source_run_id: planRunId ?? null,
            generated_at: new Date().toISOString(),
            warnings_json: allWarnings.length > 0 ? allWarnings : null,
            hourly_rate: r.hourlyRate ?? null,
            target_salary: r.targetSalary ?? null,
            calculated_salary: r.calculatedSalary ?? null,
            coverage_summary_json: r.coverageSummary,
            generation_settings_json: r.generationSettings,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'company_id,driver_id,month,year' });

        if (upsertErr) throw new Error(`${r.driver.name}: ${upsertErr.message}`);
        setSaveProgress(prev => ({ ...prev, done: prev.done + 1 }));
      }
      setPhase('done');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Speicherfehler');
      setPhase('preview');
    } finally {
      setSaving(false);
    }
  }, [companyId, results, existingBehavior, importId, month, year, planRunId]);

  if (!open) return null;

  // ── Computed stats ────────────────────────────────────────────────────────

  const totalTrips = results.reduce((s, r) => s + r.tripCount, 0);
  const totalCovered = results.reduce((s, r) => s + r.coverageSummary.fully_covered, 0);
  const totalPartial = results.reduce((s, r) => s + r.coverageSummary.partially_covered, 0);
  const totalUncovered = results.reduce((s, r) => s + r.coverageSummary.uncovered, 0);
  const totalOverlaps = results.reduce((s, r) => s + r.overlapWarnings.length, 0);
  const readyCount = results.filter(r => r.status === 'ready').length;
  const hasUncoveredTrips = totalUncovered > 0;
  const fahrtenbuchNotClean = fahrtenbuchValidation != null && !fahrtenbuchValidation.isClean;
  const canSave = results.length > 0 && (!hasUncoveredTrips || forceConfirm) && !fahrtenbuchNotClean;

  const fmtMins = (m: number) => {
    const h = Math.floor(m / 60);
    const min = m % 60;
    return `${h}:${String(min).padStart(2, '0')}`;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.5)' }}>
      <div className="w-full max-w-3xl rounded-2xl overflow-hidden flex flex-col" style={{
        background: 'var(--bg-surface)', border: '1px solid var(--border)',
        maxHeight: '90vh', boxShadow: '0 25px 50px -12px rgba(0,0,0,0.25)',
      }}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom: '1px solid var(--border)' }}>
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: 'var(--accent-subtle)' }}>
              <Clock size={18} style={{ color: 'var(--accent)' }} />
            </div>
            <div>
              <h2 className="text-base font-bold" style={{ color: 'var(--text-primary)' }}>
                Stundennachweise aus Fahrtenbuch
              </h2>
              <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                {MONTH_NAMES_DE[month - 1]} {year} {importFileName ? `- ${importFileName}` : ''}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:opacity-80 transition-opacity" style={{ color: 'var(--text-tertiary)' }}>
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          {/* Config Phase */}
          {phase === 'config' && (
            <>
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)' }}>Fahrer</label>
                  <div className="flex gap-3">
                    <label className="flex items-center gap-2 text-sm cursor-pointer" style={{ color: 'var(--text-primary)' }}>
                      <input type="radio" checked={driverFilter === 'all'} onChange={() => setDriverFilter('all')} />
                      <Users size={14} /> Alle Fahrer
                    </label>
                    <label className="flex items-center gap-2 text-sm cursor-pointer" style={{ color: 'var(--text-primary)' }}>
                      <input type="radio" checked={driverFilter === 'single'} onChange={() => setDriverFilter('single')} />
                      <User size={14} /> Einzelner Fahrer
                    </label>
                  </div>
                  {driverFilter === 'single' && (
                    <select
                      value={selectedDriverId}
                      onChange={e => setSelectedDriverId(e.target.value)}
                      className="mt-2 w-full px-3 py-2 rounded-lg text-sm"
                      style={{ background: 'var(--bg-input)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                    >
                      <option value="">Fahrer waehlen...</option>
                      {drivers.map(d => (
                        <option key={d.id} value={d.id}>{d.name}</option>
                      ))}
                    </select>
                  )}
                </div>

                <div>
                  <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-secondary)' }}>Bestehende Stundennachweise</label>
                  <div className="flex gap-3">
                    <label className="flex items-center gap-2 text-sm cursor-pointer" style={{ color: 'var(--text-primary)' }}>
                      <input type="radio" checked={existingBehavior === 'skip'} onChange={() => setExistingBehavior('skip')} />
                      Ueberspringen
                    </label>
                    <label className="flex items-center gap-2 text-sm cursor-pointer" style={{ color: 'var(--text-primary)' }}>
                      <input type="radio" checked={existingBehavior === 'overwrite'} onChange={() => setExistingBehavior('overwrite')} />
                      Ueberschreiben
                    </label>
                  </div>
                </div>
              </div>

              <div className="p-3 rounded-lg text-xs" style={{ background: 'var(--bg-muted)', color: 'var(--text-secondary)' }}>
                <p className="font-medium mb-1">Hinweise:</p>
                <ul className="list-disc pl-4 space-y-0.5">
                  <li>Block-basierte Schichtgenerierung mit {BLOCK_SEPARATOR_GAP_MINUTES} Min. Trennlinie</li>
                  <li>Variable Puffer ({BUFFER_MIN_MINUTES}-{BUFFER_MAX_MINUTES} Min.) statt fester 10-Minuten-Puffer</li>
                  <li>Gehaltsanpassung erweitert Schichten innerhalb erlaubter Fenster</li>
                  <li>Stornierte Fahrten werden ausgeschlossen</li>
                  <li>Fahrtenbuch-Daten werden nicht veraendert</li>
                </ul>
              </div>
            </>
          )}

          {/* Preview Phase */}
          {phase === 'preview' && (
            <>
              {/* Summary grid */}
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                <StatBox label="Fahrer" value={results.length} />
                <StatBox label="Fahrten" value={totalTrips} />
                <StatBox label="Abgedeckt" value={totalCovered} bg="var(--success-subtle)" color="var(--success)" />
                {totalPartial > 0 && <StatBox label="Teilweise" value={totalPartial} bg="var(--warning-subtle)" color="var(--warning)" />}
                <StatBox
                  label="Nicht abgedeckt"
                  value={totalUncovered}
                  bg={totalUncovered > 0 ? 'var(--danger-subtle)' : undefined}
                  color={totalUncovered > 0 ? 'var(--danger)' : undefined}
                />
                {totalOverlaps > 0 && <StatBox label="Ueberlappungen" value={totalOverlaps} bg="var(--danger-subtle)" color="var(--danger)" />}
                <StatBox label="Bereit" value={readyCount} bg={readyCount > 0 ? 'var(--success-subtle)' : undefined} color="var(--success)" />
              </div>

              {/* Fahrtenbuch Assignment Check */}
              {fahrtenbuchValidation && (
                <FahrtenbuchAssignmentCheck
                  validation={fahrtenbuchValidation}
                  resolverResult={carResolverResult}
                  showDetails={showCarPreview}
                  onToggleDetails={() => setShowCarPreview(!showCarPreview)}
                />
              )}

              {/* Uncovered warning banner */}
              {hasUncoveredTrips && (
                <div className="flex items-start gap-2 p-3 rounded-lg text-xs" style={{ background: 'var(--danger-subtle)', color: 'var(--danger)', border: '1px solid var(--danger)' }}>
                  <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
                  <div>
                    <strong>{totalUncovered} Fahrt{totalUncovered !== 1 ? 'en' : ''}</strong> nicht abgedeckt
                    {totalPartial > 0 && <>, <strong>{totalPartial}</strong> teilweise</>}
                    {!forceConfirm && ' - Speichern blockiert bis bestaetigt.'}
                  </div>
                </div>
              )}

              {/* Driver list */}
              <div className="space-y-2 max-h-[350px] overflow-y-auto">
                {results.map(r => {
                  const expanded = expandedDriver === r.driver.id;
                  return (
                    <div key={r.driver.id} className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--border)' }}>
                      <button
                        onClick={() => setExpandedDriver(expanded ? null : r.driver.id)}
                        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:opacity-90 transition-opacity"
                        style={{ background: 'var(--bg-surface)' }}
                      >
                        <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold" style={{
                          background: r.status === 'ready' ? 'var(--success-subtle)' : r.status === 'conflict' ? 'var(--danger-subtle)' : 'var(--warning-subtle)',
                          color: r.status === 'ready' ? 'var(--success)' : r.status === 'conflict' ? 'var(--danger)' : 'var(--warning)',
                        }}>
                          {r.status === 'ready' ? <CheckCircle size={14} /> : <AlertTriangle size={14} />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{r.driver.name}</div>
                          <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                            {r.coverageSummary.fully_covered}/{r.tripCount} abgedeckt, {r.workingDays} Tage, {fmtMins(r.totals.grundlohn)} Std.
                            {r.coverageSummary.partially_covered > 0 && <span style={{ color: 'var(--warning)' }}> ({r.coverageSummary.partially_covered} teilw.)</span>}
                            {r.coverageSummary.uncovered > 0 && <span style={{ color: 'var(--danger)' }}> ({r.coverageSummary.uncovered} offen)</span>}
                            {r.existingRecord && <span style={{ color: 'var(--warning)' }}> (vorhanden)</span>}
                          </div>
                        </div>
                        {(() => {
                          const totalIssues = r.overlapWarnings.length
                            + r.transferSummary.totalCount
                            + r.coverageSummary.uncovered + r.coverageSummary.partially_covered
                            + r.longShiftWarnings.length
                            + r.warnings.filter(w =>
                              !w.includes('Ueberlappende Fahrten')
                              && !w.includes('kritische Transfer')
                              && !w.includes('knappe Anschlussfahrten')
                              && !w.includes('nicht von Schicht abgedeckt')
                              && !w.includes('nicht abgedeckt')
                              && !w.includes('laenger als')
                              && !w.includes('Pause eingefuegt')
                            ).length;
                          return totalIssues > 0 ? (
                            <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{
                              background: r.coverageSummary.uncovered > 0 || r.overlapWarnings.length > 0 ? 'var(--danger-subtle)' : 'var(--warning-subtle)',
                              color: r.coverageSummary.uncovered > 0 || r.overlapWarnings.length > 0 ? 'var(--danger)' : 'var(--warning)',
                            }}>
                              {totalIssues}
                            </span>
                          ) : null;
                        })()}
                        {expanded ? <ChevronUp size={14} style={{ color: 'var(--text-tertiary)' }} /> : <ChevronDown size={14} style={{ color: 'var(--text-tertiary)' }} />}
                      </button>

                      {expanded && (
                        <div className="px-4 py-3 space-y-3" style={{ borderTop: '1px solid var(--border)', background: 'var(--bg-muted)' }}>
                          {/* Totals */}
                          <div className="grid grid-cols-3 gap-2 text-xs">
                            <div><span style={{ color: 'var(--text-tertiary)' }}>Grundlohn:</span> <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{fmtMins(r.totals.grundlohn)}</span></div>
                            {r.totals.nachtarbeit > 0 && <div><span style={{ color: 'var(--text-tertiary)' }}>Nacht:</span> <span className="font-medium">{fmtMins(r.totals.nachtarbeit)}</span></div>}
                            {r.totals.sonntag > 0 && <div><span style={{ color: 'var(--text-tertiary)' }}>Sonntag:</span> <span className="font-medium">{fmtMins(r.totals.sonntag)}</span></div>}
                            {r.totals.feiertag > 0 && <div><span style={{ color: 'var(--text-tertiary)' }}>Feiertag:</span> <span className="font-medium">{fmtMins(r.totals.feiertag)}</span></div>}
                            {r.totals.samstag > 0 && <div><span style={{ color: 'var(--text-tertiary)' }}>Samstag:</span> <span className="font-medium">{fmtMins(r.totals.samstag)}</span></div>}
                          </div>

                          {/* Salary info */}
                          {r.hourlyRate != null && r.hourlyRate > 0 && (
                            <div className="flex flex-wrap gap-3 text-xs p-2 rounded-lg" style={{ background: 'var(--accent-subtle)', border: '1px solid var(--accent)' }}>
                              <span><span style={{ color: 'var(--text-tertiary)' }}>Stundensatz:</span> <span className="font-semibold" style={{ color: 'var(--accent-text)' }}>{r.hourlyRate.toFixed(2).replace('.', ',')} EUR</span></span>
                              {r.targetSalary != null && r.targetSalary > 0 && (
                                <span><span style={{ color: 'var(--text-tertiary)' }}>Wunschgehalt:</span> <span className="font-semibold">{r.targetSalary.toFixed(2).replace('.', ',')} EUR</span></span>
                              )}
                              {r.calculatedSalary != null && (
                                <span><span style={{ color: 'var(--text-tertiary)' }}>Brutto-Lohn:</span> <span className="font-semibold" style={{ color: 'var(--success)' }}>{r.calculatedSalary.toFixed(2).replace('.', ',')} EUR</span></span>
                              )}
                              {r.extraMinutesAdded > 0 && (
                                <span><span style={{ color: 'var(--text-tertiary)' }}>Mehrarbeit:</span> <span className="font-semibold" style={{ color: 'var(--warning)' }}>+{fmtMins(r.extraMinutesAdded)} Std.</span></span>
                              )}
                            </div>
                          )}

                          {/* Overlap warnings */}
                          {r.overlapWarnings.length > 0 && (
                            <div className="space-y-1">
                              <p className="text-xs font-semibold" style={{ color: 'var(--danger)' }}>
                                Ueberlappende Fahrten ({r.overlapWarnings.length}):
                              </p>
                              {r.overlapWarnings.map((ow, i) => (
                                <div key={i} className="flex items-start gap-1.5 text-xs" style={{ color: 'var(--danger)' }}>
                                  <AlertTriangle size={10} className="mt-0.5 flex-shrink-0" />
                                  <span>{ow.date}: {ow.tripA.start}-{ow.tripA.end} und {ow.tripB.start}-{ow.tripB.end} ({ow.overlapMinutes} Min.)</span>
                                </div>
                              ))}
                            </div>
                          )}

                          {/* Long shift warnings */}
                          {r.longShiftWarnings.length > 0 && (
                            <div className="space-y-1">
                              <p className="text-xs font-semibold" style={{ color: 'var(--warning)' }}>
                                Lange Schichten ({r.longShiftWarnings.length}):
                              </p>
                              {r.longShiftWarnings.map((lw, i) => (
                                <div key={i} className="flex items-start gap-1.5 text-xs" style={{ color: lw.wasSplit ? 'var(--success)' : 'var(--warning)' }}>
                                  <Info size={10} className="mt-0.5 flex-shrink-0" />
                                  <span>{lw.message}</span>
                                </div>
                              ))}
                            </div>
                          )}

                          {/* Transfer warnings (deduplicated + summarized) */}
                          {r.transferSummary.totalCount > 0 && (
                            <div className="space-y-1">
                              <p className="text-xs font-semibold" style={{ color: 'var(--warning)' }}>
                                Transfer-Warnungen: {r.transferSummary.criticalCount > 0 && <span style={{ color: 'var(--danger)' }}>{r.transferSummary.criticalCount} kritisch</span>}
                                {r.transferSummary.criticalCount > 0 && r.transferSummary.warningCount > 0 && ', '}
                                {r.transferSummary.warningCount > 0 && `${r.transferSummary.warningCount} knapp`}
                                {(r.transferSummary.criticalCount > 0 || r.transferSummary.warningCount > 0) && r.transferSummary.lowCount > 0 && ', '}
                                {r.transferSummary.lowCount > 0 && `${r.transferSummary.lowCount} niedrig`}
                              </p>
                              {r.transferSummary.topWarnings.map((tw, i) => (
                                <div key={i} className="flex items-start gap-1.5 text-xs" style={{ color: tw.severity === 'critical' ? 'var(--danger)' : 'var(--warning)' }}>
                                  <Info size={10} className="mt-0.5 flex-shrink-0" />
                                  <span>{tw.date}: {tw.fromTrip.end} ({tw.fromTrip.routeEnd ?? '?'}) -{'>'} {tw.toTrip.start} ({tw.toTrip.routeStart ?? '?'}), {tw.gapMinutes} Min. - {tw.reason}</span>
                                </div>
                              ))}
                              {r.transferSummary.hasMore && (
                                <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                                  Weitere {r.transferSummary.totalCount - r.transferSummary.topWarnings.length} Anschlussfahrt-Warnungen im System sichtbar
                                </div>
                              )}
                            </div>
                          )}

                          {/* Coverage details */}
                          {(r.coverageSummary.uncovered > 0 || r.coverageSummary.partially_covered > 0) && (
                            <div className="space-y-1">
                              <p className="text-xs font-semibold" style={{ color: 'var(--danger)' }}>
                                Abdeckungsprobleme ({r.coverageSummary.uncovered + r.coverageSummary.partially_covered}):
                              </p>
                              <div className="max-h-32 overflow-y-auto space-y-0.5">
                                {r.coverageResults
                                  .filter(cr => cr.status !== 'fully_covered')
                                  .slice(0, 20)
                                  .map((cr, i) => (
                                    <div key={i} className="flex flex-col gap-0.5 text-xs" style={{ color: cr.status === 'partially_covered' ? 'var(--warning)' : 'var(--danger)' }}>
                                      <div className="flex items-start gap-1.5">
                                        <AlertTriangle size={10} className="mt-0.5 flex-shrink-0" />
                                        <span>
                                          {cr.status === 'partially_covered' && '[Teilweise] '}
                                          {cr.date} {cr.startTime}-{cr.endTime}: {cr.reason}
                                        </span>
                                      </div>
                                      {cr.debug && (
                                        <div className="ml-4 text-[10px] font-mono opacity-70">
                                          rawDate={cr.debug.rawTripDate} actualStart={cr.debug.actualStartDatetime ?? 'null'} svcDate={cr.debug.normalizedServiceDate} mins={cr.debug.startMinutes}-{cr.debug.endMinutes} shifts=[{cr.debug.shiftsOnDate.join(', ')}]
                                        </div>
                                      )}
                                    </div>
                                  ))}
                              </div>
                            </div>
                          )}

                          {/* General warnings (excluding items shown in dedicated sections above) */}
                          {(() => {
                            const generalWarnings = r.warnings.filter(w =>
                              !w.includes('Ueberlappende Fahrten')
                              && !w.includes('kritische Transfer')
                              && !w.includes('knappe Anschlussfahrten')
                              && !w.includes('nicht von Schicht abgedeckt')
                              && !w.includes('nicht abgedeckt')
                              && !w.includes('laenger als')
                              && !w.includes('Pause eingefuegt')
                            );
                            return generalWarnings.length > 0 ? (
                              <div className="space-y-1">
                                <p className="text-xs font-semibold" style={{ color: 'var(--warning)' }}>Hinweise ({generalWarnings.length}):</p>
                                <div className="max-h-32 overflow-y-auto space-y-0.5">
                                  {generalWarnings.slice(0, 15).map((w, i) => (
                                    <div key={i} className="flex items-start gap-1.5 text-xs" style={{ color: w.includes('Abwesenheit') ? 'var(--danger)' : 'var(--warning)' }}>
                                      <AlertTriangle size={10} className="mt-0.5 flex-shrink-0" />
                                      {w}
                                    </div>
                                  ))}
                                  {generalWarnings.length > 15 && (
                                    <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>... und {generalWarnings.length - 15} weitere</div>
                                  )}
                                </div>
                              </div>
                            ) : null;
                          })()}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {/* Saving Phase */}
          {phase === 'saving' && (
            <div className="text-center py-8 space-y-4">
              <Loader2 size={32} className="animate-spin mx-auto" style={{ color: 'var(--accent)' }} />
              <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                Speichere Stundennachweise... {saveProgress.done} / {saveProgress.total}
              </div>
              <div className="w-64 mx-auto h-2 rounded-full overflow-hidden" style={{ background: 'var(--bg-muted)' }}>
                <div className="h-full rounded-full transition-all" style={{
                  width: `${saveProgress.total > 0 ? (saveProgress.done / saveProgress.total) * 100 : 0}%`,
                  background: 'var(--accent)',
                }} />
              </div>
            </div>
          )}

          {/* Done Phase */}
          {phase === 'done' && (
            <div className="text-center py-8 space-y-4">
              <div className="w-14 h-14 rounded-2xl mx-auto flex items-center justify-center" style={{ background: 'var(--success-subtle)' }}>
                <CheckCircle size={28} style={{ color: 'var(--success)' }} />
              </div>
              <div>
                <div className="text-base font-bold" style={{ color: 'var(--text-primary)' }}>
                  Stundennachweise wurden erstellt
                </div>
                <div className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
                  {saveProgress.done} Stundennachweis{saveProgress.done !== 1 ? 'e' : ''} gespeichert
                  {saveProgress.skipped > 0 && `, ${saveProgress.skipped} uebersprungen`}
                </div>
              </div>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="flex items-start gap-2 p-3 rounded-lg text-xs" style={{ background: 'var(--warning-subtle)', color: 'var(--warning)' }}>
              <AlertTriangle size={13} className="mt-0.5 flex-shrink-0" />
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-6 py-4" style={{ borderTop: '1px solid var(--border)' }}>
          {phase === 'config' && (
            <>
              <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
                Abbrechen
              </button>
              <button
                onClick={handleGenerate}
                disabled={generating || (driverFilter === 'single' && !selectedDriverId)}
                className="flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-semibold transition-opacity disabled:opacity-50"
                style={{ background: 'var(--accent)', color: 'white' }}
              >
                {generating ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />}
                {generating ? 'Generiert...' : 'Vorschau erstellen'}
              </button>
            </>
          )}

          {phase === 'preview' && (
            <>
              <button onClick={() => setPhase('config')} className="px-4 py-2 rounded-lg text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
                Zurueck
              </button>
              {fahrtenbuchNotClean && (
                <span className="flex items-center gap-1.5 text-xs font-medium" style={{ color: 'var(--danger)' }}>
                  <CarIcon size={13} />
                  Fahrtenbuch nicht sauber
                </span>
              )}
              {!fahrtenbuchNotClean && hasUncoveredTrips && !forceConfirm && (
                <button
                  onClick={() => setForceConfirm(true)}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition-opacity"
                  style={{ background: 'var(--danger-subtle)', color: 'var(--danger)', border: '1px solid var(--danger)' }}
                >
                  <AlertTriangle size={13} />
                  Mit Konflikten speichern
                </button>
              )}
              <button
                onClick={handleSave}
                disabled={saving || !canSave}
                className="flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-semibold transition-opacity disabled:opacity-50"
                style={{ background: canSave ? 'var(--success)' : 'var(--bg-muted)', color: canSave ? 'white' : 'var(--text-tertiary)' }}
              >
                <Download size={14} />
                {results.length} Stundennachweis{results.length !== 1 ? 'e' : ''} speichern
              </button>
            </>
          )}

          {phase === 'done' && (
            <button
              onClick={onClose}
              className="flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-semibold"
              style={{ background: 'var(--accent)', color: 'white' }}
            >
              <ExternalLink size={14} />
              Schliessen
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Fahrtenbuch Assignment Check component ────────────────────────────────

function FahrtenbuchAssignmentCheck({
  validation,
  resolverResult,
  showDetails,
  onToggleDetails,
}: {
  validation: ResolvedFahrtenbuchValidation;
  resolverResult: CarBlockResolverResult | null;
  showDetails: boolean;
  onToggleDetails: () => void;
}) {
  const allViolations = [
    ...validation.driverOverlaps,
    ...validation.vehicleSwitchViolations,
    ...validation.vehicleOverlaps,
  ];
  const hasProblems = !validation.isClean;

  return (
    <div className="rounded-xl overflow-hidden" style={{
      border: `1px solid ${hasProblems ? 'var(--danger)' : 'var(--success)'}`,
    }}>
      {/* Header row */}
      <button
        onClick={onToggleDetails}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:opacity-90 transition-opacity"
        style={{ background: hasProblems ? 'var(--danger-subtle)' : 'var(--success-subtle)' }}
      >
        <div className="w-7 h-7 rounded-full flex items-center justify-center" style={{
          background: hasProblems ? 'var(--danger-subtle)' : 'var(--success-subtle)',
          color: hasProblems ? 'var(--danger)' : 'var(--success)',
          border: `1px solid ${hasProblems ? 'var(--danger)' : 'var(--success)'}`,
        }}>
          {hasProblems ? <AlertTriangle size={14} /> : <CheckCircle size={14} />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            Fahrtenbuch-Zuweisungspruefung
          </div>
          <div className="text-xs" style={{ color: hasProblems ? 'var(--danger)' : 'var(--success)' }}>
            {hasProblems ? 'Probleme gefunden - Speichern blockiert' : 'Alle Pruefungen bestanden'}
          </div>
        </div>
        {showDetails
          ? <ChevronUp size={14} style={{ color: 'var(--text-tertiary)' }} />
          : <ChevronDown size={14} style={{ color: 'var(--text-tertiary)' }} />
        }
      </button>

      {/* Summary stats (always visible) */}
      <div className="px-4 py-2.5 grid grid-cols-2 sm:grid-cols-3 gap-2" style={{
        borderTop: '1px solid var(--border)',
        background: 'var(--bg-surface)',
      }}>
        <MiniStat
          label="Zugewiesene Fahrten"
          value={validation.resolvedTrips}
          color="var(--success)"
        />
        <MiniStat
          label="Nicht zugewiesene Fahrten"
          value={validation.unresolvedTrips}
          color={validation.unresolvedTrips > 0 ? 'var(--danger)' : 'var(--text-tertiary)'}
        />
        <MiniStat
          label="Fahrer-Ueberlappungen"
          value={validation.driverOverlaps.length}
          color={validation.driverOverlaps.length > 0 ? 'var(--danger)' : 'var(--success)'}
        />
        <MiniStat
          label="Fahrzeugwechsel-Verletzungen"
          value={validation.vehicleSwitchViolations.length}
          color={validation.vehicleSwitchViolations.length > 0 ? 'var(--danger)' : 'var(--success)'}
        />
        <MiniStat
          label="Fahrzeug-Ueberlappungen"
          value={validation.vehicleOverlaps.length}
          color={validation.vehicleOverlaps.length > 0 ? 'var(--danger)' : 'var(--success)'}
        />
        <MiniStat
          label="Same-vehicle Konflikte"
          value={validation.sameVehicleConflicts.length}
          color={validation.sameVehicleConflicts.length > 0 ? '#e6a817' : 'var(--text-tertiary)'}
        />
        <MiniStat
          label="Puffer"
          value={`${MIN_VEHICLE_SWITCH_BUFFER_MINUTES} Min.`}
          color="var(--text-tertiary)"
        />
      </div>

      {/* Detailed violations + resolved blocks */}
      {showDetails && (
        <div className="px-4 py-3 space-y-3" style={{
          borderTop: '1px solid var(--border)',
          background: 'var(--bg-muted)',
        }}>
          {/* Violations */}
          {allViolations.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-semibold" style={{ color: 'var(--danger)' }}>
                Probleme ({allViolations.length}):
              </p>
              {allViolations.slice(0, 20).map((v, i) => (
                <div
                  key={i}
                  className="p-2 rounded-lg text-xs"
                  style={{ background: 'var(--danger-subtle)', border: '1px solid var(--danger)' }}
                >
                  <div className="flex items-start gap-2" style={{ color: 'var(--danger)' }}>
                    <AlertTriangle size={10} className="mt-0.5 flex-shrink-0" />
                    <div>
                      <span className="font-medium">
                        {v.type === 'driver_overlap' && 'Fahrer-Ueberlappung'}
                        {v.type === 'vehicle_switch_buffer' && 'Fahrzeugwechsel-Puffer'}
                        {v.type === 'vehicle_overlap' && 'Fahrzeug-Ueberlappung'}
                        {v.driverName && ` (${v.driverName})`}
                        {v.vehicleKennzeichen && ` (${v.vehicleKennzeichen})`}
                      </span>
                      <div className="mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                        {v.details}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
              {allViolations.length > 20 && (
                <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                  ... und {allViolations.length - 20} weitere Probleme
                </div>
              )}
            </div>
          )}

          {/* Unresolved blocks */}
          {resolverResult && resolverResult.unresolved.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-semibold" style={{ color: 'var(--danger)' }}>
                Nicht zuweisbare Bloecke ({resolverResult.unresolved.length}):
              </p>
              {resolverResult.unresolved.slice(0, 10).map((ub, i) => (
                <div key={i} className="p-2 rounded-lg text-xs space-y-1" style={{
                  background: 'var(--danger-subtle)', border: '1px solid var(--danger)',
                }}>
                  <div className="flex items-center gap-2 font-medium" style={{ color: 'var(--danger)' }}>
                    <CarIcon size={10} />
                    <span>{ub.kennzeichen} | {ub.date} | {minutesToTime(ub.startMin)}-{minutesToTime(ub.endMin)}</span>
                  </div>
                  <div style={{ color: 'var(--text-secondary)' }}>{ub.reason}</div>
                  {ub.triedDrivers.length > 0 && (
                    <div className="pl-3 space-y-0.5" style={{ color: 'var(--text-tertiary)' }}>
                      {ub.triedDrivers.slice(0, 5).map((td, j) => (
                        <div key={j}>{td.driverName}: {td.rejectReason}</div>
                      ))}
                      {ub.triedDrivers.length > 5 && (
                        <div>... und {ub.triedDrivers.length - 5} weitere</div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Same-vehicle conflicts (non-blocking) */}
          {validation.sameVehicleConflicts.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-semibold" style={{ color: '#e6a817' }}>
                Same-vehicle Konflikte ({validation.sameVehicleConflicts.length}):
              </p>
              <p className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
                Rohdaten-Konflikte im Fahrtenbuch — blockieren die Planung nicht.
              </p>
              {validation.sameVehicleConflicts.slice(0, 15).map((v, i) => (
                <div
                  key={i}
                  className="p-2 rounded-lg text-xs"
                  style={{ background: 'rgba(230,168,23,0.08)', border: '1px solid rgba(230,168,23,0.3)' }}
                >
                  <div className="flex items-start gap-2" style={{ color: '#e6a817' }}>
                    <Info size={10} className="mt-0.5 flex-shrink-0" />
                    <div>
                      <span className="font-medium">
                        Same-vehicle Konflikt
                        {v.vehicleKennzeichen && ` (${v.vehicleKennzeichen})`}
                        {v.driverName && ` — ${v.driverName}`}
                      </span>
                      <div className="mt-0.5" style={{ color: 'var(--text-secondary)' }}>{v.details}</div>
                    </div>
                  </div>
                </div>
              ))}
              {validation.sameVehicleConflicts.length > 15 && (
                <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                  ... und {validation.sameVehicleConflicts.length - 15} weitere
                </div>
              )}
            </div>
          )}

          {/* Resolved blocks preview */}
          {resolverResult && resolverResult.resolved.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-semibold" style={{ color: 'var(--success)' }}>
                Zugewiesene Bloecke ({resolverResult.resolved.length}):
              </p>
              <div className="max-h-40 overflow-y-auto space-y-0.5">
                {resolverResult.resolved.map((rb, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs py-1 px-2 rounded" style={{ background: 'var(--bg-surface)' }}>
                    <span className="font-mono font-medium" style={{ color: 'var(--accent-text)', minWidth: '80px' }}>{rb.kennzeichen}</span>
                    <span style={{ color: 'var(--text-tertiary)', minWidth: '80px' }}>{rb.date}</span>
                    <span style={{ color: 'var(--text-secondary)', minWidth: '90px' }}>{minutesToTime(rb.startMin)}-{minutesToTime(rb.endMin)}</span>
                    <span className="flex-1 truncate" style={{ color: 'var(--success)' }}>{rb.assignedDriverName}</span>
                    <span className="text-[10px] truncate" style={{ color: 'var(--text-tertiary)', maxWidth: '160px' }}>{rb.reason}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MiniStat({ label, value, color }: { label: string; value: number | string; color: string }) {
  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      <span style={{ color: 'var(--text-tertiary)' }}>{label}:</span>
      <span className="font-bold" style={{ color }}>{value}</span>
    </div>
  );
}

// ─── Small stat box component ───────────────────────────────────────────────

function StatBox({ label, value, bg, color }: { label: string; value: number; bg?: string; color?: string }) {
  return (
    <div className="p-2.5 rounded-xl text-center" style={{ background: bg || 'var(--bg-muted)' }}>
      <div className="text-lg font-bold" style={{ color: color || 'var(--text-primary)' }}>{value}</div>
      <div className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>{label}</div>
    </div>
  );
}
