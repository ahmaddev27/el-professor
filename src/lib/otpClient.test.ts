import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  emailFromFragment,
  formatOtpMessage,
  isPlausibleEmail,
  normalizeOtpInput,
  otpMessage,
  requestOtp,
  verifyOtp,
  type OtpMessage,
  type OtpRequestResult,
  type OtpVerifyResult,
} from './otpClient';

const API = 'https://api.example.test';

type RecordedCall = { url: string; init: RequestInit };

/** Answers every fetch with this status and body; returns the calls it saw. */
function serverAnswers(status: number, body: unknown, headers: Record<string, string> = {}): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(text, { status, headers });
  }));
  return calls;
}

const sentBody = (call: RecordedCall) => JSON.parse(String(call.init.body));
const sentHeaders = (call: RecordedCall) => call.init.headers as Record<string, string>;

const SESSION = {
  access_token: 'access',
  refresh_token: 'refresh',
  expires_in: 3600,
  expires_at: 1_900_000_000,
  token_type: 'bearer',
};

beforeEach(() => {
  vi.stubEnv('VITE_SUPABASE_URL', `${API}/`);
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('normalizeOtpInput', () => {
  it.each([
    ['123456', '123456'],
    ['123 456', '123456'],
    [' 12-34-56 ', '123456'],
    ['1234567890', '123456'],
    ['12a3b4', '1234'],
    ['abc', ''],
    ['', ''],
  ])('%j becomes %j', (raw, expected) => {
    expect(normalizeOtpInput(raw)).toBe(expected);
  });
});

describe('emailFromFragment', () => {
  it.each([
    ['#email=anna%40firma.de', 'anna@firma.de'],
    ['#email=Name%2Btag%40Example.DE', 'name+tag@example.de'],
    ['#email=a+b@c.de', 'a+b@c.de'],
    ['#type=invite&email=x%40y.de', 'x@y.de'],
    ['email=x%40y.de', 'x@y.de'],
    ['#other=1', ''],
    ['', ''],
    ['#email=%E0%A4%A', ''],
  ])('%j gives %j', (hash, expected) => {
    expect(emailFromFragment(hash)).toBe(expected);
  });
});

describe('isPlausibleEmail', () => {
  it('accepts an address and refuses what the server would refuse', () => {
    expect(isPlausibleEmail(' Anna@Firma.de ')).toBe(true);
    expect(isPlausibleEmail('anna@firma')).toBe(false);
    expect(isPlausibleEmail('anna firma@x.de')).toBe(false);
    expect(isPlausibleEmail(`${'a'.repeat(250)}@x.de`)).toBe(false);
  });
});

describe('requestOtp', () => {
  it('sends a public purpose with the anon key only, and reads 202 as the uniform answer', async () => {
    const calls = serverAnswers(202, { ok: true, status: 'accepted', cooldown_seconds: 60, expires_in_seconds: 600 });
    const result = await requestOtp({ purpose: 'password_reset', email: ' Anna@Firma.DE ' });

    expect(result).toEqual({ ok: true, cooldownSeconds: 60, expiresInSeconds: 600, uniform: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${API}/functions/v1/otp-request`);
    expect(calls[0].init.method).toBe('POST');
    expect(sentHeaders(calls[0])).toEqual({ apikey: 'anon-key', 'Content-Type': 'application/json' });
    expect(sentBody(calls[0])).toEqual({ purpose: 'password_reset', email: 'anna@firma.de' });
  });

  it('sends email_change with the bearer token and new_email, and reads 200 as not uniform', async () => {
    const calls = serverAnswers(200, { ok: true, status: 'sent', cooldown_seconds: 60, expires_in_seconds: 600 });
    const result = await requestOtp({ purpose: 'email_change', newEmail: 'Neu@Firma.de', accessToken: 'jwt' });

    expect(result).toEqual({ ok: true, cooldownSeconds: 60, expiresInSeconds: 600, uniform: false });
    expect(sentHeaders(calls[0]).Authorization).toBe('Bearer jwt');
    expect(sentBody(calls[0])).toEqual({ purpose: 'email_change', new_email: 'neu@firma.de' });
  });

  it('sends platform_login with nothing but the purpose', async () => {
    const calls = serverAnswers(200, { ok: true, status: 'sent', cooldown_seconds: 60, expires_in_seconds: 600 });
    await requestOtp({ purpose: 'platform_login', accessToken: 'jwt' });
    expect(sentBody(calls[0])).toEqual({ purpose: 'platform_login' });
  });

  it.each<[string, number, unknown, OtpRequestResult]>([
    ['ip limit', 429, { ok: false, reason: 'rate_limited', scope: 'ip', retry_after_seconds: 1800 },
      { ok: false, reason: 'rate_limited', scope: 'ip', retryAfterSeconds: 1800 }],
    ['cooldown', 429, { ok: false, reason: 'rate_limited', scope: 'cooldown', retry_after_seconds: 42 },
      { ok: false, reason: 'rate_limited', scope: 'cooldown', retryAfterSeconds: 42 }],
    ['hourly limit', 429, { ok: false, reason: 'rate_limited', scope: 'email_hourly', retry_after_seconds: 3000 },
      { ok: false, reason: 'rate_limited', scope: 'email_hourly', retryAfterSeconds: 3000 }],
    ['send failed', 502, { ok: false, reason: 'send_failed' }, { ok: false, reason: 'send_failed' }],
    ['same email', 400, { ok: false, reason: 'same_email' }, { ok: false, reason: 'same_email' }],
    ['email taken', 409, { ok: false, reason: 'email_taken' }, { ok: false, reason: 'email_taken' }],
    ['forbidden', 403, { ok: false, reason: 'forbidden' }, { ok: false, reason: 'forbidden' }],
    ['unauthorized', 401, { ok: false, reason: 'unauthorized' }, { ok: false, reason: 'unauthorized' }],
    ['stale password proof', 401, { ok: false, reason: 'reauth_required' }, { ok: false, reason: 'reauth_required' }],
    ['validation', 400, { ok: false, reason: 'invalid_request' }, { ok: false, reason: 'invalid_request' }],
    ['internal', 500, { ok: false, reason: 'internal', request_id: 'abcd1234' }, { ok: false, reason: 'internal' }],
    ['a reason outside the list', 405, { ok: false, reason: 'method_not_allowed' }, { ok: false, reason: 'internal' }],
    ['the router refusing the api key', 401, { error: 'Missing or invalid API key' }, { ok: false, reason: 'unauthorized' }],
  ])('maps %s', async (_label, status, body, expected) => {
    serverAnswers(status, body);
    const result = await requestOtp({ purpose: 'email_change', newEmail: 'neu@firma.de', accessToken: 'jwt' });
    expect(result).toEqual(expected);
  });

  it.each<[string, number, unknown, OtpRequestResult]>([
    ['the ip limit', 429, { ok: false, reason: 'rate_limited', scope: 'ip', retry_after_seconds: 1200 },
      { ok: false, reason: 'rate_limited', scope: 'ip', retryAfterSeconds: 1200 }],
    ['validation', 400, { ok: false, reason: 'invalid_request' }, { ok: false, reason: 'invalid_request' }],
    ['a retry_after_seconds below one', 429, { ok: false, reason: 'rate_limited', scope: 'ip', retry_after_seconds: 0 },
      { ok: false, reason: 'rate_limited', scope: 'ip', retryAfterSeconds: 1 }],
  ])('maps %s for a public purpose', async (_label, status, body, expected) => {
    serverAnswers(status, body);
    expect(await requestOtp({ purpose: 'signup_verify', email: 'a@b.de' })).toEqual(expected);
  });

  it('reads a proxy 429 without our body from Retry-After', async () => {
    serverAnswers(429, { message: 'API rate limit exceeded' }, { 'Retry-After': '30' });
    expect(await requestOtp({ purpose: 'signup_verify', email: 'a@b.de' }))
      .toEqual({ ok: false, reason: 'rate_limited', retryAfterSeconds: 30 });
  });

  it('turns a non-JSON answer into network', async () => {
    serverAnswers(502, '<html>Bad Gateway</html>');
    expect(await requestOtp({ purpose: 'invite_activate', email: 'a@b.de' })).toEqual({ ok: false, reason: 'network' });
  });

  it('turns a rejected fetch into network', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    expect(await requestOtp({ purpose: 'password_reset', email: 'a@b.de' })).toEqual({ ok: false, reason: 'network' });
  });

  it('refuses an implausible address or a missing token without a request', async () => {
    const calls = serverAnswers(202, { ok: true });
    expect(await requestOtp({ purpose: 'password_reset', email: 'not-an-address' }))
      .toEqual({ ok: false, reason: 'invalid_request' });
    expect(await requestOtp({ purpose: 'email_change', newEmail: 'neu@firma.de', accessToken: '' }))
      .toEqual({ ok: false, reason: 'invalid_request' });
    expect(calls).toHaveLength(0);
  });
});

describe('verifyOtp', () => {
  it('returns only the five session fields for signup_verify', async () => {
    const calls = serverAnswers(200, {
      ok: true, purpose: 'signup_verify', next: 'app',
      session: { ...SESSION, user: { id: 'u1' } },
      discount: null,
    });
    const result = await verifyOtp({ purpose: 'signup_verify', email: 'Anna@Firma.de', code: '123 456' });

    expect(result).toEqual({ ok: true, purpose: 'signup_verify', next: 'app', session: SESSION });
    expect(calls[0].url).toBe(`${API}/functions/v1/otp-verify`);
    expect(sentHeaders(calls[0]).Authorization).toBeUndefined();
    expect(sentBody(calls[0])).toEqual({ purpose: 'signup_verify', email: 'anna@firma.de', code: '123456' });
  });

  it('sends password reset on to the password form', async () => {
    serverAnswers(200, { ok: true, purpose: 'password_reset', next: 'set_password', session: SESSION });
    expect(await verifyOtp({ purpose: 'password_reset', email: 'a@b.de', code: '123456' }))
      .toEqual({ ok: true, purpose: 'password_reset', next: 'set_password', session: SESSION });
  });

  it('falls back to the purpose when next is missing', async () => {
    serverAnswers(200, { ok: true, purpose: 'invite_activate', session: SESSION });
    const result = await verifyOtp({ purpose: 'invite_activate', email: 'a@b.de', code: '123456' });
    expect(result).toMatchObject({ ok: true, next: 'set_password' });
  });

  it('treats an ok without a usable session as session_failed', async () => {
    serverAnswers(200, { ok: true, purpose: 'password_reset', next: 'set_password', session: { access_token: 'a' } });
    expect(await verifyOtp({ purpose: 'password_reset', email: 'a@b.de', code: '123456' }))
      .toEqual({ ok: false, reason: 'session_failed' });
  });

  it('sends email_change with the token and no email', async () => {
    const calls = serverAnswers(200, { ok: true, purpose: 'email_change', email: 'neu@firma.de' });
    const result = await verifyOtp({ purpose: 'email_change', code: '654321', accessToken: 'jwt' });

    expect(result).toEqual({ ok: true, purpose: 'email_change', email: 'neu@firma.de' });
    expect(sentHeaders(calls[0]).Authorization).toBe('Bearer jwt');
    expect(sentBody(calls[0])).toEqual({ purpose: 'email_change', code: '654321' });
  });

  it('reads platform_login verified_until', async () => {
    serverAnswers(200, { ok: true, purpose: 'platform_login', verified_until: '2026-09-15T10:00:00Z' });
    expect(await verifyOtp({ purpose: 'platform_login', code: '654321', accessToken: 'jwt' }))
      .toEqual({ ok: true, purpose: 'platform_login', verifiedUntil: '2026-09-15T10:00:00Z' });
  });

  it('refuses an answer for a different purpose', async () => {
    serverAnswers(200, { ok: true, purpose: 'password_reset', session: SESSION });
    expect(await verifyOtp({ purpose: 'signup_verify', email: 'a@b.de', code: '123456' }))
      .toEqual({ ok: false, reason: 'internal' });
  });

  it.each<[string, number, unknown, OtpVerifyResult]>([
    ['a wrong code', 422, { ok: false, reason: 'invalid_code', attempts_left: 3 },
      { ok: false, reason: 'invalid_code', attemptsLeft: 3 }],
    ['a locked challenge', 422, { ok: false, reason: 'locked' }, { ok: false, reason: 'locked' }],
    ['an expired code', 422, { ok: false, reason: 'expired' }, { ok: false, reason: 'expired' }],
    ['no open challenge', 422, { ok: false, reason: 'not_found' }, { ok: false, reason: 'not_found' }],
    ['an invalid session', 401, { ok: false, reason: 'unauthorized' }, { ok: false, reason: 'unauthorized' }],
    ['a taken address', 409, { ok: false, reason: 'email_taken' }, { ok: false, reason: 'email_taken' }],
    ['a failed session hand-off', 502, { ok: false, reason: 'session_failed', request_id: 'abcd1234' },
      { ok: false, reason: 'session_failed' }],
    ['validation', 400, { ok: false, reason: 'invalid_request' }, { ok: false, reason: 'invalid_request' }],
    ['internal', 500, { ok: false, reason: 'internal', request_id: 'abcd1234' }, { ok: false, reason: 'internal' }],
    ['a reason outside the list', 429, { ok: false, reason: 'rate_limited' }, { ok: false, reason: 'internal' }],
    ['the router refusing the api key', 401, { error: 'Missing or invalid API key' }, { ok: false, reason: 'unauthorized' }],
  ])('maps %s', async (_label, status, body, expected) => {
    serverAnswers(status, body);
    expect(await verifyOtp({ purpose: 'password_reset', email: 'a@b.de', code: '123456' })).toEqual(expected);
  });

  it('turns a non-JSON answer and a rejected fetch into network', async () => {
    serverAnswers(504, 'Gateway Timeout');
    expect(await verifyOtp({ purpose: 'password_reset', email: 'a@b.de', code: '123456' }))
      .toEqual({ ok: false, reason: 'network' });

    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    expect(await verifyOtp({ purpose: 'email_change', code: '123456', accessToken: 'jwt' }))
      .toEqual({ ok: false, reason: 'network' });
  });

  it('refuses a short code, a missing email or a missing token without a request', async () => {
    const calls = serverAnswers(200, { ok: true });
    expect(await verifyOtp({ purpose: 'password_reset', email: 'a@b.de', code: '12345' }))
      .toEqual({ ok: false, reason: 'invalid_request' });
    expect(await verifyOtp({ purpose: 'signup_verify', code: '123456' }))
      .toEqual({ ok: false, reason: 'invalid_request' });
    expect(await verifyOtp({ purpose: 'platform_login', code: '123456' }))
      .toEqual({ ok: false, reason: 'invalid_request' });
    expect(calls).toHaveLength(0);
  });
});

describe('otpMessage', () => {
  it.each<[string, OtpRequestResult | OtpVerifyResult, OtpMessage | null]>([
    ['a sent code', { ok: true, cooldownSeconds: 60, expiresInSeconds: 600, uniform: false }, { key: 'otp.sent' }],
    ['a uniform answer', { ok: true, cooldownSeconds: 60, expiresInSeconds: 600, uniform: true }, { key: 'otp.sent' }],
    ['a verified code', { ok: true, purpose: 'email_change', email: 'x@y.de' }, null],
    ['the ip limit', { ok: false, reason: 'rate_limited', scope: 'ip', retryAfterSeconds: 120 },
      { key: 'otp.error.rateLimited', vars: { seconds: 120 } }],
    ['the cooldown', { ok: false, reason: 'rate_limited', scope: 'cooldown', retryAfterSeconds: 7 },
      { key: 'otp.error.rateLimited', vars: { seconds: 7 } }],
    ['a limit without seconds', { ok: false, reason: 'rate_limited' },
      { key: 'otp.error.rateLimited', vars: { seconds: 60 } }],
    ['the hourly limit', { ok: false, reason: 'rate_limited', scope: 'email_hourly', retryAfterSeconds: 3000 },
      { key: 'otp.error.rateLimitedHourly' }],
    ['a failed send', { ok: false, reason: 'send_failed' }, { key: 'otp.error.sendFailed' }],
    ['invalid input', { ok: false, reason: 'invalid_request' }, { key: 'otp.error.invalidInput' }],
    ['a wrong code', { ok: false, reason: 'invalid_code', attemptsLeft: 4 },
      { key: 'otp.error.invalidCode', plural: { one: 'otp.error.attemptsLeftOne', other: 'otp.error.attemptsLeftOther', count: 4 } }],
    ['a wrong code without a count', { ok: false, reason: 'invalid_code' }, { key: 'otp.error.invalidCode' }],
    ['a lock', { ok: false, reason: 'locked' }, { key: 'otp.error.locked' }],
    ['an expiry', { ok: false, reason: 'expired' }, { key: 'otp.error.expired' }],
    ['no challenge', { ok: false, reason: 'not_found' }, { key: 'otp.error.notFound' }],
    ['a taken address', { ok: false, reason: 'email_taken' }, { key: 'otp.error.emailTaken' }],
    ['the same address', { ok: false, reason: 'same_email' }, { key: 'account.error.emailUnchanged' }],
    ['an expired session', { ok: false, reason: 'unauthorized' }, { key: 'otp.error.unauthorized' }],
    ['a stale password proof', { ok: false, reason: 'reauth_required' }, { key: 'otp.error.reauthRequired' }],
    ['an ineligible account', { ok: false, reason: 'forbidden' }, { key: 'otp.error.forbidden' }],
    ['a failed hand-off', { ok: false, reason: 'session_failed' }, { key: 'otp.error.sessionFailed' }],
    ['an internal error', { ok: false, reason: 'internal' }, { key: 'otp.error.internal' }],
    ['a network error', { ok: false, reason: 'network' }, { key: 'otp.error.network' }],
  ])('%s', (_label, result, expected) => {
    expect(otpMessage(result)).toEqual(expected);
  });
});

describe('formatOtpMessage', () => {
  const t = (key: string, vars?: Record<string, string | number>) => `${key}${vars ? JSON.stringify(vars) : ''}`;
  const tPlural = (keys: { one: string; other: string }, count: number) => `${count === 1 ? keys.one : keys.other}:${count}`;

  it('interpolates and appends the plural sentence', () => {
    expect(formatOtpMessage({ key: 'otp.error.rateLimited', vars: { seconds: 5 } }, t, tPlural))
      .toBe('otp.error.rateLimited{"seconds":5}');
    expect(formatOtpMessage(
      { key: 'otp.error.invalidCode', plural: { one: 'otp.error.attemptsLeftOne', other: 'otp.error.attemptsLeftOther', count: 1 } },
      t, tPlural,
    )).toBe('otp.error.invalidCode otp.error.attemptsLeftOne:1');
  });
});
