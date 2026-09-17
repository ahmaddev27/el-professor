/*
  # Google sign-in (plan step 1.6, PR A): the pending Google signup marker

  ## Why

  With Google sign-in, GoTrue creates the account the moment someone finishes
  Google's consent screen. At that point nobody has named a company yet, and
  some people will close the tab right there. Those accounts must stay
  recognisable, so that

  - oauth_signup_create_company (20260916100020) can tell a new Google account
    that still has to register its company from every other account, and
  - purge_abandoned_oauth_signups can delete the ones nobody finished, and
    nothing else.

  A row in app_private.pending_oauth_signups is that mark. The trigger below
  writes it when GoTrue inserts a Google account; the RPCs delete it when the
  company is registered or the account is discarded.

  Inert until PR B: GOTRUE_DISABLE_SIGNUP is still true and no Google client is
  configured, so GoTrue creates no Google accounts and the trigger never
  matches.

  ## How GoTrue v2.170.0 marks a Google account (read from its source)

  The only INSERT of an external-provider account is
  createAccountFromExternalIdentity (internal/api/external.go), decision
  CreateAccount. It builds the row with SignupParams.ToUserModel
  (internal/api/signup.go), which sets, before the INSERT,

      raw_app_meta_data = {"provider": "google", "providers": ["google"]}

  Nothing else identifies it at that moment: email_confirmed_at is still NULL
  (user.Confirm() sets it in a later UPDATE of the same transaction), and the
  auth.identities row is inserted after the user. The trigger can only rely on
  the metadata.

  Every other INSERT carries a different provider at that moment:

      admin createUser (company-signup,   {"provider": "email", "providers": ["email"]};
      manage-users)                       app_metadata passed by the caller is merged
                                          by a later UPDATE (internal/api/admin.go)
      /invite, /signup                    ToUserModel with "email" or "phone"
      anonymous sign-in                   no provider key at all
      SSO                                 "sso:<provider id>"

  Linking Google to an existing account with the same verified address
  (LinkAccount) and accepting a GoTrue invitation through Google
  (processInvite) only UPDATE the row, so they never reach this trigger;
  oauth_session_reconcile deals with those accounts.

  The trigger matches either key, so it still fires if GoTrue drops the
  deprecated "provider" key.

  ## The trigger must never fail an account's creation

  It runs inside GoTrue's own transaction: an error here would turn a Google
  sign-in into a 500 and leave no account. So the function is one INSERT that
  cannot fail:

  - it looks up no other table;
  - the address is optional, and lower() cannot raise;
  - the foreign key is satisfied by the very row that fired the trigger;
  - ON CONFLICT DO NOTHING covers a row that is already there;
  - the WHEN clause uses only ->> and ?, which yield NULL or false for every
    JSON shape, SQL NULL, JSON null, arrays and scalars included.

  public.handle_new_user (on_auth_user_created) keeps firing as before and
  gives the account its company-less viewer profile.

  Rules as in 20260915100000: nobody but the owner reaches app_private, and the
  table and the function get their own REVOKE. Purely additive.
*/

-- ─── Table ──────────────────────────────────────────────────────────────────

CREATE TABLE app_private.pending_oauth_signups (
  user_id    uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Lower-cased, for the log and for support. Nullable so that an account
  -- written without an address is still created.
  email      text        NULL,
  -- Abandonment is measured from here.
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX pending_oauth_signups_created_at ON app_private.pending_oauth_signups (created_at);

-- ─── Trigger ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION app_private.mark_pending_oauth_signup()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO app_private.pending_oauth_signups (user_id, email)
  VALUES (NEW.id, lower(NEW.email))
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS mark_pending_oauth_signup ON auth.users;
CREATE TRIGGER mark_pending_oauth_signup
  AFTER INSERT ON auth.users
  FOR EACH ROW
  WHEN ((NEW.raw_app_meta_data ->> 'provider') = 'google'
        OR (NEW.raw_app_meta_data -> 'providers') ? 'google')
  EXECUTE FUNCTION app_private.mark_pending_oauth_signup();

-- ─── Privileges ─────────────────────────────────────────────────────────────

REVOKE ALL ON TABLE app_private.pending_oauth_signups FROM PUBLIC, anon, authenticated, service_role;

-- Fired by GoTrue's INSERT, never called: triggers do not check EXECUTE.
REVOKE ALL ON FUNCTION app_private.mark_pending_oauth_signup() FROM PUBLIC, anon, authenticated, service_role;

-- ─── Self-check ─────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_role text;
  v_fn   oid := 'app_private.mark_pending_oauth_signup()'::regprocedure;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_schema_privilege(v_role, 'app_private', 'USAGE') THEN
      RAISE EXCEPTION '20260916100000 self-check: % has USAGE on app_private', v_role;
    END IF;
    IF has_table_privilege(v_role, 'app_private.pending_oauth_signups',
                           'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') THEN
      RAISE EXCEPTION '20260916100000 self-check: % holds a privilege on app_private.pending_oauth_signups', v_role;
    END IF;
    IF has_function_privilege(v_role, v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '20260916100000 self-check: % can execute app_private.mark_pending_oauth_signup()', v_role;
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proconfig) AS c(setting)
                  WHERE p.oid = v_fn AND p.prosecdef AND c.setting LIKE 'search_path=%') THEN
    RAISE EXCEPTION '20260916100000 self-check: mark_pending_oauth_signup() is not SECURITY DEFINER with a pinned search_path';
  END IF;

  -- tgtype bits: 1 row, 2 before, 4 insert, 8 delete, 16 update, 32 truncate, 64 instead of.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                  WHERE t.tgrelid = 'auth.users'::regclass
                    AND t.tgname  = 'mark_pending_oauth_signup'
                    AND t.tgfoid  = v_fn
                    AND t.tgenabled = 'O'
                    AND t.tgtype & 1 = 1
                    AND t.tgtype & 4 = 4
                    AND t.tgtype & (2 | 8 | 16 | 32 | 64) = 0) THEN
    RAISE EXCEPTION '20260916100000 self-check: mark_pending_oauth_signup is not an enabled AFTER INSERT row trigger on auth.users';
  END IF;
END $$;
