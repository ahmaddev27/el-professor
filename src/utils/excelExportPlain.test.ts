/**
 * The shape of an operational export: headers in A1, data from A2, nothing else.
 *
 * The owner's instruction is "literally the same as Uber's file", measured on
 * uber.xlsx: row 1 the headers, rows 2..n the data, no totals row, no title, no
 * columns element, no freeze pane, no autofilter. This pins that shape, and pins
 * what the file therefore no longer carries so nobody later reads the loss as a
 * bug: the title band, the module name and timestamp, the "Aktive Filter" line
 * (the only record of which filter produced a file), the "Gesamt" totals row and
 * the empty-state sentence.
 */
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { buildPlainWorkbook, buildTableWorkbook, type ExportOptions } from './excelExport';
import { workbookToPayload } from './workbookPayload';

const OPTIONS: ExportOptions = {
  filename: 'belege',
  sheetTitle: 'BELEGE-TITEL',
  moduleName: 'Belege',
  filterSummary: ['Zeitraum: Oktober', 'Fahrer: Alle'],
  columns: [
    { key: 'nr', label: 'Belegnummer' },
    { key: 'preis', label: 'Literpreis', type: 'number3' },
    { key: 'betrag', label: 'Betrag', type: 'money' },
    { key: 'km', label: 'Kilometer', type: 'kilometres' },
  ],
  rows: [
    { nr: 'BEL-1', preis: 2.049, betrag: 41.47, km: 120345 },
    { nr: 'BEL-2', preis: null, betrag: 0, km: undefined },
  ],
  totals: { betrag: 41.47 },
  labels: { footer: 'Fussnote' },
};

function rowsOf(options: ExportOptions) {
  return workbookToPayload(buildPlainWorkbook([options]), { headerRow: true }).sheets[0];
}

describe('the plain export shape', () => {
  it('is the headers in row 1 and the data from row 2, and nothing else', () => {
    const sheet = rowsOf(OPTIONS);
    expect(sheet.header).toBe(true);
    expect(sheet.rows).toHaveLength(3);
    expect(sheet.rows[0]).toEqual(['Belegnummer', 'Literpreis', 'Betrag', 'Kilometer']);
    expect(sheet.rows[1]).toEqual([
      'BEL-1',
      { t: 'n', v: 2.049, fmt: '#,##0.000' },
      { t: 'n', v: 41.47, fmt: '#,##0.00\\ "€"' },
      { t: 'n', v: 120345, fmt: '#,##0\\ "km"' },
    ]);
  });

  it('writes no title, module name, timestamp, filter line, totals row, footer or empty-state text', () => {
    const everything = JSON.stringify(rowsOf(OPTIONS));
    for (const gone of ['BELEGE-TITEL', 'BELEGE', 'Aktive Filter', 'Zeitraum', 'Fahrer: Alle', 'Gesamt', 'Fussnote']) {
      expect(everything, gone).not.toContain(gone);
    }
    expect(JSON.stringify(rowsOf({ ...OPTIONS, rows: [] }))).not.toContain('Keine Daten');
    expect(rowsOf({ ...OPTIONS, rows: [] }).rows).toEqual([['Belegnummer', 'Literpreis', 'Betrag', 'Kilometer']]);
  });

  it('keeps a missing figure empty and a real zero a zero', () => {
    const [, , second] = rowsOf(OPTIONS).rows;
    // preis is missing: an empty cell in its place (null), never 0; the real 0
    // in betrag stays a number; the trailing missing km is simply not sent.
    expect(second).toEqual(['BEL-2', null, { t: 'n', v: 0, fmt: '#,##0.00\\ "€"' }]);
  });

  it('describes no style, width, merge, freeze or filter on the sheet', () => {
    const sheet = buildPlainWorkbook([OPTIONS]).Sheets.Belege as unknown as Record<string, unknown>;
    expect(Object.keys(sheet).filter(k => k.startsWith('!'))).toEqual(['!ref']);
    expect(Object.entries(sheet).filter(([k, v]) => !k.startsWith('!') && (v as { s?: unknown }).s)).toEqual([]);
    expect(sheet['!ref']).toBe('A1:D3');
  });

  it('keeps the header text it is given, in whatever language the screen used', () => {
    const sheet = rowsOf({ ...OPTIONS, columns: [{ key: 'nr', label: 'Receipt no.' }], rows: [] });
    expect(sheet.rows[0]).toEqual(['Receipt no.']);
  });

  it('still refuses a totals entry on the first column, whichever shape the file has', () => {
    expect(() => buildPlainWorkbook([{ ...OPTIONS, totals: { nr: 'x' } }])).toThrow(/can never be rendered/);
  });

  it('numbers a repeated sheet name instead of throwing, as before', () => {
    const wb = buildPlainWorkbook([OPTIONS, OPTIONS]);
    expect(wb.SheetNames).toEqual(['Belege', 'Belege (2)']);
  });

  it('leaves buildTableWorkbook, which the monthly plan documents still use, with its bands', () => {
    const sheet = buildTableWorkbook(OPTIONS).Sheets.Belege;
    expect(XLSX.utils.encode_cell({ r: 1, c: 0 })).toBe('A2');
    expect((sheet.A2 as { v: string }).v).toBe('BELEGE-TITEL');
  });
});
