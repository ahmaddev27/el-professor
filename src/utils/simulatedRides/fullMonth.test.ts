import { beforeAll, describe, expect, it } from 'vitest';
import { findBlockingNote } from '../driverNoteValidation';
import type { StructuredNote } from '../monatsplanungPhase3';
import {
  FULL_MONTH_GENERATOR_VERSION,
  generateFullMonth,
  type FullMonthDriver,
  type FullMonthInput,
  type FullMonthResult,
} from './fullMonth';
import { DEFAULT_OPTIONS } from './generator';
import { DEFAULT_SIMULATION_TENANT_SETTINGS } from './tenantSettings';
import type { GeoPoint, PoolAddress, SimRide } from './types';

// Everything below is invented: public repository, no real person, plate or address.
const BASE: GeoPoint = { lat: 51.1657, lon: 7.0671 };
const POOL: PoolAddress[] = Array.from({ length: 40 }, (_, i) => ({
  label: `Teststraße ${i + 1}, 42651 Solingen, Deutschland`,
  lat: 51.1 + Math.floor(i / 8) * 0.0055,
  lon: 7.0 + (i % 8) * 0.0085,
}));
const VEHICLES = [
  { id: '11111111-1111-4111-8111-111111111111', plate: 'XX-TA1', type: 'Mietwagen' },
  { id: '22222222-2222-4222-8222-222222222222', plate: 'XX-TA2', type: 'Mietwagen' },
];
const ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ID_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DRIVERS: FullMonthDriver[] = [
  { id: ID_A, name: 'Fahrer Alpha' },
  { id: ID_B, name: 'Fahrer Beta' },
  { id: ID_C, name: 'Fahrer Gamma' },
];

const note = (over: Partial<StructuredNote> & { driver_id: string }): StructuredNote => ({
  id: `note-${over.driver_id.slice(0, 2)}`,
  note_type: 'Urlaub',
  note_text: 'Testnotiz',
  note_planning_behavior: 'exclude_from_plan',
  is_full_day: true,
  start_date: null,
  end_date: null,
  note_date: null,
  start_time: null,
  end_time: null,
  ...over,
});

const input = (over: Partial<FullMonthInput> = {}): FullMonthInput => ({
  year: 2026,
  month: 9,
  base: BASE,
  pool: POOL,
  vehicles: VEHICLES,
  drivers: DRIVERS,
  driverNotesMap: new Map(),
  seed: 4711,
  shiftsPerVehicleDay: 1,
  ...over,
});

function run(over: Partial<FullMonthInput> = {}): FullMonthResult {
  const out = generateFullMonth(input(over));
  if (!out.ok) throw new Error(`generation refused: ${JSON.stringify(out.failure)}`);
  return out.result;
}

const ymd = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

// Independent of validateFullMonth: absolute milliseconds, grouped by id, so the
// check does not run the code under test.
function overlapsBy(rides: readonly SimRide[], key: (r: SimRide) => string): string[] {
  const groups = new Map<string, SimRide[]>();
  for (const r of rides) {
    if (r.startMs === null || r.endMs === null) continue;
    groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);
  }
  const out: string[] = [];
  for (const [k, list] of groups) {
    const sorted = [...list].sort((a, b) => (a.startMs as number) - (b.startMs as number));
    for (let i = 1; i < sorted.length; i++) {
      if ((sorted[i].startMs as number) < (sorted[i - 1].endMs as number)) out.push(k);
    }
  }
  return out;
}

describe('every day of the month is present', () => {
  const cases: [string, number, number, number][] = [
    ['31-day month', 2026, 10, 31],
    ['30-day month', 2026, 9, 30],
    ['February of a leap year', 2028, 2, 29],
    ['February of a non-leap year', 2026, 2, 28],
  ];
  it.each(cases)('%s', (_n, year, month, count) => {
    const r = run({ year, month });
    expect(r.period).toHaveLength(count);
    expect(r.days).toHaveLength(count);
    expect(r.days[0].day).toBe(ymd(year, month, 1));
    expect(r.days[count - 1].day).toBe(ymd(year, month, count));
    expect(r.days.map(d => d.day)).toEqual(r.period.map(d => d.day));
  });
});

describe('zero-ride days', () => {
  let r: FullMonthResult;
  beforeAll(() => {
    // Nobody works Saturday or Sunday, so the weekends are guaranteed empty.
    const weekdays = DRIVERS.map(d => ({ ...d, allowed_weekdays: [1, 2, 3, 4, 5] }));
    r = run({ drivers: weekdays });
  });

  it('are present, flagged, and carry no ride', () => {
    const zero = r.days.filter(d => d.zeroRideDay);
    expect(zero.length).toBeGreaterThan(0);
    expect(zero.length).not.toBe(r.days.length);
    for (const d of zero) {
      expect(d.rides).toBe(0);
      expect(d.shifts).toBe(0);
    }
    expect(r.days).toHaveLength(30);
  });

  it('every weekend day of the month is one of them', () => {
    const weekend = r.days.filter(d => d.isoWeekday >= 6);
    expect(weekend.length).toBe(8);
    expect(weekend.every(d => d.zeroRideDay)).toBe(true);
  });

  it('a day with rides is not flagged', () => {
    for (const d of r.days.filter(x => x.rides > 0)) expect(d.zeroRideDay).toBe(false);
    expect(r.days.some(d => d.rides > 0)).toBe(true);
  });
});

describe('no ride during a driver unavailability', () => {
  const idsOf = (r: FullMonthResult) => r.month.shifts.map(s => s.driver.id as string);

  it('a full-day note range keeps the driver off those days, and the refusal is recorded', () => {
    const notes = new Map([
      [ID_A, [note({ driver_id: ID_A, start_date: '2026-09-07', end_date: '2026-09-20' })]],
    ]);
    const r = run({ driverNotesMap: notes });
    expect(r.month.shifts.length).toBeGreaterThan(0);
    for (const s of r.month.shifts) expect(findBlockingNote(s.driver.id as string, s.startMs, s.endMs, notes)).toBeNull();
    expect(r.violations).toEqual([]);
    expect(r.refusals.some(x => x.reason === 'driver_blocked_by_note' && x.driverId === ID_A)).toBe(true);
    // Not vacuous: the same driver does work outside the range.
    expect(idsOf(r)).toContain(ID_A);
  });

  it('a timed note blocks only its window; the driver still works outside it', () => {
    const notes = new Map([
      [
        ID_A,
        [note({
          driver_id: ID_A, is_full_day: false, start_date: '2026-09-01', end_date: '2026-09-30',
          start_time: '06:00', end_time: '12:00', note_type: 'Arzttermin',
        })],
      ],
    ]);
    const r = run({ driverNotesMap: notes });
    for (const s of r.month.shifts) expect(findBlockingNote(s.driver.id as string, s.startMs, s.endMs, notes)).toBeNull();
    // Independent restatement of the window in local wall time.
    for (const s of r.month.shifts.filter(x => x.driver.id === ID_A)) {
      for (let d = 1; d <= 30; d++) {
        const from = new Date(2026, 8, d, 6, 0).getTime();
        const to = new Date(2026, 8, d, 12, 0).getTime();
        expect(s.startMs < to && s.endMs > from).toBe(false);
      }
    }
    expect(r.violations).toEqual([]);
    expect(r.refusals.some(x => x.reason === 'driver_blocked_by_note' && x.driverId === ID_A && x.noteType === 'Arzttermin')).toBe(true);
    expect(idsOf(r)).toContain(ID_A);
  });

  it('a "neutral" note blocks nothing', () => {
    const notes = new Map([
      [ID_A, [note({ driver_id: ID_A, note_planning_behavior: 'neutral', start_date: '2026-09-01', end_date: '2026-09-30' })]],
    ]);
    const r = run({ driverNotesMap: notes });
    expect(r.refusals.some(x => x.reason === 'driver_blocked_by_note')).toBe(false);
  });
});

describe('no operating capacity means no rides, with a reason', () => {
  it('no vehicle', () => {
    const r = run({ vehicles: [] });
    expect(r.month.rides).toHaveLength(0);
    expect(r.days.every(d => d.zeroRideDay)).toBe(true);
    expect(r.days).toHaveLength(30);
    expect(r.refusals.filter(x => x.reason === 'no_vehicle_in_fleet')).toHaveLength(30);
  });

  it('no driver', () => {
    const r = run({ drivers: [] });
    expect(r.month.rides).toHaveLength(0);
    expect(r.refusals.filter(x => x.reason === 'no_driver_in_pool')).toHaveLength(30);
  });

  it('every driver switched off in planning', () => {
    const r = run({ drivers: DRIVERS.map(d => ({ ...d, planning_enabled: false })) });
    expect(r.month.rides).toHaveLength(0);
    expect(r.refusals.filter(x => x.reason === 'no_driver_in_pool')).toHaveLength(30);
  });

  it('a weekend-only driver works weekends only', () => {
    const r = run({ drivers: [{ id: ID_A, name: 'Fahrer Alpha', allowed_weekdays: [6, 7] }] });
    expect(r.month.shifts.length).toBeGreaterThan(0);
    const weekdayOf = new Map(r.days.map(d => [d.day, d.isoWeekday]));
    for (const s of r.month.shifts) expect([6, 7]).toContain(weekdayOf.get(s.operatingDay));
    expect(r.refusals.some(x => x.reason === 'driver_weekday_not_allowed')).toBe(true);
  });
});

describe('a healthy month', () => {
  let r: FullMonthResult;
  beforeAll(() => {
    r = run({ settings: { declinedRidesEnabled: true, declinedShare: 0.5 } });
  });

  it('has no violations and rides exist', () => {
    expect(r.month.rides.length).toBeGreaterThan(50);
    expect(r.violations).toEqual([]);
  });

  it('no driver and no vehicle holds two overlapping rides (checked independently)', () => {
    expect(overlapsBy(r.month.rides, x => x.driver.id as string)).toEqual([]);
    expect(overlapsBy(r.month.rides, x => x.vehicle.plate)).toEqual([]);
  });

  it('every orderTransmittedMs is unique, declined rides included', () => {
    expect(r.internal.declined.counts.declined).toBeGreaterThan(0);
    const all = r.month.rides.map(x => x.orderTransmittedMs);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('determinism', () => {
  const fingerprint = (r: FullMonthResult) =>
    JSON.stringify({
      rides: r.month.rides.map(x => [x.status, x.driver.id, x.vehicle.plate, x.orderTransmittedMs, x.startMs, x.endMs, x.fare, x.tip]),
      fare: r.revenue.fareCents,
    });
  it('same input and seed give an identical month; another seed does not', () => {
    const a = run({ seed: 99 });
    const b = run({ seed: 99 });
    const c = run({ seed: 100 });
    expect(fingerprint(a)).toBe(fingerprint(b));
    expect(fingerprint(a)).not.toBe(fingerprint(c));
  });
});

describe('provenance', () => {
  it('records what built the month', () => {
    const notes = new Map([[ID_A, [note({ driver_id: ID_A, start_date: '2026-09-02', end_date: '2026-09-02' })]]]);
    const r = run({ seed: 7, driverNotesMap: notes, options: { tipShare: 0.3 }, settings: { declinedFeeCents: 700 } });
    const p = r.provenance;
    expect(p.generatorVersion).toBe(FULL_MONTH_GENERATOR_VERSION);
    expect(p).toMatchObject({ seed: 7, year: 2026, month: 9, inputSource: 'period_driven', simulated: true, shiftsPerVehicleDay: 1 });
    expect(p.settings).toEqual({ ...DEFAULT_SIMULATION_TENANT_SETTINGS, declinedFeeCents: 700 });
    expect(p.options).toEqual({ ...DEFAULT_OPTIONS, tipShare: 0.3 });
    expect(p.inputs).toEqual({
      drivers: 3, vehicles: 2, addressPool: 40, driversWithNotes: 1, structuredNotes: 1, werkstattChecks: 0,
    });
  });
});

describe('declined rides', () => {
  it('are off by default and on when asked', () => {
    expect(run().internal.declined.counts.declined).toBe(0);
    const on = run({ settings: { declinedRidesEnabled: true, declinedShare: 0.5 } });
    expect(on.internal.declined.counts.declined).toBeGreaterThan(0);
    expect(on.internal.declined.declinedFeeCents).toBe(on.internal.declined.counts.declined * 600);
    // The report's own money never holds one of them.
    expect(on.revenue.counts.declined).toBe(0);
    expect(on.revenue.declinedFeeCents).toBe(0);
  });

  it('consume no shift time: the completed rides are byte-identical with the feature on or off', () => {
    const off = run({ seed: 2026 });
    const on = run({ seed: 2026, settings: { declinedRidesEnabled: true, declinedShare: 0.5 } });
    expect(on.internal.declined.counts.declined).toBeGreaterThan(0);
    const completedOf = (r: FullMonthResult) => r.month.rides.filter(x => x.status === 'completed');
    expect(completedOf(on).length).toBe(completedOf(off).length);
    expect(JSON.stringify(completedOf(on))).toBe(JSON.stringify(completedOf(off)));
  });
});

describe('refusals of the input', () => {
  it('a month out of range', () => {
    for (const month of [0, 13, 1.5]) {
      expect(generateFullMonth(input({ month }))).toEqual({ ok: false, failure: { kind: 'month_out_of_range' } });
    }
  });

  it('bad settings', () => {
    expect(generateFullMonth(input({ settings: { declinedFeeCents: 6.5 } }))).toEqual({
      ok: false, failure: { kind: 'settings', problem: 'declined_fee_not_whole_cents' },
    });
    expect(generateFullMonth(input({ settings: { timeZone: 'Mars/Olympus' } }))).toEqual({
      ok: false, failure: { kind: 'settings', problem: 'time_zone_unknown' },
    });
  });

  it('an address pool that is too small', () => {
    expect(generateFullMonth(input({ pool: POOL.slice(0, 7) }))).toEqual({ ok: false, failure: { kind: 'address_pool_too_small' } });
  });
});

describe('the monthly share', () => {
  it('is null by default', () => {
    expect(run().share).toBeNull();
  });

  it('when on, adds up to the basis exactly', () => {
    const r = run({ settings: { monthlyRevenueShareEnabled: true } });
    expect(r.share).not.toBeNull();
    const res = r.share!.result;
    expect(res.basisCents).toBe(r.basis.basisCents);
    expect(res.basisCents).toBeGreaterThan(0);
    expect(res.amountCents + res.remainderCents).toBe(res.basisCents);
  });
});
