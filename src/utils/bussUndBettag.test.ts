/**
 * Buß- und Bettag is the Wednesday **strictly before** 23 November. It therefore
 * always falls between the 16th and the 22nd, is always a Wednesday, and is never
 * the 23rd itself.
 *
 * Both of the product's holiday tables got it wrong, in different ways, and this
 * file pins the date so neither can drift back. Measured over 2020..2035:
 *
 * - `utils/germanHolidays.ts` used the offset `(day + 4) % 7`, which is 0 when 23
 *   November is itself a Wednesday — so it returned 23 November. Wrong in **2022
 *   and 2033**, right in the other fourteen years. The golden snapshot covers
 *   2024..2027, so it never saw either.
 * - `pages/StundennachweisPage.tsx` used `((day + 4) % 7) + 1`, one day past the
 *   Wednesday. Wrong in **all sixteen years** — it landed on a Tuesday every
 *   time, e.g. 17 November 2026 instead of the 18th.
 *
 * **Who this reaches today: nobody.** Measured on both databases on 27.09.2026,
 * `company_settings.state` holds exactly one non-empty value — `Nordrhein-
 * Westfalen`, one company — with 16 empty on production and 23 on staging. Buß-
 * und Bettag is a Sachsen holiday, so no customer's Feiertagszuschlag moves. It
 * becomes live the day a Saxon operator signs up.
 */
import { describe, it, expect } from 'vitest'
import { getHolidaysForYear } from './germanHolidays'

const YEARS = [2020, 2021, 2022, 2023, 2024, 2025, 2026, 2027, 2028, 2029, 2030, 2031, 2032, 2033, 2034, 2035]

/** The definition, computed independently of the implementation under test. */
function wednesdayStrictlyBeforeNov23(year: number): string {
  const nov23 = new Date(Date.UTC(year, 10, 23))
  const back = ((nov23.getUTCDay() - 3) + 7) % 7 || 7
  const d = new Date(nov23.getTime() - back * 86400000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

/** The offset that shipped in germanHolidays.ts, kept so it can be seen to fail. */
function asShippedInUtils(year: number): string {
  const nov23 = new Date(Date.UTC(year, 10, 23))
  const d = new Date(nov23.getTime() - ((nov23.getUTCDay() + 4) % 7) * 86400000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

describe('Buß- und Bettag in getHolidaysForYear', () => {
  it.each(YEARS)('%i falls on the Wednesday strictly before 23 November', year => {
    const expected = wednesdayStrictlyBeforeNov23(year)
    const holidays = getHolidaysForYear(year, 'SN')
    expect(holidays.has(expected)).toBe(true)

    // Always a Wednesday, always the 16th..22nd, never the 23rd.
    const d = new Date(`${expected}T00:00:00Z`)
    expect(d.getUTCDay()).toBe(3)
    expect(d.getUTCDate()).toBeGreaterThanOrEqual(16)
    expect(d.getUTCDate()).toBeLessThanOrEqual(22)
    expect(holidays.has(`${year}-11-23`)).toBe(false)
  })

  it('NEGATIVE CONTROL: the shipped offset returned 23 November in 2022 and 2033', () => {
    expect(asShippedInUtils(2022)).toBe('2022-11-23')
    expect(asShippedInUtils(2033)).toBe('2033-11-23')
    expect(wednesdayStrictlyBeforeNov23(2022)).toBe('2022-11-16')
    expect(wednesdayStrictlyBeforeNov23(2033)).toBe('2033-11-16')
    // 23 November was a Wednesday in exactly those two years of the sixteen.
    const wednesdayOn23rd = YEARS.filter(y => new Date(Date.UTC(y, 10, 23)).getUTCDay() === 3)
    expect(wednesdayOn23rd).toEqual([2022, 2033])
  })

  it('agreed with the shipped offset in the other fourteen years, so nothing else moves', () => {
    for (const year of YEARS.filter(y => y !== 2022 && y !== 2033)) {
      expect(asShippedInUtils(year)).toBe(wednesdayStrictlyBeforeNov23(year))
    }
  })

  it('is not added for a Bundesland that does not have it', () => {
    // Only the SN/TH branch adds it. NRW — the one non-empty state any customer
    // has — must not see it.
    const nrw = getHolidaysForYear(2026, 'NW')
    expect(nrw.has(wednesdayStrictlyBeforeNov23(2026))).toBe(false)
  })
})
