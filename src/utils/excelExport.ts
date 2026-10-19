/**
 * WHO WRITES THE FILE, AND WHO ONLY DESCRIBES IT.
 *
 * Every Excel file this module produces is WRITTEN BY THE EXPORT SERVICE
 * (deploy/export-service, Python's openpyxl), because the companies that receive
 * these files check the writer. `exportTableToExcel` and `exportSheetsToExcel`
 * build the sheet here, as they always did, and hand it to `deliverWorkbook`,
 * which posts the values to the service and downloads what comes back. If the
 * service cannot be reached the user is told so and NO file is written: there is
 * no fallback to a JavaScript writer, because that file would carry the wrong
 * signature and nobody would know.
 *
 * Formatting is plain, like the files these customers already get from other
 * tools: no fonts, fills, borders, alignment, widths, freeze pane, filter or
 * merges. The `s` styles, `!cols`, `!rows`, `!merges`, `!freeze` and
 * `!autofilter` that `buildTableSheet` still describes are NOT SENT, and the
 * contract has nowhere to put them (`src/lib/workbookContract.ts`). What is sent
 * is the value of each cell, whether it is a number, and the number format when
 * it is one the contract lists. A number stays a number so an accountant can sum
 * a column. This reverses the look the owner asked for on 01.10.2026; the
 * descriptions are left in place for now and are dead weight until a follow-up
 * removes them.
 *
 * `xlsx@0.20.3` is used HERE only as a data structure (`XLSX.WorkBook` is what
 * `buildTableWorkbook` returns and the tests read cell by cell) and never as a
 * writer for these lists. What STAYS on `xlsx` and on `exceljs` is the other
 * exports, deliberately, until their own change moves them:
 * `fahrtenbuchExport.ts` / `historicalWorkingHoursFahrtenbuchExport.ts` /
 * `monatsplanungXlsxExport.ts` / `monthlyPlanFahrtenbuchExport.ts`, whose
 * `'original'` mode must reproduce an imported sheet's headers byte for byte,
 * and the Fahrerübersicht and the monthly plan's documents. See
 * `styledWorkbookDownload.ts`.
 */
import * as XLSX from 'xlsx';
import { deliverWorkbook } from './serviceWorkbookDownload';
import { Income, SalaryCalculation } from '../types/receipt';
import {
  buildIncomeSheets,
  buildSalarySheets,
  salaryExportFilename,
} from './listExportSheets';

/**
 * Umsätze, as three styled sheets.
 *
 * This was 145 lines of `aoa_to_sheet` with a styling pass the `xlsx` writer threw
 * away: a plain grid, every amount a string, a uuid in the widest column and the
 * words "EL-PROFESSOR - UMSÄTZE BERICHT" across the top. The owner reported it on
 * 01.10.2026. The content is the same three sections it always had — the entries,
 * the split by type and the split by driver — in `listExportSheets.ts`, drawn by
 * the same exporter as every other list in the product.
 */
export const exportIncomeToExcel = (
  incomes: Income[],
  fromDate?: string,
  toDate?: string,
): void => {
  exportSheetsToExcel('umsaetze', buildIncomeSheets(incomes, fromDate, toDate));
};

/**
 * Gehälter, as two styled sheets.
 *
 * The same correction as Umsätze above, and the payroll rule it preserves —
 * `COALESCE(netto_salary, amount_due)` for due, the payments for paid, both read
 * from `utils/salaryDue.ts` — is written out at `buildSalarySheets`.
 */
export const exportSalariesToExcel = (
  salaries: SalaryCalculation[],
  periodStart: string,
  periodEnd: string,
): void => {
  exportSheetsToExcel(
    salaryExportFilename(periodStart, periodEnd),
    buildSalarySheets(salaries, periodStart, periodEnd),
  );
};

// ─── Generic reusable table export ────────────────────────────────────────────

export type ExportColumnType = 'text' | 'number' | 'number3' | 'integer' | 'money' | 'percent' | 'kilometres';

export interface ExportColumn {
  key: string;
  label: string;
  width?: number;
  align?: 'left' | 'center' | 'right';
  /**
   * The display of a TEXT column. A numeric column is displayed by its number
   * format instead, so `format` is ignored there — pass one or the other, never
   * both, or the cell reads as text again by accident.
   */
  format?: (value: unknown) => string;
  /**
   * Write the cell as a typed value with a German display format, so Excel can
   * sum, sort and compute with it. Default: 'text'.
   *
   * THE INVARIANT: a column that does not opt in renders byte-identically to
   * before this existed — same `t`, same `v`, no `z` key at all.
   */
  type?: ExportColumnType;
}

/**
 * The chrome `exportTableToExcel` writes around the caller's own columns.
 *
 * This dump satisfies no statutory form — it is a convenience export of an
 * operational list — so its wording follows the UI language, unlike the
 * Fahrtenbuch XLSX and the Stundennachweis PDF, whose German is prescribed.
 * The module stays pure: a screen passes its own translated labels, and the
 * German defaults below keep every existing caller byte-identical.
 */
export interface ExportChromeLabels {
  /** Printed in the first cell when there are no rows. */
  emptyState: string;
  /** Prefix of the filter line; the summary follows it. */
  activeFilters: string;
  /** Label of the totals row; `{count}` is the number of rows. */
  totalsRow: string;
  /**
   * A note printed in a band under the table, or absent for no band at all.
   *
   * Absent is the default, and that is the point: the band used to say
   * "El-Professor Verwaltungssystem — N Datensätze exportiert" beside a second
   * copy of the export timestamp, which the owner had removed on 01.10.2026.
   * What it is for is a sentence the sheet needs in order to be read correctly —
   * the payroll summary's warning that the surcharge columns must not be added
   * to the hours. `{count}` is substituted if present.
   */
  footer?: string;
}

export const DEFAULT_EXPORT_CHROME: ExportChromeLabels = {
  emptyState:    'Keine Daten vorhanden',
  activeFilters: 'Aktive Filter:',
  totalsRow:     'Gesamt  ({count} Einträge)',
};

function chromeText(template: string, count: number): string {
  return template.replace('{count}', String(count));
}

export interface ExportOptions {
  filename: string;
  sheetTitle: string;
  moduleName: string;
  columns: ExportColumn[];
  rows: Record<string, unknown>[];
  filterSummary?: string[];
  /**
   * The totals row's figures, by column key. A number is written as a number
   * cell in its column's format; a string as text.
   *
   * THE CONTRACT: the row's FIRST cell is its label and carries no figure, so
   * naming `columns[0].key` here throws — that wording goes in
   * `labels.totalsRow`. Pass `{}` for a totals row that carries only its label.
   */
  totals?: Record<string, string | number>;
  /** Defaults to the German wording this export has always had. */
  labels?: Partial<ExportChromeLabels>;
}

// ─── Design tokens ────────────────────────────────────────────────────────────
// Slate-900 header, slate-700 subheader, sky-700 column header, clean grids
const T = {
  TITLE_BG:     '0F2337',  // very dark navy — report header band
  TITLE_FG:     'FFFFFF',
  META_BG:      '1C3A52',  // slightly lighter navy — meta row
  META_FG:      'B8D4E8',  // muted sky text
  FILTER_BG:    'F1F5F9',  // near-white slate
  FILTER_FG:    '475569',  // slate-600
  FILTER_BORDER:'CBD5E1',  // slate-300
  COL_HEAD_BG:  '1D5F8A',  // sky-800 — column header
  COL_HEAD_FG:  'FFFFFF',
  COL_HEAD_BTM: '0F4C75',  // darker bottom accent line
  ROW_EVEN_BG:  'F7F9FC',  // very subtle off-white
  ROW_ODD_BG:   'FFFFFF',
  ROW_BORDER:   'DDE3EA',  // soft grid lines
  ROW_BORDER_V: 'DDE3EA',
  TOTAL_BG:     'E3EEF7',  // light sky tint
  TOTAL_FG:     '0F2337',
  TOTAL_ACCENT: '1D5F8A',  // top border accent
  FOOTER_BG:    'F1F5F9',
  FOOTER_FG:    '94A3B8',  // slate-400
  FOOTER_LINE:  'CBD5E1',
} as const;

// ─── Number formats ───────────────────────────────────────────────────────────
// An xlsx number format is stored in EN-US convention and Excel renders it with
// the viewer's locale. So German 1.234,56 is written '#,##0.00' — NOT
// '#.##0,00', which would produce a file that looks right to nobody.
//
// 'percent' multiplies by 100 on display, so a column using it must hold the
// FRACTION (0.4147 for 41,47 %). A column whose raw value is already multiplied
// uses 'number' and keeps the % in its label.
//
// 'kilometres' is an integer with its unit in the cell's format rather than in
// the value, which is what keeps an odometer reading summable and sortable while
// it still reads as "123.456 km". The unit symbol is the same word in German and
// English, so it carries no language and stays out of the dictionaries.
const NUMBER_FORMATS: Record<Exclude<ExportColumnType, 'text'>, string> = {
  number:     '#,##0.00',
  // A unit price at a pump has three decimals; 'number' would show 2,05 for 2,049.
  number3:    '#,##0.000',
  integer:    '#,##0',
  money:      '#,##0.00\\ "€"',
  percent:    '0.0%',
  kilometres: '#,##0\\ "km"',
} as const;

// ─── Style helpers ────────────────────────────────────────────────────────────

function gridBorder() {
  return {
    top:    { style: 'thin',   color: { rgb: T.ROW_BORDER } },
    bottom: { style: 'thin',   color: { rgb: T.ROW_BORDER } },
    left:   { style: 'thin',   color: { rgb: T.ROW_BORDER_V } },
    right:  { style: 'thin',   color: { rgb: T.ROW_BORDER_V } },
  };
}

function cell(
  ws: XLSX.WorkSheet,
  r: number,
  c: number,
  value: string | number,
  style: object,
  numberFormat?: string,
) {
  const addr = XLSX.utils.encode_cell({ r, c });
  ws[addr] = { t: typeof value === 'number' ? 'n' : 's', v: value, s: style };
  // Set only for a column that opted in, so every other cell keeps exactly the
  // three keys it has always had.
  if (numberFormat) ws[addr].z = numberFormat;
}

/**
 * The finite number a raw value stands for, or null when it stands for none.
 *
 * Null is never coerced to 0: a 0,00 € where the datum is missing is a wrong
 * figure, and this product's figures reconcile against an accountant's. The
 * caller falls back to the text path instead.
 */
function asFiniteNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string') {
    // Number('   ') is 0, so an all-whitespace string must be refused by hand.
    const trimmed = raw.trim();
    if (trimmed === '') return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * The number cell a column asks for, or null to leave the value on the text path
 * — because the column did not opt in, or because its value cannot be read.
 * Returns an object rather than a number so that a legitimate 0 stays truthy.
 */
function numericCell(col: ExportColumn, raw: unknown): { value: number; z: string } | null {
  if (!col.type || col.type === 'text') return null;
  const value = asFiniteNumber(raw);
  if (value === null) return null;
  return { value, z: NUMBER_FORMATS[col.type] };
}

function blank(ws: XLSX.WorkSheet, r: number, numCols: number, bg = 'FFFFFF') {
  for (let c = 0; c < numCols; c++) {
    const addr = XLSX.utils.encode_cell({ r, c });
    ws[addr] = { t: 's', v: '', s: { fill: { fgColor: { rgb: bg } } } };
  }
}

// ─── Main export function ─────────────────────────────────────────────────────

/** A drawn sheet and the name it goes into the workbook under. */
interface BuiltSheet {
  name: string;
  sheet: XLSX.WorkSheet;
}

/**
 * Draws one sheet: the seven bands, the number formats and the sheet settings.
 *
 * Separated from the workbook so a workbook can hold several of them — Notizen,
 * Umsätze and Gehälter each export a set of related tables. Nothing about the
 * drawing changed when it was separated; `buildTableWorkbook` below is still one
 * call to this, which is what keeps the cell-by-cell tests describing what the
 * product writes.
 */
function buildTableSheet(opts: ExportOptions): BuiltSheet {
  const { sheetTitle, moduleName, columns, rows, filterSummary = [], totals } = opts;
  const labels: ExportChromeLabels = { ...DEFAULT_EXPORT_CHROME, ...(opts.labels ?? {}) };

  // ── The totals row's first cell is its label, and there is only one cell ───
  // THE RULE: `totals` names the columns that carry a figure; column 0 carries
  // the row's label. Block 6 below writes that label unconditionally, so a
  // `totals` entry keyed to the first column could never be rendered — and was
  // dropped with no warning, which is what this refuses.
  //
  // It refuses rather than moving the label, because the label in the first cell
  // is the one piece of chrome every file this export has ever produced carries,
  // and a count sentence in the Kennzeichen or Fahrername column would be
  // sorted and filtered as data. Three callers were tripping over this —
  // Fahrzeuge, Fahrer and Benutzer — and every one of them was passing its own
  // WORDING and not a figure, so `labels.totalsRow` is where they belong. No
  // figure was ever lost; wording was.
  //
  // Loud, not a console warning: every call site is in this repository, so this
  // is a wrong program rather than wrong data, and it is meant to fail the first
  // click and the test rather than reach a customer's file.
  if (totals && columns.length > 0 && Object.prototype.hasOwnProperty.call(totals, columns[0].key)) {
    throw new Error(
      `exportTableToExcel: totals['${columns[0].key}'] can never be rendered — the first ` +
      `column of the totals row is that row's label. Pass wording as labels.totalsRow, ` +
      `and put a figure in any column but the first.`,
    );
  }

  const N = columns.length;
  const exportedDate = new Date().toLocaleDateString('de-DE');
  const exportedTime = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

  const ws: XLSX.WorkSheet = {};
  let R = 0;

  // ═══════════════════════════════════════════════════════════════════════════
  // BLOCK 1 — REPORT HEADER (3 rows tall)
  // ═══════════════════════════════════════════════════════════════════════════

  // Row 0: top accent stripe (very thin, dark)
  for (let c = 0; c < N; c++) {
    const addr = XLSX.utils.encode_cell({ r: R, c });
    ws[addr] = {
      t: 's', v: '',
      s: { fill: { fgColor: { rgb: T.TITLE_BG } } },
    };
  }
  R++;

  // Row 1: TITLE — large bold white text on dark navy, left-aligned
  for (let c = 0; c < N; c++) {
    cell(ws, R, c, c === 0 ? sheetTitle : '', {
      font: { bold: true, sz: 20, color: { rgb: T.TITLE_FG }, name: 'Calibri Light' },
      fill: { fgColor: { rgb: T.TITLE_BG } },
      alignment: { horizontal: 'left', vertical: 'center', indent: 2 },
    });
  }
  R++;

  // Row 2: META — module name (left) + export date/time (right)
  for (let c = 0; c < N; c++) {
    const isLast = c === N - 1;
    const metaVal = c === 0
      ? moduleName.toUpperCase()
      : isLast
        ? `${exportedDate}  ${exportedTime}`
        : '';
    cell(ws, R, c, metaVal, {
      font: {
        bold:   c === 0,
        sz:     c === 0 ? 10 : 9,
        color:  { rgb: T.META_FG },
        name:   'Calibri',
        italic: c !== 0 && isLast,
      },
      fill: { fgColor: { rgb: T.META_BG } },
      alignment: {
        horizontal: isLast ? 'right' : 'left',
        vertical:   'center',
        indent:     c === 0 ? 2 : 0,
      },
      border: {
        bottom: { style: 'thin', color: { rgb: T.COL_HEAD_BG } },
      },
    });
  }
  R++;

  // ═══════════════════════════════════════════════════════════════════════════
  // BLOCK 2 — FILTER CONTEXT (optional, 1 row)
  // ═══════════════════════════════════════════════════════════════════════════

  let filterRow = -1;
  if (filterSummary.length > 0) {
    filterRow = R;
    const filterText = `${labels.activeFilters}  ${filterSummary.join('   |   ')}`;
    for (let c = 0; c < N; c++) {
      cell(ws, R, c, c === 0 ? filterText : '', {
        font:      { sz: 9, color: { rgb: T.FILTER_FG }, italic: true, name: 'Calibri' },
        fill:      { fgColor: { rgb: T.FILTER_BG } },
        alignment: { horizontal: 'left', vertical: 'center', indent: 2, wrapText: false },
        border: {
          top:    { style: 'thin', color: { rgb: T.FILTER_BORDER } },
          bottom: { style: 'thin', color: { rgb: T.FILTER_BORDER } },
          left:   c === 0 ? { style: 'thin', color: { rgb: T.FILTER_BORDER } } : undefined,
          right:  c === N - 1 ? { style: 'thin', color: { rgb: T.FILTER_BORDER } } : undefined,
        },
      });
    }
    R++;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BLOCK 3 — SPACER ROW (provides visual breathing room)
  // ═══════════════════════════════════════════════════════════════════════════

  blank(ws, R, N);
  R++;

  // ═══════════════════════════════════════════════════════════════════════════
  // BLOCK 4 — COLUMN HEADERS
  // ═══════════════════════════════════════════════════════════════════════════

  const colHeaderRow = R;
  columns.forEach((col, c) => {
    cell(ws, R, c, col.label, {
      font:      { bold: true, sz: 10, color: { rgb: T.COL_HEAD_FG }, name: 'Calibri' },
      fill:      { fgColor: { rgb: T.COL_HEAD_BG } },
      alignment: { horizontal: col.align ?? 'left', vertical: 'center', wrapText: false, indent: col.align === 'left' ? 1 : 0 },
      border: {
        top:    { style: 'medium', color: { rgb: T.TITLE_BG } },
        bottom: { style: 'medium', color: { rgb: T.COL_HEAD_BTM } },
        left:   { style: 'thin',   color: { rgb: T.COL_HEAD_BG } },
        right:  { style: 'thin',   color: { rgb: T.COL_HEAD_BG } },
      },
    });
  });
  R++;

  // ═══════════════════════════════════════════════════════════════════════════
  // BLOCK 5 — DATA ROWS
  // ═══════════════════════════════════════════════════════════════════════════

  rows.forEach((dataRow, i) => {
    const isEven = i % 2 === 0;
    const rowBg  = isEven ? T.ROW_EVEN_BG : T.ROW_ODD_BG;

    columns.forEach((col, c) => {
      const rawVal   = dataRow[col.key];
      const numeric  = numericCell(col, rawVal);
      // A numeric column is displayed by its `z`; a text column by its `format`.
      // With no number to write, the text path below is exactly what it always was.
      const formatted = numeric
        ? numeric.value
        : col.format
          ? col.format(rawVal)
          : rawVal == null ? '' : String(rawVal);

      cell(ws, R, c, formatted, {
        font:      { sz: 10, name: 'Calibri', color: { rgb: '1E293B' } },
        fill:      { fgColor: { rgb: rowBg } },
        alignment: {
          horizontal: col.align ?? 'left',
          vertical:   'center',
          wrapText:   false,
          indent:     col.align === 'left' ? 1 : 0,
        },
        border: {
          top:    { style: 'thin', color: { rgb: T.ROW_BORDER } },
          bottom: { style: 'thin', color: { rgb: T.ROW_BORDER } },
          left:   c === 0
            ? { style: 'medium', color: { rgb: T.COL_HEAD_BG } }
            : { style: 'thin',   color: { rgb: T.ROW_BORDER_V } },
          right:  c === N - 1
            ? { style: 'medium', color: { rgb: T.COL_HEAD_BG } }
            : { style: 'thin',   color: { rgb: T.ROW_BORDER_V } },
        },
      }, numeric?.z);
    });
    R++;
  });

  // Empty-state placeholder
  if (rows.length === 0) {
    const msg = labels.emptyState;
    for (let c = 0; c < N; c++) {
      cell(ws, R, c, c === 0 ? msg : '', {
        font:      { sz: 10, italic: true, color: { rgb: '94A3B8' }, name: 'Calibri' },
        fill:      { fgColor: { rgb: T.ROW_EVEN_BG } },
        alignment: { horizontal: 'left', vertical: 'center', indent: 1 },
        border:    gridBorder(),
      });
    }
    R++;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BLOCK 6 — TOTALS / SUMMARY ROW (optional)
  // ═══════════════════════════════════════════════════════════════════════════

  if (totals) {
    // Top-border accent line (1-row cap before totals)
    for (let c = 0; c < N; c++) {
      const addr = XLSX.utils.encode_cell({ r: R, c });
      ws[addr] = {
        t: 's', v: '',
        s: {
          fill:   { fgColor: { rgb: T.TOTAL_ACCENT } },
          border: {
            top:    { style: 'medium', color: { rgb: T.TITLE_BG } },
            bottom: { style: 'medium', color: { rgb: T.TITLE_BG } },
          },
        },
      };
    }
    R++;

    columns.forEach((col, c) => {
      const isLabel = c === 0;
      // The first cell is always the label, as it always was — never a figure,
      // which the guard at the top of this function now enforces instead of
      // silently discarding one. The label follows the UI language since #112;
      // only the figures are ours.
      const rawTotal = totals[col.key];
      const numeric  = isLabel ? null : numericCell(col, rawTotal);
      const val      = isLabel
        ? chromeText(labels.totalsRow, rows.length)
        : numeric ? numeric.value : (rawTotal ?? '');
      cell(ws, R, c, val, {
        font: {
          bold:  true,
          sz:    10,
          color: { rgb: isLabel ? T.TOTAL_ACCENT : T.TOTAL_FG },
          name:  'Calibri',
        },
        fill:      { fgColor: { rgb: T.TOTAL_BG } },
        alignment: {
          horizontal: isLabel ? 'left' : (col.align ?? 'right'),
          vertical:   'center',
          indent:     isLabel ? 1 : 0,
        },
        border: {
          top:    { style: 'medium', color: { rgb: T.TOTAL_ACCENT } },
          bottom: { style: 'medium', color: { rgb: T.TITLE_BG }    },
          left:   c === 0     ? { style: 'medium', color: { rgb: T.COL_HEAD_BG } } : { style: 'thin', color: { rgb: T.ROW_BORDER_V } },
          right:  c === N - 1 ? { style: 'medium', color: { rgb: T.COL_HEAD_BG } } : { style: 'thin', color: { rgb: T.ROW_BORDER_V } },
        },
      }, numeric?.z);
    });
    R++;
  } else {
    // Even without a totals row, close the table with a medium bottom border
    const lastDataR = R - 1;
    for (let c = 0; c < N; c++) {
      const addr = XLSX.utils.encode_cell({ r: lastDataR, c });
      if (ws[addr] && ws[addr].s) {
        ws[addr].s.border = {
          ...(ws[addr].s.border ?? {}),
          bottom: { style: 'medium', color: { rgb: T.COL_HEAD_BG } },
        };
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BLOCK 7 — FOOTER BAND, only when the caller passes a note
  // ═══════════════════════════════════════════════════════════════════════════

  const footerText = labels.footer ? chromeText(labels.footer, rows.length) : '';
  let footerRow = -1;

  if (footerText) {
    R++; // one blank spacer row above the band

    for (let c = 0; c < N; c++) {
      cell(ws, R, c, c === 0 ? footerText : '', {
        font:  { sz: 9, color: { rgb: T.META_FG }, name: 'Calibri' },
        fill:  { fgColor: { rgb: T.FOOTER_BG } },
        alignment: {
          horizontal: 'left',
          vertical:   'top',
          wrapText:   true,
          indent:     c === 0 ? 1 : 0,
        },
        border: {
          top:    { style: 'thin', color: { rgb: T.FOOTER_LINE } },
          bottom: { style: 'thin', color: { rgb: T.FOOTER_LINE } },
          left:   c === 0     ? { style: 'thin', color: { rgb: T.FOOTER_LINE } } : undefined,
          right:  c === N - 1 ? { style: 'thin', color: { rgb: T.FOOTER_LINE } } : undefined,
        },
      });
    }

    footerRow = R;
    R++;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // WORKSHEET SETTINGS
  // ═══════════════════════════════════════════════════════════════════════════

  // Range
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: R - 1, c: N - 1 } });

  // Column widths — use provided widths; auto-min of 10
  ws['!cols'] = columns.map(col => ({ wch: Math.max(col.width ?? 18, 10) }));

  // Row heights (in points)
  const rowHeights: { [key: number]: { hpt: number } } = {
    0: { hpt: 4  },   // accent stripe — short
    1: { hpt: 32 },   // title row
    2: { hpt: 18 },   // meta row
  };
  if (filterRow >= 0) rowHeights[filterRow] = { hpt: 16 };
  rowHeights[colHeaderRow - 1] = { hpt: 6 };  // spacer
  rowHeights[colHeaderRow]     = { hpt: 22 };  // column headers
  for (let i = colHeaderRow + 1; i < colHeaderRow + 1 + rows.length; i++) {
    rowHeights[i] = { hpt: 18 };
  }
  if (footerRow >= 0) {
    // Tall enough for the note to be read. The band is one merged cell across
    // every column, so the line count is the text length over the summed column
    // width — about 1.1 characters per width unit at 9pt — and a note of five
    // lines in a 14pt row, which is what the old band gave it, was unreadable.
    const widthUnits = columns.reduce((sum, col) => sum + Math.max(col.width ?? 18, 10), 0);
    const lines = Math.max(1, Math.ceil(footerText.length / Math.max(20, widthUnits * 1.1)));
    rowHeights[footerRow] = { hpt: Math.min(120, 12 * lines + 4) };
  }
  ws['!rows'] = Array.from({ length: R }, (_, i) => rowHeights[i] ?? { hpt: 18 });

  // Freeze pane: freeze everything above and including the column-header row
  ws['!freeze'] = { xSplit: 0, ySplit: colHeaderRow + 1 };

  // AutoFilter on column-header row
  ws['!autofilter'] = {
    ref: XLSX.utils.encode_range({
      s: { r: colHeaderRow, c: 0 },
      e: { r: colHeaderRow, c: N - 1 },
    }),
  };

  // Cell merges
  const merges: XLSX.Range[] = [
    // Accent stripe — full width
    { s: { r: 0, c: 0 }, e: { r: 0, c: N - 1 } },
    // Title row — full width
    { s: { r: 1, c: 0 }, e: { r: 1, c: N - 1 } },
    // Meta row — left part (module name) spans all but last cell
    { s: { r: 2, c: 0 }, e: { r: 2, c: N - 2 } },
  ];
  // The footer band is one cell across the full width: it holds a sentence, not
  // a figure, so unlike the meta row it has nothing to right-align beside it.
  if (footerRow >= 0) {
    merges.push({ s: { r: footerRow, c: 0 }, e: { r: footerRow, c: N - 1 } });
  }
  if (filterRow >= 0) {
    merges.push({ s: { r: filterRow, c: 0 }, e: { r: filterRow, c: N - 1 } });
  }
  ws['!merges'] = merges;

  // Print settings
  ws['!margins'] = { left: 0.5, right: 0.5, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 };

  return { name: moduleName.slice(0, 31), sheet: ws };
}

/** The document properties every styled workbook carries. */
function workbookProps(first: ExportOptions): XLSX.FullProperties {
  return {
    Title:       first.sheetTitle,
    Subject:     first.moduleName,
    // No Author and no Company. Both named the product, and the owner asked on
    // 01.10.2026 for no signature of ours on a file a customer sends out. The
    // sheet's own title band says what the file is; who generated it is not the
    // reader's business and was never the customer's own name.
    CreatedDate: new Date(),
  };
}

/**
 * Builds the workbook `exportTableToExcel` writes. Split out so the sheet can be
 * inspected cell by cell in a test without touching the filesystem —
 * `XLSX.writeFile` is the only part that does.
 */
export function buildTableWorkbook(opts: ExportOptions): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  wb.Props = workbookProps(opts);
  const built = buildTableSheet(opts);
  XLSX.utils.book_append_sheet(wb, built.sheet, built.name);
  return wb;
}

/**
 * Several styled tables in one workbook, one sheet each, in the order given.
 *
 * The properties come from the first sheet, which is the one the screen's own
 * title names. A sheet name that repeats gets a numeric suffix rather than
 * throwing, because `book_append_sheet` refuses a duplicate and two sections of
 * one export can legitimately be called the same thing after the 31-character
 * truncation Excel imposes.
 */
export function buildSheetsWorkbook(sheets: ExportOptions[]): XLSX.WorkBook {
  if (sheets.length === 0) {
    throw new Error('buildSheetsWorkbook: a workbook needs at least one sheet');
  }
  const wb = XLSX.utils.book_new();
  wb.Props = workbookProps(sheets[0]);

  const used = new Set<string>();
  for (const opts of sheets) {
    const built = buildTableSheet(opts);
    let name = built.name;
    for (let n = 2; used.has(name); n++) {
      const suffix = ` (${n})`;
      name = `${built.name.slice(0, 31 - suffix.length)}${suffix}`;
    }
    used.add(name);
    XLSX.utils.book_append_sheet(wb, built.sheet, name);
  }
  return wb;
}

/**
 * Writes a multi-sheet workbook through the export service.
 *
 * Same contract as `exportTableToExcel`, including the `void` signature: the
 * service answers asynchronously, and a failure is reported to the user through
 * `deliverWorkbook` (a toast with a retry) rather than thrown at a caller that
 * has nowhere to show it.
 */
export function exportSheetsToExcel(filename: string, sheets: ExportOptions[]): void {
  const wb = buildSheetsWorkbook(sheets);
  const safeFilename = filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`;
  deliverWorkbook(wb, safeFilename);
}

export function exportTableToExcel(opts: ExportOptions): void {
  const wb = buildTableWorkbook(opts);
  const safeFilename = opts.filename.endsWith('.xlsx') ? opts.filename : `${opts.filename}.xlsx`;
  // The guard against a file that claims nought after a failed read stays at the
  // call site either way: this still builds a workbook for whatever rows it is
  // handed.
  deliverWorkbook(wb, safeFilename);
}
