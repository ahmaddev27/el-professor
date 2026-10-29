import { describe, expect, it } from 'vitest';
import { routeChecks, summariseRouteChecks } from './routeCheck';
import type { TravelModel } from './travelModel';
import type { PoolAddress, SimRide } from './types';

const P = (n: number): PoolAddress => ({ label: `Teststraße ${n}, 40210 Demostadt, Deutschland`, lat: 51.1 + n * 0.001, lon: 7.0 });

/** A model with a fixed answer per pair, so every status can be produced on purpose. */
function model(answers: Record<string, number | null>): TravelModel {
  const look = (a: PoolAddress | { lat: number }, b: PoolAddress | { lat: number }) => {
    const k = `${Math.round(((a.lat - 51.1) / 0.001))}>${Math.round(((b.lat - 51.1) / 0.001))}`;
    const s = answers[k];
    return s === undefined || s === null ? null : { seconds: s, km: s / 100 };
  };
  return { source: 'synthetic:test', measured: true, drive: look, ride: look };
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

describe('the route check of a month', () => {
  it('names a fit, a warning, the same address and a pair without a route', () => {
    const rides = [
      ride({ startMs: T(0), endMs: T(10), pickup: P(1), dropoff: P(2) }),
      ride({ startMs: T(15), endMs: T(25), pickup: P(3), dropoff: P(4) }), // 2>3: 5 min gap, 200 s route: fits
      ride({ startMs: T(27), endMs: T(40), pickup: P(5), dropoff: P(6) }), // 4>5: 2 min gap, 300 s route: warning
      ride({ startMs: T(45), endMs: T(50), pickup: P(6), dropoff: P(7) }), // same address
      ride({ startMs: T(60), endMs: T(70), pickup: P(9), dropoff: P(1) }), // 7>9: no route
    ];
    const checks = routeChecks(rides, model({ '2>3': 200, '4>5': 300, '7>9': null }));
    const vehicle = checks.filter(c => c.grouping === 'vehicle').map(c => [c.prevNr, c.nextNr, c.status, c.marginSeconds]);
    expect(vehicle).toEqual([
      [1, 2, 'route_fits', 100],
      [2, 3, 'route_time_warning', -180],
      [3, 4, 'same_address', 300],
      [4, 5, 'unverifiable', null],
    ]);
    expect(checks.every(c => c.source === 'synthetic:test')).toBe(true);
  });

  it('checks the driver as well as the vehicle, and counts a warning once per pair', () => {
    const rides = [
      ride({ startMs: T(0), endMs: T(10), pickup: P(1), dropoff: P(2) }),
      ride({ startMs: T(12), endMs: T(20), pickup: P(3), dropoff: P(4) }),
    ];
    const checks = routeChecks(rides, model({ '2>3': 600 }));
    expect(checks.map(c => c.grouping)).toEqual(['vehicle', 'driver']);
    const summary = summariseRouteChecks(checks);
    expect(summary.byStatus.route_time_warning).toBe(2);
    expect(summary.uniqueWarnings).toBe(1);
    expect(summary.uniquePairs).toBe(1);
  });

  it('never checks a cancelled or declined order, which kept no clock times', () => {
    const rides = [
      ride({ startMs: T(0), endMs: T(10), pickup: P(1), dropoff: P(2) }),
      { ...ride({ startMs: T(11), endMs: T(11), pickup: P(5), dropoff: P(6) }), status: 'declined' as const, startMs: null, endMs: null },
      ride({ startMs: T(30), endMs: T(40), pickup: P(3), dropoff: P(4) }),
    ];
    const checks = routeChecks(rides, model({ '2>3': 100 }));
    expect(checks.map(c => [c.prevNr, c.nextNr])).toEqual([[1, 3], [1, 3]]);
  });
});
