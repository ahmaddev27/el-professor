/**
 * Golden-master tests for the two live German holiday tables.
 *
 * These assert what the code DOES TODAY, not what the law requires. Their job is
 * to make Phase 3 changes visible: when someone converges the holiday tables
 * against §3b EStG, every behavioural difference shows up here as a failing
 * assertion to be reviewed deliberately rather than discovered on a payslip.
 *
 * The app carries two independent holiday implementations:
 *
 *   utils/germanHolidays.ts               getHolidaysForYear(year, bundesland)
 *   historicalWorkingHoursCleanEngine.ts  getGermanNationalHolidays(year)
 *
 * FINDINGS.md H27, H28, M16 and M26 all describe them disagreeing. The
 * divergence tests below record that disagreement as executable fact so it
 * cannot be quietly "fixed" in one table only.
 */
import { describe, it, expect } from 'vitest';
import { getHolidaysForYear, isPublicHoliday, normaliseBundesland } from './germanHolidays';
import { getGermanNationalHolidays } from './historicalWorkingHoursCleanEngine';

const sorted = (s: Set<string>) => [...s].sort();

describe('germanHolidays.getHolidaysForYear — current behaviour', () => {
  it('returns the nationwide set for a year with no Bundesland', () => {
    expect(sorted(getHolidaysForYear(2026))).toMatchInlineSnapshot(`
      [
        "2026-01-01",
        "2026-04-03",
        "2026-04-06",
        "2026-05-01",
        "2026-05-14",
        "2026-05-25",
        "2026-10-03",
        "2026-12-25",
        "2026-12-26",
      ]
    `);
  });

  it('resolves Easter-derived dates for 2026', () => {
    const holidays = getHolidaysForYear(2026);
    // Easter Sunday 2026 is 5 April. Karfreitag and Ostermontag bracket it.
    expect(holidays.has('2026-04-03')).toBe(true);  // Karfreitag
    expect(holidays.has('2026-04-06')).toBe(true);  // Ostermontag
    expect(holidays.has('2026-05-14')).toBe(true);  // Christi Himmelfahrt
    expect(holidays.has('2026-05-25')).toBe(true);  // Pfingstmontag
  });

  it('adds Bundesland-specific days for Bayern', () => {
    const nationwide = getHolidaysForYear(2026);
    const bayern = getHolidaysForYear(2026, 'BY');
    const extra = [...bayern].filter(d => !nationwide.has(d)).sort();
    expect(extra).toMatchInlineSnapshot(`
      [
        "2026-01-06",
        "2026-06-04",
        "2026-08-15",
        "2026-11-01",
      ]
    `);
  });

  it('adds Bundesland-specific days for Baden-Württemberg', () => {
    const nationwide = getHolidaysForYear(2026);
    const bw = getHolidaysForYear(2026, 'BW');
    const extra = [...bw].filter(d => !nationwide.has(d)).sort();
    expect(extra).toMatchInlineSnapshot(`
      [
        "2026-01-06",
        "2026-06-04",
      ]
    `);
  });

  it('normalises Bundesland spellings', () => {
    expect(normaliseBundesland('bw')).toBe('BW');
    expect(normaliseBundesland('Bavaria')).toBe('BY');
    expect(normaliseBundesland(null)).toBe('');
    expect(normaliseBundesland('   ')).toBe('');
  });

  it('isPublicHoliday agrees with the set it derives from', () => {
    expect(isPublicHoliday('2026-01-01')).toBe(true);
    expect(isPublicHoliday('2026-01-02')).toBe(false);
    expect(isPublicHoliday('')).toBe(false);
    expect(isPublicHoliday('not-a-date')).toBe(false);
  });
});

describe('cleanEngine.getGermanNationalHolidays — current behaviour', () => {
  it('returns its own nationwide set for 2026', () => {
    expect(sorted(getGermanNationalHolidays(2026))).toMatchInlineSnapshot(`
      [
        "2026-01-01",
        "2026-04-03",
        "2026-04-05",
        "2026-04-06",
        "2026-05-01",
        "2026-05-14",
        "2026-05-25",
        "2026-10-03",
        "2026-12-25",
        "2026-12-26",
      ]
    `);
  });
});

describe('the two tables disagree — recorded, not endorsed', () => {
  /**
   * If a Phase 3 change makes these two agree, these tests fail. That is the
   * intended signal: update the snapshots deliberately, having checked the
   * result against §3b EStG rather than against the other table.
   */
  for (const year of [2024, 2025, 2026, 2027]) {
    it(`differs in ${year}`, () => {
      const a = getHolidaysForYear(year);            // germanHolidays.ts
      const b = getGermanNationalHolidays(year);     // clean engine

      const onlyInGermanHolidays = [...a].filter(d => !b.has(d)).sort();
      const onlyInCleanEngine = [...b].filter(d => !a.has(d)).sort();

      expect({ onlyInGermanHolidays, onlyInCleanEngine }).toMatchSnapshot();
    });
  }

  it('Buß- und Bettag lands on different dates in the two tables', () => {
    // M16/M26: the Wednesday-before-23-November rule is implemented differently.
    // Record what each produces for a run of years, including 2027 where
    // 23 November itself falls on a Tuesday and 2023 where it is a Thursday.
    const rows = [2023, 2024, 2025, 2026, 2027, 2028].map(year => {
      const a = [...getHolidaysForYear(year, 'SN')].filter(d => d.startsWith(`${year}-11`)).sort();
      const b = [...getGermanNationalHolidays(year)].filter(d => d.startsWith(`${year}-11`)).sort();
      return { year, germanHolidaysSN: a, cleanEngine: b };
    });
    expect(rows).toMatchInlineSnapshot(`
      [
        {
          "cleanEngine": [],
          "germanHolidaysSN": [
            "2023-11-22",
          ],
          "year": 2023,
        },
        {
          "cleanEngine": [],
          "germanHolidaysSN": [
            "2024-11-20",
          ],
          "year": 2024,
        },
        {
          "cleanEngine": [],
          "germanHolidaysSN": [
            "2025-11-19",
          ],
          "year": 2025,
        },
        {
          "cleanEngine": [],
          "germanHolidaysSN": [
            "2026-11-18",
          ],
          "year": 2026,
        },
        {
          "cleanEngine": [],
          "germanHolidaysSN": [
            "2027-11-17",
          ],
          "year": 2027,
        },
        {
          "cleanEngine": [],
          "germanHolidaysSN": [
            "2028-11-22",
          ],
          "year": 2028,
        },
      ]
    `);
  });
});
