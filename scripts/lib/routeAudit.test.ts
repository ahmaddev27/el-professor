import { describe, expect, it } from 'vitest';
import {
  buildTransitions, causeClass, classifyTransition, csvLine, parseCsv, percentile, wallMs,
  type AuditRide, type GeocodeLookup, type RouteLookup,
} from './routeAudit.mts';

const at = (hhmm: string) => wallMs(`2026-09-07 ${hhmm}:00`);
const ride = (nr: number, s: string, e: string, over: Partial<AuditRide> = {}): AuditRide => ({
  nr, startMs: at(s), endMs: at(e), vehicle: 'V1', driver: 'Fahrer 1',
  pickup: 'Teststraße 1, 40210 Demostadt, Deutschland', dropoff: 'Teststraße 2, 40210 Demostadt, Deutschland', cancelled: false, ...over,
});
const here: GeocodeLookup = { kind: 'located', lat: 51.2, lon: 6.8 };
const t = (available: number, from = 'Teststraße 1, 40210 Demostadt', to = 'Teststraße 9, 40210 Demostadt') =>
  ({ availableSeconds: available, fromText: from, toText: to });
const r = (seconds: number, km = 2): RouteLookup => ({ kind: 'route', seconds, km });

describe('buildTransitions', () => {
  it('pairs consecutive completed rides per vehicle and per driver, skipping cancelled ones', () => {
    const rides = [ride(1, '08:00', '08:10'), ride(2, '08:20', '08:30', { cancelled: true }), ride(3, '08:40', '08:50'),
      ride(4, '09:00', '09:10', { vehicle: 'V2' })];
    const out = buildTransitions(rides);
    const vehicle = out.filter((x) => x.grouping === 'vehicle');
    const driver = out.filter((x) => x.grouping === 'driver');
    expect(vehicle.map((x) => [x.prevNr, x.nextNr, x.availableSeconds])).toEqual([[1, 3, 1800]]);
    expect(driver.map((x) => [x.prevNr, x.nextNr])).toEqual([[1, 3], [3, 4]]);
  });
  it('sorts by start and drops rides with unreadable times', () => {
    const out = buildTransitions([ride(2, '09:00', '09:10'), ride(1, '08:00', '08:10'), { ...ride(3, '10:00', '10:10'), endMs: Number.NaN }]);
    expect(out.filter((x) => x.grouping === 'vehicle').map((x) => [x.prevNr, x.nextNr])).toEqual([[1, 2]]);
  });
});

describe('classifyTransition', () => {
  it('fits only with both ends located and a measured route inside the gap', () => {
    const c = classifyTransition(t(300), here, here, r(240));
    expect(c).toMatchObject({ status: 'ESTIMATE_FITS', roadSeconds: 240, marginSeconds: 60 });
    expect(c.reason).toContain('estimate');
  });
  it('warns when the road time exceeds the gap and reports the shortfall', () => {
    expect(classifyTransition(t(200), here, here, r(260))).toMatchObject({ status: 'ROUTE_TIME_WARNING', marginSeconds: -60 });
  });
  it('same address text is SAME_ADDRESS whatever the geocoder said, case and country aside', () => {
    const c = classifyTransition(t(5, 'Teststraße 1, 40210 Demostadt, Deutschland', 'teststraße 1,  40210 Demostadt'), undefined, undefined, undefined);
    expect(c.status).toBe('SAME_ADDRESS');
  });
  it('an unlocated end is UNVERIFIED with the geocoder reason, never a pass', () => {
    const c = classifyTransition(t(900), { kind: 'unlocated', reason: 'too_coarse' }, here, r(10));
    expect(c.status).toBe('UNVERIFIED');
    expect(c.reason).toContain('dropoff:too_coarse');
    expect(c.roadSeconds).toBeNull();
    const d = classifyTransition(t(900), here, { kind: 'unlocated', reason: 'no_house_number' }, r(10));
    expect(d.reason).toContain('pickup:no_house_number');
  });
  it.each([
    ['undefined', undefined],
    ['unavailable', { kind: 'unavailable', reason: 'timeout' } as RouteLookup],
    ['NaN', r(Number.NaN)],
    ['Infinity', r(Number.POSITIVE_INFINITY)],
    ['negative', r(-5)],
    ['NaN km', r(100, Number.NaN)],
  ])('route %s is UNVERIFIED, no zero, no pass', (_n, route) => {
    const c = classifyTransition(t(10_000), here, here, route);
    expect(c.status).toBe('UNVERIFIED');
    expect(c.roadSeconds).toBeNull();
    expect(c.marginSeconds).toBeNull();
  });
  it('an unreadable gap is UNVERIFIED', () => {
    expect(classifyTransition(t(Number.NaN), here, here, r(10)).status).toBe('UNVERIFIED');
  });
});

describe('causeClass', () => {
  const base = { availableSeconds: 200, fromLocated: true, toLocated: true, modelSeconds: 150, engineSeconds: 260 };
  it('model_underestimate: gap honours the model, engine needs longer', () => expect(causeClass(base)).toBe('model_underestimate'));
  it('model_violated: gap below the generator\'s own estimate', () => expect(causeClass({ ...base, modelSeconds: 220 })).toBe('model_violated'));
  it('geocode wins when an end is not located', () => expect(causeClass({ ...base, toLocated: false, modelSeconds: null })).toBe('geocode'));
  it('engine_disagreement: our engine fits the gap', () => expect(causeClass({ ...base, engineSeconds: 190 })).toBe('engine_disagreement'));
  it('no engine answer is route_unavailable, not a pass', () => expect(causeClass({ ...base, engineSeconds: null })).toBe('route_unavailable'));
});

describe('helpers', () => {
  it('percentile interpolates and ignores NaN', () => {
    expect(percentile([1, 2, 3, 4, Number.NaN], 0.5)).toBe(2.5);
    expect(Number.isNaN(percentile([], 0.5))).toBe(true);
  });
  it('csv round-trips quotes, commas and a BOM', () => {
    const line = csvLine(['a,b', 'say "x"', 3, null]);
    expect(parseCsv(`﻿${line}\r\nz,y\n`)).toEqual([['a,b', 'say "x"', '3', ''], ['z', 'y']]);
  });
});
