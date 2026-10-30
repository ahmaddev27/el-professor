import { describe, expect, it } from 'vitest';
import type { GeocodeBatchAnswer, GeocodeResult } from '../../../supabase/functions/_shared/geocode-core';
import type { RouteBatchAnswer } from '../../../supabase/functions/_shared/travel-route-core';
import type { GeocodeClient } from '../../lib/geocodeClient';
import { prepareRouting } from '../../lib/simulationRouting';
import type { StructuredNote } from '../monatsplanungPhase3';
import type { TravelRouter } from '../travelRouting/prefetch';
import { generateFullMonth, validateFullMonth, type FullMonthInput, type FullMonthResult } from './fullMonth';
import { DEFAULT_OPTIONS, SHIFT_LIMITS } from './generator';
import { haversineKm, PICKUP_HANDLING_SECONDS } from './geo';
import { SHEET_RIDES, buildMonthReport } from './monthWorkbook';
import { verifyMonth } from './monthVerification';
import { SHEET_DECLINED_INTERNAL, SHEET_LEGS, buildOperationalReport } from './operationalReport';
import { isPreferredLeg, pickupDriveSeconds, safetyMarginSeconds } from './repositioning';
import { ESTIMATE_TRAVEL_MODEL, buildRoutedMatrix, matrixTravelModel, pointKey, selectRoutingPoints, type TravelModel } from './travelModel';
import type { GeoPoint, PoolAddress } from './types';

/**
 * The acceptance tests of external audit round 6, one block per item of the
 * assignment. Invented data only: public repository, no real person, plate or
 * address. A "router" here is a function of the two points, so each test says
 * exactly what the service would answer.
 */

const BASE: GeoPoint = { lat: 51.12, lon: 7.05 };
const POOL: PoolAddress[] = Array.from({ length: 64 }, (_, i) => ({
  label: `Teststraße ${i + 1}, 40210 Demostadt, Deutschland`,
  lat: 51.1 + Math.floor(i / 8) * 0.006,
  lon: 7.02 + (i % 8) * 0.009,
}));
const DRIVERS = [
  { id: '22222222-2222-4222-8222-222222222201', name: 'Fahrer 1' },
  { id: '22222222-2222-4222-8222-222222222202', name: 'Fahrer 2' },
  { id: '22222222-2222-4222-8222-222222222203', name: 'Fahrer 3' },
];
const VEHICLES = [
  { id: '11111111-1111-4111-8111-111111111101', plate: 'XX-TEST-1', type: 'Limousine', tuev_gueltig_bis: '2027-04-30' },
  { id: '11111111-1111-4111-8111-111111111102', plate: 'XX-TEST-2', type: 'Limousine', tuev_gueltig_bis: '2027-04-30' },
];
const TENANT = '00000000-0000-4000-8000-0000000000aa';
const noSleep = { sleep: async () => {}, now: () => new Date('2026-10-30T10:00:00Z') };

/** A router whose drive time is the straight line at a city speed, plus a fixed part. */
const lineRouter = (kmh = 18, extra = 20): TravelRouter => ({
  route: async (pairs): Promise<RouteBatchAnswer> => ({
    ok: true,
    dataVersion: null,
    results: pairs.map(p => {
      const km = haversineKm(p.from, p.to) * 1.35;
      return { id: p.id, kind: 'route' as const, durationSeconds: (km / kmh) * 3600 + extra, distanceMeters: km * 1000, snapMeters: [2, 2] as const };
    }),
  }),
});

/** A router that answers every pair with the same drive time. */
const constantRouter = (seconds: number): TravelRouter => ({
  route: async (pairs): Promise<RouteBatchAnswer> => ({
    ok: true,
    dataVersion: null,
    results: pairs.map(p => ({ id: p.id, kind: 'route' as const, durationSeconds: seconds, distanceMeters: seconds * 8, snapMeters: [2, 2] as const })),
  }),
});

async function modelOf(router: TravelRouter, pool = POOL): Promise<{ model: TravelModel; pool: PoolAddress[] }> {
  const points = selectRoutingPoints(pool, 64);
  const matrix = await buildRoutedMatrix([...points, BASE], router, noSleep);
  return { model: matrixTravelModel(matrix), pool: points };
}

const input = (over: Partial<FullMonthInput>): FullMonthInput => ({
  year: 2026, month: 9, base: BASE, pool: POOL, vehicles: VEHICLES, drivers: DRIVERS, driverNotesMap: new Map(),
  seed: 20261030, tenantId: TENANT,
  settings: { declinedRidesEnabled: true, cancellationFeeEnabled: true, cancellationFeeCents: 600, monthlyRevenueShareEnabled: true },
  options: { cancellationShare: 0.06 },
  ...over,
});

function month(over: Partial<FullMonthInput>): FullMonthResult {
  const out = generateFullMonth(input(over));
  if (!out.ok) throw new Error(JSON.stringify(out.failure));
  return out.result;
}

const minutes = (ms: number) => ms / 60_000;

/** A stable number per ordered pair of points, so a test can pick pairs without picking points. */
function pairHash(a: GeoPoint, b: GeoPoint): number {
  const text = `${a.lat.toFixed(6)},${a.lon.toFixed(6)}>${b.lat.toFixed(6)},${b.lon.toFixed(6)}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h;
}

// ── 1. Repositioning legs of 2, 5 and 15 minutes, and one with too little time ──

describe('the scheduling rule: road time, handling and the margin, never less', () => {
  it.each([
    [120, 60 + 18],
    [300, 60 + 45],
    [900, 60 + 135],
  ])('a leg of %i s gets a margin of %i s and needs road + 45 s + margin', (road, margin) => {
    expect(safetyMarginSeconds(road, DEFAULT_OPTIONS)).toBe(margin);
    expect(pickupDriveSeconds(road, DEFAULT_OPTIONS)).toBe(road + PICKUP_HANDLING_SECONDS + margin);
  });

  it('prefers two to five minutes, and calls nothing outside that window preferred', () => {
    expect([119, 120, 300, 301, 900].map(isPreferredLeg)).toEqual([false, true, true, false, false]);
  });

  it.each([120, 300, 900])('a month whose every drive takes %i s keeps that drive and its margin on every leg', async seconds => {
    const { model, pool } = await modelOf(constantRouter(seconds));
    const built = month({ pool, travel: model });
    expect(built.violations).toEqual([]);
    expect(built.repositioning.length).toBeGreaterThan(50);
    for (const leg of built.repositioning) {
      // Never shortened, never sped up: the leg is the router's own answer.
      expect(leg.roadSeconds === 0 || leg.roadSeconds === seconds, leg.legId).toBe(true);
      expect(leg.slackSeconds!, leg.legId).toBeGreaterThanOrEqual(0);
      expect(leg.verificationStatus).toBe('ROUTE_VERIFIED');
    }
    const driven = built.repositioning.filter(l => l.roadSeconds === seconds);
    expect(driven.every(l => l.preferredWindow === isPreferredLeg(seconds))).toBe(true);
    expect(verifyMonth(built).checks.find(c => c.code === 'repositioning')!.outcome).toBe('passed');
  });

  it('draws pickups two to five minutes away when the pool has them (measured: 100 %, 83 % without the preference)', async () => {
    const { model, pool } = await modelOf(lineRouter());
    const built = month({ pool, travel: model });
    const driven = built.repositioning.filter(l => l.purpose !== 'to_waiting_position' && (l.roadSeconds ?? 0) > 0);
    expect(driven.length).toBeGreaterThan(300);
    expect(driven.filter(l => l.preferredWindow).length / driven.length).toBeGreaterThan(0.95);
  });

  it('with too little time for any drive, refuses the shift rather than shorten a leg', async () => {
    // Three hours each way: no 6-hour window holds the drive, the ride and the margins.
    const { model, pool } = await modelOf(constantRouter(3 * 3600));
    const built = month({ pool, travel: model });
    expect(built.month.rides).toHaveLength(0);
    expect(built.repositioning).toHaveLength(0);
    expect(built.violations).toEqual([]);
    expect(built.refusals.some(r => r.reason === 'shift_produced_no_ride')).toBe(true);
    expect(built.days.every(d => d.zeroRideDay)).toBe(true);
  });
});

// ── 2. An address the geocoder does not find, and a low-precision location ──

describe('addresses the geocoder cannot place at house level never reach a month', () => {
  it('drops a not-found and a too-coarse address before routing, and no ride names either', async () => {
    const notFound = POOL[3].label;
    const coarse = POOL[7].label;
    const geocoder: GeocodeClient = {
      geocode: async (batch): Promise<GeocodeBatchAnswer> => ({
        ok: true,
        dataUpdated: '2026-10-01',
        results: batch.map((q): GeocodeResult => {
          if (q.text === notFound) return { id: q.id, kind: 'unlocated', reason: 'not_found' };
          if (q.text === coarse) return { id: q.id, kind: 'unlocated', reason: 'too_coarse' };
          const a = POOL.find(p => p.label === q.text)!;
          return { id: q.id, kind: 'located', lat: a.lat, lon: a.lon, precision: 'exact', osm: null };
        }),
      }),
    };
    const routing = await prepareRouting({ pool: POOL, base: BASE, deps: { geocoder, router: lineRouter(), storage: null, sleep: async () => {}, pauseMs: 0 } });
    expect(routing.ok).toBe(true);
    if (!routing.ok) return;
    expect(routing.provenance.addressesDroppedByReason).toEqual({ not_found: 1, too_coarse: 1 });
    const built = month({ pool: routing.points, travel: routing.model, routing: routing.provenance });
    const labels = new Set(built.month.rides.flatMap(r => [r.pickup.label, r.dropoff.label]));
    expect(labels.has(notFound)).toBe(false);
    expect(labels.has(coarse)).toBe(false);
    expect(built.violations).toEqual([]);
  });
});

// ── 3. A route the router cannot compute, and the service failing mid-way ──

describe('a pair without a route is never driven, and never passes', () => {
  it('never uses a pair the router refused, and verifies every leg it did drive', async () => {
    const refused = new Set<string>();
    const router: TravelRouter = {
      route: async pairs => {
        const answer = await lineRouter().route(pairs);
        if (!answer.ok) return answer;
        return {
          ...answer,
          results: answer.results.map((r, i) => {
            // One ordered pair in five has no road: a pair, not a point, so the way
            // through a waiting position can be routed while the direct drive is not.
            const p = pairs[i];
            const cut = pairHash(p.from, p.to) % 5 === 0;
            if (!cut) return r;
            refused.add(`${pointKey(p.from)}>${pointKey(p.to)}`);
            return { id: r.id, kind: 'unavailable' as const, reason: 'no_route' };
          }),
        };
      },
    };
    const { model, pool } = await modelOf(router);
    expect(refused.size).toBeGreaterThan(100);
    const built = month({ pool, travel: model });
    expect(built.violations).toEqual([]);
    for (const r of built.month.rides.filter(x => x.status === 'completed')) {
      expect(refused.has(`${pointKey(r.pickup)}>${pointKey(r.dropoff)}`)).toBe(false);
    }
    for (const leg of built.repositioning) {
      expect(refused.has(`${pointKey(leg.from)}>${pointKey(leg.to)}`), leg.legId).toBe(false);
      expect(leg.verificationStatus).toBe('ROUTE_VERIFIED');
    }
    // A pair the generator never drove (across shifts) may lack a route: it is UNVERIFIABLE, and the month is not validated.
    const unverifiable = built.routeChecks.filter(c => c.status === 'UNVERIFIABLE');
    expect(unverifiable.filter(c => c.sameShift)).toEqual([]);
    expect(unverifiable.length).toBeGreaterThan(0);
    expect(verifyMonth(built).verdict).toBe('VERIFICATION_INCOMPLETE');
    expect(verifyMonth(built).checks.find(c => c.code === 'route_pairs')!.outcome).toBe('not_verified');
  });

  it('holds the direct drive too, where it is longer than the way through the waiting position', async () => {
    // A detour on one pair in four (a one-way street): the direct drive is
    // longer than the two legs through a waiting position, so a gap built
    // from those two legs alone would be too short for the direct route.
    const detour: TravelRouter = {
      route: async pairs => {
        const answer = await lineRouter().route(pairs);
        if (!answer.ok) return answer;
        return {
          ...answer,
          results: answer.results.map((r, i) => (r.kind === 'route' && pairHash(pairs[i].from, pairs[i].to) % 4 === 0
            ? { ...r, durationSeconds: r.durationSeconds + 900 } : r)),
        };
      },
    };
    const { model, pool } = await modelOf(detour);
    for (const seed of [1, 2, 3]) {
      const built = month({ pool, travel: model, seed });
      expect(built.violations).toEqual([]);
      expect(built.routeChecks.filter(c => c.sameShift && c.status !== 'ROUTE_VERIFIED')).toEqual([]);
    }
  });

  it('stops with a reason when the service fails after the first answers, and never falls back to the estimate', async () => {
    let calls = 0;
    const failing: TravelRouter = {
      route: async (pairs): Promise<RouteBatchAnswer> => {
        calls += 1;
        return calls <= 2 ? lineRouter().route(pairs) : { ok: false, reason: 'function_unreachable' };
      },
    };
    const geocoder: GeocodeClient = {
      geocode: async (batch): Promise<GeocodeBatchAnswer> => ({
        ok: true, dataUpdated: '2026-10-01',
        results: batch.map((q): GeocodeResult => {
          const a = POOL.find(p => p.label === q.text)!;
          return { id: q.id, kind: 'located', lat: a.lat, lon: a.lon, precision: 'exact', osm: null };
        }),
      }),
    };
    const routing = await prepareRouting({ pool: POOL, base: BASE, deps: { geocoder, router: failing, storage: null, sleep: async () => {}, pauseMs: 0 } });
    expect(routing.ok).toBe(false);
    if (routing.ok) return;
    expect(['too_few_routes', 'base_unroutable', 'routing_failed']).toContain(routing.reason);
  });
});

// ── 4. A change of driver or vehicle during rescheduling ──

describe('a rescheduled shift carries its final driver and vehicle onto every record', () => {
  it('names on every leg exactly the shift that drove it, after refusals moved the shift', async () => {
    const { model, pool } = await modelOf(lineRouter());
    // Fahrer 1 is on a confirmed vacation the first half of the month: shifts drawn for him are moved.
    const notes = new Map<string, StructuredNote[]>([[DRIVERS[0].id, [{
      id: 'note-vacation', driver_id: DRIVERS[0].id, note_type: 'vacation', note_text: 'Urlaub', note_planning_behavior: 'exclude_from_plan',
      is_full_day: true, start_date: '2026-09-01', end_date: '2026-09-15', note_date: '2026-08-20', start_time: null, end_time: null,
    } as StructuredNote]]]);
    const built = month({ pool, travel: model, driverNotesMap: notes, shiftsPerVehicleDay: 2 });
    expect(built.refusals.some(r => r.reason === 'driver_blocked_by_note' && r.driverId === DRIVERS[0].id)).toBe(true);
    const shifts = new Map(built.month.shifts.map(s => [s.id, s]));
    const vehicleId = new Map(VEHICLES.map(v => [v.plate, v.id]));
    for (const leg of built.repositioning) {
      const shift = shifts.get(leg.shiftId)!;
      expect([leg.driverId, leg.plate, leg.vehicleId, leg.tenantId]).toEqual([shift.driver.id, shift.vehicle.plate, vehicleId.get(shift.vehicle.plate), TENANT]);
    }
    for (const r of built.month.rides) expect(r.driver.id).toBe(shifts.get(r.shiftId)!.driver.id);
    expect(built.month.shifts.some(s => s.driver.id === DRIVERS[0].id && s.operatingDay <= '2026-09-15')).toBe(false);
  });
});

// ── 5. A shift over or under its limit (the audit's "S38"), and overlaps ──

/**
 * The defect: the ride loop ended a shift at the first step that found
 * nothing, so a long wait followed by a pickup no ride left in time ended the
 * shift with an hour of its window unused, below the 240-minute minimum, and
 * only the read-back noticed. Reproduced on invented data with a pool whose
 * outskirts hold a dead end: a pickup no ride leaves from. Before the fix this
 * produced shifts of 165-235 minutes; now the step is drawn again, and a shift
 * that still ends short is refused at scheduling time.
 */
describe('every shift is 240 to 360 minutes, enforced before it is accepted', () => {
  const deadEnd: PoolAddress = { label: 'Sackgasse 1, 40210 Demostadt, Deutschland', lat: 51.17, lon: 7.14 };
  const trapped: TravelModel = {
    source: 'synthetic:dead-end',
    measured: false,
    drive: (from, to, hour) => ESTIMATE_TRAVEL_MODEL.drive(from, to, hour),
    ride: (from, to, hour) => (pointKey(from) === pointKey(deadEnd) ? null : ESTIMATE_TRAVEL_MODEL.ride(from, to, hour)),
  };

  it.each([1, 2, 3, 4, 5, 6])('seed %i: no shift outside the limits, and the trap was hit', seed => {
    const built = month({ pool: [...POOL, deadEnd], travel: trapped, seed: 9000 + seed, shiftsPerVehicleDay: 3 });
    expect(built.violations.filter(v => v.includes('shift of'))).toEqual([]);
    for (const s of built.month.shifts) {
      expect(minutes(s.endMs - s.startMs), s.id).toBeGreaterThanOrEqual(SHIFT_LIMITS.minMinutes);
      expect(minutes(s.endMs - s.startMs), s.id).toBeLessThanOrEqual(SHIFT_LIMITS.maxMinutes);
    }
    const tried = built.scheduling.reduce((n, s) => n + (s.refusedSteps.no_dropoff ?? 0), 0);
    expect(tried).toBeGreaterThan(0);
  });

  it('fills the window instead of refusing it: a step is drawn again before a shift ends short (measured: 1 refusal in six months, 35 without the retries)', () => {
    let tooShort = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const built = month({ pool: [...POOL, deadEnd], travel: trapped, seed: 9000 + seed, shiftsPerVehicleDay: 3 });
      tooShort += built.refusals.filter(r => r.reason === 'shift_too_short').length;
    }
    expect(tooShort).toBeLessThanOrEqual(3);
  });

  it('reports overlapping rides of one vehicle or one driver when they are injected', async () => {
    const { model, pool } = await modelOf(lineRouter());
    const built = month({ pool, travel: model });
    expect(built.violations).toEqual([]);
    const done = built.month.rides.filter(r => r.status === 'completed');
    const [a, b] = [done[0], done.find(r => r.vehicle.plate === done[0].vehicle.plate && r !== done[0])!];
    const clashing = { ...b, startMs: a.startMs, endMs: a.endMs, orderTransmittedMs: b.orderTransmittedMs };
    const found = validateFullMonth({ ...built.month, rides: [...built.month.rides.filter(r => r !== b), clashing] },
      built.period, new Map(), built.provenance.settings);
    expect(found.some(v => v.includes('vehicle') && v.includes('overlapping'))).toBe(true);
    expect(found.some(v => v.includes('driver') && v.includes('overlapping'))).toBe(true);
  });
});

// ── 6. Maintenance and vacation events, and different company settings ──

describe('events are read before generation: confirmed blocks, reported reviews', () => {
  it('marks a shift on a vehicle with a negative workshop check for review and never blocks it on a guess', async () => {
    const { model, pool } = await modelOf(lineRouter());
    const built = month({
      pool, travel: model,
      werkstattChecks: [{ car_id: VEHICLES[0].id, check_date: '2026-09-10', status: 'negative', notes: 'Bremsen pruefen' }],
    });
    const that = built.decisions.filter(d => d.day === '2026-09-10' && d.plate === VEHICLES[0].plate && d.outcome !== 'excluded');
    expect(that.length).toBeGreaterThan(0);
    expect(that.every(d => d.outcome === 'accepted_with_review' && d.code === 'werkstatt_negative' && d.certainty === 'reported')).toBe(true);
    expect(verifyMonth(built).checks.find(c => c.code === 'events_reviewed')!.outcome).toBe('not_verified');
  });

  it('keeps an expired TÜV off the road for the day, as a confirmed block', async () => {
    const { model, pool } = await modelOf(lineRouter());
    const vehicles = [{ ...VEHICLES[0], tuev_gueltig_bis: '2026-09-20' }, VEHICLES[1]];
    const built = month({ pool, travel: model, vehicles });
    expect(built.month.shifts.some(s => s.vehicle.plate === VEHICLES[0].plate && s.operatingDay > '2026-09-20')).toBe(false);
    expect(built.refusals.some(r => r.reason === 'vehicle_tuev_expired' && r.day === '2026-09-21')).toBe(true);
  });

  it('applies two companies’ settings to the same month, each within its own rules', async () => {
    const { model, pool } = await modelOf(lineRouter());
    const loose = month({ pool, travel: model, options: { cancellationShare: 0.06, repositioningMarginSeconds: 0, repositioningMarginPercent: 0 },
      settings: { cancellationFeeEnabled: false, declinedRidesEnabled: false } });
    const strict = month({ pool, travel: model, options: { cancellationShare: 0.06, repositioningMarginSeconds: 180, repositioningMarginPercent: 30 },
      settings: { cancellationFeeEnabled: true, cancellationFeeCents: 750, declinedRidesEnabled: true } });
    for (const built of [loose, strict]) {
      expect(built.violations).toEqual([]);
      expect(built.repositioning.every(l => l.slackSeconds! >= 0)).toBe(true);
    }
    expect(loose.revenue.cancelledFeeCents).toBe(0);
    expect(strict.revenue.cancelledFeeCents).toBe(strict.revenue.counts.cancelled * 750);
    expect(strict.repositioning.every(l => l.roadSeconds === null || l.roadSeconds === 0 || l.safetyMarginSeconds! >= 180)).toBe(true);
    expect(loose.internal.declined.counts.declined).toBe(0);
    expect(strict.internal.declined.counts.declined).toBeGreaterThan(0);
  });
});

// ── 7. The verdict, kept apart from generation ──

describe('VALIDATED FOR EXPORT only when every mandatory check passed', () => {
  it('validates a routed month with no open review', async () => {
    const { model, pool } = await modelOf(lineRouter());
    const built = month({ pool, travel: model });
    const v = verifyMonth(built);
    expect(v.generated).toBe(true);
    expect(v.checks.filter(c => c.outcome !== 'passed')).toEqual([]);
    expect(v.verdict).toBe('VALIDATED_FOR_EXPORT');
    expect(buildMonthReport(built).fileName).toContain('_VALIDATED_FOR_EXPORT.xlsx');
  });

  it('never validates a month built without route calculation, however clean it reads', () => {
    const built = month({});
    const v = verifyMonth(built);
    expect(built.violations).toEqual([]);
    expect(v.generated).toBe(true);
    expect(v.routing).toBe('estimate');
    expect(v.verdict).toBe('VERIFICATION_INCOMPLETE');
    expect(v.checks.find(c => c.code === 'routing_measured')!.outcome).toBe('not_verified');
    expect(built.routeChecks.every(c => c.status === 'ESTIMATE_ONLY')).toBe(true);
    expect(built.repositioning.every(l => l.verificationStatus === 'ESTIMATE_ONLY')).toBe(true);
    expect(buildMonthReport(built).fileName).toContain('_VERIFICATION_INCOMPLETE_ESTIMATE_ONLY.xlsx');
  });

  it('refuses the verdict to a month with a broken rule', async () => {
    const { model, pool } = await modelOf(lineRouter());
    const built = month({ pool, travel: model });
    const v = verifyMonth({ ...built, violations: ['injected'] });
    expect(v.generated).toBe(false);
    expect(v.verdict).toBe('NOT_VALIDATED');
  });
});

// ── 8. Repositioning out of the passenger sheet, in a record of its own ──

describe('the two files of a month', () => {
  it('keeps every empty drive out of the passenger sheet and in the operational report, with every field', async () => {
    const { model, pool } = await modelOf(lineRouter());
    const built = month({ pool, travel: model });
    const report = buildMonthReport(built);
    const operational = buildOperationalReport(built);
    const rides = report.payload.sheets.find(s => s.name === SHEET_RIDES)!.rows;
    expect(rides).toHaveLength(built.revenue.counts.completed + built.revenue.counts.cancelled + 1);
    for (const sheet of report.payload.sheets) {
      for (const row of sheet.rows) expect(row.some(c => c === 'LEERFAHRT' || c === 'REPOSITIONING'), sheet.name).toBe(false);
    }
    const legs = operational.payload.sheets.find(s => s.name === SHEET_LEGS)!.rows;
    expect(legs).toHaveLength(built.repositioning.length + 1);
    const header = legs[0].map(String);
    for (const field of ['Mandant', 'Fahrzeug-ID', 'Fahrer-ID', 'Fahrt-ID vorher', 'Fahrt-ID nachher', 'Von', 'Nach', 'Abfahrt', 'Ankunft',
      'Strecke (km)', 'Fahrzeit Strasse (s)', 'Routingquelle', 'Pruefstatus', 'Datenart', 'Seed', 'Lauf-ID']) {
      expect(header, field).toContain(field);
    }
    const first = Object.fromEntries(header.map((h, i) => [h, legs[1][i]]));
    expect(first).toMatchObject({ Art: 'REPOSITIONING', Bezeichnung: 'LEERFAHRT', Datenart: 'SIMULATED', Mandant: TENANT, Seed: built.provenance.seed, 'Lauf-ID': built.provenance.runId });
    expect(operational.fileName).toContain('Betriebsbericht_2026-09');
    expect(operational.payload.sheets[operational.payload.sheets.length - 1].name).toBe('SIMULIERT');
  });

  it('keeps the declined orders, with their fee, only in the operational report', async () => {
    const { model, pool } = await modelOf(lineRouter());
    const built = month({ pool, travel: model });
    const declined = built.month.rides.filter(r => r.status === 'declined');
    expect(declined.length).toBeGreaterThan(0);
    const internal = buildOperationalReport(built).payload.sheets.find(s => s.name === SHEET_DECLINED_INTERNAL)!.rows;
    expect(internal).toHaveLength(declined.length + 1);
    const ids = new Set(declined.map(r => r.tripId));
    for (const sheet of buildMonthReport(built).payload.sheets) {
      for (const row of sheet.rows) expect(row.some(c => typeof c === 'string' && ids.has(c)), sheet.name).toBe(false);
    }
  });

  it('builds the same month, the same ids and the same run id from the same inputs', async () => {
    const { model, pool } = await modelOf(lineRouter());
    const a = month({ pool, travel: model });
    const b = month({ pool, travel: model });
    expect(a.provenance.runId).toBe(b.provenance.runId);
    expect(JSON.stringify(a.repositioning)).toBe(JSON.stringify(b.repositioning));
    expect(a.provenance.runId).toMatch(/^SIM-2026-09-20261030-[0-9a-f]{8}$/);
  });
});
