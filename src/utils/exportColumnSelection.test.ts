import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { buildTableWorkbook, type ExportOptions } from './excelExport';
import {
  STORAGE_PREFIX,
  applyColumnSelection,
  loadRemembered,
  moveKey,
  orderForDisplay,
  resolveInitialSelection,
  saveRemembered,
  validateSelection,
} from './exportColumnSelection';

const OPTS: ExportOptions = {
  filename: 'x',
  sheetTitle: 'Titel',
  moduleName: 'Modul',
  columns: [
    { key: 'name', label: 'Name', width: 20 },
    { key: 'city', label: 'Ort', width: 20 },
    { key: 'amount', label: 'Betrag', type: 'money', align: 'right' },
    { key: 'km', label: 'Kilometer', type: 'integer' },
  ],
  rows: [
    { name: 'Anna', city: 'Köln', amount: 12.5, km: 100 },
    { name: 'Ben', city: 'Bonn', amount: 7.25, km: 40 },
  ],
  labels: { totalsRow: 'Gesamt (2)' },
  totals: { amount: 19.75, km: 140 },
};

/** The header row of the drawn sheet: the first row whose cells carry the labels. */
function headerLabels(opts: ExportOptions): string[] {
  const ws = buildTableWorkbook(opts).Sheets[buildTableWorkbook(opts).SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, blankrows: false });
  const labels = opts.columns.map(c => c.label);
  const row = rows.find(r => labels.every((l, i) => r[i] === l));
  if (!row) throw new Error('header row not found');
  return row.slice(0, labels.length).map(String);
}

function sheetOf(opts: ExportOptions): XLSX.WorkSheet {
  const wb = buildTableWorkbook(opts);
  return wb.Sheets[wb.SheetNames[0]];
}

describe('resolveInitialSelection', () => {
  const available = ['a', 'b', 'c'];
  it('starts with every column in the table order when nothing is remembered', () => {
    expect(resolveInitialSelection(available, null)).toEqual(['a', 'b', 'c']);
  });
  it('keeps the remembered subset and order', () => {
    expect(resolveInitialSelection(available, { selected: ['c', 'a'], known: available })).toEqual(['c', 'a']);
  });
  it('ignores a remembered column the table no longer offers', () => {
    expect(resolveInitialSelection(available, { selected: ['gone', 'b'], known: ['gone', 'a', 'b', 'c'] })).toEqual(['b']);
  });
  it('INCLUDES a column the memory has never seen', () => {
    expect(resolveInitialSelection(['a', 'b', 'c', 'd'], { selected: ['a'], known: ['a', 'b', 'c'] })).toEqual(['a', 'd']);
  });
  it('does not resurrect a column the user unticked and had seen', () => {
    expect(resolveInitialSelection(available, { selected: ['a', 'c'], known: available })).toEqual(['a', 'c']);
  });
  it('falls back to everything when the memory matches nothing', () => {
    expect(resolveInitialSelection(available, { selected: ['gone'], known: ['gone', 'a', 'b', 'c'] })).toEqual(['a', 'b', 'c']);
  });
});

describe('validateSelection / moveKey / orderForDisplay', () => {
  it('refuses an empty selection by name', () => {
    expect(validateSelection([])).toBe('empty');
    expect(validateSelection(['a'])).toBeNull();
  });
  it('moves one place and clamps at the ends', () => {
    expect(moveKey(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(moveKey(['a', 'b', 'c'], 'a', -1)).toEqual(['a', 'b', 'c']);
    expect(moveKey(['a', 'b', 'c'], 'c', 1)).toEqual(['a', 'b', 'c']);
  });
  it('lists chosen columns first, then the rest in table order', () => {
    expect(orderForDisplay(['a', 'b', 'c', 'd'], ['c', 'a'])).toEqual(['c', 'a', 'b', 'd']);
  });
});

describe('applyColumnSelection', () => {
  it('writes exactly the chosen headers, in the chosen order', () => {
    const chosen = applyColumnSelection(OPTS, ['amount', 'name']);
    expect(headerLabels(chosen)).toEqual(['Betrag', 'Name']);
  });

  it('refuses an empty selection instead of writing an empty sheet', () => {
    expect(() => applyColumnSelection(OPTS, [])).toThrow(/no column selected/);
  });

  it('totals only the columns that are in the file', () => {
    const chosen = applyColumnSelection(OPTS, ['name', 'km']);
    expect(Object.keys(chosen.totals ?? {})).toEqual(['km']);
    const ws = sheetOf(chosen);
    const values = Object.values(ws).map(c => (c as XLSX.CellObject).v);
    expect(values).toContain(140);
    expect(values).not.toContain(19.75);
  });

  it('drops the figure of a column that became first instead of throwing', () => {
    const chosen = applyColumnSelection(OPTS, ['amount', 'km']);
    expect(chosen.totals).toEqual({ km: 140 });
    expect(() => buildTableWorkbook(chosen)).not.toThrow();
  });

  it('keeps numbers as numbers with their German formats', () => {
    const ws = sheetOf(applyColumnSelection(OPTS, ['amount']));
    const cells = Object.entries(ws).filter(([, c]) => (c as XLSX.CellObject).t === 'n') as [string, XLSX.CellObject][];
    expect(cells.length).toBeGreaterThan(0);
    for (const [, cell] of cells) expect(cell.z).toBe('#,##0.00\\ "€"');
  });

  it('hands the writer the same column objects, untouched', () => {
    const chosen = applyColumnSelection(OPTS, ['km', 'name']);
    expect(chosen.columns[0]).toBe(OPTS.columns[3]);
    expect(chosen.columns[1]).toBe(OPTS.columns[0]);
    expect(chosen.rows).toBe(OPTS.rows);
  });
});

function memory(): Storage {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: k => data.get(k) ?? null,
    key: i => [...data.keys()][i] ?? null,
    removeItem: k => { data.delete(k); },
    setItem: (k, v) => { data.set(k, v); },
  };
}

describe('remembered choice', () => {
  it('round-trips per table id', () => {
    const store = memory();
    saveRemembered('cars', { selected: ['b'], known: ['a', 'b'] }, store);
    expect(loadRemembered('cars', store)).toEqual({ selected: ['b'], known: ['a', 'b'] });
    expect(loadRemembered('drivers', store)).toBeNull();
    expect(store.getItem(`${STORAGE_PREFIX}cars`)).not.toBeNull();
  });

  it('reads garbage as no memory', () => {
    const store = memory();
    store.setItem(`${STORAGE_PREFIX}cars`, '{not json');
    expect(loadRemembered('cars', store)).toBeNull();
    store.setItem(`${STORAGE_PREFIX}cars`, JSON.stringify({ selected: [1], known: [] }));
    expect(loadRemembered('cars', store)).toBeNull();
  });

  it('survives storage that throws on read and on write, or is missing', () => {
    const hostile = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    } as unknown as Storage;
    expect(loadRemembered('cars', hostile)).toBeNull();
    expect(() => saveRemembered('cars', { selected: ['a'], known: ['a'] }, hostile)).not.toThrow();
    expect(loadRemembered('cars', null)).toBeNull();
    expect(() => saveRemembered('cars', { selected: ['a'], known: ['a'] }, null)).not.toThrow();
  });
});
