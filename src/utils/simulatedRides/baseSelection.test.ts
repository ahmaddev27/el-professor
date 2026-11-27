import { describe, expect, it } from 'vitest';
import type { GeocodeBatchAnswer, GeocodeQuery, UnlocatedReason } from '../../../supabase/functions/_shared/geocode-core';
import type { GeocodeClient } from '../../lib/geocodeClient';
import { SAVED_POINT_LABEL, companyAddressText, resolveBase, savedPoint } from './baseSelection';

/**
 * §12 class 22: the base comes from the saved point, otherwise from the
 * company's address found at house level, and otherwise there is no base and
 * no month. The address-pool centre is never offered, in any branch.
 */

const SAVED = { lat: 51.1036, lon: 7.0287 };
const HOUSE = { lat: 51.1418, lon: 7.0811 };
const ADDRESS = { street: 'Musterweg', house_number: '7', postal_code: '40210', city: 'Demostadt' };

/** A geocoder that answers from a script and remembers what it was asked. */
function geocoder(answer: (batch: readonly GeocodeQuery[]) => GeocodeBatchAnswer): GeocodeClient & { asked: GeocodeQuery[][] } {
  const asked: GeocodeQuery[][] = [];
  return {
    asked,
    geocode: async batch => { asked.push([...batch]); return answer(batch); },
  };
}

const locates = () => geocoder(batch => ({
  ok: true, dataUpdated: null,
  results: batch.map(q => ({ id: q.id, kind: 'located' as const, ...HOUSE, precision: 'exact' as const, osm: 'node/1' })),
}));
const refuses = (reason: UnlocatedReason) => geocoder(batch => ({
  ok: true, dataUpdated: null, results: batch.map(q => ({ id: q.id, kind: 'unlocated' as const, reason })),
}));

describe('resolveBase', () => {
  it('a saved point wins, and the address is not even asked about', async () => {
    const g = locates();
    const out = await resolveBase({ saved: SAVED, address: ADDRESS, geocoder: g });
    expect(out).toEqual({ ok: true, base: SAVED, source: 'saved_point', label: SAVED_POINT_LABEL });
    expect(g.asked).toEqual([]);
  });

  it('with no saved point, the company address found at house level is the base, labelled as derived', async () => {
    const g = locates();
    const out = await resolveBase({ saved: null, address: { ...ADDRESS, street: '  Musterweg ' }, geocoder: g });
    expect(out).toEqual({
      ok: true, base: HOUSE, source: 'company_address',
      label: 'Musterweg 7, 40210 Demostadt (Betriebssitz aus der Firmenadresse abgeleitet)',
    });
    expect(g.asked).toEqual([[{ id: 'company-base', text: 'Musterweg 7, 40210 Demostadt' }]]);
  });

  it('negative: no saved point and no address field at all is no base, and nobody is asked', async () => {
    const g = locates();
    for (const address of [null, {}, { street: '', house_number: ' ', postal_code: null, city: undefined }]) {
      expect(await resolveBase({ saved: null, address, geocoder: g })).toEqual({ ok: false, reason: 'no_base_configured', detail: null });
    }
    expect(g.asked).toEqual([]);
  });

  it('negative: an address without a house number is incomplete and is never geocoded to a street', async () => {
    const g = locates();
    const out = await resolveBase({ saved: null, address: { ...ADDRESS, house_number: '' }, geocoder: g });
    expect(out).toEqual({ ok: false, reason: 'address_incomplete', detail: 'house_number' });
    expect(g.asked).toEqual([]);
  });

  it('negative: an address with only a city names every missing field', async () => {
    const out = await resolveBase({ saved: null, address: { city: 'Demostadt' }, geocoder: locates() });
    expect(out).toEqual({ ok: false, reason: 'address_incomplete', detail: 'street, house_number, postal_code' });
  });

  it.each(['not_found', 'too_coarse', 'postcode_mismatch', 'ambiguous', 'no_house_number', 'unparseable'] as const)(
    'negative: a geocoder answer of %s is no base, never an approximate point', async reason => {
      const out = await resolveBase({ saved: null, address: ADDRESS, geocoder: refuses(reason) });
      expect(out).toEqual({ ok: false, reason: 'address_not_located', detail: reason });
    },
  );

  it.each(['rate_limited', 'service_error', 'bad_answer', 'unreachable', 'timeout', 'rejected'] as const)(
    'negative: an unanswered address (%s) is reported as the geocoder being unavailable', async reason => {
      const out = await resolveBase({ saved: null, address: ADDRESS, geocoder: refuses(reason) });
      expect(out).toEqual({ ok: false, reason: 'geocoder_unavailable', detail: reason });
    },
  );

  it('negative: a refused batch and an answer without our id are the geocoder being unavailable', async () => {
    const down = geocoder(() => ({ ok: false, reason: 'function_unreachable' }));
    expect(await resolveBase({ saved: null, address: ADDRESS, geocoder: down }))
      .toEqual({ ok: false, reason: 'geocoder_unavailable', detail: 'function_unreachable' });
    const other = geocoder(() => ({ ok: true, dataUpdated: null, results: [{ id: 'someone-else', kind: 'located', ...HOUSE, precision: 'exact', osm: null }] }));
    expect(await resolveBase({ saved: null, address: ADDRESS, geocoder: other }))
      .toEqual({ ok: false, reason: 'geocoder_unavailable', detail: 'bad_answer' });
  });

  it('every answer is the saved point, the located house or a refusal: no other coordinate can come out', async () => {
    const cases = [
      await resolveBase({ saved: SAVED, address: null, geocoder: refuses('too_coarse') }),
      await resolveBase({ saved: null, address: ADDRESS, geocoder: locates() }),
      await resolveBase({ saved: null, address: ADDRESS, geocoder: refuses('ambiguous') }),
      await resolveBase({ saved: null, address: { city: 'Demostadt' }, geocoder: locates() }),
    ];
    const points = cases.flatMap(c => (c.ok ? [c.base] : []));
    expect(points).toEqual([SAVED, HOUSE]);
  });
});

describe('savedPoint', () => {
  it('reads two finite coordinates, also from the numeric strings PostgREST returns', () => {
    expect(savedPoint(51.1, 7.02)).toEqual({ lat: 51.1, lon: 7.02 });
    expect(savedPoint('51.1', '7.02')).toEqual({ lat: 51.1, lon: 7.02 });
  });

  it.each([
    ['no row', null, null],
    ['half a pair', 51.1, null],
    ['empty strings', '', ''],
    ['text', 'Nord', 'Ost'],
    ['out of range', 91, 7],
    ['not finite', Infinity, 7],
  ])('negative: %s is no saved point', (_n, lat, lon) => {
    expect(savedPoint(lat, lon)).toBeNull();
  });
});

describe('companyAddressText', () => {
  it('writes the shape the geocoder parses, trimmed', () => {
    expect(companyAddressText({ street: ' Hauptstraße', house_number: '12a ', postal_code: '42651', city: 'Solingen' }))
      .toEqual({ text: 'Hauptstraße 12a, 42651 Solingen' });
  });
});
