import { describe, expect, it } from 'vitest';
import {
  groupIncome,
  driversOfMonth,
  driversOfWeek,
  flattenDays,
  flattenWeeks,
  isWeekLevelRow,
  sumTotals,
  weekEndOf,
  type GroupableIncome,
  type IncomeTotals,
} from './incomeGrouping';

let n = 0;
const row = (over: Partial<GroupableIncome> & Pick<GroupableIncome, 'date' | 'driver_name'>): GroupableIncome => ({
  id: `r${++n}`, type: 'umsatz', amount: 10, ...over,
});
const uber = (start: string, end: string, over: Partial<GroupableIncome> & Pick<GroupableIncome, 'date' | 'driver_name'>) =>
  row({ source: 'uber', source_period_start: start, source_period_end: end, ...over });

const ROWS: GroupableIncome[] = [
  // Weekly import of the week of Monday 05.10.2026 (no day of its own).
  uber('2026-10-05', '2026-10-11', { date: '2026-10-05', driver_name: 'Ahmed', amount: 664.19 }),
  uber('2026-10-05', '2026-10-11', { date: '2026-10-05', driver_name: 'Ahmed', type: 'trinkgeld', amount: 28 }),
  // Daily imports in the week of Monday 12.10.
  uber('2026-10-12', '2026-10-12', { date: '2026-10-12', driver_name: 'Ahmed', amount: 100.1 }),
  uber('2026-10-12', '2026-10-12', { date: '2026-10-12', driver_name: 'Bilal', amount: 50.2 }),
  uber('2026-10-13', '2026-10-13', { date: '2026-10-13', driver_name: 'Ahmed', type: 'aktionen', amount: 7.7 }),
  // Typed by hand, same day and driver as an import.
  row({ date: '2026-10-13', driver_name: 'Ahmed', type: 'bargeld', amount: 0.3 }),
  // 01.10.2026 is a Thursday in the week of Monday 28.09.: September's week.
  row({ date: '2026-10-01', driver_name: 'Bilal', amount: 20 }),
  row({ date: '2026-09-29', driver_name: 'Bilal', amount: 0.1 }),
];

const keys = (t: IncomeTotals) => [t.umsatzCents, t.aktionenCents, t.trinkgeldCents, t.bargeldCents, t.sumCents, t.rowCount];

describe('groupIncome: structure', () => {
  const months = groupIncome(ROWS);

  it('orders months, weeks and days newest first', () => {
    expect(months.map(m => [m.year, m.month])).toEqual([[2026, 10], [2026, 9]]);
    expect(months[0]!.weeks.map(w => w.monday)).toEqual(['2026-10-12', '2026-10-05']);
    expect(months[0]!.weeks[0]!.days.map(d => d.date)).toEqual(['2026-10-13', '2026-10-12']);
  });

  it('a week belongs to the month of its Monday, not the calendar month of its rows', () => {
    const september = months[1]!;
    expect(september.weeks.map(w => w.monday)).toEqual(['2026-09-28']);
    const dates = september.weeks[0]!.days.map(d => d.date);
    expect(dates).toEqual(['2026-10-01', '2026-09-29']);
  });

  it('carries the books\' Woche N of the Monday', () => {
    expect(months[0]!.weeks.map(w => w.weekNumber)).toEqual([2, 1]);
    expect(months[1]!.weeks[0]!.weekNumber).toBe(4);
  });

  it('a weekly-sourced row sits at its week in a day-less bucket, not spread over days', () => {
    const week = months[0]!.weeks[1]!;
    expect(week.days).toHaveLength(1);
    expect(week.days[0]!.date).toBeNull();
    expect(week.days[0]!.drivers[0]!.rows).toHaveLength(2);
    expect(keys(week.totals)).toEqual([66419, 0, 2800, 0, 66419, 2]);
  });

  it('a one-day import and a typed row have their date as their day, and group by driver', () => {
    const day = months[0]!.weeks[0]!.days.find(d => d.date === '2026-10-13')!;
    expect(day.drivers.map(d => d.driverName)).toEqual(['Ahmed']);
    expect(keys(day.totals)).toEqual([0, 770, 0, 30, 770, 2]);
    const twelfth = months[0]!.weeks[0]!.days.find(d => d.date === '2026-10-12')!;
    expect(twelfth.drivers.map(d => d.driverName)).toEqual(['Ahmed', 'Bilal']);
  });

  it('puts the whole-week bucket after the days of the same week', () => {
    const mixed = groupIncome([
      uber('2026-10-05', '2026-10-11', { date: '2026-10-05', driver_name: 'A', amount: 5 }),
      row({ date: '2026-10-07', driver_name: 'A', amount: 1 }),
    ]);
    expect(mixed[0]!.weeks[0]!.days.map(d => d.date)).toEqual(['2026-10-07', null]);
  });

  it('knows what a week-level row is', () => {
    expect(isWeekLevelRow(ROWS[0]!)).toBe(true);
    expect(isWeekLevelRow(ROWS[2]!)).toBe(false);
    expect(isWeekLevelRow(ROWS[5]!)).toBe(false);
    // A typed row is never week-level, whatever its date.
    expect(isWeekLevelRow(row({ date: '2026-10-05', driver_name: 'A', source_period_start: '2026-10-05', source_period_end: '2026-10-11' }))).toBe(false);
  });

  it('is empty for no rows', () => {
    expect(groupIncome([])).toEqual([]);
  });
});

describe('groupIncome: totals agree at every level', () => {
  const months = groupIncome(ROWS);

  it('a month is the sum of its weeks, a week of its days, a day of its drivers, a driver of its rows', () => {
    for (const m of months) {
      expect(keys(m.totals), `month ${m.year}-${m.month}`).toEqual(keys(sumTotals(m.weeks.map(w => w.totals))));
      for (const w of m.weeks) {
        expect(keys(w.totals), `week ${w.monday}`).toEqual(keys(sumTotals(w.days.map(d => d.totals))));
        for (const d of w.days) {
          expect(keys(d.totals), `day ${d.date}`).toEqual(keys(sumTotals(d.drivers.map(x => x.totals))));
          for (const x of d.drivers) {
            const cents = x.rows.reduce((s, r) => s + Math.round(Number(r.amount) * 100), 0);
            const all = x.totals.umsatzCents + x.totals.aktionenCents + x.totals.trinkgeldCents + x.totals.bargeldCents;
            expect(all, `driver ${x.driverName} on ${d.date}`).toBe(cents);
            expect(x.totals.rowCount).toBe(x.rows.length);
          }
        }
      }
    }
  });

  it('the grand total equals the rows summed directly, in cents, and loses no row', () => {
    const grand = sumTotals(months.map(m => m.totals));
    const direct = ROWS.reduce((s, r) => s + Math.round(Number(r.amount) * 100), 0);
    expect(grand.umsatzCents + grand.aktionenCents + grand.trinkgeldCents + grand.bargeldCents).toBe(direct);
    expect(grand.rowCount).toBe(ROWS.length);
  });

  it('sums in cents: 0,1 + 0,2 style float drift cannot appear', () => {
    const [m] = groupIncome([
      row({ date: '2026-10-07', driver_name: 'A', amount: 0.1 }),
      row({ date: '2026-10-07', driver_name: 'B', amount: 0.2 }),
    ]);
    expect(m!.totals.umsatzCents).toBe(30);
  });

  it('Summe is Netto-Fahrpreis plus Aktionen only', () => {
    const grand = sumTotals(months.map(m => m.totals));
    expect(grand.sumCents).toBe(grand.umsatzCents + grand.aktionenCents);
  });

  it('refuses an amount it cannot read instead of counting it as zero', () => {
    expect(() => groupIncome([row({ date: '2026-10-07', driver_name: 'A', amount: Number.NaN })])).toThrow(RangeError);
  });
});

describe('views over the grouping', () => {
  const months = groupIncome(ROWS);

  it('weekEndOf is the Sunday of the week', () => {
    expect(weekEndOf('2026-10-12')).toBe('2026-10-18');
    expect(weekEndOf('2026-12-28')).toBe('2027-01-03');
  });

  it('flattenDays lists every day once, newest first, with its week', () => {
    const entries = flattenDays(months);
    expect(entries.map(e => e.day.date)).toEqual(['2026-10-13', '2026-10-12', null, '2026-10-01', '2026-09-29']);
    expect(entries.map(e => e.week.monday)).toEqual(['2026-10-12', '2026-10-12', '2026-10-05', '2026-09-28', '2026-09-28']);
  });

  it('flattenWeeks keeps the weeks of every month', () => {
    expect(flattenWeeks(months).map(w => w.monday)).toEqual(['2026-10-12', '2026-10-05', '2026-09-28']);
  });

  it('a week and a month add their drivers to the level above, to the cent', () => {
    for (const month of months) {
      const drivers = driversOfMonth(month);
      expect(keys(sumTotals(drivers.map(d => d.totals)))).toEqual(keys(month.totals));
      for (const week of month.weeks) {
        expect(keys(sumTotals(driversOfWeek(week).map(d => d.totals)))).toEqual(keys(week.totals));
      }
    }
    expect(driversOfMonth(months[0]!).map(d => d.driverName)).toEqual(['Ahmed', 'Bilal']);
  });
});
