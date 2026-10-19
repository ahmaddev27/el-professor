import { describe, expect, it } from 'vitest';
import {
  defaultHandoverCents,
  deriveHandover,
  indexWeeklyHandovers,
  monthlyGivenCents,
  sumGivenCents,
  weeklyGivenCents,
} from './abrechnungHandover';

describe('deriveHandover', () => {
  it('is given when exactly what is due was handed over', () => {
    const s = deriveHandover(5000, 5000);
    expect(s).toMatchObject({ status: 'given', remainingCents: 0, excessCents: 0, recorded: true });
  });

  it("is partial for the owner's example: 50 due, 30 handed over, 20 still with the driver", () => {
    const s = deriveHandover(5000, 3000);
    expect(s).toMatchObject({ status: 'partial', remainingCents: 2000, excessCents: 0, recorded: true });
  });

  it('is open with no record at all, and says nobody confirmed anything', () => {
    const s = deriveHandover(5000, null);
    expect(s).toMatchObject({ status: 'open', remainingCents: 5000, recorded: false, givenCents: 0 });
  });

  it('keeps a recorded 0 apart from no record: both open, only one recorded', () => {
    const zero = deriveHandover(5000, 0);
    const none = deriveHandover(5000, null);
    expect(zero.status).toBe('open');
    expect(none.status).toBe('open');
    expect(zero.recorded).toBe(true);
    expect(none.recorded).toBe(false);
  });

  it('is given with an excess when more than is due was handed over', () => {
    expect(deriveHandover(5000, 5250)).toMatchObject({ status: 'given', excessCents: 250, remainingCents: 0 });
  });

  it('counts a cent short as partial, not given (integer cents, no float tolerance)', () => {
    expect(deriveHandover(5000, 4999)).toMatchObject({ status: 'partial', remainingCents: 1 });
  });

  it('has nothing to hand over when the Difference is zero or negative', () => {
    expect(deriveHandover(0, null).status).toBe('none_due');
    expect(deriveHandover(-1250, null)).toMatchObject({ status: 'none_due', remainingCents: 0 });
    expect(deriveHandover(-1250, 0).status).toBe('none_due');
  });

  it('still reports what was handed over when nothing was due', () => {
    expect(deriveHandover(-1250, 400)).toMatchObject({ status: 'given', excessCents: 400, givenCents: 400 });
  });

  it('offers the whole Difference as the default and never a negative', () => {
    expect(defaultHandoverCents(4147)).toBe(4147);
    expect(defaultHandoverCents(-300)).toBe(0);
    expect(defaultHandoverCents(0)).toBe(0);
  });
});

describe('the weekly index and the monthly sum', () => {
  const records = [
    { year: 2026, month: 5, week_number: 18, driver_name: 'Anna', amount: '30.00' },
    { year: 2026, month: 5, week_number: 19, driver_name: 'Anna', amount: 20 },
    { year: 2026, month: 5, week_number: 19, driver_name: 'Ben', amount: 0 },
    { year: 2026, month: 6, week_number: 23, driver_name: 'Anna', amount: 99 },
  ];

  it('finds a weekly row by the Abrechnung identity, and null for an unrecorded one', () => {
    const index = indexWeeklyHandovers(records);
    expect(weeklyGivenCents(index, { year: 2026, month: 5, week_number: 18, driver_name: 'Anna' })).toBe(3000);
    expect(weeklyGivenCents(index, { year: 2026, month: 5, week_number: 19, driver_name: 'Ben' })).toBe(0);
    expect(weeklyGivenCents(index, { year: 2026, month: 5, week_number: 18, driver_name: 'Ben' })).toBeNull();
  });

  it('sums a driver over the month in cents and ignores other months and drivers', () => {
    expect(monthlyGivenCents(records, 2026, 5, 'Anna')).toBe(5000);
    expect(monthlyGivenCents(records, 2026, 6, 'Anna')).toBe(9900);
  });

  it('is null for a driver without any record, and 0 for one whose only record is 0', () => {
    expect(monthlyGivenCents(records, 2026, 5, 'Carla')).toBeNull();
    expect(monthlyGivenCents(records, 2026, 5, 'Ben')).toBe(0);
  });

  it('derives the monthly status against the monthly Difference exactly as the weekly one', () => {
    const given = monthlyGivenCents(records, 2026, 5, 'Anna');
    expect(deriveHandover(7000, given)).toMatchObject({ status: 'partial', remainingCents: 2000 });
    expect(deriveHandover(5000, given).status).toBe('given');
  });

  it('adds cents without float drift', () => {
    const states = [deriveHandover(1000, 10), deriveHandover(1000, 20)];
    expect(sumGivenCents(states)).toBe(30);
    expect(
      monthlyGivenCents(
        [
          { year: 2026, month: 1, week_number: 1, driver_name: 'X', amount: 0.1 },
          { year: 2026, month: 1, week_number: 2, driver_name: 'X', amount: 0.2 },
        ],
        2026, 1, 'X',
      ),
    ).toBe(30);
  });
});
