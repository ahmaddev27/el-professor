/*
  Deleting a company completely (owner's request, 16.10.2026).

  "The delete removes the e-mails, the fleet, the company, the admins and
  everything — the earnings, the drivers, everything."

  What the direct delete in CompaniesPage did not do, measured on staging
  16.10.2026 and not assumed:

    * 52 foreign keys cascade from companies, so most business data went.
    * Four tables carry a company_id with NO foreign key at all, so their rows
      stayed behind with a company id that no longer existed:
      cash_transactions, historical_payroll_targets (64 rows on staging),
      document_templates (reached only if its creator's account is deleted)
      and app_private.receipt_ocr_events. Their children reach the company
      through a parent that does cascade (driver_notes through drivers,
      werkstatt_checks through cars, planning_finalizations through the run),
      so those were fine.
    * auth.users was never touched, so every login address stayed registered
      and could not be used again. That is the reason for this migration.
    * Files in the company buckets (storage.objects) have no foreign key
      either; the edge function removes them through the storage API, which
      deletes the file as well as the row.

  What is built, and why it is shaped like this

    app_private.company_deletion_tables()   the catalogue of what a company
                                            owns: every table in public and
                                            app_private with a company_id
                                            column. One list, derived from
                                            the catalogue, so a table added
                                            next year is counted, deleted and
                                            verified without anyone editing a
                                            list.
    app_private.company_deletion_counts()   the rows per table
    app_private.company_deletion_plan()     counts + accounts + files + what
                                            is kept
    public.platform_company_delete_preview  the plan, as an audited read
    public.platform_company_delete          the deletion, as an audited write

  The preview and the deletion call the SAME plan function, and the deletion
  ends by running the SAME counter and failing if anything is left. A preview
  that disagrees with the deletion is therefore impossible by construction, and
  so is a deletion that silently leaves a table behind.

  Platform staff accounts are never deleted. An account with a platform_staff
  row (a disabled one included, the rule of account_is_platform_staff) is
  reported as kept. Its PROFILE does go with the company, because
  user_profiles.company_id cascades and the profile guard forbids any JWT to
  move a profile out of a company; the platform-staff function writes it back
  company-less with the service role, which the guard does not cover.

  What is kept on purpose, and said so in every preview:

    * app_private.platform_audit_log   the history of this very action.
    * app_private.receipt_ocr_events   an abuse control keyed by user id; it is
                                       written so that deleting an account does
                                       not reset a budget, and deleting a
                                       company must not either.
    * activation_codes, activation_code_attempts, discount_codes
                                       their foreign key to companies is
                                       ON DELETE SET NULL. They are platform
                                       records of codes that were issued and
                                       redeemed; deleting them would let a
                                       redeemed single-use code look unused
                                       and erase the trail of who redeemed what.
                                       One column is personal data and is
                                       REPORTED, not changed: activation_codes
                                       .target_email.

  Who may: companies.hard_delete (owner only in the capability matrix, read from
  app_private.platform_capability_matrix() on 16.10.2026), asked of the database
  with platform_rpc_authorize, which also records the refusal.

  The open-context rule is not restated. app_private.guard_company_hard_delete
  (20260920110000) still fires on the DELETE and raises
  company_delete_context_open when the caller holds any platform context. This
  function catches that one hint and answers it as a sentence, and re-raises
  anything else.

  A company must be marked deleted first (the lifecycle menu's "mark_deleted"),
  as the screen has always required. That is checked here too, so a script
  cannot skip a step the screen takes.

  platform_edge_audit_actions() gains one row, because the edge function brackets
  the whole operation with an `attempt` row written BEFORE anything is deleted.
  Backward compatible, no SCHEMA_EPOCH bump: new functions, one list restated
  with one more row, no table touched.
*/

-- ─── 1. What a company owns ─────────────────────────────────────────────────

/*
  Every table in public and app_private with a company_id column, except:

    * app_private.platform_audit_log and app_private.receipt_ocr_events, kept
      (header);
    * a table whose company_id foreign key does NOT cascade: it is a platform
      record that survives with a null company (activation_codes,
      activation_code_attempts).

  `cascades` says whether a foreign key from company_id to companies cascades.
  A row in a table with no foreign key (cascades = false) is deleted explicitly
  by platform_company_delete; the rest go with the company.
*/
CREATE OR REPLACE FUNCTION app_private.company_deletion_tables()
RETURNS TABLE (schema_name text, table_name text, cascades boolean)
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT n.nspname::text,
         c.relname::text,
         EXISTS (SELECT 1 FROM pg_constraint k
                  WHERE k.conrelid = c.oid AND k.contype = 'f'
                    AND k.confrelid = 'public.companies'::regclass
                    AND k.conkey = ARRAY[a.attnum]
                    AND k.confdeltype = 'c')
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'company_id'
                       AND a.attnum > 0 AND NOT a.attisdropped
   WHERE c.relkind IN ('r', 'p')
     AND NOT c.relispartition
     AND n.nspname IN ('public', 'app_private')
     AND (n.nspname, c.relname) NOT IN (('app_private', 'platform_audit_log'),
                                        ('app_private', 'receipt_ocr_events'))
     AND NOT EXISTS (SELECT 1 FROM pg_constraint k
                      WHERE k.conrelid = c.oid AND k.contype = 'f'
                        AND k.confrelid = 'public.companies'::regclass
                        AND k.conkey = ARRAY[a.attnum]
                        AND k.confdeltype <> 'c')
   ORDER BY 1, 2;
$$;

-- Rows per table for one company, only the tables that hold any. The key is the
-- table name, schema-qualified outside public.
CREATE OR REPLACE FUNCTION app_private.company_deletion_counts(p_company_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  r      record;
  v_n    bigint;
  v_out  jsonb := '{}'::jsonb;
BEGIN
  FOR r IN SELECT * FROM app_private.company_deletion_tables() LOOP
    EXECUTE format('SELECT count(*) FROM %I.%I WHERE company_id = $1', r.schema_name, r.table_name)
       INTO v_n USING p_company_id;
    IF v_n > 0 THEN
      v_out := v_out || jsonb_build_object(
        CASE WHEN r.schema_name = 'public' THEN r.table_name ELSE r.schema_name || '.' || r.table_name END,
        v_n);
    END IF;
  END LOOP;
  RETURN v_out;
END;
$$;

-- The files of the company: first folder of the object name is the company id
-- in every company bucket (20260920100000).
CREATE OR REPLACE FUNCTION app_private.company_deletion_objects(p_company_id uuid)
RETURNS jsonb
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('bucket', o.bucket_id, 'name', o.name)
                            ORDER BY o.bucket_id, o.name), '[]'::jsonb)
    FROM storage.objects o
   WHERE split_part(o.name, '/', 1) = p_company_id::text;
$$;

-- ─── 2. The plan: what the preview shows and the deletion carries out ───────

CREATE OR REPLACE FUNCTION app_private.company_deletion_plan(p_company_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_company  public.companies%ROWTYPE;
  v_counts   jsonb;
  v_accounts jsonb;
  v_files    jsonb;
  v_rows     bigint;
BEGIN
  SELECT * INTO v_company FROM public.companies WHERE id = p_company_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  v_counts := app_private.company_deletion_counts(p_company_id);
  SELECT coalesce(sum(value::bigint), 0) INTO v_rows FROM jsonb_each_text(v_counts);

  -- An account belongs to the company when its profile does: user_profiles
  -- .user_id is unique, so an account has at most one company and nothing here
  -- can reach an account of another one. A staff account is kept.
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'user_id',   p.user_id,
           'email',     p.email,
           'full_name', p.full_name,
           'role',      p.role,
           'status',    p.status,
           'action',    CASE WHEN s.is_staff THEN 'keep' ELSE 'delete' END,
           'reason',    CASE WHEN s.is_staff THEN 'platform_staff' END)
         ORDER BY lower(p.email), p.user_id), '[]'::jsonb)
    INTO v_accounts
    FROM public.user_profiles p
   CROSS JOIN LATERAL (SELECT coalesce(app_private.oauth_account_is_platform_staff(p.user_id), false) AS is_staff) s
   WHERE p.company_id = p_company_id;

  SELECT jsonb_build_object(
           'count',     coalesce(sum(b.n), 0),
           'by_bucket', coalesce(jsonb_object_agg(b.bucket_id, b.n), '{}'::jsonb))
    INTO v_files
    FROM (SELECT o.bucket_id, count(*) AS n
            FROM storage.objects o
           WHERE split_part(o.name, '/', 1) = p_company_id::text
           GROUP BY o.bucket_id) b;

  RETURN jsonb_build_object(
    'company',    jsonb_build_object('id', v_company.id, 'name', v_company.name,
                                     'slug', v_company.slug, 'status', v_company.status),
    'tables',     v_counts,
    'rows_total', v_rows,
    -- A company can hold both kinds: rows the Uber import wrote (source = 'uber')
    -- and rows somebody typed. Already inside `tables`; split here so the
    -- operator sees how much is hand-entered.
    'income',     jsonb_build_object(
                    'uber',  (SELECT count(*) FROM public.income i WHERE i.company_id = p_company_id AND i.source = 'uber'),
                    'other', (SELECT count(*) FROM public.income i WHERE i.company_id = p_company_id AND i.source IS DISTINCT FROM 'uber')),
    'accounts',   v_accounts,
    'files',      v_files,
    'kept', jsonb_build_object(
      'activation_codes',
        (SELECT count(*) FROM public.activation_codes c
          WHERE c.company_id = p_company_id OR c.used_company_id = p_company_id),
      'activation_codes_with_address',
        (SELECT count(*) FROM public.activation_codes c
          WHERE (c.company_id = p_company_id OR c.used_company_id = p_company_id)
            AND c.target_email IS NOT NULL),
      'activation_code_attempts',
        (SELECT count(*) FROM public.activation_code_attempts a WHERE a.company_id = p_company_id),
      'discount_codes',
        (SELECT count(*) FROM public.discount_codes d WHERE d.assigned_company_id = p_company_id),
      'audit_rows',
        (SELECT count(*) FROM app_private.platform_audit_log l WHERE l.company_id = p_company_id),
      'ocr_events',
        (SELECT count(*) FROM app_private.receipt_ocr_events e WHERE e.company_id = p_company_id)));
END;
$$;

-- ─── 3. The preview: an audited read ────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.platform_company_delete_preview(p_company_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_action CONSTANT text := 'platform_read.company_delete_preview';
  v_plan   jsonb;
BEGIN
  IF NOT app_private.platform_rpc_authorize('companies.hard_delete', 'read', c_action,
                                            p_company_id, 'company', p_company_id::text) THEN
    RETURN app_private.platform_rpc_response('denied');
  END IF;

  IF p_company_id IS NULL THEN
    RETURN app_private.platform_rpc_finish('read', c_action, 'invalid', NULL, 'company', NULL, NULL, NULL);
  END IF;

  v_plan := app_private.company_deletion_plan(p_company_id);
  IF v_plan IS NULL THEN
    RETURN app_private.platform_rpc_finish('read', c_action, 'not_found', NULL, 'company', p_company_id::text, NULL, NULL);
  END IF;

  -- The row says that the list was read and how big it was, never the
  -- addresses in it.
  RETURN app_private.platform_rpc_finish('read', c_action, NULL, p_company_id, 'company', p_company_id::text, NULL,
    jsonb_build_object('rows_total', v_plan -> 'rows_total',
                       'accounts',   jsonb_array_length(v_plan -> 'accounts')),
    jsonb_build_object('plan', v_plan));
END;
$$;

-- ─── 4. The deletion: an audited write ──────────────────────────────────────

CREATE OR REPLACE FUNCTION public.platform_company_delete(p_company_id uuid, p_confirm_name text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_action CONSTANT text := 'company.hard_delete';
  v_company public.companies%ROWTYPE;
  v_plan    jsonb;
  v_objects jsonb;
  v_left    jsonb;
  v_hint    text;
  v_msg     text;
  r         record;
BEGIN
  IF NOT app_private.platform_rpc_authorize('companies.hard_delete', 'write', c_action,
                                            p_company_id, 'company', p_company_id::text) THEN
    RETURN app_private.platform_rpc_response('denied');
  END IF;

  IF p_company_id IS NULL OR p_confirm_name IS NULL THEN
    RETURN app_private.platform_rpc_finish('write', c_action, 'invalid', p_company_id, 'company', p_company_id::text,
                                           NULL, NULL);
  END IF;

  SELECT * INTO v_company FROM public.companies WHERE id = p_company_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN app_private.platform_rpc_finish('write', c_action, 'not_found', NULL, 'company', p_company_id::text, NULL, NULL);
  END IF;

  -- The screen offers this only for a company marked deleted; a script gets the
  -- same step.
  IF v_company.status IS DISTINCT FROM 'deleted' THEN
    PERFORM app_private.platform_rpc_record('write', c_action, 'invalid_status', p_company_id, 'company',
                                            p_company_id::text, NULL, jsonb_build_object('status', v_company.status));
    RETURN app_private.platform_rpc_response('invalid_status')
           || jsonb_build_object('error',
                'Ein Unternehmen kann erst endgültig gelöscht werden, nachdem es als gelöscht markiert wurde.');
  END IF;

  IF btrim(p_confirm_name) IS DISTINCT FROM btrim(v_company.name) THEN
    PERFORM app_private.platform_rpc_record('write', c_action, 'name_mismatch', p_company_id, 'company',
                                            p_company_id::text, NULL, NULL);
    RETURN app_private.platform_rpc_response('name_mismatch')
           || jsonb_build_object('error',
                'Der eingegebene Name stimmt nicht mit dem Unternehmensnamen überein.');
  END IF;

  v_plan    := app_private.company_deletion_plan(p_company_id);
  v_objects := app_private.company_deletion_objects(p_company_id);

  BEGIN
    -- The company first: its BEFORE DELETE guard refuses while the caller holds
    -- a platform context, before anything else is touched.
    DELETE FROM public.companies WHERE id = p_company_id;

    -- Tables with a company_id and no foreign key do not cascade.
    FOR r IN SELECT * FROM app_private.company_deletion_tables() t WHERE NOT t.cascades LOOP
      EXECUTE format('DELETE FROM %I.%I WHERE company_id = $1', r.schema_name, r.table_name)
        USING p_company_id;
    END LOOP;

    -- The same counter the preview used. Anything left rolls the whole
    -- deletion back; a deletion that cannot prove it removed everything it
    -- listed does not happen.
    v_left := app_private.company_deletion_counts(p_company_id);
    IF v_left <> '{}'::jsonb THEN
      RAISE EXCEPTION 'company delete left rows behind: %', v_left;
    END IF;
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
    IF v_hint IS DISTINCT FROM 'company_delete_context_open' THEN
      RAISE;
    END IF;
    PERFORM app_private.platform_rpc_record('write', c_action, 'company_delete_context_open', p_company_id,
                                            'company', p_company_id::text, NULL, NULL);
    RETURN app_private.platform_rpc_response('company_delete_context_open')
           || jsonb_build_object('error', v_msg);
  END;

  PERFORM app_private.platform_rpc_record('write', c_action, NULL, p_company_id, 'company', p_company_id::text,
    jsonb_build_object('name', v_company.name, 'slug', v_company.slug, 'status', v_company.status),
    jsonb_build_object(
      'rows_total',       v_plan -> 'rows_total',
      'tables',           v_plan -> 'tables',
      'files',            (v_plan -> 'files') -> 'count',
      'accounts_delete',  (SELECT coalesce(jsonb_agg(a ->> 'user_id'), '[]'::jsonb)
                             FROM jsonb_array_elements(v_plan -> 'accounts') a WHERE a ->> 'action' = 'delete'),
      'accounts_kept',    (SELECT coalesce(jsonb_agg(a ->> 'user_id'), '[]'::jsonb)
                             FROM jsonb_array_elements(v_plan -> 'accounts') a WHERE a ->> 'action' = 'keep'),
      'kept',             v_plan -> 'kept'));

  RETURN app_private.platform_rpc_response(NULL, jsonb_build_object(
    'plan',    v_plan,
    'objects', v_objects));
END;
$$;

-- ─── 5. platform_edge_audit_actions: the edge route's action ────────────────

-- 20260923140000's list with one row added. Self-check 4 re-asserts the other
-- twelve, and supabase/functions/_shared/platform-access-actions.test.ts reads
-- this definition and fails the build while a route's action is missing.
CREATE OR REPLACE FUNCTION app_private.platform_edge_audit_actions()
RETURNS TABLE (action text, category text, capability text)
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT a.action, a.category, a.capability
    FROM (VALUES
      ('manage_users.list',            'read',  'business.read'),
      ('manage_users.create',          'write', 'company_users.manage'),
      ('manage_users.update',          'write', 'company_users.manage'),
      ('manage_users.set_status',      'write', 'company_users.manage'),
      ('manage_users.resend_invite',   'write', 'company_users.manage'),
      ('manage_users.reset_password',  'write', 'company_users.manage'),
      ('manage_users.delete',          'write', 'company_users.manage'),
      ('manage_users.unknown',         'write', NULL),
      ('activation_code.generate',     'write', 'codes.manage'),
      ('platform_staff_invite.create', 'write', 'staff.manage'),
      ('platform_staff_invite.resend', 'write', 'staff.manage'),
      ('platform_staff_role.set',      'write', 'staff.manage'),
      -- 20261016140000: the platform-staff function's /delete-company route. Its
      -- attempt row is written before the first thing is deleted.
      ('platform_company_hard_delete.execute', 'write', 'companies.hard_delete')
    ) AS a(action, category, capability);
$$;

-- ─── 5b. The three guards that would stop a company's own cascade ──────────

/*
  Found by deleting a company that had done real work, in this migration's own
  test, not by reading: the direct delete of CompaniesPage fails outright for a
  company that has finalized a month or confirmed a monthly plan.

    * fahrtenbuch_imports_protect_finalized (20260908113000) refuses to delete an
      import that a finalized planning run refers to. The cascade from the
      company meets it as soon as the imports go before the finalizations.
    * monthly_plan_guard (20260930100000) refuses to delete a confirmed or
      superseded plan, and monthly_plan_parent_is_open, which the child guards
      ask, refuses to let a confirmed plan's blocks, rides or drivers go.

  All three protect a LIVE company's record against a user deleting a piece of
  it. A company that is already gone has nothing left to protect, and the
  cascade is the company's own. Each body below is the original character for
  character, plus one condition: the refusal applies only while the company row
  exists. By the time a cascade reaches a child the parent row is deleted, so the
  refusal stays in force for every ordinary delete (an import, a plan, a ride of
  a company that exists) and stands aside for exactly the cascade. Self-check 6
  re-asserts the original refusal and the new condition, fragment by fragment.
*/
CREATE OR REPLACE FUNCTION public.prevent_finalized_import_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $fn$
DECLARE
  v_finalizations int;
BEGIN
  SELECT COUNT(*)
    INTO v_finalizations
  FROM planning_finalizations pf
  JOIN company_planning_runs r ON r.id = pf.planning_run_id
  WHERE r.import_id = OLD.id;

  IF v_finalizations > 0
     AND EXISTS (SELECT 1 FROM public.companies c WHERE c.id = OLD.company_id) THEN
    RAISE EXCEPTION
      'Fahrtenbuch-Import % kann nicht gelöscht werden: % abgeschlossene Planung(en) beziehen sich darauf. '
      'Die Stundennachweise und das Fahrtenbuch dieses Monats wurden bereits final erstellt.',
      OLD.id, v_finalizations
      USING ERRCODE = 'P0001';
  END IF;

  RETURN OLD;
END;
$fn$;

CREATE OR REPLACE FUNCTION app_private.monthly_plan_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  c_marker CONSTANT text := 'app_private.monthly_plan_transition';
  v_uid    uuid := auth.uid();
  v_moves  boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- A confirmed plan is the month's record and a superseded one is its
    -- history; neither is deleted. A draft is a proposal and may go.
    IF OLD.status <> 'draft'
       AND EXISTS (SELECT 1 FROM public.companies c WHERE c.id = OLD.company_id) THEN
      RAISE EXCEPTION 'Ein bestätigter oder ersetzter Monatsplan kann nicht gelöscht werden.'
        USING ERRCODE = 'P0001', HINT = 'monthly_plan_is_final';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- A plan is born a draft. Confirmation is monthly_plan_confirm's act.
    NEW.status              := 'draft';
    NEW.confirmed_at        := NULL;
    NEW.confirmed_by        := NULL;
    NEW.superseded_at       := NULL;
    NEW.superseded_by       := NULL;
    NEW.replaced_by_plan_id := NULL;
    NEW.created_by          := v_uid;
    NEW.created_at          := now();
    NEW.updated_by          := v_uid;
    NEW.updated_at          := now();
    RETURN NEW;
  END IF;

  IF NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.year    IS DISTINCT FROM OLD.year
     OR NEW.month   IS DISTINCT FROM OLD.month THEN
    RAISE EXCEPTION 'Ein Monatsplan bleibt bei seinem Unternehmen und seinem Monat.'
      USING ERRCODE = 'P0001', HINT = 'monthly_plan_key_fixed';
  END IF;

  NEW.created_at := OLD.created_at;
  NEW.created_by := OLD.created_by;
  NEW.updated_by := v_uid;
  NEW.updated_at := now();

  v_moves := NEW.status              IS DISTINCT FROM OLD.status
          OR NEW.confirmed_at        IS DISTINCT FROM OLD.confirmed_at
          OR NEW.confirmed_by        IS DISTINCT FROM OLD.confirmed_by
          OR NEW.superseded_at       IS DISTINCT FROM OLD.superseded_at
          OR NEW.superseded_by       IS DISTINCT FROM OLD.superseded_by
          OR NEW.replaced_by_plan_id IS DISTINCT FROM OLD.replaced_by_plan_id;

  IF v_moves THEN
    IF nullif(current_setting(c_marker, true), '')
         IS DISTINCT FROM 'plan:' || OLD.id::text || ':' || pg_current_xact_id()::text THEN
      RAISE EXCEPTION 'Der Status eines Monatsplans wird nur über monthly_plan_confirm geändert.'
        USING ERRCODE = 'P0001', HINT = 'monthly_plan_transition_needs_rpc';
    END IF;

    -- The actor and the time are the database's on both transitions, whatever
    -- the caller sent.
    IF NEW.status = 'confirmed' THEN
      NEW.confirmed_at  := now();
      NEW.confirmed_by  := v_uid;
      NEW.superseded_at := NULL;
      NEW.superseded_by := NULL;
    ELSIF NEW.status = 'superseded' THEN
      NEW.confirmed_at  := OLD.confirmed_at;
      NEW.confirmed_by  := OLD.confirmed_by;
      NEW.superseded_at := now();
      NEW.superseded_by := v_uid;
    ELSE
      RAISE EXCEPTION 'Ein Monatsplan kann nicht auf % zurückgesetzt werden.', NEW.status
        USING ERRCODE = 'P0001', HINT = 'monthly_plan_transition_invalid';
    END IF;
    RETURN NEW;
  END IF;

  -- An ordinary edit. Only a draft has anything to edit.
  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'Ein bestätigter Monatsplan kann nicht geändert werden.'
      USING ERRCODE = 'P0001', HINT = 'monthly_plan_is_final';
  END IF;

  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION app_private.monthly_plan_parent_is_open(p_plan_id uuid, p_company_id uuid)
RETURNS public.monthly_plans
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_plan public.monthly_plans;
BEGIN
  SELECT * INTO v_plan FROM public.monthly_plans p WHERE p.id = p_plan_id;

  IF NOT FOUND THEN
    RETURN v_plan;
  END IF;

  -- 20261016140000: a company that no longer exists takes its plans with it. The
  -- rows reaching this point are the company's own cascade.
  IF NOT EXISTS (SELECT 1 FROM public.companies c WHERE c.id = p_company_id) THEN
    RETURN v_plan;
  END IF;

  IF v_plan.company_id IS DISTINCT FROM p_company_id THEN
    RAISE EXCEPTION 'Der Monatsplan gehört zu einem anderen Unternehmen.'
      USING ERRCODE = 'P0001', HINT = 'monthly_plan_company_mismatch';
  END IF;

  IF v_plan.status <> 'draft' THEN
    RAISE EXCEPTION 'Ein bestätigter Monatsplan kann nicht geändert werden.'
      USING ERRCODE = 'P0001', HINT = 'monthly_plan_is_final';
  END IF;

  RETURN v_plan;
END;
$fn$;

-- ─── 6. Ownership and privileges ────────────────────────────────────────────

ALTER FUNCTION app_private.company_deletion_tables()                OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.company_deletion_counts(uuid)            OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.company_deletion_objects(uuid)           OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.company_deletion_plan(uuid)              OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.platform_edge_audit_actions()            OWNER TO CURRENT_USER;
ALTER FUNCTION public.prevent_finalized_import_delete()              OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.monthly_plan_guard()                     OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.monthly_plan_parent_is_open(uuid, uuid)  OWNER TO CURRENT_USER;
ALTER FUNCTION public.platform_company_delete_preview(uuid)         OWNER TO CURRENT_USER;
ALTER FUNCTION public.platform_company_delete(uuid, text)           OWNER TO CURRENT_USER;

REVOKE ALL ON FUNCTION app_private.company_deletion_tables()        FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.company_deletion_counts(uuid)    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.company_deletion_objects(uuid)   FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.company_deletion_plan(uuid)      FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.platform_edge_audit_actions()    FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.platform_company_delete_preview(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.platform_company_delete(uuid, text)   FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_company_delete_preview(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_company_delete(uuid, text)   TO authenticated;

-- ─── Self-check ─────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_sig     text;
  v_body    text;
  v_missing text;
  v_wrong   text;
BEGIN
  -- 1. Shape and privileges of the two RPCs and the four helpers.
  FOREACH v_sig IN ARRAY ARRAY[
    'public.platform_company_delete_preview(uuid)',
    'public.platform_company_delete(uuid,text)',
    'app_private.company_deletion_counts(uuid)',
    'app_private.company_deletion_objects(uuid)',
    'app_private.company_deletion_plan(uuid)'] LOOP
    IF to_regprocedure(v_sig) IS NULL THEN
      RAISE EXCEPTION '20261016140000 self-check 1: % is missing', v_sig;
    END IF;
    IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = v_sig::regprocedure) THEN
      RAISE EXCEPTION '20261016140000 self-check 1: % is not SECURITY DEFINER', v_sig;
    END IF;
    IF (SELECT p.provolatile FROM pg_proc p WHERE p.oid = v_sig::regprocedure) <> 'v' THEN
      RAISE EXCEPTION '20261016140000 self-check 1: % must be VOLATILE', v_sig;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(coalesce(p.proconfig, '{}'::text[])) c(setting)
                    WHERE p.oid = v_sig::regprocedure AND c.setting LIKE 'search_path=%') THEN
      RAISE EXCEPTION '20261016140000 self-check 1: % has no pinned search_path', v_sig;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
                    WHERE p.oid = v_sig::regprocedure
                      AND (r.rolsuper OR r.oid = (SELECT nspowner FROM pg_namespace WHERE nspname = 'app_private'))) THEN
      RAISE EXCEPTION '20261016140000 self-check 1: the owner of % can call no app_private helper', v_sig;
    END IF;
  END LOOP;

  FOREACH v_sig IN ARRAY ARRAY[
    'public.platform_company_delete_preview(uuid)',
    'public.platform_company_delete(uuid,text)'] LOOP
    IF has_function_privilege('anon', v_sig::regprocedure, 'EXECUTE')
       OR has_function_privilege('service_role', v_sig::regprocedure, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', v_sig::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION '20261016140000 self-check 1: EXECUTE on % must be authenticated alone', v_sig;
    END IF;
  END LOOP;

  FOREACH v_sig IN ARRAY ARRAY[
    'app_private.company_deletion_tables()',
    'app_private.company_deletion_counts(uuid)',
    'app_private.company_deletion_objects(uuid)',
    'app_private.company_deletion_plan(uuid)'] LOOP
    IF has_function_privilege('anon', v_sig::regprocedure, 'EXECUTE')
       OR has_function_privilege('authenticated', v_sig::regprocedure, 'EXECUTE')
       OR has_function_privilege('service_role', v_sig::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION '20261016140000 self-check 1: % is executable by an API role', v_sig;
    END IF;
  END LOOP;

  -- 2. The catalogue. The tables that were left behind by the direct delete are
  --    on the list, the records that are kept on purpose are not, and no table
  --    on the list has a company_id foreign key that does anything but cascade.
  SELECT string_agg(f.t, ', ') INTO v_missing
    FROM (VALUES ('drivers'), ('income'), ('cars'), ('user_profiles'), ('cash_transactions'),
                 ('historical_payroll_targets')) f(t)
   WHERE NOT EXISTS (SELECT 1 FROM app_private.company_deletion_tables() d
                      WHERE d.schema_name = 'public' AND d.table_name = f.t);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION '20261016140000 self-check 2: the company catalogue lost: %', v_missing;
  END IF;

  SELECT string_agg(d.schema_name || '.' || d.table_name, ', ') INTO v_wrong
    FROM app_private.company_deletion_tables() d
   WHERE (d.schema_name, d.table_name) IN (('app_private', 'platform_audit_log'),
                                           ('app_private', 'receipt_ocr_events'),
                                           ('public', 'activation_codes'),
                                           ('public', 'activation_code_attempts'));
  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '20261016140000 self-check 2: the catalogue would delete a record that is kept on purpose: %', v_wrong;
  END IF;

  IF EXISTS (SELECT 1
               FROM app_private.company_deletion_tables() d
               JOIN pg_constraint k ON k.conrelid = format('%I.%I', d.schema_name, d.table_name)::regclass
              WHERE k.contype = 'f' AND k.confrelid = 'public.companies'::regclass
                AND k.confdeltype <> 'c') THEN
    RAISE EXCEPTION '20261016140000 self-check 2: a listed table has a company foreign key that does not cascade';
  END IF;

  -- 3. The deletion's rules, fragment by fragment.
  v_body := (SELECT p.prosrc FROM pg_proc p WHERE p.oid = 'public.platform_company_delete(uuid,text)'::regprocedure);
  SELECT string_agg(f.fragment, '; ') INTO v_missing
    FROM (VALUES
      ('companies.hard_delete first', 'platform_rpc_authorize\(''companies\.hard_delete'', ''write'', c_action'),
      ('denied answer',               'platform_rpc_response\(''denied''\)'),
      ('marked deleted first',        'status IS DISTINCT FROM ''deleted'''),
      ('typed name',                  'btrim\(p_confirm_name\) IS DISTINCT FROM btrim\(v_company\.name\)'),
      ('the same plan as the preview','company_deletion_plan\(p_company_id\)'),
      ('the company is deleted',      'DELETE FROM public\.companies WHERE id = p_company_id'),
      ('no-FK tables are deleted',    'NOT t\.cascades'),
      ('verification with the counter','company_deletion_counts\(p_company_id\)'),
      ('nothing left or nothing done','v_left <> ''\{\}''::jsonb'),
      ('only the guard hint is caught','company_delete_context_open'),
      ('anything else is re-raised',  'RAISE;'),
      ('one audit row',               'platform_rpc_record\(''write'', c_action, NULL')
    ) AS f(fragment, pattern)
   WHERE v_body IS NULL OR v_body !~ f.pattern;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION '20261016140000 self-check 3: a rule of platform_company_delete is missing: %', v_missing;
  END IF;

  v_body := (SELECT p.prosrc FROM pg_proc p WHERE p.oid = 'app_private.company_deletion_plan(uuid)'::regprocedure);
  IF v_body !~ 'oauth_account_is_platform_staff\(p\.user_id\)' OR v_body !~ 'p\.company_id = p_company_id' THEN
    RAISE EXCEPTION '20261016140000 self-check 3: the plan no longer separates platform staff accounts or no longer scopes accounts to the company';
  END IF;

  -- The guard this function depends on still stands.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger g
                  WHERE g.tgrelid = 'public.companies'::regclass
                    AND g.tgname = 'guard_company_hard_delete'
                    AND g.tgenabled = 'O' AND NOT g.tgisinternal
                    AND g.tgfoid = 'app_private.guard_company_hard_delete()'::regprocedure) THEN
    RAISE EXCEPTION '20261016140000 self-check 3: companies carries no enabled guard_company_hard_delete trigger';
  END IF;

  -- 4. The edge door's list: the new action, and all twelve that were there.
  SELECT string_agg(format('%s/%s/%s', e.action, e.category, coalesce(e.capability, 'NULL')), '; ')
    INTO v_missing
    FROM (VALUES
      ('manage_users.list',            'read',  'business.read'),
      ('manage_users.create',          'write', 'company_users.manage'),
      ('manage_users.update',          'write', 'company_users.manage'),
      ('manage_users.set_status',      'write', 'company_users.manage'),
      ('manage_users.resend_invite',   'write', 'company_users.manage'),
      ('manage_users.reset_password',  'write', 'company_users.manage'),
      ('manage_users.delete',          'write', 'company_users.manage'),
      ('manage_users.unknown',         'write', NULL),
      ('activation_code.generate',     'write', 'codes.manage'),
      ('platform_staff_invite.create', 'write', 'staff.manage'),
      ('platform_staff_invite.resend', 'write', 'staff.manage'),
      ('platform_staff_role.set',      'write', 'staff.manage'),
      ('platform_company_hard_delete.execute', 'write', 'companies.hard_delete')
    ) AS e(action, category, capability)
   WHERE NOT EXISTS (SELECT 1 FROM app_private.platform_edge_audit_actions() a
                      WHERE a.action = e.action AND a.category = e.category
                        AND a.capability IS NOT DISTINCT FROM e.capability);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION '20261016140000 self-check 4: platform_edge_audit_actions lost a row: %', v_missing;
  END IF;
  IF (SELECT count(*) FROM app_private.platform_edge_audit_actions()) <> 13 THEN
    RAISE EXCEPTION '20261016140000 self-check 4: platform_edge_audit_actions names % rows, expected 13',
      (SELECT count(*) FROM app_private.platform_edge_audit_actions());
  END IF;

  -- 5. The capability is the owner's alone, read from the matrix itself.
  IF EXISTS (SELECT 1 FROM app_private.platform_capability_matrix() m
              WHERE m.capability = 'companies.hard_delete' AND m.role <> 'owner') THEN
    RAISE EXCEPTION '20261016140000 self-check 5: companies.hard_delete is no longer the owner''s alone';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_private.platform_capability_matrix() m
                  WHERE m.capability = 'companies.hard_delete' AND m.role = 'owner') THEN
    RAISE EXCEPTION '20261016140000 self-check 5: the owner no longer holds companies.hard_delete';
  END IF;

  -- 6. The three guards: the original refusal is still there, and so is the
  --    condition that lets a company's own cascade through.
  SELECT string_agg(f.name, '; ') INTO v_missing
    FROM (VALUES
      ('prevent_finalized_import_delete: refusal',   'public.prevent_finalized_import_delete()',            'IF v_finalizations > 0'),
      ('prevent_finalized_import_delete: its message', 'public.prevent_finalized_import_delete()',          'abgeschlossene Planung'),
      ('prevent_finalized_import_delete: only while the company exists', 'public.prevent_finalized_import_delete()', 'FROM public\.companies c WHERE c\.id = OLD\.company_id'),
      ('monthly_plan_guard: a confirmed plan is not deleted', 'app_private.monthly_plan_guard()',        'OLD\.status <> ''draft''\s+AND EXISTS'),
      ('monthly_plan_guard: its hint',                'app_private.monthly_plan_guard()',                   'monthly_plan_is_final'),
      ('monthly_plan_guard: only while the company exists', 'app_private.monthly_plan_guard()',          'FROM public\.companies c WHERE c\.id = OLD\.company_id'),
      ('monthly_plan_guard: the transition rule',     'app_private.monthly_plan_guard()',                   'monthly_plan_transition_needs_rpc'),
      ('parent_is_open: a confirmed plan is frozen',  'app_private.monthly_plan_parent_is_open(uuid,uuid)', 'v_plan\.status <> ''draft'''),
      ('parent_is_open: the company mismatch',        'app_private.monthly_plan_parent_is_open(uuid,uuid)', 'monthly_plan_company_mismatch'),
      ('parent_is_open: only while the company exists', 'app_private.monthly_plan_parent_is_open(uuid,uuid)', 'NOT EXISTS \(SELECT 1 FROM public\.companies c WHERE c\.id = p_company_id\)')
    ) AS f(name, sig, pattern)
   WHERE (SELECT p.prosrc FROM pg_proc p WHERE p.oid = f.sig::regprocedure) !~ f.pattern;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION '20261016140000 self-check 6: a guard lost a rule or the cascade exception: %', v_missing;
  END IF;
  FOREACH v_sig IN ARRAY ARRAY['public.prevent_finalized_import_delete()', 'app_private.monthly_plan_guard()',
                               'app_private.monthly_plan_parent_is_open(uuid,uuid)'] LOOP
    IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = v_sig::regprocedure) THEN
      RAISE EXCEPTION '20261016140000 self-check 6: % is no longer SECURITY DEFINER', v_sig;
    END IF;
  END LOOP;
END $$;
