import { describe, expect, it } from 'vitest';
import { CALENDAR_SHIFT_LIMITS, generateFullMonth, type FullMonthDriver, type FullMonthInput, type FullMonthResult } from './fullMonth';
import { validateRides } from './generator';
import { verifyMonth } from './monthVerification';
import { emptyDriveSeconds, pickupDriveSeconds } from './repositioning';
import { ESTIMATE_TRAVEL_MODEL, pointKey, type TravelModel } from './travelModel';
import type { GeoPoint, PoolAddress, SimRide, SimShift } from './types';

/**
 * Round 8, slice S5 (§3 and §12 classes 6, 7, 8 and 23).
 *
 * Every shift leaves from the company's base, and the drive to the first pickup
 * is a recorded empty leg whose time the shift spends. Between two passenger
 * rides the car's way to the next pickup is recorded too. Returning to the base
 * at the end of a shift is a company setting (D8): with it, the drive home is
 * routed, recorded, and the shift lasts until the car arrives; without it there
 * is no such leg and no such rule. Where no route exists, nothing is invented:
 * the month has no ride there, and its verdict says so.
 *
 * Everything below is invented: public repository, no real person, plate or address.
 */

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
  { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Fahrer Alpha', ...RANGE },
  { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Fahrer Beta', ...RANGE },
];

/** The estimate's answers under a router's label, so the month can be judged as routed. */
const ROUTED: TravelModel = { source: 'test-router', measured: true, drive: ESTIMATE_TRAVEL_MODEL.drive, ride: ESTIMATE_TRAVEL_MODEL.ride };
const atBase = (p: GeoPoint) => pointKey(p) === pointKey(BASE);
/** Every road except the ones back into the base. */
const NO_WAY_HOME: TravelModel = {
  source: 'test-no-way-home',
  measured: true,
  drive: (from, to, hour) => (atBase(to) && !atBase(from) ? null : ROUTED.drive(from, to, hour)),
  ride: (from, to, hour) => (atBase(to) ? null : ROUTED.ride(from, to, hour)),
};
const NO_ROUTES: TravelModel = { source: 'test-router-down', measured: true, drive: () => null, ride: () => null };

const input = (over: Partial<FullMonthInput> = {}): FullMonthInput => ({
  year: 2026,
  month: 9,
  base: BASE,
  baseSource: 'saved_point',
  pool: POOL,
  vehicles: VEHICLES,
  drivers: DRIVERS,
  driverNotesMap: new Map(),
  seed: 2712,
  shiftsPerVehicleDay: 3,
  travel: ROUTED,
  ...over,
});

function run(over: Partial<FullMonthInput> = {}): FullMonthResult {
  const out = generateFullMonth(input(over));
  if (!out.ok) throw new Error(`generation refused: ${JSON.stringify(out.failure)}`);
  return out.result;
}

const completedByShift = (rides: readonly SimRide[]): Map<string, SimRide[]> => {
  const out = new Map<string, SimRide[]>();
  for (const r of rides) {
    if (r.status !== 'completed' || r.startMs === null || r.endMs === null) continue;
    out.set(r.shiftId, [...(out.get(r.shiftId) ?? []), r]);
  }
  for (const list of out.values()) list.sort((a, b) => (a.startMs as number) - (b.startMs as number));
  return out;
};
const plannedEnd = (s: SimShift) => s.plannedEndMs ?? s.endMs;
const revalidate = (r: FullMonthResult, shifts: readonly SimShift[], returnToBase: boolean, travel: TravelModel = ROUTED) =>
  validateRides({ ...r.month, shifts: [...shifts] }, BASE, travel, r.provenance.options, CALENDAR_SHIFT_LIMITS, returnToBase);

const plain = run();
const home = run({ returnToBase: true });

describe('class 6: every shift starts at the company base', () => {
  it('the first order of every shift reaches the car at the base, after the shift began', () => {
    const shifts = new Map(plain.month.shifts.map(s => [s.id, s]));
    const byShift = completedByShift(plain.month.rides);
    expect(byShift.size).toBeGreaterThan(20);
    for (const [shiftId, list] of byShift) {
      expect(atBase(list[0].vehiclePosition)).toBe(true);
      expect(list[0].orderTransmittedMs).toBeGreaterThanOrEqual(shifts.get(shiftId)!.startMs);
    }
  });

  it('the base and where it came from are on the month, and a different origin is a different run', () => {
    expect(plain.provenance.base).toEqual({ lat: BASE.lat, lon: BASE.lon, source: 'saved_point', label: 'Betriebssitz' });
    expect(plain.provenance.returnToBase).toBe(false);
    const derived = run({ baseSource: 'company_address', baseLabel: 'Musterweg 7, 42651 Solingen (Betriebssitz aus der Firmenadresse abgeleitet)' });
    expect(derived.provenance.runId).not.toBe(plain.provenance.runId);
    expect(home.provenance.runId).not.toBe(plain.provenance.runId);
  });

  it('a configured base passes the verdict check; a point of unstated origin leaves the month incomplete', () => {
    expect(verifyMonth(plain).checks.find(c => c.code === 'base_configured')!.outcome).toBe('passed');
    const unstated = run({ baseSource: undefined });
    const check = verifyMonth(unstated).checks.find(c => c.code === 'base_configured')!;
    expect(check.outcome).toBe('not_verified');
    expect(check.detail).toContain('CONFIGURATION_REQUIRED');
    expect(verifyMonth(unstated).verdict).not.toBe('VALIDATED_FOR_EXPORT');
  });
});

describe('class 7: the drive from the base to the first pickup', () => {
  it('is one recorded empty leg per shift, from the base, whose road time and margin the shift spends', () => {
    const shifts = new Map(plain.month.shifts.map(s => [s.id, s]));
    const byShift = completedByShift(plain.month.rides);
    const opening = plain.repositioning.filter(l => l.purpose === 'from_base');
    expect(opening).toHaveLength(byShift.size);
    for (const leg of opening) {
      const first = byShift.get(leg.shiftId)![0];
      expect(leg).toMatchObject({ kind: 'REPOSITIONING', label: 'LEERFAHRT', previousTripId: null, nextTripId: first.tripId });
      expect(atBase(leg.from)).toBe(true);
      expect(pointKey(leg.to)).toBe(pointKey(first.pickup));
      expect(leg.departMs).toBe(shifts.get(leg.shiftId)!.startMs);
      expect(leg.roadKm).not.toBeNull();
      if (!atBase(first.pickup)) expect(leg.roadKm as number).toBeGreaterThan(0);
      // The time is consumed: the ride cannot start before the car has driven there.
      const needed = pickupDriveSeconds(leg.roadSeconds as number, plain.provenance.options);
      expect(first.startMs as number).toBeGreaterThanOrEqual(leg.departMs + needed * 1000);
    }
    expect(plain.repositioningSummary.byPurpose.from_base).toBe(opening.length);
  });

  it('is never a passenger ride: no ride of the month starts at the base on the way out', () => {
    const tripIds = new Set(plain.month.rides.map(r => r.tripId));
    for (const leg of plain.repositioning) expect(tripIds.has(leg.legId)).toBe(false);
  });
});

describe('class 8: repositioning between passenger rides', () => {
  it('every consecutive pair of rides in a shift has a recorded way to the next pickup', () => {
    const byShift = completedByShift(plain.month.rides);
    const toPickup = new Map(plain.repositioning.filter(l => l.purpose === 'to_pickup').map(l => [`${l.previousTripId}>${l.nextTripId}`, l]));
    let pairs = 0;
    for (const list of byShift.values()) {
      for (let i = 1; i < list.length; i += 1) {
        const leg = toPickup.get(`${list[i - 1].tripId}>${list[i].tripId}`);
        expect(leg, `${list[i - 1].tripId} → ${list[i].tripId}`).toBeDefined();
        expect(pointKey(leg!.to)).toBe(pointKey(list[i].pickup));
        pairs += 1;
      }
    }
    expect(pairs).toBeGreaterThan(50);
  });
});

describe('return to the base at shift end (D8: a company setting, off by default)', () => {
  it('off: no shift has a drive home, and a shift ends with its last ride', () => {
    expect(plain.repositioning.filter(l => l.purpose === 'to_base')).toEqual([]);
    expect(plain.repositioningSummary.byPurpose.to_base).toBe(0);
    const byShift = completedByShift(plain.month.rides);
    for (const s of plain.month.shifts) {
      const list = byShift.get(s.id);
      if (list) expect(s.endMs).toBe(list[list.length - 1].endMs);
    }
  });

  it('on: every shift drives home, recorded, inside its planned end, and lasts until the car arrives', () => {
    expect(home.violations).toEqual([]);
    expect(home.provenance.returnToBase).toBe(true);
    const byShift = completedByShift(home.month.rides);
    const legs = new Map(home.repositioning.filter(l => l.purpose === 'to_base').map(l => [l.shiftId, l]));
    let checked = 0;
    for (const s of home.month.shifts) {
      const list = byShift.get(s.id);
      if (!list) continue;
      const last = list[list.length - 1];
      if (atBase(last.dropoff)) { expect(legs.has(s.id)).toBe(false); expect(s.endMs).toBe(last.endMs); continue; }
      const leg = legs.get(s.id)!;
      expect(leg).toMatchObject({ previousTripId: last.tripId, nextTripId: '', departMs: last.endMs });
      expect(pointKey(leg.from)).toBe(pointKey(last.dropoff));
      expect(atBase(leg.to)).toBe(true);
      expect(leg.roadKm as number).toBeGreaterThan(0);
      expect(s.endMs).toBe((last.endMs as number) + (leg.roadSeconds as number) * 1000);
      const needed = emptyDriveSeconds(leg.roadSeconds as number, home.provenance.options);
      expect((last.endMs as number) + needed * 1000).toBeLessThanOrEqual(plannedEnd(s));
      expect(leg.slackSeconds as number).toBeGreaterThanOrEqual(0);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(20);
    expect(legs.size).toBe(checked);
    expect(home.repositioningSummary.byPurpose.to_base).toBe(checked);
  });

  it('the base check names the rule on the verdict', () => {
    expect(verifyMonth(home).checks.find(c => c.code === 'base_configured')!.detail).toContain('Rueckkehr zum Betriebssitz');
  });

  it('negative: a month made without the rule fails it, so the check is not vacuous', () => {
    expect(revalidate(plain, plain.month.shifts, true).some(v => v.includes('ends before the car is back at the base'))).toBe(true);
  });

  it('negative: a shift forged to end at its last drop-off is caught', () => {
    const byShift = completedByShift(home.month.rides);
    const forged = home.month.shifts.map(s => {
      const list = byShift.get(s.id);
      return list ? { ...s, endMs: list[list.length - 1].endMs as number } : s;
    });
    const found = revalidate(home, forged, true).filter(v => v.includes('ends before the car is back at the base'));
    expect(found.length).toBe(home.repositioning.filter(l => l.purpose === 'to_base').length);
    // Without the company's rule the same shifts are lawful: there is no universal return requirement.
    expect(revalidate(home, forged, false).filter(v => v.includes('base'))).toEqual([]);
  });

  it('negative: a planned end that leaves no time for the drive home is caught', () => {
    const byShift = completedByShift(home.month.rides);
    const target = home.repositioning.find(l => l.purpose === 'to_base')!;
    const forged = home.month.shifts.map(s => {
      if (s.id !== target.shiftId) return s;
      const last = byShift.get(s.id)!.at(-1)!;
      return { ...s, plannedEndMs: (last.endMs as number) + 60_000 };
    });
    expect(revalidate(home, forged, true).some(v => v.startsWith(`${target.shiftId}: the drive back to the base and its margin need`))).toBe(true);
  });

  it('negative (class 23): a router with no road home is reported by the check, never read as zero', () => {
    const found = revalidate(home, home.month.shifts, true, NO_WAY_HOME);
    expect(found.some(v => v.includes('no test-no-way-home route from the last drop-off back to the base'))).toBe(true);
  });
});

describe('class 23: where no route exists, nothing is invented', () => {
  it('without the return rule, a missing road home changes nothing', () => {
    const r = run({ travel: NO_WAY_HOME });
    expect(r.month.rides.filter(x => x.status === 'completed').length).toBeGreaterThan(50);
    expect(r.violations).toEqual([]);
  });

  // An empty month passed every other check vacuously and read VALIDATED_FOR_EXPORT until
  // `rides_generated` existed: these two scenarios are why it does.
  it('with the return rule and no road home, no shift is planned that could not get back, and the empty month fails', () => {
    // One driver in February keeps the futile search short.
    const r = run({ travel: NO_WAY_HOME, returnToBase: true, month: 2, drivers: [DRIVERS[0]] });
    expect(r.month.rides.filter(x => x.status === 'completed')).toEqual([]);
    expect(r.refusals.some(x => x.reason === 'shift_produced_no_ride')).toBe(true);
    const v = verifyMonth(r);
    expect(v.checks.find(c => c.code === 'rides_generated')!.outcome).toBe('failed');
    expect(v.verdict).toBe('NOT_VALIDATED');
  });

  it('with no routes at all, the month has no ride and is not validated', () => {
    const r = run({ travel: NO_ROUTES });
    expect(r.month.rides.filter(x => x.status === 'completed')).toEqual([]);
    const v = verifyMonth(r);
    expect(v.checks.find(c => c.code === 'rides_generated')!.detail).toContain('keine berechnete Route');
    expect(v.verdict).toBe('NOT_VALIDATED');
  });

  it('a month with rides passes the check', () => {
    expect(verifyMonth(plain).checks.find(c => c.code === 'rides_generated')!.outcome).toBe('passed');
  });
});
