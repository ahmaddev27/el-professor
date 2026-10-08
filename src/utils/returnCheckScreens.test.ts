import { describe, it, expect } from 'vitest';
import type { CheckRide, OrderCheck, ReturnCheckResult } from './returnCheck';
import {
  anomalyDetail,
  berlinStamp,
  buildAnomalyRows,
  buildReviewRows,
  filterReviewRows,
  formatCoordinate,
  parseBase,
  parseCoordinate,
  reviewExportOptions,
  reviewVehicles,
  sortReviewRows,
  unverifiableCounts,
} from './returnCheckScreens';

const ride = (id: string, over: Partial<CheckRide> = {}): CheckRide => ({
  id, vehicle: 'B-AB 1', driverName: 'Max', status: 'completed', startMs: Date.UTC(2026, 8, 1, 8, 0), endMs: null,
  orderMs: null, orderProblem: null, position: null, positionProblem: null, km: null, prebooked: null,
  pickup: { raw: 'Hauptstr. 1, 10115 Berlin', normalized: '', street: 'hauptstr', houseNumber: '1', postalCode: '10115', city: 'berlin' },
  dropoff: { raw: 'Hauptstr. 1, 10115 Berlin', normalized: '', street: 'hauptstr', houseNumber: '1', postalCode: '10115', city: 'berlin' },
  sourceRow: null, ...over,
});

const order = (rideId: string, over: Partial<OrderCheck> = {}): OrderCheck => ({
  rideId, vehicle: 'B-AB 1', previousRideId: null, placement: 'away_from_base', reason: null, waitMinutes: 10,
  distanceKm: 2.34, prebooked: null, samePostalCodeAsPreviousDestination: null,
  orderMs: Date.UTC(2026, 8, 1, 10, 30), previousEndMs: Date.UTC(2026, 8, 1, 10, 0), ...over,
});

const result = (orders: OrderCheck[], anomalies: ReturnCheckResult['anomalies'] = []): ReturnCheckResult => ({
  algorithmVersion: 't', settings: { base: null, baseRadiusKm: 1, blockGapMinutes: 30, maxSpeedKmh: 200 }, status: 'ok',
  rides: orders.length, checkedRides: orders.length, orders, anomalies,
  counts: { byPlacement: {} as never, byAnomaly: {} as never },
});

describe('parseCoordinate', () => {
  it('reads comma and dot', () => {
    expect(parseCoordinate('52,5200')).toBe(52.52);
    expect(parseCoordinate(' 13.405 ')).toBe(13.405);
    expect(parseCoordinate('-1,5')).toBe(-1.5);
  });
  it('rejects junk and empty', () => {
    expect(parseCoordinate('')).toBeNull();
    expect(parseCoordinate('abc')).toBeNull();
    expect(parseCoordinate('1,2,3')).toBeNull();
    expect(parseCoordinate('52.5 N')).toBeNull();
  });
});

describe('parseBase', () => {
  it('accepts a valid pair', () => {
    expect(parseBase('52,52', '13,405')).toEqual({ base: { lat: 52.52, lon: 13.405 }, problem: null });
  });
  it('flags out-of-range values by field', () => {
    expect(parseBase('91', '13')).toEqual({ base: null, problem: 'lat' });
    expect(parseBase('52', '181')).toEqual({ base: null, problem: 'lon' });
    expect(parseBase('x', '13').problem).toBe('lat');
  });
  it('treats an empty field as no base yet, not an error', () => {
    expect(parseBase('', '')).toEqual({ base: null, problem: null });
    expect(parseBase('52', '')).toEqual({ base: null, problem: null });
  });
});

describe('formatting', () => {
  it('writes a coordinate with a decimal comma', () => expect(formatCoordinate(52.52)).toBe('52,52000'));
  it('writes Berlin local time, across the DST offset', () => {
    expect(berlinStamp(Date.UTC(2026, 0, 15, 11, 5))).toEqual({ date: '2026-01-15', time: '12:05' });
    expect(berlinStamp(Date.UTC(2026, 6, 15, 22, 30))).toEqual({ date: '2026-07-16', time: '00:30' });
  });
});

describe('review rows', () => {
  const orders = [
    order('a', { waitMinutes: 5 }),
    order('b', { waitMinutes: 40, prebooked: true, samePostalCodeAsPreviousDestination: true }),
    order('c', { placement: 'block_start_away', waitMinutes: null, previousEndMs: null, vehicle: 'B-CD 2' }),
    order('d', { placement: 'at_base' }),
    order('e', { placement: 'unverifiable', reason: 'no_position', orderMs: null }),
  ];
  const rows = buildReviewRows(result(orders), [ride('a'), ride('b', { driverName: 'Eva' }), ride('c')]);

  it('keeps only the two review placements and sorts the longest wait first', () => {
    expect(rows.map(r => r.id)).toEqual(['b', 'a', 'c']);
  });
  it('carries driver, times and flags', () => {
    const b = rows[0];
    expect(b).toMatchObject({ driver: 'Eva', date: '2026-09-01', orderTime: '12:30', previousEndTime: '12:00', prebooked: true, samePostalCode: true });
    expect(rows[2].previousEndTime).toBeNull();
  });
  it('filters by vehicle and placement', () => {
    expect(filterReviewRows(rows, 'B-CD 2', '').map(r => r.id)).toEqual(['c']);
    expect(filterReviewRows(rows, '', 'away_from_base').map(r => r.id)).toEqual(['b', 'a']);
    expect(filterReviewRows(rows, '', '')).toHaveLength(3);
  });
  it('keeps a block start that has no order time, dated by the ride, and shows no wait for it', () => {
    const start = Date.UTC(2026, 8, 1, 4, 0); // 06:00 in Berlin
    const [row] = buildReviewRows(
      result([order('f', { placement: 'block_start_away', orderMs: null, waitMinutes: 600, previousEndMs: start - 600 * 60_000 })]),
      [ride('f', { startMs: start })],
    );
    expect(row).toMatchObject({ id: 'f', orderTime: '06:00', waitMinutes: null, previousEndTime: null });
  });
  it('lists vehicles once, sorted', () => expect(reviewVehicles(rows)).toEqual(['B-AB 1', 'B-CD 2']));
  it('does not mutate its input when sorting', () => {
    const copy = [...rows];
    sortReviewRows(copy);
    expect(copy).toEqual(rows);
  });
});

describe('anomalies', () => {
  it('writes values as dictionary sentences with German numbers', () => {
    expect(anomalyDetail('implausible_speed', { speedKmh: 312.4, km: 20.55, minutes: 4 })).toEqual({
      key: 'returncheck.detail.speed', vars: { speed: '312', km: '20,6', minutes: '4' },
    });
    expect(anomalyDetail('zero_distance', { minutes: 12 })?.key).toBe('returncheck.detail.zeroDistance');
    expect(anomalyDetail('position_invalid', { problem: 'outside_germany' })?.key).toBe('returncheck.detail.position.outside_germany');
  });
  it('returns null rather than a sentence with a hole', () => {
    expect(anomalyDetail('implausible_speed', { km: 5 })).toBeNull();
    expect(anomalyDetail('position_invalid', { problem: 'weird' })).toBeNull();
    expect(anomalyDetail('same_address', {})).toBeNull();
  });
  it('shows addresses for the two address findings only', () => {
    const rows = buildAnomalyRows(
      result([], [
        { rideId: 'a', type: 'same_address', values: {} },
        { rideId: 'a', type: 'zero_distance', values: { minutes: 9 } },
        { rideId: 'missing', type: 'same_street', values: {} },
      ]),
      [ride('a')],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].addresses).toEqual({ pickup: 'Hauptstr. 1, 10115 Berlin', dropoff: 'Hauptstr. 1, 10115 Berlin' });
    expect(rows[1].addresses).toBeNull();
    expect(rows[0].date).toBe('2026-09-01');
  });
});

describe('unverifiableCounts', () => {
  it('counts per reason and omits reasons with none', () => {
    const orders = [
      order('a', { placement: 'unverifiable', reason: 'no_position' }),
      order('b', { placement: 'unverifiable', reason: 'no_position' }),
      order('c', { placement: 'unverifiable', reason: 'no_order_time' }),
      order('d'),
    ];
    expect(unverifiableCounts(result(orders))).toEqual([
      { reason: 'no_order_time', count: 1 },
      { reason: 'no_position', count: 2 },
    ]);
  });
});

describe('reviewExportOptions', () => {
  it('writes German dates, rounded figures and the flags as a note', () => {
    const rows = buildReviewRows(result([order('b', { prebooked: true, waitMinutes: 40.4 })]), [ride('b')]);
    const labels = {
      sheetTitle: 's', moduleName: 'm', date: 'd', vehicle: 'v', driver: 'f', orderAt: 'o', previousEnd: 'p', wait: 'w',
      distance: 'x', placement: 't', note: 'n', placements: { away_from_base: 'Weg', block_start_away: 'Block' },
      prebooked: 'vorbestellt', samePostalCode: 'PLZ',
    };
    const options = reviewExportOptions(rows, labels);
    expect(options.rows[0]).toMatchObject({ date: '01.09.2026', wait: 40, distance: 2.3, placement: 'Weg', note: 'vorbestellt' });
    expect(options.columns.map(c => c.key)).toContain('note');
  });
});
