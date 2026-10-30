import { describe, expect, it } from 'vitest';
import { routeChecks, summariseRouteChecks } from './routeCheck';
import type { TravelModel } from './travelModel';
import type { PoolAddress, SimRide } from './types';

const P = (n: number): PoolAddress => ({ label: `Teststraße ${n}, 40210 Demostadt, Deutschland`, lat: 51.1 + n * 0.001, lon: 7.0 });

/** A model with a fixed answer per pair, so every status can be produced on purpose. */
function model(answers: Record<string, number | null>, measured = true): TravelModel {
  const look = (a: PoolAddress | { lat: number }, b: PoolAddress | { lat: number }) => {
    const k = `${Math.round(((a.lat - 51.1) / 0.001))}>${Math.round(((b.lat - 51.1) / 0.001))}`;
    const s = answers[k];
    return s === undefined || s === null ? null : { seconds: s, km: s / 100 };
  };
  return { source: measured ? 'synthetic:test' : 'estimate:test', measured, drive: look, ride: look };
}

let n = 0;
function ride(over: Partial<SimRide> & { startMs: number; endMs: number; pickup: PoolAddress; dropoff: PoolAddress }): SimRide {
  n += 1;
  return {
    shiftId: 'S1', vehicle: { plate: 'XX-TEST-1', type: 'T' }, driver: { id: 'd1', name: 'Fahrer 1' }, status: 'completed',
    orderReceivedMs: over.startMs - 60_000, orderTransmittedMs: over.startMs - 60_000 + n, plannedPickupMs: null,
    vehiclePosition: over.pickup, fare: 10, tip: 0, km: 1, payment: 'App', prebooked: false, ...over,
  };
}

const T = (minutes: number) => Date.UTC(2026, 9, 5, 8, 0) + minutes * 60_000;
const DEFAULT_MARGINS = { repositioningMarginSeconds: 60, repositioningMarginPercent: 15 };
const NO_MARGIN = { repositioningMarginSeconds: 0, repositioningMarginPercent: 0 };

describe('the route check of a month', () => {
  it('names a verified pair, a conflict, the same address and a pair without a route', () => {
    const rides = [
      ride({ startMs: T(0), endMs: T(10), pickup: P(1), dropoff: P(2) }),
      ride({ startMs: T(15), endMs: T(25), pickup: P(3), dropoff: P(4) }), // 2>3: 300 s gap, 150 s road: 278 s needed
      ride({ startMs: T(27), endMs: T(40), pickup: P(5), dropoff: P(6) }), // 4>5: 120 s gap, 300 s road: 450 s needed
      ride({ startMs: T(45), endMs: T(50), pickup: P(6), dropoff: P(7) }), // same address: 105 s needed
      ride({ startMs: T(60), endMs: T(70), pickup: P(9), dropoff: P(1) }), // 7>9: no route
    ];
    const checks = routeChecks(rides, model({ '2>3': 150, '4>5': 300, '7>9': null }), DEFAULT_MARGINS);
    const vehicle = checks.filter(c => c.grouping === 'vehicle')
      .map(c => [c.prevTripId, c.nextTripId, c.status, c.requiredSeconds, c.slackSeconds, c.sameAddress]);
    expect(vehicle).toEqual([
      ['1', '2', 'ROUTE_VERIFIED', 278, 22, false],
      ['2', '3', 'ROUTE_CONFLICT', 450, -330, false],
      ['3', '4', 'ROUTE_VERIFIED', 105, 195, true],
      ['4', '5', 'UNVERIFIABLE', null, null, false],
    ]);
    expect(checks.every(c => c.source === 'synthetic:test')).toBe(true);
  });

  it('holds the gap to road time plus the safety margin, not to road time alone', () => {
    const rides = [
      ride({ startMs: T(0), endMs: T(10), pickup: P(1), dropoff: P(2) }),
      ride({ startMs: T(15), endMs: T(25), pickup: P(3), dropoff: P(4) }), // 300 s gap, 250 s road
    ];
    const answers = { '2>3': 250 };
    expect(routeChecks(rides, model(answers), NO_MARGIN)[0].status).toBe('ROUTE_VERIFIED');
    const strict = routeChecks(rides, model(answers), DEFAULT_MARGINS)[0];
    expect([strict.status, strict.safetyMarginSeconds, strict.requiredSeconds]).toEqual(['ROUTE_CONFLICT', 98, 393]);
  });

  it('never calls an estimated pair verified, and says when even the estimate does not fit', () => {
    const rides = [
      ride({ startMs: T(0), endMs: T(10), pickup: P(1), dropoff: P(2) }),
      ride({ startMs: T(15), endMs: T(25), pickup: P(3), dropoff: P(4) }),
      ride({ startMs: T(26), endMs: T(30), pickup: P(5), dropoff: P(6) }),
      ride({ startMs: T(40), endMs: T(50), pickup: P(8), dropoff: P(9) }),
    ];
    const checks = routeChecks(rides, model({ '2>3': 100, '4>5': 600, '6>8': null }, false), DEFAULT_MARGINS);
    expect(checks.every(c => c.status === 'ESTIMATE_ONLY')).toBe(true);
    expect(checks.filter(c => c.grouping === 'vehicle').map(c => c.estimateFits)).toEqual([true, false, false]);
    const summary = summariseRouteChecks(checks);
    expect(summary.byStatus).toEqual({ ROUTE_VERIFIED: 0, ROUTE_CONFLICT: 0, UNVERIFIABLE: 0, ESTIMATE_ONLY: 6 });
    expect(summary.estimateMisfits).toBe(4);
  });

  it('checks the driver as well as the vehicle, and counts a conflict once per pair', () => {
    const rides = [
      ride({ startMs: T(0), endMs: T(10), pickup: P(1), dropoff: P(2) }),
      ride({ startMs: T(12), endMs: T(20), pickup: P(3), dropoff: P(4) }),
    ];
    const checks = routeChecks(rides, model({ '2>3': 600 }));
    expect(checks.map(c => c.grouping)).toEqual(['vehicle', 'driver']);
    const summary = summariseRouteChecks(checks);
    expect(summary.byStatus.ROUTE_CONFLICT).toBe(2);
    expect(summary.uniqueConflicts).toBe(1);
    expect(summary.uniquePairs).toBe(1);
  });

  it('names rides by their trip id when they carry one, and never checks a cancelled or declined order', () => {
    const rides = [
      ride({ tripId: 'F00001', startMs: T(0), endMs: T(10), pickup: P(1), dropoff: P(2) }),
      { ...ride({ tripId: 'F00002', startMs: T(11), endMs: T(11), pickup: P(5), dropoff: P(6) }), status: 'declined' as const, startMs: null, endMs: null },
      ride({ tripId: 'F00003', startMs: T(30), endMs: T(40), pickup: P(3), dropoff: P(4) }),
    ];
    const checks = routeChecks(rides, model({ '2>3': 100 }));
    expect(checks.map(c => [c.prevTripId, c.nextTripId])).toEqual([['F00001', 'F00003'], ['F00001', 'F00003']]);
  });
});
