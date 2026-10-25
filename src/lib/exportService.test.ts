import { describe, expect, it, vi } from 'vitest';
import { ExportServiceError, fetchWorkbook, type ExportFailureKind } from './exportService';
import type { WorkbookPayload } from './workbookContract';

const PAYLOAD: WorkbookPayload = { version: 1, sheets: [{ name: 'A', rows: [['x']] }] };
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const BASE = 'https://api.example.test';

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function deps(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  return { fetchImpl, baseUrl: BASE, getAccessToken: async () => 'tok', refreshSession: async () => false, ...extra };
}

async function failure(promise: Promise<unknown>): Promise<ExportServiceError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ExportServiceError);
    return error as ExportServiceError;
  }
  throw new Error('expected the export to fail');
}

describe('fetchWorkbook', () => {
  it('posts the payload with the callers own token and answers the workbook', async () => {
    const fetchImpl = vi.fn(async () => new Response('PK-bytes', { status: 200, headers: { 'Content-Type': XLSX_MIME } }));
    const blob = await fetchWorkbook(PAYLOAD, deps(fetchImpl as unknown as typeof fetch));
    expect(await blob.text()).toBe('PK-bytes');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/export/v1/workbook`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body as string)).toEqual(PAYLOAD);
  });

  it('has no session: unauthorized, and nothing is sent', async () => {
    const fetchImpl = vi.fn();
    const error = await failure(fetchWorkbook(PAYLOAD, deps(fetchImpl as unknown as typeof fetch, { getAccessToken: async () => null })));
    expect(error.kind).toBe('unauthorized');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  const CASES: [string, () => Response, ExportFailureKind, boolean][] = [
    ['502 from the gateway', () => new Response('<html>bad gateway</html>', { status: 502 }), 'unreachable', true],
    ['503 from the gateway', () => new Response('', { status: 503 }), 'unreachable', true],
    ['503 auth_unavailable', () => json(503, { error: { code: 'auth_unavailable' } }), 'unreachable', true],
    ['504 from the gateway', () => new Response('', { status: 504 }), 'unreachable', true],
    ['503 busy', () => json(503, { error: { code: 'busy' } }, { 'Retry-After': '3' }), 'busy', true],
    ['504 from the service deadline', () => json(504, { error: { code: 'timeout' } }), 'timeout', true],
    ['429', () => json(429, { error: { code: 'rate_limited' } }, { 'Retry-After': '12' }), 'rate_limited', true],
    ['401', () => json(401, { error: { code: 'unauthorized' } }), 'unauthorized', false],
    ['413', () => json(413, { error: { code: 'payload_too_large' } }), 'too_large', false],
    ['422', () => json(422, { error: { code: 'illegal_character', sheet: 'Belege', row: 3, column: 2 } }), 'rejected', false],
    ['500', () => json(500, { error: { code: 'internal', request_id: 'abc123' } }), 'server', true],
    ['an HTML page with a 200', () => new Response('<html>captive portal</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }), 'server', true],
    ['a 500 that is not ours', () => new Response('oops', { status: 500 }), 'server', true],
  ];

  for (const [name, respond, kind, retryable] of CASES) {
    it(`${name} is "${kind}", ${retryable ? 'retryable' : 'not retryable'}`, async () => {
      const error = await failure(fetchWorkbook(PAYLOAD, deps((async () => respond()) as unknown as typeof fetch)));
      expect(error.kind).toBe(kind);
      expect(error.retryable).toBe(retryable);
    });
  }

  it('carries the sheet, row and column of a rejection', async () => {
    const error = await failure(fetchWorkbook(PAYLOAD, deps((async () =>
      json(422, { error: { code: 'illegal_character', sheet: 'Belege', row: 3, column: 2, request_id: 'r1' } })) as unknown as typeof fetch)));
    expect(error.detail).toMatchObject({ code: 'illegal_character', sheet: 'Belege', row: 3, column: 2, requestId: 'r1' });
  });

  it('takes the request id from the header when the body has none', async () => {
    const error = await failure(fetchWorkbook(PAYLOAD, deps((async () =>
      new Response('x', { status: 500, headers: { 'X-Request-Id': 'hdr9' } })) as unknown as typeof fetch)));
    expect(error.detail.requestId).toBe('hdr9');
  });

  it('reads Retry-After on a 429', async () => {
    const error = await failure(fetchWorkbook(PAYLOAD, deps((async () =>
      json(429, { error: { code: 'rate_limited' } }, { 'Retry-After': '12' })) as unknown as typeof fetch)));
    expect(error.detail.retryAfterSeconds).toBe(12);
  });

  it('a fetch that rejects is the service being unreachable', async () => {
    const error = await failure(fetchWorkbook(PAYLOAD, deps((async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch)));
    expect(error.kind).toBe('unreachable');
    expect(error.retryable).toBe(true);
  });

  it('a request that outlives the timeout is aborted and is a timeout', async () => {
    const hang = ((_: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })) as unknown as typeof fetch;
    const error = await failure(fetchWorkbook(PAYLOAD, deps(hang, { timeoutMs: 20 })));
    expect(error.kind).toBe('timeout');
  });

  it('a 401 refreshes the session once and retries with the new token', async () => {
    const tokens = ['old', 'new'];
    const fetchImpl = vi.fn(async (_url: unknown, init: RequestInit) => {
      const bearer = (init.headers as Record<string, string>).Authorization;
      return bearer === 'Bearer new'
        ? new Response('ok', { status: 200, headers: { 'Content-Type': XLSX_MIME } })
        : json(401, { error: { code: 'unauthorized' } });
    });
    const refreshSession = vi.fn(async () => true);
    const blob = await fetchWorkbook(PAYLOAD, deps(fetchImpl as unknown as typeof fetch, {
      getAccessToken: async () => tokens.shift() ?? 'new',
      refreshSession,
    }));
    expect(await blob.text()).toBe('ok');
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('a 401 that survives the refresh is unauthorized, after exactly two attempts', async () => {
    const fetchImpl = vi.fn(async () => json(401, { error: { code: 'unauthorized' } }));
    const error = await failure(fetchWorkbook(PAYLOAD, deps(fetchImpl as unknown as typeof fetch, { refreshSession: async () => true })));
    expect(error.kind).toBe('unauthorized');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not retry on its own for any other failure', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 502 }));
    await failure(fetchWorkbook(PAYLOAD, deps(fetchImpl as unknown as typeof fetch)));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
