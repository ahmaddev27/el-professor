import { describe, expect, it } from 'vitest';
import type { RouteBatchAnswer } from '../../../supabase/functions/_shared/travel-route-core';
import type { StructuredNote } from '../monatsplanungPhase3';
import type { TravelRouter } from '../travelRouting/prefetch';
import { DECLINE_RULE_IDLE_IN_SHIFT, FULL_MONTH_GENERATOR_VERSION, generateFullMonth, validateFullMonth, type FullMonthInput } from './fullMonth';
import { validateRides } from './generator';
import { haversineKm } from './geo';
import { routeChecks, summariseRouteChecks } from './routeCheck';
import { ESTIMATE_TRAVEL_MODEL, buildRoutedMatrix, matrixTravelModel, selectRoutingPoints, type TravelModel } from './travelModel';
import type { PoolAddress } from './types';

/**
 * A month built against a routing service (external audit round 4).
 *
 * The defect, reproduced: the auditor checked our month with a router that is
 * slower than the generator's straight-line model on short urban hops, and 60
 * gaps were too short. Here the "router" is a synthetic one — the line times
 * 1.4 at 15 km/h, slower than the estimate everywhere — so the same thing
 * happens on invented data: built with the estimate and checked with the
 * router, the month has warnings; built with the router, it has none.
 */
const BASE = { lat: 51.12, lon: 7.05 };
const POOL: PoolAddress[] = Array.from({ length: 64 }, (_, i) => ({
  label: `Teststraße ${i + 1}, 40210 Demostadt, Deutschland`,
  lat: 51.1 + Math.floor(i / 8) * 0.006,
  lon: 7.02 + (i % 8) * 0.009,
}));

const slowRouter: TravelRouter = {
  route: async (pairs): Promise<RouteBatchAnswer> => ({
    ok: true,
    dataVersion: null,
    results: pairs.map(p => {
      const km = haversineKm(p.from, p.to) * 1.4;
      return { id: p.id, kind: 'route' as const, durationSeconds: (km / 15) * 3600 + 20, distanceMeters: km * 1000, snapMeters: [2, 2] as const };
    }),
  }),
};

const noSleep = { sleep: async () => {}, now: () => new Date('2026-10-29T10:00:00Z') };

async function routed(): Promise<{ model: TravelModel; pool: PoolAddress[] }> {
  const pool = selectRoutingPoints(POOL, 64);
  const matrix = await buildRoutedMatrix([...pool, BASE], slowRouter, noSleep);
  return { model: matrixTravelModel(matrix), pool };
}

const DRIVERS = [
  { id: '22222222-2222-4222-8222-222222222201', name: 'Fahrer 1' },
  { id: '22222222-2222-4222-8222-222222222202', name: 'Fahrer 2' },
  { id: '22222222-2222-4222-8222-222222222203', name: 'Fahrer 3' },
];
const VEHICLES = [
  { id: '11111111-1111-4111-8111-111111111101', plate: 'XX-TEST-1', type: 'Limousine', tuev_gueltig_bis: '2027-04-30' },
  { id: '11111111-1111-4111-8111-111111111102', plate: 'XX-TEST-2', type: 'Limousine', tuev_gueltig_bis: '2027-04-30' },
];

function input(over: Partial<FullMonthInput>): FullMonthInput {
  return {
    year: 2026, month: 10, base: BASE, pool: POOL, vehicles: VEHICLES, drivers: DRIVERS,
    driverNotesMap: new Map(), seed: 20261029, settings: { declinedRidesEnabled: true }, ...over,
  };
}

function month(over: Partial<FullMonthInput>) {
  const out = generateFullMonth(input(over));
  if (!out.ok) throw new Error(JSON.stringify(out.failure));
  return out.result;
}

describe('the route a gap must hold', () => {
  it('reproduces the audit: built with the estimate, checked with a slower router, gaps are too short', async () => {
    const { model, pool } = await routed();
    const built = month({ pool });
    const checked = summariseRouteChecks(routeChecks(built.month.rides, model));
    expect(checked.uniqueWarnings).toBeGreaterThan(0);
  });

  it('built with the router, every gap of every vehicle and every driver holds the routed drive', async () => {
    const { model, pool } = await routed();
    const built = month({ pool, travel: model });
    expect(built.violations).toEqual([]);
    expect(built.routeSummary.byStatus.route_time_warning).toBe(0);
    expect(built.routeSummary.byStatus.unverifiable).toBe(0);
    expect(built.routeSummary.checks).toBeGreaterThan(200);
    expect(built.provenance.travel).toEqual({ source: 'osrm', measured: true });
    expect(built.provenance.generatorVersion).toBe(FULL_MONTH_GENERATOR_VERSION);
  });

  it('never uses a pair the router could not route', async () => {
    const pool = selectRoutingPoints(POOL, 64);
    const cut = pool[10];
    const router: TravelRouter = {
      route: async pairs => {
        const answer = await slowRouter.route(pairs);
        if (!answer.ok) return answer;
        return {
          ...answer,
          results: answer.results.map((r, n) => {
            const p = pairs[n];
            const touches = [p.from, p.to].some(x => Math.abs(x.lat - cut.lat) < 1e-9 && Math.abs(x.lon - cut.lon) < 1e-9);
            return touches ? { id: r.id, kind: 'unavailable' as const, reason: 'no_route' as const } : r;
          }),
        };
      },
    };
    const model = matrixTravelModel(await buildRoutedMatrix([...pool, BASE], router, noSleep));
    const built = month({ pool, travel: model });
    const used = built.month.rides.filter(r => r.status === 'completed').flatMap(r => [r.pickup.label, r.dropoff.label]);
    expect(used).not.toContain(cut.label);
    expect(validateRides(built.month, BASE, model)).toEqual([]);
  });

  it('a gap shorter than its route is caught by the validator, not only avoided by the builder', async () => {
    const { model, pool } = await routed();
    const built = month({ pool });
    // The estimate-built month, read with the router's model: the validator must object.
    expect(validateRides(built.month, BASE, model).some(v => v.includes('shorter than'))).toBe(true);
  });
});

describe('what a note and a vehicle fact do to a simulated shift', () => {
  const confirmedSick: StructuredNote = {
    id: 'note-confirmed', driver_id: DRIVERS[0].id, note_type: 'sick', note_text: 'krank',
    note_planning_behavior: 'exclude_from_plan', is_full_day: true,
    start_date: '2026-10-05', end_date: '2026-10-11', note_date: '2026-10-04T08:00:00.000Z', start_time: null, end_time: null,
  };
  const assumedSick: StructuredNote = {
    ...confirmedSick, id: 'note-assumed', start_date: null, end_date: null, note_date: '2026-10-20T08:00:00.000Z',
  };

  it('keeps a driver out of every window his confirmed note covers', () => {
    const built = month({ driverNotesMap: new Map([[DRIVERS[0].id, [confirmedSick]]]) });
    const inside = built.month.shifts.filter(s => s.driver.id === DRIVERS[0].id && s.operatingDay >= '2026-10-05' && s.operatingDay <= '2026-10-11');
    expect(inside).toEqual([]);
    expect(built.decisions.some(d => d.outcome === 'excluded' && d.code === 'driver_blocked_by_note' && d.eventRef === 'note-confirmed')).toBe(true);
    expect(built.violations).toEqual([]);
  });

  it('lets a shift run past a note whose window is only the notice date, and says so on its decision', () => {
    const solo = [DRIVERS[0]];
    const built = month({ drivers: solo, vehicles: [VEHICLES[0]], driverNotesMap: new Map([[DRIVERS[0].id, [assumedSick]]]) });
    const onThatDay = built.month.shifts.filter(s => s.operatingDay === '2026-10-20');
    expect(onThatDay.length).toBeGreaterThan(0);
    const decision = built.decisions.find(d => d.day === '2026-10-20' && d.outcome !== 'excluded');
    expect(decision?.outcome).toBe('accepted_with_review');
    expect(decision?.eventRef).toBe('note-assumed');
    expect(decision?.certainty).toBe('assumed_from_notice_date');
  });

  it('keeps a vehicle off the road from the day after its TÜV expired', () => {
    const expiring = [{ ...VEHICLES[0] }, { ...VEHICLES[1], tuev_gueltig_bis: '2026-10-15' }];
    const built = month({ vehicles: expiring });
    const late = built.month.shifts.filter(s => s.vehicle.plate === 'XX-TEST-2' && s.operatingDay > '2026-10-15');
    expect(late).toEqual([]);
    expect(built.month.shifts.some(s => s.vehicle.plate === 'XX-TEST-2' && s.operatingDay <= '2026-10-15')).toBe(true);
    const offDays = new Set(built.decisions.filter(d => d.code === 'vehicle_tuev_expired').map(d => d.day));
    expect(offDays.size).toBe(16);
    expect(built.violations).toEqual([]);
  });

  it('a TÜV shift that slipped through is caught by the validator', () => {
    const built = month({});
    const after = validateFullMonth(built.month, built.period, new Map(), built.provenance.settings, [
      { ...VEHICLES[0], tuev_gueltig_bis: '2026-10-01' },
    ]);
    expect(after.some(v => v.includes('after its TÜV expired'))).toBe(true);
  });
});

describe('declined and cancelled orders', () => {
  it('a declined order names its rule, carries the tenant fee and reaches an idle car', () => {
    const built = month({});
    const declined = built.month.rides.filter(r => r.status === 'declined');
    expect(declined.length).toBeGreaterThan(0);
    for (const r of declined) {
      expect(r.declineRule).toBe(DECLINE_RULE_IDLE_IN_SHIFT);
      expect(r.declinedFeeCents).toBe(600);
      expect([r.fare, r.tip, r.km]).toEqual([0, 0, 0]);
    }
    expect(built.revenue.declinedFeeCents).toBe(declined.length * 600);
    expect(built.violations).toEqual([]);
  });

  it('the validator catches a declined order placed inside a ride', () => {
    const built = month({});
    const ride = built.month.rides.find(r => r.status === 'completed')!;
    const declined = built.month.rides.find(r => r.status === 'declined')!;
    const moved = built.month.rides.map(r => (r === declined ? { ...r, vehicle: ride.vehicle, orderTransmittedMs: (ride.startMs as number) + 1000 } : r));
    const found = validateFullMonth({ ...built.month, rides: moved }, built.period, new Map(), built.provenance.settings);
    expect(found.some(v => v.includes('while it carried a passenger'))).toBe(true);
  });

  it('a cancellation carries no fare and no fee unless the tenant charges one', () => {
    const built = month({ options: { cancellationShare: 0.2 } });
    const cancelled = built.month.rides.filter(r => r.status === 'cancelled');
    expect(cancelled.length).toBeGreaterThan(0);
    expect(cancelled.every(r => r.fare === 0)).toBe(true);
    expect(built.revenue.cancelledFeeCents).toBe(0);
    const charged = month({ options: { cancellationShare: 0.2 }, settings: { declinedRidesEnabled: true, chargeDeclinedFeeOnCancelled: true } });
    expect(charged.revenue.cancelledFeeCents).toBe(charged.revenue.counts.cancelled * 600);
  });

  it('the estimate is still the default, and says it is an estimate', () => {
    const built = month({});
    expect(built.provenance.travel).toEqual({ source: ESTIMATE_TRAVEL_MODEL.source, measured: false });
  });
});
