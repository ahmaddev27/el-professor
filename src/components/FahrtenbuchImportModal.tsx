import React, { useState, useRef, useCallback } from 'react';
import * as XLSX from 'xlsx';
import { Upload, X, ChevronRight, ChevronLeft, Check, AlertTriangle, User, Car as CarIcon, FileSpreadsheet, Eye, RefreshCw, Plus, Trash2 } from 'lucide-react';
import { useFahrtenbuch, TripInsertRow, FahrtenbuchImport } from '../hooks/useFahrtenbuch';
import { useToast } from '../contexts/ToastContext';
import { format } from 'date-fns';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';

// ── Driver / Car types passed in from parent ──────────────────────────────────
export interface DriverOption { id: string; name: string; }
export interface CarOption    { id: string; plate: string; model?: string; }

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onImported: (importId: string) => void;
  drivers: DriverOption[];
  cars: CarOption[];
  existingImports?: FahrtenbuchImport[];
  onDeleteImport?: (importId: string) => Promise<void>;
}

// ── Parsed row from Excel/CSV ─────────────────────────────────────────────────
// Values may be string | number | boolean | null from raw XLSX read
type CellValue = string | number | boolean | null | undefined;
type RawRow = Record<string, CellValue>;

// ── Column mapping state ───────────────────────────────────────────────────────
interface ColMap {
  trip_date: string;
  start_time: string;
  end_time: string;
  driver_name: string;
  car_identifier: string;
  price_amount: string;
  tip_amount: string;
  payment_method: string;
  route_start: string;
  route_end: string;
  description: string;
}

const REQUIRED_COLS: (keyof ColMap)[] = ['trip_date', 'start_time', 'end_time', 'driver_name'];

// Mapping-UI labels for the system fields. These name our own fields, not the
// uploaded workbook's headers, so they follow the UI language. Values are
// TranslationKeys resolved with t() where they are rendered; the required-field
// marker is appended from REQUIRED_COLS rather than baked into the text.
const COL_LABEL_KEYS: Record<keyof ColMap, TranslationKey> = {
  trip_date:      'imp.col.tripDate',
  start_time:     'imp.col.startTime',
  end_time:       'imp.col.endTime',
  driver_name:    'imp.col.driverName',
  car_identifier: 'imp.col.plate',
  price_amount:   'imp.col.price',
  tip_amount:     'imp.col.tip',
  payment_method: 'imp.col.paymentMethod',
  route_start:    'imp.col.routeStart',
  route_end:      'imp.col.routeEnd',
  description:    'imp.col.description',
};

// Candidate column headers.
// Rules:
//  – List more-specific phrases first (exact match wins over substring).
//  – Short/ambiguous tokens ('beginn', 'start', 'ende') are only tried as
//    exact-normalised matches, never as substrings, to avoid mis-matching
//    columns like "Auftragsbeginn", "Geplante Abholzeit", etc.
//  – Tokens marked with a leading '=' are exact-only.
const AUTO_MATCH: Record<keyof ColMap, string[]> = {
  trip_date:      ['datum der fahrt','fahrtdatum','fahrt datum','fahrttag','=datum','=date'],
  // '=beginn' → exact only; prevents matching "Auftragsbeginn" / "Geplante Abholzeit"
  start_time:     ['uhrzeit des fahrtbeginns','uhrzeites fahrtbeginns','uhrzeit fahrtbeginn',
                   'fahrtbeginn','beginn der fahrt','start time','startzeit','=beginn'],
  end_time:       ['uhrzeit des fahrtendes','uhrzeit fahrtende','fahrtende','ende der fahrt',
                   'end time','endzeit','=ende'],
  driver_name:    ['fahrername','fahrer name','=fahrer','driver name','=driver'],
  // Only explicit plate-column names — never generic 'fahrzeug' which matches GPS columns
  car_identifier: ['kennzeichen','kfz kennzeichen','nummernschild','license plate','licenseplate','=plate'],
  price_amount:   ['fahrpreis','fahrtpreis','betrag','=preis','=price','=fare'],
  tip_amount:     ['trinkgeld','=tip','=tips'],
  payment_method: ['zahlungsart','=zahlung','payment method','=payment'],
  route_start:    ['abholort','abholadresse','=pickup','=von'],
  route_end:      ['zielort','zieladresse','=destination','=bis','=ziel'],
  description:    ['fahrzeugtyp','beschreibung','vehicle type','=typ','=type'],
};

// Known header keywords used to detect the actual header row
const HEADER_KEYWORDS = [
  'datum','fahrer','uhrzeit','preis','trinkgeld','zahlungsart','abholort','zielort','kennzeichen',
  'start','ende','beginn','fahrt','trip','driver','date','time','price','status','storniert',
];

// Normalized status values that mean "canceled" in the source file
const CANCELED_STATUSES = new Set([
  'storniert','storniertfahrt','storno','stornierung',
  'cancelled','canceled','abgebrochen','nichtdurchgefuhrt','nichtdurchgeführt',
]);

// Auto-match for the optional status column (not part of ColMap — detected separately)
const STATUS_COL_CANDIDATES = [
  'fahrtstatus','fahrt status','status der fahrt','trip status',
  '=status','auftragsstatus','buchungsstatus',
];

function isCanceledStatus(raw: CellValue): boolean {
  if (raw === null || raw === undefined) return false;
  const n = normalise(String(raw));
  return CANCELED_STATUSES.has(n);
}

// ── Driver matching state ─────────────────────────────────────────────────────
interface DriverMatch {
  importedName: string;
  matchedDriverId: string | null;
  matchedDriverName: string;
  confirmed: boolean;
}

// ── Car matching state ────────────────────────────────────────────────────────
interface CarMatch {
  importedPlate: string;
  matchedCarId: string | null;
  confirmed: boolean;
}

// ── Parse rejection tracking ──────────────────────────────────────────────────
interface ParseStats {
  total: number;
  valid: number;
  canceled: number;
  badDate: number;
  badStartTime: number;
  badEndTime: number;
  missingDriver: number;
  other: number;
  // Sample raw values for diagnosis
  sampleBadStartTime: CellValue[];
  sampleBadDate: CellValue[];
  startTimeColName: string;
  dateColName: string;
  statusColName: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalise(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// First-match wins; longer/more-specific candidates appear first in lists.
// Candidates prefixed with '=' are matched exactly only (never as substring).
function autoMatchCol(headers: string[], candidates: string[]): string {
  const exactOnly = (c: string) => c.startsWith('=');
  const token     = (c: string) => normalise(c.startsWith('=') ? c.slice(1) : c);

  // Pass 1: exact normalised match for ALL candidates
  for (const c of candidates) {
    const nc = token(c);
    for (const h of headers) {
      if (normalise(h) === nc) return h;
    }
  }
  // Pass 2: substring match only for non-exact candidates
  for (const c of candidates) {
    if (exactOnly(c)) continue;
    const nc = token(c);
    for (const h of headers) {
      if (normalise(h).includes(nc)) return h;
    }
  }
  return '';
}

// Column name fragments that must NEVER be matched for actual ride start/end times.
// These are order/request/dispatch timestamps, not the actual ride window.
const RIDE_TIME_REJECT_FRAGMENTS = [
  'auftrag',
  'auftragsuebermittlung',
  'auftragsübermittlung',
  'übermittlung',
  'uebermittlung',
  'disposition',
  'vermittlung',
  'eingang',
];

function isRejectedRideTimeCol(header: string): boolean {
  const hn = normalise(header);
  return RIDE_TIME_REJECT_FRAGMENTS.some(f => hn.includes(normalise(f)));
}

// Like autoMatchCol but additionally rejects known non-ride-time headers.
function autoMatchRideTimeCol(headers: string[], candidates: string[]): string {
  const safeHeaders = headers.filter(h => !isRejectedRideTimeCol(h));
  return autoMatchCol(safeHeaders, candidates);
}

// ── Date parsing ──────────────────────────────────────────────────────────────
// Accepts: Excel serial number (number), DD.MM.YYYY string, YYYY-MM-DD string,
// d.M.yyyy, ISO datetime, JS Date-like string, or already-formatted string.
function parseDate(raw: CellValue): string | null {
  if (raw === null || raw === undefined || raw === '' || raw === '\\N') return null;

  // Numeric — could be Excel date serial (integers 30000–60000) or fractional (time)
  if (typeof raw === 'number') {
    // Excel date serial: integers roughly between 30000 (1982) and 60000 (2064)
    if (Number.isInteger(raw) && raw > 1000) {
      try {
        const d = XLSX.SSF.parse_date_code(raw);
        if (d && d.y > 1980 && d.y < 2100) {
          return `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`;
        }
      } catch { /* fall through */ }
    }
    // Float that might encode a combined date+time (e.g. 45678.625)
    if (raw > 1000) {
      try {
        const d = XLSX.SSF.parse_date_code(Math.floor(raw));
        if (d && d.y > 1980 && d.y < 2100) {
          return `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`;
        }
      } catch { /* fall through */ }
    }
    return null;
  }

  const s = String(raw).trim();
  if (!s || s === '\\N') return null;

  // DD.MM.YYYY or D.M.YYYY or DD.MM.YY
  const m1 = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/);
  if (m1) {
    let y = Number(m1[3]);
    if (y < 100) y += y < 50 ? 2000 : 1900;
    return `${y}-${m1[2].padStart(2,'0')}-${m1[1].padStart(2,'0')}`;
  }

  // YYYY-MM-DD (possibly with time suffix)
  const m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m2) return `${m2[1]}-${m2[2]}-${m2[3]}`;

  // DD/MM/YYYY or MM/DD/YYYY — try both, prefer DD/MM for German files
  const m3 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m3) {
    const a = Number(m3[1]), b = Number(m3[2]);
    // If first number > 12, it must be the day
    if (a > 12) return `${m3[3]}-${m3[2].padStart(2,'0')}-${m3[1].padStart(2,'0')}`;
    // Otherwise assume MM/DD/YYYY (US) for safety
    return `${m3[3]}-${m3[1].padStart(2,'0')}-${m3[2].padStart(2,'0')}`;
  }

  // Excel serial number as string (e.g. "45678")
  if (/^\d{5}$/.test(s)) {
    try {
      const d = XLSX.SSF.parse_date_code(Number(s));
      if (d && d.y > 1980) return `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`;
    } catch { /* fall through */ }
  }

  return null;
}

// ── Time parsing ──────────────────────────────────────────────────────────────
// Accepts: Excel time fraction (0–1), "HH:MM", "HH:MM:SS", "H:MM", numeric-as-string.
function parseTime(raw: CellValue): string | null {
  if (raw === null || raw === undefined || raw === '' || raw === '\\N') return null;

  // Numeric fraction from Excel (0.0 = 00:00, 0.5 = 12:00, 1.0 = 24:00)
  if (typeof raw === 'number') {
    // Pure fraction in range [0, 1)
    let frac = raw;
    if (frac >= 1) frac = frac - Math.floor(frac); // strip date part from combined datetime
    if (frac < 0) return null;
    const totalMinutes = Math.round(frac * 24 * 60);
    const h = Math.floor(totalMinutes / 60) % 24;
    const m = totalMinutes % 60;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
  }

  const s = String(raw).trim();
  if (!s || s === '\\N') return null;

  // Datetime string — extract time part with a single regex.
  // Handles: "2025-10-01 10:05:22.000", "2025-10-01T04:31:28", "01.10.2025 10:05", etc.
  // The pattern finds HH:MM anywhere in the string (after a date prefix).
  const dtm = s.match(/(?:[T\s])(\d{1,2}):(\d{2})(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/);
  if (dtm) return `${dtm[1].padStart(2,'0')}:${dtm[2]}`;

  // Pure time strings: HH:MM or H:MM (with optional seconds / milliseconds)
  const m1 = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?(?:\.\d+)?$/);
  if (m1) return `${m1[1].padStart(2,'0')}:${m1[2]}`;

  // HH.MM or H.MM
  const m2 = s.match(/^(\d{1,2})\.(\d{2})$/);
  if (m2) return `${m2[1].padStart(2,'0')}:${m2[2]}`;

  // HHhMM
  const m3 = s.match(/^(\d{1,2})h(\d{2})$/i);
  if (m3) return `${m3[1].padStart(2,'0')}:${m3[2]}`;

  // Numeric string — pure fraction "0.625" or combined datetime "45931.625"
  if (/^\d+\.\d+$/.test(s)) {
    const n = parseFloat(s);
    let frac = n >= 1 ? n - Math.floor(n) : n;
    const totalMinutes = Math.round(frac * 24 * 60);
    const h = Math.floor(totalMinutes / 60) % 24;
    const m = totalMinutes % 60;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
  }

  return null;
}

// ── Money parsing ─────────────────────────────────────────────────────────────
function parseMoney(raw: CellValue): number {
  if (raw === null || raw === undefined) return 0;
  if (typeof raw === 'number') return Math.round(raw * 100) / 100;
  const s = String(raw).trim();
  if (!s || s === '\\N') return 0;
  // Handle German decimal comma: "41,93" → "41.93"
  const cleaned = s.replace(/[^\d,.-]/g, '').replace(/,(\d{2})$/, '.$1');
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : Math.round(n * 100) / 100;
}

function durationMinutes(start: string, end: string): number {
  try {
    const [sh, sm] = start.split(':').map(Number);
    const [eh, em] = end.split(':').map(Number);
    let diff = (eh * 60 + em) - (sh * 60 + sm);
    if (diff < 0) diff += 24 * 60;
    return diff;
  } catch { return 0; }
}

// Rejects GPS coords, \N, empty, pure numbers — real plates must contain a letter.
function isValidKennzeichen(raw: CellValue): boolean {
  if (raw === null || raw === undefined) return false;
  const v = String(raw).trim();
  if (!v || v === '\\N' || v.toLowerCase() === 'null' || v.toLowerCase() === 'undefined') return false;
  if (/^-?\d{1,3}\.\d+\s+-?\d{1,3}\.\d+$/.test(v)) return false; // GPS pair
  if (/^-?\d{2,3}\.\d{5,}$/.test(v)) return false;               // single lat/lon
  if (/^\d{7,}$/.test(v)) return false;                           // too-long number
  if (!/[a-zA-ZÄÖÜäöü]/.test(v)) return false;                   // no letter = not a plate
  return true;
}

// ── Header row detection ──────────────────────────────────────────────────────
// Some files have metadata rows before the actual header row.
// Find the first row where multiple cells match known keywords.
function detectHeaderRow(sheet: XLSX.WorkSheet): number {
  const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1:A1');
  for (let r = range.s.r; r <= Math.min(range.e.r, 20); r++) {
    let matches = 0;
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })];
      if (!cell) continue;
      const val = String(cell.v || '').toLowerCase();
      if (HEADER_KEYWORDS.some(kw => val.includes(kw))) matches++;
    }
    if (matches >= 3) return r;
  }
  return 0; // default: row 0 is header
}

// Wizard step names. Resolved with t() where they are rendered.
const STEP_KEYS: readonly TranslationKey[] = [
  'imp.step.file', 'imp.step.columns', 'imp.step.drivers', 'imp.step.vehicles', 'imp.step.preview',
];

// ── Component ─────────────────────────────────────────────────────────────────
const MONTH_KEYS: readonly TranslationKey[] = [
  'doc.month.january', 'doc.month.february', 'doc.month.march',     'doc.month.april',
  'doc.month.may',     'doc.month.june',     'doc.month.july',      'doc.month.august',
  'doc.month.september', 'doc.month.october', 'doc.month.november', 'doc.month.december',
];

const FahrtenbuchImportModal: React.FC<Props> = ({
  isOpen, onClose, onImported, drivers, cars, existingImports, onDeleteImport,
}) => {
  const { createImport } = useFahrtenbuch();
  const { success, error: showError } = useToast();
  const { t } = useTranslation();

  const [step, setStep] = useState(0);
  const [importing, setImporting] = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const [rawRows, setRawRows] = useState<RawRow[]>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [year, setYear]   = useState(new Date().getFullYear());
  const [parseError, setParseError] = useState('');

  const [colMap, setColMap] = useState<ColMap>({
    trip_date: '', start_time: '', end_time: '', driver_name: '',
    car_identifier: '', price_amount: '', tip_amount: '',
    payment_method: '', route_start: '', route_end: '', description: '',
  });

  const [driverMatches, setDriverMatches] = useState<DriverMatch[]>([]);
  const [carMatches, setCarMatches] = useState<CarMatch[]>([]);
  const [parseStats, setParseStats] = useState<ParseStats | null>(null);
  const [statusColName, setStatusColName] = useState('');

  const [sourceSheetName, setSourceSheetName] = useState('Sheet1');

  // Duplicate import conflict state
  const [showDuplicateWarning, setShowDuplicateWarning] = useState(false);
  const [replaceImportId, setReplaceImportId] = useState<string | null>(null);
  const [replacingImport, setReplacingImport] = useState(false);

  // Raw XLSX bytes preserved for storage upload on confirm
  const [rawXlsxBytes, setRawXlsxBytes] = useState<Uint8Array | null>(null);

  const reset = () => {
    setStep(0); setFileName(''); setRawRows([]); setHeaders([]); setParseError('');
    setColMap({
      trip_date:'', start_time:'', end_time:'', driver_name:'',
      car_identifier:'', price_amount:'', tip_amount:'',
      payment_method:'', route_start:'', route_end:'', description:'',
    });
    setStatusColName(''); setSourceSheetName('Sheet1');
    setDriverMatches([]); setCarMatches([]); setImporting(false); setParseStats(null);
    setShowDuplicateWarning(false); setReplaceImportId(null); setReplacingImport(false);
    setRawXlsxBytes(null);
  };

  const handleClose = () => { reset(); onClose(); };

  // ── File parsing ─────────────────────────────────────────────────────────────
  const handleFile = useCallback((file: File) => {
    setParseError('');
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target!.result as ArrayBuffer);
        setRawXlsxBytes(data);
        // raw: true → keep numeric values (dates as serials, times as fractions)
        const wb = XLSX.read(data, { type: 'array', raw: true, cellDates: false });

        console.log('[Fahrtenbuch] Sheet names:', wb.SheetNames);
        const sheetName = wb.SheetNames[0];
        setSourceSheetName(sheetName || 'Sheet1');
        console.log('[Fahrtenbuch] Using sheet:', sheetName);

        const ws = wb.Sheets[sheetName];

        // Find actual header row (skip metadata rows)
        const headerRowIdx = detectHeaderRow(ws);
        console.log('[Fahrtenbuch] Detected header row index:', headerRowIdx);

        // Parse starting from the detected header row
        const json: RawRow[] = XLSX.utils.sheet_to_json(ws, {
          defval: null,
          raw: true,
          range: headerRowIdx,
        }) as RawRow[];

        console.log('[Fahrtenbuch] Raw rows count:', json.length);
        if (json.length === 0) { setParseError(t('imp.error.noData')); return; }

        const hdrs = Object.keys(json[0]);
        console.log('[Fahrtenbuch] Headers detected:', hdrs);

        setHeaders(hdrs);
        setRawRows(json);

        // Auto-match columns
        const auto: ColMap = {
          trip_date:'', start_time:'', end_time:'', driver_name:'',
          car_identifier:'', price_amount:'', tip_amount:'',
          payment_method:'', route_start:'', route_end:'', description:'',
        };
        (Object.keys(auto) as (keyof ColMap)[]).forEach(k => {
          if (k === 'start_time' || k === 'end_time') {
            auto[k] = autoMatchRideTimeCol(hdrs, AUTO_MATCH[k]);
          } else {
            auto[k] = autoMatchCol(hdrs, AUTO_MATCH[k]);
          }
        });
        // Auto-detect optional status column
        const detectedStatusCol = autoMatchCol(hdrs, STATUS_COL_CANDIDATES);
        console.log('[Fahrtenbuch] Auto-mapped columns:', auto, '| status col:', detectedStatusCol);
        setColMap(auto);
        setStatusColName(detectedStatusCol);
      } catch (err: any) {
        console.error('[Fahrtenbuch] Parse error:', err);
        setParseError(t('imp.error.readFile', { message: err.message || String(err) }));
      }
    };
    reader.readAsArrayBuffer(file);
  }, [t]);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  };

  // ── Step navigation ───────────────────────────────────────────────────────────
  const canGoNext = () => {
    if (step === 0) return rawRows.length > 0 && !parseError;
    if (step === 1) return REQUIRED_COLS.every(k => colMap[k] !== '');
    if (step === 2) return driverMatches.every(d => d.confirmed);
    return true; // step 3 (cars) is always optional
  };

  const goNext = () => {
    if (step === 1) buildDriverMatches();
    if (step === 2) buildCarMatches();
    setStep(s => s + 1);
  };

  const buildDriverMatches = () => {
    const names = [...new Set(
      rawRows
        .map(r => String(r[colMap.driver_name] ?? '').trim())
        .filter(Boolean)
    )];
    const matches: DriverMatch[] = names.map(name => {
      const norm = normalise(name);
      const found = drivers.find(d =>
        normalise(d.name) === norm ||
        normalise(d.name).includes(norm) ||
        norm.includes(normalise(d.name))
      );
      return {
        importedName: name,
        matchedDriverId: found?.id || null,
        matchedDriverName: found?.name || name,
        confirmed: !!found,
      };
    });
    setDriverMatches(matches);
  };

  const buildCarMatches = () => {
    if (!colMap.car_identifier) { setCarMatches([]); return; }
    const allValues = rawRows.map(r => r[colMap.car_identifier]);
    const plates = [...new Set(allValues.filter(isValidKennzeichen))].map(v => String(v).trim());
    const matches: CarMatch[] = plates.map(plate => {
      const norm = normalise(plate);
      const found = cars.find(c => normalise(c.plate) === norm || normalise(c.plate).includes(norm));
      return { importedPlate: plate, matchedCarId: found?.id || null, confirmed: true };
    });
    setCarMatches(matches);
  };

  // ── Build trip rows ───────────────────────────────────────────────────────────
  const buildTripRows = (): { rows: TripInsertRow[]; stats: ParseStats } => {
    const driverMap = new Map(driverMatches.map(d => [d.importedName, d]));
    const carMap    = new Map(carMatches.map(c => [c.importedPlate, c]));

    const stats: ParseStats = {
      total: rawRows.length, valid: 0, canceled: 0,
      badDate: 0, badStartTime: 0, badEndTime: 0,
      missingDriver: 0, other: 0,
      sampleBadStartTime: [], sampleBadDate: [],
      startTimeColName: colMap.start_time,
      dateColName: colMap.trip_date,
      statusColName,
    };

    const rows: TripInsertRow[] = [];

    for (let rowIdx = 0; rowIdx < rawRows.length; rowIdx++) {
      const row = rawRows[rowIdx];
      const rawDate      = colMap.trip_date  ? row[colMap.trip_date]  : null;
      const rawStart     = colMap.start_time ? row[colMap.start_time] : null;
      const rawEnd       = colMap.end_time   ? row[colMap.end_time]   : null;
      const rawDriver    = String(colMap.driver_name ? (row[colMap.driver_name] ?? '') : '').trim();
      const rawSrcStatus = statusColName ? String(row[statusColName] ?? '').trim() : '';
      const canceled     = isCanceledStatus(rawSrcStatus || rawStart || rawEnd);

      const tripDate  = parseDate(rawDate);
      const startTime = parseTime(rawStart);
      const endTime   = parseTime(rawEnd);

      // ── Canceled row path ──────────────────────────────────────────────────
      if (canceled) {
        // Need at least a trip date to anchor the canceled row; if missing use
        // a best-effort fallback of today so the row is still preservable.
        const effectiveDate = tripDate ?? new Date().toISOString().slice(0, 10);
        // Stored in fahrtenbuch_trips.original_driver_name — a persisted value,
        // not a label, so it stays German regardless of the UI language.
        const effectiveDriver = rawDriver || 'Unbekannt';
        const driverMatch = driverMap.get(rawDriver);

        const rawPlate  = colMap.car_identifier ? row[colMap.car_identifier] : null;
        const rawPrice  = colMap.price_amount   ? row[colMap.price_amount]   : null;
        const rawTip    = colMap.tip_amount     ? row[colMap.tip_amount]     : null;
        const rawStart2 = colMap.route_start    ? String(row[colMap.route_start] ?? '') : '';
        const rawEnd2   = colMap.route_end      ? String(row[colMap.route_end]   ?? '') : '';
        const rawDesc   = colMap.description    ? String(row[colMap.description]  ?? '') : '';
        const validPlate = rawPlate && isValidKennzeichen(rawPlate) ? String(rawPlate).trim() : null;
        const carMatch   = validPlate ? carMap.get(validPlate) : undefined;

        rows.push({
          company_id: '',
          import_id: '',
          trip_date:        effectiveDate,
          start_time:       null,
          end_time:         null,
          duration_minutes: null,
          original_driver_id:   driverMatch?.matchedDriverId ?? null,
          original_driver_name: effectiveDriver,
          assigned_driver_id:   driverMatch?.matchedDriverId ?? null,
          assigned_driver_name: driverMatch?.matchedDriverName ?? effectiveDriver,
          car_id:               carMatch?.matchedCarId ?? null,
          car_identifier:       validPlate,
          route_start:          rawStart2 || null,
          route_end:            rawEnd2   || null,
          description:          rawDesc   || null,
          price_amount:         parseMoney(rawPrice),
          cash_amount:          0,
          online_amount:        0,
          tip_amount:           parseMoney(rawTip),
          action_amount:        0,
          raw_data_json:        Object.fromEntries(
            Object.entries(row).map(([k, v]) => [k, v ?? null])
          ),
          plausibility_status: 'canceled',
          is_canceled:          true,
          source_status:        rawSrcStatus || null,
          source_row_index:     rowIdx + 1,
        });
        stats.canceled++;
        continue;
      }

      // ── Valid completed trip path ───────────────────────────────────────────
      if (!tripDate) {
        stats.badDate++;
        if (stats.sampleBadDate.length < 5) stats.sampleBadDate.push(rawDate);
        console.log('[Fahrtenbuch] Discard: bad date', rawDate, row);
        continue;
      }
      if (!startTime) {
        stats.badStartTime++;
        if (stats.sampleBadStartTime.length < 5) stats.sampleBadStartTime.push(rawStart);
        console.log('[Fahrtenbuch] Discard: bad start_time', rawStart, row);
        continue;
      }
      if (!endTime)   { stats.badEndTime++;    console.log('[Fahrtenbuch] Discard: bad end_time', rawEnd, row); continue; }
      if (!rawDriver) { stats.missingDriver++; console.log('[Fahrtenbuch] Discard: missing driver', row); continue; }

      const rawPlate  = colMap.car_identifier ? row[colMap.car_identifier] : null;
      const rawPrice  = colMap.price_amount   ? row[colMap.price_amount]   : null;
      const rawTip    = colMap.tip_amount     ? row[colMap.tip_amount]     : null;
      const rawPay    = colMap.payment_method ? String(row[colMap.payment_method] ?? '').toLowerCase() : '';
      const rawStart2 = colMap.route_start    ? String(row[colMap.route_start] ?? '') : '';
      const rawEnd2   = colMap.route_end      ? String(row[colMap.route_end]   ?? '') : '';
      const rawDesc   = colMap.description    ? String(row[colMap.description]  ?? '') : '';

      const priceAmt  = parseMoney(rawPrice);
      const tipAmt    = parseMoney(rawTip);
      const isBar     = rawPay.includes('bar') || rawPay.includes('cash') || rawPay === 'b';
      const cashAmt   = isBar ? priceAmt : 0;
      const onlineAmt = isBar ? 0 : priceAmt;

      const driverMatch = driverMap.get(rawDriver);
      const validPlate  = rawPlate && isValidKennzeichen(rawPlate) ? String(rawPlate).trim() : null;
      const carMatch    = validPlate ? carMap.get(validPlate) : undefined;

      rows.push({
        company_id: '',
        import_id: '',
        trip_date:        tripDate,
        start_time:       startTime,
        end_time:         endTime,
        duration_minutes: durationMinutes(startTime, endTime),
        original_driver_id:   driverMatch?.matchedDriverId   ?? null,
        original_driver_name: rawDriver,
        assigned_driver_id:   driverMatch?.matchedDriverId   ?? null,
        assigned_driver_name: driverMatch?.matchedDriverName ?? rawDriver,
        car_id:               carMatch?.matchedCarId ?? null,
        car_identifier:       validPlate,
        route_start:          rawStart2 || null,
        route_end:            rawEnd2   || null,
        description:          rawDesc   || null,
        price_amount:         priceAmt,
        cash_amount:          cashAmt,
        online_amount:        onlineAmt,
        tip_amount:           tipAmt,
        action_amount:        0,
        raw_data_json:        Object.fromEntries(
          Object.entries(row).map(([k, v]) => [k, v ?? null])
        ),
        plausibility_status: 'pending',
        is_canceled:          false,
        source_status:        rawSrcStatus || null,
        source_row_index:     rowIdx + 1,
      });
      stats.valid++;
    }

    console.log('[Fahrtenbuch] Build result:', stats);
    return { rows, stats };
  };

  // Memoised result for step 4 rendering (avoids rebuilding on every render)
  const [builtResult, setBuiltResult] = useState<{ rows: TripInsertRow[]; stats: ParseStats } | null>(null);

  // Rebuild when entering step 4
  const goNextWithBuild = () => {
    if (step === 2) buildCarMatches();
    const nextStep = step + 1;
    if (nextStep === 4) {
      const result = buildTripRows();
      setBuiltResult(result);
      setParseStats(result.stats);
    }
    setStep(nextStep);
  };

  const conflictingImports = existingImports?.filter(
    imp => imp.month === month && imp.year === year,
  ) ?? [];

  const handleImport = async () => {
    const result = builtResult ?? buildTripRows();
    if (result.rows.length === 0) {
      showError(t('common.error'), t('imp.error.noValidTrips'));
      return;
    }
    // Check for duplicate month/year imports
    if (conflictingImports.length > 0 && !showDuplicateWarning) {
      setShowDuplicateWarning(true);
      return;
    }
    await doImport(result.rows, replaceImportId);
  };

  const doImport = async (rows: TripInsertRow[], deleteFirstId: string | null) => {
    // Pre-check: original XLSX bytes must be present
    if (!rawXlsxBytes || rawXlsxBytes.length === 0) {
      showError(t('imp.error.blockedTitle'), t('imp.error.rawXlsxMissing'));
      return;
    }
    setImporting(true);
    try {
      // If replacing, delete the old import first (validation already passed)
      if (deleteFirstId && onDeleteImport) {
        setReplacingImport(true);
        try {
          await onDeleteImport(deleteFirstId);
        } catch (err: any) {
          showError(t('common.error'), t('imp.error.deleteOldImport', { message: err.message || t('imp.error.unknown') }));
          setReplacingImport(false);
          setImporting(false);
          return;
        }
        setReplacingImport(false);
      }
      const importId = await createImport({ month, year, fileName, trips: rows, sourceSheetName, sourceColumns: headers, xlsxBytes: rawXlsxBytes ?? undefined });
      success(t('imp.toast.successTitle'), t('imp.toast.successBody', { count: rows.length }));
      reset();
      onImported(importId);
    } catch (err: any) {
      showError(t('imp.toast.failedTitle'), err.message || String(err));
    } finally {
      setImporting(false);
    }
  };

  const previewRows = rawRows.slice(0, 5);

  if (!isOpen) return null;

  const inputSt: React.CSSProperties = {
    background: 'var(--bg-subtle)', border: '1px solid var(--border)',
    borderRadius: '0.5rem', color: 'var(--text-primary)',
    fontSize: '0.875rem', padding: '0.5rem 0.75rem', outline: 'none', width: '100%',
  };
  const selectSt: React.CSSProperties = { ...inputSt, cursor: 'pointer' };

  const validRows  = builtResult?.rows ?? [];
  const stats      = builtResult?.stats ?? null;
  const unmatchedDrivers = driverMatches.filter(d => !d.matchedDriverId).length;
  const unmatchedCars    = carMatches.filter(c => !c.matchedCarId).length;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}
    >
      <div
        className="w-full max-w-3xl max-h-[90vh] flex flex-col rounded-2xl overflow-hidden"
        style={{ background: 'var(--bg-surface)', boxShadow: '0 25px 50px rgba(0,0,0,0.5)' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom: '1px solid var(--border)' }}>
          <div className="flex items-center gap-3">
            <div className="rounded-lg p-2" style={{ background: 'var(--accent-subtle)' }}>
              <FileSpreadsheet size={20} style={{ color: 'var(--accent-text)' }} />
            </div>
            <div>
              <h2 className="font-semibold text-base" style={{ color: 'var(--text-primary)' }}>
                {t('imp.title')}
              </h2>
              <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                {t('imp.stepIndicator', { current: step + 1, total: STEP_KEYS.length, label: t(STEP_KEYS[step]) })}
              </p>
            </div>
          </div>
          <button onClick={handleClose} style={{ color: 'var(--text-tertiary)' }}>
            <X size={20} />
          </button>
        </div>

        {/* Step progress */}
        <div className="flex gap-1 px-6 pt-4">
          {STEP_KEYS.map((stepKey, i) => (
            <div key={stepKey} className="flex-1 flex flex-col items-center gap-1">
              <div className="h-1.5 w-full rounded-full"
                style={{ background: i <= step ? 'var(--accent)' : 'var(--border)' }} />
              <span className="text-xs hidden sm:block"
                style={{ color: i === step ? 'var(--accent-text)' : 'var(--text-tertiary)' }}>
                {t(stepKey)}
              </span>
            </div>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">

          {/* ── Step 0: Datei ─────────────────────────────────────────────── */}
          {step === 0 && (
            <div className="space-y-5">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>{t('common.month')}</label>
                  <select value={month} onChange={e => setMonth(Number(e.target.value))} style={selectSt}>
                    {MONTH_KEYS.map((monthKey, i) => <option key={monthKey} value={i + 1}>{t(monthKey)}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>{t('imp.year')}</label>
                  <select value={year} onChange={e => setYear(Number(e.target.value))} style={selectSt}>
                    {[2024, 2025, 2026, 2027].map(y => <option key={y} value={y}>{y}</option>)}
                  </select>
                </div>
              </div>

              <div
                className="rounded-xl border-2 border-dashed flex flex-col items-center justify-center gap-3 py-10 cursor-pointer"
                style={{ borderColor: rawRows.length ? 'var(--success)' : 'var(--border)', background: 'var(--bg-subtle)' }}
                onDragOver={e => e.preventDefault()}
                onDrop={onDrop}
                onClick={() => fileRef.current?.click()}
              >
                {rawRows.length > 0 ? (
                  <>
                    <div className="rounded-full p-3" style={{ background: 'var(--success-subtle)' }}>
                      <Check size={28} style={{ color: 'var(--success)' }} />
                    </div>
                    <p className="font-medium" style={{ color: 'var(--success)' }}>{fileName}</p>
                    <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>{t('imp.rowsRead', { count: rawRows.length })}</p>
                  </>
                ) : (
                  <>
                    <Upload size={32} style={{ color: 'var(--text-tertiary)' }} />
                    <p className="font-medium" style={{ color: 'var(--text-primary)' }}>{t('imp.dropzoneTitle')}</p>
                    <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>{t('imp.dropzoneHint')}</p>
                  </>
                )}
              </div>
              <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden"
                onChange={e => { if (e.target.files?.[0]) handleFile(e.target.files[0]); }} />

              {parseError && (
                <div className="flex items-center gap-2 p-3 rounded-lg"
                  style={{ background: 'var(--danger-subtle)', border: '1px solid var(--danger)' }}>
                  <AlertTriangle size={16} style={{ color: 'var(--danger)' }} />
                  <span className="text-sm" style={{ color: 'var(--danger)' }}>{parseError}</span>
                </div>
              )}

              {rawRows.length > 0 && (
                <div>
                  <p className="text-xs font-medium mb-2 flex items-center gap-1" style={{ color: 'var(--text-tertiary)' }}>
                    <Eye size={13} /> {t('imp.previewRaw')}
                  </p>
                  <div className="overflow-x-auto rounded-lg" style={{ border: '1px solid var(--border)' }}>
                    <table className="w-full text-xs">
                      <thead style={{ background: 'var(--bg-subtle)' }}>
                        <tr>
                          {headers.slice(0, 8).map(h => (
                            <th key={h} className="px-3 py-2 text-left font-medium whitespace-nowrap"
                              style={{ color: 'var(--text-tertiary)' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {previewRows.map((row, i) => (
                          <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                            {headers.slice(0, 8).map(h => (
                              <td key={h} className="px-3 py-2 whitespace-nowrap"
                                style={{ color: 'var(--text-primary)' }}>
                                {String(row[h] ?? '').slice(0, 24)}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Step 1: Spalten ──────────────────────────────────────────── */}
          {step === 1 && (
            <div className="space-y-4">
              <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                {t('imp.mappingIntro')}
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {(Object.keys(COL_LABEL_KEYS) as (keyof ColMap)[]).map(key => (
                  <div key={key}>
                    <label className="block text-xs font-medium mb-1"
                      style={{ color: REQUIRED_COLS.includes(key) ? 'var(--accent-text)' : 'var(--text-secondary)' }}>
                      {t(COL_LABEL_KEYS[key])}{REQUIRED_COLS.includes(key) ? ' *' : ''}
                    </label>
                    <select
                      value={colMap[key]}
                      onChange={e => setColMap(prev => ({ ...prev, [key]: e.target.value }))}
                      style={selectSt}
                    >
                      <option value="">{t('imp.optionUnmapped')}</option>
                      {headers.map(h => <option key={h} value={h}>{h}</option>)}
                    </select>
                  </div>
                ))}
              </div>
              {!REQUIRED_COLS.every(k => colMap[k]) && (
                <div className="flex items-center gap-2 p-3 rounded-lg"
                  style={{ background: 'var(--warning-subtle)', border: '1px solid var(--warning)' }}>
                  <AlertTriangle size={14} style={{ color: 'var(--warning)' }} />
                  <span className="text-sm" style={{ color: 'var(--warning)' }}>
                    {t('imp.warnRequiredCols')}
                  </span>
                </div>
              )}

              {/* Column parse debug — always shown for required columns so wrong mappings are visible */}
              {rawRows.length > 0 && (() => {
                const sampleRows = rawRows.slice(0, 3);

                const fields: Array<{ key: keyof ColMap; parser: (v: CellValue) => string | null }> = [
                  { key: 'trip_date',   parser: parseDate },
                  { key: 'start_time',  parser: parseTime },
                  { key: 'end_time',    parser: parseTime },
                  { key: 'driver_name',
                    parser: v => { const s = String(v ?? '').trim(); return s || null; } },
                ];

                return (
                  <div className="space-y-2">
                    <p className="text-xs font-medium" style={{ color: 'var(--text-tertiary)' }}>
                      {t('imp.mappingDebugHeading')}
                    </p>
                    {fields.map(({ key, parser }) => {
                      const col = colMap[key];
                      const samples = col
                        ? sampleRows.map(r => r[col])
                        : [];
                      const parsed  = samples.map(v => parser(v));
                      const allParsed = parsed.every(p => p !== null);
                      const bg  = !col ? 'var(--bg-subtle)' : allParsed ? 'var(--success-subtle)' : 'var(--danger-subtle)';
                      const bdr = !col ? 'var(--border)'    : allParsed ? 'var(--success)'         : 'var(--danger)';
                      const tc  = !col ? 'var(--text-tertiary)' : allParsed ? 'var(--success)' : 'var(--danger)';
                      return (
                        <div key={key} className="rounded-lg p-3 text-xs"
                          style={{ background: bg, border: `1px solid ${bdr}` }}>
                          <div className="flex items-center justify-between mb-1">
                            <span className="font-medium" style={{ color: tc }}>{t(COL_LABEL_KEYS[key])}</span>
                            <span style={{ color: 'var(--text-tertiary)' }}>
                              {col ? t('imp.columnNamed', { column: col }) : t('imp.unmapped')}
                            </span>
                          </div>
                          {col && (
                            <div className="space-y-0.5" style={{ color: 'var(--text-secondary)' }}>
                              {samples.map((raw, i) => (
                                <div key={i}>
                                  {t('imp.rawValue')}: <code className="font-mono">{String(raw ?? 'null')}</code>
                                  {' → '}
                                  <b style={{ color: parsed[i] ? 'var(--success)' : 'var(--danger)' }}>
                                    {parsed[i] ?? t('imp.parseFailed')}
                                  </b>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
          )}

          {/* ── Step 2: Fahrer ───────────────────────────────────────────── */}
          {step === 2 && (
            <div className="space-y-4">
              <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                {t('imp.driversIntro')}
              </p>
              {driverMatches.length === 0 && (
                <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>{t('imp.noDriverNames')}</p>
              )}
              {driverMatches.map((dm, idx) => (
                <div key={dm.importedName} className="rounded-lg p-4 flex items-center gap-4"
                  style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
                  <div className="rounded-full p-2" style={{ background: 'var(--accent-subtle)', flexShrink: 0 }}>
                    <User size={16} style={{ color: 'var(--accent-text)' }} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{dm.importedName}</p>
                    <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{t('imp.nameFoundInFile')}</p>
                  </div>
                  <ChevronRight size={16} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
                  <div className="flex-1 min-w-0">
                    <select
                      value={dm.matchedDriverId || ''}
                      onChange={e => {
                        const drv = drivers.find(d => d.id === e.target.value);
                        setDriverMatches(prev => prev.map((d, i) => i === idx ? {
                          ...d,
                          matchedDriverId: drv?.id || null,
                          matchedDriverName: drv?.name || dm.importedName,
                          confirmed: true,
                        } : d));
                      }}
                      style={selectSt}
                    >
                      <option value="">{t('imp.optionNoDriver')}</option>
                      {drivers.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </select>
                  </div>
                  <button
                    onClick={() => setDriverMatches(prev => prev.map((d, i) =>
                      i === idx ? { ...d, confirmed: true } : d))}
                    className="rounded-lg px-3 py-1.5 text-xs font-medium"
                    style={dm.confirmed
                      ? { background: 'var(--success-subtle)', color: 'var(--success)', border: '1px solid var(--success)' }
                      : { background: 'var(--bg-surface)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
                  >
                    {dm.confirmed ? <Check size={14} /> : 'OK'}
                  </button>
                </div>
              ))}
              {driverMatches.some(d => !d.confirmed) && (
                <div className="flex items-center gap-2 p-3 rounded-lg"
                  style={{ background: 'var(--warning-subtle)', border: '1px solid var(--warning)' }}>
                  <AlertTriangle size={14} style={{ color: 'var(--warning)' }} />
                  <span className="text-sm" style={{ color: 'var(--warning)' }}>
                    {t('imp.warnConfirmDrivers')}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* ── Step 3: Fahrzeuge ────────────────────────────────────────── */}
          {step === 3 && (
            <div className="space-y-4">
              <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                {t('imp.carsIntro')}
              </p>
              {carMatches.length === 0 && (
                <div className="flex items-start gap-3 p-4 rounded-lg"
                  style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
                  <CarIcon size={18} style={{ color: 'var(--text-tertiary)', flexShrink: 0, marginTop: 2 }} />
                  <div>
                    <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                      {t('imp.noPlateColumnTitle')}
                    </p>
                    <p className="text-sm mt-1" style={{ color: 'var(--text-tertiary)' }}>
                      {colMap.car_identifier
                        ? t('imp.noPlateColumnMapped', { column: colMap.car_identifier })
                        : t('imp.noPlateColumnUnmapped')}
                      {' '}{t('imp.noPlateColumnEffect')}
                    </p>
                  </div>
                </div>
              )}
              {carMatches.map((cm, idx) => (
                <div key={cm.importedPlate} className="rounded-lg p-4 flex items-center gap-4"
                  style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
                  <div className="rounded-full p-2" style={{ background: 'var(--warning-subtle)', flexShrink: 0 }}>
                    <CarIcon size={16} style={{ color: 'var(--warning)' }} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{cm.importedPlate}</p>
                    <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{t('imp.plateFromFile')}</p>
                  </div>
                  <ChevronRight size={16} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
                  <div className="flex-1 min-w-0">
                    <select
                      value={cm.matchedCarId || ''}
                      onChange={e => {
                        setCarMatches(prev => prev.map((c, i) => i === idx
                          ? { ...c, matchedCarId: e.target.value || null }
                          : c));
                      }}
                      style={selectSt}
                    >
                      <option value="">{t('imp.optionNoCar')}</option>
                      {cars.map(c => <option key={c.id} value={c.id}>{c.plate}{c.model ? ` — ${c.model}` : ''}</option>)}
                    </select>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ── Step 4: Vorschau & Import ────────────────────────────────── */}
          {step === 4 && (
            <div className="space-y-4">
              {/* Summary cards */}
              {(() => {
                const canceledCount = stats?.canceled ?? 0;
                const skipped = stats ? (stats.total - stats.valid - canceledCount) : 0;
                return (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    {([
                      { labelKey: 'imp.card.validTrips' as TranslationKey, value: stats?.valid ?? validRows.filter(r => !r.is_canceled).length, color: 'var(--accent)' },
                      { labelKey: 'imp.card.canceledTrips' as TranslationKey, value: canceledCount, color: canceledCount > 0 ? 'var(--warning)' : 'var(--text-tertiary)' },
                      { labelKey: 'imp.card.skippedRows' as TranslationKey, value: skipped, color: skipped > 0 ? 'var(--danger)' : 'var(--success)' },
                      { labelKey: 'imp.card.monthYear' as TranslationKey, value: `${month}/${year}`, color: 'var(--text-primary)' },
                    ]).map(card => (
                      <div key={card.labelKey} className="rounded-lg p-3"
                        style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
                        <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{t(card.labelKey)}</p>
                        <p className="text-xl font-bold mt-1" style={{ color: card.color }}>{card.value}</p>
                      </div>
                    ))}
                  </div>
                );
              })()}

              {/* Duplicate import warning overlay */}
              {showDuplicateWarning && conflictingImports.length > 0 && (
                <div className="rounded-xl p-5 space-y-4" style={{ background: 'var(--bg-surface)', border: '2px solid var(--warning)', boxShadow: 'var(--shadow-lg)' }}>
                  <div className="flex items-center gap-3">
                    <div className="rounded-lg p-2" style={{ background: 'var(--warning-subtle)' }}>
                      <AlertTriangle size={20} style={{ color: 'var(--warning)' }} />
                    </div>
                    <div>
                      <h4 className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>
                        {t('imp.duplicateTitle')}
                      </h4>
                      <p className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                        {t(MONTH_KEYS[month - 1])} {year}
                      </p>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <p className="text-xs font-medium" style={{ color: 'var(--text-tertiary)' }}>{t('imp.existingImports')}</p>
                    {conflictingImports.map(imp => (
                      <div key={imp.id} className="flex items-center justify-between rounded-lg px-3 py-2 text-sm"
                        style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
                        <div>
                          <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{imp.file_name}</span>
                          <span className="text-xs ml-2" style={{ color: 'var(--text-tertiary)' }}>
                            {t('imp.tripCount', { count: imp.row_count })} — {format(new Date(imp.imported_at), 'dd.MM.yyyy HH:mm')}
                          </span>
                        </div>
                        {onDeleteImport && (
                          <label className="flex items-center gap-1.5 cursor-pointer">
                            <input
                              type="radio"
                              name="replaceImport"
                              checked={replaceImportId === imp.id}
                              onChange={() => setReplaceImportId(replaceImportId === imp.id ? null : imp.id)}
                              className="w-3.5 h-3.5"
                            />
                            <span className="text-xs" style={{ color: 'var(--danger)' }}>{t('imp.replace')}</span>
                          </label>
                        )}
                      </div>
                    ))}
                  </div>

                  {replaceImportId && (
                    <div className="rounded-lg px-3 py-2.5 text-xs" style={{ background: 'var(--danger-subtle)', color: 'var(--danger)' }}>
                      {t('imp.replaceWarning')}
                    </div>
                  )}

                  <div className="flex flex-col sm:flex-row gap-2">
                    <button
                      onClick={() => { setShowDuplicateWarning(false); setReplaceImportId(null); }}
                      className="flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium"
                      style={{ background: 'var(--bg-muted)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
                    >
                      {t('common.cancel')}
                    </button>
                    <button
                      onClick={() => {
                        setShowDuplicateWarning(false);
                        setReplaceImportId(null);
                        const result = builtResult ?? buildTripRows();
                        doImport(result.rows, null);
                      }}
                      disabled={importing}
                      className="flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium"
                      style={{ background: 'var(--accent)', color: 'white' }}
                    >
                      <Plus size={14} /> {t('imp.importAdditionally')}
                    </button>
                    {replaceImportId && onDeleteImport && (
                      <button
                        onClick={() => {
                          setShowDuplicateWarning(false);
                          const result = builtResult ?? buildTripRows();
                          doImport(result.rows, replaceImportId);
                        }}
                        disabled={importing || replacingImport}
                        className="flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium"
                        style={{ background: 'var(--danger)', color: 'white' }}
                      >
                        <RefreshCw size={14} />
                        {replacingImport ? t('imp.replacing') : t('imp.replaceExisting')}
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* Canceled trip notice */}
              {stats && stats.canceled > 0 && (
                <div className="flex items-start gap-2 p-3 rounded-lg"
                  style={{ background: 'var(--warning-subtle)', border: '1px solid var(--warning)' }}>
                  <AlertTriangle size={14} style={{ color: 'var(--warning)', flexShrink: 0, marginTop: 2 }} />
                  <p className="text-sm" style={{ color: 'var(--warning)' }}>
                    {t('imp.canceledNotice', { count: stats.canceled })}
                    {stats.statusColName ? ` (${t('imp.columnNamed', { column: stats.statusColName })})` : ''}
                  </p>
                </div>
              )}

              {/* Rejection breakdown — only truly skipped rows */}
              {stats && (stats.badDate + stats.badStartTime + stats.badEndTime + stats.missingDriver + stats.other) > 0 && (
                <div className="p-3 rounded-lg space-y-2"
                  style={{ background: 'var(--warning-subtle)', border: '1px solid var(--warning)' }}>
                  <p className="text-sm font-medium" style={{ color: 'var(--warning)' }}>
                    {t('imp.skippedRows', { count: stats.total - stats.valid - stats.canceled })}
                  </p>
                  <div className="text-xs space-y-1" style={{ color: 'var(--text-secondary)' }}>
                    {stats.badDate > 0 && (
                      <div>
                        <p>{t('imp.reject.badDate', { count: stats.badDate })} — {t('imp.column')}: <b>"{stats.dateColName}"</b></p>
                        {stats.sampleBadDate.length > 0 && (
                          <p className="font-mono pl-2" style={{ color: 'var(--danger)' }}>
                            {t('imp.examples')}: {stats.sampleBadDate.map(v => `"${v}"`).join(', ')}
                          </p>
                        )}
                      </div>
                    )}
                    {stats.badStartTime > 0 && (
                      <div>
                        <p>{t('imp.reject.badStartTime', { count: stats.badStartTime })} — {t('imp.column')}: <b>"{stats.startTimeColName}"</b></p>
                        {stats.sampleBadStartTime.length > 0 && (
                          <p className="font-mono pl-2" style={{ color: 'var(--danger)' }}>
                            {t('imp.examples')}: {stats.sampleBadStartTime.map(v => `"${v}"`).join(', ')}
                          </p>
                        )}
                        <p className="pl-2" style={{ color: 'var(--text-tertiary)' }}>
                          {t('imp.reject.checkColumnHint')}
                        </p>
                      </div>
                    )}
                    {stats.badEndTime    > 0 && <p>{t('imp.reject.badEndTime')}: {stats.badEndTime}</p>}
                    {stats.missingDriver > 0 && <p>{t('imp.reject.missingDriver')}: {stats.missingDriver}</p>}
                    {stats.other         > 0 && <p>{t('imp.reject.other')}: {stats.other}</p>}
                  </div>
                </div>
              )}

              {unmatchedDrivers > 0 && (
                <div className="flex items-start gap-2 p-3 rounded-lg"
                  style={{ background: 'var(--warning-subtle)', border: '1px solid var(--warning)' }}>
                  <AlertTriangle size={14} style={{ color: 'var(--warning)', flexShrink: 0, marginTop: 2 }} />
                  <p className="text-sm" style={{ color: 'var(--warning)' }}>
                    {t('imp.unmatchedDriversNotice', { count: unmatchedDrivers })}
                  </p>
                </div>
              )}

              {validRows.length === 0 && (
                <div className="flex items-start gap-2 p-4 rounded-lg"
                  style={{ background: 'var(--danger-subtle)', border: '1px solid var(--danger)' }}>
                  <AlertTriangle size={16} style={{ color: 'var(--danger)', flexShrink: 0, marginTop: 2 }} />
                  <div>
                    <p className="text-sm font-medium" style={{ color: 'var(--danger)' }}>
                      {t('imp.noValidTripsTitle')}
                    </p>
                    <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
                      {t('imp.noValidTripsHint')}
                    </p>
                  </div>
                </div>
              )}

              {/* Preview table */}
              {validRows.length > 0 && (
                <div>
                  <p className="text-xs font-medium mb-2" style={{ color: 'var(--text-tertiary)' }}>
                    {t('imp.previewTrips')}
                  </p>
                  <div className="overflow-x-auto rounded-lg" style={{ border: '1px solid var(--border)' }}>
                    <table className="w-full text-xs">
                      <thead style={{ background: 'var(--bg-subtle)' }}>
                        <tr>
                          {([
                            'common.date', 'imp.th.start', 'imp.th.end', 'imp.th.originalDriver',
                            'imp.th.plate', 'imp.th.price', 'imp.th.tip',
                          ] as TranslationKey[]).map(headerKey => (
                            <th key={headerKey} className="px-2 py-2 text-left font-medium whitespace-nowrap"
                              style={{ color: 'var(--text-tertiary)' }}>{t(headerKey)}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {validRows.slice(0, 10).map((r, i) => (
                          <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                            <td className="px-2 py-1.5 whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>{r.trip_date}</td>
                            <td className="px-2 py-1.5 whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>{r.start_time}</td>
                            <td className="px-2 py-1.5 whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>{r.end_time}</td>
                            <td className="px-2 py-1.5 whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>{r.original_driver_name}</td>
                            <td className="px-2 py-1.5 whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{r.car_identifier || '-'}</td>
                            <td className="px-2 py-1.5 whitespace-nowrap" style={{ color: 'var(--accent-text)' }}>{r.price_amount.toFixed(2)} €</td>
                            <td className="px-2 py-1.5 whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>{r.tip_amount.toFixed(2)} €</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              <div className="p-3 rounded-lg text-sm"
                style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
                {t('imp.immutableNote')}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4"
          style={{ borderTop: '1px solid var(--border)' }}>
          <button
            onClick={step === 0 ? handleClose : () => setStep(s => s - 1)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium"
            style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
          >
            <ChevronLeft size={16} />
            {step === 0 ? t('common.cancel') : t('common.back')}
          </button>

          {step < STEP_KEYS.length - 1 ? (
            <button
              onClick={() => {
                if (step === 1) buildDriverMatches();
                if (step === 2) buildCarMatches();
                const next = step + 1;
                if (next === 4) {
                  const result = buildTripRows();
                  setBuiltResult(result);
                  setParseStats(result.stats);
                }
                setStep(next);
              }}
              disabled={!canGoNext()}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-opacity"
              style={{ background: 'var(--accent)', color: 'white', opacity: canGoNext() ? 1 : 0.45 }}
            >
              {t('imp.next')} <ChevronRight size={16} />
            </button>
          ) : (
            <button
              onClick={handleImport}
              disabled={importing || validRows.length === 0}
              className="flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-semibold transition-opacity"
              style={{ background: 'var(--success)', color: 'white', opacity: importing || validRows.length === 0 ? 0.5 : 1 }}
            >
              {importing ? t('imp.importing') : (() => {
                const valid    = validRows.filter(r => !r.is_canceled).length;
                const canceled = validRows.filter(r =>  r.is_canceled).length;
                if (canceled > 0) return t('imp.importWithCanceled', { valid, canceled });
                return t('imp.importTrips', { count: valid });
              })()}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default FahrtenbuchImportModal;