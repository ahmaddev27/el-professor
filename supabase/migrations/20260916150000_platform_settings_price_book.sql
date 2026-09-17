/*
  # Settings, the price book and the plan feature map

  Plan 3.9 (section 3.E). Builds on 20260916110000: platform staff, the
  capability matrix and the audit log.

  ## What was wrong

  The prices and the plan feature map lived in code, and the prices twice:

  - `src/utils/pricing.ts` priced the landing page, the signup screen and the
    platform dashboard;
  - `compute_plan_price()` (20260911120000) priced every discount redemption
    with the same formula written out again in SQL;
  - `FEATURE_MIN_PLAN` in `src/contexts/PlanContext.tsx` decided which plan
    unlocks which screen.

  Changing a price took a release, and the TypeScript and SQL copies stayed in
  step only by discipline and one parity test.

  ## The pricing rule this file preserves

  Today, in both copies:

      price per car per month   basic 20 €, advanced 40 €, premium 70 €
      fleet discount            from 11 cars 10 %, from 6 cars 5 %, else 0 %
      monthly                   cars × price per car × (1 − fleet %)
      yearly                    monthly × 12 × (1 − 10 %)
      billed                    yearly for the cycle 'yearly', monthly otherwise

  compute_plan_price also counts a NULL car count as 1, bills a count below 1
  as one car while looking its fleet tier up with the count as given, charges
  an unknown or NULL plan the basic price, and treats every cycle but 'yearly'
  as monthly. Nothing rounds: whole-euro prices and these discounts always give
  whole cents.

  ## What this adds

  - `app_private.platform_settings`: one JSON value per key, with a version
    every write bumps. Two keys are seeded, with today's values exactly:
    - `price_book`: the price per car in integer cents per plan, the fleet
      discount tiers, and the yearly discount, in whole percent;
    - `plan_features`: the minimum plan of each feature, FEATURE_MIN_PLAN as it
      stood. The browser counts a feature the map does not name as premium.
  - `public.compute_plan_price(plan, cars, cycle)` keeps its signature, grants
    and results, and reads the price book. The formula lives once, in
    `app_private.price_book_price(book, plan, cars, cycle)`. The self-check
    below compares it with 20260911120000's body on 42 combinations and nine
    edge cases, value and text.
  - `public.platform_settings_get(key)` needs `settings.read`. Billing holds
    that capability for prices only (plan 3.A), so it reads `price_book` and
    nothing else.
  - `public.platform_settings_put(key, value, expected_version)` needs
    `pricing.manage` for `price_book`, and `settings.manage` — owner only — for
    every other key, `plan_features` included: `pricing.manage` is held by
    billing as well as owner, and the feature map decides what every customer
    may open, so it follows plan 3.A's owner-only `settings.manage` rather than
    the prices. It validates the value's shape for its key, refuses a stale
    version, and records the value before and after. A key without a validator
    is refused: plan 3.10 and 3.11 add their validators, and seed their keys,
    in the migration that introduces them.
  - `public.get_public_config()`, for anyone: the price book and the trial
    length. `public.get_app_config()`, for signed-in users: the price book,
    the feature map, the trial length, and an empty `feature_flags` and
    `announcements` until plan 3.11 fills them.
  - `public.platform_audit_record` is **not** redefined here. Plan 3.5's
    `20260916150000_platform_audit_record_allowlist.sql` owns it and admits only
    the actions in `app_private.platform_edge_audit_actions()`, which names no
    `platform_settings` action — so a settings row cannot be forged through that
    door, and this file, which sorts after it, must not `CREATE OR REPLACE` it:
    that would silently drop both of its rules. Self-check 8 asserts the refusal
    instead (CLAUDE.md, "Platform staff, capabilities and the audit log").

  ## Refusals and the audit log

  Outcomes are return values, never exceptions, so the audit row of a refused
  call commits with it. Only a broken argument contract (a NULL or malformed
  key, a NULL value or version) raises 22023. Every call by an active staff
  role is recorded: a read as category `read`, a write as `settings`, a read
  row naming the version it returned and never the value. As in
  platform_audit_record, a caller without an active staff role is refused
  without a row, since any signed-in company user could otherwise fill the
  append-only log.

  ## Money

  Prices are integer cents and percentages whole numbers. compute_plan_price
  returns euros as numeric, as before, and computes exactly without rounding.
  Today's book never yields a fraction of a cent; whether a later book that
  does is rounded, and how, is open decision D9. The plans stay the three fixed
  ones (open decision D11): a price book names exactly basic, advanced and
  premium.

  The trial length stays the constant app_private.signup_insert_company
  applies until plan 3.10 moves it into the settings. get_public_config reads
  it from app_private.signup_trial_days(), and the self-check compares the two.

  ## Ownership

  compute_plan_price becomes SECURITY DEFINER and reaches app_private, so it is
  handed to the migration role, as every such function (20260916110010,
  "Ownership"). A SECURITY DEFINER function that calls it runs as its own
  owner; where that owner is `postgres`, as `redeem_discount_code` may be on
  the real databases, the owner would lose EXECUTE with the ownership. Each
  such owner is granted EXECUTE by name, and the self-check fails the release
  if one lacks it.

  ## Compatibility

  Backward compatible, no SCHEMA_EPOCH bump. The previous release prices the
  same in TypeScript and calls compute_plan_price with the same signature.
  After a price change, a rollback shows the old prices on screen while the
  database charges the new ones.
*/

-- ─── The settings table ─────────────────────────────────────────────────────

CREATE TABLE app_private.platform_settings (
  key        text        PRIMARY KEY
                         CHECK (length(key) <= 100 AND key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
  value      jsonb       NOT NULL,
  version    integer     NOT NULL DEFAULT 1 CHECK (version >= 1),
  -- No foreign key: whoever saved a value may leave later. The audit log keeps
  -- every change.
  updated_by uuid        NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Today's values, exactly. src/lib/appConfigSeed.ts holds the same two
-- documents for the browser, and src/lib/appConfigSeed.test.ts fails when the
-- two copies differ.
INSERT INTO app_private.platform_settings (key, value) VALUES
  ('price_book', $seed_price_book$
{
  "price_per_car_cents": { "basic": 2000, "advanced": 4000, "premium": 7000 },
  "fleet_discount_tiers": [
    { "min_cars": 6, "percent": 5 },
    { "min_cars": 11, "percent": 10 }
  ],
  "yearly_discount_percent": 10
}
$seed_price_book$::jsonb),
  ('plan_features', $seed_plan_features$
{
  "overview": "basic",
  "belege": "basic",
  "fahrer": "basic",
  "fahrzeuge": "basic",
  "umsaetze": "basic",
  "fixkosten": "basic",
  "bargeldbestand": "basic",
  "werkstatt": "advanced",
  "abrechnung": "advanced",
  "notizen": "advanced",
  "rollen_nutzer": "advanced",
  "benachrichtigungen": "advanced",
  "gehaelter": "premium",
  "dokumente": "premium",
  "trinkgeld_quittung": "premium",
  "stundennachweis": "premium"
}
$seed_plan_features$::jsonb);

-- ─── Helpers ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION app_private.platform_setting_value(p_key text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN (SELECT s.value FROM app_private.platform_settings s WHERE s.key = p_key);
END;
$$;

-- The pricing slice: the keys pricing.manage writes, and all billing may read.
--
-- `plan_features` is deliberately NOT one of them. pricing.manage is held by
-- owner AND billing, so grouping the feature map here would let a billing
-- account rewrite which plan unlocks which screen for every customer — and
-- because the validator accepts a partial map on purpose and the browser reads
-- a feature the map does not name as premium (src/utils/planFeatures.ts), one
-- billing write of `{}` would lock every gated screen for every non-trial
-- company on basic or advanced. Plan 3.A puts prices under billing's
-- settings.read "(الأسعار)" and lists "ميزات" (features) under the owner-only
-- settings.manage, so the feature map follows settings.manage.
CREATE OR REPLACE FUNCTION app_private.platform_setting_is_pricing(p_key text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN coalesce(p_key = 'price_book', false);
END;
$$;

-- Whether a platform role may read one key. settings.read, and billing holds
-- that capability for the prices only (plan 3.A: "settings.read … billing ✓
-- (prices)"), which no single capability can say.
CREATE OR REPLACE FUNCTION app_private.platform_settings_readable(p_role text, p_key text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN coalesce(
    app_private.platform_role_can(p_role, 'settings.read')
    AND (app_private.platform_setting_is_pricing(p_key) OR p_role IS DISTINCT FROM 'billing'),
    false);
END;
$$;

CREATE OR REPLACE FUNCTION app_private.platform_setting_write_capability(p_key text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN CASE WHEN app_private.platform_setting_is_pricing(p_key) THEN 'pricing.manage' ELSE 'settings.manage' END;
END;
$$;

-- The keys of a JSON object in byte order, or NULL for anything that is not an
-- object.
CREATE OR REPLACE FUNCTION app_private.settings_object_keys(p_value jsonb)
RETURNS text[]
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF jsonb_typeof(p_value) IS DISTINCT FROM 'object' THEN
    RETURN NULL;
  END IF;
  RETURN coalesce((SELECT array_agg(k.key ORDER BY k.key COLLATE "C")
                     FROM jsonb_object_keys(p_value) AS k(key)),
                  ARRAY[]::text[]);
END;
$$;

-- Whether a JSON value is a whole number within [p_min, p_max]. 5.0 counts.
CREATE OR REPLACE FUNCTION app_private.settings_integer_between(p_value jsonb, p_min integer, p_max integer)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_number numeric;
BEGIN
  IF jsonb_typeof(p_value) IS DISTINCT FROM 'number' THEN
    RETURN false;
  END IF;
  v_number := (p_value #>> '{}')::numeric;
  RETURN v_number = trunc(v_number) AND v_number >= p_min AND v_number <= p_max;
END;
$$;

-- What is wrong with a value for a key, as a short fixed path, or NULL when
-- nothing is. 'unknown_key' for a key without a validator. The limits are
-- sanity bounds that keep every product of the price formula exact in the
-- browser's floating point, not business rules; src/utils/pricing.ts reads a
-- book with the same ones.
CREATE OR REPLACE FUNCTION app_private.platform_settings_problem(p_key text, p_value jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_max_value_bytes CONSTANT integer := 16384;
  c_max_cents       CONSTANT integer := 1000000;   -- 10.000,00 € per car per month
  c_max_tiers       CONSTANT integer := 20;
  c_max_min_cars    CONSTANT integer := 100000;
  c_max_features    CONSTANT integer := 200;
  -- Open decision D11: the three plans are fixed until the owner decides
  -- otherwise, so a price book names exactly these, in byte order.
  c_plans           CONSTANT text[]  := ARRAY['advanced', 'basic', 'premium'];

  v_part  jsonb;
  v_tier  jsonb;
  v_plan  text;
  v_index integer;
  v_prev  integer;
  v_entry record;
BEGIN
  IF p_key IS NULL OR p_key NOT IN ('price_book', 'plan_features') THEN
    RETURN 'unknown_key';
  END IF;
  IF p_value IS NULL OR octet_length(p_value::text) > c_max_value_bytes THEN
    RETURN 'value_size';
  END IF;

  IF p_key = 'price_book' THEN
    IF app_private.settings_object_keys(p_value)
       IS DISTINCT FROM ARRAY['fleet_discount_tiers', 'price_per_car_cents', 'yearly_discount_percent'] THEN
      RETURN 'price_book';
    END IF;

    v_part := p_value -> 'price_per_car_cents';
    IF app_private.settings_object_keys(v_part) IS DISTINCT FROM c_plans THEN
      RETURN 'price_book.price_per_car_cents';
    END IF;
    FOREACH v_plan IN ARRAY c_plans LOOP
      IF NOT app_private.settings_integer_between(v_part -> v_plan, 0, c_max_cents) THEN
        RETURN 'price_book.price_per_car_cents.' || v_plan;
      END IF;
    END LOOP;

    v_part := p_value -> 'fleet_discount_tiers';
    IF jsonb_typeof(v_part) IS DISTINCT FROM 'array' THEN
      RETURN 'price_book.fleet_discount_tiers';
    END IF;
    IF jsonb_array_length(v_part) > c_max_tiers THEN
      RETURN 'price_book.fleet_discount_tiers';
    END IF;
    v_prev := 0;
    FOR v_index IN 0 .. jsonb_array_length(v_part) - 1 LOOP
      v_tier := v_part -> v_index;
      IF app_private.settings_object_keys(v_tier) IS DISTINCT FROM ARRAY['min_cars', 'percent'] THEN
        RETURN 'price_book.fleet_discount_tiers.' || v_index;
      END IF;
      IF NOT app_private.settings_integer_between(v_tier -> 'min_cars', 1, c_max_min_cars)
         OR NOT app_private.settings_integer_between(v_tier -> 'percent', 0, 100) THEN
        RETURN 'price_book.fleet_discount_tiers.' || v_index;
      END IF;
      -- Sorted by min_cars, strictly increasing, so the tier a car count
      -- reaches is never ambiguous.
      IF (v_tier ->> 'min_cars')::integer <= v_prev THEN
        RETURN 'price_book.fleet_discount_tiers.' || v_index;
      END IF;
      v_prev := (v_tier ->> 'min_cars')::integer;
    END LOOP;

    IF NOT app_private.settings_integer_between(p_value -> 'yearly_discount_percent', 0, 100) THEN
      RETURN 'price_book.yearly_discount_percent';
    END IF;
    RETURN NULL;
  END IF;

  -- plan_features: feature key -> the minimum plan. A feature it does not name
  -- counts as premium in the browser, so a partial map is valid.
  IF jsonb_typeof(p_value) IS DISTINCT FROM 'object' THEN
    RETURN 'plan_features';
  END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p_value)) > c_max_features THEN
    RETURN 'plan_features';
  END IF;
  FOR v_entry IN
    SELECT e.key, e.value FROM jsonb_each(p_value) AS e ORDER BY e.key COLLATE "C"
  LOOP
    IF length(v_entry.key) > 60 OR v_entry.key !~ '^[a-z][a-z0-9_]*$' THEN
      RETURN 'plan_features.key';
    END IF;
    IF jsonb_typeof(v_entry.value) IS DISTINCT FROM 'string'
       OR (v_entry.value #>> '{}') <> ALL (c_plans) THEN
      RETURN 'plan_features.' || v_entry.key;
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

-- The price of a plan, a car count and a billing cycle under one price book,
-- in euros. The rule of the header, with the book's numbers in place of the
-- constants. The arithmetic mirrors 20260911120000 step for step, so today's
-- book returns the same numeric with the same scale: 114.00, 1231.2000.
CREATE OR REPLACE FUNCTION app_private.price_book_price(
  p_book          jsonb,
  p_plan          text,
  p_car_limit     integer,
  p_billing_cycle text
)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_tier_cars   integer := coalesce(p_car_limit, 1);
  v_billed_cars integer := greatest(coalesce(p_car_limit, 1), 1);
  v_cents       numeric;
  v_fleet_pct   numeric;
  v_monthly     numeric;
BEGIN
  -- An unknown or NULL plan pays the basic price, as the old CASE's ELSE did.
  v_cents := coalesce((p_book -> 'price_per_car_cents' ->> p_plan)::numeric,
                      (p_book -> 'price_per_car_cents' ->> 'basic')::numeric);

  SELECT (t.tier ->> 'percent')::numeric
    INTO v_fleet_pct
    FROM jsonb_array_elements(p_book -> 'fleet_discount_tiers') AS t(tier)
   WHERE (t.tier ->> 'min_cars')::integer <= v_tier_cars
   ORDER BY (t.tier ->> 'min_cars')::integer DESC
   LIMIT 1;

  v_monthly := v_billed_cars
             * trim_scale(v_cents * 0.01)
             * (1 - CASE WHEN coalesce(v_fleet_pct, 0) = 0 THEN 0 ELSE v_fleet_pct * 0.01 END);

  IF p_billing_cycle = 'yearly' THEN
    RETURN v_monthly * 12 * (1 - (p_book ->> 'yearly_discount_percent')::numeric * 0.01);
  END IF;
  RETURN v_monthly;
END;
$$;

-- The trial length of a new company, in days: signup_insert_company's
-- c_trial_length until plan 3.10 moves the trial into the settings. The
-- self-check below and tests/rls/pricing.sql compare the two.
CREATE OR REPLACE FUNCTION app_private.signup_trial_days()
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN 14;
END;
$$;

-- ─── compute_plan_price reads the price book ────────────────────────────────

CREATE OR REPLACE FUNCTION public.compute_plan_price(
  p_plan          text,
  p_car_limit     integer,
  p_billing_cycle text
)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_book jsonb := app_private.platform_setting_value('price_book');
BEGIN
  -- Fail closed: no price book, no price. A NULL would reach
  -- discount_code_redemptions as a NOT NULL violation further down anyway.
  IF v_book IS NULL THEN
    RAISE EXCEPTION 'compute_plan_price: the price_book setting is missing' USING ERRCODE = 'P0002';
  END IF;
  RETURN app_private.price_book_price(v_book, p_plan, p_car_limit, p_billing_cycle);
END;
$$;

ALTER FUNCTION public.compute_plan_price(text, integer, text) OWNER TO CURRENT_USER;

COMMENT ON FUNCTION public.compute_plan_price(text, integer, text) IS
  'The price of a plan, car count and billing cycle under the price_book setting (app_private.platform_settings), in euros. calcPricing() in src/utils/pricing.ts computes the same from the same book.';

-- ─── Reading and writing a setting ──────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.platform_settings_get(p_key text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_role text := app_private.platform_staff_role_of(auth.uid());
  v_row  app_private.platform_settings%ROWTYPE;
BEGIN
  IF p_key IS NULL OR length(p_key) > 100 OR p_key !~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$' THEN
    RAISE EXCEPTION 'platform_settings_get: invalid arguments' USING ERRCODE = '22023';
  END IF;

  -- Not platform staff: refused, and not recorded (see the header).
  IF v_role IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'forbidden');
  END IF;

  -- Refused before the row is looked up, so a refusal says nothing about
  -- whether the key exists.
  IF NOT app_private.platform_settings_readable(v_role, p_key) THEN
    PERFORM app_private.audit_write('read', 'platform_settings.get', 'denied', NULL,
                                    'platform_setting', p_key);
    RETURN jsonb_build_object('ok', false, 'reason', 'forbidden');
  END IF;

  SELECT * INTO v_row FROM app_private.platform_settings s WHERE s.key = p_key;
  IF NOT FOUND THEN
    PERFORM app_private.audit_write('read', 'platform_settings.get', 'error', NULL,
                                    'platform_setting', p_key, NULL,
                                    jsonb_build_object('reason', 'not_found'));
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  -- The row names what was read, never the value itself.
  PERFORM app_private.audit_write('read', 'platform_settings.get', 'ok', NULL,
                                  'platform_setting', p_key, NULL,
                                  jsonb_build_object('version', v_row.version));

  RETURN jsonb_build_object(
    'ok',         true,
    'key',        v_row.key,
    'value',      v_row.value,
    'version',    v_row.version,
    'updated_at', v_row.updated_at,
    'updated_by', v_row.updated_by
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.platform_settings_put(
  p_key              text,
  p_value            jsonb,
  p_expected_version integer
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_role    text := app_private.platform_staff_role_of(auth.uid());
  v_problem text;
  v_reason  text;
  v_old     app_private.platform_settings%ROWTYPE;
  v_new     app_private.platform_settings%ROWTYPE;
BEGIN
  IF p_key IS NULL OR length(p_key) > 100 OR p_key !~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'
     OR p_value IS NULL OR p_expected_version IS NULL THEN
    RAISE EXCEPTION 'platform_settings_put: invalid arguments' USING ERRCODE = '22023';
  END IF;

  -- Not platform staff: refused, and not recorded (see the header).
  IF v_role IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'forbidden');
  END IF;

  IF NOT app_private.platform_role_can(v_role, app_private.platform_setting_write_capability(p_key)) THEN
    PERFORM app_private.audit_write('settings', 'platform_settings.put', 'denied', NULL,
                                    'platform_setting', p_key);
    RETURN jsonb_build_object('ok', false, 'reason', 'forbidden');
  END IF;

  v_problem := app_private.platform_settings_problem(p_key, p_value);
  IF v_problem IS NOT NULL THEN
    v_reason := CASE WHEN v_problem = 'unknown_key' THEN 'unknown_key' ELSE 'invalid_value' END;
    PERFORM app_private.audit_write('settings', 'platform_settings.put', 'error', NULL,
                                    'platform_setting', p_key, NULL,
                                    jsonb_build_object('reason', v_reason, 'problem', v_problem));
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'problem', v_problem);
  END IF;

  -- The lock serialises two saves of the same key, so both cannot pass the
  -- version check.
  SELECT * INTO v_old FROM app_private.platform_settings s WHERE s.key = p_key FOR UPDATE;
  IF NOT FOUND THEN
    -- Every key with a validator is seeded by the migration that adds the
    -- validator; this is a broken release, not a user error.
    PERFORM app_private.audit_write('settings', 'platform_settings.put', 'error', NULL,
                                    'platform_setting', p_key, NULL,
                                    jsonb_build_object('reason', 'not_found'));
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  IF v_old.version IS DISTINCT FROM p_expected_version THEN
    PERFORM app_private.audit_write('settings', 'platform_settings.put', 'error', NULL,
                                    'platform_setting', p_key, NULL,
                                    jsonb_build_object('reason', 'version_conflict',
                                                       'expected_version', p_expected_version,
                                                       'current_version', v_old.version));
    RETURN jsonb_build_object('ok', false, 'reason', 'version_conflict', 'current_version', v_old.version);
  END IF;

  UPDATE app_private.platform_settings s
     SET value      = p_value,
         version    = s.version + 1,
         updated_by = v_uid,
         updated_at = now()
   WHERE s.key = p_key
  RETURNING * INTO v_new;

  PERFORM app_private.audit_write('settings', 'platform_settings.put', 'ok', NULL,
                                  'platform_setting', p_key,
                                  jsonb_build_object('version', v_old.version, 'value', v_old.value),
                                  jsonb_build_object('version', v_new.version, 'value', v_new.value));

  RETURN jsonb_build_object(
    'ok',         true,
    'key',        v_new.key,
    'value',      v_new.value,
    'version',    v_new.version,
    'updated_at', v_new.updated_at,
    'updated_by', v_new.updated_by
  );
END;
$$;

-- ─── Configuration for the app ──────────────────────────────────────────────

-- For the landing page and the signup screen, before anyone is signed in.
-- Public data only: nothing here is a platform read, so nothing is recorded.
CREATE OR REPLACE FUNCTION public.get_public_config()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN jsonb_build_object(
    'price_book', app_private.platform_setting_value('price_book'),
    'trial_days', app_private.signup_trial_days()
  );
END;
$$;

-- For every signed-in screen. feature_flags and announcements stay empty until
-- plan 3.11 builds them; the keys exist so the browser's shape does not change
-- then.
CREATE OR REPLACE FUNCTION public.get_app_config()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN jsonb_build_object(
    'price_book',    app_private.platform_setting_value('price_book'),
    'plan_features', app_private.platform_setting_value('plan_features'),
    'trial_days',    app_private.signup_trial_days(),
    'feature_flags', '{}'::jsonb,
    'announcements', '[]'::jsonb
  );
END;
$$;

-- ─── Ownership ──────────────────────────────────────────────────────────────

-- Each function here reaches app_private, which only its owner or a superuser
-- can (20260916110010, "Ownership").
--
-- platform_audit_record is deliberately NOT redefined in this file.
-- 20260916150000_platform_audit_record_allowlist.sql (plan 3.5) is its live
-- definition and carries two rules at once: the namespaces the database writes
-- itself, and the action allow-list in
-- app_private.platform_edge_audit_actions(). This file sorts after that one, so
-- a CREATE OR REPLACE here would silently drop both. It is also unnecessary:
-- `platform_settings.get` and `platform_settings.put` are not on the allow-list,
-- so the door already refuses them with 22023, which is a stricter guard than a
-- reserved namespace. Self-check 8 below asserts exactly that, so this file
-- still fails the release if the property it depends on ever goes away.
ALTER FUNCTION public.platform_settings_get(text) OWNER TO CURRENT_USER;
ALTER FUNCTION public.platform_settings_put(text, jsonb, integer) OWNER TO CURRENT_USER;
ALTER FUNCTION public.get_public_config() OWNER TO CURRENT_USER;
ALTER FUNCTION public.get_app_config() OWNER TO CURRENT_USER;

-- ─── Privileges ─────────────────────────────────────────────────────────────

REVOKE ALL ON TABLE app_private.platform_settings FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION app_private.platform_setting_value(text)                        FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.platform_setting_is_pricing(text)                   FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.platform_settings_readable(text, text)              FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.platform_setting_write_capability(text)             FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.settings_object_keys(jsonb)                         FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.settings_integer_between(jsonb, integer, integer)   FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.platform_settings_problem(text, jsonb)              FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.price_book_price(jsonb, text, integer, text)        FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.signup_trial_days()                                 FROM PUBLIC, anon, authenticated, service_role;

-- As 20260915120000 left it: signed-in screens and the service role.
REVOKE ALL ON FUNCTION public.compute_plan_price(text, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.compute_plan_price(text, integer, text) TO authenticated, service_role;

-- The platform's settings screens (plan 3.6c), signed in.
REVOKE ALL ON FUNCTION public.platform_settings_get(text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_settings_get(text) TO authenticated;

REVOKE ALL ON FUNCTION public.platform_settings_put(text, jsonb, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_settings_put(text, jsonb, integer) TO authenticated;

-- The landing page and the signup screen call it anonymously; a signed-in
-- visitor's client sends its JWT instead.
REVOKE ALL ON FUNCTION public.get_public_config() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_public_config() TO anon, authenticated;

REVOKE ALL ON FUNCTION public.get_app_config() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_app_config() TO authenticated;

-- ─── Callers of compute_plan_price keep EXECUTE ─────────────────────────────

-- A SECURITY DEFINER function runs as its owner. Before this file, an owner of
-- compute_plan_price could call it without a grant; with the ownership handed
-- over above, a caller owned by that role (redeem_discount_code, where
-- `postgres` owns both) would fail. Each such owner is granted EXECUTE by name,
-- which is exactly what it held before.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT owner_role.rolname
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_roles owner_role ON owner_role.oid = p.proowner
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND p.prosecdef
       AND p.oid <> 'public.compute_plan_price(text,integer,text)'::regprocedure
       AND p.prosrc ~ 'compute_plan_price\s*\('
       AND NOT has_function_privilege(owner_role.oid, 'public.compute_plan_price(text,integer,text)'::regprocedure, 'EXECUTE')
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.compute_plan_price(text, integer, text) TO %I', r.rolname);
    RAISE NOTICE '20260916150000: % owns a SECURITY DEFINER function that calls compute_plan_price and keeps EXECUTE on it', r.rolname;
  END LOOP;
END $$;

-- ─── Self-check ─────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_role    text;
  v_wrong   text;
  v_grid    integer;
  v_trial   text;
  v_ns      text;
BEGIN
  -- 1. Nobody the API authenticates as reaches the settings table.
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_schema_privilege(v_role, 'app_private', 'USAGE')
       OR has_table_privilege(v_role, 'app_private.platform_settings',
                              'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') THEN
      RAISE EXCEPTION '20260916150000 self-check: % reaches app_private.platform_settings', v_role;
    END IF;
  END LOOP;

  -- 2. Every function here: SECURITY DEFINER where it should be, a pinned
  --    search_path, an owner that reaches app_private, and exactly the stated
  --    EXECUTE grants.
  SELECT string_agg(format('%s (%s)', f.sig, f.problem), '; ') INTO v_wrong
    FROM (
      SELECT v.sig, CASE
               WHEN to_regprocedure(v.sig) IS NULL THEN 'missing'
               WHEN (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(v.sig)) IS DISTINCT FROM v.definer
                 THEN 'SECURITY DEFINER should be ' || v.definer
               WHEN NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proconfig) c(setting)
                                 WHERE p.oid = to_regprocedure(v.sig) AND c.setting LIKE 'search_path=%')
                 THEN 'no pinned search_path'
               WHEN v.definer AND NOT EXISTS (
                      SELECT 1
                        FROM pg_proc p
                        JOIN pg_roles r ON r.oid = p.proowner
                       WHERE p.oid = to_regprocedure(v.sig)
                         AND (r.rolsuper OR r.oid = (SELECT nspowner FROM pg_namespace WHERE nspname = 'app_private')))
                 THEN 'owner can call no app_private helper'
               WHEN has_function_privilege('anon', to_regprocedure(v.sig), 'EXECUTE') IS DISTINCT FROM v.anon
                 THEN 'anon EXECUTE should be ' || v.anon
               WHEN has_function_privilege('authenticated', to_regprocedure(v.sig), 'EXECUTE') IS DISTINCT FROM v.authn
                 THEN 'authenticated EXECUTE should be ' || v.authn
               WHEN has_function_privilege('service_role', to_regprocedure(v.sig), 'EXECUTE') IS DISTINCT FROM v.service
                 THEN 'service_role EXECUTE should be ' || v.service
             END AS problem
        FROM (VALUES
          -- signature                                                                     definer anon   authn  service
          ('public.compute_plan_price(text,integer,text)',                                 true,   false, true,  true),
          ('public.platform_settings_get(text)',                                           true,   false, true,  false),
          ('public.platform_settings_put(text,jsonb,integer)',                             true,   false, true,  false),
          ('public.get_public_config()',                                                   true,   true,  true,  false),
          ('public.get_app_config()',                                                      true,   false, true,  false),
          ('app_private.platform_setting_value(text)',                                     false,  false, false, false),
          ('app_private.platform_setting_is_pricing(text)',                                false,  false, false, false),
          ('app_private.platform_settings_readable(text,text)',                            false,  false, false, false),
          ('app_private.platform_setting_write_capability(text)',                          false,  false, false, false),
          ('app_private.settings_object_keys(jsonb)',                                      false,  false, false, false),
          ('app_private.settings_integer_between(jsonb,integer,integer)',                  false,  false, false, false),
          ('app_private.platform_settings_problem(text,jsonb)',                            false,  false, false, false),
          ('app_private.price_book_price(jsonb,text,integer,text)',                        false,  false, false, false),
          ('app_private.signup_trial_days()',                                              false,  false, false, false)
        ) AS v(sig, definer, anon, authn, service)
    ) f
   WHERE f.problem IS NOT NULL;

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '20260916150000 self-check: %', v_wrong;
  END IF;

  -- 3. The owner of every SECURITY DEFINER function that calls
  --    compute_plan_price may execute it.
  SELECT string_agg(format('%s owned by %s', p.oid::regprocedure, owner_role.rolname), ', ') INTO v_wrong
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_roles owner_role ON owner_role.oid = p.proowner
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND p.prosecdef
     AND p.oid <> 'public.compute_plan_price(text,integer,text)'::regprocedure
     AND p.prosrc ~ 'compute_plan_price\s*\('
     AND NOT has_function_privilege(owner_role.oid, 'public.compute_plan_price(text,integer,text)'::regprocedure, 'EXECUTE');

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '20260916150000 self-check: cannot execute compute_plan_price: %', v_wrong;
  END IF;

  -- 4. The seeds pass their own validators.
  SELECT string_agg(format('%s: %s', s.key, app_private.platform_settings_problem(s.key, s.value)), ', ') INTO v_wrong
    FROM app_private.platform_settings s
   WHERE app_private.platform_settings_problem(s.key, s.value) IS NOT NULL;

  IF v_wrong IS NOT NULL OR (SELECT count(*) FROM app_private.platform_settings) <> 2
     OR (SELECT count(*) FROM jsonb_object_keys(app_private.platform_setting_value('plan_features'))) <> 16 THEN
    RAISE EXCEPTION '20260916150000 self-check: the seeded settings are not the two valid documents of this file: %',
      coalesce(v_wrong, 'wrong row or feature count');
  END IF;

  -- 5. compute_plan_price answers what 20260911120000's body answered: every
  --    plan and cycle at the car counts on either side of each fleet tier,
  --    and nine edge cases. Value and text, so even the scale stays.
  WITH cases AS (
    SELECT p.plan, d.cars, e.cycle, true AS grid
      FROM (VALUES ('basic'), ('advanced'), ('premium')) AS p(plan)
     CROSS JOIN (VALUES (1), (3), (5), (6), (10), (11), (25)) AS d(cars)
     CROSS JOIN (VALUES ('monthly'), ('yearly')) AS e(cycle)
    UNION ALL
    SELECT x.plan, x.cars, x.cycle, false
      FROM (VALUES
        ('basic',    NULL::integer, 'monthly'),
        ('premium',  0,             'yearly'),
        ('advanced', -3,            'monthly'),
        ('gold',     5,             'monthly'),
        (NULL,       11,            'yearly'),
        ('Basic',    6,             'yearly'),
        ('basic',    6,             'weekly'),
        ('advanced', 6,             NULL),
        ('premium',  1000,          'yearly')
      ) AS x(plan, cars, cycle)
  ),
  compared AS (
    SELECT c.plan, c.cars, c.cycle, c.grid,
           -- 20260911120000's body, verbatim, with its parameters substituted.
           (SELECT CASE WHEN c.cycle = 'yearly' THEN q.monthly * 12 * 0.90 ELSE q.monthly END
              FROM (SELECT greatest(coalesce(c.cars, 1), 1)
                         * CASE c.plan WHEN 'basic' THEN 20 WHEN 'advanced' THEN 40 WHEN 'premium' THEN 70 ELSE 20 END
                         * (1 - CASE WHEN coalesce(c.cars, 1) >= 11 THEN 0.10
                                     WHEN coalesce(c.cars, 1) >= 6  THEN 0.05
                                     ELSE 0 END) AS monthly) AS q) AS old_price,
           public.compute_plan_price(c.plan, c.cars, c.cycle) AS new_price
      FROM cases c
  )
  SELECT count(*) FILTER (WHERE grid),
         string_agg(format('%s|%s|%s: old %s, new %s', plan, cars, cycle, old_price, new_price), '; ')
           FILTER (WHERE old_price IS DISTINCT FROM new_price OR old_price::text IS DISTINCT FROM new_price::text)
    INTO v_grid, v_wrong
    FROM compared;

  IF v_grid <> 42 THEN
    RAISE EXCEPTION '20260916150000 self-check: compared % grid combinations, not 42', v_grid;
  END IF;
  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '20260916150000 self-check: compute_plan_price no longer answers what it did: %', v_wrong;
  END IF;

  -- 6. The trial length get_public_config reports is the one a signup gets.
  SELECT substring(p.prosrc FROM 'c_trial_length\s+CONSTANT\s+interval\s*:=\s*interval\s*''(\d+) days''')
    INTO v_trial
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('app_private.signup_insert_company(uuid,text,text,text,text,text,integer,uuid,text,text)');

  IF v_trial IS DISTINCT FROM app_private.signup_trial_days()::text THEN
    RAISE EXCEPTION '20260916150000 self-check: signup_insert_company applies % trial days, signup_trial_days() says %',
      coalesce(v_trial, 'an unreadable number of'), app_private.signup_trial_days();
  END IF;

  -- 7. The capabilities named here exist; a typo would refuse everyone.
  IF (SELECT count(DISTINCT m.capability)
        FROM app_private.platform_capability_matrix() m
       WHERE m.capability IN ('settings.read', 'settings.manage', 'pricing.manage')) <> 3 THEN
    RAISE EXCEPTION '20260916150000 self-check: a capability this file names is not in the matrix';
  END IF;

  -- 8. Nothing may forge a platform_settings audit row through
  --    platform_audit_record. This file deliberately does not redefine that
  --    function: 20260916150000_platform_audit_record_allowlist.sql (plan 3.5)
  --    owns it and admits only the actions in
  --    app_private.platform_edge_audit_actions(), which lists no
  --    platform_settings action. The settings rows above are written inside the
  --    database instead. Asserted rather than assumed, so the release fails if
  --    that ever changes. Every check below the argument contract runs before
  --    the staff lookup, so each raises here too, where auth.uid() is NULL.
  FOREACH v_ns IN ARRAY ARRAY['platform_settings.get', 'platform_settings.put', 'platform_settings',
                              'platform_staff.delete', 'legacy.x', 'auth.x', 'platform_read.x'] LOOP
    BEGIN
      PERFORM public.platform_audit_record('read', v_ns, 'ok');
      RAISE EXCEPTION '20260916150000 self-check: platform_audit_record accepts the forbidden action %', v_ns;
    EXCEPTION
      WHEN invalid_parameter_value THEN NULL;   -- 22023: the refusal this pins
    END;
  END LOOP;
END $$;
