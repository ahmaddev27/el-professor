/*
  A monthly plan's children are frozen by a lock, not by a stale read.

  app_private.monthly_plan_parent_is_open is the one place the two child guards
  — app_private.monthly_plan_child_guard on public.monthly_plan_blocks and on
  public.monthly_plan_block_trips, and app_private.monthly_plan_driver_guard on
  public.monthly_plan_drivers — ask whether a plan exists, belongs to the row's
  company and is still a draft. It read the plan with no lock, so the answer
  "draft" was already stale when it was given.

  ── THE RACE ────────────────────────────────────────────────────────────────

  public.monthly_plan_confirm takes pg_advisory_xact_lock on the company, year
  and month, reads the plan FOR UPDATE, counts the plan's blocks and re-derives
  requirement section 7's rules over them, and then stamps the plan confirmed.
  All of that is one transaction, and until it commits the plan's committed row
  still says `draft`. So:

      INSERT   session A confirms and holds its transaction open. Session B
               inserts a block; the guard reads the plan with no lock, sees the
               committed `draft`, and allows it. B then waits — not on the
               guard, but on the foreign key check of monthly_plan_blocks
               .plan_id, which takes KEY SHARE on the plan row and so conflicts
               with A's FOR UPDATE. A commits; the key did not move, so B's
               foreign key check passes and the row lands. The confirmed plan
               holds a block the confirmation never saw — in the worst case two
               overlapping blocks of one driver, which is the very thing
               `driver_overlap` was re-derived to refuse.
      DELETE   the mirror, and worse, because a DELETE of a child has no
               foreign key check against the parent to wait on. B's delete is
               allowed by the stale read and commits straight away, so the
               plan is confirmed with fewer blocks than were validated — in the
               worst case none, which is what `plan_empty` exists to prevent.

  Both leave a confirmed plan that disagrees with the certificate the
  confirmation gave it, and the screen reports success in both directions.
  Requirement section 22 says every document's totals come from the same plan;
  this is the hole through which they stopped doing so.

  ── THE LOCK, AND WHY THE OTHER ONE IS WRONG ────────────────────────────────

  The guard now reads the plan FOR KEY SHARE. That is 20261022140000's fix for
  the newer vehicle_day_plans family, which copied this file's shape four weeks
  later and was reviewed before it shipped; the precedent is deliberate and this
  file is the older half catching up.

  FOR KEY SHARE and not FOR UPDATE, and the difference is not a matter of degree:

    · FOR KEY SHARE is exactly the lock a child row's own foreign key check
      already takes on its parent, and it is a SHARED mode. Two sessions writing
      children of one plan both hold it at once and neither waits, so ordinary
      concurrent writing is unchanged. What it does conflict with is FOR UPDATE,
      which is the one thing it has to: confirmation and child write now take
      turns in either order, and whichever comes second sees what the first did.
      A write that arrives second is refused as `monthly_plan_is_final`; a
      confirmation that arrives second validates the rows as they really are.
    · FOR UPDATE is exclusive. It conflicts with the KEY SHARE every child
      write's foreign key check takes on the plan, so it would serialise every
      child write of a plan behind every other — and where one transaction's
      foreign key check already holds KEY SHARE on a row that another then asks
      FOR UPDATE on, the two deadlock. That is the measured failure behind
      confirm_salary_cash_payment's standing rule ("a payment's foreign-key
      check holds a key share on the salary, FOR UPDATE conflicts with it, and
      two concurrent payments deadlock"), and the guard fires on every row of a
      bulk write of a month's rides, which is where it would be met.

    It is also strictly more than is needed. The guard has to know only that the
    plan's STATUS cannot move under it, which is to say that no confirmation can
    commit while the write is being judged. FOR KEY SHARE says precisely that
    and nothing else.

  Nothing else about the function moves. A missing plan is still allowed and so
  is a write while the company row is gone: those are the cascade, the condition
  20261016140000 added after a company that had confirmed a monthly plan could
  not be deleted. By the time a cascade reaches a child the parent row is already
  deleted in that transaction, so the locking read finds nothing and the first
  branch returns — the lock is never taken on a row the cascade is removing, and
  the refusal stays in force for every ordinary write.

  ── WHAT IS RESTATED ────────────────────────────────────────────────────────

  The live body is 20261016140000's, not 20260930100000's, and it is carried over
  here character for character apart from the one changed line. The COMMENT is
  restated too — 20261016140000 left 20260930100000's in place, which would have
  left the one date on a function that three migrations have now written. The
  self-check below re-asserts every load-bearing fragment from the catalogue,
  including the ones this file did not touch, and both halves of the pair: the
  guard's FOR KEY SHARE and monthly_plan_confirm's FOR UPDATE, because a KEY
  SHARE that conflicts with nothing freezes nothing.

  tests/rls/monthly-plans-two-sessions.sql drives the two orders, the lock mode,
  and the cascade with two real sessions through dblink. A one-session file
  cannot see any of it: a lock is only shown to work by something waiting on it.
*/

CREATE OR REPLACE FUNCTION app_private.monthly_plan_parent_is_open(p_plan_id uuid, p_company_id uuid)
RETURNS public.monthly_plans
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_plan public.monthly_plans;
BEGIN
  -- 20261023110000: FOR KEY SHARE, which conflicts with the FOR UPDATE
  -- monthly_plan_confirm takes on this row, so a child write and a confirmation
  -- take turns in either order. Read without a lock the answer below was stale
  -- the moment it was given. Not FOR UPDATE: that is the mode a child's own
  -- foreign key check conflicts with, and two concurrent child writes would
  -- deadlock on it.
  SELECT * INTO v_plan FROM public.monthly_plans p WHERE p.id = p_plan_id FOR KEY SHARE;

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

COMMENT ON FUNCTION app_private.monthly_plan_parent_is_open(uuid, uuid) IS
  'The one place the two child guards ask whether a monthly plan exists, belongs '
  'to the row''s company and is still a draft. Reads the plan FOR KEY SHARE, which '
  'conflicts with monthly_plan_confirm''s FOR UPDATE, so a child write and a '
  'confirmation take turns (20261023110000). A missing plan, or a company that no '
  'longer exists, is a cascade and is allowed (20260930100000, 20261016140000).';

-- CREATE OR REPLACE keeps whatever owner the function had; the owner is stated,
-- as 20260930100000 and 20261016140000 both state it.
ALTER FUNCTION app_private.monthly_plan_parent_is_open(uuid, uuid) OWNER TO CURRENT_USER;

-- Fired through the child guards, which are triggers and do not check EXECUTE.
-- The REVOKE is the second wall behind the missing USAGE on app_private, and it
-- names PUBLIC and anon as well: Supabase's default privileges grant EXECUTE on
-- every new function to both, so revoking from authenticated alone leaves it
-- callable (20260911120000's defect).
REVOKE ALL ON FUNCTION app_private.monthly_plan_parent_is_open(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- ─── self-check ─────────────────────────────────────────────────────────────

DO $mig$
DECLARE
  c_sig     CONSTANT text := 'app_private.monthly_plan_parent_is_open(uuid,uuid)';
  c_confirm CONSTANT text := 'public.monthly_plan_confirm(uuid,boolean)';
  v_code    text;
  v_missing text;
  v_role    text;
  v_sig     text;
  v_tbl     text;
BEGIN
  -- Comments are stripped, so every pattern below is matched against code. \s+
  -- and not a literal space between tokens: the blob is LF and the working tree
  -- may be CRLF, and a probe that pins a fragment of a body has aborted the
  -- whole kit over exactly that (.gitattributes, 22.10.2026).
  v_code := app_private.function_code(c_sig);

  -- 1. The lock this migration exists for.
  IF v_code !~ 'FROM\s+public\.monthly_plans\s+p\s+WHERE\s+p\.id\s*=\s*p_plan_id\s+FOR\s+KEY\s+SHARE\s*;' THEN
    RAISE EXCEPTION '20261023110000 self-check 1: % no longer reads the plan FOR KEY SHARE', c_sig;
  END IF;

  -- 2. And it is that mode and no stronger one. FOR UPDATE here would conflict
  --    with the KEY SHARE a child's own foreign key check takes on the plan, so
  --    two concurrent child writes would deadlock; FOR NO KEY UPDATE and FOR
  --    SHARE are likewise not the mode that was reasoned about.
  IF v_code ~ 'FOR\s+UPDATE' OR v_code ~ 'FOR\s+NO\s+KEY\s+UPDATE' OR v_code ~ 'FOR\s+SHARE' THEN
    RAISE EXCEPTION '20261023110000 self-check 2: % takes a lock stronger than FOR KEY SHARE; '
      'a child write''s own foreign key check holds KEY SHARE on the plan and would deadlock against it', c_sig;
  END IF;
  IF (SELECT count(*) FROM regexp_matches(v_code, 'FOR\s+KEY\s+SHARE', 'g')) <> 1 THEN
    RAISE EXCEPTION '20261023110000 self-check 2: % names FOR KEY SHARE % times, expected once', c_sig,
      (SELECT count(*) FROM regexp_matches(v_code, 'FOR\s+KEY\s+SHARE', 'g'));
  END IF;

  -- 3. Every other rule of the body, carried over from 20260930100000 and
  --    20261016140000. A restatement that keeps the lock and loses one of these
  --    is the failure this list is here to make loud.
  SELECT string_agg(f.name, '; ') INTO v_missing
    FROM (VALUES
      ('a missing plan is allowed',               'IF\s+NOT\s+FOUND\s+THEN\s+RETURN\s+v_plan\s*;'),
      ('only while the company exists',           'NOT\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+public\.companies\s+c\s+WHERE\s+c\.id\s*=\s*p_company_id\s*\)'),
      ('the company mismatch',                   'v_plan\.company_id\s+IS\s+DISTINCT\s+FROM\s+p_company_id'),
      ('its hint',                               'monthly_plan_company_mismatch'),
      -- Each umlaut is matched as one or two characters: `.` is a character in
      -- a UTF-8 database and a byte in SQL_ASCII, and the pattern must not
      -- depend on which this database is.
      ('its sentence',                            'Der Monatsplan geh.{1,2}rt zu einem anderen Unternehmen\.'),
      ('a confirmed plan is frozen',             'v_plan\.status\s*<>\s*''draft'''),
      ('its hint',                               'monthly_plan_is_final'),
      ('its sentence',                            'Ein best.{1,2}tigter Monatsplan kann nicht ge.{1,2}ndert werden\.'),
      ('both refusals are P0001',                'P0001'),
      ('the plan row is returned',               'RETURN\s+v_plan\s*;\s*END\s*;')
    ) AS f(name, pattern)
   WHERE v_code !~ f.pattern;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION '20261023110000 self-check 3: % lost a rule of the body it restates: %', c_sig, v_missing;
  END IF;

  -- 4. The app_private shape: SECURITY DEFINER, plpgsql, a pinned search_path,
  --    and no EXECUTE for any role the API authenticates as.
  IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = c_sig::regprocedure) THEN
    RAISE EXCEPTION '20261023110000 self-check 4: % is no longer SECURITY DEFINER', c_sig;
  END IF;
  IF (SELECT l.lanname FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
       WHERE p.oid = c_sig::regprocedure) <> 'plpgsql' THEN
    RAISE EXCEPTION '20261023110000 self-check 4: % is no longer LANGUAGE plpgsql', c_sig;
  END IF;
  -- `LIKE 'search_path=%'` is 20260915100100's idiom; the second half is this
  -- schema's own rule, that the pinned path begins at pg_catalog.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proconfig) AS c(setting)
                  WHERE p.oid = c_sig::regprocedure
                    AND c.setting LIKE 'search_path=%' AND c.setting LIKE '%pg_catalog%') THEN
    RAISE EXCEPTION '20261023110000 self-check 4: % has no pinned search_path naming pg_catalog', c_sig;
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_function_privilege(v_role, c_sig::regprocedure::oid, 'EXECUTE') THEN
      RAISE EXCEPTION '20261023110000 self-check 4: % may execute %', v_role, c_sig;
    END IF;
  END LOOP;
  -- The owner must be able to reach app_private, or the SECURITY DEFINER read
  -- above cannot run at all (20261021120000's idiom).
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
                  WHERE p.oid = c_sig::regprocedure
                    AND (r.rolsuper OR r.oid = (SELECT nspowner FROM pg_namespace WHERE nspname = 'app_private'))) THEN
    RAISE EXCEPTION '20261023110000 self-check 4: the owner of % can reach no app_private helper', c_sig;
  END IF;

  -- 5. The other half of the pair. A KEY SHARE that conflicts with nothing
  --    freezes nothing, so the confirmation must still read the plan FOR UPDATE
  --    and must still take the advisory lock on the month before it looks.
  v_code := app_private.function_code(c_confirm);
  IF v_code !~ 'FROM\s+public\.monthly_plans\s+p\s+WHERE\s+p\.id\s*=\s*p_plan_id\s+FOR\s+UPDATE\s*;' THEN
    RAISE EXCEPTION '20261023110000 self-check 5: % no longer reads the plan FOR UPDATE, so the child guard''s '
      'FOR KEY SHARE conflicts with nothing', c_confirm;
  END IF;
  IF v_code !~ 'pg_advisory_xact_lock' THEN
    RAISE EXCEPTION '20261023110000 self-check 5: % no longer takes the advisory lock on the month', c_confirm;
  END IF;
  IF v_code !~ 'monthly_plan_blocks\s+b\s+WHERE\s+b\.plan_id\s*=\s*p_plan_id' THEN
    RAISE EXCEPTION '20261023110000 self-check 5: % no longer counts the plan''s blocks, which is what the '
      'lock is protecting', c_confirm;
  END IF;

  -- 6. The lock only reaches the three child tables through their guards, so
  --    both guards must still call the helper and all three triggers must still
  --    be wired to the guard that does.
  FOREACH v_sig IN ARRAY ARRAY['app_private.monthly_plan_child_guard()',
                               'app_private.monthly_plan_driver_guard()'] LOOP
    IF app_private.function_code(v_sig) !~ 'app_private\.monthly_plan_parent_is_open\(' THEN
      RAISE EXCEPTION '20261023110000 self-check 6: % no longer asks monthly_plan_parent_is_open, so its table '
        'is written against an unlocked plan', v_sig;
    END IF;
  END LOOP;
  FOREACH v_tbl IN ARRAY ARRAY['monthly_plan_blocks', 'monthly_plan_block_trips', 'monthly_plan_drivers'] LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM pg_trigger g
        JOIN pg_proc p ON p.oid = g.tgfoid
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE g.tgrelid = format('public.%I', v_tbl)::regclass
         AND NOT g.tgisinternal
         AND n.nspname = 'app_private'
         AND p.proname IN ('monthly_plan_child_guard', 'monthly_plan_driver_guard')
         -- TRIGGER_TYPE_ROW is bit 0 and TRIGGER_TYPE_BEFORE bit 1: the guard
         -- has to run per row and before the write, or it judges nothing.
         AND (g.tgtype & 1) = 1 AND (g.tgtype & 2) = 2) THEN
      RAISE EXCEPTION '20261023110000 self-check 6: public.% carries no BEFORE row trigger calling a guard that '
        'locks the plan', v_tbl;
    END IF;
  END LOOP;

  RAISE NOTICE '20261023110000 self-check: passed';
END $mig$;
