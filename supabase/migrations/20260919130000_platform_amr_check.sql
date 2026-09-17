/*
  20260919130000 — a platform capability requires a password-backed session.

  ## Why

  The owner decided on 16.09.2026 that platform staff never sign in with
  Google. Until now only the browser enforced it: `sessionCameFromGoogle()` in
  `src/lib/googleAccount.ts` ends the session and `LoginForm` says why. That is
  a screen, not a boundary. A session Google minted for a platform account's
  address carries a perfectly valid JWT, and used directly against PostgREST or
  an edge function it passed every `platform_can()` check — the whole panel, the
  write RPCs, the read models, the settings.

  Worse, the browser's own test cannot always see it. GoTrue leaves
  `app_metadata.provider` at `email` when it *links* a Google identity to an
  account that was created with a password, so for a linked account the browser
  has nothing but the one-time marker this tab left in `sessionStorage`
  (`src/lib/googleSignIn.ts`). A request that does not come from that tab —
  curl, a replayed token, another browser — is indistinguishable there. The
  JWT's `amr` claim is not: it records how the session was established,
  server-side, and travels with the token.

  CLAUDE.md has carried the rule as a thing still to build ("the session JWT's
  `amr` claim must include the `password` method, so a session Google minted
  cannot use one"). This is it. It matters now because Google sign-in is about
  to be switched on in production.

  ## What GoTrue v2.170.0 actually writes

  Read out of the source tree at tag v2.170.0, not from memory. The method
  strings are `internal/models/factor.go` lines 40–91 (`AuthenticationMethod`
  and its `String()`): `oauth`, `password`, `otp`, `totp`, `mfa/phone`,
  `mfa/webauthn`, `sso/saml`, `recovery`, `invite`, `magiclink`,
  `email/signup`, `email_change`, `token_refresh`, `anonymous`. Each entry is
  `{"method": …, "timestamp": <unix seconds>}`, plus `"provider"` for SSO
  (`internal/models/sessions.go` lines 37–42).

    password sign-in  /token?grant_type=password   token.go:220   -> password
    Google, implicit  /authorize -> /callback      external.go:232-> oauth
    Google, PKCE      /authorize -> /token         external.go:82 -> oauth
    Google One Tap    /token?grant_type=id_token   token_oidc.go:235 -> oauth
    SAML              /sso/saml/acs                samlacs.go:299 -> sso/saml
    anonymous         /signup (anonymous)          anonymous.go:43-> anonymous
    POST /verify, ANY type                         verify.go:279  -> otp
    MFA verify                                     mfa.go         -> totp, appended
    refresh                                        token_refresh.go:217 -> unchanged

  Two of those decide the shape of this file:

  - **A refresh keeps the session's `amr` and adds nothing.** `token_refresh.go`
    contains no `AddClaimToSession` call at all; `generateAccessToken` rebuilds
    `amr` from the session's `mfa_amr_claims` rows every time. So `amr`
    describes how the *session* was established, not how this access token was
    minted, and a rule written on it does not expire after an hour.
  - **`POST /verify` records `otp` whatever the `type` is.** `verify.go:279`
    issues the token with `models.OTP` regardless of `params.Type`. So the
    session `issueSession()` mints after a verified one-time code
    (`supabase/functions/_shared/otp.ts`: a magic-link hash exchanged at
    `/auth/v1/verify`) carries `otp`, never `magiclink` and never `password`.
    `passwordAmrAgeSeconds()` in `_shared/otp-core.ts` already says so from a
    probe on 15.09.2026; this is the source behind it.

  `amr` can be absent altogether — the hook struct tags it `omitempty` and a
  session with no `mfa_amr_claims` rows produces a token without the key. Every
  session v2.170.0 creates writes its claim in the same transaction, so that is
  a legacy or out-of-band session. Absent reads as "not password-backed" here.

  ## The rule

  An allow-list, not a deny-list: the session must carry `password`. A method
  this build has never heard of therefore grants nothing, which is what a rule
  about sign-in strength has to do — a deny-list would have to be edited for
  every provider GoTrue adds, and would silently admit the one it missed.
  `oauth`, `sso/saml` and `anonymous` are refused a second time, explicitly and
  regardless of what else the array holds, because MFA *appends* to a session's
  `amr` and a rule that only looked for `password` would accept a session that
  also named an external provider.

  **What this costs, deliberately.** A session minted by `POST /verify` carries
  `otp`, so a platform account holds no capability until it has signed in with
  its password. Two flows reach it:

  - a newly invited platform member, who activates with an `invite_activate`
    code and then sets a password on `SetPasswordPage`;
  - a platform member who used "Passwort vergessen", which lands on the same
    page.

  Both have just chosen a password, so asking them to use it is one step, and
  it is the step the owner's decision already describes: platform sign-in is an
  address and a password. `SetPasswordPage` now ends such a session itself and
  sends the account to `/admin/login`, so neither flow ends on the panel's "no
  platform role" screen, which would have been the wrong sentence.

  ## Where the check lives, and why there

  In `app_private.platform_staff_role_of(uuid)`, the one function every
  session-facing platform path already reaches: `platform_staff_role()`,
  `platform_can()`, `platform_whoami()`, `platform_can_manage_account()`,
  `platform_audit_record()`, `is_user_super_admin()`, the five audited read
  models, both settings RPCs, every platform write RPC's capability check, the
  profile privilege guard — and, when 20260917140000 lands, `platform_context_row()`.
  Nothing has to be redefined twice and nothing can be forgotten.

  The condition is about the *session*, and it has exactly two states:

      jwt_has_subject()  AND NOT session_amr_permits_platform()  ->  NULL

  A request carrying an end user's token that was not established with a
  password exercises no platform authority for any account. Everything else is
  unchanged:

  - **No token, no gate.** A trigger, a migration, GoTrue and the service role
    carry no `sub` claim — the service key holds a `role` and nothing else — so
    `jwt_has_subject()` is false and the function answers exactly as before.
    Every SECURITY DEFINER caller that passes a user id it did not get from a
    session — `otp_issue`'s `platform_login` eligibility above all — is
    untouched.
  - **The account fact keeps its own name.** `platform_staff_role_of_account()`
    is the old body, unguarded. Three callers must have it because they ask
    about a row, not about a session: `platform_staff_sync_profile()` (the
    `is_super_admin` routing hint follows `platform_staff`, whoever is writing
    and however they signed in), `enforce_user_profile_privilege_guard()`
    (`staff_flag` protects the profile being written; `caller_platform` is
    authority and stays gated), and `audit_write()`'s `actor_role`, which is a
    fact about the actor and would otherwise go NULL on exactly the event this
    migration exists to record (section 5b).

  ## Two things a reader should not assume

  - **Self-check section 3 does not always run.** It needs an active
    `app_private.platform_staff` row, and the RLS kit seeds its staff *after* the
    migrations, so there it prints a NOTICE and skips. A green kit is not
    evidence that section ran; `tests/rls/platform-amr.sql` is what covers those
    cases, and section 3 is for the live databases, which do have staff rows.
  - **This file sorts after 20260917140000** (plan 3.4, support sessions), so the
    live ledger applies it *after* that migration while the kit — which applies
    every migration from 20260908 in filename order against a fixture that has
    neither — applies them in the same order. Nothing here redefines anything
    that file redefines, and every platform read it makes goes through the gate,
    so the two orders agree; whichever lands second should still re-read the
    other before merging.

  **Why not `p_user_id = auth.uid()`.** That is what this migration first said,
  and the RLS kit rejected it. Two defects in one line. `auth.uid()` is not
  ours: its body differs between the supabase/postgres image and the live
  databases, the image's reading only `request.jwt.claim.sub` — which is exactly
  why `_as()` in tests/rls/assertions.sql sets the singular claim and records
  that the JSON one "does not reach the function". And hanging the gate on a
  three-valued comparison means one NULL anywhere in it fails **open**: the
  comparison was NULL, the `AND` was NULL, the `IF` did not fire, and a Google
  session kept its platform role while every pure-rule assertion around it
  passed. It is the NULL-safety defect class this repository has shipped twice
  already (CLAUDE.md, *Known defects*), and it belongs in the function, not in
  the test that caught it. The condition above can only be true or false, reads
  both claim forms itself, and does not have to agree with the argument.

  ## Compatibility

  Backward compatible, **no SCHEMA_EPOCH bump**. No table, column, signature or
  grant changes; nothing dropped and nothing renamed. Every predicate the
  previous release depends on answers exactly as before for a password session,
  which per the owner's decision of 16.09.2026 is the only way platform staff
  sign in. A company user is not touched at all: it has no `platform_staff` row,
  so both the old and the new body answer NULL for it.

  The one behaviour that differs under a rollback is the one this file exists to
  remove — a session that was not established with a password holding platform
  rights — plus the invited-member step above, which the rolled-back release
  would not sign out automatically. That is recoverable by the person in front
  of the screen (sign out, sign in), so it is not an epoch matter.

  ## Ownership

  `platform_staff_role_of()` is SECURITY INVOKER and stays so: it runs as the
  owner of whichever SECURITY DEFINER function called it, and every caller is
  one, since `authenticated` holds EXECUTE on nothing in `app_private`. The
  three SECURITY DEFINER functions replaced here — `audit_write`,
  `platform_staff_sync_profile` and `enforce_user_profile_privilege_guard` —
  gain no new schema but are handed to the migration role anyway, because
  CREATE OR REPLACE keeps the owner and on the live databases that owner is a
  non-superuser `postgres` that holds EXECUTE on no `app_private` function. The
  self-check asks it of the invoker functions too: an owner is what a later
  ALTER could change.
*/

-- ─── 1. Reading the claim ───────────────────────────────────────────────────

/*
  Which document the caller's session is described by, or NULL when there is no
  end user's token at all: `claim` for the singular `request.jwt.claim.*` GUCs,
  `claims` for the one `request.jwt.claims` document PostgREST sets.

  **The order is `auth.uid()`'s**, singular first. Not because the singular form
  is trusted more — in production PostgREST sets only the document, so the
  branch is unreachable there — but because the whole point of this function is
  that one source describes the session. `auth.uid()` checks the singular claim
  first, and every capability lookup in the schema resolves the caller through
  it; if the `amr` were read from the other document, a database where both are
  set could name one session's subject and another session's sign-in method.
  Reading both out of the same place is what makes that impossible, and
  `jwt_amr()` below is built on this rather than on its own precedence.

  Only presence is asked, never a uuid: a subject that does not parse is still a
  session, and turning a malformed token into "no token" would fail open.

  A `request.jwt.claims` that is not JSON is not an error — but note it is only
  ever parsed when the singular subject is absent, so a caller who has one is
  never affected by the other being broken.
*/
CREATE OR REPLACE FUNCTION app_private.jwt_subject_source()
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF nullif(current_setting('request.jwt.claim.sub', true), '') IS NOT NULL THEN
    RETURN 'claim';
  END IF;
  IF nullif((nullif(current_setting('request.jwt.claims', true), '')::jsonb) ->> 'sub', '')
     IS NOT NULL THEN
    RETURN 'claims';
  END IF;
  RETURN NULL;
EXCEPTION WHEN others THEN
  -- request.jwt.claims that is not valid JSON, and no singular subject beside
  -- it: no session, not an error.
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION app_private.jwt_subject_source() IS
  'Which document describes the caller''s session — claim (the singular GUCs, '
  'the form auth.uid() checks first) or claims (PostgREST''s document) — or '
  'NULL for a request with no end user token. Never raises.';

/*
  Whether the request carries an end user's token at all.

  Deliberately **not** `auth.uid() IS NOT NULL`. `auth.uid()` is not ours: its
  body differs between the supabase/postgres image and the live databases — the
  image's reads only `request.jwt.claim.sub`, which is why `_as()` in
  tests/rls/assertions.sql sets the singular claim and says the JSON one "does
  not reach the function". A gate that asks it is a gate that can silently
  switch itself off on a database where it answers NULL for a real session. That
  is the NULL-safety defect class this repository has already shipped twice
  (CLAUDE.md, *Known defects*), and the first version of this migration walked
  straight into it: the gate read `p_user_id = auth.uid()`, the comparison was
  NULL in the RLS kit, the `AND` was NULL, and a Google session kept its
  platform role while every rule assertion around it passed.

  False, never NULL, never an exception.
*/
CREATE OR REPLACE FUNCTION app_private.jwt_has_subject()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT app_private.jwt_subject_source() IS NOT NULL;
$$;

COMMENT ON FUNCTION app_private.jwt_has_subject() IS
  'Whether the request carries an end user''s token. Not auth.uid(), whose body '
  'differs between the image and the live databases, and not parsed as a uuid. '
  'False, never NULL, never raises.';

/*
  The `amr` array of the session `jwt_subject_source()` named, or NULL —
  **read out of the same document as that session's subject**, never out of the
  other one, so the sign-in method always belongs to the account the rest of the
  schema resolves the caller as.

  Anything malformed — not JSON, not an array, absent, or no session at all — is
  NULL rather than an error: a claim that cannot be read is not a sign-in
  method. The handler is the function's own, so a broken `amr` loses the amr and
  not the session, which would fail open.
*/
CREATE OR REPLACE FUNCTION app_private.jwt_amr()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_source text := app_private.jwt_subject_source();
  v_amr    jsonb;
BEGIN
  IF v_source IS NULL THEN
    RETURN NULL;
  ELSIF v_source = 'claim' THEN
    v_amr := nullif(current_setting('request.jwt.claim.amr', true), '')::jsonb;
  ELSE
    v_amr := (nullif(current_setting('request.jwt.claims', true), '')::jsonb) -> 'amr';
  END IF;

  IF v_amr IS NULL OR jsonb_typeof(v_amr) <> 'array' THEN
    RETURN NULL;
  END IF;
  RETURN v_amr;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION app_private.jwt_amr() IS
  'The amr array of the caller''s session, taken from the same document its '
  'subject came from (app_private.jwt_subject_source()). NULL for a request '
  'with no session, no amr or a malformed one. Never raises.';

-- ─── 2. The rule ────────────────────────────────────────────────────────────

/*
  Whether the session in hand may exercise a platform capability.

  The two lists are CONSTANTs here because this is the one function that
  enforces the rule, the way every limit in `app_private` is written down once
  where it is applied.

  Returns false, never NULL and never an exception, for every caller: no JWT,
  no `amr`, an `amr` that is not an array, entries that are not objects. An
  entry may be a bare string as well as GoTrue's `{"method": …}` object, so a
  standards-shaped `amr` from any future issuer is read rather than ignored.
*/
CREATE OR REPLACE FUNCTION app_private.session_amr_permits_platform()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  -- The sign-in that carries platform rights. GoTrue v2.170.0 writes
  -- `password` for /token?grant_type=password (internal/api/token.go:220).
  c_permitted CONSTANT text[] := ARRAY['password'];
  -- Refused whatever else the array holds: MFA appends to a session's amr, so
  -- "contains password" alone would accept a session that also names an
  -- external identity provider. The owner's decision of 16.09.2026 is that a
  -- platform account never signs in through one.
  c_refused   CONSTANT text[] := ARRAY['oauth', 'sso/saml', 'anonymous'];
  v_amr    jsonb := app_private.jwt_amr();
  v_entry  jsonb;
  v_method text;
  v_ok     boolean := false;
BEGIN
  IF v_amr IS NULL THEN
    RETURN false;
  END IF;

  FOR v_entry IN SELECT value FROM jsonb_array_elements(v_amr) AS t(value) LOOP
    v_method := CASE jsonb_typeof(v_entry)
                  WHEN 'string' THEN v_entry #>> '{}'
                  WHEN 'object' THEN v_entry ->> 'method'
                  ELSE NULL
                END;
    IF v_method IS NULL THEN
      CONTINUE;
    END IF;
    IF v_method = ANY (c_refused) THEN
      RETURN false;
    END IF;
    IF v_method = ANY (c_permitted) THEN
      v_ok := true;
    END IF;
  END LOOP;

  RETURN v_ok;
EXCEPTION WHEN others THEN
  RETURN false;
END;
$$;

COMMENT ON FUNCTION app_private.session_amr_permits_platform() IS
  'True only for a session GoTrue established with a password, and never for '
  'one that also names oauth, sso/saml or anonymous. False for a missing or '
  'malformed amr and for a caller with no JWT. Never NULL, never raises.';

-- ─── 3. The account fact, under its own name ────────────────────────────────

/*
  20260916110000's body, unchanged and ungated: the active role of one account,
  or NULL — no row, a disabled row, or no id.

  This is a fact about a row. It answers for a *target* account, so it must not
  depend on how the caller signed in; the two triggers below ask it about a row
  that may happen to be the caller's own.
*/
CREATE OR REPLACE FUNCTION app_private.platform_staff_role_of_account(p_user_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_user_id IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN (SELECT s.role
            FROM app_private.platform_staff s
           WHERE s.user_id = p_user_id
             AND s.disabled_at IS NULL);
END;
$$;

COMMENT ON FUNCTION app_private.platform_staff_role_of_account(uuid) IS
  'The active platform role of one account, whatever session is asking. The '
  'fact about the row; platform_staff_role_of() is the authority a session may '
  'exercise.';

-- ─── 4. The authority a session may exercise ────────────────────────────────

/*
  The same signature, and the same answer as before for everyone except one
  caller: a request carrying an end user's token that GoTrue did not establish
  with a password. Such a session exercises no platform authority at all — not
  for itself and not for anyone else.

  **The condition is the session, not the argument.** An earlier version read
  `p_user_id = auth.uid()`, which was narrower and wrong twice over: it asked
  `auth.uid()`, whose body is not ours (see `jwt_has_subject()` above), and it
  hung the whole gate on a three-valued comparison, so one NULL anywhere in it
  failed open. A condition that can only be true or false, and that never has to
  agree with anything about the argument, has neither problem.

  What still passes untouched is everything with no token at all: a trigger, a
  migration, GoTrue, and the service role — whose key carries a `role` and no
  `sub`. A SECURITY DEFINER function that holds a user id and no session keeps
  working exactly as before, which is the property `otp_issue`'s platform_login
  branch and the two staff triggers depend on.

  Two callers pass a user id that is not the caller's — the company-lifecycle
  RPCs that skip platform accounts (20260916130000) and platform_staff_add /
  _enable / _disable looking at their target (20260916130010). Both check a
  capability first, so a session this gate refuses never reaches them; and both
  ask an account question, so if either is ever rewritten it should read
  platform_staff_role_of_account() instead.
*/
CREATE OR REPLACE FUNCTION app_private.platform_staff_role_of(p_user_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_user_id IS NULL THEN
    RETURN NULL;
  END IF;

  IF app_private.jwt_has_subject()
     AND NOT app_private.session_amr_permits_platform() THEN
    RETURN NULL;
  END IF;

  RETURN app_private.platform_staff_role_of_account(p_user_id);
END;
$$;

COMMENT ON FUNCTION app_private.platform_staff_role_of(uuid) IS
  'The platform role the caller may exercise for that account. The account''s '
  'active role — except for a request carrying an end user''s token whose amr '
  'does not name password, which exercises none for any account '
  '(20260919130000). A caller with no token is not gated.';

-- ─── 5. The two callers that ask about a row, not a session ─────────────────

/*
  20260916110000's body with one call renamed. The routing hint follows
  `platform_staff`, whoever is writing the row and however they signed in — a
  derived column that a Google session could set to false would be a lie the
  next reader believes.
*/
CREATE OR REPLACE FUNCTION app_private.platform_staff_sync_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_ids uuid[];
BEGIN
  IF TG_TABLE_SCHEMA = 'public' AND TG_TABLE_NAME = 'user_profiles' THEN
    IF app_private.platform_staff_role_of_account(NEW.user_id) IS NOT NULL THEN
      NEW.is_super_admin := true;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_ids := ARRAY[NEW.user_id];
  ELSIF TG_OP = 'DELETE' THEN
    v_ids := ARRAY[OLD.user_id];
  ELSE
    v_ids := ARRAY[OLD.user_id, NEW.user_id];
  END IF;

  UPDATE public.user_profiles up
     SET is_super_admin = (app_private.platform_staff_role_of_account(up.user_id) IS NOT NULL)
   WHERE up.user_id = ANY (v_ids)
     AND up.is_super_admin IS DISTINCT FROM (app_private.platform_staff_role_of_account(up.user_id) IS NOT NULL);

  RETURN NULL;
END;
$$;

/*
  20260917130000's body with one call renamed, and only one.

  `staff_flag` is what stops a JWT setting `is_super_admin` to anything but what
  `platform_staff` already says. It is about the row being written — including
  when that row is the caller's own — so it reads the account fact. Left on the
  gated helper, a platform account signing in with Google would read its own
  staff row as absent and could clear its own flag.

  `caller_platform` is the opposite: it is the authority the caller is claiming,
  and it stays on `platform_staff_role_of()`, which is now what refuses a
  session Google minted. That is the whole change here.
*/
CREATE OR REPLACE FUNCTION public.enforce_user_profile_privilege_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  caller_uid       uuid := auth.uid();
  caller_jwt_role  text := auth.role();
  caller_company   uuid;
  caller_role_text text;
  caller_status    text;
  caller_platform  text;
  staff_flag       boolean;
  -- The statuses AuthContext.userStatusBlockReason() blocks. `pending_invite`
  -- is not one of them, here as in get_active_company_id().
  c_blocked        CONSTANT text[] := ARRAY['inactive', 'suspended', 'deactivated'];
BEGIN
  -- Unguarded: the service role, GoTrue and migrations, none of which carries
  -- an end user's JWT.
  IF caller_uid IS NULL AND coalesce(caller_jwt_role, '') NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;

  -- A JWT without a subject (the anon key) writes no profile at all. RLS
  -- already refuses its direct writes; this also holds inside a SECURITY
  -- DEFINER function anon can reach, where RLS does not apply and every rule
  -- below would otherwise compare against a NULL caller.
  IF caller_uid IS NULL THEN
    RAISE EXCEPTION 'Not allowed: a request without a signed-in user cannot write profiles';
  END IF;

  -- A profile belongs to one account for good. Checked first, so the rules
  -- below cannot be judged against an account the row is being moved to.
  IF TG_OP = 'UPDATE' AND NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'Not allowed: cannot change user_id';
  END IF;

  -- The platform flag follows platform_staff. A JWT may set it only to what
  -- that table already says, which is what the sync trigger's own update does.
  staff_flag := app_private.platform_staff_role_of_account(NEW.user_id) IS NOT NULL;
  IF TG_OP = 'INSERT' THEN
    IF coalesce(NEW.is_super_admin, false) AND NOT staff_flag THEN
      RAISE EXCEPTION 'Not allowed: cannot self-assign super admin';
    END IF;
  ELSIF coalesce(NEW.is_super_admin, false) IS DISTINCT FROM coalesce(OLD.is_super_admin, false)
        AND coalesce(NEW.is_super_admin, false) IS DISTINCT FROM staff_flag THEN
    RAISE EXCEPTION 'Not allowed: cannot modify is_super_admin';
  END IF;

  -- No JWT moves a profile between companies, a platform account's included.
  IF TG_OP = 'UPDATE' AND NEW.company_id IS DISTINCT FROM OLD.company_id THEN
    RAISE EXCEPTION 'Not allowed: cannot change company assignment';
  END IF;

  SELECT company_id, role, status
    INTO caller_company, caller_role_text, caller_status
    FROM public.user_profiles
   WHERE user_id = caller_uid
   LIMIT 1;

  caller_platform := app_private.platform_staff_role_of(caller_uid);

  IF TG_OP = 'INSERT' THEN
    IF NEW.user_id <> caller_uid
       AND NOT app_private.platform_role_can(caller_platform, 'company_users.manage') THEN
      RAISE EXCEPTION 'Not allowed: cannot insert profile for another user';
    END IF;

    -- NULL or the caller's own company; no platform exception any more.
    IF NEW.company_id IS NOT NULL
       AND NEW.company_id IS DISTINCT FROM caller_company THEN
      RAISE EXCEPTION 'Not allowed: cannot insert profile for another company';
    END IF;

    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- role / role_id can be changed by:
    --   * a platform account holding company_users.manage
    --   * a company admin, whose own account is usable, on a target profile in
    --     the SAME company that is not a platform account (no staff row, a
    --     disabled one included)
    -- coalesce(): for a caller without a company the comparison is NULL, and
    -- NOT NULL let the whole condition fall through without raising.
    IF (NEW.role_id IS DISTINCT FROM OLD.role_id
        OR NEW.role     IS DISTINCT FROM OLD.role)
       AND NOT app_private.platform_role_can(caller_platform, 'company_users.manage')
       AND NOT coalesce(
            caller_role_text = 'admin'
            AND NOT (caller_status = ANY (c_blocked))
            AND OLD.company_id IS NOT NULL
            AND OLD.company_id = caller_company
            AND NEW.company_id = caller_company
            AND NOT app_private.oauth_account_is_platform_staff(OLD.user_id),
            false)
    THEN
      RAISE EXCEPTION 'Not allowed: cannot change role assignment';
    END IF;

    -- status can be changed by:
    --   * a platform account holding company_users.manage or companies.lifecycle
    --   * a company admin, whose own account is usable, on a target profile in
    --     the SAME company that is not a platform account (no staff row, a
    --     disabled one included)
    --   * the user themselves, but ONLY to complete the invite flow
    --     ('pending_invite' -> 'active', SetPasswordPage.tsx)
    IF NEW.status IS DISTINCT FROM OLD.status
       AND NOT app_private.platform_role_can(caller_platform, 'company_users.manage')
       AND NOT app_private.platform_role_can(caller_platform, 'companies.lifecycle')
       AND NOT coalesce(
            caller_role_text = 'admin'
            AND NOT (caller_status = ANY (c_blocked))
            AND OLD.company_id IS NOT NULL
            AND OLD.company_id = caller_company
            AND NOT app_private.oauth_account_is_platform_staff(OLD.user_id),
            false)
       AND NOT coalesce(
            OLD.user_id = caller_uid
            AND OLD.status = 'pending_invite'
            AND NEW.status = 'active',
            false)
    THEN
      RAISE EXCEPTION 'Not allowed: cannot change account status';
    END IF;

    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$fn$;

-- ─── 5b. The audit log records the actor's role, not the session's ──────────

/*
  `actor_role` is a fact about the actor — the column's own header in
  20260916110000 says "the actor's role is always looked up here, never passed"
  — so it reads the account fact, exactly like `staff_flag` and the sync trigger
  above.

  Left on the gated helper it would answer NULL for the one event this migration
  exists to record. The only row a refused session can still produce is the
  `denied` row `platform_rpc_authorize` writes (20260916130000:209-222), which
  is written for *any* actor, staff or not; with a NULL role, a platform account
  probing the write RPCs from a Google session would be indistinguishable in the
  log from an ordinary company user being refused. The `actor_user_id` is there
  either way, but the log is read by role, and a column that silently means two
  different things is worse than one that is occasionally uninteresting.

  **This is 20260916110000's body with one call renamed and nothing else.** Every
  rule it carries is restated deliberately, because this repository has already
  shipped a defect by re-creating a function from an older body and dropping one
  of its rules (`platform_audit_record`, 20260916140000 → 20260916150000, in
  CLAUDE.md). Carried over, in order:

    1. the seven categories, and `legacy` among them;
    2. the action's 100-character limit and its dotted lower-case pattern;
    3. the four outcomes;
    4. `target_type`'s 60 characters and pattern, and `target_id`'s 200;
    5. the 32 KiB cap on `before` and `after`;
    6. **`p_occurred_at` is refused for every category but `legacy`**, so
       nothing but the legacy copy can backdate a row;
    7. the actor defaults to `auth.uid()`, the session to the JWT's
       `session_id`, read from `request.jwt.claims` and uuid-checked, a
       malformed one leaving the column empty rather than failing the action;
    8. `legacy` rows carry no role;
    9. `VOLATILE`, `SECURITY DEFINER`, the pinned search_path, the signature and
       the RETURNS.

  `tests/rls/platform-amr.sql` section 5 pins what the `denied` row carries, so
  the behaviour is chosen rather than inherited.
*/
CREATE OR REPLACE FUNCTION app_private.audit_write(
  p_category      text,
  p_action        text,
  p_outcome       text        DEFAULT 'ok',
  p_company_id    uuid        DEFAULT NULL,
  p_target_type   text        DEFAULT NULL,
  p_target_id     text        DEFAULT NULL,
  p_before        jsonb       DEFAULT NULL,
  p_after         jsonb       DEFAULT NULL,
  p_actor_user_id uuid        DEFAULT NULL,
  p_session_id    uuid        DEFAULT NULL,
  p_occurred_at   timestamptz DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_max_value_bytes CONSTANT integer := 32768;
  c_uuid_pattern    CONSTANT text    := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

  v_actor   uuid;
  v_session uuid := p_session_id;
  v_claim   text;
  v_id      bigint;
BEGIN
  IF p_category IS NULL
     OR p_category NOT IN ('read','write','support','auth','settings','staff','legacy')
     OR p_action IS NULL OR length(p_action) > 100
     OR p_action !~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'
     OR p_outcome IS NULL OR p_outcome NOT IN ('attempt','ok','denied','error')
     OR (p_target_type IS NOT NULL AND (length(p_target_type) > 60 OR p_target_type !~ '^[a-z][a-z0-9_]*$'))
     OR (p_target_id IS NOT NULL AND length(p_target_id) > 200)
     OR (p_before IS NOT NULL AND octet_length(p_before::text) > c_max_value_bytes)
     OR (p_after  IS NOT NULL AND octet_length(p_after::text)  > c_max_value_bytes)
     OR (p_occurred_at IS NOT NULL AND p_category <> 'legacy')
  THEN
    RAISE EXCEPTION 'audit_write: invalid arguments' USING ERRCODE = '22023';
  END IF;

  v_actor := coalesce(p_actor_user_id, auth.uid());

  -- PostgREST puts the verified claims here. A missing or malformed session_id
  -- leaves the column empty rather than failing the action being recorded.
  IF v_session IS NULL THEN
    v_claim := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'session_id';
    IF v_claim ~ c_uuid_pattern THEN
      v_session := v_claim::uuid;
    END IF;
  END IF;

  INSERT INTO app_private.platform_audit_log
    (occurred_at, actor_user_id, actor_role, session_id, company_id, category, action, outcome,
     target_type, target_id, before_value, after_value)
  VALUES
    (coalesce(p_occurred_at, now()), v_actor,
     -- The one changed line: the account's role, not the role this session may
     -- exercise. 20260919130000.
     CASE WHEN p_category = 'legacy' THEN NULL ELSE app_private.platform_staff_role_of_account(v_actor) END,
     v_session, p_company_id, p_category, p_action, p_outcome,
     p_target_type, p_target_id, p_before, p_after)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- ─── 6. Ownership and privileges ────────────────────────────────────────────

/*
  CREATE OR REPLACE keeps a function's owner, and on the live databases several
  of these belong to a non-superuser `postgres` that holds EXECUTE on no
  app_private function. Each function replaced or created here is handed to the
  role applying the migrations, which owns app_private. The self-check proves it
  for the SECURITY DEFINER ones, which are the ones where the owner decides what
  the body may call.
*/
ALTER FUNCTION app_private.jwt_subject_source()                   OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.jwt_amr()                              OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.audit_write(text, text, text, uuid, text, text, jsonb, jsonb, uuid, uuid, timestamptz) OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.jwt_has_subject()                      OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.session_amr_permits_platform()         OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.platform_staff_role_of_account(uuid)   OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.platform_staff_role_of(uuid)           OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.platform_staff_sync_profile()          OWNER TO CURRENT_USER;
ALTER FUNCTION public.enforce_user_profile_privilege_guard()      OWNER TO CURRENT_USER;

/*
  Nobody the API authenticates as reaches app_private: the missing USAGE on the
  schema is what keeps them out, and these REVOKEs are the second wall, because
  EXECUTE to PUBLIC on a new function is a built-in global default that cannot
  be revoked per schema. Restated for the replaced functions too, so this file's
  self-check does not depend on an earlier one.
*/
REVOKE ALL ON FUNCTION app_private.jwt_subject_source()                 FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.jwt_amr()                            FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.audit_write(text, text, text, uuid, text, text, jsonb, jsonb, uuid, uuid, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.jwt_has_subject()                    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.session_amr_permits_platform()       FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.platform_staff_role_of_account(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.platform_staff_role_of(uuid)         FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.platform_staff_sync_profile()        FROM PUBLIC, anon, authenticated, service_role;

-- Fired by a trigger, never called: triggers do not check EXECUTE.
REVOKE ALL ON FUNCTION public.enforce_user_profile_privilege_guard()
  FROM PUBLIC, anon, authenticated, service_role;

-- ─── 7. Self-check ──────────────────────────────────────────────────────────

DO $selfcheck$
DECLARE
  c_password CONSTANT text := '[{"method": "password", "timestamp": 1789416052}]';
  c_oauth    CONSTANT text := '[{"method": "oauth",    "timestamp": 1789416052}]';
  c_otp      CONSTANT text := '[{"method": "otp",      "timestamp": 1789416052}]';
  c_both     CONSTANT text := '[{"method": "password", "timestamp": 1}, {"method": "oauth", "timestamp": 2}]';
  c_mfa      CONSTANT text := '[{"method": "password", "timestamp": 1}, {"method": "totp",  "timestamp": 2}]';
  c_saml     CONSTANT text := '[{"method": "sso/saml", "timestamp": 1, "provider": "acme"}]';
  c_doc      CONSTANT text := '{"sub":"%s","role":"authenticated","amr":%s}';
  v_staff    uuid;
  v_other    uuid := '00000000-0000-4000-8000-0000000000ff';
  v_src      text;
  v_role     text;
  v_id       bigint;
  v_wrong    text;
BEGIN
  -- 1. The rule itself, with no data at all. Each case is set the way PostgREST
  --    sets it: one JSON document in request.jwt.claims, and each carries a
  --    subject, because jwt_amr() reads the amr out of the document the
  --    *subject* came from. There is no such thing as the amr of a request that
  --    describes no session.
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.amr', '', true);

  PERFORM set_config('request.jwt.claims', format(c_doc, v_other, c_password), true);
  IF app_private.session_amr_permits_platform() IS NOT TRUE THEN
    RAISE EXCEPTION '20260919130000 self-check: a password session is refused';
  END IF;

  PERFORM set_config('request.jwt.claims', format(c_doc, v_other, c_mfa), true);
  IF app_private.session_amr_permits_platform() IS NOT TRUE THEN
    RAISE EXCEPTION '20260919130000 self-check: password plus an MFA method is refused';
  END IF;

  PERFORM set_config('request.jwt.claims', format(c_doc, v_other, c_oauth), true);
  IF app_private.session_amr_permits_platform() IS NOT FALSE THEN
    RAISE EXCEPTION '20260919130000 self-check: a Google session is admitted';
  END IF;

  PERFORM set_config('request.jwt.claims', format(c_doc, v_other, c_saml), true);
  IF app_private.session_amr_permits_platform() IS NOT FALSE THEN
    RAISE EXCEPTION '20260919130000 self-check: an SSO session is admitted';
  END IF;

  PERFORM set_config('request.jwt.claims', format(c_doc, v_other, c_both), true);
  IF app_private.session_amr_permits_platform() IS NOT FALSE THEN
    RAISE EXCEPTION '20260919130000 self-check: oauth beside password is admitted';
  END IF;

  -- POST /verify writes `otp` whatever the type is (verify.go:279), so this is
  -- every session issueSession() mints.
  PERFORM set_config('request.jwt.claims', format(c_doc, v_other, c_otp), true);
  IF app_private.session_amr_permits_platform() IS NOT FALSE THEN
    RAISE EXCEPTION '20260919130000 self-check: a code-minted session is admitted';
  END IF;

  -- Absent, empty, the wrong type, and not JSON at all: all false, none an error.
  PERFORM set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated"}', v_other), true);
  IF app_private.session_amr_permits_platform() IS NOT FALSE THEN
    RAISE EXCEPTION '20260919130000 self-check: a token without amr is admitted';
  END IF;
  PERFORM set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated","amr":[]}', v_other), true);
  IF app_private.session_amr_permits_platform() IS NOT FALSE THEN
    RAISE EXCEPTION '20260919130000 self-check: an empty amr is admitted';
  END IF;
  PERFORM set_config('request.jwt.claims',
    format('{"sub":"%s","role":"authenticated","amr":"password"}', v_other), true);
  IF app_private.session_amr_permits_platform() IS NOT FALSE THEN
    RAISE EXCEPTION '20260919130000 self-check: an amr that is not an array is admitted';
  END IF;
  PERFORM set_config('request.jwt.claims', 'not json at all', true);
  IF app_private.session_amr_permits_platform() IS NOT FALSE THEN
    RAISE EXCEPTION '20260919130000 self-check: malformed claims are admitted';
  END IF;
  PERFORM set_config('request.jwt.claims', '', true);
  IF app_private.session_amr_permits_platform() IS NOT FALSE THEN
    RAISE EXCEPTION '20260919130000 self-check: a caller with no claims is admitted';
  END IF;

  -- An amr with no subject beside it describes no session, so there is no amr
  -- to read. This is the shape the old, independent jwt_amr() would have
  -- admitted.
  PERFORM set_config('request.jwt.claims', format('{"role":"authenticated","amr":%s}', c_password), true);
  IF app_private.session_amr_permits_platform() IS NOT FALSE THEN
    RAISE EXCEPTION '20260919130000 self-check: an amr without a subject is admitted';
  END IF;

  -- The symmetry the two helpers exist to guarantee: the amr is read out of the
  -- document the subject came from, and never out of the other one. The
  -- singular claim wins, which is the order auth.uid() checks — so the session
  -- every capability lookup resolves and the sign-in method judged here can
  -- never be two different sessions.
  PERFORM set_config('request.jwt.claim.sub', v_other::text, true);
  PERFORM set_config('request.jwt.claim.amr', c_password, true);
  PERFORM set_config('request.jwt.claims',
    format('{"sub":"00000000-0000-4000-8000-00000000000e","role":"authenticated","amr":%s}', c_oauth), true);
  IF app_private.jwt_subject_source() IS DISTINCT FROM 'claim' THEN
    RAISE EXCEPTION '20260919130000 self-check: the singular subject no longer wins';
  END IF;
  IF app_private.session_amr_permits_platform() IS NOT TRUE THEN
    RAISE EXCEPTION '20260919130000 self-check: the amr is read from a document the subject did not come from';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', '', true);
  IF app_private.jwt_subject_source() IS DISTINCT FROM 'claims' THEN
    RAISE EXCEPTION '20260919130000 self-check: the claims document is not the fallback source';
  END IF;
  IF app_private.session_amr_permits_platform() IS NOT FALSE THEN
    RAISE EXCEPTION '20260919130000 self-check: the singular amr outlived the singular subject';
  END IF;
  PERFORM set_config('request.jwt.claim.amr', '', true);
  PERFORM set_config('request.jwt.claims', '', true);

  -- 1b. The other half of the condition: is there an end user's token at all?
  --      Each claim form on its own, because the image's auth.uid() reads only
  --      the singular one and the live databases' reads both — which is
  --      precisely why the gate does not ask auth.uid().
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  IF app_private.jwt_has_subject() IS NOT FALSE THEN
    RAISE EXCEPTION '20260919130000 self-check: a caller with no claims reads as a session';
  END IF;

  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  IF app_private.jwt_has_subject() IS NOT FALSE THEN
    RAISE EXCEPTION '20260919130000 self-check: the service role reads as an end user''s session';
  END IF;

  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  IF app_private.jwt_has_subject() IS NOT FALSE THEN
    RAISE EXCEPTION '20260919130000 self-check: the anon key reads as an end user''s session';
  END IF;

  PERFORM set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}', v_other), true);
  IF app_private.jwt_has_subject() IS NOT TRUE THEN
    RAISE EXCEPTION '20260919130000 self-check: a subject in the claims document is not seen';
  END IF;

  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', v_other::text, true);
  IF app_private.jwt_has_subject() IS NOT TRUE THEN
    RAISE EXCEPTION '20260919130000 self-check: a subject in the singular claim is not seen';
  END IF;

  -- A subject that is not a uuid is still a session; parsing it would turn a
  -- malformed token into "no token", which is the wrong way to fail. The
  -- singular claim is cleared first, or it would be the one answering.
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '{"sub":"not-a-uuid","role":"authenticated"}', true);
  IF app_private.jwt_has_subject() IS NOT TRUE THEN
    RAISE EXCEPTION '20260919130000 self-check: a malformed subject reads as no session';
  END IF;

  -- An empty subject is not one.
  PERFORM set_config('request.jwt.claims', '{"sub":"","role":"authenticated"}', true);
  IF app_private.jwt_has_subject() IS NOT FALSE THEN
    RAISE EXCEPTION '20260919130000 self-check: an empty subject reads as a session';
  END IF;

  -- Claims that are not JSON: the singular claim still decides, and nothing raises.
  PERFORM set_config('request.jwt.claim.sub', v_other::text, true);
  PERFORM set_config('request.jwt.claims', 'not json at all', true);
  IF app_private.jwt_has_subject() IS NOT TRUE THEN
    RAISE EXCEPTION '20260919130000 self-check: malformed claims lose the singular subject';
  END IF;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  IF app_private.jwt_has_subject() IS NOT FALSE THEN
    RAISE EXCEPTION '20260919130000 self-check: malformed claims alone read as a session';
  END IF;
  PERFORM set_config('request.jwt.claims', '', true);

  -- 2. The gate is in the function every session-facing path reaches, and a
  --    later rewrite that drops either half fails here.
  SELECT p.prosrc INTO v_src
    FROM pg_proc p WHERE p.oid = to_regprocedure('app_private.platform_staff_role_of(uuid)');
  IF v_src !~ 'session_amr_permits_platform' THEN
    RAISE EXCEPTION '20260919130000 self-check: platform_staff_role_of() no longer asks the amr rule';
  END IF;
  IF v_src !~ 'jwt_has_subject' THEN
    RAISE EXCEPTION '20260919130000 self-check: platform_staff_role_of() no longer asks whether there is a session';
  END IF;
  -- The defect this migration was first written with. auth.uid()'s body is not
  -- ours and differs between the image and the live databases, so a gate that
  -- reads it can switch itself off; a three-valued comparison in the condition
  -- fails open on one NULL. Neither belongs here.
  IF v_src ~ 'auth\.uid' THEN
    RAISE EXCEPTION '20260919130000 self-check: platform_staff_role_of() reads auth.uid() again — the gate must not depend on it';
  END IF;

  --    …and the two callers that ask about a row read the ungated fact.
  FOR v_wrong IN
    SELECT sig FROM (VALUES
        ('app_private.platform_staff_sync_profile()'),
        ('public.enforce_user_profile_privilege_guard()')
      ) AS t(sig)
     WHERE (SELECT p.prosrc FROM pg_proc p WHERE p.oid = to_regprocedure(t.sig))
           !~ 'platform_staff_role_of_account'
  LOOP
    RAISE EXCEPTION '20260919130000 self-check: % no longer reads the ungated account fact', v_wrong;
  END LOOP;

  -- 3. Against a real staff row, when the database has one. The RLS kit seeds
  --    its staff after the migrations, so there it only reports.
  SELECT s.user_id INTO v_staff
    FROM app_private.platform_staff s
   WHERE s.disabled_at IS NULL
   ORDER BY s.user_id
   LIMIT 1;

  IF v_staff IS NULL THEN
    RAISE NOTICE '20260919130000 self-check: no active platform_staff row — the session cases are checked by tests/rls/platform-amr.sql';
  ELSE
    -- Both claim forms are set together throughout this section, and they
    -- describe the same session, because is_user_super_admin() goes through
    -- auth.uid(), whose body reads only the singular claim on the
    -- supabase/postgres image and both on the live databases. The gate itself
    -- needs neither. jwt_subject_source() prefers the singular subject, so the
    -- singular amr is what is read here; the document carries the same one so
    -- the two can never be read as different sessions.

    -- No token at all: a trigger, a migration, GoTrue, the service role.
    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.jwt.claim.sub', '', true);
    IF app_private.platform_staff_role_of(v_staff) IS NULL THEN
      RAISE EXCEPTION '20260919130000 self-check: a caller without a session can no longer read a staff role';
    END IF;

    -- A password session.
    PERFORM set_config('request.jwt.claim.sub', v_staff::text, true);
    PERFORM set_config('request.jwt.claim.amr', c_password, true);
    PERFORM set_config('request.jwt.claims',
      format('{"sub":"%s","role":"authenticated","amr":%s}', v_staff, c_password), true);
    IF app_private.platform_staff_role_of(v_staff) IS NULL THEN
      RAISE EXCEPTION '20260919130000 self-check: a password session lost its platform role';
    END IF;
    IF public.is_user_super_admin() IS NOT TRUE THEN
      RAISE EXCEPTION '20260919130000 self-check: is_user_super_admin() refuses a password session';
    END IF;

    -- A session minted by Google.
    PERFORM set_config('request.jwt.claim.amr', c_oauth, true);
    PERFORM set_config('request.jwt.claims',
      format('{"sub":"%s","role":"authenticated","amr":%s}', v_staff, c_oauth), true);
    IF app_private.platform_staff_role_of(v_staff) IS NOT NULL THEN
      RAISE EXCEPTION '20260919130000 self-check: a Google session still holds a platform role';
    END IF;
    IF public.is_user_super_admin() IS NOT FALSE THEN
      RAISE EXCEPTION '20260919130000 self-check: is_user_super_admin() admits a Google session';
    END IF;

    -- …and the account fact underneath it is untouched. This is what the sync
    -- trigger and the profile guard's staff_flag read, and losing it would let
    -- a Google session clear its own is_super_admin.
    IF app_private.platform_staff_role_of_account(v_staff) IS NULL THEN
      RAISE EXCEPTION '20260919130000 self-check: the account fact follows the session';
    END IF;

    -- A session with no amr at all.
    PERFORM set_config('request.jwt.claim.amr', '', true);
    PERFORM set_config('request.jwt.claims',
      format('{"sub":"%s","role":"authenticated"}', v_staff), true);
    IF app_private.platform_staff_role_of(v_staff) IS NOT NULL THEN
      RAISE EXCEPTION '20260919130000 self-check: a session without amr still holds a platform role';
    END IF;

    -- The condition is the session, not the argument: a Google session reads no
    -- account's platform role, its own or anyone else's.
    PERFORM set_config('request.jwt.claim.sub', v_other::text, true);
    PERFORM set_config('request.jwt.claim.amr', c_oauth, true);
    PERFORM set_config('request.jwt.claims',
      format('{"sub":"%s","role":"authenticated","amr":%s}', v_other, c_oauth), true);
    IF app_private.platform_staff_role_of(v_staff) IS NOT NULL THEN
      RAISE EXCEPTION '20260919130000 self-check: a Google session reads another account''s platform role';
    END IF;
    IF app_private.platform_staff_role_of_account(v_staff) IS NULL THEN
      RAISE EXCEPTION '20260919130000 self-check: the account fact follows another session';
    END IF;

    -- A password session of an account that is not staff: NULL because there is
    -- no row, not because of the gate.
    PERFORM set_config('request.jwt.claim.amr', c_password, true);
    PERFORM set_config('request.jwt.claims',
      format('{"sub":"%s","role":"authenticated","amr":%s}', v_other, c_password), true);
    IF app_private.platform_staff_role_of(v_staff) IS NULL THEN
      RAISE EXCEPTION '20260919130000 self-check: a password session cannot read a staff role it is not asking about';
    END IF;

    -- 3b. audit_write() records the role the *account* holds. Asked of the
    --     gated helper it would answer NULL for exactly the caller this
    --     migration exists to record — the only row a refused session can still
    --     produce is platform_rpc_authorize's denied one — and that row would
    --     then be indistinguishable from an ordinary company user's refusal.
    --     Written inside a subtransaction that is rolled back, so the check
    --     leaves the live log untouched.
    PERFORM set_config('request.jwt.claim.sub', v_staff::text, true);
    PERFORM set_config('request.jwt.claim.amr', c_oauth, true);
    PERFORM set_config('request.jwt.claims',
      format('{"sub":"%s","role":"authenticated","amr":%s}', v_staff, c_oauth), true);
    BEGIN
      -- Into a variable first: audit_write is VOLATILE, and a volatile call left
      -- in a WHERE clause is evaluated per row scanned — one probe would become
      -- as many rows as the log is long.
      v_id := app_private.audit_write('write', 'company.set_status', 'denied');
      SELECT l.actor_role INTO v_role
        FROM app_private.platform_audit_log l
       WHERE l.id = v_id;
      IF v_role IS DISTINCT FROM app_private.platform_staff_role_of_account(v_staff) THEN
        RAISE EXCEPTION '20260919130000 self-check: audit_write records the session''s role, not the account''s (got %)',
          coalesce(v_role, 'NULL');
      END IF;
      RAISE EXCEPTION USING ERRCODE = 'ZZ010';
    EXCEPTION WHEN SQLSTATE 'ZZ010' THEN
      NULL;   -- the row is rolled back with this subtransaction
    END;
  END IF;

  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.amr', '', true);

  -- 4. Every function created or replaced here: its SECURITY DEFINER flag, a
  --    pinned search_path, an owner that can actually reach app_private, and
  --    exactly the EXECUTE grants it is meant to have. 20260916110000's shape.
  SELECT string_agg(f.sig || ': ' || f.problem, '; ') INTO v_wrong
    FROM (
      SELECT v.sig, CASE
               WHEN to_regprocedure(v.sig) IS NULL THEN 'missing'
               WHEN (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(v.sig)) IS DISTINCT FROM v.definer
                 THEN 'SECURITY DEFINER should be ' || v.definer
               WHEN NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proconfig) c(setting)
                                 WHERE p.oid = to_regprocedure(v.sig) AND c.setting LIKE 'search_path=%')
                 THEN 'no pinned search_path'
               -- These bodies reach app_private, which only its owner or a
               -- superuser can (see 20260916110010, "Ownership"). Asked of the
               -- invoker functions too: an owner is what a later ALTER could
               -- change, and CREATE OR REPLACE would keep it.
               WHEN NOT EXISTS (
                      SELECT 1
                        FROM pg_proc p
                        JOIN pg_roles r ON r.oid = p.proowner
                       WHERE p.oid = to_regprocedure(v.sig)
                         AND (r.rolsuper OR r.oid = (SELECT nspowner FROM pg_namespace WHERE nspname = 'app_private')))
                 THEN 'owner can call no app_private helper'
               WHEN has_function_privilege('anon', to_regprocedure(v.sig), 'EXECUTE') IS DISTINCT FROM v.anon
                 THEN 'anon EXECUTE should be ' || v.anon
               WHEN has_function_privilege('authenticated', to_regprocedure(v.sig), 'EXECUTE') IS DISTINCT FROM v.authn
                 THEN 'authenticated EXECUTE should be ' || v.authn
               WHEN has_function_privilege('service_role', to_regprocedure(v.sig), 'EXECUTE') IS DISTINCT FROM v.service
                 THEN 'service_role EXECUTE should be ' || v.service
             END AS problem
        FROM (VALUES
          -- signature                                          definer anon   authn  service
          ('app_private.jwt_subject_source()',                  false,  false, false, false),
          ('app_private.jwt_amr()',                             false,  false, false, false),
          ('app_private.audit_write(text,text,text,uuid,text,text,jsonb,jsonb,uuid,uuid,timestamptz)',
                                                                true,   false, false, false),
          ('app_private.jwt_has_subject()',                     false,  false, false, false),
          ('app_private.session_amr_permits_platform()',        false,  false, false, false),
          ('app_private.platform_staff_role_of_account(uuid)',  false,  false, false, false),
          ('app_private.platform_staff_role_of(uuid)',          false,  false, false, false),
          ('app_private.platform_staff_sync_profile()',         true,   false, false, false),
          ('public.enforce_user_profile_privilege_guard()',     true,   false, false, false)
        ) AS v(sig, definer, anon, authn, service)
    ) f
   WHERE f.problem IS NOT NULL;

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '20260919130000 self-check: %', v_wrong;
  END IF;
END
$selfcheck$;
