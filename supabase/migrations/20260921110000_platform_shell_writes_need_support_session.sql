/*
  # A platform account writes a company's accounts and settings only inside a
    support session on that company, and each such write is recorded
    (plan 3.13, slice 3.13a — the database half)

  ## What was open

  20260917130000 (plan 3.3) gave the account shell a capability branch with no
  company term, and 20260917140000 (3.4a) left it there on purpose:

      user_profiles_update, user_profiles_delete     OR platform_can('company_users.manage')
      company_settings_update                        OR platform_can('companies.lifecycle')
      company_settings_insert                        company_id = get_user_company_id()
                                                     AND (is_company_admin() OR platform_can('companies.lifecycle'))
      company_settings_delete                        platform_can('companies.hard_delete')

  So a platform owner edited, deleted and re-pointed any company's settings row
  with no context, no reason and no audit row; a view context (which is meant
  to write nothing) changed the profiles of the company it was reading — the
  context made them visible and the capability made them writable — and a view
  context inserted a company's settings row, because the context completed the
  company term and the capability the rest. The refusal trigger of 3.4a is not
  on either table, and 3.4c (20260920110000) left both out of the write audit
  for the same reason: their platform writes took no company from the context.
  tests/rls/matrix.sql tagged the cells residual for 3.4c/3.13.

  ## The rule

  A platform account acts on a company's accounts and settings only inside an
  open **support** session on that company. The platform branch of each of the
  five policies becomes

      company_id = (SELECT public.platform_support_company_id())

  3.4a's public name for "the company this account has open in support mode"
  (app_private.platform_context_company(true)), the same term the storage write
  policies of 20260920100000 use. Nothing new is defined. It answers NULL
  outside a support session — no context, a view context, an expired one, one
  bound to another sign-in session, a disabled or demoted staff row, a session
  not minted with a password — so outside one the branch is false and no row
  of any company matches it.

  No capability term sits beside it on the four member-shaped policies, on
  purpose: inside a support session is_company_admin() already answers true for
  a company-less staff account (3.4a), so the member branch next to it admits
  the same rows, and a capability conjunct on the platform branch would gate
  nothing. The capability that decides is support.session, which opening the
  session required and platform_context_row() re-asks on every read.
  company_settings_delete keeps companies.hard_delete as a conjunct, because it
  has no member branch at all: a company administrator never deletes its
  settings row, and nothing in the repository deletes one through the API — a
  company's hard delete removes it by the foreign key's cascade, which RLS does
  not apply to.

  One consequence stated rather than hidden: the explicit branch reaches the
  support session's company even for a staff account that also sits in a
  company of its own (the state plan 3.7b removes), where the member branch
  would judge it by its membership. platform_context_open() refuses to open a
  context for such an account (`account_in_company`), and no JWT can give a
  profile a company afterwards (the profile guard), so the case needs an
  operator writing a profile by hand during an open session — and the write is
  still recorded, because the audit below keys on the same term.

  ## What a company member keeps

  Every member term is carried over unchanged: a caller's own profile row
  (`user_id = auth.uid()`), and a company administrator's writes on its own
  company's profiles and settings (`company_id = get_user_company_id() AND
  is_company_admin()`). The one member-visible difference is on
  company_settings_insert, which read
  `company_id = get_user_company_id() AND (is_company_admin() OR platform_can(…))`:
  for a member the capability was always false, so the predicate a member meets
  is the same.

  ## What this changes for platform screens, and what it does not

  - Changing a company's settings (SettingsPage, CompanySettingsContext) and a
    direct PATCH of a company's profiles work inside a support session on that
    company and nowhere else. The platform panel never wrote either table
    directly outside a context; its company writes are the audited RPCs of
    20260916130000.
  - Those RPCs are SECURITY DEFINER and run past RLS, so this file does not
    touch them: platform_company_lifecycle still sets a company's profiles'
    status, platform_subscription_assign still sets drivers_per_car_limit, and
    platform_staff_sync_profile still keeps is_super_admin in step. Each
    records itself.
  - manage-users acts with the service role and is scoped in the function
    itself (supabase/functions/manage-users, same slice).

  ## The two tables join 3.4c's audit — with their own arming

  3.4c left them out because a write there "takes no company from the
  context". That is what this file ends, so their support-session writes are
  now recorded exactly like the 39 tables' writes: the same function
  (app_private.record_support_write), the same row shape, the same redaction
  (iban and bic on company_settings are markers), action
  `support_write.user_profiles.<op>` / `support_write.company_settings.<op>`.

  They do **not** get 3.4c's statement trigger, and that is deliberate. That
  trigger refuses every write of a view context and marks every other write of
  a company-less platform account as `none:<account>`, which the audit
  function then refuses. On these two tables both would be wrong:

    - a platform account updates its **own** profile row in any mode —
      AccountPage (full name), SetPasswordPage (status and
      must_change_password) — and that row belongs to no company;
    - platform_staff_sync_profile updates a staff member's profile when
      platform_staff_add, _disable or _enable run, with the caller's token;
    - platform_company_lifecycle and platform_subscription_assign write these
      tables for the company named in their argument, whatever context the
      caller holds, and a RAISE would roll back their own audit row. That is
      exactly why 3.4a took company_settings off its trigger.

  RLS already refuses a view context here (neither branch answers it), so
  nothing is lost by leaving the refusal out. What they get instead:

    app_private.arm_support_shell_write()   BEFORE … FOR EACH STATEMENT. Every
                                            statement first clears
                                            `app_private.support_shell_company`;
                                            only a caller inside a support
                                            session sets it to that session's
                                            company, and arms 3.4c's flag with
                                            the session, as 3.4c's own trigger
                                            does.
    record_support_shell_write_insert       AFTER … FOR EACH ROW, calling
    record_support_shell_write_update       app_private.record_support_write(),
    record_support_shell_write_delete       gated with WHEN on the row's
                                            company_id equalling that setting.

  So a row is recorded exactly when its company is the caller's support
  session's company. The caller's own profile (company NULL), another staff
  member's profile, and an audited RPC's write to another company never reach
  the audit function — which would refuse a row of another company, and roll
  the RPC back with it. An UPDATE is recorded when either side names the
  session's company, so one that moved a row in or out would reach the audit
  function's own company check and be refused rather than let through (RLS and
  the profile guard refuse that move first). A company member's statement costs
  one set_config and one primary-key lookup on platform_staff, and its rows are
  never recorded: the setting is empty for it.

  The setting is transaction-local and cleared at the start of every statement
  on these two tables, so a company bound by one caller's statement never
  reaches another caller's rows. Nothing a client can call runs set_config.

  ## Compatibility — this does NOT bump deploy/SCHEMA_EPOCH

  Five policies restated, one function and eight triggers added. No column,
  grant or data changes. The previous release's screens write these two tables
  only as a company administrator, on the caller's own row, or inside a support
  session — all still admitted — so a rollback of the code across this file
  leaves nothing that the database now refuses and the old code relied on,
  except the platform owner's direct cross-company settings edit, which no
  screen performs.
*/

-- ─── 1. The policies ────────────────────────────────────────────────────────

DROP POLICY IF EXISTS user_profiles_update ON public.user_profiles;
DROP POLICY IF EXISTS user_profiles_delete ON public.user_profiles;

CREATE POLICY user_profiles_update ON public.user_profiles
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid())
         OR (company_id = (SELECT public.get_user_company_id()) AND (SELECT public.is_company_admin()))
         OR company_id = (SELECT public.platform_support_company_id()))
  WITH CHECK (user_id = (SELECT auth.uid())
              OR (company_id = (SELECT public.get_user_company_id()) AND (SELECT public.is_company_admin()))
              OR company_id = (SELECT public.platform_support_company_id()));

CREATE POLICY user_profiles_delete ON public.user_profiles
  FOR DELETE TO authenticated
  USING ((company_id = (SELECT public.get_user_company_id()) AND (SELECT public.is_company_admin()))
         OR company_id = (SELECT public.platform_support_company_id()));

DROP POLICY IF EXISTS company_settings_insert ON public.company_settings;
DROP POLICY IF EXISTS company_settings_update ON public.company_settings;
DROP POLICY IF EXISTS company_settings_delete ON public.company_settings;

CREATE POLICY company_settings_insert ON public.company_settings
  FOR INSERT TO authenticated
  WITH CHECK ((company_id = (SELECT public.get_user_company_id()) AND (SELECT public.is_company_admin()))
              OR company_id = (SELECT public.platform_support_company_id()));

CREATE POLICY company_settings_update ON public.company_settings
  FOR UPDATE TO authenticated
  USING ((company_id = (SELECT public.get_user_company_id()) AND (SELECT public.is_company_admin()))
         OR company_id = (SELECT public.platform_support_company_id()))
  WITH CHECK ((company_id = (SELECT public.get_user_company_id()) AND (SELECT public.is_company_admin()))
              OR company_id = (SELECT public.platform_support_company_id()));

CREATE POLICY company_settings_delete ON public.company_settings
  FOR DELETE TO authenticated
  USING (company_id = (SELECT public.platform_support_company_id())
         AND (SELECT public.platform_can('companies.hard_delete')));

-- ─── 2. The audit: armed per statement, recorded per row ────────────────────

/*
  Arms the support-write audit for one statement on company_settings or
  user_profiles. See the header, "The two tables join 3.4c's audit".

  In order:
    1. the company binding is cleared, for every caller and every statement;
    2. no subject (the service role, GoTrue, a migration) or no platform_staff
       row (every company member): nothing else to do;
    3. a valid support session: 3.4c's flag names it and this account, and the
       binding names its company.
  Anything else — a view context, no context — leaves the binding empty, so no
  row of this statement reaches the audit function. RLS answers the write.

  platform_context_row() is the one reader of a context; it applies every rule
  that ends one (expiry, the sign-in session, the staff row, the capability).
*/
CREATE OR REPLACE FUNCTION app_private.arm_support_shell_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_flag    CONSTANT text := 'app_private.support_write_context';
  c_company CONSTANT text := 'app_private.support_shell_company';

  v_uid uuid := auth.uid();
  v_ctx app_private.platform_company_contexts%ROWTYPE;
BEGIN
  PERFORM set_config(c_company, '', true);

  IF v_uid IS NULL THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_private.platform_staff s WHERE s.user_id = v_uid) THEN
    RETURN NULL;
  END IF;

  v_ctx := app_private.platform_context_row();
  IF v_ctx.id IS NULL OR v_ctx.mode <> 'support' THEN
    RETURN NULL;
  END IF;

  PERFORM set_config(c_flag, v_ctx.id::text || ':' || v_uid::text, true);
  PERFORM set_config(c_company, v_ctx.company_id::text, true);
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION app_private.arm_support_shell_write() IS
  'Arms the support-write audit for one statement on company_settings or '
  'user_profiles: binds the caller''s support session''s company, or nothing '
  '(20260921110000).';

DO $mig$
DECLARE
  v_tbl text;
BEGIN
  FOREACH v_tbl IN ARRAY ARRAY['company_settings', 'user_profiles'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS arm_support_shell_write ON public.%I', v_tbl);
    EXECUTE format(
      'CREATE TRIGGER arm_support_shell_write '
      'BEFORE INSERT OR UPDATE OR DELETE ON public.%I '
      'FOR EACH STATEMENT EXECUTE FUNCTION app_private.arm_support_shell_write()', v_tbl);

    -- One trigger per event, because a WHEN clause may name only the row
    -- images its event has: NEW for an insert, OLD for a delete, both for an
    -- update.
    EXECUTE format('DROP TRIGGER IF EXISTS record_support_shell_write_insert ON public.%I', v_tbl);
    EXECUTE format(
      'CREATE TRIGGER record_support_shell_write_insert '
      'AFTER INSERT ON public.%I FOR EACH ROW '
      'WHEN (NEW.company_id::text = current_setting(%L, true)) '
      'EXECUTE FUNCTION app_private.record_support_write()',
      v_tbl, 'app_private.support_shell_company');

    EXECUTE format('DROP TRIGGER IF EXISTS record_support_shell_write_update ON public.%I', v_tbl);
    EXECUTE format(
      'CREATE TRIGGER record_support_shell_write_update '
      'AFTER UPDATE ON public.%I FOR EACH ROW '
      'WHEN (OLD.company_id::text = current_setting(%L, true) '
      '   OR NEW.company_id::text = current_setting(%L, true)) '
      'EXECUTE FUNCTION app_private.record_support_write()',
      v_tbl, 'app_private.support_shell_company', 'app_private.support_shell_company');

    EXECUTE format('DROP TRIGGER IF EXISTS record_support_shell_write_delete ON public.%I', v_tbl);
    EXECUTE format(
      'CREATE TRIGGER record_support_shell_write_delete '
      'AFTER DELETE ON public.%I FOR EACH ROW '
      'WHEN (OLD.company_id::text = current_setting(%L, true)) '
      'EXECUTE FUNCTION app_private.record_support_write()',
      v_tbl, 'app_private.support_shell_company');
  END LOOP;
END $mig$;

-- ─── 3. Ownership and privileges ────────────────────────────────────────────

-- SECURITY DEFINER and it reaches app_private, so it belongs to the role that
-- owns that schema; CREATE OR REPLACE keeps whatever owner a function had.
ALTER FUNCTION app_private.arm_support_shell_write() OWNER TO CURRENT_USER;

-- Fired by triggers only. Triggers do not check EXECUTE; the REVOKE is the
-- second wall behind the missing USAGE on app_private.
REVOKE ALL ON FUNCTION app_private.arm_support_shell_write() FROM PUBLIC, anon, authenticated, service_role;

-- ─── 4. Self-check ──────────────────────────────────────────────────────────

DO $mig$
DECLARE
  c_company CONSTANT text := 'app_private.support_shell_company';
  v_wrong   text;
BEGIN
  -- 1. The five policies: for authenticated, the right command, and the
  --    platform branch is the support session's company.
  SELECT string_agg(format('%s (%s)', v.pol, v.problem), '; ' ORDER BY v.pol) INTO v_wrong
    FROM (
      SELECT e.pol, CASE
               WHEN p.policyname IS NULL THEN 'missing'
               WHEN p.cmd IS DISTINCT FROM e.cmd THEN 'command is ' || p.cmd
               WHEN p.roles::text[] IS DISTINCT FROM ARRAY['authenticated']::text[] THEN 'not for authenticated alone'
               WHEN (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) !~ 'platform_support_company_id\('
                 THEN 'the platform branch does not ask platform_support_company_id()'
               WHEN e.pol <> 'company_settings_delete'
                    AND (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) ~ 'platform_can\('
                 THEN 'still carries a capability branch'
               WHEN e.pol <> 'company_settings_delete'
                    AND (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) !~ 'is_company_admin\('
                 THEN 'lost the company administrator''s branch'
               WHEN e.pol = 'company_settings_delete'
                    AND coalesce(p.qual, '') !~ 'platform_can\(''companies\.hard_delete''::text\)'
                 THEN 'lost companies.hard_delete'
               WHEN e.pol = 'user_profiles_update'
                    AND (coalesce(p.qual, '') !~ 'auth\.uid\(\)' OR coalesce(p.with_check, '') !~ 'auth\.uid\(\)')
                 THEN 'lost the caller''s own row'
               WHEN e.cmd IN ('UPDATE', 'INSERT')
                    AND coalesce(p.with_check, '') !~ 'platform_support_company_id\('
                 THEN 'WITH CHECK does not bind the support session''s company'
             END AS problem
        FROM (VALUES
          ('company_settings_insert', 'company_settings', 'INSERT'),
          ('company_settings_update', 'company_settings', 'UPDATE'),
          ('company_settings_delete', 'company_settings', 'DELETE'),
          ('user_profiles_update',    'user_profiles',    'UPDATE'),
          ('user_profiles_delete',    'user_profiles',    'DELETE')
        ) AS e(pol, tbl, cmd)
        LEFT JOIN pg_policies p
          ON p.schemaname = 'public' AND p.tablename = e.tbl AND p.policyname = e.pol
    ) v
   WHERE v.problem IS NOT NULL;

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '3.13a self-check 1: %', v_wrong;
  END IF;

  -- 2. No other policy on the two tables names a capability, except the two
  --    that must: reading a company's settings (companies.read) and deleting
  --    one inside a support session (companies.hard_delete).
  SELECT string_agg(p.policyname::text, ', ' ORDER BY p.policyname::text) INTO v_wrong
    FROM pg_policies p
   WHERE p.schemaname = 'public'
     AND p.tablename IN ('company_settings', 'user_profiles')
     AND (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) ~ 'platform_can\('
     AND p.policyname::text NOT IN ('company_settings_select', 'company_settings_delete');

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '3.13a self-check 2: a capability branch with no company term is back on %', v_wrong;
  END IF;

  -- 3. The arming function: SECURITY DEFINER, a pinned search_path, an owner
  --    that can reach app_private, and no EXECUTE for an API role.
  IF NOT EXISTS (
       SELECT 1
         FROM pg_proc p
         JOIN pg_roles r ON r.oid = p.proowner
        WHERE p.oid = 'app_private.arm_support_shell_write()'::regprocedure
          AND p.prosecdef
          AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c(setting) WHERE c.setting LIKE 'search_path=%')
          AND (r.rolsuper OR r.oid = (SELECT nspowner FROM pg_namespace WHERE nspname = 'app_private')))
     OR has_function_privilege('anon',          'app_private.arm_support_shell_write()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'app_private.arm_support_shell_write()', 'EXECUTE')
     OR has_function_privilege('service_role',  'app_private.arm_support_shell_write()', 'EXECUTE') THEN
    RAISE EXCEPTION '3.13a self-check 3: arm_support_shell_write() is not a SECURITY DEFINER function with a pinned search_path, an app_private owner and no API grant';
  END IF;

  -- 4. The triggers, table by table: the statement trigger (tgtype 30 = BEFORE
  --    2 + INSERT 4 + DELETE 8 + UPDATE 16, statement level) and the three row
  --    triggers (5 = ROW 1 + INSERT 4, 17 = ROW + UPDATE 16, 9 = ROW + DELETE
  --    8, all AFTER), each enabled, each row trigger gated on the binding and
  --    calling 3.4c's audit function.
  SELECT string_agg(format('%s.%s', e.tbl, e.tg), ', ' ORDER BY e.tbl, e.tg) INTO v_wrong
    FROM (VALUES ('company_settings'), ('user_profiles')) AS t(tbl)
   CROSS JOIN LATERAL (VALUES
          (t.tbl, 'arm_support_shell_write',           30, 'app_private.arm_support_shell_write()'::regprocedure, false),
          (t.tbl, 'record_support_shell_write_insert',  5, 'app_private.record_support_write()'::regprocedure,    true),
          (t.tbl, 'record_support_shell_write_update', 17, 'app_private.record_support_write()'::regprocedure,    true),
          (t.tbl, 'record_support_shell_write_delete',  9, 'app_private.record_support_write()'::regprocedure,    true)
        ) AS e(tbl, tg, tgtype, fn, gated)
   WHERE NOT EXISTS (
           SELECT 1 FROM pg_trigger g
            WHERE g.tgrelid = to_regclass('public.' || e.tbl)
              AND g.tgname = e.tg
              AND NOT g.tgisinternal
              AND g.tgtype = e.tgtype
              AND g.tgenabled = 'O'
              AND g.tgfoid = e.fn
              AND (NOT e.gated
                   OR (g.tgqual IS NOT NULL
                       AND pg_get_triggerdef(g.oid) ~ 'app_private\.support_shell_company')));

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '3.13a self-check 4: missing or misshapen trigger(s) %', v_wrong;
  END IF;

  -- 5. …and neither table carries 3.4a's refusal trigger or 3.4c's audit
  --    trigger by its own name: 3.4c's self-check and support-write-audit.sql
  --    pair those two table by table, and these tables are armed differently
  --    on purpose (the header says why).
  IF EXISTS (SELECT 1 FROM pg_trigger g
              WHERE g.tgrelid IN ('public.company_settings'::regclass, 'public.user_profiles'::regclass)
                AND g.tgname IN ('refuse_read_only_context_write', 'record_support_write')
                AND NOT g.tgisinternal) THEN
    RAISE EXCEPTION '3.13a self-check 5: company_settings or user_profiles carries 3.4a''s refusal trigger or 3.4c''s paired audit trigger';
  END IF;

  -- 6. Every trigger that calls the audit function is one of the two kinds:
  --    3.4c's, paired with the refusal trigger, or this file's, on these two
  --    tables. A third kind would be armed by nothing anybody has reviewed.
  SELECT string_agg(format('%s.%s', c.relname::text, g.tgname::text), ', ') INTO v_wrong
    FROM pg_trigger g
    JOIN pg_class c ON c.oid = g.tgrelid
   WHERE g.tgfoid = 'app_private.record_support_write()'::regprocedure
     AND NOT g.tgisinternal
     AND NOT (g.tgname = 'record_support_write'
              AND EXISTS (SELECT 1 FROM pg_trigger r
                           WHERE r.tgrelid = g.tgrelid
                             AND r.tgname = 'refuse_read_only_context_write'
                             AND NOT r.tgisinternal))
     AND NOT (g.tgname::text IN ('record_support_shell_write_insert',
                                 'record_support_shell_write_update',
                                 'record_support_shell_write_delete')
              AND c.relname::text IN ('company_settings', 'user_profiles')
              AND c.relnamespace = 'public'::regnamespace);

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '3.13a self-check 6: record_support_write() is called by a trigger nothing arms: %', v_wrong;
  END IF;

  -- 7. A statement by a caller without a subject — the migration itself, as
  --    the service role and GoTrue — clears a binding it finds. WHERE false:
  --    a statement trigger fires for a statement that touches no row, and this
  --    one must touch none on a live database.
  PERFORM set_config(c_company, gen_random_uuid()::text, true);
  UPDATE public.company_settings SET company_id = company_id WHERE false;
  IF current_setting(c_company, true) IS DISTINCT FROM '' THEN
    RAISE EXCEPTION '3.13a self-check 7: a statement on company_settings left a company bound';
  END IF;

  PERFORM set_config(c_company, gen_random_uuid()::text, true);
  UPDATE public.user_profiles SET company_id = company_id WHERE false;
  IF current_setting(c_company, true) IS DISTINCT FROM '' THEN
    RAISE EXCEPTION '3.13a self-check 7: a statement on user_profiles left a company bound';
  END IF;

  RAISE NOTICE '3.13a self-check: passed — the account shell is written by a platform account only inside a support session, and recorded there';
END $mig$;
