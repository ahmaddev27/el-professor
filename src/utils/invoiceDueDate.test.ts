import { describe, it, expect } from 'vitest'
import { invoiceDueDate } from './invoiceDueDate'

/*
  vitest.config.ts pins TZ=Europe/Berlin, which is the zone the defect needed:
  the old code built local midnight and converted to UTC, losing a day. These
  cases are the ones measured on the branch before the fix, so a regression to
  any Date-based implementation fails here rather than on a customer's invoice.
*/
describe('invoiceDueDate', () => {
  it('keeps the billing day in the invoice month — the summer case that was off by one', () => {
    expect(invoiceDueDate(2026, 9, 1)).toBe('2026-09-01')   // stored 2026-08-31 before
    expect(invoiceDueDate(2026, 7, 1)).toBe('2026-07-01')   // stored 2026-06-30 before
    expect(invoiceDueDate(2026, 9, 15)).toBe('2026-09-15')  // stored 2026-09-14 before
  })

  it('is right in winter too, so the fix is not an offset that happens to cancel', () => {
    expect(invoiceDueDate(2026, 1, 10)).toBe('2026-01-10')  // stored 2026-01-09 before
    expect(invoiceDueDate(2026, 12, 1)).toBe('2026-12-01')
    expect(invoiceDueDate(2027, 1, 1)).toBe('2027-01-01')   // never falls into the previous year
  })

  it('pads the month and the day to two digits, because the column is a date', () => {
    expect(invoiceDueDate(2026, 3, 5)).toBe('2026-03-05')
  })

  it('clamps to the range the CHECK constraint allows', () => {
    expect(invoiceDueDate(2026, 2, 31)).toBe('2026-02-28')  // February needs no special case
    expect(invoiceDueDate(2026, 2, 0)).toBe('2026-02-01')
  })

  it('never depends on the machine zone: the old implementation fails these', () => {
    // The shape that produced the defect, kept as the negative control.
    const old = (y: number, m: number, d: number) =>
      new Date(y, m - 1, Math.min(d, 28)).toISOString().split('T')[0]
    expect(old(2026, 9, 1)).not.toBe(invoiceDueDate(2026, 9, 1))
    expect(invoiceDueDate(2026, 9, 1)).toBe('2026-09-01')
  })
})
