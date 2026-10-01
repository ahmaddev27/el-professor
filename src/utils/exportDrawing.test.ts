/**
 * Every styled workbook is actually DRAWN, and none of them is signed.
 *
 * ## Why this test reads the written bytes
 *
 * The owner reported on 01.10.2026 that the Excel files came out ugly, and the
 * cause was not the drawing code: `xlsx@0.20.3` writes one hard-coded font, two
 * fills and one empty border for a whole file, discarding every style it is
 * handed. So a module could describe a fill on every cell, a test could assert
 * that the description was correct, and the file a customer opened was still a
 * plain grid. `excelExportCore.test.ts` and `styledWorkbookDownload.test.ts`
 * assert the description and the translation; this one builds each workbook,
 * runs it through the REAL `exceljs`, writes it to a buffer, **reads the buffer
 * back** and counts what survived.
 *
 * That is the only way to be sure, and it is cheap: three workbooks, no DOM.
 *
 * ## The two things it refuses
 *
 * - **A flat sheet.** Zero fills or zero borders in a sheet of a styled workbook
 *   means that sheet reached the writer as a bare grid, whatever the builder
 *   said. A new export added to `EXPORTS` below either draws or fails here.
 * - **A signature.** No cell and no document property may name the product. The
 *   footer band used to write "El-Professor Verwaltungssystem — N Datensätze
 *   exportiert" into every file, and `Author`/`Company` carried the name into the
 *   file's properties; both went on 01.10.2026, and a customer's file carries no
 *   mark of ours. The check is a case-insensitive match on "professor", so it
 *   also catches a reworded version of the same line.
 *
 * It says nothing about whether the colours are *nice*. A number that is a
 * number, a border that exists and a name that is absent are the three things
 * that can be measured.
 *
 * ## What it does not reach, so nobody assumes it covers everything
 *
 * - **The Fahrtenanalyse report** is drawn too, and asserted in its own file
 *   (`tripAnalysisReport.test.ts`, "the drawing"), on the description rather than
 *   on the written bytes. Its four sheets are not uniform tables, so they are not
 *   `ExportOptions` and cannot be listed here.
 * - **The Fahrerübersicht** (`exportFahreruebersichtToExcel`) exports no builder —
 *   it writes the file itself — so there is nothing here to hand to the writer. It
 *   had always DESCRIBED a fully drawn sheet, 22 styles and all, and xlsx threw
 *   every one away; the correction was the writer, not the drawing.
 * - **The Fahrtenbuch exports** must stay plain and are not a defect.
 */
import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';

import { buildSheetsWorkbook, buildTableWorkbook, type ExportOptions } from './excelExport';
import { buildIncomeSheets, buildSalarySheets } from './listExportSheets';
import { applyStyledWorkbook } from './styledWorkbookDownload';
import type { Income, SalaryCalculation } from '../types/receipt';

interface SheetReport {
  sheet: string;
  fills: number;
  borders: number;
  numberFormats: number;
  numericCells: number;
  signatures: string[];
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Writes the workbook with exceljs, reads it back, and counts what survived. */
async function written(source: XLSX.WorkBook): Promise<SheetReport[]> {
  const loaded: unknown = await import('exceljs');
  const candidate = loaded as { Workbook?: unknown; default?: { Workbook?: unknown } };
  const Workbook = (candidate.Workbook ?? candidate.default?.Workbook) as new () => any;

  const out = new Workbook();
  applyStyledWorkbook(source, out);
  const buffer = await out.xlsx.writeBuffer();

  const back = new Workbook();
  await back.xlsx.load(buffer);

  const reports: SheetReport[] = [];
  for (const ws of back.worksheets) {
    const report: SheetReport = {
      sheet: ws.name, fills: 0, borders: 0, numberFormats: 0, numericCells: 0, signatures: [],
    };
    ws.eachRow({ includeEmpty: false }, (row: any) => {
      row.eachCell({ includeEmpty: false }, (cell: any) => {
        if (cell.fill?.type) report.fills++;
        if (cell.border && Object.keys(cell.border).length > 0) report.borders++;
        if (cell.numFmt) report.numberFormats++;
        if (typeof cell.value === 'number') report.numericCells++;
        if (typeof cell.value === 'string' && /professor/i.test(cell.value)) {
          report.signatures.push(cell.value);
        }
      });
    });
    reports.push(report);
  }

  // The document properties are part of the file a customer can read, under
  // File → Info, so a signature there counts as one.
  const props = [back.creator, back.lastModifiedBy, back.company, back.title, back.subject]
    .filter((value): value is string => typeof value === 'string' && /professor/i.test(value));
  if (props.length > 0) reports[0].signatures.push(...props.map(p => `[properties] ${p}`));

  return reports;
}

/* eslint-enable @typescript-eslint/no-explicit-any */

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
 * and the drawing is per band, not per caller.
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

/** A list that passes a footer note, which is the one way the band is drawn. */
const LIST_WITH_NOTE: ExportOptions = {
  ...GENERIC_LIST,
  labels: { footer: 'Zuschlagsarten sind Zuschläge derselben Stunden und dürfen nicht addiert werden.' },
};

const EXPORTS: [name: string, build: () => XLSX.WorkBook][] = [
  ['a generic list',            () => buildTableWorkbook(GENERIC_LIST)],
  ['a list with a footer note', () => buildTableWorkbook(LIST_WITH_NOTE)],
  ['Umsätze (3 sheets)', () => buildSheetsWorkbook(buildIncomeSheets(
    [income({}), income({ type: 'trinkgeld', amount: 20, driver_name: 'Berta' })],
    '2026-10-01', '2026-10-31',
  ))],
  ['Gehälter (2 sheets)', () => buildSheetsWorkbook(buildSalarySheets(
    [salary({}), salary({ driver_name: 'Berta', total_paid: 890 })],
    '2026-10-01', '2026-10-31',
  ))],
];

describe('the written file: drawn, numeric and unsigned', () => {
  for (const [name, build] of EXPORTS) {
    // 60 s, because the FIRST case in the file pays for loading exceljs — 27 s on
    // this machine, against well under a second for every case after it. A 5 s
    // default made the first test fail and the other four pass, which reads as a
    // defect in that one export and is nothing of the kind.
    it(`${name} reaches the file with fills, borders and no signature`, { timeout: 60_000 }, async () => {
      const reports = await written(build());
      expect(reports.length, 'the workbook has no sheet').toBeGreaterThan(0);

      for (const report of reports) {
        // eslint-disable-next-line no-console
        console.log(
          `  ${name} / ${report.sheet.padEnd(18)} fills=${String(report.fills).padStart(3)}`
          + ` borders=${String(report.borders).padStart(3)}`
          + ` numFmt=${String(report.numberFormats).padStart(3)}`
          + ` numeric=${String(report.numericCells).padStart(3)}`,
        );
        expect(report.fills, `${name} / ${report.sheet}: not one cell carries a fill`)
          .toBeGreaterThan(0);
        expect(report.borders, `${name} / ${report.sheet}: not one cell carries a border`)
          .toBeGreaterThan(0);
        expect(report.signatures, `${name} / ${report.sheet}: the file is signed`)
          .toEqual([]);
      }

      // At least one sheet holds real numbers under a real format. Writing money
      // as text with `.toFixed(2)` is what made these files unusable: a column an
      // accountant has to add up by hand.
      expect(
        reports.some(r => r.numericCells > 0 && r.numberFormats > 0),
        `${name}: every figure in the workbook is text`,
      ).toBe(true);
    });
  }

  it('the Umsätze money columns are numbers, not strings', { timeout: 60_000 }, async () => {
    const [entries] = await written(
      buildSheetsWorkbook(buildIncomeSheets([income({ amount: 1234.56 })], '2026-10-01', '2026-10-31')),
    );
    // One amount cell and one totals cell, both numeric and both formatted.
    expect(entries.numericCells).toBeGreaterThanOrEqual(2);
    expect(entries.numberFormats).toBeGreaterThanOrEqual(2);
  });
});
