import { describe, expect, it } from 'vitest';
import type { RoutePair } from '../../supabase/functions/_shared/travel-route-core';
import { createTravelRouteClient } from './travelRouteClient';

const PAIRS: RoutePair[] = [
  { id: 'p1', from: { lat: 51.17129, lon: 7.08321 }, to: { lat: 51.2277, lon: 6.7735 } },
];
const GOOD = { ok: true, data_version: '2026-10-20T23:29:32Z', results: [{ id: 'p1', kind: 'route', durationSeconds: 600, distanceMeters: 4000, snapMeters: [4, 6] }] };

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
  const client = createTravelRouteClient({
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

describe('createTravelRouteClient', () => {
  it('posts the pairs to the travel-route function with the signed-in user\'s token', async () => {
    const { client, calls } = harness([reply(200, GOOD)]);
    const answer = await client.route(PAIRS);
    expect(answer).toEqual({
      ok: true,
      dataVersion: '2026-10-20T23:29:32Z',
      results: [{ id: 'p1', kind: 'route', durationSeconds: 600, distanceMeters: 4000, snapMeters: [4, 6] }],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.example.test/functions/v1/travel-route');
    expect(calls[0].init.method).toBe('POST');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer user-token');
  });

  it('sends coordinates and ids and nothing else: no address, no name, no time', async () => {
    const { client, calls } = harness([reply(200, GOOD)]);
    await client.route([{ ...PAIRS[0], address: 'Musterstrasse 1', driver: 'Max' } as RoutePair]);
    const body = JSON.parse(String(calls[0].init.body)) as { pairs: Array<Record<string, unknown>> };
    expect(Object.keys(body)).toEqual(['pairs']);
    expect(Object.keys(body.pairs[0]).sort()).toEqual(['from', 'id', 'to']);
    expect(Object.keys(body.pairs[0].from as object).sort()).toEqual(['lat', 'lon']);
    expect(JSON.stringify(body)).not.toMatch(/Musterstrasse|Max/);
  });

  it('answers not_authenticated without calling anything when there is no session', async () => {
    const { client, calls } = harness([reply(200, GOOD)], { getAccessToken: async () => null });
    expect(await client.route(PAIRS)).toEqual({ ok: false, reason: 'not_authenticated' });
    expect(calls).toHaveLength(0);
  });

  it('asks for a fresh session after a 401 and tries once more with it', async () => {
    let token = 'old';
    const { client, calls } = harness(
      [reply(401, { ok: false, reason: 'not_authenticated' }), reply(200, GOOD)],
      { getAccessToken: async () => token, refreshSession: async () => { token = 'new'; return true; } },
    );
    expect((await client.route(PAIRS)).ok).toBe(true);
    expect(calls.map((c) => (c.init.headers as Record<string, string>).Authorization)).toEqual(['Bearer old', 'Bearer new']);
  });

  it('gives up after one retry: a second 401 is not_authenticated', async () => {
    const { client, calls } = harness(
      [reply(401, { ok: false, reason: 'not_authenticated' })],
      { refreshSession: async () => true },
    );
    expect(await client.route(PAIRS)).toEqual({ ok: false, reason: 'not_authenticated' });
    expect(calls).toHaveLength(2);
  });

  it.each([
    [403, { ok: false, reason: 'no_company' }, 'no_company'],
    [413, { ok: false, reason: 'too_many_pairs' }, 'too_many_pairs'],
    [500, { ok: false, reason: 'server_error' }, 'server_error'],
    [502, undefined, 'server_error'],
  ])('reads a %i as %s', async (status, body, reason) => {
    const { client } = harness([() => new Response(body === undefined ? '<html>' : JSON.stringify(body), { status })]);
    expect(await client.route(PAIRS)).toEqual({ ok: false, reason });
  });

  it('answers bad_answer for a 200 that is not the contract', async () => {
    const { client } = harness([reply(200, { ok: true, results: [{ id: 'p1', kind: 'maybe' }] })]);
    expect(await client.route(PAIRS)).toEqual({ ok: false, reason: 'bad_answer' });
    const { client: html } = harness([() => new Response('<html>hello</html>', { status: 200 })]);
    expect(await html.route(PAIRS)).toEqual({ ok: false, reason: 'bad_answer' });
  });

  it('answers function_unreachable when the connection fails, and never throws', async () => {
    const { client } = harness([() => { throw new TypeError('Failed to fetch'); }]);
    expect(await client.route(PAIRS)).toEqual({ ok: false, reason: 'function_unreachable' });
  });

  it('answers function_unreachable when nothing answers in time', async () => {
    const fetchImpl = ((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })) as typeof fetch;
    const client = createTravelRouteClient({
      fetchImpl, baseUrl: 'https://api.example.test', getAccessToken: async () => 't', refreshSession: async () => false, timeoutMs: 20,
    });
    expect(await client.route(PAIRS)).toEqual({ ok: false, reason: 'function_unreachable' });
  });
});
