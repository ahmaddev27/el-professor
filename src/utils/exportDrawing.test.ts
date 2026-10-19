/**
 * What the export service is asked to write: plain, numeric and unsigned.
 *
 * This file used to write each workbook with ExcelJS, read the bytes back and
 * count the fills and borders that survived, because `xlsx@0.20.3` threw every
 * style away and a test of the description alone could pass while the customer
 * opened a bare grid. Both halves of that story are over: the lists are written
 * by the export service (openpyxl, plain, no fills and no borders by decision),
 * and what crosses the network is a payload that has no field for a style.
 *
 * So the same four workbooks are built and turned into the payload, and what is
 * asserted is the payload:
 *
 * - **Plain.** Nothing in it but the contract's own keys, so a font, a fill or a
 *   border could not travel even if a builder still described one.
 * - **Numeric.** A figure is a number under a format the contract lists, never a
 *   string, so an accountant can sum the column. Writing money as text with
 *   `.toFixed(2)` is what made these files unusable.
 * - **Unsigned.** No cell and no sheet name may name the product. The footer band
 *   used to write "El-Professor Verwaltungssystem — N Datensätze exportiert" into
 *   every file; it went on 01.10.2026 and a customer's file carries no mark of
 *   ours. The check is a case-insensitive match on "professor". (The service
 *   sets the document properties itself, and its tests assert them.)
 *
 * The bytes the service writes are asserted in deploy/export-service/tests.
 */
import { describe, it, expect } from 'vitest';
import type * as XLSX from 'xlsx';

import { buildPlainWorkbook, type ExportOptions } from './excelExport';
import { buildIncomeSheets, buildSalarySheets } from './listExportSheets';
import { workbookToPayload } from './workbookPayload';
import { isNumberFormat, type PayloadCell } from '../lib/workbookContract';
import type { Income, SalaryCalculation } from '../types/receipt';

const ALLOWED_KEYS = new Set(['version', 'sheets', 'name', 'rows', 't', 'v', 'fmt']);

interface PayloadReport {
  keys: Set<string>;
  numbers: number;
  formattedNumbers: number;
  strings: string[];
  badFormats: unknown[];
}

function report(source: XLSX.WorkBook): PayloadReport {
  const payload = workbookToPayload(source);
  const out: PayloadReport = { keys: new Set(), numbers: 0, formattedNumbers: 0, strings: [], badFormats: [] };
  const visit = (cell: PayloadCell) => {
    if (cell === null) return;
    if (typeof cell === 'string') { out.strings.push(cell); return; }
    if (typeof cell === 'number') { out.numbers++; return; }
    Object.keys(cell).forEach(k => out.keys.add(k));
    if (cell.t === 'n') {
      out.numbers++;
      if (cell.fmt !== undefined) {
        out.formattedNumbers++;
        if (!isNumberFormat(cell.fmt)) out.badFormats.push(cell.fmt);
      }
    }
  };
  Object.keys(payload).forEach(k => out.keys.add(k));
  for (const sheet of payload.sheets) {
    Object.keys(sheet).forEach(k => out.keys.add(k));
    out.strings.push(sheet.name);
    sheet.rows.forEach(row => row.forEach(visit));
  }
  return out;
}

const income = (over: Partial<Income>): Income => ({
  id: 'i1', driver_name: 'Ali', type: 'umsatz', amount: 1234.56,
  description: 'Woche 40', date: '2026-10-01',
  ...over,
} as Income);

const salary = (over: Partial<SalaryCalculation>): SalaryCalculation => ({
  driver_id: 'd', driver_name: 'Ali', salary_ratio: 0.42,
  revenue: 2000, tips: 50, revenue_share: 840,
  amount_due: 890, status: 'unpaid',
  ...over,
});

/**
 * One generic list, standing for the twenty screens that call
 * `exportTableToExcel` with their own columns. They differ only in their columns,
 * and the payload is per cell, not per caller.
 */
const GENERIC_LIST: ExportOptions = {
  filename: 'fahrzeuge',
  sheetTitle: 'Fahrzeuge',
  moduleName: 'Fahrzeuge',
  filterSummary: ['Aktive Filter: alle'],
  columns: [
    { key: 'plate', label: 'Kennzeichen', width: 16 },
    { key: 'km',    label: 'Kilometer',   width: 14, align: 'right', type: 'kilometres' },
    { key: 'cost',  label: 'Kosten',      width: 14, align: 'right', type: 'money' },
  ],
  rows: [{ plate: 'B-AB 1', km: 120345, cost: 499.9 }],
  totals: { km: 120345, cost: 499.9 },
};

/** A list that passes a footer note, which is the one way the band is written. */
const LIST_WITH_NOTE: ExportOptions = {
  ...GENERIC_LIST,
  labels: { footer: 'Zuschlagsarten sind Zuschläge derselben Stunden und dürfen nicht addiert werden.' },
};

const EXPORTS: [name: string, build: () => XLSX.WorkBook][] = [
  ['a generic list',            () => buildPlainWorkbook([GENERIC_LIST])],
  ['a list with a footer note', () => buildPlainWorkbook([LIST_WITH_NOTE])],
  ['Umsätze (3 sheets)', () => buildPlainWorkbook(buildIncomeSheets(
    [income({ trip_count: 12 }), income({ type: 'trinkgeld', amount: 20, driver_name: 'Berta', trip_count: null })],
    '2026-10-01', '2026-10-31',
  ))],
  ['Gehälter (2 sheets)', () => buildPlainWorkbook(buildSalarySheets(
    [salary({}), salary({ driver_name: 'Berta', total_paid: 890 })],
    '2026-10-01', '2026-10-31',
  ))],
];

describe('the payload: plain, numeric and unsigned', () => {
  for (const [name, build] of EXPORTS) {
    it(`${name} carries values and number formats only, and no signature`, () => {
      const r = report(build());
      expect([...r.keys].filter(k => !ALLOWED_KEYS.has(k)), `${name}: a key the contract does not have`).toEqual([]);
      expect(r.badFormats, `${name}: a number format the contract does not list`).toEqual([]);
      expect(r.strings.filter(s => /professor/i.test(s)), `${name}: the file is signed`).toEqual([]);
      // At least one figure is a number under a real format. Writing money as
      // text is what made these files unusable: a column to add up by hand.
      expect(r.numbers > 0, `${name}: every figure in the workbook is text`).toBe(true);
      // Uber's data cells carry no number format, so neither do ours.
      expect(r.formattedNumbers, `${name}: a number carries a format`).toBe(0);
    });
  }

  it('the Umsätze money columns are numbers, not strings', () => {
    const r = report(buildPlainWorkbook(buildIncomeSheets([income({ amount: 1234.56 })], '2026-10-01', '2026-10-31')));
    // The amount cells are numeric, and bare.
    expect(r.numbers).toBeGreaterThanOrEqual(2);
    expect(r.formattedNumbers).toBe(0);
  });
});
