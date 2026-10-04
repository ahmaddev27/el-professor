import { describe, expect, it } from 'vitest';
import { copyForMonth, listMonths, planCostEdit, resolveMonth, sumEuro, type MonthlyCostRow } from './fixedCostMonths';

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

describe('planCostEdit', () => {
  const r = (id: string, d: string, a: number, m: string | null) => row(id, d, a, m);
  const rent = (a: number) => ({ description: 'Miete', amount: a });

  it('this_month on an inherited month copies it and pins the next month to the old rows', () => {
    const rows = [r('a', 'Miete', 350, '2026-07-01'), r('b', 'Strom', 80, '2026-07-01')];
    const plan = planCostEdit(rows, '2026-09', 'a', rent(400), 'this_month');
    expect(plan.inserts).toEqual([
      { month: '2026-10', copies: [{ description: 'Miete', amount: 350 }, { description: 'Strom', amount: 80 }] },
      { month: '2026-09', copies: [{ description: 'Miete', amount: 400 }, { description: 'Strom', amount: 80 }] },
    ]);
    expect(plan.updates).toEqual([]);
  });

  it('this_month on an own month updates in place and pins the next month', () => {
    const rows = [r('a', 'Miete', 350, '2026-09-01')];
    const plan = planCostEdit(rows, '2026-09', 'a', rent(400), 'this_month');
    expect(plan.updates).toEqual([{ id: 'a', change: rent(400) }]);
    expect(plan.inserts).toEqual([{ month: '2026-10', copies: [{ description: 'Miete', amount: 350 }] }]);
  });

  it('this_month pins nothing when the next month has its own rows', () => {
    const rows = [r('a', 'Miete', 350, '2026-09-01'), r('b', 'Miete', 360, '2026-10-01')];
    expect(planCostEdit(rows, '2026-09', 'a', rent(400), 'this_month').inserts).toEqual([]);
  });

  it('this_and_later pins nothing and changes later months of their own that hold the row', () => {
    const rows = [
      r('a', 'Miete', 350, '2026-07-01'), r('s', 'Strom', 80, '2026-07-01'),
      r('c', 'Miete', 360, '2026-11-01'), r('d', 'Strom', 90, '2026-11-01'),
      r('e', 'Versicherung', 50, '2026-12-01'),
    ];
    const plan = planCostEdit(rows, '2026-09', 'a', rent(400), 'this_and_later');
    expect(plan.inserts).toEqual([{ month: '2026-09', copies: [{ description: 'Miete', amount: 400 }, { description: 'Strom', amount: 80 }] }]);
    expect(plan.updates).toEqual([{ id: 'c', change: rent(400) }]);
    expect(plan.laterMonthsChanged).toEqual(['2026-11']);
  });

  it('never touches an earlier month', () => {
    const rows = [r('a', 'Miete', 350, '2026-07-01'), r('b', 'Miete', 355, '2026-08-01'), r('c', 'Miete', 360, '2026-09-01')];
    const plan = planCostEdit(rows, '2026-09', 'c', rent(400), 'this_and_later');
    expect(plan.updates.map(u => u.id)).toEqual(['c']);
  });

  it('works from baseline rows and returns an empty plan for an unknown row', () => {
    const rows = [r('a', 'Miete', 350, null)];
    expect(planCostEdit(rows, '2026-09', 'a', rent(400), 'this_and_later').inserts[0].month).toBe('2026-09');
    expect(planCostEdit(rows, '2026-09', 'zzz', rent(400), 'this_month')).toEqual({ inserts: [], updates: [], laterMonthsChanged: [] });
  });
});
