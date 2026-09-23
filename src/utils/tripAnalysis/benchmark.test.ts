/**
 * A synthetic 10,000-trip month, the size the spec asks to measure. It prints
 * the measured time and heap figures (the PR records them); the only timing
 * assertion is a loose guard against a quadratic regression, so a slow CI
 * machine does not fail the build.
 *
 * Deterministic: a fixed-seed generator, so every run analyses the same data.
 */
import { describe, expect, it } from 'vitest';
import { analyzeTrips } from './analyze';
import type { AnalysisShift, AnalysisTrip, BudgetInput, TravelTimeEstimator, TripStatus } from './types';

const MIN = 60_000;
const TRIPS = 10_000;
const DRIVERS = 20;
const MONTH_START = Date.parse('2026-08-01T00:00:00+02:00');

function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function syntheticMonth() {
  const random = generator(20260922);
  const trips: AnalysisTrip[] = [];
  const shifts: AnalysisShift[] = [];
  const budgets: Record<string, BudgetInput> = {};
  const perDriver = TRIPS / DRIVERS;
  for (let d = 0; d < DRIVERS; d += 1) {
    const driver = `driver-${String(d).padStart(2, '0')}`;
    budgets[driver] = { salaryMin: 800, salaryMax: 1000 + d * 25, hourlyRate: 13.9, reservedHours: d % 3 === 0 ? undefined : 5 };
    let cursor = MONTH_START + Math.floor(random() * 6 * 60) * MIN;
    for (let k = 0; k < perDriver; k += 1) {
      const duration = (5 + Math.floor(random() * 35)) * MIN;
      const roll = random();
      const status: TripStatus = roll < 0.02 ? 'cancelled' : roll < 0.03 ? 'unknown' : 'completed';
      const noEnd = roll > 0.995;
      const id = `trip-${String(trips.length).padStart(5, '0')}`;
      trips.push({
        id,
        driver_id: driver,
        driver_name: `Fahrer ${d}`,
        vehicle: `V${d % 10}`, // two drivers per vehicle, so vehicle overlaps occur
        start_ms: status === 'cancelled' ? null : cursor,
        end_ms: status === 'cancelled' || noEnd ? null : cursor + duration,
        status,
        price: Math.round(random() * 4000) / 100,
        currency: 'EUR',
        source_row: trips.length + 2,
        pickup_address: random() < 0.9 ? `Straße ${Math.floor(random() * 300)}` : null,
        dropoff_address: random() < 0.9 ? `Straße ${Math.floor(random() * 300)}` : null,
      });
      // Mostly short gaps, sometimes a small overlap, sometimes a night off.
      const gapRoll = random();
      const gap = gapRoll < 0.05 ? -3 * MIN : gapRoll < 0.93 ? Math.floor(random() * 45) * MIN : 10 * 60 * MIN;
      cursor += duration + gap;
    }
    for (let day = 0; day < 31; day += 1) {
      const start = MONTH_START + day * 24 * 60 * MIN + (6 + (d % 4)) * 60 * MIN;
      shifts.push({ id: `shift-${driver}-${day}`, driver_id: driver, start_ms: start, end_ms: start + 9 * 60 * MIN, source: 'synthetic' });
    }
  }
  return { trips, shifts, budgets };
}

/** A lookup over invented addresses, standing in for a routing table. */
const tableEstimator: TravelTimeEstimator = {
  source: 'synthetic-table',
  estimate: request => {
    let hash = 0;
    for (const ch of request.fromAddress + request.toAddress) hash = (Math.imul(hash, 31) + ch.charCodeAt(0)) >>> 0;
    return { kind: 'estimated', minutes: hash % 30, source: 'synthetic-table', confidence: 'low' };
  },
};

function heapUsed(): number {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (gc) gc();
  return process.memoryUsage().heapUsed;
}

describe('10,000 trips', () => {
  it('analyses a synthetic month and reports the measured cost', () => {
    const month = syntheticMonth();
    const input = { ...month, settings: { blockGapMinutes: 30, travelMarginMinutes: 2 }, travelEstimator: tableEstimator };

    analyzeTrips(input); // warm-up: JIT and the Intl formatter caches
    const timings: number[] = [];
    for (let run = 0; run < 3; run += 1) {
      const started = performance.now();
      analyzeTrips(input);
      timings.push(performance.now() - started);
    }
    const heapBefore = heapUsed();
    const result = analyzeTrips(input);
    const heapRetained = heapUsed() - heapBefore;

    expect(result.counts.rows).toBe(TRIPS);
    expect(result.trips).toHaveLength(TRIPS);
    expect(result.counts.analysed + result.counts.byStatus.cancelled + result.counts.needsReview).toBeGreaterThanOrEqual(TRIPS);
    expect(result.issues.some(i => i.type === 'driver_overlap')).toBe(true);
    expect(result.issues.some(i => i.type === 'vehicle_overlap')).toBe(true);
    expect(Math.max(...timings)).toBeLessThan(15_000);

    const sorted = [...timings].sort((a, b) => a - b);
    console.log(
      `[trip-analysis benchmark] ${TRIPS} trips, ${month.shifts.length} shifts, ${DRIVERS} drivers: ` +
        `runs ${timings.map(t => t.toFixed(0)).join(' / ')} ms (median ${sorted[1].toFixed(0)} ms), ` +
        `result retained ≈ ${(heapRetained / 1024 / 1024).toFixed(1)} MiB heap` +
        `${(globalThis as { gc?: unknown }).gc ? '' : ' (no --expose-gc: heap figure approximate)'}, ` +
        `${result.blocks.length} blocks, ${result.issues.length} findings; node ${process.version} ${process.platform}/${process.arch}`,
    );
  });
});
