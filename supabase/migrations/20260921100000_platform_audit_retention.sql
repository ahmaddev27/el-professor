/*
  # Retention of the platform audit log (decision D4)

  The owner delegated D4 on 21.09.2026 and it is made: rows of category `read`
  are kept 12 months, every other category 36 months, and then a daily job
  deletes them. This file builds that job. It installs nothing on a host and
  deletes nothing when it is applied.

  ## Why this can be built now

  `app_private.platform_audit_log` was append-only with no way out, on purpose:
  until slice 3.12 the Team page folded this log into the platform roster, so a
  retention job would have dropped a member added long ago from the roster while
  the member kept full access. 3.12 (`platform_staff_list`, 20260920140000) reads
  the staff table itself and is live on production since 21.09.2026.

  What still reads history out of the log, searched in src, the edge functions,
  every migration and deploy/:

    platform_audit_list                 the Protokoll screen; reads what exists
    platform_rpc_authorize              at most 30 `denied` rows per actor in the
                                        last minute (20260916130000)
    platform_audit_record               at most 120 edge rows per actor in the
                                        last minute (20260916150000)
    platform_settings_rate_limited      at most 120 settings rows per actor in
                                        the last minute (20260920130000)
    platform_self_email_change_check    at most 5 completed changes per account
                                        in the last hour (20260919140000)

  The longest window any of them counts is one hour, and the shortest period
  kept here is twelve months, so the purge cannot reach a row any of them
  counts. Nothing else reads the log: the company lifecycle deliberately does
  not read a prior status back out of it (HANDOFF.md, 3.5), and 3.4c's
  "wrote in a support session earlier in this transaction" is a setting, not a
  read of the log.

  ## Nothing is deleted before September 2027

  `read` rows exist since slice 3.1 and 3.6b (16.09.2026 on staging, later on
  production); `audit_write` stamps every category but `legacy` with now(), so
  none can be older. Every other category needs 36 months. `legacy` rows carry
  the `created_at` of the two tables 20260916110000 copied, which were created
  by 20260607125649 and 20260621114828 with `DEFAULT now()`, so the first of
  them is reached in June 2029 at the earliest. HANDOFF.md carries the
  read-only query that confirms the oldest row per category on a live database
  before the job is installed.

  ## What this adds

    app_private.platform_audit_purge()            deletes what has expired and
                                                  returns, per category, the
                                                  cut-off and how many rows went
    app_private.platform_audit_log_refuse_change()  restated: the one narrow way
                                                  past it (below)
    both append-only triggers                     ENABLE ALWAYS
    platform_audit_log_read_occurred_at           a partial index on the read
                                                  rows' timestamp

  ## The rule, and where its numbers live

  A `read` row older than 12 months goes; any other row older than 36 months
  goes. "Older than" is strict: a row stamped exactly on the cut-off stays one
  more day. The periods are CONSTANTs in the purge function and nowhere else,
  as every other limit in app_private is.

  The cut-off is counted in Europe/Berlin wall-clock months: now() in Berlin,
  minus the months, read back as Berlin time. So the answer does not depend on
  the TimeZone of whichever session runs the job (the kit runs in UTC), and
  "12 months" means what a German privacy policy means by it, including across
  a change to or from summer time. `now()` is the transaction's start, so every
  statement of one run uses the same cut-off.

  ## The narrow way past the append-only trigger

  The trigger still refuses every UPDATE and every TRUNCATE, by anyone. It lets
  a DELETE of a row through only when both of these hold:

  1. The setting `app_private.audit_purge_marker` holds exactly
     `purge:<this transaction's id>`. The purge sets it immediately before its
     one DELETE and clears it immediately after, so it exists only for the
     duration of that statement: a DELETE later in the same transaction is
     refused again, and a failed DELETE aborts the transaction or
     subtransaction, which puts the setting back. Binding it to the
     transaction id means a value left in a session, a role default
     (`ALTER ROLE … SET`) or a database default can never be the marker,
     because it cannot know the id of a transaction that did not exist yet.
  2. The statement runs as a member of the table's owner (`pg_has_role`,
     which a superuser always is). The purge is SECURITY INVOKER and is run by
     `supabase_admin`, the owner.

  ### Why a client cannot reach it

  - **No API role can issue the DELETE at all.** `anon`, `authenticated` and
    `service_role` hold no USAGE on app_private and no privilege on the table,
    so their DELETE fails with 42501 before the trigger runs, marker or not.
    Condition 2 is a second wall against the day someone grants more than they
    meant to: 20250930185334 once ran GRANT ALL ON ALL TABLES IN SCHEMA public
    TO service_role, and a like grant on this schema would still not make an
    API role a member of the owner.
  - **No function a client can call deletes from the log.** The self-check
    below reads every function in public and app_private and fails a release
    in which anything but the purge names a DELETE, UPDATE or TRUNCATE of the
    table, or anything but the purge and the trigger names the marker. The
    table has no foreign keys, so no cascade reaches it either.
  - **No client can call the purge.** EXECUTE is revoked from PUBLIC, anon,
    authenticated and service_role, and it lives in a schema none of them may
    use. It is SECURITY INVOKER, so a grant that leaked later would still run
    it as the caller, who holds no DELETE.
  - **No client can set the marker.** PostgREST sets only its own `request.`
    settings, the role and the search path, the claims come from a token this
    stack signed, and the only function that calls set_config with this name
    is the purge.
    Placeholder settings are user-settable in SQL, which is exactly why the
    marker alone is not trusted: an API role that set it would still meet the
    missing privilege and condition 2.

  The shape follows 3.4c's flag (a transaction-local setting that only one
  function writes, judged by the trigger that reads it) and U3's
  `current_user` test (a fact about the role the statement runs as, which no
  claim can change).

  ### What it cannot do

  Hold a superuser who means it. `supabase_admin` at a psql prompt is refused a
  plain DELETE, UPDATE or TRUNCATE, and since this file also with
  `session_replication_role = replica` (which skips ordinary triggers — hence
  ENABLE ALWAYS); but a superuser can disable or drop the trigger, and one who
  types the marker by hand passes as the purge does. The kit pins that last one
  as the documented residual. It is the same limit U3 states for its wall: an
  operator is not someone a trigger can hold, so the purge is the way an
  operator removes rows, and the nightly backup (which carries app_private
  since 18.09.2026) is the record of what was there.

  ## The purge's own row

  One per run, also when nothing was deleted: category `settings`, action
  `platform_audit.purge`, outcome `ok`, target_type `platform_audit_log`, no
  company, and in `after_value` the two periods, the zone, both cut-offs, the
  count deleted per category (all seven, zeros included) and the total. The
  actor is the caller's JWT subject, which a host cron does not have, so it is
  NULL.

  Why `settings`: the retention periods are how the platform is run, decided
  by the owner, and `settings` is the category of the platform's own
  configuration, readable in full only with `audit.read` (owner). It must not
  be `read` or `write`, the two categories `platform_audit_record` accepts from
  the edge functions. `legacy` means "copied from a table that predates 3.1"
  and is the only category allowed its own timestamp, so a new row there would
  blur exactly the rows a reader has to treat with care. `staff`, `auth` and
  `support` belong to the trigger, sign-in and support-session rows.
  `platform_audit_record` refuses the action in every category, because its
  allow-list (20260916150000) names only what the edge functions send; like
  3.9 and 3.4c, this file asserts that instead of redefining the function.

  The purge row is itself a non-`read` row, so it is kept 36 months: the record
  that read rows were removed outlives them by two years.

  ## Cost

  The job runs once a day and deletes one day's expired rows. The DELETE
  reaches read rows through the new partial index and every other row through
  `platform_audit_log_occurred_at`, so it never walks the rows it keeps. The
  index costs one entry per read row written. Runs are serialised by an
  advisory lock, so two overlapping cron runs cannot count each other's rows.

  ## How it is run

  By a host cron as `supabase_admin`, staging first, production after. The
  exact lines, and the dry run to take first (the same call inside BEGIN …
  ROLLBACK), are in HANDOFF.md. Nothing calls the purge until someone installs
  them.

  ## Compatibility — SCHEMA_EPOCH stays at 2

  Additive: a new function, a trigger function restated with every refusal it
  had and one path more, the triggers' enable mode, and an index. No column,
  policy or grant an API role holds changes. The previous release never
  deletes from the log, so a rollback leaves nothing it depends on changed.
*/

-- ─── 1. The index the read half of the purge walks ─────────────────────────

CREATE INDEX IF NOT EXISTS platform_audit_log_read_occurred_at
  ON app_private.platform_audit_log (occurred_at)
  WHERE category = 'read';

-- ─── 2. The trigger, with its one narrow path ──────────────────────────────

-- Every refusal of 20260916110000 is kept: UPDATE and TRUNCATE always, DELETE
-- unless the purge's marker names this transaction and the statement runs as
-- a member of the table's owner. SQLSTATE and message are unchanged. It must
-- stay SECURITY INVOKER: as a definer, pg_has_role would always be asked about
-- its owner. The self-check fails a release where that changes.
CREATE OR REPLACE FUNCTION app_private.platform_audit_log_refuse_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_marker CONSTANT text := 'app_private.audit_purge_marker';
BEGIN
  IF TG_OP = 'DELETE'
     AND TG_LEVEL = 'ROW'
     AND current_setting(c_marker, true) = 'purge:' || pg_current_xact_id()::text
     AND pg_has_role((SELECT c.relowner FROM pg_class c WHERE c.oid = TG_RELID), 'MEMBER')
  THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'platform_audit_log is append-only: % refused', TG_OP USING ERRCODE = 'P0001';
END;
$$;

-- An ordinary trigger does not fire under session_replication_role = replica,
-- which a superuser can set for a session. ALWAYS closes that side door; what
-- stays open to a superuser is disabling or dropping the trigger (the header).
ALTER TABLE app_private.platform_audit_log ENABLE ALWAYS TRIGGER platform_audit_log_append_only;
ALTER TABLE app_private.platform_audit_log ENABLE ALWAYS TRIGGER platform_audit_log_no_truncate;

-- ─── 3. The purge ──────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION app_private.platform_audit_purge()
RETURNS TABLE (category text, cut_off timestamptz, deleted bigint)
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $$
DECLARE
  -- Decision D4 (21.09.2026). The only place these numbers live.
  c_read_months  CONSTANT integer := 12;
  c_other_months CONSTANT integer := 36;
  c_zone         CONSTANT text    := 'Europe/Berlin';
  c_marker       CONSTANT text    := 'app_private.audit_purge_marker';
  c_categories   CONSTANT text[]  := ARRAY['read', 'write', 'support', 'auth', 'settings', 'staff', 'legacy'];

  v_wall      timestamp := now() AT TIME ZONE c_zone;
  v_read_cut  timestamptz;
  v_other_cut timestamptz;
  v_gone      jsonb;
  v_counts    jsonb;
  v_total     bigint;
BEGIN
  -- One run at a time: a second run waits, then finds the first one's rows
  -- gone (its DELETE takes a fresh snapshot) and removes nothing twice.
  PERFORM pg_advisory_xact_lock(hashtextextended('app_private.platform_audit_purge', 0));

  v_read_cut  := (v_wall - make_interval(months => c_read_months))  AT TIME ZONE c_zone;
  v_other_cut := (v_wall - make_interval(months => c_other_months)) AT TIME ZONE c_zone;

  -- The marker exists for this one statement.
  PERFORM set_config(c_marker, 'purge:' || pg_current_xact_id()::text, true);

  WITH gone AS (
    DELETE FROM app_private.platform_audit_log l
     WHERE (l.category = 'read'  AND l.occurred_at < v_read_cut)
        OR (l.category <> 'read' AND l.occurred_at < v_other_cut)
    RETURNING l.category AS cat
  )
  SELECT coalesce(jsonb_object_agg(k.cat, k.n), '{}'::jsonb), coalesce(sum(k.n), 0)::bigint
    INTO v_gone, v_total
    FROM (SELECT g.cat, count(*) AS n FROM gone g GROUP BY g.cat) k;

  PERFORM set_config(c_marker, '', true);

  -- All seven categories, zeros included, so a reader never has to guess
  -- whether a missing key means none or not counted.
  SELECT jsonb_object_agg(c.cat, coalesce((v_gone ->> c.cat)::bigint, 0))
    INTO v_counts
    FROM unnest(c_categories) AS c(cat);

  PERFORM app_private.audit_write(
    p_category    => 'settings',
    p_action      => 'platform_audit.purge',
    p_outcome     => 'ok',
    p_target_type => 'platform_audit_log',
    p_after       => jsonb_build_object(
                       'retention_months', jsonb_build_object('read', c_read_months, 'other', c_other_months),
                       'time_zone',        c_zone,
                       'cut_off',          jsonb_build_object('read', v_read_cut, 'other', v_other_cut),
                       'deleted',          v_counts,
                       'deleted_total',    v_total));

  RETURN QUERY
    SELECT c.cat,
           CASE WHEN c.cat = 'read' THEN v_read_cut ELSE v_other_cut END,
           (v_counts ->> c.cat)::bigint
      FROM unnest(c_categories) WITH ORDINALITY AS c(cat, ord)
     ORDER BY c.ord;
END;
$$;

COMMENT ON FUNCTION app_private.platform_audit_purge() IS
  'Decision D4: deletes platform audit rows of category read older than 12 months '
  'and all others older than 36 months (Europe/Berlin months), writes one settings '
  'row platform_audit.purge per run, and returns the cut-off and count per '
  'category. Run daily by a host cron as supabase_admin (20260921100000).';

-- ─── 4. Ownership and privileges ───────────────────────────────────────────

ALTER FUNCTION app_private.platform_audit_purge()             OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.platform_audit_log_refuse_change() OWNER TO CURRENT_USER;

REVOKE ALL ON FUNCTION app_private.platform_audit_purge()             FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.platform_audit_log_refuse_change() FROM PUBLIC, anon, authenticated, service_role;

-- ─── 5. Self-check ─────────────────────────────────────────────────────────

DO $selfcheck$
DECLARE
  c_marker CONSTANT text := 'app_private.audit_purge_marker';

  v_wrong       text;
  v_triggers    text;
  v_refused     boolean;
  v_old_read    bigint;
  v_young_read  bigint;
  v_old_write   bigint;
  v_young_write bigint;
  v_before_id   bigint;
  v_n_read      bigint;
  v_n_other     bigint;
  v_rows        integer;
  v_row         app_private.platform_audit_log%ROWTYPE;
BEGIN
  -- 1. Both functions: SECURITY INVOKER, a pinned search_path, an owner that
  --    reaches app_private, and no EXECUTE for any role the API authenticates
  --    as. The purge deletes, so it is VOLATILE.
  SELECT string_agg(format('%s (%s)', f.sig, f.problem), '; ' ORDER BY f.sig) INTO v_wrong
    FROM (
      SELECT v.sig, CASE
               WHEN to_regprocedure(v.sig) IS NULL THEN 'missing'
               WHEN (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(v.sig))
                 THEN 'must be SECURITY INVOKER'
               WHEN (SELECT p.provolatile FROM pg_proc p WHERE p.oid = to_regprocedure(v.sig)) <> 'v'
                 THEN 'must be VOLATILE'
               WHEN NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proconfig) c(setting)
                                 WHERE p.oid = to_regprocedure(v.sig) AND c.setting LIKE 'search_path=%')
                 THEN 'no pinned search_path'
               WHEN NOT EXISTS (
                      SELECT 1 FROM pg_proc p
                        JOIN pg_roles r ON r.oid = p.proowner
                       WHERE p.oid = to_regprocedure(v.sig)
                         AND (r.rolsuper OR r.oid = (SELECT n.nspowner FROM pg_namespace n WHERE n.nspname = 'app_private')))
                 THEN 'owner cannot reach app_private'
               WHEN has_function_privilege('anon', to_regprocedure(v.sig), 'EXECUTE')
                 OR has_function_privilege('authenticated', to_regprocedure(v.sig), 'EXECUTE')
                 OR has_function_privilege('service_role', to_regprocedure(v.sig), 'EXECUTE')
                 THEN 'executable by a role the API authenticates as'
             END AS problem
        FROM (VALUES
          ('app_private.platform_audit_purge()'),
          ('app_private.platform_audit_log_refuse_change()')
        ) AS v(sig)
    ) f
   WHERE f.problem IS NOT NULL;

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '20260921100000 self-check: %', v_wrong;
  END IF;

  -- 2. The table carries exactly its two guards, both ALWAYS, both calling the
  --    restated function: BEFORE UPDATE OR DELETE per row (tgtype 27 = ROW 1 +
  --    BEFORE 2 + DELETE 8 + UPDATE 16) and BEFORE TRUNCATE per statement
  --    (34 = BEFORE 2 + TRUNCATE 32). The partial index is there.
  SELECT string_agg(format('%s %s %s %s', g.tgname::text, g.tgtype::text, g.tgenabled::text,
                           (g.tgfoid = 'app_private.platform_audit_log_refuse_change()'::regprocedure)::text),
                    ', ' ORDER BY g.tgname::text)
    INTO v_triggers
    FROM pg_trigger g
   WHERE g.tgrelid = 'app_private.platform_audit_log'::regclass
     AND NOT g.tgisinternal;

  IF v_triggers IS DISTINCT FROM
       'platform_audit_log_append_only 27 A true, platform_audit_log_no_truncate 34 A true' THEN
    RAISE EXCEPTION '20260921100000 self-check: the audit log''s triggers are %', coalesce(v_triggers, 'none');
  END IF;

  IF to_regclass('app_private.platform_audit_log_read_occurred_at') IS NULL THEN
    RAISE EXCEPTION '20260921100000 self-check: the read rows'' index is missing';
  END IF;

  -- 3. Nothing but the purge deletes, updates or truncates the log, and
  --    nothing but the purge and the trigger names the marker. Read from the
  --    catalogue, so a function added later that does either fails here.
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text) INTO v_wrong
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('public', 'app_private')
     AND p.oid NOT IN ('app_private.platform_audit_purge()'::regprocedure,
                       'app_private.platform_audit_log_refuse_change()'::regprocedure)
     AND (p.prosrc ~* '(delete\s+from|update|truncate(\s+table)?)\s+(only\s+)?(app_private\s*\.\s*)?platform_audit_log\M'
          OR strpos(p.prosrc, c_marker) > 0);

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '20260921100000 self-check: something besides the purge writes the audit log away or names its marker: %', v_wrong;
  END IF;

  -- 4. The behaviour, on synthetic rows, inside a subtransaction that is
  --    rolled back, so the live log keeps no trace of it. Each id is taken in
  --    its own statement and read in a later one.
  BEGIN
    INSERT INTO app_private.platform_audit_log (occurred_at, category, action, outcome)
    VALUES (now() - interval '13 months', 'read', 'retention_self_check.old', 'ok')
    RETURNING id INTO v_old_read;
    INSERT INTO app_private.platform_audit_log (occurred_at, category, action, outcome)
    VALUES (now() - interval '11 months', 'read', 'retention_self_check.young', 'ok')
    RETURNING id INTO v_young_read;
    INSERT INTO app_private.platform_audit_log (occurred_at, category, action, outcome)
    VALUES (now() - interval '37 months', 'write', 'retention_self_check.old', 'ok')
    RETURNING id INTO v_old_write;
    INSERT INTO app_private.platform_audit_log (occurred_at, category, action, outcome)
    VALUES (now() - interval '35 months', 'write', 'retention_self_check.young', 'ok')
    RETURNING id INTO v_young_write;

    -- 4a. This migration's own role owns the table. A plain DELETE is refused.
    v_refused := false;
    BEGIN
      DELETE FROM app_private.platform_audit_log l WHERE l.id = v_old_read;
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
      v_refused := true;
    END;
    IF NOT v_refused THEN
      RAISE EXCEPTION '20260921100000 self-check: the owner deleted an audit row outside the purge';
    END IF;

    -- 4b. The purge removes the two expired rows and keeps the two young ones.
    SELECT max(l.id) INTO v_before_id FROM app_private.platform_audit_log l;

    SELECT coalesce(sum(p.deleted) FILTER (WHERE p.category = 'read'), 0),
           coalesce(sum(p.deleted) FILTER (WHERE p.category <> 'read'), 0)
      INTO v_n_read, v_n_other
      FROM app_private.platform_audit_purge() AS p;

    SELECT count(*) INTO v_rows
      FROM app_private.platform_audit_log l
     WHERE l.id IN (v_old_read, v_old_write);
    IF v_rows <> 0 THEN
      RAISE EXCEPTION '20260921100000 self-check: the purge kept % expired row(s)', v_rows;
    END IF;

    SELECT count(*) INTO v_rows
      FROM app_private.platform_audit_log l
     WHERE l.id IN (v_young_read, v_young_write);
    IF v_rows <> 2 THEN
      RAISE EXCEPTION '20260921100000 self-check: the purge removed a row inside its period';
    END IF;

    IF v_n_read < 1 OR v_n_other < 1 THEN
      RAISE EXCEPTION '20260921100000 self-check: the purge reported % read and % other row(s)', v_n_read, v_n_other;
    END IF;

    -- 4c. It wrote exactly one row of its own, saying what it removed.
    SELECT count(*) INTO v_rows
      FROM app_private.platform_audit_log l
     WHERE l.id > v_before_id AND l.action = 'platform_audit.purge';
    IF v_rows <> 1 THEN
      RAISE EXCEPTION '20260921100000 self-check: the purge wrote % row(s) of its own, not one', v_rows;
    END IF;

    SELECT * INTO v_row
      FROM app_private.platform_audit_log l
     WHERE l.id > v_before_id AND l.action = 'platform_audit.purge'
     ORDER BY l.id DESC
     LIMIT 1;
    IF v_row.category <> 'settings'
       OR v_row.outcome <> 'ok'
       OR v_row.target_type IS DISTINCT FROM 'platform_audit_log'
       OR (v_row.after_value -> 'deleted' ->> 'read')::bigint IS DISTINCT FROM v_n_read
       OR (v_row.after_value ->> 'deleted_total')::bigint IS DISTINCT FROM v_n_read + v_n_other
       OR (v_row.after_value -> 'retention_months' ->> 'read')::integer IS DISTINCT FROM 12
       OR (v_row.after_value -> 'retention_months' ->> 'other')::integer IS DISTINCT FROM 36 THEN
      RAISE EXCEPTION '20260921100000 self-check: the purge''s own row does not say what it removed: %', row_to_json(v_row);
    END IF;

    -- 4d. The marker did not outlive the purge: the next plain DELETE in the
    --     same transaction is refused again.
    IF current_setting(c_marker, true) IS DISTINCT FROM '' THEN
      RAISE EXCEPTION '20260921100000 self-check: the purge left its marker set';
    END IF;
    v_refused := false;
    BEGIN
      DELETE FROM app_private.platform_audit_log l WHERE l.id = v_young_read;
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
      v_refused := true;
    END;
    IF NOT v_refused THEN
      RAISE EXCEPTION '20260921100000 self-check: a DELETE after the purge, in its transaction, was let through';
    END IF;

    RAISE EXCEPTION USING ERRCODE = 'ZZ021';
  EXCEPTION WHEN SQLSTATE 'ZZ021' THEN
    NULL;   -- the synthetic rows, the purge's row and anything it deleted are rolled back
  END;

  -- 5. The edge functions' door stays shut to the purge's action, in every
  --    category it could try: 20260916150000's allow-list names it nowhere.
  BEGIN
    PERFORM public.platform_audit_record('write', 'platform_audit.purge', 'ok');
    RAISE EXCEPTION '20260921100000 self-check: platform_audit_record accepted platform_audit.purge' USING ERRCODE = 'ZZ022';
  EXCEPTION WHEN invalid_parameter_value THEN
    NULL;
  END;
  BEGIN
    PERFORM public.platform_audit_record('read', 'platform_audit.purge', 'ok');
    RAISE EXCEPTION '20260921100000 self-check: platform_audit_record accepted platform_audit.purge as a read' USING ERRCODE = 'ZZ022';
  EXCEPTION WHEN invalid_parameter_value THEN
    NULL;
  END;
  BEGIN
    PERFORM public.platform_audit_record('settings', 'platform_audit.purge', 'ok');
    RAISE EXCEPTION '20260921100000 self-check: platform_audit_record accepted the settings category' USING ERRCODE = 'ZZ022';
  EXCEPTION WHEN invalid_parameter_value THEN
    NULL;
  END;

  RAISE NOTICE '20260921100000 self-check: passed';
END
$selfcheck$;
