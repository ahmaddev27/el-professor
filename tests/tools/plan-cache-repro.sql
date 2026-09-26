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

  This file reports eleven things, each printed as its own NOTICE, and every
  premise it depends on is asserted before the step that needs it. It **reports**: the
  verdict block draws no conclusion, because a verdict here printed a one-line
  answer about function EXECUTE once and that answer was wrong. The taxonomy
  built from these lines lives in CLAUDE.md.

    A  the owner's write succeeds and warms the cache
    B  the principal's identical write succeeds too — the mask
    C  `DISCARD PLANS` through plpgsql `EXECUTE`, and as a plain plpgsql
       statement: which of the two works, and the SQLSTATE of either that does
       not. No fallback, no silence: the point is the answer
    D  the principal's write, after the discard, is refused 42501
    E  granting USAGE makes the same write succeed — so D was about USAGE and
       about nothing else
    F1 function EXECUTE, through a **plpgsql** function the principal may not
       execute — never inlinable, so the call is really in the cached plan
    F2 the same through an inlinable `sql IMMUTABLE` function with no SET clause
    F3 the same through a `sql STABLE` function **with** a SET clause, which is
       the shape of 20260923120000's helper and of matrix.sql's `roles I` cell
    G  a table privilege, on the same shape
    H1 schema USAGE warmed by one ordinary role and read by another, with **no
       owner anywhere in the path** — whether a pooled backend can carry the mask
       between two signed-in users
    H2 the same for the one callee shape that masked in F2

  F1, F2 and F3 differ in exactly the property that decides whether the planner
  may fold the call away, and **none of the three is asserted**: which of them a
  given PostgreSQL groups together is the measurement.

  ## What each round trip got wrong, and why all three F probes are kept

  Measured on PostgreSQL 17.6: schema USAGE **is** masked by the plan cache (A,
  B, D, E), and a table privilege is **not** — G is refused with the cache just
  as warm. The EXECUTE class is not one answer: it depends on the callee, which
  is what F1, F2 and F3 are for, and at the time of writing F3 has not run.

  Three readings have been wrong here, in three directions, which is why nothing
  in this file asserts a mechanism any more:

  1. The first version had only F2, and F2 answered ALLOWED. Written up as "the
     EXECUTE class is masked". **It measures nothing about privilege**:
     `LANGUAGE sql` + `IMMUTABLE` + a body that selects a constant is the
     textbook inlinable shape, so the planner folds the call away and the owner's
     cached plan holds no function reference for the principal to be refused on.
  2. F1 then measured the same class through a plpgsql callee, never inlinable,
     and was **refused** — the opposite answer, for a callee the planner cannot
     fold. So the original reading, that EXECUTE is re-checked per execution,
     holds for a real call.
  3. `tests/rls/matrix.sql`'s `roles I` cell moved `RR` to `PP` for `anon` with
     `permission denied for function role_name_is_system_reserved`, and inlining
     was offered as the account of it. That helper is `LANGUAGE sql STABLE` **with
     a SET clause**; F3 is that exact shape and came back **REFUSED with the cache
     warm**, which kills the inlining account as well.

  So **the mechanism behind `roles I` is not established**, and nothing in this
  file or in CLAUDE.md claims one. What the three probes do is rule things out:

    F1 refused  →  a real call's EXECUTE is re-checked per execution
    F3 refused  →  and that holds for `roles I`'s own callee shape
    F2 allowed  →  only a callee the planner may fold away is masked, and
                   `roles I`'s is not one

  Something about the real path differs from every probe here in a way nobody has
  identified. The differences that have not been probed, as leads and **not as
  explanations**: the real trigger is BEFORE INSERT **OR UPDATE**, the probes'
  fire on INSERT only; the real callee's body reads an RLS table (`public.roles`)
  where the probes' select a constant; the real table has RLS enabled with
  policies and the probe tables have none, so the real path has a WITH CHECK that
  can refuse and the probes do not; and the real trigger function lives in
  `app_private` rather than `public`. Each is something to probe, and a fourth
  confident paragraph is exactly what must not be written instead.

  The lesson the file carries in its own structure: a reading of PostgreSQL's
  source has been wrong here three times, in both directions, and each read as
  confirmed at the time. Measure it.

  The guard in `matrix.sql` is unaffected by every one of these, and by
  construction rather than by luck: `DISCARD PLANS` forces a re-plan, and a
  re-plan under the principal can neither reuse the owner's resolution nor inline
  a function the principal may not execute.

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

/*
  Step F3: the shape `tests/rls/matrix.sql`'s `roles I` cell actually has, which
  is neither F1's nor F2's, and which is why that cell's mechanism is measured
  here instead of being asserted from a reading.

  `20260923120000`'s helper is `LANGUAGE sql STABLE` **with a
  `SET search_path` clause**. F1 is plpgsql and F2 is `sql IMMUTABLE` with no
  `SET`. The three differ in exactly the property that decides whether the
  planner may inline the call, so run together they separate the hypotheses
  rather than leaving one to be argued:

    F1  plpgsql                       — never inlinable
    F2  sql IMMUTABLE, no SET clause  — the textbook inlinable shape
    F3  sql STABLE, SET search_path   — `roles I`'s shape

  The reading of PostgreSQL's optimiser says a function carrying a `SET` clause
  is not inlined, because the setting would have to follow the expression it was
  folded into — which would put F3 with F1 and make "the call was inlined away"
  the wrong account of `roles I`. **That reading is not written into anything
  until this step answers.** This branch has had a reading of the source be
  wrong twice already, in opposite directions.
*/
CREATE FUNCTION public.pc_open_sql_set() RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog, public
AS $$ SELECT true $$;
REVOKE ALL ON FUNCTION public.pc_open_sql_set() FROM PUBLIC;

CREATE TABLE public.pc_rows_exec_set (note text);
GRANT INSERT ON public.pc_rows_exec_set TO pc_principal;

CREATE FUNCTION public.pc_guard_exec_set() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.pc_open_sql_set();
  RETURN NEW;
END $$;

CREATE TRIGGER pc_guard_exec_set BEFORE INSERT ON public.pc_rows_exec_set
  FOR EACH ROW EXECUTE FUNCTION public.pc_guard_exec_set();

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

-- ─── Step H: is the mask confined to the owner at all? ──────────────────────
/*
  Every step above warms the cache as the **owner**, a superuser that bypasses
  RLS and holds every grant. That made it easy to read the mask as an artefact of
  this file's fixture pass. It is not safe to keep reading it that way, for two
  reasons:

  - **PostgREST pools connections.** One PostgreSQL backend serves requests from
    many roles in turn, with `SET LOCAL ROLE` per transaction, and the plan cache
    belongs to the backend and not to the role. If an ordinary role that holds a
    privilege can warm a plan for one that does not, the mask is a property of a
    shared backend and reaches production, not only the kit.
  - **No mechanism is established.** F1, F2 and F3 between them killed both
    accounts of why `matrix.sql`'s `roles I` moved. With no mechanism there is no
    argument that the mask is confined to a superuser, so the confinement has to
    be measured rather than assumed.

  So H takes the owner out of the path entirely. Two ordinary roles: `pc_warmer`
  holds the grant and plans the statement first; `pc_principal` does not hold it
  and runs the same statement second. Both halves of the one class that masked
  (H2, an inlinable callee) and of the class this whole guard exists for (H1,
  schema USAGE) are probed.

  Asserted premises, no asserted outcome, and the verdict prints what it found —
  the same shape as F1/F2/F3, for the same reason.
*/
CREATE ROLE pc_warmer NOLOGIN;
GRANT USAGE ON SCHEMA public TO pc_warmer;
GRANT pc_warmer TO CURRENT_USER;

-- H1: schema USAGE. A second hidden schema, because step E granted pc_principal
-- USAGE on the first one.
CREATE SCHEMA pc_hidden2;
CREATE FUNCTION pc_hidden2.answer() RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$ SELECT true $$;
GRANT USAGE ON SCHEMA pc_hidden2 TO pc_warmer;

CREATE TABLE public.pc_rows_pool_schema (note text);
GRANT INSERT ON public.pc_rows_pool_schema TO pc_warmer, pc_principal;

CREATE FUNCTION public.pc_guard_pool_schema() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM pc_hidden2.answer();
  RETURN NEW;
END $$;

CREATE TRIGGER pc_guard_pool_schema BEFORE INSERT ON public.pc_rows_pool_schema
  FOR EACH ROW EXECUTE FUNCTION public.pc_guard_pool_schema();

-- H2: function EXECUTE, on the one callee shape that masked (F2's).
CREATE FUNCTION public.pc_open_inlinable2() RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$ SELECT true $$;
REVOKE ALL ON FUNCTION public.pc_open_inlinable2() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pc_open_inlinable2() TO pc_warmer;

CREATE TABLE public.pc_rows_pool_exec (note text);
GRANT INSERT ON public.pc_rows_pool_exec TO pc_warmer, pc_principal;

CREATE FUNCTION public.pc_guard_pool_exec() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.pc_open_inlinable2();
  RETURN NEW;
END $$;

CREATE TRIGGER pc_guard_pool_exec BEFORE INSERT ON public.pc_rows_pool_exec
  FOR EACH ROW EXECUTE FUNCTION public.pc_guard_pool_exec();

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
  f3_exec     text;
  f3_owner    text;
  g_table     text;
  g_owner     text;
  h1_warm     text;
  h1_read     text;
  h2_warm     text;
  h2_read     text;
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
  IF has_function_privilege('pc_principal', 'public.pc_open_sql_set()', 'EXECUTE') THEN
    RAISE EXCEPTION 'premise: pc_principal holds EXECUTE on pc_open_sql_set, so F3 measures nothing';
  END IF;
  IF has_table_privilege('pc_principal', 'public.pc_closed', 'SELECT') THEN
    RAISE EXCEPTION 'premise: pc_principal can read pc_closed, so G measures nothing';
  END IF;
  RAISE NOTICE 'premises ok: no USAGE on pc_hidden, no EXECUTE on any pc_open_*, no SELECT on pc_closed';
  RAISE NOTICE ' ';

  -- A. The owner writes. This compiles pc_guard()'s call to pc_hidden.answer()
  --    and caches it for the session.
  a_owner := public.pc_write('pc_rows', NULL, 'owner warms the cache');
  RAISE NOTICE 'A  owner INSERT                       -> %', a_owner;
  RAISE NOTICE '   expected ALLOWED (and the trigger''s call is now cached)';
  IF a_owner <> 'ALLOWED' THEN
    v_ok := false;
    v_verdict := array_append(v_verdict, 'A did not succeed for the owner — the rest of this file means nothing');
  END IF;
  RAISE NOTICE ' ';

  -- B. The same write as a role with no USAGE on pc_hidden. If the plan cache
  --    masks the check, this succeeds although the role could never have
  --    parsed the trigger's body itself.
  b_masked := public.pc_write('pc_rows', 'pc_principal', 'principal, cache warm');
  RAISE NOTICE 'B  principal INSERT, cache warm       -> %', b_masked;
  RAISE NOTICE '   expected ALLOWED — this IS the mask';
  IF b_masked <> 'ALLOWED' THEN
    v_verdict := array_append(v_verdict,
      ('B was refused, so this PostgreSQL does not reproduce the mask: ' || b_masked));
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
    v_verdict := array_append(v_verdict,
      ('DISCARD PLANS through plpgsql EXECUTE raises: ' || c_execute ||
       ' — tests/rls/matrix.sql must use another method'));
  END IF;
  IF c_direct <> 'OK' THEN
    v_verdict := array_append(v_verdict,
      ('DISCARD PLANS as a plain plpgsql statement raises: ' || c_direct ||
       ' — EXECUTE is then the only spelling'));
  END IF;
  RAISE NOTICE ' ';

  -- D. The write the mask was hiding. The discards above ran after B, so the
  --    trigger's call must be parsed again, now as the principal.
  d_refused := public.pc_write('pc_rows', 'pc_principal', 'principal, cache discarded');
  RAISE NOTICE 'D  principal INSERT, plans discarded  -> %', d_refused;
  RAISE NOTICE '   expected REFUSED 42501 permission denied for schema pc_hidden';
  IF d_refused NOT LIKE 'REFUSED 42501 permission denied for schema pc_hidden%' THEN
    v_ok := false;
    v_verdict := array_append(v_verdict,
      ('D did not produce the schema refusal: ' || d_refused));
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
    v_verdict := array_append(v_verdict, ('E was refused although USAGE was granted: ' || e_granted));
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
    v_verdict := array_append(v_verdict, ('F1''s owner pass failed, so F1 measures nothing: ' || f1_owner));
  ELSIF f1_exec <> 'ALLOWED'
        AND f1_exec NOT LIKE 'REFUSED 42501 permission denied for function%' THEN
    v_ok := false;
    v_verdict := array_append(v_verdict, ('F1 was refused for an unrelated reason: ' || f1_exec));
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
    v_verdict := array_append(v_verdict,
      ('F2 was refused (' || f2_exec || '), so this planner did not inline the function — read F1 alone'));
  END IF;
  RAISE NOTICE ' ';

  -- F3. `roles I`'s own shape: sql, STABLE, with a SET clause. Reported, never
  --     asserted: which of F1 and F2 it joins is the finding.
  f3_owner := public.pc_write('pc_rows_exec_set', NULL, 'owner warms the sql+SET path');
  f3_exec  := public.pc_write('pc_rows_exec_set', 'pc_principal', 'principal, EXECUTE not held');
  RAISE NOTICE 'F3 owner INSERT (warms), sql+SET fn   -> %', f3_owner;
  RAISE NOTICE 'F3 principal INSERT, no discard       -> %', f3_exec;
  RAISE NOTICE '   this is 20260923120000''s helper''s shape, and matrix.sql''s roles I';
  RAISE NOTICE '   cell. REFUSED puts it with F1 and the cell''s mask is NOT inlining;';
  RAISE NOTICE '   ALLOWED puts it with F2 and inlining is the whole story';
  IF f3_owner <> 'ALLOWED' THEN
    v_ok := false;
    v_verdict := array_append(v_verdict, ('F3''s owner pass failed, so F3 measures nothing: ' || f3_owner));
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
    v_verdict := array_append(v_verdict, ('G''s owner pass failed, so its control proves nothing: ' || g_owner));
  ELSIF g_table NOT LIKE 'REFUSED 42501 permission denied for table%' THEN
    v_ok := false;
    v_verdict := array_append(v_verdict,
      ('G: table privileges behaved unlike the reading of them — ' || g_table));
  END IF;
  RAISE NOTICE ' ';

  /*
    H. The owner is not in this path. Premises first, and they are the whole
    validity of the step: a warmer that may not do the thing warms nothing, a
    reader that may do it proves nothing, and a role that bypasses RLS or is a
    superuser is not an ordinary role.
  */
  IF NOT has_schema_privilege('pc_warmer', 'pc_hidden2', 'USAGE') THEN
    RAISE EXCEPTION 'premise: pc_warmer cannot use pc_hidden2, so H1 warms nothing';
  END IF;
  IF has_schema_privilege('pc_principal', 'pc_hidden2', 'USAGE') THEN
    RAISE EXCEPTION 'premise: pc_principal can use pc_hidden2, so H1 measures nothing';
  END IF;
  IF NOT has_function_privilege('pc_warmer', 'public.pc_open_inlinable2()', 'EXECUTE') THEN
    RAISE EXCEPTION 'premise: pc_warmer holds no EXECUTE on pc_open_inlinable2, so H2 warms nothing';
  END IF;
  IF has_function_privilege('pc_principal', 'public.pc_open_inlinable2()', 'EXECUTE') THEN
    RAISE EXCEPTION 'premise: pc_principal holds EXECUTE on pc_open_inlinable2, so H2 measures nothing';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles
              WHERE rolname IN ('pc_warmer', 'pc_principal')
                AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'premise: one of the two H roles is a superuser or bypasses RLS, so neither stands in for authenticated';
  END IF;
  RAISE NOTICE 'H premises ok: pc_warmer holds both grants, pc_principal neither, and neither role is super or bypassrls';

  -- Nothing has executed either guard function, and a discard makes that
  -- independent of anything above rather than merely true today.
  PERFORM public.pc_discard_via_execute();

  h1_warm := public.pc_write('pc_rows_pool_schema', 'pc_warmer',    'pc_warmer warms the schema path');
  h1_read := public.pc_write('pc_rows_pool_schema', 'pc_principal', 'pc_principal, no USAGE');
  RAISE NOTICE 'H1 pc_warmer INSERT (warms)           -> %', h1_warm;
  RAISE NOTICE 'H1 pc_principal INSERT, no discard    -> %', h1_read;
  RAISE NOTICE '   schema USAGE, warmed by an ordinary role and read by another.';
  RAISE NOTICE '   REFUSED means the mask needs the owner. ALLOWED means it does not,';
  RAISE NOTICE '   and a pooled backend can carry it between two signed-in users';

  h2_warm := public.pc_write('pc_rows_pool_exec', 'pc_warmer',    'pc_warmer warms the EXECUTE path');
  h2_read := public.pc_write('pc_rows_pool_exec', 'pc_principal', 'pc_principal, no EXECUTE');
  RAISE NOTICE 'H2 pc_warmer INSERT (warms)           -> %', h2_warm;
  RAISE NOTICE 'H2 pc_principal INSERT, no discard    -> %', h2_read;
  RAISE NOTICE '   the same for the one callee shape that masked in F2';

  IF h1_warm <> 'ALLOWED' THEN
    v_ok := false;
    v_verdict := array_append(v_verdict, ('H1''s warmer was refused, so H1 warmed nothing: ' || h1_warm));
  END IF;
  IF h2_warm <> 'ALLOWED' THEN
    v_ok := false;
    v_verdict := array_append(v_verdict, ('H2''s warmer was refused, so H2 warmed nothing: ' || h2_warm));
  END IF;
  RAISE NOTICE ' ';

  RAISE NOTICE '════ WHAT EACH PROBE FOUND ════';
  RAISE NOTICE 'This block reports. It draws no conclusion on purpose: an earlier version';
  RAISE NOTICE 'printed a one-line answer about function EXECUTE and that answer was wrong,';
  RAISE NOTICE 'in a file whose own F2 showed the opposite for a different kind of callee.';
  RAISE NOTICE 'The taxonomy lives in CLAUDE.md and is built from these lines.';
  RAISE NOTICE ' ';
  RAISE NOTICE '  schema USAGE, cache warm            %', b_masked;
  RAISE NOTICE '  schema USAGE, plans discarded       %', d_refused;
  RAISE NOTICE '  schema USAGE, then granted          %', e_granted;
  RAISE NOTICE '  EXECUTE, plpgsql callee (F1)        %', f1_exec;
  RAISE NOTICE '  EXECUTE, inlinable sql callee (F2)  %', f2_exec;
  RAISE NOTICE '  EXECUTE, sql + SET callee (F3)      %', f3_exec;
  RAISE NOTICE '  table privilege (G)                 %', g_table;
  RAISE NOTICE '  schema USAGE, no owner (H1)         %', h1_read;
  RAISE NOTICE '  EXECUTE, inlinable, no owner (H2)   %', h2_read;
  RAISE NOTICE ' ';
  RAISE NOTICE 'How to read a line: ALLOWED with the cache warm means the class is masked —';
  RAISE NOTICE 'the owner''s plan decided it. REFUSED means it is re-checked per execution.';
  RAISE NOTICE 'F1 against F2 against F3 is what says whether the EXECUTE answer is about';
  RAISE NOTICE 'privilege timing or about whether the callee could be inlined away.';
  RAISE NOTICE ' ';
  RAISE NOTICE 'The guard in tests/rls/matrix.sql covers every masked class either way, and';
  RAISE NOTICE 'by construction rather than by luck: DISCARD PLANS forces a re-plan, and a';
  RAISE NOTICE 're-plan under the principal can neither reuse the owner''s resolution nor';
  RAISE NOTICE 'inline a function the principal may not execute.';
  IF h1_read = 'ALLOWED' OR h2_read = 'ALLOWED' THEN
    RAISE NOTICE ' ';
    RAISE NOTICE '*** STOP AND READ: a mask crossed two ordinary roles with no owner in the';
    RAISE NOTICE '*** path (H1=%, H2=%). PostgREST pools one backend across roles, so this is', h1_read, h2_read;
    RAISE NOTICE '*** a statement about the product and not about this file. Take it to the';
    RAISE NOTICE '*** owner before anything else is written down.';
  ELSIF h1_warm = 'ALLOWED' AND h2_warm = 'ALLOWED' THEN
    RAISE NOTICE ' ';
    RAISE NOTICE 'H: neither mask crossed two ordinary roles, so on this PostgreSQL it needs';
    RAISE NOTICE 'the owner. That is measured here, not assumed from the absence of a';
    RAISE NOTICE 'mechanism.';
  END IF;
  IF cardinality(v_verdict) > 0 THEN
    RAISE NOTICE ' ';
    FOR i IN 1 .. cardinality(v_verdict) LOOP
      RAISE NOTICE 'NOTE % %', i, v_verdict[i];
    END LOOP;
  END IF;
  IF NOT v_ok THEN
    RAISE NOTICE ' ';
    RAISE NOTICE 'A premise or an owner pass failed, so at least one line above measured';
    RAISE NOTICE 'nothing. Paste the whole output back before drawing anything from it.';
  END IF;
  RAISE NOTICE '═══════════════════════════════';
END $run$;

ROLLBACK;
