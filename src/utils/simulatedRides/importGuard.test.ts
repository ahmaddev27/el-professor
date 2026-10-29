import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { SIMULATED_NOTICE, SIMULATED_SHEET_NAME, addSimulatedNotice, findSimulationMarker } from './marker';
import { buildMonthReport } from './monthWorkbook';
import { buildFixtureMonth } from '../../../scripts/lib/reportFixture';
import { UBER_COLUMN_MAP } from './importPath';
import { rideToRow } from './sheet';

/**
 * A simulated file must never be imported as a real Fahrtenbuch. The guard is a
 * pure function over the workbook the modal has just read, and these tests are
 * the three signs it looks for, the control that a real file passes, and the
 * wiring that puts it before anything is kept.
 */
const book = (rows: unknown[][], name = 'Sheet1'): XLSX.WorkBook => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  return wb;
};
const first = (wb: XLSX.WorkBook) => findSimulationMarker(wb, wb.SheetNames[0]);

describe('findSimulationMarker', () => {
  it('refuses a workbook with a sheet named SIMULIERT, whichever sheet is read', () => {
    const wb = book([['Fahrername'], ['Fahrer 1']]);
    addSimulatedNotice(wb, 'last');
    expect(first(wb)).toBe('sheet');
  });

  it('refuses a copied sheet that kept the label column', () => {
    const wb = book([['Kennzeichnung', 'Fahrername'], ['SIMULIERT', 'Fahrer 1'], ['SIMULIERT', 'Fahrer 2']]);
    expect(first(wb)).toBe('label_column');
  });

  it('refuses a read sheet holding the notice sentence in any cell', () => {
    const wb = book([['Fahrername'], ['Fahrer 1'], [], [SIMULATED_NOTICE]]);
    expect(first(wb)).toBe('notice_text');
  });

  it('does not take a header alone, or the word in another column, for the label', () => {
    expect(first(book([['Kennzeichnung', 'Fahrername'], ['', 'SIMULIERT']]))).toBeNull();
    expect(first(book([['Kennzeichnung'], ['normal']]))).toBeNull();
  });

  it('control: a real Uber-shaped sheet passes — its 18 headers do not include the label header', async () => {
    const month = await buildFixtureMonth({ year: 2026, month: 10, seed: 7 });
    const row = rideToRow(month.month.rides[0]);
    const headers = Object.keys(row);
    expect(headers).toHaveLength(18);
    expect(headers).not.toContain('Kennzeichnung');
    expect(Object.values(UBER_COLUMN_MAP)).not.toContain('Kennzeichnung');
    expect(first(book([headers, headers.map(h => String(row[h]))]))).toBeNull();
  });

  it('the report this module exports is refused as a whole and sheet by sheet', async () => {
    const report = buildMonthReport(await buildFixtureMonth({ year: 2026, month: 10, seed: 7 }));
    const rows = (name: string) => report.payload.sheets.find(s => s.name === name)!.rows;
    const rides = rows('A Fahrten') as unknown[][];
    expect(first(book(rides))).toBe('label_column');
    // The notice sheet alone is a single cell of the sentence.
    expect(first(book(rows(SIMULATED_SHEET_NAME) as unknown[][]))).toBe('notice_text');
  });
});

describe('where the guard applies', () => {
  const read = (rel: string) => readFileSync(path.resolve(__dirname, rel), 'utf8');

  it('the real import modal asks before it keeps the bytes or asks for a fingerprint', () => {
    const src = read('../../components/FahrtenbuchImportModal.tsx');
    const guard = src.indexOf('findSimulationMarker(wb, sheetName)');
    expect(guard).toBeGreaterThan(0);
    expect(src.indexOf('setRawXlsxBytes(data)')).toBeGreaterThan(guard);
    expect(src.indexOf('checkFileFingerprint(data)')).toBeGreaterThan(guard);
    // Unconditional: nothing may sit in front of the check (a `false &&` would disable it), and it must stop the read.
    expect(src).toMatch(/\n\s+if \(findSimulationMarker\(wb, sheetName\) !== null\) \{\s*setParseError\(t\('imp\.error\.simulatedFile'\)\);\s*return;\s*\}/);
  });

  it('the simulated import path does not use it, so it keeps importing with isSimulated', () => {
    expect(read('./importPath.ts')).not.toContain('findSimulationMarker');
    expect(read('./sheet.ts')).not.toContain('findSimulationMarker');
  });
});
