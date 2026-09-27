/**
 * A receipt belongs to a period when its calendar day lies inside it — both ends
 * inclusive. The comparison must therefore be made on days, not on instants.
 *
 * `ReceiptList` compared instants, and its two range paths built them with
 * different meanings:
 *
 * - a **custom range** parses `YYYY-MM-DD` with `new Date(...)`, which ECMAScript
 *   reads as **UTC** midnight;
 * - a **week or business month** comes from `new Date(year, month, day)` via
 *   `weekCalculations`, which is **local** midnight.
 *
 * A receipt's `date` is a bare `YYYY-MM-DD`, so it too was a UTC midnight — later
 * than a local-midnight end bound in any zone east of UTC. In Berlin that is one
 * or two hours, and it was enough: every receipt dated on the **last day** of the
 * selected week or business month failed `<= end` and disappeared from the list,
 * the total, the Excel export and the summary PDF sent to the Steuerberater.
 *
 * Measured on production on 27.09.2026: of 915 receipts, **93 fall on a Sunday** —
 * a business week's last day — and **31 on a month's last day**. So this one was
 * live, not latent.
 *
 * `vitest.config.ts` pins `TZ=Europe/Berlin`, which is the zone the defect needs,
 * so the negative controls below reproduce it exactly.
 */
import { describe, it, expect } from 'vitest'
import { getBusinessWeeksForMonth, getBusinessMonthRange } from './weekCalculations'

/** The comparison as it is now: calendar days, lexicographic, both ends inclusive. */
function inRangeByDay(receiptDate: string, start: string, end: string): boolean {
  const day = receiptDate.slice(0, 10)
  return day >= start && day <= end
}

/** The comparison that shipped, kept so the defect can be seen rather than described. */
function inRangeAsShipped(receiptDate: string, start: Date, end: Date): boolean {
  const d = new Date(receiptDate)
  return d >= start && d <= end
}

const localKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

describe('a receipt on the last day of a business week', () => {
  // weekCalculations is 0-indexed: month 5 is June. A week belongs to the month
  // containing its Monday.
  const weeks = getBusinessWeeksForMonth(5, 2026)

  it('is included in its week', () => {
    for (const week of weeks) {
      const lastDay = localKey(week.lastDay)
      expect(inRangeByDay(lastDay, localKey(week.firstDay), lastDay)).toBe(true)
    }
  })

  it('is included on the first day too, which never broke', () => {
    for (const week of weeks) {
      const firstDay = localKey(week.firstDay)
      expect(inRangeByDay(firstDay, firstDay, localKey(week.lastDay))).toBe(true)
    }
  })

  it('NEGATIVE CONTROL: the shipped comparison dropped every week’s last day', () => {
    const dropped = weeks.filter(w => !inRangeAsShipped(localKey(w.lastDay), w.firstDay, w.lastDay))
    // Every single week, not just some — the offset is the same all year.
    expect(dropped.length).toBe(weeks.length)
    expect(weeks.length).toBeGreaterThan(0)
  })

  it('leaves a day outside the week outside it', () => {
    const week = weeks[0]
    const dayAfter = new Date(week.lastDay)
    dayAfter.setDate(dayAfter.getDate() + 1)
    expect(inRangeByDay(localKey(dayAfter), localKey(week.firstDay), localKey(week.lastDay))).toBe(false)

    const dayBefore = new Date(week.firstDay)
    dayBefore.setDate(dayBefore.getDate() - 1)
    expect(inRangeByDay(localKey(dayBefore), localKey(week.firstDay), localKey(week.lastDay))).toBe(false)
  })
})

describe('a receipt on the last day of a business month', () => {
  const range = getBusinessMonthRange(5, 2026)

  it('is included', () => {
    expect(inRangeByDay(localKey(range.end), localKey(range.start), localKey(range.end))).toBe(true)
  })

  it('NEGATIVE CONTROL: the shipped comparison dropped it', () => {
    expect(inRangeAsShipped(localKey(range.end), range.start, range.end)).toBe(false)
  })
})

describe('a custom range, which already worked and must not change', () => {
  it('includes both ends', () => {
    expect(inRangeByDay('2026-06-08', '2026-06-08', '2026-06-14')).toBe(true)
    expect(inRangeByDay('2026-06-14', '2026-06-08', '2026-06-14')).toBe(true)
    expect(inRangeByDay('2026-06-07', '2026-06-08', '2026-06-14')).toBe(false)
    expect(inRangeByDay('2026-06-15', '2026-06-08', '2026-06-14')).toBe(false)
  })

  it('agrees with the shipped comparison, because both of its bounds were UTC', () => {
    // This is why the custom path never showed the defect, and why fixing the
    // week path must not disturb it.
    for (const day of ['2026-06-08', '2026-06-11', '2026-06-14']) {
      expect(inRangeAsShipped(day, new Date('2026-06-08'), new Date('2026-06-14'))).toBe(true)
      expect(inRangeByDay(day, '2026-06-08', '2026-06-14')).toBe(true)
    }
  })
})

describe('a receipt date carrying a time, as a timestamp column would', () => {
  it('is compared on its day alone', () => {
    expect(inRangeByDay('2026-06-14T22:30:00Z', '2026-06-08', '2026-06-14')).toBe(true)
  })
})
