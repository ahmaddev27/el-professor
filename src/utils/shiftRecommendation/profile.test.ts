import { describe, expect, it } from 'vitest';
import { buildDemandProfile } from './profile';
import { hourlyGrid } from './hourly';
import { DEFAULT_PROFILE_SETTINGS } from './settings';
import type { AnalysisTrip } from '../tripAnalysis/types';
import type { DemandProfile, ProfileSettings } from './types';

const AUGUST = [{ year: 2026, month: 8 }];

/** Local wall-clock times, read in the zone vitest pins (Europe/Berlin). */
function ride(id: string, vehicle: string | null, start: string | null, end: string | null, extra: Partial<AnalysisTrip> = {}): AnalysisTrip {
  return {
    id,
    driver_id: 'd1',
    driver_name: 'Fahrer',
    vehicle,
    start_ms: start === null ? null : new Date(start).getTime(),
    end_ms: end === null ? null : new Date(end).getTime(),
    status: 'completed',
    price: '20.00',
    currency: 'EUR',
    source_row: null,
    ...extra,
  };
}

function profileOf(trips: AnalysisTrip[], settings: Partial<ProfileSettings> = {}, holidays: string[] = []): DemandProfile {
  return buildDemandProfile({
    trips,
    historyMonths: AUGUST,
    holidays: new Set(holidays),
    settings: { ...DEFAULT_PROFILE_SETTINGS, minEvidenceDays: 1, ...settings },
  });
}

/** The cell of a weekday (Mon 0 … Sun 6) and a local time, under the default 04:00 day start and 15-minute slots. */
function cellAt(profile: DemandProfile, dayType: number, time: string) {
  const [h, m] = time.split(':').map(Number);
  const minute = (h * 60 + m - 240 + 1440) % 1440;
  return profile.cells[dayType * profile.positions + Math.floor(minute / profile.settings.slotMinutes)];
}

describe('buildDemandProfile — what it learns from', () => {
  it('counts every row it cannot use under its first reason, and keeps the money it could not place apart', () => {
    const profile = profileOf([
      ride('ok', 'A', '2026-08-03T10:00', '2026-08-03T10:30'),
      ride('cancel', 'A', null, null, { status: 'cancelled', price: '5.00' }),
      ride('unknown', 'A', '2026-08-03T11:00', '2026-08-03T11:20', { status: 'unknown', price: '7.00' }),
      ride('novehicle', null, '2026-08-03T12:00', '2026-08-03T12:20', { price: '9.00' }),
      ride('nostart', 'A', null, '2026-08-03T12:20'),
      ride('noend', 'A', '2026-08-03T12:00', null),
      ride('backwards', 'A', '2026-08-03T13:00', '2026-08-03T12:00'),
      ride('instant', 'A', '2026-08-03T13:30', '2026-08-03T13:30'),
      ride('decades', 'A', '2026-08-03T13:40', '2099-08-03T13:50'),
      ride('dst', 'A', '2026-08-03T14:00', '2026-08-03T14:20', { time_ambiguity: 'dst_ambiguous' }),
      ride('noprice', 'A', '2026-08-03T15:00', '2026-08-03T15:20', { price: null }),
    ]);
    expect(profile.status).toBe('ok');
    expect(profile.coverage).toEqual({
      rows: 11,
      usedRides: 1,
      excluded: {
        cancelled: 1,
        status_unknown: 1,
        missing_vehicle: 1,
        missing_start: 1,
        missing_end: 1,
        end_before_start: 1,
        implausible_duration: 2,
        ambiguous_local_time: 1,
        unpriced: 1,
      },
      usedRevenueCents: 2000,
      // unknown 7,00 + no vehicle 9,00 + no start/no end/backwards/instant/decades/dst at 20,00 each
      unplacedRevenueCents: 700 + 900 + 6 * 2000,
      cancelledRevenueCents: 500,
    });
  });

  it('learns nothing from a ride of no length or of more than twelve hours, and walks no slot of it', () => {
    const profile = profileOf([
      ride('ok', 'A', '2026-08-03T10:00', '2026-08-03T10:30'),
      ride('twelve', 'B', '2026-08-03T06:00', '2026-08-03T18:00'),
      ride('typo', 'C', '2026-08-03T11:00', '2099-08-03T11:20'),
    ]);
    expect(profile.coverage.excluded.implausible_duration).toBe(1);
    expect(profile.vehicles.map(v => v.vehicle)).toEqual(['A', 'B']);
    // B's twelve hours count: exactly the limit is still a ride.
    expect(profile.perMonth.vehicleMinutes).toBe(30 + 720);
  });

  it('answers no_history rather than an empty profile when nothing is usable', () => {
    const profile = profileOf([ride('c', 'A', null, null, { status: 'cancelled' })]);
    expect(profile.status).toBe('no_history');
    expect(profile.cells).toEqual([]);
  });

  it('refuses settings it cannot read, and computes nothing from them', () => {
    const profile = profileOf([ride('ok', 'A', '2026-08-03T10:00', '2026-08-03T10:30')], { slotMinutes: 20 });
    expect(profile.status).toBe('invalid_settings');
    expect(profile.problems).toEqual(['slot_minutes_unsupported']);
    expect(profile.cells).toEqual([]);
  });
});

describe('buildDemandProfile — time on the road and revenue', () => {
  it('chains rides at most the gap apart into one period and counts the wait as time on the road', () => {
    // Monday 03.08.2026: 10:00–10:15 and 10:45–11:00, a 30-minute wait, exactly the gap.
    const profile = profileOf([
      ride('a', 'A', '2026-08-03T10:00', '2026-08-03T10:15', { price: '30.00' }),
      ride('b', 'A', '2026-08-03T10:45', '2026-08-03T11:00', { price: '30.00' }),
    ]);
    expect(profile.perMonth.vehicleMinutes).toBe(60);
    expect(profile.perMonth.revenueCents).toBe(6000);
    expect(profile.perMonth.revenuePerHourCents).toBe(6000);
    // The 10:30 slot is waiting time: on the road, no revenue.
    expect(cellAt(profile, 0, '10:30')).toMatchObject({ vehicleMinutes: 15, revenueCents: 0, revenuePerHourCents: 0 });
  });

  it('opens a new period after a gap longer than the setting, so the wait is not paid for', () => {
    const profile = profileOf([
      ride('a', 'A', '2026-08-03T10:00', '2026-08-03T10:20'),
      ride('b', 'A', '2026-08-03T11:00', '2026-08-03T11:20'),
    ]);
    expect(profile.perMonth.vehicleMinutes).toBe(40);
    expect(cellAt(profile, 0, '10:30').vehicleMinutes).toBe(0);
  });

  it('spreads a ride’s revenue over the slots it covers, in proportion', () => {
    const profile = profileOf([ride('a', 'A', '2026-08-03T10:00', '2026-08-03T10:30', { price: '30.00' })]);
    expect(cellAt(profile, 0, '10:00').revenueCents).toBe(1500);
    expect(cellAt(profile, 0, '10:15').revenueCents).toBe(1500);
    expect(cellAt(profile, 0, '10:00').revenuePerHourCents).toBe(6000);
  });

  it('puts a night after midnight on the operating day it started, and a holiday on Sunday', () => {
    // Saturday 08.08.2026 01:00 belongs to Friday (dayType 4) under a 04:00 day start.
    const night = profileOf([ride('n', 'A', '2026-08-08T01:00', '2026-08-08T01:15')]);
    expect(cellAt(night, 4, '01:00').vehicleMinutes).toBe(15);
    expect(cellAt(night, 5, '01:00').vehicleMinutes).toBe(0);

    // Monday 03.08.2026 declared a holiday reads as a Sunday.
    const holiday = profileOf([ride('h', 'A', '2026-08-03T10:00', '2026-08-03T10:15')], {}, ['2026-08-03']);
    expect(cellAt(holiday, 6, '10:00').vehicleMinutes).toBe(15);
    expect(cellAt(holiday, 0, '10:00').vehicleMinutes).toBe(0);
  });

  it('withholds a rate seen on too few days, while keeping the figures it rests on', () => {
    const profile = profileOf(
      [
        ride('a', 'A', '2026-08-03T10:00', '2026-08-03T10:15'),
        ride('b', 'A', '2026-08-10T10:00', '2026-08-10T10:15'),
        ride('c', 'A', '2026-08-04T10:00', '2026-08-04T10:15'),
      ],
      { minEvidenceDays: 2 },
    );
    expect(cellAt(profile, 0, '10:00')).toMatchObject({ activeDays: 2, revenuePerHourCents: 8000 });
    expect(cellAt(profile, 1, '10:00')).toMatchObject({ activeDays: 1, vehicleMinutes: 15, revenuePerHourCents: null });
  });

  it('records the most vehicles ever out at once in a slot', () => {
    const profile = profileOf([
      ride('a', 'A', '2026-08-03T10:00', '2026-08-03T10:15'),
      ride('b', 'B', '2026-08-03T10:05', '2026-08-03T10:15'),
      ride('c', 'A', '2026-08-10T10:00', '2026-08-10T10:15'),
    ]);
    expect(cellAt(profile, 0, '10:00').maxVehicles).toBe(2);
    expect(profile.vehicles.map(v => v.vehicle)).toEqual(['A', 'B']);
  });

  it('cuts slots in absolute time on the night the clocks go back, and names both 02:00 hours alike', () => {
    // 25.10.2026: 02:00–02:15 happens at +02:00 and again at +01:00. Saturday's operating day.
    const profile = profileOf([
      ride('first', 'A', '2026-10-25T02:00:00+02:00', '2026-10-25T02:15:00+02:00'),
      ride('second', 'B', '2026-10-25T02:00:00+01:00', '2026-10-25T02:15:00+01:00'),
    ]);
    const cell = cellAt(profile, 5, '02:00');
    expect(cell.vehicleMinutes).toBe(30);
    expect(cell.activeDays).toBe(1);
    expect(cell.maxVehicles).toBe(1);
  });

  it('pools the slots into hours for the grid, and shows nothing where no slot carries a rate', () => {
    const profile = profileOf([ride('a', 'A', '2026-08-03T10:00', '2026-08-03T10:30', { price: '30.00' })]);
    const grid = hourlyGrid(profile);
    expect(grid).toHaveLength(7 * 24);
    // Hour 6 of the operating day is 10:00; two slots of 15 minutes earn 30,00 €.
    expect(grid[6]).toMatchObject({ dayType: 0, hourIndex: 6, clockHour: 10, revenuePerHourCents: 6000, vehicleMinutes: 30 });
    expect(grid[7]).toMatchObject({ clockHour: 11, revenuePerHourCents: null });
    expect(hourlyGrid({ ...profile, status: 'no_history' })).toEqual([]);
  });

  it('is deterministic and does not mutate its input', () => {
    const trips = [
      ride('a', 'A', '2026-08-03T10:00', '2026-08-03T10:20'),
      ride('b', 'B', '2026-08-07T22:00', '2026-08-08T00:40', { price: '55.10' }),
    ];
    const frozen = JSON.stringify(trips);
    expect(profileOf(trips)).toEqual(profileOf(trips));
    expect(JSON.stringify(trips)).toBe(frozen);
  });
});
