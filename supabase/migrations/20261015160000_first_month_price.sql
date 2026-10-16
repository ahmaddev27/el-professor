/*
  The first month costs a flat price, then the price book applies per car
  (owner's decision, 15.10.2026: "first month has a price of 200 Euro ignoring
  the number of cars, then each car according to the price list we have").

  ## Why

  Nothing in the code knew about a first month. The panel priced a premium
  company with five cars at 350,00 EUR a month from the price book while its
  invoice was raised at 200,00 EUR from `subscription_plans.monthly_price`.
  Both figures were "right"; they were the first month and the rest.

  ## The rule

  A company's FIRST INVOICE is the flat price in the book, whatever its plan,
  car count or billing cycle. Every later invoice is the book per car, as
  before. "First" means: the company has no earlier invoice that is not
  cancelled. "Earlier" is by period (year, month), not by creation, so raising
  an October invoice after a November one exists still raises the first.
  A cancelled invoice never happened as far as this rule is concerned: a first
  invoice that was cancelled and re-raised is still the first.

  ## One flat figure, not one per plan

  The decision says "200 Euro ignoring the number of cars" and names no plan.
  A per-plan figure would be a second price list nobody asked for. The book
  carries one key, `first_month_cents` (integer cents), beside the three it had.

  ## The book

  `first_month_cents` is OPTIONAL. A book without it is exactly the book every
  earlier release saved and reads, and prices every invoice per car. That is
  what keeps this migration backward compatible: the previous release's panel
  saves a three-key book and is still accepted (it removes the flat price, which
  is the one consequence of a rollback), and its browser, which reads the three
  keys it knows, ignores the fourth. The seed adds 20000 to the stored book and
  raises its version, so a panel tab opened before this release gets
  `version_conflict` on its next save instead of silently dropping the figure.
  Zero is allowed: a free first month is a decision the owner may take.

  ## The engines

  `compute_plan_price(plan, cars, cycle, first_invoice DEFAULT false)` and
  `app_private.price_book_price(book, plan, cars, cycle, first_invoice DEFAULT
  false)` extend the signature rather than adding a function. The three-argument
  forms are DROPPED, not left beside the new ones: two overloads where one has
  defaults is a call PostgreSQL may refuse as ambiguous, and
  `redeem_discount_code` calls `compute_plan_price` with three arguments, which
  now resolve to the new function with `false`. With the flag false nothing
  changes: every edge case of 20260916150000 is carried (a NULL car count counts
  as 1, a count below 1 is billed as one car but looks its tier up as given, an
  unknown or NULL plan pays the basic price, any cycle but 'yearly' is monthly).
  With the flag true and a book that carries the figure, the answer is that
  figure whatever the other arguments are.
  `calcPricing(book, plan, cars, cycle, firstInvoice)` in src/utils/pricing.ts
  is the twin; tests/rls/pricing.sql prices an alien book's first month and
  src/utils/pricing.parity.test.ts reads the same numbers from it.

  ## The invoice amount

  `app_private.invoice_amount_cents(book, plan, cars, cycle, first)` is the one
  place an invoice's amount is decided, in integer cents:
    - first invoice and the book carries the figure: the figure;
    - otherwise a yearly company: the yearly price divided by twelve (an
      invoice is a month; the yearly discount is the book's), rounded to cents;
    - otherwise the monthly price per car, rounded to cents.
  The browser used to take `company_subscriptions.monthly_price`, a rate copied
  from `subscription_plans` when the subscription was assigned, which is not the
  price book. `public.platform_invoice_quotes(month, year)` answers, for every
  active subscription, whether the invoice for that period would be the
  company's first and its amount in cents, so GenerateInvoicesModal raises what
  the panel quotes. It is a read model in the shape of platform_invoices_list:
  `billing.manage`, one audited `read` row per call (`platform_read.invoice_quotes`),
  a refusal is a return value.

  ## What is deliberately not changed

  `redeem_discount_code` keeps pricing a signup from the book per car: the flag
  defaults to false, and a discount code is not an invoice.

  ## Compatibility

  No SCHEMA_EPOCH bump. The book gains an optional key, one function is
  replaced by an equivalent with a defaulted argument, one is new. The previous
  release never calls compute_plan_price from the browser, reads three keys of
  the book, and raises invoices from monthly_price exactly as before.

  ## Money

  Integer cents in the book and in every amount this file returns. The only
  division is the yearly price by twelve, rounded once, half away from zero.
*/

-- ─── 1. The validator learns the optional key ───────────────────────────────

/*
  20260921120000's body with two changes and no others, both in the price_book
  branch: the key set may also be the four-key set, and first_month_cents is an
  integer between 0 and the per-car ceiling. Every other branch is carried over
  character for character; the self-check restates what each must still refuse.
*/
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

  v_part    jsonb;
  v_tier    jsonb;
  v_plan    text;
  v_index   integer;
  v_prev    integer;
  v_entry   record;
  v_missing text[];
BEGIN
  IF p_key IS NULL
     OR p_key NOT IN ('price_book', 'plan_features', 'seller', 'trial', 'invoice',
                      'mail.sender',
                      'mail.template.signup_verify', 'mail.template.password_reset',
                      'mail.template.invite_activate', 'mail.template.email_change',
                      'feature_flags',
                      'legal.impressum', 'legal.privacy') THEN
    RETURN 'unknown_key';
  END IF;

  -- 20260921120000: the privacy text carries its own size bound, which is the
  -- one exception to the shared bound below (see that file's header).
  IF p_key = 'legal.privacy' THEN
    RETURN app_private.platform_settings_problem_legal(p_key, p_value);
  END IF;

  IF p_value IS NULL OR octet_length(p_value::text) > c_max_value_bytes THEN
    RETURN 'value_size';
  END IF;

  -- 20260921120000: the Impressum, within the shared bound above.
  IF p_key = 'legal.impressum' THEN
    RETURN app_private.platform_settings_problem_legal(p_key, p_value);
  END IF;

  -- Plan 3.10, first half. Checked after the size limit above, so every key
  -- shares one bound on how much one row may hold.
  IF p_key IN ('seller', 'trial', 'invoice') THEN
    RETURN app_private.platform_settings_problem_3_10(p_key, p_value);
  END IF;

  -- Plan 3.10, second half, and plan 3.11's flags (20260920130000).
  IF p_key = 'mail.sender' OR left(p_key, 14) = 'mail.template.' THEN
    RETURN app_private.platform_settings_problem_mail(p_key, p_value);
  END IF;
  IF p_key = 'feature_flags' THEN
    RETURN app_private.platform_settings_problem_flags(p_value);
  END IF;

  IF p_key = 'price_book' THEN
    -- 20261015160000: first_month_cents is the one optional key. A book
    -- without it is the three-key book every earlier release saved and reads,
    -- and prices every invoice per car.
    IF app_private.settings_object_keys(p_value)
       IS DISTINCT FROM ARRAY['fleet_discount_tiers', 'price_per_car_cents', 'yearly_discount_percent']
       AND app_private.settings_object_keys(p_value)
       IS DISTINCT FROM ARRAY['first_month_cents', 'fleet_discount_tiers', 'price_per_car_cents', 'yearly_discount_percent'] THEN
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

    -- 20261015160000: the flat price of a company's first invoice, in integer
    -- cents, whatever its plan or car count. The same bound as a price per car.
    IF p_value ? 'first_month_cents'
       AND NOT app_private.settings_integer_between(p_value -> 'first_month_cents', 0, c_max_cents) THEN
      RETURN 'price_book.first_month_cents';
    END IF;
    RETURN NULL;
  END IF;

  -- plan_features: feature key -> the minimum plan.
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

  -- Every feature the application knows must be named. The browser reads a
  -- feature the map does not name as premium, so a short map would silently
  -- lock those screens for every non-trial company below premium. Reported
  -- after the shape checks above, so a bad value is still named as a bad value.
  -- Keys this build does not know stay valid: that is how a feature is seeded
  -- before the release that gates it.
  v_missing := app_private.plan_features_missing_keys(p_value);
  IF array_length(v_missing, 1) IS NOT NULL THEN
    RETURN 'plan_features.missing.' || v_missing[1];
  END IF;

  RETURN NULL;
END;
$$;

-- ─── 2. The seed ────────────────────────────────────────────────────────────

-- 200,00 EUR, the owner's figure. updated_by stays NULL (nobody saved it) and
-- the version moves, so a settings tab open since before this release cannot
-- overwrite the book with a copy that lacks the key.
UPDATE app_private.platform_settings
   SET value      = value || '{"first_month_cents": 20000}'::jsonb,
       version    = version + 1,
       updated_at = now()
 WHERE key = 'price_book'
   AND NOT (value ? 'first_month_cents');

-- ─── 3. The engines ─────────────────────────────────────────────────────────

DROP FUNCTION public.compute_plan_price(text, integer, text);
DROP FUNCTION app_private.price_book_price(jsonb, text, integer, text);

/*
  20260916150000's body with one block added at the top. The arithmetic below
  it is untouched, so a book priced per car returns the same numeric with the
  same scale as before: 114.00, 1231.2000.
*/
CREATE OR REPLACE FUNCTION app_private.price_book_price(
  p_book          jsonb,
  p_plan          text,
  p_car_limit     integer,
  p_billing_cycle text,
  p_first_invoice boolean DEFAULT false
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
  -- The first invoice is one flat figure: not the plan, not the cars, not the
  -- cycle. A book without the figure has no first month and prices per car.
  IF coalesce(p_first_invoice, false) AND p_book ? 'first_month_cents' THEN
    RETURN (p_book ->> 'first_month_cents')::numeric * 0.01;
  END IF;

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

CREATE OR REPLACE FUNCTION public.compute_plan_price(
  p_plan          text,
  p_car_limit     integer,
  p_billing_cycle text,
  p_first_invoice boolean DEFAULT false
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
  RETURN app_private.price_book_price(v_book, p_plan, p_car_limit, p_billing_cycle, p_first_invoice);
END;
$$;

COMMENT ON FUNCTION public.compute_plan_price(text, integer, text, boolean) IS
  'The price of a plan, car count and billing cycle under the price_book setting (app_private.platform_settings), in euros; with p_first_invoice and a book that carries first_month_cents, that flat figure instead. calcPricing() in src/utils/pricing.ts computes the same from the same book.';

/*
  What one invoice costs, in integer cents. The single place the amount is
  decided; src/utils/pricing.ts invoiceAmountCents() is its twin.
*/
CREATE OR REPLACE FUNCTION app_private.invoice_amount_cents(
  p_book          jsonb,
  p_plan          text,
  p_car_limit     integer,
  p_billing_cycle text,
  p_first_invoice boolean
)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF coalesce(p_first_invoice, false) AND p_book ? 'first_month_cents' THEN
    RETURN round(app_private.price_book_price(p_book, p_plan, p_car_limit, p_billing_cycle, true) * 100)::integer;
  END IF;

  -- An invoice is a month. A yearly company pays the yearly price in twelve
  -- parts, which is the monthly equivalent the panel prints.
  IF p_billing_cycle = 'yearly' THEN
    RETURN round(app_private.price_book_price(p_book, p_plan, p_car_limit, 'yearly') * 100 / 12)::integer;
  END IF;
  RETURN round(app_private.price_book_price(p_book, p_plan, p_car_limit, 'monthly') * 100)::integer;
END;
$$;

-- ─── 4. The quotes ──────────────────────────────────────────────────────────

/*
  For every active subscription: is the invoice for this period the company's
  first, and what does it cost. The plan, car limit and cycle are the company's
  (companies.plan, subscription_car_limit, billing_cycle), the same three the
  panel prices from. 'canceled' is the invoice status's spelling (20260607125649).
*/
CREATE OR REPLACE FUNCTION public.platform_invoice_quotes(
  p_month integer,
  p_year  integer
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_action   CONSTANT text := 'platform_read.invoice_quotes';
  c_min_year CONSTANT integer := 2020;
  c_max_year CONSTANT integer := 2100;
  v_book     jsonb;
  v_items    jsonb;
  v_request  jsonb;
BEGIN
  IF p_month IS NULL OR p_month < 1 OR p_month > 12
     OR p_year IS NULL OR p_year < c_min_year OR p_year > c_max_year THEN
    RAISE EXCEPTION 'platform_invoice_quotes: invalid arguments' USING ERRCODE = '22023';
  END IF;

  v_request := jsonb_build_object('month', p_month, 'year', p_year);

  IF NOT coalesce(public.platform_can('billing.manage'), false) THEN
    PERFORM app_private.platform_read_record(c_action, 'denied', NULL, 'invoice',
                                             jsonb_build_object('request', v_request));
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
  END IF;

  v_book := app_private.platform_setting_value('price_book');
  IF v_book IS NULL OR app_private.platform_settings_problem('price_book', v_book) IS NOT NULL THEN
    PERFORM app_private.platform_read_record(c_action, 'error', NULL, 'invoice',
                                             jsonb_build_object('request', v_request, 'reason', 'price_book_unreadable'));
    RETURN jsonb_build_object('ok', false, 'reason', 'price_book_unreadable');
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'subscription_id', q.subscription_id,
           'company_id',      q.company_id,
           'company_name',    q.company_name,
           'plan',            q.plan,
           'car_limit',       q.car_limit,
           'billing_cycle',   q.billing_cycle,
           'first_invoice',   q.first_invoice,
           'amount_cents',    app_private.invoice_amount_cents(v_book, q.plan, q.car_limit, q.billing_cycle, q.first_invoice)
         ) ORDER BY q.company_name, q.subscription_id), '[]'::jsonb)
    INTO v_items
    FROM (
      SELECT s.id AS subscription_id, s.company_id, c.name AS company_name,
             c.plan, c.subscription_car_limit AS car_limit, c.billing_cycle,
             NOT EXISTS (
               SELECT 1
                 FROM public.subscription_invoices i
                WHERE i.company_id = s.company_id
                  AND i.status <> 'canceled'
                  AND (i.invoice_year * 12 + i.invoice_month) < (p_year * 12 + p_month)
             ) AS first_invoice
        FROM public.company_subscriptions s
        JOIN public.companies c ON c.id = s.company_id
       WHERE s.status = 'active'
    ) q;

  PERFORM app_private.platform_read_record(c_action, 'ok', NULL, 'invoice',
    jsonb_build_object('request', v_request, 'returned', jsonb_array_length(v_items)));

  RETURN jsonb_build_object('ok', true, 'month', p_month, 'year', p_year, 'items', v_items);
END;
$$;

-- ─── 5. Ownership and privileges ────────────────────────────────────────────

-- Each of these reaches app_private, which only its owner or a superuser can.
ALTER FUNCTION app_private.platform_settings_problem(text, jsonb)                             OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.price_book_price(jsonb, text, integer, text, boolean)              OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.invoice_amount_cents(jsonb, text, integer, text, boolean)          OWNER TO CURRENT_USER;
ALTER FUNCTION public.compute_plan_price(text, integer, text, boolean)                        OWNER TO CURRENT_USER;
ALTER FUNCTION public.platform_invoice_quotes(integer, integer)                               OWNER TO CURRENT_USER;

REVOKE ALL ON FUNCTION app_private.platform_settings_problem(text, jsonb)                     FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.price_book_price(jsonb, text, integer, text, boolean)      FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.invoice_amount_cents(jsonb, text, integer, text, boolean)  FROM PUBLIC, anon, authenticated, service_role;

-- As 20260915120000 and 20260916150000 left the three-argument function:
-- signed-in screens and the service role, never anon.
REVOKE ALL ON FUNCTION public.compute_plan_price(text, integer, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.compute_plan_price(text, integer, text, boolean) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.platform_invoice_quotes(integer, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_invoice_quotes(integer, integer) TO authenticated;

-- 20260916150000's rule again, for the new function: a SECURITY DEFINER caller
-- owned by another role (redeem_discount_code, where `postgres` owns it) needs
-- EXECUTE by name, which is exactly what it held on the function dropped above.
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
       AND p.oid <> 'public.compute_plan_price(text,integer,text,boolean)'::regprocedure
       AND p.prosrc ~ 'compute_plan_price\s*\('
       AND NOT has_function_privilege(owner_role.oid, 'public.compute_plan_price(text,integer,text,boolean)'::regprocedure, 'EXECUTE')
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.compute_plan_price(text, integer, text, boolean) TO %I', r.rolname);
    RAISE NOTICE '20261015160000: % owns a SECURITY DEFINER function that calls compute_plan_price and keeps EXECUTE on it', r.rolname;
  END LOOP;
END $$;

-- ─── Self-check ─────────────────────────────────────────────────────────────

DO $$
DECLARE
  c_public_fields CONSTANT text[] := ARRAY[
    'city', 'contact_email', 'contact_phone', 'content_responsible_address',
    'content_responsible_name', 'house_number', 'legal_form', 'legal_name',
    'postal_code', 'register_court', 'register_number', 'represented_by',
    'street', 'vat_id'];

  v_role      text;
  v_wrong     text;
  v_book      jsonb;
  v_answer    jsonb;
  v_alien     jsonb;
  v_seed      jsonb;
  v_seller    jsonb;
  v_impressum jsonb;
  v_privacy   jsonb;
  v_template  jsonb;
  v_big       jsonb;
BEGIN
  -- 1. Nobody the API authenticates as reaches the schema or the settings table.
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_schema_privilege(v_role, 'app_private', 'USAGE')
       OR has_table_privilege(v_role, 'app_private.platform_settings',
                              'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') THEN
      RAISE EXCEPTION '20261015160000 self-check: % reaches app_private', v_role;
    END IF;
  END LOOP;

  -- 2. The old signatures are gone, so no call can be ambiguous, and every
  --    function here is what it should be: SECURITY DEFINER where stated, a
  --    pinned search_path, an owner that reaches app_private, exactly the
  --    stated EXECUTE grants, none for PUBLIC.
  IF to_regprocedure('public.compute_plan_price(text,integer,text)') IS NOT NULL
     OR to_regprocedure('app_private.price_book_price(jsonb,text,integer,text)') IS NOT NULL THEN
    RAISE EXCEPTION '20261015160000 self-check: a three-argument pricing function is still there beside the new one';
  END IF;

  SELECT string_agg(format('%s (%s)', f.sig, f.problem), '; ') INTO v_wrong
    FROM (
      SELECT v.sig, CASE
               WHEN to_regprocedure(v.sig) IS NULL THEN 'missing'
               WHEN (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(v.sig)) IS DISTINCT FROM v.definer
                 THEN 'SECURITY DEFINER should be ' || v.definer
               WHEN NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proconfig) c(setting)
                                 WHERE p.oid = to_regprocedure(v.sig) AND c.setting LIKE 'search_path=%')
                 THEN 'no pinned search_path'
               WHEN NOT EXISTS (
                      SELECT 1
                        FROM pg_proc p
                        JOIN pg_roles r ON r.oid = p.proowner
                       WHERE p.oid = to_regprocedure(v.sig)
                         AND (r.rolsuper OR r.oid = (SELECT nspowner FROM pg_namespace WHERE nspname = 'app_private')))
                 THEN 'owner can call no app_private helper'
               WHEN EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                             WHERE p.oid = to_regprocedure(v.sig) AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')
                 THEN 'PUBLIC holds EXECUTE'
               WHEN has_function_privilege('anon', to_regprocedure(v.sig), 'EXECUTE') IS DISTINCT FROM v.anon
                 THEN 'anon EXECUTE should be ' || v.anon
               WHEN has_function_privilege('authenticated', to_regprocedure(v.sig), 'EXECUTE') IS DISTINCT FROM v.authn
                 THEN 'authenticated EXECUTE should be ' || v.authn
               WHEN has_function_privilege('service_role', to_regprocedure(v.sig), 'EXECUTE') IS DISTINCT FROM v.service
                 THEN 'service_role EXECUTE should be ' || v.service
             END AS problem
        FROM (VALUES
          -- signature                                                    definer anon   authn  service
          ('app_private.platform_settings_problem(text,jsonb)',           false,  false, false, false),
          ('app_private.price_book_price(jsonb,text,integer,text,boolean)', false, false, false, false),
          ('app_private.invoice_amount_cents(jsonb,text,integer,text,boolean)', false, false, false, false),
          ('public.compute_plan_price(text,integer,text,boolean)',        true,   false, true,  true),
          ('public.platform_invoice_quotes(integer,integer)',             true,   false, true,  false)
        ) AS v(sig, definer, anon, authn, service)
    ) f
   WHERE f.problem IS NOT NULL;

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '20261015160000 self-check: %', v_wrong;
  END IF;

  IF (SELECT p.provolatile FROM pg_proc p WHERE p.oid = 'public.platform_invoice_quotes(integer,integer)'::regprocedure) <> 'v' THEN
    RAISE EXCEPTION '20261015160000 self-check: platform_invoice_quotes must be VOLATILE — it writes its audit row';
  END IF;

  -- The quotes follow the read-model shape: one capability, one audit row.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = 'public.platform_invoice_quotes(integer,integer)'::regprocedure
                    AND p.prosrc LIKE '%public.platform_can(''billing.manage'')%'
                    AND p.prosrc LIKE '%app_private.platform_read_record(%'
                    AND p.prosrc LIKE '%app_private.invoice_amount_cents(%')
     OR NOT EXISTS (SELECT 1 FROM app_private.platform_capability_matrix() m WHERE m.capability = 'billing.manage') THEN
    RAISE EXCEPTION '20261015160000 self-check: platform_invoice_quotes does not check, record or price as it should';
  END IF;

  -- 3. The stored book carries the owner's figure, is valid, and every stored
  --    setting still passes its own validator (which also catches a
  --    restatement that dropped another file's key).
  v_book := app_private.platform_setting_value('price_book');
  IF (v_book ->> 'first_month_cents')::integer IS DISTINCT FROM 20000 THEN
    RAISE EXCEPTION '20261015160000 self-check: the stored price book does not carry the first month at 20000 cents';
  END IF;

  SELECT string_agg(format('%s: %s', s.key, app_private.platform_settings_problem(s.key, s.value)), ', ')
    INTO v_wrong
    FROM app_private.platform_settings s
   WHERE app_private.platform_settings_problem(s.key, s.value) IS NOT NULL;
  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '20261015160000 self-check: a stored setting is refused by its own validator: %', v_wrong;
  END IF;

  v_seller := app_private.platform_setting_value('seller');

  -- 4. What the price_book branch refuses, old rules and new, restated.
  IF app_private.platform_settings_problem('price_book', v_book - 'first_month_cents') IS NOT NULL
     OR app_private.platform_settings_problem('price_book', v_book || '{"first_month_cents": 0}') IS NOT NULL
     OR app_private.platform_settings_problem('price_book', v_book || '{"first_month_cents": 1000000}') IS NOT NULL
     OR app_private.platform_settings_problem('price_book', v_book || '{"first_month_cents": 1000001}')
          IS DISTINCT FROM 'price_book.first_month_cents'
     OR app_private.platform_settings_problem('price_book', v_book || '{"first_month_cents": -1}')
          IS DISTINCT FROM 'price_book.first_month_cents'
     OR app_private.platform_settings_problem('price_book', v_book || '{"first_month_cents": 200.5}')
          IS DISTINCT FROM 'price_book.first_month_cents'
     OR app_private.platform_settings_problem('price_book', v_book || '{"first_month_cents": "20000"}')
          IS DISTINCT FROM 'price_book.first_month_cents'
     OR app_private.platform_settings_problem('price_book', v_book || '{"first_month_cents": null}')
          IS DISTINCT FROM 'price_book.first_month_cents'
     OR app_private.platform_settings_problem('price_book', v_book || '{"first_month": 20000}')
          IS DISTINCT FROM 'price_book'
     OR app_private.platform_settings_problem('price_book', (v_book - 'yearly_discount_percent'))
          IS DISTINCT FROM 'price_book'
     OR app_private.platform_settings_problem('price_book', (v_book - 'fleet_discount_tiers') - 'first_month_cents')
          IS DISTINCT FROM 'price_book'
     OR app_private.platform_settings_problem('price_book',
          jsonb_set(v_book, '{price_per_car_cents,gold}', '5000'::jsonb)) IS DISTINCT FROM 'price_book.price_per_car_cents'
     OR app_private.platform_settings_problem('price_book',
          jsonb_set(v_book, '{price_per_car_cents,basic}', '2000.5'::jsonb)) IS DISTINCT FROM 'price_book.price_per_car_cents.basic'
     OR app_private.platform_settings_problem('price_book',
          jsonb_set(v_book, '{price_per_car_cents,premium}', '-1'::jsonb)) IS DISTINCT FROM 'price_book.price_per_car_cents.premium'
     OR app_private.platform_settings_problem('price_book',
          jsonb_set(v_book, '{fleet_discount_tiers}', '[{"min_cars": 11, "percent": 10}, {"min_cars": 6, "percent": 5}]'::jsonb))
          IS DISTINCT FROM 'price_book.fleet_discount_tiers.1'
     OR app_private.platform_settings_problem('price_book',
          jsonb_set(v_book, '{yearly_discount_percent}', '101'::jsonb)) IS DISTINCT FROM 'price_book.yearly_discount_percent' THEN
    RAISE EXCEPTION '20261015160000 self-check: the price_book validator does not judge as this file states';
  END IF;

  -- 5. The engines. With the flag false the book prices per car exactly as
  --    before (six of the forty-two numbers 20260916150000 pins), with it true
  --    one flat figure whatever the plan, the cars or the cycle, and a book
  --    without the figure has no first month.
  IF public.compute_plan_price('basic', 1, 'monthly') IS DISTINCT FROM 20
     OR public.compute_plan_price('premium', 5, 'monthly') IS DISTINCT FROM 350
     OR public.compute_plan_price('premium', 5, 'monthly', false) IS DISTINCT FROM 350
     OR public.compute_plan_price('basic', 6, 'yearly') IS DISTINCT FROM 1231.2
     OR public.compute_plan_price('advanced', 11, 'monthly') IS DISTINCT FROM 396
     OR public.compute_plan_price('premium', 25, 'yearly') IS DISTINCT FROM 17010
     OR public.compute_plan_price('basic', NULL, 'monthly') IS DISTINCT FROM 20
     OR public.compute_plan_price('basic', -3, 'monthly') IS DISTINCT FROM 20
     OR public.compute_plan_price('gold', 1, 'weekly') IS DISTINCT FROM 20 THEN
    RAISE EXCEPTION '20261015160000 self-check: the price book no longer prices per car as it did';
  END IF;

  IF public.compute_plan_price('premium', 5, 'monthly', true) IS DISTINCT FROM 200
     OR public.compute_plan_price('basic', 1, 'yearly', true) IS DISTINCT FROM 200
     OR public.compute_plan_price('advanced', 40, 'monthly', true) IS DISTINCT FROM 200
     OR public.compute_plan_price('gold', NULL, NULL, true) IS DISTINCT FROM 200 THEN
    RAISE EXCEPTION '20261015160000 self-check: the first invoice is not the flat price whatever the plan, cars and cycle';
  END IF;

  v_alien := '{"price_per_car_cents": {"basic": 1250, "advanced": 3300, "premium": 9900},
               "fleet_discount_tiers": [{"min_cars": 2, "percent": 3}],
               "yearly_discount_percent": 20}'::jsonb;
  IF app_private.price_book_price(v_alien, 'basic', 1, 'monthly', true) IS DISTINCT FROM 12.5
     OR app_private.price_book_price(v_alien, 'basic', 1, 'monthly', false) IS DISTINCT FROM 12.5
     OR app_private.price_book_price(v_alien, 'premium', 3, 'yearly', true) IS DISTINCT FROM 2765.664
     OR app_private.price_book_price(v_alien || '{"first_month_cents": 31700}', 'premium', 3, 'yearly', true) IS DISTINCT FROM 317
     OR app_private.price_book_price(v_alien || '{"first_month_cents": 31700}', 'premium', 3, 'yearly', false) IS DISTINCT FROM 2765.664 THEN
    RAISE EXCEPTION '20261015160000 self-check: the flat price is not read from the book it is asked of';
  END IF;

  -- 6. The invoice amount, in cents: the flat figure first, then per car, a
  --    yearly company in twelve parts, a cancelled-out book without the figure
  --    per car even for the first invoice.
  IF app_private.invoice_amount_cents(v_book, 'premium', 5, 'monthly', true)  IS DISTINCT FROM 20000
     OR app_private.invoice_amount_cents(v_book, 'premium', 5, 'yearly',  true)  IS DISTINCT FROM 20000
     OR app_private.invoice_amount_cents(v_book, 'premium', 5, 'monthly', false) IS DISTINCT FROM 35000
     OR app_private.invoice_amount_cents(v_book, 'premium', 5, 'yearly',  false) IS DISTINCT FROM 31500
     OR app_private.invoice_amount_cents(v_book, 'basic', 6, 'yearly', false)    IS DISTINCT FROM 10260
     OR app_private.invoice_amount_cents(v_book - 'first_month_cents', 'premium', 5, 'monthly', true) IS DISTINCT FROM 35000
     OR app_private.invoice_amount_cents(v_book - 'first_month_cents', 'premium', 5, 'yearly', true)  IS DISTINCT FROM 31500
     OR app_private.invoice_amount_cents(v_book, 'premium', 5, 'monthly', NULL)  IS DISTINCT FROM 35000 THEN
    RAISE EXCEPTION '20261015160000 self-check: invoice_amount_cents does not decide an amount as this file states';
  END IF;

  -- 7. What every earlier branch of platform_settings_problem refuses, restated so a botched copy of
  --    platform_settings_problem fails here and not on a customer's screen.
  --    First 20260920130000's two lists, as that file checked them.
  v_seed := app_private.platform_setting_value('plan_features');
  IF app_private.platform_settings_problem('plan_features', v_seed) IS NOT NULL
     OR app_private.platform_settings_problem('plan_features', v_seed - 'gehaelter')
          IS DISTINCT FROM 'plan_features.missing.gehaelter'
     OR app_private.platform_settings_problem('plan_features', '{}'::jsonb) IS NULL
     OR app_private.platform_settings_problem('plan_features',
          v_seed || '{"a_feature_of_a_later_release": "basic"}'::jsonb) IS NOT NULL THEN
    RAISE EXCEPTION '20261015160000 self-check: the complete-feature-map rule of 20260917120000 did not survive';
  END IF;

  IF app_private.platform_settings_problem('price_book', app_private.platform_setting_value('price_book')) IS NOT NULL
     OR app_private.platform_settings_problem('price_book', '{}'::jsonb) IS DISTINCT FROM 'price_book'
     OR app_private.platform_settings_problem('trial', '{"days": 0}'::jsonb) IS DISTINCT FROM 'trial.days'
     OR app_private.platform_settings_problem('seller', '{}'::jsonb) IS DISTINCT FROM 'seller'
     OR app_private.platform_settings_problem('invoice', '{}'::jsonb) IS DISTINCT FROM 'invoice'
     OR app_private.platform_settings_problem('mail.template.platform_login', '{}'::jsonb) IS DISTINCT FROM 'unknown_key'
     OR app_private.platform_settings_problem('mail.other', '{}'::jsonb) IS DISTINCT FROM 'unknown_key'
     OR app_private.platform_settings_problem('legal.other', '{}'::jsonb) IS DISTINCT FROM 'unknown_key'
     OR app_private.platform_settings_problem(NULL, '{}'::jsonb) IS DISTINCT FROM 'unknown_key' THEN
    RAISE EXCEPTION '20261015160000 self-check: a branch of platform_settings_problem moved';
  END IF;

  v_template := '{"subject": "Ihr Code – El-Professor", "heading": "Willkommen",
                  "paragraphs": ["Hallo {email}, willkommen bei {company}.", "Zweiter Absatz."],
                  "button": "Einladung annehmen"}'::jsonb;
  IF app_private.platform_settings_problem('mail.template.invite_activate', v_template) IS NOT NULL
     OR app_private.platform_settings_problem('mail.template.signup_verify', v_template)
          IS DISTINCT FROM 'mail.template.signup_verify.paragraphs.0'
     OR app_private.platform_settings_problem('mail.template.email_change', v_template)
          IS DISTINCT FROM 'mail.template.email_change'
     OR app_private.platform_settings_problem('mail.template.invite_activate',
          jsonb_set(v_template, '{subject}', '"Ihr Code {code}"'::jsonb)) IS DISTINCT FROM 'mail.template.invite_activate.subject.code'
     OR app_private.platform_settings_problem('mail.template.invite_activate',
          jsonb_set(v_template, '{subject}', '"Code 482915"'::jsonb)) IS DISTINCT FROM 'mail.template.invite_activate.subject.code'
     OR app_private.platform_settings_problem('mail.template.invite_activate',
          jsonb_set(v_template, '{subject}', '"Hallo {email}"'::jsonb)) IS DISTINCT FROM 'mail.template.invite_activate.subject'
     OR app_private.platform_settings_problem('mail.template.invite_activate',
          jsonb_set(v_template, '{paragraphs}', '["Ihr Code: {code}"]'::jsonb)) IS DISTINCT FROM 'mail.template.invite_activate.paragraphs.0'
     OR app_private.platform_settings_problem('mail.template.invite_activate',
          jsonb_set(v_template, '{paragraphs}', '[]'::jsonb)) IS DISTINCT FROM 'mail.template.invite_activate.paragraphs'
     OR app_private.platform_settings_problem('mail.template.invite_activate',
          jsonb_set(v_template, '{heading}', '"Zeile\neins"'::jsonb)) IS DISTINCT FROM 'mail.template.invite_activate.heading'
     OR app_private.platform_settings_problem('mail.sender', '{"name": "Support"}'::jsonb) IS NOT NULL
     OR app_private.platform_settings_problem('mail.sender', '{"name": "support@bank.de"}'::jsonb)
          IS DISTINCT FROM 'mail.sender.name'
     OR app_private.platform_settings_problem('mail.sender', '{"name": " El-Professor"}'::jsonb)
          IS DISTINCT FROM 'mail.sender.name'
     OR app_private.platform_settings_problem('feature_flags', '{"new_banner": true}'::jsonb) IS NOT NULL
     OR app_private.platform_settings_problem('feature_flags', '{"new_banner": "yes"}'::jsonb)
          IS DISTINCT FROM 'feature_flags.new_banner'
     OR app_private.platform_settings_problem('feature_flags', '{"New Banner": true}'::jsonb)
          IS DISTINCT FROM 'feature_flags.key' THEN
    RAISE EXCEPTION '20261015160000 self-check: a mail or flag validator of 20260920130000 no longer refuses what it must';
  END IF;

  -- Then the seller, the trial and the invoice, as 20260919120000 checked them.
  -- The seller is still exactly the eleven fields: a document that carries an
  -- Impressum field is refused as a whole, as it was before this file.
  IF app_private.platform_settings_problem('seller', v_seller) IS NOT NULL
     OR app_private.platform_settings_problem('seller', v_seller - 'bic') IS DISTINCT FROM 'seller'
     OR app_private.platform_settings_problem('seller', v_seller || '{"country": "Deutschland"}'::jsonb)
          IS DISTINCT FROM 'seller'
     OR app_private.platform_settings_problem('seller', v_seller || '{"legal_name": "Muster GmbH"}'::jsonb)
          IS DISTINCT FROM 'seller'
     OR app_private.platform_settings_problem('seller',
          jsonb_set(v_seller, '{postal_code}', '42651'::jsonb)) IS DISTINCT FROM 'seller.postal_code'
     OR app_private.platform_settings_problem('seller',
          jsonb_set(v_seller, '{name}', '""'::jsonb)) IS DISTINCT FROM 'seller.name'
     OR app_private.platform_settings_problem('seller',
          jsonb_set(v_seller, '{city}', '"Solingen\nNRW"'::jsonb)) IS DISTINCT FROM 'seller.city'
     OR app_private.platform_settings_problem('seller',
          jsonb_set(v_seller, '{city}', to_jsonb(repeat('x', 201)))) IS DISTINCT FROM 'seller.city'
     OR app_private.platform_settings_problem('trial', '{"days": 366}'::jsonb) IS DISTINCT FROM 'trial.days'
     OR app_private.platform_settings_problem('trial', '{"days": 14, "weeks": 2}'::jsonb) IS DISTINCT FROM 'trial'
     OR app_private.platform_settings_problem('trial', '{"days": 1}'::jsonb) IS NOT NULL
     OR app_private.platform_settings_problem('invoice',
          jsonb_set(app_private.platform_setting_value('invoice'), '{number_prefix}', '"inv-x"'::jsonb))
          IS DISTINCT FROM 'invoice.number_prefix'
     OR app_private.platform_settings_problem('invoice',
          jsonb_set(app_private.platform_setting_value('invoice'), '{number_digits}', '0'::jsonb))
          IS DISTINCT FROM 'invoice.number_digits' THEN
    RAISE EXCEPTION '20261015160000 self-check: a rule of 20260919120000 (seller, trial, invoice) did not survive';
  END IF;

  -- Every other key still shares the 16384-byte bound, the Impressum included:
  -- only legal.privacy has one of its own.
  v_big := jsonb_build_object('a_flag', true, 'padding_is_not_a_flag', repeat('x', 17000));
  IF app_private.platform_settings_problem('feature_flags', v_big) IS DISTINCT FROM 'value_size'
     OR app_private.platform_settings_problem('legal.impressum', jsonb_build_object('legal_name', repeat('x', 17000)))
          IS DISTINCT FROM 'value_size' THEN
    RAISE EXCEPTION '20261015160000 self-check: the shared size bound no longer applies to every other key';
  END IF;

  -- 8. The rules of 20260921120000, at their edges. The Impressum first: any of the fourteen
  --    fields, nothing else, each the seller's rules, and the two contact
  --    fields checked for what they claim to be.
  v_impressum := '{"legal_name": "Muster GmbH", "legal_form": "GmbH",
                   "street": "Hauptstraße", "house_number": "1", "postal_code": "42651", "city": "Solingen",
                   "represented_by": "Erika Muster", "contact_email": "info@example.com",
                   "contact_phone": "+49 (0)212 123-45/6", "register_court": "Amtsgericht Wuppertal",
                   "register_number": "HRB 12345", "vat_id": "DE123456789",
                   "content_responsible_name": "Erika Muster",
                   "content_responsible_address": "Hauptstraße 1, 42651 Solingen"}'::jsonb;
  IF app_private.settings_object_keys(v_impressum) IS DISTINCT FROM c_public_fields
     OR app_private.platform_settings_problem('legal.impressum', v_impressum) IS NOT NULL
     OR app_private.platform_settings_problem('legal.impressum', '{}'::jsonb) IS NOT NULL
     OR app_private.platform_settings_problem('legal.impressum', '{"legal_name": ""}'::jsonb) IS NOT NULL
     OR app_private.platform_settings_problem('legal.impressum', '[]'::jsonb) IS DISTINCT FROM 'legal.impressum'
     OR app_private.platform_settings_problem('legal.impressum', v_impressum || '{"iban": "DE02"}'::jsonb)
          IS DISTINCT FROM 'legal.impressum'
     OR app_private.platform_settings_problem('legal.impressum', v_impressum || '{"tax_number": "123"}'::jsonb)
          IS DISTINCT FROM 'legal.impressum'
     OR app_private.platform_settings_problem('legal.impressum', jsonb_set(v_impressum, '{legal_name}', '42'::jsonb))
          IS DISTINCT FROM 'legal.impressum.legal_name'
     OR app_private.platform_settings_problem('legal.impressum', jsonb_set(v_impressum, '{represented_by}', '"A\nB"'::jsonb))
          IS DISTINCT FROM 'legal.impressum.represented_by'
     OR app_private.platform_settings_problem('legal.impressum', jsonb_set(v_impressum, '{register_number}', to_jsonb(repeat('x', 201))))
          IS DISTINCT FROM 'legal.impressum.register_number'
     OR app_private.platform_settings_problem('legal.impressum', jsonb_set(v_impressum, '{contact_email}', '"info at example"'::jsonb))
          IS DISTINCT FROM 'legal.impressum.contact_email'
     OR app_private.platform_settings_problem('legal.impressum', jsonb_set(v_impressum, '{contact_phone}', '"Ruf an!"'::jsonb))
          IS DISTINCT FROM 'legal.impressum.contact_phone'
     OR app_private.platform_settings_problem('legal.impressum', jsonb_set(v_impressum, '{contact_phone}', '"+4"'::jsonb))
          IS DISTINCT FROM 'legal.impressum.contact_phone' THEN
    RAISE EXCEPTION '20261015160000 self-check: the Impressum validator does not judge as this file states';
  END IF;

  -- Then the privacy text.
  v_privacy := '{"as_of": "2026-09-21",
                 "paragraphs": ["Verantwortlich:\nMuster GmbH\nHauptstraße 1", "Zweiter Absatz."]}'::jsonb;
  IF app_private.platform_settings_problem('legal.privacy', '{}'::jsonb) IS NOT NULL
     OR app_private.platform_settings_problem('legal.privacy', v_privacy) IS NOT NULL
     OR app_private.platform_settings_problem('legal.privacy', NULL) IS DISTINCT FROM 'value_size'
     OR app_private.platform_settings_problem('legal.privacy', '[]'::jsonb) IS DISTINCT FROM 'legal.privacy'
     OR app_private.platform_settings_problem('legal.privacy', v_privacy - 'as_of') IS DISTINCT FROM 'legal.privacy'
     OR app_private.platform_settings_problem('legal.privacy', v_privacy || '{"title": "x"}'::jsonb)
          IS DISTINCT FROM 'legal.privacy'
     OR app_private.platform_settings_problem('legal.privacy', jsonb_set(v_privacy, '{as_of}', '"2026-02-30"'::jsonb))
          IS DISTINCT FROM 'legal.privacy.as_of'
     OR app_private.platform_settings_problem('legal.privacy', jsonb_set(v_privacy, '{as_of}', '"21.09.2026"'::jsonb))
          IS DISTINCT FROM 'legal.privacy.as_of'
     OR app_private.platform_settings_problem('legal.privacy', jsonb_set(v_privacy, '{as_of}', '"1999-12-31"'::jsonb))
          IS DISTINCT FROM 'legal.privacy.as_of'
     OR app_private.platform_settings_problem('legal.privacy', jsonb_set(v_privacy, '{as_of}', '"2028-02-29"'::jsonb))
          IS NOT NULL
     OR app_private.platform_settings_problem('legal.privacy', jsonb_set(v_privacy, '{paragraphs}', '[]'::jsonb))
          IS DISTINCT FROM 'legal.privacy.paragraphs'
     OR app_private.platform_settings_problem('legal.privacy', jsonb_set(v_privacy, '{paragraphs}', '"Text"'::jsonb))
          IS DISTINCT FROM 'legal.privacy.paragraphs'
     OR app_private.platform_settings_problem('legal.privacy', jsonb_set(v_privacy, '{paragraphs,1}', '"<b>fett</b>"'::jsonb))
          IS DISTINCT FROM 'legal.privacy.paragraphs.1'
     OR app_private.platform_settings_problem('legal.privacy', jsonb_set(v_privacy, '{paragraphs,1}', '"Tab\there"'::jsonb))
          IS DISTINCT FROM 'legal.privacy.paragraphs.1'
     OR app_private.platform_settings_problem('legal.privacy', jsonb_set(v_privacy, '{paragraphs,1}', '"Eins\n\nZwei"'::jsonb))
          IS DISTINCT FROM 'legal.privacy.paragraphs.1'
     OR app_private.platform_settings_problem('legal.privacy', jsonb_set(v_privacy, '{paragraphs,0}', '" \n "'::jsonb))
          IS DISTINCT FROM 'legal.privacy.paragraphs.0'
     OR app_private.platform_settings_problem('legal.privacy', jsonb_set(v_privacy, '{paragraphs,0}', to_jsonb(repeat('x', 4001))))
          IS DISTINCT FROM 'legal.privacy.paragraphs.0'
     OR app_private.platform_settings_problem('legal.privacy',
          jsonb_build_object('as_of', '2026-09-21', 'paragraphs', to_jsonb(array_fill('x'::text, ARRAY[301]))))
          IS DISTINCT FROM 'legal.privacy.paragraphs' THEN
    RAISE EXCEPTION '20261015160000 self-check: the privacy validator does not refuse what it must';
  END IF;

  -- The bound is the privacy text's own, and a document at it still fits the
  -- audit row platform_settings_put writes: audit_write refuses a before or
  -- after value above 32768 bytes, and the put wraps the value with its version.
  v_big := jsonb_build_object('as_of', '2026-09-21',
             'paragraphs', to_jsonb(array_fill(repeat('ä', 1000), ARRAY[15])));
  IF octet_length(v_big::text) <= 16384 OR octet_length(v_big::text) > 32000
     OR app_private.platform_settings_problem('legal.privacy', v_big) IS NOT NULL
     OR octet_length(jsonb_build_object('version', 2147483647, 'value', v_big)::text) > 32768 THEN
    RAISE EXCEPTION '20261015160000 self-check: a privacy text of % bytes is refused, or would not fit its audit row',
      octet_length(v_big::text);
  END IF;
  v_big := jsonb_build_object('as_of', '2026-09-21',
             'paragraphs', to_jsonb(array_fill(repeat('ä', 1000), ARRAY[17])));
  IF app_private.platform_settings_problem('legal.privacy', v_big) IS DISTINCT FROM 'value_size' THEN
    RAISE EXCEPTION '20261015160000 self-check: a privacy text of % bytes passes the 32000-byte bound',
      octet_length(v_big::text);
  END IF;


  RAISE NOTICE '20261015160000 self-check: ok';
END $$;
