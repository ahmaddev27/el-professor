/*
  Vehicle availability (migration 20261023130000).

  Runs after assertions.sql against the same throwaway database, as
  supabase_admin. The whole file is one transaction rolled back at the end, so
  the files after it — vehicle-day-plans.sql among them, which sorts after this
  one — see the database as the seeds left it.

  The kit's fixture is production's --schema=public dump, so it carries `cars`
  and `werkstatt_checks` with no rows; the two companies and their people come
  from tests/rls/seed.sql. The cars, checks, windows and plans below are this
  file's own, and 2029 is this file's year so nothing it writes can be mistaken
  for another file's.

  ── THE RULES, WRITTEN DOWN SO A LATER CHANGE ARGUES WITH THEM ──────────────

  1. **A car is unavailable on an operating day for three reasons, and the
     answer names every one that applies.** A hand-entered window in
     `vehicle_unavailability` overlapping the day; a `cars.tuev_gueltig_bis`
     the day starts after; and a `werkstatt_checks` row of status 'negative'
     that nothing later has cleared. A NULL TÜV is unknown, not expired.

  2. **The operating day's start hour is never assumed.**
     `vehicle_availability_on` takes it as an argument with no default and
     `vehicle_day_plan_availability` reads it from the plan row. Section 4 is
     the whole point of this slice: the *same* window answers for two different
     operating days depending on the hour, and a reader that guessed would be
     wrong for three of this codebase's four cuts.

  3. **The window's car belongs to the window's company, by a foreign key.** The
     four policies see `company_id` only, so a caller who keeps its own company
     and points `car_id` at another company's car passes every one of them.
     Section 3 builds that row and shows it refused — for the table's owner too,
     which is how it is told apart from a policy.

  4. **Writes ask the Fahrzeuge page, reads ask no role**, and both context
     triggers are on the table.

  What is covered, in order:

     1. shape        the table, row level security, exactly the four policies of
                     3.3's shape with the cars page on the three writes and no
                     role on SELECT, both context triggers, the composite
                     foreign key, the three check constraints, the grants, and
                     both readers invoker/plpgsql/pinned/naming no private
                     schema, with no default hour
     2. constraints  a window that ends before it starts, an unknown reason and
                     an oversized note are each refused; an open-ended window is
                     accepted
     3. the car      another company's car is refused by the foreign key (23503)
                     and not by a policy, for the owner as well, and the guard
                     pins the company and the car against a later UPDATE
     4. the hour     one window, two operating days, under two hours; the 25- and
                     23-hour DST days are each one operating day; a wall time the
                     clocks skip is stored rather than guessed
     5. derivation   negative / repaired / positive checks, an earlier negative
                     cleared by a later check, an expired TÜV, a NULL TÜV, and
                     all three reasons at once reported sorted
     6. tenancy      company B's administrator reads none of company A's windows
                     and the reader answers 'unverifiable' for its car
     7. the gate     a viewer is refused all three writes and still reads; an
                     editor writes
     8. contexts     a view context writes nothing; a support session writes the
                     company it opened and leaves one audit row per row
     9. the plan     the plan-scoped reader takes the hour from the plan row, a
                     clean plan answers no rows, and a drifted plate is
                     'unverifiable' and never available
    10. controls     eleven mutation controls: every assertion above that could
                     pass for the wrong reason is re-run with the rule broken,
                     and must fail
*/

\set ON_ERROR_STOP on

BEGIN;

-- ─── GoTrue stubs (as in vehicle-day-plans.sql) ─────────────────────────────

ALTER TABLE auth.users
  ADD COLUMN IF NOT EXISTS email_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS banned_until       timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_at         timestamptz,
  ADD COLUMN IF NOT EXISTS created_at         timestamptz DEFAULT now();

CREATE TABLE IF NOT EXISTS auth.sessions (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  not_after  timestamptz
);

-- ─── helpers ────────────────────────────────────────────────────────────────

CREATE TEMP TABLE _va_results (
  n        serial PRIMARY KEY,
  label    text    NOT NULL,
  expected text,
  actual   text,
  ok       boolean NOT NULL
);

/* Record one outcome and print it. A NULL actual never equals anything. */
CREATE OR REPLACE FUNCTION _va_expect(p_label text, p_expected text, p_actual text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_ok boolean := p_actual IS NOT DISTINCT FROM p_expected;
BEGIN
  INSERT INTO _va_results (label, expected, actual, ok) VALUES (p_label, p_expected, p_actual, v_ok);
  IF v_ok THEN
    RAISE NOTICE 'ok   % [%]', p_label, p_actual;
  ELSE
    RAISE NOTICE 'DIFF % -- expected [%] got [%]', p_label, p_expected, p_actual;
  END IF;
END $$;

/* A boolean check. NULL is a failure: a check that could not be evaluated proved nothing. */
CREATE OR REPLACE FUNCTION _va_ok(p_label text, p_ok boolean) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _va_expect(p_label, 'true', coalesce(p_ok::text, 'NULL'));
END $$;

CREATE OR REPLACE FUNCTION _va_id(p_what text) RETURNS uuid
LANGUAGE sql IMMUTABLE AS $$ SELECT md5('va:' || p_what)::uuid $$;

CREATE OR REPLACE FUNCTION _va_reset() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'SET LOCAL ROLE NONE';
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claim.session_id', '', true);
  PERFORM set_config('request.jwt.claim.amr', '', true);
END $$;

CREATE OR REPLACE FUNCTION _va_owner() RETURNS uuid
LANGUAGE sql IMMUTABLE AS $$ SELECT 'ffffffff-ffff-4fff-8fff-ffffffffffff'::uuid $$;

/* Become a signed-in caller with a password sign-in (every principal in the kit
   carries one since 20260919130000), or anon when p_user is NULL. _va_owner()
   keeps the table owner, to probe what no policy is asked about. */
CREATE OR REPLACE FUNCTION _va_as(p_user uuid, p_session uuid DEFAULT NULL) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _va_reset();
  IF p_user = _va_owner() THEN
    RETURN;
  END IF;
  IF p_user IS NULL THEN
    PERFORM set_config('request.jwt.claim.role', 'anon', true);
    EXECUTE 'SET LOCAL ROLE anon';
    RETURN;
  END IF;
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.amr', '[{"method": "password", "timestamp": 1789416052}]', true);
  IF p_session IS NOT NULL THEN
    PERFORM set_config('request.jwt.claim.session_id', p_session::text, true);
  END IF;
  EXECUTE 'SET LOCAL ROLE authenticated';
END $$;

/* What a refusal is reported as, after its SQLSTATE. A missing GRANT is read out
   of PostgreSQL's message and never from the HINT (the supabase/postgres 17.6
   image writes a prose hint PostgreSQL 16 does not); an RPC's or a guard's own
   gate prints its snake_case HINT; a policy prints its message, which names the
   table. Keeping the three apart is what stops two different refusals passing
   for one another. */
CREATE OR REPLACE FUNCTION _va_reason(p_state text, p_message text, p_hint text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_state = '42501' AND p_message ~ '^permission denied for (table|function|schema) '
      THEN 'privilege ' || regexp_replace(p_message, '^permission denied for (table|function|schema) .*$', '\1')
           || ' ' || regexp_replace(p_message, '^permission denied for (table|function|schema) ', '')
    WHEN p_hint ~ '^[a-z][a-z0-9_]*$' THEN p_hint
    ELSE p_message
  END
$$;

/* Run p_sql as that caller in a subtransaction that is always rolled back and
   return the scalar it answered, `rows N` for a statement without a result, or
   `ERR <sqlstate> <reason>`. Nothing it writes survives, which is what makes the
   refusal probes safe to run inside one transaction. */
CREATE OR REPLACE FUNCTION _va_try(p_user uuid, p_session uuid, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out   text;
  v_rows  bigint;
  v_state text;
  v_msg   text;
  v_hint  text;
BEGIN
  BEGIN
    PERFORM _va_as(p_user, p_session);
    IF p_sql ~* '^\s*(select|with)' THEN
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
    WHEN query_canceled THEN
      v_out := 'ERR 57014 ' || SQLERRM;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT,
                              v_hint = PG_EXCEPTION_HINT;
      v_out := 'ERR ' || v_state || ' ' || _va_reason(v_state, v_msg, v_hint);
  END;
  PERFORM _va_reset();
  RETURN v_out;
END $$;

/* The same probe with a rule broken first. p_mutation runs as the owner inside
   the subtransaction (a DO block, so it may hold several statements and DDL),
   the probe then runs as the caller, and the whole subtransaction — the mutation
   with it — is rolled back. */
CREATE OR REPLACE FUNCTION _va_mutant(p_mutation text, p_user uuid, p_session uuid, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out text;
BEGIN
  BEGIN
    PERFORM _va_reset();
    EXECUTE p_mutation;
    v_out := _va_try(p_user, p_session, p_sql);
    RAISE EXCEPTION USING ERRCODE = 'ZZ032', MESSAGE = v_out;
  EXCEPTION
    WHEN SQLSTATE 'ZZ032' THEN
      v_out := SQLERRM;
  END;
  PERFORM _va_reset();
  RETURN v_out;
END $$;

/* A mutation of one function: take its live definition from the catalogue,
   replace one fragment and install the result. It refuses when the fragment is
   not there, because a mutation that changes nothing would make its control pass
   for the wrong reason. */
CREATE OR REPLACE FUNCTION _va_mutate_fn(p_sig text, p_from text, p_to text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_old text := pg_get_functiondef(to_regprocedure(p_sig));
BEGIN
  IF v_old IS NULL OR position(p_from IN v_old) = 0 THEN
    RAISE EXCEPTION 'mutation control: % does not contain [%], so the mutation would change nothing', p_sig, p_from;
  END IF;
  EXECUTE replace(v_old, p_from, p_to);
END $$;

/* The audit log's high-water mark, and the support-write rows since it. */
CREATE OR REPLACE FUNCTION _va_mark() RETURNS bigint
LANGUAGE sql AS $$ SELECT coalesce(max(l.id), 0) FROM app_private.platform_audit_log l $$;

CREATE OR REPLACE FUNCTION _va_rows(p_since bigint, p_action text DEFAULT NULL) RETURNS bigint
LANGUAGE sql AS $$
  SELECT count(*)
    FROM app_private.platform_audit_log l
   WHERE l.id > p_since
     AND l.action ~ '^support_write\.'
     AND (p_action IS NULL OR l.action = p_action)
$$;

/* The verdict and its sources as one readable string, so a probe compares one
   scalar: 'available', or 'unavailable/recorded,tuev_expired'. */
CREATE OR REPLACE FUNCTION _va_verdict(p_car uuid, p_date date, p_hour integer) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT a.verdict
         || CASE WHEN array_length(a.sources, 1) IS NULL THEN ''
                 ELSE '/' || array_to_string(a.sources, ',') END
    FROM public.vehicle_availability_on(p_car, p_date, p_hour) a
$$;

/* One window, written as the owner. */
CREATE OR REPLACE FUNCTION _va_put_window(p_company uuid, p_car uuid, p_from timestamp,
                                          p_to timestamp, p_reason text DEFAULT 'workshop')
RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.vehicle_unavailability (company_id, car_id, starts_local, ends_local, reason)
  VALUES (p_company, p_car, p_from, p_to, p_reason)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

/* One Werkstatt check, written as the owner. The descriptive ordinals are just
   that since 20260928121500, so any 1..5 and the year will do; the week key is
   on date_trunc('week', check_date), so two checks of one car must sit in
   different weeks. */
CREATE OR REPLACE FUNCTION _va_put_check(p_company uuid, p_car uuid, p_date date, p_status text)
RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.werkstatt_checks
    (car_id, week_number, year, check_date, status, notes, km_stand, created_by, company_id)
  VALUES (p_car, 1, EXTRACT(YEAR FROM p_date)::integer, p_date, p_status, 'va probe', 1000,
          'a0000000-0000-4000-8000-000000000001', p_company);
END $$;

/* One shift of a vehicle day plan, with every derived column computed from the
   positions the way slice 1's own guard recomputes them, so the guard can never
   be the reason a fixture fails. */
CREATE OR REPLACE FUNCTION _va_put_shift(p_company uuid, p_plan uuid, p_date date, p_vehicle text,
                                         p_index integer, p_from integer, p_to integer,
                                         p_hour integer, p_slot integer DEFAULT 15)
RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.vehicle_day_shifts
    (company_id, plan_id, operating_date, vehicle, shift_index, start_position, end_position,
     starts_local, ends_local, minutes, day_type, is_holiday,
     expected_revenue_cents, expected_revenue_per_hour_cents, confidence, evidence_days)
  VALUES (p_company, p_plan, p_date, p_vehicle, p_index, p_from, p_to,
          p_date::timestamp + make_interval(hours => p_hour, mins => p_from * p_slot),
          p_date::timestamp + make_interval(hours => p_hour, mins => p_to   * p_slot),
          (p_to - p_from) * p_slot,
          EXTRACT(ISODOW FROM p_date)::integer - 1, false,
          12345, 2057, 'low', 3);
END $$;

-- ─── fixtures and premises ──────────────────────────────────────────────────
--
-- Five cars, and each section owns the ones it touches, because a window one
-- section leaves behind is a source the next section's verdict would include:
--
--   A1  TÜV 2039 (far future)  sections 2, 3, 6, 7, 8 — the write probes
--   A2  TÜV 2029-06-30          section 5's TÜV probes and its three-reason case
--   A3  no TÜV                  sections 4 and 9 — the operating-day cut
--   A4  no TÜV                  section 5's Werkstatt probes, and nothing else
--   B1  TÜV 2039                company B
--
-- A4 exists only because section 4 leaves an OPEN-ENDED window on A3 (4g), which
-- reaches every later day: every Werkstatt verdict on A3 would then carry
-- `recorded` beside the reason being measured, and 5i/5l would read as
-- unavailable for a reason that has nothing to do with a check.
--
-- The TÜV dates are fixed literals, never relative to now(): a fixture that
-- drifts with the clock stops testing what it was written for.

DO $$
BEGIN
  IF to_regclass('public.cars') IS NULL THEN
    RAISE EXCEPTION 'vehicle-availability: public.cars does not exist — the fixture is not production''s public schema';
  END IF;
  IF to_regclass('public.werkstatt_checks') IS NULL THEN
    RAISE EXCEPTION 'vehicle-availability: public.werkstatt_checks does not exist — the fixture is not production''s public schema';
  END IF;
  IF to_regclass('public.vehicle_day_plans') IS NULL THEN
    RAISE EXCEPTION 'vehicle-availability: public.vehicle_day_plans is missing — 20261022140000 did not apply';
  END IF;
END $$;

INSERT INTO public.cars (id, kennzeichen, created_by, company_id, tuev_gueltig_bis)
VALUES
  (_va_id('car:a1'), 'VA-A 1', 'a0000000-0000-4000-8000-000000000001',
   'c0000000-0000-4000-8000-00000000000a', DATE '2039-12-31'),
  (_va_id('car:a2'), 'VA-A 2', 'a0000000-0000-4000-8000-000000000001',
   'c0000000-0000-4000-8000-00000000000a', DATE '2029-06-30'),
  (_va_id('car:a3'), 'VA-A 3', 'a0000000-0000-4000-8000-000000000001',
   'c0000000-0000-4000-8000-00000000000a', NULL),
  (_va_id('car:a4'), 'VA-A 4', 'a0000000-0000-4000-8000-000000000001',
   'c0000000-0000-4000-8000-00000000000a', NULL),
  (_va_id('car:b1'), 'VA-B 1', 'b0000000-0000-4000-8000-000000000001',
   'c0000000-0000-4000-8000-00000000000b', DATE '2039-12-31');

-- The premises this file's expectations rest on. A premise that has drifted
-- would make a dozen probes below pass or fail for a reason that has nothing to
-- do with this slice, so each is asserted rather than assumed.
SELECT _va_ok('premise: an editor of company A holds can_edit on the cars page',
  EXISTS (SELECT 1 FROM public.role_permissions rp
            JOIN public.roles r ON r.id = rp.role_id
           WHERE r.name = 'editor' AND r.company_id IS NULL
             AND rp.page_key = 'cars' AND rp.can_edit));

SELECT _va_ok('premise: a viewer of company A does not',
  EXISTS (SELECT 1 FROM public.role_permissions rp
            JOIN public.roles r ON r.id = rp.role_id
           WHERE r.name = 'viewer' AND r.company_id IS NULL
             AND rp.page_key = 'cars' AND NOT rp.can_edit));

SELECT _va_ok('premise: werkstatt_checks.status admits exactly positive, negative and repaired',
  (SELECT pg_get_constraintdef(c.oid) LIKE '%positive%'
      AND pg_get_constraintdef(c.oid) LIKE '%negative%'
      AND pg_get_constraintdef(c.oid) LIKE '%repaired%'
     FROM pg_constraint c
    WHERE c.conrelid = 'public.werkstatt_checks'::regclass
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) LIKE '%status%'
    LIMIT 1));

-- The measured reason cars.status is not reused (see the migration header): its
-- domain is exactly two values and neither is an out-of-service state. If a
-- release ever widens it, this premise fails and the decision is re-read rather
-- than silently outlived.
SELECT _va_ok('premise: cars.status admits exactly active and inactive, so it holds no out-of-service state',
  (SELECT pg_get_constraintdef(c.oid) = 'CHECK ((status = ANY (ARRAY[''active''::text, ''inactive''::text])))'
     FROM pg_constraint c
    WHERE c.conrelid = 'public.cars'::regclass AND c.conname = 'cars_status_check'));

-- ─── 1. shape ───────────────────────────────────────────────────────────────

SELECT _va_ok('1a the table exists with row level security on',
  (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.vehicle_unavailability'::regclass));

SELECT _va_expect('1b exactly the four policies of 3.3''s shape, and nothing else',
  'vehicle_unavailability_delete (DELETE), vehicle_unavailability_insert (INSERT), vehicle_unavailability_select (SELECT), vehicle_unavailability_update (UPDATE)',
  (SELECT string_agg(format('%s (%s)', p.policyname, p.cmd), ', ' ORDER BY p.policyname)
     FROM pg_policies p
    WHERE p.schemaname = 'public' AND p.tablename = 'vehicle_unavailability'));

SELECT _va_ok('1c every policy asks get_active_company_id(), and none reads user_profiles or is_user_super_admin()',
  NOT EXISTS (SELECT 1 FROM pg_policies p
               WHERE p.schemaname = 'public' AND p.tablename = 'vehicle_unavailability'
                 AND (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')
                        NOT LIKE '%get_active_company_id%'
                   OR coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')
                        ~ '(is_user_super_admin|user_profiles)')));

SELECT _va_ok('1d the three writes ask the cars page and SELECT asks no role at all',
  (SELECT count(*) = 3 FROM pg_policies p
    WHERE p.schemaname = 'public' AND p.tablename = 'vehicle_unavailability'
      AND p.cmd IN ('INSERT', 'UPDATE', 'DELETE')
      AND coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')
            LIKE '%current_role_permits(''cars''%')
  AND NOT EXISTS (SELECT 1 FROM pg_policies p
                   WHERE p.schemaname = 'public' AND p.tablename = 'vehicle_unavailability'
                     AND p.cmd = 'SELECT' AND coalesce(p.qual, '') LIKE '%current_role_permits%'));

SELECT _va_ok('1e the UPDATE policy repeats its predicate as WITH CHECK, which is what refuses a move',
  (SELECT p.with_check LIKE '%get_active_company_id%'
      AND p.with_check LIKE '%current_role_permits(''cars''%'
     FROM pg_policies p
    WHERE p.schemaname = 'public' AND p.tablename = 'vehicle_unavailability' AND p.cmd = 'UPDATE'));

SELECT _va_ok('1f both context triggers are on the table, and point at the right functions',
  (SELECT count(*) = 2 FROM pg_trigger g
    WHERE g.tgrelid = 'public.vehicle_unavailability'::regclass
      AND NOT g.tgisinternal
      AND ((g.tgname = 'refuse_read_only_context_write'
            AND g.tgfoid = 'app_private.refuse_read_only_context_write()'::regprocedure)
        OR (g.tgname = 'record_support_write'
            AND g.tgfoid = 'app_private.record_support_write()'::regprocedure))));

SELECT _va_ok('1g the composite foreign key points at cars (id, company_id), and the unique key it needs exists',
  EXISTS (SELECT 1 FROM pg_constraint
           WHERE conrelid = 'public.vehicle_unavailability'::regclass
             AND conname = 'vehicle_unavailability_car_of_company'
             AND contype = 'f' AND confrelid = 'public.cars'::regclass
             AND array_length(conkey, 1) = 2)
  AND EXISTS (SELECT 1 FROM pg_constraint
               WHERE conrelid = 'public.cars'::regclass
                 AND conname = 'cars_id_company_key' AND contype = 'u'));

SELECT _va_ok('1h the three check constraints exist, and none of them names the private schema',
  (SELECT count(*) = 3 FROM pg_constraint
    WHERE conrelid = 'public.vehicle_unavailability'::regclass AND contype = 'c'
      AND conname IN ('vehicle_unavailability_window_ordered',
                      'vehicle_unavailability_reason_known',
                      'vehicle_unavailability_note_bounded'))
  -- a CHECK is evaluated as the WRITING role, so one reaching app_private would
  -- let the owner insert and give every client 42501 on every row
  AND NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conrelid = 'public.vehicle_unavailability'::regclass AND contype = 'c'
                     AND pg_get_constraintdef(oid) LIKE '%app_private.%'));

SELECT _va_ok('1i the table carries no column named like a driver, a ride, an address or a fare',
  NOT EXISTS (SELECT 1 FROM pg_attribute
               WHERE attrelid = 'public.vehicle_unavailability'::regclass
                 AND attnum > 0 AND NOT attisdropped
                 AND attname ~ '(driver|fahrer|ride|fahrt|trip|address|adresse|fare|amount|revenue|tip|trinkgeld)'));

SELECT _va_ok('1j authenticated holds all four table privileges; anon and the service role hold none',
  has_table_privilege('authenticated', 'public.vehicle_unavailability', 'SELECT')
  AND has_table_privilege('authenticated', 'public.vehicle_unavailability', 'INSERT')
  AND has_table_privilege('authenticated', 'public.vehicle_unavailability', 'UPDATE')
  AND has_table_privilege('authenticated', 'public.vehicle_unavailability', 'DELETE')
  AND NOT has_table_privilege('anon', 'public.vehicle_unavailability', 'SELECT, INSERT, UPDATE, DELETE')
  AND NOT has_table_privilege('service_role', 'public.vehicle_unavailability', 'SELECT, INSERT, UPDATE, DELETE'));

SELECT _va_ok('1k both readers are SECURITY INVOKER plpgsql with a pinned search_path',
  (SELECT count(*) = 2 FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
    WHERE p.oid IN ('public.vehicle_availability_on(uuid,date,integer)'::regprocedure,
                    'public.vehicle_day_plan_availability(uuid)'::regprocedure)
      AND NOT p.prosecdef
      AND l.lanname = 'plpgsql'
      AND p.proconfig IS NOT NULL
      AND EXISTS (SELECT 1 FROM unnest(p.proconfig) cfg WHERE cfg LIKE 'search\_path=%')));

SELECT _va_ok('1l neither reader names the private schema — as invoker functions they would raise 42501 for every client',
  app_private.function_code('public.vehicle_availability_on(uuid,date,integer)') NOT LIKE '%app_private.%'
  AND app_private.function_code('public.vehicle_day_plan_availability(uuid)') NOT LIKE '%app_private.%');

SELECT _va_ok('1m neither reader reads cars.status',
  app_private.function_code('public.vehicle_availability_on(uuid,date,integer)') !~ 'c\.status|cars\.status'
  AND app_private.function_code('public.vehicle_day_plan_availability(uuid)') !~ 'c\.status|cars\.status');

SELECT _va_ok('1n the core reader states NO default for the operating day hour (rule 2)',
  (SELECT p.pronargdefaults = 0 FROM pg_proc p
    WHERE p.oid = 'public.vehicle_availability_on(uuid,date,integer)'::regprocedure));

SELECT _va_ok('1o authenticated may execute both readers; anon and the service role may execute neither',
  has_function_privilege('authenticated', 'public.vehicle_availability_on(uuid,date,integer)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.vehicle_day_plan_availability(uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.vehicle_availability_on(uuid,date,integer)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.vehicle_day_plan_availability(uuid)', 'EXECUTE')
  AND NOT has_function_privilege('service_role', 'public.vehicle_availability_on(uuid,date,integer)', 'EXECUTE')
  AND NOT has_function_privilege('service_role', 'public.vehicle_day_plan_availability(uuid)', 'EXECUTE'));

SELECT _va_ok('1p no API role may execute the guard, and PUBLIC holds no default grant on it',
  NOT has_function_privilege('anon', 'app_private.vehicle_unavailability_guard()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'app_private.vehicle_unavailability_guard()', 'EXECUTE')
  AND NOT has_function_privilege('service_role', 'app_private.vehicle_unavailability_guard()', 'EXECUTE')
  AND (SELECT p.proacl IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a
                               WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
         FROM pg_proc p WHERE p.oid = 'app_private.vehicle_unavailability_guard()'::regprocedure));

-- ─── 2. the constraints, not comments ───────────────────────────────────────

DO $$
DECLARE
  c_co_a CONSTANT uuid := 'c0000000-0000-4000-8000-00000000000a';
BEGIN
  PERFORM _va_expect('2a a window that ends before it starts is refused, by a check constraint',
    'ERR 23514 new row for relation "vehicle_unavailability" violates check constraint "vehicle_unavailability_window_ordered"',
    _va_try(_va_owner(), NULL, format(
      'INSERT INTO vehicle_unavailability (company_id, car_id, starts_local, ends_local, reason) '
      || 'VALUES (%L, %L, ''2029-05-10 08:00'', ''2029-05-09 08:00'', ''workshop'')',
      c_co_a, _va_id('car:a1'))));

  PERFORM _va_expect('2b …and one that ends exactly when it starts, which is an empty window',
    'ERR 23514 new row for relation "vehicle_unavailability" violates check constraint "vehicle_unavailability_window_ordered"',
    _va_try(_va_owner(), NULL, format(
      'INSERT INTO vehicle_unavailability (company_id, car_id, starts_local, ends_local, reason) '
      || 'VALUES (%L, %L, ''2029-05-10 08:00'', ''2029-05-10 08:00'', ''workshop'')',
      c_co_a, _va_id('car:a1'))));

  PERFORM _va_expect('2c an open-ended window is accepted: the car is off the road and nobody said until when',
    'rows 1',
    _va_try(_va_owner(), NULL, format(
      'INSERT INTO vehicle_unavailability (company_id, car_id, starts_local, ends_local, reason) '
      || 'VALUES (%L, %L, ''2029-05-10 08:00'', NULL, ''breakdown'')',
      c_co_a, _va_id('car:a1'))));

  PERFORM _va_expect('2d a reason outside the closed list is refused',
    'ERR 23514 new row for relation "vehicle_unavailability" violates check constraint "vehicle_unavailability_reason_known"',
    _va_try(_va_owner(), NULL, format(
      'INSERT INTO vehicle_unavailability (company_id, car_id, starts_local, reason) '
      || 'VALUES (%L, %L, ''2029-05-10 08:00'', ''urlaub'')',
      c_co_a, _va_id('car:a1'))));

  -- All five in one statement, so the probe reports how many the table took.
  PERFORM _va_expect('2e …and each of the five reasons it admits is accepted', '5',
    _va_try(_va_owner(), NULL, format(
      'WITH ins AS ('
      || 'INSERT INTO vehicle_unavailability (company_id, car_id, starts_local, ends_local, reason) '
      || 'SELECT %L, %L, DATE ''2030-01-01'' + (t.n * 2) * INTERVAL ''1 day'', '
      ||        'DATE ''2030-01-01'' + (t.n * 2 + 1) * INTERVAL ''1 day'', t.r '
      || 'FROM unnest(ARRAY[''workshop'',''accident'',''breakdown'',''inspection'',''other'']) '
      ||      'WITH ORDINALITY AS t(r, n) RETURNING 1) '
      || 'SELECT count(*)::text FROM ins',
      c_co_a, _va_id('car:a1'))));

  PERFORM _va_expect('2f an oversized note is refused',
    'ERR 23514 new row for relation "vehicle_unavailability" violates check constraint "vehicle_unavailability_note_bounded"',
    _va_try(_va_owner(), NULL, format(
      'INSERT INTO vehicle_unavailability (company_id, car_id, starts_local, reason, note) '
      || 'VALUES (%L, %L, ''2029-05-10 08:00'', ''other'', repeat(''x'', 501))',
      c_co_a, _va_id('car:a1'))));

  PERFORM _va_expect('2g the guard stamps the actor itself, so a client cannot claim someone else recorded it',
    'a0000000-0000-4000-8000-000000000001',
    _va_try('a0000000-0000-4000-8000-000000000001', NULL, format(
      'WITH w AS (INSERT INTO vehicle_unavailability (company_id, car_id, starts_local, reason, recorded_by) '
      || 'VALUES (%L, %L, ''2029-05-11 08:00'', ''other'', %L) RETURNING recorded_by) '
      || 'SELECT recorded_by::text FROM w',
      c_co_a, _va_id('car:a1'), 'b0000000-0000-4000-8000-000000000001')));
END $$;

-- ─── 3. the car belongs to the company, by a foreign key ────────────────────
--
-- This is rule 3, and it is the one thing on this table the four policies cannot
-- do. The probes are run as the OWNER, which no policy is asked about, so a
-- refusal here can only be the foreign key — and its SQLSTATE (23503) is a
-- different class from a policy's (42501), which is what keeps the two apart.

DO $$
DECLARE
  c_co_a CONSTANT uuid := 'c0000000-0000-4000-8000-00000000000a';
  c_co_b CONSTANT uuid := 'c0000000-0000-4000-8000-00000000000b';
  v_win  uuid;
BEGIN
  PERFORM _va_expect('3a company A''s window on company B''s car is refused, for the owner too, by the foreign key',
    'ERR 23503 insert or update on table "vehicle_unavailability" violates foreign key constraint "vehicle_unavailability_car_of_company"',
    _va_try(_va_owner(), NULL, format(
      'INSERT INTO vehicle_unavailability (company_id, car_id, starts_local, reason) '
      || 'VALUES (%L, %L, ''2029-05-10 08:00'', ''workshop'')',
      c_co_a, _va_id('car:b1'))));

  PERFORM _va_expect('3b …and so is a car that does not exist at all',
    'ERR 23503 insert or update on table "vehicle_unavailability" violates foreign key constraint "vehicle_unavailability_car_of_company"',
    _va_try(_va_owner(), NULL, format(
      'INSERT INTO vehicle_unavailability (company_id, car_id, starts_local, reason) '
      || 'VALUES (%L, %L, ''2029-05-10 08:00'', ''workshop'')',
      c_co_a, _va_id('car:nonexistent'))));

  PERFORM _va_expect('3c the matching pair is accepted', 'rows 1',
    _va_try(_va_owner(), NULL, format(
      'INSERT INTO vehicle_unavailability (company_id, car_id, starts_local, reason) '
      || 'VALUES (%L, %L, ''2029-05-10 08:00'', ''workshop'')',
      c_co_a, _va_id('car:a1'))));

  -- The guard's pins. A window belongs to one car of one company for its life;
  -- correcting the car is a new window. The reason pin_billing_company_id exists
  -- on the billing tables: a WITH CHECK sees only the new row.
  v_win := _va_put_window(c_co_a, _va_id('car:a1'), '2029-07-01 00:00', '2029-07-02 00:00');

  PERFORM _va_expect('3d the guard refuses re-pointing a window at another car',
    'ERR P0001 vehicle_unavailability_car_pinned',
    _va_try(_va_owner(), NULL, format(
      'UPDATE vehicle_unavailability SET car_id = %L WHERE id = %L', _va_id('car:a2'), v_win)));

  PERFORM _va_expect('3e …and at another company',
    'ERR P0001 vehicle_unavailability_company_pinned',
    _va_try(_va_owner(), NULL, format(
      'UPDATE vehicle_unavailability SET company_id = %L WHERE id = %L', c_co_b, v_win)));

  PERFORM _va_expect('3f but the window itself may be corrected', 'rows 1',
    _va_try(_va_owner(), NULL, format(
      'UPDATE vehicle_unavailability SET ends_local = ''2029-07-05 00:00'' WHERE id = %L', v_win)));
END $$;

-- ─── 4. the operating day's start hour decides which day a window hits ──────
--
-- Rule 2, and the reason this slice exists as a slice. ONE window — 01:00 to
-- 03:00 on Tuesday 2029-05-08 — answers for TWO different operating days
-- depending on the hour, because the operating day that starts on date D under
-- hour H is the half-open wall-clock window [D+H, D+1 day+H).
--
--   hour 4: operating day 2029-05-07 is [07.05 04:00, 08.05 04:00) → it HITS
--           operating day 2029-05-08 is [08.05 04:00, 09.05 04:00) → it misses
--   hour 0: operating day 2029-05-07 is [07.05 00:00, 08.05 00:00) → it misses
--           operating day 2029-05-08 is [08.05 00:00, 09.05 00:00) → it HITS
--
-- A reader that assumed one cut would therefore be wrong about this car on one
-- of the two days, whichever cut it picked.

DO $$
DECLARE
  c_co_a CONSTANT uuid := 'c0000000-0000-4000-8000-00000000000a';
  c_car  CONSTANT uuid := _va_id('car:a3');   -- no TÜV date, so only the window speaks
BEGIN
  PERFORM _va_put_window(c_co_a, c_car, '2029-05-08 01:00', '2029-05-08 03:00', 'breakdown');

  PERFORM _va_expect('4a under hour 4 the window falls in the operating day that STARTED the day before',
    'unavailable/recorded', _va_verdict(c_car, DATE '2029-05-07', 4));
  PERFORM _va_expect('4b …and not in the one named by its own calendar date',
    'available', _va_verdict(c_car, DATE '2029-05-08', 4));

  PERFORM _va_expect('4c under hour 0 the same window falls in its own calendar date',
    'unavailable/recorded', _va_verdict(c_car, DATE '2029-05-08', 0));
  PERFORM _va_expect('4d …and not in the day before',
    'available', _va_verdict(c_car, DATE '2029-05-07', 0));

  -- The boundary is half-open on both sides, the shape noteExclusionIntervals'
  -- own overlap test uses: a window that ends exactly when the operating day
  -- begins does not touch it, and one that begins exactly when the day ends
  -- does not either.
  PERFORM _va_put_window(c_co_a, c_car, '2029-06-04 00:00', '2029-06-04 04:00', 'workshop');
  PERFORM _va_expect('4e a window ending exactly at the operating day''s start does not touch it (half-open)',
    'available', _va_verdict(c_car, DATE '2029-06-04', 4));
  PERFORM _va_expect('4f …and it does touch the day that ends there',
    'unavailable/recorded', _va_verdict(c_car, DATE '2029-06-03', 4));

  -- An open-ended window has no end, so it reaches every later day.
  PERFORM _va_put_window(c_co_a, c_car, '2029-08-01 06:00', NULL, 'accident');
  PERFORM _va_expect('4g an open-ended window reaches the day it starts on',
    'unavailable/recorded', _va_verdict(c_car, DATE '2029-08-01', 4));
  PERFORM _va_expect('4h …and a day a year later',
    'unavailable/recorded', _va_verdict(c_car, DATE '2030-08-01', 4));
  PERFORM _va_expect('4i …and no day before it',
    'available', _va_verdict(c_car, DATE '2029-07-30', 4));
END $$;

-- ─── 4b. the two DST days are each one operating day ────────────────────────
--
-- 25.10.2026 is a 25-hour local day in Europe/Berlin and 29.03.2026 a 23-hour
-- one. Because every boundary here is a WALL CLOCK timestamp built from its own
-- day's calendar parts, and never an instant advanced by a fixed 86_400_000
-- milliseconds, both are one operating day like any other. That exact mistake —
-- a fixed day length — gave 11 real rides on staging to drivers marked sick.

DO $$
DECLARE
  c_co_a CONSTANT uuid := 'c0000000-0000-4000-8000-00000000000a';
  c_car  CONSTANT uuid := _va_id('car:a3');
BEGIN
  -- The repeated hour of the 25-hour day. 02:30 on 25.10.2026 happens twice as
  -- an instant and once as a wall time; stored as a wall time there is nothing
  -- to guess.
  PERFORM _va_put_window(c_co_a, c_car, '2026-10-25 02:15', '2026-10-25 02:45', 'workshop');
  PERFORM _va_expect('4j the repeated DST hour falls in the operating day that began on 24.10 under hour 4',
    'unavailable/recorded', _va_verdict(c_car, DATE '2026-10-24', 4));
  PERFORM _va_expect('4k …and not in the one that begins on 25.10',
    'available', _va_verdict(c_car, DATE '2026-10-25', 4));

  -- The skipped hour of the 23-hour day. 02:30 on 29.03.2026 is a wall time the
  -- clocks skip: it is no instant at all, and a timestamp WITHOUT time zone
  -- stores it rather than inventing one.
  PERFORM _va_expect('4l a wall time the clocks SKIP is stored, not guessed and not refused', 'rows 1',
    _va_try(_va_owner(), NULL, format(
      'INSERT INTO vehicle_unavailability (company_id, car_id, starts_local, ends_local, reason) '
      || 'VALUES (%L, %L, ''2026-03-29 02:15'', ''2026-03-29 02:45'', ''workshop'')',
      c_co_a, _va_id('car:a2'))));

  PERFORM _va_put_window(c_co_a, c_car, '2026-03-29 02:15', '2026-03-29 02:45', 'workshop');
  PERFORM _va_expect('4m …and it falls in the operating day that began on 28.03 under hour 4',
    'unavailable/recorded', _va_verdict(c_car, DATE '2026-03-28', 4));

  -- And the arithmetic itself: both DST days are exactly 24 wall-clock hours
  -- wide, which is what makes the two probes above hold by construction rather
  -- than by luck.
  PERFORM _va_ok('4n both DST days are exactly 24 wall-clock hours wide under any hour',
    (DATE '2026-10-26'::timestamp + make_interval(hours => 4))
      - (DATE '2026-10-25'::timestamp + make_interval(hours => 4)) = interval '24 hours'
    AND (DATE '2026-03-30'::timestamp + make_interval(hours => 4))
      - (DATE '2026-03-29'::timestamp + make_interval(hours => 4)) = interval '24 hours');

  -- The contract: an hour outside 0..23 is a broken argument contract and raises
  -- 22023, never SQLERRM and never a silent answer.
  PERFORM _va_expect('4o an hour outside 0..23 raises 22023 with a fixed message',
    'ERR 22023 vehicle_availability_on: the operating day start hour must be between 0 and 23',
    _va_try(_va_owner(), NULL, format('SELECT verdict FROM public.vehicle_availability_on(%L, ''2029-05-07'', 24)', c_car)));
  PERFORM _va_expect('4p …and a missing argument likewise',
    'ERR 22023 vehicle_availability_on: car, operating date and operating day start hour are all required',
    _va_try(_va_owner(), NULL, format('SELECT verdict FROM public.vehicle_availability_on(%L, ''2029-05-07'', NULL)', c_car)));
END $$;

-- ─── 5. the derivation: what is read instead of typed twice ─────────────────

DO $$
DECLARE
  c_co_a CONSTANT uuid := 'c0000000-0000-4000-8000-00000000000a';
  c_a1   CONSTANT uuid := _va_id('car:a1');   -- TÜV 2039
  c_a2   CONSTANT uuid := _va_id('car:a2');   -- TÜV 2029-06-30
  c_a3   CONSTANT uuid := _va_id('car:a3');   -- no TÜV, section 4's car
  -- The Werkstatt probes get a car of their own: section 4 left an open-ended
  -- window on A3, which would add `recorded` to every verdict below.
  c_a4   CONSTANT uuid := _va_id('car:a4');   -- no TÜV, no window, ever
BEGIN
  -- 5.1 the TÜV
  PERFORM _va_expect('5a a car whose TÜV is years away is available', 'available',
    _va_verdict(c_a1, DATE '2029-05-07', 4));
  PERFORM _va_expect('5b a car is available on the last day its TÜV covers', 'available',
    _va_verdict(c_a2, DATE '2029-06-30', 4));
  PERFORM _va_expect('5c …and unavailable on the first operating day that starts after it',
    'unavailable/tuev_expired', _va_verdict(c_a2, DATE '2029-07-01', 4));
  PERFORM _va_expect('5d a NULL TÜV is UNKNOWN, not expired: the car is available',
    'available', _va_verdict(c_a3, DATE '2029-05-07', 4));
  -- The 60-day warning window is deliberately not read here: a TÜV expiring in a
  -- fortnight does not stop a car driving today, and reading the warning as
  -- unavailability would take a quarter of a fleet off the road.
  PERFORM _va_expect('5e a TÜV expiring within the product''s 60-day warning window does NOT make the car unavailable',
    'available', _va_verdict(c_a2, DATE '2029-05-15', 4));

  -- 5.2 the Werkstatt check. One pass over the car's checks: the latest on or
  -- before the day decides, and 'repaired' or 'positive' clears a negative.
  PERFORM _va_put_check(c_co_a, c_a4, DATE '2029-09-03', 'negative');
  PERFORM _va_expect('5f a negative check makes the car unavailable from its own day on',
    'unavailable/werkstatt_negative', _va_verdict(c_a4, DATE '2029-09-03', 4));
  PERFORM _va_expect('5g …and on every later day while nothing clears it',
    'unavailable/werkstatt_negative', _va_verdict(c_a4, DATE '2029-09-09', 4));
  PERFORM _va_expect('5h …and on no day before it',
    'available', _va_verdict(c_a4, DATE '2029-09-02', 4));

  PERFORM _va_put_check(c_co_a, c_a4, DATE '2029-09-10', 'repaired');
  PERFORM _va_expect('5i a later ''repaired'' check clears it', 'available',
    _va_verdict(c_a4, DATE '2029-09-10', 4));
  PERFORM _va_expect('5j …and the day between the two is still unavailable, because the check that spoke then was the negative one',
    'unavailable/werkstatt_negative', _va_verdict(c_a4, DATE '2029-09-09', 4));

  PERFORM _va_put_check(c_co_a, c_a4, DATE '2029-09-17', 'negative');
  PERFORM _va_put_check(c_co_a, c_a4, DATE '2029-09-24', 'positive');
  PERFORM _va_expect('5k a second negative takes it off the road again', 'unavailable/werkstatt_negative',
    _va_verdict(c_a4, DATE '2029-09-20', 4));
  PERFORM _va_expect('5l …and a later ''positive'' clears that one too', 'available',
    _va_verdict(c_a4, DATE '2029-09-25', 4));

  -- 5.3 all three reasons at once, reported sorted and complete. A precedence
  -- would have been invented here; naming every reason is the honest answer.
  PERFORM _va_put_check(c_co_a, c_a2, DATE '2029-10-01', 'negative');
  PERFORM _va_put_window(c_co_a, c_a2, '2029-10-08 00:00', '2029-10-09 00:00', 'accident');
  PERFORM _va_expect('5m all three reasons at once are all reported, sorted',
    'unavailable/recorded,tuev_expired,werkstatt_negative',
    _va_verdict(c_a2, DATE '2029-10-08', 4));

  -- 5.4 and a car the caller cannot see is 'unverifiable', never 'available'.
  PERFORM _va_expect('5n a car that does not exist is unverifiable, never available',
    'unverifiable/car_not_readable', _va_verdict(_va_id('car:nonexistent'), DATE '2029-05-07', 4));
END $$;

-- ─── 6. tenancy ─────────────────────────────────────────────────────────────

DO $$
DECLARE
  c_co_a   CONSTANT uuid := 'c0000000-0000-4000-8000-00000000000a';
  c_co_b   CONSTANT uuid := 'c0000000-0000-4000-8000-00000000000b';
  c_admin_a CONSTANT uuid := 'a0000000-0000-4000-8000-000000000001';
  c_admin_b CONSTANT uuid := 'b0000000-0000-4000-8000-000000000001';
BEGIN
  PERFORM _va_put_window(c_co_a, _va_id('car:a1'), '2029-11-05 00:00', '2029-11-06 00:00');

  PERFORM _va_expect('6a company A''s administrator reads company A''s windows', 'true',
    _va_try(c_admin_a, NULL, format(
      'SELECT (count(*) > 0)::text FROM vehicle_unavailability WHERE company_id = %L', c_co_a)));
  PERFORM _va_expect('6b company B''s administrator reads none of them', '0',
    _va_try(c_admin_b, NULL, format(
      'SELECT count(*)::text FROM vehicle_unavailability WHERE company_id = %L', c_co_a)));
  PERFORM _va_expect('6c anon reads nothing at all', 'ERR 42501 privilege table vehicle_unavailability',
    _va_try(NULL, NULL, 'SELECT count(*)::text FROM vehicle_unavailability'));

  -- The reader runs as the caller, so company B's administrator cannot even see
  -- the car: 'unverifiable', never 'available'. That distinction is the point —
  -- an unreadable car reported as available is how a planner would put another
  -- company's broken car on the road.
  PERFORM _va_expect('6d the reader answers ''unverifiable'' for a car of another company, never ''available''',
    'unverifiable/car_not_readable',
    _va_try(c_admin_b, NULL, format(
      'SELECT verdict || ''/'' || array_to_string(sources, '','') FROM public.vehicle_availability_on(%L, ''2029-11-05'', 4)',
      _va_id('car:a1'))));

  PERFORM _va_expect('6e …and company A''s administrator gets the real answer for the same car',
    'unavailable/recorded',
    _va_try(c_admin_a, NULL, format(
      'SELECT verdict || ''/'' || array_to_string(sources, '','') FROM public.vehicle_availability_on(%L, ''2029-11-05'', 4)',
      _va_id('car:a1'))));

  -- A write that names another company is refused by the policy (42501), which
  -- is a different class from the foreign key's 23503 in section 3.
  PERFORM _va_expect('6f company A''s administrator cannot write a window for company B',
    'ERR 42501 new row violates row-level security policy for table "vehicle_unavailability"',
    _va_try(c_admin_a, NULL, format(
      'INSERT INTO vehicle_unavailability (company_id, car_id, starts_local, reason) '
      || 'VALUES (%L, %L, ''2029-11-05 00:00'', ''workshop'')', c_co_b, _va_id('car:b1'))));
END $$;

-- ─── 7. the role gate: writes ask the Fahrzeuge page, reads ask no role ─────

DO $$
DECLARE
  c_co_a    CONSTANT uuid := 'c0000000-0000-4000-8000-00000000000a';
  c_viewer  CONSTANT uuid := 'a0000000-0000-4000-8000-000000000003';
  c_editor  CONSTANT uuid := 'a0000000-0000-4000-8000-000000000002';
  v_win     uuid;
BEGIN
  v_win := _va_put_window(c_co_a, _va_id('car:a1'), '2029-12-03 00:00', '2029-12-04 00:00');

  PERFORM _va_expect('7a a viewer READS the windows: SELECT is not role-gated in 3.3''s shape', 'true',
    _va_try(c_viewer, NULL, format(
      'SELECT (count(*) > 0)::text FROM vehicle_unavailability WHERE company_id = %L', c_co_a)));

  PERFORM _va_expect('7b …and may call the reader', 'unavailable/recorded',
    _va_try(c_viewer, NULL, format(
      'SELECT verdict || ''/'' || array_to_string(sources, '','') FROM public.vehicle_availability_on(%L, ''2029-12-03'', 4)',
      _va_id('car:a1'))));

  PERFORM _va_expect('7c but a viewer cannot INSERT one',
    'ERR 42501 new row violates row-level security policy for table "vehicle_unavailability"',
    _va_try(c_viewer, NULL, format(
      'INSERT INTO vehicle_unavailability (company_id, car_id, starts_local, reason) '
      || 'VALUES (%L, %L, ''2029-12-10 00:00'', ''workshop'')', c_co_a, _va_id('car:a1'))));

  -- An UPDATE or a DELETE a policy hides changes zero rows and reports success,
  -- which is exactly why the product routes them through updateChecked /
  -- deleteChecked. The probe therefore asserts `rows 0`, not an error.
  PERFORM _va_expect('7d a viewer''s UPDATE touches no row and raises nothing — the silent refusal writeOutcome.ts exists for',
    'rows 0',
    _va_try(c_viewer, NULL, format(
      'UPDATE vehicle_unavailability SET reason = ''other'' WHERE id = %L', v_win)));

  PERFORM _va_expect('7e …and so does a viewer''s DELETE', 'rows 0',
    _va_try(c_viewer, NULL, format('DELETE FROM vehicle_unavailability WHERE id = %L', v_win)));

  PERFORM _va_expect('7f an editor, who holds can_edit on the cars page, inserts one', 'rows 1',
    _va_try(c_editor, NULL, format(
      'INSERT INTO vehicle_unavailability (company_id, car_id, starts_local, reason) '
      || 'VALUES (%L, %L, ''2029-12-11 00:00'', ''workshop'')', c_co_a, _va_id('car:a1'))));

  PERFORM _va_expect('7g …and updates one', 'rows 1',
    _va_try(c_editor, NULL, format(
      'UPDATE vehicle_unavailability SET reason = ''other'' WHERE id = %L', v_win)));

  PERFORM _va_expect('7h …and deletes one', 'rows 1',
    _va_try(c_editor, NULL, format('DELETE FROM vehicle_unavailability WHERE id = %L', v_win)));
END $$;

-- ─── 8. platform contexts ───────────────────────────────────────────────────

INSERT INTO auth.users (id, email, email_confirmed_at)
SELECT _va_id('user:' || v.who), 'va-' || v.who || '@test.invalid', now()
FROM (VALUES ('owner-view'), ('owner-support')) AS v(who)
ON CONFLICT (id) DO NOTHING;

INSERT INTO user_profiles (user_id, email, full_name, role, role_id, company_id, status)
SELECT _va_id('user:' || v.who), 'va-' || v.who || '@test.invalid', 'VA ' || v.who, 'viewer',
       (SELECT r.id FROM roles r WHERE r.name = 'viewer' AND r.company_id IS NULL),
       NULL, 'active'
FROM (VALUES ('owner-view'), ('owner-support')) AS v(who)
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO app_private.platform_staff (user_id, role, note)
VALUES (_va_id('user:owner-view'), 'owner', 'va'), (_va_id('user:owner-support'), 'owner', 'va')
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO auth.sessions (id, user_id)
SELECT _va_id('session:' || v.who), _va_id('user:' || v.who)
FROM (VALUES ('owner-view'), ('owner-support')) AS v(who)
ON CONFLICT (id) DO NOTHING;

DO $$
DECLARE
  c_view    CONSTANT uuid := _va_id('user:owner-view');
  c_support CONSTANT uuid := _va_id('user:owner-support');
  c_s_view  CONSTANT uuid := _va_id('session:owner-view');
  c_s_supp  CONSTANT uuid := _va_id('session:owner-support');
  c_co_a    CONSTANT uuid := 'c0000000-0000-4000-8000-00000000000a';
  c_co_b    CONSTANT uuid := 'c0000000-0000-4000-8000-00000000000b';
  v_open    jsonb;
  v_mark    bigint;
  v_after   jsonb;
  v_win     uuid;
BEGIN
  v_win := _va_put_window(c_co_a, _va_id('car:a1'), '2029-04-02 00:00', '2029-04-03 00:00');

  -- A platform account with no context open reads nothing: the read seam
  -- platform_reads_company_data() has been `SELECT false` since 20260917140000.
  PERFORM _va_expect('8a a platform owner with no context open reads no window', '0',
    _va_try(c_support, c_s_supp, format(
      'SELECT count(*)::text FROM vehicle_unavailability WHERE company_id = %L', c_co_a)));

  PERFORM _va_as(c_view, c_s_view);
  v_open := public.platform_context_open(c_co_a, 'view');
  PERFORM _va_reset();
  PERFORM _va_expect('8b the view context opened', 'true', v_open ->> 'success');

  PERFORM _va_expect('8c a view context reads the company it opened', 'true',
    _va_try(c_view, c_s_view, format(
      'SELECT (count(*) > 0)::text FROM vehicle_unavailability WHERE company_id = %L', c_co_a)));
  PERFORM _va_expect('8d …and no other company''s', '0',
    _va_try(c_view, c_s_view, format(
      'SELECT count(*)::text FROM vehicle_unavailability WHERE company_id = %L', c_co_b)));
  PERFORM _va_expect('8e a view context writes nothing, and says why (3.4a)',
    'ERR P0001 support_session_required',
    _va_try(c_view, c_s_view, format(
      'INSERT INTO vehicle_unavailability (company_id, car_id, starts_local, reason) '
      || 'VALUES (%L, %L, ''2029-04-10 00:00'', ''workshop'')', c_co_a, _va_id('car:a1'))));
  PERFORM _va_expect('8f …not even an UPDATE that would touch no row',
    'ERR P0001 support_session_required',
    _va_try(c_view, c_s_view, format(
      'UPDATE vehicle_unavailability SET reason = reason WHERE id = %L', v_win)));
  PERFORM _va_expect('8g …and not a DELETE',
    'ERR P0001 support_session_required',
    _va_try(c_view, c_s_view, format('DELETE FROM vehicle_unavailability WHERE id = %L', v_win)));

  -- The support session: it writes the company it opened, as that company's
  -- administrator would, and every row leaves exactly one audit row (3.4c).
  PERFORM _va_as(c_support, c_s_supp);
  v_open := public.platform_context_open(c_co_a, 'support', 'Ticket Fahrzeug-Ausfall');
  PERFORM _va_reset();
  PERFORM _va_expect('8h the support session opened', 'true', v_open ->> 'success');

  v_mark := _va_mark();
  PERFORM _va_as(c_support, c_s_supp);
  INSERT INTO public.vehicle_unavailability (company_id, car_id, starts_local, ends_local, reason, note)
  VALUES (c_co_a, _va_id('car:a1'), '2029-04-15 06:00', '2029-04-17 18:00', 'accident', 'Unfall A3');
  PERFORM _va_reset();

  PERFORM _va_expect('8i a support session''s insert leaves exactly one audit row', '1',
    _va_rows(v_mark, 'support_write.vehicle_unavailability.insert')::text);

  SELECT l.after_value INTO v_after
    FROM app_private.platform_audit_log l
   WHERE l.id > v_mark AND l.action = 'support_write.vehicle_unavailability.insert'
   ORDER BY l.id LIMIT 1;
  PERFORM _va_expect('8j …and it names the session''s reason and keeps the window',
    'Ticket Fahrzeug-Ausfall|accident|2029-04-15T06:00:00',
    (v_after ->> 'reason') || '|' || (v_after -> 'values' ->> 'reason')
    || '|' || (v_after -> 'values' ->> 'starts_local'));

  v_mark := _va_mark();
  PERFORM _va_as(c_support, c_s_supp);
  UPDATE public.vehicle_unavailability SET ends_local = '2029-04-18 18:00'
   WHERE company_id = c_co_a AND car_id = _va_id('car:a1') AND starts_local = '2029-04-15 06:00';
  PERFORM _va_reset();
  PERFORM _va_expect('8k …and an update of its own is recorded too', '1',
    _va_rows(v_mark, 'support_write.vehicle_unavailability.update')::text);

  PERFORM _va_expect('8l a support session writes no other company''s window',
    'ERR 42501 new row violates row-level security policy for table "vehicle_unavailability"',
    _va_try(c_support, c_s_supp, format(
      'INSERT INTO vehicle_unavailability (company_id, car_id, starts_local, reason) '
      || 'VALUES (%L, %L, ''2029-04-20 00:00'', ''workshop'')', c_co_b, _va_id('car:b1'))));

  PERFORM _va_as(c_support, c_s_supp);
  PERFORM public.platform_context_close();
  PERFORM _va_as(c_view, c_s_view);
  PERFORM public.platform_context_close();
  PERFORM _va_reset();
END $$;

-- ─── 9. the plan-scoped reader takes the hour from the plan row ─────────────
--
-- Rule 2's other half. The plan stores operating_day_start_hour NOT NULL with no
-- default (slice 1), and this reader reads it from there. The fixture is built so
-- that the SAME shifts and the SAME window answer differently under the two
-- plans — which is only possible if the hour really comes from the row.

DO $$
DECLARE
  c_co_a   CONSTANT uuid := 'c0000000-0000-4000-8000-00000000000a';
  c_admin  CONSTANT uuid := 'a0000000-0000-4000-8000-000000000001';
  c_plan4  CONSTANT uuid := _va_id('plan:hour4');
  c_plan0  CONSTANT uuid := _va_id('plan:hour0');
  c_car    CONSTANT uuid := _va_id('car:a3');  -- 'VA-A 3', no TÜV date
BEGIN
  INSERT INTO public.vehicle_day_plans
    (id, company_id, year, month, operating_day_start_hour, slot_minutes, algorithm_version)
  VALUES (c_plan4, c_co_a, 2029, 5, 4, 15, 'shift-recommendation/1.0.0'),
         (c_plan0, c_co_a, 2029, 5, 0, 15, 'shift-recommendation/1.0.0');

  -- One shift per plan, both on operating day 2029-05-07, both on 'VA-A 3'.
  PERFORM _va_put_shift(c_co_a, c_plan4, DATE '2029-05-07', 'VA-A 3', 0, 24, 36, 4);
  PERFORM _va_put_shift(c_co_a, c_plan0, DATE '2029-05-07', 'VA-A 3', 0, 24, 36, 0);

  -- Section 4 put a window on 2029-05-08 01:00–03:00 on this car. Under hour 4
  -- that window is inside operating day 2029-05-07; under hour 0 it is not.
  PERFORM _va_expect('9a the hour-4 plan reports its 07.05 shift as unavailable',
    '1|VA-A 3|unavailable|recorded',
    _va_try(c_admin, NULL, format(
      'SELECT count(*)::text || ''|'' || max(vehicle) || ''|'' || max(verdict) || ''|'' || max(array_to_string(sources, '','')) '
      || 'FROM public.vehicle_day_plan_availability(%L)', c_plan4)));

  PERFORM _va_expect('9b the hour-0 plan, with the SAME shift and the SAME window, reports no conflict at all',
    '0',
    _va_try(c_admin, NULL, format(
      'SELECT count(*)::text FROM public.vehicle_day_plan_availability(%L)', c_plan0)));

  -- A plate that no longer matches a car of the company. A plan whose plates
  -- have drifted from the fleet table must say so rather than report a clean
  -- month, so the verdict is 'unverifiable' and never 'available'.
  PERFORM _va_put_shift(c_co_a, c_plan0, DATE '2029-05-09', 'VA-GONE 9', 0, 24, 36, 0);
  PERFORM _va_expect('9c a shift whose plate matches no car is ''unverifiable'', never available',
    '1|VA-GONE 9|unverifiable|vehicle_not_resolved',
    _va_try(c_admin, NULL, format(
      'SELECT count(*)::text || ''|'' || max(vehicle) || ''|'' || max(verdict) || ''|'' || max(array_to_string(sources, '','')) '
      || 'FROM public.vehicle_day_plan_availability(%L)', c_plan0)));

  -- The match is exact text, as slice 1's own overlap check takes a vehicle.
  PERFORM _va_put_shift(c_co_a, c_plan0, DATE '2029-05-10', 'va-a 3', 0, 24, 36, 0);
  PERFORM _va_expect('9d the plate is matched as EXACT text: a different case is a different vehicle',
    'true',
    _va_try(c_admin, NULL, format(
      'SELECT (count(*) = 1)::text FROM public.vehicle_day_plan_availability(%L) '
      || 'WHERE vehicle = ''va-a 3'' AND verdict = ''unverifiable''', c_plan0)));

  -- A plan of another company, and one that does not exist, answer no rows at
  -- all: the reader runs as the caller and the plan is simply not readable.
  PERFORM _va_expect('9e a plan the caller cannot read answers no rows', '0',
    _va_try('b0000000-0000-4000-8000-000000000001', NULL, format(
      'SELECT count(*)::text FROM public.vehicle_day_plan_availability(%L)', c_plan4)));
  PERFORM _va_expect('9f …and so does a plan that does not exist', '0',
    _va_try(c_admin, NULL, format(
      'SELECT count(*)::text FROM public.vehicle_day_plan_availability(%L)', _va_id('plan:nope'))));
  PERFORM _va_expect('9g a NULL plan id is a broken contract and raises 22023',
    'ERR 22023 vehicle_day_plan_availability: a plan id is required',
    _va_try(c_admin, NULL, 'SELECT count(*)::text FROM public.vehicle_day_plan_availability(NULL)'));

  -- An unresolved plate must not make the whole plan raise. vehicle_availability_on
  -- refuses a NULL car with 22023, so the reader's CTE fence is what keeps the
  -- lateral call off the unresolved rows; 9c already proves it answers, and this
  -- asserts the mixed case — a resolved conflict and an unresolved plate together.
  PERFORM _va_put_shift(c_co_a, c_plan4, DATE '2029-05-07', 'VA-GONE 4', 1, 40, 48, 4);
  PERFORM _va_expect('9h a plan holding BOTH an unresolved plate and a real conflict answers both, and raises nothing',
    '2|unavailable,unverifiable',
    _va_try(c_admin, NULL, format(
      'SELECT count(*)::text || ''|'' || string_agg(DISTINCT verdict, '','' ORDER BY verdict) '
      || 'FROM public.vehicle_day_plan_availability(%L)', c_plan4)));
END $$;

-- ─── 10. mutation controls ──────────────────────────────────────────────────
--
-- Every assertion above that could pass for the wrong reason is re-run with the
-- rule it depends on broken. Each mutation runs as the owner inside a
-- subtransaction that is rolled back with it, and _va_mutate_fn refuses a
-- fragment that is not there — a mutation that changed nothing would make its
-- control pass for the wrong reason.

DO $$
DECLARE
  c_co_a   CONSTANT uuid := 'c0000000-0000-4000-8000-00000000000a';
  c_co_b   CONSTANT uuid := 'c0000000-0000-4000-8000-00000000000b';
  c_viewer CONSTANT uuid := 'a0000000-0000-4000-8000-000000000003';
  c_admin  CONSTANT uuid := 'a0000000-0000-4000-8000-000000000001';
  c_car    CONSTANT uuid := _va_id('car:a3');  -- section 4's car
  c_a2     CONSTANT uuid := _va_id('car:a2');  -- section 5's TÜV car
  c_a4     CONSTANT uuid := _va_id('car:a4');  -- section 5's Werkstatt car
BEGIN
  -- 10a the page gate is what refuses the viewer, and nothing else. With the
  --     gate taken out of the INSERT policy the viewer's write succeeds, so 7c
  --     was measuring the gate and not the tenancy term beside it.
  PERFORM _va_expect('10a control: with the cars page dropped from the INSERT policy, the viewer''s insert succeeds',
    'rows 1',
    _va_mutant(
      'DO $m$ BEGIN '
      || 'DROP POLICY vehicle_unavailability_insert ON public.vehicle_unavailability; '
      || 'CREATE POLICY vehicle_unavailability_insert ON public.vehicle_unavailability '
      || 'FOR INSERT TO authenticated WITH CHECK (company_id = (SELECT public.get_active_company_id())); '
      || 'END $m$',
      c_viewer, NULL, format(
      'INSERT INTO vehicle_unavailability (company_id, car_id, starts_local, reason) '
      || 'VALUES (%L, %L, ''2029-12-20 00:00'', ''workshop'')', c_co_a, c_car)));

  -- 10b the tenancy term is what refuses the cross-company write, and it is a
  --     SEPARATE term: with it dropped and the page gate left in place, the
  --     administrator writes company B's row.
  PERFORM _va_expect('10b control: with the tenancy term dropped, company A''s admin writes company B''s window',
    'rows 1',
    _va_mutant(
      'DO $m$ BEGIN '
      || 'DROP POLICY vehicle_unavailability_insert ON public.vehicle_unavailability; '
      || 'CREATE POLICY vehicle_unavailability_insert ON public.vehicle_unavailability '
      || 'FOR INSERT TO authenticated WITH CHECK ((SELECT public.current_role_permits(''cars'', true))); '
      || 'END $m$',
      c_admin, NULL, format(
      'INSERT INTO vehicle_unavailability (company_id, car_id, starts_local, reason) '
      || 'VALUES (%L, %L, ''2029-12-21 00:00'', ''workshop'')', c_co_b, _va_id('car:b1'))));

  -- 10c the composite foreign key is what refuses another company's car, and no
  --     policy does: with the key dropped, the owner's cross-company row goes in.
  PERFORM _va_expect('10c control: with the composite foreign key dropped, company A takes a window on company B''s car',
    'rows 1',
    _va_mutant(
      'ALTER TABLE public.vehicle_unavailability DROP CONSTRAINT vehicle_unavailability_car_of_company',
      _va_owner(), NULL, format(
      'INSERT INTO vehicle_unavailability (company_id, car_id, starts_local, reason) '
      || 'VALUES (%L, %L, ''2029-12-22 00:00'', ''workshop'')', c_co_a, _va_id('car:b1'))));

  -- 10d the window-ordering constraint is what refuses a backwards window.
  PERFORM _va_expect('10d control: with the ordering constraint dropped, a window that ends before it starts goes in',
    'rows 1',
    _va_mutant(
      'ALTER TABLE public.vehicle_unavailability DROP CONSTRAINT vehicle_unavailability_window_ordered',
      _va_owner(), NULL, format(
      'INSERT INTO vehicle_unavailability (company_id, car_id, starts_local, ends_local, reason) '
      || 'VALUES (%L, %L, ''2029-12-24 08:00'', ''2029-12-23 08:00'', ''workshop'')', c_co_a, c_car)));

  -- 10e the guard's car pin is what refuses a re-attribution.
  PERFORM _va_expect('10e control: with the car pin removed from the guard, a window can be moved to another car',
    'rows 1',
    _va_mutant(
      format('SELECT _va_mutate_fn(%L, %L, %L)',
             'app_private.vehicle_unavailability_guard()',
             'IF NEW.car_id IS DISTINCT FROM OLD.car_id THEN',
             'IF false THEN'),
      _va_owner(), NULL, format(
      'UPDATE vehicle_unavailability SET car_id = %L WHERE company_id = %L AND car_id = %L',
      _va_id('car:a1'), c_co_a, c_a2)));

  -- 10f the TÜV term is load-bearing: with the comparison inverted, the car with
  --     a live TÜV reads as expired. 5b/5c were measuring that comparison.
  PERFORM _va_expect('10f control: with the TÜV comparison inverted, a car with a live TÜV reads as expired',
    'unavailable/tuev_expired',
    _va_mutant(
      format('SELECT _va_mutate_fn(%L, %L, %L)',
             'public.vehicle_availability_on(uuid,date,integer)',
             'p_operating_date > v_tuev', 'p_operating_date <= v_tuev'),
      c_admin, NULL, format(
      'SELECT verdict || ''/'' || array_to_string(sources, '','') FROM public.vehicle_availability_on(%L, ''2029-06-01'', 4)',
      c_a2)));

  -- 10g the NULL-TÜV rule is load-bearing in the other direction: a car with no
  --     TÜV date must read as available, not as expired.
  PERFORM _va_expect('10g control: with the NULL guard removed, a car with NO TÜV date reads as expired',
    'unavailable/tuev_expired',
    _va_mutant(
      format('SELECT _va_mutate_fn(%L, %L, %L)',
             'public.vehicle_availability_on(uuid,date,integer)',
             'IF v_tuev IS NOT NULL AND p_operating_date > v_tuev THEN',
             'IF v_tuev IS NULL OR p_operating_date > v_tuev THEN'),
      c_admin, NULL, format(
      'SELECT verdict || ''/'' || array_to_string(sources, '','') FROM public.vehicle_availability_on(%L, ''2029-01-05'', 4)',
      c_car)));

  -- 10h the Werkstatt derivation reads the LATEST check and not just any: with
  --     the ordering reversed it reads the earliest, so the cleared car of 5l
  --     reads as still defective.
  PERFORM _va_expect('10h control: with the check ordering reversed, a car cleared by a later check still reads as defective',
    'unavailable/werkstatt_negative',
    _va_mutant(
      format('SELECT _va_mutate_fn(%L, %L, %L)',
             'public.vehicle_availability_on(uuid,date,integer)',
             'ORDER BY w.check_date DESC, w.created_at DESC',
             'ORDER BY w.check_date ASC, w.created_at ASC'),
      c_admin, NULL, format(
      'SELECT verdict || ''/'' || array_to_string(sources, '','') FROM public.vehicle_availability_on(%L, ''2029-09-25'', 4)',
      c_a4)));

  -- 10i the operating-day window is half-open at its END: with the comparison
  --     widened to <=, the window of 4e that ends exactly at the day's start
  --     touches it.
  PERFORM _va_expect('10i control: with the overlap widened to <=, a window ending at the day''s start touches it',
    'unavailable/recorded',
    _va_mutant(
      format('SELECT _va_mutate_fn(%L, %L, %L)',
             'public.vehicle_availability_on(uuid,date,integer)',
             'u.ends_local > v_from', 'u.ends_local >= v_from'),
      c_admin, NULL, format(
      'SELECT verdict || ''/'' || array_to_string(sources, '','') FROM public.vehicle_availability_on(%L, ''2029-06-04'', 4)',
      c_car)));

  -- 10j the operating day's LENGTH is one calendar day: with it shortened to
  --     half a day, the window of 4a stops falling in operating day 07.05 under
  --     hour 4. This is the control for the whole of section 4.
  PERFORM _va_expect('10j control: with the operating day shortened, the hour-4 window stops being found',
    'available',
    _va_mutant(
      format('SELECT _va_mutate_fn(%L, %L, %L)',
             'public.vehicle_availability_on(uuid,date,integer)',
             'v_to   := (p_operating_date + 1)::timestamp + make_interval(hours => p_operating_day_start_hour);',
             'v_to   := p_operating_date::timestamp + make_interval(hours => p_operating_day_start_hour + 12);'),
      c_admin, NULL, format(
      'SELECT verdict || ''/'' || array_to_string(sources, '','') FROM public.vehicle_availability_on(%L, ''2029-05-07'', 4)',
      c_car)));

  -- 10k and the plan-scoped reader really takes the hour from the plan row: with
  --     a literal 0 substituted for it, the hour-4 plan of 9a stops reporting its
  --     conflict. This is the control for rule 2.
  PERFORM _va_expect('10k control: with a literal hour substituted, the hour-4 plan stops reporting its conflict',
    '0',
    _va_mutant(
      format('SELECT _va_mutate_fn(%L, %L, %L)',
             'public.vehicle_day_plan_availability(uuid)',
             'r.q_date, v_hour) a', 'r.q_date, 0) a'),
      c_admin, NULL, format(
      'SELECT count(*)::text FROM public.vehicle_day_plan_availability(%L)', _va_id('plan:hour4'))));
END $$;

-- ─── 11. the verdict ────────────────────────────────────────────────────────

DO $$
DECLARE
  v_bad  int;
  v_all  int;
  v_list text;
BEGIN
  SELECT count(*) FILTER (WHERE NOT ok), count(*) INTO v_bad, v_all FROM _va_results;

  IF v_bad > 0 THEN
    SELECT string_agg(format('%s: expected [%s] got [%s]', label, expected, actual), E'\n  ' ORDER BY n)
      INTO v_list FROM _va_results WHERE NOT ok;
    RAISE EXCEPTION E'vehicle-availability: % of % checks failed:\n  %', v_bad, v_all, v_list;
  END IF;

  RAISE NOTICE 'vehicle-availability: all % checks passed', v_all;
END $$;

ROLLBACK;
