/**
 * Two questions the screens ask about a session after Google sign-in went live
 * (plan step 1.6), kept pure so the routing they drive can be tested.
 *
 * They are deliberately different questions:
 *
 * - **Did this sign-in come from Google?** Only this may end a session. The
 *   platform-staff refusal hangs on it, and a platform account that signs in
 *   with its password must never be caught by it — even when its address also
 *   exists at Google.
 * - **Does this account have a Google identity?** This is what says an account
 *   without a company is a Google signup waiting to register one, rather than
 *   an ordinary account in a state the app already knows.
 */

/** As much of supabase-js's `User` as these questions need. */
export interface GoogleAccountUser {
  app_metadata?: Record<string, unknown> | null;
  identities?: ReadonlyArray<{ provider?: string | null }> | null;
}

const GOOGLE = 'google';

/**
 * Whether the account carries a Google identity, whichever way GoTrue recorded
 * it: `provider` for an account Google created, `providers` for one it was
 * linked to later, and the identity list when the session carries it.
 */
export function hasGoogleIdentity(user: GoogleAccountUser | null): boolean {
  if (!user) return false;
  const meta = user.app_metadata ?? {};
  if (meta.provider === GOOGLE) return true;
  if (Array.isArray(meta.providers) && meta.providers.includes(GOOGLE)) return true;
  return (user.identities ?? []).some(identity => identity.provider === GOOGLE);
}

/**
 * Whether the session in hand was created by a Google sign-in.
 *
 * Two signals, and each on its own is enough:
 *
 * - `app_metadata.provider === 'google'` — GoTrue created the account from
 *   Google, so it holds no password and every session of it is a Google one.
 * - `hasIntent` — this tab pressed the Google button a moment ago
 *   (`lib/googleSignIn`), which is the only way to recognise a Google sign-in
 *   into an account that was created with a password: GoTrue leaves `provider`
 *   at `email` when it links an identity.
 *
 * An account that merely *has* a Google identity is not enough, or the password
 * sign-in of a linked account would be treated as a Google one — and a platform
 * account would be signed out of a sign-in it made correctly.
 */
export function sessionCameFromGoogle(user: GoogleAccountUser | null, hasIntent: boolean): boolean {
  if (!user) return false;
  if ((user.app_metadata ?? {}).provider === GOOGLE) return true;
  return hasIntent && hasGoogleIdentity(user);
}

/**
 * Whether a Google session still has anything for `oauth-account` to settle.
 *
 * `reconcile` does two things: it cancels a password signup Google has just
 * confirmed, and it accepts a pending invitation. An account that already
 * belongs to a company and is active has neither pending, so every call it
 * makes can only answer `nothing_pending`.
 *
 * Without this test the call goes out on *every page load* for the rest of that
 * account's life: `sessionCameFromGoogle` is true for a Google-created account
 * with no marker at all, and the "already settled" ref in AuthContext starts
 * empty each load.
 *
 * `status` has to be part of it: an invited employee accepting through Google
 * carries a company on a `pending_invite` profile, and that is exactly the
 * session reconcile exists for.
 *
 * This is not a substitute for the platform-staff refusal, which is decided
 * before it, on a profile that carries no company at all.
 */
export function googleSessionIsSettled(
  profile: { company_id?: string | null; status?: string | null } | null,
): boolean {
  return !!profile?.company_id && profile.status === 'active';
}

/**
 * Whether this account still has to register a company: a Google account whose
 * profile belongs to no company. Platform accounts are company-less by design
 * and never belong here.
 */
export function needsCompanyRegistration(
  user: GoogleAccountUser | null,
  profile: { company_id?: string | null; is_super_admin?: boolean } | null,
): boolean {
  if (!user || !profile) return false;
  if (profile.is_super_admin) return false;
  if (profile.company_id) return false;
  return hasGoogleIdentity(user);
}
