/*
  Plan 3.F step U1: one subscription model — the coverage table, the recompute,
  and the backfill that filled it without changing anybody's access.

  Runs after the migrations and the seeds, as supabase_admin, in one transaction
  that is rolled back at the end, so the files after it see the database as the
  seeds left it.

  What is covered, in order:

    1. the recompute   its five branches, each against coverage rows written by
                       hand: open-ended, running, passed, recorded-but-never-
                       granting, and nothing at all
    2. the backfill    one company in each of seven of U0's conflict classes,
                       and the rule the migration exists to keep: the server's
                       own answer — `get_active_company_id()`, called as each
                       company's administrator — is the same before and after.
                       The two retired CHECK values are dropped for the seeding
                       and put back afterwards, so the constraint itself has to
                       accept what the backfill left behind
    3. suspension      outranks coverage: a company with open-ended, granting
                       coverage is refused while companies.status says
                       suspended, and comes back when that one column is reset
                       — which is the hole rule 3 closes, because before U1 a
                       suspension could sit in one of two other columns that
                       `reactivate` never touched
    4. activation      a redeemed code extends the coverage and the company's
                       expiry follows; a suspended company's administrator may
                       still redeem, and it no longer un-suspends the company
                       (the hole at 20260916130020:430); an open-ended company
                       keeps its open end (rule 1)
    5. invoices        paying one changes nothing in U1 (rule 5), and the
                       mechanism that will extend in U2 is the same
                       `subscription_coverage_record` a manual grant uses
    6. two at once     two periods recorded at the same instant leave the later
                       end standing, and a second row for the same source is
                       refused by the unique index rather than counted twice
    7. the shape       one SELECT policy, no write policy, no write grant, a
                       member reads its own company only, a coverage row cannot
                       be re-pointed at another company

  The companies here are created inside this file rather than in seed.sql for
  the same reason tenant-state.sql creates its own: they exist to be refused,
  and every one of them would otherwise widen what the other test files see.
*/

\set ON_ERROR_STOP on

BEGIN;

-- ─── helpers ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION _sub_ok(p_desc text, p_ok boolean) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  -- NULL is a failure: a check that could not be evaluated proved nothing.
  IF p_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: %', p_desc;
  END IF;
  RAISE NOTICE 'ok  %', p_desc;
END $$;

CREATE OR REPLACE FUNCTION _sub_reset() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'SET LOCAL ROLE NONE';
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claim.amr', '', true);
END $$;

/** Become a signed-in user, or anon when p_user is NULL. */
CREATE OR REPLACE FUNCTION _sub_become(p_user uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _sub_reset();
  IF p_user IS NULL THEN
    PERFORM set_config('request.jwt.claim.role', 'anon', true);
    EXECUTE 'SET LOCAL ROLE anon';
  ELSE
    PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    -- A password sign-in: since 20260919130000 a platform capability needs one.
    PERFORM set_config('request.jwt.claim.amr', '[{"method": "password", "timestamp": 1789416052}]', true);
    EXECUTE 'SET LOCAL ROLE authenticated';
  END IF;
END $$;

/** Fixed, readable-by-construction ids, as in matrix.sql and tenant-state.sql. */
CREATE OR REPLACE FUNCTION _sub_id(p_what text) RETURNS uuid
LANGUAGE sql IMMUTABLE AS $$ SELECT md5('sub:' || p_what)::uuid $$;

/*
  The gate, asked of the server and not of a transcription: become the account
  and read public.get_active_company_id(). That is what every business policy
  and every planning RPC asks, so "access changed" means exactly this answer
  changed.
*/
CREATE OR REPLACE FUNCTION _sub_admitted(p_user uuid) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE v_co uuid;
BEGIN
  PERFORM _sub_become(p_user);
  SELECT public.get_active_company_id() INTO v_co;
  PERFORM _sub_reset();
  RETURN v_co IS NOT NULL;
END $$;

/*
  Run p_sql as p_user **in a subtransaction that is always rolled back**, and
  answer the scalar it returned, `rows N` for a statement without a result, or
  `ERR <sqlstate> <message>`.

  The rollback is the point and it is not incidental: a block with an EXCEPTION
  clause is a subtransaction, so raising ZZ006 on the success path and catching
  it undoes everything the statement did. That is what makes this safe to point
  at a write — the probe leaves nothing behind — and it is why `_ts_try` in
  tenant-state.sql and `_pr_try` in platform-rpcs.sql are written the same way.

  **So it cannot be used for a write whose effect is then asserted.** Use
  `_sub_do` below for that. Getting this wrong does not look like a bug: the
  statement runs, the RPC answers `success: true`, and the answer survives
  because it is a value and not a row — only the assertion that reads the table
  afterwards fails, one line later.
*/
CREATE OR REPLACE FUNCTION _sub_try(p_user uuid, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out   text;
  v_rows  bigint;
  v_state text;
  v_msg   text;
BEGIN
  BEGIN
    PERFORM _sub_become(p_user);
    IF p_sql ~* '^\s*(select|with)' THEN
      EXECUTE p_sql INTO v_out;
      v_out := coalesce(v_out, '<null>');
    ELSE
      EXECUTE p_sql;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      v_out := 'rows ' || v_rows;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'ZZ006', MESSAGE = v_out;
  EXCEPTION
    WHEN SQLSTATE 'ZZ006' THEN
      v_out := SQLERRM;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
      v_out := 'ERR ' || v_state || ' ' || v_msg;
  END;
  PERFORM _sub_reset();
  RETURN v_out;
END $$;

/** Like _sub_try, but keeps what the statement did — as `_pr_do` does. */
CREATE OR REPLACE FUNCTION _sub_do(p_user uuid, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out   text;
  v_state text;
  v_msg   text;
BEGIN
  BEGIN
    PERFORM _sub_become(p_user);
    EXECUTE p_sql INTO v_out;
    v_out := coalesce(v_out, '<null>');
  EXCEPTION WHEN OTHERS THEN
    -- Only a statement that actually failed reaches here, and its own effects
    -- are the only thing this rolls back.
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    v_out := 'ERR ' || v_state || ' ' || v_msg;
  END;
  PERFORM _sub_reset();
  RETURN v_out;
END $$;

/** Did an RPC that answers jsonb/json say so? False for anything that is not one. */
CREATE OR REPLACE FUNCTION _sub_succeeded(p_out text) RETURNS boolean
LANGUAGE plpgsql AS $$
BEGIN
  RETURN (p_out::jsonb ->> 'success') = 'true';
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END $$;

/** The SQLSTATE a statement raises, or 'none'. Run as the owner. */
CREATE OR REPLACE FUNCTION _sub_raises(p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    RETURN SQLSTATE;
  END;
  RETURN 'none';
END $$;

/**
  A company with its own administrator, a settings row and a driver, so a probe
  has a real target. Answers the company id; the administrator is
  _sub_id('user:' || p_slug).
*/
CREATE OR REPLACE FUNCTION _sub_company(
  p_slug        text,
  p_approval    text,
  p_status      text,
  p_sub_status  text,
  p_started_at  timestamptz DEFAULT NULL,
  p_expires_at  timestamptz DEFAULT NULL,
  p_approved_at timestamptz DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_co   uuid := _sub_id('company:' || p_slug);
  v_user uuid := _sub_id('user:' || p_slug);
BEGIN
  INSERT INTO companies (id, name, slug, approval_status, status, plan,
                         subscription_status, subscription_started_at, subscription_expires_at,
                         approved_at)
  VALUES (v_co, 'SUB ' || p_slug, 'sub-' || p_slug, p_approval, p_status, 'basic',
          p_sub_status, p_started_at, p_expires_at, p_approved_at);

  INSERT INTO company_settings (company_id, company_name) VALUES (v_co, 'SUB ' || p_slug);

  INSERT INTO auth.users (id, email) VALUES (v_user, 'sub-' || p_slug || '@test.invalid');

  INSERT INTO user_profiles (user_id, email, full_name, role, role_id, company_id,
                             is_super_admin, status, must_change_password)
  VALUES (v_user, 'sub-' || p_slug || '@test.invalid', 'SUB ' || p_slug, 'admin',
          (SELECT id FROM roles WHERE name = 'admin' AND company_id IS NULL LIMIT 1),
          v_co, false, 'active', false);

  RETURN v_co;
END $$;

-- ─── 1. the recompute: its five branches ────────────────────────────────────
--
-- Coverage rows are written straight into the table as the owner, so this
-- section tests the derivation and nothing else. Every company starts
-- ('inactive', NULL) — the fifth branch — and moves as rows are added.

DO $$
DECLARE
  v_co     uuid;
  v_status text;
  v_exp    timestamptz;
  v_far    timestamptz := now() + interval '30 days';
  v_past   timestamptz := now() - interval '1 day';
BEGIN
  -- 1e. no coverage at all
  v_co := _sub_company('rc-none', 'approved', 'active', 'active', now(), v_far);
  PERFORM app_private.recompute_company_subscription(v_co);
  SELECT subscription_status, subscription_expires_at INTO v_status, v_exp FROM companies WHERE id = v_co;
  PERFORM _sub_ok('recompute: no coverage at all answers inactive with no expiry',
    v_status = 'inactive' AND v_exp IS NULL);

  -- 1a. a granting row with no end (rule 1)
  v_co := _sub_company('rc-open', 'approved', 'active', 'inactive');
  INSERT INTO subscription_coverage (company_id, source, period_start, period_end)
  VALUES (v_co, 'migration', now() - interval '1 year', NULL);
  PERFORM app_private.recompute_company_subscription(v_co);
  SELECT subscription_status, subscription_expires_at INTO v_status, v_exp FROM companies WHERE id = v_co;
  PERFORM _sub_ok('recompute: an open-ended grant answers active with no expiry, and no expiry is invented',
    v_status = 'active' AND v_exp IS NULL);

  -- …and it outranks a bounded row, whichever way round they are written
  INSERT INTO subscription_coverage (company_id, source, period_start, period_end)
  VALUES (v_co, 'manual', now() - interval '10 days', v_far);
  PERFORM app_private.recompute_company_subscription(v_co);
  SELECT subscription_status, subscription_expires_at INTO v_status, v_exp FROM companies WHERE id = v_co;
  PERFORM _sub_ok('recompute: a bounded grant beside an open-ended one leaves the open end standing',
    v_status = 'active' AND v_exp IS NULL);

  -- 1b. the newest granting end is ahead
  v_co := _sub_company('rc-running', 'approved', 'active', 'inactive');
  INSERT INTO subscription_coverage (company_id, source, period_start, period_end)
  VALUES (v_co, 'migration', now() - interval '1 year', now() + interval '1 day'),
         (v_co, 'manual',    now() + interval '1 day',  v_far);
  PERFORM app_private.recompute_company_subscription(v_co);
  SELECT subscription_status, subscription_expires_at INTO v_status, v_exp FROM companies WHERE id = v_co;
  PERFORM _sub_ok('recompute: two grants answer active at the later end',
    v_status = 'active' AND v_exp = v_far);

  -- 1c. every granting row has passed (rule 2)
  v_co := _sub_company('rc-passed', 'approved', 'active', 'active', now() - interval '1 year', v_past);
  INSERT INTO subscription_coverage (company_id, source, period_start, period_end)
  VALUES (v_co, 'migration', now() - interval '1 year', v_past);
  PERFORM app_private.recompute_company_subscription(v_co);
  SELECT subscription_status, subscription_expires_at INTO v_status, v_exp FROM companies WHERE id = v_co;
  PERFORM _sub_ok('recompute: a grant that has passed answers expired and keeps its date (rule 2)',
    v_status = 'expired' AND v_exp = v_past);

  -- 1d. recorded, never granting — U0 class 06 carried across unchanged
  v_co := _sub_company('rc-recorded', 'approved', 'active', 'inactive', now(), v_far);
  INSERT INTO subscription_coverage (company_id, source, period_start, period_end, grants_access)
  VALUES (v_co, 'migration', now(), v_far, false);
  PERFORM app_private.recompute_company_subscription(v_co);
  SELECT subscription_status, subscription_expires_at INTO v_status, v_exp FROM companies WHERE id = v_co;
  PERFORM _sub_ok('recompute: a recorded period that grants nothing answers inactive and still shows its date',
    v_status = 'inactive' AND v_exp = v_far);

  -- …and a voided row counts for nothing at all
  v_co := _sub_company('rc-void', 'approved', 'active', 'active', now(), v_far);
  INSERT INTO subscription_coverage (company_id, source, period_start, period_end, status, void_reason)
  VALUES (v_co, 'migration', now(), v_far, 'void', 'replaced');
  PERFORM app_private.recompute_company_subscription(v_co);
  SELECT subscription_status, subscription_expires_at INTO v_status, v_exp FROM companies WHERE id = v_co;
  PERFORM _sub_ok('recompute: a voided period neither grants nor is shown',
    v_status = 'inactive' AND v_exp IS NULL);

  -- the plan travels with the period, and a company with no coverage keeps its own
  PERFORM _sub_ok('recompute: a company with no coverage keeps the plan it already had',
    (SELECT plan FROM companies WHERE id = _sub_id('company:rc-none')) = 'basic');

  UPDATE subscription_coverage SET plan = 'premium'
   WHERE company_id = _sub_id('company:rc-running') AND period_end = v_far;
  PERFORM app_private.recompute_company_subscription(_sub_id('company:rc-running'));
  PERFORM _sub_ok('recompute: the plan of the period that decided is written onto the company',
    (SELECT plan FROM companies WHERE id = _sub_id('company:rc-running')) = 'premium');

  -- a broken argument contract raises, it does not answer
  PERFORM _sub_ok('recompute: a NULL company id raises 22023 rather than answering',
    _sub_raises('SELECT app_private.recompute_company_subscription(NULL)') = '22023');
END $$;

-- ─── 2. the backfill: seven conflict classes, and access unchanged ──────────
--
-- The two CHECK constraints 20260919150000 narrowed are dropped for the seeding
-- and added back at the end of this section. That is not a convenience: rows
-- carrying the retired values are exactly what the backfill was written for,
-- and re-adding the constraint afterwards is what proves it left none behind.

ALTER TABLE companies DROP CONSTRAINT companies_approval_status_check;
ALTER TABLE companies DROP CONSTRAINT companies_subscription_status_check;

CREATE TEMP TABLE _sub_class (
  slug text, class text, label text,
  approval text, status text, sub_status text,
  started_at timestamptz, expires_at timestamptz, approved_at timestamptz,
  admitted_today boolean
);

INSERT INTO _sub_class VALUES
  -- U0 04: active with no expiry. Rule 1 — it stays open and gets no expiry.
  ('c04', '04_active_without_expiry', 'active, no expiry',
   'approved', 'active', 'active', now() - interval '1 year', NULL, now() - interval '1 year', true),
  -- U0 05: active past its expiry. Rule 2 — the word is corrected, the date kept.
  ('c05', '05_active_past_expiry', 'active past its expiry',
   'approved', 'active', 'active', now() - interval '1 year', now() - interval '1 day', now() - interval '1 year', false),
  -- U0 06: blocked while an expiry in the future covers today.
  ('c06', '06_access_blocked_but_covered', 'inactive with a future expiry',
   'approved', 'active', 'inactive', now() - interval '10 days', now() + interval '30 days', now() - interval '1 year', false),
  -- U0 10: a redeemed code with no recorded period. Rule 6 — nothing is guessed.
  ('c10', '10_redemption_without_effect', 'a used code whose applied period was never written',
   'approved', 'active', 'inactive', NULL, NULL, now() - interval '1 year', false),
  -- U0 13: the three suspension flags disagree — here only subscription_status.
  ('c13', '13_suspension_flags_disagree', 'suspended through subscription_status alone',
   'approved', 'active', 'suspended', now() - interval '10 days', now() + interval '30 days', now() - interval '1 year', false),
  -- U0 14: suspended at the approval step while the subscription is live.
  ('c14', '14_suspended_with_active_subscription', 'approval suspended, subscription active',
   'suspended', 'active', 'active', now() - interval '10 days', now() + interval '30 days', now() - interval '1 year', false),
  -- U0 15: a period that starts after it ends.
  ('c15', '15_periods_out_of_order', 'a period recorded backwards',
   'approved', 'active', 'active', now() + interval '10 days', now() + interval '5 days', now() - interval '1 year', true);

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM _sub_class ORDER BY slug LOOP
    PERFORM _sub_company(r.slug, r.approval, r.status, r.sub_status,
                         r.started_at, r.expires_at, r.approved_at);
  END LOOP;

  -- class 10 needs its code: used, and with no applied period at all.
  INSERT INTO activation_codes (id, code_hash, duration_type, expires_at, created_by,
                                company_id, status, used_at, used_by, used_company_id)
  VALUES (_sub_id('code:c10'), encode(sha256(convert_to('sub-c10', 'UTF8')), 'hex'),
          '1_monat', now() - interval '1 day', _sub_id('user:c10'),
          _sub_id('company:c10'), 'used', now() - interval '20 days',
          _sub_id('user:c10'), _sub_id('company:c10'));
END $$;

/*
  Before: the server's own answer for each company's administrator.

  Filled row by row from a loop rather than by `CREATE TABLE … AS SELECT`:
  _sub_admitted() switches the session role to `authenticated` and back, and a
  role change half way through a statement that is also writing a table is a
  question nobody should have to ask. Out here each call has returned, and the
  role is NONE again, before the INSERT runs.
*/
CREATE TEMP TABLE _sub_before (slug text, admitted boolean);
CREATE TEMP TABLE _sub_after  (slug text, admitted boolean);

DO $$
DECLARE
  r   record;
  v_a boolean;
BEGIN
  FOR r IN SELECT slug FROM _sub_class ORDER BY slug LOOP
    v_a := _sub_admitted(_sub_id('user:' || r.slug));
    INSERT INTO _sub_before VALUES (r.slug, v_a);
  END LOOP;
END $$;

-- The gate must agree with what the classes claim, or the classes are wrong and
-- nothing after this means anything.
DO $$
DECLARE v_wrong text;
BEGIN
  SELECT string_agg(format('%s (expected %s, got %s)', c.slug, c.admitted_today, b.admitted), ', ' ORDER BY c.slug)
    INTO v_wrong
    FROM _sub_class c JOIN _sub_before b USING (slug)
   WHERE c.admitted_today IS DISTINCT FROM b.admitted;
  PERFORM _sub_ok('backfill: the seven classes are seeded in the state they claim'
                  || coalesce(' — ' || v_wrong, ''),
    v_wrong IS NULL);
END $$;

-- …and then the backfill, one company at a time, through the rule itself.
DO $$
DECLARE
  r      record;
  v_did  text;
  v_seen text := '';
BEGIN
  FOR r IN SELECT slug FROM _sub_class ORDER BY slug LOOP
    v_did := app_private.subscription_backfill_company(_sub_id('company:' || r.slug));
    v_seen := v_seen || r.slug || '=' || v_did || ' ';
  END LOOP;
  RAISE NOTICE 'backfill: %', v_seen;
END $$;

DO $$
DECLARE
  r   record;
  v_a boolean;
BEGIN
  FOR r IN SELECT slug FROM _sub_class ORDER BY slug LOOP
    v_a := _sub_admitted(_sub_id('user:' || r.slug));
    INSERT INTO _sub_after VALUES (r.slug, v_a);
  END LOOP;
END $$;

DO $$
DECLARE
  v_wrong text;
  v_n     bigint;
  v_rows  bigint;
BEGIN
  -- The gate. Both directions are failures: taking access away is the obvious
  -- one, handing it out is the one a backfill invents.
  SELECT string_agg(format('%s (%s → %s)', b.slug, b.admitted, a.admitted), ', ' ORDER BY b.slug)
    INTO v_wrong
    FROM _sub_before b JOIN _sub_after a USING (slug)
   WHERE b.admitted IS DISTINCT FROM a.admitted;
  PERFORM _sub_ok('backfill: no company''s access changed' || coalesce(' — ' || v_wrong, ''),
    v_wrong IS NULL);

  -- …and the buckets account for every class, so a NULL cannot slip through
  -- unmeasured (the trap scripts/active-company-parity.sql describes).
  SELECT count(*) INTO v_rows FROM _sub_class;
  SELECT count(*) FILTER (WHERE b.admitted AND a.admitted)
       + count(*) FILTER (WHERE NOT b.admitted AND NOT a.admitted)
       + count(*) FILTER (WHERE b.admitted AND NOT a.admitted)
       + count(*) FILTER (WHERE NOT b.admitted AND a.admitted)
    INTO v_n
    FROM _sub_before b JOIN _sub_after a USING (slug);
  PERFORM _sub_ok('backfill: the four buckets account for all seven classes', v_n = v_rows);

  -- Rule 1: nobody was given an expiry they did not have, and c04 keeps none.
  PERFORM _sub_ok('backfill 04: a company active with no expiry keeps no expiry, and its coverage is open-ended (rule 1)',
    (SELECT subscription_status = 'active' AND subscription_expires_at IS NULL
       FROM companies WHERE id = _sub_id('company:c04'))
    AND EXISTS (SELECT 1 FROM subscription_coverage
                 WHERE company_id = _sub_id('company:c04')
                   AND source = 'migration' AND status = 'active' AND grants_access
                   AND period_end IS NULL));

  -- Rule 2: the word is corrected, the date is not touched.
  PERFORM _sub_ok('backfill 05: active past its expiry is written expired, with the same date (rule 2)',
    (SELECT subscription_status = 'expired'
            AND subscription_expires_at = (SELECT expires_at FROM _sub_class WHERE slug = 'c05')
       FROM companies WHERE id = _sub_id('company:c05')));

  -- Class 06: recorded, still refused, and the date still on screen.
  PERFORM _sub_ok('backfill 06: a future expiry that granted nothing goes on granting nothing, and is still shown',
    (SELECT subscription_status = 'inactive'
            AND subscription_expires_at = (SELECT expires_at FROM _sub_class WHERE slug = 'c06')
       FROM companies WHERE id = _sub_id('company:c06'))
    AND EXISTS (SELECT 1 FROM subscription_coverage
                 WHERE company_id = _sub_id('company:c06') AND NOT grants_access));

  -- Rule 6: no period is reconstructed for a code that never recorded one.
  PERFORM _sub_ok('backfill 10: a used code with no recorded period gets no coverage row (rule 6)',
    NOT EXISTS (SELECT 1 FROM subscription_coverage
                 WHERE company_id = _sub_id('company:c10'))
    AND (SELECT subscription_status = 'inactive' AND subscription_expires_at IS NULL
           FROM companies WHERE id = _sub_id('company:c10')));

  -- Rule 3, both shapes of it.
  PERFORM _sub_ok('backfill 13: a suspension carried by subscription_status alone moves onto companies.status (rule 3)',
    (SELECT status = 'suspended' AND subscription_status <> 'suspended'
       FROM companies WHERE id = _sub_id('company:c13')));
  PERFORM _sub_ok('backfill 14: a suspension carried by approval_status moves too, and the approval it had is kept',
    (SELECT status = 'suspended' AND approval_status = 'approved'
       FROM companies WHERE id = _sub_id('company:c14')));

  -- Class 15: the end is what the gate reads, so the start is clamped to it and
  -- the row says so.
  PERFORM _sub_ok('backfill 15: a period recorded backwards is stored forwards, with its end untouched',
    (SELECT period_start <= period_end AND period_end = (SELECT expires_at FROM _sub_class WHERE slug = 'c15')
       FROM subscription_coverage WHERE company_id = _sub_id('company:c15') AND source = 'migration'));

  -- Idempotent: running it again writes nothing and moves nothing.
  SELECT count(*) INTO v_rows FROM subscription_coverage;
  PERFORM app_private.subscription_backfill_company(_sub_id('company:c04'));
  PERFORM app_private.subscription_backfill_company(_sub_id('company:c06'));
  SELECT count(*) INTO v_n FROM subscription_coverage;
  PERFORM _sub_ok('backfill: running it a second time writes no new coverage row', v_n = v_rows);

  -- A company that is not there is answered, not raised on.
  PERFORM _sub_ok('backfill: an unknown company answers not_found',
    app_private.subscription_backfill_company(_sub_id('company:nowhere')) = 'not_found');
END $$;

-- The constraints go back on. They validate every existing row, so this
-- statement succeeds only if the backfill removed every retired value — which
-- is the assertion, not the cleanup.
ALTER TABLE companies ADD CONSTRAINT companies_approval_status_check
  CHECK (approval_status = ANY (ARRAY['pending', 'approved', 'rejected']));
ALTER TABLE companies ADD CONSTRAINT companies_subscription_status_check
  CHECK (subscription_status = ANY (ARRAY['inactive', 'active', 'expired']));

DO $$ BEGIN
  PERFORM _sub_ok('backfill: the narrowed CHECK constraints accept every row the backfill left', true);
END $$;

-- The two values tenant-state.sql and matrix.sql no longer carry. This is where
-- their absence is asserted, because a row those files cannot insert is not a
-- state and not a matrix cell.
DO $$
BEGIN
  PERFORM _sub_ok('rule 3: approval_status = ''suspended'' is refused by the constraint',
    _sub_raises(format($q$UPDATE companies SET approval_status = 'suspended' WHERE id = %L$q$,
                       _sub_id('company:c04'))) = '23514');
  PERFORM _sub_ok('rule 3: subscription_status = ''suspended'' is refused by the constraint',
    _sub_raises(format($q$UPDATE companies SET subscription_status = 'suspended' WHERE id = %L$q$,
                       _sub_id('company:c04'))) = '23514');
  PERFORM _sub_ok('rule 3: …and companies.status still accepts it, or suspension would have nowhere to live',
    _sub_raises(format($q$UPDATE companies SET status = 'suspended' WHERE id = %L$q$,
                       _sub_id('company:rc-none'))) = 'none');
END $$;

-- ─── 3. a suspension outranks coverage ──────────────────────────────────────

DO $$
DECLARE v_co uuid := _sub_id('company:c04');
BEGIN
  PERFORM _sub_ok('suspension: the open-ended company is admitted while it is not suspended',
    _sub_admitted(_sub_id('user:c04')));

  UPDATE companies SET status = 'suspended' WHERE id = v_co;
  PERFORM _sub_ok('suspension: companies.status outranks open-ended, granting coverage',
    NOT _sub_admitted(_sub_id('user:c04'))
    AND (SELECT subscription_status FROM companies WHERE id = v_co) = 'active');

  -- A recompute in the middle of a suspension must not lift it: it writes the
  -- three derived columns and never companies.status.
  PERFORM app_private.recompute_company_subscription(v_co);
  PERFORM _sub_ok('suspension: a recompute does not lift it',
    (SELECT status FROM companies WHERE id = v_co) = 'suspended'
    AND NOT _sub_admitted(_sub_id('user:c04')));

  -- …and resetting that one column is now enough to bring the company back.
  -- Before U1 the suspension could sit in one of two other columns that
  -- platform_company_lifecycle('reactivate') never touched, and the company
  -- stayed locked with nothing on screen explaining why.
  UPDATE companies SET status = 'active' WHERE id = v_co;
  PERFORM _sub_ok('suspension: resetting companies.status alone brings the company back (rule 3)',
    _sub_admitted(_sub_id('user:c04')));
END $$;

-- ─── 4. an activation code extends ──────────────────────────────────────────

--
-- Every redemption here goes through `_sub_do`, never `_sub_try`: the effect is
-- what is asserted, and `_sub_try` rolls its subtransaction back.

DO $$
DECLARE
  v_bounded uuid;
  v_open    uuid;
  v_susp    uuid;
  v_end     timestamptz := now() + interval '10 days';
  v_out     text;
  v_exp     timestamptz;
  v_cov_end timestamptz;
BEGIN
  -- a company whose coverage runs out in ten days
  v_bounded := _sub_company('code-bounded', 'approved', 'active', 'active', now(), v_end,
                            now() - interval '1 year');
  PERFORM app_private.subscription_backfill_company(v_bounded);

  INSERT INTO activation_codes (id, code_hash, duration_type, expires_at, created_by, company_id)
  VALUES (_sub_id('code:bounded'), encode(sha256(convert_to('300111', 'UTF8')), 'hex'),
          '1_monat', now() + interval '7 days', _sub_id('user:code-bounded'), v_bounded);

  v_out := _sub_do(_sub_id('user:code-bounded'), 'SELECT redeem_activation_code(''300111'')::text');
  SELECT subscription_expires_at INTO v_exp FROM companies WHERE id = v_bounded;
  SELECT period_end INTO v_cov_end
    FROM subscription_coverage
   WHERE company_id = v_bounded AND source = 'activation_code'
     AND source_id = _sub_id('code:bounded') AND status = 'active' AND grants_access;

  PERFORM _sub_ok('activation: redeeming succeeds and extends from the running expiry',
    _sub_succeeded(v_out));
  PERFORM _sub_ok('activation: the period is recorded as coverage, against the code that granted it',
    v_cov_end = v_end + interval '1 month');
  /*
    The property the whole slice exists for, stated as one comparison: the
    company's expiry and the coverage row's end are the same instant, because
    one of them is derived from the other. Two places deciding one fact is the
    defect this would catch, so the values are printed either way.
  */
  PERFORM _sub_ok(format('activation: the company''s expiry IS the code''s period end (old %s, coverage end %s, company %s)',
                         v_end, v_cov_end, v_exp),
    v_exp = v_cov_end AND v_exp = v_end + interval '1 month');

  -- rule 1: an open-ended company keeps its open end. Before U1 a redemption
  -- overwrote it with now() + one month, which took open-ended access away from
  -- a company that had it.
  v_open := _sub_company('code-open', 'approved', 'active', 'active', now() - interval '1 year', NULL,
                         now() - interval '1 year');
  PERFORM app_private.subscription_backfill_company(v_open);
  INSERT INTO activation_codes (id, code_hash, duration_type, expires_at, created_by, company_id)
  VALUES (_sub_id('code:open'), encode(sha256(convert_to('300222', 'UTF8')), 'hex'),
          '1_monat', now() + interval '7 days', _sub_id('user:code-open'), v_open);

  v_out := _sub_do(_sub_id('user:code-open'), 'SELECT redeem_activation_code(''300222'')::text');
  SELECT subscription_expires_at INTO v_exp FROM companies WHERE id = v_open;
  PERFORM _sub_ok(format('activation: an open-ended company keeps its open end (rule 1) — answered %s, company expiry %s',
                         _sub_succeeded(v_out), coalesce(v_exp::text, 'open')),
    _sub_succeeded(v_out)
    AND v_exp IS NULL
    AND (SELECT subscription_status FROM companies WHERE id = v_open) = 'active'
    -- …and the code's own bounded period really was recorded, so the open end
    -- stands because an open-ended row outranks it and not because nothing
    -- was written.
    AND EXISTS (SELECT 1 FROM subscription_coverage
                 WHERE company_id = v_open AND source = 'activation_code'
                   AND source_id = _sub_id('code:open')
                   AND status = 'active' AND grants_access AND period_end IS NOT NULL));

  -- the hole at 20260916130020:430: a redemption used to write
  -- subscription_status = 'active' unconditionally, so a company suspended
  -- through that column let itself back in with any valid code.
  v_susp := _sub_company('code-susp', 'approved', 'suspended', 'active', now(), v_end,
                         now() - interval '1 year');
  PERFORM app_private.subscription_backfill_company(v_susp);
  INSERT INTO activation_codes (id, code_hash, duration_type, expires_at, created_by, company_id)
  VALUES (_sub_id('code:susp'), encode(sha256(convert_to('300333', 'UTF8')), 'hex'),
          '1_monat', now() + interval '7 days', _sub_id('user:code-susp'), v_susp);

  v_out := _sub_do(_sub_id('user:code-susp'), 'SELECT redeem_activation_code(''300333'')::text');
  PERFORM _sub_ok('activation: a suspended company''s administrator is still let in to redeem',
    _sub_succeeded(v_out));
  PERFORM _sub_ok('activation: …and redeeming no longer un-suspends the company (20260916130020:430)',
    (SELECT status FROM companies WHERE id = v_susp) = 'suspended'
    -- the redemption really landed, so the company stays out because of its
    -- status and not because the code was refused
    AND EXISTS (SELECT 1 FROM subscription_coverage
                 WHERE company_id = v_susp AND source = 'activation_code' AND status = 'active')
    AND NOT _sub_admitted(_sub_id('user:code-susp')));
END $$;

-- ─── 5. invoices do not affect access in U1 (rule 5) ────────────────────────

DO $$
DECLARE
  v_co      uuid;
  v_plan    uuid := _sub_id('plan');
  v_sub     uuid := _sub_id('subscription:inv');
  v_invoice uuid := _sub_id('invoice:inv');
  v_before  bigint;
  v_after   bigint;
  v_out     text;
  v_owner   constant uuid := '50000000-0000-4000-8000-000000000001';
BEGIN
  v_co := _sub_company('inv', 'approved', 'active', 'inactive', now() - interval '1 year',
                       now() - interval '1 day', now() - interval '1 year');
  PERFORM app_private.subscription_backfill_company(v_co);

  INSERT INTO subscription_plans (id, name, monthly_price, included_cars)
  VALUES (v_plan, 'SUB plan', 20, 1);
  INSERT INTO company_subscriptions (id, company_id, plan_id, monthly_price)
  VALUES (v_sub, v_co, v_plan, 20);
  INSERT INTO subscription_invoices (id, company_id, subscription_id, invoice_month, invoice_year,
                                     invoice_number, amount, due_date)
  VALUES (v_invoice, v_co, v_sub, 1, 2026, 'INV-2026-SUB1', 20, now()::date);

  PERFORM _sub_ok('invoices: the company is refused before the invoice is paid',
    NOT _sub_admitted(_sub_id('user:inv')));

  -- _sub_do, not _sub_try: if the payment were rolled back, "paying writes no
  -- coverage row" would pass because nothing happened at all.
  SELECT count(*) INTO v_before FROM subscription_coverage WHERE company_id = v_co;
  v_out := _sub_do(v_owner, format('SELECT platform_invoice_mark_paid(%L, %s)::text', v_invoice, 2000));
  SELECT count(*) INTO v_after FROM subscription_coverage WHERE company_id = v_co;

  PERFORM _sub_ok('invoices: an owner still marks one paid', _sub_succeeded(v_out));
  PERFORM _sub_ok('invoices: …and the payment really landed, so the checks below are not vacuous',
    (SELECT status FROM subscription_invoices WHERE id = v_invoice) = 'paid');
  PERFORM _sub_ok('invoices: paying writes no coverage row (rule 5 — that is U2''s)', v_after = v_before);
  PERFORM _sub_ok('invoices: …and the company is still refused',
    NOT _sub_admitted(_sub_id('user:inv')));
  PERFORM _sub_ok('invoices: no coverage row anywhere carries source = invoice in U1',
    NOT EXISTS (SELECT 1 FROM subscription_coverage WHERE source = 'invoice'));

  -- The mechanism U2 will use is the one a manual grant already uses; nothing
  -- about the model is waiting to be built, only the decision about grace days.
  PERFORM app_private.subscription_coverage_record(
    v_co, 'manual', NULL, now(), now() + interval '30 days', true, 'basic', 2000,
    'the U2 shape, exercised here as a manual grant', false);
  PERFORM _sub_ok('invoices: recording a paid period is what admits the company, and it is one call',
    _sub_admitted(_sub_id('user:inv')));
  PERFORM _sub_ok('invoices: …and the money on that period is integer cents (rule 4)',
    (SELECT price_cents FROM subscription_coverage
      WHERE company_id = v_co AND source = 'manual' AND status = 'active') = 2000);
END $$;

-- ─── 6. two periods at the same instant ─────────────────────────────────────
--
-- now() is the transaction's clock, so two records written here carry the same
-- created_at — the deterministic stand-in for two payments arriving together.
-- What this proves is that the answer does not depend on which row was written
-- first; it does not exercise two concurrent sessions, which one psql session
-- cannot.

DO $$
DECLARE
  v_co     uuid;
  v_short  timestamptz := now() + interval '10 days';
  v_long   timestamptz := now() + interval '40 days';
  v_exp    timestamptz;
  v_first  text;
  v_second text;
BEGIN
  v_co := _sub_company('race', 'approved', 'active', 'inactive', NULL, NULL, now() - interval '1 year');

  PERFORM app_private.subscription_coverage_record(v_co, 'manual', NULL, now(), v_long,  true, NULL, 1000, 'long',  false);
  PERFORM app_private.subscription_coverage_record(v_co, 'manual', NULL, now(), v_short, true, NULL, 1000, 'short', false);
  SELECT subscription_expires_at INTO v_exp FROM companies WHERE id = v_co;
  PERFORM _sub_ok('two at once: the later end stands, whichever was written last', v_exp = v_long);

  -- …and the other way round, to show the order is not what decided it
  v_co := _sub_company('race2', 'approved', 'active', 'inactive', NULL, NULL, now() - interval '1 year');
  PERFORM app_private.subscription_coverage_record(v_co, 'manual', NULL, now(), v_short, true, NULL, 1000, 'short', false);
  PERFORM app_private.subscription_coverage_record(v_co, 'manual', NULL, now(), v_long,  true, NULL, 1000, 'long',  false);
  SELECT subscription_expires_at INTO v_exp FROM companies WHERE id = v_co;
  PERFORM _sub_ok('two at once: …and the same answer with the writes reversed', v_exp = v_long);

  -- A second row for the same source is refused, so a double-submitted payment
  -- or a retried redemption is counted once. Two statements, not one `AND`: the
  -- second call only conflicts because the first one landed, and PostgreSQL
  -- does not promise to evaluate the operands of AND left to right.
  v_first := _sub_raises(format($q$SELECT app_private.subscription_coverage_record(%L, 'activation_code', %L, now(), now() + interval '1 month')$q$,
                                v_co, _sub_id('code:bounded')));
  v_second := _sub_raises(format($q$SELECT app_private.subscription_coverage_record(%L, 'activation_code', %L, now(), now() + interval '2 months')$q$,
                                 v_co, _sub_id('code:bounded')));
  PERFORM _sub_ok(format('two at once: a second period for the same source is refused by the unique index (first %s, second %s)',
                         v_first, v_second),
    v_first = 'none' AND v_second = '23505');

  -- p_replace is what a manual edit uses: it withdraws the picture rather than
  -- adding to it, so an older period cannot stay behind as the newest date.
  PERFORM app_private.subscription_coverage_record(v_co, 'manual', NULL, now(), now() + interval '2 days',
                                                   true, NULL, NULL, 'replacing', true);
  SELECT subscription_expires_at INTO v_exp FROM companies WHERE id = v_co;
  PERFORM _sub_ok('two at once: a replacing record leaves its own end standing and voids the rest',
    v_exp = now() + interval '2 days'
    AND (SELECT count(*) FROM subscription_coverage
          WHERE company_id = v_co AND status = 'active') = 1);
END $$;

-- ─── 7. the shape ───────────────────────────────────────────────────────────

DO $$
DECLARE
  v_co_a constant uuid := 'c0000000-0000-4000-8000-00000000000a';
  v_co_b constant uuid := 'c0000000-0000-4000-8000-00000000000b';
  v_row  uuid;
BEGIN
  INSERT INTO subscription_coverage (id, company_id, source, period_start, period_end)
  VALUES (_sub_id('cov:a'), v_co_a, 'manual', now(), now() + interval '30 days'),
         (_sub_id('cov:b'), v_co_b, 'manual', now(), now() + interval '30 days');

  PERFORM _sub_ok('shape: exactly one policy, and it is a SELECT policy',
    (SELECT count(*) FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'subscription_coverage') = 1
    AND (SELECT count(*) FROM pg_policies
          WHERE schemaname = 'public' AND tablename = 'subscription_coverage' AND cmd = 'SELECT') = 1);

  PERFORM _sub_ok('shape: authenticated holds SELECT and nothing else; anon holds nothing',
    has_table_privilege('authenticated', 'public.subscription_coverage', 'SELECT')
    AND NOT has_table_privilege('authenticated', 'public.subscription_coverage', 'INSERT')
    AND NOT has_table_privilege('authenticated', 'public.subscription_coverage', 'UPDATE')
    AND NOT has_table_privilege('authenticated', 'public.subscription_coverage', 'DELETE')
    AND NOT has_table_privilege('anon', 'public.subscription_coverage', 'SELECT')
    AND NOT has_table_privilege('service_role', 'public.subscription_coverage', 'SELECT'));

  PERFORM _sub_ok('shape: a member reads its own company''s coverage',
    _sub_try('a0000000-0000-4000-8000-000000000003',
             format('SELECT count(*) FROM subscription_coverage WHERE id = %L', _sub_id('cov:a'))) = '1');
  PERFORM _sub_ok('shape: …and not another company''s',
    _sub_try('a0000000-0000-4000-8000-000000000003',
             format('SELECT count(*) FROM subscription_coverage WHERE id = %L', _sub_id('cov:b'))) = '0');
  PERFORM _sub_ok('shape: an active platform role reads both, through companies.read',
    _sub_try('50000000-0000-4000-8000-000000000001',
             'SELECT count(*) FROM subscription_coverage WHERE id IN ('
             || quote_literal(_sub_id('cov:a')) || ', ' || quote_literal(_sub_id('cov:b')) || ')') = '2');
  PERFORM _sub_ok('shape: anon reads nothing at all — it holds no grant',
    _sub_try(NULL, format('SELECT count(*) FROM subscription_coverage WHERE id = %L', _sub_id('cov:a')))
      LIKE 'ERR 42501%');

  -- The account shell's predicate, not the active helper: a company whose
  -- coverage ran out is exactly the one whose owner has to read it. c06 is
  -- refused by get_active_company_id() and still reads its own coverage.
  PERFORM _sub_ok('shape: a blocked company still reads its own coverage, which is why the shell helper is the predicate',
    NOT _sub_admitted(_sub_id('user:c06'))
    AND _sub_try(_sub_id('user:c06'),
                 format('SELECT count(*) FROM subscription_coverage WHERE company_id = %L',
                        _sub_id('company:c06'))) = '1');

  -- A coverage row belongs to the company it was raised for.
  PERFORM _sub_ok('shape: a coverage row cannot be re-pointed at another company, not even by the owner',
    _sub_raises(format('UPDATE subscription_coverage SET company_id = %L WHERE id = %L', v_co_b, _sub_id('cov:a')))
      = 'P0001');

  -- The table's own rules.
  PERFORM _sub_ok('shape: a live period that grants nothing must be bounded',
    _sub_raises(format($q$INSERT INTO subscription_coverage (company_id, source, period_start, period_end, grants_access)
                          VALUES (%L, 'manual', now(), NULL, false)$q$, v_co_a)) = '23514');
  PERFORM _sub_ok('shape: a live period runs forwards',
    _sub_raises(format($q$INSERT INTO subscription_coverage (company_id, source, period_start, period_end)
                          VALUES (%L, 'manual', now() + interval '2 days', now())$q$, v_co_a)) = '23514');
  PERFORM _sub_ok('shape: a voided period names why',
    _sub_raises(format($q$INSERT INTO subscription_coverage (company_id, source, period_start, period_end, status)
                          VALUES (%L, 'manual', now(), now() + interval '1 day', 'void')$q$, v_co_a)) = '23514');
  PERFORM _sub_ok('shape: a source outside the five the model names is refused',
    _sub_raises(format($q$INSERT INTO subscription_coverage (company_id, source, period_start, period_end)
                          VALUES (%L, 'goodwill', now(), now() + interval '1 day')$q$, v_co_a)) = '23514');
  PERFORM _sub_ok('shape: money is never negative',
    _sub_raises(format($q$INSERT INTO subscription_coverage (company_id, source, period_start, period_end, price_cents)
                          VALUES (%L, 'manual', now(), now() + interval '1 day', -1)$q$, v_co_a)) = '23514');

  -- app_private stays out of reach: the helpers are called by SECURITY DEFINER
  -- functions and by nobody else.
  PERFORM _sub_ok('shape: no API role may call the recompute or the recorder',
    NOT has_function_privilege('anon',          'app_private.recompute_company_subscription(uuid)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'app_private.recompute_company_subscription(uuid)', 'EXECUTE')
    AND NOT has_function_privilege('service_role',  'app_private.recompute_company_subscription(uuid)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'app_private.subscription_backfill_company(uuid)', 'EXECUTE'));
END $$;

DO $$ BEGIN RAISE NOTICE '── subscriptions (plan 3.F U1): all checks passed ──'; END $$;

ROLLBACK;
