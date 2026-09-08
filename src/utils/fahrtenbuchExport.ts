import * as XLSX from 'xlsx';
import { FahrtenbuchTrip } from '../hooks/useFahrtenbuch';
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

const FAHRTENBUCH_ORIGINAL_COLUMNS = [
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