import { describe, expect, it } from 'vitest';
import { generateMonth, validateRides, SHIFT_LIMITS } from './generator';
import { minTravelSeconds } from './geo';
import { localHour, operatingDayOf } from './time';
import type { GeneratedMonth, GeneratorInput, GeoPoint, PoolAddress } from './types';

const BASE: GeoPoint = { lat: 51.1657, lon: 7.0671 };

/** 24 x 24 addresses about 0.6 km apart: a town of roughly 14 km across. */
const POOL: PoolAddress[] = Array.from({ length: 576 }, (_, i) => ({
  label: `Teststraße ${i}, 42651 Solingen, Deutschland`,
  lat: 51.1 + Math.floor(i / 24) * 0.0055,
  lon: 7.0 + (i % 24) * 0.0085,
}));

const input = (over: Partial<GeneratorInput> = {}): GeneratorInput => ({
  year: 2026,
  month: 9,
  base: BASE,
  pool: POOL,
  vehicles: [{ plate: 'SG-YA15', type: 'Toyota' }, { plate: 'SG-YA18', type: 'Toyota' }, { plate: 'SG-YA20', type: 'Toyota' }],
  drivers: ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map(name => ({ name })),
  seed: 42,
  ...over,
});

describe('generateMonth', () => {
  const month = generateMonth(input());

  it('produces a month, and the same one for the same seed', () => {
    expect(month.rides.length).toBeGreaterThan(300);
    expect(generateMonth(input()).rides).toEqual(month.rides);
    expect(generateMonth(input({ seed: 43 })).rides).not.toEqual(month.rides);
  });

  it('passes its own validator', () => {
    expect(validateRides(month, BASE)).toEqual([]);
  });

  it('keeps every shift between 4 and 6 hours', () => {
    for (const s of month.shifts) {
      const minutes = (s.endMs - s.startMs) / 60_000;
      expect(minutes).toBeGreaterThanOrEqual(SHIFT_LIMITS.minMinutes);
      expect(minutes).toBeLessThanOrEqual(SHIFT_LIMITS.maxMinutes);
    }
  });

  it('puts at most 3 shifts of a vehicle into one operating day, and uses 3 sometimes', () => {
    const counts = new Map<string, number>();
    for (const s of month.shifts) counts.set(`${s.vehicle.plate}|${s.operatingDay}`, (counts.get(`${s.vehicle.plate}|${s.operatingDay}`) ?? 0) + 1);
    expect(Math.max(...counts.values())).toBe(3);
  });

  it('never lets a ride overlap another one of the same shift', () => {
    for (const s of month.shifts) {
      const rides = month.rides.filter(r => r.shiftId === s.id && r.status === 'completed').sort((a, b) => a.startMs! - b.startMs!);
      rides.forEach((r, i) => { if (i > 0) expect(r.startMs!).toBeGreaterThanOrEqual(rides[i - 1].endMs!); });
    }
  });

  it('derives every gap from the distance: never shorter than the drive, at most 40 s longer', () => {
    let pairs = 0;
    for (const s of month.shifts) {
      const rides = month.rides.filter(r => r.shiftId === s.id && r.status === 'completed').sort((a, b) => a.startMs! - b.startMs!);
      for (let i = 1; i < rides.length; i++) {
        const gap = (rides[i].startMs! - rides[i - 1].endMs!) / 1000;
        const needed = minTravelSeconds(rides[i - 1].dropoff, rides[i].pickup, localHour(rides[i - 1].endMs!));
        expect(gap).toBeGreaterThanOrEqual(needed);
        expect(gap).toBeLessThanOrEqual(needed + 40);
        pairs++;
      }
    }
    expect(pairs).toBeGreaterThan(200);
  });

  it('starts the first ride of every shift from the base', () => {
    for (const s of month.shifts) {
      const first = month.rides.filter(r => r.shiftId === s.id).sort((a, b) => a.orderTransmittedMs - b.orderTransmittedMs)[0];
      expect(first.vehiclePosition).toEqual(BASE);
    }
  });

  it('lets no vehicle and no driver be in two shifts at once, and rests drivers', () => {
    expect(validateRides(month, BASE).filter(v => v.includes('overlap'))).toEqual([]);
    const byDriver = new Map<string, typeof month.shifts>();
    for (const s of month.shifts) byDriver.set(s.driver.name, [...(byDriver.get(s.driver.name) ?? []), s]);
    for (const list of byDriver.values()) {
      const sorted = [...list].sort((a, b) => a.startMs - b.startMs);
      sorted.forEach((s, i) => { if (i > 0) expect(s.startMs - sorted[i - 1].endMs).toBeGreaterThanOrEqual(11 * 3_600_000); });
    }
  });

  it('keeps cancellations plausible and without clock times', () => {
    const cancelled = month.rides.filter(r => r.status === 'cancelled');
    expect(cancelled.length / month.rides.length).toBeGreaterThan(0.005);
    expect(cancelled.length / month.rides.length).toBeLessThan(0.05);
    for (const r of cancelled) {
      expect(r.startMs).toBeNull();
      expect(r.km).toBe(0);
    }
  });

  it('gives every order its own transmission instant', () => {
    expect(new Set(month.rides.map(r => r.orderTransmittedMs)).size).toBe(month.rides.length);
  });

  it('dates a ride by its operating day, so a ride just after midnight belongs to the day before', () => {
    const late = month.rides.find(r => r.startMs !== null && localHour(r.startMs) < 4);
    expect(late).toBeDefined();
    const shift = month.shifts.find(s => s.id === late!.shiftId)!;
    expect(operatingDayOf(late!.startMs!)).toBe(shift.operatingDay);
  });

  it('writes nothing when it has no pool, no vehicle or no driver', () => {
    expect(generateMonth(input({ pool: POOL.slice(0, 3) })).rides).toEqual([]);
    expect(generateMonth(input({ vehicles: [] })).rides).toEqual([]);
    expect(generateMonth(input({ drivers: [] })).rides).toEqual([]);
  });

  it('survives the October clock change without a clock reading that names two instants', () => {
    const october = generateMonth(input({ month: 10 }));
    expect(october.rides.length).toBeGreaterThan(100);
    expect(validateRides(october, BASE)).toEqual([]);
  });
});

// ── Negative controls: the validator must notice a broken month ─────────────

function clone(m: GeneratedMonth): GeneratedMonth {
  return { ...m, shifts: m.shifts.map(s => ({ ...s })), rides: m.rides.map(r => ({ ...r })) };
}

describe('validateRides (negative controls)', () => {
  const good = generateMonth(input());

  it('flags a gap shorter than the distance allows', () => {
    const bad = clone(good);
    const shift = bad.shifts[0];
    const rides = bad.rides.filter(r => r.shiftId === shift.id && r.status === 'completed').sort((a, b) => a.startMs! - b.startMs!);
    // Pull the second ride five seconds after the first one ended.
    const shift2 = rides[1].endMs! - rides[1].startMs!;
    rides[1].startMs = rides[0].endMs! + 5_000;
    rides[1].endMs = rides[1].startMs + shift2;
    expect(validateRides(bad, BASE).some(v => v.includes('shorter than'))).toBe(true);
  });

  it('flags overlapping rides', () => {
    const bad = clone(good);
    const rides = bad.rides.filter(r => r.shiftId === bad.shifts[0].id && r.status === 'completed').sort((a, b) => a.startMs! - b.startMs!);
    rides[1].startMs = rides[0].endMs! - 60_000;
    expect(validateRides(bad, BASE).some(v => v.includes('overlap'))).toBe(true);
  });

  it('flags a shift of three hours and one of seven', () => {
    const short = clone(good);
    short.shifts[0].endMs = short.shifts[0].startMs + 180 * 60_000;
    expect(validateRides(short, BASE).some(v => v.includes('outside'))).toBe(true);
    const long = clone(good);
    long.shifts[0].endMs = long.shifts[0].startMs + 420 * 60_000;
    expect(validateRides(long, BASE).some(v => v.includes('outside'))).toBe(true);
  });

  it('flags a fourth shift of one vehicle in one operating day', () => {
    const bad = clone(good);
    const s = bad.shifts[0];
    for (let i = 0; i < 3; i++) bad.shifts.push({ ...s, id: `X${i}`, driver: { name: `Z${i}` }, startMs: s.endMs + (i + 1) * 36_000_000, endMs: s.endMs + (i + 1) * 36_000_000 + 280 * 60_000 });
    expect(validateRides(bad, BASE).some(v => v.includes('shifts in one operating day'))).toBe(true);
  });

  it('flags a first ride that does not start from the base', () => {
    const bad = clone(good);
    const first = bad.rides.filter(r => r.shiftId === bad.shifts[0].id).sort((a, b) => a.orderTransmittedMs - b.orderTransmittedMs)[0];
    first.vehiclePosition = { lat: 52, lon: 8 };
    expect(validateRides(bad, BASE).some(v => v.includes('does not start from the base'))).toBe(true);
  });

  it('flags a driver in two places at once', () => {
    const bad = clone(good);
    const other = bad.shifts.find(s => s.vehicle.plate !== bad.shifts[0].vehicle.plate)!;
    other.driver = bad.shifts[0].driver;
    other.startMs = bad.shifts[0].startMs + 600_000;
    other.endMs = other.startMs + 280 * 60_000;
    expect(validateRides(bad, BASE).some(v => v.includes('overlap'))).toBe(true);
  });
});
