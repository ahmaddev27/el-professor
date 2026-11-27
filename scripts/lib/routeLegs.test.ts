import { describe, expect, it } from 'vitest';
import {
  BASE_PURPOSE, LEG_CSV_HEADERS, RETURN_PURPOSE, legCsvRow, legsFromVehicleSheet, pointLookup, recheckLeg, shiftsWithoutReturn,
} from './routeLegs.mts';
import { VEHICLE_HEADERS } from '../../src/utils/simulatedRides/monthClosing';

/** Sheet 5 as the Monatsabschluss writes it: the header list is the module's own, so a renamed column fails here. */
const H = [...VEHICLE_HEADERS];
const cell = (row: unknown[], name: string, v: unknown) => { row[H.indexOf(name)] = v; };
function legRow(over: Record<string, unknown>): unknown[] {
  const row: unknown[] = H.map(() => '');
  const base: Record<string, unknown> = {
    Kennzeichnung: 'SIMULIERT', Zeilenart: 'Leerfahrt', Fahrzeug: 'XX-TB1', Fahrer: 'Fahrer Alpha', 'Schicht-ID': 's1',
    'Leerfahrt-ID': 'l1', Zweck: 'zur Abholung', Start: 'Teststraße 1, 42651 Solingen', 'Start Breite': 51.1, 'Start Laenge': 7.0,
    Ziel: 'Teststraße 9, 42651 Solingen', 'Ziel Breite': 51.11, 'Ziel Laenge': 7.02, Abfahrt: '2026-09-08 10:00:00',
    Ankunft: '2026-09-08 10:06:00', 'Fahrzeit (s)': 360, 'Leer-km': 2.4, 'Verfuegbar (s)': 600, Anbieter: 'osrm', Status: 'ROUTED',
  };
  for (const [k, v] of Object.entries({ ...base, ...over })) cell(row, k, v);
  return row;
}
const summary = (shift: string) => { const r: unknown[] = H.map(() => ''); cell(r, 'Zeilenart', 'Schicht'); cell(r, 'Schicht-ID', shift); return r; };
const same = (_: string, name: string) => name;

describe('legsFromVehicleSheet', () => {
  it('reads the empty drives by column name and skips the shift summaries', () => {
    const legs = legsFromVehicleSheet([H, summary('s1'), legRow({}), legRow({ 'Leerfahrt-ID': 'l2', Zweck: RETURN_PURPOSE })]);
    expect(legs.map((l) => l.legId)).toEqual(['l1', 'l2']);
    expect(legs[0]).toMatchObject({ shiftId: 's1', from: { lat: 51.1, lon: 7.0 }, to: { lat: 51.11, lon: 7.02 }, ourSeconds: 360, ourKm: 2.4, availableSeconds: 600 });
  });

  it('an unrouted drive reads as no figure, never as zero seconds', () => {
    const [leg] = legsFromVehicleSheet([H, legRow({ 'Fahrzeit (s)': '', 'Leer-km': 'nicht geroutet' })]);
    expect(leg.ourSeconds).toBeNull();
    expect(leg.ourKm).toBeNull();
    expect(legCsvRow(leg, undefined, same)[LEG_CSV_HEADERS.indexOf('OurMarginSeconds')]).toBe('');
  });

  it('refuses a sheet that lost a column the CSV needs', () => {
    const broken = H.map((h) => (h === 'Ziel Laenge' ? 'Ziel Lng' : h));
    expect(() => legsFromVehicleSheet([broken, legRow({})])).toThrow(/Ziel Laenge/);
  });
});

describe('the re-check', () => {
  const [leg] = legsFromVehicleSheet([H, legRow({})]);

  it('fits when the other engine needs no more than the available time, warns when it needs more', () => {
    expect(recheckLeg(leg, { kind: 'route', seconds: 420, km: 2.6 }).status).toBe('ESTIMATE_FITS');
    const warn = recheckLeg(leg, { kind: 'route', seconds: 700, km: 3.1 });
    expect(warn.status).toBe('ROUTE_TIME_WARNING');
    expect(warn.marginSeconds).toBe(-100);
  });

  it('a drive the other engine did not answer, or whose coordinates are broken, is unverified, not fitting', () => {
    expect(recheckLeg(leg, undefined).status).toBe('UNVERIFIED');
    expect(recheckLeg(leg, { kind: 'unavailable', reason: 'no_route' }).status).toBe('UNVERIFIED');
    const [nowhere] = legsFromVehicleSheet([H, legRow({ 'Start Breite': '', 'Start Laenge': '' })]);
    const r = recheckLeg(nowhere, { kind: 'route', seconds: 10, km: 0.1 });
    expect(r.status).toBe('UNVERIFIED');
    expect(r.reason).toMatch(/coordinates_invalid/);
    expect(pointLookup({ lat: 0, lon: 0 }).kind).toBe('unlocated');
    expect(pointLookup({ lat: 91, lon: 7 }).kind).toBe('unlocated');
  });

  it('writes both ends\' coordinates, both engines\' figures and the alias, one row per drive', () => {
    const row = legCsvRow(leg, { kind: 'route', seconds: 420, km: 2.6 }, (kind) => (kind === 'vehicle' ? 'V1' : 'D01'));
    expect(row).toHaveLength(LEG_CSV_HEADERS.length);
    const at = (h: (typeof LEG_CSV_HEADERS)[number]) => row[LEG_CSV_HEADERS.indexOf(h)];
    expect([at('Vehicle'), at('Driver')]).toEqual(['V1', 'D01']);
    expect([at('FromLat'), at('FromLon'), at('ToLat'), at('ToLon')]).toEqual([51.1, 7.0, 51.11, 7.02]);
    expect([at('OurSeconds'), at('OurMarginSeconds'), at('RecheckSeconds'), at('RecheckMarginSeconds')]).toEqual([360, 240, 420, 180]);
  });
});

describe('shiftsWithoutReturn', () => {
  it('names every shift whose drives hold no return to the base', () => {
    const legs = legsFromVehicleSheet([H,
      legRow({ 'Schicht-ID': 's1', Zweck: BASE_PURPOSE }), legRow({ 'Schicht-ID': 's1', Zweck: RETURN_PURPOSE }),
      legRow({ 'Schicht-ID': 's2', Zweck: BASE_PURPOSE })]);
    expect(shiftsWithoutReturn(legs)).toEqual(['s2']);
  });

  it('names a shift that returns twice, and accepts a return of 0 km from a drop-off at the base', () => {
    const legs = legsFromVehicleSheet([H,
      legRow({ 'Schicht-ID': 's1', Zweck: BASE_PURPOSE }), legRow({ 'Schicht-ID': 's1', Zweck: RETURN_PURPOSE }),
      legRow({ 'Schicht-ID': 's1', Zweck: RETURN_PURPOSE }),
      legRow({ 'Schicht-ID': 's3', Zweck: BASE_PURPOSE }), legRow({ 'Schicht-ID': 's3', Zweck: RETURN_PURPOSE, 'Leer-km': 0, 'Fahrzeit (s)': 0 })]);
    expect(shiftsWithoutReturn(legs)).toEqual(['s1']);
  });
});
