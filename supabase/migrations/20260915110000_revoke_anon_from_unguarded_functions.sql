/*
  Close anonymous access to SECURITY DEFINER functions that never check who calls.

  Supabase's default privileges grant EXECUTE on every new function to PUBLIC,
  anon, authenticated and service_role. Several older functions still carried
  that grant:

  - list_users_for_admin() returned every account's email, name and role to a
    caller holding only the public anon key. Its guard reads
    `IF auth.email() != 'support@yamobility.de' THEN RAISE`, and for an
    anonymous caller auth.email() is NULL, so the comparison is NULL and the
    RAISE never runs. Confirmed on staging on 15.09.2026 (15 rows back). The
    owner approved closing it by hand on production and staging the same day,
    before this migration; Kong's log since 13.09.2026 shows no call to it.
  - create_user_account() has the same NULL-blind guard. It only returns
    instructions, and nothing calls it.
  - redeem_discount_code() records a redemption for whatever company id it is
    given. 20260911120000 revoked PUBLIC and authenticated but missed anon.
    Its only caller is the company-signup function, as service_role.
  - preview_activation_code() and redeem_activation_code() are called from
    ActivationPage by signed-in users, who keep their grant.
  - get_user_status() and is_user_active() tell anyone the status of a user
    id. Nothing calls them, and no policy or other function uses them.

  Nothing in src/ or supabase/functions calls any of these anonymously, so no
  behaviour a user relies on changes. Phase 3 rewrites the checks themselves;
  this only shuts what is open today.

  Idempotent: REVOKE of a privilege that is not held is a no-op, and on
  production and staging the first five revokes already ran by hand. A
  function missing from a database (the RLS kit fixture, say) is skipped.
*/

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('public.list_users_for_admin()',                                'PUBLIC, anon, authenticated'),
      ('public.create_user_account(text, text, text, text)',           'PUBLIC, anon, authenticated'),
      ('public.redeem_discount_code(text, uuid, text, text, integer)', 'PUBLIC, anon'),
      ('public.preview_activation_code(text)',                         'PUBLIC, anon'),
      ('public.redeem_activation_code(text)',                          'PUBLIC, anon'),
      ('public.get_user_status(uuid)',                                 'PUBLIC, anon'),
      ('public.is_user_active(uuid)',                                  'PUBLIC, anon')
    ) AS t(fn, roles)
  LOOP
    IF to_regprocedure(r.fn) IS NOT NULL THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM %s', r.fn, r.roles);
    END IF;
  END LOOP;

  -- The callers that need these keep an explicit grant, so revoking PUBLIC
  -- cannot take it from them wherever it only came through PUBLIC.
  FOR r IN
    SELECT * FROM (VALUES
      ('public.redeem_discount_code(text, uuid, text, text, integer)', 'service_role'),
      ('public.preview_activation_code(text)',                         'authenticated, service_role'),
      ('public.redeem_activation_code(text)',                          'authenticated, service_role'),
      ('public.get_user_status(uuid)',                                 'authenticated, service_role'),
      ('public.is_user_active(uuid)',                                  'authenticated, service_role')
    ) AS t(fn, roles)
  LOOP
    IF to_regprocedure(r.fn) IS NOT NULL THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %s', r.fn, r.roles);
    END IF;
  END LOOP;
END $$;

-- Self-check: fail the release if an anonymous caller can still run any of
-- them, or a signed-in user can still list or create accounts.
DO $$
DECLARE
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.list_users_for_admin()',
    'public.create_user_account(text, text, text, text)',
    'public.redeem_discount_code(text, uuid, text, text, integer)',
    'public.preview_activation_code(text)',
    'public.redeem_activation_code(text)',
    'public.get_user_status(uuid)',
    'public.is_user_active(uuid)'
  ] LOOP
    IF to_regprocedure(fn) IS NOT NULL THEN
      IF has_function_privilege('anon', fn, 'EXECUTE') THEN
        RAISE EXCEPTION 'anon can still execute %', fn;
      END IF;
    END IF;
  END LOOP;

  FOREACH fn IN ARRAY ARRAY[
    'public.list_users_for_admin()',
    'public.create_user_account(text, text, text, text)'
  ] LOOP
    IF to_regprocedure(fn) IS NOT NULL THEN
      IF has_function_privilege('authenticated', fn, 'EXECUTE') THEN
        RAISE EXCEPTION 'authenticated can still execute %', fn;
      END IF;
    END IF;
  END LOOP;
END $$;
