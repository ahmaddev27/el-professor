import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { buildTableWorkbook, type ExportColumn, type ExportOptions } from './excelExport';

/**
 * The generic table exporter used to write every cell as text, so Excel showed no
 * sum over a money column and warned "number stored as text" on each one. These
 * tests hold the two halves of the fix together:
 *
 *  - a column that opts in with `type` writes a real number cell (`t: 'n'`) with a
 *    German display format;
 *  - a column that does not opt in renders BYTE-IDENTICALLY to before, and so does
 *    a numeric column whose value cannot be read as a finite number.
 *
 * The format strings below are written out literally on purpose. Re-deriving them
 * from the same constant the implementation reads would let a wrong format pass.
 */

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

describe('buildTableWorkbook — numeric columns', () => {
  it('writes a money column as a number cell with the German euro format', () => {
    const ws = sheetOf({
      columns: [{ key: 'amount', label: 'Betrag', type: 'money' }],
      rows: [{ amount: 1234.56 }],
    });

    const cell = at(ws, FIRST_DATA_ROW, 0);
    expect(cell.t).toBe('n');
    expect(cell.v).toBe(1234.56);
    // Stored in en-US convention; Excel renders it as 1.234,56 € for a German viewer.
    expect(cell.z).toBe('#,##0.00\\ "€"');
  });

  it('writes number, integer and percent columns with their own formats', () => {
    const ws = sheetOf({
      columns: [
        { key: 'hours', label: 'Stunden', type: 'number' },
        { key: 'prio', label: 'Prio', type: 'integer' },
        { key: 'ratio', label: 'Anteil', type: 'percent' },
      ],
      rows: [{ hours: 160.5, prio: 100, ratio: 0.4147 }],
    });

    expect(at(ws, FIRST_DATA_ROW, 0)).toMatchObject({ t: 'n', v: 160.5, z: '#,##0.00' });
    expect(at(ws, FIRST_DATA_ROW, 1)).toMatchObject({ t: 'n', v: 100, z: '#,##0' });
    // Excel's percent format multiplies by 100, so the stored value is the fraction.
    expect(at(ws, FIRST_DATA_ROW, 2)).toMatchObject({ t: 'n', v: 0.4147, z: '0.0%' });
  });

  it('coerces a numeric string to a number', () => {
    const ws = sheetOf({
      columns: [{ key: 'amount', label: 'Betrag', type: 'money' }],
      rows: [{ amount: '42.5' }],
    });

    expect(at(ws, FIRST_DATA_ROW, 0)).toMatchObject({ t: 'n', v: 42.5 });
  });

  it('writes a numeric totals value as a number cell in the column format', () => {
    const ws = sheetOf({
      columns: [
        { key: 'description', label: 'Bezeichnung' },
        { key: 'amount', label: 'Betrag', type: 'money' },
      ],
      rows: [{ description: 'Miete', amount: 100 }],
      totals: { amount: 250.75 },
    });

    // data row, then the accent cap row, then the totals row
    const totalsCell = at(ws, FIRST_DATA_ROW + 2, 1);
    expect(totalsCell.t).toBe('n');
    expect(totalsCell.v).toBe(250.75);
    expect(totalsCell.z).toBe('#,##0.00\\ "€"');
  });
});

describe('buildTableWorkbook — the invariant: no opt-in, no change', () => {
  it('leaves a column without `type` as a text cell with no number format', () => {
    const ws = sheetOf({
      columns: [{ key: 'plate', label: 'Kennzeichen' }],
      rows: [{ plate: 'B-AB 1234' }],
    });

    const cell = at(ws, FIRST_DATA_ROW, 0);
    expect(cell.t).toBe('s');
    expect(cell.v).toBe('B-AB 1234');
    expect(cell.z).toBeUndefined();
  });

  it('still writes a numeric-looking value as text when the column does not opt in', () => {
    const ws = sheetOf({
      columns: [{ key: 'personalnummer', label: 'Personalnummer' }],
      rows: [{ personalnummer: '0042' }],
    });

    // A personnel number is an identifier: as a number it would lose its zeros.
    expect(at(ws, FIRST_DATA_ROW, 0)).toMatchObject({ t: 's', v: '0042' });
  });

  it('keeps a text column`s `format` in charge of the display', () => {
    const ws = sheetOf({
      columns: [{ key: 'status', label: 'Status', format: v => (v === 'active' ? 'Aktiv' : 'Inaktiv') }],
      rows: [{ status: 'active' }],
    });

    expect(at(ws, FIRST_DATA_ROW, 0)).toMatchObject({ t: 's', v: 'Aktiv' });
  });

  it('keeps a string totals value byte-identical', () => {
    const ws = sheetOf({
      columns: [
        { key: 'description', label: 'Bezeichnung' },
        { key: 'amount', label: 'Betrag', type: 'money' },
      ],
      rows: [{ description: 'Miete', amount: 100 }],
      totals: { amount: '+12,00 / -3,00' },
    });

    const totalsCell = at(ws, FIRST_DATA_ROW + 2, 1);
    expect(totalsCell.t).toBe('s');
    expect(totalsCell.v).toBe('+12,00 / -3,00');
    expect(totalsCell.z).toBeUndefined();
  });
});

describe('buildTableWorkbook — a number that cannot be read never becomes 0', () => {
  // A 0,00 € where the datum is missing is a wrong figure, and this product's
  // figures reconcile against an accountant's.
  const cases: Array<[string, unknown, string]> = [
    ['null', null, ''],
    ['undefined', undefined, ''],
    ['an empty string', '', ''],
    ['whitespace', '   ', '   '],
    ['NaN', NaN, 'NaN'],
    ['a word', 'k. A.', 'k. A.'],
    ['Infinity', Infinity, 'Infinity'],
  ];

  for (const [name, raw, expected] of cases) {
    it(`falls back to today's text behaviour for ${name}`, () => {
      const ws = sheetOf({
        columns: [{ key: 'amount', label: 'Betrag', type: 'money' }],
        rows: [{ amount: raw }],
      });

      const cell = at(ws, FIRST_DATA_ROW, 0);
      expect(cell.t).toBe('s');
      expect(cell.v).toBe(expected);
      expect(cell.z).toBeUndefined();
    });
  }

  it('does not invent a value for a key the row does not carry', () => {
    const ws = sheetOf({
      columns: [{ key: 'missing', label: 'Fehlt', type: 'integer' }],
      rows: [{ other: 5 }],
    });

    expect(at(ws, FIRST_DATA_ROW, 0)).toMatchObject({ t: 's', v: '' });
  });

  it('writes zero itself as a real zero', () => {
    const ws = sheetOf({
      columns: [{ key: 'amount', label: 'Betrag', type: 'money' }],
      rows: [{ amount: 0 }],
    });

    expect(at(ws, FIRST_DATA_ROW, 0)).toMatchObject({ t: 'n', v: 0 });
  });
});
