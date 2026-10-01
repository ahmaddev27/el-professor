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
 * Since 01.10.2026 no export in this module uses it: `exportTableToExcel`,
 * `exportSheetsToExcel` and so both legacy dumps all write through
 * `downloadStyledWorkbook`, xlsx 0.20.3 having discarded every fill, font and
 * border it was handed. Both writers are mocked, so "nothing was written" below
 * still means it — and §3's last assertion is that `writeFile` stays unused.
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
import { buildSalarySheets } from './listExportSheets';
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

/**
 * The two sheets the Gehälter export writes, as `ExportOptions`.
 *
 * Read off the builder rather than out of a written workbook. Since 01.10.2026
 * this export is drawn by `exportSheetsToExcel`, so there is no single sheet of
 * text to parse — and the rule under test is about the FIGURES, which the builder
 * hands over as numbers. Asserting on a number is what the old `.toFixed(2)`
 * string comparison was standing in for.
 */
function salarySheets(rows: SalaryCalculation[]) {
  const sheets = buildSalarySheets(rows, '2026-09-01', '2026-09-30');
  expect(sheets, 'the export is a summary sheet and a per-driver sheet').toHaveLength(2);
  return { summary: sheets[0], perDriver: sheets[1] };
}

/** The per-driver row for one driver. */
function driverRow(rows: SalaryCalculation[], name: string): Record<string, unknown> {
  const row = salarySheets(rows).perDriver.rows.find(r => r.driver === name);
  expect(row, `no row for ${name}`).toBeDefined();
  return row as Record<string, unknown>;
}

/** A metric's figure from the summary sheet, by its label. */
function metric(rows: SalaryCalculation[], label: string, key: 'amount' | 'count'): unknown {
  const row = salarySheets(rows).summary.rows.find(r => r.metric === label);
  expect(row, `no metric ${label}`).toBeDefined();
  return (row as Record<string, unknown>)[key];
}

describe('3 — the Gehälter export reads the same due and status as the screen', () => {
  it('due is netto_salary where it is set, not amount_due', () => {
    // The screen shows 500,00 for this row (salaryBase). The export printed
    // 900,00 — the calculated amount the manual adjustment overrode.
    expect(driverRow(
      [salary({ driver_name: 'Ali', amount_due: 900, netto_salary: 500, total_paid: 500 })],
      'Ali',
    ).due).toBe(500);
  });

  it('a netto adjustment to zero is honoured, because the base uses ?? and not ||', () => {
    expect(driverRow(
      [salary({ driver_name: 'Ali', amount_due: 900, netto_salary: 0 })],
      'Ali',
    ).due).toBe(0);
  });

  it('due falls back to amount_due when netto_salary is absent — 51 of 58 production rows', () => {
    expect(driverRow(
      [salary({ driver_name: 'Ali', amount_due: 1234.5, netto_salary: undefined })],
      'Ali',
    ).due).toBe(1234.5);
  });

  it('the status is derived from the payments, not read off the stored word', () => {
    // Stored 'paid', but only 400 of 1000 was ever paid. The export printed
    // "Bezahlt"; the screen's badge says "Teilweise".
    expect(driverRow(
      [salary({ driver_name: 'Ali', amount_due: 1000, total_paid: 400, status: 'paid' })],
      'Ali',
    ).status).toBe('Teilweise bezahlt');
  });

  it('a row paid in full against its base reads Bezahlt although it is stored unpaid', () => {
    expect(driverRow(
      [salary({ driver_name: 'Ali', amount_due: 900, netto_salary: 500, total_paid: 500, status: 'unpaid' })],
      'Ali',
    ).status).toBe('Bezahlt');
  });

  it('a row with no payment reads Unbezahlt although it is stored paid', () => {
    expect(driverRow(
      [salary({ driver_name: 'Ali', amount_due: 1000, total_paid: 0, status: 'paid' })],
      'Ali',
    ).status).toBe('Unbezahlt');
  });

  it('float noise does not make a fully paid row read as partly paid', () => {
    // 3 × 411,52 sums to 1234.5599999999999 in binary floats. MONEY_EPSILON is
    // what keeps that off a driver's file as a remaining balance.
    expect(driverRow(
      [salary({ driver_name: 'Ali', amount_due: 411.52 * 3, total_paid: 411.52 + 411.52 + 411.52 })],
      'Ali',
    ).status).toBe('Bezahlt');
  });

  it('the totals row and the summary sum the base, not amount_due', () => {
    const rows = [
      salary({ driver_name: 'Ali',   amount_due: 900,  netto_salary: 500, total_paid: 500 }),
      salary({ driver_name: 'Berta', amount_due: 1000, total_paid: 400, status: 'paid' }),
    ];
    // 500 + 1000, where summing amount_due gave 1900.
    expect(salarySheets(rows).perDriver.totals?.due).toBe(1500);
    expect(metric(rows, 'Gesamt Fällig', 'amount')).toBe(1500);
  });

  it('the three summary counts are derived and sum to the driver count', () => {
    const rows = [
      salary({ driver_name: 'Ali',   amount_due: 500,  total_paid: 500 }),                 // paid
      salary({ driver_name: 'Berta', amount_due: 1000, total_paid: 400, status: 'paid' }),  // partially
      salary({ driver_name: 'Cem',   amount_due: 800,  total_paid: 0,   status: 'paid' }),  // unpaid
    ];
    expect(metric(rows, 'Bezahlt', 'count')).toBe(1);
    expect(metric(rows, 'Teilweise bezahlt', 'count')).toBe(1);
    expect(metric(rows, 'Unbezahlt', 'count')).toBe(1);
    expect(metric(rows, 'Anzahl Fahrer', 'count')).toBe(3);
  });

  /**
   * What replaced the old merged section bands.
   *
   * Until 01.10.2026 both sections were stacked on ONE plain sheet with a merged
   * title row each, and this test pinned those two merges — because the literal
   * row numbers the code used had drifted: 6 was right, 17 was the blank row
   * BELOW the driver band, so that title had never actually been merged. They are
   * two sheets now, which is why there is nothing left to drift.
   */
  it('the two sections are two named sheets, and neither is a band in the other', () => {
    const { summary, perDriver } = salarySheets([salary({ driver_name: 'Ali' })]);
    expect(summary.moduleName).toBe('Zusammenfassung');
    expect(perDriver.moduleName).toBe('Pro Fahrer');
    expect(perDriver.rows.map(r => r.driver)).toEqual(['Ali']);
    // The per-driver sheet holds drivers only: no metric row leaked into it.
    expect(perDriver.rows.some(r => r.metric !== undefined)).toBe(false);
  });

  /**
   * And the file is written by the styled writer, not by `xlsx`.
   *
   * The whole reason this export was rebuilt: `xlsx@0.20.3` discards every fill,
   * font and border on write, so the Gehälter file came out an unstyled grid of
   * strings. A regression to `XLSX.writeFile` would satisfy every assertion above
   * and still produce that file.
   */
  it('writes through the styled writer and never through xlsx', () => {
    exportSalariesToExcel([salary({ driver_name: 'Ali' })], '2026-09-01', '2026-09-30');
    expect(downloadStyledWorkbook).toHaveBeenCalledTimes(1);
    expect(writeFile).not.toHaveBeenCalled();
    expect(downloadStyledWorkbook.mock.calls[0][1]).toBe('salaries_01-09-2026_to_30-09-2026.xlsx');
  });
});
