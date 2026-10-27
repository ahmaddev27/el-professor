/**
 * The acceptance cases of the Fahrtenbuch analysis spec (fahrtenbuch.md v2,
 * "معايير القبول"), each run through analyzeTrips. Synthetic data only.
 * Times are local Europe/Berlin (vitest.config.ts pins TZ).
 *
 * blockGapMinutes = 30 is the spec's trial value for tests, not a product default.
 */
import { describe, expect, it, vi } from 'vitest';
import { analyzeTrips, listTravelRequests } from './index';
import type { AnalysisShift, AnalysisTrip, Issue, IssueType, TravelTimeEstimator, TripAnalysisResult } from './types';

const MIN = 60_000;
const DAY = '2026-08-03'; // a Monday
const NEXT_DAY = '2026-08-04';

function ms(time: string, day = DAY): number {
  return new Date(`${day}T${time}:00`).getTime();
}

function trip(
  id: string,
  driver: string | null,
  vehicle: string | null,
  start: string | null,
  end: string | null,
  extra: Partial<AnalysisTrip> = {},
): AnalysisTrip {
  return {
    id,
    driver_id: driver,
    driver_name: driver === null ? null : `Fahrer ${driver}`,
    vehicle,
    start_ms: start === null ? null : ms(start),
    end_ms: end === null ? null : ms(end),
    status: 'completed',
    price: 10,
    currency: 'EUR',
    source_row: null,
    pickup_address: null,
    dropoff_address: null,
    ...extra,
  };
}

function shift(id: string, driver: string, start: string, end: string, day = DAY): AnalysisShift {
  return { id, driver_id: driver, start_ms: ms(start, day), end_ms: ms(end, day), source: 'test' };
}

const SETTINGS = { blockGapMinutes: 30, travelMarginMinutes: 0 };

function run(trips: AnalysisTrip[], extra: Partial<Parameters<typeof analyzeTrips>[0]> = {}): TripAnalysisResult {
  return analyzeTrips({ trips, settings: SETTINGS, ...extra });
}

function issuesOf(result: TripAnalysisResult, type: IssueType): Issue[] {
  return result.issues.filter(i => i.type === type);
}

function fixedEstimator(minutes: number): TravelTimeEstimator {
  return {
    source: 'test-table',
    estimate: () => ({ kind: 'estimated', minutes, source: 'test-table', confidence: 'medium', computedAt: '2026-09-22T10:00:00Z' }),
  };
}

describe('activity outside the recorded shift', () => {
  it('shift 08:00–10:00 and a trip 13:00–13:20 → 20 min outside, the trip unchanged', () => {
    const t1 = trip('t1', 'd1', 'X', '13:00', '13:20');
    const result = run([t1], { shifts: [shift('s1', 'd1', '08:00', '10:00')] });

    expect(result.trips[0].outsideShiftMs).toBe(20 * MIN);
    expect(result.drivers[0].metrics.outsideShiftMs).toBe(20 * MIN);
    const [outside] = issuesOf(result, 'activity_outside_shift');
    expect(outside).toMatchObject({ status: 'conflict', tripIds: ['t1'], values: { outsideMinutes: 20, tripMinutes: 20 } });
    expect(outside.explanation).toContain('20 Min.');
    // The shift has no trip in it: a finding of its own, not a reason to move anything.
    expect(issuesOf(result, 'shift_without_activity')).toMatchObject([{ shiftIds: ['s1'], status: 'conflict' }]);
    expect(result.trips[0].trip).toBe(t1);
    expect(t1.start_ms).toBe(ms('13:00'));
    expect(t1.end_ms).toBe(ms('13:20'));
  });

  it('counts only the uncovered part of a trip that straddles the end of a shift', () => {
    const result = run([trip('t1', 'd1', 'X', '09:50', '10:20')], { shifts: [shift('s1', 'd1', '08:00', '10:00')] });
    expect(result.trips[0].outsideShiftMs).toBe(20 * MIN);
    expect(result.checks.shiftCoverage).toEqual({ passed: 0, conflict: 1, unverifiable: 0 });
  });

  it('without shift records the outside metric is null and the check unverifiable, never passed', () => {
    const result = run([trip('t1', 'd1', 'X', '13:00', '13:20')]);
    expect(result.trips[0].outsideShiftMs).toBeNull();
    expect(result.drivers[0].metrics.outsideShiftMs).toBeNull();
    expect(issuesOf(result, 'no_shift_records')).toMatchObject([{ driverId: 'd1', status: 'unverifiable' }]);
    expect(result.checks.shiftCoverage).toEqual({ passed: 0, conflict: 0, unverifiable: 1 });
  });

  it('reports overlapping shift records and invalid ones', () => {
    const result = run([trip('t1', 'd1', 'X', '08:30', '08:40')], {
      shifts: [
        shift('s1', 'd1', '08:00', '10:00'),
        shift('s2', 'd1', '09:30', '11:00'),
        { id: 's3', driver_id: 'd1', start_ms: ms('12:00'), end_ms: ms('11:00'), source: 'test' },
      ],
    });
    expect(issuesOf(result, 'shift_overlap')).toMatchObject([{ shiftIds: ['s1', 's2'], values: { overlapMinutes: 30 } }]);
    expect(issuesOf(result, 'shift_invalid')).toMatchObject([{ shiftIds: ['s3'], values: { reason: 'invalid_interval' } }]);
    // The union of the valid shifts, 08:00–11:00, counts once.
    expect(result.drivers[0].shiftUnionMs).toBe(180 * MIN);
  });
});

describe('overlaps: every pair, per driver across vehicles and per vehicle across drivers', () => {
  it('one driver on X 07:00–07:15 and on Y 07:10–07:20 → a 5-min driver overlap', () => {
    const result = run([trip('x', 'd1', 'X', '07:00', '07:15'), trip('y', 'd1', 'Y', '07:10', '07:20')]);
    const overlaps = issuesOf(result, 'driver_overlap');
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]).toMatchObject({
      status: 'conflict',
      driverId: 'd1',
      tripIds: ['x', 'y'],
      values: { overlapMinutes: 5, vehicleA: 'X', vehicleB: 'Y', identicalInterval: false },
    });
    // The vehicle change splits the block; the overlap is found across the split.
    expect(result.blocks.map(b => b.startReason)).toEqual(['first', 'vehicle_change']);
    expect(result.blocks[1].gapBeforeMs).toBe(-5 * MIN);
    expect(issuesOf(result, 'vehicle_overlap')).toHaveLength(0);
  });

  it('one vehicle with two drivers at once → a vehicle overlap', () => {
    const result = run([trip('a', 'd1', 'X', '09:00', '09:30'), trip('b', 'd2', 'X', '09:20', '09:40')]);
    expect(issuesOf(result, 'vehicle_overlap')).toMatchObject([
      { status: 'conflict', vehicle: 'X', tripIds: ['a', 'b'], values: { overlapMinutes: 10, driverA: 'd1', driverB: 'd2' } },
    ]);
    expect(issuesOf(result, 'driver_overlap')).toHaveLength(0);
    expect(result.checks.vehicleOverlap).toEqual({ passed: 0, conflict: 2, unverifiable: 0 });
  });

  it('a long trip against three short ones → all three overlaps, none invented between the short ones', () => {
    const result = run([
      trip('long', 'd1', 'X', '10:00', '12:00'),
      trip('a', 'd1', 'X', '10:10', '10:20'),
      trip('b', 'd1', 'X', '10:40', '10:50'),
      trip('c', 'd1', 'X', '11:30', '11:45'),
    ]);
    const overlaps = issuesOf(result, 'driver_overlap');
    expect(overlaps.map(i => i.tripIds)).toEqual([
      ['a', 'long'],
      ['b', 'long'],
      ['c', 'long'],
    ]);
    expect(overlaps.map(i => i.values.overlapMinutes)).toEqual([10, 10, 15]);
    // A neighbour-only check would have compared c with b alone and missed c.
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].metrics.durationSumMs).toBe(155 * MIN);
    expect(result.blocks[0].metrics.unionMs).toBe(120 * MIN);
    expect(result.checks.driverOverlap).toEqual({ passed: 0, conflict: 4, unverifiable: 0 });
  });

  it('end equal to the next start is no overlap, but the travel check still runs', () => {
    const result = run([
      trip('t1', 'd1', 'X', '08:00', '08:30', { dropoff_address: 'A' }),
      trip('t2', 'd1', 'X', '08:30', '09:00', { pickup_address: 'B' }),
    ]);
    expect(issuesOf(result, 'driver_overlap')).toHaveLength(0);
    const [travel] = issuesOf(result, 'travel_gap');
    expect(travel).toMatchObject({ status: 'unverifiable', values: { availableMinutes: 0, fromTripId: 't1', toTripId: 't2' } });
    // With an estimate the same pair is judged: 0 available against 5 needed.
    const judged = run(result.trips.map(t => t.trip), { travelEstimator: fixedEstimator(5) });
    expect(issuesOf(judged, 'travel_gap')[0]).toMatchObject({ status: 'conflict', values: { shortByMinutes: 5 } });
  });

  it('identical intervals are flagged as a possible duplicate, not dropped', () => {
    const result = run([trip('t1', 'd1', 'X', '08:00', '08:30'), trip('t2', 'd1', 'X', '08:00', '08:30')]);
    expect(issuesOf(result, 'driver_overlap')[0].values.identicalInterval).toBe(true);
    expect(result.counts.analysed).toBe(2);
  });
});

describe('travel between consecutive trips', () => {
  const pair = (margin = 0) => ({
    trips: [
      trip('t1', 'd1', 'X', '08:00', '08:30', { dropoff_address: 'Königsallee 1, Düsseldorf' }),
      trip('t2', 'd1', 'X', '08:40', '09:00', { pickup_address: 'Hauptstraße 221, Heiligenhaus' }),
    ],
    settings: { blockGapMinutes: 30, travelMarginMinutes: margin },
  });

  it('a 10-min gap against a 30-min estimate → short by 20 min, with source and confidence', () => {
    const result = analyzeTrips({ ...pair(), travelEstimator: fixedEstimator(30) });
    const [travel] = issuesOf(result, 'travel_gap');
    expect(travel).toMatchObject({
      status: 'conflict',
      severity: 'warning',
      confidence: 'medium',
      values: {
        availableMinutes: 10,
        estimateMinutes: 30,
        requiredMinutes: 30,
        shortByMinutes: 20,
        estimateSource: 'test-table',
        estimateComputedAt: '2026-09-22T10:00:00Z',
      },
    });
    expect(travel.explanation).toBe('Verfügbar 10 Min., geschätzt 30 Min., es fehlen 20 Min. (Quelle: test-table).');
  });

  it('adds the operational margin to the estimate', () => {
    const result = analyzeTrips({ ...pair(5), travelEstimator: fixedEstimator(30) });
    expect(issuesOf(result, 'travel_gap')[0].values).toMatchObject({ requiredMinutes: 35, shortByMinutes: 25 });
  });

  it('passes when the estimate fits, and records the evidence', () => {
    const result = analyzeTrips({ ...pair(), travelEstimator: fixedEstimator(8) });
    expect(issuesOf(result, 'travel_gap')[0]).toMatchObject({ status: 'passed', values: { shortByMinutes: 0 } });
    expect(result.checks.travelGap).toEqual({ passed: 1, conflict: 0, unverifiable: 0 });
  });

  it('a missing address → unverifiable, and the estimator is not even asked', () => {
    const estimator = fixedEstimator(1);
    const spy = vi.spyOn(estimator, 'estimate');
    const input = pair();
    const trips = [input.trips[0], { ...input.trips[1], pickup_address: null }];
    const result = analyzeTrips({ ...input, trips, travelEstimator: estimator });
    expect(spy).not.toHaveBeenCalled();
    expect(issuesOf(result, 'travel_gap')[0]).toMatchObject({ status: 'unverifiable', values: { reason: 'address_missing' } });
  });

  it('no routing service (the default) or a failing one → unverifiable, never passed', () => {
    const byDefault = analyzeTrips(pair());
    expect(byDefault.travelEstimatorSource).toBe('none');
    expect(issuesOf(byDefault, 'travel_gap')[0]).toMatchObject({ status: 'unverifiable', values: { reason: 'no_routing_service' } });

    const failing: TravelTimeEstimator = {
      source: 'osrm',
      estimate: () => ({ kind: 'unavailable', source: 'osrm', reason: 'service_error' }),
    };
    const result = analyzeTrips({ ...pair(), travelEstimator: failing });
    expect(issuesOf(result, 'travel_gap')[0]).toMatchObject({ status: 'unverifiable', values: { reason: 'service_error' } });
    expect(result.checks.travelGap.passed).toBe(0);
  });

  it('an estimate that is not a number → unverifiable, and never a pass', () => {
    /*
      Audit round 2 (27.10.2026) asks that a routing failure never become
      zero. The `unavailable` branch above is that rule for a service that
      says it failed. This is the rule for one that does not: an estimator
      answering `estimated` with a value that is not a minute count.

      Unguarded it would read as a PASS, not as a zero, which is worse.
      `requiredMinutes = NaN + margin` is NaN, `shortByMinutes` is NaN, and
      `shortByMinutes > 0` is FALSE for NaN — so `status` would resolve to
      'passed' and a broken router would certify the gap it could not
      measure. A negative minute count passes the same way by arithmetic.
      `usableEstimate` is the guard (Number.isFinite and >= 0) and
      `invalid_estimate` is the reason it records; before this test the
      reason appeared nowhere but the one line that writes it.
    */
    for (const minutes of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const broken: TravelTimeEstimator = {
        source: 'osrm',
        estimate: () => ({ kind: 'estimated', minutes, source: 'osrm', confidence: 'high' }),
      };
      const result = analyzeTrips({ ...pair(), travelEstimator: broken });
      expect(issuesOf(result, 'travel_gap')[0]).toMatchObject({
        status: 'unverifiable',
        confidence: 'low',
        values: {
          reason: 'invalid_estimate',
          estimateMinutes: null,
          requiredMinutes: null,
          shortByMinutes: null,
        },
      });
      expect(result.checks.travelGap).toEqual({ passed: 0, conflict: 0, unverifiable: 1 });
    }
  });

  it('without an estimate, a gap below the margin is only a weak signal', () => {
    const result = analyzeTrips(pair(15));
    expect(issuesOf(result, 'travel_gap')[0]).toMatchObject({
      status: 'unverifiable',
      severity: 'warning',
      confidence: 'low',
      values: { belowMargin: true },
    });
  });

  it('measures from the running maximum end, and asks exactly what listTravelRequests lists', () => {
    const input = {
      trips: [
        trip('long', 'd1', 'X', '10:00', '12:00', { dropoff_address: 'A' }),
        trip('inner', 'd1', 'X', '10:10', '10:20', { dropoff_address: 'B', pickup_address: 'B0' }),
        trip('next', 'd1', 'Y', '12:05', '12:30', { pickup_address: 'C' }),
      ],
      settings: SETTINGS,
    };
    const asked: string[] = [];
    const estimator: TravelTimeEstimator = {
      source: 'spy',
      estimate: r => {
        asked.push(`${r.fromTripId}>${r.toTripId}`);
        return { kind: 'estimated', minutes: 3, source: 'spy', confidence: 'high' };
      },
    };
    const result = analyzeTrips({ ...input, travelEstimator: estimator });
    // long → next, 5 minutes after the long trip's end; inner overlaps long and gets no travel check.
    expect(asked).toEqual(['long>next']);
    expect(listTravelRequests(input).map(r => `${r.fromTripId}>${r.toTripId}`)).toEqual(asked);
    expect(issuesOf(result, 'travel_gap')[0].values).toMatchObject({ availableMinutes: 5, vehicleChange: true });
  });
});

describe('blocks', () => {
  it('08:00–08:30 plus 08:45–09:15 → 60 min of durations and a 75 min span in one block', () => {
    const result = run([trip('t1', 'd1', 'X', '08:00', '08:30'), trip('t2', 'd1', 'X', '08:45', '09:15')]);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].metrics).toMatchObject({ durationSumMs: 60 * MIN, unionMs: 60 * MIN, spanMs: 75 * MIN });
    expect(result.drivers[0].metrics).toMatchObject({ durationSumMs: 60 * MIN, spanMs: 75 * MIN });
  });

  it('a gap equal to the threshold stays; one minute more starts a new block', () => {
    const result = run([
      trip('t1', 'd1', 'X', '08:00', '08:30'),
      trip('t2', 'd1', 'X', '09:00', '09:10'), // gap 30 = threshold
      trip('t3', 'd1', 'X', '09:41', '09:50'), // gap 31
    ]);
    expect(result.blocks.map(b => b.tripIds)).toEqual([['t1', 't2'], ['t3']]);
    expect(result.blocks[1]).toMatchObject({ startReason: 'gap', gapBeforeMs: 31 * MIN, id: 'd1#1', index: 1 });
  });

  it('measures the gap from the running maximum end, not from the last trip', () => {
    const result = run([
      trip('long', 'd1', 'X', '08:00', '10:00'),
      trip('inner', 'd1', 'X', '08:10', '08:20'),
      trip('after', 'd1', 'X', '10:30', '10:40'), // 30 after 10:00, 130 after 08:20
    ]);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].endMs).toBe(ms('10:40'));
  });

  it('keeps a midnight crossing whole, in one block with the trip after it', () => {
    const cross = trip('cross', 'd1', 'X', null, null, { start_ms: ms('23:50'), end_ms: ms('00:10', NEXT_DAY) });
    const after = trip('after', 'd1', 'X', null, null, { start_ms: ms('00:20', NEXT_DAY), end_ms: ms('00:30', NEXT_DAY) });
    const result = run([cross, after]);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].tripIds).toEqual(['cross', 'after']);
    expect(result.blocks[0].metrics).toMatchObject({ durationSumMs: 30 * MIN, spanMs: 40 * MIN });
  });

  it('orders by start, then id, whatever the input order', () => {
    const trips = [
      trip('b', 'd1', 'X', '08:00', '08:10'),
      trip('a', 'd1', 'X', '08:00', '08:05'),
      trip('c', 'd1', 'X', '07:00', '07:10'),
    ];
    expect(run(trips).blocks.flatMap(b => b.tripIds)).toEqual(['c', 'a', 'b']);
  });
});

describe('both DST Sundays, on absolute times', () => {
  it('spring: 01:50 CET → 03:10 CEST is 20 minutes', () => {
    const t1 = trip('t1', 'd1', 'X', null, null, {
      start_ms: Date.parse('2026-03-29T00:50:00Z'),
      end_ms: Date.parse('2026-03-29T01:10:00Z'),
    });
    expect(run([t1]).blocks[0].metrics.durationSumMs).toBe(20 * MIN);
  });

  it('autumn: 02:50 CEST → 02:10 CET is 20 minutes, not an end before its start', () => {
    const t1 = trip('t1', 'd1', 'X', null, null, {
      start_ms: Date.parse('2026-10-25T00:50:00Z'),
      end_ms: Date.parse('2026-10-25T01:10:00Z'),
    });
    const result = run([t1]);
    expect(result.blocks[0].metrics.durationSumMs).toBe(20 * MIN);
    expect(issuesOf(result, 'end_before_start')).toHaveLength(0);
  });

  it('the block gap across the spring switch is absolute: 01:55 CET to 03:20 CEST is 25 minutes', () => {
    const result = run([
      trip('t1', 'd1', 'X', null, null, { start_ms: Date.parse('2026-03-29T00:30:00Z'), end_ms: Date.parse('2026-03-29T00:55:00Z') }),
      trip('t2', 'd1', 'X', null, null, { start_ms: Date.parse('2026-03-29T01:20:00Z'), end_ms: Date.parse('2026-03-29T01:30:00Z') }),
    ]);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].metrics.spanMs).toBe(60 * MIN);
  });
});

describe('rows that cannot be measured stay in the result', () => {
  it('a missing end or driver → review list, row kept, never part of an overlap pass', () => {
    const complete = trip('complete', 'd1', 'X', '08:00', '09:00');
    const noEnd = trip('noEnd', 'd1', 'X', '08:30', null);
    const noDriver = trip('noDriver', null, 'X', '08:10', '08:20');
    const result = run([complete, noEnd, noDriver]);

    expect(result.counts.rows).toBe(3);
    expect(result.trips.map(t => t.trip.id)).toEqual(['complete', 'noEnd', 'noDriver']);
    expect(result.reviewTripIds).toEqual(['noEnd', 'noDriver']);
    expect(result.trips[1].excludedBecause).toEqual(['missing_end']);
    expect(result.trips[2].excludedBecause).toEqual(['missing_driver']);
    expect(issuesOf(result, 'missing_end')).toMatchObject([{ tripIds: ['noEnd'], status: 'unverifiable' }]);
    expect(issuesOf(result, 'missing_driver')).toMatchObject([{ tripIds: ['noDriver'], status: 'unverifiable' }]);
    // No end is ever assumed: the trip takes part in no overlap, conflicting or passing.
    expect(result.issues.filter(i => i.type === 'driver_overlap' || i.type === 'vehicle_overlap')).toHaveLength(0);
    expect(result.checks.driverOverlap).toEqual({ passed: 1, conflict: 0, unverifiable: 1 });
    expect(result.blocks.flatMap(b => b.tripIds)).toEqual(['complete']);
  });

  it('cancelled rows are counted and kept, outside the time metrics, and not a review item', () => {
    const result = run([
      trip('done', 'd1', 'X', '08:00', '08:20'),
      trip('storno', 'd1', 'X', null, null, { status: 'cancelled', price: 6 }),
    ]);
    expect(result.counts).toMatchObject({ rows: 2, byStatus: { completed: 1, cancelled: 1, unknown: 0 }, analysed: 1, needsReview: 0 });
    expect(result.trips[1].excludedBecause).toEqual(['cancelled']);
    // Its cancellation fee is summed under its own status, never mixed with trip revenue.
    expect(result.drivers[0].prices.totals).toEqual([
      { currency: 'EUR', status: 'completed', totalCents: 1000, tripCount: 1 },
      { currency: 'EUR', status: 'cancelled', totalCents: 600, tripCount: 1 },
    ]);
  });

  it('an unknown status is a review item, even with complete times', () => {
    const result = run([trip('t1', 'd1', 'X', '08:00', '08:20', { status: 'unknown' })]);
    expect(result.reviewTripIds).toEqual(['t1']);
    expect(result.blocks).toHaveLength(0);
    expect(result.checks.driverOverlap).toEqual({ passed: 0, conflict: 0, unverifiable: 1 });
  });

  it('an end before the start is a data conflict; a missing vehicle only a note', () => {
    const result = run([trip('back', 'd1', 'X', '09:00', '08:00'), trip('novehicle', 'd1', null, '10:00', '10:10')]);
    expect(issuesOf(result, 'end_before_start')).toMatchObject([{ status: 'conflict', severity: 'error' }]);
    expect(issuesOf(result, 'missing_vehicle')).toMatchObject([{ status: 'unverifiable', severity: 'info' }]);
    expect(result.trips[1].blockId).toBe('d1#0');
    expect(result.checks.vehicleOverlap).toEqual({ passed: 0, conflict: 0, unverifiable: 1 });
  });

  it('a DST-ambiguous local time is sent to review, not resolved', () => {
    const result = run([trip('t1', 'd1', 'X', '08:00', '08:20', { time_ambiguity: 'dst_ambiguous' })]);
    expect(result.trips[0].excludedBecause).toEqual(['ambiguous_local_time']);
    expect(issuesOf(result, 'ambiguous_local_time')).toMatchObject([{ values: { ambiguity: 'dst_ambiguous' } }]);
  });

  it('one driver id under two names → a mismatch citing the odd rows', () => {
    const result = run([
      trip('t1', 'd1', 'X', '08:00', '08:10', { driver_name: 'Sara Weiss' }),
      trip('t2', 'd1', 'X', '09:00', '09:10', { driver_name: 'Sara Weiss' }),
      trip('t3', 'd1', 'X', '10:00', '10:10', { driver_name: 'S. Weiss' }),
    ]);
    expect(issuesOf(result, 'driver_name_mismatch')).toMatchObject([
      { driverId: 'd1', tripIds: ['t3'], values: { names: 'S. Weiss | Sara Weiss', majorityName: 'Sara Weiss' } },
    ]);
    expect(result.drivers[0].driverNames).toEqual(['S. Weiss', 'Sara Weiss']);
  });
});

describe('budget against past activity', () => {
  it('a 40 h ceiling against 55 h of activity → both shown and the difference, nothing moved', () => {
    // 556 / 13.9 = 40 h exactly; eleven 5-hour trips on eleven days = 55 h.
    const trips = Array.from({ length: 11 }, (_, i) => {
      const day = `2026-08-${String(3 + i).padStart(2, '0')}`;
      return trip(`t${i}`, 'd1', 'X', null, null, { start_ms: ms('08:00', day), end_ms: ms('13:00', day) });
    });
    const before = structuredClone(trips);
    const result = run(trips, { budgets: { d1: { salaryMin: 278, salaryMax: 556, hourlyRate: 13.9, reservedHours: 4 } } });

    const [driver] = result.drivers;
    expect(driver.budget).toMatchObject({ status: 'ok', hoursMax: 40, capHours: 36, capMinutes: 2160 });
    expect(driver.budgetComparison).toMatchObject({ maxMinutes: 2400, activityMinutes: 3300, activityVsMaxMinutes: 900 });
    expect(issuesOf(result, 'activity_over_budget')).toMatchObject([
      { status: 'conflict', severity: 'warning', driverId: 'd1', values: { overByMinutes: 900 } },
    ]);
    // The reserve is not deducted from past activity: the comparison is against hoursMax, not the cap.
    expect(driver.budgetComparison?.maxMinutes).toBe(40 * 60);
    // Every trip is still there, with its driver, its times and its price.
    expect(result.counts.analysed).toBe(11);
    expect(trips).toEqual(before);
    expect(result.trips.every(t => t.trip.driver_id === 'd1')).toBe(true);
    expect(result.checks.budget).toEqual({ passed: 0, conflict: 1, unverifiable: 0 });
  });

  it('a budget that cannot be computed never blocks the analysis', () => {
    const result = run([trip('t1', 'd1', 'X', '08:00', '08:20')], {
      budgets: { d1: { salaryMin: 800, salaryMax: 1000, hourlyRate: 0 } },
    });
    expect(result.blocks).toHaveLength(1);
    expect(result.drivers[0].budget).toMatchObject({ status: 'not_computable', rangeStatus: 'not_computable' });
    expect(result.drivers[0].budgetComparison).toBeNull();
    expect(issuesOf(result, 'budget_not_computable')).toMatchObject([
      { status: 'unverifiable', values: { problems: 'hourly_rate_not_positive,reserve_not_set', rangeComputable: false } },
    ]);
    expect(result.checks.budget).toEqual({ passed: 0, conflict: 0, unverifiable: 1 });
  });

  it('flags a reserve that pushes the planning cap below the minimum', () => {
    const result = run([], { budgets: { d1: { salaryMin: 900, salaryMax: 1000, hourlyRate: 13.9, reservedHours: 10 } } });
    expect(issuesOf(result, 'cap_below_hours_min')).toHaveLength(1);
    expect(result.drivers.map(d => d.driverId)).toEqual(['d1']);
  });
});

describe('findings point back at their evidence', () => {
  it('indexes every finding to its trips, blocks and driver', () => {
    const result = run([trip('x', 'd1', 'X', '07:00', '07:15'), trip('y', 'd1', 'Y', '07:10', '07:20')]);
    const overlapId = 'driver_overlap:x+y';
    expect(result.trips.every(t => t.issueIds.includes(overlapId))).toBe(true);
    expect(result.blocks.every(b => b.issueIds.includes(overlapId))).toBe(true);
    expect(result.drivers[0].issueIds).toContain(overlapId);
    expect(result.drivers[0].issueIds).toContain('no_shift_records:d1');
  });

  it('stores the algorithm version and the settings', () => {
    const result = run([]);
    expect(result.algorithmVersion).toBe('trip-analysis/1.0.0');
    expect(result.settings).toEqual(SETTINGS);
  });

  it('refuses a broken contract instead of guessing', () => {
    expect(() => analyzeTrips({ trips: [], settings: { blockGapMinutes: -1, travelMarginMinutes: 0 } })).toThrow(RangeError);
    expect(() => analyzeTrips({ trips: [], settings: { blockGapMinutes: Number.NaN, travelMarginMinutes: 0 } })).toThrow(RangeError);
    expect(() => run([trip('t', 'd1', 'X', '08:00', '08:10'), trip('t', 'd1', 'X', '09:00', '09:10')])).toThrow(/duplicate trip id/);
  });
});
