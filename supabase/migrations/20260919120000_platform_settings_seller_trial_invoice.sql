/*
  # Settings: the seller, the trial length and the invoice defaults

  Plan 3.10, first half (section 3.E). Builds on
  `20260916150000_platform_settings_price_book.sql` (the settings table, its two
  RPCs and the price book) and `20260917120000_settings_hardening.sql` (the
  per-actor cap and the complete-feature-map rule).

  The mail templates and the sender — `mail.sender` and `mail.template.*`, the
  rest of 3.10 — are deliberately NOT here. They need an edge function to send a
  test mail and a preview, and folding them in would make one unreviewable
  change out of two. `mail.sender` stays an unknown key until they arrive, and
  self-check 7 pins that.

  ## What was wrong

  Three things the owner is supposed to be able to change still lived in code:

  - **The seller's details on invoices.** `SubscriptionBillingPage.handleDownloadPdf`
    reads them out of the `company_settings` row of whichever company the
    signed-in platform account happens to sit in, and falls back to the literal
    'El-Professor' for the name. That company is a tenant like any other; plan
    step 3.7b takes the platform account out of it, and on that day the invoices
    would silently lose their sender.
  - **The trial length**, a `CONSTANT interval := interval '14 days'` inside
    `app_private.signup_insert_company`. `app_private.signup_trial_days()`
    existed only to report that constant to `get_public_config()`, and
    20260916150000's self-check compared the two by reading the function's
    source text.
  - **The invoice defaults**: the number format in `generate_invoice_number`
    ('INV-' || year || '-' || lpad(seq, 4, '0')) and the payment method
    `GenerateInvoicesModal` writes onto every invoice it creates ('cash').

  ## What this adds

  Three keys in `app_private.platform_settings`, each with its validator in this
  same file, because `platform_settings_put` refuses a key it has no validator
  for (`unknown_key`):

  - **`seller`** — eleven text fields, exactly the columns
    `SubscriptionBillingPage` selects today, with `company_name` under the name
    `name`. **The values are copied from that very row**, not invented: the seed
    below reads the `company_settings` of the company the oldest active platform
    owner belongs to, which is the row that screen reads. Where there is no such
    row — a fresh database, the RLS fixture, or after 3.7b — every field is the
    empty string and `name` is 'El-Professor', which is the fallback that screen
    already applies.
  - **`trial`** — `{"days": 14}`, and `signup_insert_company` now reads it.
  - **`invoice`** — `{"number_prefix": "INV", "number_digits": 4,
    "default_payment_method": "cash"}`.

  All three are written with `settings.manage`, which plan 3.A gives to the
  owner alone ("settings.manage (بائع، تجربة، إيميلات، إعلانات، ميزات)"). That
  falls out of `app_private.platform_setting_is_pricing()` without a change:
  only `price_book` is a pricing key, so only it takes `pricing.manage`, and
  billing — which holds `settings.read` for the prices alone — is refused all
  three, on reading as well as writing.

  ## The trial length: the rule this file preserves

  **A company created by a signup gets a trial that ends `now()` plus the trial
  length, and nothing recomputes the trial of a company that already exists.**

  `signup_insert_company` writes `trial_end` once, on the INSERT of a new
  company, and no other statement here touches `companies`. So changing the
  setting later changes what the *next* signup gets and nothing else: every
  trial already running keeps the `trial_end` stored on its row.

  With the seeded value, the arithmetic is the one it replaces, term for term —
  `make_interval(days => 14)` is `interval '14 days'` — so this release gives
  exactly the trial the previous one gave. Self-check 5 asserts that equality
  rather than assuming it.

  The old comparison (20260916150000, self-check 6) read the constant out of the
  function's source and compared it with `signup_trial_days()`. There is no
  constant to read any more, so the comparison is replaced, not dropped, and it
  is stricter: self-check 5 requires that the function's source *calls*
  `signup_trial_days`, that it no longer carries a hard-coded day interval, that
  `signup_trial_days()` returns what the `trial` setting holds, and that
  `get_public_config()` reports the same number. A later migration that
  hard-codes the trial again fails the release.

  `signup_trial_days()` is the one place that reads the key, for the signup and
  for `get_public_config()` alike, so the number a visitor is quoted and the
  number a company is given cannot come apart. It answers 14 — the value the
  constant held — for a missing, malformed or out-of-range document: a single-row
  SELECT returns NULL when no row matches, `make_interval(days => NULL)` is NULL,
  and a NULL `trial_end` is a company whose trial never ends (CLAUDE.md, "A SQL
  helper that selects a single row returns NULL when no row matches"). The whole
  subquery is wrapped, not the column.

  ## Reaching app_private from the signup path

  `signup_insert_company` is SECURITY DEFINER and, from this file on, calls an
  `app_private` function. A SECURITY DEFINER function runs as its owner, and on
  the real databases that owner may be `postgres` rather than the migration role
  (CLAUDE.md, "Platform staff"; the ownership note of 20260916110010).

  Its owner is deliberately **left alone**. Handing it to CURRENT_USER would
  change which role writes `public.companies` and `public.user_profiles`, and so
  whether row-level security applies to the signup's own inserts — a change to
  the riskiest path in the product, for no reason this slice has. Instead the
  owner is granted, by name, exactly what the new call needs: USAGE on
  `app_private` and EXECUTE on `app_private.signup_trial_days()`. That is the
  shape 20260916150000 used for the owners of `compute_plan_price`'s callers.
  Self-check 6 fails the release if the owner cannot make the call, and
  self-check 1 still fails it if `anon`, `authenticated` or `service_role` ever
  gained either privilege.

  The functions this file creates or replaces on its own account —
  `signup_trial_days`, both validators — are handed to CURRENT_USER as usual.

  ## The invoice key, and what is not in it

  Only values the invoice code actually holds today are seeded, one per line of
  code:

  - `number_prefix` and `number_digits` are 'INV' and 4 from
    `public.generate_invoice_number` (20260607125649);
  - `default_payment_method` is the 'cash' `GenerateInvoicesModal` writes, which
    is also the column default on `subscription_invoices` and
    `company_subscriptions`.

  Left out, deliberately:

  - **A tax rate.** Nothing in the invoice path computes or prints one: the PDF
    has a single line item and `amount` is the total, with no MwSt row. Adding a
    rate here would create a number no code owes anything to, and how VAT is
    charged is open decision D9.
  - **The due day.** The due date is `billing_day` of the *subscription*, capped
    at 28 by the browser and by a CHECK constraint on `company_subscriptions`.
    It is per customer, not per platform, so it is not a setting.
  - **The currency** (euro throughout, in both engines) and **the payment-method
    label** ('Barzahlung'), which is German text printed into a German payment
    record and stays in the document module like every other such string
    (src/i18n/index.ts).

  **Nothing reads these three values yet.** This file stores them; teaching
  `SubscriptionBillingPage`, `GenerateInvoicesModal` and
  `generate_invoice_number` to read them is a later step, and the editor says so
  on screen. `seller` is in the same position. `trial` is the exception: it is
  wired up here, because leaving it unwired would mean a setting that contradicts
  what a signup actually gets, which is the defect this key exists to remove.

  ## Data protection

  The seller document carries our own bank details (IBAN, BIC) and tax numbers.
  Two consequences, both deliberate:

  - Today those values sit in `public.company_settings`, whose SELECT policy is
    `USING (true)` for every authenticated user of every company. Moving them
    into `app_private.platform_settings`, readable only through
    `platform_settings_get` by a role holding `settings.read`, is a narrowing.
  - `platform_settings_put` records the value before and the value after every
    accepted write, so an edited IBAN lands in `app_private.platform_audit_log`.
    That log is append-only and read with `audit.read`, which plan 3.A gives the
    owner (read_only is open decision D3). These are the seller's own details,
    not a customer's or a driver's. `platform_settings_put` is not redefined
    here to redact them — see below.

  ## What is deliberately not redefined

  `public.platform_settings_get`, `public.platform_settings_put` and
  `public.platform_audit_record`. Each already carries rules a re-creation would
  silently drop — the per-actor cap and the audit write (20260917120000), the
  reserved namespaces and the edge action allow-list (20260916150000's
  allow-list file) — and that has already gone wrong once, when 20260916140000
  re-created `platform_audit_record` and reopened it for a release. This file
  sorts after all of them, so it adds validators and keys and changes neither
  RPC. Self-checks 7 and 8 assert that both properties still hold.

  `app_private.platform_settings_problem` *is* replaced, because a validator can
  only be added there. Its existing branches are carried over unchanged, and
  self-check 4 re-states the rules 20260916150000 and 20260917120000 installed —
  a complete feature map, a refused short one, today's price book — so a botched
  copy fails this release instead of a customer's screen.

  ## Money

  No price, percentage or amount is read, written or computed here. The price
  book and its validator are untouched.

  ## Compatibility

  Expansive; **no SCHEMA_EPOCH bump**. Nothing is dropped, renamed or given a new
  meaning: three rows are added to a table, one validator learns three keys, and
  two functions keep their signatures, their grants and — with the seeded value —
  their answers. The previous release calls `signup_create_company`,
  `oauth_signup_create_company`, `get_public_config` and `get_app_config` with
  the same arguments and reads the same fields.

  A rollback leaves the database as it is, as always. If the owner has changed
  the trial length by then, the rolled-back release keeps giving the new length
  and keeps quoting it on the landing page, because both read
  `signup_trial_days()` — the same consistency the price book has since 3.9.
*/

-- ─── Validators for the three new keys ──────────────────────────────────────

/*
  Kept out of platform_settings_problem itself so that the copy of that
  function below stays a copy: this slice's rules are all in one place, and the
  branches 20260916150000 and 20260917120000 wrote are carried over untouched.
*/
CREATE OR REPLACE FUNCTION app_private.platform_settings_problem_3_10(p_key text, p_value jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  -- Exactly the columns SubscriptionBillingPage selects for the invoice PDF,
  -- with company_name as `name`, in byte order — settings_object_keys sorts
  -- COLLATE "C", so the comparison below is a single array equality.
  c_seller_fields  CONSTANT text[]  := ARRAY[
    'account_holder', 'bank_name', 'bic', 'city', 'house_number', 'iban',
    'name', 'postal_code', 'street', 'tax_number', 'vat_id'];
  c_invoice_fields CONSTANT text[]  := ARRAY[
    'default_payment_method', 'number_digits', 'number_prefix'];
  -- Long enough for any real address line, IBAN or registered name, short
  -- enough that eleven of them cannot approach the 16 KB value limit.
  c_max_field      CONSTANT integer := 200;
  -- A trial is a number of days a person types. Below one is not a trial, and
  -- above a year is a typo that would hand out free access for years.
  c_min_trial_days CONSTANT integer := 1;
  c_max_trial_days CONSTANT integer := 365;
  c_max_digits     CONSTANT integer := 10;

  v_field text;
  v_part  jsonb;
  v_text  text;
BEGIN
  IF p_key = 'seller' THEN
    IF app_private.settings_object_keys(p_value) IS DISTINCT FROM c_seller_fields THEN
      RETURN 'seller';
    END IF;

    FOREACH v_field IN ARRAY c_seller_fields LOOP
      v_part := p_value -> v_field;
      IF jsonb_typeof(v_part) IS DISTINCT FROM 'string' THEN
        RETURN 'seller.' || v_field;
      END IF;
      v_text := v_part #>> '{}';
      IF length(v_text) > c_max_field THEN
        RETURN 'seller.' || v_field;
      END IF;
      -- These strings are drawn into a PDF line by line. A newline, a tab or a
      -- stray control character would break that layout silently, on a document
      -- that goes to a customer.
      IF v_text ~ '[[:cntrl:]]' THEN
        RETURN 'seller.' || v_field;
      END IF;
    END LOOP;

    -- Every other field may be blank — not every seller has a VAT id — but a
    -- nameless invoice has no sender at all, and the empty string is what an
    -- absent column becomes in the seed below.
    IF btrim(p_value ->> 'name') = '' THEN
      RETURN 'seller.name';
    END IF;

    RETURN NULL;
  END IF;

  IF p_key = 'trial' THEN
    IF app_private.settings_object_keys(p_value) IS DISTINCT FROM ARRAY['days'] THEN
      RETURN 'trial';
    END IF;
    IF NOT app_private.settings_integer_between(p_value -> 'days', c_min_trial_days, c_max_trial_days) THEN
      RETURN 'trial.days';
    END IF;
    RETURN NULL;
  END IF;

  IF p_key = 'invoice' THEN
    IF app_private.settings_object_keys(p_value) IS DISTINCT FROM c_invoice_fields THEN
      RETURN 'invoice';
    END IF;

    -- 'INV-2026-0001': the prefix is the part before the first dash, so it may
    -- not contain one — generate_invoice_number reads the sequence back with
    -- split_part(invoice_number, '-', 3).
    IF jsonb_typeof(p_value -> 'number_prefix') IS DISTINCT FROM 'string'
       OR (p_value ->> 'number_prefix') !~ '^[A-Z][A-Z0-9]{0,9}$' THEN
      RETURN 'invoice.number_prefix';
    END IF;

    IF NOT app_private.settings_integer_between(p_value -> 'number_digits', 1, c_max_digits) THEN
      RETURN 'invoice.number_digits';
    END IF;

    IF jsonb_typeof(p_value -> 'default_payment_method') IS DISTINCT FROM 'string'
       OR (p_value ->> 'default_payment_method') !~ '^[a-z][a-z0-9_]{0,29}$' THEN
      RETURN 'invoice.default_payment_method';
    END IF;

    RETURN NULL;
  END IF;

  RETURN 'unknown_key';
END;
$$;

-- ─── platform_settings_problem learns the three keys ────────────────────────

/*
  20260917120000's body, with two changes and no others: the key gate names the
  three new keys, and they are handed to the validator above. The price_book and
  plan_features branches are carried over character for character, including the
  completeness rule that keeps a short feature map from locking every gated
  screen. Self-check 4 re-states what those branches must still do.
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
     OR p_key NOT IN ('price_book', 'plan_features', 'seller', 'trial', 'invoice') THEN
    RETURN 'unknown_key';
  END IF;
  IF p_value IS NULL OR octet_length(p_value::text) > c_max_value_bytes THEN
    RETURN 'value_size';
  END IF;

  -- Plan 3.10, first half. Checked after the size limit above, so every key
  -- shares one bound on how much one row may hold.
  IF p_key IN ('seller', 'trial', 'invoice') THEN
    RETURN app_private.platform_settings_problem_3_10(p_key, p_value);
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

-- ─── The three keys ─────────────────────────────────────────────────────────

/*
  `seller`, copied from the row SubscriptionBillingPage reads today: the
  company_settings of the company the oldest active platform owner belongs to.
  Ordered by created_at then user_id so two owners cannot make the result depend
  on which row the planner happens to return first.

  The LEFT JOIN LATERAL is what makes the fallback work: with no platform owner,
  no company, or no settings row — a fresh database, the RLS fixture, or a
  database where 3.7b has already moved the platform account out of its company
  — every column is NULL, so every field becomes the empty string and `name`
  becomes 'El-Professor', which is exactly what that screen falls back to today
  (`s?.company_name || 'El-Professor'`).

  Each value is trimmed and cut to the validator's 200 characters, so the seed
  passes the validator this file installs whatever the source row holds; 200
  characters is far beyond any real name, address line, IBAN or tax number, so
  nothing real is shortened. Self-check 3 proves the copy against the source.
*/
INSERT INTO app_private.platform_settings (key, value)
SELECT 'seller', jsonb_build_object(
  'name',           coalesce(nullif(left(btrim(cs.company_name),    200), ''), 'El-Professor'),
  'street',         coalesce(       left(btrim(cs.street),          200),      ''),
  'house_number',   coalesce(       left(btrim(cs.house_number),    200),      ''),
  'postal_code',    coalesce(       left(btrim(cs.postal_code),     200),      ''),
  'city',           coalesce(       left(btrim(cs.city),            200),      ''),
  'vat_id',         coalesce(       left(btrim(cs.vat_id),          200),      ''),
  'tax_number',     coalesce(       left(btrim(cs.tax_number),      200),      ''),
  'bank_name',      coalesce(       left(btrim(cs.bank_name),       200),      ''),
  'iban',           coalesce(       left(btrim(cs.iban),            200),      ''),
  'bic',            coalesce(       left(btrim(cs.bic),             200),      ''),
  'account_holder', coalesce(       left(btrim(cs.account_holder),  200),      '')
)
  FROM (SELECT 1) AS one
  LEFT JOIN LATERAL (
    SELECT c.*
      FROM public.company_settings c
     WHERE c.company_id = (
             SELECT up.company_id
               FROM public.user_profiles up
               JOIN app_private.platform_staff ps ON ps.user_id = up.user_id
              WHERE ps.disabled_at IS NULL
                AND ps.role = 'owner'
                AND up.company_id IS NOT NULL
              ORDER BY ps.created_at, ps.user_id
              LIMIT 1)
     LIMIT 1
  ) cs ON true;

-- src/lib/appConfigSeed.ts holds SEED_TRIAL_DAYS, and
-- src/lib/appConfigSeed.test.ts parses the block below out of this file and
-- fails when the two differ.
INSERT INTO app_private.platform_settings (key, value) VALUES
  ('trial', $seed_trial$
{
  "days": 14
}
$seed_trial$::jsonb),
  ('invoice', $seed_invoice$
{
  "number_prefix": "INV",
  "number_digits": 4,
  "default_payment_method": "cash"
}
$seed_invoice$::jsonb);

-- ─── The trial length comes from the setting ────────────────────────────────

/*
  The one reader of the `trial` key: the signup below and get_public_config()
  both go through it, so the number a visitor is quoted and the number a company
  is given cannot come apart.

  It answers 14 — the value the constant it replaces held — for a missing,
  malformed or out-of-range document, because the alternative is a NULL travelling
  into `make_interval(days => …)` and from there into a company whose trial never
  ends. The whole subquery is wrapped, never the column.

  SECURITY DEFINER, and owned by the role that owns app_private, so the answer
  does not depend on what its caller may read. It was IMMUTABLE while it returned
  a literal; reading a table makes it STABLE, which every caller here already is.
*/
CREATE OR REPLACE FUNCTION app_private.signup_trial_days()
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_fallback CONSTANT integer := 14;
  c_min      CONSTANT integer := 1;
  c_max      CONSTANT integer := 365;
  v_days     jsonb;
BEGIN
  v_days := (SELECT s.value -> 'days'
               FROM app_private.platform_settings s
              WHERE s.key = 'trial');

  -- settings_integer_between answers false for SQL NULL, for a JSON value that
  -- is not a number, and for one outside the bounds — the three ways this can
  -- fail — so one guard covers all of them.
  IF NOT app_private.settings_integer_between(v_days, c_min, c_max) THEN
    RETURN c_fallback;
  END IF;

  RETURN coalesce((v_days #>> '{}')::numeric::integer, c_fallback);
END;
$$;

/*
  20260916100010's function, with one change: the trial length is read rather
  than declared. Everything else — the argument contract, the normalization, the
  slug transliteration and its collision loop, the owner profile, the settings
  row, the return value — is carried over as it stood.

  With the seeded 14, `make_interval(days => 14)` is `interval '14 days'`, so a
  company created by this release gets the trial the previous one gave it.
  Self-check 5 asserts that equality.

  The owner is deliberately not changed; see the header. It is granted USAGE and
  EXECUTE below instead.
*/
CREATE OR REPLACE FUNCTION app_private.signup_insert_company(
  p_user_id       uuid,
  p_owner_email   text,     -- the address as auth.users holds it
  p_full_name     text,     -- trimmed by the caller
  p_company_name  text,     -- trimmed by the caller
  p_plan          text,
  p_billing_cycle text,
  p_car_limit     integer,
  p_referral_id   uuid,     -- looked up and checked by the caller, or NULL
  p_referral_code text,     -- the upper-cased code, recorded only with a referral
  p_owner_status  text      -- 'pending_invite': a code is still to come; 'active': the address is proven
)
RETURNS public.companies
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_slug_attempts CONSTANT integer  := 10;

  -- Plan 3.10: the `trial` setting, through the one function that reads it.
  -- Evaluated once per signup, so every row this call writes agrees.
  v_trial_length  interval := make_interval(days => app_private.signup_trial_days());

  v_now           timestamptz := now();
  v_plan          text;
  v_cycle         text;
  v_car_limit     integer;
  v_base_slug     text;
  v_company       public.companies%ROWTYPE;
  v_admin_role_id uuid;
BEGIN
  IF p_user_id IS NULL
     OR coalesce(p_owner_email, '') = ''
     OR coalesce(p_full_name, '') = ''
     OR coalesce(p_company_name, '') = ''
     OR p_owner_status IS NULL
     OR p_owner_status NOT IN ('pending_invite', 'active')
  THEN
    RAISE EXCEPTION 'signup_insert_company: invalid arguments' USING ERRCODE = '22023';
  END IF;

  -- 1. The same normalization company-signup applies in TypeScript:
  --    Math.max(1, Math.min(100, Math.floor(Number(x) || 3))) — so 0 and a
  --    missing value both mean 3.
  v_plan      := CASE WHEN p_plan IN ('basic','advanced','premium') THEN p_plan ELSE 'basic' END;
  v_cycle     := CASE WHEN p_billing_cycle = 'yearly' THEN 'yearly' ELSE 'monthly' END;
  v_car_limit := CASE WHEN coalesce(p_car_limit, 0) = 0 THEN 3
                      ELSE greatest(1, least(100, p_car_limit)) END;

  -- 2. Slug: the TypeScript transliteration. Upper-case umlauts are mapped
  --    first because lower() only folds non-ASCII letters under a UTF-8
  --    ctype, while JavaScript's toLowerCase always does.
  v_base_slug := replace(replace(replace(replace(p_company_name, 'Ä', 'ä'), 'Ö', 'ö'), 'Ü', 'ü'), 'ẞ', 'ß');
  v_base_slug := lower(v_base_slug);
  v_base_slug := replace(replace(replace(replace(v_base_slug, 'ä', 'ae'), 'ö', 'oe'), 'ü', 'ue'), 'ß', 'ss');
  v_base_slug := regexp_replace(v_base_slug, '[^a-z0-9]+', '-', 'g');
  v_base_slug := regexp_replace(v_base_slug, '^-|-$', '', 'g');
  v_base_slug := left(v_base_slug, 60);

  -- 3. The company. ON CONFLICT on the slug instead of a look-then-insert, so
  --    two signups with the same name cannot both pick the same free slug.
  FOR i IN 1..c_slug_attempts LOOP
    INSERT INTO public.companies
      (name, slug, status, approval_status, plan, billing_cycle, subscription_car_limit,
       trial_start, trial_end, country, subscription_status,
       referral_id, referral_code_used, referred_at)
    VALUES
      (p_company_name,
       CASE WHEN i = 1 THEN v_base_slug
            ELSE v_base_slug || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6) END,
       'trial', 'pending', v_plan, v_cycle, v_car_limit,
       v_now, v_now + v_trial_length, 'Deutschland', 'inactive',
       p_referral_id,
       CASE WHEN p_referral_id IS NOT NULL THEN p_referral_code END,
       CASE WHEN p_referral_id IS NOT NULL THEN v_now END)
    ON CONFLICT (slug) DO NOTHING
    RETURNING * INTO v_company;

    EXIT WHEN v_company.id IS NOT NULL;
  END LOOP;

  IF v_company.id IS NULL THEN
    RAISE EXCEPTION 'signup_insert_company: no free slug';
  END IF;

  -- 4. The owner, as the company's admin. An active owner is activated now; a
  --    pending one keeps whatever activated_at an existing profile had.
  SELECT r.id INTO v_admin_role_id
    FROM public.roles r
   WHERE r.name = 'admin' AND r.company_id IS NULL
   ORDER BY r.is_system DESC NULLS LAST, r.created_at
   LIMIT 1;

  INSERT INTO public.user_profiles AS up
    (user_id, email, full_name, role, role_id, company_id, is_super_admin, status, activated_at)
  VALUES
    (p_user_id, p_owner_email, p_full_name, 'admin', v_admin_role_id, v_company.id, false, p_owner_status,
     CASE WHEN p_owner_status = 'active' THEN v_now END)
  ON CONFLICT (user_id) DO UPDATE
    SET email          = EXCLUDED.email,
        full_name      = EXCLUDED.full_name,
        role           = EXCLUDED.role,
        role_id        = EXCLUDED.role_id,
        company_id     = EXCLUDED.company_id,
        is_super_admin = false,
        status         = p_owner_status,
        activated_at   = CASE WHEN p_owner_status = 'active' THEN v_now ELSE up.activated_at END,
        updated_at     = now();

  -- 5.
  INSERT INTO public.company_settings (company_id, company_name)
  VALUES (v_company.id, p_company_name);

  RETURN v_company;
END;
$$;

-- ─── Ownership ──────────────────────────────────────────────────────────────

-- CREATE OR REPLACE keeps whatever owner a function had, and on the real
-- databases that may be `postgres`, which reaches no app_private helper.
-- app_private.signup_insert_company is the deliberate exception: its owner is
-- left as it is and granted what the new call needs instead (see the header).
ALTER FUNCTION app_private.platform_settings_problem_3_10(text, jsonb) OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.platform_settings_problem(text, jsonb)      OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.signup_trial_days()                         OWNER TO CURRENT_USER;

-- ─── Privileges ─────────────────────────────────────────────────────────────

-- Supabase's default privileges grant EXECUTE on every new function to PUBLIC,
-- anon, authenticated and service_role, so each one is revoked by name. Nobody
-- the API authenticates as holds USAGE on app_private; these REVOKEs are the
-- second wall.
REVOKE ALL ON FUNCTION app_private.platform_settings_problem_3_10(text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.platform_settings_problem(text, jsonb)      FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.signup_trial_days()                         FROM PUBLIC, anon, authenticated, service_role;

-- Restated exactly as 20260916100010 left it.
REVOKE ALL ON FUNCTION app_private.signup_insert_company(uuid, text, text, text, text, text, integer, uuid, text, text)
  FROM PUBLIC, anon, authenticated, service_role;

-- ─── The signup path keeps its reach into app_private ───────────────────────

/*
  app_private.signup_insert_company is SECURITY DEFINER, so it runs as its owner,
  and from this file on it calls app_private.signup_trial_days(). The owner
  therefore needs USAGE on the schema — without it the name cannot even be
  resolved — and EXECUTE on that function. The same shape as 20260916150000's
  "Callers of compute_plan_price keep EXECUTE", and for the same reason: an
  owner that could call a function because it owned it may no longer be able to.

  An API role must never own a SECURITY DEFINER function in the signup path, and
  must never be handed USAGE on app_private; the loop refuses rather than
  granting. Self-check 1 checks the three of them again afterwards.
*/
DO $$
DECLARE
  c_target CONSTANT text := 'app_private.signup_trial_days()';
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT owner_role.rolname
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_roles owner_role ON owner_role.oid = p.proowner
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND p.prosecdef
       AND p.oid <> c_target::regprocedure
       AND p.prosrc ~ 'signup_trial_days\s*\('
       AND (NOT has_function_privilege(owner_role.oid, c_target::regprocedure, 'EXECUTE')
            OR NOT has_schema_privilege(owner_role.oid, 'app_private', 'USAGE'))
  LOOP
    IF r.rolname IN ('anon', 'authenticated', 'service_role') THEN
      RAISE EXCEPTION
        '20260919120000: % owns a SECURITY DEFINER function that calls signup_trial_days(); an API role must never own one, and must never reach app_private',
        r.rolname;
    END IF;

    EXECUTE format('GRANT USAGE ON SCHEMA app_private TO %I', r.rolname);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', c_target, r.rolname);
    RAISE NOTICE '20260919120000: % owns a SECURITY DEFINER caller of signup_trial_days() and keeps its reach into app_private', r.rolname;
  END LOOP;
END $$;

-- ─── Self-check ─────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_role    text;
  v_wrong   text;
  v_seller  jsonb;
  v_source  record;
  v_owner   oid;
  v_src     text;
  v_seed    jsonb;
  v_action  text;
  v_sig     text;
BEGIN
  -- 1. Nobody the API authenticates as reaches the schema, the settings table,
  --    or anything the block above may have granted.
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_schema_privilege(v_role, 'app_private', 'USAGE')
       OR has_table_privilege(v_role, 'app_private.platform_settings',
                              'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
       OR has_function_privilege(v_role, 'app_private.signup_trial_days()'::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION '20260919120000 self-check: % reaches app_private', v_role;
    END IF;
  END LOOP;

  -- 2. Every function this file created or replaced: SECURITY DEFINER where it
  --    should be, a pinned search_path, an owner that reaches app_private, and
  --    exactly the stated EXECUTE grants.
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
               WHEN has_function_privilege('anon', to_regprocedure(v.sig), 'EXECUTE') IS DISTINCT FROM v.anon
                 THEN 'anon EXECUTE should be ' || v.anon
               WHEN has_function_privilege('authenticated', to_regprocedure(v.sig), 'EXECUTE') IS DISTINCT FROM v.authn
                 THEN 'authenticated EXECUTE should be ' || v.authn
               WHEN has_function_privilege('service_role', to_regprocedure(v.sig), 'EXECUTE') IS DISTINCT FROM v.service
                 THEN 'service_role EXECUTE should be ' || v.service
             END AS problem
        FROM (VALUES
          -- signature                                                definer anon   authn  service
          ('app_private.platform_settings_problem_3_10(text,jsonb)',  false,  false, false, false),
          ('app_private.platform_settings_problem(text,jsonb)',       false,  false, false, false),
          ('app_private.signup_trial_days()',                         true,   false, false, false)
        ) AS v(sig, definer, anon, authn, service)
    ) f
   WHERE f.problem IS NOT NULL;

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '20260919120000 self-check: %', v_wrong;
  END IF;

  -- signup_insert_company keeps its own owner, so only the rest is asserted.
  v_sig := 'app_private.signup_insert_company(uuid,text,text,text,text,text,integer,uuid,text,text)';
  IF to_regprocedure(v_sig) IS NULL
     OR NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(v_sig))
     OR NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proconfig) c(setting)
                     WHERE p.oid = to_regprocedure(v_sig) AND c.setting LIKE 'search_path=%')
     OR has_function_privilege('anon', to_regprocedure(v_sig), 'EXECUTE')
     OR has_function_privilege('authenticated', to_regprocedure(v_sig), 'EXECUTE')
     OR has_function_privilege('service_role', to_regprocedure(v_sig), 'EXECUTE') THEN
    RAISE EXCEPTION '20260919120000 self-check: signup_insert_company is missing, unpinned, not SECURITY DEFINER, or reachable from the API';
  END IF;

  -- 3. The three keys are seeded, valid, at version 1 — and the seller really
  --    was copied from the row the invoice page reads, field for field, where
  --    there was one to copy.
  IF (SELECT count(*) FROM app_private.platform_settings
       WHERE key IN ('seller', 'trial', 'invoice')
         AND version = 1 AND updated_by IS NULL) <> 3
     OR (SELECT count(*) FROM app_private.platform_settings) <> 5 THEN
    RAISE EXCEPTION '20260919120000 self-check: the three new keys are not the only ones added';
  END IF;

  SELECT string_agg(format('%s: %s', s.key, app_private.platform_settings_problem(s.key, s.value)), ', ')
    INTO v_wrong
    FROM app_private.platform_settings s
   WHERE app_private.platform_settings_problem(s.key, s.value) IS NOT NULL;
  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '20260919120000 self-check: a stored setting is refused by its own validator: %', v_wrong;
  END IF;

  v_seller := app_private.platform_setting_value('seller');

  SELECT c.* INTO v_source
    FROM public.company_settings c
   WHERE c.company_id = (
           SELECT up.company_id
             FROM public.user_profiles up
             JOIN app_private.platform_staff ps ON ps.user_id = up.user_id
            WHERE ps.disabled_at IS NULL
              AND ps.role = 'owner'
              AND up.company_id IS NOT NULL
            ORDER BY ps.created_at, ps.user_id
            LIMIT 1)
   LIMIT 1;

  IF FOUND THEN
    IF v_seller ->> 'name' IS DISTINCT FROM
         coalesce(nullif(left(btrim(v_source.company_name), 200), ''), 'El-Professor')
       OR v_seller ->> 'iban'        IS DISTINCT FROM coalesce(left(btrim(v_source.iban), 200), '')
       OR v_seller ->> 'vat_id'      IS DISTINCT FROM coalesce(left(btrim(v_source.vat_id), 200), '')
       OR v_seller ->> 'street'      IS DISTINCT FROM coalesce(left(btrim(v_source.street), 200), '')
       OR v_seller ->> 'postal_code' IS DISTINCT FROM coalesce(left(btrim(v_source.postal_code), 200), '')
       OR v_seller ->> 'city'        IS DISTINCT FROM coalesce(left(btrim(v_source.city), 200), '') THEN
      RAISE EXCEPTION '20260919120000 self-check: the seeded seller is not the company_settings row the invoice page reads';
    END IF;
    RAISE NOTICE '20260919120000: the seller was copied from the platform owner''s company settings (%)', v_seller ->> 'name';
  ELSE
    -- No platform owner in a company: the fallback the invoice page already
    -- applies, and the state 3.7b leaves behind.
    IF v_seller ->> 'name' IS DISTINCT FROM 'El-Professor'
       OR (SELECT count(*) FROM jsonb_each_text(v_seller) e WHERE e.key <> 'name' AND e.value <> '') <> 0 THEN
      RAISE EXCEPTION '20260919120000 self-check: with no source row the seller must be the empty El-Professor document';
    END IF;
    RAISE NOTICE '20260919120000: no platform owner sits in a company, so the seller was seeded empty, named El-Professor';
  END IF;

  -- 4. The rules the two earlier settings migrations installed still hold, so a
  --    botched copy of platform_settings_problem fails here and not on a
  --    customer's screen.
  v_seed := app_private.platform_setting_value('plan_features');
  IF app_private.platform_settings_problem('plan_features', v_seed) IS NOT NULL
     OR app_private.platform_settings_problem('plan_features', v_seed - 'gehaelter')
          IS DISTINCT FROM 'plan_features.missing.gehaelter'
     OR app_private.platform_settings_problem('plan_features', '{}'::jsonb) IS NULL
     OR app_private.platform_settings_problem('plan_features',
          v_seed || '{"a_feature_of_a_later_release": "basic"}'::jsonb) IS NOT NULL THEN
    RAISE EXCEPTION '20260919120000 self-check: the complete-feature-map rule of 20260917120000 did not survive';
  END IF;

  IF app_private.platform_settings_problem('price_book',
       app_private.platform_setting_value('price_book')) IS NOT NULL
     OR app_private.platform_settings_problem('price_book', '{}'::jsonb) IS DISTINCT FROM 'price_book' THEN
    RAISE EXCEPTION '20260919120000 self-check: the price book validator did not survive';
  END IF;

  -- The new validators, at their edges.
  IF app_private.platform_settings_problem('trial', '{"days": 0}'::jsonb) IS DISTINCT FROM 'trial.days'
     OR app_private.platform_settings_problem('trial', '{"days": 366}'::jsonb) IS DISTINCT FROM 'trial.days'
     OR app_private.platform_settings_problem('trial', '{"days": 14, "weeks": 2}'::jsonb) IS DISTINCT FROM 'trial'
     OR app_private.platform_settings_problem('trial', '{"days": 1}'::jsonb) IS NOT NULL
     OR app_private.platform_settings_problem('seller', '{}'::jsonb) IS DISTINCT FROM 'seller'
     OR app_private.platform_settings_problem('seller',
          jsonb_set(v_seller, '{name}', '""'::jsonb)) IS DISTINCT FROM 'seller.name'
     OR app_private.platform_settings_problem('seller',
          jsonb_set(v_seller, '{city}', '"Solingen\nNRW"'::jsonb)) IS DISTINCT FROM 'seller.city'
     OR app_private.platform_settings_problem('invoice', '{}'::jsonb) IS DISTINCT FROM 'invoice'
     OR app_private.platform_settings_problem('invoice',
          jsonb_set(app_private.platform_setting_value('invoice'), '{number_prefix}', '"inv-x"'::jsonb))
          IS DISTINCT FROM 'invoice.number_prefix'
     OR app_private.platform_settings_problem('invoice',
          jsonb_set(app_private.platform_setting_value('invoice'), '{number_digits}', '0'::jsonb))
          IS DISTINCT FROM 'invoice.number_digits' THEN
    RAISE EXCEPTION '20260919120000 self-check: a validator this file installs does not refuse what it must';
  END IF;

  -- 5. The trial. This replaces 20260916150000's self-check 6, which read the
  --    constant out of signup_insert_company's source; there is no constant to
  --    read any more, so the comparison is made where it belongs.
  IF app_private.signup_trial_days() IS DISTINCT FROM
       (app_private.platform_setting_value('trial') ->> 'days')::integer THEN
    RAISE EXCEPTION '20260919120000 self-check: signup_trial_days() says %, the trial setting says %',
      app_private.signup_trial_days(), app_private.platform_setting_value('trial') ->> 'days';
  END IF;

  -- The seeded length is the one the constant applied, so this release gives
  -- the trial the previous one gave.
  IF make_interval(days => app_private.signup_trial_days()) IS DISTINCT FROM interval '14 days' THEN
    RAISE EXCEPTION '20260919120000 self-check: a new company would get a % trial, not the 14 days it got before',
      make_interval(days => app_private.signup_trial_days());
  END IF;

  SELECT p.prosrc INTO v_src
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('app_private.signup_insert_company(uuid,text,text,text,text,text,integer,uuid,text,text)');

  IF v_src !~ 'signup_trial_days' THEN
    RAISE EXCEPTION '20260919120000 self-check: signup_insert_company no longer reads the trial setting';
  END IF;
  IF v_src ~ $re$interval\s*'\d+ *days?'$re$ THEN
    RAISE EXCEPTION '20260919120000 self-check: signup_insert_company has a hard-coded trial length again';
  END IF;

  IF (public.get_public_config() ->> 'trial_days')::integer IS DISTINCT FROM app_private.signup_trial_days() THEN
    RAISE EXCEPTION '20260919120000 self-check: get_public_config() quotes a trial length the signup does not give';
  END IF;

  -- 6. The signup path can make that call: its owner reaches app_private.
  SELECT p.proowner INTO v_owner
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('app_private.signup_insert_company(uuid,text,text,text,text,text,integer,uuid,text,text)');

  IF NOT has_schema_privilege(v_owner, 'app_private', 'USAGE')
     OR NOT has_function_privilege(v_owner, 'app_private.signup_trial_days()'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION '20260919120000 self-check: %, which owns signup_insert_company, cannot call signup_trial_days() — every signup would fail',
      (SELECT rolname FROM pg_roles WHERE oid = v_owner);
  END IF;

  -- 7. Who may write the three keys, and who may read them. All three are
  --    settings.manage — owner only — and billing, which holds settings.read
  --    for the prices alone, is refused all three.
  FOREACH v_action IN ARRAY ARRAY['seller', 'trial', 'invoice'] LOOP
    IF app_private.platform_setting_write_capability(v_action) IS DISTINCT FROM 'settings.manage'
       OR app_private.platform_setting_is_pricing(v_action)
       OR app_private.platform_settings_readable('billing', v_action)
       OR NOT app_private.platform_settings_readable('owner', v_action)
       OR NOT app_private.platform_settings_readable('read_only', v_action)
       OR app_private.platform_settings_readable('support', v_action) THEN
      RAISE EXCEPTION '20260919120000 self-check: the authority over the % key is not the one plan 3.A states', v_action;
    END IF;
  END LOOP;

  -- The other half of 3.10 is not here, so its key still has no validator.
  IF app_private.platform_settings_problem('mail.sender', '{}'::jsonb) IS DISTINCT FROM 'unknown_key' THEN
    RAISE EXCEPTION '20260919120000 self-check: mail.sender belongs to the other half of 3.10 and must still be unknown';
  END IF;

  -- 8. Neither settings RPC was redefined, so both still carry the per-actor cap
  --    and their audit write (20260917120000), and platform_audit_record still
  --    refuses to forge a settings row (20260916150000's allow-list).
  FOREACH v_sig IN ARRAY ARRAY['public.platform_settings_get(text)',
                               'public.platform_settings_put(text,jsonb,integer)'] LOOP
    SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = to_regprocedure(v_sig);
    IF v_src !~ 'platform_settings_rate_limited' OR v_src !~ 'audit_write' THEN
      RAISE EXCEPTION '20260919120000 self-check: % has lost its cap or its audit row', v_sig;
    END IF;
  END LOOP;

  FOREACH v_action IN ARRAY ARRAY['platform_settings.get', 'platform_settings.put'] LOOP
    BEGIN
      PERFORM public.platform_audit_record('settings', v_action, 'ok');
      RAISE EXCEPTION '20260919120000 self-check: platform_audit_record accepts the forbidden action %', v_action;
    EXCEPTION
      WHEN invalid_parameter_value THEN NULL;   -- 22023: the refusal this pins
    END;
  END LOOP;
END $$;
