import * as XLSX from 'xlsx';
import { downloadStyledWorkbook } from './styledWorkbookDownload';
// The column list, the hour formatter and the month names are shared with §12's
// payroll summary (`monthlyPlanPayrollSummary.ts`), which prints the same seven
// Lohnart columns for the same recipient from a different source. They were
// moved out of this file unchanged; see that module's header for why.
import {
  FAHRERUEBERSICHT_COLUMNS,
  MONTHS_DE,
  fmtHours,
} from './fahreruebersichtColumns';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SavedStundennachweis {
  id: string;
  driver_id: string;
  driver_name: string;
  personalnummer: string | null;
  month: number;
  year: number;
  grundlohn_min: number;
  nachtarbeit_min: number;
  nacht04_min: number;
  samstag_min: number;
  sonntag_min: number;
  feiertag_min: number;
  weihnachten_min: number;
  working_days: number;
  saved_at: string;
}

export interface DriverSummary {
  driver_id: string;
  driver_name: string;
  personalnummer: string | null;
  saved: SavedStundennachweis | null;
}

// ── Cell style helpers ─────────────────────────────────────────────────────────

type CellStyle = {
  font?: Record<string, unknown>;
  fill?: Record<string, unknown>;
  alignment?: Record<string, unknown>;
  border?: Record<string, unknown>;
};

const BORDER_THIN = {
  top:    { style: 'thin', color: { rgb: 'DDE3EA' } },
  bottom: { style: 'thin', color: { rgb: 'DDE3EA' } },
  left:   { style: 'thin', color: { rgb: 'DDE3EA' } },
  right:  { style: 'thin', color: { rgb: 'DDE3EA' } },
};

function cell(v: unknown, s: CellStyle): XLSX.CellObject {
  return { v: v as XLSX.CellObject['v'], t: typeof v === 'number' ? 'n' : 's', s };
}

const S = {
  title: {
    font:      { bold: true, sz: 14, color: { rgb: 'FFFFFF' } },
    fill:      { fgColor: { rgb: '0F2337' } },
    alignment: { horizontal: 'left', vertical: 'center' },
  } as CellStyle,
  meta: {
    font:      { sz: 10, color: { rgb: 'B8D4E8' } },
    fill:      { fgColor: { rgb: '1C3A52' } },
    alignment: { horizontal: 'left', vertical: 'center' },
  } as CellStyle,
  hdr: {
    font:      { bold: true, sz: 9, color: { rgb: 'FFFFFF' } },
    fill:      { fgColor: { rgb: '1D5F8A' } },
    alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
    border:    { bottom: { style: 'medium', color: { rgb: '0F4C75' } }, ...BORDER_THIN },
  } as CellStyle,
  even: {
    font:      { sz: 9, color: { rgb: '1A2B3C' } },
    fill:      { fgColor: { rgb: 'F7F9FC' } },
    alignment: { horizontal: 'left', vertical: 'center' },
    border:    BORDER_THIN,
  } as CellStyle,
  odd: {
    font:      { sz: 9, color: { rgb: '1A2B3C' } },
    fill:      { fgColor: { rgb: 'FFFFFF' } },
    alignment: { horizontal: 'left', vertical: 'center' },
    border:    BORDER_THIN,
  } as CellStyle,
  evenC: {
    font:      { sz: 9, color: { rgb: '1A2B3C' } },
    fill:      { fgColor: { rgb: 'F7F9FC' } },
    alignment: { horizontal: 'center', vertical: 'center' },
    border:    BORDER_THIN,
  } as CellStyle,
  oddC: {
    font:      { sz: 9, color: { rgb: '1A2B3C' } },
    fill:      { fgColor: { rgb: 'FFFFFF' } },
    alignment: { horizontal: 'center', vertical: 'center' },
    border:    BORDER_THIN,
  } as CellStyle,
  empty: {
    font:      { sz: 9, color: { rgb: '9FB3C8' } },
    fill:      { fgColor: { rgb: 'F7F9FC' } },
    alignment: { horizontal: 'center', vertical: 'center' },
    border:    BORDER_THIN,
  } as CellStyle,
  emptyOdd: {
    font:      { sz: 9, color: { rgb: '9FB3C8' } },
    fill:      { fgColor: { rgb: 'FFFFFF' } },
    alignment: { horizontal: 'center', vertical: 'center' },
    border:    BORDER_THIN,
  } as CellStyle,
  footer: {
    font:      { italic: true, sz: 8, color: { rgb: '8899AA' } },
    fill:      { fgColor: { rgb: 'F0F4F8' } },
    alignment: { horizontal: 'left', vertical: 'center' },
  } as CellStyle,
};

// ── Column definitions ────────────────────────────────────────────────────────
// The list itself is `FAHRERUEBERSICHT_COLUMNS` in `fahreruebersichtColumns.ts`,
// shared with §12's payroll summary so the two sheets cannot drift apart. The
// local alias keeps every use below character-identical.

const COLUMNS = FAHRERUEBERSICHT_COLUMNS;

const NUM_COLS = COLUMNS.length;

// ── Main export function ───────────────────────────────────────────────────────

export function exportFahreruebersichtToExcel(params: {
  month: number;
  year: number;
  companyName: string;
  drivers: DriverSummary[];
}): void {
  const { month, year, companyName, drivers } = params;
  const monthName = MONTHS_DE[month - 1];
  const periodLabel = `${monthName} ${year}`;
  const generatedAt = new Date().toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

  const wb = XLSX.utils.book_new();
  const ws: XLSX.WorkSheet = {};
  const merges: XLSX.Range[] = [];

  let r = 0;

  // ── Title row ──
  ws[XLSX.utils.encode_cell({ r, c: 0 })] = cell(`Fahrerübersicht — ${periodLabel}`, S.title);
  for (let c = 1; c < NUM_COLS; c++) ws[XLSX.utils.encode_cell({ r, c })] = cell('', S.title);
  merges.push({ s: { r, c: 0 }, e: { r, c: NUM_COLS - 1 } });
  r++;

  // ── Meta rows ──
  const metaLeft  = `Unternehmen: ${companyName || '—'}`;
  const metaRight = `Erstellt: ${generatedAt}`;
  ws[XLSX.utils.encode_cell({ r, c: 0 })] = cell(metaLeft, S.meta);
  for (let c = 1; c < NUM_COLS - 4; c++) ws[XLSX.utils.encode_cell({ r, c })] = cell('', S.meta);
  merges.push({ s: { r, c: 0 }, e: { r, c: NUM_COLS - 5 } });
  ws[XLSX.utils.encode_cell({ r, c: NUM_COLS - 4 })] = cell(metaRight, { ...S.meta, alignment: { horizontal: 'right', vertical: 'center' } });
  for (let c = NUM_COLS - 3; c < NUM_COLS; c++) ws[XLSX.utils.encode_cell({ r, c })] = cell('', S.meta);
  merges.push({ s: { r, c: NUM_COLS - 4 }, e: { r, c: NUM_COLS - 1 } });
  r++;

  // ── Blank separator ──
  for (let c = 0; c < NUM_COLS; c++) ws[XLSX.utils.encode_cell({ r, c })] = cell('', {});
  r++;

  // ── Header row ──
  const headerRow = r;
  COLUMNS.forEach((col, c) => {
    ws[XLSX.utils.encode_cell({ r, c })] = cell(col.label, S.hdr);
  });
  r++;

  // ── Data rows ──
  drivers.forEach((d, idx) => {
    const isEven = idx % 2 === 0;
    const rowBase  = isEven ? S.even  : S.odd;
    const rowCtr   = isEven ? S.evenC : S.oddC;
    const rowEmpty = isEven ? S.empty : S.emptyOdd;
    const s = d.saved;

    const values: (string | number)[] = [
      idx + 1,
      d.personalnummer ?? '—',
      d.driver_name,
      s ? s.working_days : '',
      s ? fmtHours(s.grundlohn_min)   : '',
      s ? fmtHours(s.nachtarbeit_min) : '',
      s ? fmtHours(s.nacht04_min)     : '',
      s ? fmtHours(s.samstag_min)     : '',
      s ? fmtHours(s.sonntag_min)     : '',
      s ? fmtHours(s.feiertag_min)    : '',
      s ? fmtHours(s.weihnachten_min) : '',
      '', '', '', '', '', '', '', '', '', '', '', '', '', '',
    ];

    values.forEach((v, c) => {
      const style = c <= 2 ? rowBase : (v === '' ? rowEmpty : rowCtr);
      ws[XLSX.utils.encode_cell({ r, c })] = cell(v, style);
    });
    r++;
  });

  // ── Footer note ──
  r++;
  ws[XLSX.utils.encode_cell({ r, c: 0 })] = cell(
    'Diese Fahrerübersicht wurde aus den gespeicherten Stundennachweisen generiert. Felder ohne Quelle sind manuell zu befüllen.',
    S.footer,
  );
  merges.push({ s: { r, c: 0 }, e: { r, c: NUM_COLS - 1 } });

  // ── Sheet range ──
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r, c: NUM_COLS - 1 } });

  // ── Column widths ──
  ws['!cols'] = COLUMNS.map(col => ({ wch: col.width }));

  // ── Row heights ──
  ws['!rows'] = [
    { hpt: 30 },
    { hpt: 18 },
    { hpt: 6  },
    { hpt: 36 },
    ...drivers.map(() => ({ hpt: 18 })),
  ];

  ws['!merges'] = merges;

  // The header row stays in view, which on a sheet of 25 columns and one row per
  // driver is the difference between reading it and losing your place. Added with
  // the writer swap because `XLSX.writeFile` emitted no `<pane>` either — this
  // key has never had an effect in this file.
  ws['!freeze'] = { xSplit: 0, ySplit: headerRow + 1 };

  const mm = String(month).padStart(2, '0');
  const sheetName = `${mm}_${year}`;
  XLSX.utils.book_append_sheet(wb, ws, sheetName);

  // ExcelJS, not `XLSX.writeFile`. Everything above describes a drawn sheet — 22
  // styles, the merges, the row heights — and xlsx 0.20.3 discards all of it:
  // `get_cell_style` reads only `cell.z`. This sheet is the payroll summary an
  // accountant reads, and it was coming out as a bare grid. Not a cell, a style,
  // a width or a merge changed with the writer; only the freeze above was added.
  void downloadStyledWorkbook(wb, `Fahreruebersicht_Stundennachweis_${mm}_${year}.xlsx`)
    .catch((error: unknown) => {
      console.error('exportFahreruebersichtToExcel: writing the workbook failed', error);
    });
}

// ── Fahrerübersicht import-format export ──────────────────────────────────────
// Produces a single-sheet XLSX with the exact column names expected by the
// Fahrerübersicht import file. One row per final driver in the planning snapshot.
// Computed fields come from the final trip snapshot (Fahrpreis, Trinkgeld, cash).
// Fields with no reliable source are left blank rather than fabricated.

export interface FahreruebersichtImportRow {
  driver_id: string;
  driver_name: string;
  personalnummer: string | null;
  online_hours: number;      // paid hours from final snapshot
  fahrten: number;           // trip count from final snapshot
  fahrpreise: number;        // sum of Fahrpreis from assigned trips
  trinkgeld: number;         // sum of Trinkgeld from assigned trips
  gesammeltes_bargeld: number; // sum of Fahrpreis where Zahlungsart is cash
}

const IMPORT_HEADERS = [
  'ID', 'Monat', 'Name',
  'Online_Stunden', 'Fahrten',
  'Annahmequote', 'Abschlussquote', 'Stornierungen', 'Auslastung', 'Rating',
  'Fahrpreise', 'Umsatz_vor_MwSt', 'Bonus', 'Trinkgeld',
  'Gesammeltes_Bargeld', 'QPP Zahlungen',
];

export function exportFahreruebersichtImportFormat(params: {
  month: number;
  year: number;
  companyId: string | null;
  rows: FahreruebersichtImportRow[];
}): void {
  const { month, year, companyId, rows } = params;
  const monthName = MONTHS_DE[month - 1];
  const monatLabel = `${monthName} ${year}`;

  const mm = String(month).padStart(2, '0');
  const lastDay = new Date(year, month, 0).getDate();
  const dateFrom = `${year}-${mm}-01`;
  const dateTo   = `${year}-${mm}-${String(lastDay).padStart(2, '0')}`;
  const fileName = companyId
    ? `${dateFrom}_${dateTo}_Fahrerübersicht_${companyId}.xlsx`
    : `Fahrerübersicht_${monthName}_${year}.xlsx`;

  const wb = XLSX.utils.book_new();

  const aoa: (string | number | null)[][] = [IMPORT_HEADERS];

  for (const row of rows) {
    aoa.push([
      row.personalnummer ?? row.driver_id ?? null,
      monatLabel,
      row.driver_name,
      Math.round(row.online_hours * 100) / 100,
      row.fahrten,
      null,   // Annahmequote — no source
      null,   // Abschlussquote — no source
      null,   // Stornierungen — no source
      null,   // Auslastung — no source
      null,   // Rating — no source
      Math.round(row.fahrpreise * 100) / 100,
      null,   // Umsatz_vor_MwSt — no reliable formula
      null,   // Bonus — no source
      Math.round(row.trinkgeld * 100) / 100,
      Math.round(row.gesammeltes_bargeld * 100) / 100,
      null,   // QPP Zahlungen — no source
    ]);
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);

  // Bold header row
  const range = XLSX.utils.decode_range(ws['!ref'] ?? 'A1');
  for (let c = range.s.c; c <= range.e.c; c++) {
    const addr = XLSX.utils.encode_cell({ r: 0, c });
    if (ws[addr]) {
      ws[addr].s = { font: { bold: true } };
    }
  }

  ws['!cols'] = IMPORT_HEADERS.map(h => ({ wch: Math.max(h.length + 4, 14) }));

  XLSX.utils.book_append_sheet(wb, ws, `${mm}_${year}`);
  XLSX.writeFile(wb, fileName);
}
