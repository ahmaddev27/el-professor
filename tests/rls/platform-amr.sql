/*
  A platform capability requires a password-backed session (20260919130000).

  The owner decided on 16.09.2026 that platform staff never sign in with
  Google. Until that migration only the browser enforced it, so a session Google
  minted for a staff account's address still passed every `platform_can()` check
  when it was used directly against PostgREST or an edge function. This file is
  what says it does not any more.

  Runs after assertions.sql, against the same throwaway database, as
  supabase_admin. Every check raises on failure; a silent run is a pass. The
  whole file is one transaction rolled back at the end, so the files after it
  see the database as the seeds left it — the RPCs probed here write audit rows.

  The principal is the seed's platform owner, `50000000-…-01`, which already has
  an `app_private.platform_staff` row. Nothing here creates a staff account: the
  point is that the *same* account holds everything through one session and
  nothing through another.

  What GoTrue v2.170.0 writes, from its source at that tag:

    password sign-in      /token?grant_type=password    token.go:220         password
    Google (both flows)   /authorize                    external.go:82,232   oauth
    SAML                  /sso/saml/acs                 samlacs.go:299       sso/saml
    POST /verify, ANY type                              verify.go:279        otp
    MFA verify                                          mfa.go               totp, appended
    refresh                                             token_refresh.go:217 unchanged

  So `otp` — not `magiclink` — is what `issueSession()` in
  supabase/functions/_shared/otp.ts mints after a verified one-time code, and a
  refresh never changes what `amr` says.

  Sections:

    1. the rule          jwt_amr() and session_amr_permits_platform() on their
                         own: every method, both claim forms, and everything
                         malformed
    2. the seam          platform_staff_role_of() answers the session, not the
                         argument; the account fact and every caller without a
                         session are untouched
   2b. the session       jwt_has_subject(), which the gate asks instead of
                         auth.uid(), in both claim forms — see its own note
    3. capabilities      an oauth session holds none of the fourteen
    4. the helpers       platform_staff_role(), platform_whoami(),
                         is_user_super_admin(), platform_can_manage_account()
    5. the RPCs          a read model, a settings read, a write RPC and
                         platform_audit_record all refuse — and the one row a
                         refused session still leaves, platform_rpc_authorize's
                         `denied`, names the role the account holds
    6. the policies      a tenant table's platform branch admits nothing
    7. the other methods otp (a code-minted session), a missing amr, sso/saml,
                         anonymous, and password beside oauth
    8. the guard         an oauth session cannot clear its own is_super_admin:
                         the profile guard reads the account, not the session
*/

\set ON_ERROR_STOP on

BEGIN;

-- ─── helpers ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION _amr_ok(p_desc text, p_ok boolean) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  -- NULL is a failure: a check that could not be evaluated proved nothing.
  IF p_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: %', p_desc;
  END IF;
  RAISE NOTICE 'ok  %', p_desc;
END $$;

/** Back to the connecting superuser with no JWT claims at all. */
CREATE OR REPLACE FUNCTION _amr_reset() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'SET LOCAL ROLE NONE';
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claim.amr', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
END $$;

/**
  Set the claims of a session without switching database role, so a check can
  call an app_private helper the way a SECURITY DEFINER function does.

  `p_amr` is the array as JSON text, or NULL for a token that carries no amr at
  all (GoTrue's `omitempty`). `p_json` chooses which document describes the
  session — **subject and amr together, never split across the two**, because
  that is the invariant `app_private.jwt_subject_source()` exists to hold:
  false writes the singular request.jwt.claim.* GUCs the kit uses elsewhere,
  true writes the one request.jwt.claims document PostgREST sets.

  Section 2b pins each form on its own, and pins what happens when both are set
  and disagree.
*/
CREATE OR REPLACE FUNCTION _amr_claims(p_user uuid, p_amr text, p_json boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_claims jsonb;
BEGIN
  PERFORM _amr_reset();
  IF p_json THEN
    v_claims := jsonb_build_object('sub', p_user, 'role', 'authenticated');
    IF p_amr IS NOT NULL THEN
      v_claims := v_claims || jsonb_build_object('amr', p_amr::jsonb);
    END IF;
    PERFORM set_config('request.jwt.claims', v_claims::text, true);
  ELSE
    PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    IF p_amr IS NOT NULL THEN
      PERFORM set_config('request.jwt.claim.amr', p_amr, true);
    END IF;
  END IF;
END $$;

/** _amr_claims, and then actually become `authenticated`. */
CREATE OR REPLACE FUNCTION _amr_become(p_user uuid, p_amr text, p_json boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _amr_claims(p_user, p_amr, p_json);
  EXECUTE 'SET LOCAL ROLE authenticated';
END $$;

/**
  Run one SELECT as that session in a subtransaction that is always rolled back,
  and return its scalar or `ERR <sqlstate> <message>`.
*/
CREATE OR REPLACE FUNCTION _amr_try(p_user uuid, p_amr text, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out   text;
  v_state text;
  v_msg   text;
BEGIN
  BEGIN
    PERFORM _amr_become(p_user, p_amr);
    EXECUTE p_sql INTO v_out;
    v_out := coalesce(v_out, '<null>');
    RAISE EXCEPTION USING ERRCODE = 'ZZ009', MESSAGE = v_out;
  EXCEPTION
    WHEN SQLSTATE 'ZZ009' THEN
      v_out := SQLERRM;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
      v_out := 'ERR ' || v_state || ' ' || v_msg;
  END;
  PERFORM _amr_reset();
  RETURN v_out;
END $$;

/** Like _amr_try, but KEEPS what the statement wrote: the audit row is the point. */
CREATE OR REPLACE FUNCTION _amr_do(p_user uuid, p_amr text, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out   text;
  v_state text;
  v_msg   text;
BEGIN
  BEGIN
    PERFORM _amr_become(p_user, p_amr);
    EXECUTE p_sql INTO v_out;
    v_out := coalesce(v_out, '<null>');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    v_out := 'ERR ' || v_state || ' ' || v_msg;
  END;
  PERFORM _amr_reset();
  RETURN v_out;
END $$;

/** The `reason` a platform write RPC answered with, or the raw answer. */
CREATE OR REPLACE FUNCTION _amr_reason(p_answer text) RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  IF left(p_answer, 4) = 'ERR ' OR p_answer = '<null>' THEN
    RETURN p_answer;
  END IF;
  RETURN coalesce(p_answer::jsonb ->> 'reason', p_answer);
EXCEPTION WHEN others THEN
  RETURN p_answer;
END $$;

-- The sessions, written once. `timestamp` is a plausible unix second; nothing
-- reads it, and that is itself worth pinning — the rule is about the method.
CREATE OR REPLACE FUNCTION _amr_password()  RETURNS text LANGUAGE sql IMMUTABLE AS
  $$ SELECT '[{"method": "password", "timestamp": 1789416052}]' $$;
CREATE OR REPLACE FUNCTION _amr_oauth()     RETURNS text LANGUAGE sql IMMUTABLE AS
  $$ SELECT '[{"method": "oauth", "timestamp": 1789416052}]' $$;
CREATE OR REPLACE FUNCTION _amr_otp()       RETURNS text LANGUAGE sql IMMUTABLE AS
  $$ SELECT '[{"method": "otp", "timestamp": 1789416052}]' $$;

-- ─── 1. the rule on its own ─────────────────────────────────────────────────

DO $$
DECLARE
  owner CONSTANT uuid := '50000000-0000-4000-8000-000000000001';
  v_case  record;
BEGIN
  -- Every method GoTrue v2.170.0 can write (internal/models/factor.go:59-91),
  -- in both claim forms. Only `password` admits.
  FOR v_case IN
    SELECT * FROM (VALUES
      ('password',     true),
      ('oauth',        false),
      ('otp',          false),
      ('totp',         false),
      ('mfa/phone',    false),
      ('mfa/webauthn', false),
      ('sso/saml',     false),
      ('recovery',     false),
      ('invite',       false),
      ('magiclink',    false),
      ('email/signup', false),
      ('email_change', false),
      ('token_refresh',false),
      ('anonymous',    false)
    ) AS t(method, admits)
  LOOP
    PERFORM _amr_claims(owner,
      format('[{"method": %s, "timestamp": 1789416052}]', to_json(v_case.method)), false);
    PERFORM _amr_ok(format('rule: singular claim, amr %s admits %s', v_case.method, v_case.admits),
      app_private.session_amr_permits_platform() = v_case.admits);

    PERFORM _amr_claims(owner,
      format('[{"method": %s, "timestamp": 1789416052}]', to_json(v_case.method)), true);
    PERFORM _amr_ok(format('rule: claims JSON, amr %s admits %s', v_case.method, v_case.admits),
      app_private.session_amr_permits_platform() = v_case.admits);
  END LOOP;

  -- Combinations. MFA *appends* to a session's amr (mfa.go), so password plus a
  -- second factor is a password session; an external provider beside password
  -- is refused whatever else the array holds.
  PERFORM _amr_claims(owner, '[{"method": "password", "timestamp": 1}, {"method": "totp", "timestamp": 2}]', true);
  PERFORM _amr_ok('rule: password plus an MFA factor is still a password session',
    app_private.session_amr_permits_platform());

  PERFORM _amr_claims(owner, '[{"method": "password", "timestamp": 1}, {"method": "oauth", "timestamp": 2}]', true);
  PERFORM _amr_ok('rule: oauth beside password is refused',
    app_private.session_amr_permits_platform() = false);

  PERFORM _amr_claims(owner, '[{"method": "oauth", "timestamp": 1}, {"method": "password", "timestamp": 2}]', true);
  PERFORM _amr_ok('rule: the order of the entries does not matter',
    app_private.session_amr_permits_platform() = false);

  -- A bare-string entry, the shape OIDC's own amr uses.
  PERFORM _amr_claims(owner, '["password"]', true);
  PERFORM _amr_ok('rule: a bare-string entry is read as a method',
    app_private.session_amr_permits_platform());
  PERFORM _amr_claims(owner, '["oauth"]', true);
  PERFORM _amr_ok('rule: a bare-string oauth entry is refused',
    app_private.session_amr_permits_platform() = false);

  -- Nothing here may raise, and nothing may answer NULL.
  PERFORM _amr_claims(owner, NULL, true);
  PERFORM _amr_ok('rule: a token with no amr at all is refused',
    app_private.session_amr_permits_platform() = false AND app_private.jwt_amr() IS NULL);

  PERFORM _amr_claims(owner, '[]', true);
  PERFORM _amr_ok('rule: an empty amr is refused',
    app_private.session_amr_permits_platform() = false);

  PERFORM _amr_claims(owner, '[1, true, null, {"no_method": "x"}]', true);
  PERFORM _amr_ok('rule: entries that name no method are ignored, not an error',
    app_private.session_amr_permits_platform() = false);

  PERFORM _amr_reset();
  PERFORM set_config('request.jwt.claims',
    format('{"sub": "%s", "role": "authenticated", "amr": "password"}', owner), true);
  PERFORM _amr_ok('rule: an amr that is not an array is refused',
    app_private.session_amr_permits_platform() = false AND app_private.jwt_amr() IS NULL);

  PERFORM _amr_reset();
  PERFORM set_config('request.jwt.claims', 'not json at all', true);
  PERFORM _amr_ok('rule: claims that are not JSON are refused, not an error',
    app_private.session_amr_permits_platform() = false AND app_private.jwt_amr() IS NULL);

  PERFORM _amr_reset();
  PERFORM set_config('request.jwt.claim.amr', 'not json at all', true);
  PERFORM _amr_ok('rule: a singular claim that is not JSON is refused, not an error',
    app_private.session_amr_permits_platform() = false AND app_private.jwt_amr() IS NULL);

  PERFORM _amr_reset();
  PERFORM _amr_ok('rule: a caller with no claims at all is refused',
    app_private.session_amr_permits_platform() = false);

  -- The form a request actually carries wins. jwt_amr() reads
  -- request.jwt.claims first precisely so the kit's singular affordance can
  -- never raise a real session's authority.
  PERFORM _amr_reset();
  PERFORM set_config('request.jwt.claim.amr', _amr_password(), true);
  PERFORM set_config('request.jwt.claims',
    format('{"sub": "%s", "role": "authenticated", "amr": %s}', owner, _amr_oauth()), true);
  PERFORM _amr_ok('rule: the claims document wins over the singular claim',
    app_private.session_amr_permits_platform() = false);

  PERFORM _amr_reset();
END $$;

-- ─── 2. the seam: the caller's session, not the argument ────────────────────

DO $$
DECLARE
  owner   CONSTANT uuid := '50000000-0000-4000-8000-000000000001';
  admin_a CONSTANT uuid := 'a0000000-0000-4000-8000-000000000001';
BEGIN
  -- No token at all: a trigger, a migration, GoTrue. This is the case that must
  -- not break, and the reason the gate asks whether there is a session rather
  -- than asking "is this session password-backed" on its own.
  PERFORM _amr_reset();
  PERFORM _amr_ok('seam: a caller with no session still reads the staff role',
    app_private.platform_staff_role_of(owner) = 'owner');

  -- The service role: a JWT with a role and no subject.
  PERFORM _amr_reset();
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM _amr_ok('seam: the service role still reads the staff role',
    app_private.platform_staff_role_of(owner) = 'owner');

  -- The caller's own password session.
  PERFORM _amr_claims(owner, _amr_password(), true);
  PERFORM _amr_ok('seam: a password session holds its own role',
    app_private.platform_staff_role_of(owner) = 'owner');

  -- The caller's own Google session.
  PERFORM _amr_claims(owner, _amr_oauth(), true);
  PERFORM _amr_ok('seam: a Google session holds none of its own role',
    app_private.platform_staff_role_of(owner) IS NULL);

  -- …and the account fact is unchanged underneath it. This is what the profile
  -- guard and the sync trigger read.
  PERFORM _amr_ok('seam: the account fact is not touched by the session',
    app_private.platform_staff_role_of_account(owner) = 'owner');

  -- The condition is the session, not the argument. A Google session exercises
  -- no platform authority for *any* account — asking about somebody else is not
  -- a way round it — while the account fact stays readable for the two triggers
  -- that ask about a row.
  PERFORM _amr_claims(admin_a, _amr_oauth(), true);
  PERFORM _amr_ok('seam: a Google session reads no account''s platform role, not even another''s',
    app_private.platform_staff_role_of(owner) IS NULL);
  PERFORM _amr_ok('seam: and the account fact is still readable underneath it',
    app_private.platform_staff_role_of_account(owner) = 'owner');

  -- A password session that is not staff reads the fact as before: the gate did
  -- not fire, so the NULL below is "no staff row", not "no authority".
  PERFORM _amr_claims(admin_a, _amr_password(), true);
  PERFORM _amr_ok('seam: a password session reads the staff row it is not asking about',
    app_private.platform_staff_role_of(owner) = 'owner');
  PERFORM _amr_ok('seam: a company admin holds no role, password session or not',
    app_private.platform_staff_role_of(admin_a) IS NULL);

  PERFORM _amr_reset();
  PERFORM _amr_ok('seam: a NULL account id answers NULL',
    app_private.platform_staff_role_of(NULL) IS NULL
    AND app_private.platform_staff_role_of_account(NULL) IS NULL);
END $$;

-- ─── 2b. the other half of the condition: is there a session at all? ────────

/*
  `jwt_has_subject()` is what the gate asks instead of `auth.uid()`. That is not
  a style choice: `auth.uid()` is not ours, its body differs between the
  supabase/postgres image (singular claim only) and the live databases (both),
  and the first version of this migration hung the gate on `p_user_id =
  auth.uid()` — a three-valued comparison that came back NULL here, so the
  `AND` was NULL, the `IF` never fired, and a Google session kept its platform
  role while every pure-rule assertion around it passed. Both claim forms are
  pinned separately below so that cannot come back quietly.

  The second half of this section pins the symmetry: the `amr` is read out of
  the same document the subject came from, so the session the rest of the schema
  resolves the caller as and the sign-in method judged here can never be two
  different sessions.
*/
DO $$
DECLARE
  owner   CONSTANT uuid := '50000000-0000-4000-8000-000000000001';
  admin_a CONSTANT uuid := 'a0000000-0000-4000-8000-000000000001';
BEGIN
  PERFORM _amr_reset();
  PERFORM _amr_ok('session: no claims at all is not a session',
    app_private.jwt_has_subject() = false);

  PERFORM _amr_reset();
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM _amr_ok('session: the service role is not a session — its key carries a role and no sub',
    app_private.jwt_has_subject() = false);

  PERFORM _amr_reset();
  PERFORM set_config('request.jwt.claims', '{"role": "anon"}', true);
  PERFORM _amr_ok('session: the anon key is not a session',
    app_private.jwt_has_subject() = false);

  -- Each form on its own, because only one of them reaches auth.uid() here.
  PERFORM _amr_reset();
  PERFORM set_config('request.jwt.claim.sub', owner::text, true);
  PERFORM _amr_ok('session: the singular claim alone is a session',
    app_private.jwt_has_subject());

  PERFORM _amr_reset();
  PERFORM set_config('request.jwt.claims',
    format('{"sub": "%s", "role": "authenticated"}', owner), true);
  PERFORM _amr_ok('session: the claims document alone is a session',
    app_private.jwt_has_subject());

  -- …and so the gate fires from the claims document alone, which is the exact
  -- case the first version of this file failed on.
  PERFORM set_config('request.jwt.claims',
    format('{"sub": "%s", "role": "authenticated", "amr": %s}', owner, _amr_oauth()), true);
  PERFORM _amr_ok('session: a Google session set only through the claims document is still refused',
    app_private.platform_staff_role_of(owner) IS NULL);

  -- A subject that is not a uuid is still a session: parsing it would turn a
  -- malformed token into "no token", and fail open.
  PERFORM _amr_reset();
  PERFORM set_config('request.jwt.claims', '{"sub": "not-a-uuid", "role": "authenticated"}', true);
  PERFORM _amr_ok('session: a malformed subject is still a session',
    app_private.jwt_has_subject());
  PERFORM _amr_ok('session: …and it holds no platform role',
    app_private.platform_staff_role_of(owner) IS NULL);

  -- An empty subject is not one.
  PERFORM _amr_reset();
  PERFORM set_config('request.jwt.claims', '{"sub": "", "role": "authenticated"}', true);
  PERFORM _amr_ok('session: an empty subject is not a session',
    app_private.jwt_has_subject() = false);

  -- Claims that are not JSON: the singular claim still decides, and nothing raises.
  PERFORM _amr_reset();
  PERFORM set_config('request.jwt.claims', 'not json at all', true);
  PERFORM set_config('request.jwt.claim.sub', owner::text, true);
  PERFORM _amr_ok('session: malformed claims do not lose the singular subject',
    app_private.jwt_has_subject());
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM _amr_ok('session: malformed claims alone are not a session',
    app_private.jwt_has_subject() = false);

  /*
    The symmetry the two helpers exist for: the amr is read out of the document
    the **subject** came from, never out of the other one.

    Without it the two could describe different sessions wherever both forms are
    set — which is only ever the RLS kit, since PostgREST sets the document
    alone, but "only in the kit" is where this migration's first defect lived
    too. The singular claim wins, which is the order `auth.uid()` checks in both
    of its known bodies, so the session every capability lookup resolves the
    caller as and the sign-in method judged here are always the same session.
  */
  PERFORM _amr_reset();
  PERFORM set_config('request.jwt.claim.sub', owner::text, true);
  PERFORM set_config('request.jwt.claim.amr', _amr_password(), true);
  PERFORM set_config('request.jwt.claims',
    format('{"sub": "%s", "role": "authenticated", "amr": %s}', admin_a, _amr_oauth()), true);
  PERFORM _amr_ok('symmetry: the singular subject wins, as it does for auth.uid()',
    app_private.jwt_subject_source() = 'claim');
  PERFORM _amr_ok('symmetry: …so the singular amr is the one judged',
    app_private.session_amr_permits_platform());
  PERFORM _amr_ok('symmetry: and the owner keeps the role that session established',
    app_private.platform_staff_role_of(owner) = 'owner');

  -- Take the singular subject away and the document becomes the session, amr
  -- and all: the singular amr does not outlive the subject it belonged to.
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM _amr_ok('symmetry: without a singular subject the document is the session',
    app_private.jwt_subject_source() = 'claims');
  PERFORM _amr_ok('symmetry: …and the singular amr no longer counts',
    app_private.session_amr_permits_platform() = false);
  PERFORM _amr_ok('symmetry: so the owner holds nothing through it',
    app_private.platform_staff_role_of(owner) IS NULL);

  -- An amr with no subject beside it describes no session, so there is no amr
  -- to read. This is the shape an independent jwt_amr() would have admitted.
  PERFORM _amr_reset();
  PERFORM set_config('request.jwt.claims',
    format('{"role": "authenticated", "amr": %s}', _amr_password()), true);
  PERFORM _amr_ok('symmetry: an amr with no subject is not a session''s amr',
    app_private.jwt_amr() IS NULL AND app_private.session_amr_permits_platform() = false);

  /*
    storage-api's shape (20260920100000): the singular subject, no singular
    amr, and the whole payload as the document. Both come from one token, so
    the document's amr is that session's — but only when the document names
    the same subject. Before that migration this read as no amr at all, and
    every platform account held no role on every storage-api request.
  */
  PERFORM _amr_reset();
  PERFORM set_config('request.jwt.claim.sub', owner::text, true);
  PERFORM set_config('request.jwt.claims',
    format('{"sub": "%s", "role": "authenticated", "amr": %s}', owner, _amr_password()), true);
  PERFORM _amr_ok('storage-api: the singular subject is still the source',
    app_private.jwt_subject_source() = 'claim');
  PERFORM _amr_ok('storage-api: …and with no singular amr, the same subject''s document amr is read',
    app_private.session_amr_permits_platform()
    AND app_private.platform_staff_role_of(owner) = 'owner');

  PERFORM set_config('request.jwt.claims',
    format('{"sub": "%s", "role": "authenticated", "amr": %s}', owner, _amr_oauth()), true);
  PERFORM _amr_ok('storage-api: a Google session in that shape is still refused',
    app_private.session_amr_permits_platform() = false
    AND app_private.platform_staff_role_of(owner) IS NULL);

  PERFORM set_config('request.jwt.claims',
    format('{"sub": "%s", "role": "authenticated", "amr": %s}', admin_a, _amr_password()), true);
  PERFORM _amr_ok('storage-api: a document naming another subject lends its amr to nobody',
    app_private.jwt_amr() IS NULL
    AND app_private.platform_staff_role_of(owner) IS NULL);

  PERFORM set_config('request.jwt.claims',
    format('{"sub": "%s", "role": "authenticated", "amr": %s}', owner, _amr_password()), true);
  PERFORM set_config('request.jwt.claim.amr', 'not json at all', true);
  PERFORM _amr_ok('storage-api: a singular amr that is present but broken does not fall back',
    app_private.jwt_amr() IS NULL AND app_private.session_amr_permits_platform() = false);

  PERFORM _amr_reset();
END $$;

-- ─── 3. an oauth session holds none of the fourteen capabilities ────────────

DO $$
DECLARE
  owner CONSTANT uuid := '50000000-0000-4000-8000-000000000001';
  v_cap text;
  v_held integer;
BEGIN
  -- First, that this account really does hold something: a check that refused
  -- everything for both sessions would prove nothing.
  v_held := 0;
  FOR v_cap IN SELECT DISTINCT capability FROM app_private.platform_capability_matrix() ORDER BY 1 LOOP
    IF _amr_try(owner, _amr_password(), format('SELECT platform_can(%L)::text', v_cap)) = 'true' THEN
      v_held := v_held + 1;
    END IF;
  END LOOP;
  PERFORM _amr_ok('capabilities: the password session holds every capability the owner role has',
    v_held = (SELECT count(DISTINCT capability)
                FROM app_private.platform_capability_matrix() WHERE role = 'owner'));

  FOR v_cap IN SELECT DISTINCT capability FROM app_private.platform_capability_matrix() ORDER BY 1 LOOP
    PERFORM _amr_ok(format('capabilities: a Google session holds no %s', v_cap),
      _amr_try(owner, _amr_oauth(), format('SELECT platform_can(%L)::text', v_cap)) = 'false');
  END LOOP;

  -- Not NULL, and not an error: platform_can is written into RLS policies, and
  -- a policy denies on NULL as on false, which is exactly how a wrong answer
  -- goes unnoticed.
  PERFORM _amr_ok('capabilities: platform_can answers false, never NULL',
    _amr_try(owner, _amr_oauth(), 'SELECT (platform_can(''staff.manage'') IS NOT NULL)::text') = 'true');
END $$;

-- ─── 4. the helpers the browser and the edge functions ask ──────────────────

DO $$
DECLARE
  owner   CONSTANT uuid := '50000000-0000-4000-8000-000000000001';
  admin_a CONSTANT uuid := 'a0000000-0000-4000-8000-000000000001';
  v_who   jsonb;
BEGIN
  PERFORM _amr_ok('helpers: platform_staff_role() is owner for a password session',
    _amr_try(owner, _amr_password(), 'SELECT platform_staff_role()') = 'owner');
  PERFORM _amr_ok('helpers: platform_staff_role() is NULL for a Google session',
    _amr_try(owner, _amr_oauth(), 'SELECT platform_staff_role()') = '<null>');

  v_who := _amr_try(owner, _amr_password(), 'SELECT platform_whoami()::text')::jsonb;
  PERFORM _amr_ok('helpers: platform_whoami() reports the role for a password session',
    v_who ->> 'role' = 'owner' AND jsonb_array_length(v_who -> 'capabilities') > 0);

  v_who := _amr_try(owner, _amr_oauth(), 'SELECT platform_whoami()::text')::jsonb;
  PERFORM _amr_ok('helpers: platform_whoami() reports no role for a Google session',
    v_who ->> 'role' IS NULL AND v_who -> 'capabilities' = '[]'::jsonb);

  -- is_user_super_admin() is "has an active staff row". It gates
  -- create_user_profile_manual and routes the browser, so it has to refuse too.
  PERFORM _amr_ok('helpers: is_user_super_admin() is true for a password session',
    _amr_try(owner, _amr_password(), 'SELECT is_user_super_admin()::text') = 'true');
  PERFORM _amr_ok('helpers: is_user_super_admin() is false — not NULL — for a Google session',
    _amr_try(owner, _amr_oauth(), 'SELECT is_user_super_admin()::text') = 'false');

  PERFORM _amr_ok('helpers: platform_can_manage_account() is true for a password session',
    _amr_try(owner, _amr_password(), format('SELECT platform_can_manage_account(%L)::text', admin_a)) = 'true');
  PERFORM _amr_ok('helpers: platform_can_manage_account() is false for a Google session',
    _amr_try(owner, _amr_oauth(), format('SELECT platform_can_manage_account(%L)::text', admin_a)) = 'false');
END $$;

-- ─── 5. the RPCs a platform screen and an edge function call ────────────────

DO $$
DECLARE
  owner   CONSTANT uuid := '50000000-0000-4000-8000-000000000001';
  admin_a CONSTANT uuid := 'a0000000-0000-4000-8000-000000000001';
  co_a    CONSTANT uuid := 'c0000000-0000-4000-8000-00000000000a';
  v_rows  bigint;
  v_role  text;
BEGIN
  -- An audited read model. A refusal is a return value, so the denied row can
  -- still be written; for a caller with no role there is no row at all.
  PERFORM _amr_ok('rpc: platform_companies_list answers for a password session',
    (_amr_try(owner, _amr_password(), 'SELECT platform_companies_list()::text')::jsonb ->> 'ok') = 'true');
  PERFORM _amr_ok('rpc: platform_companies_list refuses a Google session',
    _amr_try(owner, _amr_oauth(), 'SELECT platform_companies_list()::text')::jsonb
      = '{"ok": false, "reason": "not_authorized"}'::jsonb);

  -- A settings read: `forbidden` is what a caller who is not staff is told.
  PERFORM _amr_ok('rpc: platform_settings_get answers for a password session',
    (_amr_try(owner, _amr_password(), 'SELECT platform_settings_get(''price_book'')::text')::jsonb ->> 'ok') = 'true');
  PERFORM _amr_ok('rpc: platform_settings_get refuses a Google session',
    (_amr_try(owner, _amr_oauth(), 'SELECT platform_settings_get(''price_book'')::text')::jsonb ->> 'reason') = 'forbidden');

  -- A platform write.
  PERFORM _amr_ok('rpc: a platform write refuses a Google session',
    _amr_reason(_amr_try(owner, _amr_oauth(),
      format('SELECT platform_company_set_status(%L, ''active'')::text', co_a))) = 'denied');

  /*
    …and the `denied` row it leaves names the role the account holds.

    This is the one row a refused session can still produce: platform_rpc_authorize
    (20260916130000:209-222) writes it for *any* actor, staff or not. Left on the
    gated helper, audit_write would have stamped it NULL — and the log is read by
    role, so a platform account probing the write RPCs from a Google session
    would have been indistinguishable from an ordinary company user being
    refused, on exactly the event this migration exists to record. `actor_role`
    is a fact about the actor (20260916110000: "the actor's role is always looked
    up here, never passed"), so it reads platform_staff_role_of_account().

    _amr_do, not _amr_try: the row is the point, and _amr_try would roll it back.
  */
  PERFORM _amr_do(owner, _amr_oauth(),
    format('SELECT platform_company_set_status(%L, ''active'')::text', co_a));
  PERFORM _amr_reset();
  SELECT l.actor_role INTO v_role
    FROM app_private.platform_audit_log l
   WHERE l.actor_user_id = owner
     AND l.action = 'company.set_status'
     AND l.outcome = 'denied'
   ORDER BY l.id DESC
   LIMIT 1;
  PERFORM _amr_ok('rpc: the refused Google session''s denied row names the account''s role, not NULL',
    v_role = 'owner');

  -- And a company admin refused the same way is still told apart from it: same
  -- row shape, no role, which is what the column would have said for both if
  -- audit_write had been left on the gated helper.
  PERFORM _amr_do(admin_a, _amr_password(),
    format('SELECT platform_company_set_status(%L, ''active'')::text', co_a));
  PERFORM _amr_reset();
  -- The row has to exist for its NULL role to mean anything: `SELECT … INTO`
  -- leaves the variable alone when nothing matches, so "no row" would read as
  -- "a row with no role".
  SELECT count(*) INTO v_rows
    FROM app_private.platform_audit_log l
   WHERE l.actor_user_id = admin_a
     AND l.action = 'company.set_status'
     AND l.outcome = 'denied';
  SELECT l.actor_role INTO v_role
    FROM app_private.platform_audit_log l
   WHERE l.actor_user_id = admin_a
     AND l.action = 'company.set_status'
     AND l.outcome = 'denied'
   ORDER BY l.id DESC
   LIMIT 1;
  PERFORM _amr_ok('rpc: a company admin''s denied row exists and still carries no role',
    v_rows > 0 AND v_role IS NULL);

  -- The edge functions' audit door. It writes for staff and answers NULL for
  -- anyone else — so a Google session cannot even file a row in its own name.
  -- _amr_do keeps what the statement wrote, because the row is the point: with
  -- _amr_try's rollback the count below would be zero whatever happened.
  PERFORM _amr_ok('rpc: platform_audit_record answers NULL for a Google session',
    _amr_do(owner, _amr_oauth(),
      'SELECT platform_audit_record(''write'', ''activation_code.generate'', ''ok'')::text') = '<null>');

  PERFORM _amr_reset();
  SELECT count(*) INTO v_rows
    FROM app_private.platform_audit_log l
   WHERE l.actor_user_id = owner
     AND l.action = 'activation_code.generate';
  PERFORM _amr_ok('rpc: and it wrote no row', v_rows = 0);

  -- The same call from the password session does write one, so the zero above
  -- is the amr rule and not a broken probe.
  PERFORM _amr_ok('rpc: platform_audit_record writes for the password session',
    _amr_do(owner, _amr_password(),
      'SELECT platform_audit_record(''write'', ''activation_code.generate'', ''ok'')::text') <> '<null>');

  PERFORM _amr_reset();
  SELECT count(*) INTO v_rows
    FROM app_private.platform_audit_log l
   WHERE l.actor_user_id = owner
     AND l.action = 'activation_code.generate'
     AND l.actor_role = 'owner';
  PERFORM _amr_ok('rpc: with the role the session may exercise', v_rows = 1);
END $$;

-- ─── 6. the tenant policies' platform branch ────────────────────────────────

DO $$
DECLARE
  owner CONSTANT uuid := '50000000-0000-4000-8000-000000000001';
  v_seam_open boolean;
BEGIN
  -- `drivers` is a plain business table: SELECT is the tenant term OR
  -- platform_reads_company_data(). The platform owner has no company, so the
  -- tenant term is NULL for it and only the platform branch can admit anything.
  PERFORM _amr_ok('policies: the platform read seam is closed for a Google session',
    _amr_try(owner, _amr_oauth(), 'SELECT platform_reads_company_data()::text') = 'false');
  PERFORM _amr_ok('policies: a Google session reads no company''s drivers',
    _amr_try(owner, _amr_oauth(), 'SELECT count(*)::text FROM drivers') = '0');

  -- The capability itself, which is what platform_reads_company_data() asks
  -- today and what 3.4 replaces it with.
  PERFORM _amr_ok('policies: a password session still holds business.read',
    _amr_try(owner, _amr_password(), 'SELECT platform_can(''business.read'')::text') = 'true');

  -- The comparison only means something while the seam is open. After plan 3.4
  -- (20260917140000) it is a constant false and a password session reads no
  -- other company's rows either — which is that slice's own subject, not this
  -- file's.
  v_seam_open := _amr_try(owner, _amr_password(), 'SELECT platform_reads_company_data()::text') = 'true';
  IF v_seam_open THEN
    PERFORM _amr_ok('policies: a password session does read them, so the 0 above is the amr rule',
      _amr_try(owner, _amr_password(), 'SELECT count(*)::text FROM drivers') <> '0');
  ELSE
    RAISE NOTICE 'note  the platform read seam is already closed (plan 3.4); the drivers comparison is skipped';
  END IF;
END $$;

-- ─── 7. the sessions that are not Google either ─────────────────────────────

DO $$
DECLARE
  owner CONSTANT uuid := '50000000-0000-4000-8000-000000000001';
BEGIN
  /*
    The chosen rule is an allow-list of `password`, not a deny-list of `oauth`.
    So a session minted by POST /verify — `otp`, whatever the type was — holds
    nothing either. That is deliberate and it is the rule's one cost: a newly
    invited platform member activates with an invite_activate code and a member
    who used "Passwort vergessen" arrives the same way, and both must sign in
    with the password they have just chosen. SetPasswordPage ends such a session
    itself and sends the account to /admin/login.
  */
  PERFORM _amr_ok('other: a code-minted session (POST /verify -> otp) holds no role',
    _amr_try(owner, _amr_otp(), 'SELECT platform_staff_role()') = '<null>');
  PERFORM _amr_ok('other: a code-minted session holds no capability',
    _amr_try(owner, _amr_otp(), 'SELECT platform_can(''staff.manage'')::text') = 'false');

  -- A token with no amr at all: GoTrue's omitempty, or an issuer that never
  -- wrote one. Fail closed.
  PERFORM _amr_ok('other: a session with no amr holds no role',
    _amr_try(owner, NULL, 'SELECT platform_staff_role()') = '<null>');
  PERFORM _amr_ok('other: a session with no amr holds no capability',
    _amr_try(owner, NULL, 'SELECT platform_can(''staff.manage'')::text') = 'false');

  PERFORM _amr_ok('other: an SSO session holds no role',
    _amr_try(owner, '[{"method": "sso/saml", "timestamp": 1, "provider": "acme"}]',
             'SELECT platform_staff_role()') = '<null>');
  PERFORM _amr_ok('other: an anonymous session holds no role',
    _amr_try(owner, '[{"method": "anonymous", "timestamp": 1}]', 'SELECT platform_staff_role()') = '<null>');

  -- A second factor does not make a code session a password one.
  PERFORM _amr_ok('other: otp plus totp is still not a password session',
    _amr_try(owner, '[{"method": "otp", "timestamp": 1}, {"method": "totp", "timestamp": 2}]',
             'SELECT platform_staff_role()') = '<null>');
  -- …and it does not take one away.
  PERFORM _amr_ok('other: password plus totp keeps the role',
    _amr_try(owner, '[{"method": "password", "timestamp": 1}, {"method": "totp", "timestamp": 2}]',
             'SELECT platform_staff_role()') = 'owner');
END $$;

-- ─── 8. the profile guard reads the account, not the session ────────────────

DO $$
DECLARE
  owner CONSTANT uuid := '50000000-0000-4000-8000-000000000001';
  v_out text;
BEGIN
  /*
    `staff_flag` in enforce_user_profile_privilege_guard() is what stops a JWT
    setting is_super_admin to anything but what platform_staff says. It is about
    the row being written, so it reads the ungated account fact: on the gated
    helper a platform account signing in with Google would read its own staff
    row as absent and could clear its own routing hint, and the next reader
    would believe it.

    user_profiles_update admits `user_id = auth.uid()`, so RLS lets this
    statement reach the trigger; the trigger is what must refuse it.
  */
  v_out := _amr_try(owner, _amr_oauth(),
    format($q$UPDATE user_profiles SET is_super_admin = false WHERE user_id = %L RETURNING 'written'$q$, owner));
  PERFORM _amr_ok('guard: a Google session cannot clear its own is_super_admin',
    v_out LIKE 'ERR P0001 Not allowed: cannot modify is_super_admin%');

  v_out := _amr_try(owner, _amr_password(),
    format($q$UPDATE user_profiles SET is_super_admin = false WHERE user_id = %L RETURNING 'written'$q$, owner));
  PERFORM _amr_ok('guard: nor can a password session — the flag follows platform_staff either way',
    v_out LIKE 'ERR P0001 Not allowed: cannot modify is_super_admin%');

  PERFORM _amr_reset();
  PERFORM _amr_ok('guard: the flag is still set',
    (SELECT is_super_admin FROM user_profiles WHERE user_id = owner));
END $$;

ROLLBACK;
