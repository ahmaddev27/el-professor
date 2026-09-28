/*
  # One Werkstatt check per car per week — keyed on the week, not on a month ordinal

  `werkstatt_checks.week_number` holds the **1..5 ordinal of the week inside its
  business month**, written by `WerkstattCheckModal` from
  `getWeekNumberForDate()`. The table's uniqueness rule was
  `UNIQUE (car_id, week_number, year)`, which reads that ordinal as if it were an
  ISO week number. It is not: week 1 of January and week 1 of February are the
  same pair, so the second one is refused.

  ## What that costs, measured rather than argued

  Measured in a throwaway Node process (Europe/Berlin and Asia/Riyadh, same
  answer) against a transliteration of `src/utils/weekCalculations.ts`. Its
  Mondays were checked against the ones PostgreSQL's `date_trunc('week', …)`
  reports for the seven live rows — 0 of 7 disagree — so the arithmetic below is
  verified, not assumed:

    · one car checked every Monday of 2026 produces **52** weeks but only **5**
      distinct `(week_number, year)` pairs: **47 of the 52 inserts are refused**
      by the old key with a duplicate-key error the screen cannot explain
      (`WerkstattCheckModal` catches `duplicate key` and prints
      `fleet.werkstattCheckDuplicate`). From the fifth check of the year onwards
      the feature is dead for that car.

    · the year is wrong for **01.–04. January** of a week whose Monday was in
      December: the modal wrote `year: selectedMonth.getFullYear()` — the
      calendar year of the navigated `Date` — while the week dropdown it picks
      from is `getWeeksOfMonth(selectedMonth)`, i.e. the weeks of the *business*
      month (`getBusinessMonth`, the month containing the Monday). For
      01.01.2026 that is week 5 of December **2025** stored under year **2026**.

  Measured on staging and production (read-only, 28.09.2026): **7 rows on each**,
  3 cars, 3 car-years, at most 3 checks in any car-year. So nothing sits at the
  cap today and this is latent — but the same read also shows the column already
  carries two different meanings: **3 of the 7 rows hold a `week_number` that is
  not the business-week ordinal of their own `check_date`** (two hold 10, the ISO
  week of 02.03.2026, one holds 4 where the ordinal is 1). A column three of
  seven rows disagree with is not a key.

  (The plan this implements said "0 of 18 car-years". The figure is 3 car-years,
  not 18; the conclusion — none at the cap, max 3, latent — is unchanged.)

  ## The new key

    UNIQUE (car_id, date_trunc('week', check_date::timestamp))

  `date_trunc('week', …)` returns the Monday 00:00 of the week, which is exactly
  the business week's own Monday ("a week belongs to the month containing its
  Monday", CLAUDE.md), so the rule the table always meant — **one check per car
  per week** — is preserved unchanged and no longer needs a month or a year to
  express it.

  The `::timestamp` cast is load-bearing. `date` casts implicitly to both
  `timestamp` and `timestamptz`; the `timestamptz` overload of `date_trunc` is
  STABLE (it reads the session's TimeZone) and PostgreSQL resolves an unqualified
  call to it, because `timestamptz` is the preferred type of the category — and a
  STABLE expression cannot be indexed. Measured on staging (PostgreSQL 17.6):
  `date_trunc(text, timestamp without time zone)` is `i` (immutable), the
  `timestamptz` overload is `s`, and `date → timestamp` is an immutable cast.
  Keep the cast.

  It is a unique **index**, not a constraint: PostgreSQL cannot put a UNIQUE
  constraint on an expression.

  ## Order, and why the index is built before the old key is dropped

  The index is created **first**, then the old constraint is dropped. A unique
  index that cannot be built aborts the transaction while the old constraint is
  still in force, so no path through this file can leave the table with neither
  key. The precheck before it (`app_private.werkstatt_check_week_collisions()`)
  exists to turn that abort into a readable message naming the car and the week —
  the index build is the wall, the precheck is the sentence. The function is kept
  rather than inlined as a one-shot DO block so that
  `tests/rls/werkstatt-checks.sql` can seed a colliding pair and assert it is
  reported; a guard nothing can exercise is a guard nobody knows still works.

  ## What is deliberately not touched

  · **`week_number` and `year` stay.** They are descriptive ordinals now, not a
    key. Nothing reads them as one: `WerkstattPage.tsx` loads by `check_date`
    between the selected week's Monday and Sunday, `OverviewPage.tsx` orders by
    `check_date`, and no component renders `week_number`. Dropping the columns
    would be a rename in disguise and would need a SCHEMA_EPOCH bump.
  · `idx_werkstatt_checks_week_year` on `(week_number, year)` is left in place.
    It supports no query in the product, but removing it is unrelated churn.
  · No policy, no grant, no trigger and no row is touched. The four tenant
    policies of 20260917130000 and the two support-write triggers of
    20260917140000 / 20260920110000 stay exactly as they are.

  **No SCHEMA_EPOCH bump.** The previous release neither reads this constraint
  nor depends on its existence — it only catches the violation and shows a toast
  — so it keeps working against the new key, and a rollback onto it is safe.
  This is the one item of this round that touches a constraint.
*/

-- The colliding pairs under the new key, as a readable list. SECURITY INVOKER
-- and in app_private, so the only callers are roles that already hold USAGE
-- there (supabase_admin runs the migrations and the RLS kit); no API role can
-- reach it. It is a reader: it writes nothing and locks nothing.
CREATE OR REPLACE FUNCTION app_private.werkstatt_check_week_collisions()
RETURNS TABLE (car_id uuid, week_start date, check_count bigint)
LANGUAGE plpgsql
SECURITY INVOKER
STABLE
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  -- Every identifier is qualified with `w.`, so none of the three OUT columns
  -- this function declares can be read as a variable reference.
  RETURN QUERY
  SELECT w.car_id,
         date_trunc('week', w.check_date::timestamp)::date,
         count(*)
    FROM public.werkstatt_checks w
   GROUP BY w.car_id, date_trunc('week', w.check_date::timestamp)::date
  HAVING count(*) > 1
   ORDER BY 1, 2;
END;
$fn$;

-- PUBLIC as well as the three API roles: EXECUTE to PUBLIC is a built-in default
-- for every new function and cannot be revoked per schema (CLAUDE.md,
-- app_private). Missing USAGE on app_private is what keeps callers out; this is
-- the second wall.
REVOKE ALL ON FUNCTION app_private.werkstatt_check_week_collisions() FROM PUBLIC, anon, authenticated, service_role;

DO $mig$
DECLARE
  v_collisions text;
  v_pairs      bigint;
BEGIN
  -- The RLS kit's fixture is a --schema=public dump and the migration chain
  -- cannot create this table at all (CLAUDE.md, Known defects), so every step
  -- here is written to pass on a database that does not have it.
  IF to_regclass('public.werkstatt_checks') IS NULL THEN
    RAISE NOTICE '20260928121500: public.werkstatt_checks does not exist here — nothing to re-key';
    RETURN;
  END IF;

  -- 1. Refuse rather than half-apply. Two checks for one car in one week cannot
  --    both survive the new key, and which one to keep is a customer's decision,
  --    not this file's.
  SELECT string_agg(format('car %s, week of %s: %s checks', c.car_id, c.week_start, c.check_count),
                    '; ' ORDER BY c.car_id, c.week_start),
         count(*)
    INTO v_collisions, v_pairs
    FROM app_private.werkstatt_check_week_collisions() c;

  IF v_pairs > 0 THEN
    RAISE EXCEPTION '20260928121500: % car/week pair(s) already hold more than one Werkstatt check, so the new unique key cannot be built: %',
      v_pairs, v_collisions
      USING HINT = 'Decide per pair which check is the real one before re-running this migration; nothing has been changed.';
  END IF;

  -- 2. The new key, built while the old one is still in force.
  IF to_regclass('public.werkstatt_checks_car_week_key') IS NULL THEN
    EXECUTE 'CREATE UNIQUE INDEX werkstatt_checks_car_week_key '
         || 'ON public.werkstatt_checks (car_id, date_trunc(''week'', check_date::timestamp))';
    RAISE NOTICE '20260928121500: werkstatt_checks_car_week_key built';
  END IF;

  -- 3. Only now the old one goes.
  EXECUTE 'ALTER TABLE public.werkstatt_checks '
       || 'DROP CONSTRAINT IF EXISTS werkstatt_checks_car_id_week_number_year_key';
END
$mig$;

DO $selfcheck$
DECLARE
  v_oid   oid;
  v_def   text;
  v_count int;
  v_role  text;
BEGIN
  -- 1. The guard exists, is what this file says it is, and no API role can call
  --    it. (app_private is unreachable for all three anyway; this is the second
  --    wall CLAUDE.md asks for.)
  SELECT p.oid INTO v_oid
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'app_private' AND p.proname = 'werkstatt_check_week_collisions';
  IF v_oid IS NULL THEN
    RAISE EXCEPTION '20260928121500 self-check: app_private.werkstatt_check_week_collisions() is missing';
  END IF;

  IF (SELECT l.lanname FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
       WHERE p.oid = v_oid) <> 'plpgsql' THEN
    RAISE EXCEPTION '20260928121500 self-check: the collision guard is not LANGUAGE plpgsql';
  END IF;

  IF (SELECT prosecdef FROM pg_proc WHERE oid = v_oid) THEN
    RAISE EXCEPTION '20260928121500 self-check: the collision guard became SECURITY DEFINER; it reads a tenant table and must stay INVOKER';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = v_oid
       AND p.proconfig IS NOT NULL
       AND EXISTS (SELECT 1 FROM unnest(p.proconfig) cfg WHERE cfg LIKE 'search\_path=%')
  ) THEN
    RAISE EXCEPTION '20260928121500 self-check: the collision guard has no pinned search_path';
  END IF;

  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role)
       AND has_function_privilege(v_role::name, v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION '20260928121500 self-check: % may execute the collision guard', v_role;
    END IF;
  END LOOP;

  -- grantee 0 is PUBLIC, which has_function_privilege() cannot be asked about.
  -- A NULL acl is not "nothing granted": it means the built-in default, which
  -- grants EXECUTE to PUBLIC — the state a plain DROP + CREATE would restore.
  IF (SELECT p.proacl IS NULL FROM pg_proc p WHERE p.oid = v_oid)
     OR EXISTS (
       SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
        WHERE p.oid = v_oid AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
     ) THEN
    RAISE EXCEPTION '20260928121500 self-check: PUBLIC may execute the collision guard';
  END IF;

  -- Everything below is about the table, so it is skipped where the migration
  -- chain cannot create it.
  IF to_regclass('public.werkstatt_checks') IS NULL THEN
    RAISE NOTICE '20260928121500 self-check: passed (no werkstatt_checks table here)';
    RETURN;
  END IF;

  -- 2. The month-ordinal key is gone, under that name and under any other: a
  --    second unique index on the same three columns would cap the table again.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.werkstatt_checks'::regclass
       AND conname = 'werkstatt_checks_car_id_week_number_year_key'
  ) THEN
    RAISE EXCEPTION '20260928121500 self-check: the old UNIQUE (car_id, week_number, year) constraint is still there';
  END IF;

  SELECT count(*) INTO v_count
    FROM pg_index i
   WHERE i.indrelid = 'public.werkstatt_checks'::regclass
     AND i.indisunique
     AND pg_get_indexdef(i.indexrelid) LIKE '%(car\_id, week\_number, year)%';
  IF v_count > 0 THEN
    RAISE EXCEPTION '20260928121500 self-check: % unique index(es) still key on (car_id, week_number, year)', v_count;
  END IF;

  -- 3. The week key is there, unique, valid, and on the immutable expression. A
  --    STABLE expression cannot be indexed at all, so an index that exists is
  --    already proof of the cast — but the text is asserted so a later
  --    restatement cannot quietly key on something else.
  IF to_regclass('public.werkstatt_checks_car_week_key') IS NULL THEN
    RAISE EXCEPTION '20260928121500 self-check: werkstatt_checks_car_week_key is missing — the table would have no uniqueness rule at all';
  END IF;

  v_def := pg_get_indexdef('public.werkstatt_checks_car_week_key'::regclass);

  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
     WHERE i.indexrelid = 'public.werkstatt_checks_car_week_key'::regclass
       AND i.indrelid   = 'public.werkstatt_checks'::regclass
       AND i.indisunique
       AND i.indisvalid
  ) THEN
    RAISE EXCEPTION '20260928121500 self-check: werkstatt_checks_car_week_key is not a valid unique index on werkstatt_checks (%)', v_def;
  END IF;

  IF strpos(v_def, 'date_trunc(''week''') = 0
     OR strpos(v_def, 'check_date') = 0
     OR strpos(v_def, 'car_id') = 0
     OR strpos(v_def, 'timestamp without time zone') = 0 THEN
    RAISE EXCEPTION '20260928121500 self-check: werkstatt_checks_car_week_key does not key on (car_id, date_trunc(''week'', check_date::timestamp)): %', v_def;
  END IF;

  -- 4. The descriptive ordinals are still there. Dropping them is a rename in
  --    disguise and would need a SCHEMA_EPOCH bump; the browser still writes
  --    both and they are NOT NULL.
  SELECT count(*) INTO v_count
    FROM pg_attribute
   WHERE attrelid = 'public.werkstatt_checks'::regclass
     AND attname IN ('week_number', 'year')
     AND attnotnull AND NOT attisdropped;
  IF v_count <> 2 THEN
    RAISE EXCEPTION '20260928121500 self-check: week_number and/or year are gone or became nullable (% of 2 present and NOT NULL)', v_count;
  END IF;

  -- 5. Nothing else about the table moved. The four tenant policies of
  --    20260917130000 and both support-write triggers of
  --    20260917140000 / 20260920110000 are what confine this table; a file that
  --    re-keyed it by recreating the table would lose them silently.
  SELECT count(*) INTO v_count
    FROM pg_policy
   WHERE polrelid = 'public.werkstatt_checks'::regclass
     AND polname IN ('werkstatt_checks_select', 'werkstatt_checks_insert',
                     'werkstatt_checks_update', 'werkstatt_checks_delete');
  IF v_count <> 4 THEN
    RAISE EXCEPTION '20260928121500 self-check: werkstatt_checks carries % of its 4 tenant policies', v_count;
  END IF;

  SELECT count(*) INTO v_count
    FROM pg_trigger
   WHERE tgrelid = 'public.werkstatt_checks'::regclass
     AND NOT tgisinternal
     AND tgname IN ('refuse_read_only_context_write', 'record_support_write');
  IF v_count <> 2 THEN
    RAISE EXCEPTION '20260928121500 self-check: werkstatt_checks carries % of its 2 support-write triggers', v_count;
  END IF;

  -- 6. And the key it now has actually holds: no car/week pair is doubled.
  IF EXISTS (SELECT 1 FROM app_private.werkstatt_check_week_collisions()) THEN
    RAISE EXCEPTION '20260928121500 self-check: a car/week pair holds more than one check although the unique index reports as valid';
  END IF;

  RAISE NOTICE '20260928121500 self-check: passed — one Werkstatt check per car per week, keyed on the week of check_date';
END
$selfcheck$;
