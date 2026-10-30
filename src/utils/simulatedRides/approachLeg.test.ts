import { describe, expect, it } from 'vitest';
import { validateRides } from './generator';
import { generateFromFigures, addDays, mondaysOfMonth, figuresOf, type FiguresInput, type IncomeRow } from './figures';
import { deadheadSeconds, driveSeconds, haversineKm, roadKm } from './geo';
import { rideDate, ridesToRows } from './sheet';
import { localHour } from './time';
import type { GeneratedMonth, GeoPoint, PoolAddress, SimRide } from './types';

/**
 * The time between two rides of one vehicle. A real export (uber.xlsx, 2377
 * rows) measured on the same proxy: median 17.7 km/h, p95 142, 134 of 2325
 * transitions (5.8 %) over 120 km/h. The generator used to give 49 % over 120.
 * What a ride row leaves out, the approach, is a constraint on time here and
 * never a row; the module header of generator.ts says why.
 */
const BASE: GeoPoint = { lat: 51.1657, lon: 7.0671 };

const gridPool = (cols: number, rows: number, dLat: number, dLon: number): PoolAddress[] =>
  Array.from({ length: cols * rows }, (_, i) => ({
    label: `Teststraße ${i}, 42651 Solingen, Deutschland`,
    lat: 51.1 + Math.floor(i / cols) * dLat,
    lon: 7.0 + (i % cols) * dLon,
  }));

/** About 14 km across: the size of one city's pool. */
const TOWN = gridPool(24, 24, 0.0055, 0.0085);
/** About 90 km across: a pool that reaches the neighbouring cities and the airport. */
const REGION = gridPool(40, 40, 0.02, 0.03);

const NAMES = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];

function incomeFor(year: number, month: number): IncomeRow[] {
  return mondaysOfMonth(year, month).flatMap((monday, w) => NAMES.flatMap((name, d) => {
    const date = addDays(monday, 6);
    const umsatz = 900 + ((w * 7 + d) % 5) * 260 + 0.37 * d;
    return [
      { driver_name: name, type: 'umsatz', date, amount: umsatz },
      { driver_name: name, type: 'bargeld', date, amount: Math.round(umsatz * 0.3 * 100) / 100 },
      { driver_name: name, type: 'trinkgeld', date, amount: 20 + d },
    ];
  }));
}

const input = (over: Partial<FiguresInput> = {}): FiguresInput => ({
  year: 2026,
  month: 9,
  base: BASE,
  pool: TOWN,
  vehicles: [{ plate: 'SG-YA15', type: 'Toyota' }, { plate: 'SG-YA18', type: 'Toyota' }, { plate: 'SG-YA20', type: 'Toyota' }],
  drivers: NAMES.map(name => ({ name })),
  income: incomeFor(2026, 9),
  occupied: new Set(),
  seed: 42,
  ...over,
});

const SEEDS = [11, 42, 77, 123];
const months = (over: Partial<FiguresInput> = {}): GeneratedMonth[] => SEEDS.map(seed => generateFromFigures(input({ seed, ...over })).month);

/**
 * The speed the file itself shows between two consecutive rides of one
 * vehicle: the distance between the two order positions over the time from the
 * first ride's end to the second ride's start. This is the figure measured on
 * the real export (a Zielort has no coordinates in a file, a Standort does).
 */
function impliedSpeeds(list: readonly GeneratedMonth[]): number[] {
  const out: number[] = [];
  for (const month of list) {
    const byPlate = new Map<string, SimRide[]>();
    for (const r of month.rides.filter(x => x.status === 'completed')) byPlate.set(r.vehicle.plate, [...(byPlate.get(r.vehicle.plate) ?? []), r]);
    for (const rides of byPlate.values()) {
      rides.sort((a, b) => a.startMs! - b.startMs!);
      for (let i = 1; i < rides.length; i++) {
        const hours = (rides[i].startMs! - rides[i - 1].endMs!) / 3_600_000;
        if (hours > 0) out.push(haversineKm(rides[i - 1].vehiclePosition, rides[i].vehiclePosition) / hours);
      }
    }
  }
  return out.sort((a, b) => a - b);
}

const quantile = (sorted: readonly number[], p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];

describe('the speed implied between consecutive rides of a vehicle', () => {
  const speeds = impliedSpeeds(months());
  const over120 = speeds.filter(v => v > 120).length / speeds.length;

  it('has enough transitions to mean something', () => {
    expect(speeds.length).toBeGreaterThan(800);
  });

  /**
   * Until round 6 this asserted a floor as well: at least 3 % of transitions
   * over 120 km/h, so the generator would carry the real export's share of
   * nonsense and not be "a tell". Round 6 forbids exactly that: every gap must
   * hold the drive and a safety margin, and the generator prefers short legs.
   * The two cannot both hold, and the audit's rule is the one kept. What stays
   * over 120 is the proxy's own error (it measures from the previous ORDER
   * position, not from where that ride ended), bounded from above.
   * Measured 30.10.2026: 0.7 % (5 to 6 % before).
   */
  it('stays far below the 49 % of the first generator, now that every gap holds its drive and margin', () => {
    expect(over120).toBeLessThan(0.03);
  });

  it('has a city-traffic median and a bounded tail, as the real file does', () => {
    expect(quantile(speeds, 0.5)).toBeGreaterThan(8);
    expect(quantile(speeds, 0.5)).toBeLessThan(35);
    expect(quantile(speeds, 0.95)).toBeLessThan(250);
  });
});

describe('the approach leg is a constraint on time, never a row', () => {
  const all = months();

  it('writes exactly one row per ride', () => {
    for (const month of all) expect(ridesToRows(month.rides)).toHaveLength(month.rides.length);
  });

  it('gives every completed row a passenger ride: a fare and a distance', () => {
    for (const month of all) {
      for (const row of month.rides.filter(r => r.status === 'completed')) {
        expect(row.km).toBeGreaterThan(0);
        expect(row.fare).toBeGreaterThan(0);
        expect(row.startMs! < row.endMs!).toBe(true);
      }
    }
  });

  it('keeps the books to the cent, with the longer gaps', () => {
    for (const seed of SEEDS) {
      const result = generateFromFigures(input({ seed }));
      const read = figuresOf(result.month.rides, rideDate);
      expect(result.explained.length).toBeGreaterThan(20);
      for (const f of result.explained) {
        const got = [...read.values()].find(x => x.driver === f.driver && x.weekMonday === f.weekMonday)!;
        expect(got.umsatz).toBe(f.umsatz);
        expect(got.bargeld).toBe(f.bargeld);
        expect(got.trinkgeld).toBe(f.trinkgeld);
      }
    }
  });

  it('passes the validator that checks both legs', () => {
    for (const month of all) expect(validateRides(month, BASE)).toEqual([]);
  });

  /** The rule itself, restated from the output: Zielort -> Standort -> Abholort fits inside the gap. */
  it('leaves every gap at least as long as the two legs need', () => {
    let after = 0;
    let during = 0;
    for (const month of all) {
      for (const shift of month.shifts) {
        const rides = month.rides.filter(r => r.shiftId === shift.id && r.status === 'completed').sort((a, b) => a.startMs! - b.startMs!);
        for (let i = 1; i < rides.length; i++) {
          const prev = rides[i - 1];
          const next = rides[i];
          const hour = localHour(prev.endMs!);
          const gap = (next.startMs! - prev.endMs!) / 1000;
          if (next.orderTransmittedMs >= prev.endMs!) {
            const legOne = driveSeconds(roadKm(prev.dropoff, next.vehiclePosition), hour);
            const legTwo = deadheadSeconds(roadKm(next.vehiclePosition, next.pickup), hour);
            expect(gap).toBeGreaterThanOrEqual(legOne + legTwo);
            expect((next.orderTransmittedMs - prev.endMs!) / 1000).toBeGreaterThanOrEqual(legOne);
            after++;
          } else {
            expect(gap).toBeGreaterThanOrEqual(deadheadSeconds(roadKm(prev.dropoff, next.pickup), hour));
            during++;
          }
        }
      }
    }
    expect(after).toBeGreaterThan(300);
    expect(during).toBeGreaterThan(100);
  });
});

describe('the validator refuses a Standort the car could not have reached', () => {
  const good = generateFromFigures(input()).month;
  const clone = (m: GeneratedMonth): GeneratedMonth => ({ ...m, shifts: m.shifts.map(s => ({ ...s })), rides: m.rides.map(r => ({ ...r })) });

  it('flags an order position far from the Zielort when the gap is short', () => {
    const bad = clone(good);
    const shift = bad.shifts[0];
    const rides = bad.rides.filter(r => r.shiftId === shift.id && r.status === 'completed').sort((a, b) => a.startMs! - b.startMs!);
    const target = rides.find((r, i) => i > 0 && r.orderTransmittedMs >= rides[i - 1].endMs!)!;
    target.vehiclePosition = { lat: BASE.lat + 0.4, lon: BASE.lon + 0.4 };
    expect(validateRides(bad, BASE).some(v => v.includes('legs'))).toBe(true);
  });
});

describe('the length of a ride', () => {
  const lengths = (list: readonly GeneratedMonth[]): number[] =>
    list.flatMap(m => m.rides.filter(r => r.status === 'completed').map(r => r.km)).sort((a, b) => a - b);

  it('keeps the median and the quartiles of the real export (6.1, 3.4, 11.0)', () => {
    const km = lengths(months({ pool: REGION }));
    expect(quantile(km, 0.5)).toBeGreaterThan(5);
    expect(quantile(km, 0.5)).toBeLessThan(7.5);
    expect(quantile(km, 0.25)).toBeGreaterThan(2.6);
    expect(quantile(km, 0.25)).toBeLessThan(4.4);
    expect(quantile(km, 0.75)).toBeGreaterThan(9);
    expect(quantile(km, 0.75)).toBeLessThan(13.5);
  });

  it('reaches the tail when the pool does: well past the old 24 km ceiling', () => {
    const km = lengths(months({ pool: REGION }));
    expect(km[km.length - 1]).toBeGreaterThan(45);
    expect(km[km.length - 1]).toBeLessThanOrEqual(95 + 0.01);
  });

  it('does not pile the tail onto a small pool\'s edge', () => {
    const km = lengths(months({ pool: TOWN }));
    expect(quantile(km, 0.5)).toBeGreaterThan(4.5);
    expect(quantile(km, 0.5)).toBeLessThan(8);
  });
});
