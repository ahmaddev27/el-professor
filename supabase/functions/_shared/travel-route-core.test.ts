import { describe, expect, it } from 'vitest';
import {
  MAX_PAIRS_PER_CALL,
  MAX_BODY_CHARS,
  OSRM_ORIGIN,
  ROUTE_FAILURE_REASONS,
  ROUTE_REFUSAL_REASONS,
  interpretOsrmAnswer,
  mapWithConcurrency,
  parseRouteBody,
  parseRouteRequest,
  parseRouteResponse,
  refusalStatus,
  routePairs,
  routeUrl,
  type RoutePair,
} from './travel-route-core';

const FROM = { lat: 51.171290, lon: 7.083210 };
const TO = { lat: 51.2277, lon: 6.7735 };
const pair = (id: string, over: Partial<RoutePair> = {}): RoutePair => ({ id, from: FROM, to: TO, ...over });

/** What osrm-routed answers for a route it found (overview=false). */
function okBody(over: Record<string, unknown> = {}) {
  return {
    code: 'Ok',
    routes: [{ duration: 612.4, distance: 4210.7, weight: 612.4, weight_name: 'routability', legs: [] }],
    waypoints: [
      { distance: 8.2, name: 'Weyerstrasse', location: [7.0832, 51.1713] },
      { distance: 31.9, name: 'Koenigsallee', location: [6.7735, 51.2277] },
    ],
    ...over,
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type FetchFn = typeof fetch;
const stub = (impl: (url: string, init?: RequestInit) => Promise<Response> | Response): FetchFn =>
  (async (input: RequestInfo | URL, init?: RequestInit) => impl(String(input), init)) as FetchFn;

const options = (fetchFn: FetchFn, over: Record<string, unknown> = {}) => ({
  fetchFn,
  baseUrl: 'http://osrm:5000',
  timeoutMs: 200,
  concurrency: 4,
  deadlineMs: 10_000,
  now: () => 0,
  ...over,
});

describe('parseRouteRequest', () => {
  it('accepts well-formed pairs and returns exactly the fields it reads', () => {
    const parsed = parseRouteRequest({ pairs: [{ id: 'a>b', from: FROM, to: TO, extra: 'ignored' }], unknown: 1 });
    expect(parsed).toEqual({ ok: true, pairs: [{ id: 'a>b', from: FROM, to: TO }] });
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'pairs'],
    ['no pairs key', {}],
    ['pairs that are not a list', { pairs: 'x' }],
    ['an empty list', { pairs: [] }],
    ['an entry that is not an object', { pairs: [1] }],
    ['an entry with no id', { pairs: [{ from: FROM, to: TO }] }],
    ['an id that is not a string', { pairs: [{ id: 7, from: FROM, to: TO }] }],
    ['an empty id', { pairs: [{ id: '', from: FROM, to: TO }] }],
    ['an id over 80 characters', { pairs: [{ id: 'x'.repeat(81), from: FROM, to: TO }] }],
    ['a point that is a string', { pairs: [{ id: 'a', from: '51,7', to: TO }] }],
    ['a point missing its longitude', { pairs: [{ id: 'a', from: { lat: 51 }, to: TO }] }],
  ])('refuses %s as invalid_request', (_label, body) => {
    expect(parseRouteRequest(body)).toEqual({ ok: false, problem: 'invalid_request' });
  });

  it('refuses more pairs than one call may carry, before reading any of them', () => {
    const pairs = Array.from({ length: MAX_PAIRS_PER_CALL + 1 }, (_, i) => ({ id: `p${i}`, from: FROM, to: TO }));
    expect(parseRouteRequest({ pairs })).toEqual({ ok: false, problem: 'too_many_pairs' });
    expect(parseRouteRequest({ pairs: pairs.slice(0, MAX_PAIRS_PER_CALL) }).ok).toBe(true);
  });

  it.each([
    ['a numeric string', { lat: '51.1', lon: 7.1 }],
    ['NaN', { lat: Number.NaN, lon: 7.1 }],
    ['Infinity', { lat: 51.1, lon: Number.POSITIVE_INFINITY }],
    ['a latitude above 90', { lat: 90.0001, lon: 7.1 }],
    ['a latitude below -90', { lat: -91, lon: 7.1 }],
    ['a longitude above 180', { lat: 51.1, lon: 180.5 }],
    ['a longitude below -180', { lat: 51.1, lon: -181 }],
    ['null', { lat: null, lon: 7.1 }],
  ])('refuses %s as a bad_coordinate', (_label, point) => {
    expect(parseRouteRequest({ pairs: [{ id: 'a', from: point, to: TO }] })).toEqual({ ok: false, problem: 'bad_coordinate' });
    expect(parseRouteRequest({ pairs: [{ id: 'a', from: FROM, to: point }] })).toEqual({ ok: false, problem: 'bad_coordinate' });
  });

  it('refuses a repeated id: an answer is matched to its request by id and only by id', () => {
    const body = { pairs: [{ id: 'same', from: FROM, to: TO }, { id: 'same', from: TO, to: FROM }] };
    expect(parseRouteRequest(body)).toEqual({ ok: false, problem: 'duplicate_id' });
  });

  it('keeps a point on the equator and the meridian: zero is a coordinate, not a missing one', () => {
    const zero = { lat: 0, lon: 0 };
    expect(parseRouteRequest({ pairs: [{ id: 'z', from: zero, to: zero }] }).ok).toBe(true);
  });
});

describe('parseRouteBody', () => {
  it('reads the text of a request the way parseRouteRequest reads its object', () => {
    const text = JSON.stringify({ pairs: [{ id: 'a', from: FROM, to: TO }] });
    expect(parseRouteBody(text)).toEqual({ ok: true, pairs: [{ id: 'a', from: FROM, to: TO }] });
  });

  it('refuses text that is not JSON, and a body too long to be read at all, without parsing it', () => {
    expect(parseRouteBody('{"pairs":')).toEqual({ ok: false, problem: 'invalid_request' });
    expect(parseRouteBody('')).toEqual({ ok: false, problem: 'invalid_request' });
    expect(parseRouteBody(' '.repeat(MAX_BODY_CHARS + 1))).toEqual({ ok: false, problem: 'too_large' });
  });
});

describe('refusalStatus', () => {
  it('gives every refusal an HTTP status the browser reads back as the same reason', () => {
    for (const reason of ROUTE_REFUSAL_REASONS) {
      const status = refusalStatus(reason);
      expect(status).toBeGreaterThanOrEqual(400);
      const answered = parseRouteResponse(status, undefined);
      expect(answered.ok).toBe(false);
    }
    expect(refusalStatus('not_authenticated')).toBe(401);
    expect(refusalStatus('no_company')).toBe(403);
    expect(refusalStatus('too_many_pairs')).toBe(413);
  });
});

describe('routeUrl', () => {
  it('writes longitude first, then latitude, as OSRM reads them', () => {
    const url = routeUrl('http://osrm:5000', pair('a'));
    expect(url).toContain('/route/v1/driving/7.083210,51.171290;6.773500,51.227700?');
  });

  it('asks for the duration and the distance and nothing that costs the server more', () => {
    const url = new URL(routeUrl('http://osrm:5000', pair('a')));
    expect(url.pathname.startsWith('/route/v1/driving/')).toBe(true);
    expect(Object.fromEntries(url.searchParams)).toEqual({ overview: 'false', alternatives: 'false', steps: 'false' });
  });

  it('never lets a coordinate break out of the path', () => {
    const url = routeUrl('http://osrm:5000', pair('a', { from: { lat: 1e-7, lon: -0.0000004 } }));
    expect(url).toMatch(/^http:\/\/osrm:5000\/route\/v1\/driving\/-?0\.000000,0\.000000;[\d.,]+\?/);
    expect(url).not.toMatch(/e[+-]?\d/);
  });
});

describe('interpretOsrmAnswer', () => {
  it('reads the route a good answer carries, in seconds and metres, with the snap distance of both points', () => {
    expect(interpretOsrmAnswer(200, okBody({ data_version: '2026-10-20T23:29:32Z' }))).toEqual({
      kind: 'route',
      durationSeconds: 612.4,
      distanceMeters: 4210.7,
      snapMeters: [8.2, 31.9],
      dataVersion: '2026-10-20T23:29:32Z',
    });
  });

  it('has no data version when the answer names none', () => {
    const answer = interpretOsrmAnswer(200, okBody());
    expect(answer.kind === 'route' && answer.dataVersion).toBeNull();
  });

  it('accepts a route of no length: two addresses on the same spot', () => {
    const body = okBody({ routes: [{ duration: 0, distance: 0 }] });
    expect(interpretOsrmAnswer(200, body)).toMatchObject({ kind: 'route', durationSeconds: 0, distanceMeters: 0 });
  });

  it.each([
    ['NoRoute', 400, 'no_route'],
    ['NoSegment', 400, 'not_on_road'],
    ['InvalidQuery', 400, 'request_rejected'],
    ['InvalidValue', 400, 'request_rejected'],
    ['InvalidOptions', 400, 'request_rejected'],
    ['InvalidUrl', 400, 'request_rejected'],
    ['TooBig', 400, 'request_rejected'],
    ['SomethingNew', 400, 'service_error'],
  ])('reads the OSRM code %s (sent with HTTP %i) as %s, and reads it the same at HTTP 200', (code, status, reason) => {
    expect(interpretOsrmAnswer(status, { code, message: 'text that is never passed on' })).toEqual({ kind: 'unavailable', reason });
    expect(interpretOsrmAnswer(200, { code })).toEqual({ kind: 'unavailable', reason });
  });

  it.each([
    ['no routes', okBody({ routes: [] })],
    ['routes that are not a list', okBody({ routes: 'x' })],
    ['no duration', okBody({ routes: [{ distance: 10 }] })],
    ['no distance', okBody({ routes: [{ duration: 10 }] })],
    ['a negative duration', okBody({ routes: [{ duration: -1, distance: 10 }] })],
    ['a negative distance', okBody({ routes: [{ duration: 1, distance: -10 }] })],
    ['a duration that is a string', okBody({ routes: [{ duration: '612', distance: 10 }] })],
    ['a duration that is NaN', okBody({ routes: [{ duration: Number.NaN, distance: 10 }] })],
    ['an infinite distance', okBody({ routes: [{ duration: 1, distance: Number.POSITIVE_INFINITY }] })],
    ['one waypoint', okBody({ waypoints: [{ distance: 1 }] })],
    ['three waypoints', okBody({ waypoints: [{ distance: 1 }, { distance: 1 }, { distance: 1 }] })],
    ['no waypoints', okBody({ waypoints: undefined })],
    ['a waypoint without a snap distance', okBody({ waypoints: [{ distance: 1 }, {}] })],
    ['a negative snap distance', okBody({ waypoints: [{ distance: -1 }, { distance: 1 }] })],
  ])('refuses an Ok answer with %s as bad_answer, never a made-up minute count', (_label, body) => {
    expect(interpretOsrmAnswer(200, body)).toEqual({ kind: 'unavailable', reason: 'bad_answer' });
  });

  it('does not believe an Ok body that arrived with an error status', () => {
    expect(interpretOsrmAnswer(500, okBody())).toEqual({ kind: 'unavailable', reason: 'bad_answer' });
  });

  it.each([
    ['not JSON at all', 200, 'bad_answer', undefined],
    ['null', 200, 'bad_answer', null],
    ['a list', 200, 'bad_answer', []],
    ['a body with no code', 200, 'bad_answer', { routes: [] }],
    ['a gateway error page', 502, 'service_error', undefined],
    ['a server error with no body', 500, 'service_error', undefined],
    ['a service unavailable', 503, 'service_error', null],
  ])('reads %s (HTTP %i) as %s', (_label, status, reason, body) => {
    expect(interpretOsrmAnswer(status, body)).toEqual({ kind: 'unavailable', reason });
  });
});

describe('mapWithConcurrency', () => {
  it('keeps the order of its input and never runs more than the limit at once', async () => {
    let running = 0;
    let peak = 0;
    const out = await mapWithConcurrency([5, 1, 4, 2, 3, 9, 7], 3, async (n) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, n));
      running -= 1;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30, 90, 70]);
    expect(peak).toBe(3);
  });

  it('copes with fewer items than workers and with none', async () => {
    expect(await mapWithConcurrency([1], 8, async (n) => n)).toEqual([1]);
    expect(await mapWithConcurrency([], 8, async (n: number) => n)).toEqual([]);
  });
});

describe('routePairs', () => {
  it('routes every pair, answers in request order and carries the data version of the first answer that has one', async () => {
    const fetchFn = stub((url) => {
      const tag = url.includes('7.083210') ? 1 : 2;
      return json(200, okBody({ routes: [{ duration: 60 * tag, distance: 1000 * tag }], data_version: tag === 2 ? '2026-10-20T23:29:32Z' : undefined }));
    });
    const pairs = [pair('p1'), pair('p2', { from: { lat: 51.3, lon: 7.2 } }), pair('p3')];
    const out = await routePairs(pairs, options(fetchFn));
    expect(out.results.map((r) => r.id)).toEqual(['p1', 'p2', 'p3']);
    expect(out.results.map((r) => r.kind === 'route' && r.durationSeconds)).toEqual([60, 120, 60]);
    expect(out.dataVersion).toBe('2026-10-20T23:29:32Z');
  });

  it('asks the configured origin, one request per pair, longitude first', async () => {
    const seen: string[] = [];
    const fetchFn = stub((url) => {
      seen.push(url);
      return json(200, okBody());
    });
    await routePairs([pair('a')], options(fetchFn, { baseUrl: OSRM_ORIGIN }));
    expect(seen).toHaveLength(1);
    expect(seen[0].startsWith(`${OSRM_ORIGIN}/route/v1/driving/7.083210,51.171290;`)).toBe(true);
  });

  it('answers a failed pair as unavailable and leaves its neighbours alone', async () => {
    const fetchFn = stub((url) => (url.includes('9.000000')
      ? json(400, { code: 'NoRoute', message: 'x' })
      : json(200, okBody())));
    const out = await routePairs(
      [pair('good1'), pair('bad', { to: { lat: 48, lon: 9 } }), pair('good2')],
      options(fetchFn),
    );
    expect(out.results.map((r) => r.kind)).toEqual(['route', 'unavailable', 'route']);
    expect(out.results[1]).toEqual({ id: 'bad', kind: 'unavailable', reason: 'no_route' });
  });

  it('answers unreachable when the connection fails, and never throws', async () => {
    const fetchFn = stub(() => {
      throw new TypeError('fetch failed');
    });
    const out = await routePairs([pair('a'), pair('b')], options(fetchFn));
    expect(out.results).toEqual([
      { id: 'a', kind: 'unavailable', reason: 'unreachable' },
      { id: 'b', kind: 'unavailable', reason: 'unreachable' },
    ]);
    expect(out.dataVersion).toBeNull();
  });

  it('answers timeout when the service does not answer in time, and stops waiting for it', async () => {
    let aborted = 0;
    const fetchFn = stub((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        aborted += 1;
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    }));
    const started = Date.now();
    const out = await routePairs([pair('slow')], options(fetchFn, { timeoutMs: 25 }));
    expect(out.results).toEqual([{ id: 'slow', kind: 'unavailable', reason: 'timeout' }]);
    expect(aborted).toBe(1);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('answers bad_answer for a 200 that is not JSON, and service_error for a gateway page', async () => {
    const fetchFn = stub((url) => (url.includes('9.000000')
      ? new Response('<html>Bad gateway</html>', { status: 502 })
      : new Response('<html>hello</html>', { status: 200 })));
    const out = await routePairs([pair('a'), pair('b', { to: { lat: 48, lon: 9 } })], options(fetchFn));
    expect(out.results.map((r) => r.kind === 'unavailable' && r.reason)).toEqual(['bad_answer', 'service_error']);
  });

  it('never routes more pairs at once than the concurrency limit', async () => {
    let running = 0;
    let peak = 0;
    const fetchFn = stub(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return json(200, okBody());
    });
    const pairs = Array.from({ length: 12 }, (_, i) => pair(`p${i}`));
    const out = await routePairs(pairs, options(fetchFn, { concurrency: 3 }));
    expect(out.results.every((r) => r.kind === 'route')).toBe(true);
    expect(peak).toBe(3);
  });

  it('stops asking once its deadline has passed and says timeout for the rest, without calling the service for them', async () => {
    let clock = 0;
    let calls = 0;
    const fetchFn = stub(() => {
      calls += 1;
      clock += 1000;
      return json(200, okBody());
    });
    const pairs = Array.from({ length: 5 }, (_, i) => pair(`p${i}`));
    const out = await routePairs(pairs, options(fetchFn, { concurrency: 1, deadlineMs: 2500, now: () => clock }));
    expect(calls).toBe(3);
    expect(out.results.map((r) => r.kind === 'unavailable' && r.reason)).toEqual([false, false, false, 'timeout', 'timeout']);
  });

  it('only ever answers with a closed set of reasons', async () => {
    const fetchFn = stub(() => json(400, { code: 'NoSegment' }));
    const out = await routePairs([pair('a')], options(fetchFn));
    for (const r of out.results) {
      if (r.kind === 'unavailable') expect(ROUTE_FAILURE_REASONS).toContain(r.reason);
    }
  });
});

describe('parseRouteResponse (the browser reads what the function wrote)', () => {
  const route = { id: 'a', kind: 'route', durationSeconds: 60, distanceMeters: 900, snapMeters: [3, 4] };
  const gone = { id: 'b', kind: 'unavailable', reason: 'no_route' };

  it('reads the results and the data version', () => {
    expect(parseRouteResponse(200, { ok: true, data_version: '2026-10-20T23:29:32Z', results: [route, gone] })).toEqual({
      ok: true,
      dataVersion: '2026-10-20T23:29:32Z',
      results: [route, gone],
    });
  });

  it('has no data version when the function sent none', () => {
    expect(parseRouteResponse(200, { ok: true, data_version: null, results: [] })).toMatchObject({ ok: true, dataVersion: null });
  });

  it.each([
    ['a result of an unknown kind', { ok: true, results: [{ id: 'a', kind: 'maybe' }] }],
    ['a result with no id', { ok: true, results: [{ kind: 'unavailable', reason: 'no_route' }] }],
    ['a reason outside the closed list', { ok: true, results: [{ id: 'a', kind: 'unavailable', reason: 'whatever the server wrote' }] }],
    ['a route with a negative duration', { ok: true, results: [{ ...route, durationSeconds: -1 }] }],
    ['a route with a string distance', { ok: true, results: [{ ...route, distanceMeters: '900' }] }],
    ['a route with one snap distance', { ok: true, results: [{ ...route, snapMeters: [3] }] }],
    ['results that are not a list', { ok: true, results: 'x' }],
    ['no results', { ok: true }],
    ['a data version that is a number', { ok: true, data_version: 5, results: [] }],
  ])('refuses %s as a bad_answer, so a malformed reply is never half-used', (_label, body) => {
    expect(parseRouteResponse(200, body)).toEqual({ ok: false, reason: 'bad_answer' });
  });

  it('reads a refusal by its reason, and an unknown reason by its status', () => {
    expect(parseRouteResponse(403, { ok: false, reason: 'no_company' })).toEqual({ ok: false, reason: 'no_company' });
    expect(parseRouteResponse(413, { ok: false, reason: 'too_many_pairs' })).toEqual({ ok: false, reason: 'too_many_pairs' });
    expect(parseRouteResponse(401, { ok: false, reason: 'something new' })).toEqual({ ok: false, reason: 'not_authenticated' });
    expect(parseRouteResponse(403, { ok: false, reason: 'something new' })).toEqual({ ok: false, reason: 'no_company' });
    expect(parseRouteResponse(500, { ok: false, reason: 'something new' })).toEqual({ ok: false, reason: 'server_error' });
  });

  it('answers by status alone when the body is not usable', () => {
    expect(parseRouteResponse(401, undefined)).toEqual({ ok: false, reason: 'not_authenticated' });
    expect(parseRouteResponse(502, undefined)).toEqual({ ok: false, reason: 'server_error' });
    expect(parseRouteResponse(200, undefined)).toEqual({ ok: false, reason: 'bad_answer' });
    expect(parseRouteResponse(200, [])).toEqual({ ok: false, reason: 'bad_answer' });
  });
});
