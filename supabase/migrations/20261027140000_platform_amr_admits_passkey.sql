/*
  20261027140000 — a passkey carries platform rights, exactly as a password does.

  The owner's decision, 27.10.2026: *"الباس كي زي الباس بورد للادمن وللشركات
  ولاي اشي؟ اعمل الصح"* — a passkey is like a password, for platform admins, for
  companies, for everything.

  ## Why this is the rule applied, not the rule weakened

  Read `20260919130000`'s allow-list as "password specifically" and this change
  looks like a hole being opened. It was never that. Each entry on the refusal
  list is refused for a reason about **what the method proves**, and none of
  those reasons reaches a passkey:

    oauth, sso/saml   a third party controls the identity. The owner's decision
                      of 16.09.2026 is that a platform account never signs in
                      through one, and that is about who vouches for the
                      account, not about how many factors were used.
    otp               a code mailed to an address proves control of a *mailbox*
                      at that moment. It does not prove knowledge of the
                      account's own secret, which is exactly why a session
                      minted by `POST /verify` holds no platform capability.
    anonymous         there is no identity to carry a right.

  A passkey is a WebAuthn credential: **device-bound and phishing-resistant**,
  held by the authenticator rather than typed into whatever page asked for it.
  The private key never leaves the device, the assertion is signed over a
  challenge this server minted, and the origin is bound into the signature — so
  it cannot be replayed against another site and cannot be read out of a user by
  a convincing imitation of our login page. Against the one it stands beside, a
  password, it is **strictly stronger on every axis the refusal list cares
  about**. Admitting it is the rule being applied to a method that satisfies it.

  **So the next person to read `session_amr_permits_platform()` must not have to
  re-derive why one method was added and three stay out.** That is what the
  paragraph above is for; do not compress it away.

  ## What does NOT change, and why each still has to be there

  - **The three refusals stay.** `oauth`, `sso/saml` and `anonymous` are still
    refused outright, for the reasons above. This migration adds one name to the
    permitted list and touches nothing else in the body.

  - **It stays an allow-list.** MFA *appends* to a session's `amr`
    (`AddClaimToSession` is called a second time on the same session by
    `updateMFASessionAndClaims`), so `["passkey", "totp"]` is a legitimate
    array and "contains passkey" is the right test — never "equals passkey".
    By the same token a refused method anywhere in the array still refuses the
    whole session, which is what stops `["password", "oauth"]` passing.

  - **A passkey session is AAL1, like a password session.** GoTrue's
    `IsAAL2Claim()` names `totp`, `mfa/phone`, `mfa/webauthn` and
    `mfa/recovery_code`; `PasskeyLogin` is deliberately not among them. So this
    does not quietly raise or lower any assurance level — nothing in this
    codebase reads `aal`, and this rule reads `amr`.

  - **`mfa/webauthn` is a different method and stays refused on its own.** It is
    a security key used as a *second* factor on an existing session
    (`AMREntry.Method = "mfa/webauthn"`), where `passkey` is a primary sign-in.
    A session holding only `mfa/webauthn` cannot exist in practice, but if one
    did it would prove a second factor with no first one, so it admits nothing.

  ## The string is `passkey`, measured from GoTrue's source

  `internal/models/factor.go` at v2.188.0 and at v2.197.0:

      case PasskeyLogin:
          return "passkey"

  and the mirror, `case "passkey": return PasskeyLogin, nil`. Not `webauthn`,
  which is nothing, and not `mfa/webauthn`, which is the second-factor method
  above. `PasskeyAuthenticationVerify` issues the session through
  `IssueRefreshToken`, which creates a **new** session and adds that **single**
  claim — it does not append to a password session — so a passkey sign-in's
  `amr` is exactly `[{"method": "passkey", "timestamp": <sign-in>}]` with no
  `password` entry anywhere. That is why this migration is required before
  `PASSKEY_SIGNIN_ENABLED` may be turned on at all, and why `deploy.sh` refuses
  the switch until it is applied.

  ## This migration is inert until passkeys are enabled, and that is deliberate

  No GoTrue in this stack can mint a `passkey` session today: the image is older
  than v2.188.0 and the feature switch ships off. So applying this changes the
  answer for **no session that can currently exist** — it is the precondition
  being satisfied ahead of the feature, not a behaviour change. `deploy.sh`'s
  passkey guard reads this file's text, so the two move together.

  ## Rollback

  Safe across a rollback with no epoch bump. The previous release's function
  body differs only by this one array element, and a passkey session it would
  refuse cannot be minted by the GoTrue either release runs. Nothing else in
  the chain reads the permitted list.
*/

-- ─── The rule ───────────────────────────────────────────────────────────────

/*
  20260919130000's body with one name added to `c_permitted`, and every other
  line carried over character for character: the same two CONSTANTs at the top,
  the same string-or-object entry read, the same early return on a refused
  method, the same `v_ok` accumulation, the same handler.

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
  -- The sign-ins that carry platform rights. GoTrue writes `password` for
  -- /token?grant_type=password (internal/api/token.go) and `passkey` for the
  -- passkey verify route (internal/models/factor.go, PasskeyLogin). Both are a
  -- primary sign-in proving the account's own secret; see this file's header
  -- for why a passkey satisfies the rule rather than relaxing it.
  c_permitted CONSTANT text[] := ARRAY['password', 'passkey'];
  -- Refused whatever else the array holds: MFA appends to a session's amr, so
  -- "contains password" alone would accept a session that also names an
  -- external identity provider. The owner's decision of 16.09.2026 is that a
  -- platform account never signs in through one. `otp` is refused by omission
  -- rather than by name, as it always was: a code proves a mailbox.
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
  'True only for a session GoTrue established with a password or a passkey, and '
  'never for one that also names oauth, sso/saml or anonymous. False for a '
  'missing or malformed amr and for a caller with no JWT. Never NULL, never raises.';

-- ─── Self-check ─────────────────────────────────────────────────────────────

/*
  Fails the release if the rule is lost. Three kinds of check, because each
  catches something the others cannot:

    1. the catalogue — the function's declaration is still what it must be
    2. the text      — both permitted methods and all three refusals are named
                       in the live body, and it still reads jwt_amr()
    3. the behaviour — the function actually answers correctly, per method and
                       per combination

  The behavioural section sets the request GUCs with `set_config(..., true)`,
  so they are transaction-local and gone at commit. It is the one that would
  catch a body that names `passkey` in a comment and not in the array.
*/
DO $$
DECLARE
  v_src     text;
  v_case    record;
  v_frag    text;
  v_missing text[] := ARRAY[]::text[];
BEGIN
  -- 1. the catalogue
  PERFORM 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_language l ON l.oid = p.prolang
   WHERE n.nspname = 'app_private'
     AND p.proname = 'session_amr_permits_platform'
     AND p.pronargs = 0
     AND l.lanname = 'plpgsql'
     AND p.provolatile = 's'
     AND p.proconfig @> ARRAY['search_path=pg_catalog, public'];
  IF NOT FOUND THEN
    RAISE EXCEPTION 'self-check 1: app_private.session_amr_permits_platform() is not a zero-argument STABLE plpgsql function with a pinned search_path';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'app_private' AND p.proname = 'session_amr_permits_platform';

  -- 2. the text. Each fragment is load-bearing: the two permitted names, the
  -- three refusals, the jwt_amr() call the whole rule reads through, and the
  -- string-or-object entry read that makes a bare-string amr legible.
  FOREACH v_frag IN ARRAY ARRAY[
    '''password''',
    '''passkey''',
    '''oauth''',
    '''sso/saml''',
    '''anonymous''',
    'app_private.jwt_amr()',
    'jsonb_array_elements',
    'WHEN ''string'' THEN',
    'WHEN ''object'' THEN',
    'c_refused',
    'c_permitted'
  ] LOOP
    IF position(v_frag IN v_src) = 0 THEN
      v_missing := v_missing || v_frag;
    END IF;
  END LOOP;
  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION 'self-check 2: app_private.session_amr_permits_platform() no longer names %', array_to_string(v_missing, ', ');
  END IF;

  -- The permitted list must be exactly these two. A third name added here is a
  -- decision about authority and belongs in a migration of its own, with its
  -- own reasoning, not in a body somebody widened in passing.
  IF position('ARRAY[''password'', ''passkey'']' IN v_src) = 0 THEN
    RAISE EXCEPTION 'self-check 2b: the permitted list is not exactly ARRAY[''password'', ''passkey'']';
  END IF;

  -- 3. the behaviour, per method. Eighteen methods: the fourteen GoTrue
  -- v2.170.0 could write, plus the four added since (mfa/recovery_code, web3,
  -- oauth_provider/authorization_code and passkey itself). Only the two
  -- permitted names admit.
  FOR v_case IN
    SELECT * FROM (VALUES
      ('password',                         true),
      ('passkey',                          true),
      ('oauth',                            false),
      ('otp',                              false),
      ('totp',                             false),
      ('mfa/phone',                        false),
      ('mfa/webauthn',                     false),
      ('mfa/recovery_code',                false),
      ('sso/saml',                         false),
      ('recovery',                         false),
      ('invite',                           false),
      ('magiclink',                        false),
      ('email/signup',                     false),
      ('email_change',                     false),
      ('token_refresh',                    false),
      ('anonymous',                        false),
      ('web3',                             false),
      ('oauth_provider/authorization_code', false),
      -- Not a method GoTrue writes: a near-miss that must not be read as a
      -- passkey. `webauthn` alone is nothing, and `mfa/webauthn` is a second
      -- factor, covered above.
      ('webauthn',                         false)
    ) AS t(method, admits)
  LOOP
    PERFORM set_config('request.jwt.claims',
      jsonb_build_object(
        'sub', '50000000-0000-4000-8000-000000000001',
        'role', 'authenticated',
        'amr', jsonb_build_array(jsonb_build_object('method', v_case.method, 'timestamp', 1789416052))
      )::text, true);
    IF app_private.session_amr_permits_platform() IS DISTINCT FROM v_case.admits THEN
      RAISE EXCEPTION 'self-check 3: amr [%] should admit % and does not', v_case.method, v_case.admits;
    END IF;
  END LOOP;

  -- 4. the behaviour, per combination. The allow-list's shape: a permitted
  -- method anywhere admits, a refused method anywhere refuses, and the order
  -- of the array never matters.
  FOR v_case IN
    SELECT * FROM (VALUES
      ('[{"method":"passkey"},{"method":"totp"}]',      true,  'passkey plus an MFA factor is still a passkey session'),
      ('[{"method":"totp"},{"method":"passkey"}]',      true,  'order does not matter'),
      ('[{"method":"password"},{"method":"passkey"}]',  true,  'both permitted methods together'),
      ('[{"method":"passkey"},{"method":"oauth"}]',     false, 'oauth beside passkey is refused'),
      ('[{"method":"oauth"},{"method":"passkey"}]',     false, 'and in either order'),
      ('[{"method":"passkey"},{"method":"anonymous"}]', false, 'anonymous beside passkey is refused'),
      ('[{"method":"passkey"},{"method":"sso/saml"}]',  false, 'sso/saml beside passkey is refused'),
      ('["passkey"]',                                   true,  'a bare-string passkey entry is read'),
      ('["passkey","oauth"]',                           false, 'bare strings are refused the same way'),
      ('[{"method":"otp"},{"method":"invite"}]',        false, 'neither of these is a primary sign-in'),
      ('[]',                                            false, 'an empty amr admits nothing'),
      ('[{"timestamp":1}]',                             false, 'an entry with no method admits nothing'),
      ('[42]',                                          false, 'a number is not a method')
    ) AS t(amr, admits, what)
  LOOP
    PERFORM set_config('request.jwt.claims',
      jsonb_build_object(
        'sub', '50000000-0000-4000-8000-000000000001',
        'role', 'authenticated'
      )::text, true);
    PERFORM set_config('request.jwt.claims',
      (jsonb_build_object(
        'sub', '50000000-0000-4000-8000-000000000001',
        'role', 'authenticated'
      ) || jsonb_build_object('amr', v_case.amr::jsonb))::text, true);
    IF app_private.session_amr_permits_platform() IS DISTINCT FROM v_case.admits THEN
      RAISE EXCEPTION 'self-check 4: %s — amr % should admit %', v_case.what, v_case.amr, v_case.admits;
    END IF;
  END LOOP;

  -- 5. a caller with no session at all is still false, never NULL. Everything
  -- that holds a user id without a session — a trigger, a migration, GoTrue,
  -- the service role — depends on this.
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.amr', '', true);
  IF app_private.session_amr_permits_platform() IS NOT FALSE THEN
    RAISE EXCEPTION 'self-check 5: a caller with no JWT must read false, not % ',
      coalesce(app_private.session_amr_permits_platform()::text, 'NULL');
  END IF;

  RAISE NOTICE '20261027140000 self-check: passed (18 methods, 13 combinations, no-session, catalogue and text)';
END $$;
