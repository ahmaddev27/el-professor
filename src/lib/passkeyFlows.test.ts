import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  authenticateWithPasskey,
  enrollPasskey,
  runPasskeyAuthentication,
  signInWithPasskey,
  type CredentialsApi,
} from './passkeyFlows';

/**
 * The ceremonies, run against a fake authenticator.
 *
 * What is worth checking here is not the happy path — the server verifies the
 * assertion and this module only carries it — but the two rules that are ours
 * and that no server will enforce for us: the account the assertion resolved to
 * is compared, and a session minted for the wrong one is revoked rather than
 * left live.
 */

const API = 'https://api.example.test';

type Call = { url: string; method: string; bearer: string; body: unknown };

interface ServerOptions {
  /** Which account every assertion resolves to. */
  resolvesTo?: string;
  /** Status for the verify route, when it must refuse. */
  verifyStatus?: number;
  verifyBody?: unknown;
  /** Status for the registration verify route. */
  registerStatus?: number;
  registerBody?: unknown;
}

function server(options: ServerOptions = {}): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({
      url,
      method: init?.method ?? 'GET',
      bearer: String(headers.Authorization ?? '').replace(/^Bearer /, ''),
      body,
    });

    if (url.endsWith('/passkeys/authentication/options') || url.endsWith('/passkeys/registration/options')) {
      return new Response(JSON.stringify({
        challenge_id: 'challenge-1',
        options: { challenge: 'AQ', rpId: 'example.test', user: { id: 'Ag', name: 'a@b.test', displayName: 'A' } },
        expires_at: 1,
      }), { status: 200 });
    }
    if (url.endsWith('/passkeys/authentication/verify')) {
      if (options.verifyStatus && options.verifyStatus !== 200) {
        return new Response(JSON.stringify(options.verifyBody ?? {}), { status: options.verifyStatus });
      }
      return new Response(JSON.stringify({
        access_token: 'minted-access',
        refresh_token: 'minted-refresh',
        user: { id: options.resolvesTo ?? 'user-1' },
      }), { status: 200 });
    }
    if (url.endsWith('/passkeys/registration/verify')) {
      return options.registerStatus && options.registerStatus !== 200
        ? new Response(JSON.stringify(options.registerBody ?? {}), { status: options.registerStatus })
        : new Response(JSON.stringify({ id: 'p-new', created_at: '2026-10-27T10:00:00Z' }), { status: 200 });
    }
    if (url.includes('/auth/v1/logout')) return new Response(null, { status: 204 });
    return new Response('unexpected route', { status: 500 });
  }));
  return calls;
}

/** An authenticator that always consents, returning a well-formed assertion. */
function authenticator(overrides: Partial<CredentialsApi> = {}): CredentialsApi {
  return {
    get: async () => ({
      id: 'cred-1',
      rawId: new Uint8Array([1]),
      type: 'public-key',
      response: {
        clientDataJSON: new Uint8Array([2]),
        authenticatorData: new Uint8Array([3]),
        signature: new Uint8Array([4]),
        userHandle: new Uint8Array([5]),
      },
    }),
    create: async () => ({
      id: 'cred-new',
      rawId: new Uint8Array([9]),
      type: 'public-key',
      response: { clientDataJSON: new Uint8Array([2]), attestationObject: new Uint8Array([8]) },
    }),
    ...overrides,
  };
}

function sessionClient() {
  const installed: Array<{ access_token: string; refresh_token: string }> = [];
  return {
    installed,
    client: {
      auth: {
        setSession: async (tokens: { access_token: string; refresh_token: string }) => {
          installed.push(tokens);
          return { error: null };
        },
      },
    },
  };
}

beforeEach(() => {
  vi.stubEnv('VITE_SUPABASE_URL', `${API}/`);
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('runPasskeyAuthentication', () => {
  it('asks for a challenge, hands it over and sends back what was signed', async () => {
    const calls = server({ resolvesTo: 'user-1' });

    await expect(runPasskeyAuthentication(null, { credentials: authenticator() })).resolves.toEqual({
      ok: true,
      value: { accessToken: 'minted-access', refreshToken: 'minted-refresh', userId: 'user-1' },
    });

    expect(calls.map(c => c.url)).toEqual([
      `${API}/auth/v1/passkeys/authentication/options`,
      `${API}/auth/v1/passkeys/authentication/verify`,
    ]);
    // The options route is public, so it carries the publishable key and no session.
    expect(calls[0].bearer).toBe('anon-key');
    expect(calls[1].body).toMatchObject({ challenge_id: 'challenge-1' });
  });

  it('accepts whichever account a sign-in resolves to', async () => {
    server({ resolvesTo: 'somebody-else' });
    const result = await runPasskeyAuthentication(null, { credentials: authenticator() });
    expect(result).toMatchObject({ ok: true, value: { userId: 'somebody-else' } });
  });

  it('refuses an account that is not the one being acted on, and revokes the session it minted', async () => {
    // The rule no server enforces for us. A discoverable assertion resolves
    // whichever credential the authenticator offered, so on a shared machine
    // this comes back as a colleague's account — and a token for that account
    // is not a proof about this one.
    const calls = server({ resolvesTo: 'colleague' });

    await expect(runPasskeyAuthentication('user-1', { credentials: authenticator() }))
      .resolves.toEqual({ ok: false, failure: 'wrongAccount' });

    const logout = calls.find(c => c.url.includes('/auth/v1/logout'));
    expect(logout).toBeDefined();
    // Spent with the token it is revoking, or it would revoke nothing.
    expect(logout!.bearer).toBe('minted-access');
  });

  it('reads a dismissed prompt as cancelled and never reaches the verify route', async () => {
    const calls = server();
    const refuse = authenticator({
      get: async () => { throw Object.assign(new Error('no'), { name: 'NotAllowedError' }); },
    });

    await expect(runPasskeyAuthentication(null, { credentials: refuse }))
      .resolves.toEqual({ ok: false, failure: 'cancelled' });
    expect(calls.map(c => c.url)).toEqual([`${API}/auth/v1/passkeys/authentication/options`]);
  });

  it('reads a credential the authenticator did not return as cancelled', async () => {
    server();
    const nothing = authenticator({ get: async () => null });
    await expect(runPasskeyAuthentication(null, { credentials: nothing }))
      .resolves.toEqual({ ok: false, failure: 'cancelled' });
  });

  it('is unsupported where there is no authenticator to ask', async () => {
    const calls = server();
    // No `credentials` injected and no browser globals: the ceremony must not
    // even ask the server for a challenge.
    await expect(runPasskeyAuthentication(null)).resolves.toEqual({ ok: false, failure: 'unsupported' });
    expect(calls).toHaveLength(0);
  });

  it('passes the server s own refusal through', async () => {
    server({ verifyStatus: 400, verifyBody: { error_code: 'webauthn_verification_failed' } });
    await expect(runPasskeyAuthentication(null, { credentials: authenticator() }))
      .resolves.toEqual({ ok: false, failure: 'verificationFailed' });
  });
});

describe('signInWithPasskey', () => {
  it('installs the minted session and nothing else', async () => {
    server({ resolvesTo: 'user-7' });
    const { client, installed } = sessionClient();

    const result = await signInWithPasskey({ credentials: authenticator(), client });

    expect(result).toMatchObject({ ok: true, value: { userId: 'user-7' } });
    // Installing it is the whole of the routing: AuthContext's listener and
    // SignInRoute take it from here, so a navigate() here would be the bug.
    expect(installed).toEqual([{ access_token: 'minted-access', refresh_token: 'minted-refresh' }]);
  });

  it('installs nothing when the ceremony was refused', async () => {
    server({ verifyStatus: 404, verifyBody: null });
    const { client, installed } = sessionClient();

    await expect(signInWithPasskey({ credentials: authenticator(), client }))
      .resolves.toEqual({ ok: false, failure: 'disabled' });
    expect(installed).toEqual([]);
  });
});

describe('authenticateWithPasskey', () => {
  it('installs nothing for the wrong account', async () => {
    server({ resolvesTo: 'colleague' });
    const { client, installed } = sessionClient();

    await expect(authenticateWithPasskey('user-1', { credentials: authenticator(), client }))
      .resolves.toEqual({ ok: false, failure: 'wrongAccount' });
    expect(installed).toEqual([]);
  });
});

describe('enrollPasskey', () => {
  it('registers on the bearer it was given, not on the ambient session', async () => {
    // The proof is load-bearing: both registration calls are made with the
    // token AccountPage has just minted from a password or a passkey, so the
    // credential is created on a session that is seconds old.
    const calls = server();

    await expect(enrollPasskey('proof-token', { credentials: authenticator() }))
      .resolves.toEqual({ ok: true, value: null });

    expect(calls.map(c => c.url)).toEqual([
      `${API}/auth/v1/passkeys/registration/options`,
      `${API}/auth/v1/passkeys/registration/verify`,
    ]);
    expect(calls.map(c => c.bearer)).toEqual(['proof-token', 'proof-token']);
  });

  it('sends the attestation, not an assertion', async () => {
    const calls = server();
    await enrollPasskey('proof-token', { credentials: authenticator() });

    const verify = calls[1].body as { credential: { response: Record<string, unknown> } };
    expect(verify.credential.response).toHaveProperty('attestationObject');
    expect(verify.credential.response).not.toHaveProperty('signature');
  });

  it('reports the ten-passkey ceiling in the server s own words', async () => {
    server({ registerStatus: 422, registerBody: { error_code: 'too_many_passkeys' } });
    await expect(enrollPasskey('proof-token', { credentials: authenticator() }))
      .resolves.toEqual({ ok: false, failure: 'tooMany' });
  });

  it('reads a credential this account already holds as such', async () => {
    server();
    const already = authenticator({
      create: async () => { throw Object.assign(new Error('no'), { name: 'InvalidStateError' }); },
    });
    await expect(enrollPasskey('proof-token', { credentials: already }))
      .resolves.toEqual({ ok: false, failure: 'alreadyRegistered' });
  });
});
