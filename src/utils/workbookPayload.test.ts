import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { buildSheetsWorkbook, buildTableWorkbook, type ExportColumnType } from './excelExport';
import { workbookToPayload } from './workbookPayload';
import { NUMBER_FORMATS } from '../lib/workbookContract';

function book(cells: Record<string, XLSX.CellObject>, ref: string): XLSX.WorkBook {
  const sheet: XLSX.WorkSheet = { ...cells, '!ref': ref };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, 'S');
  return wb;
}

describe('workbookToPayload', () => {
  it('keeps values, numbers and a listed format, and positions empty cells', () => {
    const payload = workbookToPayload(book({
      A1: { t: 's', v: 'Kopf' },
      B1: { t: 'n', v: 41.47, z: '#,##0.00\\ "€"' },
      C1: { t: 'n', v: 7 },
      B2: { t: 's', v: 'x' },
    }, 'A1:C2'));
    expect(payload).toEqual({
      version: 1,
      sheets: [{
        name: 'S',
        rows: [['Kopf', { t: 'n', v: 41.47, fmt: '#,##0.00\\ "€"' }, 7], [null, 'x']],
      }],
    });
  });

  it('never sends styling, widths, merges, freeze or filter, whatever the sheet describes', () => {
    const sheet = {
      A1: { t: 's', v: 'x', s: { font: { bold: true }, fill: { fgColor: { rgb: 'FF0000' } } } },
      '!ref': 'A1:A1',
      '!cols': [{ wch: 30 }],
      '!rows': [{ hpt: 40 }],
      '!merges': [{ s: { r: 0, c: 0 }, e: { r: 0, c: 0 } }],
      '!freeze': { xSplit: 0, ySplit: 1 },
      '!autofilter': { ref: 'A1:A1' },
    } as XLSX.WorkSheet;
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, 'S');
    const json = JSON.stringify(workbookToPayload(wb));
    expect(json).toBe('{"version":1,"sheets":[{"name":"S","rows":[["x"]]}]}');
  });

  it('marks every sheet as having a header row only when asked, and sends no other style', () => {
    const wb = book({ A1: { t: 's', v: 'Kopf' } }, 'A1:A1');
    expect(workbookToPayload(wb).sheets[0]).toEqual({ name: 'S', rows: [['Kopf']] });
    expect(workbookToPayload(wb, { headerRow: true }).sheets[0]).toEqual({ name: 'S', rows: [['Kopf']], header: true });
  });

  it('turns an empty string into nothing and drops trailing empty cells', () => {
    const payload = workbookToPayload(book({ A1: { t: 's', v: 'a' }, B1: { t: 's', v: '' }, C1: { t: 's', v: '' } }, 'A1:C1'));
    expect(payload.sheets[0].rows).toEqual([['a']]);
  });

  it('keeps a number as a number and drops a format the contract does not list', () => {
    const payload = workbookToPayload(book({ A1: { t: 'n', v: 3, z: '0.0000' } }, 'A1:A1'));
    expect(payload.sheets[0].rows).toEqual([[3]]);
  });

  it('keeps a string that looks like a formula or a number as a string', () => {
    const payload = workbookToPayload(book({ A1: { t: 's', v: '=SUM(A2)' }, B1: { t: 's', v: '0042' } }, 'A1:B1'));
    expect(payload.sheets[0].rows).toEqual([['=SUM(A2)', '0042']]);
  });

  it('refuses a cell type the contract does not carry, rather than guessing', () => {
    expect(() => workbookToPayload(book({ A1: { t: 'b', v: true } }, 'A1:A1'))).toThrow(/does not carry/);
  });

  it('keeps sheet order and names', () => {
    const wb = buildSheetsWorkbook([
      { filename: 'x', sheetTitle: 'A', moduleName: 'Eins', columns: [{ key: 'a', label: 'A' }], rows: [] },
      { filename: 'x', sheetTitle: 'B', moduleName: 'Zwei', columns: [{ key: 'a', label: 'A' }], rows: [] },
    ]);
    expect(workbookToPayload(wb).sheets.map(s => s.name)).toEqual(['Eins', 'Zwei']);
  });
});

describe('every column type the generic exporter writes', () => {
  const TYPES: ExportColumnType[] = ['number', 'number3', 'integer', 'money', 'percent', 'kilometres'];

  it('reaches the payload as a number under a format the contract lists', () => {
    const wb = buildTableWorkbook({
      filename: 'x', sheetTitle: 'T', moduleName: 'M',
      columns: TYPES.map(type => ({ key: type, label: type, type })),
      rows: [Object.fromEntries(TYPES.map(type => [type, 1234.5678]))],
      totals: Object.fromEntries(TYPES.slice(1).map(type => [type, 10])),
    });
    const cells = workbookToPayload(wb).sheets[0].rows.flat();
    const numbers = cells.filter((c): c is { t: 'n'; v: number; fmt: (typeof NUMBER_FORMATS)[number] } =>
      typeof c === 'object' && c !== null && c.t === 'n');
    expect(new Set(numbers.map(c => c.fmt)).size).toBe(TYPES.length);
    for (const cell of numbers) expect(NUMBER_FORMATS).toContain(cell.fmt);
  });

  it('keeps the 3-decimal unit price a number (PR 249)', () => {
    const wb = buildTableWorkbook({
      filename: 'x', sheetTitle: 'T', moduleName: 'M',
      columns: [{ key: 'p', label: 'Preis', type: 'number3' }],
      rows: [{ p: 2.049 }],
    });
    expect(workbookToPayload(wb).sheets[0].rows.flat()).toContainEqual({ t: 'n', v: 2.049, fmt: '#,##0.000' });
  });
});
