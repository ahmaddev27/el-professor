import { describe, expect, it } from 'vitest';
import { sortRows, type SortValue } from './sortRows';

type Row = { id: string; value: SortValue };

const ids = (rows: Row[]) => rows.map(row => row.id);
const byValue = (row: Row) => row.value;

describe('sortRows', () => {
  it('orders German text with umlauts next to their base letter', () => {
    const rows: Row[] = [
      { id: 'b', value: 'Bäcker' },
      { id: 'o', value: 'Özdemir' },
      { id: 'a', value: 'Albrecht' },
      { id: 'z', value: 'Zimmer' },
      { id: 'o2', value: 'Ostermann' },
    ];
    expect(ids(sortRows(rows, byValue, 'asc'))).toEqual(['a', 'b', 'o2', 'o', 'z']);
  });

  it('orders plates with numbers numerically', () => {
    const rows: Row[] = [
      { id: '10', value: 'B-EP 10' },
      { id: '9', value: 'B-EP 9' },
      { id: '100', value: 'B-EP 100' },
    ];
    expect(ids(sortRows(rows, byValue, 'asc'))).toEqual(['9', '10', '100']);
  });

  it('sorts numbers in both directions', () => {
    const rows: Row[] = [
      { id: 'mid', value: 41.47 },
      { id: 'low', value: -3 },
      { id: 'high', value: 18342.25 },
    ];
    expect(ids(sortRows(rows, byValue, 'asc'))).toEqual(['low', 'mid', 'high']);
    expect(ids(sortRows(rows, byValue, 'desc'))).toEqual(['high', 'mid', 'low']);
  });

  it('keeps empty values last whichever way the column is sorted', () => {
    const rows: Row[] = [
      { id: 'none', value: null },
      { id: 'late', value: '2026-11-02' },
      { id: 'blank', value: '' },
      { id: 'early', value: '2026-03-15' },
    ];
    expect(ids(sortRows(rows, byValue, 'asc'))).toEqual(['early', 'late', 'none', 'blank']);
    expect(ids(sortRows(rows, byValue, 'desc'))).toEqual(['late', 'early', 'none', 'blank']);
  });

  it('is stable for equal values and does not mutate its input', () => {
    const rows: Row[] = [
      { id: 'first', value: 'Taxi' },
      { id: 'second', value: 'taxi' },
      { id: 'third', value: 'Mietwagen' },
    ];
    const snapshot = ids(rows);
    expect(ids(sortRows(rows, byValue, 'desc'))).toEqual(['first', 'second', 'third']);
    expect(ids(rows)).toEqual(snapshot);
  });
});
