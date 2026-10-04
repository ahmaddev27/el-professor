/*
  Plan 3.F steps U1, U2 and U3: one subscription model — the coverage table, the
  recompute, the backfill that filled it without changing anybody's access, the
  invoice and payment rules that came next, and the wall that keeps every other
  writer off the columns the model derives.

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
   3b. the writers     `platform_company_set_approval('suspend')` writes
                       `companies.status` and leaves the approval alone;
                       `update_company_subscription_manual('suspended')` records
                       a period that grants nothing and does **not** reach
                       `companies.status` — suspending a company is
                       `companies.lifecycle`'s act and that RPC asks
                       `billing.manage`. Both refuse the company afterwards, and
                       the manual one comes back when `Aktiv` is picked again
   3c. early renewal   an upgrade must reach the period that has not started
                       yet, or the daily sweep reads the old tier off it and
                       silently downgrades a paying customer
    4. activation      a redeemed code extends the coverage and the company's
                       expiry follows; a suspended company's administrator may
                       still redeem, and it no longer un-suspends the company
                       (the hole at 20260916130020:430); an open-ended company
                       keeps its open end (rule 1)
    5. invoices        U2. Paying one records the calendar month it names and
                       admits the company; the money on that period is the
                       invoice's own amount in integer cents, not what was
                       handed over. An unpaid one grants until two business days
                       after its due date and no longer, so a Friday due date
                       closes on the Tuesday. Re-opening a paid invoice shrinks
                       its period back to that window without voiding it;
                       cancelling voids it and keeps the invoice. Applying the
                       same invoice twice leaves one row. And an open-ended U1
                       period outranks every invoice, so paying never caps a
                       company that rule 1 carried in with no expiry
    6. two at once     two periods recorded at the same instant leave the later
                       end standing, and a second row for the same source is
                       refused by the unique index rather than counted twice
    7. the shape       one SELECT policy, no write policy, no write grant, a
                       member reads its own company only — and since decision
                       D14 (20260924110000) a platform role with no context reads
                       neither company's periods — and a coverage row cannot be
                       re-pointed at another company
    8. the wall        U3. A request PostgREST serves — the platform owner
                       through the companies policies, the service role past
                       them — cannot change any of the five subscription
                       columns, on UPDATE or INSERT; carrying a column's current
                       value is not a change; a company's own administrator is
                       still stopped by RLS first; the two columns only a
                       redemption and a manual edit own still reach the row
                       through them; and the functions that write the five are
                       exactly the ones the migration names, found by a reader
                       that is shown not to be blind
    9. the tier fix    20260920150000. A tier the owner sets on a company whose
                       every period has ended survives the next recompute and
                       the sweep; a company with no coverage keeps a tier it was
                       given; an early renewal that has not begun carries the
                       upgrade; a period that has not begun still decides the
                       tier; and the one path the fix does not close — a period
                       revived by a payment — is recorded as today's behaviour,
                       tagged HOLE[revival], so that closing it flips a line
   10. the kept void   20260921130000. A period a manual edit voided as
                       `replaced` stays void through the sweep, a re-apply, a
                       re-opened invoice and a cancel-then-un-cancel, so the
                       company the administrator set to expired (or inactive)
                       stays refused; an explicit payment of that invoice brings
                       it back; a period the invoice's own cancellation voided
                       comes back when the invoice is paid again; and a second
                       sweep changes nothing

  The companies here are created inside this file rather than in seed.sql for
  the same reason tenant-state.sql creates its own: they exist to be refused,
  and every one of them would otherwise widen what the other test files see.

  ## Why this file carries the behaviour, and the migration only a tripwire

  20260919150000 ends in a self-check that runs on every deploy, which this kit
  does not. Three of its checks read a function body as text, and the shape they
  settled on was paid for four times over:

    1. a check forbidding `period_start <= now()` matched the line comment that
       says that term must not be there;
    2. a check forbidding an assignment of `subscription_status` matched a block
       comment quoting what an earlier draft got wrong — the comment stripper
       handled line comments only, and its own header had claimed that was all
       the file used;
    3. writing that stripper's explanation reintroduced the delimiters as prose,
       and because PostgreSQL nests block comments, the file stopped parsing;
    4. so the explanation now lives here instead, and the migration keeps one
       short line-comment per check.

  The rule that came out of it: **a check that forbids an assignment must read
  assignments**, not the body. So checks 7 and 8 read only the `SET` clause of an
  `UPDATE` of `companies` — the one place those columns can be written — and a
  column named anywhere else (an INSERT column list, a VALUES expression, a
  comparison, surviving prose) cannot fire them.

  A text tripwire is still not a proof: it matches a phrase, so a predicate
  rewritten another way slips past. That is what the sections below are for, and
  why every behavioural claim about a writer is asserted here rather than
  described there — 3b for the two suspension writers, 3c for the early-renewal
  downgrade, 4 for the redemption, 5 for the invoice rule.

  20260919170000 (U2) follows the same division and for the same reason. Its
  self-check holds seven tripwires — the helpers exist, are unreachable by the
  API roles, are owned by a role that can reach app_private; the three RPCs call
  the rule and assign no column the recompute owns; the grace is asked for
  rather than written at a call site; Friday plus two business days is Tuesday;
  and the migration itself writes no coverage row. Everything else about U2 is
  section 5 below, including the one property the migration cannot assert about
  itself: that the rule produces the right period.

  20260920120000 (U3) keeps the division too. Its self-check pins the shape —
  the trigger fires BEFORE INSERT OR UPDATE for every row and column, its
  function is not SECURITY DEFINER, every sanctioned writer is — and compares the
  list of functions that write the five columns with the one it names. Section 8
  restates that list here, where it is checked after every migration and every
  earlier test file has run, and it is the only place the wall is exercised as
  the roles it exists to refuse.
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

-- ─── 3b. the two writers that now suspend through companies.status ──────────
--
-- Both are declared behaviour changes of this slice, so both are asserted here
-- rather than described in a header. Each goes through _sub_do, as a platform
-- owner: the effect on the row is the whole point.

DO $$
DECLARE
  v_co    uuid;
  v_out   text;
  v_owner constant uuid := '50000000-0000-4000-8000-000000000001';
BEGIN
  -- platform_company_set_approval('suspend') used to write
  -- approval_status = 'suspended', a value the CHECK now refuses.
  v_co := _sub_company('setappr', 'approved', 'active', 'active', now(), now() + interval '30 days',
                       now() - interval '1 year');
  PERFORM app_private.subscription_backfill_company(v_co);
  PERFORM _sub_ok('set_approval: the company is admitted before it is suspended',
    _sub_admitted(_sub_id('user:setappr')));

  v_out := _sub_do(v_owner, format('SELECT platform_company_set_approval(%L, %L)::text', v_co, 'suspend'));
  PERFORM _sub_ok('set_approval(suspend): answers success', _sub_succeeded(v_out));
  PERFORM _sub_ok('set_approval(suspend): writes companies.status and leaves the approval alone',
    (SELECT status FROM companies WHERE id = v_co) = 'suspended'
    AND (SELECT approval_status FROM companies WHERE id = v_co) = 'approved');
  PERFORM _sub_ok('set_approval(suspend): …and the company is refused',
    NOT _sub_admitted(_sub_id('user:setappr')));

  -- approve and reject are untouched, so the way back from a *rejection* still
  -- runs through the approval column.
  v_out := _sub_do(v_owner, format('SELECT platform_company_set_approval(%L, %L, %L)::text', v_co, 'reject', 'sub'));
  PERFORM _sub_ok('set_approval(reject): still writes the approval column, not the status',
    _sub_succeeded(v_out)
    AND (SELECT approval_status FROM companies WHERE id = v_co) = 'rejected');

  /*
    update_company_subscription_manual('suspended') used to write
    subscription_status = 'suspended', the other retired value.

    It now records a period that grants nothing, which blocks the company the
    same way — and it does **not** write companies.status. This modal is the
    Abo-Status, not a lifecycle control: suspending a company is
    `companies.lifecycle`, owners-only under D2, while this RPC asks
    `billing.manage`. Writing the status here would hand billing an owner's act,
    and a one-way one, since nothing in the modal clears it.
  */
  v_co := _sub_company('manualsusp', 'approved', 'active', 'active', now(), now() + interval '30 days',
                       now() - interval '1 year');
  PERFORM app_private.subscription_backfill_company(v_co);
  PERFORM _sub_ok('manual update: the company is admitted before it is blocked',
    _sub_admitted(_sub_id('user:manualsusp')));

  v_out := _sub_do(v_owner, format(
    'SELECT update_company_subscription_manual(%L, %L, NULL, %L, NULL, %L)::text',
    v_co, 'suspended', now() + interval '30 days', 'sub test'));
  PERFORM _sub_ok('manual update(suspended): answers success', _sub_succeeded(v_out));
  PERFORM _sub_ok('manual update(suspended): blocks through a period that grants nothing',
    (SELECT subscription_status FROM companies WHERE id = v_co) <> 'active'
    AND (SELECT count(*) FROM subscription_coverage
          WHERE company_id = v_co AND status = 'active' AND grants_access) = 0);
  PERFORM _sub_ok('manual update(suspended): …and does not reach companies.status — that is lifecycle''s',
    (SELECT status FROM companies WHERE id = v_co) = 'active');
  PERFORM _sub_ok('manual update(suspended): …and the company is refused',
    NOT _sub_admitted(_sub_id('user:manualsusp')));

  -- The trail row records what the column holds, not what was asked for: the
  -- two can differ now that the word is derived.
  PERFORM _sub_ok('manual update: the trail row agrees with the column it describes',
    (SELECT a.new_status FROM subscription_admin_actions a
      WHERE a.company_id = v_co ORDER BY a.created_at DESC LIMIT 1)
    = (SELECT subscription_status FROM companies WHERE id = v_co));

  -- …and the door swings both ways: picking Aktiv again restores a granting
  -- period. Under the earlier draft this was a silent no-op, because the only
  -- exit from a manual suspension was lifecycle('reactivate') on another screen.
  v_out := _sub_do(v_owner, format(
    'SELECT update_company_subscription_manual(%L, %L, NULL, %L, NULL, %L)::text',
    v_co, 'active', now() + interval '30 days', 'sub test back'));
  PERFORM _sub_ok('manual update(active): brings the company back, so the modal is not a one-way door',
    _sub_succeeded(v_out)
    AND (SELECT subscription_status FROM companies WHERE id = v_co) = 'active'
    AND _sub_admitted(_sub_id('user:manualsusp')));
END $$;

-- ─── 3c. an early renewal must not be downgraded by the next sweep ──────────
--
-- The shape that broke it: set_plan wrote the new tier only onto periods that
-- had already started, while the recompute takes the plan from the granting row
-- with the furthest end. A company that renews early owns a row starting in the
-- future, so the upgrade skipped exactly the row the recompute would read, and
-- the next `recompute_all_company_subscriptions()` — which HANDOFF.md tells the
-- operator to schedule — wrote the old tier back over it.

DO $$
DECLARE
  v_co    uuid;
  v_out   text;
  v_owner constant uuid := '50000000-0000-4000-8000-000000000001';
BEGIN
  -- on basic, paid to 01.12, and renewing a year early
  v_co := _sub_company('renew', 'approved', 'active', 'active', now() - interval '1 year',
                       now() + interval '60 days', now() - interval '1 year');
  PERFORM app_private.subscription_backfill_company(v_co);
  PERFORM app_private.subscription_coverage_record(
    v_co, 'activation_code', _sub_id('code:renew'),
    now() + interval '60 days', now() + interval '425 days', true, 'basic', NULL, 'early renewal', false);
  -- …and a period it already used up, so the last assertion is not vacuous
  PERFORM app_private.subscription_coverage_record(
    v_co, 'manual', NULL,
    now() - interval '2 years', now() - interval '1 year', true, 'basic', NULL, 'last year', false);

  PERFORM _sub_ok('early renewal: the company is on basic, covered past the renewal',
    (SELECT plan FROM companies WHERE id = v_co) = 'basic');

  v_out := _sub_do(v_owner, format('SELECT platform_company_set_plan(%L, %L)::text', v_co, 'premium'));
  PERFORM _sub_ok('early renewal: the upgrade answers success', _sub_succeeded(v_out));
  PERFORM _sub_ok('early renewal: …and reaches the period that has not started yet',
    (SELECT count(*) FROM subscription_coverage
      WHERE company_id = v_co AND status = 'active' AND grants_access
        AND (period_end IS NULL OR period_end > now())
        AND plan IS DISTINCT FROM 'premium') = 0
    AND (SELECT count(*) FROM subscription_coverage
          WHERE company_id = v_co AND period_start > now() AND plan = 'premium') = 1);

  -- The sweep is the instrument that used to undo it.
  PERFORM app_private.recompute_all_company_subscriptions();
  PERFORM _sub_ok('early renewal: the daily sweep leaves the upgrade standing',
    (SELECT plan FROM companies WHERE id = v_co) = 'premium');

  -- A period that is already over keeps the tier it was sold at: it is history,
  -- and since 20260920150000 the recompute never reads it (section 9).
  PERFORM _sub_ok('early renewal: a period that has ended keeps the tier it was sold at',
    (SELECT count(*) FROM subscription_coverage
      WHERE company_id = v_co AND period_end IS NOT NULL AND period_end <= now()
        AND plan = 'premium') = 0);
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

-- ─── 5. invoices: paying extends, the grace closes (U2) ─────────────────────
--
-- U1's rule 5 was that an invoice affects nothing; 20260919170000 replaced it
-- with the owner's three rules of 18.09.2026, and this section is those rules.
--
-- Two kinds of date are used here, on purpose. A claim about **access** needs a
-- period that is live on the day the kit runs, so it is written against the
-- current calendar month — a hard-coded 2026 would stop meaning "the month has
-- not ended" the year after next. A claim about the **shape of a period** needs
-- both of its ends to be the same on every day the kit can run, so it is
-- written against a fixed month whose weekdays are known (02.01.2026 is a
-- Friday). Mixing the two is what would make a check pass on a Wednesday in
-- March and fail on the first of a month.
--
-- One plan is shared; each company gets its own subscription row and its own
-- invoices, because `subscription_invoices` is unique on
-- (company_id, invoice_month, invoice_year) and on invoice_number.

/** The calendar month an invoice for (p_year, p_month) covers, as U2 maps it. */
CREATE OR REPLACE FUNCTION _sub_period(p_year integer, p_month integer, p_which text)
RETURNS timestamptz
LANGUAGE sql STABLE AS $$
  SELECT CASE p_which
           WHEN 'start' THEN make_date(p_year, p_month, 1)::timestamp AT TIME ZONE 'Europe/Berlin'
           ELSE (make_date(p_year, p_month, 1) + interval '1 month') AT TIME ZONE 'Europe/Berlin'
         END
$$;

/**
  An invoice for one of this section's companies. Answers its id.

  The subscription row is looked up from the company rather than derived from
  the slug, so a company may carry several invoices under slugs of its own.
  `ORDER BY s.id` and not a bare `LIMIT 1`: every company here has exactly one
  subscription row today, so an unordered pick would be right by accident and
  would start choosing arbitrarily the day one of them has two.

  **Year before month, in all three places.** The arguments, the column list and
  the values are written in the same order on purpose. The first version of this
  helper listed the columns `invoice_month, invoice_year` and passed
  `p_year, p_month`, so 2026 went into `invoice_month` and the table's
  `CHECK (invoice_month BETWEEN 1 AND 12)` refused every insert — which aborted
  the file and left all of section 5 unproven. Keeping one order end to end is
  what removes the transposition rather than moving it: `_sub_period` and
  `make_date` are year-first too, so nothing in this section reads month-first.
*/
CREATE OR REPLACE FUNCTION _sub_invoice(
  p_slug  text,
  p_co    uuid,
  p_year  integer,
  p_month integer,
  p_due   date,
  p_amount numeric DEFAULT 20
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid := _sub_id('invoice:' || p_slug);
BEGIN
  INSERT INTO subscription_invoices (id, company_id, subscription_id,
                                     invoice_year, invoice_month,
                                     invoice_number, amount, due_date)
  VALUES (v_id, p_co,
          (SELECT s.id FROM company_subscriptions s WHERE s.company_id = p_co ORDER BY s.id LIMIT 1),
          p_year, p_month,
          'INV-SUB-' || upper(p_slug), p_amount, p_due);
  RETURN v_id;
END $$;

/** A company for this section, with the subscription row its invoices hang off. */
CREATE OR REPLACE FUNCTION _sub_billed_company(p_slug text, p_sub_status text DEFAULT 'inactive',
                                               p_expires timestamptz DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_co uuid;
BEGIN
  v_co := _sub_company(p_slug, 'approved', 'active', p_sub_status,
                       now() - interval '1 year', p_expires, now() - interval '1 year');
  PERFORM app_private.subscription_backfill_company(v_co);
  INSERT INTO company_subscriptions (id, company_id, plan_id, monthly_price)
  VALUES (_sub_id('subscription:' || p_slug), v_co, _sub_id('plan'), 20);
  RETURN v_co;
END $$;

-- 5a. paying records the month, and the money on it is the invoice's own amount
DO $$
DECLARE
  v_owner constant uuid := '50000000-0000-4000-8000-000000000001';
  v_month constant integer := extract(month FROM (now() AT TIME ZONE 'Europe/Berlin'))::integer;
  v_year  constant integer := extract(year  FROM (now() AT TIME ZONE 'Europe/Berlin'))::integer;
  v_co    uuid;
  v_inv   uuid;
  v_row   subscription_coverage%ROWTYPE;
  v_out   text;
BEGIN
  INSERT INTO subscription_plans (id, name, monthly_price, included_cars)
  VALUES (_sub_id('plan'), 'SUB plan', 20, 1);

  v_co  := _sub_billed_company('inv');
  -- Due in the middle of the month it invoices, the way GenerateInvoicesModal
  -- writes one: `min(billing_day, 28)` of the invoiced month.
  v_inv := _sub_invoice('inv', v_co, v_year, v_month,
                        make_date(v_year, v_month, 1) + 4, 20);

  PERFORM _sub_ok('invoices: the company is refused while the invoice is neither paid nor applied',
    NOT _sub_admitted(_sub_id('user:inv')));

  -- _sub_do, not _sub_try: the effect is what is asserted, and _sub_try rolls
  -- every probe back — the RPC would still answer `success` and every check
  -- below would read a table nothing had touched.
  --
  -- 1500 cents handed over against an invoice of 20,00 €, so the coverage price
  -- cannot accidentally be the RPC's argument: it is the invoice's `amount`,
  -- because that is what the period cost.
  v_out := _sub_do(v_owner, format('SELECT platform_invoice_mark_paid(%L, %s)::text', v_inv, 1500));
  PERFORM _sub_ok('invoices: an owner marks one paid', _sub_succeeded(v_out));
  PERFORM _sub_ok('invoices: …and the payment really landed, so the checks below are not vacuous',
    (SELECT status FROM subscription_invoices WHERE id = v_inv) = 'paid');

  SELECT * INTO v_row FROM subscription_coverage
   WHERE company_id = v_co AND source = 'invoice' AND source_id = v_inv;

  PERFORM _sub_ok('invoices: paying writes exactly one coverage row, live and granting',
    v_row.id IS NOT NULL AND v_row.status = 'active' AND v_row.grants_access
    AND (SELECT count(*) FROM subscription_coverage WHERE company_id = v_co AND source = 'invoice') = 1);
  PERFORM _sub_ok('invoices: …covering the calendar month the invoice names, in Europe/Berlin',
    v_row.period_start = _sub_period(v_year, v_month, 'start')
    AND v_row.period_end = _sub_period(v_year, v_month, 'end'));
  PERFORM _sub_ok('invoices: …priced at the invoice''s own amount in integer cents, not at what was handed over',
    v_row.price_cents = 2000
    AND (SELECT cash_received_amount FROM subscription_invoices WHERE id = v_inv) = 15.00);
  PERFORM _sub_ok('invoices: …and the company is admitted, on the expiry the recompute derived',
    _sub_admitted(_sub_id('user:inv'))
    AND (SELECT subscription_expires_at FROM companies WHERE id = v_co) = _sub_period(v_year, v_month, 'end'));

  -- Applying the same invoice again must move the row, never add one: the
  -- partial unique index on (company_id, source, source_id) is what keeps that
  -- true, and the sweep calls this over every invoice.
  PERFORM app_private.subscription_invoice_apply(v_inv);
  PERFORM app_private.subscription_invoice_apply(v_inv);
  PERFORM _sub_ok('invoices: applying the same invoice three times leaves one row',
    (SELECT count(*) FROM subscription_coverage WHERE company_id = v_co AND source = 'invoice') = 1);
END $$;

-- 5b. a payment two days past its due date still extends
DO $$
DECLARE
  v_owner constant uuid := '50000000-0000-4000-8000-000000000001';
  v_month constant integer := extract(month FROM (now() AT TIME ZONE 'Europe/Berlin'))::integer;
  v_year  constant integer := extract(year  FROM (now() AT TIME ZONE 'Europe/Berlin'))::integer;
  -- One clock for the month and for the due date. `current_date` reads the
  -- session's TimeZone, which is UTC in the kit's container, while the month
  -- above is Berlin — so on the last night of a month the two name different
  -- months and an invoice would be filed under one while its due date sat in
  -- the other. Deriving both from the same expression removes the question.
  v_today constant date    := (now() AT TIME ZONE 'Europe/Berlin')::date;
  v_co    uuid;
  v_inv   uuid;
BEGIN
  v_co  := _sub_billed_company('inv_late');
  -- Due 30 days ago, so it is past whatever day the kit runs on, and paid only
  -- now. Being late is not a reason to buy less than the month that was billed.
  v_inv := _sub_invoice('inv_late', v_co, v_year, v_month, (v_today - 30), 20);

  PERFORM _sub_ok('invoices: a late payment is accepted',
    _sub_succeeded(_sub_do(v_owner, format('SELECT platform_invoice_mark_paid(%L, %s)::text', v_inv, 2000))));
  PERFORM _sub_ok('invoices: …and still buys the whole month it was for',
    (SELECT period_end FROM subscription_coverage
      WHERE company_id = v_co AND source = 'invoice' AND source_id = v_inv)
      = _sub_period(v_year, v_month, 'end')
    AND _sub_admitted(_sub_id('user:inv_late')));
END $$;

-- 5c. the grace: an unpaid invoice grants until two business days after its due
--     date, and not one hour longer
DO $$
DECLARE
  v_month constant integer := extract(month FROM (now() AT TIME ZONE 'Europe/Berlin'))::integer;
  v_year  constant integer := extract(year  FROM (now() AT TIME ZONE 'Europe/Berlin'))::integer;
  -- The same one clock as 5b, and for the same reason.
  v_today constant date    := (now() AT TIME ZONE 'Europe/Berlin')::date;
  v_co    uuid;
  v_inv   uuid;
  v_row   subscription_coverage%ROWTYPE;
BEGIN
  -- Inside the grace: due today, so the close is two business days ahead. That
  -- is at least tomorrow at Berlin midnight whatever weekday this runs on, so
  -- the period is live and the company is admitted on every day of the week —
  -- the one claim here that the calendar could otherwise have decided.
  v_co  := _sub_billed_company('inv_grace');
  v_inv := _sub_invoice('inv_grace', v_co, v_year, v_month, v_today, 20);
  PERFORM app_private.subscription_invoice_apply(v_inv);

  SELECT * INTO v_row FROM subscription_coverage
   WHERE company_id = v_co AND source = 'invoice' AND source_id = v_inv;

  PERFORM _sub_ok('grace: an unpaid invoice grants, and its row is live and granting like any other',
    v_row.status = 'active' AND v_row.grants_access);
  PERFORM _sub_ok('grace: …until two business days after the due date, and that is where it ends',
    v_row.period_end = app_private.invoice_grace_end(v_today));
  PERFORM _sub_ok('grace: …and that end is ahead of now, on whatever weekday this runs',
    v_row.period_end > now());
  PERFORM _sub_ok('grace: …so the company is admitted while the grace runs',
    _sub_admitted(_sub_id('user:inv_grace')));

  -- Past the grace: a fixed month, and not the current one with a due date 30
  -- days back. An unpaid period ends at `greatest(grace end, period start)`,
  -- because a live period has to run forwards, and a due date before the month
  -- it invoices would otherwise be clamped — on the 25th of a month a due date
  -- 30 days ago sits before the 1st, and the end would be the period start
  -- rather than the grace. January 2026 due on Friday the 2nd has both ends
  -- known and in the past on every day this can run.
  v_co  := _sub_billed_company('inv_overdue');
  v_inv := _sub_invoice('inv_overdue', v_co, 2026, 1, DATE '2026-01-02', 20);
  PERFORM app_private.subscription_invoice_apply(v_inv);

  PERFORM _sub_ok('grace: an invoice two business days past due grants a period that has ended',
    (SELECT period_end FROM subscription_coverage
      WHERE company_id = v_co AND source = 'invoice' AND source_id = v_inv)
      = app_private.invoice_grace_end(DATE '2026-01-02'));
  PERFORM _sub_ok('grace: …so the company with nothing paid is refused',
    NOT _sub_admitted(_sub_id('user:inv_overdue')));

  -- The owner's own case, and the reason the number is business days: a Friday
  -- due date must not close on the Sunday. 02.01.2026 is a Friday, 03. and 04.
  -- are the weekend, 05. is a Monday.
  PERFORM _sub_ok('grace: a Friday due date closes on the Tuesday, not on the Sunday',
    app_private.add_business_days(DATE '2026-01-02', 2) = DATE '2026-01-06'
    AND app_private.invoice_grace_end(DATE '2026-01-02')
        = (DATE '2026-01-06')::timestamp AT TIME ZONE 'Europe/Berlin');
  PERFORM _sub_ok('grace: …and a Monday due date closes on the Wednesday, two days later',
    app_private.add_business_days(DATE '2026-01-05', 2) = DATE '2026-01-07');
  PERFORM _sub_ok('grace: the number is two business days, from the one place that holds it',
    app_private.subscription_grace_business_days() = 2);

  -- Paying must never shorten what being open already granted: a due date on
  -- the 28th plus two business days can land in the following month.
  PERFORM _sub_ok('grace: a period that outruns its own month survives the payment',
    app_private.invoice_grace_end(DATE '2026-02-27') > _sub_period(2026, 2, 'end'));
END $$;

-- 5d. cancelling withdraws the coverage and keeps the record (rule 3);
--     re-opening shrinks it to the grace window without withdrawing it
DO $$
DECLARE
  v_owner constant uuid := '50000000-0000-4000-8000-000000000001';
  v_month constant integer := extract(month FROM (now() AT TIME ZONE 'Europe/Berlin'))::integer;
  v_year  constant integer := extract(year  FROM (now() AT TIME ZONE 'Europe/Berlin'))::integer;
  v_co    uuid;
  v_inv   uuid;
  v_row   subscription_coverage%ROWTYPE;
BEGIN
  v_co  := _sub_billed_company('inv_cancel');
  v_inv := _sub_invoice('inv_cancel', v_co, v_year, v_month,
                        make_date(v_year, v_month, 1) + 4, 20);

  -- Split for the same reason, although this one is safe as it stands: both
  -- operands are volatile plpgsql calls, so there is no sub-SELECT to become an
  -- InitPlan and the planner may not reorder them — the payment really did run
  -- before the read. It is split anyway, because the rule above has no
  -- exception worth carrying in anyone's head, and one shape in a file beats
  -- two with a footnote.
  PERFORM _sub_ok('cancel: the invoice is paid first, so there is coverage to withdraw',
    _sub_succeeded(_sub_do(v_owner, format('SELECT platform_invoice_mark_paid(%L, %s)::text', v_inv, 2000))));
  PERFORM _sub_ok('cancel: …and it admits the company, so there is access to lose',
    _sub_admitted(_sub_id('user:inv_cancel')));

  PERFORM _sub_ok('cancel: an owner cancels a paid invoice',
    _sub_succeeded(_sub_do(v_owner, format('SELECT platform_invoice_cancel(%L)::text', v_inv))));

  SELECT * INTO v_row FROM subscription_coverage
   WHERE company_id = v_co AND source = 'invoice' AND source_id = v_inv;

  PERFORM _sub_ok('cancel: the coverage row is voided and names why',
    v_row.status = 'void' AND v_row.void_reason = 'invoice_canceled');
  PERFORM _sub_ok('cancel: …the period it withdrew is kept exactly as it was recorded',
    v_row.period_end = _sub_period(v_year, v_month, 'end'));
  PERFORM _sub_ok('cancel: …the company loses the access it bought',
    NOT _sub_admitted(_sub_id('user:inv_cancel')));
  PERFORM _sub_ok('cancel: …and the invoice keeps its record, payment and all',
    (SELECT status = 'canceled' AND paid_at IS NOT NULL AND cash_received_amount = 20.00
       FROM subscription_invoices WHERE id = v_inv));

  -- Re-opening is the other half, and it is not a cancellation: the invoice is
  -- still owed, so it still grants until its grace ends.
  --
  -- A **fixed** month here, not the current one, and deliberately: what is
  -- asserted is the two exact period ends, and only a fixed month makes both
  -- deterministic on every day the kit can run. 02.01.2026 is a Friday, so the
  -- grace ends on Tuesday 06.01. and the month on 01.02. — far apart, and
  -- neither can collide with the period start the way a due date relative to
  -- today can. Whether the company is admitted is not claimed here: both ends
  -- are in the past, so it is refused before and after, and 5c is where the
  -- refusal is earned.
  v_co  := _sub_billed_company('inv_reopen');
  v_inv := _sub_invoice('inv_reopen', v_co, 2026, 1, DATE '2026-01-02', 20);

  /*
    **The write and the read of that write are two statements, always.**

    This assertion was one expression — `_sub_succeeded(_sub_do(… mark_paid …))
    AND (SELECT period_end FROM subscription_coverage …) = …` — and it failed
    while the row it read was perfectly correct. An uncorrelated scalar
    sub-SELECT is planned as an InitPlan, and an InitPlan is not an operand of
    the AND: `ExecEvalAnd`'s left-to-right short-circuit orders the operands, it
    does not make the InitPlan wait for them. So the read ran before the payment
    it was meant to observe, found nothing, and the comparison was NULL — which
    `_sub_ok` reports as a failure, indistinguishable from a wrong value.

    The rule, and it has no exception in this file: **an assertion must not
    write and read the same rows in one expression.** Do the write, then assert.
  */
  PERFORM _sub_ok('reopen: an owner marks the invoice paid',
    _sub_succeeded(_sub_do(v_owner, format('SELECT platform_invoice_mark_paid(%L, %s)::text', v_inv, 2000))));
  PERFORM _sub_ok('reopen: …and a paid invoice covers its whole month',
    (SELECT period_end FROM subscription_coverage
      WHERE company_id = v_co AND source = 'invoice' AND source_id = v_inv)
      = _sub_period(2026, 1, 'end'));
  -- U1 shipped price_cents NULL on every path; filling it was U2's first job.
  PERFORM _sub_ok('reopen: …carrying the invoice''s amount in integer cents',
    (SELECT price_cents FROM subscription_coverage
      WHERE company_id = v_co AND source = 'invoice' AND source_id = v_inv) = 2000);

  PERFORM _sub_ok('reopen: marking it unpaid is accepted',
    _sub_succeeded(_sub_do(v_owner, format('SELECT platform_invoice_mark_unpaid(%L)::text', v_inv))));

  SELECT * INTO v_row FROM subscription_coverage
   WHERE company_id = v_co AND source = 'invoice' AND source_id = v_inv;

  PERFORM _sub_ok('reopen: the row stays live and granting — the invoice is owed, not cancelled',
    v_row.status = 'active' AND v_row.grants_access AND v_row.void_reason IS NULL);
  PERFORM _sub_ok('reopen: …but its period shrinks from the month back to the grace window',
    v_row.period_end = app_private.invoice_grace_end(DATE '2026-01-02')
    AND v_row.period_end < _sub_period(2026, 1, 'end'));
  PERFORM _sub_ok('reopen: …and the row still starts where the month does',
    v_row.period_start = _sub_period(2026, 1, 'start'));
END $$;

-- 5e. two payments at the same instant, and the open-ended period of rule 1
DO $$
DECLARE
  v_owner constant uuid := '50000000-0000-4000-8000-000000000001';
  v_month constant integer := extract(month FROM (now() AT TIME ZONE 'Europe/Berlin'))::integer;
  v_year  constant integer := extract(year  FROM (now() AT TIME ZONE 'Europe/Berlin'))::integer;
  v_next_m constant integer := extract(month FROM ((now() AT TIME ZONE 'Europe/Berlin') + interval '1 month'))::integer;
  v_next_y constant integer := extract(year  FROM ((now() AT TIME ZONE 'Europe/Berlin') + interval '1 month'))::integer;
  v_co    uuid;
  v_inv_a uuid;
  v_inv_b uuid;
BEGIN
  -- Two invoices of one company, paid in one transaction, so both coverage rows
  -- carry the same created_at — the deterministic stand-in for two payments
  -- arriving together (section 6 makes the same point for manual records). The
  -- later month is paid first, so an answer that depended on write order would
  -- name the wrong end.
  v_co    := _sub_billed_company('inv_race');
  v_inv_a := _sub_invoice('inv_race_a', v_co, v_year,   v_month,
                          make_date(v_year, v_month, 1) + 4, 20);
  v_inv_b := _sub_invoice('inv_race_b', v_co, v_next_y, v_next_m,
                          make_date(v_next_y, v_next_m, 1) + 4, 20);

  -- The later month first, so the order is the unhelpful one.
  PERFORM _sub_do(v_owner, format('SELECT platform_invoice_mark_paid(%L, %s)::text', v_inv_b, 2000));
  PERFORM _sub_do(v_owner, format('SELECT platform_invoice_mark_paid(%L, %s)::text', v_inv_a, 2000));

  PERFORM _sub_ok('two invoices: both periods are on record, one row each',
    (SELECT count(*) FROM subscription_coverage
      WHERE company_id = v_co AND source = 'invoice' AND status = 'active') = 2);
  PERFORM _sub_ok('two invoices: …and the later end stands, whichever was paid last',
    (SELECT subscription_expires_at FROM companies WHERE id = v_co)
      = _sub_period(v_next_y, v_next_m, 'end'));

  -- Rule 1 of U1: a company carried in as `active` with no expiry stays open.
  -- An invoice is a bounded period, and the recompute answers open-ended
  -- whenever any live granting row has no end — so paying must not cap it.
  v_co    := _sub_billed_company('inv_open', 'active', NULL);
  PERFORM _sub_ok('open-ended: the backfill carried it in with no expiry',
    (SELECT subscription_expires_at IS NULL AND subscription_status = 'active'
       FROM companies WHERE id = v_co)
    AND _sub_admitted(_sub_id('user:inv_open')));

  v_inv_a := _sub_invoice('inv_open', v_co, v_year, v_month,
                          make_date(v_year, v_month, 1) + 4, 20);
  PERFORM _sub_ok('open-ended: it can still pay an invoice',
    _sub_succeeded(_sub_do(v_owner, format('SELECT platform_invoice_mark_paid(%L, %s)::text', v_inv_a, 2000))));
  PERFORM _sub_ok('open-ended: …the payment is recorded as its own bounded period',
    (SELECT period_end FROM subscription_coverage
      WHERE company_id = v_co AND source = 'invoice' AND source_id = v_inv_a)
      = _sub_period(v_year, v_month, 'end'));
  PERFORM _sub_ok('open-ended: …and paying does not cap a company rule 1 left open',
    (SELECT subscription_expires_at IS NULL FROM companies WHERE id = v_co)
    AND _sub_admitted(_sub_id('user:inv_open')));
END $$;

-- 5f. the shape of what U2 added
DO $$
DECLARE
  v_role text;
  v_sig  text;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
      'app_private.subscription_grace_business_days()',
      'app_private.add_business_days(date,integer)',
      'app_private.invoice_grace_end(date)',
      -- (uuid, boolean) since 20260921130000, section 10: the second argument
      -- is the explicit payment's, and only platform_invoice_mark_paid passes it.
      'app_private.subscription_invoice_apply(uuid,boolean)',
      'app_private.subscription_invoices_apply_all()']
  LOOP
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      PERFORM _sub_ok(format('shape: %s may not call %s', v_role, v_sig),
        NOT has_function_privilege(v_role, v_sig::regprocedure, 'EXECUTE'));
    END LOOP;
  END LOOP;

  -- U2 added no public function, so the permission matrix has nothing new to
  -- cover: the three RPCs it rewrote are the ones platform-rpcs.sql already
  -- probes role by role.
  PERFORM _sub_ok('shape: the three invoice RPCs are still the only public door to an invoice',
    to_regprocedure('public.platform_invoice_mark_paid(uuid,bigint,timestamptz,text)') IS NOT NULL
    AND to_regprocedure('public.platform_invoice_mark_unpaid(uuid)') IS NOT NULL
    AND to_regprocedure('public.platform_invoice_cancel(uuid)') IS NOT NULL
    AND to_regprocedure('public.subscription_invoice_apply(uuid)') IS NULL);

  -- The sweep exists and is wired to nothing. If a later release wires it, the
  -- count it answers is how many invoices it touched.
  PERFORM _sub_ok('shape: the sweep exists, and it walks every invoice',
    app_private.subscription_invoices_apply_all()
      = (SELECT count(*) FROM subscription_invoices));
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
  /*
    Decision D14 (24.09.2026, migration 20260924110000): the coverage periods
    lost their `companies.read` branch. An active platform role read both rows
    until then — `companies.read` is held by all four roles by plan 3.A — and
    now reads neither outside an open context. No read model carries this table:
    nothing in the product reads a coverage period across companies, and one no
    screen shows would be code with no caller. The context side of the same rule
    is `subscription_coverage S` in tests/rls/matrix.sql, which reads 'Y.' for
    both context principals.
  */
  PERFORM _sub_ok('shape: a platform role with no context reads neither company''s coverage (D14)',
    _sub_try('50000000-0000-4000-8000-000000000001',
             'SELECT count(*) FROM subscription_coverage WHERE id IN ('
             || quote_literal(_sub_id('cov:a')) || ', ' || quote_literal(_sub_id('cov:b')) || ')') = '0');
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

-- ─── 8. the wall: nothing writes the derived columns directly (U3) ──────────
--
-- 20260920120000. The migrations run before any test file, so every sanctioned
-- writer this file has already called went through the wall: the recompute in
-- 1, update_company_subscription_manual in 3b, platform_company_set_plan in 3c,
-- redeem_activation_code in 4, the invoice RPCs in 5. What is left is the other
-- half: a request PostgREST serves is refused, and only for a change.

/**
  _sub_try as the service role, which is what an edge function holding the
  service key runs as. The same always-rolled-back subtransaction, for the same
  reason: a probe that should have been refused and was not leaves nothing.
*/
CREATE OR REPLACE FUNCTION _sub_try_service(p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out   text;
  v_rows  bigint;
  v_state text;
  v_msg   text;
BEGIN
  BEGIN
    PERFORM _sub_reset();
    PERFORM set_config('request.jwt.claim.role', 'service_role', true);
    EXECUTE 'SET LOCAL ROLE service_role';
    EXECUTE p_sql;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RAISE EXCEPTION USING ERRCODE = 'ZZ006', MESSAGE = 'rows ' || v_rows;
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

/**
  Was p_out the wall's own refusal, naming p_column? A bare `LIKE 'ERR 42501%'`
  cannot tell it from the others that share the code: an RLS WITH CHECK that
  fails, or a privilege the role does not hold. So the message is matched too,
  and the column has to be the one the message names.
*/
CREATE OR REPLACE FUNCTION _sub_walled(p_out text, p_column text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(p_out LIKE 'ERR 42501 companies: % may not be written directly;%'
                  AND strpos(split_part(p_out, ' may not be written directly;', 1), p_column) > 0,
                  false)
$$;

-- 8a–8d. the roles PostgREST serves a request as
DO $$
DECLARE
  v_owner constant uuid := '50000000-0000-4000-8000-000000000001';
  v_co    uuid;
  v_new   constant uuid := _sub_id('company:wall-new');
  v_set   text;
  v_out   text;
BEGIN
  -- A company inside the model: backfilled, so its five columns are what its
  -- coverage says, and a refusal below is about the write and not about a row
  -- that was already out of step.
  v_co := _sub_company('wall', 'approved', 'active', 'active', now() - interval '1 year',
                       now() + interval '30 days', now() - interval '1 year');
  PERFORM app_private.subscription_backfill_company(v_co);

  -- 8a. The door. companies_update admits a holder of companies.lifecycle, and
  --     the seeded owner holds it. The control comes first, so a refusal below
  --     cannot be RLS or a malformed statement in disguise.
  PERFORM _sub_ok('wall: the owner reaches the row through the companies_update policy (control)',
    _sub_try(v_owner, format('UPDATE companies SET name = name WHERE id = %L', v_co)) = 'rows 1');

  -- Every value differs from the row's, and each is one the table's own CHECKs
  -- accept. _sub_walled() then insists the refusal is the wall's own message,
  -- naming the column the assignment starts with.
  FOREACH v_set IN ARRAY ARRAY[
      $s$subscription_status = 'expired'$s$,
      $s$subscription_expires_at = NULL$s$,
      $s$subscription_expires_at = now() + interval '10 years'$s$,
      $s$subscription_started_at = now() - interval '2 years'$s$,
      $s$subscription_duration_type = '1_jahr'$s$,
      $s$plan = 'premium'$s$]
  LOOP
    v_out := _sub_try(v_owner, format('UPDATE companies SET %s WHERE id = %L', v_set, v_co));
    PERFORM _sub_ok(format('wall: the owner, through PostgREST, cannot write %s (%s)', v_set, left(v_out, 60)),
      _sub_walled(v_out, split_part(v_set, ' ', 1)));
  END LOOP;

  -- A statement that carries a column's current value is not a write of it: a
  -- screen that reads a row and sends it back whole must still save.
  PERFORM _sub_ok('wall: restating all five current values is not a write',
    _sub_try(v_owner, format(
      'UPDATE companies SET plan = plan, subscription_status = subscription_status, '
      || 'subscription_expires_at = subscription_expires_at, '
      || 'subscription_started_at = subscription_started_at, '
      || 'subscription_duration_type = subscription_duration_type WHERE id = %L', v_co)) = 'rows 1');

  -- 8b. The service role. RLS does not apply to it, and the wall does not ask.
  PERFORM _sub_ok('wall: the service role reaches the row (control)',
    _sub_try_service(format('UPDATE companies SET name = name WHERE id = %L', v_co)) = 'rows 1');
  PERFORM _sub_ok('wall: the service role cannot move the status past the recompute',
    _sub_walled(_sub_try_service(format($q$UPDATE companies SET subscription_status = 'expired' WHERE id = %L$q$, v_co)),
                'subscription_status'));
  PERFORM _sub_ok('wall: …nor open the expiry, the one change that would grant for ever',
    _sub_walled(_sub_try_service(format('UPDATE companies SET subscription_expires_at = NULL WHERE id = %L', v_co)),
                'subscription_expires_at'));
  PERFORM _sub_ok('wall: …nor the tier, past platform_company_set_plan',
    _sub_walled(_sub_try_service(format($q$UPDATE companies SET plan = 'premium' WHERE id = %L$q$, v_co)),
                'plan'));

  -- 8c. INSERT. companies_insert still lets the owner create a company; it may
  --     not arrive subscribed, dated or tiered.
  PERFORM _sub_ok('wall: the owner inserts a company whose five columns are neutral (control)',
    _sub_try(v_owner, format($q$INSERT INTO companies (id, name, slug) VALUES (%L, 'SUB wall new', 'sub-wall-new')$q$,
                             v_new)) = 'rows 1');
  -- …and naming the five is not what is refused: the same INSERT, with each of
  -- them written out at its neutral value, is let through.
  PERFORM _sub_ok('wall: …and one that names all five at their neutral values (control)',
    _sub_try(v_owner, format($q$INSERT INTO companies (id, name, slug, subscription_status, subscription_expires_at,
                                                       subscription_started_at, subscription_duration_type, plan)
                                VALUES (%L, 'SUB wall new', 'sub-wall-new', 'inactive', NULL, NULL, NULL, 'basic')$q$,
                             v_new)) = 'rows 1');
  PERFORM _sub_ok('wall: …but not one that arrives subscribed',
    _sub_walled(_sub_try(v_owner, format($q$INSERT INTO companies (id, name, slug, subscription_status)
                                            VALUES (%L, 'SUB wall new', 'sub-wall-new', 'active')$q$, v_new)),
                'subscription_status'));
  PERFORM _sub_ok('wall: …nor with an expiry no coverage row holds',
    _sub_walled(_sub_try(v_owner, format($q$INSERT INTO companies (id, name, slug, subscription_expires_at)
                                            VALUES (%L, 'SUB wall new', 'sub-wall-new', now() + interval '1 year')$q$, v_new)),
                'subscription_expires_at'));
  v_out := _sub_try(v_owner, format($q$INSERT INTO companies (id, name, slug, subscription_started_at, subscription_duration_type)
                                       VALUES (%L, 'SUB wall new', 'sub-wall-new', now(), '1_monat')$q$, v_new));
  PERFORM _sub_ok(format('wall: …nor with a start or a duration word, and the refusal names both (%s)', left(v_out, 90)),
    _sub_walled(v_out, 'subscription_started_at') AND _sub_walled(v_out, 'subscription_duration_type'));
  PERFORM _sub_ok('wall: …nor on a tier platform_company_set_plan did not set',
    _sub_walled(_sub_try(v_owner, format($q$INSERT INTO companies (id, name, slug, plan)
                                            VALUES (%L, 'SUB wall new', 'sub-wall-new', 'premium')$q$, v_new)),
                'plan'));
  PERFORM _sub_ok('wall: the service role is held to the same rule on INSERT',
    _sub_walled(_sub_try_service(format($q$INSERT INTO companies (id, name, slug, subscription_status)
                                           VALUES (%L, 'SUB wall new', 'sub-wall-new', 'active')$q$, v_new)),
                'subscription_status'));

  -- 8d. A company's own administrator never reached the row. The wall stands
  --     behind RLS, not in front of it, so that answer is unchanged.
  PERFORM _sub_ok('wall: a company admin is still stopped by RLS first — no row, so no refusal',
    _sub_try(_sub_id('user:wall'), format($q$UPDATE companies SET plan = 'premium' WHERE id = %L$q$, v_co))
      = 'rows 0');
END $$;

-- 8e. The two guarded columns the recompute does not own reach the row through
--     their own writers, called as the roles that call them. The write and the
--     read of it are two statements each (5d says why).
--
--     Every value asserted is one only the write could have produced. The
--     `wall` company was created starting a year ago, expiring in 30 days, with
--     no duration word; this whole file is one transaction, so now() is the same
--     instant here as it was then.
DO $$
DECLARE
  v_owner constant uuid := '50000000-0000-4000-8000-000000000001';
  v_co    constant uuid := _sub_id('company:wall');
  v_row   companies%ROWTYPE;
  v_out   text;
BEGIN
  SELECT * INTO v_row FROM companies WHERE id = v_co;
  PERFORM _sub_ok('wall: before the writes, no duration word and a start a year back (so the checks below are not vacuous)',
    v_row.subscription_duration_type IS NULL
    AND v_row.subscription_started_at = now() - interval '1 year'
    AND v_row.subscription_expires_at = now() + interval '30 days');

  INSERT INTO activation_codes (id, code_hash, duration_type, expires_at, created_by, company_id)
  VALUES (_sub_id('code:wall'), encode(sha256(convert_to('300444', 'UTF8')), 'hex'),
          '3_monate', now() + interval '7 days', _sub_id('user:wall'), v_co);

  v_out := _sub_do(_sub_id('user:wall'), 'SELECT redeem_activation_code(''300444'')::text');
  PERFORM _sub_ok('wall: a company admin''s redemption still succeeds', _sub_succeeded(v_out));

  -- A redemption on an active company starts its period at the running expiry.
  SELECT * INTO v_row FROM companies WHERE id = v_co;
  PERFORM _sub_ok(format('wall: …and writes the start and the duration word it owns (start %s, word %s)',
                         v_row.subscription_started_at, v_row.subscription_duration_type),
    v_row.subscription_started_at = now() + interval '30 days'
    AND v_row.subscription_duration_type = '3_monate');

  v_out := _sub_do(v_owner, format(
    'SELECT update_company_subscription_manual(%L, %L, %L, %L, %L, %L)::text',
    v_co, 'active', now() - interval '1 day', now() + interval '1 year', '1_jahr', 'sub wall'));
  PERFORM _sub_ok('wall: a platform owner''s manual edit still succeeds', _sub_succeeded(v_out));

  -- The start and the word are the two values this RPC writes itself; the
  -- expiry is the one the recompute derives from the period it recorded.
  SELECT * INTO v_row FROM companies WHERE id = v_co;
  PERFORM _sub_ok(format('wall: …and writes the start and the duration word it owns (start %s, word %s, expiry %s)',
                         v_row.subscription_started_at, v_row.subscription_duration_type, v_row.subscription_expires_at),
    v_row.subscription_started_at = now() - interval '1 day'
    AND v_row.subscription_duration_type = '1_jahr'
    AND v_row.subscription_expires_at = now() + interval '1 year');
END $$;

-- 8f. the shape: the migration's self-check restated, since that ran before
--     any later migration could have touched it
DO $$
BEGIN
  PERFORM _sub_ok('wall shape: an enabled BEFORE INSERT OR UPDATE row trigger on companies, for every column',
    EXISTS (SELECT 1 FROM pg_trigger t
             WHERE t.tgrelid = 'public.companies'::regclass
               AND t.tgname = 'refuse_direct_subscription_write'
               AND NOT t.tgisinternal
               AND t.tgfoid = 'app_private.refuse_direct_subscription_write()'::regprocedure
               AND t.tgenabled = 'O'
               AND t.tgtype & 1 = 1 AND t.tgtype & 2 = 2 AND t.tgtype & 4 = 4 AND t.tgtype & 16 = 16
               AND pg_get_triggerdef(t.oid) !~* '\mupdate\s+of\M'));
  PERFORM _sub_ok('wall shape: its function is not SECURITY DEFINER, or current_user inside it would be its owner and it would refuse nobody',
    NOT (SELECT p.prosecdef FROM pg_proc p
          WHERE p.oid = 'app_private.refuse_direct_subscription_write()'::regprocedure));
  PERFORM _sub_ok('wall shape: no API role may call either U3 function',
    NOT has_function_privilege('anon',          'app_private.refuse_direct_subscription_write()', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'app_private.refuse_direct_subscription_write()', 'EXECUTE')
    AND NOT has_function_privilege('service_role',  'app_private.refuse_direct_subscription_write()', 'EXECUTE')
    AND NOT has_function_privilege('anon',          'app_private.subscription_column_writes()', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'app_private.subscription_column_writes()', 'EXECUTE')
    AND NOT has_function_privilege('service_role',  'app_private.subscription_column_writes()', 'EXECUTE'));
END $$;

-- 8g. the catalogue. The list is restated here rather than read from the
--     migration, as platform-authority.sql restates the capability matrix: a
--     migration that adds a writer has to change both, in the same commit.
DO $$
DECLARE
  v_missing text;
  v_extra   text;
BEGIN
  WITH expected(fn, column_name, via) AS (
    VALUES
      ('app_private.recompute_company_subscription(uuid)'::regprocedure::oid, 'plan',                    'update'),
      ('app_private.recompute_company_subscription(uuid)'::regprocedure::oid, 'subscription_expires_at', 'update'),
      ('app_private.recompute_company_subscription(uuid)'::regprocedure::oid, 'subscription_status',     'update'),
      ('public.platform_company_set_plan(uuid,text,text,integer)'::regprocedure::oid, 'plan',            'update'),
      ('public.redeem_activation_code(text)'::regprocedure::oid, 'subscription_duration_type',           'update'),
      ('public.redeem_activation_code(text)'::regprocedure::oid, 'subscription_started_at',              'update'),
      ('public.update_company_subscription_manual(uuid,text,timestamptz,timestamptz,text,text)'::regprocedure::oid,
                                                                  'subscription_duration_type',           'update'),
      ('public.update_company_subscription_manual(uuid,text,timestamptz,timestamptz,text,text)'::regprocedure::oid,
                                                                  'subscription_started_at',              'update'),
      ('app_private.signup_insert_company(uuid,text,text,text,text,text,integer,uuid,text,text)'::regprocedure::oid,
                                                                  'plan',                                 'insert'),
      ('app_private.signup_insert_company(uuid,text,text,text,text,text,integer,uuid,text,text)'::regprocedure::oid,
                                                                  'subscription_status',                  'insert')
  ),
  -- This file's own helpers are the one exclusion, by name: _sub_company seeds
  -- companies with every column. The reader itself reads every function,
  -- whatever its name, so a writer called `_anything` anywhere else counts.
  found AS (
    SELECT w.routine::oid AS fn, w.column_name, w.via
      FROM app_private.subscription_column_writes() w
      JOIN pg_proc p ON p.oid = w.routine
     WHERE p.proname NOT LIKE '\_sub\_%'
  )
  SELECT (SELECT string_agg(e.line, '; ' ORDER BY e.line)
            FROM (SELECT format('%s writes %s (%s)', d.fn::regprocedure, d.column_name, d.via) AS line
                    FROM (SELECT * FROM expected EXCEPT SELECT * FROM found) d) e),
         (SELECT string_agg(e.line, '; ' ORDER BY e.line)
            FROM (SELECT format('%s writes %s (%s)', d.fn::regprocedure, d.column_name, d.via) AS line
                    FROM (SELECT * FROM found EXCEPT SELECT * FROM expected) d) e)
    INTO v_missing, v_extra;

  PERFORM _sub_ok('catalogue: no function writes a subscription column of companies but the sanctioned ones'
                  || coalesce(' — found ' || v_extra, ''),
    v_extra IS NULL);
  PERFORM _sub_ok('catalogue: …and every sanctioned one still writes what it owns'
                  || coalesce(' — missing ' || v_missing, ''),
    v_missing IS NULL);

  -- The exclusion above is this file's, not the reader's: the reader does see
  -- a function whose name starts with an underscore.
  PERFORM _sub_ok('catalogue: the reader reads a function whose name starts with an underscore (this file''s _sub_company)',
    EXISTS (SELECT 1
              FROM app_private.subscription_column_writes() w
              JOIN pg_proc p ON p.oid = w.routine
             WHERE p.proname = '_sub_company' AND w.column_name = 'plan' AND w.via = 'insert'));
END $$;

/*
  …and the reader is not blind. A check that finds nothing passes just as well
  when it cannot see, so a writer is planted for every branch of the reader and
  every spelling the sanctioned writers do not use. They live until the ROLLBACK
  at the end of this file.

    spellings    an alias, ONLY, the row form of SET, an INSERT with a column
                 list, next to two writes only a comment describes
    no list      an INSERT naming no columns writes all five
    upsert       ON CONFLICT … DO UPDATE assigns one
    merge        a MERGE that mentions one
    defaults     an INSERT of DEFAULT VALUES writes none
*/
CREATE FUNCTION public.u3_probe_spellings() RETURNS void
LANGUAGE plpgsql AS $f$
BEGIN
  -- UPDATE companies SET subscription_duration_type = 'described, not written';
  /* UPDATE companies SET subscription_started_at = now(); */
  UPDATE ONLY public.companies AS c SET subscription_status = 'active' WHERE false;
  UPDATE companies SET (name, subscription_expires_at) = ('probe', NULL) WHERE false;
  INSERT INTO companies (name, slug, plan) SELECT 'probe', 'probe', 'premium' WHERE false;
END $f$;

CREATE FUNCTION public.u3_probe_no_list() RETURNS void
LANGUAGE plpgsql AS $f$
BEGIN
  INSERT INTO companies SELECT * FROM companies WHERE false;
END $f$;

CREATE FUNCTION public.u3_probe_upsert() RETURNS void
LANGUAGE plpgsql AS $f$
BEGIN
  INSERT INTO companies (id, name, slug) VALUES (gen_random_uuid(), 'probe', 'probe')
    ON CONFLICT (id) DO UPDATE SET subscription_duration_type = 'probe';
END $f$;

CREATE FUNCTION public.u3_probe_merge() RETURNS void
LANGUAGE plpgsql AS $f$
BEGIN
  MERGE INTO companies c USING (SELECT 1 AS one) s ON false
    WHEN NOT MATCHED THEN INSERT (name, slug, subscription_expires_at) VALUES ('probe', 'probe', NULL);
END $f$;

CREATE FUNCTION public.u3_probe_defaults() RETURNS void
LANGUAGE plpgsql AS $f$
BEGIN
  INSERT INTO companies DEFAULT VALUES;
END $f$;

DO $$
DECLARE
  r       record;
  v_found text;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('public.u3_probe_spellings()', 'plan:insert,subscription_expires_at:update,subscription_status:update'),
      ('public.u3_probe_no_list()',   'plan:insert,subscription_duration_type:insert,subscription_expires_at:insert,'
                                      || 'subscription_started_at:insert,subscription_status:insert'),
      ('public.u3_probe_upsert()',    'subscription_duration_type:insert'),
      ('public.u3_probe_merge()',     'subscription_expires_at:merge'),
      ('public.u3_probe_defaults()',  'nothing')) AS v(probe, want)
  LOOP
    -- COLLATE "C": the expected strings are in byte order, whatever the
    -- database's own collation does with the underscores.
    SELECT coalesce(string_agg(w.column_name || ':' || w.via, ',' ORDER BY w.column_name COLLATE "C"), 'nothing')
      INTO v_found
      FROM app_private.subscription_column_writes() w
     WHERE w.routine::oid = r.probe::regprocedure::oid;

    PERFORM _sub_ok(format('catalogue: the reader sees %s as %s (found %s)', r.probe, r.want, v_found),
      v_found = r.want);
  END LOOP;
END $$;

-- ─── 9. a tier set after every period has ended (20260920150000) ────────────
--
-- The defect: the recompute read the tier off the granting period with the
-- furthest end whether or not that end had passed, while set_plan carries a
-- tier only onto periods that have not ended. For a company whose every
-- granting period had ended, the next recompute wrote the old tier back over
-- the owner's change. The fix reads a tier only from a period that has not
-- ended, the set set_plan carries onto.
--
-- Every company here starts on basic and its periods are recorded at basic, so
-- premium or advanced afterwards can only have come from the write under test.
-- Writes and the reads of them are separate statements throughout (5d says why).
-- This section runs after section 5 because 9b needs the subscription plan row
-- 5a inserts.

-- 9a. the defect, and the controls the rule must keep
DO $$
DECLARE
  v_owner constant uuid := '50000000-0000-4000-8000-000000000001';
  v_co    uuid;
  v_out   text;
BEGIN
  -- A company paid until ten days ago, and nothing since.
  v_co := _sub_company('tier-ended', 'approved', 'active', 'active', now() - interval '1 year',
                       now() - interval '10 days', now() - interval '1 year');
  PERFORM app_private.subscription_backfill_company(v_co);

  -- The precondition, so the checks below are not vacuous: no period is left
  -- for set_plan to carry a tier onto, and the one that ended is at basic.
  PERFORM _sub_ok('tier: the company''s only period has ended at basic, so set_plan has nothing to carry a tier onto',
    (SELECT subscription_status FROM companies WHERE id = v_co) = 'expired'
    AND (SELECT count(*) FROM subscription_coverage
          WHERE company_id = v_co AND status = 'active' AND grants_access
            AND (period_end IS NULL OR period_end > now())) = 0
    AND (SELECT count(*) FROM subscription_coverage
          WHERE company_id = v_co AND status = 'active' AND grants_access AND plan = 'basic') = 1);

  v_out := _sub_do(v_owner, format('SELECT platform_company_set_plan(%L, %L)::text', v_co, 'premium'));
  PERFORM _sub_ok('tier: the owner sets premium on it', _sub_succeeded(v_out));
  PERFORM _sub_ok('tier: …the company holds premium, and the ended period keeps the basic it was sold at',
    (SELECT plan FROM companies WHERE id = v_co) = 'premium'
    AND (SELECT plan FROM subscription_coverage WHERE company_id = v_co AND source = 'migration') = 'basic');

  -- The instrument that used to undo it, one company at a time…
  PERFORM app_private.recompute_company_subscription(v_co);
  PERFORM _sub_ok('tier: the next recompute leaves the owner''s premium standing (before 20260920150000 it wrote basic back)',
    (SELECT plan FROM companies WHERE id = v_co) = 'premium');

  -- …and the daily sweep, which would have done it every night.
  PERFORM app_private.recompute_all_company_subscriptions();
  PERFORM _sub_ok('tier: …and so does the daily sweep',
    (SELECT plan FROM companies WHERE id = v_co) = 'premium');
  PERFORM _sub_ok('tier: …while the status half is untouched: expired, on the day the period ended',
    (SELECT subscription_status = 'expired' AND subscription_expires_at = now() - interval '10 days'
       FROM companies WHERE id = v_co));

  -- Control: a company with no coverage at all keeps the plan it was given.
  -- Section 1 checks this for the default tier; here it is a tier set_plan set,
  -- so the column cannot be right merely by being the default.
  v_co := _sub_company('tier-none', 'approved', 'active', 'inactive');
  PERFORM app_private.subscription_backfill_company(v_co);
  v_out := _sub_do(v_owner, format('SELECT platform_company_set_plan(%L, %L)::text', v_co, 'premium'));
  PERFORM _sub_ok('tier, control: set_plan on a company with no coverage answers success', _sub_succeeded(v_out));
  PERFORM app_private.recompute_company_subscription(v_co);
  PERFORM _sub_ok('tier, control: a company with no coverage keeps the plan it was given',
    (SELECT plan FROM companies WHERE id = v_co) = 'premium'
    AND NOT EXISTS (SELECT 1 FROM subscription_coverage WHERE company_id = v_co));

  -- Control: an early renewal survives the sweep (3c), here in the case the
  -- fix is about — the running period has ended and the renewal has not begun.
  v_co := _sub_company('tier-renew', 'approved', 'active', 'active', now() - interval '1 year',
                       now() - interval '10 days', now() - interval '1 year');
  PERFORM app_private.subscription_backfill_company(v_co);
  PERFORM app_private.subscription_coverage_record(
    v_co, 'activation_code', _sub_id('code:tier-renew'),
    now() + interval '5 days', now() + interval '1 year', true, 'basic', NULL, 'renewal not yet begun', false);
  v_out := _sub_do(v_owner, format('SELECT platform_company_set_plan(%L, %L)::text', v_co, 'premium'));
  PERFORM _sub_ok('tier, early renewal: the upgrade answers success', _sub_succeeded(v_out));
  PERFORM app_private.recompute_all_company_subscriptions();
  PERFORM _sub_ok('tier, early renewal: the renewal that has not begun carries the upgrade, the ended period does not',
    (SELECT plan FROM subscription_coverage WHERE company_id = v_co AND source = 'activation_code') = 'premium'
    AND (SELECT plan FROM subscription_coverage WHERE company_id = v_co AND source = 'migration') = 'basic');
  PERFORM _sub_ok('tier, early renewal: …and the sweep leaves the company on premium',
    (SELECT plan FROM companies WHERE id = v_co) = 'premium');

  -- Control: the fix reads no start date. A period that has not begun and
  -- carries its own tier still decides, while the one that ended does not. With
  -- a start term in the tier query this company would stay on basic.
  v_co := _sub_company('tier-future', 'approved', 'active', 'active', now() - interval '1 year',
                       now() - interval '10 days', now() - interval '1 year');
  PERFORM app_private.subscription_backfill_company(v_co);
  PERFORM app_private.subscription_coverage_record(
    v_co, 'manual', NULL, now() + interval '5 days', now() + interval '1 year', true, 'advanced', NULL,
    'a period recorded with its own tier', false);
  PERFORM _sub_ok('tier, control: a period that has not begun still decides the tier, so the fix filters on no start date',
    (SELECT plan FROM companies WHERE id = v_co) = 'advanced');
END $$;

/*
  9b. HOLE[revival]: the path the fix does not close, recorded as today's
      behaviour.

  A period that has ended can come back after set_plan has run.
  app_private.subscription_invoice_apply moves an invoice's row in place and
  never rewrites its tier, so an unpaid invoice whose grace has passed keeps an
  ended row at the old tier, set_plan leaves that row alone, and paying the
  invoice later moves its end to the month's end. The recompute then reads the
  old tier off a period that has not ended, which is exactly the rule. Closing
  it is a change to U2's rule, not to the recompute, and it is the owner's
  (HANDOFF.md). When it is closed, the last assertion here flips on purpose.
  20260921130000 (section 10) does not close it: that migration decides which
  voided periods may come back, and this one was never voided — it ended.

  The due date sits before the month it invoices, so the unpaid row ends at the
  month's start (the clamp in 5c) and has ended on every day the kit can run. A
  realistic due date inside the month has passed its grace only from about the
  fifth onwards, and the calendar would decide the test.
*/
DO $$
DECLARE
  v_owner constant uuid := '50000000-0000-4000-8000-000000000001';
  v_month constant integer := extract(month FROM (now() AT TIME ZONE 'Europe/Berlin'))::integer;
  v_year  constant integer := extract(year  FROM (now() AT TIME ZONE 'Europe/Berlin'))::integer;
  v_co    uuid;
  v_inv   uuid;
  v_out   text;
BEGIN
  v_co  := _sub_billed_company('tier-revive');
  v_inv := _sub_invoice('tier-revive', v_co, v_year, v_month, make_date(v_year, v_month, 1) - 30, 20);

  -- What the nightly invoice sweep does to an invoice nobody has touched.
  PERFORM app_private.subscription_invoice_apply(v_inv);
  PERFORM _sub_ok('HOLE[revival] setup: the unpaid invoice''s period has ended, at the tier the company had',
    (SELECT period_end <= now() AND plan = 'basic'
       FROM subscription_coverage WHERE company_id = v_co AND source = 'invoice' AND source_id = v_inv));

  v_out := _sub_do(v_owner, format('SELECT platform_company_set_plan(%L, %L)::text', v_co, 'premium'));
  PERFORM _sub_ok('HOLE[revival] setup: the owner sets premium', _sub_succeeded(v_out));
  PERFORM _sub_ok('HOLE[revival] setup: …the company holds it, and the ended invoice period stays at basic',
    (SELECT plan FROM companies WHERE id = v_co) = 'premium'
    AND (SELECT plan FROM subscription_coverage WHERE company_id = v_co AND source = 'invoice') = 'basic');

  v_out := _sub_do(v_owner, format('SELECT platform_invoice_mark_paid(%L, %s)::text', v_inv, 2000));
  PERFORM _sub_ok('HOLE[revival] setup: the invoice is then marked paid', _sub_succeeded(v_out));
  PERFORM _sub_ok('HOLE[revival] setup: …which moves its period to the month''s end, still at basic',
    (SELECT period_end > now() AND plan = 'basic'
       FROM subscription_coverage WHERE company_id = v_co AND source = 'invoice' AND source_id = v_inv));

  PERFORM _sub_ok('HOLE[revival]: the revived period decides the tier, so the owner''s premium goes back to basic — today''s behaviour, recorded; see HANDOFF.md',
    (SELECT plan FROM companies WHERE id = v_co) = 'basic');
END $$;

-- ─── 10. a period something else replaced stays replaced (20260921130000) ──
--
-- The defect: app_private.subscription_invoice_apply looked an invoice's
-- coverage row up whatever its status and set it back to active. A manual edit
-- voids every live row of the company as `replaced`, the invoice's included, so
-- the nightly invoice sweep would have re-admitted, every night, a company an
-- administrator had set to expired.
--
-- The rule since 20260921130000: a voided invoice period comes back only when
-- its own invoice voided it (`invoice_canceled`) and that invoice is no longer
-- cancelled, or when that invoice is explicitly paid. A period voided as
-- `replaced` is left exactly as it is by the sweep, by a re-apply and by
-- re-opening the invoice.
--
-- Claims about access use the current calendar month, as section 5 does, so
-- "the month has not ended" holds on every day the kit can run. Writes and the
-- reads of them are separate statements throughout (5d says why).

-- 10a. the defect: a paid invoice, a manual `expired`, the sweep
DO $$
DECLARE
  v_owner constant uuid := '50000000-0000-4000-8000-000000000001';
  v_month constant integer := extract(month FROM (now() AT TIME ZONE 'Europe/Berlin'))::integer;
  v_year  constant integer := extract(year  FROM (now() AT TIME ZONE 'Europe/Berlin'))::integer;
  v_co    uuid;
  v_inv   uuid;
  v_row   subscription_coverage%ROWTYPE;
  v_after subscription_coverage%ROWTYPE;
  v_out   text;
BEGIN
  v_co  := _sub_billed_company('void-kept');
  v_inv := _sub_invoice('void-kept', v_co, v_year, v_month, make_date(v_year, v_month, 1) + 4, 20);

  v_out := _sub_do(v_owner, format('SELECT platform_invoice_mark_paid(%L, %s)::text', v_inv, 2000));
  PERFORM _sub_ok('replaced: the invoice for this month is paid', _sub_succeeded(v_out));
  PERFORM _sub_ok('replaced: …so the company is admitted on it, and there is access to lose',
    _sub_admitted(_sub_id('user:void-kept')));

  -- The administrator's decision: the Abo-Status modal, `expired`, with an end
  -- that has passed. It records that period and voids every other live one.
  v_out := _sub_do(v_owner, format(
    'SELECT update_company_subscription_manual(%L, %L, %L, %L, NULL, %L)::text',
    v_co, 'expired', now() - interval '2 months', now() - interval '1 day', 'sub test: expired by hand'));
  PERFORM _sub_ok('replaced: the manual edit to expired answers success', _sub_succeeded(v_out));

  SELECT * INTO v_row FROM subscription_coverage
   WHERE company_id = v_co AND source = 'invoice' AND source_id = v_inv;
  PERFORM _sub_ok('replaced: …it voided the invoice''s period, as replaced',
    v_row.status = 'void' AND v_row.void_reason = 'replaced');
  PERFORM _sub_ok('replaced: …and the company is refused, expired',
    NOT _sub_admitted(_sub_id('user:void-kept'))
    AND (SELECT subscription_status FROM companies WHERE id = v_co) = 'expired');

  -- The nightly sweep, both halves, in the order the cron line runs them.
  PERFORM app_private.subscription_invoices_apply_all();
  PERFORM app_private.recompute_all_company_subscriptions();

  SELECT * INTO v_after FROM subscription_coverage WHERE id = v_row.id;
  PERFORM _sub_ok('replaced: the sweep leaves the replaced period void, and says why (before 20260921130000 it set it active again)',
    v_after.status = 'void' AND v_after.void_reason = 'replaced');
  PERFORM _sub_ok('replaced: …exactly as it was recorded: dates, grant, price and note',
    v_after.period_start = v_row.period_start
    AND v_after.period_end = v_row.period_end
    AND v_after.grants_access = v_row.grants_access
    AND v_after.price_cents IS NOT DISTINCT FROM v_row.price_cents
    AND v_after.note IS NOT DISTINCT FROM v_row.note);
  PERFORM _sub_ok('replaced: …so the company the administrator set to expired stays refused',
    NOT _sub_admitted(_sub_id('user:void-kept'))
    AND (SELECT subscription_status FROM companies WHERE id = v_co) = 'expired');

  -- Asked directly, the rule says why it did nothing.
  v_out := app_private.subscription_invoice_apply(v_inv);
  PERFORM _sub_ok(format('replaced: applied again, the rule answers superseded (answered %s)', v_out),
    v_out = 'superseded');
  PERFORM _sub_ok('replaced: …and still leaves the row void',
    (SELECT status = 'void' AND void_reason = 'replaced' FROM subscription_coverage WHERE id = v_row.id));

  -- Re-opening the invoice is an act on it, but one that withdraws access. It
  -- must not turn a replaced period into a grace window.
  v_out := _sub_do(v_owner, format('SELECT platform_invoice_mark_unpaid(%L)::text', v_inv));
  PERFORM _sub_ok('replaced: re-opening the invoice is accepted', _sub_succeeded(v_out));
  PERFORM _sub_ok('replaced: …and leaves the replaced period void',
    (SELECT status = 'void' AND void_reason = 'replaced' FROM subscription_coverage WHERE id = v_row.id));
  PERFORM _sub_ok('replaced: …so the company stays refused',
    NOT _sub_admitted(_sub_id('user:void-kept')));
  PERFORM _sub_ok('replaced: …and its audit row records why nothing moved',
    (SELECT a.after_value ->> 'coverage'
       FROM app_private.platform_audit_log a
      WHERE a.action = 'invoice.mark_unpaid' AND a.outcome = 'ok' AND a.target_id = v_inv::text
      ORDER BY a.id DESC
      LIMIT 1) = 'superseded');

  -- …and the sweep after it changes nothing either.
  PERFORM app_private.subscription_invoices_apply_all();
  PERFORM app_private.recompute_all_company_subscriptions();
  PERFORM _sub_ok('replaced: the sweep after the re-opening still leaves it void, and the company refused',
    (SELECT status = 'void' AND void_reason = 'replaced' FROM subscription_coverage WHERE id = v_row.id)
    AND NOT _sub_admitted(_sub_id('user:void-kept')));

  -- An explicit payment of that invoice is the one act that brings the period
  -- back: the money arrived after the administrator's decision.
  v_out := _sub_do(v_owner, format('SELECT platform_invoice_mark_paid(%L, %s)::text', v_inv, 2000));
  PERFORM _sub_ok('replaced: the invoice is then paid, explicitly', _sub_succeeded(v_out));

  SELECT * INTO v_after FROM subscription_coverage WHERE id = v_row.id;
  PERFORM _sub_ok('replaced: …which brings the same row back, live and granting, for the month it names',
    v_after.status = 'active' AND v_after.void_reason IS NULL AND v_after.grants_access
    AND v_after.period_end = _sub_period(v_year, v_month, 'end'));
  PERFORM _sub_ok('replaced: …still one row for the invoice',
    (SELECT count(*) FROM subscription_coverage WHERE company_id = v_co AND source = 'invoice') = 1);
  PERFORM _sub_ok('replaced: …and the company is admitted again',
    _sub_admitted(_sub_id('user:void-kept')));
END $$;

-- 10b. the other writer of `replaced`: a manual `inactive` with no date voids
--      every live row without recording one (20260919150000:1393-1398); and a
--      cancellation followed by an un-cancel does not turn that void into the
--      invoice's own
DO $$
DECLARE
  v_owner constant uuid := '50000000-0000-4000-8000-000000000001';
  v_month constant integer := extract(month FROM (now() AT TIME ZONE 'Europe/Berlin'))::integer;
  v_year  constant integer := extract(year  FROM (now() AT TIME ZONE 'Europe/Berlin'))::integer;
  v_co    uuid;
  v_inv   uuid;
  v_out   text;
BEGIN
  v_co  := _sub_billed_company('void-kept-nodate');
  v_inv := _sub_invoice('void-kept-nodate', v_co, v_year, v_month, make_date(v_year, v_month, 1) + 4, 20);

  v_out := _sub_do(v_owner, format('SELECT platform_invoice_mark_paid(%L, %s)::text', v_inv, 2000));
  PERFORM _sub_ok('replaced, no date: the invoice for this month is paid', _sub_succeeded(v_out));
  PERFORM _sub_ok('replaced, no date: …and admits the company',
    _sub_admitted(_sub_id('user:void-kept-nodate')));

  v_out := _sub_do(v_owner, format(
    'SELECT update_company_subscription_manual(%L, %L, NULL, NULL, NULL, %L)::text',
    v_co, 'inactive', 'sub test: inactive by hand'));
  PERFORM _sub_ok('replaced, no date: the manual edit to inactive answers success', _sub_succeeded(v_out));
  PERFORM _sub_ok('replaced, no date: …it voided the invoice''s period as replaced, and the company is refused',
    (SELECT status = 'void' AND void_reason = 'replaced'
       FROM subscription_coverage WHERE company_id = v_co AND source = 'invoice' AND source_id = v_inv)
    AND NOT _sub_admitted(_sub_id('user:void-kept-nodate')));

  PERFORM app_private.subscription_invoices_apply_all();
  PERFORM app_private.recompute_all_company_subscriptions();

  PERFORM _sub_ok('replaced, no date: the sweep leaves it void',
    (SELECT status = 'void' AND void_reason = 'replaced'
       FROM subscription_coverage WHERE company_id = v_co AND source = 'invoice' AND source_id = v_inv));
  PERFORM _sub_ok('replaced, no date: …and the company stays refused, inactive with no date',
    NOT _sub_admitted(_sub_id('user:void-kept-nodate'))
    AND (SELECT subscription_status = 'inactive' AND subscription_expires_at IS NULL
           FROM companies WHERE id = v_co));

  -- The reason is what tells an administrator's void from the invoice's own,
  -- so a cancellation must not relabel it: the cancel branch voids only a live
  -- row. Were it to write `invoice_canceled` over `replaced`, an un-cancel would
  -- revive what the administrator withdrew.
  v_out := _sub_do(v_owner, format('SELECT platform_invoice_cancel(%L)::text', v_inv));
  PERFORM _sub_ok('replaced, no date: cancelling the invoice afterwards is accepted', _sub_succeeded(v_out));
  PERFORM _sub_ok('replaced, no date: …and the period still says replaced, not invoice_canceled',
    (SELECT status = 'void' AND void_reason = 'replaced'
       FROM subscription_coverage WHERE company_id = v_co AND source = 'invoice' AND source_id = v_inv));

  -- The operator's un-cancel, as in 10c, and the sweep after it.
  UPDATE subscription_invoices SET status = 'paid' WHERE id = v_inv;
  PERFORM app_private.subscription_invoices_apply_all();
  PERFORM app_private.recompute_all_company_subscriptions();
  PERFORM _sub_ok('replaced, no date: un-cancelled and swept, the replaced period stays void, and the company refused',
    (SELECT status = 'void' AND void_reason = 'replaced'
       FROM subscription_coverage WHERE company_id = v_co AND source = 'invoice' AND source_id = v_inv)
    AND NOT _sub_admitted(_sub_id('user:void-kept-nodate')));
END $$;

-- 10c. the control: a period its own invoice's cancellation voided comes back
--      when that invoice is paid again, through the sweep
DO $$
DECLARE
  v_owner constant uuid := '50000000-0000-4000-8000-000000000001';
  v_month constant integer := extract(month FROM (now() AT TIME ZONE 'Europe/Berlin'))::integer;
  v_year  constant integer := extract(year  FROM (now() AT TIME ZONE 'Europe/Berlin'))::integer;
  v_co    uuid;
  v_inv   uuid;
  v_id    uuid;
  v_row   subscription_coverage%ROWTYPE;
  v_out   text;
BEGIN
  v_co  := _sub_billed_company('void-revive');
  v_inv := _sub_invoice('void-revive', v_co, v_year, v_month, make_date(v_year, v_month, 1) + 4, 20);

  v_out := _sub_do(v_owner, format('SELECT platform_invoice_mark_paid(%L, %s)::text', v_inv, 2000));
  PERFORM _sub_ok('cancelled, then paid: the invoice is paid', _sub_succeeded(v_out));
  v_out := _sub_do(v_owner, format('SELECT platform_invoice_cancel(%L)::text', v_inv));
  PERFORM _sub_ok('cancelled, then paid: …and then cancelled', _sub_succeeded(v_out));

  SELECT * INTO v_row FROM subscription_coverage
   WHERE company_id = v_co AND source = 'invoice' AND source_id = v_inv;
  v_id := v_row.id;
  PERFORM _sub_ok('cancelled, then paid: the cancellation voided the period, naming itself',
    v_row.status = 'void' AND v_row.void_reason = 'invoice_canceled');
  PERFORM _sub_ok('cancelled, then paid: …and the company is refused',
    NOT _sub_admitted(_sub_id('user:void-revive')));

  -- No RPC takes an invoice out of `canceled` — mark_paid refuses it — but the
  -- table's own UPDATE policy lets a holder of billing.manage do it, and so can
  -- an operator. This is the operator, as the owner of the table.
  UPDATE subscription_invoices SET status = 'paid' WHERE id = v_inv;

  PERFORM app_private.subscription_invoices_apply_all();
  PERFORM app_private.recompute_all_company_subscriptions();

  SELECT * INTO v_row FROM subscription_coverage WHERE id = v_id;
  PERFORM _sub_ok('cancelled, then paid: the sweep brings the same row back, live and granting, for its month',
    v_row.status = 'active' AND v_row.void_reason IS NULL AND v_row.grants_access
    AND v_row.period_end = _sub_period(v_year, v_month, 'end'));
  PERFORM _sub_ok('cancelled, then paid: …still one row for the invoice (one invoice, one period)',
    (SELECT count(*) FROM subscription_coverage WHERE company_id = v_co AND source = 'invoice') = 1);
  PERFORM _sub_ok('cancelled, then paid: …and the company is admitted again',
    _sub_admitted(_sub_id('user:void-revive')));
END $$;

-- 10d. the sweep run twice changes nothing the second time
DO $$
DECLARE
  v_rows      bigint;
  v_replaced  bigint;
  v_cov_diff  bigint;
  v_co_diff   bigint;
BEGIN
  PERFORM app_private.subscription_invoices_apply_all();
  PERFORM app_private.recompute_all_company_subscriptions();

  CREATE TEMP TABLE _sub_sweep_cov AS
    SELECT id, company_id, source, source_id, period_start, period_end, grants_access,
           plan, price_cents, status, void_reason, note
      FROM subscription_coverage;
  CREATE TEMP TABLE _sub_sweep_co AS
    SELECT id, subscription_status, subscription_expires_at, plan
      FROM companies;

  SELECT count(*) INTO v_rows FROM _sub_sweep_cov WHERE source = 'invoice';
  SELECT count(*) INTO v_replaced FROM _sub_sweep_cov
   WHERE source = 'invoice' AND status = 'void' AND void_reason = 'replaced';
  PERFORM _sub_ok(format('sweep twice: there are invoice periods to walk (%s), %s of them replaced, so the check below is not vacuous',
                         v_rows, v_replaced),
    v_rows > 0 AND v_replaced > 0);

  PERFORM app_private.subscription_invoices_apply_all();
  PERFORM app_private.recompute_all_company_subscriptions();

  SELECT count(*) INTO v_cov_diff FROM (
    (SELECT id, company_id, source, source_id, period_start, period_end, grants_access,
            plan, price_cents, status, void_reason, note FROM subscription_coverage
     EXCEPT SELECT * FROM _sub_sweep_cov)
    UNION ALL
    (SELECT * FROM _sub_sweep_cov
     EXCEPT SELECT id, company_id, source, source_id, period_start, period_end, grants_access,
                   plan, price_cents, status, void_reason, note FROM subscription_coverage)) d;
  SELECT count(*) INTO v_co_diff FROM (
    (SELECT id, subscription_status, subscription_expires_at, plan FROM companies
     EXCEPT SELECT * FROM _sub_sweep_co)
    UNION ALL
    (SELECT * FROM _sub_sweep_co
     EXCEPT SELECT id, subscription_status, subscription_expires_at, plan FROM companies)) d;

  PERFORM _sub_ok(format('sweep twice: the second run changes no coverage row (%s differ)', v_cov_diff),
    v_cov_diff = 0);
  PERFORM _sub_ok(format('sweep twice: …and no company''s status, expiry or tier (%s differ)', v_co_diff),
    v_co_diff = 0);
END $$;

DO $$ BEGIN RAISE NOTICE '── subscriptions (plan 3.F, steps U1, U2 and U3, the tier fix and the kept void): all checks passed ──'; END $$;

ROLLBACK;
