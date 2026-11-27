import { describe, expect, it } from 'vitest';
import type { StructuredNote } from '../monatsplanungPhase3';
import {
  checkDriverShifts,
  generateFullMonth,
  validateFullMonth,
  type FullMonthDriver,
  type FullMonthInput,
  type FullMonthResult,
} from './fullMonth';
import { MAX_DAY_MINUTES } from './driverMonthPlan';
import { verifyMonth } from './monthVerification';
import { readUnavailability, type VehicleUnavailabilityRow } from './vehicleAvailability';
import type { GeoPoint, PoolAddress, SimRide, SimShift } from './types';
import { noRealTrips } from './realTrips';

/**
 * Round 8, slice S4: the calendar month is led by the drivers. Each driver's
 * days, window and minutes come from his Drivers page (`planDriverMonth`); a
 * shift is placed for a planned driver-day on a vehicle that is free, has a
 * valid TÜV and is outside its `vehicle_unavailability` windows. §12's classes
 * 5 (maintenance), 9 (midnight), 10 (month lengths) and 21 (overlaps) are here,
 * with the negative scenarios whose correct answer is a refusal, a finding or
 * an incomplete verdict, never a successful-looking report.
 *
 * Everything below is invented: public repository, no real person, plate or address.
 */

const ZONE = 'Europe/Berlin';
const BASE: GeoPoint = { lat: 51.1657, lon: 7.0671 };
const POOL: PoolAddress[] = Array.from({ length: 40 }, (_, i) => ({
  label: `Teststraße ${i + 1}, 42651 Solingen, Deutschland`,
  lat: 51.1 + Math.floor(i / 8) * 0.0055,
  lon: 7.0 + (i % 8) * 0.0085,
}));
const CAR_1 = '11111111-1111-4111-8111-111111111111';
const CAR_2 = '22222222-2222-4222-8222-222222222222';
const VEHICLES = [
  { id: CAR_1, plate: 'XX-TA1', type: 'Mietwagen' },
  { id: CAR_2, plate: 'XX-TA2', type: 'Mietwagen' },
];
const ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ID_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const RANGE = { planning_min_salary: 600, planning_max_salary: 1200, planning_hourly_rate: 13 } as const;
const DRIVERS: FullMonthDriver[] = [
  { id: ID_A, name: 'Fahrer Alpha', ...RANGE },
  { id: ID_B, name: 'Fahrer Beta', ...RANGE },
  { id: ID_C, name: 'Fahrer Gamma', ...RANGE },
];

const input = (over: Partial<FullMonthInput> = {}): FullMonthInput => ({
  year: 2026,
  month: 9,
  base: BASE,
  pool: POOL,
  vehicles: VEHICLES,
  drivers: DRIVERS,
  driverNotesMap: new Map(),
  seed: 2711,
  shiftsPerVehicleDay: 3,
  realTrips: noRealTrips(),
  ...over,
});

function run(over: Partial<FullMonthInput> = {}): FullMonthResult {
  const out = generateFullMonth(input(over));
  if (!out.ok) throw new Error(`generation refused: ${JSON.stringify(out.failure)}`);
  return out.result;
}

const minutes = (ms: number) => Math.round(ms / 60_000);
const plannedEnd = (s: SimShift) => s.plannedEndMs ?? s.endMs;
const wall = (ms: number) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(ms);
  const get = (t: string) => parts.find(p => p.type === t)!.value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, minute: Number(get('hour')) * 60 + Number(get('minute')) };
};
const recheck = (r: FullMonthResult, shifts: readonly SimShift[] = r.month.shifts) =>
  checkDriverShifts(shifts, r.driverPlans, r.vehicleUnavailability, r.provenance.options.minDriverRestMinutes);

// Independent of the code under test: absolute milliseconds, grouped by a key.
function overlapsBy(rides: readonly SimRide[], key: (r: SimRide) => string): number {
  const groups = new Map<string, SimRide[]>();
  for (const r of rides) {
    if (r.startMs === null || r.endMs === null) continue;
    groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);
  }
  let n = 0;
  for (const list of groups.values()) {
    const sorted = [...list].sort((a, b) => (a.startMs as number) - (b.startMs as number));
    for (let i = 1; i < sorted.length; i++) if ((sorted[i].startMs as number) < (sorted[i - 1].endMs as number)) n++;
  }
  return n;
}

// ── 5. Vehicle maintenance: vehicle_unavailability windows ──

describe('a car is never on the road inside its unavailability window (class 5)', () => {
  const rows: VehicleUnavailabilityRow[] = [
    { id: 'u-werkstatt', car_id: CAR_1, starts_local: '2026-09-10 08:00:00', ends_local: '2026-09-12 18:00:00', reason: 'werkstatt' },
    { id: 'u-unfall', car_id: CAR_2, starts_local: '2026-09-25 00:00:00', ends_local: null, reason: 'unfall' },
  ];
  const windows = readUnavailability(rows);
  const r = run({ vehicleUnavailability: windows });

  it('places no shift that overlaps a window, open end included', () => {
    const [werkstatt, unfall] = windows;
    expect(unfall.endMs).toBe(Infinity);
    for (const s of r.month.shifts) {
      const end = plannedEnd(s);
      if (s.vehicle.id === CAR_1) expect(s.startMs < werkstatt.endMs && end > werkstatt.startMs, s.id).toBe(false);
      if (s.vehicle.id === CAR_2) expect(end <= unfall.startMs, s.id).toBe(true);
    }
    expect(recheck(r)).toEqual([]);
    expect(r.violations).toEqual([]);
  });

  it('keeps the car in service outside the window, on the same days', () => {
    const onCar1 = r.month.shifts.filter(s => s.vehicle.id === CAR_1);
    expect(onCar1.some(s => s.operatingDay === '2026-09-09')).toBe(true);
    expect(onCar1.some(s => s.operatingDay === '2026-09-13')).toBe(true);
    // CAR_2 is gone from the 25th, and CAR_1 carries those days alone.
    expect(r.month.shifts.some(s => s.vehicle.id === CAR_1 && s.operatingDay >= '2026-09-25')).toBe(true);
  });

  it('names the window as a confirmed refusal on every day it touches', () => {
    const refused = r.refusals.filter(x => x.reason === 'vehicle_unavailable');
    const days = (id: string) => [...new Set(refused.filter(x => x.noteId === `unavailability:${id}`).map(x => x.day))].sort();
    // The operating day of the 9th ends at 04:00 on the 10th, before the workshop opens at 08:00.
    expect(days('u-werkstatt')).toEqual(['2026-09-10', '2026-09-11', '2026-09-12']);
    expect(days('u-unfall')).toEqual(['2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30']);
    const decided = r.decisions.filter(d => d.code === 'vehicle_unavailable');
    expect(decided.length).toBeGreaterThan(0);
    expect(decided.every(d => d.certainty === 'confirmed' && d.outcome === 'excluded')).toBe(true);
    expect(new Set(decided.map(d => d.eventRef))).toEqual(new Set(['unavailability:u-werkstatt', 'unavailability:u-unfall']));
    expect(r.provenance.inputs.vehicleUnavailability).toBe(2);
  });

  it('negative: a shift forged into the window is caught by the read-back', () => {
    const victim = r.month.shifts.find(s => s.vehicle.id === CAR_2 && s.operatingDay < '2026-09-24')!;
    const moved = { ...victim, vehicle: { ...victim.vehicle, id: CAR_1, plate: 'XX-TA1' }, operatingDay: '2026-09-11',
      startMs: windows[0].startMs + 3_600_000, endMs: windows[0].startMs + 7_200_000, plannedEndMs: windows[0].startMs + 7_200_000 };
    const found = recheck(r, [...r.month.shifts.filter(s => s !== victim), moved]);
    expect(found.some(v => v.includes('inside its unavailability window u-werkstatt'))).toBe(true);
  });

  it('negative: a row that does not read blocks the car for the whole month and says so', () => {
    const broken = readUnavailability([{ id: 'u-kaputt', car_id: CAR_1, starts_local: 'gestern', ends_local: null, reason: 'werkstatt' }]);
    expect(broken[0].unreadable).toBe(true);
    const blocked = run({ vehicleUnavailability: broken });
    expect(blocked.month.shifts.filter(s => s.vehicle.id === CAR_1)).toEqual([]);
    expect(blocked.month.shifts.length).toBeGreaterThan(0);
    expect(recheck(blocked)).toEqual([]);
  });

  it('negative: every car off the road gives no ride and a refusal per car and day, not an invented month', () => {
    const all = readUnavailability([
      { id: 'u-a', car_id: CAR_1, starts_local: '2026-08-01 00:00:00', ends_local: null, reason: 'werkstatt' },
      { id: 'u-b', car_id: CAR_2, starts_local: '2026-08-01 00:00:00', ends_local: null, reason: 'pruefung' },
    ]);
    const none = run({ vehicleUnavailability: all });
    expect(none.month.rides).toEqual([]);
    expect(none.month.shifts).toEqual([]);
    for (const day of none.days) {
      expect(none.refusals.filter(x => x.day === day.day && x.reason === 'vehicle_unavailable')).toHaveLength(2);
    }
    expect(none.driverOutcomes.every(o => o.placedShifts === 0 && o.missedDays.length > 0)).toBe(true);
  });
});

// ── 9. Trips crossing midnight ──

describe('a window across midnight keeps its shifts and rides on the operating day (class 9)', () => {
  // 22:30-01:30: three hours. The range spreads about 140 minutes a day, so
  // every possible start (22:30, 22:45, 23:00) ends after midnight.
  const night: FullMonthDriver = { id: ID_A, name: 'Fahrer Nacht', ...RANGE, work_window_start: '22:30', work_window_end: '01:30' };
  const r = run({ drivers: [night], vehicles: [VEHICLES[0]] });

  it('every shift starts and ends inside the window, crossing midnight', () => {
    expect(r.month.shifts.length).toBeGreaterThan(20);
    let crossing = 0;
    for (const s of r.month.shifts) {
      const from = wall(s.startMs);
      const to = wall(plannedEnd(s));
      expect(from.date, s.id).toBe(s.operatingDay);
      expect(from.minute, s.id).toBeGreaterThanOrEqual(22 * 60 + 30);
      expect(to.minute, s.id).toBeLessThanOrEqual(90);
      if (to.date !== from.date) crossing++;
    }
    expect(crossing).toBe(r.month.shifts.length);
    expect(recheck(r)).toEqual([]);
  });

  it('a ride after midnight counts on the operating day it was driven for', () => {
    const shiftDay = new Map(r.month.shifts.map(s => [s.id, s.operatingDay]));
    const afterMidnight = r.month.rides.filter(x => x.status === 'completed' && wall(x.startMs!).minute < 4 * 60);
    expect(afterMidnight.length).toBeGreaterThan(0);
    for (const ride of afterMidnight) {
      expect(wall(ride.startMs!).date > shiftDay.get(ride.shiftId)!, ride.shiftId).toBe(true);
    }
    expect(r.violations).toEqual([]);
  });

  it('the last day of the month keeps its tail: the shift of the 30th ends on 1 October and is still September\'s', () => {
    const last = r.month.shifts.filter(s => s.operatingDay === '2026-09-30');
    expect(last).toHaveLength(1);
    expect(wall(plannedEnd(last[0])).date).toBe('2026-10-01');
  });

  it('negative: a shift moved past the window\'s end is caught', () => {
    const [first, ...rest] = r.month.shifts;
    const late = { ...first, plannedEndMs: plannedEnd(first) + 90 * 60_000 };
    expect(recheck(r, [late, ...rest]).some(v => v.includes('outside driver'))).toBe(true);
  });
});

// ── 10. Every calendar month length, both clock changes ──

describe('every month length, and the two nights the clocks change (class 10)', () => {
  const cases: [string, number, number, number][] = [
    ['February, 28 days', 2026, 2, 28],
    ['February of a leap year, 29 days', 2028, 2, 29],
    ['30 days', 2026, 4, 30],
    ['31 days, clocks forward on the 29th', 2026, 3, 31],
    ['31 days, clocks back on the 25th', 2026, 10, 31],
  ];

  it.each(cases)('%s: one plan day per calendar day, every shift its planned real minutes', (_n, year, month, count) => {
    const r = run({ year, month });
    for (const plan of r.driverPlans) {
      expect(plan.days.map(d => d.date)).toEqual(r.period.map(d => d.day));
      expect(plan.days).toHaveLength(count);
    }
    const byDay = new Map(r.driverPlans.flatMap(p => p.days.map(d => [`${p.driverId}|${d.date}`, d] as const)));
    for (const s of r.month.shifts) {
      const day = byDay.get(`${s.driver.id}|${s.operatingDay}`)!;
      expect(day.status, s.id).toBe('planned');
      // Absolute milliseconds: a wall-clock subtraction is an hour off on the change night.
      expect(minutes(plannedEnd(s) - s.startMs), s.id).toBe(day.plannedMinutes);
      expect(minutes(plannedEnd(s) - s.startMs), s.id).toBeLessThanOrEqual(MAX_DAY_MINUTES);
    }
    expect(r.month.shifts.every(s => s.operatingDay.startsWith(`${year}-${String(month).padStart(2, '0')}`))).toBe(true);
    expect(recheck(r)).toEqual([]);
    expect(r.violations).toEqual([]);
  });

  it('a night window across the change is measured in real minutes: 01:00-04:00 is two hours in March, four in October', () => {
    const night: FullMonthDriver = { id: ID_A, name: 'Fahrer Nacht', ...RANGE, work_window_start: '01:00', work_window_end: '04:00' };
    const march = run({ year: 2026, month: 3, drivers: [night], vehicles: [VEHICLES[0]] });
    const october = run({ year: 2026, month: 10, drivers: [night], vehicles: [VEHICLES[0]] });
    const windowOf = (r: FullMonthResult, date: string) => {
      const d = r.driverPlans[0].days.find(x => x.date === date)!;
      return minutes(d.windowEndMs! - d.windowStartMs!);
    };
    // The window starts before 04:00, so it belongs to the previous operating day.
    expect(windowOf(march, '2026-03-27')).toBe(180);
    expect(windowOf(march, '2026-03-28')).toBe(120);
    expect(windowOf(october, '2026-10-23')).toBe(180);
    expect(windowOf(october, '2026-10-24')).toBe(240);
    for (const r of [march, october]) {
      const byDay = new Map(r.driverPlans[0].days.map(d => [d.date, d]));
      for (const s of r.month.shifts) {
        const d = byDay.get(s.operatingDay)!;
        expect(s.startMs, s.id).toBeGreaterThanOrEqual(d.windowStartMs!);
        expect(plannedEnd(s), s.id).toBeLessThanOrEqual(d.windowEndMs!);
      }
      expect(recheck(r)).toEqual([]);
      expect(r.violations).toEqual([]);
    }
  });
});

// ── 21. Driver and vehicle overlap prevention; two drivers with one name ──

describe('overlaps are judged by UUID, never by name (class 21)', () => {
  const same = (id: string): FullMonthDriver => ({ id, name: 'Fahrer Gleich', ...RANGE, work_window_start: '08:00', work_window_end: '14:00' });
  const r = run({ drivers: [same(ID_A), same(ID_B)] });

  it('two drivers of one name are planned and counted apart', () => {
    expect(r.driverPlans.map(p => p.driverId)).toEqual([ID_A, ID_B]);
    expect(r.driverOutcomes.map(o => o.driverId)).toEqual([ID_A, ID_B]);
    expect(r.driverOutcomes.every(o => o.placedShifts > 0)).toBe(true);
    const shifts = r.month.shifts;
    expect(shifts.every(s => s.driver.id === ID_A || s.driver.id === ID_B)).toBe(true);
  });

  it('no driver and no vehicle drives two rides at once, though by name they would collide', () => {
    const done = r.month.rides.filter(x => x.status === 'completed');
    expect(overlapsBy(done, x => x.driver.id!)).toBe(0);
    expect(overlapsBy(done, x => x.vehicle.plate)).toBe(0);
    // The control: grouped by name, the two drivers' simultaneous shifts read as one man in two cars.
    expect(overlapsBy(done, x => x.driver.name)).toBeGreaterThan(0);
    expect(r.violations).toEqual([]);
    expect(recheck(r)).toEqual([]);
  });

  it('negative: a second shift for one driver on one day, and a ride overlap, are both found', () => {
    const first = r.month.shifts.find(s => s.driver.id === ID_A)!;
    const twin = { ...first, id: `${first.id}-twin`, vehicle: VEHICLES[1] };
    expect(recheck(r, [...r.month.shifts, twin]).some(v => v.includes(`two shifts on ${first.operatingDay}`))).toBe(true);

    const done = r.month.rides.filter(x => x.status === 'completed' && x.driver.id === ID_A);
    const [a, b] = [done[0], done.find(x => x.shiftId !== done[0].shiftId)!];
    const clash = { ...b, startMs: a.startMs, endMs: a.endMs };
    const found = validateFullMonth({ ...r.month, rides: [...r.month.rides.filter(x => x !== b), clash] },
      r.period, new Map(), r.provenance.settings);
    expect(found.some(v => v.includes('driver') && v.includes('overlapping'))).toBe(true);
  });

  it('negative: rest under eleven hours, a 400-minute shift and a month over the maximum are each found', () => {
    const own = r.month.shifts.filter(s => s.driver.id === ID_A).sort((x, y) => x.startMs - y.startMs);
    const [d1, d2] = own;
    const early = { ...d2, startMs: plannedEnd(d1) + 60 * 60_000, endMs: plannedEnd(d1) + 90 * 60_000, plannedEndMs: plannedEnd(d1) + 90 * 60_000 };
    expect(recheck(r, [...r.month.shifts.filter(s => s !== d2), early]).some(v => v.includes('less than'))).toBe(true);

    const long = { ...d1, plannedEndMs: d1.startMs + 400 * 60_000 };
    expect(recheck(r, [...r.month.shifts.filter(s => s !== d1), long]).some(v => v.includes('400 minutes'))).toBe(true);

    // The maximum is 1200 EUR / 13 EUR = 92.3 h. Stretching every shift to its window's six hours passes it.
    const stretched = r.month.shifts.map(s => (s.driver.id === ID_A ? { ...s, plannedEndMs: s.startMs + 360 * 60_000 } : s));
    expect(recheck(r, stretched).some(v => v.includes(`driver ${ID_A}`) && v.includes('exceed the maximum'))).toBe(true);
  });
});

// ── Negative scenarios: configuration, shortfall, the verdict ──

describe('a driver without settings is not planned on a guess', () => {
  const bare: FullMonthDriver = { id: ID_C, name: 'Fahrer Ohne' };

  it('gets no ride and a CONFIGURATION_REQUIRED refusal on every day, and the verdict is not validated', () => {
    const r = run({ drivers: [...DRIVERS.slice(0, 2), bare] });
    expect(r.month.shifts.filter(s => s.driver.id === ID_C)).toEqual([]);
    const plan = r.driverPlans.find(p => p.driverId === ID_C)!;
    expect(plan.planned).toBe(false);
    expect(plan.notPlannedReason).toBe('configuration_required');
    const days = r.refusals.filter(x => x.reason === 'driver_configuration_required' && x.driverId === ID_C).map(x => x.day);
    expect([...new Set(days)]).toEqual(r.period.map(d => d.day));
    const check = verifyMonth(r).checks.find(c => c.code === 'drivers_planned')!;
    expect(check.outcome).toBe('not_verified');
    expect(check.detail).toContain('Fahrer Ohne');
    expect(verifyMonth(r).verdict).not.toBe('VALIDATED_FOR_EXPORT');
  });

  it('a month in which nobody can be planned fails, rather than passing every check on no rides', () => {
    const r = run({ drivers: [bare, { id: ID_A, name: 'Fahrer Halb', planning_min_salary: 600 }] });
    expect(r.month.rides).toEqual([]);
    const v = verifyMonth(r);
    expect(v.checks.find(c => c.code === 'drivers_planned')!.outcome).toBe('failed');
    expect(v.verdict).toBe('NOT_VALIDATED');
  });

  it('an inactive or planning-disabled driver is left out without counting against the month', () => {
    const r = run({ drivers: [...DRIVERS.slice(0, 2), { ...DRIVERS[2], status: 'inactive' }, { id: ID_C.replace('c', 'd'), name: 'Fahrer Pause', planning_enabled: false }] });
    expect(r.month.shifts.every(s => s.driver.id === ID_A || s.driver.id === ID_B)).toBe(true);
    expect(verifyMonth(r).checks.find(c => c.code === 'drivers_planned')!.outcome).toBe('passed');
  });
});

describe('a shortfall is reported, never filled in', () => {
  it('a driver whose window cannot hold his minimum reads below his range, with the days he lacked', () => {
    // 2000-2400 EUR at 13 EUR/h is 153.8-184.6 hours; two weekdays of six hours cannot carry it.
    const tight: FullMonthDriver = {
      id: ID_A, name: 'Fahrer Knapp', planning_min_salary: 2000, planning_max_salary: 2400, planning_hourly_rate: 13,
      allowed_weekdays: [1, 2], work_window_start: '08:00', work_window_end: '14:00',
    };
    const r = run({ drivers: [tight, DRIVERS[1]] });
    const outcome = r.driverOutcomes.find(o => o.driverId === ID_A)!;
    expect(outcome.assessment.position).toBe('below');
    // Six hours on each of the nine Mondays and Tuesdays is 54 h; the minimum is 153.8 h.
    expect(outcome.assessment.deviationHours).toBeCloseTo(54 - 2000 / 13, 6);
    expect(r.driverPlans.find(p => p.driverId === ID_A)!.discrepancies.some(d => d.kind === 'capacity_below_minimum')).toBe(true);
    // Nothing was stretched to close the gap: every shift is still at most six hours and on a Monday or Tuesday.
    for (const s of r.month.shifts.filter(x => x.driver.id === ID_A)) {
      expect(minutes(plannedEnd(s) - s.startMs)).toBeLessThanOrEqual(MAX_DAY_MINUTES);
      expect([1, 2]).toContain(new Date(`${s.operatingDay}T12:00:00Z`).getUTCDay());
    }
    expect(recheck(r)).toEqual([]);
  });

  it('a sick spell is an absence with its note, and its last night is not driven either', () => {
    const sick: StructuredNote = {
      id: 'note-krank', driver_id: ID_A, note_type: 'Krank', note_text: 'Testnotiz', note_planning_behavior: 'exclude_from_plan',
      is_full_day: true, start_date: '2026-09-07', end_date: '2026-09-27', note_date: null, start_time: null, end_time: null,
    } as StructuredNote;
    const r = run({ driverNotesMap: new Map([[ID_A, [sick]]]) });
    const plan = r.driverPlans.find(p => p.driverId === ID_A)!;
    const absent = plan.days.filter(d => d.status === 'absent').map(d => d.date);
    expect(absent[0]).toBe('2026-09-07');
    expect(absent[absent.length - 1]).toBe('2026-09-27');
    expect(r.month.shifts.some(s => s.driver.id === ID_A && s.operatingDay >= '2026-09-07' && s.operatingDay <= '2026-09-27')).toBe(false);
    // The operating day of the 27th runs to 04:00 on the 28th: nothing of it is driven either.
    const sickEnd = Date.parse('2026-09-28T02:00:00Z');
    expect(r.month.shifts.some(s => s.driver.id === ID_A && s.startMs < sickEnd && plannedEnd(s) > Date.parse('2026-09-06T22:00:00Z'))).toBe(false);
    expect(recheck(r)).toEqual([]);
  });
});
