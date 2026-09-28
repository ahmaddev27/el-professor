import * as XLSX from 'xlsx';
import type { FahrtenbuchTrip } from '../hooks/useFahrtenbuch';
import { validateDriverNotesForPlanStep, type NoteViolation } from './driverNoteValidation';
import type { StructuredNote } from './monatsplanungPhase3';

export type { NoteViolation };

/** Options for pre-export driver-note validation. */
export interface ExportNoteGuardOptions {
  driverNotesMap?: Map<string, StructuredNote[]>;
}

/**
 * Validate that all trips in the export have a valid Fahrername and no note
 * violations. Returns violations (empty = OK).
 *
 * Call before exportFahrtenbuch() to enforce the export guard.
 */
export function validateExportDriverNotes(
  trips: FahrtenbuchTrip[],
  opts?: ExportNoteGuardOptions,
): NoteViolation[] {
  const notesMap = opts?.driverNotesMap ?? new Map();
  const activeTips = trips.filter(t => !t.is_canceled);

  const rides = activeTips.map(t => {
    const startMs = parseLocalDate(t.trip_date, t.start_time);
    const endMs = parseLocalDate(t.trip_date, t.end_time ?? t.start_time);
    return {
      blockId: t.id,
      vehicleIdentifier: t.car_identifier ?? undefined,
      driverId: t.assigned_driver_id ?? t.original_driver_id ?? '',
      driverName: t.assigned_driver_name || t.original_driver_name || '',
      startMs,
      endMs,
    };
  });

  return validateDriverNotesForPlanStep({
    stepName: 'Export: Fahrtenbuch',
    rides,
    driverNotesMap: notesMap,
  }).violations;
}

function parseLocalDate(date: string, time: string | null | undefined): number {
  const d = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!d) return 0;
  const t = time ? /^(\d{1,2}):(\d{2})/.exec(time) : null;
  return new Date(+d[1], +d[2] - 1, +d[3], t ? +t[1] : 0, t ? +t[2] : 0).getTime();
}

const DRIVER_COL_CANDIDATES = [
  'fahrername', 'fahrer name', 'fahrer', 'driver name', 'driver',
];

export const FAHRTENBUCH_ORIGINAL_COLUMNS = [
  'Datum/Uhrzeit Auftragseingang',
  'Uhrzeit der Auftragsuebermittlung',
  'Geplante Abholzeit',
  'Datum der Fahrt',
  'Fahrtstatus',
  'Standort des Fahrzeugs bei Auftragsuebermittlung',
  'Uhrzeit des Fahrtbeginns',
  'Uhrzeit des Fahrtendes',
  'Kennzeichen',
  'Fahrzeugtyp',
  'Fahrername',
  'Fahrpreis',
  'Trinkgeld',
  'Kilometer',
  'Zahlungsart',
  'Abholort',
  'Zielort',
  'Vorreservierte Fahrt',
];

/**
 * ── Number formats for source cells that arrive as Excel serials ──
 *
 * The importer reads the sheet with `XLSX.read(bytes, { raw: true, cellDates:
 * false })` and `sheet_to_json(ws, { raw: true })` (`FahrtenbuchImportModal`),
 * so a cell Excel stores as a *date* arrives as its serial — `46265` for a
 * date, `0.3451` for a time, `46265.3451` for both — and that serial is what
 * lands in `raw_data_json`. Written straight back with no number format, it
 * reaches the Steuerberater as `46265` where the source sheet read
 * `31.08.2026`.
 *
 * **The source cell's own format string is not available here.** The importer
 * keeps values only; a cell's `z` is never stored, on the import row or
 * anywhere else. So the discriminator is the **column**, never the JS type:
 * `Fahrpreis`, `Trinkgeld` and `Kilometer` are legitimately numeric and must
 * stay bare numbers, and a type-led rule would date-format all three.
 *
 * The column *name* is not enough to say *which* format either. Measured on
 * staging on 28.09.2026, `Uhrzeit des Fahrtbeginns` holds
 * `2026-06-02 17:27:20.000` — a full datetime, despite "Uhrzeit". The serial is
 * the reliable witness, read only inside a column already known to hold a date
 * or a time: below 1 it is a time of day, a whole number is a date, and a
 * fraction above 1 is both.
 *
 * Measured the same day: 13,959 of 13,959 rows on production *and* staging
 * carry all six of these columns as text and all three money columns as
 * numbers, so **no cell either exporter writes today changes**. The rule fails
 * closed — an unrecognised column, a value that is not a finite number, and a
 * number outside the plausible-serial window are all passed through untouched —
 * which is what keeps the 'original' export mode reproducing the imported
 * sheet.
 */
function normaliseSourceColumn(column: string): string {
  return column.toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * The columns of an Uber Fahrtenbuch export that hold a date, a time or both.
 * A subset of FAHRTENBUCH_ORIGINAL_COLUMNS, which the test asserts; the three
 * money columns are deliberately absent.
 */
const DATE_TIME_SOURCE_COLUMNS: ReadonlySet<string> = new Set(
  [
    'Datum/Uhrzeit Auftragseingang',
    'Uhrzeit der Auftragsuebermittlung',
    'Geplante Abholzeit',
    'Datum der Fahrt',
    'Uhrzeit des Fahrtbeginns',
    'Uhrzeit des Fahrtendes',
  ].map(normaliseSourceColumn),
);

/** Excel number-format codes. German display, the DD.MM.YYYY the product uses throughout. */
export const EXCEL_FORMAT_DATE = 'dd.mm.yyyy';
export const EXCEL_FORMAT_TIME = 'hh:mm:ss';
export const EXCEL_FORMAT_DATETIME = 'dd.mm.yyyy hh:mm:ss';

/**
 * 01.01.2000 and 01.01.2100 as Excel serials (verified against the 1899-12-30
 * epoch). A number in a date column outside this window is not a date anybody
 * typed — a 0, a count of minutes, an identifier — so it is left alone rather
 * than rendered as a date in 1904 or 2431.
 */
const SERIAL_DATE_MIN = 36526;
const SERIAL_DATE_MAX = 73051;

/**
 * The Excel number format a source cell needs, or null to write it exactly as
 * this exporter writes it today.
 */
export function sourceCellNumberFormat(column: string, value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (!DATE_TIME_SOURCE_COLUMNS.has(normaliseSourceColumn(column))) return null;
  // A fraction below 1 carries no date part: it is a time of day.
  if (value > 0 && value < 1) return EXCEL_FORMAT_TIME;
  // Exactly 0 is ambiguous — midnight, or the zero an empty numeric cell reads
  // as. It is left untouched on purpose: a bare `0` is visibly wrong to whoever
  // opens the sheet, where a spurious `00:00:00` looks like a real time and
  // would be believed.
  if (value < SERIAL_DATE_MIN || value >= SERIAL_DATE_MAX) return null;
  return Number.isInteger(value) ? EXCEL_FORMAT_DATE : EXCEL_FORMAT_DATETIME;
}

/**
 * Give every source cell that arrived as a serial its number format, in place.
 * `rows` is the data only — `r + 1` skips the header row, which is never
 * touched, because the 'original' mode has to reproduce the imported headers
 * byte for byte. Returns how many cells were formatted.
 */
export function applySourceCellFormats(
  ws: XLSX.WorkSheet,
  columns: readonly string[],
  rows: readonly (readonly unknown[])[],
): number {
  let formatted = 0;
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < columns.length; c++) {
      const z = sourceCellNumberFormat(columns[c], rows[r][c]);
      if (!z) continue;
      const cell = ws[XLSX.utils.encode_cell({ r: r + 1, c })];
      if (!cell) continue;
      cell.t = 'n';
      cell.z = z;
      formatted++;
    }
  }
  return formatted;
}

function findDriverColumn(keys: string[]): string | null {
  const normalized = keys.map(k => k.toLowerCase().trim());
  for (const candidate of DRIVER_COL_CANDIDATES) {
    const idx = normalized.indexOf(candidate);
    if (idx !== -1) return keys[idx];
  }
  for (const candidate of DRIVER_COL_CANDIDATES) {
    const idx = normalized.findIndex(k => k.includes(candidate));
    if (idx !== -1) return keys[idx];
  }
  return null;
}

interface ExportOptions {
  trips: FahrtenbuchTrip[];
  month: number;
  year: number;
  importFileName?: string;
  sourceColumns?: string[] | null;
  sourceSheetName?: string | null;
  skipSort?: boolean;
}

export function exportFahrtenbuch({ trips, month, year, importFileName, sourceColumns, sourceSheetName, skipSort }: ExportOptions) {
  if (trips.length === 0) return;

  const SORT_COL = 'Uhrzeit der Auftragsuebermittlung';
  const firstRawCheck = (trips[0].raw_data_json ?? {}) as Record<string, unknown>;
  const hasSortCol = !skipSort && SORT_COL in firstRawCheck;

  const ordered = skipSort ? trips : [...trips].sort((a, b) => {
    if (hasSortCol) {
      const av = String(((a.raw_data_json ?? {}) as Record<string, unknown>)[SORT_COL] ?? '');
      const bv = String(((b.raw_data_json ?? {}) as Record<string, unknown>)[SORT_COL] ?? '');
      return av.localeCompare(bv);
    }
    if (a.source_row_index != null && b.source_row_index != null) {
      return a.source_row_index - b.source_row_index;
    }
    if (a.source_row_index != null) return -1;
    if (b.source_row_index != null) return 1;
    return a.created_at.localeCompare(b.created_at);
  });

  const firstRaw = ordered[0].raw_data_json;
  if (!firstRaw || typeof firstRaw !== 'object') return;

  const rawKeys = Object.keys(firstRaw);

  let columns: string[];
  if (sourceColumns && sourceColumns.length > 0) {
    columns = sourceColumns;
  } else {
    const allMatch = FAHRTENBUCH_ORIGINAL_COLUMNS.every(c => rawKeys.includes(c));
    columns = allMatch ? FAHRTENBUCH_ORIGINAL_COLUMNS : rawKeys;
  }
  if (columns.length === 0) return;

  const driverCol = findDriverColumn(columns);
  const sheetName = sourceSheetName || 'Sheet1';

  const headers = [...columns];
  const rows = ordered.map(trip => {
    const raw = (trip.raw_data_json ?? {}) as Record<string, unknown>;
    return columns.map(col => {
      if (col === driverCol) {
        return trip.assigned_driver_name || trip.original_driver_name || '';
      }
      const val = raw[col];
      if (val === null || val === undefined) return '';
      return val;
    });
  });

  const data = [headers, ...rows];
  const ws = XLSX.utils.aoa_to_sheet(data);
  applySourceCellFormats(ws, columns, rows);

  ws['!cols'] = columns.map((col, ci) => {
    const maxLen = Math.max(
      col.length,
      ...rows.slice(0, 50).map(r => String(r[ci] ?? '').length)
    );
    return { wch: Math.min(Math.max(maxLen + 2, 10), 40) };
  });

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);

  const filename = importFileName || `Fahrtenbuch_${year}-${String(month).padStart(2, '0')}.xlsx`;
  XLSX.writeFile(wb, filename);
}

const MONTHS = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];

function fmtDate(d: string): string {
  const [y, m, day] = d.split('-');
  return `${day}.${m}.${y}`;
}

function fmtTime(t: string | null): string {
  if (!t) return '';
  return t.slice(0, 5);
}

function changeStatus(trip: FahrtenbuchTrip): string {
  if (trip.is_canceled) return 'Storniert';
  if (
    trip.assigned_driver_id && trip.original_driver_id &&
    trip.assigned_driver_id !== trip.original_driver_id
  ) return 'Geändert';
  if (
    !trip.assigned_driver_id && !trip.original_driver_id
  ) return 'Unverändert';
  if (
    trip.assigned_driver_name !== trip.original_driver_name
  ) return 'Geändert';
  return 'Unverändert';
}

interface AuditExportOptions {
  trips: FahrtenbuchTrip[];
  month: number;
  year: number;
  importFileName?: string;
  isApplied?: boolean;
}

export function exportFahrtenbuchAudit({ trips, month, year, importFileName, isApplied }: AuditExportOptions) {
  const wb = XLSX.utils.book_new();
  wb.Props = {
    Title: `Fahrtenbuch Audit ${MONTHS[month - 1]} ${year}`,
    Author: 'Company Planner',
  };

  const sorted = [...trips].sort((a, b) => {
    if (a.trip_date !== b.trip_date) return a.trip_date < b.trip_date ? -1 : 1;
    return (a.start_time ?? '').localeCompare(b.start_time ?? '');
  });

  const headers = [
    'Datum', 'Start', 'Ende', 'Originalfahrer', 'Zugeordneter Fahrer',
    'Kennzeichen', 'Fahrpreis', 'Trinkgeld', 'Barzahlung', 'Kartenzahlung',
    'Startadresse', 'Zieladresse', 'Fahrtstatus', 'Änderungsstatus', 'Änderungsgrund',
  ];

  const rows: (string | number)[][] = sorted.map(t => [
    fmtDate(t.trip_date),
    fmtTime(t.start_time),
    fmtTime(t.end_time),
    t.original_driver_name,
    t.assigned_driver_name,
    t.car_identifier ?? '',
    t.price_amount,
    t.tip_amount,
    t.cash_amount,
    t.online_amount,
    t.route_start ?? '',
    t.route_end ?? '',
    t.source_status ?? t.plausibility_status ?? '',
    changeStatus(t),
    (t.assignment_reason || t.assignment_note || ''),
  ]);

  const data = [headers, ...rows];
  const ws = XLSX.utils.aoa_to_sheet(data);

  ws['!cols'] = [
    { wch: 12 }, { wch: 7 }, { wch: 7 }, { wch: 22 }, { wch: 22 },
    { wch: 14 }, { wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 12 },
    { wch: 28 }, { wch: 28 }, { wch: 14 }, { wch: 16 }, { wch: 40 },
  ];

  for (let r = 1; r < data.length; r++) {
    for (const c of [6, 7, 8, 9]) {
      const addr = XLSX.utils.encode_cell({ r, c });
      if (ws[addr]) {
        ws[addr].t = 'n';
        ws[addr].z = '#,##0.00 \u20AC';
      }
    }
  }

  XLSX.utils.book_append_sheet(wb, ws, 'Fahrtenbuch');

  const activeTrips = sorted.filter(t => !t.is_canceled);
  const canceledTrips = sorted.filter(t => t.is_canceled);
  const changedTrips = sorted.filter(t => changeStatus(t) === 'Geändert');
  const unchangedTrips = sorted.filter(t => changeStatus(t) === 'Unverändert');
  const totalPrice = activeTrips.reduce((s, t) => s + t.price_amount, 0);
  const totalTip = activeTrips.reduce((s, t) => s + t.tip_amount, 0);
  const totalCash = activeTrips.reduce((s, t) => s + t.cash_amount, 0);
  const totalOnline = activeTrips.reduce((s, t) => s + t.online_amount, 0);

  const summaryData: (string | number)[][] = [
    ['Fahrtenbuch Zusammenfassung', ''],
    ['', ''],
    ['Import-Datei', importFileName ?? ''],
    ['Monat / Jahr', `${MONTHS[month - 1]} ${year}`],
    ['Status', isApplied ? 'Plan angewendet' : 'Vorschau'],
    ['', ''],
    ['Kennzahl', 'Wert'],
    ['Gesamtzeilen', sorted.length],
    ['Aktive Fahrten', activeTrips.length],
    ['Stornierte Fahrten', canceledTrips.length],
    ['Geänderte Fahrten', changedTrips.length],
    ['Unveränderte Fahrten', unchangedTrips.length],
    ['', ''],
    ['Gesamtfahrpreis', totalPrice],
    ['Gesamttrinkgeld', totalTip],
    ['Gesamtbarzahlung', totalCash],
    ['Gesamtkartenzahlung', totalOnline],
    ['', ''],
    ['Exportiert am', new Date().toLocaleString('de-DE')],
  ];

  const wsSum = XLSX.utils.aoa_to_sheet(summaryData);
  wsSum['!cols'] = [{ wch: 24 }, { wch: 30 }];

  for (const r of [13, 14, 15, 16]) {
    const addr = XLSX.utils.encode_cell({ r, c: 1 });
    if (wsSum[addr]) {
      wsSum[addr].t = 'n';
      wsSum[addr].z = '#,##0.00 \u20AC';
    }
  }

  XLSX.utils.book_append_sheet(wb, wsSum, 'Zusammenfassung');

  if (changedTrips.length > 0) {
    const changeHeaders = [
      'Datum', 'Start', 'Ende', 'Originalfahrer', 'Zugeordneter Fahrer',
      'Kennzeichen', 'Fahrpreis', 'Änderungsgrund',
    ];

    const changeRows = changedTrips.map(t => [
      fmtDate(t.trip_date),
      fmtTime(t.start_time),
      fmtTime(t.end_time),
      t.original_driver_name,
      t.assigned_driver_name,
      t.car_identifier ?? '',
      t.price_amount,
      (t.assignment_reason || t.assignment_note || ''),
    ]);

    const changeData = [changeHeaders, ...changeRows];
    const wsChanges = XLSX.utils.aoa_to_sheet(changeData);
    wsChanges['!cols'] = [
      { wch: 12 }, { wch: 7 }, { wch: 7 }, { wch: 22 }, { wch: 22 },
      { wch: 14 }, { wch: 12 }, { wch: 50 },
    ];

    XLSX.utils.book_append_sheet(wb, wsChanges, 'Änderungen');
  }

  const prefix = isApplied ? 'Audit_angewendet' : 'Audit_Vorschau';
  const monthStr = String(month).padStart(2, '0');
  const filename = `${prefix}_${year}-${monthStr}_${MONTHS[month - 1]}.xlsx`;
  XLSX.writeFile(wb, filename);
}