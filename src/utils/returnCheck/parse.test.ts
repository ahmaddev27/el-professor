import { describe, expect, it } from 'vitest';
import { checkRideFromRow, parseAddress, parseKilometres, parsePosition } from './parse';
import type { TripRowForAnalysis } from '../tripAnalysis/types';

function row(raw: Record<string, unknown>, extra: Partial<TripRowForAnalysis> = {}): TripRowForAnalysis {
  return {
    id: 'r1',
    trip_date: '2026-08-03',
    start_time: '10:00',
    end_time: '10:20',
    original_driver_id: 'd1',
    original_driver_name: 'Fahrer Eins',
    car_identifier: 'SG-AB 1',
    route_start: 'Konrad-Adenauer-Straße 12, 42651 Solingen, Deutschland',
    route_end: 'Hauptstr. 5, 40213 Düsseldorf, Deutschland',
    price_amount: '25.00',
    is_canceled: false,
    source_status: 'abgeschlossen',
    source_row_index: 7,
    raw_data_json: raw,
    start_at: '2026-08-03T08:00:00Z',
    end_at: '2026-08-03T08:20:00Z',
    currency: 'EUR',
    trip_status: 'completed',
    ...extra,
  };
}

describe('parseAddress', () => {
  it('splits street, number, postal code and city, and normalises the street word', () => {
    expect(parseAddress('Konrad-Adenauer-Straße 12, 42651 Solingen, Deutschland')).toEqual({
      raw: 'Konrad-Adenauer-Straße 12, 42651 Solingen, Deutschland',
      normalized: 'konrad-adenauer-str 12, 42651 solingen',
      street: 'konrad-adenauer-str',
      houseNumber: '12',
      postalCode: '42651',
      city: 'solingen',
    });
  });

  it('reads "Str.", "Strasse" and "Straße" as the same street', () => {
    const a = parseAddress('Beethovenstr. 12, 42655 Solingen');
    const b = parseAddress('Beethovenstrasse 44, 42655 Solingen');
    const c = parseAddress('Beethovenstraße 44, 42655 Solingen, Deutschland');
    expect(a?.street).toBe('beethovenstr');
    expect(b?.street).toBe('beethovenstr');
    expect(b?.normalized).toBe(c?.normalized);
  });

  it('takes the street from the segment before the postal code when a place name comes first', () => {
    expect(parseAddress('Hauptbahnhof, Bahnhofstraße 1a, 42651 Solingen, Deutschland')).toMatchObject({
      street: 'bahnhofstr', houseNumber: '1a', postalCode: '42651', city: 'solingen',
    });
  });

  it('passes over a place name in front even when the address has no postal code', () => {
    expect(parseAddress('Hauptbahnhof, Bahnhofstraße 1')).toMatchObject({ street: 'bahnhofstr', houseNumber: '1', postalCode: null });
  });

  it('names no street when the address carries no number, and nothing at all when empty', () => {
    expect(parseAddress('Flughafen Düsseldorf, 40474 Düsseldorf')).toMatchObject({ street: null, houseNumber: null, postalCode: '40474' });
    expect(parseAddress('  ')).toBeNull();
    expect(parseAddress(null)).toBeNull();
  });
});

describe('positions and kilometres', () => {
  it('reads "lat lon", and refuses what is not a position', () => {
    expect(parsePosition('51.171290 7.083210')).toEqual({ position: { lat: 51.17129, lon: 7.08321 }, problem: null });
    expect(parsePosition('')).toEqual({ position: null, problem: 'missing' });
    expect(parsePosition('Unterwegs in Düsseldorf')).toEqual({ position: null, problem: 'unparsed' });
    // Swapped coordinates land in the Arabian Sea, not in Germany.
    expect(parsePosition('7.083210 51.171290').problem).toBe('outside_germany');
    expect(parsePosition('0 0').problem).toBe('outside_germany');
    // A bare comma is a German decimal: "51,7" is one number, never latitude 51 and longitude 7.
    expect(parsePosition('51,7').problem).toBe('unparsed');
    expect(parsePosition('51.1713; 7.0832').position).toEqual({ lat: 51.1713, lon: 7.0832 });
    expect(parsePosition('51.1713, 7.0832').position).toEqual({ lat: 51.1713, lon: 7.0832 });
  });

  it('reads kilometres with a dot or a comma, and answers null rather than 0 for nonsense', () => {
    expect(parseKilometres('12.5')).toBe(12.5);
    expect(parseKilometres('12,5')).toBe(12.5);
    expect(parseKilometres(7)).toBe(7);
    expect(parseKilometres('')).toBeNull();
    expect(parseKilometres('n/a')).toBeNull();
    expect(parseKilometres(-3)).toBeNull();
  });
});

describe('checkRideFromRow', () => {
  it('reads the four export columns by name, in whatever order the row lists them', () => {
    const ride = checkRideFromRow(row({
      // The export lists the end before the start; nothing here reads by position.
      'Uhrzeit des Fahrtendes': '2026-08-03 10:20:00.000',
      'Kilometer': '14.2',
      'Standort des Fahrzeugs bei Auftragsuebermittlung': '51.171290 7.083210',
      'Vorreservierte Fahrt': 'Nein',
      'Uhrzeit der Auftragsuebermittlung': '2026-08-03 09:55:30.000',
      'Uhrzeit des Fahrtbeginns': '2026-08-03 10:00:00.000',
    }));
    expect(ride).toMatchObject({
      id: 'r1',
      vehicle: 'SG-AB 1',
      driverName: 'Fahrer Eins',
      status: 'completed',
      startMs: Date.parse('2026-08-03T08:00:00Z'),
      endMs: Date.parse('2026-08-03T08:20:00Z'),
      // 09:55:30 in Berlin in August is 07:55:30 UTC.
      orderMs: Date.parse('2026-08-03T07:55:30Z'),
      orderProblem: null,
      position: { lat: 51.17129, lon: 7.08321 },
      positionProblem: null,
      km: 14.2,
      prebooked: false,
      sourceRow: 7,
    });
    expect(ride.pickup?.postalCode).toBe('42651');
    expect(ride.dropoff?.city).toBe('düsseldorf');
  });

  it('accepts the ü spelling of the headers, and says when a field is missing or unreadable', () => {
    const umlaut = checkRideFromRow(row({
      'Uhrzeit der Auftragsübermittlung': '03.08.2026 09:55',
      'Standort des Fahrzeugs bei Auftragsübermittlung': '51.1 7.0',
    }));
    expect(umlaut.orderMs).toBe(Date.parse('2026-08-03T07:55:00Z'));
    expect(umlaut.position).toEqual({ lat: 51.1, lon: 7 });

    const missing = checkRideFromRow(row({}));
    expect(missing).toMatchObject({ orderMs: null, orderProblem: 'missing', positionProblem: 'missing', km: null, prebooked: null });

    const broken = checkRideFromRow(row({ 'Uhrzeit der Auftragsuebermittlung': 'gestern' }));
    expect(broken.orderProblem).toBe('unparsed');
  });

  it('does not guess a wall time the clocks skip', () => {
    // 29.03.2026 02:30 does not exist in Berlin.
    const skipped = checkRideFromRow(row({ 'Uhrzeit der Auftragsuebermittlung': '2026-03-29 02:30:00' }));
    expect(skipped).toMatchObject({ orderMs: null, orderProblem: 'unparsed' });
  });
});
