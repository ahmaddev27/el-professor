import type { RouteBatchAnswer } from '../../supabase/functions/_shared/travel-route-core';
import type { StructuredNote } from '../../src/utils/monatsplanungPhase3';
import type { TravelRouter } from '../../src/utils/travelRouting/prefetch';
import { generateFullMonth, type FullMonthInput, type FullMonthResult } from '../../src/utils/simulatedRides/fullMonth';
import { haversineKm } from '../../src/utils/simulatedRides/geo';
import { buildRoutedMatrix, matrixTravelModel, selectRoutingPoints } from '../../src/utils/simulatedRides/travelModel';
import type { PoolAddress } from '../../src/utils/simulatedRides/types';
import { noRealTrips, readRealTrips, type RealTripsRead, type RealTripRow } from '../../src/utils/simulatedRides/realTrips';
import type { ReconcileUber } from '../../src/utils/simulatedRides/reconciliation';
import type { UberDriverDay, UberFigures, UberPeriodTotal } from '../../src/utils/simulatedRides/uberImport';

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
  { id: '22222222-2222-4222-8222-222222222201', name: 'Fahrer 1', allowed_weekdays: [1, 2, 3, 4, 5], planning_min_salary: 600, planning_max_salary: 1200, planning_hourly_rate: 13 },
  { id: '22222222-2222-4222-8222-222222222202', name: 'Fahrer 2', allowed_weekdays: [1, 2, 3, 4, 5], planning_min_salary: 600, planning_max_salary: 1200, planning_hourly_rate: 13 },
  { id: '22222222-2222-4222-8222-222222222203', name: 'Fahrer 3', allowed_weekdays: [1, 2, 3, 4, 5], planning_min_salary: 600, planning_max_salary: 1200, planning_hourly_rate: 13 },
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
  options?: FullMonthInput['options'];
  /** Round 8: anything else of the month's input (Uber, real trips, share, return to base). */
  extra?: Partial<FullMonthInput>;
}

/** An invented company id: the fixture is no real tenant. */
export const FIXTURE_TENANT_ID = '00000000-0000-4000-8000-00000000f1b0';

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
    year: o.year, month: o.month, base: FIXTURE_BASE, baseSource: 'saved_point', realTrips: noRealTrips(), pool, vehicles: plates, drivers: FIXTURE_DRIVERS,
    driverNotesMap: fixtureNotes(o.year, o.month), seed: o.seed,
    settings: {
      declinedRidesEnabled: true, declinedFeeCents: 600, cancellationFeeEnabled: true, cancellationFeeCents: 600,
      monthlyRevenueShareEnabled: true, ...o.settings,
    },
    options: { cancellationShare: 0.1, ...o.options },
    tenantId: FIXTURE_TENANT_ID,
    ...o.extra,
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

// ── Round 8: the Monatsabschluss's month ─────────────────────────────────────

const figures = (over: Partial<UberFigures>): UberFigures =>
  ({ umsatzCents: 0, aktionenCents: 0, trinkgeldCents: 0, bargeldCents: 0, tripCount: null, ...over });

/**
 * Invented daily Uber figures for the three fixture drivers on every weekday,
 * except Fahrer 2's last week, which comes as one week running into the next
 * month and so is never counted inside it.
 */
export function fixtureUber(year: number, month: number): ReconcileUber {
  const mm = String(month).padStart(2, '0');
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const days: UberDriverDay[] = [];
  for (let d = 1; d <= last; d++) {
    const weekday = new Date(Date.UTC(year, month - 1, d)).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    const date = `${year}-${mm}-${String(d).padStart(2, '0')}`;
    FIXTURE_DRIVERS.forEach((driver, k) => {
      if (k === 1 && d >= last - 5) return;
      days.push({
        driverId: driver.id, driverName: driver.name, date, identity: 'partner_link', rowIds: [`uber-${k}-${date}`],
        negativeTypes: [], overlapsPeriod: false,
        figures: figures({ umsatzCents: 14_000 + d * 53 + k * 917, aktionenCents: k === 0 ? 400 : 0, trinkgeldCents: d % 3 === 0 ? 0 : 150 + d * 9 + k, tripCount: 8 }),
      });
    });
  }
  const next = new Date(Date.UTC(year, month, 1));
  const period: UberPeriodTotal = {
    driverId: FIXTURE_DRIVERS[1].id, driverName: FIXTURE_DRIVERS[1].name,
    periodStart: `${year}-${mm}-${String(last - 5).padStart(2, '0')}`,
    periodEnd: `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-01`,
    days: 7, placement: 'crosses_month_boundary', identity: 'partner_link', rowIds: ['uber-week-boundary'],
    negativeTypes: [], overlappingDailyDates: [], figures: figures({ umsatzCents: 65_000, trinkgeldCents: 800 }),
  };
  return { days, periods: [period], handRows: [], issues: [] };
}

/** Fahrer 3 drove for real on the 10th: two rides, one cancelled, one order declined. */
export function fixtureRealTrips(year: number, month: number): RealTripsRead {
  const day = `${year}-${String(month).padStart(2, '0')}-10`;
  const driver = FIXTURE_DRIVERS[2];
  const row = (id: string, startUtc: string, endUtc: string, over: Partial<RealTripRow> = {}): RealTripRow => ({
    id, import_id: 'import-fixture', trip_date: day, start_at: `${day}T${startUtc}Z`, end_at: `${day}T${endUtc}Z`,
    start_time: null, end_time: null, original_driver_id: driver.id, original_driver_name: driver.name, car_identifier: 'XX-TEST-1',
    route_start: 'Teststraße 3, 40210 Demostadt', route_end: 'Teststraße 11, 40210 Demostadt', price_amount: '12.40', tip_amount: '1.00',
    cash_amount: '0.00', online_amount: '12.40', action_amount: '0.00', is_canceled: false, trip_status: 'completed',
    declined_fee_cents: null, source_row_key: `fixture:${id}`, is_simulated: false, ...over,
  });
  return readRealTrips({
    year, month, timeZone: 'Europe/Berlin', operatingDayStartHour: 4,
    drivers: FIXTURE_DRIVERS.map(d => ({ id: d.id, name: d.name })),
    rows: [
      row('real-1', '07:00:00', '07:22:00'),
      row('real-2', '08:05:00', '08:41:00', { price_amount: '23.90', tip_amount: '0.00' }),
      row('real-3', '10:00:00', '10:15:00', { is_canceled: true, trip_status: 'cancelled', price_amount: '5.00', tip_amount: '0.00' }),
      row('real-4', '12:00:00', '12:00:00', { trip_status: 'declined', price_amount: '0.00', tip_amount: '0.00', declined_fee_cents: 600 }),
    ],
  });
}

/** The closing's month: return to the base on, a fixed share, Uber and real trips read; Fahrer 1 alone has a rate. */
export function closingExtra(year: number, month: number): Partial<FullMonthInput> {
  return {
    returnToBase: true,
    shareSetting: { mode: 'fixed', percent: 32 },
    uber: fixtureUber(year, month),
    realTrips: fixtureRealTrips(year, month),
    drivers: FIXTURE_DRIVERS.map((d, k) => (k === 0 ? { ...d, salary_ratio: 0.45 } : d)),
  };
}
