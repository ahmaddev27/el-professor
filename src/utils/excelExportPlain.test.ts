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
import { buildIncomeSheets } from './listExportSheets';
import type { Income } from '../types/receipt';

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
    // Bare numbers: no unit, no currency symbol, no forced decimals.
    expect(sheet.rows[1]).toEqual(['BEL-1', 2.049, 41.47, 120345]);
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
    expect(second).toEqual(['BEL-2', null, 0]);
  });

  it('puts no number format on any data cell, whichever column type it is (Uber has none)', () => {
    const types = ['number', 'number3', 'integer', 'money', 'percent', 'kilometres'] as const;
    const sheet = rowsOf({
      ...OPTIONS,
      columns: types.map(type => ({ key: type, label: type, type, width: 30, align: 'right' as const })),
      rows: [Object.fromEntries(types.map(type => [type, 1234.5678]))],
    });
    // Every type is the stored number except percent, whose fraction becomes the
    // percentage a reader expects (below).
    expect(sheet.rows[1]).toEqual(types.map(type => (type === 'percent' ? 123456.78 : 1234.5678)));
    expect(JSON.stringify(sheet)).not.toMatch(/fmt|"t":/);
    const raw = buildPlainWorkbook([{ ...OPTIONS, columns: OPTIONS.columns.map(col => ({ ...col, width: 40, align: 'right' as const })) }]);
    const cells = Object.entries(raw.Sheets.Belege).filter(([k]) => !k.startsWith('!')).map(([, v]) => v as { z?: unknown; s?: unknown });
    expect(cells.filter(cell => cell.z !== undefined || cell.s !== undefined)).toEqual([]);
  });

  it('writes a percent column as the percentage, stored value times 100, bare', () => {
    const fractions = [0.42, 0.29, 0.4147, 0.1, 0, 1, 0.3333333333333333];
    const sheet = rowsOf({
      ...OPTIONS,
      columns: [{ key: 'anteil', label: 'Anteil', type: 'percent' }],
      rows: fractions.map(anteil => ({ anteil })),
    });
    // 0.29 * 100 is 28.999999999999996 in floating point; the noise is dropped.
    expect(sheet.rows.slice(1)).toEqual([[42], [29], [41.47], [10], [0], [100], [33.3333333333]]);
    const json = JSON.stringify(sheet);
    expect(json).not.toMatch(/fmt|%/);
    const raw = buildPlainWorkbook([{ ...OPTIONS, columns: [{ key: 'anteil', label: 'Anteil', type: 'percent' }], rows: [{ anteil: 0.42 }] }]);
    expect(raw.Sheets.Belege.A2).toEqual({ t: 'n', v: 42 });
  });

  it('does not scale anything that is not a percent column, nor a value it cannot read', () => {
    const sheet = rowsOf({
      ...OPTIONS,
      columns: [
        { key: 'n', label: 'N', type: 'number' },
        { key: 'p', label: 'P', type: 'percent' },
      ],
      rows: [{ n: 0.42, p: null }, { n: 0.42, p: 'kein Wert' }],
    });
    expect(sheet.rows.slice(1)).toEqual([[0.42], [0.42, 'kein Wert']]);
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

  it('a real caller (Umsätze, Anteil by type) reaches the file as a percentage without touching its own code', () => {
    const income = (type: string, amount: number) => ({ id: type, driver_name: 'Ali', type, amount, description: '', date: '2026-10-01' }) as unknown as Income;
    const [, byType] = buildIncomeSheets([income('umsatz', 75), income('trinkgeld', 25)], '2026-10-01', '2026-10-31');
    const sheet = workbookToPayload(buildPlainWorkbook([byType]), { headerRow: true }).sheets[0];
    expect(sheet.rows[0]).toEqual(['Typ', 'Betrag', 'Anteil']);
    const shares = sheet.rows.slice(1).map(row => row[2]).filter(v => v !== undefined && v !== null);
    expect(shares).toContain(75);
    expect(shares).toContain(25);
  });
});
