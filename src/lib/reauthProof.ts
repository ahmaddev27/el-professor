import type { TranslationKey } from '../i18n';
import { passkeyMessageKey } from './passkeyClient';
import { authenticateWithPasskey, type PasskeyCeremonyOptions } from './passkeyFlows';

/**
 * The re-authentication proof, and the one reason this slice exists.
 *
 * ## What the proof is, and what it is not
 *
 * Two sensitive changes on `/mein-konto` re-authenticate before they are
 * accepted, because an unattended signed-in browser must not be enough to take
 * an account over. For a **platform** account's email change that proof is also
 * the *only* control left: the owner's decision of 17.09.2026 removed the
 * one-time code — it was mailed to the *new* address, so it proved control of
 * that mailbox and nothing about the account — leaving a password sign-in
 * recorded in the session token's `amr` claim and no older than
 * `PASSWORD_PROOF_MAX_AGE_SECONDS` (600 s). `otp_request` enforces it for the
 * code path and `POST /platform-staff/email-change` for the direct one.
 *
 * **Nothing here is that check.** This module produces a token; the two servers
 * read the `amr` claim out of it and decide. CLAUDE.md is explicit that the
 * direct route must not be "simplified" into a browser-side password check, and
 * this is not one: a token minted here carries a claim written by GoTrue, which
 * the browser cannot forge and does not interpret.
 *
 * ## How freshness travels, which is the question this slice had to answer
 *
 * It travels in the token's own `amr[].timestamp`, and in nothing else. No
 * expiry is tracked here, no clock is read, no window is re-stated. GoTrue sets
 * that timestamp from `mfa_amr_claims.updated_at` in the single
 * `AddClaimToSession` call inside `IssueRefreshToken` — **the same line, with no
 * method-specific branch, for `password` and `passkey` alike** — and the refresh
 * path never calls it, so a long-lived session keeps its original sign-in
 * timestamp and cannot satisfy the window indefinitely. That is already written
 * down and measured in `supabase/functions/_shared/otp-core.ts`, whose
 * `REAUTH_PROOF_METHODS` names exactly `['password', 'passkey']`.
 *
 * So a fresh passkey assertion produces the proof **the same way** a fresh
 * password sign-in does: both mint a new session, both get one `amr` entry
 * stamped now, both are read by the same server-side window. The 600 seconds
 * are untouched, and a passkey is not a second, weaker door — it is the method
 * the owner's decision of 27.10.2026 put beside the password, and that
 * `20261027140000` admits in the database's own allow-list.
 *
 * ## Why enrolment goes through here too
 *
 * GoTrue's `POST /passkeys/registration/*` asks only for a session (AAL2 only
 * when MFA is enabled, which nothing in this product uses). Taken as shipped,
 * that would make **adding a passkey the one sensitive change on this page that
 * an unattended browser can make** — and a passkey is a permanent sign-in
 * credential, so it is a quieter account takeover than changing the password,
 * which this page already refuses to do without a proof. Enrolment therefore
 * asks for the same proof, and the token this module returns is the bearer the
 * registration call is made with. It is load-bearing, not decoration: the
 * credential is created on a session minted seconds earlier by a password or a
 * passkey.
 *
 * Removal deliberately does **not** ask. Deleting a passkey destroys a
 * credential rather than creating one, every account in this product keeps its
 * password (see the recovery note on `PasskeyCard`), and an attacker holding the
 * session cannot convert a deletion into access — the half that would, adding
 * their own credential, is the half that is gated.
 */

export type ReauthProof =
  | { ok: true; accessToken: string }
  /** Already a dictionary key: the caller shows it and decides nothing. */
  | { ok: false; messageKey: TranslationKey };

/** The supabase-js surface the password path uses, narrowed so a test can pass a fake. */
export interface PasswordCapableClient {
  auth: {
    signInWithPassword: (credentials: { email: string; password: string }) => PromiseLike<{
      data: { session: { access_token: string } | null };
      error: unknown;
    }>;
  };
}

/**
 * The current password, spent on a sign-in against the *current* address.
 *
 * This is the behaviour `AccountPage.provePassword` has had all along, moved
 * here unchanged so the two methods sit side by side: the same call, the same
 * single wrong-password message for every failure. One message and not several
 * on purpose — the person has just typed their own password into their own
 * account, so "that was not it" is the whole of what a distinction could say.
 */
export async function proveWithPassword(
  email: string,
  password: string,
  client?: PasswordCapableClient,
): Promise<ReauthProof> {
  const resolved = client ?? ((await import('./supabase')).supabase as unknown as PasswordCapableClient);
  const { data, error } = await resolved.auth.signInWithPassword({ email, password });
  if (error || !data.session) return { ok: false, messageKey: 'account.error.pwCurrentWrong' };
  return { ok: true, accessToken: data.session.access_token };
}

/**
 * A fresh passkey assertion, spent the same way.
 *
 * `expectedUserId` is not optional and must not be made so. A discoverable
 * assertion resolves whichever account the offered credential belongs to, so on
 * a shared machine this can come back as a colleague's account — and a token for
 * another account is not a proof about this one. `runPasskeyAuthentication`
 * compares it, revokes the session it would otherwise strand, and reports
 * `wrongAccount`.
 */
export async function proveWithPasskey(
  expectedUserId: string,
  options: PasskeyCeremonyOptions = {},
): Promise<ReauthProof> {
  const result = await authenticateWithPasskey(expectedUserId, options);
  if (!result.ok) return { ok: false, messageKey: passkeyMessageKey(result.failure) };
  return { ok: true, accessToken: result.value.accessToken };
}
