import { describe, expect, it } from 'vitest';
import type { GeocodeQuery } from '../../supabase/functions/_shared/geocode-core';
import { createGeocodeClient } from './geocodeClient';

const BATCH: GeocodeQuery[] = [{ id: 'a0', text: 'Hauptstraße 12, 42651 Solingen, Deutschland' }];
const LOCATED = { id: 'a0', kind: 'located', lat: 51.1722, lon: 7.0833, precision: 'exact', osm: 'node/4711' };
const GOOD = { ok: true, data_updated: '2026-08-21T17:21:05+00:00', results: [LOCATED] };

interface Call { url: string; init: RequestInit }

function harness(answers: Array<() => Response | Promise<Response>>, over: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  let next = 0;
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const answer = answers[Math.min(next, answers.length - 1)];
    next += 1;
    return answer();
  }) as typeof fetch;
  const client = createGeocodeClient({
    fetchImpl,
    baseUrl: 'https://api.example.test/',
    getAccessToken: async () => 'user-token',
    refreshSession: async () => false,
    timeoutMs: 100,
    ...over,
  });
  return { client, calls };
}

const reply = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status });

describe('createGeocodeClient', () => {
  it('posts the addresses to the geocode-address function with the signed-in user\'s token', async () => {
    const { client, calls } = harness([reply(200, GOOD)]);
    const answer = await client.geocode(BATCH);
    expect(answer).toEqual({ ok: true, dataUpdated: '2026-08-21T17:21:05+00:00', results: [LOCATED] });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.example.test/functions/v1/geocode-address');
    expect(calls[0].init.method).toBe('POST');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer user-token');
  });

  it('sends the id and the text of an address and nothing else of the ride', async () => {
    const { client, calls } = harness([reply(200, GOOD)]);
    await client.geocode([{ ...BATCH[0], tripId: 't1', driver: 'Max', fare: 12.5 } as GeocodeQuery]);
    const body = JSON.parse(String(calls[0].init.body)) as { addresses: Array<Record<string, unknown>> };
    expect(Object.keys(body)).toEqual(['addresses']);
    expect(Object.keys(body.addresses[0]).sort()).toEqual(['id', 'text']);
    expect(JSON.stringify(body)).not.toMatch(/t1|Max|12\.5/);
  });

  it('answers not_authenticated without calling anything when there is no session', async () => {
    const { client, calls } = harness([reply(200, GOOD)], { getAccessToken: async () => null });
    expect(await client.geocode(BATCH)).toEqual({ ok: false, reason: 'not_authenticated' });
    expect(calls).toHaveLength(0);
  });

  it('asks for a fresh session after a 401 and tries once more with it', async () => {
    let token = 'old';
    const { client, calls } = harness(
      [reply(401, { ok: false, reason: 'not_authenticated' }), reply(200, GOOD)],
      { getAccessToken: async () => token, refreshSession: async () => { token = 'new'; return true; } },
    );
    expect((await client.geocode(BATCH)).ok).toBe(true);
    expect(calls.map((c) => (c.init.headers as Record<string, string>).Authorization)).toEqual(['Bearer old', 'Bearer new']);
  });

  it.each([
    [403, { ok: false, reason: 'no_company' }, 'no_company'],
    [413, { ok: false, reason: 'too_many_addresses' }, 'too_many_addresses'],
    [500, { ok: false, reason: 'server_error' }, 'server_error'],
    [502, undefined, 'server_error'],
  ])('reads a %i as %s', async (status, body, reason) => {
    const { client } = harness([() => new Response(body === undefined ? '<html>' : JSON.stringify(body), { status })]);
    expect(await client.geocode(BATCH)).toEqual({ ok: false, reason });
  });

  it('answers bad_answer for a 200 that is not the contract: a point it would have to guess', async () => {
    const coarse = { id: 'a0', kind: 'located', lat: 51.1, lon: 7.0, precision: 'street', osm: null };
    const { client } = harness([reply(200, { ok: true, results: [coarse] })]);
    expect(await client.geocode(BATCH)).toEqual({ ok: false, reason: 'bad_answer' });
  });

  it('answers function_unreachable when the connection fails or nothing answers in time, and never throws', async () => {
    const { client } = harness([() => { throw new TypeError('Failed to fetch'); }]);
    expect(await client.geocode(BATCH)).toEqual({ ok: false, reason: 'function_unreachable' });
    const hung = ((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })) as typeof fetch;
    const slow = createGeocodeClient({ fetchImpl: hung, baseUrl: 'https://api.example.test', getAccessToken: async () => 't', refreshSession: async () => false, timeoutMs: 20 });
    expect(await slow.geocode(BATCH)).toEqual({ ok: false, reason: 'function_unreachable' });
  });
});
