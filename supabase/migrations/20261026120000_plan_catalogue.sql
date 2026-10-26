/*
  The plan catalogue: one row per plan, and the row is what prices and gates.

  Docs/design/plan-system.md sections 3, 4 and 5, with one deliberate narrowing
  named in full below. The owner's decision of 26.10.2026, after he opened
  "Pläne verwalten" in the panel and found one plan, no feature picker and no
  sidebar entry:

      "بدي اقدر في الادمن ادير الخطط واسعارها والفيتشر بشكل مستقل ومنظم
       ويأثر على الاشتراكات"

      I want to manage the plans, their prices and their features in the admin,
      independently and in an organised way, and have it affect the
      subscriptions.

  ─── The three stores before this file, measured on production 26.10.2026 ───

    what bills   app_private.platform_settings -> price_book, version 2
                 price_per_car_cents {basic 2000, advanced 4000, premium 7000}
                 fleet_discount_tiers [{6, 5%}, {11, 10%}], yearly 10%,
                 first_month_cents 20000
    what gates   app_private.platform_settings -> plan_features, version 1
                 16 keys, feature -> minimum plan
    what the     public.subscription_plans: ONE row
    screen       (Premium, monthly_price 200, included_cars 5,
    edits        drivers_per_car_limit 4, features_json {})

  `subscription_plans` prices nothing. `features_json` is read by no code in
  `src/` and written by no screen. `basic` and `advanced` have no row at all.
  One `company_subscriptions` row points at the single row through `plan_id`.

  ─── The seam, and what was rejected ──────────────────────────────────────

  `public.plans` is the SOURCE of the two per-plan facts: the price per car and
  the feature set. The two settings keys become PROJECTIONS of it, computed by
  `app_private.plan_price_book()` and `app_private.plan_feature_map()`, and the
  four readers that consumed the stored rows consume the projections instead.

  What that deliberately does NOT do, and each omission is the point:

  * It does not change one formula. `app_private.price_book_price` and
    `app_private.invoice_amount_cents` are not redefined here — not their
    bodies, not their signatures. What moves is where one of their inputs comes
    from. So every one of the 42 numbers the four parity gates pin is
    byte-identical by construction rather than by re-proof, and self-check 4
    asserts that over the whole grid as value AND text.

  * It does not change one line of the browser's pricing or gating path.
    `PriceBook`, `parsePriceBook`, `calcPricing`, `invoiceAmountCents`,
    `PlanFeatureMap`, `minPlanForFeature`, `SEED_PRICE_BOOK` and
    `SEED_PLAN_FEATURES` are untouched, because the projections emit exactly
    the two shapes those modules already parse. `appConfigSeed.test.ts` and
    `pricing.parity.test.ts` therefore stay live and keep measuring precisely
    what they measured yesterday. The design document's slice 1 also renamed
    `PriceBook` to `PriceModel` and taught `minPlanFor` to answer `'locked'`;
    that is NOT done here. It is a large refactor of LandingPage, PlanSelection
    and PlanContext that the owner did not ask for, it would replace a live
    gate in the same release that replaces what the gate measures (the document
    names that hazard itself, section 6.3), and the `'locked'` branch would be
    dead on arrival because invariant I2 below makes it unreachable.

  * It does not restate `app_private.platform_settings_problem`. The design
    document's slice 3 makes `price_per_car_cents` optional and then forbidden
    in the book, and bumps `deploy/SCHEMA_EPOCH` for the changed meaning. Not
    needed here, and skipping it is what keeps this file reversible: the key
    stays required by the validator, the stored row keeps it, and
    `platform_plans_save` REWRITES both settings rows from the catalogue on
    every save. So the two keys are a rollback shadow that is always current.
    The release before this one reads them and prices exactly as it does today.
    NO SCHEMA_EPOCH BUMP, and `DROP TABLE public.plans` plus re-pointing the
    four readers is the whole way back.

  Rejected: reshaping `subscription_plans` in place. Its `id` is a uuid
  referenced by `company_subscriptions.plan_id`; its `monthly_price numeric
  NOT NULL` is the flat-price model the owner rejected ("فش ارضيات") and its
  `included_cars integer NOT NULL CHECK (> 0)` belongs to the car cap that
  20261026110000 has already removed; and its three write policies are per-row,
  which is exactly the shape that cannot hold the cross-row invariants below.
  A new table reverts with DROP TABLE. `subscription_plans` is left standing,
  untouched, as the foreign-key target it is.

  ─── Why one RPC and no write policy ─────────────────────────────────────

  The table carries SELECT only. The invariants are CROSS-ROW, so a per-row
  write cannot enforce them and a CHECK constraint cannot see another row:

    I1  monotonicity. For active plans p, q with rank(p) < rank(q):
        p.features is a subset of q.features.
    I2  completeness. The union of features over active plans contains every
        key in app_private.plan_feature_keys().

  Neither alone is enough, and a later slice must not "simplify" one away.
  I2 alone admits a catalogue where basic grants `gehaelter` and premium does
  not — the union is complete, every key is named, and the feature is now
  cheaper on a lower plan. That configuration is unrepresentable in the map
  being replaced, because a map saying "gehaelter: basic" grants it at every
  rank at or above basic automatically; moving to explicit sets loses that
  implicit inheritance silently. I1 alone admits an empty catalogue.

  Together they are `plan_features_missing_keys()` in the row model: under I1
  the union equals the top active plan's set, so I2 says the top active plan
  grants everything the build knows — which is what "the map names every key"
  guarantees today.

  ─── Exactly three plans, and that is not this file's decision ───────────

  `app_private.platform_settings_problem` has pinned the plan set since
  20260916150000:

      -- Open decision D11: the three plans are fixed until the owner decides
      -- otherwise, so a price book names exactly these, in byte order.
      c_plans CONSTANT text[] := ARRAY['advanced', 'basic', 'premium'];

  and `Plan` in src/contexts/PlanContext.tsx is a three-member TypeScript union
  whose ORDER is load-bearing (PLAN_RANK in src/utils/planFeatures.ts), while
  `parsePriceBook` requires exactly those three keys and answers null for a
  book missing one. So a fourth plan is storable here and consumable by
  nothing: the browser would read the projected book as malformed and keep the
  book already on screen.

  This file therefore REFUSES a catalogue whose active slugs are not exactly
  the three (`plans.required.*` and `plans.extra.*`), rather than accepting a
  fourth plan and ignoring it. Carrying D11 forward is deliberate: the screen
  says why, and the open decision stays the owner's. The day he answers it, the
  lift is this validator's two branches, `plan_required_slugs()`, and the
  browser's `Plan` union — not a data migration.

  Also deliberately absent: `included_cars`, `drivers_per_car_limit` and
  `monthly_price`. The first two lost their last consumer when 20261026110000
  dropped both fleet caps and quoted the invoice on the real fleet; the third
  is the rejected pricing model. Measured: no function's body names
  `subscription_plans.features_json`, and `drivers_per_car_limit` on that table
  fed nothing even before the caps went — the live driver cap read
  `company_settings.drivers_per_car_limit`.
*/

-- ─── 1. The table ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.plans (
  slug                 text        PRIMARY KEY
                                   CHECK (slug ~ '^[a-z][a-z0-9_]{0,31}$'),
  name                 text        NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 60),
  -- The order basic < advanced < premium becomes data. PLAN_RANK in
  -- src/utils/planFeatures.ts is the browser's copy and must agree.
  rank                 smallint    NOT NULL CHECK (rank >= 0 AND rank <= 999),
  price_per_car_cents  integer     NOT NULL CHECK (price_per_car_cents BETWEEN 0 AND 1000000),
  -- The plan's own set. A text[] has a natural @> for I1's superset test and
  -- cannot hold a non-string, which jsonb can.
  features             text[]      NOT NULL DEFAULT '{}',
  is_active            boolean     NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

/*
  DEFERRABLE INITIALLY DEFERRED, and this is load-bearing rather than taste:
  platform_plans_save replaces the catalogue with one upsert, and a save that
  swaps two plans' ranks passes through a state where two rows share a rank.
  Checked at statement end, that save is refused for a conflict the committed
  state does not contain. Checked at commit, it is not.
*/
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.plans'::regclass AND conname = 'plans_rank_key') THEN
    ALTER TABLE public.plans
      ADD CONSTRAINT plans_rank_key UNIQUE (rank) DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

COMMENT ON TABLE public.plans IS
  'The plan catalogue: one row per plan, carrying its display name, its price per car in integer cents and the features it grants. The source of the price_per_car_cents half of the price_book setting and of the whole plan_features map, both of which app_private.plan_price_book() and app_private.plan_feature_map() project from these rows. Written only by public.platform_plans_save().';

ALTER TABLE public.plans ENABLE ROW LEVEL SECURITY;

/*
  No tenant: a platform catalogue, the shape matrix.sql already records for
  public.subscription_plans. SELECT is open to every signed-in principal
  because a plan's name and price are what the panel and the plan cards print.

  There is no INSERT, UPDATE or DELETE policy and no write grant, which is
  company_modules' shape (20261025120000) and its reasoning transfers: a write
  is refused for having no policy rather than by a WITH CHECK clause a later
  migration could restate away. Here it is sharper — the invariants above are
  cross-row and a per-row write could not enforce them at all.
*/
DROP POLICY IF EXISTS plans_select ON public.plans;
CREATE POLICY plans_select ON public.plans
  FOR SELECT TO authenticated
  USING (true);

REVOKE ALL ON TABLE public.plans FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.plans TO authenticated;

-- ─── 2. The catalogue's version ─────────────────────────────────────────────

/*
  One integer, for the same optimistic concurrency platform_settings_put has:
  a save carries the version it read, and a stale version is refused rather
  than merged. It is a table of its own rather than a platform_settings key
  because a settings key needs a validator branch, and adding one means
  restating platform_settings_problem with every existing branch carried
  character for character — a cost with nothing to buy here.
*/
CREATE TABLE IF NOT EXISTS app_private.plan_catalogue_meta (
  id         boolean     PRIMARY KEY DEFAULT true CHECK (id),
  version    integer     NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);

INSERT INTO app_private.plan_catalogue_meta (id) VALUES (true)
ON CONFLICT (id) DO NOTHING;

REVOKE ALL ON TABLE app_private.plan_catalogue_meta FROM PUBLIC, anon, authenticated, service_role;

-- ─── 3. The seed, derived from the live settings and never from literals ────

/*
  A literal seed can disagree with what is live; a derived one cannot. The
  inversion is also where I1 comes from for free: inverting a
  feature -> minimum rank map always yields monotone sets, because a plan at
  rank r takes every feature whose minimum rank is at most r.

  Idempotent: a row that already exists is left exactly as it is, so a re-run
  never overwrites an operator's later save.
*/
INSERT INTO public.plans (slug, name, rank, price_per_car_cents, features, is_active)
SELECT s.slug,
       s.name,
       s.rank,
       (app_private.platform_setting_value('price_book') -> 'price_per_car_cents' ->> s.slug)::integer,
       coalesce((SELECT array_agg(m.key ORDER BY m.key COLLATE "C")
                   FROM jsonb_each_text(app_private.platform_setting_value('plan_features')) AS m(key, min_plan)
                  WHERE CASE m.min_plan WHEN 'basic' THEN 0 WHEN 'advanced' THEN 1 WHEN 'premium' THEN 2 END <= s.rank),
                ARRAY[]::text[]),
       true
  FROM (VALUES ('basic',    'Basic',    0::smallint),
               ('advanced', 'Advanced', 1::smallint),
               ('premium',  'Premium',  2::smallint)) AS s(slug, name, rank)
ON CONFLICT (slug) DO NOTHING;

/*
  Measured: companies.plan has no CHECK constraint, so platform_company_set_plan
  can write any text and nothing objects; the three live values happen to be
  right. The FK refuses a typo at write time and refuses deleting a plan a
  company names. NO ACTION (the default) — nothing here should cascade.

  All 18 production companies hold one of the three seeded slugs, so no
  backfill. subscription_coverage.plan deliberately gets no FK: it holds
  history a migration wrote, including a `void` row, and a plan deactivated
  after a period was recorded is legitimate history.
*/
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.companies'::regclass AND conname = 'companies_plan_fkey') THEN
    ALTER TABLE public.companies
      ADD CONSTRAINT companies_plan_fkey FOREIGN KEY (plan) REFERENCES public.plans(slug);
  END IF;
END $$;

-- ─── 4. The slugs this build can consume ────────────────────────────────────

-- The `Plan` union of src/contexts/PlanContext.tsx, in byte order, which is
-- also platform_settings_problem's c_plans. See the header on open decision
-- D11: a fourth plan is refused rather than stored and ignored.
CREATE OR REPLACE FUNCTION app_private.plan_required_slugs()
RETURNS text[]
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN ARRAY['advanced', 'basic', 'premium'];
END;
$$;

-- ─── 5. The validator ───────────────────────────────────────────────────────

/*
  One stable problem code or NULL, mirroring platform_settings_problem's
  contract. Called by platform_plans_save before it writes anything, and by
  self-check 3 against the seed, so a release whose own seed violates its own
  validator fails at deploy time (20260917120000's self-check 4 is the
  precedent).

  No trigger: a row trigger cannot see the set, and a statement trigger would
  fire on the RPC's own intermediate states. The RPC is the only writer, which
  is what makes one check sufficient.
*/
CREATE OR REPLACE FUNCTION app_private.plan_catalogue_problem(p_plans jsonb)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_max_plans   CONSTANT integer := 20;
  c_max_cents   CONSTANT integer := 1000000;
  c_max_feats   CONSTANT integer := 200;
  c_keys        CONSTANT text[]  := ARRAY['features', 'is_active', 'name', 'price_per_car_cents', 'rank', 'slug'];

  v_entry   jsonb;
  v_index   integer;
  v_slug    text;
  v_feature text;
  v_slugs   text[] := ARRAY[]::text[];
  v_ranks   integer[] := ARRAY[]::integer[];
  v_active  text[] := ARRAY[]::text[];
  v_missing text[];
  v_pair    record;
BEGIN
  IF p_plans IS NULL OR jsonb_typeof(p_plans) IS DISTINCT FROM 'array' THEN
    RETURN 'plans';
  END IF;
  IF jsonb_array_length(p_plans) = 0 OR jsonb_array_length(p_plans) > c_max_plans THEN
    RETURN 'plans';
  END IF;

  -- Per entry: the key set, then every field as the JSON type it is stored as.
  -- The type checks are here and not left to a cast in the INSERT, because
  -- jsonb_array_elements plus ->> would store the TEXT of an object where a
  -- string was meant.
  FOR v_index IN 0 .. jsonb_array_length(p_plans) - 1 LOOP
    v_entry := p_plans -> v_index;
    IF jsonb_typeof(v_entry) IS DISTINCT FROM 'object'
       OR app_private.settings_object_keys(v_entry) IS DISTINCT FROM c_keys THEN
      RETURN 'plans.entry.' || v_index;
    END IF;

    IF jsonb_typeof(v_entry -> 'slug') IS DISTINCT FROM 'string' THEN
      RETURN 'plans.entry.' || v_index;
    END IF;
    v_slug := v_entry ->> 'slug';
    IF v_slug !~ '^[a-z][a-z0-9_]{0,31}$' THEN
      RETURN 'plans.slug.' || v_index;
    END IF;
    IF v_slug = ANY (v_slugs) THEN
      RETURN 'plans.slug.duplicate.' || v_slug;
    END IF;
    v_slugs := v_slugs || v_slug;

    IF jsonb_typeof(v_entry -> 'name') IS DISTINCT FROM 'string'
       OR btrim(v_entry ->> 'name') = ''
       OR length(v_entry ->> 'name') > 60 THEN
      RETURN 'plans.name.' || v_slug;
    END IF;

    IF NOT app_private.settings_integer_between(v_entry -> 'rank', 0, 999) THEN
      RETURN 'plans.rank.' || v_slug;
    END IF;
    IF (v_entry ->> 'rank')::integer = ANY (v_ranks) THEN
      RETURN 'plans.rank.duplicate.' || (v_entry ->> 'rank');
    END IF;
    v_ranks := v_ranks || (v_entry ->> 'rank')::integer;

    IF NOT app_private.settings_integer_between(v_entry -> 'price_per_car_cents', 0, c_max_cents) THEN
      RETURN 'plans.price.' || v_slug;
    END IF;

    IF jsonb_typeof(v_entry -> 'is_active') IS DISTINCT FROM 'boolean' THEN
      RETURN 'plans.is_active.' || v_slug;
    END IF;

    IF jsonb_typeof(v_entry -> 'features') IS DISTINCT FROM 'array'
       OR jsonb_array_length(v_entry -> 'features') > c_max_feats THEN
      RETURN 'plans.features.' || v_slug;
    END IF;
    -- EXISTS and not a FOR loop: the elements are jsonb here, and plpgsql
    -- assigning a jsonb into a text loop variable is a cast this must not rely
    -- on. The next loop is over jsonb_array_elements_TEXT, so it is text.
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_entry -> 'features') AS f(value)
                WHERE jsonb_typeof(f.value) IS DISTINCT FROM 'string') THEN
      RETURN 'plans.features.' || v_slug;
    END IF;
    FOR v_feature IN SELECT f.value FROM jsonb_array_elements_text(v_entry -> 'features') AS f(value) LOOP
      IF length(v_feature) > 60 OR v_feature !~ '^[a-z][a-z0-9_]*$' THEN
        RETURN 'plans.features.' || v_slug || '.key';
      END IF;
    END LOOP;

    IF (v_entry ->> 'is_active')::boolean THEN
      v_active := v_active || v_slug;
    END IF;
  END LOOP;

  -- Open decision D11, and the header says why it is refused rather than
  -- stored: the active set must be exactly the slugs this build can consume.
  FOREACH v_slug IN ARRAY app_private.plan_required_slugs() LOOP
    IF NOT (v_slug = ANY (v_active)) THEN
      RETURN 'plans.required.' || v_slug;
    END IF;
  END LOOP;
  FOREACH v_slug IN ARRAY v_active LOOP
    IF NOT (v_slug = ANY (app_private.plan_required_slugs())) THEN
      RETURN 'plans.extra.' || v_slug;
    END IF;
  END LOOP;

  /*
    I1, monotonicity. Consecutive active plans by rank are enough: the subset
    relation is transitive, so a ⊆ b and b ⊆ c give a ⊆ c, and naming the
    adjacent pair is the message an operator can act on.
  */
  FOR v_pair IN
    WITH active AS (
      SELECT e.value ->> 'slug' AS slug,
             (e.value ->> 'rank')::integer AS rank,
             coalesce((SELECT array_agg(f.value ORDER BY f.value COLLATE "C")
                         FROM jsonb_array_elements_text(e.value -> 'features') AS f(value)),
                      ARRAY[]::text[]) AS features
        FROM jsonb_array_elements(p_plans) AS e(value)
       WHERE (e.value ->> 'is_active')::boolean
    ),
    ordered AS (
      SELECT slug, rank, features,
             lead(slug)     OVER (ORDER BY rank) AS next_slug,
             lead(features) OVER (ORDER BY rank) AS next_features
        FROM active
    )
    SELECT o.slug, o.next_slug,
           (SELECT k FROM unnest(o.features) AS k
             WHERE NOT (k = ANY (o.next_features)) ORDER BY k COLLATE "C" LIMIT 1) AS lost
      FROM ordered o
     WHERE o.next_slug IS NOT NULL
       AND NOT (o.next_features @> o.features)
     ORDER BY o.rank
     LIMIT 1
  LOOP
    RETURN 'plans.monotonicity.' || v_pair.slug || '.' || v_pair.next_slug || '.' || coalesce(v_pair.lost, '?');
  END LOOP;

  /*
    I2, completeness. Every key the application knows must be granted by some
    active plan, because the browser reads a feature no plan grants as premium
    and a short catalogue would silently lock those screens for every customer
    below premium. Keys this build does not know stay valid: that is how a
    feature is seeded before the release that gates it, and
    20260917120000:57-60 states the same rule for the map being replaced.
  */
  SELECT array_agg(k.key ORDER BY k.key COLLATE "C") INTO v_missing
    FROM unnest(app_private.plan_feature_keys()) AS k(key)
   WHERE NOT EXISTS (
     SELECT 1 FROM jsonb_array_elements(p_plans) AS e(value)
      WHERE (e.value ->> 'is_active')::boolean
        AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(e.value -> 'features') AS f(value)
                     WHERE f.value = k.key));
  IF array_length(v_missing, 1) IS NOT NULL THEN
    RETURN 'plans.missing.' || v_missing[1];
  END IF;

  RETURN NULL;
END;
$$;

-- ─── 6. Reading: the catalogue, and the two projections ─────────────────────

-- The active catalogue as the value platform_plans_save takes back, so the
-- panel round-trips exactly what it was given rather than rebuilding a payload
-- from a client-side registry. company_role_save's wholesale-replace defect
-- comes from rebuilding; this shape is what avoids it.
CREATE OR REPLACE FUNCTION app_private.plan_catalogue()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'slug',                p.slug,
             'name',                p.name,
             'rank',                p.rank,
             'price_per_car_cents', p.price_per_car_cents,
             'features',            to_jsonb(p.features),
             'is_active',           p.is_active
           ) ORDER BY p.rank)
      FROM public.plans p), '[]'::jsonb);
END;
$$;

/*
  The effective price book: the stored row's three book-level keys, with
  price_per_car_cents built from the catalogue.

  The fleet tiers, the yearly discount and the first month are NOT per-plan and
  stay where they are. The design document's section 4.1 is explicit that the
  book loses exactly one key and keeps its row, its version, its validator
  branch, its audit trail and its settings.read-for-billing special case.

  NULL rather than a partial book when the catalogue cannot supply all three
  required prices, so compute_plan_price raises its P0002 and
  platform_invoice_quotes answers price_book_unreadable. An empty catalogue
  must raise, never price at zero: a price of 0,00 EUR is a claim.
  tests/rls/pricing.sql already asserts the same of a missing book row.
*/
CREATE OR REPLACE FUNCTION app_private.plan_price_book()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_book   jsonb := app_private.platform_setting_value('price_book');
  v_prices jsonb;
BEGIN
  IF v_book IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT jsonb_object_agg(p.slug, p.price_per_car_cents) INTO v_prices
    FROM public.plans p
   WHERE p.is_active
     AND p.slug = ANY (app_private.plan_required_slugs());

  IF v_prices IS NULL
     OR (SELECT count(*) FROM jsonb_object_keys(v_prices))
        <> coalesce(array_length(app_private.plan_required_slugs(), 1), 0) THEN
    RETURN NULL;
  END IF;

  RETURN v_book || jsonb_build_object('price_per_car_cents', v_prices);
END;
$$;

/*
  The effective feature map: feature key -> the lowest-ranked active plan that
  grants it.

  A feature no active plan grants is simply absent, which the browser's
  minPlanForFeature reads as premium — the fail-closed read wall, unchanged.
  I2 makes that unreachable for a key the build knows, and the absence is the
  honest answer for one it does not.
*/
CREATE OR REPLACE FUNCTION app_private.plan_feature_map()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN coalesce((
    SELECT jsonb_object_agg(g.feature, g.slug)
      FROM (SELECT DISTINCT ON (f.feature) f.feature, p.slug
              FROM public.plans p
              CROSS JOIN LATERAL unnest(p.features) AS f(feature)
             WHERE p.is_active
             ORDER BY f.feature, p.rank) g), '{}'::jsonb);
END;
$$;

-- ─── 7. The four readers ────────────────────────────────────────────────────

/*
  20261015160000's body with one change and no others: the book comes from
  app_private.plan_price_book() instead of the stored setting row. The P0002
  fail-closed branch, the signature, the volatility, the search_path and the
  call into price_book_price are carried over character for character.
*/
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
  v_book jsonb := app_private.plan_price_book();
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
  'The price of a plan, car count and billing cycle under the effective price book — public.plans for the price per car, the price_book setting for the fleet tiers, the yearly discount and the first month — in euros; with p_first_invoice and a book that carries first_month_cents, that flat figure instead. calcPricing() in src/utils/pricing.ts computes the same from the same book.';

-- 20261026110000's body with one change and no others: the book comes from
-- the projection. Everything else — the argument validation, the
-- billing.manage gate, the audited read row, the active-cars fleet subquery,
-- the first-invoice test and the ORDER BY — is carried over verbatim.
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

  v_book := app_private.plan_price_book();
  IF v_book IS NULL OR app_private.platform_settings_problem('price_book', v_book) IS NOT NULL THEN
    PERFORM app_private.platform_read_record(c_action, 'error', NULL, 'invoice',
                                             jsonb_build_object('request', v_request, 'reason', 'price_book_unreadable'));
    RETURN jsonb_build_object('ok', false, 'reason', 'price_book_unreadable');
  END IF;

  WITH fleet AS (
    SELECT company_id, count(*)::integer AS active_cars
      FROM public.cars
     WHERE status IS DISTINCT FROM 'inactive'
     GROUP BY company_id
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'subscription_id', q.subscription_id,
           'company_id',      q.company_id,
           'company_name',    q.company_name,
           'plan',            q.plan,
           -- The stored allowance. Informational since 20261026110000: it
           -- prices nothing and caps nothing.
           'car_limit',       q.car_limit,
           -- What the amount IS computed from.
           'active_cars',     q.active_cars,
           'billing_cycle',   q.billing_cycle,
           'first_invoice',   q.first_invoice,
           'amount_cents',    app_private.invoice_amount_cents(v_book, q.plan, q.active_cars, q.billing_cycle, q.first_invoice)
         ) ORDER BY q.company_name, q.subscription_id), '[]'::jsonb)
    INTO v_items
    FROM (
      SELECT s.id AS subscription_id, s.company_id, c.name AS company_name,
             c.plan, c.subscription_car_limit AS car_limit, c.billing_cycle,
             coalesce(f.active_cars, 0) AS active_cars,
             NOT EXISTS (
               SELECT 1
                 FROM public.subscription_invoices i
                WHERE i.company_id = s.company_id
                  AND i.status <> 'canceled'
                  AND (i.invoice_year * 12 + i.invoice_month) < (p_year * 12 + p_month)
             ) AS first_invoice
        FROM public.company_subscriptions s
        JOIN public.companies c ON c.id = s.company_id
        LEFT JOIN fleet f ON f.company_id = s.company_id
       WHERE s.status = 'active'
    ) q;

  PERFORM app_private.platform_read_record(c_action, 'ok', NULL, 'invoice',
    jsonb_build_object('request', v_request, 'returned', jsonb_array_length(v_items)));

  RETURN jsonb_build_object('ok', true, 'month', p_month, 'year', p_year, 'items', v_items);
END;
$$;

/*
  THE LIVE BODIES, read with pg_get_functiondef on production 26.10.2026, and
  not the text of the migration that last wrote `CREATE OR REPLACE` for them.
  That distinction cost a kit run and is worth stating once:

  `20261015170000_remove_free_trial.sql` edits these two functions with a
  `replace()` over `pg_get_functiondef(...)` — `pg_temp._ntr_patch` — so the
  file contains no `CREATE OR REPLACE FUNCTION public.get_app_config` text at
  all. Grepping the migration chain for that phrase finds 20260916150000 and
  20260920130010 and misses the edit entirely, and both of those bodies still
  carry `'trial_days', app_private.signup_trial_days()` — a function
  20261015170000 DROPPED. Restating from the migration text therefore
  re-introduced a call to a function that does not exist, and every
  get_app_config / get_public_config call answered 42883.

  So: neither key is in the live shape. get_public_config returns price_book
  alone and get_app_config returns the four keys below. Self-check 8b pins the
  exact key sets, so a future restatement from stale migration text fails here
  rather than at runtime.
*/
CREATE OR REPLACE FUNCTION public.get_public_config()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN jsonb_build_object(
    'price_book', app_private.plan_price_book()
  );
END;
$$;

-- The live body with two changes and no others: the price book and the feature
-- map are the projections. The flags and the announcements are read as before.
CREATE OR REPLACE FUNCTION public.get_app_config()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN jsonb_build_object(
    'price_book',    app_private.plan_price_book(),
    'plan_features', app_private.plan_feature_map(),
    'feature_flags', coalesce(app_private.platform_setting_value('feature_flags'), '{}'::jsonb),
    'announcements', app_private.announcements_for_company(public.get_active_company_id())
  );
END;
$$;

-- ─── 8. Refusal sentences ───────────────────────────────────────────────────

/*
  20260923140000's live body — read with pg_get_functiondef on production
  26.10.2026, not from migration text — with four sentences added at the end,
  every existing branch carried over character for character. Four sentences
  added, NOTHING ELSE CHANGED. Self-check 11 re-states all twenty-one of the
  old sentences plus the fallback, on the terms that file set.

  ─── A behavioural change was written here and then reverted. Read this. ───

  The refusal branch ignores `p_extra`:

      WHEN p_reason IS NULL THEN jsonb_build_object('success', true) || p_extra
      ELSE jsonb_build_object('success', false, 'reason', …, 'error', …)

  so `platform_plans_save` returning
  `platform_rpc_response('invalid_value', {"problem": …})` answered with no
  `problem` at all, and the panel would have had to print "Die Pläne sind in
  dieser Form nicht gültig." with nothing saying WHICH plan or WHICH feature.
  The kit caught it.

  The obvious fix is to merge `p_extra` in the refusal branch too, and that was
  written. It is wrong, and what makes it wrong is two measurements of the live
  catalogue:

  1. `app_private.platform_rpc_finish` passes
     `CASE WHEN p_reason IS NULL THEN p_extra END` — it goes out of its way to
     pass NULL on a refusal. Extras-on-success-only is a decision somebody
     made, not an omission nobody noticed.
  2. There is already an idiom for adding detail to a refusal, used twice:
     `public.platform_company_delete` and `public.platform_company_set_module`
     both write `platform_rpc_response('<reason>') || jsonb_build_object(…)`,
     merging ON TOP so they can override `error` with a specific sentence.

  So this file follows the idiom and leaves the shared helper's behaviour
  exactly as it is. That keeps twenty-five other RPCs out of the blast radius
  of a change they do not need. Self-check 11 pins the convention — the helper
  must still drop a refusal's extra — so a later "tidy-up" that merges it finds
  this reasoning rather than re-deriving it.
*/
CREATE OR REPLACE FUNCTION app_private.platform_rpc_response(p_reason text, p_extra jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN p_reason IS NULL THEN jsonb_build_object('success', true) || coalesce(p_extra, '{}'::jsonb)
    ELSE jsonb_build_object(
      'success', false,
      'reason',  p_reason,
      'error',   CASE p_reason
        WHEN 'denied'             THEN 'Keine Berechtigung für diese Aktion.'
        WHEN 'invalid'            THEN 'Ungültige Eingabe.'
        WHEN 'not_found'          THEN 'Nicht gefunden.'
        WHEN 'invalid_status'     THEN 'Diese Aktion ist im aktuellen Zustand nicht möglich.'
        WHEN 'slug_taken'         THEN 'Dieser Slug ist bereits vergeben.'
        WHEN 'code_taken'         THEN 'Dieser Code existiert bereits.'
        WHEN 'no_trial'           THEN 'Für dieses Unternehmen ist keine Testphase eingetragen.'
        WHEN 'plan_inactive'      THEN 'Dieser Plan ist nicht aktiv.'
        WHEN 'account_not_found'  THEN 'Konto nicht gefunden.'
        WHEN 'account_in_company' THEN 'Dieses Konto gehört zu einem Unternehmen und kann nicht zum Plattform-Team hinzugefügt werden.'
        WHEN 'already_staff'      THEN 'Dieses Konto gehört bereits zum Plattform-Team.'
        WHEN 'already_disabled'   THEN 'Dieses Konto ist bereits deaktiviert.'
        WHEN 'already_enabled'    THEN 'Dieses Konto ist bereits aktiv.'
        WHEN 'last_owner'         THEN 'Der letzte aktive Inhaber der Plattform kann nicht deaktiviert oder herabgestuft werden.'
        WHEN 'role_requires_3_3'  THEN 'Andere Rollen als "owner" sind erst ab Plan-Schritt 3.3 möglich.'
        -- 20260917140000, the support sessions
        WHEN 'context_open'       THEN 'Es ist bereits ein Zugriff auf ein anderes Unternehmen offen. Bitte zuerst beenden.'
        WHEN 'reason_required'    THEN 'Für eine Support-Sitzung ist ein Grund erforderlich.'
        WHEN 'no_session'         THEN 'Diese Anmeldung ist nicht mehr gültig. Bitte erneut anmelden.'
        WHEN 'no_context'         THEN 'Es ist kein Unternehmenszugriff offen.'
        -- 20260923140000, the role change
        WHEN 'member_disabled'    THEN 'Dieses Mitglied ist deaktiviert. Bitte zuerst aktivieren und die Rolle danach ändern.'
        WHEN 'already_in_role'    THEN 'Dieses Mitglied hat diese Rolle bereits.'
        -- 20261026120000, the plan catalogue. invalid_value carries `problem`,
        -- which the panel renders as its own sentence naming the plan and the
        -- feature: a validation failure reported as "Keine Berechtigung" is
        -- the company_role_save defect and must not be repeated here.
        WHEN 'invalid_value'      THEN 'Die Pläne sind in dieser Form nicht gültig.'
        WHEN 'version_conflict'   THEN 'Die Pläne wurden zwischenzeitlich geändert. Bitte neu laden.'
        WHEN 'plan_in_use'        THEN 'Dieser Plan ist einem Unternehmen zugeordnet und kann nicht entfernt werden.'
        WHEN 'catalogue_missing'  THEN 'Es ist kein Plan-Katalog vorhanden.'
        ELSE 'Die Aktion konnte nicht ausgeführt werden.'
      END)
  END;
$$;

-- ─── 9. Reading and writing the catalogue ───────────────────────────────────

/*
  The panel's read. No capability and no audit row: the rows are already
  SELECT-able by every signed-in principal through PostgREST, because a plan's
  name and price are what the plan cards print, so an RPC adds nothing but the
  version — and a version is not a secret. get_legal_pages() is the same shape.
  STABLE, so PostgREST may answer it with GET; it writes nothing.
*/
CREATE OR REPLACE FUNCTION public.platform_plans_list()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_meta app_private.plan_catalogue_meta%ROWTYPE;
BEGIN
  SELECT * INTO v_meta FROM app_private.plan_catalogue_meta WHERE id;
  RETURN jsonb_build_object(
    'ok',         true,
    'plans',      app_private.plan_catalogue(),
    'version',    coalesce(v_meta.version, 0),
    'updated_at', v_meta.updated_at,
    'updated_by', v_meta.updated_by,
    -- What the catalogue cannot currently express, so the screen can say so
    -- rather than offer a control that would be refused. Open decision D11.
    'fixed_slugs', to_jsonb(app_private.plan_required_slugs()),
    'feature_keys', to_jsonb(app_private.plan_feature_keys())
  );
END;
$$;

COMMENT ON FUNCTION public.platform_plans_list() IS
  'The whole plan catalogue with its version, for the panel''s plan screen. No capability and no audit row: public.plans is SELECT-able by every signed-in principal and the version is not a secret.';

/*
  The one writer. One transaction, pricing.manage first, the whole catalogue as
  one payload, and exactly one audit row.

  Wholesale, because the invariants are cross-row — but NOT the wholesale
  replace company_role_save does. Two differences, both deliberate:

   1. The payload is what platform_plans_list() returned, round-tripped, not a
      payload rebuilt from a client-side registry. That rebuild is where
      company_role_save loses a key the build does not know.
   2. `features` entries the build does not know are PRESERVED. The validator
      tolerates them exactly as plan_features does today, because seeding a
      feature before the release that gates it is load-bearing for every future
      gated screen.

  An upsert and not DELETE-then-INSERT: companies.plan references plans(slug),
  so deleting the live rows would violate the foreign key mid-transaction. A
  slug absent from the payload is deleted afterwards, and the FK refuses that
  for a plan a company still names — reported as plan_in_use rather than as a
  raw 23503.
*/
CREATE OR REPLACE FUNCTION public.platform_plans_save(
  p_plans            jsonb,
  p_expected_version integer
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_category CONSTANT text := 'settings';
  c_action   CONSTANT text := 'platform_plans.save';
  v_uid      uuid := auth.uid();
  v_problem  text;
  v_before   jsonb;
  v_meta     app_private.plan_catalogue_meta%ROWTYPE;
  v_slugs    text[];
  v_version  integer;
BEGIN
  IF p_plans IS NULL OR p_expected_version IS NULL THEN
    RAISE EXCEPTION 'platform_plans_save: invalid arguments' USING ERRCODE = '22023';
  END IF;

  IF NOT app_private.platform_rpc_authorize('pricing.manage', c_category, c_action,
                                            NULL, 'plan_catalogue', NULL) THEN
    RETURN app_private.platform_rpc_response('denied');
  END IF;

  v_problem := app_private.plan_catalogue_problem(p_plans);
  IF v_problem IS NOT NULL THEN
    PERFORM app_private.platform_rpc_record(c_category, c_action, 'invalid_value', NULL,
                                            'plan_catalogue', NULL, NULL,
                                            jsonb_build_object('problem', v_problem));
    -- `||` and not a second argument: the helper drops a refusal's extra on
    -- purpose, and this is the idiom platform_company_delete and
    -- platform_company_set_module already use. The header says why.
    RETURN app_private.platform_rpc_response('invalid_value')
           || jsonb_build_object('problem', v_problem);
  END IF;

  -- The lock serialises two saves, so both cannot pass the version check.
  SELECT * INTO v_meta FROM app_private.plan_catalogue_meta WHERE id FOR UPDATE;
  IF NOT FOUND THEN
    -- The migration seeds this row; its absence is a broken release.
    PERFORM app_private.platform_rpc_record(c_category, c_action, 'catalogue_missing', NULL,
                                            'plan_catalogue', NULL, NULL, NULL);
    RETURN app_private.platform_rpc_response('catalogue_missing');
  END IF;

  IF v_meta.version IS DISTINCT FROM p_expected_version THEN
    PERFORM app_private.platform_rpc_record(c_category, c_action, 'version_conflict', NULL,
                                            'plan_catalogue', NULL, NULL,
                                            jsonb_build_object('expected_version', p_expected_version,
                                                               'current_version', v_meta.version));
    RETURN app_private.platform_rpc_response('version_conflict')
           || jsonb_build_object('current_version', v_meta.version);
  END IF;

  v_before := app_private.plan_catalogue();

  INSERT INTO public.plans (slug, name, rank, price_per_car_cents, features, is_active)
  SELECT e.value ->> 'slug',
         btrim(e.value ->> 'name'),
         (e.value ->> 'rank')::smallint,
         (e.value ->> 'price_per_car_cents')::integer,
         coalesce((SELECT array_agg(f.value ORDER BY f.value COLLATE "C")
                     FROM jsonb_array_elements_text(e.value -> 'features') AS f(value)),
                  ARRAY[]::text[]),
         (e.value ->> 'is_active')::boolean
    FROM jsonb_array_elements(p_plans) AS e(value)
      ON CONFLICT (slug) DO UPDATE
         SET name                = EXCLUDED.name,
             rank                = EXCLUDED.rank,
             price_per_car_cents = EXCLUDED.price_per_car_cents,
             features            = EXCLUDED.features,
             is_active           = EXCLUDED.is_active,
             updated_at          = now();

  SELECT array_agg(e.value ->> 'slug') INTO v_slugs
    FROM jsonb_array_elements(p_plans) AS e(value);

  BEGIN
    DELETE FROM public.plans WHERE slug <> ALL (v_slugs);
  EXCEPTION WHEN foreign_key_violation THEN
    -- A company still names the plan. Reported as itself, never as a raw
    -- 23503 the panel would print as "Keine Berechtigung".
    PERFORM app_private.platform_rpc_record(c_category, c_action, 'plan_in_use', NULL,
                                            'plan_catalogue', NULL, NULL, NULL);
    RETURN app_private.platform_rpc_response('plan_in_use');
  END;

  /*
    The rollback shadow, and nothing reads it.

    Both keys are rewritten from the catalogue in this transaction so the
    release BEFORE this one — which reads the stored rows — prices and gates
    exactly as the catalogue says. That is what makes this migration
    reversible without a SCHEMA_EPOCH bump.

    Never read these two rows for pricing or gating again: plan_price_book()
    and plan_feature_map() are the readers, and the price-book editor's per-car
    fields and the whole plan-features tab are read-only from this release on.
  */
  UPDATE app_private.platform_settings s
     SET value      = s.value || jsonb_build_object(
                        'price_per_car_cents',
                        (SELECT jsonb_object_agg(p.slug, p.price_per_car_cents)
                           FROM public.plans p
                          WHERE p.is_active
                            AND p.slug = ANY (app_private.plan_required_slugs()))),
         version    = s.version + 1,
         updated_by = v_uid,
         updated_at = now()
   WHERE s.key = 'price_book';

  UPDATE app_private.platform_settings s
     SET value      = app_private.plan_feature_map(),
         version    = s.version + 1,
         updated_by = v_uid,
         updated_at = now()
   WHERE s.key = 'plan_features';

  UPDATE app_private.plan_catalogue_meta m
     SET version    = m.version + 1,
         updated_by = v_uid,
         updated_at = now()
   WHERE m.id
  RETURNING m.version INTO v_version;

  PERFORM app_private.platform_rpc_record(c_category, c_action, NULL, NULL,
                                          'plan_catalogue', NULL,
                                          jsonb_build_object('version', v_meta.version, 'plans', v_before),
                                          jsonb_build_object('version', v_version, 'plans', app_private.plan_catalogue()));

  RETURN app_private.platform_rpc_response(NULL, jsonb_build_object(
    'version', v_version,
    'plans',   app_private.plan_catalogue()));
END;
$$;

COMMENT ON FUNCTION public.platform_plans_save(jsonb, integer) IS
  'Replaces the whole plan catalogue in one transaction: pricing.manage, the cross-row invariants I1 (monotonicity) and I2 (completeness) checked as a set, optimistic concurrency on the catalogue version, one audit row, and the price_book and plan_features settings rows rewritten from the catalogue as a rollback shadow nothing reads.';

-- ─── 10. Ownership ──────────────────────────────────────────────────────────

-- Each of these reaches app_private, which only its owner or a superuser can
-- (20260916110010, "Ownership").
ALTER TABLE    public.plans                                        OWNER TO CURRENT_USER;
ALTER TABLE    app_private.plan_catalogue_meta                     OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.plan_required_slugs()                   OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.plan_catalogue_problem(jsonb)           OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.plan_catalogue()                        OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.plan_price_book()                       OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.plan_feature_map()                      OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.platform_rpc_response(text, jsonb)      OWNER TO CURRENT_USER;
ALTER FUNCTION public.compute_plan_price(text, integer, text, boolean) OWNER TO CURRENT_USER;
ALTER FUNCTION public.platform_invoice_quotes(integer, integer)    OWNER TO CURRENT_USER;
ALTER FUNCTION public.get_public_config()                          OWNER TO CURRENT_USER;
ALTER FUNCTION public.get_app_config()                             OWNER TO CURRENT_USER;
ALTER FUNCTION public.platform_plans_list()                        OWNER TO CURRENT_USER;
ALTER FUNCTION public.platform_plans_save(jsonb, integer)          OWNER TO CURRENT_USER;

-- ─── 11. Privileges ─────────────────────────────────────────────────────────

-- Supabase's default privileges grant EXECUTE on every new public function to
-- PUBLIC, anon, authenticated and service_role, so each needs its own REVOKE
-- and not only the one that looks wrong.
REVOKE ALL ON FUNCTION app_private.plan_required_slugs()         FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.plan_catalogue_problem(jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.plan_catalogue()              FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.plan_price_book()             FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.plan_feature_map()            FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.platform_rpc_response(text, jsonb) FROM PUBLIC, anon, authenticated, service_role;

-- The panel calls these signed in, and nothing else does: no anon, and no
-- service role, which has no auth.uid() to be an actor.
REVOKE ALL ON FUNCTION public.platform_plans_list()              FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_plans_list()           TO authenticated;
REVOKE ALL ON FUNCTION public.platform_plans_save(jsonb, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_plans_save(jsonb, integer) TO authenticated;

-- CREATE OR REPLACE keeps the owner and the ACL, so these only re-assert what
-- the earlier files set. They are here because a restatement that silently
-- lost a grant would leave the product unable to price at all.
REVOKE ALL ON FUNCTION public.compute_plan_price(text, integer, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.compute_plan_price(text, integer, text, boolean) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.platform_invoice_quotes(integer, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_invoice_quotes(integer, integer) TO authenticated;
REVOKE ALL ON FUNCTION public.get_public_config() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_public_config() TO anon, authenticated;
REVOKE ALL ON FUNCTION public.get_app_config() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_app_config() TO authenticated;

-- ─── 12. Self-checks ────────────────────────────────────────────────────────

DO $$
DECLARE
  c_save    CONSTANT text := 'public.platform_plans_save(jsonb,integer)';
  c_list    CONSTANT text := 'public.platform_plans_list()';
  v_body    text;
  v_missing text;
  v_wrong   text;
  v_problem text;
  v_stored  jsonb;
  v_proj    jsonb;
  v_sig     text;
BEGIN
  -- 1. The table's shape: RLS on, SELECT only, no write policy, no write grant.
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.plans'::regclass AND relrowsecurity) THEN
    RAISE EXCEPTION '20261026120000 self-check 1: RLS is not enabled on public.plans';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'plans' AND cmd <> 'SELECT') THEN
    RAISE EXCEPTION '20261026120000 self-check 1: public.plans has a write policy; the cross-row invariants cannot be enforced per row';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'plans') <> 1 THEN
    RAISE EXCEPTION '20261026120000 self-check 1: public.plans must carry exactly one policy, got %',
      (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'plans');
  END IF;
  FOREACH v_sig IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE'] LOOP
    IF has_table_privilege('authenticated', 'public.plans', v_sig)
       OR has_table_privilege('anon', 'public.plans', v_sig)
       OR has_table_privilege('service_role', 'public.plans', v_sig) THEN
      RAISE EXCEPTION '20261026120000 self-check 1: an API role holds % on public.plans', v_sig;
    END IF;
  END LOOP;
  IF NOT has_table_privilege('authenticated', 'public.plans', 'SELECT') THEN
    RAISE EXCEPTION '20261026120000 self-check 1: authenticated cannot read public.plans';
  END IF;
  IF has_table_privilege('anon', 'public.plans', 'SELECT') THEN
    RAISE EXCEPTION '20261026120000 self-check 1: anon reads public.plans; the plan cards are served by get_public_config()';
  END IF;
  -- The deferred unique constraint: a rank swap in one upsert depends on it.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.plans'::regclass AND conname = 'plans_rank_key'
                    AND condeferrable AND condeferred) THEN
    RAISE EXCEPTION '20261026120000 self-check 1: plans_rank_key must be DEFERRABLE INITIALLY DEFERRED, or a save that swaps two ranks is refused for a conflict the committed state does not hold';
  END IF;
  -- app_private stays unreachable.
  IF has_table_privilege('authenticated', 'app_private.plan_catalogue_meta', 'SELECT')
     OR has_table_privilege('anon', 'app_private.plan_catalogue_meta', 'SELECT')
     OR has_table_privilege('service_role', 'app_private.plan_catalogue_meta', 'SELECT') THEN
    RAISE EXCEPTION '20261026120000 self-check 1: an API role reads app_private.plan_catalogue_meta';
  END IF;

  -- 2. The seed exists, is the three slugs, and carries the live prices.
  IF (SELECT count(*) FROM public.plans) <> 3 THEN
    RAISE EXCEPTION '20261026120000 self-check 2: the catalogue holds % rows, expected the three seeded plans',
      (SELECT count(*) FROM public.plans);
  END IF;
  SELECT string_agg(format('%s rank %s / %s cents', p.slug, p.rank, p.price_per_car_cents), '; ' ORDER BY p.rank)
    INTO v_missing
    FROM public.plans p
   WHERE (p.slug, p.rank) NOT IN (('basic', 0), ('advanced', 1), ('premium', 2));
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION '20261026120000 self-check 2: a seeded plan has the wrong rank — PLAN_RANK in src/utils/planFeatures.ts is the browser''s copy: %', v_missing;
  END IF;
  IF EXISTS (SELECT 1 FROM public.plans WHERE NOT is_active) THEN
    RAISE EXCEPTION '20261026120000 self-check 2: a seeded plan is inactive; all three are the slugs this build consumes';
  END IF;

  -- 3. The seed satisfies its own validator. A release whose seed violates the
  --    rule it ships would otherwise refuse the operator's first save.
  v_problem := app_private.plan_catalogue_problem(app_private.plan_catalogue());
  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION '20261026120000 self-check 3: the seeded catalogue fails its own validator: %', v_problem;
  END IF;

  -- 4. THE PRICE PROOF. Every combination the four parity gates pin, priced
  --    from the stored book and from the projection, compared as value AND as
  --    text — so a change of numeric scale cannot pass unnoticed, which is the
  --    assertion 20260916150000's DO block makes and the one easiest to lose.
  SELECT string_agg(format('%s/%s/%s: stored %s, projected %s',
                           g.plan, g.cars, g.cycle, g.old_price, g.new_price), '; ')
    INTO v_wrong
    FROM (
      SELECT p.plan, c.cars, y.cycle,
             app_private.price_book_price(app_private.platform_setting_value('price_book'),
                                          p.plan, c.cars, y.cycle, f.first) AS old_price,
             app_private.price_book_price(app_private.plan_price_book(),
                                          p.plan, c.cars, y.cycle, f.first) AS new_price
        FROM unnest(ARRAY['basic', 'advanced', 'premium', 'gold', NULL]) AS p(plan)
        CROSS JOIN unnest(ARRAY[0, 1, 3, 5, 6, 10, 11, 25, -3, NULL]) AS c(cars)
        CROSS JOIN unnest(ARRAY['monthly', 'yearly', 'weekly', NULL]) AS y(cycle)
        CROSS JOIN unnest(ARRAY[false, true, NULL]) AS f(first)
    ) g
   WHERE g.old_price IS DISTINCT FROM g.new_price
      OR g.old_price::text IS DISTINCT FROM g.new_price::text;
  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '20261026120000 self-check 4: the projected book prices differently from the stored one: %', v_wrong;
  END IF;

  -- The same for the amount in cents, the single place an invoice is decided.
  SELECT string_agg(format('%s/%s/%s/%s: stored %s, projected %s',
                           g.plan, g.cars, g.cycle, g.first, g.old_cents, g.new_cents), '; ')
    INTO v_wrong
    FROM (
      SELECT p.plan, c.cars, y.cycle, f.first,
             app_private.invoice_amount_cents(app_private.platform_setting_value('price_book'),
                                              p.plan, c.cars, y.cycle, f.first) AS old_cents,
             app_private.invoice_amount_cents(app_private.plan_price_book(),
                                              p.plan, c.cars, y.cycle, f.first) AS new_cents
        FROM unnest(ARRAY['basic', 'advanced', 'premium', 'gold', NULL]) AS p(plan)
        CROSS JOIN unnest(ARRAY[0, 1, 3, 5, 6, 10, 11, 25, -3, NULL]) AS c(cars)
        CROSS JOIN unnest(ARRAY['monthly', 'yearly', 'weekly', NULL]) AS y(cycle)
        CROSS JOIN unnest(ARRAY[false, true, NULL]) AS f(first)
    ) g
   WHERE g.old_cents IS DISTINCT FROM g.new_cents
      OR g.old_cents::text IS DISTINCT FROM g.new_cents::text;
  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '20261026120000 self-check 4: the projected book decides a different amount: %', v_wrong;
  END IF;

  -- The projected book is byte-identical to the stored one, which is the
  -- strongest form of "nothing moved" available today and is what makes the
  -- rollback shadow trivially correct on day one.
  v_stored := app_private.platform_setting_value('price_book');
  v_proj   := app_private.plan_price_book();
  IF v_proj IS DISTINCT FROM v_stored THEN
    RAISE EXCEPTION '20261026120000 self-check 4: the projected book differs from the stored one. stored %, projected %',
      v_stored, v_proj;
  END IF;
  IF app_private.platform_settings_problem('price_book', v_proj) IS NOT NULL THEN
    RAISE EXCEPTION '20261026120000 self-check 4: the projected book fails the price_book validator: %',
      app_private.platform_settings_problem('price_book', v_proj);
  END IF;

  -- 5. The feature map projection reproduces the stored map exactly, and is a
  --    map the validator would accept — including its completeness rule.
  v_stored := app_private.platform_setting_value('plan_features');
  v_proj   := app_private.plan_feature_map();
  IF v_proj IS DISTINCT FROM v_stored THEN
    RAISE EXCEPTION '20261026120000 self-check 5: the projected feature map differs from the stored one. stored %, projected %',
      v_stored, v_proj;
  END IF;
  IF app_private.platform_settings_problem('plan_features', v_proj) IS NOT NULL THEN
    RAISE EXCEPTION '20261026120000 self-check 5: the projected feature map fails the plan_features validator: %',
      app_private.platform_settings_problem('plan_features', v_proj);
  END IF;
  IF array_length(app_private.plan_features_missing_keys(v_proj), 1) IS NOT NULL THEN
    RAISE EXCEPTION '20261026120000 self-check 5: the projected feature map does not name every feature the build knows';
  END IF;

  -- 6. The validator refuses each thing it exists to refuse. Every one of
  --    these is a deliberate violation built from the seed, so a branch that
  --    stopped firing fails the release rather than going quiet.
  SELECT string_agg(t.label, '; ') INTO v_missing
    FROM (VALUES
      ('not an array',      app_private.plan_catalogue_problem('{}'::jsonb),                     'plans'),
      ('empty',             app_private.plan_catalogue_problem('[]'::jsonb),                     'plans'),
      ('I2 completeness',   app_private.plan_catalogue_problem(
         (SELECT jsonb_agg(CASE WHEN e.value ->> 'slug' = 'premium'
                                THEN jsonb_set(e.value, '{features}',
                                     (SELECT coalesce(jsonb_agg(f.value), '[]'::jsonb)
                                        FROM jsonb_array_elements(e.value -> 'features') AS f(value)
                                       WHERE f.value <> '"gehaelter"'::jsonb))
                                ELSE e.value END)
            FROM jsonb_array_elements(app_private.plan_catalogue()) AS e(value))),
                                                                                                 'plans.missing.gehaelter'),
      ('I1 monotonicity',   app_private.plan_catalogue_problem(
         (SELECT jsonb_agg(CASE WHEN e.value ->> 'slug' = 'basic'
                                THEN jsonb_set(e.value, '{features}',
                                     (e.value -> 'features') || '["gehaelter"]'::jsonb)
                                ELSE e.value END)
            FROM jsonb_array_elements(app_private.plan_catalogue()) AS e(value))),
                                                                                                 'plans.monotonicity.basic.advanced.gehaelter'),
      ('a required slug deactivated', app_private.plan_catalogue_problem(
         (SELECT jsonb_agg(CASE WHEN e.value ->> 'slug' = 'advanced'
                                THEN jsonb_set(e.value, '{is_active}', 'false'::jsonb)
                                ELSE e.value END)
            FROM jsonb_array_elements(app_private.plan_catalogue()) AS e(value))),
                                                                                                 'plans.required.advanced'),
      ('a fourth plan',     app_private.plan_catalogue_problem(
         app_private.plan_catalogue()
         || jsonb_build_array(jsonb_build_object('slug', 'gold', 'name', 'Gold', 'rank', 3,
                                                 'price_per_car_cents', 9000,
                                                 'features', to_jsonb(app_private.plan_feature_keys()),
                                                 'is_active', true))),
                                                                                                 'plans.extra.gold'),
      ('a duplicate rank',  app_private.plan_catalogue_problem(
         (SELECT jsonb_agg(CASE WHEN e.value ->> 'slug' = 'advanced'
                                THEN jsonb_set(e.value, '{rank}', '0'::jsonb)
                                ELSE e.value END)
            FROM jsonb_array_elements(app_private.plan_catalogue()) AS e(value))),
                                                                                                 'plans.rank.duplicate.0'),
      ('a blank name',      app_private.plan_catalogue_problem(
         (SELECT jsonb_agg(CASE WHEN e.value ->> 'slug' = 'basic'
                                THEN jsonb_set(e.value, '{name}', '"   "'::jsonb)
                                ELSE e.value END)
            FROM jsonb_array_elements(app_private.plan_catalogue()) AS e(value))),
                                                                                                 'plans.name.basic'),
      ('a price out of bounds', app_private.plan_catalogue_problem(
         (SELECT jsonb_agg(CASE WHEN e.value ->> 'slug' = 'basic'
                                THEN jsonb_set(e.value, '{price_per_car_cents}', '1000001'::jsonb)
                                ELSE e.value END)
            FROM jsonb_array_elements(app_private.plan_catalogue()) AS e(value))),
                                                                                                 'plans.price.basic'),
      ('a fractional price', app_private.plan_catalogue_problem(
         (SELECT jsonb_agg(CASE WHEN e.value ->> 'slug' = 'basic'
                                THEN jsonb_set(e.value, '{price_per_car_cents}', '19.5'::jsonb)
                                ELSE e.value END)
            FROM jsonb_array_elements(app_private.plan_catalogue()) AS e(value))),
                                                                                                 'plans.price.basic')
    ) AS t(label, got, want)
   WHERE t.got IS DISTINCT FROM t.want;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION '20261026120000 self-check 6: plan_catalogue_problem no longer refuses: %', v_missing;
  END IF;

  -- An unknown feature key stays VALID: seeding a feature before the release
  -- that gates it is load-bearing, and losing this would break every future
  -- gated screen's rollout.
  IF app_private.plan_catalogue_problem(
       (SELECT jsonb_agg(jsonb_set(e.value, '{features}',
                                   (e.value -> 'features') || '["a_feature_from_the_future"]'::jsonb))
          FROM jsonb_array_elements(app_private.plan_catalogue()) AS e(value))) IS NOT NULL THEN
    RAISE EXCEPTION '20261026120000 self-check 6: a feature key the build does not know is no longer tolerated; that is how a feature is seeded before the release that gates it';
  END IF;

  -- 7. Every rule of platform_plans_save, fragment by fragment.
  v_body := (SELECT p.prosrc FROM pg_proc p WHERE p.oid = c_save::regprocedure);
  SELECT string_agg(f.name, '; ') INTO v_missing
    FROM (VALUES
      ('pricing.manage first',  'platform_rpc_authorize\(''pricing\.manage'''),
      ('denied answer',         'platform_rpc_response\(''denied''\)'),
      ('the validator',         'plan_catalogue_problem\(p_plans\)'),
      ('invalid_value',         '''invalid_value'''),
      ('the version lock',      'plan_catalogue_meta WHERE id FOR UPDATE'),
      ('version_conflict',      '''version_conflict'''),
      ('an upsert, not a wipe', 'ON CONFLICT \(slug\) DO UPDATE'),
      ('plan_in_use',           '''plan_in_use'''),
      ('the price shadow',      'WHERE s\.key = ''price_book'''),
      ('the feature shadow',    'WHERE s\.key = ''plan_features'''),
      ('one audit row',         'platform_rpc_record\(c_category, c_action, NULL')
    ) AS f(name, pattern)
   WHERE v_body IS NULL OR v_body !~ f.pattern;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION '20261026120000 self-check 7: a rule of platform_plans_save is missing: %', v_missing;
  END IF;

  -- Shape and privileges, on the terms 20260923140000 asserts them.
  FOREACH v_sig IN ARRAY ARRAY[c_save, c_list] LOOP
    IF to_regprocedure(v_sig) IS NULL THEN
      RAISE EXCEPTION '20261026120000 self-check 7: % is missing', v_sig;
    END IF;
    IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = v_sig::regprocedure) THEN
      RAISE EXCEPTION '20261026120000 self-check 7: % is not SECURITY DEFINER', v_sig;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(coalesce(p.proconfig, '{}'::text[])) c(setting)
                    WHERE p.oid = v_sig::regprocedure AND c.setting LIKE 'search_path=%') THEN
      RAISE EXCEPTION '20261026120000 self-check 7: % has no pinned search_path', v_sig;
    END IF;
    IF has_function_privilege('anon', v_sig::regprocedure, 'EXECUTE')
       OR has_function_privilege('service_role', v_sig::regprocedure, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', v_sig::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION '20261026120000 self-check 7: EXECUTE on % must be authenticated alone', v_sig;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
                    WHERE p.oid = v_sig::regprocedure
                      AND (r.rolsuper OR r.oid = (SELECT nspowner FROM pg_namespace WHERE nspname = 'app_private'))) THEN
      RAISE EXCEPTION '20261026120000 self-check 7: the owner of % can call no app_private helper', v_sig;
    END IF;
  END LOOP;
  -- The write must be VOLATILE or PostgREST calls it with GET, in a read-only
  -- transaction where the audit row could not be written.
  IF (SELECT p.provolatile FROM pg_proc p WHERE p.oid = c_save::regprocedure) <> 'v' THEN
    RAISE EXCEPTION '20261026120000 self-check 7: platform_plans_save must be VOLATILE';
  END IF;

  -- 8. The four readers read the projection and no longer the stored row. This
  --    is the whole seam, and it is the one thing a later restatement of any of
  --    these four functions would silently undo.
  SELECT string_agg(f.sig, '; ') INTO v_missing
    FROM (VALUES
      ('public.compute_plan_price(text,integer,text,boolean)'),
      ('public.platform_invoice_quotes(integer,integer)'),
      ('public.get_public_config()'),
      ('public.get_app_config()')
    ) AS f(sig)
   WHERE (SELECT p.prosrc FROM pg_proc p WHERE p.oid = f.sig::regprocedure) !~ 'plan_price_book\(\)'
      OR (SELECT p.prosrc FROM pg_proc p WHERE p.oid = f.sig::regprocedure)
         ~ 'platform_setting_value\(''price_book''\)';
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION '20261026120000 self-check 8: a reader still prices from the stored price_book row instead of the catalogue: %', v_missing;
  END IF;
  IF (SELECT p.prosrc FROM pg_proc p WHERE p.oid = 'public.get_app_config()'::regprocedure)
     !~ 'plan_feature_map\(\)'
     OR (SELECT p.prosrc FROM pg_proc p WHERE p.oid = 'public.get_app_config()'::regprocedure)
        ~ 'platform_setting_value\(''plan_features''\)' THEN
    RAISE EXCEPTION '20261026120000 self-check 8: get_app_config still gates from the stored plan_features row instead of the catalogue';
  END IF;

  /*
    8b. The two config answers' EXACT key sets, and that neither names a
    function that no longer exists.

    This guards the defect this file shipped once. 20261015170000 edits both
    bodies with a `replace()` over pg_get_functiondef rather than a
    CREATE OR REPLACE, so grepping the migration chain for
    "CREATE OR REPLACE FUNCTION public.get_app_config" finds only the two
    older files — both of which still carry `app_private.signup_trial_days()`,
    which that same migration DROPPED. Restating from the migration text
    therefore produced two functions that raised 42883 on every call, and the
    only instrument that would have caught it beforehand is the live catalogue.

    Pinned as the key set rather than as a fragment, so a restatement that
    adds or loses a key fails here whichever way it was written.
  */
  IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(public.get_public_config()) AS k)
     IS DISTINCT FROM ARRAY['price_book'] THEN
    RAISE EXCEPTION '20261026120000 self-check 8b: get_public_config answers the keys %, expected price_book alone',
      (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(public.get_public_config()) AS k);
  END IF;
  IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(public.get_app_config()) AS k)
     IS DISTINCT FROM ARRAY['announcements', 'feature_flags', 'plan_features', 'price_book'] THEN
    RAISE EXCEPTION '20261026120000 self-check 8b: get_app_config answers the keys %, expected announcements, feature_flags, plan_features, price_book',
      (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(public.get_app_config()) AS k);
  END IF;
  -- The dropped function, named explicitly: there is no trial since
  -- 20261015170000 and nothing may call back into it.
  SELECT string_agg(f.sig, '; ') INTO v_missing
    FROM (VALUES
      ('public.get_public_config()'),
      ('public.get_app_config()')
    ) AS f(sig)
   WHERE (SELECT p.prosrc FROM pg_proc p WHERE p.oid = f.sig::regprocedure) ~ 'signup_trial_days';
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION '20261026120000 self-check 8b: % calls app_private.signup_trial_days(), which 20261015170000 dropped', v_missing;
  END IF;

  -- 9. The formulas are NOT redefined here. If a later edit of this file ever
  --    touches one, the 42 numbers stop being neutral by construction.
  IF (SELECT p.prosrc FROM pg_proc p
       WHERE p.oid = 'app_private.price_book_price(jsonb,text,integer,text,boolean)'::regprocedure)
     !~ 'v_billed_cars integer := greatest\(coalesce\(p_car_limit, 1\), 1\)'
     OR (SELECT p.prosrc FROM pg_proc p
          WHERE p.oid = 'app_private.price_book_price(jsonb,text,integer,text,boolean)'::regprocedure)
        !~ 'v_tier_cars   integer := coalesce\(p_car_limit, 1\)' THEN
    RAISE EXCEPTION '20261026120000 self-check 9: the floor or the unfloored tier lookup moved inside price_book_price, which this file must not touch';
  END IF;

  -- 10. The edge functions' door still refuses this file's action. The
  --     allow-list in platform_edge_audit_actions() is stricter than a
  --     reserved namespace, which is why platform_audit_record is NOT
  --     redefined here — 20260916150000's self-check 8 is the precedent.
  IF EXISTS (SELECT 1 FROM app_private.platform_edge_audit_actions() a
              WHERE a.action = 'platform_plans.save') THEN
    RAISE EXCEPTION '20261026120000 self-check 10: platform_plans.save is on the edge audit allow-list; it is written by the database alone';
  END IF;

  -- 11. platform_rpc_response: the four added sentences, and every one of the
  --     twenty-one 20260923140000 pinned, plus the fallback and success.
  SELECT string_agg(format('%s → %L', s.reason, app_private.platform_rpc_response(s.reason) ->> 'error'), '; ')
    INTO v_wrong
    FROM (VALUES
      ('denied',             'Keine Berechtigung für diese Aktion.'),
      ('invalid',            'Ungültige Eingabe.'),
      ('not_found',          'Nicht gefunden.'),
      ('invalid_status',     'Diese Aktion ist im aktuellen Zustand nicht möglich.'),
      ('slug_taken',         'Dieser Slug ist bereits vergeben.'),
      ('code_taken',         'Dieser Code existiert bereits.'),
      ('no_trial',           'Für dieses Unternehmen ist keine Testphase eingetragen.'),
      ('plan_inactive',      'Dieser Plan ist nicht aktiv.'),
      ('account_not_found',  'Konto nicht gefunden.'),
      ('account_in_company', 'Dieses Konto gehört zu einem Unternehmen und kann nicht zum Plattform-Team hinzugefügt werden.'),
      ('already_staff',      'Dieses Konto gehört bereits zum Plattform-Team.'),
      ('already_disabled',   'Dieses Konto ist bereits deaktiviert.'),
      ('already_enabled',    'Dieses Konto ist bereits aktiv.'),
      ('last_owner',         'Der letzte aktive Inhaber der Plattform kann nicht deaktiviert oder herabgestuft werden.'),
      ('role_requires_3_3',  'Andere Rollen als "owner" sind erst ab Plan-Schritt 3.3 möglich.'),
      ('context_open',       'Es ist bereits ein Zugriff auf ein anderes Unternehmen offen. Bitte zuerst beenden.'),
      ('reason_required',    'Für eine Support-Sitzung ist ein Grund erforderlich.'),
      ('no_session',         'Diese Anmeldung ist nicht mehr gültig. Bitte erneut anmelden.'),
      ('no_context',         'Es ist kein Unternehmenszugriff offen.'),
      ('member_disabled',    'Dieses Mitglied ist deaktiviert. Bitte zuerst aktivieren und die Rolle danach ändern.'),
      ('already_in_role',    'Dieses Mitglied hat diese Rolle bereits.'),
      ('invalid_value',      'Die Pläne sind in dieser Form nicht gültig.'),
      ('version_conflict',   'Die Pläne wurden zwischenzeitlich geändert. Bitte neu laden.'),
      ('plan_in_use',        'Dieser Plan ist einem Unternehmen zugeordnet und kann nicht entfernt werden.'),
      ('catalogue_missing',  'Es ist kein Plan-Katalog vorhanden.'),
      ('something_else',     'Die Aktion konnte nicht ausgeführt werden.')
    ) AS s(reason, sentence)
   WHERE (app_private.platform_rpc_response(s.reason) ->> 'error') IS DISTINCT FROM s.sentence
      OR (app_private.platform_rpc_response(s.reason) ->> 'reason') IS DISTINCT FROM s.reason
      OR (app_private.platform_rpc_response(s.reason) ->> 'success') <> 'false';
  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '20261026120000 self-check 11: platform_rpc_response lost or changed a sentence: %', v_wrong;
  END IF;
  IF app_private.platform_rpc_response(NULL) <> '{"success": true}'::jsonb
     OR app_private.platform_rpc_response(NULL, '{"id": 1}'::jsonb) <> '{"id": 1, "success": true}'::jsonb THEN
    RAISE EXCEPTION '20261026120000 self-check 11: platform_rpc_response no longer answers success the way it did';
  END IF;

  /*
    The convention this file deliberately did NOT change (see the header): a
    refusal drops its extra, and detail is added by the caller with `||`. Both
    halves are pinned, because the first draft of this migration changed the
    helper and the reasoning for reverting it is worth more than the assertion.
  */
  IF app_private.platform_rpc_response('denied', '{"problem": "x"}'::jsonb)
     IS DISTINCT FROM app_private.platform_rpc_response('denied') THEN
    RAISE EXCEPTION '20261026120000 self-check 11: platform_rpc_response now merges a refusal''s extra. That is a change to twenty-five other RPCs'' answers; platform_rpc_finish passes NULL there on purpose and two RPCs add detail with ||. Read this file''s header before keeping it.';
  END IF;
  IF (SELECT p.prosrc FROM pg_proc p
       WHERE p.oid = 'app_private.platform_rpc_finish(text,text,text,uuid,text,text,jsonb,jsonb,jsonb)'::regprocedure)
     !~ 'CASE WHEN p_reason IS NULL THEN p_extra END' THEN
    RAISE EXCEPTION '20261026120000 self-check 11: platform_rpc_finish no longer passes NULL as the extra on a refusal, which is the evidence that extras-on-success is a decision and not an oversight';
  END IF;
  -- And this file's own refusal does carry its problem code, through the ||
  -- idiom, so the panel can name the plan and the feature.
  IF (SELECT p.prosrc FROM pg_proc p WHERE p.oid = c_save::regprocedure)
     !~ 'platform_rpc_response\(''invalid_value''\)\s*\|\|' THEN
    RAISE EXCEPTION '20261026120000 self-check 11: platform_plans_save no longer adds its problem code to the refusal, so a validation failure reaches the operator as a sentence they cannot act on';
  END IF;

  -- 12. The foreign key, and that it refuses a typo.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.companies'::regclass AND conname = 'companies_plan_fkey'
                    AND confrelid = 'public.plans'::regclass AND confupdtype = 'a' AND confdeltype = 'a') THEN
    RAISE EXCEPTION '20261026120000 self-check 12: companies.plan does not reference plans(slug) with NO ACTION on both sides';
  END IF;
  IF EXISTS (SELECT 1 FROM public.companies c
              WHERE NOT EXISTS (SELECT 1 FROM public.plans p WHERE p.slug = c.plan)) THEN
    RAISE EXCEPTION '20261026120000 self-check 12: a company names a plan the catalogue does not hold';
  END IF;

  -- 13. subscription_plans is left exactly as it was: this file replaces what
  --     reads it, never the table. billing-system.md's slice 2 finishes it.
  IF to_regclass('public.subscription_plans') IS NULL THEN
    RAISE EXCEPTION '20261026120000 self-check 13: public.subscription_plans was dropped; this file must not touch it';
  END IF;
END $$;
