import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  asIssueDbResult,
  asVerifyDbResult,
  bearerToken,
  CODE_REJECTION_BOUND,
  decodeJwtPayload,
  describeError,
  generateCode,
  hmacHex,
  hmacSha256Hex,
  isEmailExistsError,
  isEmailTakenOnUpdate,
  isValidEmail,
  mapIssueToHttp,
  mapVerifyToHttp,
  normalizeEmail,
  padElapsed,
  parseClientIp,
  parseCode,
  parseEmail,
  parseOtpRequest,
  parseOtpVerify,
  passwordAmrAgeSeconds,
  pickSession,
  readBodyText,
  scrubForLog,
  secureRandomUint32,
  type IssueDbResult,
  type VerifyDbResult,
} from './otp-core.ts';

const PEPPER = 'k2V7qQ0m3eT8Yp1Zr4Ls9Wd6Fh2Jc5Nb0Xu7Ag3Ev1Ty8Oi';
const CHALLENGE = '3f1c2a9e-8b7d-4c6e-9a5f-0d1e2c3b4a5f';

describe('generateCode', () => {
  const from = (...values: number[]) => {
    let i = 0;
    return () => values[i++];
  };

  it('zero-pads to six digits', () => {
    expect(generateCode(from(42))).toBe('000042');
  });

  it('takes the value modulo one million below the bound', () => {
    expect(generateCode(from(4_293_999_999))).toBe('999999');
  });

  it('uses the largest multiple of a million that fits in 32 bits as the bound', () => {
    expect(CODE_REJECTION_BOUND % 1_000_000).toBe(0);
    expect(2 ** 32 - CODE_REJECTION_BOUND).toBeLessThan(1_000_000);
  });

  it('draws again at or above the bound, so every code is equally likely', () => {
    expect(generateCode(from(4_294_000_000, 4_294_967_295, 123_456))).toBe('123456');
  });

  it('reads the source as unsigned 32-bit', () => {
    expect(generateCode(from(-1, 7))).toBe('000007');
  });

  it('gives up on a source that never lands below the bound', () => {
    expect(() => generateCode(() => 4_294_967_295)).toThrow();
  });

  it('always yields six digits from the real source', () => {
    for (let i = 0; i < 500; i++) expect(generateCode(secureRandomUint32)).toMatch(/^\d{6}$/);
  });
});

describe('hmacHex', () => {
  it('is HMAC-SHA256: RFC 4231 test case 2', async () => {
    expect(await hmacSha256Hex('Jefe', 'what do ya want for nothing?'))
      .toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
  });

  it('hashes "<challenge id>:<code>" keyed with the pepper, as lower-case hex', async () => {
    const expected = createHmac('sha256', PEPPER).update(`${CHALLENGE}:048213`).digest('hex');
    expect(await hmacHex(PEPPER, CHALLENGE, '048213')).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reads the pepper as UTF-8', async () => {
    const pepper = 'ä'.repeat(32);
    expect(await hmacHex(pepper, CHALLENGE, '123456'))
      .toBe(createHmac('sha256', Buffer.from(pepper, 'utf8')).update(`${CHALLENGE}:123456`).digest('hex'));
  });

  it('hashes the same code differently in another challenge', async () => {
    const other = '9b2e4c1a-7d3f-4e8a-b6c5-1f0e2d3c4b5a';
    expect(await hmacHex(PEPPER, CHALLENGE, '123456')).not.toBe(await hmacHex(PEPPER, other, '123456'));
  });

  it('refuses a short pepper, a malformed or upper-case id, and a code that is not six digits', async () => {
    await expect(hmacHex('too-short', CHALLENGE, '123456')).rejects.toThrow();
    await expect(hmacHex(PEPPER, CHALLENGE.toUpperCase(), '123456')).rejects.toThrow();
    await expect(hmacHex(PEPPER, 'not-a-uuid', '123456')).rejects.toThrow();
    await expect(hmacHex(PEPPER, CHALLENGE, '12345')).rejects.toThrow();
  });

  it('never repeats the pepper or the code in its errors', async () => {
    const error = await hmacHex(PEPPER, 'nope', '123456').catch((e: Error) => e);
    expect(String(error)).not.toContain(PEPPER);
    expect(String(error)).not.toContain('123456');
  });
});

describe('input', () => {
  it('normalizes an address by trimming and lower-casing', () => {
    expect(normalizeEmail('  Anna.Schmidt@Example.DE ')).toBe('anna.schmidt@example.de');
    expect(normalizeEmail(42)).toBeNull();
    expect(parseEmail(undefined)).toBeNull();
  });

  it('accepts an address of up to 254 characters', () => {
    const address = `${'a'.repeat(64)}@${'b'.repeat(186)}.de`;
    expect(address.length).toBe(254);
    expect(isValidEmail(address)).toBe(true);
    expect(isValidEmail(`x${address}`)).toBe(false);
  });

  it.each(['a@b', 'a b@c.de', '@b.de', 'a@.de', 'a@b.de ', '', 'a@@b.de'])('refuses the address %j', (raw) => {
    expect(isValidEmail(raw)).toBe(false);
  });

  it('reads a pasted code with spaces as six digits', () => {
    expect(parseCode(' 123 456\n')).toBe('123456');
  });

  it.each(['12345', '1234567', '12a456', '١٢٣٤٥٦', ''])('refuses the code %j', (raw) => {
    expect(parseCode(raw)).toBeNull();
  });

  it('refuses a code sent as a number', () => {
    expect(parseCode(123456)).toBeNull();
  });
});

describe('parseClientIp', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    [' 198.51.100.1 ', '198.51.100.1'],
    ['2001:DB8::1', '2001:db8::1'],
    ['::1', '::1'],
    ['::ffff:192.0.2.1', '::ffff:192.0.2.1'],
  ])('accepts %j', (raw, expected) => {
    expect(parseClientIp(raw)).toBe(expected);
  });

  it.each([
    '256.1.1.1',
    '01.2.3.4',
    '1.2.3',
    'fe80::1%eth0',
    '1.2.3.4, 5.6.7.8',
    '[::1]',
    '1:2:3:4:5:6:7:8:9',
    'localhost',
    '',
    'a'.repeat(46),
  ])('refuses %j', (raw) => {
    expect(parseClientIp(raw)).toBeNull();
  });

  it('is null without a header', () => {
    expect(parseClientIp(null)).toBeNull();
    expect(parseClientIp(undefined)).toBeNull();
  });
});

describe('readBodyText', () => {
  const fake = (body: ReadableStream<Uint8Array> | null, headers: Record<string, string> = {}) =>
    ({ headers: new Headers(headers), body }) as unknown as Request;

  it('reads a small body', async () => {
    expect(await readBodyText(new Request('http://x/', { method: 'POST', body: '{"a":1}' }))).toBe('{"a":1}');
  });

  it('accepts exactly the limit', async () => {
    const text = 'a'.repeat(4096);
    expect(await readBodyText(new Request('http://x/', { method: 'POST', body: text }))).toBe(text);
  });

  it('refuses a declared length over the limit, or one that is not a number', async () => {
    expect(await readBodyText(fake(null, { 'content-length': '4097' }))).toBeNull();
    expect(await readBodyText(fake(null, { 'content-length': 'lots' }))).toBeNull();
  });

  it('stops reading a stream that grows past the limit, whatever the header said', async () => {
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 10) controller.enqueue(new Uint8Array(1024));
        else controller.close();
      },
    });
    expect(await readBodyText(fake(stream, { 'content-length': '10' }))).toBeNull();
    expect(sent).toBeLessThan(10);
  });

  it('refuses a body that is not UTF-8', async () => {
    expect(await readBodyText(fake(new Response(new Uint8Array([0xff, 0xfe, 0x41])).body))).toBeNull();
  });
});

describe('request bodies', () => {
  it('reads a public request, normalizing the address and ignoring unknown fields', () => {
    expect(parseOtpRequest('{"purpose":"password_reset","email":" A@B.DE ","new_email":"x@y.de","extra":1}'))
      .toEqual({ purpose: 'password_reset', email: 'a@b.de' });
  });

  it('reads new_email for email_change and nothing for platform_login', () => {
    expect(parseOtpRequest('{"purpose":"email_change","new_email":"Neu@B.de","email":"ignored@b.de"}'))
      .toEqual({ purpose: 'email_change', newEmail: 'neu@b.de' });
    expect(parseOtpRequest('{"purpose":"platform_login","email":"ignored@b.de"}')).toEqual({ purpose: 'platform_login' });
  });

  it.each([
    'not json',
    '[]',
    'null',
    '{"purpose":"admin_login","email":"a@b.de"}',
    '{"purpose":"signup_verify"}',
    '{"purpose":"invite_activate","email":"nope"}',
    '{"purpose":"email_change"}',
  ])('refuses the request %s', (text) => {
    expect(parseOtpRequest(text)).toBeNull();
  });

  it('reads a verification with a pasted code', () => {
    expect(parseOtpVerify('{"purpose":"invite_activate","email":"a@b.de","code":"123 456"}'))
      .toEqual({ purpose: 'invite_activate', email: 'a@b.de', code: '123456' });
    expect(parseOtpVerify('{"purpose":"email_change","code":"123456","email":"x@y.de"}'))
      .toEqual({ purpose: 'email_change', code: '123456' });
  });

  it.each([
    '{"purpose":"password_reset","email":"a@b.de","code":"12345"}',
    '{"purpose":"password_reset","code":"123456"}',
    '{"purpose":"platform_login","code":123456}',
  ])('refuses the verification %s without it costing an attempt', (text) => {
    expect(parseOtpVerify(text)).toBeNull();
  });
});

describe('tokens', () => {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = (payload: unknown) => `${part({ alg: 'HS256', typ: 'JWT' })}.${part(payload)}.signature`;

  it('takes the bearer token from the header', () => {
    expect(bearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(bearerToken('bearer   abc')).toBe('abc');
    expect(bearerToken('Basic abc')).toBeNull();
    expect(bearerToken('Bearer a b')).toBeNull();
    expect(bearerToken(null)).toBeNull();
  });

  it('decodes a payload, UTF-8 included', () => {
    const payload = { sub: 'u-1', session_id: 's-1', user_metadata: { full_name: 'Jürgen Groß' } };
    expect(decodeJwtPayload(token(payload))).toEqual(payload);
  });

  it.each(['a.b', 'a.!!!.c', `${part({})}.${Buffer.from('not json').toString('base64url')}.s`, token([1, 2])])(
    'returns null for %j',
    (value) => {
      expect(decodeJwtPayload(value)).toBeNull();
    },
  );
});

describe('passwordAmrAgeSeconds', () => {
  it('measures the newest password sign-in', () => {
    const payload = {
      amr: [
        { method: 'password', timestamp: 1000 },
        { method: 'otp', timestamp: 1500 },
        { method: 'password', timestamp: 1200 },
      ],
    };
    expect(passwordAmrAgeSeconds(payload, 1800)).toBe(600);
    expect(passwordAmrAgeSeconds(payload, 1800.9)).toBe(600);
  });

  it('does not count a session made by /verify', () => {
    expect(passwordAmrAgeSeconds({ amr: [{ method: 'otp', timestamp: 1789416052 }] }, 1789416060)).toBeNull();
  });

  it('is null without a usable claim and never negative', () => {
    expect(passwordAmrAgeSeconds({}, 100)).toBeNull();
    expect(passwordAmrAgeSeconds({ amr: 'password' }, 100)).toBeNull();
    expect(passwordAmrAgeSeconds({ amr: [{ method: 'password', timestamp: '90' }] }, 100)).toBeNull();
    expect(passwordAmrAgeSeconds({ amr: [{ method: 'password', timestamp: 200 }] }, 100)).toBe(0);
  });
});

describe('database results', () => {
  const issued = {
    status: 'issued',
    challenge_id: CHALLENGE,
    user_id: 'u-1',
    recipient_email: 'a@b.de',
    expires_at: '2026-09-14T12:10:00+00:00',
    full_name: 'Anna',
    company_name: null,
  };

  it('accepts every otp_issue shape the contract names', () => {
    expect(asIssueDbResult(issued)).toEqual(issued);
    expect(asIssueDbResult({ ...issued, full_name: undefined })).toEqual({ ...issued, full_name: null });
    for (const status of ['no_user', 'ineligible', 'same_email', 'email_taken']) {
      expect(asIssueDbResult({ status })).toEqual({ status });
    }
  });

  it('turns retry_after_seconds into a whole number of at least one', () => {
    const limited = (value: unknown) =>
      asIssueDbResult({ status: 'rate_limited', reason: 'cooldown', retry_after_seconds: value });
    expect(limited(12.4)).toMatchObject({ retry_after_seconds: 13 });
    expect(limited('7')).toMatchObject({ retry_after_seconds: 7 });
    expect(limited(0)).toMatchObject({ retry_after_seconds: 1 });
    expect(limited('soon')).toMatchObject({ retry_after_seconds: 60 });
  });

  it.each([
    null,
    { status: 'issued', user_id: 'u' },
    { status: 'rate_limited', reason: 'weekly' },
    { status: 'sent' },
  ])('throws on %j, which means the migration and the function disagree', (raw) => {
    expect(() => asIssueDbResult(raw)).toThrow();
  });

  it('accepts an otp_verify ok only for the purpose that was asked', () => {
    const ok = {
      status: 'ok', purpose: 'email_change', user_id: 'u-1', email: 'alt@b.de',
      new_email: 'neu@b.de', platform_verified_until: null,
    };
    expect(asVerifyDbResult(ok, 'email_change')).toEqual(ok);
    expect(() => asVerifyDbResult(ok, 'password_reset')).toThrow();
  });

  it('keeps attempts_left between one and four', () => {
    expect(asVerifyDbResult({ status: 'wrong', attempts_left: 3 }, 'password_reset')).toEqual({ status: 'wrong', attempts_left: 3 });
    expect(asVerifyDbResult({ status: 'wrong', attempts_left: 9 }, 'password_reset')).toMatchObject({ attempts_left: 4 });
    expect(asVerifyDbResult({ status: 'wrong', attempts_left: 0 }, 'password_reset')).toMatchObject({ attempts_left: 1 });
    expect(asVerifyDbResult({ status: 'wrong' }, 'password_reset')).toMatchObject({ attempts_left: 1 });
  });

  it('throws on an unknown verify status', () => {
    expect(() => asVerifyDbResult({ status: 'maybe' }, 'password_reset')).toThrow();
  });
});

// The closed reason lists of contract 5.1: what src/lib/otpClient.ts accepts.
const REQUEST_REASONS = ['invalid_request', 'rate_limited', 'unauthorized', 'reauth_required', 'forbidden',
  'same_email', 'email_taken', 'send_failed', 'internal', 'network'];
const VERIFY_REASONS = ['invalid_request', 'invalid_code', 'locked', 'expired', 'not_found', 'email_taken',
  'unauthorized', 'session_failed', 'internal', 'network'];

const ISSUED: IssueDbResult = {
  status: 'issued',
  challenge_id: CHALLENGE,
  user_id: 'u-1',
  recipient_email: 'anna@example.com',
  expires_at: '2026-09-14T12:10:00+00:00',
  full_name: 'Anna',
  company_name: 'Taxi Müller',
};
const cooldown: IssueDbResult = { status: 'rate_limited', reason: 'cooldown', retry_after_seconds: 42 };
const hourly: IssueDbResult = { status: 'rate_limited', reason: 'email_hourly', retry_after_seconds: 1800 };
const ipLimited: IssueDbResult = { status: 'rate_limited', reason: 'ip_hourly', retry_after_seconds: 900 };

describe('mapIssueToHttp: public purposes (contract 3.2)', () => {
  const uniform = { status: 202, body: { ok: true, status: 'accepted', cooldown_seconds: 60, expires_in_seconds: 600 } };

  it.each<[string, IssueDbResult, 'sent' | 'send_failed' | undefined]>([
    ['issued, mail sent', ISSUED, 'sent'],
    ['issued, mail failed', ISSUED, 'send_failed'],
    ['issued, mail sent after the response', ISSUED, undefined],
    ['no account', { status: 'no_user' }, undefined],
    ['not eligible', { status: 'ineligible' }, undefined],
    ['cooldown', cooldown, undefined],
    ['hourly limit per address', hourly, undefined],
  ])('%s: the same 202', (_, db, mail) => {
    expect(mapIssueToHttp('public', db, mail)).toEqual(uniform);
  });

  it('carries nothing that depends on the account', () => {
    const body = JSON.stringify(mapIssueToHttp('public', ISSUED, 'sent').body);
    for (const secret of [CHALLENGE, 'anna@example.com', 'u-1', 'Taxi']) expect(body).not.toContain(secret);
  });

  it('lets only the per-IP limit show, because it is the same for every address', () => {
    expect(mapIssueToHttp('public', ipLimited)).toEqual({
      status: 429,
      body: { ok: false, reason: 'rate_limited', scope: 'ip', retry_after_seconds: 900 },
    });
  });
});

describe('mapIssueToHttp: authenticated purposes (contract 3.2)', () => {
  it.each<[string, IssueDbResult, 'sent' | 'send_failed' | undefined, number, Record<string, unknown>]>([
    ['issued and sent', ISSUED, 'sent', 200, { ok: true, status: 'sent', cooldown_seconds: 60, expires_in_seconds: 600 }],
    ['issued, mail failed', ISSUED, 'send_failed', 502, { ok: false, reason: 'send_failed' }],
    ['issued, no mail result', ISSUED, undefined, 502, { ok: false, reason: 'send_failed' }],
    ['cooldown', cooldown, undefined, 429, { ok: false, reason: 'rate_limited', scope: 'cooldown', retry_after_seconds: 42 }],
    ['hourly', hourly, undefined, 429, { ok: false, reason: 'rate_limited', scope: 'email_hourly', retry_after_seconds: 1800 }],
    ['ip', ipLimited, undefined, 429, { ok: false, reason: 'rate_limited', scope: 'ip', retry_after_seconds: 900 }],
    ['same address', { status: 'same_email' }, undefined, 400, { ok: false, reason: 'same_email' }],
    ['address taken', { status: 'email_taken' }, undefined, 409, { ok: false, reason: 'email_taken' }],
    ['not eligible', { status: 'ineligible' }, undefined, 403, { ok: false, reason: 'forbidden' }],
    ['no account', { status: 'no_user' }, undefined, 403, { ok: false, reason: 'forbidden' }],
  ])('%s', (_, db, mail, status, body) => {
    const reply = mapIssueToHttp('authenticated', db, mail);
    expect(reply).toEqual({ status, body });
    if (reply.body.ok === false) expect(REQUEST_REASONS).toContain(reply.body.reason);
  });
});

describe('mapVerifyToHttp (contract 3.3)', () => {
  it.each<[VerifyDbResult, number, Record<string, unknown>]>([
    [{ status: 'wrong', attempts_left: 3 }, 422, { ok: false, reason: 'invalid_code', attempts_left: 3 }],
    [{ status: 'locked' }, 422, { ok: false, reason: 'locked' }],
    [{ status: 'expired' }, 422, { ok: false, reason: 'expired' }],
    [{ status: 'not_found' }, 422, { ok: false, reason: 'not_found' }],
    [{ status: 'session_invalid' }, 401, { ok: false, reason: 'unauthorized' }],
    [{ status: 'email_taken' }, 409, { ok: false, reason: 'email_taken' }],
  ])('%j', (db, status, body) => {
    const reply = mapVerifyToHttp(db);
    expect(reply).toEqual({ status, body });
    expect(VERIFY_REASONS).toContain(reply?.body.reason);
  });

  it('leaves ok to the purpose that completes it', () => {
    expect(mapVerifyToHttp({
      status: 'ok', purpose: 'platform_login', user_id: 'u', email: 'a@b.de', new_email: null,
      platform_verified_until: '2026-09-15T00:00:00+00:00',
    })).toBeNull();
  });
});

describe('pickSession', () => {
  it('keeps exactly the five session fields and drops the user', () => {
    const verified = {
      access_token: 'a', refresh_token: 'r', expires_in: 3600, expires_at: 1789419649, token_type: 'bearer',
      user: { id: 'u-1', email: 'anna@example.com' },
    };
    expect(pickSession(verified)).toEqual({
      access_token: 'a', refresh_token: 'r', expires_in: 3600, expires_at: 1789419649, token_type: 'bearer',
    });
  });

  it('throws on an answer without a session', () => {
    expect(() => pickSession({ code: 403, error_code: 'otp_expired' })).toThrow();
    expect(() => pickSession(null)).toThrow();
  });
});

describe('GoTrue errors, as v2.170.0 answered them on 15.09.2026', () => {
  const exists = { name: 'AuthApiError', status: 422, code: 'email_exists', message: 'A user with this email address has already been registered' };
  const updateClash = { name: 'AuthRetryableFetchError', status: 500, code: null, message: 'Error updating user' };

  it('recognises an existing address on createUser', () => {
    expect(isEmailExistsError(exists)).toBe(true);
    expect(isEmailExistsError({ message: 'User already registered' })).toBe(true);
    expect(isEmailExistsError(updateClash)).toBe(false);
    expect(isEmailExistsError(null)).toBe(false);
  });

  it('recognises only a refusal GoTrue names on updateUserById', () => {
    expect(isEmailTakenOnUpdate(exists)).toBe(true);
    expect(isEmailTakenOnUpdate({ status: 422, message: 'Unprocessable' })).toBe(true);
    // The real v2.170.0 answer cannot be told apart from any other failure; it
    // becomes session_failed, and the next otp-request says email_taken.
    expect(isEmailTakenOnUpdate(updateClash)).toBe(false);
  });
});

describe('logs', () => {
  it('scrubs a six-digit run, a JWT and a long hex string', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.c2lnbmF0dXJl';
    const out = scrubForLog(`code 048213 token ${jwt} hash ${'ab'.repeat(32)}`);
    expect(out).not.toContain('048213');
    expect(out).not.toContain(jwt);
    expect(out).not.toContain('ab'.repeat(32));
  });

  it('keeps ids, SQLSTATEs and longer numbers readable', () => {
    const text = `user ${CHALLENGE} request 1a2b3c4d sqlstate 22023 phone 01701234567`;
    expect(scrubForLog(text)).toBe(text);
  });

  it('caps a line at 500 characters', () => {
    expect(scrubForLog('x'.repeat(2000))).toHaveLength(500);
  });

  it('describes a PostgREST error by code and message, never by details', () => {
    const err = { code: '22023', message: 'otp_issue: invalid arguments', details: 'Failing row contains (anna@example.com)' };
    expect(describeError(err)).toBe('22023: otp_issue: invalid arguments');
    const thrown = Object.assign(new Error('boom'), { code: 'PGRST202' });
    expect(describeError(thrown)).toBe('Error PGRST202: boom');
  });
});

describe('padElapsed', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits out the rest of the floor', async () => {
    vi.useFakeTimers();
    let done = false;
    const pad = padElapsed(1000, 1500, () => 1400).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(1099);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pad;
    expect(done).toBe(true);
  });

  it('returns at once when the floor has passed', async () => {
    vi.useFakeTimers();
    let done = false;
    const pad = padElapsed(0, 1500, () => 2000).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    await pad;
    expect(done).toBe(true);
  });
});
