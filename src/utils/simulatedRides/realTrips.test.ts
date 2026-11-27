import { describe, expect, it } from 'vitest';
import { toCents } from '../money';
import { checkRealTrips, generateFullMonth, type FullMonthDriver, type FullMonthInput, type FullMonthResult } from './fullMonth';
import { verifyMonth } from './monthVerification';
import { noRealTrips, readRealTrips, type RealTripDriverRef, type RealTripRow } from './realTrips';
import { ESTIMATE_TRAVEL_MODEL, type TravelModel } from './travelModel';
import type { GeoPoint, PoolAddress, SimShift } from './types';

/**
 * Round 8, slice S6 (§4, §12 classes 16 and 17).
 *
 * A real trip is a record. It is carried exactly as imported — id, date, times,
 * driver, vehicle, places, fare, tip, status, the fee of a declined order — and
 * the simulation changes none of it, inflates no fare, and adds no row that
 * claims to be one. The driver-day it falls on is actual and is not simulated
 * over; its vehicle is held while it ran and its driver rests around it.
 *
 * Where the month cannot see that (the trips were not read, a trip names no
 * driver it can be sure of, an amount is not one), the verdict is incomplete,
 * never validated.
 *
 * Everything below is invented: public repository, no real person, plate or address.
 */

const ALPHA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BETA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const GAMMA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DRIVER_REFS: RealTripDriverRef[] = [
  { id: ALPHA, name: 'Fahrer Alpha' },
  { id: BETA, name: 'Fahrer Beta' },
];
const ZONE = 'Europe/Berlin';

let nextId = 1;
/** One imported row, as PostgREST returns it: numeric columns as decimal strings. */
const row = (over: Partial<RealTripRow> = {}): RealTripRow => ({
  id: `trip-${String(nextId++).padStart(4, '0')}`,
  import_id: 'import-2026-09',
  trip_date: '2026-09-08',
  start_at: '2026-09-08T08:00:00Z',
  end_at: '2026-09-08T08:25:00Z',
  start_time: '10:00:00',
  end_time: '10:25:00',
  original_driver_id: ALPHA,
  original_driver_name: 'Fahrer Alpha',
  car_identifier: 'XX-TB 1',
  route_start: 'Teststraße 1, 42651 Solingen',
  route_end: 'Teststraße 9, 42651 Solingen',
  price_amount: '8.70',
  tip_amount: '1.30',
  cash_amount: '0.00',
  online_amount: '8.70',
  action_amount: '0.00',
  is_canceled: false,
  trip_status: 'completed',
  declined_fee_cents: null,
  source_row_key: 'uber:abc',
  is_simulated: false,
  ...over,
});

const read = (rows: RealTripRow[], drivers: RealTripDriverRef[] = DRIVER_REFS) =>
  readRealTrips({ year: 2026, month: 9, rows, drivers, timeZone: ZONE, operatingDayStartHour: 4 });

describe('readRealTrips: a record is carried exactly as imported', () => {
  it('keeps every field: an 8,70 € trip stays 870 cents, its tip, times, places, status and source unchanged', () => {
    const r = row({ id: 'trip-real-1' });
    const out = read([r]);
    expect(out.trips).toEqual([{
      label: 'IMPORTIERT',
      tripId: 'trip-real-1',
      importId: 'import-2026-09',
      tripDate: '2026-09-08',
      startMs: Date.parse('2026-09-08T08:00:00Z'),
      endMs: Date.parse('2026-09-08T08:25:00Z'),
      startTime: '10:00:00',
      endTime: '10:25:00',
      operatingDay: '2026-09-08',
      dayFrom: 'start_at',
      driverId: ALPHA,
      driverName: 'Fahrer Alpha',
      identity: 'driver_id',
      plate: 'XX-TB 1',
      pickup: 'Teststraße 1, 42651 Solingen',
      destination: 'Teststraße 9, 42651 Solingen',
      fareCents: 870,
      tipCents: 130,
      cashCents: 0,
      onlineCents: 870,
      actionCents: 0,
      status: 'completed',
      canceled: false,
      declinedFeeCents: 0,
      sourceRowKey: 'uber:abc',
    }]);
    expect(out.days).toEqual(new Map([[ALPHA, new Set(['2026-09-08'])]]));
    expect(out.unattributed).toEqual([]);
  });

  it('keeps a cancellation with its charge and a declined order with its fee, as stored', () => {
    const out = read([
      row({ id: 'trip-cancel', is_canceled: true, trip_status: 'cancelled', price_amount: '5.00', tip_amount: null }),
      row({ id: 'trip-declined', trip_status: 'declined', price_amount: '0.00', tip_amount: '0.00', declined_fee_cents: 250, start_at: '2026-09-08T09:00:00Z', end_at: '2026-09-08T09:00:00Z' }),
    ]);
    expect(out.trips.map(t => [t.tripId, t.status, t.canceled, t.fareCents, t.tipCents, t.declinedFeeCents])).toEqual([
      ['trip-cancel', 'cancelled', true, 500, 0, 0],
      ['trip-declined', 'declined', false, 0, 0, 250],
    ]);
  });

  it('cuts the operating day at 04:00 Berlin time: 01:30 on the 1st belongs to the month before, 01:30 on 1 October to 30 September', () => {
    const out = read([
      row({ id: 'early-sept', trip_date: '2026-08-31', start_at: '2026-08-31T23:30:00Z', end_at: '2026-08-31T23:50:00Z' }),
      row({ id: 'early-oct', trip_date: '2026-09-30', start_at: '2026-09-30T23:30:00Z', end_at: '2026-09-30T23:50:00Z' }),
    ]);
    expect(out.trips.map(t => [t.tripId, t.operatingDay])).toEqual([['early-oct', '2026-09-30']]);
    expect(out.outsideMonth).toBe(1);
  });

  it('without a start instant the stored trip date is the day, and says so', () => {
    const [t] = read([row({ start_at: null, end_at: null, trip_date: '2026-09-12' })]).trips;
    expect([t.operatingDay, t.dayFrom, t.startMs, t.endMs]).toEqual(['2026-09-12', 'trip_date', null, null]);
  });

  it('names the driver by id, else by one exact name; two of the name or none leave it unattributed', () => {
    const twins: RealTripDriverRef[] = [...DRIVER_REFS, { id: GAMMA, name: 'Fahrer Beta' }];
    const out = read([
      row({ id: 'by-id' }),
      row({ id: 'by-name', original_driver_id: null, original_driver_name: ' Fahrer Alpha ' }),
      row({ id: 'twin', original_driver_id: null, original_driver_name: 'Fahrer Beta' }),
      row({ id: 'stranger', original_driver_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', original_driver_name: 'Niemand Bekannt' }),
    ], twins);
    expect(out.trips.map(t => [t.tripId, t.driverId, t.identity])).toEqual([
      ['by-id', ALPHA, 'driver_id'],
      ['by-name', ALPHA, 'name_only'],
      ['stranger', null, 'unresolved'],
      ['twin', null, 'ambiguous'],
    ]);
    expect(out.unattributed.map(t => t.tripId)).toEqual(['stranger', 'twin']);
    // The stored name stays as stored, spaces included.
    expect(out.trips.find(t => t.tripId === 'by-name')!.driverName).toBe(' Fahrer Alpha ');
  });

  it('negative: an amount that is not one is kept as unreadable, never guessed or zeroed', () => {
    const out = read([row({ id: 'bad-fare', price_amount: '8,70' })]);
    expect(out.trips[0].fareCents).toBeNull();
    expect(out.unreadableAmounts).toEqual([{ tripId: 'bad-fare', column: 'price_amount' }]);
  });

  it('negative: a simulated row, or one that does not say, is never read as real', () => {
    const out = read([row({ is_simulated: true }), row({ is_simulated: null }), row({ id: 'real' })]);
    expect(out.trips.map(t => t.tripId)).toEqual(['real']);
    expect(out.simulatedSkipped).toBe(2);
  });
});

// ── The month around real trips ─────────────────────────────────────────────

const BASE: GeoPoint = { lat: 51.1657, lon: 7.0671 };
const POOL: PoolAddress[] = Array.from({ length: 40 }, (_, i) => ({
  label: `Teststraße ${i + 1}, 42651 Solingen, Deutschland`,
  lat: 51.1 + Math.floor(i / 8) * 0.0055,
  lon: 7.0 + (i % 8) * 0.0085,
}));
const VEHICLES = [
  { id: '11111111-1111-4111-8111-111111111111', plate: 'XX-TB1', type: 'Mietwagen' },
  { id: '22222222-2222-4222-8222-222222222222', plate: 'XX-TB2', type: 'Mietwagen' },
];
const RANGE = { planning_min_salary: 600, planning_max_salary: 1200, planning_hourly_rate: 13 } as const;
const DRIVERS: FullMonthDriver[] = [
  { id: ALPHA, name: 'Fahrer Alpha', ...RANGE },
  { id: BETA, name: 'Fahrer Beta', ...RANGE },
];
const ROUTED: TravelModel = { source: 'test-router', measured: true, drive: ESTIMATE_TRAVEL_MODEL.drive, ride: ESTIMATE_TRAVEL_MODEL.ride };

const monthInput = (over: Partial<FullMonthInput> = {}): FullMonthInput => ({
  year: 2026, month: 9, base: BASE, baseSource: 'saved_point', pool: POOL, vehicles: VEHICLES, drivers: DRIVERS,
  driverNotesMap: new Map(), seed: 2713, shiftsPerVehicleDay: 3, travel: ROUTED, realTrips: noRealTrips(), ...over,
});
function run(over: Partial<FullMonthInput> = {}): FullMonthResult {
  const out = generateFullMonth(monthInput(over));
  if (!out.ok) throw new Error(`generation refused: ${JSON.stringify(out.failure)}`);
  return out.result;
}
const kept = (r: FullMonthResult) => verifyMonth(r).checks.find(c => c.code === 'real_trips_kept')!;

/** Freezes a read all the way down, so any write into a record throws. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    if (value instanceof Map) for (const [k, v] of value) { deepFreeze(k); deepFreeze(v); }
    else if (value instanceof Set) for (const v of value) deepFreeze(v);
    else for (const v of Object.values(value as object)) deepFreeze(v);
  }
  return value;
}

const without = run();
// Alpha drove four real trips on Tuesday 8 September, the last ending after midnight.
const ALPHA_DAY = [
  row({ id: 'r-1', start_at: '2026-09-08T08:00:00Z', end_at: '2026-09-08T08:25:00Z', car_identifier: 'xx tb1' }),
  row({ id: 'r-2', start_at: '2026-09-08T09:10:00Z', end_at: '2026-09-08T09:40:00Z', car_identifier: 'XX-TB1', price_amount: '19.80' }),
  row({ id: 'r-3', start_at: '2026-09-08T13:00:00Z', end_at: '2026-09-08T13:20:00Z', car_identifier: 'XX-TB1', is_canceled: true, trip_status: 'cancelled', price_amount: '5.00' }),
  row({ id: 'r-4', trip_date: '2026-09-08', start_at: '2026-09-08T23:30:00Z', end_at: '2026-09-09T00:20:00Z', car_identifier: 'XX-TB1' }),
];
const realRead = deepFreeze(read(ALPHA_DAY));
const withReal = run({ realTrips: realRead });

describe('class 17: a real driver-day is actual, never simulated over', () => {
  it('without real trips Alpha is simulated on 8 September (the control)', () => {
    expect(without.month.shifts.some(s => s.driver.id === ALPHA && s.operatingDay === '2026-09-08')).toBe(true);
  });

  it('with them, Alpha has no simulated shift that day, and the refusal says why', () => {
    expect(withReal.month.shifts.filter(s => s.driver.id === ALPHA && s.operatingDay === '2026-09-08')).toEqual([]);
    expect(withReal.refusals).toContainEqual({ day: '2026-09-08', reason: 'driver_has_real_trips', driverId: ALPHA });
  });

  it('no simulated shift holds XX-TB1 while a real trip ran in it, the vehicle gap included', () => {
    const gap = withReal.provenance.options.minVehicleGapMinutes * 60_000;
    const realWindows = ALPHA_DAY.map(r => [Date.parse(r.start_at!), Date.parse(r.end_at!)]);
    for (const s of withReal.month.shifts.filter(x => x.vehicle.plate === 'XX-TB1')) {
      const end = s.plannedEndMs ?? s.endMs;
      for (const [a, b] of realWindows) expect(s.startMs < b + gap && end > a - gap).toBe(false);
    }
  });

  it("Alpha's next shift keeps his rest after the real trip that ended after midnight", () => {
    const rest = withReal.provenance.options.minDriverRestMinutes * 60_000;
    const lastReal = Date.parse('2026-09-09T00:20:00Z');
    const next = withReal.month.shifts.filter(s => s.driver.id === ALPHA && s.startMs > lastReal).sort((a, b) => a.startMs - b.startMs)[0];
    expect(next).toBeDefined();
    expect(next.startMs).toBeGreaterThanOrEqual(lastReal + rest);
  });

  it('when his rest after the real trip covers the whole next window, Alpha is not planned the next morning', () => {
    // 11 h after the real trip that ended at 02:20 is 13:20; his window closes at 12:00.
    const morning = [{ ...DRIVERS[0], work_window_start: '05:00', work_window_end: '12:00' }, DRIVERS[1]];
    const control = run({ drivers: morning });
    expect(control.month.shifts.some(s => s.driver.id === ALPHA && s.operatingDay === '2026-09-09')).toBe(true);
    const rested = run({ drivers: morning, realTrips: read(ALPHA_DAY) });
    expect(rested.month.shifts.filter(s => s.driver.id === ALPHA && s.operatingDay === '2026-09-09')).toEqual([]);
    expect(rested.refusals).toContainEqual({ day: '2026-09-09', reason: 'driver_resting', driverId: ALPHA });
    expect(rested.violations).toEqual([]);
  });

  it('when the rest before an early real trip covers the evening window, Alpha is not planned that evening', () => {
    // A real trip at 05:00 on the 10th needs him off duty from 18:00 on the 9th; his window is 16:00 to 22:00.
    const evening = [{ ...DRIVERS[0], work_window_start: '16:00', work_window_end: '22:00' }, DRIVERS[1]];
    const control = run({ drivers: evening });
    expect(control.month.shifts.some(s => s.driver.id === ALPHA && s.operatingDay === '2026-09-09')).toBe(true);
    const dawn = read([row({ id: 'dawn', trip_date: '2026-09-10', start_at: '2026-09-10T03:00:00Z', end_at: '2026-09-10T03:30:00Z' })]);
    const rested = run({ drivers: evening, realTrips: dawn });
    expect(rested.month.shifts.filter(s => s.driver.id === ALPHA && s.operatingDay === '2026-09-09')).toEqual([]);
    expect(rested.refusals).toContainEqual({ day: '2026-09-09', reason: 'driver_resting', driverId: ALPHA });
    expect(rested.violations).toEqual([]);
  });

  it('no simulated ride carries a real trip id, and the read-back finds nothing', () => {
    const ids = new Set(ALPHA_DAY.map(r => r.id));
    expect(withReal.month.rides.filter(r => r.tripId && ids.has(r.tripId))).toEqual([]);
    expect(withReal.violations).toEqual([]);
  });

  it('the verdict check passes and names what it left alone; the run id knows the trips were there', () => {
    expect(kept(withReal)).toMatchObject({ outcome: 'passed', detail: '4 echte Fahrten (IMPORTIERT) unveraendert, 1 Fahrertage nicht simuliert' });
    expect(withReal.provenance.realTrips).toMatchObject({ trips: 4, driverDays: 1, unattributed: 0, unreadableAmounts: 0 });
    expect(withReal.provenance.runId).not.toBe(without.provenance.runId);
    expect(kept(without)).toMatchObject({ outcome: 'passed', detail: 'keine echten Fahrten im Monat' });
  });
});

describe('class 16: no real fare is inflated, no actual ride is fabricated', () => {
  it('the real trips come back exactly as read: 8,70 € stays 8,70 € and 19,80 € stays 19,80 €', () => {
    // Frozen before generation, so a write into a record would have thrown.
    expect(withReal.realTrips).toBe(realRead);
    expect(withReal.realTrips!.trips).toEqual(read(ALPHA_DAY).trips);
    expect(withReal.realTrips!.trips.map(t => t.fareCents)).toEqual([870, 1980, 500, 870]);
  });

  it('the simulated month adds no row that is a real trip, and counts no real fare in its revenue', () => {
    expect(withReal.month.rides.every(r => !ALPHA_DAY.some(x => x.id === r.tripId))).toBe(true);
    const simulated = withReal.month.rides.filter(r => r.status === 'completed').reduce((n, r) => n + toCents(r.fare), 0);
    expect(withReal.revenue.fareCents).toBe(simulated);
  });
});

describe('negatives: what the month cannot see is not validated', () => {
  it('real trips never read: incomplete, never validated', () => {
    const blind = run({ realTrips: undefined });
    expect(kept(blind)).toMatchObject({ outcome: 'not_verified' });
    expect(kept(blind).detail).toContain('nicht gelesen');
    expect(verifyMonth(blind).verdict).toBe('VERIFICATION_INCOMPLETE');
    expect(blind.provenance.realTrips).toBeNull();
  });

  it('a real trip that names no driver for certain: kept unchanged, but the month is incomplete', () => {
    const twins = read([row({ id: 'twin', original_driver_id: null, original_driver_name: 'Fahrer Beta' })],
      [...DRIVER_REFS, { id: GAMMA, name: 'Fahrer Beta' }]);
    const r = run({ realTrips: twins });
    expect(r.realTrips!.unattributed.map(t => t.tripId)).toEqual(['twin']);
    expect(kept(r).outcome).toBe('not_verified');
    expect(kept(r).detail).toContain('Fahrer Beta');
    expect(verifyMonth(r).verdict).toBe('VERIFICATION_INCOMPLETE');
  });

  it('a real trip with an unreadable amount: kept, not estimated, the month is incomplete', () => {
    const r = run({ realTrips: read([row({ id: 'bad', price_amount: 'n/a' })]) });
    expect(kept(r)).toMatchObject({ outcome: 'not_verified', detail: '1 unlesbare Betraege in echten Fahrten - nicht geschaetzt' });
    expect(verifyMonth(r).verdict).toBe('VERIFICATION_INCOMPLETE');
  });

  it('a simulated row in the read does not make a day real: Alpha is still simulated on 8 September', () => {
    const r = run({ realTrips: read([row({ is_simulated: true })]) });
    expect(r.month.shifts.some(s => s.driver.id === ALPHA && s.operatingDay === '2026-09-08')).toBe(true);
  });
});

describe('the read-back refuses a month that touched a real trip', () => {
  const alphaShift = without.month.shifts.find(s => s.driver.id === ALPHA && s.operatingDay === '2026-09-08')!;
  const forge = (shift: SimShift) => ({ ...without.month, shifts: [shift] });

  it('a shift on a real driver-day', () => {
    expect(checkRealTrips(forge(alphaShift), realRead, without.provenance.options))
      .toContain(`${alphaShift.id}: driver ${ALPHA} has real trips on 2026-09-08 and was simulated over`);
  });

  it("another driver's shift on the vehicle while a real trip ran in it", () => {
    const start = Date.parse('2026-09-08T07:00:00Z');
    const beta: SimShift = { ...alphaShift, id: 'S-forged', driver: { ...alphaShift.driver, id: BETA }, vehicle: VEHICLES[0], startMs: start, endMs: start + 3 * 3_600_000, plannedEndMs: start + 3 * 3_600_000 };
    expect(checkRealTrips(forge(beta), realRead, without.provenance.options)).toEqual(['S-forged: vehicle XX-TB1 is held by a real trip during the shift']);
  });

  it("Alpha's shift on the next day inside his rest after the real trip", () => {
    const start = Date.parse('2026-09-09T02:30:00Z');
    const early: SimShift = { ...alphaShift, id: 'S-early', operatingDay: '2026-09-09', vehicle: VEHICLES[1], startMs: start, endMs: start + 3_600_000, plannedEndMs: start + 3_600_000 };
    expect(checkRealTrips(forge(early), realRead, without.provenance.options)).toEqual([`S-early: driver ${ALPHA} has a real trip within the rest before or after the shift`]);
  });

  it('a simulated ride that carries a real trip id fails the verdict', () => {
    const forged: FullMonthResult = { ...withReal, month: { ...withReal.month, rides: [...withReal.month.rides, { ...withReal.month.rides[0], tripId: 'r-2' }] } };
    expect(kept(forged)).toMatchObject({ outcome: 'failed' });
    expect(kept(forged).detail).toContain("r-2: a simulated ride carries a real trip's id");
    expect(verifyMonth(forged).verdict).toBe('NOT_VALIDATED');
  });
});
