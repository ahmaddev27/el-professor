import { describe, expect, it } from 'vitest';
import { calcPeriodMetrics } from './overviewHelpers';
import { calcSalaryFromIncome, salaryBase, sumIncomeAmount } from './salaryDue';
import { buildIncomeSheets } from './listExportSheets';
import { buildImportRows } from './uberEarningsImport';
import type { Income } from '../types/receipt';

/**
 * Negative Uber figures are stored (20261016170000). Three claims, each pinned by
 * its own describe so one broken term fails one block and not all of them:
 *
 *   A  a negative fare, promotion or tip becomes a row, with its sign (cash does not)
 *   B  every total follows the stored row: revenue, the Overview, the exports
 *   C  the salary floors at zero and the shortfall is reported
 *
 * ── The payroll rule these preserve ─────────────────────────────────────────
 * Before: salary = (Umsatz + Aktionen) x salary_ratio + Trinkgeld x 100 %, over
 * the income rows that EXISTED; a negative figure never became a row, so the
 * revenue and the salary were overstated by what Uber took back.
 * After: the same formula over the rows that now exist, floored at zero as a
 * whole, with the amount that could not be taken off reported beside it. For a
 * period with no negative row the result is byte-identical to before.
 */

const income = (type: string, amount: number, driver = 'Anna', date = '2026-10-07'): Income =>
  ({ id: `${type}${amount}`, type, amount, driver_name: driver, date, description: '', week: 2 }) as unknown as Income;

describe('A. a negative fare, promotion or tip is stored as a row', () => {
  const week = (over: Record<string, string>) => ({
    segment: { from: '2026-10-05', to: '2026-10-11', monday: '2026-10-05' },
    drivers: [{
      externalDriverId: '7', uberDriverUuid: null, name: 'Anna',
      fareCents: 1000, promotionCents: 0, tipsCents: 0, cashCents: 0,
      netOutstandingCents: 0, trips: 3, differenceCents: 0,
      ...Object.fromEntries(Object.entries(over).map(([k, v]) => [k, Number(v)])),
    }],
  });

  it('writes the three payroll types with their sign', () => {
    const rows = buildImportRows([week({ promotionCents: '-4500', tipsCents: '-250' }) as never]);
    expect(rows.map(r => [r.type, r.amount])).toEqual([['umsatz', '10.00'], ['aktionen', '-45.00'], ['trinkgeld', '-2.50']]);
  });

  it('still writes no row for a negative cash figure: it would move the till', () => {
    const rows = buildImportRows([week({ cashCents: '-2000' }) as never]);
    expect(rows.map(r => r.type)).toEqual(['umsatz']);
  });
});

describe('B. every total follows the stored row', () => {
  const rows = [income('umsatz', 100), income('aktionen', -45), income('trinkgeld', -5)];

  it('the period revenue falls by the clawback', () => {
    expect(sumIncomeAmount(rows, ['umsatz', 'aktionen'])).toBe(55);
    expect(sumIncomeAmount(rows, ['trinkgeld'])).toBe(-5);
  });

  it('the Overview counts it: revenue, tips and the total', () => {
    const m = calcPeriodMetrics(rows, [], [], [], new Date('2026-10-01'), new Date('2026-10-31'));
    expect([m.umsatz, m.aktionen, m.trinkgeld, m.totalIncome]).toEqual([55, -45, -5, 50]);
  });

  it('the Einnahmen export totals include it, and so does the per-type sheet', () => {
    const [entries, byType] = buildIncomeSheets(rows);
    expect(entries.totals).toEqual({ amount: 50 });
    expect(byType.rows.find(r => r.type === 'Aktionen')?.amount).toBe(-45);
  });
});

describe('C. the salary floors at zero and the remainder is reported', () => {
  it('a period that clears the clawback pays the formula unchanged and reports nothing', () => {
    const r = calcSalaryFromIncome({ revenue: 55, tips: -5, salaryRatio: 0.5 });
    expect(r.amountDue).toBe(22.5);
    expect(r.unrecovered).toBe(0);
  });

  it('a period whose clawbacks exceed its earnings pays 0,00 and reports what could not be taken off', () => {
    // revenue -90 at 45 % = -40,50; tips -4,50: 45,00 beyond what was earned.
    const r = calcSalaryFromIncome({ revenue: -90, tips: -4.5, salaryRatio: 0.45 });
    expect(r.amountDue).toBe(0);
    expect(r.unrecovered).toBe(45);
  });

  it('a revenue clawback is netted against the same driver\'s tips before the floor', () => {
    const r = calcSalaryFromIncome({ revenue: -20, tips: 30, salaryRatio: 0.5 });
    expect(r.amountDue).toBe(20);
    expect(r.unrecovered).toBe(0);
  });

  it('float noise at the boundary is not a shortfall', () => {
    // 0,3 - (0,1 + 0,2) is -5.6e-17 in binary floats: nothing is unrecovered.
    const r = calcSalaryFromIncome({ revenue: 0, tips: 0.3 - (0.1 + 0.2), salaryRatio: 0.5 });
    expect(r.amountDue).toBe(0);
    expect(r.unrecovered).toBe(0);
  });

  it('the remainder is rounded to whole cents', () => {
    expect(calcSalaryFromIncome({ revenue: -100.01, tips: 0, salaryRatio: 0.45 }).unrecovered).toBe(45.0);
    expect(calcSalaryFromIncome({ revenue: -33.33, tips: 0, salaryRatio: 0.45 }).unrecovered).toBe(15);
  });

  it('a manual netto adjustment still wins over the floored calculation', () => {
    expect(salaryBase({ netto_salary: 120, amount_due: 0 })).toBe(120);
    expect(salaryBase({ netto_salary: null, amount_due: 0 })).toBe(0);
  });
});
