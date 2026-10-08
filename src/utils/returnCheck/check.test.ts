import { describe, expect, it } from 'vitest';
import { DEFAULT_RETURN_CHECK_SETTINGS, runReturnCheck, suggestBase } from './check';
import { parseAddress } from './parse';
import type { CheckRide, LatLon, ReturnCheckSettings } from './types';

const BASE: LatLon = { lat: 51.1713, lon: 7.0832 }; // Solingen
const AT_BASE: LatLon = { lat: 51.1720, lon: 7.0840 }; // ~0,1 km
const DUESSELDORF: LatLon = { lat: 51.2277, lon: 6.7735 }; // ~22 km

const SETTINGS: ReturnCheckSettings = { ...DEFAULT_RETURN_CHECK_SETTINGS, base: BASE, blockGapMinutes: 30 };

/** Monday 03.08.2026, local wall times (vitest runs in Europe/Berlin). */
const at = (time: string) => new Date(`2026-08-03T${time}:00`).getTime();

function ride(id: string, start: string, end: string, extra: Partial<CheckRide> = {}): CheckRide {
  return {
    id,
    vehicle: 'SG-AB 1',
    driverName: 'Fahrer',
    status: 'completed',
    startMs: at(start),
    endMs: at(end),
    orderMs: at(start) - 5 * 60_000,
    orderProblem: null,
    position: AT_BASE,
    positionProblem: null,
    km: 5,
    prebooked: false,
    pickup: parseAddress('Hauptstraße 1, 42651 Solingen'),
    dropoff: parseAddress('Bahnhofstraße 9, 42651 Solingen'),
    sourceRow: null,
    ...extra,
  };
}

function placements(rides: CheckRide[], settings: ReturnCheckSettings = SETTINGS) {
  return runReturnCheck(rides, settings).orders.map(o => [o.rideId, o.placement, o.reason]);
}

describe('runReturnCheck — where each order reached the vehicle', () => {
  it('lets a follow-up order through when it arrived before the previous ride ended, wherever the vehicle was', () => {
    expect(placements([
      ride('a', '10:00', '10:30'),
      ride('b', '10:35', '11:00', { orderMs: at('10:20'), position: DUESSELDORF }),
    ])).toEqual([
      ['a', 'block_start_at_base', null],
      ['b', 'during_previous', null],
    ]);
  });

  it('after the previous ride ended, places the order at the base or away from it, and says how far and how long', () => {
    const result = runReturnCheck([
      ride('a', '10:00', '10:30'),
      ride('b', '10:40', '11:00', { orderMs: at('10:35'), position: AT_BASE }),
      ride('c', '11:10', '11:30', { orderMs: at('11:12'), position: DUESSELDORF }),
    ], SETTINGS);
    expect(result.orders.map(o => o.placement)).toEqual(['block_start_at_base', 'at_base', 'away_from_base']);
    const away = result.orders[2];
    expect(away).toMatchObject({ previousRideId: 'b', waitMinutes: 12 });
    expect(away.distanceKm).toBeGreaterThan(20);
    expect(away.distanceKm).toBeLessThan(25);
  });

  it('opens a block after a gap longer than the setting, and judges that start by the position alone', () => {
    expect(placements([
      ride('a', '06:00', '06:30'),
      // 90 minutes later, no order time at all: a block start needs none.
      ride('b', '08:00', '08:20', { orderMs: null, orderProblem: 'missing', position: DUESSELDORF }),
    ])).toEqual([
      ['a', 'block_start_at_base', null],
      ['b', 'block_start_away', null],
    ]);
  });

  it('says why when it cannot decide, and never guesses', () => {
    expect(placements([ride('a', '10:00', '10:30')], { ...SETTINGS, base: null })).toEqual([['a', 'unverifiable', 'no_base']]);
    expect(placements([
      ride('a', '10:00', '10:30'),
      ride('b', '10:40', '11:00', { orderMs: null, orderProblem: 'missing' }),
      ride('c', '11:10', '11:30', { orderMs: at('11:05'), position: null, positionProblem: 'missing' }),
      ride('d', '11:40', '12:00', { orderMs: at('11:35'), position: { lat: 7.08, lon: 51.17 }, positionProblem: 'outside_germany' }),
    ]).slice(1)).toEqual([
      ['b', 'unverifiable', 'no_order_time'],
      ['c', 'unverifiable', 'no_position'],
      ['d', 'unverifiable', 'no_position'],
    ]);
  });

  it('measures the previous end as the latest end so far, so an overlapping row cannot free the vehicle early', () => {
    const result = runReturnCheck([
      ride('long', '10:00', '11:00'),
      ride('inside', '10:10', '10:20', { orderMs: at('10:05') }),
      ride('next', '11:10', '11:30', { orderMs: at('10:50'), position: DUESSELDORF }),
    ], SETTINGS);
    expect(result.orders.find(o => o.rideId === 'next')).toMatchObject({ placement: 'during_previous', previousRideId: 'long' });
  });

  it('keeps each vehicle apart and leaves cancelled and untimed rides out of the sequence', () => {
    const result = runReturnCheck([
      ride('a1', '10:00', '10:30'),
      ride('b1', '10:20', '10:50', { vehicle: 'SG-CD 2', position: DUESSELDORF }),
      ride('x', '10:40', '10:50', { status: 'cancelled', startMs: null, endMs: null }),
      ride('a2', '10:40', '11:00', { orderMs: at('10:35'), position: DUESSELDORF }),
    ], SETTINGS);
    expect(result.orders.map(o => [o.vehicle, o.rideId, o.placement])).toEqual([
      ['SG-AB 1', 'a1', 'block_start_at_base'],
      ['SG-AB 1', 'a2', 'away_from_base'],
      ['SG-CD 2', 'b1', 'block_start_away'],
    ]);
    // The cancelled ride is not a completed ride: neither checked nor unverifiable.
    expect(result.checkedRides).toBe(3);
    expect(result.rides).toBe(4);
  });

  it('notes a pickup in the postal code where the previous ride ended, and a prebooked ride, without judging either', () => {
    const result = runReturnCheck([
      ride('a', '10:00', '10:30', { dropoff: parseAddress('Königsallee 1, 40212 Düsseldorf') }),
      ride('b', '10:45', '11:00', {
        orderMs: at('10:40'), position: DUESSELDORF, prebooked: true,
        pickup: parseAddress('Königsallee 30, 40212 Düsseldorf'),
      }),
    ], SETTINGS);
    expect(result.orders[1]).toMatchObject({
      placement: 'away_from_base', samePostalCodeAsPreviousDestination: true, prebooked: true,
    });
    expect(result.orders[0].samePostalCodeAsPreviousDestination).toBeNull();
  });

  it('adds up, and carries only the fields of a finding — nothing that would change a ride', () => {
    const result = runReturnCheck([
      ride('a', '10:00', '10:30'),
      ride('b', '10:35', '11:00', { orderMs: at('10:20') }),
      ride('c', '11:10', '11:30', { orderMs: at('11:12'), position: DUESSELDORF }),
    ], SETTINGS);
    const total = Object.values(result.counts.byPlacement).reduce((sum, n) => sum + n, 0);
    expect(total).toBe(result.orders.length);
    expect(Object.keys(result.orders[0]).sort()).toEqual([
      'distanceKm', 'orderMs', 'placement', 'prebooked', 'previousEndMs', 'previousRideId', 'reason',
      'rideId', 'samePostalCodeAsPreviousDestination', 'vehicle', 'waitMinutes',
    ]);
  });

  it('counts a completed ride it cannot sequence as unverifiable rather than losing it', () => {
    const result = runReturnCheck([
      ride('a', '10:00', '10:30'),
      ride('novehicle', '10:40', '11:00', { vehicle: null }),
      ride('backwards', '12:00', '11:00'),
    ], SETTINGS);
    expect(result.checkedRides).toBe(3);
    expect(result.orders.slice(1).map(o => [o.rideId, o.placement, o.reason])).toEqual([
      ['novehicle', 'unverifiable', 'no_ride_times'],
      ['backwards', 'unverifiable', 'no_ride_times'],
    ]);
    expect(result.counts.byPlacement.unverifiable).toBe(2);
  });

  it('refuses settings it cannot use, and checks nothing with them', () => {
    const result = runReturnCheck([ride('a', '10:00', '10:30')], { ...SETTINGS, baseRadiusKm: 0 });
    expect(result.status).toBe('invalid_settings');
    expect(result.orders).toEqual([]);
    expect(runReturnCheck([], { ...SETTINGS, base: { lat: 120, lon: 7 } }).status).toBe('invalid_settings');
  });
});

describe('runReturnCheck — rides whose own data does not add up', () => {
  const types = (r: CheckRide) => runReturnCheck([r], SETTINGS).anomalies.map(a => a.type);

  it('flags the same address twice, and the same street with another number', () => {
    expect(types(ride('a', '10:00', '10:10', {
      pickup: parseAddress('Beethovenstraße 12, 42655 Solingen, Deutschland'),
      dropoff: parseAddress('Beethovenstr. 12, 42655 Solingen'),
    }))).toEqual(['same_address']);
    const sameStreet = runReturnCheck([ride('a', '10:00', '10:10', {
      pickup: parseAddress('Beethovenstraße 12, 42655 Solingen'),
      dropoff: parseAddress('Beethovenstrasse 44, 42655 Solingen'),
    })], SETTINGS).anomalies;
    expect(sameStreet).toEqual([{ rideId: 'a', type: 'same_street', values: { from: '12', to: '44' } }]);
    // A place name in front does not hide that both ends are one address.
    expect(types(ride('a', '10:00', '10:10', {
      pickup: parseAddress('Hbf, Bahnhofstraße 1, 42651 Solingen'),
      dropoff: parseAddress('Bahnhofstr. 1, 42651 Solingen, Deutschland'),
    }))).toEqual(['same_address']);
    // The same street name in another postal code is another street.
    expect(types(ride('a', '10:00', '10:10', {
      pickup: parseAddress('Hauptstraße 1, 42651 Solingen'),
      dropoff: parseAddress('Hauptstraße 9, 42699 Solingen'),
    }))).toEqual([]);
  });

  it('flags a speed no car drives, and a ride of minutes with no kilometres', () => {
    expect(runReturnCheck([ride('a', '10:00', '10:10', { km: 40 })], SETTINGS).anomalies)
      .toEqual([{ rideId: 'a', type: 'implausible_speed', values: { km: 40, minutes: 10, speedKmh: 240 } }]);
    expect(types(ride('a', '10:00', '10:10', { km: 15 }))).toEqual([]);
    expect(types(ride('a', '10:00', '10:10', { km: 0 }))).toEqual(['zero_distance']);
    expect(types(ride('a', '10:00', '10:02', { km: 0 }))).toEqual([]);
  });

  it('flags an unusable position and an order transmitted after the ride began', () => {
    expect(types(ride('a', '10:00', '10:10', { position: null, positionProblem: 'unparsed' }))).toEqual(['position_invalid']);
    expect(types(ride('a', '10:00', '10:20', { orderMs: at('10:05') }))).toEqual(['order_after_start']);
    expect(types(ride('a', '10:00', '10:20', { orderMs: at('10:00') + 30_000 }))).toEqual([]);
  });

  it('judges completed rides only', () => {
    expect(types(ride('a', '10:00', '10:10', { status: 'cancelled', km: 40 }))).toEqual([]);
  });
});

describe('suggestBase', () => {
  it('proposes where most blocks began, with how many of them', () => {
    const rides = [
      ride('a', '06:00', '06:30', { position: { lat: 51.1712, lon: 7.0831 } }),
      ride('b', '09:00', '09:30', { position: { lat: 51.1716, lon: 7.0836 } }),
      ride('c', '12:00', '12:30', { position: { lat: 51.1714, lon: 7.0833 } }),
      ride('d', '15:00', '15:30', { position: DUESSELDORF }),
      // Inside a block: not a block start, so not counted.
      ride('e', '15:40', '16:00', { orderMs: at('15:35'), position: DUESSELDORF }),
    ];
    const suggestion = suggestBase(rides, 30);
    expect(suggestion).toMatchObject({ blockStarts: 3, ofBlockStarts: 4 });
    expect(suggestion?.position.lat).toBeCloseTo(51.1714, 3);
    expect(suggestion?.position.lon).toBeCloseTo(7.0833, 3);
  });

  it('proposes nothing without a usable position', () => {
    expect(suggestBase([ride('a', '06:00', '06:30', { position: null, positionProblem: 'missing' })], 30)).toBeNull();
  });
});
