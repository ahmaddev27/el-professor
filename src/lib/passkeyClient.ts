import type { TranslationKey } from '../i18n';

/**
 * Passkeys (WebAuthn), the browser half.
 *
 * This is the one network seam for GoTrue's `/auth/v1/passkeys/*` routes and the
 * one place a WebAuthn credential is encoded or decoded. Nothing here decides
 * whether passkeys are on: that is `lib/authProviderSettings`, and every screen
 * asks it first — `GET /auth/v1/settings` reports `passkeys_enabled` from
 * v2.188.0 onward, and on an older GoTrue the key is simply absent, which reads
 * as off. So this module is unreachable on today's server, exactly as
 * `googleSignIn.ts` was unreachable while `GOOGLE_SIGNIN_ENABLED` was false.
 *
 * ## Why these are raw `fetch` calls and not supabase-js
 *
 * `@supabase/auth-js` 2.98.0 — the version this project pins — has no passkey
 * method of any kind (no `signInWithPasskey`, no `passkeys` namespace, the
 * string does not occur in the package). The routes exist on the server and the
 * client library has not caught up, so the choice is a `fetch` against a
 * documented route or nothing at all. `authProviderSettings.ts` already reads
 * `/auth/v1/settings` the same way, so this is the established shape here.
 *
 * ## The wire shapes, read from GoTrue's own source at v2.190.0
 *
 * `deploy.sh` sets `PASSKEY_MIN_GOTRUE=2.190.0` and says why: v2.189.0 changed
 * the passkey request and response shapes, so code written against v2.188.x
 * breaks. Everything below is taken from the handlers at the pinned tag —
 * `internal/api/passkey_authentication.go`, `passkey_registration.go`,
 * `passkey_manage.go` and the route table in `api.go` — not from a blog post:
 *
 *   POST /passkeys/authentication/options  → {challenge_id, options, expires_at}
 *   POST /passkeys/authentication/verify   ← {challenge_id, credential} → a session
 *   POST /passkeys/registration/options    → {challenge_id, options, expires_at}   (bearer)
 *   POST /passkeys/registration/verify     ← {challenge_id, credential}            (bearer)
 *   GET  /passkeys                         → [{id, friendly_name?, created_at, last_used_at?}]
 *   DELETE /passkeys/{id}                  → 204
 *
 * `options` is the inner `publicKey` member — the handler sends
 * `&options.Response` — so it is passed straight to `navigator.credentials`
 * under `publicKey`, after its base64url fields are decoded to buffers.
 *
 * Authentication is **discoverable**: `BeginDiscoverableLogin()` sends an empty
 * `allowCredentials` and binds no user, so signing in needs no address typed
 * first — the authenticator offers the credentials it holds. That is why the
 * sign-in button takes no email, and it is also why the caller must check which
 * account came back; see `PASSKEY_WRONG_ACCOUNT` below.
 *
 * ## Nothing here is the boundary
 *
 * The server re-checks everything: the challenge is consumed atomically and
 * refused when expired or already used, the assertion is verified against the
 * challenge and the origin, the ten-passkey ceiling is enforced again inside the
 * creating transaction, and registration requires a bearer token. The codes this
 * module maps are for wording a message, never for granting anything.
 */

// ─── base64url ──────────────────────────────────────────────────────────────

/**
 * Bytes as unpadded base64url, which is what WebAuthn JSON uses and what
 * go-webauthn's `URLEncodedBase64` unmarshals.
 */
export function toBase64Url(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * base64url (or standard base64, padded or not) as bytes.
 *
 * Tolerant on the way in deliberately: the padding and alphabet a server sends
 * are its choice, and a strict reader here would turn one of them into a
 * sign-in that fails with no explanation. Throws on text that is not base64 at
 * all, which the callers treat as a malformed answer.
 */
export function fromBase64Url(text: string): Uint8Array {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ─── What the routes answer ─────────────────────────────────────────────────

/** One challenge and the options that go with it, as either options route answers. */
export interface PasskeyChallenge {
  challengeId: string;
  /** The inner `publicKey` member, still carrying base64url strings. */
  options: Record<string, unknown>;
}

/** One row of `GET /passkeys`. */
export interface PasskeyRecord {
  id: string;
  /** GoTrue derives one from the authenticator's AAGUID; it may be absent. */
  friendlyName: string | null;
  createdAt: string | null;
  lastUsedAt: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const textOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

/** A challenge body, or null for anything that is not a complete one. */
export function parsePasskeyChallenge(body: unknown): PasskeyChallenge | null {
  if (!isRecord(body)) return null;
  const { challenge_id: id, options } = body;
  if (typeof id !== 'string' || id === '' || !isRecord(options)) return null;
  return { challengeId: id, options };
}

/**
 * The passkey list, or null when the answer is not an array.
 *
 * Null and empty are kept apart on purpose: an empty list is the claim "this
 * account has no passkey", and a body that could not be read is not evidence
 * for it. The screen says so rather than drawing an empty list.
 */
export function parsePasskeyList(body: unknown): PasskeyRecord[] | null {
  if (!Array.isArray(body)) return null;
  const rows: PasskeyRecord[] = [];
  for (const entry of body) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || entry.id === '') continue;
    rows.push({
      id: entry.id,
      friendlyName: textOrNull(entry.friendly_name),
      createdAt: textOrNull(entry.created_at),
      lastUsedAt: textOrNull(entry.last_used_at),
    });
  }
  return rows;
}

// ─── Options in, credential out ─────────────────────────────────────────────

/** A credential descriptor as WebAuthn JSON carries it. */
interface JsonDescriptor {
  type?: unknown;
  id?: unknown;
  transports?: unknown;
}

function decodeDescriptors(value: unknown): PublicKeyCredentialDescriptor[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: PublicKeyCredentialDescriptor[] = [];
  for (const entry of value as JsonDescriptor[]) {
    if (!isRecord(entry) || typeof entry.id !== 'string') continue;
    out.push({
      type: 'public-key',
      id: fromBase64Url(entry.id) as unknown as BufferSource,
      ...(Array.isArray(entry.transports)
        ? { transports: entry.transports.filter((x): x is string => typeof x === 'string') as AuthenticatorTransport[] }
        : {}),
    });
  }
  return out;
}

/**
 * The authentication options as `navigator.credentials.get` wants them.
 *
 * Only the fields WebAuthn requires as buffers are converted; every other field
 * — `rpId`, `timeout`, `userVerification`, the extensions — is passed through
 * untouched, so a value GoTrue starts sending is honoured without a change
 * here. Throws when `challenge` is missing or unreadable, which is a malformed
 * answer rather than a user-visible condition.
 */
export function decodeRequestOptions(options: Record<string, unknown>): PublicKeyCredentialRequestOptions {
  const { challenge, allowCredentials, ...rest } = options;
  if (typeof challenge !== 'string') throw new Error('passkey options carry no challenge');
  const allow = decodeDescriptors(allowCredentials);
  return {
    ...(rest as Omit<PublicKeyCredentialRequestOptions, 'challenge' | 'allowCredentials'>),
    challenge: fromBase64Url(challenge) as unknown as BufferSource,
    ...(allow ? { allowCredentials: allow } : {}),
  };
}

/** The registration options as `navigator.credentials.create` wants them. */
export function decodeCreationOptions(options: Record<string, unknown>): PublicKeyCredentialCreationOptions {
  const { challenge, user, excludeCredentials, ...rest } = options;
  if (typeof challenge !== 'string') throw new Error('passkey options carry no challenge');
  if (!isRecord(user) || typeof user.id !== 'string') throw new Error('passkey options carry no user id');
  const exclude = decodeDescriptors(excludeCredentials);
  return {
    ...(rest as Omit<PublicKeyCredentialCreationOptions, 'challenge' | 'user' | 'excludeCredentials'>),
    challenge: fromBase64Url(challenge) as unknown as BufferSource,
    user: {
      ...(user as unknown as PublicKeyCredentialUserEntity),
      id: fromBase64Url(user.id) as unknown as BufferSource,
    },
    ...(exclude ? { excludeCredentials: exclude } : {}),
  };
}

/**
 * The parts of a `PublicKeyCredential` this module reads, as a structural type.
 *
 * Structural rather than the DOM's own, so the encoder can be exercised in Node
 * with plain objects: a `PublicKeyCredential` cannot be constructed outside a
 * browser, and an encoder that only runs behind a real authenticator is an
 * encoder nothing checks.
 */
export interface RawCredential {
  id: string;
  rawId: ArrayBuffer | Uint8Array;
  type: string;
  authenticatorAttachment?: string | null;
  getClientExtensionResults?: () => Record<string, unknown>;
  response: Record<string, unknown>;
}

/**
 * A credential as the verify routes want it.
 *
 * `PublicKeyCredential.toJSON()` would do this, but it landed in browsers only
 * recently (Chrome 126, Safari 17.4, Firefox 119) and this product supports the
 * phones its drivers carry, so the shape is written out by hand. The members are
 * the ones go-webauthn's `CredentialAssertionResponse` and
 * `CredentialCreationResponse` unmarshal.
 *
 * The assertion and attestation halves are told apart by what the response
 * actually carries, not by a flag the caller passes: `signature` marks an
 * assertion, `attestationObject` an attestation. A caller that mixed the two up
 * would otherwise send a well-formed body the server rejects as unverifiable.
 */
export function serializeCredential(credential: RawCredential): Record<string, unknown> {
  const response = credential.response;
  const buffer = (key: string): ArrayBuffer | Uint8Array | null => {
    const value = response[key];
    return value instanceof ArrayBuffer || value instanceof Uint8Array ? value : null;
  };

  const clientDataJSON = buffer('clientDataJSON');
  if (!clientDataJSON) throw new Error('credential response carries no clientDataJSON');

  const base: Record<string, unknown> = {
    id: credential.id,
    rawId: toBase64Url(credential.rawId),
    type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults?.() ?? {},
  };
  if (credential.authenticatorAttachment) {
    base.authenticatorAttachment = credential.authenticatorAttachment;
  }

  const attestationObject = buffer('attestationObject');
  if (attestationObject) {
    return {
      ...base,
      response: {
        clientDataJSON: toBase64Url(clientDataJSON),
        attestationObject: toBase64Url(attestationObject),
      },
    };
  }

  const authenticatorData = buffer('authenticatorData');
  const signature = buffer('signature');
  if (!authenticatorData || !signature) {
    throw new Error('credential response is neither an assertion nor an attestation');
  }
  const userHandle = buffer('userHandle');
  return {
    ...base,
    response: {
      clientDataJSON: toBase64Url(clientDataJSON),
      authenticatorData: toBase64Url(authenticatorData),
      signature: toBase64Url(signature),
      // Omitted rather than null when the authenticator sends none: the
      // discoverable flow resolves the account from this, and an explicit null
      // is not the same thing as an absent member to a strict reader.
      ...(userHandle ? { userHandle: toBase64Url(userHandle) } : {}),
    },
  };
}

// ─── Failures ───────────────────────────────────────────────────────────────

/**
 * Every way a passkey ceremony ends other than success.
 *
 * `wrongAccount` is ours rather than GoTrue's, and it is the one that is easy to
 * leave out. A discoverable assertion resolves whichever account the chosen
 * credential belongs to, so on a shared machine the authenticator may hand back
 * a *colleague's* account — and a proof produced that way would re-authenticate
 * the wrong person. The caller compares the account before using the token; see
 * `reauthProof.ts`.
 */
export type PasskeyFailure =
  | 'unsupported'
  | 'cancelled'
  | 'disabled'
  | 'tooMany'
  | 'alreadyRegistered'
  | 'challengeExpired'
  | 'verificationFailed'
  | 'noCredential'
  | 'wrongAccount'
  | 'rateLimited'
  | 'network'
  | 'generic';

/** GoTrue's `error_code` strings, from `internal/api/apierrors/errorcode.go` at v2.190.0. */
const CODE_FAILURES: Record<string, PasskeyFailure> = {
  passkey_disabled: 'disabled',
  too_many_passkeys: 'tooMany',
  webauthn_credential_exists: 'alreadyRegistered',
  webauthn_challenge_expired: 'challengeExpired',
  webauthn_challenge_not_found: 'challengeExpired',
  webauthn_verification_failed: 'verificationFailed',
  webauthn_credential_not_found: 'noCredential',
  insufficient_aal: 'generic',
};

/**
 * What a refused HTTP answer means.
 *
 * A 404 reads as `disabled`, not as a bug: `requirePasskeyEnabled` wraps the
 * whole route group, so every passkey path is a 404 on a GoTrue that has the
 * feature switched off — and on one too old to have it at all. That is the same
 * answer for the same reason, and it is the one a user can act on.
 */
export function passkeyHttpFailure(status: number, body: unknown): PasskeyFailure {
  const code = isRecord(body) ? body.error_code : undefined;
  if (typeof code === 'string' && code in CODE_FAILURES) return CODE_FAILURES[code];
  if (status === 404) return 'disabled';
  if (status === 429) return 'rateLimited';
  if (status === 401 || status === 403) return 'generic';
  return 'generic';
}

/**
 * What a thrown `navigator.credentials` rejection means.
 *
 * `NotAllowedError` is the one that matters and the one that is routinely
 * mis-worded: the browser raises it both when the person dismisses the prompt
 * and when it times out, and it deliberately does not say which — telling them
 * apart would leak whether a credential existed. So it is reported as
 * "cancelled" and never as a failure, because the common case by far is someone
 * closing the sheet.
 */
export function passkeyCeremonyFailure(error: unknown): PasskeyFailure {
  const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : '';
  if (name === 'NotAllowedError' || name === 'AbortError') return 'cancelled';
  if (name === 'InvalidStateError') return 'alreadyRegistered';
  if (name === 'NotSupportedError' || name === 'SecurityError') return 'unsupported';
  return 'generic';
}

const FAILURE_KEYS: Record<PasskeyFailure, TranslationKey> = {
  unsupported: 'passkey.error.unsupported',
  cancelled: 'passkey.error.cancelled',
  disabled: 'passkey.error.disabled',
  tooMany: 'passkey.error.tooMany',
  alreadyRegistered: 'passkey.error.alreadyRegistered',
  challengeExpired: 'passkey.error.challengeExpired',
  verificationFailed: 'passkey.error.verificationFailed',
  noCredential: 'passkey.error.noCredential',
  wrongAccount: 'passkey.error.wrongAccount',
  rateLimited: 'passkey.error.rateLimited',
  network: 'passkey.error.network',
  generic: 'passkey.error.generic',
};

export function passkeyMessageKey(failure: PasskeyFailure): TranslationKey {
  return FAILURE_KEYS[failure];
}

// ─── Is there an authenticator to ask? ──────────────────────────────────────

/**
 * Whether this browser can run a WebAuthn ceremony at all.
 *
 * A plain capability test and not a promise: `isConditionalMediationAvailable`
 * and friends are themselves not everywhere, and a button that waits on a
 * feature probe to decide whether to draw itself is a button that flickers.
 */
export function passkeysUsable(): boolean {
  return typeof window !== 'undefined'
    && typeof window.PublicKeyCredential !== 'undefined'
    && typeof navigator !== 'undefined'
    && typeof navigator.credentials?.get === 'function';
}

// ─── The routes ─────────────────────────────────────────────────────────────

export type PasskeyResult<T> = { ok: true; value: T } | { ok: false; failure: PasskeyFailure };

const anonKey = (): string => String(import.meta.env.VITE_SUPABASE_ANON_KEY ?? '');

const authBase = (): string =>
  `${String(import.meta.env.VITE_SUPABASE_URL ?? '').replace(/\/+$/, '')}/auth/v1`;

/** The supabase-js surface this module needs, narrowed so a test can pass a fake. */
export interface SessionCapableClient {
  auth: {
    setSession: (tokens: { access_token: string; refresh_token: string }) => PromiseLike<{ error: unknown }>;
  };
}

/**
 * One call to a passkey route.
 *
 * `accessToken` is the bearer. For the public authentication routes that is the
 * anon key, which is what every unauthenticated call in this app sends; for the
 * authenticated ones it is a session token, and which session it is matters —
 * `reauthProof.ts` hands the registration routes a token it has just minted.
 */
async function call(
  method: string,
  path: string,
  accessToken: string,
  body?: unknown,
): Promise<PasskeyResult<unknown>> {
  const base = authBase();
  if (base === '/auth/v1') return { ok: false, failure: 'network' };
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method,
      headers: {
        apikey: anonKey(),
        Authorization: `Bearer ${accessToken}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    return { ok: false, failure: 'network' };
  }

  if (response.status === 204) return { ok: true, value: null };

  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  if (!response.ok) return { ok: false, failure: passkeyHttpFailure(response.status, parsed) };
  return { ok: true, value: parsed };
}

function challengeFrom(result: PasskeyResult<unknown>): PasskeyResult<PasskeyChallenge> {
  if (!result.ok) return result;
  const challenge = parsePasskeyChallenge(result.value);
  return challenge ? { ok: true, value: challenge } : { ok: false, failure: 'generic' };
}

/** `POST /passkeys/authentication/options`. Public: no session needed. */
export async function requestAuthenticationChallenge(): Promise<PasskeyResult<PasskeyChallenge>> {
  return challengeFrom(await call('POST', '/passkeys/authentication/options', anonKey(), {}));
}

/** What a verified assertion yields: a brand-new session for the resolved account. */
export interface PasskeySession {
  accessToken: string;
  refreshToken: string;
  userId: string;
}

/**
 * `POST /passkeys/authentication/verify`.
 *
 * The answer is GoTrue's ordinary `AccessTokenResponse`, so `user.id` names the
 * account the assertion resolved to — the only thing that says *whose* passkey
 * was offered, and what the caller must check before trusting the token.
 */
export async function verifyAuthentication(
  challengeId: string,
  credential: Record<string, unknown>,
): Promise<PasskeyResult<PasskeySession>> {
  const result = await call('POST', '/passkeys/authentication/verify', anonKey(), {
    challenge_id: challengeId,
    credential,
  });
  if (!result.ok) return result;
  const body = result.value;
  if (!isRecord(body)) return { ok: false, failure: 'generic' };
  const { access_token: access, refresh_token: refresh, user } = body;
  if (typeof access !== 'string' || typeof refresh !== 'string') return { ok: false, failure: 'generic' };
  if (!isRecord(user) || typeof user.id !== 'string') return { ok: false, failure: 'generic' };
  return { ok: true, value: { accessToken: access, refreshToken: refresh, userId: user.id } };
}

/** `POST /passkeys/registration/options`, on the bearer the caller supplies. */
export async function requestRegistrationChallenge(accessToken: string): Promise<PasskeyResult<PasskeyChallenge>> {
  return challengeFrom(await call('POST', '/passkeys/registration/options', accessToken, {}));
}

/** `POST /passkeys/registration/verify`, on the bearer the caller supplies. */
export async function verifyRegistration(
  accessToken: string,
  challengeId: string,
  credential: Record<string, unknown>,
): Promise<PasskeyResult<null>> {
  const result = await call('POST', '/passkeys/registration/verify', accessToken, {
    challenge_id: challengeId,
    credential,
  });
  return result.ok ? { ok: true, value: null } : result;
}

/** `GET /passkeys`. A body that cannot be read is a failure, never an empty list. */
export async function listPasskeys(accessToken: string): Promise<PasskeyResult<PasskeyRecord[]>> {
  const result = await call('GET', '/passkeys', accessToken);
  if (!result.ok) return result;
  const rows = parsePasskeyList(result.value);
  return rows ? { ok: true, value: rows } : { ok: false, failure: 'generic' };
}

/** `DELETE /passkeys/{id}`. */
export async function deletePasskey(accessToken: string, passkeyId: string): Promise<PasskeyResult<null>> {
  const result = await call('DELETE', `/passkeys/${encodeURIComponent(passkeyId)}`, accessToken);
  return result.ok ? { ok: true, value: null } : result;
}
