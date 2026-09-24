/*
  The plpgsql plan-cache mask, reproduced from nothing.

  **This is an instrument, not a gate.** It lives in tests/tools/ and not in
  tests/rls/ on purpose: scripts/rls-test.mjs runs every `tests/rls/*.sql` in
  name order, and this file is a one-off measurement, run by hand when somebody
  needs the answer again. Nothing in CI calls it.

  ## What it answers

  PR #117 shipped `enforce_company_role_shape`, a SECURITY INVOKER trigger on
  `public.roles` calling a helper in `app_private`. `authenticated` holds no
  USAGE on that schema, so every company administrator creating a role got
  `42501 permission denied for schema app_private` — the feature was dead. The
  RLS kit passed, twice, reporting `roles I` as `Y` for the admin principal.

  The reason is that schema USAGE is checked when a statement is **parsed**
  (`LookupExplicitNamespace`), and plpgsql caches the parsed form of the static
  statements in a function body. `matrix.sql` runs every fixture as the owner
  before it probes any principal, so the owner — who does hold USAGE — parses
  the trigger's call once and every principal after it reuses that plan. The
  privilege check never runs a second time.

  This file establishes seven things, each printed as its own NOTICE:

    A  the owner's write succeeds and warms the cache
    B  the principal's identical write succeeds too — the mask
    C  `DISCARD PLANS` through plpgsql `EXECUTE`, and as a plain plpgsql
       statement: which of the two works, and the SQLSTATE of either that does
       not. No fallback, no silence: the point is the answer
    D  the principal's write, after the discard, is refused 42501
    E  granting USAGE makes the same write succeed — so D was about USAGE and
       about nothing else
    F  function EXECUTE is **not** masked: an owner pass that warms a call the
       principal may not execute still leaves the principal refused
    G  table privileges are **not** masked either, on the same shape

  F and G are what make the claim in CLAUDE.md a measurement rather than a
  reading of the source: the plan cache hides exactly one privilege class,
  schema USAGE, because that one is resolved by the parser while the other two
  are re-checked per execution (`init_fcache`, `ExecCheckPermissions`).

  ## Running it

      docker run -d --name pc-repro --network none --cpus 1 --memory 1g \
        -e POSTGRES_PASSWORD=pc-repro-only supabase/postgres:17.6.1.170
      # wait for pg_isready, then:
      docker exec -i pc-repro psql -v ON_ERROR_STOP=1 -U supabase_admin -d postgres \
        < tests/tools/plan-cache-repro.sql
      docker rm -f pc-repro

  It needs no fixture, no migration and no seed — it builds its own schema, its
  own table, its own trigger and its own role. Everything is inside one
  transaction that ends in ROLLBACK, so the database is left exactly as found;
  the roles go with it, CREATE ROLE being transactional.

  Read the VERDICT block at the end. Every step prints what it expected next to
  what it got, so a changed PostgreSQL shows up as a named difference rather
  than as a file that still prints "ok".
*/

\set ON_ERROR_STOP on

BEGIN;

-- ─── the world ──────────────────────────────────────────────────────────────

-- A schema nobody is granted USAGE on: app_private's shape, without app_private.
CREATE SCHEMA pc_hidden;
CREATE FUNCTION pc_hidden.answer() RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$ SELECT true $$;

-- A table only the owner may read: for step G.
CREATE TABLE pc_hidden.secret (n int);
INSERT INTO pc_hidden.secret VALUES (1);

-- The principal. A fresh role holds USAGE on no schema but the ones granted to
-- PUBLIC, so it stands in for `authenticated` without needing Supabase's roles.
CREATE ROLE pc_principal NOLOGIN;
GRANT USAGE ON SCHEMA public TO pc_principal;
-- Superuser may SET ROLE to anything; the membership is here so the file also
-- works for a non-superuser owner that may create roles.
GRANT pc_principal TO CURRENT_USER;

-- ─── the shape under test: an invoker trigger that reaches the schema ───────

CREATE TABLE public.pc_rows (note text);
GRANT INSERT ON public.pc_rows TO pc_principal;

/*
  SECURITY INVOKER — the default, and PR #117's shape exactly. The body names a
  schema the writing role cannot use, so the writing role cannot parse it.
*/
CREATE FUNCTION public.pc_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM pc_hidden.answer();
  RETURN NEW;
END $$;

CREATE TRIGGER pc_guard BEFORE INSERT ON public.pc_rows
  FOR EACH ROW EXECUTE FUNCTION public.pc_guard();

-- ─── the two controls: a function grant, and a table grant ──────────────────

-- Step F: a function in a schema the principal CAN use, whose EXECUTE it does
-- not hold. If EXECUTE were a parse-time check like USAGE, the owner's pass
-- would mask it in the same way.
CREATE FUNCTION public.pc_open() RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$ SELECT true $$;
REVOKE ALL ON FUNCTION public.pc_open() FROM PUBLIC;

CREATE TABLE public.pc_rows_exec (note text);
GRANT INSERT ON public.pc_rows_exec TO pc_principal;

CREATE FUNCTION public.pc_guard_exec() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.pc_open();
  RETURN NEW;
END $$;

CREATE TRIGGER pc_guard_exec BEFORE INSERT ON public.pc_rows_exec
  FOR EACH ROW EXECUTE FUNCTION public.pc_guard_exec();

-- Step G: a table the principal may not read, in a schema it CAN use, so the
-- refusal can only be the table privilege and never the schema.
CREATE TABLE public.pc_closed (n int);
INSERT INTO public.pc_closed VALUES (1);
REVOKE ALL ON TABLE public.pc_closed FROM PUBLIC;

CREATE TABLE public.pc_rows_table (note text);
GRANT INSERT ON public.pc_rows_table TO pc_principal;

CREATE FUNCTION public.pc_guard_table() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE v int;
BEGIN
  SELECT n INTO v FROM public.pc_closed LIMIT 1;
  RETURN NEW;
END $$;

CREATE TRIGGER pc_guard_table BEFORE INSERT ON public.pc_rows_table
  FOR EACH ROW EXECUTE FUNCTION public.pc_guard_table();

-- ─── helpers ────────────────────────────────────────────────────────────────

/*
  Write one row as `p_role` (NULL = stay the owner) and say what happened.
  The write is a static plpgsql statement, so it goes through the plan cache
  exactly as the trigger's own call does.
*/
CREATE FUNCTION public.pc_write(p_tbl text, p_role text, p_note text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE v_state text; v_msg text;
BEGIN
  BEGIN
    IF p_role IS NOT NULL THEN
      EXECUTE format('SET LOCAL ROLE %I', p_role);
    END IF;
    EXECUTE format('INSERT INTO public.%I (note) VALUES (%L)', p_tbl, p_note);
    EXECUTE 'SET LOCAL ROLE NONE';
    RETURN 'ALLOWED';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    -- the failed subtransaction has already unwound the SET LOCAL; this is the
    -- belt to its braces
    EXECUTE 'SET LOCAL ROLE NONE';
    RETURN 'REFUSED ' || v_state || ' ' || v_msg;
  END;
END $$;

/*
  `DISCARD PLANS` two ways. Whichever raises reports its SQLSTATE; neither
  falls back to the other, because which of them works is the question.
*/
CREATE FUNCTION public.pc_discard_via_execute() RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'DISCARD PLANS';
  RETURN 'OK';
EXCEPTION WHEN OTHERS THEN
  RETURN 'RAISED ' || SQLSTATE || ' ' || SQLERRM;
END $$;

CREATE FUNCTION public.pc_discard_direct() RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  DISCARD PLANS;
  RETURN 'OK';
EXCEPTION WHEN OTHERS THEN
  RETURN 'RAISED ' || SQLSTATE || ' ' || SQLERRM;
END $$;

-- ─── the run ────────────────────────────────────────────────────────────────

DO $run$
DECLARE
  a_owner     text;
  b_masked    text;
  c_execute   text;
  c_direct    text;
  d_refused   text;
  e_granted   text;
  f_exec      text;
  f_owner     text;
  g_table     text;
  g_owner     text;
  v_verdict   text[] := ARRAY[]::text[];
  v_ok        boolean := true;
BEGIN
  RAISE NOTICE ' ';
  RAISE NOTICE '════ plan-cache reproduction ════';
  RAISE NOTICE 'server: %', version();
  RAISE NOTICE ' ';

  -- A. The owner writes. This compiles pc_guard()'s call to pc_hidden.answer()
  --    and caches it for the session.
  a_owner := public.pc_write('pc_rows', NULL, 'owner warms the cache');
  RAISE NOTICE 'A  owner INSERT                       -> %', a_owner;
  RAISE NOTICE '   expected ALLOWED (and the trigger''s call is now cached)';
  IF a_owner <> 'ALLOWED' THEN
    v_ok := false;
    v_verdict := v_verdict || 'A did not succeed for the owner — the rest of this file means nothing';
  END IF;
  RAISE NOTICE ' ';

  -- B. The same write as a role with no USAGE on pc_hidden. If the plan cache
  --    masks the check, this succeeds although the role could never have
  --    parsed the trigger's body itself.
  b_masked := public.pc_write('pc_rows', 'pc_principal', 'principal, cache warm');
  RAISE NOTICE 'B  principal INSERT, cache warm       -> %', b_masked;
  RAISE NOTICE '   expected ALLOWED — this IS the mask';
  IF b_masked <> 'ALLOWED' THEN
    v_verdict := v_verdict ||
      ('B was refused, so this PostgreSQL does not reproduce the mask: ' || b_masked);
  END IF;
  RAISE NOTICE ' ';

  -- C. Can plpgsql discard plans at all, and by which spelling?
  c_execute := public.pc_discard_via_execute();
  c_direct  := public.pc_discard_direct();
  RAISE NOTICE 'C  DISCARD PLANS via plpgsql EXECUTE  -> %', c_execute;
  RAISE NOTICE 'C  DISCARD PLANS as a plain statement -> %', c_direct;
  RAISE NOTICE '   expected OK for both; only DISCARD ALL is refused in a transaction block';
  IF c_execute <> 'OK' THEN
    v_ok := false;
    v_verdict := v_verdict ||
      ('DISCARD PLANS through plpgsql EXECUTE raises: ' || c_execute ||
       ' — tests/rls/matrix.sql must use another method');
  END IF;
  IF c_direct <> 'OK' THEN
    v_verdict := v_verdict ||
      ('DISCARD PLANS as a plain plpgsql statement raises: ' || c_direct ||
       ' — EXECUTE is then the only spelling');
  END IF;
  RAISE NOTICE ' ';

  -- D. The write the mask was hiding. The discards above ran after B, so the
  --    trigger's call must be parsed again, now as the principal.
  d_refused := public.pc_write('pc_rows', 'pc_principal', 'principal, cache discarded');
  RAISE NOTICE 'D  principal INSERT, plans discarded  -> %', d_refused;
  RAISE NOTICE '   expected REFUSED 42501 permission denied for schema pc_hidden';
  IF d_refused NOT LIKE 'REFUSED 42501 permission denied for schema pc_hidden%' THEN
    v_ok := false;
    v_verdict := v_verdict ||
      ('D did not produce the schema refusal: ' || d_refused);
  END IF;
  RAISE NOTICE ' ';

  -- E. …and it really was USAGE, not the trigger, the table or the role.
  GRANT USAGE ON SCHEMA pc_hidden TO pc_principal;
  GRANT EXECUTE ON FUNCTION pc_hidden.answer() TO pc_principal;
  e_granted := public.pc_write('pc_rows', 'pc_principal', 'principal, USAGE granted');
  RAISE NOTICE 'E  principal INSERT, USAGE granted    -> %', e_granted;
  RAISE NOTICE '   expected ALLOWED — D was about schema USAGE and nothing else';
  IF e_granted <> 'ALLOWED' THEN
    v_ok := false;
    v_verdict := v_verdict || ('E was refused although USAGE was granted: ' || e_granted);
  END IF;
  RAISE NOTICE ' ';

  -- F. The first control: function EXECUTE, warmed by the owner exactly as in
  --    A and B, on a schema the principal can use.
  f_owner := public.pc_write('pc_rows_exec', NULL, 'owner warms the EXECUTE path');
  f_exec  := public.pc_write('pc_rows_exec', 'pc_principal', 'principal, EXECUTE not held');
  RAISE NOTICE 'F  owner INSERT (warms)               -> %', f_owner;
  RAISE NOTICE 'F  principal INSERT, no discard       -> %', f_exec;
  RAISE NOTICE '   expected REFUSED 42501 permission denied for function pc_open';
  RAISE NOTICE '   — function EXECUTE is checked at executor init, so it is never masked';
  IF f_owner <> 'ALLOWED' THEN
    v_ok := false;
    v_verdict := v_verdict || ('F''s owner pass failed, so its control proves nothing: ' || f_owner);
  ELSIF f_exec NOT LIKE 'REFUSED 42501 permission denied for function%' THEN
    v_ok := false;
    v_verdict := v_verdict ||
      ('F: function EXECUTE behaved unlike the reading of it — ' || f_exec);
  END IF;
  RAISE NOTICE ' ';

  -- G. The second control: a table privilege, same shape.
  g_owner := public.pc_write('pc_rows_table', NULL, 'owner warms the table path');
  g_table := public.pc_write('pc_rows_table', 'pc_principal', 'principal, SELECT not held');
  RAISE NOTICE 'G  owner INSERT (warms)               -> %', g_owner;
  RAISE NOTICE 'G  principal INSERT, no discard       -> %', g_table;
  RAISE NOTICE '   expected REFUSED 42501 permission denied for table pc_closed';
  RAISE NOTICE '   — table privileges are checked by the executor, so never masked';
  IF g_owner <> 'ALLOWED' THEN
    v_ok := false;
    v_verdict := v_verdict || ('G''s owner pass failed, so its control proves nothing: ' || g_owner);
  ELSIF g_table NOT LIKE 'REFUSED 42501 permission denied for table%' THEN
    v_ok := false;
    v_verdict := v_verdict ||
      ('G: table privileges behaved unlike the reading of them — ' || g_table);
  END IF;
  RAISE NOTICE ' ';

  RAISE NOTICE '════ VERDICT ════';
  IF v_ok AND b_masked = 'ALLOWED' THEN
    RAISE NOTICE 'The mask reproduces, DISCARD PLANS lifts it, and it is specific to';
    RAISE NOTICE 'schema USAGE: function EXECUTE and table privileges were refused with';
    RAISE NOTICE 'the cache just as warm. tests/rls/matrix.sql''s guard is doing the one';
    RAISE NOTICE 'thing that is needed, and no more.';
  END IF;
  IF cardinality(v_verdict) > 0 THEN
    FOR i IN 1 .. cardinality(v_verdict) LOOP
      RAISE NOTICE 'NOTE % %', i, v_verdict[i];
    END LOOP;
  END IF;
  IF NOT v_ok THEN
    RAISE NOTICE ' ';
    RAISE NOTICE 'Something above did not behave as read. Paste the whole output back;';
    RAISE NOTICE 'the guard in matrix.sql may need a different method.';
  END IF;
  RAISE NOTICE '═════════════════';
END $run$;

ROLLBACK;
