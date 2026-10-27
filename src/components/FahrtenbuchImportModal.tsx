import React, { useState, useRef, useCallback, useEffect } from 'react';
import * as XLSX from 'xlsx';
import { Upload, X, ChevronRight, ChevronLeft, Check, AlertTriangle, User, Car as CarIcon, FileSpreadsheet, Eye, RefreshCw, Plus, Info, ExternalLink } from 'lucide-react';
import {
  useFahrtenbuch, TripInsertRow, FahrtenbuchImport, DuplicateImportFileError,
  type ColumnMappingMatch,
} from '../hooks/useFahrtenbuch';
import { useToast } from '../contexts/ToastContext';
import { format } from 'date-fns';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';
import {
  REVIEW_REASONS,
  SOURCE_TIME_ZONE,
  applySourceRowKeys,
  buildTripRows as buildTripRowsFrom,
  driverMatchInfo,
  findOrderTransmissionColumn,
  isMissingCell,
  isValidKennzeichen,
  normalise,
  parseDate,
  parseTime,
  sha256HexOfBytes,
  summariseRows,
  wallAt,
  withoutStoredKeys,
  type BuildStats,
  type CellValue,
  type ColMap,
  type ImportSummary,
  type RawRow,
  type ReviewReason,
  type TripStatus,
} from '../utils/fahrtenbuchImportParser';
import {
  applyRememberedMapping,
  fieldMapOf,
  isStorableMapping,
  sourceShapeKey,
  type MissingMappedColumn,
} from '../utils/importColumnMapping';
import { formatEuro } from './ui/format';

// ── Driver / Car types passed in from parent ──────────────────────────────────
export interface DriverOption { id: string; name: string; }
export interface CarOption    { id: string; plate: string; model?: string; }

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onImported: (importId: string) => void;
  /** Shows an import that already exists — offered when the same file comes again. */
  onOpenExistingImport?: (importId: string) => void;
  drivers: DriverOption[];
  cars: CarOption[];
  existingImports?: FahrtenbuchImport[];
  onDeleteImport?: (importId: string) => Promise<void>;
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

// Auto-match for the optional status column (not part of ColMap — detected
// separately). What its words mean is mapTripStatus's, in the parser.
const STATUS_COL_CANDIDATES = [
  'fahrtstatus','fahrt status','status der fahrt','trip status',
  '=status','auftragsstatus','buchungsstatus',
];

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

// ── The preview: the rows that will be written, and what was left out ─────────
interface ImportPreview {
  rows: TripInsertRow[];
  build: BuildStats;
  summary: ImportSummary;
  /** Rows whose ride an earlier row of the same file already is. */
  inFileDuplicates: number;
  /** Rows whose ride the company already stores. */
  storedDuplicates: number;
  /** Rides that are not cancelled and got no instant (missing, unparsed, DST). */
  withoutInstant: number;
}

const STATUS_LABEL_KEYS: Record<TripStatus, TranslationKey> = {
  completed: 'imp.status.completed',
  cancelled: 'imp.status.cancelled',
  unknown:   'imp.status.unknown',
  declined:  'imp.status.declined',
};

const REASON_LABEL_KEYS: Record<ReviewReason, TranslationKey> = {
  missing_trip_date: 'imp.reason.missingTripDate',
  missing_start:     'imp.reason.missingStart',
  unreadable_start:  'imp.reason.unreadableStart',
  missing_end:       'imp.reason.missingEnd',
  unreadable_end:    'imp.reason.unreadableEnd',
  end_before_start:  'imp.reason.endBeforeStart',
  missing_driver:    'imp.reason.missingDriver',
  unknown_status:    'imp.reason.unknownStatus',
  // 20261023170000's ninth reason. The Record is typed on ReviewReason, so a
  // tenth reason fails to compile until it has a label here and in both
  // dictionaries — the same fail-closed shape SEED_PLAN_FEATURES has.
  unreadable_order_transmission: 'imp.reason.unreadableOrderTransmission',
};

/** DD.MM.YYYY HH:MM:SS of an instant, on the clock the file was written in. */
function formatSourceWall(iso: string | null): string {
  if (!iso) return '—';
  const w = wallAt(Date.parse(iso), SOURCE_TIME_ZONE);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(w.day)}.${p(w.month)}.${w.year} ${p(w.hour)}:${p(w.minute)}:${p(w.second)}`;
}

/**
 * DD.MM.YYYY of the moment a mapping was last confirmed.
 *
 * German formatting in both languages, like every other date in the product. An
 * empty or unparseable timestamp prints the em dash rather than `Invalid Date`:
 * the value comes out of a jsonb-adjacent row that a restored backup may have
 * written, so it is data and not a contract.
 */
function formatSavedAt(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  return format(new Date(ms), 'dd.MM.yyyy');
}

/** DD.MM.YYYY of a stored YYYY-MM-DD. */
function formatIsoDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

// Notices in the legacy palette, drawn with classes rather than inline styles.
type NoticeTone = 'warning' | 'danger' | 'info';
const NOTICE_TONE: Record<NoticeTone, string> = {
  warning: 'border-[color:var(--warning)] bg-[color:var(--warning-subtle)] text-[color:var(--warning)]',
  danger:  'border-[color:var(--danger)] bg-[color:var(--danger-subtle)] text-[color:var(--danger)]',
  info:    'border-[color:var(--border)] bg-[color:var(--bg-subtle)] text-[color:var(--text-secondary)]',
};

const Notice: React.FC<{ tone: NoticeTone; children: React.ReactNode }> = ({ tone, children }) => (
  <div className={`flex items-start gap-2 p-3 rounded-lg border ${NOTICE_TONE[tone]}`}>
    {tone === 'info'
      ? <Info size={14} className="shrink-0 mt-0.5" />
      : <AlertTriangle size={14} className="shrink-0 mt-0.5" />}
    <div className="text-sm space-y-1 min-w-0">{children}</div>
  </div>
);

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// Parsing a cell (dates, times, money, plates) is the parser's:
// utils/fahrtenbuchImportParser.ts.

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
  isOpen, onClose, onImported, onOpenExistingImport, drivers, cars, existingImports, onDeleteImport,
}) => {
  const {
    createImport, findImportByFileHash, findStoredSourceRowKeys,
    findColumnMapping, rememberColumnMapping,
  } = useFahrtenbuch();
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
  const [statusColName, setStatusColName] = useState('');
  // Column B of the Uber export; the ride key's basis when the file has it.
  const [orderTransmissionCol, setOrderTransmissionCol] = useState('');

  const [sourceSheetName, setSourceSheetName] = useState('Sheet1');

  // Duplicate import conflict state
  const [showDuplicateWarning, setShowDuplicateWarning] = useState(false);
  const [replaceImportId, setReplaceImportId] = useState<string | null>(null);
  const [replacingImport, setReplacingImport] = useState(false);

  // Raw XLSX bytes preserved for storage upload on confirm
  const [rawXlsxBytes, setRawXlsxBytes] = useState<Uint8Array | null>(null);

  // The file's fingerprint, and the import that already holds the same file.
  const [fileSha256, setFileSha256] = useState('');
  const [hashChecking, setHashChecking] = useState(false);
  const [existingForFile, setExistingForFile] = useState<FahrtenbuchImport | null>(null);
  // Only the answer for the file chosen last may land.
  const latestHash = useRef('');

  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  // ── The remembered column mapping (20261023210000) ──────────────────────────
  // The fingerprint of this file's headers, what was remembered for it, and the
  // columns that mapping names which this file has not got. `mappingMissing` is
  // the whole point of the feature: those fields are left EMPTY rather than
  // falling back to the automatic match, and named below, so a stored mapping
  // can never quietly resolve to a different column.
  const [mappingShapeKey, setMappingShapeKey] = useState('');
  const [mappingMatch, setMappingMatch] = useState<ColumnMappingMatch>('none');
  const [mappingAppliedCount, setMappingAppliedCount] = useState(0);
  const [mappingMissing, setMappingMissing] = useState<MissingMappedColumn[]>([]);
  const [mappingSavedAt, setMappingSavedAt] = useState('');
  const [mappingLookupFailed, setMappingLookupFailed] = useState(false);
  // Only the answer for the file chosen last may land (`latestHash`'s rule).
  const fileToken = useRef(0);

  const reset = () => {
    setStep(0); setFileName(''); setRawRows([]); setHeaders([]); setParseError('');
    setColMap({
      trip_date:'', start_time:'', end_time:'', driver_name:'',
      car_identifier:'', price_amount:'', tip_amount:'',
      payment_method:'', route_start:'', route_end:'', description:'',
    });
    setStatusColName(''); setOrderTransmissionCol(''); setSourceSheetName('Sheet1');
    setDriverMatches([]); setCarMatches([]); setImporting(false);
    setShowDuplicateWarning(false); setReplaceImportId(null); setReplacingImport(false);
    setRawXlsxBytes(null);
    setFileSha256(''); setHashChecking(false); setExistingForFile(null); latestHash.current = '';
    setPreview(null); setPreviewLoading(false);
    setMappingShapeKey(''); setMappingMatch('none'); setMappingAppliedCount(0);
    setMappingMissing([]); setMappingSavedAt(''); setMappingLookupFailed(false);
    fileToken.current += 1;
  };

  const handleClose = () => { reset(); onClose(); };

  // ── File parsing ─────────────────────────────────────────────────────────────
  /*
    The same file is imported once per company. The fingerprint is taken from
    the bytes as read, before anything is uploaded, and the company's imports
    are asked for it; the unique constraint behind createImport is the wall
    for two uploads racing.
  */
  const checkFileFingerprint = useCallback(async (data: Uint8Array) => {
    setFileSha256('');
    setExistingForFile(null);
    setHashChecking(true);
    try {
      const hash = await sha256HexOfBytes(data);
      latestHash.current = hash;
      const existing = await findImportByFileHash(hash);
      if (latestHash.current !== hash) return;
      setFileSha256(hash);
      setExistingForFile(existing);
    } catch (err) {
      setParseError(t('imp.error.hashFailed', { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setHashChecking(false);
    }
  }, [findImportByFileHash, t]);

  /*
    What step 1 opens with: the automatic match, with whatever this company
    remembered laid over it.

    The order is `applyRememberedMapping`'s and lives there, not here: a
    remembered header the file actually has wins over the automatic match, one
    the file has NOT got leaves its field empty and is reported, and a field
    nobody remembered keeps the automatic match. A failed lookup leaves the
    automatic match alone and says so — silently falling back would leave an
    operator who has a saved mapping looking at columns they did not choose and
    no reason to look twice.

    `token` is the file this answer belongs to; a second file chosen while this
    is in flight makes the answer stale and it is dropped.
  */
  const loadRememberedMapping = useCallback(async (
    token: number, hdrs: string[], autoMatched: ColMap,
  ) => {
    let shape = '';
    try {
      shape = await sourceShapeKey(hdrs);
      const { mapping, match } = await findColumnMapping(shape);
      if (fileToken.current !== token) return;
      const outcome = applyRememberedMapping({ headers: hdrs, autoMatched, stored: mapping });
      setMappingShapeKey(shape);
      setMappingMatch(mapping ? match : 'none');
      setMappingAppliedCount(outcome.applied.length);
      setMappingMissing(outcome.missing);
      setMappingSavedAt(mapping?.updated_at ?? '');
      setColMap(outcome.colMap);
    } catch (err) {
      if (fileToken.current !== token) return;
      // The shape key is kept when it was computed: the mapping could not be
      // read, but the operator's confirmed choice can still be remembered.
      setMappingShapeKey(shape);
      setMappingMatch('none');
      setMappingAppliedCount(0);
      setMappingMissing([]);
      setMappingSavedAt('');
      setMappingLookupFailed(true);
      if (import.meta.env.DEV) {
        console.warn('[Fahrtenbuch] the remembered column mapping was not read:', err);
      }
    }
  }, [findColumnMapping]);

  const handleFile = useCallback((file: File) => {
    setParseError('');
    setFileName(file.name);
    // A new file: every answer still in flight for the previous one is stale.
    fileToken.current += 1;
    const token = fileToken.current;
    setMappingShapeKey(''); setMappingMatch('none'); setMappingAppliedCount(0);
    setMappingMissing([]); setMappingSavedAt(''); setMappingLookupFailed(false);
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target!.result as ArrayBuffer);
        setRawXlsxBytes(data);
        void checkFileFingerprint(data);
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
        setOrderTransmissionCol(findOrderTransmissionColumn(hdrs));
        // Then whatever this company remembered for a file of this shape, laid
        // over that automatic match. Asynchronous, so the automatic match is
        // what is on screen until the answer arrives.
        void loadRememberedMapping(token, hdrs, auto);
      } catch (err: any) {
        console.error('[Fahrtenbuch] Parse error:', err);
        setParseError(t('imp.error.readFile', { message: err.message || String(err) }));
      }
    };
    reader.readAsArrayBuffer(file);
  }, [t, checkFileFingerprint, loadRememberedMapping]);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  };

  // ── Step navigation ───────────────────────────────────────────────────────────
  const canGoNext = () => {
    // A file the company already imported goes no further.
    if (step === 0) return rawRows.length > 0 && !parseError && fileSha256 !== '' && !hashChecking && !existingForFile;
    if (step === 1) return REQUIRED_COLS.every(k => colMap[k] !== '');
    if (step === 2) return driverMatches.every(d => d.confirmed);
    return true; // step 3 (cars) is always optional
  };

  /*
    Remember the mapping the operator has just confirmed.

    Called when step 1 is LEFT, not when the import is written: leaving the
    mapping step is the operator's confirmation of these eleven choices, and it
    is the only moment this feature touches. The import's write path is
    unchanged, which also means an import abandoned later — at the duplicate-file
    wall, say — still leaves the mapping remembered, and that is wanted: the
    next attempt opens with the columns the operator already chose.

    `canGoNext` has already required the four mandatory fields, so
    `isStorableMapping` is the second wall rather than the gate; it is the
    browser's copy of the table's constraints and its guard, so a payload the
    database would refuse is not sent. The write itself never raises.
  */
  const saveColumnMapping = useCallback(async () => {
    if (mappingShapeKey === '') return;
    const fieldMap = fieldMapOf(colMap);
    if (!isStorableMapping(headers, fieldMap)) return;
    await rememberColumnMapping({
      sourceShapeKey: mappingShapeKey, sourceHeaders: headers, fieldMap,
    });
  }, [mappingShapeKey, colMap, headers, rememberColumnMapping]);

  const goNext = () => {
    if (step === 1) { buildDriverMatches(); void saveColumnMapping(); }
    if (step === 2) buildCarMatches();
    setStep(s => s + 1);
  };

  const buildDriverMatches = () => {
    // An empty cell or `\N` names no driver: the row is stored without one and flagged.
    const names = [...new Set(
      rawRows
        .filter(r => !isMissingCell(r[colMap.driver_name]))
        .map(r => String(r[colMap.driver_name]).trim())
    )];
    // Only a name a driver actually carries is confirmed for the user. A single
    // near-match is offered but stays unconfirmed, and two or more offer nothing:
    // canGoNext blocks Weiter while any row is unconfirmed and the amber note
    // below names them, so the choice reaches a person instead of being guessed.
    // matchDriverName says why.
    const matches: DriverMatch[] = names.map(name => ({
      importedName: name,
      ...driverMatchInfo(name, drivers),
    }));
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

  // ── Build the preview ─────────────────────────────────────────────────────────
  /*
    Every uploaded row becomes a trip row (utils/fahrtenbuchImportParser.ts),
    except one no date can be given to. Then the second copy of a ride inside
    the file is dropped, and the rides the company already stores are left
    out — leaving out the import the user chose to replace, which is deleted
    before the new one is written. createImport asks the database again at
    write time, so a count here that went stale is corrected there.
  */
  const buildPreview = useCallback(async (excludeImportId: string | null) => {
    setPreview(null);
    setPreviewLoading(true);
    try {
      const { built, stats } = buildTripRowsFrom({
        rows: rawRows,
        colMap,
        statusCol: statusColName,
        orderTransmissionCol,
        driverMatches: new Map(driverMatches.map(d => [d.importedName, d])),
        carMatches: new Map(carMatches.map(c => [c.importedPlate, c])),
      });
      const keyed = await applySourceRowKeys(built);
      const stored = await findStoredSourceRowKeys(
        keyed.rows.flatMap(r => (r.source_row_key ? [r.source_row_key] : [])),
        excludeImportId,
      );
      const { rows, refused } = withoutStoredKeys(keyed.rows, stored);
      setPreview({
        rows,
        build: stats,
        summary: summariseRows(rows),
        inFileDuplicates: keyed.inFileDuplicates,
        storedDuplicates: refused,
        withoutInstant: rows.filter(r => !r.is_canceled && r.start_at === null).length,
      });
    } catch (err) {
      setPreview(null);
      showError(t('common.error'), t('imp.error.previewFailed', {
        message: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setPreviewLoading(false);
    }
  }, [rawRows, colMap, statusColName, orderTransmissionCol, driverMatches, carMatches,
      findStoredSourceRowKeys, showError, t]);

  // Choosing an import to replace changes which stored rides count as
  // duplicates: that import's rides are about to be deleted.
  useEffect(() => {
    if (step === 4) void buildPreview(replaceImportId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replaceImportId]);

  const conflictingImports = existingImports?.filter(
    imp => imp.month === month && imp.year === year,
  ) ?? [];

  const handleImport = async () => {
    if (!preview || preview.rows.length === 0) {
      showError(t('common.error'), t('imp.error.noValidTrips'));
      return;
    }
    // Check for duplicate month/year imports
    if (conflictingImports.length > 0 && !showDuplicateWarning) {
      setShowDuplicateWarning(true);
      return;
    }
    await doImport(preview.rows, replaceImportId);
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
      const result = await createImport({
        month, year, fileName, trips: rows, fileSha256, sourceSheetName,
        sourceColumns: headers, xlsxBytes: rawXlsxBytes ?? undefined,
      });
      success(t('imp.toast.successTitle'), t('imp.toast.successDetail', {
        count: result.inserted, duplicates: result.duplicatesRefused,
      }));
      reset();
      onImported(result.importId);
    } catch (err: any) {
      if (err instanceof DuplicateImportFileError) {
        setExistingForFile(err.existing);
        setStep(0);
      }
      showError(t('imp.toast.failedTitle'), err.message || String(err));
    } finally {
      setImporting(false);
    }
  };

  const openExistingImport = (importId: string) => {
    reset();
    if (onOpenExistingImport) onOpenExistingImport(importId);
    else onClose();
  };

  const previewRows = rawRows.slice(0, 5);

  if (!isOpen) return null;

  const inputSt: React.CSSProperties = {
    background: 'var(--bg-subtle)', border: '1px solid var(--border)',
    borderRadius: '0.5rem', color: 'var(--text-primary)',
    fontSize: '0.875rem', padding: '0.5rem 0.75rem', outline: 'none', width: '100%',
  };
  const selectSt: React.CSSProperties = { ...inputSt, cursor: 'pointer' };

  const validRows  = preview?.rows ?? [];
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

              {hashChecking && (
                <p className="text-sm text-[color:var(--text-tertiary)]">{t('imp.hashChecking')}</p>
              )}

              {existingForFile && (
                <Notice tone="danger">
                  <p className="font-medium">{t('imp.duplicateFile.title')}</p>
                  <p>
                    {t('imp.duplicateFile.body', {
                      fileName: existingForFile.file_name,
                      month: t(MONTH_KEYS[existingForFile.month - 1]),
                      year: existingForFile.year,
                      date: format(new Date(existingForFile.imported_at), 'dd.MM.yyyy HH:mm'),
                      count: existingForFile.row_count,
                    })}
                  </p>
                  <p>{t('imp.duplicateFile.hint')}</p>
                  <button
                    type="button"
                    onClick={() => openExistingImport(existingForFile.id)}
                    className="mt-1 inline-flex items-center gap-1.5 rounded-lg border border-[color:var(--danger)] px-3 py-1.5 text-xs font-medium [@media(pointer:coarse)]:min-h-[40px]"
                  >
                    <ExternalLink size={13} /> {t('imp.duplicateFile.open')}
                  </button>
                </Notice>
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

              {/* What was remembered for this company, and what of it no longer
                  fits this file. The second notice is the feature's point: a
                  stored column the file has not got leaves its field empty and
                  is named here, never resolved to a different column. */}
              {mappingLookupFailed && (
                <Notice tone="warning">
                  <p>{t('imp.mapping.lookupFailed')}</p>
                </Notice>
              )}

              {mappingMatch === 'exact' && mappingAppliedCount > 0 && (
                <Notice tone="info">
                  <p className="font-medium">{t('imp.mapping.rememberedTitle')}</p>
                  <p>{t('imp.mapping.rememberedBody', {
                    count: mappingAppliedCount, date: formatSavedAt(mappingSavedAt),
                  })}</p>
                </Notice>
              )}

              {mappingMatch === 'other_shape' && (
                <Notice tone="warning">
                  <p className="font-medium">{t('imp.mapping.otherShapeTitle')}</p>
                  <p>{t('imp.mapping.otherShapeBody', {
                    count: mappingAppliedCount, date: formatSavedAt(mappingSavedAt),
                  })}</p>
                </Notice>
              )}

              {mappingMissing.length > 0 && (
                <Notice tone="danger">
                  <p className="font-medium">{t('imp.mapping.staleTitle')}</p>
                  <p>{t('imp.mapping.staleBody', {
                    count: mappingMissing.length,
                    columns: mappingMissing
                      .map(m => t('imp.mapping.staleColumn', {
                        field: t(COL_LABEL_KEYS[m.field]), column: m.header,
                      }))
                      .join(', '),
                  })}</p>
                </Notice>
              )}

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
              {previewLoading && (
                <p className="text-sm text-[color:var(--text-tertiary)]">{t('imp.previewLoading')}</p>
              )}

              {/* Summary cards — the rows that will be written, by status */}
              {preview && (() => {
                const { summary } = preview;
                const duplicates = preview.inFileDuplicates + preview.storedDuplicates;
                const cards: { labelKey: TranslationKey; value: string | number; tone: string }[] = [
                  { labelKey: 'imp.card.completed',     value: summary.completed,   tone: 'text-[color:var(--accent)]' },
                  { labelKey: 'imp.card.canceledTrips', value: summary.cancelled,   tone: summary.cancelled > 0 ? 'text-[color:var(--warning)]' : 'text-[color:var(--text-tertiary)]' },
                  { labelKey: 'imp.card.unknownStatus', value: summary.unknown,     tone: summary.unknown > 0 ? 'text-[color:var(--danger)]' : 'text-[color:var(--text-tertiary)]' },
                  { labelKey: 'imp.card.needsReview',   value: summary.needsReview, tone: summary.needsReview > 0 ? 'text-[color:var(--warning)]' : 'text-[color:var(--success)]' },
                  { labelKey: 'imp.card.duplicates',    value: duplicates,          tone: duplicates > 0 ? 'text-[color:var(--warning)]' : 'text-[color:var(--text-tertiary)]' },
                  { labelKey: 'imp.card.monthYear',     value: `${month}/${year}`,  tone: 'text-[color:var(--text-primary)]' },
                ];
                return (
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    {cards.map(card => (
                      <div key={card.labelKey} className="rounded-lg p-3 border border-[color:var(--border)] bg-[color:var(--bg-subtle)]">
                        <p className="text-xs text-[color:var(--text-tertiary)]">{t(card.labelKey)}</p>
                        <p className={`text-xl font-bold mt-1 tabular-nums ${card.tone}`}>{card.value}</p>
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
                        // createImport leaves out the rides the kept import holds.
                        if (preview) void doImport(preview.rows, null);
                      }}
                      disabled={importing || !preview}
                      className="flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium"
                      style={{ background: 'var(--accent)', color: 'var(--text-inverse)' }}
                    >
                      <Plus size={14} /> {t('imp.importAdditionally')}
                    </button>
                    {replaceImportId && onDeleteImport && (
                      <button
                        onClick={() => {
                          setShowDuplicateWarning(false);
                          if (preview) void doImport(preview.rows, replaceImportId);
                        }}
                        disabled={importing || replacingImport || previewLoading || !preview}
                        className="flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium"
                        style={{ background: 'var(--danger-solid)', color: 'white' }}
                      >
                        <RefreshCw size={14} />
                        {replacingImport ? t('imp.replacing') : t('imp.replaceExisting')}
                      </button>
                    )}
                  </div>
                </div>
              )}

              {preview && (() => {
                const { summary, build } = preview;
                const duplicates = preview.inFileDuplicates + preview.storedDuplicates;
                const reasons = REVIEW_REASONS.filter(r => summary.reasons[r] > 0);
                return (
                  <>
                    {/* Rows no date can be given to: trip_date is NOT NULL, and none is invented. */}
                    {build.heldBackNoDate > 0 && (
                      <Notice tone="danger">
                        {t('imp.notice.heldBack', {
                          count: build.heldBackNoDate,
                          rows: build.heldBackRows.join(', ') + (build.heldBackNoDate > build.heldBackRows.length ? ', …' : ''),
                        })}
                      </Notice>
                    )}

                    {summary.unknown > 0 && (
                      <Notice tone="danger">
                        {t('imp.notice.unknownStatus', { count: summary.unknown })}
                        {statusColName ? ` (${t('imp.columnNamed', { column: statusColName })})` : ` ${t('imp.notice.noStatusColumn')}`}
                      </Notice>
                    )}

                    {summary.cancelled > 0 && (
                      <Notice tone="warning">
                        {t('imp.canceledNotice', { count: summary.cancelled })}
                        {statusColName ? ` (${t('imp.columnNamed', { column: statusColName })})` : ''}
                      </Notice>
                    )}

                    {summary.needsReview > 0 && (
                      <Notice tone="warning">
                        <p>{t('imp.notice.needsReview', { count: summary.needsReview })}</p>
                        <ul className="list-disc pl-5 text-xs text-[color:var(--text-secondary)]">
                          {reasons.map(reason => (
                            <li key={reason}>
                              {t('imp.reasonCount', { label: t(REASON_LABEL_KEYS[reason]), count: summary.reasons[reason] })}
                            </li>
                          ))}
                        </ul>
                        {build.sampleUnreadableStart.length > 0 && (
                          <p className="text-xs text-[color:var(--text-secondary)]">
                            {t('imp.column')}: <b>"{colMap.start_time}"</b> — {t('imp.examples')}:{' '}
                            <span className="font-mono">{build.sampleUnreadableStart.map(v => `"${String(v)}"`).join(', ')}</span>
                          </p>
                        )}
                      </Notice>
                    )}

                    {duplicates > 0 && (
                      <Notice tone="warning">{t('imp.notice.duplicates', { count: duplicates })}</Notice>
                    )}

                    {build.startDateDiffers > 0 && (
                      <Notice tone="info">{t('imp.notice.startDateDiffers', { count: build.startDateDiffers })}</Notice>
                    )}

                    {preview.withoutInstant > 0 && (
                      <Notice tone="info">{t('imp.notice.withoutInstant', { count: preview.withoutInstant })}</Notice>
                    )}

                    {/*
                      An order time that is not a timestamp. The column is the
                      row's duplicate key and is stored as text, parsed into no
                      column of its own, so nothing on the row says it cannot
                      be read — see the count's comment in buildTripRows. The
                      rows are still imported and no value is guessed; this is
                      what stops a malformed file from being taken in silently.
                    */}
                    {build.unreadableOrderTransmission > 0 && (
                      <Notice tone="warning">
                        <p>
                          {t('imp.notice.unreadableOrderTransmission', {
                            count: build.unreadableOrderTransmission,
                            column: orderTransmissionCol,
                          })}
                        </p>
                        {build.sampleUnreadableOrderTransmission.length > 0 && (
                          <p className="text-xs text-[color:var(--text-secondary)]">
                            {t('imp.examples')}:{' '}
                            <span className="font-mono">
                              {build.sampleUnreadableOrderTransmission.map(v => `"${String(v)}"`).join(', ')}
                            </span>
                          </p>
                        )}
                      </Notice>
                    )}

                    <Notice tone="info">
                      <p>
                        {orderTransmissionCol
                          ? t('imp.notice.keyBasisOrder', { column: orderTransmissionCol })
                          : t('imp.notice.keyBasisStart')}
                      </p>
                      <p>{t('imp.notice.currencyAssumed')}</p>
                    </Notice>
                  </>
                );
              })()}

              {unmatchedDrivers > 0 && (
                <div className="flex items-start gap-2 p-3 rounded-lg"
                  style={{ background: 'var(--warning-subtle)', border: '1px solid var(--warning)' }}>
                  <AlertTriangle size={14} style={{ color: 'var(--warning)', flexShrink: 0, marginTop: 2 }} />
                  <p className="text-sm" style={{ color: 'var(--warning)' }}>
                    {t('imp.unmatchedDriversNotice', { count: unmatchedDrivers })}
                  </p>
                </div>
              )}

              {preview && validRows.length === 0 && (
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

              {/* Preview table: the start as the file's clock read it, seconds kept */}
              {validRows.length > 0 && (
                <div>
                  <p className="text-xs font-medium mb-2 text-[color:var(--text-tertiary)]">
                    {t('imp.previewTrips')}
                  </p>
                  <div className="overflow-x-auto rounded-lg border border-[color:var(--border)]">
                    <table className="w-full text-xs">
                      <thead className="bg-[color:var(--bg-subtle)]">
                        <tr>
                          {([
                            'common.date', 'imp.th.startAt', 'imp.th.endAt', 'imp.th.originalDriver',
                            'imp.th.plate', 'imp.th.price', 'imp.th.status',
                          ] as TranslationKey[]).map(headerKey => (
                            <th key={headerKey}
                              className="px-2 py-2 text-left font-medium whitespace-nowrap text-[color:var(--text-tertiary)]">
                              {t(headerKey)}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {validRows.slice(0, 10).map((r, i) => (
                          <tr key={i} className="border-t border-[color:var(--border)] text-[color:var(--text-primary)]">
                            <td className="px-2 py-1.5 whitespace-nowrap tabular-nums">{formatIsoDate(r.trip_date)}</td>
                            <td className="px-2 py-1.5 whitespace-nowrap tabular-nums">{r.start_at ? formatSourceWall(r.start_at) : (r.start_time ?? '—')}</td>
                            <td className="px-2 py-1.5 whitespace-nowrap tabular-nums">{r.end_at ? formatSourceWall(r.end_at) : (r.end_time ?? '—')}</td>
                            <td className="px-2 py-1.5 whitespace-nowrap">{r.original_driver_name || '—'}</td>
                            <td className="px-2 py-1.5 whitespace-nowrap text-[color:var(--text-secondary)]">{r.car_identifier || '-'}</td>
                            <td className="px-2 py-1.5 whitespace-nowrap tabular-nums text-[color:var(--accent-text)]">{formatEuro(r.price_amount)}</td>
                            <td className="px-2 py-1.5 whitespace-nowrap">
                              {t(STATUS_LABEL_KEYS[r.trip_status])}
                              {r.needs_review && <span className="ml-1 text-[color:var(--warning)]">· {t('imp.th.review')}</span>}
                            </td>
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
                if (next === 4) void buildPreview(replaceImportId);
                setStep(next);
              }}
              disabled={!canGoNext()}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-opacity"
              style={{ background: 'var(--accent)', color: 'var(--text-inverse)', opacity: canGoNext() ? 1 : 0.45 }}
            >
              {t('imp.next')} <ChevronRight size={16} />
            </button>
          ) : (
            <button
              onClick={handleImport}
              disabled={importing || previewLoading || validRows.length === 0}
              className="flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-semibold transition-opacity"
              style={{ background: 'var(--success-solid)', color: 'white', opacity: importing || previewLoading || validRows.length === 0 ? 0.5 : 1 }}
            >
              {importing ? t('imp.importing') : t('imp.importTrips', { count: validRows.length })}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default FahrtenbuchImportModal;