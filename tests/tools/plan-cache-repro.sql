/*
  The plpgsql plan-cache mask, reproduced from nothing.

  **This is an instrument, not a gate.** It lives in tests/tools/ and not in
  tests/rls/ on purpose: scripts/rls-test.mjs runs every `.sql` file in
  tests/rls/ in name order, and this file is a one-off measurement, run by hand
  when somebody needs the answer again. Nothing in CI calls it.

  That last sentence is also the hazard, and it cost a round trip on the first
  version of this file. **PostgreSQL block comments nest.** A shell glob for the
  files in a directory — a slash, then a star — opens a *second* comment inside
  this one, which nothing ever closes, so psql swallows the file to EOF and
  reports an unterminated comment at line 1. Backticks do not protect it: the
  lexer does not know what a backtick is. The delimiters are deliberately not
  written out anywhere in this file, the same rule the header of
  `app_private.function_code` states for the same reason.

  What makes this file the one it happened to: a file under tests/rls/ would
  have failed loudly on the next kit run, and **this one is run by nobody**, so
  it had no gate. It has one now — `src/utils/sqlComments.test.ts` scans every
  `.sql` file under tests/ for an unterminated comment, dollar quote or string,
  with nesting, and it runs in `npm run build`. Write a glob here as "every
  `.sql` file in that directory" and it never arises.

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

  This file establishes eight things, each printed as its own NOTICE, and every
  premise it depends on is asserted before the first of them:

    A  the owner's write succeeds and warms the cache
    B  the principal's identical write succeeds too — the mask
    C  `DISCARD PLANS` through plpgsql `EXECUTE`, and as a plain plpgsql
       statement: which of the two works, and the SQLSTATE of either that does
       not. No fallback, no silence: the point is the answer
    D  the principal's write, after the discard, is refused 42501
    E  granting USAGE makes the same write succeed — so D was about USAGE and
       about nothing else
    F1 function EXECUTE, through a **plpgsql** function the principal may not
       execute. Not asserted, measured: the verdict prints which class it is
    F2 the same through an inlinable `sql IMMUTABLE` function, which proves
       nothing about privilege and is here to say so
    G  a table privilege, on the same shape

  ## What the first run of this file got wrong, and why both halves are kept

  Measured on PostgreSQL 17.6, 26.09.2026: **two privilege classes are masked by
  the plan cache, not one.** Schema USAGE is (A, B, D), and so is function
  EXECUTE. A table privilege is not — G is refused with the cache just as warm.

  The first version of this file predicted that function EXECUTE would be
  refused, on a reading of where PostgreSQL checks it, and had two faults at
  once. The reading was **wrong**: EXECUTE is resolved when the statement is
  planned, like USAGE. And the probe was **weak**: it called a `LANGUAGE sql`,
  `IMMUTABLE` function whose body selects a constant — the textbook inlinable
  shape — so the planner folded the call away entirely and the owner's cached
  plan held no function reference at all. It would have answered ALLOWED whatever
  the privilege rule was.

  Two faults pointing the same way is the worst case for an instrument, because
  the wrong answer looks confirmed. What settled it was a second, independent
  observation: with the guard in place, `tests/rls/matrix.sql`'s `roles I` cell
  moved `RR` to `PP` for `anon`, with
  `42501 permission denied for function role_name_is_system_reserved` — the same
  class, in the real schema, on a real migration. F1 and F2 are both kept so a
  later reader can separate "PostgreSQL behaves unexpectedly" from "the
  instrument was wrong" without re-deriving any of this.

  The guard in `matrix.sql` is unaffected by which classes are masked: there is
  one plan cache and `DISCARD PLANS` empties all of it.

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

/*
  Step F: function EXECUTE, warmed by the owner exactly as A warms the schema
  check, on a schema the principal CAN use — so the only thing that can refuse
  the write is the grant on the function.

  **It is probed twice, and the difference between the two is the point.**

  The first version of this file had only F2, and F2 answered ALLOWED. Read as a
  measurement of the EXECUTE class that would say EXECUTE is masked. It is not a
  measurement of it at all: `LANGUAGE sql` + `IMMUTABLE` + a body that selects a
  constant is the textbook inlinable function. The planner inlines it into the
  calling expression and folds it to the constant, so the plan the owner cached
  holds **no function call whatsoever** — there is nothing left for the principal
  to be refused on, cache or no cache. The probe measured inlining, not
  privilege.

  F1 is the real probe: a `plpgsql` function, which is never inlined into its
  caller and never pre-evaluated, so the call survives into the cached plan.

  F2 stays, labelled, because a file that silently changed its answer would
  leave the next reader unable to tell "PostgreSQL behaves unexpectedly" from
  "the instrument was wrong". Run together they separate the two: if F1 refuses
  and F2 allows, the first run's surprise was inlining and nothing else.
*/
CREATE FUNCTION public.pc_open_plpgsql() RETURNS boolean
LANGUAGE plpgsql AS $$ BEGIN RETURN true; END $$;
REVOKE ALL ON FUNCTION public.pc_open_plpgsql() FROM PUBLIC;

CREATE FUNCTION public.pc_open_inlinable() RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$ SELECT true $$;
REVOKE ALL ON FUNCTION public.pc_open_inlinable() FROM PUBLIC;

CREATE TABLE public.pc_rows_exec (note text);
GRANT INSERT ON public.pc_rows_exec TO pc_principal;

CREATE FUNCTION public.pc_guard_exec() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.pc_open_plpgsql();
  RETURN NEW;
END $$;

CREATE TRIGGER pc_guard_exec BEFORE INSERT ON public.pc_rows_exec
  FOR EACH ROW EXECUTE FUNCTION public.pc_guard_exec();

CREATE TABLE public.pc_rows_exec_inline (note text);
GRANT INSERT ON public.pc_rows_exec_inline TO pc_principal;

CREATE FUNCTION public.pc_guard_exec_inline() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.pc_open_inlinable();
  RETURN NEW;
END $$;

CREATE TRIGGER pc_guard_exec_inline BEFORE INSERT ON public.pc_rows_exec_inline
  FOR EACH ROW EXECUTE FUNCTION public.pc_guard_exec_inline();

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
  f1_exec     text;
  f1_owner    text;
  f2_exec     text;
  f2_owner    text;
  g_table     text;
  g_owner     text;
  v_verdict   text[] := ARRAY[]::text[];
  v_ok        boolean := true;
BEGIN
  RAISE NOTICE ' ';
  RAISE NOTICE '════ plan-cache reproduction ════';
  RAISE NOTICE 'server: %', version();
  RAISE NOTICE ' ';

  /*
    The premises, before anything is measured. Each of the three probes below
    can be defeated by a setup that silently did not take — a schema the
    principal can use after all, a REVOKE that did not remove the grant PUBLIC
    gave it — and each of those would read as "allowed" and be mistaken for a
    mask. The first version of this file asserted the premise for the schema and
    not for the other two, and that is exactly where it went wrong.
  */
  IF has_schema_privilege('pc_principal', 'pc_hidden', 'USAGE') THEN
    RAISE EXCEPTION 'premise: pc_principal can use pc_hidden, so A-E measure nothing';
  END IF;
  IF has_function_privilege('pc_principal', 'public.pc_open_plpgsql()', 'EXECUTE') THEN
    RAISE EXCEPTION 'premise: pc_principal holds EXECUTE on pc_open_plpgsql, so F1 measures nothing';
  END IF;
  IF has_function_privilege('pc_principal', 'public.pc_open_inlinable()', 'EXECUTE') THEN
    RAISE EXCEPTION 'premise: pc_principal holds EXECUTE on pc_open_inlinable, so F2 measures nothing';
  END IF;
  IF has_table_privilege('pc_principal', 'public.pc_closed', 'SELECT') THEN
    RAISE EXCEPTION 'premise: pc_principal can read pc_closed, so G measures nothing';
  END IF;
  RAISE NOTICE 'premises ok: no USAGE on pc_hidden, no EXECUTE on either pc_open_*, no SELECT on pc_closed';
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

  -- F. The EXECUTE class, twice. F1 is the measurement; F2 reproduces the
  --    first run's surprise and identifies it as inlining rather than privilege.
  --    Neither is asserted: what the answer *is* is the open question, and an
  --    instrument that fails when the world disagrees with it measures nothing.
  f1_owner := public.pc_write('pc_rows_exec', NULL, 'owner warms the EXECUTE path');
  f1_exec  := public.pc_write('pc_rows_exec', 'pc_principal', 'principal, EXECUTE not held');
  RAISE NOTICE 'F1 owner INSERT (warms), plpgsql fn   -> %', f1_owner;
  RAISE NOTICE 'F1 principal INSERT, no discard       -> %', f1_exec;
  RAISE NOTICE '   a plpgsql function is never inlined, so the call is really in the';
  RAISE NOTICE '   cached plan. REFUSED here means function EXECUTE is re-checked per';
  RAISE NOTICE '   execution; ALLOWED means it is resolved at plan time and masked too';
  IF f1_owner <> 'ALLOWED' THEN
    v_ok := false;
    v_verdict := v_verdict || ('F1''s owner pass failed, so F1 measures nothing: ' || f1_owner);
  ELSIF f1_exec LIKE 'REFUSED 42501 permission denied for function%' THEN
    v_verdict := v_verdict ||
      'MEASURED: function EXECUTE is NOT masked — re-checked per execution, like a table privilege';
  ELSIF f1_exec = 'ALLOWED' THEN
    v_verdict := v_verdict ||
      'MEASURED: function EXECUTE IS masked, like schema USAGE — two classes are hidden, not one';
  ELSE
    v_ok := false;
    v_verdict := v_verdict || ('F1 was refused for an unrelated reason: ' || f1_exec);
  END IF;
  RAISE NOTICE ' ';

  f2_owner := public.pc_write('pc_rows_exec_inline', NULL, 'owner warms the inlinable path');
  f2_exec  := public.pc_write('pc_rows_exec_inline', 'pc_principal', 'principal, EXECUTE not held');
  RAISE NOTICE 'F2 owner INSERT (warms), inlinable fn -> %', f2_owner;
  RAISE NOTICE 'F2 principal INSERT, no discard       -> %', f2_exec;
  RAISE NOTICE '   expected ALLOWED, and it proves nothing about privilege: an';
  RAISE NOTICE '   IMMUTABLE sql function selecting a constant is inlined and folded,';
  RAISE NOTICE '   so the owner''s cached plan holds no function call at all. This is';
  RAISE NOTICE '   the first run''s F, kept to name what it really measured';
  IF f2_exec <> 'ALLOWED' THEN
    v_verdict := v_verdict ||
      ('F2 was refused (' || f2_exec || '), so this planner did not inline the function — read F1 alone');
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
  IF v_ok AND b_masked = 'ALLOWED' AND d_refused LIKE 'REFUSED 42501 permission denied for schema%' THEN
    RAISE NOTICE 'The mask reproduces on schema USAGE (A, B), DISCARD PLANS lifts it (C, D),';
    RAISE NOTICE 'and D was about USAGE alone (E). A table privilege is NOT masked: G was';
    RAISE NOTICE 'refused with the cache just as warm. The EXECUTE class is whichever of';
    RAISE NOTICE 'the two MEASURED lines below F1 printed — read that, do not assume it.';
    RAISE NOTICE 'tests/rls/matrix.sql''s guard covers every class either way: there is one';
    RAISE NOTICE 'plan cache and DISCARD PLANS empties all of it.';
  END IF;
  IF g_table LIKE 'REFUSED 42501 permission denied for table%' THEN
    RAISE NOTICE 'MEASURED: table privileges are NOT masked — re-checked on every execution';
  ELSIF g_owner = 'ALLOWED' THEN
    RAISE NOTICE 'MEASURED: table privileges ARE masked too (%) — wider than any reading of it', g_table;
  END IF;
  IF cardinality(v_verdict) > 0 THEN
    FOR i IN 1 .. cardinality(v_verdict) LOOP
      RAISE NOTICE 'NOTE % %', i, v_verdict[i];
    END LOOP;
  END IF;
  IF NOT v_ok THEN
    RAISE NOTICE ' ';
    RAISE NOTICE 'A premise or an owner pass failed, so at least one step measured nothing.';
    RAISE NOTICE 'Paste the whole output back before drawing anything from it.';
  END IF;
  RAISE NOTICE '═════════════════';
END $run$;

ROLLBACK;
