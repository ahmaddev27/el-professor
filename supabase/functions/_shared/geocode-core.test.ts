import { describe, expect, it } from 'vitest';
import {
  GEOCODER_ORIGIN,
  GEOCODE_REFUSAL_REASONS,
  HOUSE_RANK,
  INFRASTRUCTURE_REASONS,
  MAX_ADDRESSES_PER_CALL,
  MAX_ADDRESS_CHARS,
  MAX_GEOCODE_BODY_CHARS,
  SAME_PLACE_METERS,
  UNLOCATED_REASONS,
  addressKey,
  distanceMeters,
  geocodeAddresses,
  geocodeRefusalStatus,
  geocoderVersionLabel,
  interpretNominatimAnswer,
  normalizeHouseNumber,
  parseGeocodeBody,
  parseGeocodeRequest,
  parseGeocodeResponse,
  parseSheetAddress,
  readServiceStatus,
  searchPath,
  type ParsedAddress,
} from './geocode-core';

const solingen: ParsedAddress = { street: 'Hauptstraße', houseNumber: '12', postcode: '42651', city: 'Solingen' };

describe('parseSheetAddress', () => {
  it('reads the shape of the Uber sheet: street and number, postal code and city, the country last', () => {
    expect(parseSheetAddress('Hauptstraße 12, 42651 Solingen, Deutschland')).toEqual(solingen);
  });

  it('reads it without the country, and with spaces and an English country', () => {
    expect(parseSheetAddress('  Hauptstraße   12 ,  42651   Solingen ')).toEqual(solingen);
    expect(parseSheetAddress('Hauptstraße 12, 42651 Solingen, Germany')).toEqual(solingen);
  });

  it.each([
    ['Kronprinzenstraße 127B, 42655 Solingen', '127B'],
    ['Kronprinzenstraße 127 B, 42655 Solingen', '127B'],
    ['Kronprinzenstraße 12-14, 42655 Solingen', '12-14'],
    ['Kronprinzenstraße 12 - 14, 42655 Solingen', '12-14'],
    ['Kronprinzenstraße 12/1, 42655 Solingen', '12/1'],
    ['Kronprinzenstraße 12a-14b, 42655 Solingen', '12a-14b'],
  ])('keeps the whole house number of "%s" as %s', (text, number) => {
    const parsed = parseSheetAddress(text);
    expect(typeof parsed).toBe('object');
    expect((parsed as ParsedAddress).houseNumber).toBe(number);
    expect((parsed as ParsedAddress).street).toBe('Kronprinzenstraße');
  });

  it('drops the name in front of the street and takes the street before the postal code', () => {
    expect(parseSheetAddress('Hotel Kaiserhof, Kölner Straße 5, 40211 Düsseldorf, Deutschland')).toEqual({
      street: 'Kölner Straße', houseNumber: '5', postcode: '40211', city: 'Düsseldorf',
    });
  });

  it('takes the number from the end of a street name that has a number in it', () => {
    expect(parseSheetAddress('Straße des 17. Juni 5, 10623 Berlin')).toEqual({
      street: 'Straße des 17. Juni', houseNumber: '5', postcode: '10623', city: 'Berlin',
    });
  });

  it('says no_house_number for a street and for a bare place name: there is no single point to find', () => {
    expect(parseSheetAddress('Königstraße, 42651 Solingen, Deutschland')).toBe('no_house_number');
    expect(parseSheetAddress('Hauptbahnhof Wuppertal, 42103 Wuppertal, Deutschland')).toBe('no_house_number');
    expect(parseSheetAddress('Café Central, Marktplatz, 42651 Solingen, Deutschland')).toBe('no_house_number');
  });

  it.each([
    '',
    'Hauptstraße 12',
    'Hauptstraße 12, Solingen, Deutschland',
    '42651 Solingen, Deutschland',
    'Hauptstraße 12, 4265 Solingen',
    'Hauptstraße 12, 426511 Solingen',
  ])('says unparseable for "%s": no postal code part, or nothing before it', (text) => {
    expect(parseSheetAddress(text)).toBe('unparseable');
  });

  it('does not take a number out of the city', () => {
    expect(parseSheetAddress('Hauptstraße, 42651 Solingen 2')).toBe('no_house_number');
  });
});

describe('addressKey', () => {
  it('is one key for one place however it is spaced and capitalised, with or without the country', () => {
    const key = addressKey('Hauptstraße 12, 42651 Solingen, Deutschland');
    expect(addressKey('  hauptstraße   12 , 42651 SOLINGEN ')).toBe(key);
    expect(addressKey('Hauptstraße 12, 42651 Solingen')).toBe(key);
    expect(key).toBe('hauptstraße 12, 42651 solingen');
  });

  it('is another key for another number, postal code or city', () => {
    const key = addressKey('Hauptstraße 12, 42651 Solingen');
    expect(addressKey('Hauptstraße 14, 42651 Solingen')).not.toBe(key);
    expect(addressKey('Hauptstraße 12, 42652 Solingen')).not.toBe(key);
    expect(addressKey('Hauptstraße 12, 42651 Wuppertal')).not.toBe(key);
  });

  it('keeps the name in front: it is another cell of the sheet, and the cell is what is cached', () => {
    expect(addressKey('Hotel A, Hauptstraße 12, 42651 Solingen')).not.toBe(addressKey('Hauptstraße 12, 42651 Solingen'));
  });
});

describe('searchPath', () => {
  it('asks for the street with its number, the postal code and the city, and nothing else', () => {
    expect(searchPath(solingen)).toBe('/search?street=12%20Hauptstra%C3%9Fe&postalcode=42651&city=Solingen');
  });

  it('encodes what would otherwise end a value or start another', () => {
    const path = searchPath({ street: 'Rath & Söhne/Weg #1', houseNumber: '5', postcode: '42651', city: 'Solingen' });
    expect(path).not.toMatch(/[ #]/);
    expect(path.split('&')).toHaveLength(3);
    expect(path).toContain('street=5%20Rath%20%26%20S%C3%B6hne%2FWeg%20%231');
  });
});

// Shaped after what Nominatim 4.4.1 answered on 22.10.2026 for jsonv2 with
// addressdetails: place_rank is a number, lat and lon are strings, house_number and
// postcode sit in `address`, and the PHP API sends no addresstype.
function hit(overrides: Record<string, unknown> = {}, address: Record<string, unknown> = {}) {
  return {
    place_id: 1,
    osm_type: 'node',
    osm_id: 4711,
    lat: '51.1722',
    lon: '7.0833',
    category: 'place',
    type: 'house',
    place_rank: 30,
    importance: 0.000001,
    address: { house_number: '12', road: 'Hauptstraße', postcode: '42651', city: 'Solingen', country_code: 'de', ...address },
    ...overrides,
  };
}

const metersNorth = (hitLat: string, meters: number) => String(Number(hitLat) + meters / 111_195);

/** A house-level answer for whatever number the request asked about, so that many different addresses can be placed. */
function hitFor(path: string) {
  const street = new URL(path, 'http://gateway').searchParams.get('street') ?? '';
  return hit({}, { house_number: street.split(' ')[0] });
}

describe('interpretNominatimAnswer', () => {
  it('places an address on the house, for this number, in this postal code', () => {
    expect(interpretNominatimAnswer(200, [hit()], solingen)).toEqual({ kind: 'located', lat: 51.1722, lon: 7.0833, osm: 'node/4711' });
  });

  it('reads numbers sent as numbers as well as strings', () => {
    expect(interpretNominatimAnswer(200, [hit({ lat: 51.1722, lon: 7.0833, place_rank: '30' })], solingen).kind).toBe('located');
  });

  it('compares house numbers without regard to case, spaces and dashes, and by every number a list holds', () => {
    const parsed = (houseNumber: string): ParsedAddress => ({ ...solingen, houseNumber });
    expect(interpretNominatimAnswer(200, [hit({}, { house_number: '127b' })], parsed('127B')).kind).toBe('located');
    expect(interpretNominatimAnswer(200, [hit({}, { house_number: '12 A' })], parsed('12a')).kind).toBe('located');
    expect(interpretNominatimAnswer(200, [hit({}, { house_number: '12–14' })], parsed('12-14')).kind).toBe('located');
    expect(interpretNominatimAnswer(200, [hit({}, { house_number: '10;12;14' })], parsed('12')).kind).toBe('located');
    expect(interpretNominatimAnswer(200, [hit({}, { house_number: '10;14' })], parsed('12'))).toEqual({ kind: 'unlocated', reason: 'too_coarse' });
  });

  it('accepts an answer whatever kind of object carries the address: an entrance, a lift, a building', () => {
    const lift = hit({ category: 'highway', type: 'elevator' });
    expect(interpretNominatimAnswer(200, [lift], solingen).kind).toBe('located');
  });

  it('says not_found for an empty list', () => {
    expect(interpretNominatimAnswer(200, [], solingen)).toEqual({ kind: 'unlocated', reason: 'not_found' });
  });

  it.each([
    ['a street (rank 26)', 26],
    ['a square (rank 25)', 25],
    ['a hamlet (rank 20)', 20],
    ['a postal area (rank 21)', 21],
    ['a city (rank 16)', 16],
  ])('never places an address on %s, even one whose postal code is the one asked for', (_label, rank) => {
    const coarse = hit({ place_rank: rank, category: 'highway', type: 'residential' }, { house_number: undefined });
    expect(interpretNominatimAnswer(200, [coarse], solingen)).toEqual({ kind: 'unlocated', reason: 'too_coarse' });
  });

  it('does not place a street whose answer also carries the number: the rank decides, not the field', () => {
    expect(interpretNominatimAnswer(200, [hit({ place_rank: HOUSE_RANK - 1 })], solingen)).toEqual({ kind: 'unlocated', reason: 'too_coarse' });
  });

  it('says too_coarse when the geocoder found the street and another house', () => {
    const otherHouse = hit({}, { house_number: '14' });
    const street = hit({ place_rank: 26 }, { house_number: undefined });
    expect(interpretNominatimAnswer(200, [street, otherHouse], solingen)).toEqual({ kind: 'unlocated', reason: 'too_coarse' });
  });

  it('says postcode_mismatch for a house with this number in another postal code', () => {
    expect(interpretNominatimAnswer(200, [hit({}, { postcode: '42699' })], solingen)).toEqual({ kind: 'unlocated', reason: 'postcode_mismatch' });
  });

  it('places a house that does not say which postal code it is in: the search was restricted to it', () => {
    expect(interpretNominatimAnswer(200, [hit({}, { postcode: undefined })], solingen).kind).toBe('located');
  });

  it('is one place when the answers are one building apart, and takes the first', () => {
    const entrance = hit({ osm_id: 2 }, {});
    const lat = metersNorth('51.1722', 24);
    const found = interpretNominatimAnswer(200, [hit(), { ...entrance, lat }], solingen);
    expect(found).toEqual({ kind: 'located', lat: 51.1722, lon: 7.0833, osm: 'node/4711' });
  });

  it(`is ambiguous when house-level answers are more than ${SAME_PLACE_METERS} m apart: the same number in two places`, () => {
    const farther = hit({ osm_id: 2, lat: metersNorth('51.1722', 300) });
    expect(interpretNominatimAnswer(200, [hit(), farther], solingen)).toEqual({ kind: 'unlocated', reason: 'ambiguous' });
  });

  it('ignores a far answer that is not a house for this number: only the candidates are compared', () => {
    const farStreet = hit({ place_rank: 26, lat: metersNorth('51.1722', 539) }, { house_number: undefined });
    expect(interpretNominatimAnswer(200, [hit(), farStreet], solingen).kind).toBe('located');
  });

  it('has no osm reference when the answer names none', () => {
    const anonymous = hit({ osm_type: undefined, osm_id: undefined });
    expect(interpretNominatimAnswer(200, [anonymous], solingen)).toMatchObject({ kind: 'located', osm: null });
  });
});

describe('interpretNominatimAnswer: when the geocoder does not answer', () => {
  it.each([
    [429, 'rate_limited'],
    [502, 'unreachable'],
    [504, 'timeout'],
    [400, 'rejected'],
    [404, 'rejected'],
    [405, 'rejected'],
    [500, 'service_error'],
    [503, 'service_error'],
    [302, 'bad_answer'],
    [204, 'bad_answer'],
  ])('reads HTTP %i as %s, whatever the body says', (status, reason) => {
    expect(interpretNominatimAnswer(status, [hit()], solingen)).toEqual({ kind: 'unlocated', reason });
  });

  it.each([
    ['a body that is not a list', { results: [] }],
    ['text', 'OK'],
    ['nothing', undefined],
    ['null', null],
  ])('reads %s on a 200 as bad_answer', (_label, body) => {
    expect(interpretNominatimAnswer(200, body, solingen)).toEqual({ kind: 'unlocated', reason: 'bad_answer' });
  });

  it.each([
    ['no latitude', { lat: undefined }],
    ['a latitude that is not a number', { lat: 'north' }],
    ['no place_rank', { place_rank: undefined }],
    ['a place_rank that is not a number', { place_rank: 'house' }],
    ['a point outside Germany', { lat: '48.8566', lon: '2.3522' }],
    ['a point at the pole', { lat: '90', lon: '0' }],
  ])('reads a list with %s as bad_answer and never half-uses it', (_label, overrides) => {
    expect(interpretNominatimAnswer(200, [hit(), hit(overrides)], solingen)).toEqual({ kind: 'unlocated', reason: 'bad_answer' });
  });

  it('reads an entry that is not an object as bad_answer', () => {
    expect(interpretNominatimAnswer(200, [hit(), 'x'], solingen)).toEqual({ kind: 'unlocated', reason: 'bad_answer' });
  });
});

describe('readServiceStatus', () => {
  const ok = { status: 0, message: 'OK', data_updated: '2026-08-21T17:21:05+00:00', software_version: '4.4.1-0' };

  it('reads an answering service and its data stamp', () => {
    expect(readServiceStatus(200, ok)).toEqual({ up: true, dataUpdated: '2026-08-21T17:21:05+00:00' });
  });

  it('is up without a stamp when it does not give one', () => {
    expect(readServiceStatus(200, { status: 0, message: 'OK' })).toEqual({ up: true, dataUpdated: null });
  });

  it('is down for a service that answers with an error status or a body that is not OK', () => {
    expect(readServiceStatus(200, { status: 700, message: 'Database connection failed' })).toEqual({ up: false, reason: 'service_error' });
    expect(readServiceStatus(200, 'OK')).toEqual({ up: false, reason: 'service_error' });
    expect(readServiceStatus(502, ok)).toEqual({ up: false, reason: 'unreachable' });
    expect(readServiceStatus(504, ok)).toEqual({ up: false, reason: 'timeout' });
    expect(readServiceStatus(429, ok)).toEqual({ up: false, reason: 'rate_limited' });
  });
});

describe('geocoderVersionLabel', () => {
  it('names the data by its day', () => {
    expect(geocoderVersionLabel('2026-08-21T17:21:05+00:00')).toBe('nominatim@2026-08-21');
  });

  it('is plain nominatim when the service does not say', () => {
    expect(geocoderVersionLabel(null)).toBe('nominatim');
    expect(geocoderVersionLabel(undefined)).toBe('nominatim');
    expect(geocoderVersionLabel('yesterday')).toBe('nominatim');
  });
});

describe('the vocabulary', () => {
  it('has no reason twice, and every refusal has a status', () => {
    expect(new Set(UNLOCATED_REASONS).size).toBe(UNLOCATED_REASONS.length);
    for (const reason of GEOCODE_REFUSAL_REASONS) expect(geocodeRefusalStatus(reason)).toBeGreaterThanOrEqual(400);
  });

  it('counts as infrastructure exactly the reasons that say the geocoder could not answer', () => {
    expect([...INFRASTRUCTURE_REASONS].sort()).toEqual(['bad_answer', 'rate_limited', 'rejected', 'service_error', 'timeout', 'unreachable']);
    for (const reason of ['unparseable', 'no_house_number', 'not_found', 'too_coarse', 'postcode_mismatch', 'ambiguous'] as const) {
      expect(INFRASTRUCTURE_REASONS.has(reason)).toBe(false);
    }
  });

  it('names the gateway by the name and port the compose service has', () => {
    expect(GEOCODER_ORIGIN).toBe('http://geocoder-gateway:8080');
  });

  it('measures a metre as a metre', () => {
    expect(distanceMeters({ lat: 51, lon: 7 }, { lat: 51, lon: 7 })).toBe(0);
    expect(distanceMeters({ lat: 51, lon: 7 }, { lat: 52, lon: 7 })).toBeCloseTo(111_195, -2);
    expect(distanceMeters({ lat: 51, lon: 7 }, { lat: 51, lon: 8 })).toBeCloseTo(69_980, -3);
  });

  it('normalizes house numbers the way both sides compare them', () => {
    expect(normalizeHouseNumber(' 12 A ')).toBe('12a');
    expect(normalizeHouseNumber('12–14')).toBe('12-14');
  });
});

// -- geocodeAddresses ---------------------------------------------------------

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type FetchFn = typeof fetch;
const stub = (impl: (url: string, init?: RequestInit) => Promise<Response> | Response): FetchFn =>
  (async (input: RequestInfo | URL, init?: RequestInit) => impl(String(input), init)) as FetchFn;

const STATUS_OK = { status: 0, message: 'OK', data_updated: '2026-08-21T17:21:05+00:00', software_version: '4.4.1-0' };

const options = (fetchFn: FetchFn, over: Record<string, unknown> = {}) => ({
  fetchFn,
  baseUrl: GEOCODER_ORIGIN,
  timeoutMs: 200,
  concurrency: 2,
  deadlineMs: 10_000,
  now: () => 0,
  maxConsecutiveFailures: 3,
  ...over,
});

const query = (id: string, text = 'Hauptstraße 12, 42651 Solingen, Deutschland') => ({ id, text });

/** A gateway that answers /status itself and hands every /search to `search`, counting what it saw. */
function gateway(search: (path: string, nth: number) => Response | Promise<Response>, status: () => Response = () => json(200, STATUS_OK)) {
  const paths: string[] = [];
  let inFlight = 0;
  let mostInFlight = 0;
  const fetchFn = stub(async (url) => {
    const path = url.slice(GEOCODER_ORIGIN.length);
    paths.push(path);
    if (path.startsWith('/status')) return status();
    inFlight += 1;
    mostInFlight = Math.max(mostInFlight, inFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, 2));
      return await search(path, paths.filter((p) => p.startsWith('/search')).length);
    } finally {
      inFlight -= 1;
    }
  });
  return { fetchFn, paths, searches: () => paths.filter((p) => p.startsWith('/search')), mostInFlight: () => mostInFlight };
}

describe('geocodeAddresses', () => {
  it('places every address that has a house, answers in request order, and carries the data stamp', async () => {
    const gw = gateway(() => json(200, [hit()]));
    const out = await geocodeAddresses([query('a'), query('b'), query('c')], options(gw.fetchFn));
    expect(out.results.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(out.results.every((r) => r.kind === 'located')).toBe(true);
    expect(out.results[0]).toEqual({ id: 'a', kind: 'located', lat: 51.1722, lon: 7.0833, precision: 'exact', osm: 'node/4711' });
    expect(out.dataUpdated).toBe('2026-08-21T17:21:05+00:00');
  });

  it('asks the gateway for the three facts of the address and for nothing else', async () => {
    const gw = gateway(() => json(200, [hit()]));
    await geocodeAddresses([query('a')], options(gw.fetchFn));
    expect(gw.searches()).toEqual(['/search?street=12%20Hauptstra%C3%9Fe&postalcode=42651&city=Solingen']);
    expect(gw.paths[0]).toBe('/status');
  });

  it('never asks for an address that has no house number or cannot be read: it answers the reason itself', async () => {
    const gw = gateway(() => json(200, [hit()]));
    const out = await geocodeAddresses([
      query('street', 'Königstraße, 42651 Solingen, Deutschland'),
      query('good'),
      query('name', 'Hauptbahnhof Wuppertal, 42103 Wuppertal, Deutschland'),
      query('junk', 'irgendwo'),
    ], options(gw.fetchFn));
    expect(out.results).toEqual([
      { id: 'street', kind: 'unlocated', reason: 'no_house_number' },
      expect.objectContaining({ id: 'good', kind: 'located' }),
      { id: 'name', kind: 'unlocated', reason: 'no_house_number' },
      { id: 'junk', kind: 'unlocated', reason: 'unparseable' },
    ]);
    expect(gw.searches()).toHaveLength(1);
    expect(gw.paths.join('')).not.toMatch(/K%C3%B6nigstra|Hauptbahnhof|irgendwo/);
  });

  it('does not even ask whether the service is up when there is nothing to ask it', async () => {
    const gw = gateway(() => json(200, [hit()]));
    const out = await geocodeAddresses([query('street', 'Königstraße, 42651 Solingen')], options(gw.fetchFn));
    expect(gw.paths).toEqual([]);
    expect(out.results).toEqual([{ id: 'street', kind: 'unlocated', reason: 'no_house_number' }]);
    expect(out.dataUpdated).toBeNull();
  });

  it('answers each address on its own: a street, a missing number and a far twin do not spoil the others', async () => {
    const gw = gateway((path) => {
      if (path.includes('street=1%20')) return json(200, [hit({ place_rank: 26 }, { house_number: undefined })]);
      if (path.includes('street=2%20')) return json(200, []);
      return json(200, [hitFor(path)]);
    });
    const out = await geocodeAddresses([
      query('coarse', 'Aweg 1, 42651 Solingen'),
      query('none', 'Bweg 2, 42651 Solingen'),
      query('ok', 'Cweg 3, 42651 Solingen'),
    ], options(gw.fetchFn));
    expect(out.results.map((r) => (r.kind === 'located' ? 'located' : r.reason))).toEqual(['too_coarse', 'not_found', 'located']);
  });
});

describe('geocodeAddresses: when the service does not answer', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => query(`q${i}`, `Aweg ${i + 1}, 42651 Solingen`));

  it('answers unreachable for every address, and asks nothing else, when the status request fails', async () => {
    const gw = gateway(() => json(200, [hit()]), () => json(502, 'Bad Gateway'));
    const out = await geocodeAddresses(many(5), options(gw.fetchFn));
    expect(out.results.every((r) => r.kind === 'unlocated' && r.reason === 'unreachable')).toBe(true);
    expect(gw.searches()).toHaveLength(0);
    expect(gw.paths).toEqual(['/status']);
    expect(out.dataUpdated).toBeNull();
  });

  it('answers rate_limited and timeout from the status request the same way', async () => {
    for (const [status, reason] of [[429, 'rate_limited'], [504, 'timeout']] as const) {
      const gw = gateway(() => json(200, [hit()]), () => json(status, ''));
      const out = await geocodeAddresses(many(2), options(gw.fetchFn));
      expect(out.results.map((r) => r.kind === 'unlocated' && r.reason)).toEqual([reason, reason]);
      expect(gw.searches()).toHaveLength(0);
    }
  });

  it('stops asking after three failures of the service in a row and answers the rest with the last reason', async () => {
    const gw = gateway(() => json(502, ''));
    const out = await geocodeAddresses(many(10), options(gw.fetchFn, { concurrency: 1 }));
    expect(gw.searches()).toHaveLength(3);
    expect(out.results.every((r) => r.kind === 'unlocated' && r.reason === 'unreachable')).toBe(true);
  });

  it('does not stop for an answer of no, only for failures of the service', async () => {
    const gw = gateway(() => json(200, []));
    const out = await geocodeAddresses(many(8), options(gw.fetchFn, { concurrency: 1 }));
    expect(gw.searches()).toHaveLength(8);
    expect(out.results.every((r) => r.kind === 'unlocated' && r.reason === 'not_found')).toBe(true);
  });

  it('counts failures in a row: an answer between two failures starts the count again', async () => {
    const pattern = [502, 502, 200, 502, 502, 200, 502, 502, 200];
    const gw = gateway((path, nth) => (pattern[nth - 1] === 502 ? json(502, '') : json(200, [hitFor(path)])));
    const out = await geocodeAddresses(many(9), options(gw.fetchFn, { concurrency: 1 }));
    expect(gw.searches()).toHaveLength(9);
    expect(out.results.filter((r) => r.kind === 'located')).toHaveLength(3);
  });

  it('answers timeout when the service does not answer in time, and stops waiting for it', async () => {
    let aborted = 0;
    const fetchFn = stub((url, init) => {
      if (url.endsWith('/status')) return json(200, STATUS_OK);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted += 1;
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    });
    const started = Date.now();
    const out = await geocodeAddresses([query('slow')], options(fetchFn, { timeoutMs: 25 }));
    expect(out.results).toEqual([{ id: 'slow', kind: 'unlocated', reason: 'timeout' }]);
    expect(aborted).toBe(1);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('answers unreachable when the connection fails, and never throws', async () => {
    const fetchFn = stub(() => {
      throw new TypeError('fetch failed');
    });
    const out = await geocodeAddresses([query('a'), query('b')], options(fetchFn));
    expect(out.results).toEqual([
      { id: 'a', kind: 'unlocated', reason: 'unreachable' },
      { id: 'b', kind: 'unlocated', reason: 'unreachable' },
    ]);
  });

  it('answers bad_answer for a 200 that is not JSON, and service_error for an error page', async () => {
    const pages = [new Response('<html>hello</html>', { status: 200 }), new Response('<html>oops</html>', { status: 500 })];
    const gw = gateway((_path, nth) => pages[nth - 1]);
    const out = await geocodeAddresses([query('a'), query('b')], options(gw.fetchFn, { concurrency: 1 }));
    expect(out.results.map((r) => r.kind === 'unlocated' && r.reason)).toEqual(['bad_answer', 'service_error']);
  });

  it('asks no more once the deadline has passed and answers the rest timeout', async () => {
    let clock = 0;
    const gw = gateway((path) => {
      clock += 40_000;
      return json(200, [hitFor(path)]);
    });
    const out = await geocodeAddresses(many(4), options(gw.fetchFn, { concurrency: 1, now: () => clock, deadlineMs: 25_000 }));
    expect(gw.searches()).toHaveLength(1);
    expect(out.results.map((r) => (r.kind === 'located' ? 'located' : r.reason))).toEqual(['located', 'timeout', 'timeout', 'timeout']);
  });

  it('has at most the configured number of requests in flight', async () => {
    const gw = gateway(() => json(200, [hit()]));
    await geocodeAddresses(many(12), options(gw.fetchFn, { concurrency: 2 }));
    expect(gw.mostInFlight()).toBe(2);
  });
});

describe('parseGeocodeRequest', () => {
  it('accepts well-formed addresses and returns exactly the fields it reads', () => {
    const parsed = parseGeocodeRequest({ addresses: [{ id: 'a', text: 'Hauptstraße 12, 42651 Solingen', extra: 'ignored' }], unknown: 1 });
    expect(parsed).toEqual({ ok: true, queries: [{ id: 'a', text: 'Hauptstraße 12, 42651 Solingen' }] });
  });

  it.each([
    ['null', null],
    ['a list', []],
    ['no addresses', {}],
    ['an empty list', { addresses: [] }],
    ['addresses that are not a list', { addresses: 'x' }],
    ['an entry that is not an object', { addresses: ['Hauptstraße 12'] }],
    ['an id that is not a string', { addresses: [{ id: 1, text: 'x' }] }],
    ['an empty id', { addresses: [{ id: '', text: 'x' }] }],
    ['an id that is too long', { addresses: [{ id: 'x'.repeat(81), text: 'x' }] }],
    ['a text that is not a string', { addresses: [{ id: 'a', text: 12 }] }],
    ['a blank text', { addresses: [{ id: 'a', text: '   ' }] }],
    ['a text that is too long', { addresses: [{ id: 'a', text: 'x'.repeat(MAX_ADDRESS_CHARS + 1) }] }],
  ])('refuses %s as invalid_request', (_label, body) => {
    expect(parseGeocodeRequest(body)).toEqual({ ok: false, problem: 'invalid_request' });
  });

  it('refuses a repeated id, since an answer belongs to its request by id only', () => {
    const entries = [{ id: 'a', text: 'x' }, { id: 'a', text: 'y' }];
    expect(parseGeocodeRequest({ addresses: entries })).toEqual({ ok: false, problem: 'duplicate_id' });
  });

  it(`takes ${MAX_ADDRESSES_PER_CALL} addresses and refuses one more`, () => {
    const entries = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `a${i}`, text: 'x' }));
    expect(parseGeocodeRequest({ addresses: entries(MAX_ADDRESSES_PER_CALL) }).ok).toBe(true);
    expect(parseGeocodeRequest({ addresses: entries(MAX_ADDRESSES_PER_CALL + 1) })).toEqual({ ok: false, problem: 'too_many_addresses' });
  });
});

describe('parseGeocodeBody', () => {
  it('reads JSON text and refuses text that is not JSON', () => {
    expect(parseGeocodeBody('{"addresses":[{"id":"a","text":"x"}]}').ok).toBe(true);
    expect(parseGeocodeBody('not json')).toEqual({ ok: false, problem: 'invalid_request' });
    expect(parseGeocodeBody('')).toEqual({ ok: false, problem: 'invalid_request' });
  });

  it('judges the size before it parses anything', () => {
    expect(parseGeocodeBody(' '.repeat(MAX_GEOCODE_BODY_CHARS + 1))).toEqual({ ok: false, problem: 'too_large' });
  });
});

describe('parseGeocodeResponse', () => {
  const located = { id: 'a', kind: 'located', lat: 51.17, lon: 7.08, precision: 'exact', osm: 'node/4711' };
  const unlocatedResult = { id: 'b', kind: 'unlocated', reason: 'too_coarse' };

  it('reads the function\'s success answer', () => {
    const answer = parseGeocodeResponse(200, { ok: true, data_updated: '2026-08-21T17:21:05+00:00', results: [located, unlocatedResult] });
    expect(answer).toEqual({ ok: true, dataUpdated: '2026-08-21T17:21:05+00:00', results: [located, unlocatedResult] });
  });

  it('reads a located result without an OSM reference when the function sent null', () => {
    const answer = parseGeocodeResponse(200, { ok: true, data_updated: null, results: [{ ...located, osm: null }] });
    expect(answer).toMatchObject({ ok: true, dataUpdated: null });
  });

  it.each([
    ['no results', { ok: true }],
    ['results that are not a list', { ok: true, results: 'x' }],
    ['a data stamp that is not text', { ok: true, data_updated: 5, results: [] }],
    ['a located result with a point outside Germany', { ok: true, results: [{ ...located, lat: 0, lon: 0 }] }],
    ['a located result with a coarser precision than exact', { ok: true, results: [{ ...located, precision: 'street' }] }],
    ['a located result without osm', { ok: true, results: [{ id: 'a', kind: 'located', lat: 51.17, lon: 7.08, precision: 'exact' }] }],
    ['a reason it does not know', { ok: true, results: [{ id: 'b', kind: 'unlocated', reason: 'maybe' }] }],
    ['a kind it does not know', { ok: true, results: [{ id: 'b', kind: 'guessed', lat: 51.17, lon: 7.08 }] }],
    ['a result without an id', { ok: true, results: [{ kind: 'unlocated', reason: 'too_coarse' }] }],
  ])('reads %s as bad_answer and never half-uses it', (_label, body) => {
    expect(parseGeocodeResponse(200, body)).toEqual({ ok: false, reason: 'bad_answer' });
  });

  it('reads the function\'s refusals by their reason, and by the status when the body says nothing', () => {
    expect(parseGeocodeResponse(403, { ok: false, reason: 'no_company' })).toEqual({ ok: false, reason: 'no_company' });
    expect(parseGeocodeResponse(401, 'Unauthorized')).toEqual({ ok: false, reason: 'not_authenticated' });
    expect(parseGeocodeResponse(413, null)).toEqual({ ok: false, reason: 'too_large' });
    expect(parseGeocodeResponse(500, undefined)).toEqual({ ok: false, reason: 'server_error' });
    expect(parseGeocodeResponse(200, { ok: false, reason: 'surprise' })).toEqual({ ok: false, reason: 'bad_answer' });
  });
});
