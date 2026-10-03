import { describe, expect, it } from 'vitest';
import { copyForMonth, listMonths, resolveMonth, sumEuro, type MonthlyCostRow } from './fixedCostMonths';

const row = (id: string, description: string, amount: number, period_month: string | null, created_at?: string): MonthlyCostRow =>
  ({ id, description, amount, period_month, created_at });

describe('resolveMonth', () => {
  it("uses the month's own rows when it has any", () => {
    const rows = [row('a', 'Miete', 350, '2026-08-01'), row('b', 'Miete', 400, '2026-09-01')];
    const r = resolveMonth(rows, '2026-09');
    expect(r.source).toBe('own');
    expect(r.total).toBe(400);
  });

  it('inherits from the newest earlier month, not from a later one', () => {
    const rows = [row('a', 'Miete', 350, '2026-07-01'), row('b', 'Miete', 400, '2026-09-01')];
    expect(resolveMonth(rows, '2026-08')).toMatchObject({ source: 'inherited', inheritedFrom: '2026-07', total: 350 });
  });

  it('falls back to the baseline rows only when no earlier month has rows', () => {
    const rows = [row('a', 'Miete', 350, null), row('b', 'Miete', 400, '2026-09-01')];
    expect(resolveMonth(rows, '2026-05')).toMatchObject({ source: 'inherited', inheritedFrom: null, total: 350 });
    expect(resolveMonth(rows, '2026-10')).toMatchObject({ inheritedFrom: '2026-09', total: 400 });
  });

  it('says none when there is nothing to inherit', () => {
    expect(resolveMonth([], '2026-09')).toMatchObject({ source: 'none', total: 0 });
  });

  it('sums in cents', () => {
    expect(sumEuro([{ amount: 0.1 }, { amount: 0.2 }])).toBe(0.3);
  });
});

describe('listMonths', () => {
  const now = new Date(2026, 9, 3);
  it("runs from the baseline rows' creation month to the current month, newest first", () => {
    expect(listMonths([row('a', 'Miete', 1, null, '2026-08-15T10:00:00Z')], now)).toEqual(['2026-10', '2026-09', '2026-08']);
  });
  it('lists only the current month for a company with no rows', () => {
    expect(listMonths([], now)).toEqual(['2026-10']);
  });
  it('keeps a month of its own that lies in the future', () => {
    expect(listMonths([row('a', 'x', 1, '2026-12-01')], now)[0]).toBe('2026-12');
  });
});

describe('copyForMonth', () => {
  const resolved = resolveMonth([row('a', 'Miete', 350, '2026-08-01'), row('b', 'Strom', 80, '2026-08-01')], '2026-09');
  it('copies the inherited rows with the edit applied', () => {
    const copy = copyForMonth(resolved, { replaceId: 'a', replaceWith: { description: 'Miete', amount: 400 } });
    expect(copy).toEqual([{ description: 'Miete', amount: 400 }, { description: 'Strom', amount: 80 }]);
  });
  it('drops a removed row and appends an added one', () => {
    const copy = copyForMonth(resolved, { removeId: 'b', add: { description: 'Gas', amount: 5 } });
    expect(copy).toEqual([{ description: 'Miete', amount: 350 }, { description: 'Gas', amount: 5 }]);
  });
});
