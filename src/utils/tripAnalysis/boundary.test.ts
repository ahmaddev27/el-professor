/**
 * The hard boundary of the engine: it reads and reports. Every output trip is
 * its input, with the same driver, times, price and currency; nothing is
 * mutated; the result is the same for the same input; and none of the
 * planning functions that move trips between drivers is reachable from here.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { toCents } from '../money';
import { analyzeTrips } from './analyze';
import type { AnalysisShift, AnalysisTrip, TripAnalysisInput } from './types';

const MIN = 60_000;
const base = new Date('2026-08-03T06:00:00').getTime();

function trip(id: string, driver: string | null, vehicle: string | null, startMin: number | null, endMin: number | null, extra: Partial<AnalysisTrip>): AnalysisTrip {
  return {
    id,
    driver_id: driver,
    driver_name: driver,
    vehicle,
    start_ms: startMin === null ? null : base + startMin * MIN,
    end_ms: endMin === null ? null : base + endMin * MIN,
    status: 'completed',
    price: null,
    currency: null,
    source_row: null,
    ...extra,
  };
}

/** Every kind of row at once: overlaps, a cancellation, review rows, odd prices and currencies. */
function mixedInput(): TripAnalysisInput {
  const trips: AnalysisTrip[] = [
    trip('t01', 'd1', 'X', 0, 30, { price: 10.95, currency: 'EUR' }),
    trip('t02', 'd1', 'Y', 20, 40, { price: '20.10', currency: 'EUR' }),
    trip('t03', 'd2', 'X', 25, 50, { price: 0, currency: 'EUR' }),
    trip('t04', 'd2', 'X', 120, 180, { price: -3.5, currency: 'EUR' }),
    trip('t05', 'd1', null, 200, 230, { price: 7, currency: 'USD' }),
    trip('t06', 'd1', 'X', null, null, { status: 'cancelled', price: 6, currency: 'EUR' }),
    trip('t07', null, 'X', 60, 70, { price: 12.5, currency: null }),
    trip('t08', 'd2', 'X', 300, null, { price: '8.40', currency: 'EUR' }),
    trip('t09', 'd3', 'Z', 0, 600, { status: 'unknown', price: 'n/a', currency: 'EUR' }),
    trip('t10', 'd3', 'Z', 700, 650, { price: 1.23, currency: 'CHF' }),
    trip('t11', 'd3', 'Z', 800, 830, { price: 33.33, currency: 'EUR', time_ambiguity: 'dst_ambiguous' }),
  ];
  const shifts: AnalysisShift[] = [
    { id: 's1', driver_id: 'd1', start_ms: base, end_ms: base + 60 * MIN, source: 'test' },
    { id: 's2', driver_id: 'd2', start_ms: base + 100 * MIN, end_ms: base + 90 * MIN, source: 'test' },
  ];
  return {
    trips,
    shifts,
    settings: { blockGapMinutes: 30, travelMarginMinutes: 5 },
    budgets: { d1: { salaryMin: 800, salaryMax: 1000, hourlyRate: 13.9, reservedHours: 5 }, d2: { salaryMax: 1000 } },
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

describe('the engine only reads and reports', () => {
  it('keeps every trip, by id, with its input price and currency', () => {
    const input = mixedInput();
    const result = analyzeTrips(input);
    expect(result.trips).toHaveLength(input.trips.length);
    for (const original of input.trips) {
      const out = result.trips.find(t => t.trip.id === original.id);
      expect(out, original.id).toBeDefined();
      expect(out?.trip).toBe(original);
      expect(out?.trip.price).toBe(original.price);
      expect(out?.trip.currency).toBe(original.currency);
      expect(out?.trip.driver_id).toBe(original.driver_id);
      expect(out?.trip.start_ms).toBe(original.start_ms);
      expect(out?.trip.end_ms).toBe(original.end_ms);
    }
  });

  it('derives price sums in cents, per currency and status, from the trips in each block', () => {
    const input = mixedInput();
    const result = analyzeTrips(input);
    const byId = new Map(input.trips.map(t => [t.id, t]));
    for (const block of result.blocks) {
      const sum = block.tripIds.reduce((cents, id) => cents + toCents(byId.get(id)?.price as number | string), 0);
      expect(block.prices.totals.reduce((s, t) => s + t.totalCents, 0)).toBe(sum);
    }
    const d1 = result.drivers.find(d => d.driverId === 'd1');
    expect(d1?.prices.totals).toEqual([
      { currency: 'EUR', status: 'completed', totalCents: 3105, tripCount: 2 },
      { currency: 'EUR', status: 'cancelled', totalCents: 600, tripCount: 1 },
      { currency: 'USD', status: 'completed', totalCents: 700, tripCount: 1 },
    ]);
    expect(result.drivers.find(d => d.driverId === 'd3')?.prices.unpricedTripIds).toEqual(['t09']);
  });

  it('never writes to its input (it runs on a deep-frozen copy)', () => {
    const input = mixedInput();
    const before = structuredClone(input);
    const frozen = deepFreeze(mixedInput());
    expect(() => analyzeTrips(frozen)).not.toThrow();
    analyzeTrips(input);
    expect(input).toEqual(before);
  });

  it('returns the same result for the same input, whatever the row order', () => {
    const input = mixedInput();
    const first = analyzeTrips(input);
    expect(analyzeTrips(mixedInput())).toEqual(first);

    const shuffled = analyzeTrips({ ...input, trips: [...input.trips].reverse(), shifts: [...(input.shifts ?? [])].reverse() });
    expect(shuffled.blocks).toEqual(first.blocks);
    expect(shuffled.issues).toEqual(first.issues);
    expect(shuffled.drivers).toEqual(first.drivers);
    expect(shuffled.checks).toEqual(first.checks);
    expect(shuffled.counts).toEqual(first.counts);
    expect(shuffled.trips.map(t => t.trip.id)).toEqual(input.trips.map(t => t.id).reverse());
  });

  it('has no field that proposes a new driver, a new time or a move', () => {
    const keys = new Set<string>();
    const walk = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') {
        for (const [key, inner] of Object.entries(value)) {
          keys.add(key);
          walk(inner);
        }
      }
    };
    walk(analyzeTrips(mixedInput()));
    const proposing = [...keys].filter(k => /assign|newDriver|suggest|moved|redistribut|corrected|adjusted|fix/i.test(k));
    expect(proposing).toEqual([]);
  });

  it('reaches none of the planning functions that move trips or hours', () => {
    const forbidden = [
      'assignRegularDriversToVehicleBlocks',
      'assignSurplusBlocksToInhaberWithoutTimeChange',
      'shiftOverlappingInhaberBlocks',
      'assignBlocksPhase3',
      'repairFinalOverlaps',
      'extendShiftsForSalary',
    ];
    const folder = dirname(fileURLToPath(import.meta.url));
    const sources = readdirSync(folder).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    expect(sources.length).toBeGreaterThan(5);
    for (const file of sources) {
      const text = readFileSync(join(folder, file), 'utf8');
      for (const name of forbidden) expect(text.includes(name), `${file} mentions ${name}`).toBe(false);
      // Only these modules outside the folder may be imported: the ride-window resolver, money and the display format.
      const imports = [...text.matchAll(/from '(\.\.\/[^']+)'/g)].map(m => m[1]);
      for (const path of imports) expect(['../planningQualityChecks', '../money', '../../components/ui/format']).toContain(path);
    }
  });
});
