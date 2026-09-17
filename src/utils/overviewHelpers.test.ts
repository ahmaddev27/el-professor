import { describe, expect, it } from 'vitest';
import { calcCashSummary, getMonthRange } from './overviewHelpers';
import type { CashMovementRow } from './cashLedger';
import type { Income, Receipt } from '../types/receipt';

/**
 * calcCashSummary's period filter, on the boundary the void rule turns on.
 *
 * The one genuinely new piece of date logic in slice 4.3b is
 * `isWithinInterval(new Date(m.movement_date), { start, end })`: it decides
 * which month a Gehaltsquittung payout lands in, and voiding one books the
 * cash back on the day of the void, so a receipt paid on the 15th and voided
 * on the 4th of the next month lowers one month and raises the other. A filter
 * that was off by a day at either end would move real money between months.
 *
 * **The boundary is timezone-dependent, and only holds east of UTC.**
 * `new Date('2026-03-01')` parses as UTC midnight, while `start` and `end` come
 * from date-fns' local `startOfMonth`/`endOfMonth`. In Europe/Berlin — the zone
 * `vitest.config.ts` pins, and the one the product runs in — that is 01:00 or
 * 02:00 local on the 1st, inside the month. Run west of UTC, the same row would
 * fall into the previous month. These assertions therefore mean what they say
 * only in the product's own zone, exactly like the payroll golden masters.
 */

const MARCH = getMonthRange('2026-03');
const APRIL = getMonthRange('2026-04');

function bargeld(id: string, date: string, amount: number): Income {
  return {
    id,
    description: 'Bargeld',
    amount,
    type: 'bargeld',
    driver_name: 'Ali',
    date,
    created_at: '',
    updated_at: '',
  };
}

function beleg(id: string, date: string, expense: number): Receipt {
  return { id, receiptNumber: id, date, description: 'Tanken', driverName: 'Ali', expense };
}

/** A confirmed Gehaltsquittung, as confirm_salary_cash_payment books it. */
function payout(id: string, movementDate: string, over: Partial<CashMovementRow> = {}): CashMovementRow {
  return {
    id,
    direction: 'out',
    amount: '300.00',
    movement_date: movementDate,
    source_type: 'gehaltsquittung',
    source_id: 'r1',
    description: null,
    ...over,
  };
}

/** One month of till movement that has nothing to do with salaries. */
const MARCH_INCOME = [bargeld('i1', '2026-03-10', 1000)];
const MARCH_RECEIPTS = [beleg('b1', '2026-03-11', 40)];

describe('calcCashSummary', () => {
  it('reproduces the pre-ledger figure when no movement is passed', () => {
    // The default argument is what every period without a Gehaltsquittung gets,
    // which was every period before 4.3b shipped.
    const summary = calcCashSummary(MARCH_INCOME, MARCH_RECEIPTS, MARCH.start, MARCH.end);

    expect(summary.cashIncome).toBe(1000);
    expect(summary.cashFromExpenses).toBe(40);
    expect(summary.salaryPayouts).toBe(0);
    expect(summary.cashOut).toBe(40);
    expect(summary.cashBalance).toBe(960);
  });

  it('counts a payout dated the first day of the month, and neither neighbour', () => {
    const movements = [
      payout('m1', '2026-03-01'),
      payout('m0', '2026-02-28'),
      payout('m2', '2026-04-01'),
    ];

    const summary = calcCashSummary(MARCH_INCOME, MARCH_RECEIPTS, MARCH.start, MARCH.end, movements);

    expect(summary.salaryPayouts).toBe(300);
    expect(summary.cashOut).toBe(340);
    expect(summary.cashBalance).toBe(1000 - 40 - 300);
  });

  it('counts a payout dated the last day of the month', () => {
    // 31.03.2026 is past the DST switch, so this row parses to 02:00 local —
    // still inside March, and the assertion that pins that.
    const movements = [payout('m1', '2026-03-31'), payout('m2', '2026-04-01')];

    const summary = calcCashSummary(MARCH_INCOME, MARCH_RECEIPTS, MARCH.start, MARCH.end, movements);

    expect(summary.salaryPayouts).toBe(300);
    expect(summary.cashBalance).toBe(1000 - 40 - 300);
  });

  it('books a void into the month of the void, not the month of the payment', () => {
    // Paid 15.03., voided 04.04.: March stays lowered and April is raised, the
    // way a cash book corrects an entry rather than rewriting the day it was
    // paid. The two cancel only over a range that holds both.
    const movements = [
      payout('m1', '2026-03-15'),
      payout('m2', '2026-04-04', {
        direction: 'in',
        source_type: 'gehaltsquittung_storno',
      }),
    ];

    const march = calcCashSummary(MARCH_INCOME, MARCH_RECEIPTS, MARCH.start, MARCH.end, movements);
    const april = calcCashSummary(MARCH_INCOME, MARCH_RECEIPTS, APRIL.start, APRIL.end, movements);

    expect(march.salaryPayouts).toBe(300);
    expect(march.cashBalance).toBe(1000 - 40 - 300);

    // April holds no Bargeld and no Beleg of its own, so the cash booked back
    // is the whole balance — and the payout figure is negative, which is what
    // the screens have to render as money coming back into the till.
    expect(april.salaryPayouts).toBe(-300);
    expect(april.cashIncome).toBe(0);
    expect(april.cashOut).toBe(0);
    expect(april.cashBalance).toBe(300);
  });
});
