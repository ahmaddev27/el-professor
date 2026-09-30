import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as XLSX from 'xlsx';

/**
 * Three defects in `utils/excelExport.ts`, pinned in one file.
 *
 *  1. **`exportToExcel` is gone** (owner decision D-E). It built a financial
 *     report out of `receipt.income`, `receipt.balance` and an ROI verdict, none
 *     of which the `Receipt` model carries, and its merge arithmetic drifted by
 *     up to six rows as the data grew. Its last production caller went away with
 *     PR #122, which routed Belege through `exportTableToExcel`.
 *
 *  2. **A totals value keyed to the FIRST column used to be discarded in
 *     silence.** Block 6 writes the row's label into that cell unconditionally,
 *     so `totals[columns[0].key]` never reached a file. Three callers were
 *     tripping over it and all three were passing their own WORDING rather than
 *     a figure, so the refusal points them at `labels.totalsRow`.
 *
 *  3. **The Gehälter export printed two quantities the Gehälter screen had
 *     stopped trusting.** The rule both sides must spell the same way:
 *     *due is `COALESCE(netto_salary, amount_due)`, and paid is derived from the
 *     payments, never from the stored status word.* This is the one export in
 *     this file whose figures reach a person's pay.
 *
 * `XLSX.writeFile` is mocked at the module boundary, because the real one is a
 * DOM download; mocking it also hands the test the workbook that would have been
 * written. `XLSX.utils` stays real, so the sheet is read back the way Excel would.
 * It is still `exportSalariesToExcel`'s writer — a plain dump with no styling to
 * lose — while `exportTableToExcel` writes through `downloadStyledWorkbook` since
 * the ExcelJS swap, xlsx 0.20.3 having discarded every fill, font and border it
 * was handed. Both are mocked, so "nothing was written" below still means it.
 */
const { writeFile } = vi.hoisted(() => ({ writeFile: vi.fn() }));
vi.mock('xlsx', async (importOriginal) => {
  const real = await importOriginal<typeof import('xlsx')>();
  return { ...real, writeFile, default: { ...real, writeFile } };
});

// Resolves, because `exportTableToExcel` attaches a `.catch` to what it returns.
// A bare factory rather than one spreading the real module: that module lazily
// imports exceljs, and nothing here needs it loaded.
const { downloadStyledWorkbook } = vi.hoisted(() => ({
  downloadStyledWorkbook: vi.fn(() => Promise.resolve()),
}));
vi.mock('./styledWorkbookDownload', () => ({ downloadStyledWorkbook }));

import * as excelExport from './excelExport';
import {
  buildTableWorkbook,
  exportTableToExcel,
  exportSalariesToExcel,
  type ExportColumn,
  type ExportOptions,
} from './excelExport';
import type { SalaryCalculation } from '../types/receipt';

const SHEET = 'Test';

function sheetOf(opts: Partial<ExportOptions> & { columns: ExportColumn[]; rows: Record<string, unknown>[] }) {
  const wb = buildTableWorkbook({
    filename: 'test',
    sheetTitle: 'Titel',
    moduleName: SHEET,
    filterSummary: [],
    ...opts,
  });
  return wb.Sheets[SHEET];
}

/** The first data row: rows 0-4 are accent, title, meta, spacer and the header. */
const FIRST_DATA_ROW = 5;

function at(ws: XLSX.WorkSheet, r: number, c: number) {
  return ws[XLSX.utils.encode_cell({ r, c })];
}

/**
 * Column A of a sheet, read straight off the worksheet by row index.
 *
 * Deliberately not `sheet_to_json`: that drops or keeps blank rows depending on
 * its options, and two assertions below compare a row INDEX against `!merges`.
 * Reading the cells keeps the index the one the file actually has.
 */
function columnA(ws: XLSX.WorkSheet): string[] {
  const range = XLSX.utils.decode_range(ws['!ref'] as string);
  const out: string[] = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const value: unknown = at(ws, r, 0)?.v;
    out[r] = typeof value === 'string' ? value : '';
  }
  return out;
}

const TWO_COLUMNS: ExportColumn[] = [
  { key: 'plate', label: 'Kennzeichen' },
  { key: 'amount', label: 'Betrag', type: 'money' },
];

beforeEach(() => {
  writeFile.mockClear();
  downloadStyledWorkbook.mockClear();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('1 — exportToExcel is deleted', () => {
  it('the module exports no exportToExcel', () => {
    expect(Object.keys(excelExport)).not.toContain('exportToExcel');
  });

  it('the three exporters that are still wired up are all still exported', () => {
    // Deleting a sibling must not take one of these with it: each is the only
    // export path of the screen that calls it.
    expect(Object.keys(excelExport)).toEqual(
      expect.arrayContaining(['exportIncomeToExcel', 'exportSalariesToExcel', 'exportTableToExcel']),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('2 — a totals value on the first column is refused, not dropped', () => {
  it('throws when totals names the first column', () => {
    expect(() =>
      sheetOf({ columns: TWO_COLUMNS, rows: [{ plate: 'B-AB 1', amount: 10 }], totals: { plate: '3 Fahrzeuge' } }),
    ).toThrow(/totals\['plate'\] can never be rendered/);
  });

  it('names labels.totalsRow in the refusal, so the fix is in the message', () => {
    expect(() =>
      sheetOf({ columns: TWO_COLUMNS, rows: [], totals: { plate: 'x' } }),
    ).toThrow(/labels\.totalsRow/);
  });

  it('refuses a first-column key even when its value is a number', () => {
    // A figure there is just as unrenderable as a sentence; the guard is about
    // the cell, not about the type of what was passed.
    expect(() =>
      sheetOf({ columns: TWO_COLUMNS, rows: [], totals: { plate: 42 } }),
    ).toThrow(/can never be rendered/);
  });

  it('refuses a first-column key whose value is undefined', () => {
    // hasOwnProperty, not truthiness: `{ plate: undefined }` is still a caller
    // that believes it placed something there.
    expect(() =>
      sheetOf({ columns: TWO_COLUMNS, rows: [], totals: { plate: undefined as unknown as string } }),
    ).toThrow(/can never be rendered/);
  });

  it('refuses through exportTableToExcel too, before anything is written', () => {
    expect(() =>
      exportTableToExcel({
        filename: 'x', sheetTitle: 'T', moduleName: SHEET,
        columns: TWO_COLUMNS, rows: [], totals: { plate: 'x' },
      }),
    ).toThrow(/can never be rendered/);
    // Both writers, so "before anything is written" is not satisfied merely by
    // `exportTableToExcel` no longer being the one that calls `XLSX.writeFile`.
    // The refusal is still SYNCHRONOUS — it is raised in `buildTableWorkbook`,
    // ahead of the asynchronous write — which is what lets `toThrow` see it.
    expect(downloadStyledWorkbook).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('a total on any other column is untouched — PR #150 still holds', () => {
    const ws = sheetOf({
      columns: TWO_COLUMNS,
      rows: [{ plate: 'B-AB 1', amount: 10 }],
      totals: { amount: 250.75 },
    });
    // data row, then the accent cap row, then the totals row
    const cell = at(ws, FIRST_DATA_ROW + 2, 1);
    expect(cell.t).toBe('n');
    expect(cell.v).toBe(250.75);
    expect(cell.z).toBe('#,##0.00\\ "€"');
  });

  it('`totals: {}` still renders the totals row, carrying only its label', () => {
    // This is what the three migrated callers now pass. Without it the row would
    // vanish from their files, which is a bigger change than the one being made.
    const ws = sheetOf({ columns: TWO_COLUMNS, rows: [{ plate: 'B-AB 1', amount: 10 }], totals: {} });
    expect(at(ws, FIRST_DATA_ROW + 2, 0).v).toBe('Gesamt  (1 Einträge)');
    expect(at(ws, FIRST_DATA_ROW + 2, 1).v).toBe('');
  });

  it('labels.totalsRow is what reaches that first cell', () => {
    const ws = sheetOf({
      columns: TWO_COLUMNS,
      rows: [{ plate: 'B-AB 1', amount: 10 }, { plate: 'B-AB 2', amount: 20 }],
      totals: {},
      labels: { totalsRow: '{count} Fahrzeuge' },
    });
    expect(at(ws, FIRST_DATA_ROW + 3, 0).v).toBe('2 Fahrzeuge');
  });

  it('no totals at all still writes no totals row', () => {
    const ws = sheetOf({ columns: TWO_COLUMNS, rows: [{ plate: 'B-AB 1', amount: 10 }] });
    expect(columnA(ws)).not.toContain('Gesamt  (1 Einträge)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

/** The salary rows the assertions below are built on. */
function salary(over: Partial<SalaryCalculation>): SalaryCalculation {
  return {
    driver_id: 'd', driver_name: 'Fahrer', salary_ratio: 0.5,
    revenue: 2000, tips: 0, revenue_share: 1000,
    amount_due: 1000, status: 'unpaid',
    ...over,
  };
}

/** The sheet `exportSalariesToExcel` would have written, as rows of raw values. */
function salarySheet(rows: SalaryCalculation[]): unknown[][] {
  exportSalariesToExcel(rows, '2026-09-01', '2026-09-30');
  expect(writeFile).toHaveBeenCalledTimes(1);
  const wb = writeFile.mock.calls[0][0] as XLSX.WorkBook;
  return XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets['Gehälter'], { header: 1, raw: true, defval: '' });
}

/** The row whose first cell is `label`. */
function rowOf(sheet: unknown[][], label: string): unknown[] {
  const row = sheet.find(r => r[0] === label);
  expect(row, `no row labelled ${label}`).toBeDefined();
  return row as unknown[];
}

describe('3 — the Gehälter export reads the same due and status as the screen', () => {
  const DUE_COL = 5;     // 'Fälliger Betrag (€)'
  const STATUS_COL = 6;  // 'Status'

  it('due is netto_salary where it is set, not amount_due', () => {
    // The screen shows 500,00 for this row (salaryBase). The export printed
    // 900,00 — the calculated amount the manual adjustment overrode.
    const sheet = salarySheet([salary({ driver_name: 'Ali', amount_due: 900, netto_salary: 500, total_paid: 500 })]);
    expect(rowOf(sheet, 'Ali')[DUE_COL]).toBe('500.00');
  });

  it('a netto adjustment to zero is honoured, because the base uses ?? and not ||', () => {
    const sheet = salarySheet([salary({ driver_name: 'Ali', amount_due: 900, netto_salary: 0 })]);
    expect(rowOf(sheet, 'Ali')[DUE_COL]).toBe('0.00');
  });

  it('due falls back to amount_due when netto_salary is absent — 51 of 58 production rows', () => {
    const sheet = salarySheet([salary({ driver_name: 'Ali', amount_due: 1234.5, netto_salary: undefined })]);
    expect(rowOf(sheet, 'Ali')[DUE_COL]).toBe('1234.50');
  });

  it('the status is derived from the payments, not read off the stored word', () => {
    // Stored 'paid', but only 400 of 1000 was ever paid. The export printed
    // "Bezahlt"; the screen's badge says "Teilweise".
    const sheet = salarySheet([salary({ driver_name: 'Ali', amount_due: 1000, total_paid: 400, status: 'paid' })]);
    expect(rowOf(sheet, 'Ali')[STATUS_COL]).toBe('Teilweise bezahlt');
  });

  it('a row paid in full against its base reads Bezahlt although it is stored unpaid', () => {
    const sheet = salarySheet([salary({ driver_name: 'Ali', amount_due: 900, netto_salary: 500, total_paid: 500, status: 'unpaid' })]);
    expect(rowOf(sheet, 'Ali')[STATUS_COL]).toBe('Bezahlt');
  });

  it('a row with no payment reads Unbezahlt although it is stored paid', () => {
    const sheet = salarySheet([salary({ driver_name: 'Ali', amount_due: 1000, total_paid: 0, status: 'paid' })]);
    expect(rowOf(sheet, 'Ali')[STATUS_COL]).toBe('Unbezahlt');
  });

  it('float noise does not make a fully paid row read as partly paid', () => {
    // 3 × 411,52 sums to 1234.5599999999999 in binary floats. MONEY_EPSILON is
    // what keeps that off a driver's file as a remaining balance.
    const sheet = salarySheet([salary({ driver_name: 'Ali', amount_due: 411.52 * 3, total_paid: 411.52 + 411.52 + 411.52 })]);
    expect(rowOf(sheet, 'Ali')[STATUS_COL]).toBe('Bezahlt');
  });

  it('the GESAMT row and the summary sum the base, not amount_due', () => {
    const sheet = salarySheet([
      salary({ driver_name: 'Ali',  amount_due: 900,  netto_salary: 500, total_paid: 500 }),
      salary({ driver_name: 'Berta', amount_due: 1000, total_paid: 400, status: 'paid' }),
    ]);
    // 500 + 1000, where summing amount_due gave 1900.
    expect(rowOf(sheet, 'GESAMT')[DUE_COL]).toBe('1500.00');
    expect(rowOf(sheet, 'Gesamt Fällig')[1]).toBe('1500.00');
  });

  it('the three summary counts are derived and sum to the driver count', () => {
    const sheet = salarySheet([
      salary({ driver_name: 'Ali',   amount_due: 500, total_paid: 500 }),               // paid
      salary({ driver_name: 'Berta', amount_due: 1000, total_paid: 400, status: 'paid' }), // partially
      salary({ driver_name: 'Cem',   amount_due: 800, total_paid: 0, status: 'paid' }),  // unpaid
    ]);
    expect(rowOf(sheet, 'Bezahlt')[1]).toBe('1');
    expect(rowOf(sheet, 'Teilweise bezahlt')[1]).toBe('1');
    expect(rowOf(sheet, 'Unbezahlt')[1]).toBe('1');
    expect(rowOf(sheet, 'Anzahl Fahrer')[1]).toBe('3');
  });

  it('the two section bands are merged, and the driver band is one of them', () => {
    // The literal merge rows were 6 and 17. 6 was right; 17 was the blank row
    // BELOW the driver band, so that title has never been merged and an empty
    // row was. Adding the summary's third count line would have shifted it again.
    exportSalariesToExcel([salary({ driver_name: 'Ali' })], '2026-09-01', '2026-09-30');
    const wb = writeFile.mock.calls[0][0] as XLSX.WorkBook;
    const ws = wb.Sheets['Gehälter'];
    const labels = columnA(ws);
    const merged = ((ws['!merges'] as XLSX.Range[] | undefined) ?? []).map((m: XLSX.Range) => m.s.r);
    expect(merged).toContain(labels.indexOf('ZUSAMMENFASSUNG'));
    expect(merged).toContain(labels.indexOf('GEHALTSÜBERSICHT PRO FAHRER'));
  });
});
