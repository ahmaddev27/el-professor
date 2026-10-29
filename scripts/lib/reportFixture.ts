import type { RouteBatchAnswer } from '../../supabase/functions/_shared/travel-route-core';
import type { StructuredNote } from '../../src/utils/monatsplanungPhase3';
import type { TravelRouter } from '../../src/utils/travelRouting/prefetch';
import { generateFullMonth, type FullMonthInput, type FullMonthResult } from '../../src/utils/simulatedRides/fullMonth';
import { haversineKm } from '../../src/utils/simulatedRides/geo';
import { buildRoutedMatrix, matrixTravelModel, selectRoutingPoints } from '../../src/utils/simulatedRides/travelModel';
import type { PoolAddress } from '../../src/utils/simulatedRides/types';

/**
 * An invented month for the report's tests and for the committed fixture of the
 * export service. The repository is public, so nothing here is real: the pool is
 * "Teststraße N, 40210 Demostadt", the drivers "Fahrer 1..3", the plates
 * `XX-TEST-n`. It is not imported by the app.
 */
export const FIXTURE_BASE = { lat: 51.12, lon: 7.05 };

export const FIXTURE_POOL: PoolAddress[] = Array.from({ length: 64 }, (_, i) => ({
  label: `Teststraße ${i + 1}, 40210 Demostadt, Deutschland`,
  lat: 51.1 + Math.floor(i / 8) * 0.006,
  lon: 7.02 + (i % 8) * 0.009,
}));

export const FIXTURE_DRIVERS = [
  // Weekdays only for the first two, so every weekend is a day with no ride.
  { id: '22222222-2222-4222-8222-222222222201', name: 'Fahrer 1', allowed_weekdays: [1, 2, 3, 4, 5] },
  { id: '22222222-2222-4222-8222-222222222202', name: 'Fahrer 2', allowed_weekdays: [1, 2, 3, 4, 5] },
  { id: '22222222-2222-4222-8222-222222222203', name: 'Fahrer 3', allowed_weekdays: [1, 2, 3, 4, 5] },
];

/** A router slower than the generator's own estimate, so the routed model is the binding one. */
export const SLOW_ROUTER: TravelRouter = {
  route: async (pairs): Promise<RouteBatchAnswer> => ({
    ok: true,
    dataVersion: null,
    results: pairs.map(p => {
      const km = haversineKm(p.from, p.to) * 1.4;
      return { id: p.id, kind: 'route' as const, durationSeconds: (km / 15) * 3600 + 20, distanceMeters: km * 1000, snapMeters: [2, 2] as const };
    }),
  }),
};

export function fixtureNotes(year: number, month: number): Map<string, StructuredNote[]> {
  const mm = String(month).padStart(2, '0');
  const base = {
    driver_id: FIXTURE_DRIVERS[0].id, note_type: 'sick', note_planning_behavior: 'exclude_from_plan' as const,
    is_full_day: true, start_time: null, end_time: null,
  };
  const confirmed: StructuredNote = {
    ...base, id: 'note-confirmed', note_text: 'krank', start_date: `${year}-${mm}-05`, end_date: `${year}-${mm}-09`,
    note_date: `${year}-${mm}-04T08:00:00.000Z`,
  };
  // No window of its own, only the notice date: logged for review, never a block.
  const unconfirmed: StructuredNote = {
    ...base, id: 'note-unconfirmed', driver_id: FIXTURE_DRIVERS[1].id, note_text: 'krank gemeldet',
    start_date: null, end_date: null, note_date: `${year}-${mm}-14T08:00:00.000Z`,
  };
  return new Map([[confirmed.driver_id, [confirmed]], [unconfirmed.driver_id, [unconfirmed]]]);
}

export interface FixtureOptions {
  year: number;
  month: number;
  seed: number;
  vehicles?: number;
  /** Share declined fee and monthly share on, as the owner's decisions 3 and 4 ask. */
  settings?: FullMonthInput['settings'];
}

/** Builds the month with a routed model; throws when generation fails. */
export async function buildFixtureMonth(o: FixtureOptions): Promise<FullMonthResult> {
  const pool = selectRoutingPoints(FIXTURE_POOL, 64);
  const matrix = await buildRoutedMatrix([...pool, FIXTURE_BASE], SLOW_ROUTER, {
    sleep: async () => {}, now: () => new Date('2026-10-29T10:00:00Z'),
  });
  const plates = Array.from({ length: o.vehicles ?? 2 }, (_, i) => ({
    id: `11111111-1111-4111-8111-1111111111${String(i + 1).padStart(2, '0')}`,
    plate: `XX-TEST-${i + 1}`,
    type: 'Limousine',
    // The second vehicle's TÜV ran out mid-month: an expired one is a hard block for those days.
    tuev_gueltig_bis: i === 1 ? `${o.year}-${String(o.month).padStart(2, '0')}-20` : `${o.year + 1}-04-30`,
  }));
  const out = generateFullMonth({
    year: o.year, month: o.month, base: FIXTURE_BASE, pool, vehicles: plates, drivers: FIXTURE_DRIVERS,
    driverNotesMap: fixtureNotes(o.year, o.month), seed: o.seed,
    settings: { declinedRidesEnabled: true, declinedFeeCents: 600, monthlyRevenueShareEnabled: true, ...o.settings },
    options: { cancellationShare: 0.1 },
    travel: matrixTravelModel(matrix),
    routing: {
      points: matrix.points.length,
      routedPairs: Object.keys(matrix.legs).length,
      failedPairs: Object.keys(matrix.failures).length,
      failuresByReason: {},
      computedAt: matrix.computedAt,
    },
  });
  if (!out.ok) throw new Error(`generation failed: ${JSON.stringify(out.failure)}`);
  return out.result;
}
