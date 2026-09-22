/**
 * From today's fahrtenbuch_trips rows to AnalysisTrip. The Uber cells below
 * copy the shape of the 08/2026 sample (full local date-times, `\N` for an
 * empty cell); names and addresses are invented.
 */
import { describe, expect, it } from 'vitest';
import { resolveActualRideWindow } from '../planningQualityChecks';
import { analysisTripFromRow } from './adapter';
import { analyzeTrips } from './analyze';
import type { TripRowForAnalysis } from './types';

const MIN = 60_000;

function uberCells(start: string, end: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    'Datum/Uhrzeit Auftragseingang': '2026-08-01 00:04:26.000',
    'Uhrzeit der Auftragsuebermittlung': '2026-08-01 00:04:26.683',
    'Datum der Fahrt': '2026-08-01',
    Fahrtstatus: 'abgeschlossen',
    'Uhrzeit des Fahrtbeginns': start,
    'Uhrzeit des Fahrtendes': end,
    Kennzeichen: 'SG-XX14',
    Fahrername: 'Testfahrer Eins',
    Fahrpreis: '10.95',
    ...extra,
  };
}

function row(over: Partial<TripRowForAnalysis> = {}): TripRowForAnalysis {
  return {
    id: 'r1',
    trip_date: '2026-08-01',
    start_time: '00:06',
    end_time: '00:17',
    original_driver_id: 'd1',
    original_driver_name: 'Testfahrer Eins',
    car_identifier: 'SG-XX14',
    route_start: 'Musterstraße 1, 40227 Düsseldorf',
    route_end: 'Beispielweg 2, 40479 Düsseldorf',
    price_amount: 10.95,
    is_canceled: false,
    source_status: 'abgeschlossen',
    source_row_index: 2,
    raw_data_json: uberCells('2026-08-01 00:06:33.000', '2026-08-01 00:17:51.000'),
    ...over,
  };
}

function local(text: string): number {
  return new Date(text).getTime();
}

describe('analysisTripFromRow', () => {
  it('reads an Uber row through the source start and end columns, seconds kept', () => {
    const trip = analysisTripFromRow(row());
    expect(trip).toEqual({
      id: 'r1',
      driver_id: 'd1',
      driver_name: 'Testfahrer Eins',
      vehicle: 'SG-XX14',
      start_ms: local('2026-08-01T00:06:33'),
      end_ms: local('2026-08-01T00:17:51'),
      status: 'completed',
      price: 10.95,
      currency: null,
      source_row: 2,
      pickup_address: 'Musterstraße 1, 40227 Düsseldorf',
      dropoff_address: 'Beispielweg 2, 40479 Düsseldorf',
      time_source: 'raw_local_datetime',
      time_ambiguity: null,
    });
    expect((trip.end_ms as number) - (trip.start_ms as number)).toBe(678_000);
  });

  it('takes the date from the start column, not from "Datum der Fahrt"', () => {
    // The trip began after midnight; trip_date (column D) still says the day before.
    const trip = analysisTripFromRow(
      row({ trip_date: '2026-08-01', start_time: '00:04', end_time: '00:20', raw_data_json: uberCells('2026-08-02 00:04:31.000', '2026-08-02 00:20:02.000') }),
    );
    expect(trip.start_ms).toBe(local('2026-08-02T00:04:31'));
  });

  it('keeps the side it has when only one date-time is present, instead of falling back to trip_date', () => {
    const trip = analysisTripFromRow(row({ end_time: null, raw_data_json: uberCells('2026-08-02 00:04:31.000', '\\N') }));
    expect(trip.start_ms).toBe(local('2026-08-02T00:04:31'));
    expect(trip.end_ms).toBeNull();
    expect(trip.time_source).toBe('raw_local_datetime');
  });

  it('a cancelled Uber row has no times and stays cancelled, fee untouched', () => {
    const trip = analysisTripFromRow(
      row({ is_canceled: true, source_status: 'storniert', start_time: null, end_time: null, price_amount: '6', raw_data_json: uberCells('\\N', '\\N') }),
    );
    expect(trip).toMatchObject({ status: 'cancelled', start_ms: null, end_ms: null, price: '6' });
  });

  it('prefers slice A absolute columns, and never falls back from them', () => {
    const absolute = analysisTripFromRow(
      row({ start_at: '2026-10-25T02:50:00+02:00', end_at: '2026-10-25T02:10:00+01:00', currency: 'EUR', trip_status: 'completed' }),
    );
    expect(absolute).toMatchObject({ time_source: 'absolute', time_ambiguity: null, currency: 'EUR' });
    expect((absolute.end_ms as number) - (absolute.start_ms as number)).toBe(20 * MIN);

    const missing = analysisTripFromRow(row({ start_at: '2026-08-01T00:06:33+02:00', end_at: null }));
    expect(missing.end_ms).toBeNull();
  });

  it('maps statuses by an explicit rule; anything unrecognised is unknown', () => {
    expect(analysisTripFromRow(row({ source_status: 'Abgeschlossen ' })).status).toBe('completed');
    expect(analysisTripFromRow(row({ source_status: 'unterwegs' })).status).toBe('unknown');
    expect(analysisTripFromRow(row({ source_status: null })).status).toBe('unknown');
    expect(analysisTripFromRow(row({ is_canceled: true })).status).toBe('cancelled');
    expect(analysisTripFromRow(row({ source_status: 'unterwegs', trip_status: 'completed' })).status).toBe('completed');
  });

  it('reads `\\N` and blanks as missing identity, never as a name', () => {
    const trip = analysisTripFromRow(row({ original_driver_id: ' ', original_driver_name: '\\N', car_identifier: '', route_start: '\\N' }));
    expect(trip).toMatchObject({ driver_id: null, driver_name: null, vehicle: null, pickup_address: null });
  });
});

describe('DST in local date-times: flagged, never resolved', () => {
  it('marks the October Sunday 02:00–03:00 hour as ambiguous and sends the row to review', () => {
    const trip = analysisTripFromRow(row({ raw_data_json: uberCells('2026-10-25 02:50:00.000', '2026-10-25 02:10:00.000') }));
    expect(trip.time_ambiguity).toBe('dst_ambiguous');
    const result = analyzeTrips({ trips: [trip], settings: { blockGapMinutes: 30, travelMarginMinutes: 0 } });
    expect(result.trips[0].excludedBecause).toEqual(['ambiguous_local_time']);
    expect(result.issues.map(i => i.type)).not.toContain('end_before_start');
  });

  it('marks a March Sunday time that never existed', () => {
    const trip = analysisTripFromRow(row({ raw_data_json: uberCells('2026-03-29 02:30:00.000', '2026-03-29 03:40:00.000') }));
    expect(trip.time_ambiguity).toBe('dst_nonexistent');
  });

  it('leaves unambiguous times on both Sundays alone, and measures across the switch', () => {
    const spring = analysisTripFromRow(row({ raw_data_json: uberCells('2026-03-29 01:50:00.000', '2026-03-29 03:10:00.000') }));
    expect(spring.time_ambiguity).toBeNull();
    expect((spring.end_ms as number) - (spring.start_ms as number)).toBe(20 * MIN);
    const autumn = analysisTripFromRow(row({ raw_data_json: uberCells('2026-10-25 12:00:00.000', '2026-10-25 12:30:00.000') }));
    expect(autumn.time_ambiguity).toBeNull();
  });
});

describe('the trip_date + HH:MM fallback, for rows without source date-times', () => {
  const noRaw = (trip_date: string, start_time: string, end_time: string) =>
    analysisTripFromRow(row({ trip_date, start_time, end_time, raw_data_json: {} }));

  it('reads minute precision and marks the source', () => {
    const trip = noRaw('2026-08-03', '08:00', '08:30');
    expect(trip).toMatchObject({ time_source: 'trip_date_hhmm', start_ms: local('2026-08-03T08:00:00') });
    expect((trip.end_ms as number) - (trip.start_ms as number)).toBe(30 * MIN);
  });

  it('adds a calendar day for an overnight trip, also on both DST Sundays', () => {
    const plain = noRaw('2026-08-03', '23:50', '00:10');
    expect((plain.end_ms as number) - (plain.start_ms as number)).toBe(20 * MIN);
    for (const sunday of ['2026-03-29', '2026-10-25']) {
      const trip = noRaw(sunday, '23:50', '00:10');
      expect((trip.end_ms as number) - (trip.start_ms as number)).toBe(20 * MIN);
    }
    // Why the adapter does its own arithmetic here: the resolver adds a fixed
    // 24 h, which is 80 minutes on the March Sunday.
    const resolver = resolveActualRideWindow({ trip_date: '2026-03-29', start_time: '23:50', end_time: '00:10', raw_data_json: {} });
    expect(resolver.actualEndMs - resolver.actualStartMs).toBe(80 * MIN);
  });

  it('reads equal HH:MM as a trip under a minute, not as a 24-hour trip', () => {
    const trip = noRaw('2026-08-03', '10:00', '10:00');
    expect(trip.end_ms).toBe(trip.start_ms);
  });

  it('gives its findings medium confidence', () => {
    const trips = [
      { ...noRaw('2026-08-03', '08:00', '08:30'), id: 'a' },
      { ...noRaw('2026-08-03', '08:20', '08:40'), id: 'b' },
    ];
    const result = analyzeTrips({ trips, settings: { blockGapMinutes: 30, travelMarginMinutes: 0 } });
    expect(result.issues.find(i => i.type === 'driver_overlap')?.confidence).toBe('medium');
  });
});
