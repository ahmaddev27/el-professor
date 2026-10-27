import {
  decodeCreationOptions,
  decodeRequestOptions,
  deletePasskey,
  listPasskeys,
  passkeyCeremonyFailure,
  passkeysUsable,
  requestAuthenticationChallenge,
  requestRegistrationChallenge,
  serializeCredential,
  verifyAuthentication,
  verifyRegistration,
  type PasskeyRecord,
  type PasskeyResult,
  type PasskeySession,
  type RawCredential,
  type SessionCapableClient,
} from './passkeyClient';

/**
 * The three passkey ceremonies, each as one call.
 *
 * `passkeyClient.ts` is the wire; this is the order the two halves of a
 * ceremony happen in — ask for a challenge, hand it to the authenticator, send
 * what comes back — plus the two rules that are not GoTrue's and have to be
 * ours:
 *
 *  1. **The account that came back is checked.** Authentication is
 *     discoverable, so the authenticator decides which credential to offer and
 *     the server resolves whatever account it belongs to. On a shared machine
 *     that can be a colleague's account. For a *sign-in* that is correct and is
 *     the whole point. For a *re-authentication*, where the caller already has
 *     an account in hand and is about to act on it, a token for a different
 *     account is not a proof of anything — so `expectedUserId` is compared and
 *     a mismatch is `wrongAccount`.
 *
 *  2. **A session minted for the wrong account is revoked, not abandoned.** The
 *     assertion has already been verified by then and the session exists
 *     server-side; dropping the token on the floor would leave a live refresh
 *     token that no browser remembers and no sign-out can reach. So the
 *     mismatch path spends the token once more, on `POST /auth/v1/logout`,
 *     before reporting. Best effort: a failure there changes the answer not at
 *     all, because the alternative is reporting success.
 *
 * The WebAuthn API is injected rather than reached for, so every branch above
 * is exercised in Node against a fake authenticator. A real
 * `PublicKeyCredential` cannot be constructed outside a browser, which is
 * exactly why the encoder and these rules would otherwise be untested.
 */

/** The `navigator.credentials` surface used here, narrowed so a test can pass a fake. */
export interface CredentialsApi {
  get: (options: { publicKey: PublicKeyCredentialRequestOptions }) => Promise<unknown>;
  create: (options: { publicKey: PublicKeyCredentialCreationOptions }) => Promise<unknown>;
}

function browserCredentials(): CredentialsApi | null {
  if (!passkeysUsable()) return null;
  return navigator.credentials as unknown as CredentialsApi;
}

const isRawCredential = (value: unknown): value is RawCredential =>
  typeof value === 'object' && value !== null
  && typeof (value as RawCredential).id === 'string'
  && typeof (value as RawCredential).response === 'object'
  && (value as RawCredential).response !== null;

export interface PasskeyCeremonyOptions {
  /** Injected by the tests; the browser's own API otherwise. */
  credentials?: CredentialsApi;
  /** Injected by the tests; the app's client otherwise. */
  client?: SessionCapableClient;
}

async function appClient(given?: SessionCapableClient): Promise<SessionCapableClient> {
  if (given) return given;
  const module = await import('./supabase');
  return module.supabase as unknown as SessionCapableClient;
}

/** Spends the token on a sign-out, so a session nobody will use cannot outlive the attempt. */
async function revoke(accessToken: string): Promise<void> {
  const base = String(import.meta.env.VITE_SUPABASE_URL ?? '').replace(/\/+$/, '');
  if (!base) return;
  try {
    await fetch(`${base}/auth/v1/logout?scope=local`, {
      method: 'POST',
      headers: {
        apikey: String(import.meta.env.VITE_SUPABASE_ANON_KEY ?? ''),
        Authorization: `Bearer ${accessToken}`,
      },
    });
  } catch {
    // See the header: the caller is reporting a refusal either way.
  }
}

/**
 * One authentication ceremony: challenge, assertion, verify.
 *
 * Returns the session without installing it. `expectedUserId` is the account the
 * caller is acting on, or null for a sign-in, where any account is the answer.
 */
export async function runPasskeyAuthentication(
  expectedUserId: string | null,
  options: PasskeyCeremonyOptions = {},
): Promise<PasskeyResult<PasskeySession>> {
  const credentials = options.credentials ?? browserCredentials();
  if (!credentials) return { ok: false, failure: 'unsupported' };

  const challenge = await requestAuthenticationChallenge();
  if (!challenge.ok) return challenge;

  let assertion: unknown;
  try {
    assertion = await credentials.get({ publicKey: decodeRequestOptions(challenge.value.options) });
  } catch (error) {
    return { ok: false, failure: passkeyCeremonyFailure(error) };
  }
  if (!isRawCredential(assertion)) return { ok: false, failure: 'cancelled' };

  let body: Record<string, unknown>;
  try {
    body = serializeCredential(assertion);
  } catch {
    return { ok: false, failure: 'generic' };
  }

  const verified = await verifyAuthentication(challenge.value.challengeId, body);
  if (!verified.ok) return verified;

  if (expectedUserId !== null && verified.value.userId !== expectedUserId) {
    await revoke(verified.value.accessToken);
    return { ok: false, failure: 'wrongAccount' };
  }
  return verified;
}

/**
 * Signing in with a passkey: the ceremony, then the session installed.
 *
 * Installing it is all the routing this needs. `AuthContext`'s
 * `onAuthStateChange` listener records the activity, starts the inactivity
 * timer and loads the profile, and `SignInRoute` in App.tsx then sends the
 * session where it belongs — `/admin` for a platform account, `/overview` or the
 * remembered panel path otherwise. A `navigate()` here would be the bug plan
 * 3.6a's note warns about: the public router is unmounted by the very session
 * being installed.
 *
 * Two things a reader should not expect to find here. There is no Google-style
 * refusal for platform staff: the owner's decision of 27.10.2026 is that a
 * passkey counts as a password does, for platform accounts as for company ones,
 * and `20261027140000` admits `passkey` in the database's own allow-list. And
 * there is no intent marker: a passkey ceremony never leaves the page, so
 * nothing has to be remembered across a redirect.
 */
export async function authenticateWithPasskey(
  expectedUserId: string | null,
  options: PasskeyCeremonyOptions = {},
): Promise<PasskeyResult<PasskeySession>> {
  const result = await runPasskeyAuthentication(expectedUserId, options);
  if (!result.ok) return result;

  const client = await appClient(options.client);
  const { error } = await client.auth.setSession({
    access_token: result.value.accessToken,
    refresh_token: result.value.refreshToken,
  });
  if (error) return { ok: false, failure: 'generic' };
  return result;
}

/** The sign-in case: no account in hand, so whichever passkey is offered decides. */
export async function signInWithPasskey(
  options: PasskeyCeremonyOptions = {},
): Promise<PasskeyResult<PasskeySession>> {
  return authenticateWithPasskey(null, options);
}

/**
 * Enrolling a passkey on the account the given token belongs to.
 *
 * The token is the authorization, and which token it is matters: `AccountPage`
 * hands this one it has just minted from a password or a passkey, so adding a
 * credential takes a re-authentication even though GoTrue's route asks only for
 * a session. See `reauthProof.ts` for why that is not belt-and-braces.
 */
export async function enrollPasskey(
  accessToken: string,
  options: PasskeyCeremonyOptions = {},
): Promise<PasskeyResult<null>> {
  const credentials = options.credentials ?? browserCredentials();
  if (!credentials) return { ok: false, failure: 'unsupported' };

  const challenge = await requestRegistrationChallenge(accessToken);
  if (!challenge.ok) return challenge;

  let created: unknown;
  try {
    created = await credentials.create({ publicKey: decodeCreationOptions(challenge.value.options) });
  } catch (error) {
    return { ok: false, failure: passkeyCeremonyFailure(error) };
  }
  if (!isRawCredential(created)) return { ok: false, failure: 'cancelled' };

  let body: Record<string, unknown>;
  try {
    body = serializeCredential(created);
  } catch {
    return { ok: false, failure: 'generic' };
  }

  return verifyRegistration(accessToken, challenge.value.challengeId, body);
}

/** Re-exported so a screen imports one module for the whole feature. */
export { deletePasskey, listPasskeys };
export type { PasskeyRecord, PasskeyResult, PasskeySession };
