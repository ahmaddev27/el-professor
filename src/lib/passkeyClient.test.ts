import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decodeCreationOptions,
  decodeRequestOptions,
  deletePasskey,
  fromBase64Url,
  listPasskeys,
  parsePasskeyChallenge,
  parsePasskeyList,
  passkeyCeremonyFailure,
  passkeyHttpFailure,
  passkeyMessageKey,
  passkeysUsable,
  serializeCredential,
  toBase64Url,
  verifyAuthentication,
} from './passkeyClient';

/**
 * The passkey wire, exercised without a browser.
 *
 * Everything here is reachable in Node because the encoder takes a structural
 * credential rather than a real `PublicKeyCredential`, which cannot be
 * constructed outside a browser. That is the whole reason it is structural: an
 * encoder that only runs behind a real authenticator is an encoder nothing
 * checks until a user presses the button.
 */

const API = 'https://api.example.test';

type RecordedCall = { url: string; init: RequestInit | undefined };

function serverAnswers(status: number, body: unknown): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return status === 204
      ? new Response(null, { status })
      : new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }));
  return calls;
}

const bytes = (...values: number[]) => new Uint8Array(values);

beforeEach(() => {
  vi.stubEnv('VITE_SUPABASE_URL', `${API}/`);
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('base64url', () => {
  it('writes unpadded base64url, which is what WebAuthn JSON uses', () => {
    // 0xFB 0xFF chooses the two characters the two alphabets disagree on: standard
    // base64 writes "+/", base64url writes "-_". A codec that forgot the swap
    // produces a body the server cannot parse and a sign-in that fails with no
    // explanation, so the bytes here are chosen to catch exactly that.
    expect(toBase64Url(bytes(0xfb, 0xff, 0xfe))).toBe('-__-');
    expect(toBase64Url(bytes(1))).toBe('AQ');
    expect(toBase64Url(bytes())).toBe('');
  });

  it('reads base64url and standard base64 back, padded or not', () => {
    for (const text of ['-__-', '+//+']) {
      expect(Array.from(fromBase64Url(text))).toEqual([0xfb, 0xff, 0xfe]);
    }
    expect(Array.from(fromBase64Url('AQ'))).toEqual([1]);
    expect(Array.from(fromBase64Url('AQ=='))).toEqual([1]);
  });

  it('round-trips every byte value', () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i += 1) all[i] = i;
    expect(Array.from(fromBase64Url(toBase64Url(all)))).toEqual(Array.from(all));
  });
});

describe('parsePasskeyChallenge', () => {
  it('reads the two members it needs', () => {
    expect(parsePasskeyChallenge({ challenge_id: 'c-1', options: { challenge: 'AQ' }, expires_at: 1 }))
      .toEqual({ challengeId: 'c-1', options: { challenge: 'AQ' } });
  });

  it.each([
    ['no id', { options: {} }],
    ['an empty id', { challenge_id: '', options: {} }],
    ['no options', { challenge_id: 'c-1' }],
    ['options that are not an object', { challenge_id: 'c-1', options: 'AQ' }],
    ['nothing', null],
  ])('refuses %s', (_label, body) => {
    expect(parsePasskeyChallenge(body)).toBeNull();
  });
});

describe('parsePasskeyList', () => {
  it('reads the rows and normalises the optional members', () => {
    expect(parsePasskeyList([
      { id: 'p1', friendly_name: 'iPhone', created_at: '2026-10-27T08:00:00Z', last_used_at: '2026-10-27T09:00:00Z' },
      { id: 'p2' },
    ])).toEqual([
      { id: 'p1', friendlyName: 'iPhone', createdAt: '2026-10-27T08:00:00Z', lastUsedAt: '2026-10-27T09:00:00Z' },
      { id: 'p2', friendlyName: null, createdAt: null, lastUsedAt: null },
    ]);
  });

  it('keeps an unreadable answer apart from an empty one', () => {
    // The distinction the screen depends on: an empty list is the claim "this
    // account has no passkey", and a body that is not a list is not evidence
    // for it.
    expect(parsePasskeyList([])).toEqual([]);
    expect(parsePasskeyList({ error: 'nope' })).toBeNull();
    expect(parsePasskeyList(null)).toBeNull();
  });

  it('drops a row with no usable id rather than inventing one', () => {
    expect(parsePasskeyList([{ id: 'p1' }, { friendly_name: 'no id' }, { id: '' }]))
      .toEqual([{ id: 'p1', friendlyName: null, createdAt: null, lastUsedAt: null }]);
  });
});

describe('decoding the options', () => {
  it('turns the authentication challenge into buffers and passes the rest through', () => {
    const decoded = decodeRequestOptions({
      challenge: '-__-',
      rpId: 'elprofessor.eu',
      timeout: 60000,
      userVerification: 'preferred',
      allowCredentials: [{ type: 'public-key', id: 'AQ', transports: ['internal', 'hybrid'] }],
    });

    expect(Array.from(new Uint8Array(decoded.challenge as ArrayBuffer))).toEqual([0xfb, 0xff, 0xfe]);
    expect(decoded.rpId).toBe('elprofessor.eu');
    expect(decoded.timeout).toBe(60000);
    expect(decoded.userVerification).toBe('preferred');
    expect(Array.from(new Uint8Array(decoded.allowCredentials![0].id as ArrayBuffer))).toEqual([1]);
    expect(decoded.allowCredentials![0].transports).toEqual(['internal', 'hybrid']);
  });

  it('turns the registration challenge and the user handle into buffers', () => {
    const decoded = decodeCreationOptions({
      challenge: 'AQ',
      rp: { id: 'elprofessor.eu', name: 'El-Professor' },
      user: { id: '-__-', name: 'a@b.test', displayName: 'A' },
      excludeCredentials: [{ type: 'public-key', id: 'Ag' }],
    });

    expect(Array.from(new Uint8Array(decoded.challenge as ArrayBuffer))).toEqual([1]);
    expect(Array.from(new Uint8Array(decoded.user.id as ArrayBuffer))).toEqual([0xfb, 0xff, 0xfe]);
    expect(decoded.user.name).toBe('a@b.test');
    expect(decoded.rp).toEqual({ id: 'elprofessor.eu', name: 'El-Professor' });
    expect(Array.from(new Uint8Array(decoded.excludeCredentials![0].id as ArrayBuffer))).toEqual([2]);
  });

  it('refuses options with no challenge, and registration options with no user id', () => {
    expect(() => decodeRequestOptions({ rpId: 'x' })).toThrow();
    expect(() => decodeCreationOptions({ challenge: 'AQ' })).toThrow();
    expect(() => decodeCreationOptions({ challenge: 'AQ', user: { name: 'a' } })).toThrow();
  });
});

describe('serializeCredential', () => {
  const common = { id: 'cred-id', rawId: bytes(1, 2), type: 'public-key' };

  it('writes an assertion the way go-webauthn unmarshals it', () => {
    expect(serializeCredential({
      ...common,
      authenticatorAttachment: 'platform',
      getClientExtensionResults: () => ({ credProps: { rk: true } }),
      response: {
        clientDataJSON: bytes(3),
        authenticatorData: bytes(4),
        signature: bytes(5),
        userHandle: bytes(6),
      },
    })).toEqual({
      id: 'cred-id',
      rawId: 'AQI',
      type: 'public-key',
      authenticatorAttachment: 'platform',
      clientExtensionResults: { credProps: { rk: true } },
      response: {
        clientDataJSON: 'Aw',
        authenticatorData: 'BA',
        signature: 'BQ',
        userHandle: 'Bg',
      },
    });
  });

  it('writes an attestation, and tells the two apart by what the response carries', () => {
    const body = serializeCredential({
      ...common,
      response: { clientDataJSON: bytes(3), attestationObject: bytes(7) },
    });
    expect(body.response).toEqual({ clientDataJSON: 'Aw', attestationObject: 'Bw' });
    expect(body.clientExtensionResults).toEqual({});
    expect(body).not.toHaveProperty('authenticatorAttachment');
  });

  it('omits userHandle rather than sending null, and refuses a response that is neither kind', () => {
    const body = serializeCredential({
      ...common,
      response: { clientDataJSON: bytes(3), authenticatorData: bytes(4), signature: bytes(5), userHandle: null },
    });
    expect(body.response).not.toHaveProperty('userHandle');

    expect(() => serializeCredential({ ...common, response: { clientDataJSON: bytes(3) } })).toThrow();
    expect(() => serializeCredential({ ...common, response: {} })).toThrow();
  });
});

describe('failures', () => {
  it('maps GoTrue s own error codes', () => {
    expect(passkeyHttpFailure(422, { error_code: 'too_many_passkeys' })).toBe('tooMany');
    expect(passkeyHttpFailure(422, { error_code: 'webauthn_credential_exists' })).toBe('alreadyRegistered');
    expect(passkeyHttpFailure(400, { error_code: 'webauthn_challenge_expired' })).toBe('challengeExpired');
    expect(passkeyHttpFailure(400, { error_code: 'webauthn_challenge_not_found' })).toBe('challengeExpired');
    expect(passkeyHttpFailure(400, { error_code: 'webauthn_verification_failed' })).toBe('verificationFailed');
    expect(passkeyHttpFailure(404, { error_code: 'passkey_disabled' })).toBe('disabled');
  });

  it('reads a bare 404 as "passkeys are off", which is what it means', () => {
    // requirePasskeyEnabled wraps the whole route group, so every passkey path
    // is a 404 both when the switch is off and on a GoTrue too old to have it.
    // Same answer, same reason, and the one a user can act on.
    expect(passkeyHttpFailure(404, null)).toBe('disabled');
    expect(passkeyHttpFailure(429, null)).toBe('rateLimited');
    expect(passkeyHttpFailure(500, null)).toBe('generic');
  });

  it('reads a dismissed prompt as cancelled, never as a failure', () => {
    expect(passkeyCeremonyFailure({ name: 'NotAllowedError' })).toBe('cancelled');
    expect(passkeyCeremonyFailure({ name: 'AbortError' })).toBe('cancelled');
    expect(passkeyCeremonyFailure({ name: 'InvalidStateError' })).toBe('alreadyRegistered');
    expect(passkeyCeremonyFailure({ name: 'NotSupportedError' })).toBe('unsupported');
    expect(passkeyCeremonyFailure(new Error('something else'))).toBe('generic');
    expect(passkeyCeremonyFailure(undefined)).toBe('generic');
  });

  it('has a dictionary key for every failure', () => {
    const failures = [
      'unsupported', 'cancelled', 'disabled', 'tooMany', 'alreadyRegistered', 'challengeExpired',
      'verificationFailed', 'noCredential', 'wrongAccount', 'rateLimited', 'network', 'generic',
    ] as const;
    for (const failure of failures) {
      expect(passkeyMessageKey(failure)).toBe(`passkey.error.${failure}`);
    }
  });
});

describe('passkeysUsable', () => {
  it('is false where there is no WebAuthn to ask', () => {
    expect(passkeysUsable()).toBe(false);
  });

  it('is true once the browser carries both halves', () => {
    vi.stubGlobal('window', { PublicKeyCredential: class {} });
    vi.stubGlobal('navigator', { credentials: { get: () => {}, create: () => {} } });
    expect(passkeysUsable()).toBe(true);
  });

  it('is false when PublicKeyCredential is there but credentials is not', () => {
    vi.stubGlobal('window', { PublicKeyCredential: class {} });
    vi.stubGlobal('navigator', {});
    expect(passkeysUsable()).toBe(false);
  });
});

describe('the routes', () => {
  it('verifies an assertion and reports which account it resolved to', async () => {
    const calls = serverAnswers(200, {
      access_token: 'fresh-access',
      refresh_token: 'fresh-refresh',
      user: { id: 'user-1', email: 'a@b.test' },
    });

    await expect(verifyAuthentication('c-1', { id: 'cred' })).resolves.toEqual({
      ok: true,
      value: { accessToken: 'fresh-access', refreshToken: 'fresh-refresh', userId: 'user-1' },
    });

    expect(calls[0].url).toBe(`${API}/auth/v1/passkeys/authentication/verify`);
    expect(calls[0].init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ challenge_id: 'c-1', credential: { id: 'cred' } });
  });

  it('refuses a session answer with no account in it', async () => {
    serverAnswers(200, { access_token: 'a', refresh_token: 'b' });
    await expect(verifyAuthentication('c-1', {})).resolves.toEqual({ ok: false, failure: 'generic' });
  });

  it('lists on the caller s own bearer, at the path GoTrue serves', async () => {
    const calls = serverAnswers(200, [{ id: 'p1', friendly_name: 'Pixel' }]);
    const result = await listPasskeys('session-token');

    expect(result).toEqual({ ok: true, value: [{ id: 'p1', friendlyName: 'Pixel', createdAt: null, lastUsedAt: null }] });
    expect(calls[0].url).toBe(`${API}/auth/v1/passkeys`);
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer session-token');
    expect((calls[0].init?.headers as Record<string, string>).apikey).toBe('anon-key');
  });

  it('reads a 204 from the delete as success', async () => {
    const calls = serverAnswers(204, null);
    await expect(deletePasskey('session-token', 'p 1/x')).resolves.toEqual({ ok: true, value: null });
    // The id goes in the path, so it is escaped there and nowhere else.
    expect(calls[0].url).toBe(`${API}/auth/v1/passkeys/p%201%2Fx`);
    expect(calls[0].init?.method).toBe('DELETE');
  });

  it('reads an unreachable server as a network failure, not as an empty list', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await expect(listPasskeys('t')).resolves.toEqual({ ok: false, failure: 'network' });
  });

  it('asks nothing at all when the API is not configured', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', '');
    const calls = serverAnswers(200, []);
    await expect(listPasskeys('t')).resolves.toEqual({ ok: false, failure: 'network' });
    expect(calls).toHaveLength(0);
  });
});
