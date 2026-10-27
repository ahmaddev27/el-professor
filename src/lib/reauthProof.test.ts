import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { proveWithPasskey, proveWithPassword, type PasswordCapableClient } from './reauthProof';
import { PASSWORD_PROOF_MAX_AGE_SECONDS, REAUTH_PROOF_METHODS } from '../../supabase/functions/_shared/otp-core';

/**
 * The re-authentication proof: two methods, one shape.
 *
 * What is pinned here is that a passkey produces the proof **the same way** a
 * password does — a token, from a session minted now — and that the browser
 * decides nothing about its age. The window and the method list are the
 * server's, and the two assertions at the bottom import them from the function
 * that enforces them rather than restating the numbers, so a change there fails
 * here instead of drifting.
 */

const API = 'https://api.example.test';

function passwordClient(session: { access_token: string } | null, error: unknown = null): PasswordCapableClient {
  return { auth: { signInWithPassword: async () => ({ data: { session }, error }) } };
}

/** The passkey half, as two routes and an authenticator that always consents. */
function passkeyServer(resolvesTo: string): string[] {
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    urls.push(url);
    if (url.endsWith('/options')) {
      return new Response(JSON.stringify({ challenge_id: 'c-1', options: { challenge: 'AQ' } }), { status: 200 });
    }
    if (url.endsWith('/verify')) {
      return new Response(JSON.stringify({
        access_token: 'passkey-access',
        refresh_token: 'passkey-refresh',
        user: { id: resolvesTo },
      }), { status: 200 });
    }
    return new Response(null, { status: 204 });
  }));
  return urls;
}

const authenticator = {
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
  create: async () => null,
};

const noopClient = { auth: { setSession: async () => ({ error: null }) } };

beforeEach(() => {
  vi.stubEnv('VITE_SUPABASE_URL', `${API}/`);
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('proveWithPassword', () => {
  it('spends the password on a sign-in and hands back that session s token', async () => {
    await expect(proveWithPassword('a@b.test', 'secret', passwordClient({ access_token: 'pw-access' })))
      .resolves.toEqual({ ok: true, accessToken: 'pw-access' });
  });

  it('reports one wrong-password message for every failure', async () => {
    // One message and not several: the person has just typed their own password
    // into their own account, so "that was not it" is the whole of what a
    // distinction could say.
    for (const client of [
      passwordClient(null, { message: 'Invalid login credentials' }),
      passwordClient(null),
      passwordClient({ access_token: 'x' }, { message: 'boom' }),
    ]) {
      await expect(proveWithPassword('a@b.test', 'wrong', client))
        .resolves.toEqual({ ok: false, messageKey: 'account.error.pwCurrentWrong' });
    }
  });
});

describe('proveWithPasskey', () => {
  it('produces the same shape of proof from a fresh assertion', async () => {
    passkeyServer('user-1');
    await expect(proveWithPasskey('user-1', { credentials: authenticator, client: noopClient }))
      .resolves.toEqual({ ok: true, accessToken: 'passkey-access' });
  });

  it('refuses a passkey belonging to another account, in words the screen can show', async () => {
    passkeyServer('colleague');
    await expect(proveWithPasskey('user-1', { credentials: authenticator, client: noopClient }))
      .resolves.toEqual({ ok: false, messageKey: 'passkey.error.wrongAccount' });
  });

  it('carries the ceremony s own refusal through rather than inventing one', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (
      url.endsWith('/options')
        ? new Response(JSON.stringify({ challenge_id: 'c-1', options: { challenge: 'AQ' } }), { status: 200 })
        : new Response(JSON.stringify({ error_code: 'webauthn_challenge_expired' }), { status: 400 })
    )));
    await expect(proveWithPasskey('user-1', { credentials: authenticator, client: noopClient }))
      .resolves.toEqual({ ok: false, messageKey: 'passkey.error.challengeExpired' });
  });
});

describe('the two methods are interchangeable, and the window is not ours', () => {
  it('both produce a bare access token and nothing about its age', async () => {
    passkeyServer('user-1');
    const byPasskey = await proveWithPasskey('user-1', { credentials: authenticator, client: noopClient });
    const byPassword = await proveWithPassword('a@b.test', 'secret', passwordClient({ access_token: 'pw' }));

    // Same keys, so a caller cannot tell which method produced the proof — and
    // neither carries an expiry, because the age lives in the token's own `amr`
    // claim and is read by the server.
    expect(Object.keys(byPasskey).sort()).toEqual(['accessToken', 'ok']);
    expect(Object.keys(byPassword).sort()).toEqual(['accessToken', 'ok']);
  });

  it('is enforced against the server s own constants, not a copy of them', async () => {
    // Imported from the module `otp-request` and `POST /platform-staff/email-change`
    // actually enforce. If the window moves or a method is dropped there, this
    // fails rather than the browser quietly offering a proof the server refuses.
    expect(PASSWORD_PROOF_MAX_AGE_SECONDS).toBe(600);
    expect([...REAUTH_PROOF_METHODS]).toEqual(['password', 'passkey']);
  });
});
