/*
  # The platform team, read from its own table (plan 3.12)

  Builds on 20260916110000 (the staff table and its audit trigger),
  20260916130010 (platform_staff_add, _disable and _enable) and 20260916140000
  (the five audited read models and their helpers). Nothing here redefines
  any of them, and nothing restates the session helpers of 20260919130000 or
  20260920100000's jwt_amr(): the function reaches them only through
  platform_can() and platform_read_record(), as the other read models do.

  ## What was wrong

  The Team page (/admin/team, slice 3.6c) shipped without a read model.
  `app_private.platform_staff` is not served by PostgREST, and
  `platform_users_list` deliberately leaves out every account that has a staff
  row, so the page rebuilt the roster by folding the audit log: the trigger
  `platform_staff_audit()` writes the whole row on every change, and the newest
  row per user id was taken as the table's content. Three consequences:

  - The roster lived only as long as the log. Audit retention (open decision
    D4) would have dropped a member added long ago with no later change from the
    list while that member kept full access to every customer's data, and
    nothing on the screen would have said so, because the fold never saw the row.
  - It could not show who granted a membership.
  - Members were identified by a shortened user id; nothing resolved one to a
    person.

  ## What this adds

  - `public.platform_staff_list(p_status, p_sort, p_limit, p_offset)`: the
    sixth audited read model, in exactly the shape of 20260916140000:
    SECURITY DEFINER with a pinned search_path, executable by `authenticated`
    alone, VOLATILE so supabase-js calls it with POST, the arguments validated
    first (22023 on a broken contract, before anything is read or recorded), a
    refusal returned as `{"ok": false, "reason": "not_authorized"}`, and one
    `read` row per call, action `platform_read.staff_list`, written through
    `app_private.platform_read_record` in the same transaction. A caller
    without an active staff role is refused with no row at all, as every read
    model refuses it.
  - `app_private.platform_staff_list_statement()`: the one SQL statement the
    function runs, returned as text so tests/rls/platform-readmodels.sql can
    EXPLAIN exactly what production runs.

  ## Who may read the roster: staff.manage

  Owners only, today. The roster is the list of people who hold platform
  rights, with their sign-in addresses, so it is also a list of targets: every
  platform account signs in on the one public screen (/login) with an address
  and a password, and the rate limit there is per client address, not per
  account. A support, billing or read_only account whose password leaks should
  not hand over the addresses of the owners as well.

  - The capability that manages the team is the one that reads it, so the page
    is whole for exactly the role that may act on it, and the sidebar already
    shows the entry only for staff.manage.
  - Not audit.read. The page used to need it only because it folded the log.
    Tying the roster to audit.read would let open decision D3 (who reads the
    whole log) widen the roster by accident.
  - Not companies.read, which all four roles hold: read_only reading who can
    read everything is exactly the question to answer no to until the owner
    decides otherwise.

  Every staff member already learns its own role from platform_whoami().

  ## Columns, for the data protection review

  This is a platform-internal list of the people who hold platform rights, so
  the address is the point: an owner deciding who may keep access has to know
  who each row is. It is read from auth.users, the account's sign-in address.

    user_id, email, role, status ('active' or 'disabled'), disabled_at, note,
    created_at, created_by, created_by_email, invitation_pending

  - `created_by` is the table's own column: platform_staff_add writes the
    caller's id there. `created_by_email` resolves it through auth.users, and
    is NULL when nobody is recorded or that account no longer exists.
  - `invitation_pending` is true while the account's profile is still
    `pending_invite`, which is the only state in which otp_issue sends an
    invitation code again, so the page offers "resend" exactly then.
  - Left out: every other auth.users column (password hash, phone, metadata,
    tokens, sign-in times), and the profile apart from that one status. The
    full name is left out too; the address already identifies the account.

  The statement joins auth.users twice and reads nothing from it but `id` and
  `email`; the self-check below fails a release that reads another column.

  ## Who granted it: the actor finding

  The request was to find why platform_staff_add's audit row carries no actor
  while the function knows auth.uid(). Traced end to end, it does carry one:

  - platform_staff_add writes `created_by = auth.uid()`;
  - its own row (`platform_staff.add`, through platform_rpc_finish) and the
    trigger's row (`platform_staff.insert`) both reach audit_write without an
    actor argument, and audit_write takes `coalesce(p_actor_user_id,
    auth.uid())`. PostgREST v12 sets the caller's claims for the whole
    transaction, triggers included, and GoTrue's auth.uid() reads them;
  - disable and enable reach it the same way.

  The NULLs measured on staging on 16.09.2026 (actor_user_id and actor_role on
  all three staff rows) came from rows written without any session: the
  backfill of 20260916110000, which is a migration, and two statements run by
  hand as supabase_admin that day (one account added, another disabled). A
  statement without a session has no actor to record, and NULL is the true
  answer there, not a defect. Nothing is redefined for it:
  tests/rls/platform-readmodels.sql, section 11, pins that a change made
  through the functions carries the caller as actor, with its role, on both
  rows, and sets created_by. Existing rows stay as they are; the log is
  append-only.

  What stays true by construction: any path that writes the table outside a
  session (a migration, psql, a host script) leaves no actor and no creator.
  The page says "not recorded" for such a row rather than inventing one.

  ## What this does not do

  - platform_staff_add and platform_staff_enable still refuse every role but
    owner (`role_requires_3_3`), and nothing here redefines them. The last
    technical reason for the guard went with 20260920100000, which stopped a
    `view` support context writing the `documents` bucket. Lifting it is now a
    product decision — it decides which accounts may read every customer's
    data — and belongs in a change of its own that the owner sees on its own,
    not inside the roster. The page says the other roles are not enabled yet,
    where a role picker would go.
  - No audit retention. Once this release is live the Team page no longer reads
    the log, which is what 3.12 had to deliver before D4.

  ## Compatibility

  Expand-only: two new functions, nothing redefined, no table touched. The
  previous release's page folds the log and never calls the new function. No
  SCHEMA_EPOCH bump.
*/

-- ─── Statement ──────────────────────────────────────────────────────────────

-- $1 status ('active' | 'disabled' | NULL for both), $2 sort, $3 limit,
-- $4 offset. Returns one jsonb value: {"total": n, "items": [...]}.
CREATE OR REPLACE FUNCTION app_private.platform_staff_list_statement()
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  RETURN $sql$
WITH filtered AS (
  SELECT s.user_id, au.email, s.role, s.disabled_at, s.note, s.created_at, s.created_by,
         cb.email AS created_by_email,
         coalesce(up.status = 'pending_invite', false) AS invitation_pending
    FROM app_private.platform_staff s
    LEFT JOIN auth.users au ON au.id = s.user_id
    LEFT JOIN auth.users cb ON cb.id = s.created_by
    LEFT JOIN public.user_profiles up ON up.user_id = s.user_id
   WHERE $1::text IS NULL
      OR ($1::text = 'active'   AND s.disabled_at IS NULL)
      OR ($1::text = 'disabled' AND s.disabled_at IS NOT NULL)
),
page AS (
  SELECT f.*,
         row_number() OVER (ORDER BY
           CASE WHEN $2::text = 'status_asc'      THEN (f.disabled_at IS NOT NULL) END ASC NULLS LAST,
           CASE WHEN $2::text = 'status_asc'      THEN lower(f.email) END ASC  NULLS LAST,
           CASE WHEN $2::text = 'email_asc'       THEN lower(f.email) END ASC  NULLS LAST,
           CASE WHEN $2::text = 'created_at_asc'  THEN f.created_at END ASC  NULLS LAST,
           CASE WHEN $2::text = 'created_at_desc' THEN f.created_at END DESC NULLS LAST,
           f.user_id) AS ord
    FROM filtered f
   ORDER BY ord
   LIMIT $3::integer OFFSET $4::integer
)
SELECT jsonb_build_object(
  'total', (SELECT count(*) FROM filtered),
  'items', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'user_id',            p.user_id,
             'email',              p.email,
             'role',               p.role,
             'status',             CASE WHEN p.disabled_at IS NULL THEN 'active' ELSE 'disabled' END,
             'disabled_at',        p.disabled_at,
             'note',               p.note,
             'created_at',         p.created_at,
             'created_by',         p.created_by,
             'created_by_email',   p.created_by_email,
             'invitation_pending', p.invitation_pending
           ) ORDER BY p.ord)
      FROM page p
  ), '[]'::jsonb))
$sql$;
END;
$fn$;

-- ─── platform_staff_list ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.platform_staff_list(
  p_status text    DEFAULT NULL,
  p_sort   text    DEFAULT 'status_asc',
  p_limit  integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_action   CONSTANT text   := 'platform_read.staff_list';
  c_sorts    CONSTANT text[] := ARRAY['status_asc', 'email_asc', 'created_at_asc', 'created_at_desc'];
  c_statuses CONSTANT text[] := ARRAY['active', 'disabled'];
  v_status  text;
  v_sort    text;
  v_limit   integer;
  v_offset  integer;
  v_request jsonb;
  v_page    jsonb;
BEGIN
  v_status := app_private.platform_read_token(p_status);
  v_sort   := coalesce(app_private.platform_read_token(p_sort), 'status_asc');
  v_limit  := app_private.platform_read_limit(p_limit);
  v_offset := app_private.platform_read_offset(p_offset);

  IF v_sort <> ALL (c_sorts)
     OR (v_status IS NOT NULL AND v_status <> ALL (c_statuses))
  THEN
    RAISE EXCEPTION 'platform_staff_list: invalid arguments' USING ERRCODE = '22023';
  END IF;

  v_request := jsonb_strip_nulls(jsonb_build_object(
    'status', v_status, 'sort', v_sort, 'limit', v_limit, 'offset', v_offset));

  IF NOT coalesce(public.platform_can('staff.manage'), false) THEN
    PERFORM app_private.platform_read_record(c_action, 'denied', NULL, 'platform_staff',
                                             jsonb_build_object('request', v_request));
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
  END IF;

  EXECUTE app_private.platform_staff_list_statement() INTO v_page
    USING v_status, v_sort, v_limit, v_offset;

  PERFORM app_private.platform_read_record(c_action, 'ok', NULL, 'platform_staff',
    jsonb_build_object('request', v_request,
                       'returned', jsonb_array_length(v_page -> 'items'),
                       'total', v_page -> 'total'));

  RETURN jsonb_build_object('ok', true, 'total', v_page -> 'total', 'limit', v_limit,
                            'offset', v_offset, 'items', v_page -> 'items');
END;
$$;

COMMENT ON FUNCTION public.platform_staff_list(text, text, integer, integer) IS
  'The platform team with each member''s sign-in address, for staff.manage. '
  'One audited read per call (platform_read.staff_list). 20260920140000.';

-- ─── Ownership and privileges ───────────────────────────────────────────────

-- The public function reaches app_private, so it must belong to a role that
-- can (see "Ownership" in 20260916110010). Both are new and already belong to
-- the migration role; stated so a later copy of this block cannot forget it.
ALTER FUNCTION app_private.platform_staff_list_statement() OWNER TO CURRENT_USER;
ALTER FUNCTION public.platform_staff_list(text, text, integer, integer) OWNER TO CURRENT_USER;

REVOKE ALL ON FUNCTION app_private.platform_staff_list_statement()
  FROM PUBLIC, anon, authenticated, service_role;

-- anon and the service role have no auth.uid() to answer for.
REVOKE ALL ON FUNCTION public.platform_staff_list(text, text, integer, integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_staff_list(text, text, integer, integer)
  TO authenticated;

-- ─── Self-check ─────────────────────────────────────────────────────────────

DO $selfcheck$
DECLARE
  c_keys CONSTANT text[] := ARRAY['created_at', 'created_by', 'created_by_email', 'disabled_at', 'email',
                                  'invitation_pending', 'note', 'role', 'status', 'user_id'];
  v_wrong   text;
  v_src     text;
  v_stmt    text;
  v_page    jsonb;
  v_item    jsonb;
  v_keys    text[];
  v_checked integer := 0;
BEGIN
  -- 1. Both functions: SECURITY DEFINER where it should be, VOLATILE where it
  --    writes the log, a pinned search_path, an owner that can reach
  --    app_private, and exactly the stated EXECUTE grants.
  SELECT string_agg(format('%s (%s)', f.sig, f.problem), '; ') INTO v_wrong
    FROM (
      SELECT v.sig, CASE
               WHEN to_regprocedure(v.sig) IS NULL THEN 'missing'
               WHEN (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(v.sig)) IS DISTINCT FROM v.definer
                 THEN 'SECURITY DEFINER should be ' || v.definer
               WHEN v.volatile AND (SELECT p.provolatile FROM pg_proc p WHERE p.oid = to_regprocedure(v.sig)) <> 'v'
                 THEN 'must be VOLATILE: it writes the audit log'
               WHEN NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proconfig) c(setting)
                                 WHERE p.oid = to_regprocedure(v.sig) AND c.setting LIKE 'search_path=%')
                 THEN 'no pinned search_path'
               WHEN NOT EXISTS (
                      SELECT 1
                        FROM pg_proc p
                        JOIN pg_roles r ON r.oid = p.proowner
                       WHERE p.oid = to_regprocedure(v.sig)
                         AND (r.rolsuper OR r.oid = (SELECT n.nspowner FROM pg_namespace n WHERE n.nspname = 'app_private')))
                 THEN 'owner can call no app_private helper'
               WHEN has_function_privilege('anon', to_regprocedure(v.sig), 'EXECUTE')
                 THEN 'anon must not hold EXECUTE'
               WHEN has_function_privilege('authenticated', to_regprocedure(v.sig), 'EXECUTE') IS DISTINCT FROM v.authn
                 THEN 'authenticated EXECUTE should be ' || v.authn
               WHEN has_function_privilege('service_role', to_regprocedure(v.sig), 'EXECUTE')
                 THEN 'service_role must not hold EXECUTE'
             END AS problem
        FROM (VALUES
          -- signature                                                   definer volatile authn
          ('public.platform_staff_list(text,text,integer,integer)',      true,   true,    true),
          ('app_private.platform_staff_list_statement()',                false,  false,   false)
        ) AS v(sig, definer, volatile, authn)
    ) f
   WHERE f.problem IS NOT NULL;

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '20260920140000 self-check: %', v_wrong;
  END IF;

  -- 2. What it calls exists, with the signatures 20260916140000 gave them.
  SELECT string_agg(v.sig, ', ') INTO v_wrong
    FROM (VALUES
      ('app_private.platform_read_record(text,text,uuid,text,jsonb)'),
      ('app_private.platform_read_token(text)'),
      ('app_private.platform_read_limit(integer)'),
      ('app_private.platform_read_offset(integer)'),
      ('public.platform_can(text)')
    ) AS v(sig)
   WHERE to_regprocedure(v.sig) IS NULL;

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '20260920140000 self-check: a helper the read model calls is missing: %', v_wrong;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM app_private.platform_capability_matrix() m
                  WHERE m.capability = 'staff.manage' AND m.role = 'owner') THEN
    RAISE EXCEPTION '20260920140000 self-check: the capability matrix has no staff.manage for owner';
  END IF;

  -- 3. The function asks staff.manage, records through platform_read_record and
  --    runs its own statement. Its body carries no comment, so these can only
  --    match code.
  SELECT p.prosrc INTO v_src
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.platform_staff_list(text,text,integer,integer)');

  IF v_src NOT LIKE '%public.platform_can(''staff.manage'')%'
     OR v_src NOT LIKE '%app_private.platform_read_record(%'
     OR v_src NOT LIKE '%app_private.platform_staff_list_statement()%'
     OR v_src NOT LIKE '%''platform_read.staff_list''%'
  THEN
    RAISE EXCEPTION '20260920140000 self-check: platform_staff_list does not check, record or run what it should';
  END IF;

  -- 4. The statement reads no column of auth.users but the id it joins on and
  --    the address. Every reference through its two aliases is collected; the
  --    statement text carries no comment either.
  v_stmt := app_private.platform_staff_list_statement();

  SELECT string_agg(DISTINCT m.ref[1] || '.' || m.ref[2], ', ') INTO v_wrong
    FROM regexp_matches(v_stmt, '\m(au|cb)\.([a-z_]+)', 'g') AS m(ref)
   WHERE m.ref[2] NOT IN ('id', 'email');

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '20260920140000 self-check: the statement reads more of auth.users than the address: %', v_wrong;
  END IF;

  IF v_stmt ~ '(fahrtenbuch_trips|receipts|encrypted_password|raw_user_meta_data|raw_app_meta_data)' THEN
    RAISE EXCEPTION '20260920140000 self-check: the statement reads something a staff roster has no use for';
  END IF;

  -- 5. platform_audit_record refuses the namespace this read model writes,
  --    as it has since 20260916140000.
  BEGIN
    PERFORM public.platform_audit_record('read', 'platform_read.staff_list', 'ok');
    RAISE EXCEPTION '20260920140000 self-check: platform_audit_record accepts platform_read.staff_list'
      USING ERRCODE = 'P0001';
  EXCEPTION WHEN invalid_parameter_value THEN
    NULL;
  END;

  -- 6. The statement plans against the real schema, and runs. Where the table
  --    has rows (the live databases; the RLS kit seeds its staff after the
  --    migrations) every item carries exactly the documented keys.
  EXECUTE 'EXPLAIN ' || v_stmt USING NULL::text, 'status_asc'::text, 50, 0;

  EXECUTE v_stmt INTO v_page USING NULL::text, 'status_asc'::text, 100, 0;

  IF v_page IS NULL OR jsonb_typeof(v_page -> 'items') IS DISTINCT FROM 'array'
     OR (v_page ->> 'total')::bigint IS DISTINCT FROM (SELECT count(*) FROM app_private.platform_staff) THEN
    RAISE EXCEPTION '20260920140000 self-check: the statement does not answer {total, items} for the whole table';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(v_page -> 'items') AS t(value) LOOP
    SELECT array_agg(k ORDER BY k) INTO v_keys FROM jsonb_object_keys(v_item) AS k;
    -- Compared as sets, so the answer does not depend on how this database's
    -- collation orders an underscore.
    IF NOT (coalesce(v_keys, '{}'::text[]) @> c_keys AND coalesce(v_keys, '{}'::text[]) <@ c_keys) THEN
      RAISE EXCEPTION '20260920140000 self-check: an item carries % instead of the documented columns', v_keys;
    END IF;
    v_checked := v_checked + 1;
  END LOOP;

  IF v_checked = 0 THEN
    RAISE NOTICE '20260920140000 self-check: no platform_staff row here; the item columns are checked by tests/rls/platform-readmodels.sql';
  END IF;
END
$selfcheck$;
