/*
  Retention of the platform audit log (decision D4, migration 20260921100000):
  app_private.platform_audit_purge() removes read rows older than 12 months and
  every other row older than 36 months, writes one row of its own, and is the
  only way past the log's append-only trigger.

  Runs after the files before it, against the same throwaway database, as
  supabase_admin, the owner of the log. Every check raises on failure; a silent
  run is a pass. The whole file is one transaction rolled back at the end, so
  the files after it see the database as the seeds left it.

  What is covered, in order:

    1. shape        the purge and the trigger function are SECURITY INVOKER with
                    a pinned search_path, nobody the API authenticates as may
                    execute either, and both triggers fire ALWAYS
    2. first run    a purge that removes nothing: one row per category with the
                    cut-off counted in Europe/Berlin months, zero deleted, and
                    its own audit row all the same
    3. boundaries   per category, a row one microsecond past its cut-off goes,
                    one exactly on it and one a microsecond inside stay; a row
                    just past twelve months goes for read and stays for every
                    other category, legacy (written through audit_write with
                    its own timestamp) included
    4. its own row  category settings, action platform_audit.purge, no actor,
                    no company, the periods, the zone, both cut-offs and the
                    count per category
    5. twice        a second run, in a session with another TimeZone, finds the
                    same cut-offs and deletes nothing, and still records itself
    6. the owner    outside the purge the owner is refused DELETE, UPDATE and
                    TRUNCATE, also with session_replication_role = replica,
                    after a purge in the same transaction, and with a marker
                    that names another transaction; the residual the migration
                    header states is pinned as such
    7. API roles    anon, a company admin, the platform owner's session and the
                    service role cannot delete, update or truncate the log or
                    run the purge, also after setting the marker themselves
   7b. a leak       a role granted DELETE on the log, with the exact marker, is
                    still refused, because it is not the log's owner; and
                    postgres (not a superuser) deletes, truncates and purges
                    nothing, whatever a live database has granted it
    8. catalogue    nothing but the purge deletes from the log, and nothing but
                    the purge and the trigger names the marker
    9. the door     platform_audit_record refuses the purge's action in every
                    category, for the platform owner and without a session

  How a row is read: never in the statement that writes it. Each purge is
  captured into a temporary table first and checked in later statements, so no
  scalar sub-SELECT runs as an InitPlan before the call it is meant to follow.

  The marker's name and the statements tried against the log reach the helpers
  as arguments, never in their bodies, so section 8's catalogue check does not
  find these helpers.
*/

\set ON_ERROR_STOP on

BEGIN;

-- ─── helpers ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION _ar_ok(p_desc text, p_ok boolean) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  -- NULL is a failure: a check that could not be evaluated proved nothing.
  IF p_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: %', p_desc;
  END IF;
  RAISE NOTICE 'ok  %', p_desc;
END $$;

/** Back to the connecting superuser with no JWT claims at all. */
CREATE OR REPLACE FUNCTION _ar_reset() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'SET LOCAL ROLE NONE';
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claim.amr', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
END $$;

/**
  Become a principal: 'owner' (the connecting superuser, which owns the log),
  'anon', 'service_role', or 'authenticated' with a user id and a password
  sign-in, the only kind of session a platform capability answers to.
*/
CREATE OR REPLACE FUNCTION _ar_become(p_role text, p_user uuid DEFAULT NULL) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _ar_reset();
  IF p_role = 'owner' THEN
    RETURN;
  ELSIF p_role = 'anon' THEN
    PERFORM set_config('request.jwt.claim.role', 'anon', true);
    EXECUTE 'SET LOCAL ROLE anon';
  ELSIF p_role = 'service_role' THEN
    PERFORM set_config('request.jwt.claim.role', 'service_role', true);
    EXECUTE 'SET LOCAL ROLE service_role';
  ELSIF p_role = 'authenticated' THEN
    PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.amr', '[{"method": "password", "timestamp": 1789416052}]', true);
    EXECUTE 'SET LOCAL ROLE authenticated';
  ELSIF p_role LIKE 'role:%' THEN
    -- A role this file creates for one check (section 7b), with no claims.
    EXECUTE format('SET LOCAL ROLE %I', substr(p_role, 6));
  ELSE
    RAISE EXCEPTION '_ar_become: unknown principal %', p_role;
  END IF;
END $$;

/**
  Run p_sql as a principal inside a subtransaction that is always rolled back,
  and return what happened: the scalar a SELECT answered, `rows N` for any other
  statement, or `ERR <sqlstate> <message>`. p_setting / p_value set one
  transaction-local setting as that principal first — which is how a principal
  tries the purge's marker — and p_replica sets session_replication_role =
  replica first (the owner only; it needs a superuser). Nothing survives the
  call: the settings, the role and any row come back as they were.
*/
CREATE OR REPLACE FUNCTION _ar_try(p_role text, p_user uuid, p_sql text,
                                   p_setting text DEFAULT NULL, p_value text DEFAULT NULL,
                                   p_replica boolean DEFAULT false) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out   text;
  v_rows  bigint;
  v_state text;
  v_msg   text;
BEGIN
  BEGIN
    IF p_replica THEN
      EXECUTE 'SET LOCAL session_replication_role = replica';
    END IF;
    PERFORM _ar_become(p_role, p_user);
    IF p_setting IS NOT NULL THEN
      PERFORM set_config(p_setting, p_value, true);
    END IF;
    IF p_sql ~* '^\s*select' THEN
      EXECUTE p_sql INTO v_out;
      v_out := coalesce(v_out, '<null>');
    ELSE
      EXECUTE p_sql;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      v_out := 'rows ' || v_rows;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'ZZ031', MESSAGE = v_out;
  EXCEPTION
    WHEN SQLSTATE 'ZZ031' THEN
      v_out := SQLERRM;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
      v_out := 'ERR ' || v_state || ' ' || v_msg;
  END;
  PERFORM _ar_reset();
  RETURN v_out;
END $$;

-- One row per purge run of this file, and the ids that bracket it.
CREATE TEMP TABLE _ar_runs (step text PRIMARY KEY, id_before bigint, id_after bigint);

-- ─── 1. shape ───────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_role text;
BEGIN
  PERFORM _ar_ok('the purge is SECURITY INVOKER, VOLATILE, with a pinned search_path',
    (SELECT NOT p.prosecdef AND p.provolatile = 'v'
            AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c(setting) WHERE c.setting LIKE 'search_path=%')
       FROM pg_proc p WHERE p.oid = 'app_private.platform_audit_purge()'::regprocedure));

  PERFORM _ar_ok('the purge answers (category text, cut_off timestamptz, deleted bigint)',
    pg_get_function_result('app_private.platform_audit_purge()'::regprocedure)
      = 'TABLE(category text, cut_off timestamp with time zone, deleted bigint)');

  PERFORM _ar_ok('the trigger function is SECURITY INVOKER with a pinned search_path',
    (SELECT NOT p.prosecdef
            AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c(setting) WHERE c.setting LIKE 'search_path=%')
       FROM pg_proc p WHERE p.oid = 'app_private.platform_audit_log_refuse_change()'::regprocedure));

  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    PERFORM _ar_ok(format('%s may not execute the purge', v_role),
      NOT has_function_privilege(v_role, 'app_private.platform_audit_purge()', 'EXECUTE'));
    PERFORM _ar_ok(format('%s may not execute the trigger function', v_role),
      NOT has_function_privilege(v_role, 'app_private.platform_audit_log_refuse_change()', 'EXECUTE'));
    PERFORM _ar_ok(format('%s holds no privilege on the log', v_role),
      NOT has_table_privilege(v_role, 'app_private.platform_audit_log',
                              'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'));
  END LOOP;

  PERFORM _ar_ok('both guards fire ALWAYS, so session_replication_role cannot skip them',
    (SELECT count(*) = 2 AND bool_and(g.tgenabled = 'A')
       FROM pg_trigger g
      WHERE g.tgrelid = 'app_private.platform_audit_log'::regclass
        AND NOT g.tgisinternal
        AND g.tgname IN ('platform_audit_log_append_only', 'platform_audit_log_no_truncate')));

  PERFORM _ar_ok('the read rows'' partial index exists',
    (SELECT pg_get_indexdef(i.indexrelid) ~ '\(occurred_at\) WHERE \(category = ''read''::text\)'
       FROM pg_index i
      WHERE i.indexrelid = 'app_private.platform_audit_log_read_occurred_at'::regclass));
END $$;

-- ─── 2. first run: nothing to delete, recorded all the same ─────────────────

INSERT INTO _ar_runs (step, id_before)
SELECT 'first', coalesce(max(l.id), 0) FROM app_private.platform_audit_log l;

CREATE TEMP TABLE _ar_run_first AS SELECT * FROM app_private.platform_audit_purge();

UPDATE _ar_runs r SET id_after = (SELECT coalesce(max(l.id), 0) FROM app_private.platform_audit_log l)
 WHERE r.step = 'first';

DO $$
DECLARE
  v_read_cut  timestamptz := ((now() AT TIME ZONE 'Europe/Berlin') - interval '12 months') AT TIME ZONE 'Europe/Berlin';
  v_other_cut timestamptz := ((now() AT TIME ZONE 'Europe/Berlin') - interval '36 months') AT TIME ZONE 'Europe/Berlin';
BEGIN
  PERFORM _ar_ok('the purge answers one row per category, all seven',
    (SELECT count(*) = 7
            AND array_agg(r.category ORDER BY r.category)
                = ARRAY['auth', 'legacy', 'read', 'settings', 'staff', 'support', 'write']
       FROM _ar_run_first r));

  PERFORM _ar_ok('read''s cut-off is twelve Europe/Berlin months before now()',
    (SELECT r.cut_off = v_read_cut FROM _ar_run_first r WHERE r.category = 'read'));

  PERFORM _ar_ok('every other category''s cut-off is thirty-six Europe/Berlin months before now()',
    (SELECT bool_and(r.cut_off = v_other_cut) FROM _ar_run_first r WHERE r.category <> 'read'));

  PERFORM _ar_ok('the kit''s log holds nothing old enough, so the first run deleted nothing',
    (SELECT bool_and(r.deleted = 0) FROM _ar_run_first r));
END $$;

-- ─── 3. boundaries, per category ────────────────────────────────────────────

CREATE TEMP TABLE _ar_rows (id bigint PRIMARY KEY, category text, label text, expect_kept boolean);

/*
  Four rows per category, around the cut-off the first run reported:
    just_older     one microsecond past the cut-off         goes
    on_cut         exactly on it (not older than the period) stays
    just_younger   one microsecond inside                    stays
    past_12        a day past the twelve-month cut-off       goes for read only
  Six categories through the owner's INSERT (audit_write would stamp them now());
  legacy through audit_write itself, the one category it lets carry its own
  timestamp.
*/
WITH cut AS (
  SELECT r.category AS cat, r.cut_off,
         (SELECT f.cut_off FROM _ar_run_first f WHERE f.category = 'read') AS read_cut
    FROM _ar_run_first r
   WHERE r.category <> 'legacy'
),
spec AS (
  SELECT c.cat, 'just_older'   AS label, c.cut_off - interval '1 microsecond' AS at FROM cut c
  UNION ALL
  SELECT c.cat, 'on_cut',                c.cut_off                                   FROM cut c
  UNION ALL
  SELECT c.cat, 'just_younger',          c.cut_off + interval '1 microsecond'        FROM cut c
  UNION ALL
  SELECT c.cat, 'past_12',               c.read_cut - interval '1 day'               FROM cut c
),
ins AS (
  INSERT INTO app_private.platform_audit_log (occurred_at, category, action, outcome)
  SELECT s.at, s.cat, 'ar.' || s.label, 'ok' FROM spec s
  RETURNING id, category, action
)
INSERT INTO _ar_rows (id, category, label, expect_kept)
SELECT i.id, i.category, substr(i.action, 4),
       CASE substr(i.action, 4)
         WHEN 'just_older' THEN false
         WHEN 'past_12'    THEN i.category <> 'read'
         ELSE true
       END
  FROM ins i;

DO $$
DECLARE
  v_cut      timestamptz;
  v_read_cut timestamptz;
  v_id       bigint;
  r          record;
BEGIN
  SELECT f.cut_off INTO v_cut      FROM _ar_run_first f WHERE f.category = 'legacy';
  SELECT f.cut_off INTO v_read_cut FROM _ar_run_first f WHERE f.category = 'read';

  FOR r IN
    SELECT s.label, s.at, s.kept
      FROM (VALUES ('just_older',   v_cut - interval '1 microsecond', false),
                   ('on_cut',       v_cut,                            true),
                   ('just_younger', v_cut + interval '1 microsecond', true),
                   ('past_12',      v_read_cut - interval '1 day',    true)) AS s(label, at, kept)
  LOOP
    v_id := app_private.audit_write(p_category    => 'legacy',
                                    p_action      => 'legacy.ar_' || r.label,
                                    p_occurred_at => r.at);
    INSERT INTO _ar_rows (id, category, label, expect_kept) VALUES (v_id, 'legacy', r.label, r.kept);
  END LOOP;
END $$;

DO $$
BEGIN
  PERFORM _ar_ok('28 boundary rows, four per category, are in the log before the second run',
    (SELECT count(*) = 28 FROM _ar_rows)
    AND (SELECT count(*) = 28 FROM app_private.platform_audit_log l WHERE l.id IN (SELECT a.id FROM _ar_rows a)));
  PERFORM _ar_ok('legacy rows kept the timestamps they were given',
    (SELECT bool_and(l.occurred_at < now() - interval '11 months')
       FROM app_private.platform_audit_log l
      WHERE l.id IN (SELECT a.id FROM _ar_rows a WHERE a.category = 'legacy')));
END $$;

INSERT INTO _ar_runs (step, id_before)
SELECT 'second', coalesce(max(l.id), 0) FROM app_private.platform_audit_log l;

CREATE TEMP TABLE _ar_run_second AS SELECT * FROM app_private.platform_audit_purge();

UPDATE _ar_runs r SET id_after = (SELECT coalesce(max(l.id), 0) FROM app_private.platform_audit_log l)
 WHERE r.step = 'second';

CREATE TEMP TABLE _ar_present AS
SELECT a.id, a.category, a.label, a.expect_kept,
       EXISTS (SELECT 1 FROM app_private.platform_audit_log l WHERE l.id = a.id) AS present
  FROM _ar_rows a;

DO $$
DECLARE
  r record;
BEGIN
  PERFORM _ar_ok('the second run found the same cut-offs as the first (one transaction, one now())',
    (SELECT bool_and(s.cut_off = f.cut_off)
       FROM _ar_run_second s JOIN _ar_run_first f ON f.category = s.category));

  PERFORM _ar_ok('the second run deleted two read rows (a microsecond past, and a day past twelve months)',
    (SELECT s.deleted = 2 FROM _ar_run_second s WHERE s.category = 'read'));

  PERFORM _ar_ok('the second run deleted exactly one row of every other category, legacy included',
    (SELECT count(*) = 6 AND bool_and(s.deleted = 1) FROM _ar_run_second s WHERE s.category <> 'read'));

  FOR r IN SELECT * FROM _ar_present p ORDER BY p.category, p.label LOOP
    PERFORM _ar_ok(format('%s %s is %s', r.category, r.label,
                          CASE WHEN r.expect_kept THEN 'kept' ELSE 'deleted' END),
                   r.present = r.expect_kept);
  END LOOP;
END $$;

-- ─── 4. the purge's own row ─────────────────────────────────────────────────

DO $$
DECLARE
  v_first  app_private.platform_audit_log%ROWTYPE;
  v_second app_private.platform_audit_log%ROWTYPE;
  v_runs   _ar_runs%ROWTYPE;
  v_read   timestamptz;
  v_other  timestamptz;
BEGIN
  SELECT * INTO v_runs FROM _ar_runs r WHERE r.step = 'first';
  PERFORM _ar_ok('the first run wrote exactly one row, and it is its own',
    (SELECT count(*) = 1 AND bool_and(l.action = 'platform_audit.purge')
       FROM app_private.platform_audit_log l
      WHERE l.id > v_runs.id_before AND l.id <= v_runs.id_after));

  SELECT * INTO v_first
    FROM app_private.platform_audit_log l
   WHERE l.id > v_runs.id_before AND l.id <= v_runs.id_after
   ORDER BY l.id
   LIMIT 1;

  SELECT f.cut_off INTO v_read  FROM _ar_run_first f WHERE f.category = 'read';
  SELECT f.cut_off INTO v_other FROM _ar_run_first f WHERE f.category = 'write';

  PERFORM _ar_ok('its row: category settings, outcome ok, the log as its target, no company',
    v_first.category = 'settings' AND v_first.outcome = 'ok'
    AND v_first.target_type = 'platform_audit_log' AND v_first.target_id IS NULL
    AND v_first.company_id IS NULL AND v_first.before_value IS NULL);

  PERFORM _ar_ok('its row: no actor and no role, as for a host cron with no session',
    v_first.actor_user_id IS NULL AND v_first.actor_role IS NULL AND v_first.session_id IS NULL);

  PERFORM _ar_ok('its row names the periods (12 and 36 months) and the zone',
    (v_first.after_value -> 'retention_months' ->> 'read')::integer = 12
    AND (v_first.after_value -> 'retention_months' ->> 'other')::integer = 36
    AND v_first.after_value ->> 'time_zone' = 'Europe/Berlin');

  PERFORM _ar_ok('its row names both cut-offs it used',
    (v_first.after_value -> 'cut_off' ->> 'read')::timestamptz = v_read
    AND (v_first.after_value -> 'cut_off' ->> 'other')::timestamptz = v_other);

  PERFORM _ar_ok('a run that removed nothing records zero for all seven categories',
    (SELECT count(*) = 7 AND bool_and(e.value::bigint = 0)
       FROM jsonb_each_text(v_first.after_value -> 'deleted') AS e)
    AND (v_first.after_value ->> 'deleted_total')::bigint = 0);

  SELECT * INTO v_runs FROM _ar_runs r WHERE r.step = 'second';
  PERFORM _ar_ok('the second run wrote exactly one row too',
    (SELECT count(*) = 1 AND bool_and(l.action = 'platform_audit.purge')
       FROM app_private.platform_audit_log l
      WHERE l.id > v_runs.id_before AND l.id <= v_runs.id_after));

  SELECT * INTO v_second
    FROM app_private.platform_audit_log l
   WHERE l.id > v_runs.id_before AND l.id <= v_runs.id_after
   ORDER BY l.id
   LIMIT 1;

  PERFORM _ar_ok('the second run''s row counts what it removed, per category and in total',
    (SELECT bool_and((v_second.after_value -> 'deleted' ->> s.category)::bigint = s.deleted)
       FROM _ar_run_second s)
    AND (v_second.after_value ->> 'deleted_total')::bigint = 8);

  PERFORM _ar_ok('the purge''s row is not a read row, so it is kept 36 months',
    v_second.category <> 'read');
END $$;

-- ─── 5. twice, and in another session TimeZone ──────────────────────────────

INSERT INTO _ar_runs (step, id_before)
SELECT 'third', coalesce(max(l.id), 0) FROM app_private.platform_audit_log l;

-- The cut-off is counted in Europe/Berlin whatever the session says.
SET LOCAL TimeZone = 'Pacific/Auckland';
CREATE TEMP TABLE _ar_run_third AS SELECT * FROM app_private.platform_audit_purge();
RESET TimeZone;

UPDATE _ar_runs r SET id_after = (SELECT coalesce(max(l.id), 0) FROM app_private.platform_audit_log l)
 WHERE r.step = 'third';

DO $$
DECLARE
  v_runs _ar_runs%ROWTYPE;
BEGIN
  PERFORM _ar_ok('a run in a session on Pacific/Auckland found the same cut-offs',
    (SELECT count(*) = 7 AND bool_and(t.cut_off = f.cut_off)
       FROM _ar_run_third t JOIN _ar_run_first f ON f.category = t.category));

  PERFORM _ar_ok('running it again deleted nothing',
    (SELECT bool_and(t.deleted = 0) FROM _ar_run_third t));

  PERFORM _ar_ok('every row the second run kept is still there',
    (SELECT count(*) = 0
       FROM _ar_present p
      WHERE p.present
        AND NOT EXISTS (SELECT 1 FROM app_private.platform_audit_log l WHERE l.id = p.id)));

  SELECT * INTO v_runs FROM _ar_runs r WHERE r.step = 'third';
  PERFORM _ar_ok('and it still recorded itself, once',
    (SELECT count(*) = 1 AND bool_and(l.action = 'platform_audit.purge'
                                      AND (l.after_value ->> 'deleted_total')::bigint = 0)
       FROM app_private.platform_audit_log l
      WHERE l.id > v_runs.id_before AND l.id <= v_runs.id_after));
END $$;

-- ─── 6. the owner, outside the purge ────────────────────────────────────────

-- A row the purge would remove, so a refusal below is the trigger's and not the
-- WHERE clause's.
INSERT INTO app_private.platform_audit_log (occurred_at, category, action, outcome)
VALUES (now() - interval '10 years', 'write', 'ar.target', 'ok');

DO $$
DECLARE
  c_marker CONSTANT text := 'app_private.' || 'audit_purge_marker';
  v_target bigint;
  v_del    text;
  v_upd    text;
  v_trunc  text := 'TRUNCATE app_private.platform_audit_log';
  v_exact  text := 'purge:' || pg_current_xact_id()::text;
  v_stale  text := 'purge:' || (pg_current_xact_id()::text::bigint - 1)::text;
BEGIN
  SELECT l.id INTO v_target FROM app_private.platform_audit_log l WHERE l.action = 'ar.target';
  v_del := format('DELETE FROM app_private.platform_audit_log WHERE id = %s', v_target);
  v_upd := format('UPDATE app_private.platform_audit_log SET action = %L WHERE id = %s', 'ar.changed', v_target);

  PERFORM _ar_ok('the owner''s plain DELETE is refused',
    _ar_try('owner', NULL, v_del) LIKE 'ERR P0001 platform_audit_log is append-only: DELETE refused%');
  PERFORM _ar_ok('the owner''s UPDATE is refused',
    _ar_try('owner', NULL, v_upd) LIKE 'ERR P0001 platform_audit_log is append-only: UPDATE refused%');
  PERFORM _ar_ok('the owner''s TRUNCATE is refused',
    _ar_try('owner', NULL, v_trunc) LIKE 'ERR P0001 platform_audit_log is append-only: TRUNCATE refused%');

  PERFORM _ar_ok('with session_replication_role = replica, DELETE is still refused',
    _ar_try('owner', NULL, v_del, NULL, NULL, true) LIKE 'ERR P0001 %');
  PERFORM _ar_ok('with session_replication_role = replica, UPDATE is still refused',
    _ar_try('owner', NULL, v_upd, NULL, NULL, true) LIKE 'ERR P0001 %');
  PERFORM _ar_ok('with session_replication_role = replica, TRUNCATE is still refused',
    _ar_try('owner', NULL, v_trunc, NULL, NULL, true) LIKE 'ERR P0001 %');

  PERFORM _ar_ok('the purges above left no marker behind in this transaction',
    coalesce(current_setting(c_marker, true), '') = '');

  PERFORM _ar_ok('a marker naming another transaction does not let a DELETE through',
    _ar_try('owner', NULL, v_del, c_marker, v_stale) LIKE 'ERR P0001 %');
  PERFORM _ar_ok('a marker without a transaction id does not let a DELETE through',
    _ar_try('owner', NULL, v_del, c_marker, 'purge:') LIKE 'ERR P0001 %');
  PERFORM _ar_ok('the exact marker does not let an UPDATE through',
    _ar_try('owner', NULL, v_upd, c_marker, v_exact) LIKE 'ERR P0001 %');
  PERFORM _ar_ok('the exact marker does not let a TRUNCATE through',
    _ar_try('owner', NULL, v_trunc, c_marker, v_exact) LIKE 'ERR P0001 %');

  -- RESIDUAL, stated in the migration header ("What it cannot do"): a superuser
  -- who types the purge's marker by hand passes, as one who disables the
  -- trigger does. It is also the control that the refusals above are the
  -- marker's doing and nothing else's. Rolled back with _ar_try's
  -- subtransaction.
  PERFORM _ar_ok('RESIDUAL: the owner with the exact marker typed by hand deletes, as the purge does',
    _ar_try('owner', NULL, v_del, c_marker, v_exact) = 'rows 1');

  PERFORM _ar_ok('after all of it the target row is still there',
    EXISTS (SELECT 1 FROM app_private.platform_audit_log l WHERE l.id = v_target));
END $$;

-- ─── 7. API roles ───────────────────────────────────────────────────────────

/*
  Each principal sets the purge's exact marker itself first — placeholder
  settings are user-settable in SQL, which is why the marker alone is never
  trusted — and still meets the missing privilege. The platform owner's own
  session holds every platform capability and fares no better: platform rights
  are rows, not table privileges.
*/
DO $$
DECLARE
  c_marker CONSTANT text := 'app_private.' || 'audit_purge_marker';
  v_target bigint;
  v_exact  text := 'purge:' || pg_current_xact_id()::text;
  v_stmts  text[];
  v_labels text[] := ARRAY['DELETE', 'UPDATE', 'TRUNCATE', 'running the purge'];
  v_i      integer;
  v_out    text;
  r        record;
BEGIN
  SELECT l.id INTO v_target FROM app_private.platform_audit_log l WHERE l.action = 'ar.target';
  v_stmts := ARRAY[
    format('DELETE FROM app_private.platform_audit_log WHERE id = %s', v_target),
    format('UPDATE app_private.platform_audit_log SET action = %L WHERE id = %s', 'ar.changed', v_target),
    'TRUNCATE app_private.platform_audit_log',
    'SELECT count(*) FROM app_private.platform_audit_purge()'
  ];

  FOR r IN
    SELECT * FROM (VALUES
      ('anon',          NULL::uuid,                                   'anon'),
      ('authenticated', 'a0000000-0000-4000-8000-000000000001'::uuid, 'a company admin'),
      ('authenticated', '50000000-0000-4000-8000-000000000001'::uuid, 'the platform owner''s session'),
      ('service_role',  NULL::uuid,                                   'the service role')
    ) AS p(role, user_id, label)
  LOOP
    -- The setting itself is within reach, so it is not what stops them.
    PERFORM _ar_ok(format('%s can set the marker''s setting in SQL', r.label),
      _ar_try(r.role, r.user_id, format('SELECT current_setting(%L, true)', c_marker), c_marker, v_exact) = v_exact);

    FOR v_i IN 1 .. array_length(v_stmts, 1) LOOP
      v_out := _ar_try(r.role, r.user_id, v_stmts[v_i], c_marker, v_exact);
      -- "permission denied for schema/table/function": the privilege, not the
      -- setting ("permission denied to set parameter" would not match).
      PERFORM _ar_ok(format('%s, with the marker set, is refused by privilege: %s', r.label, v_labels[v_i]),
                     v_out LIKE 'ERR 42501 permission denied for %');
    END LOOP;
  END LOOP;

  PERFORM _ar_ok('after every API role tried, the target row is still there',
    EXISTS (SELECT 1 FROM app_private.platform_audit_log l WHERE l.id = v_target));
END $$;

-- ─── 7b. a grant that leaked ────────────────────────────────────────────────

/*
  The trigger's second condition, on its own: a role that is not a member of
  the log's owner is refused even when it holds the privileges and sets the
  exact marker — the day a wholesale GRANT reaches app_private (20250930185334
  once ran one on public). The role and its grants are rolled back with the
  file.
*/
CREATE ROLE _ar_leaked NOLOGIN NOINHERIT;
GRANT USAGE ON SCHEMA app_private TO _ar_leaked;
GRANT SELECT, UPDATE, DELETE, TRUNCATE ON app_private.platform_audit_log TO _ar_leaked;

DO $$
DECLARE
  c_marker CONSTANT text := 'app_private.' || 'audit_purge_marker';
  v_target bigint;
  v_exact  text := 'purge:' || pg_current_xact_id()::text;
BEGIN
  SELECT l.id INTO v_target FROM app_private.platform_audit_log l WHERE l.action = 'ar.target';

  PERFORM _ar_ok('the leaked role really holds DELETE on the log (so the refusal below is the trigger''s)',
    has_table_privilege('_ar_leaked', 'app_private.platform_audit_log', 'DELETE')
    AND NOT pg_has_role('_ar_leaked', (SELECT c.relowner FROM pg_class c
                                        WHERE c.oid = 'app_private.platform_audit_log'::regclass), 'MEMBER'));

  PERFORM _ar_ok('a role holding DELETE, with the exact marker, is refused: it is not the owner',
    _ar_try('role:_ar_leaked', NULL,
            format('DELETE FROM app_private.platform_audit_log WHERE id = %s', v_target),
            c_marker, v_exact)
      LIKE 'ERR P0001 platform_audit_log is append-only: DELETE refused%');

  PERFORM _ar_ok('…and its TRUNCATE is refused as well',
    _ar_try('role:_ar_leaked', NULL, 'TRUNCATE app_private.platform_audit_log', c_marker, v_exact)
      LIKE 'ERR P0001 %');

  /*
    postgres, where it is not a superuser (it is not in supabase/postgres),
    reads app_private through pg_read_all_data (CLAUDE.md). Whatever else a
    live database has granted it, it is not the log's owner, so each attempt
    must end in a refusal — by privilege (42501) or by the trigger (P0001) —
    and never in a removed row. Asked by behaviour rather than by privilege,
    because its grants are the one thing here the fixture does not carry.
  */
  IF EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = 'postgres' AND NOT r.rolsuper) THEN
    PERFORM _ar_ok('postgres, with the exact marker, cannot delete a row of the log',
      _ar_try('role:postgres', NULL,
              format('DELETE FROM app_private.platform_audit_log WHERE id = %s', v_target),
              c_marker, v_exact) ~ '^ERR (42501|P0001) ');
    PERFORM _ar_ok('postgres cannot truncate the log',
      _ar_try('role:postgres', NULL, 'TRUNCATE app_private.platform_audit_log', c_marker, v_exact)
        ~ '^ERR (42501|P0001) ');
    PERFORM _ar_ok('postgres cannot run the purge',
      _ar_try('role:postgres', NULL, 'SELECT count(*) FROM app_private.platform_audit_purge()', c_marker, v_exact)
        ~ '^ERR (42501|P0001) ');
  ELSE
    RAISE NOTICE 'no non-superuser postgres role here; its checks are skipped';
  END IF;

  PERFORM _ar_ok('the target row is still there',
    EXISTS (SELECT 1 FROM app_private.platform_audit_log l WHERE l.id = v_target));
END $$;

-- ─── 8. catalogue ───────────────────────────────────────────────────────────

/*
  An API role's marker could only matter if code running as the owner deleted
  from the log in the same transaction. That code is the purge and nothing
  else, which no API role may run. Read from the catalogue after every
  migration and every file before this one, so a function added later that
  deletes from the log, or sets the marker, fails here.
*/
DO $$
DECLARE
  c_marker CONSTANT text := 'app_private.' || 'audit_purge_marker';
  v_found  text;
BEGIN
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text) INTO v_found
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('public', 'app_private')
     AND p.prosrc ~* '(delete\s+from|update|truncate(\s+table)?)\s+(only\s+)?(app_private\s*\.\s*)?platform_audit_log\M';

  PERFORM _ar_ok(format('only the purge deletes, updates or truncates the log (found: %s)', coalesce(v_found, 'none')),
    v_found IS NOT DISTINCT FROM 'app_private.platform_audit_purge()');

  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text) INTO v_found
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('public', 'app_private')
     AND strpos(p.prosrc, c_marker) > 0;

  PERFORM _ar_ok(format('only the purge and the trigger name the marker (found: %s)', coalesce(v_found, 'none')),
    v_found IS NOT DISTINCT FROM 'app_private.platform_audit_log_refuse_change(), app_private.platform_audit_purge()');

  PERFORM _ar_ok('the log has no foreign key, so no cascade reaches it',
    NOT EXISTS (SELECT 1 FROM pg_constraint c
                 WHERE c.contype = 'f'
                   AND (c.conrelid = 'app_private.platform_audit_log'::regclass
                        OR c.confrelid = 'app_private.platform_audit_log'::regclass)));
END $$;

-- ─── 9. the edge functions' door ────────────────────────────────────────────

DO $$
DECLARE
  v_cat text;
BEGIN
  FOREACH v_cat IN ARRAY ARRAY['read', 'write', 'settings'] LOOP
    PERFORM _ar_ok(format('platform_audit_record refuses platform_audit.purge as %s, for the platform owner', v_cat),
      _ar_try('authenticated', '50000000-0000-4000-8000-000000000001',
              format('SELECT public.platform_audit_record(%L, %L, %L)', v_cat, 'platform_audit.purge', 'ok'))
        LIKE 'ERR 22023 %');
    PERFORM _ar_ok(format('platform_audit_record refuses platform_audit.purge as %s, without a session', v_cat),
      _ar_try('owner', NULL,
              format('SELECT public.platform_audit_record(%L, %L, %L)', v_cat, 'platform_audit.purge', 'ok'))
        LIKE 'ERR 22023 %');
  END LOOP;
END $$;

ROLLBACK;
