/*
  # A company's own settings are read inside a context, not by capability (plan 3.13b)

  Builds on 20260917130000 (one shape for every tenant policy), 20260917140000
  (plan 3.4a: the support context, and the two seams turned into constants) and
  20260921110000 (plan 3.13a: the shell's *writes* moved behind the support
  session). Nothing here redefines a function of those files except the one
  read-model statement named below, and no session helper of 20260919130000 or
  20260920100000 is restated.

  ## What is already closed, and what this file found still open

  Slice 3.13b set out to close "the direct read", the concession CLAUDE.md
  still describes as the owner's decision of 16.09.2026. The inventory found
  that 20260917140000 had already closed the larger half of it:

      public.platform_reads_company_data()  ->  SELECT false
      public.platform_writes_company_data() ->  SELECT false

  Every business table's SELECT policy is `company_id = get_active_company_id()
  OR (SELECT platform_reads_company_data())`, and the second term has been
  false since that file. `user_profiles_select`, `roles_select` and
  `role_permissions_select` read the same seam. So a platform account reads a
  company's Fahrtenbuch, planning, historical and ledger rows, its profiles and
  its role matrix only through the company its context names — which
  get_active_company_id() and get_user_company_id() answer for a company-less
  staff account — or through the audited read models. Section 3 below re-asserts
  that as a rule rather than leaving it as a fact about two function bodies.

  What the inventory found still open is one table: **company_settings**.

      company_settings_select
        USING (company_id = get_user_company_id()
               OR platform_can('companies.read'))

  `companies.read` is held by all four roles (plan 3.A), so a `read_only`
  platform account read every customer's legal name, managing director, VAT and
  tax number, commercial register, bank name, IBAN, BIC and account holder —
  the whole of 20260402053937's table — with no context, no reason recorded and
  no audit row. That is a wider read than the audited directories allow for a
  driver's name (`platform_drivers_list`, one `read` row per call, reduced
  columns), and it survived 20260921110000, which moved this table's INSERT,
  UPDATE and DELETE onto `platform_support_company_id()` and left the SELECT
  where 20260917130000 put it.

  ## What this file changes

  1. `company_settings_select` loses its platform branch. The tenant term is
     the whole predicate, and since 20260917140000 `get_user_company_id()`
     answers the open context's company for an account that has none of its own
     — so a platform account reads a company's settings inside a context, in
     either mode, and reads none outside one. This is the smaller of the two
     corrections available: writing `OR company_id = platform_view_company_id()`
     beside the tenant term would say the same thing twice, because that is
     exactly what the tenant term already resolves to for such a caller.

  2. `app_private.platform_companies_list_statement()` carries
     `drivers_per_car_limit` per company, from one grouped read of
     company_settings restricted to the page — the rule 20260916140000 states
     for every figure in this model. It is the one column of that table the
     panel read across companies: SuperAdminDashboard multiplies it by the car
     limit to show "drivers used of the allowance". It is a configuration
     number, not personal, financial or identifying data, and it is the only
     column of company_settings this model may carry; self-check 5 fails a
     statement that reads another.

     Nothing else in the panel read company_settings across companies.
     SubscriptionBillingPage prints its seller from `platform_invoice_seller()`
     (20260920130000) and the invoice address from `companies`, and the tenant
     screens (SettingsPage, CompanySettingsContext,
     MonatsplanungStundennachweisPreview) read the caller's own company, which
     is the term that stays.

  ## What this file deliberately does not change, and why

  Five SELECT policies still let a platform account read a company's row with a
  capability and no company term:

      companies, company_subscriptions, subscription_invoices,
      subscription_payment_audit, subscription_coverage   -> companies.read

  Those are the platform's own records *about* a customer — the account row and
  the money — not the customer's operational data, and tests/rls/matrix.sql
  records them as a decision rather than a hole: "the money a platform account
  reads to run the business is companies.read's, which every staff role holds by
  design (plan 3.A)". Closing them means moving CompaniesPage,
  SuperAdminDashboard and SubscriptionBillingPage onto audited, paged read
  models — server-side search, filter and sort where all three filter the whole
  list in the browser today — and a company list that can only be read inside a
  context is self-defeating, since the list is how a company is chosen to open
  one on. That is a product decision with a real cost, so it is written down as
  open decision **D14** in HANDOFF.md and not taken here. Self-check 4 prints
  the live set as a NOTICE on every run, so it cannot grow unnoticed.

  The `codes.manage` reads (activation codes and their attempts, discount codes
  and redemptions) and the platform catalogues (subscription_plans,
  document_categories, referrals, subscription_admin_actions) are untouched for
  the same reason: none of them is a company's operational data, and D14 covers
  the ones that name a company.

  ## Compatibility

  Backward compatible; no SCHEMA_EPOCH bump. The previous release's
  SuperAdminDashboard reads company_settings across companies and now gets an
  empty set — it already treats a missing row as the default of 4
  (`dpcMap[c.id] ?? 4`), so it renders a wrong allowance rather than failing,
  and a rollback restores the reading. Nothing else in either release reads the
  table outside its own company. The added key in platform_companies_list is
  ignored by the previous release's parser, which names the keys it reads.
*/

-- ─── 1. company_settings is read through the tenant term alone ──────────────

DROP POLICY IF EXISTS company_settings_select ON public.company_settings;

CREATE POLICY company_settings_select ON public.company_settings
  FOR SELECT TO authenticated
  USING (company_id = (SELECT public.get_user_company_id()));

COMMENT ON POLICY company_settings_select ON public.company_settings IS
  'The caller''s own company, or for a company-less platform account the company '
  'its context names (20260917140000). A platform account reads no company''s '
  'legal and bank data outside a context; the panel''s one cross-company figure, '
  'drivers_per_car_limit, comes from the audited platform_companies_list.';

-- ─── 2. The one column the audited company list carries from that table ─────

/*
  20260916140000's statement, with one CTE added and one key in the item
  object. Everything else is that file's text: the filters, the ordering, the
  page CTE and the four grouped figures, each restricted to the page rather
  than computed per company.

  company_settings has a unique constraint on company_id
  (20260627142447), so the grouped read is one row per company; max() is used
  rather than a plain join so a database that predates that constraint still
  answers one number instead of multiplying the page.
*/
CREATE OR REPLACE FUNCTION app_private.platform_companies_list_statement()
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  RETURN $sql$
WITH filtered AS (
  SELECT t.*
    FROM (SELECT c.id, c.name, c.slug, c.status, c.approval_status, c.plan, c.billing_cycle,
                 c.subscription_car_limit, c.subscription_status, c.subscription_started_at,
                 c.subscription_expires_at, c.subscription_duration_type,
                 c.trial_start, c.trial_end, c.created_at, c.archived_at, c.deleted_at,
                 CASE WHEN c.status = 'trial' AND c.trial_end >  now() THEN 'running'
                      WHEN c.status = 'trial' AND c.trial_end <= now() THEN 'expired'
                 END AS trial_state
            FROM public.companies c
           WHERE ($1::text IS NULL OR c.name ILIKE $1 OR c.slug ILIKE $1)
             AND ($2::text IS NULL OR c.approval_status = $2)
             AND ($3::text IS NULL OR c.status = $3)
             AND ($4::text IS NULL OR c.plan = $4)
             AND ($5::text IS NULL OR c.subscription_status = $5)
             AND (NOT $7::boolean
                  OR c.id IN (SELECT i.company_id
                                FROM public.subscription_invoices i
                               WHERE i.status = 'overdue'
                                  OR (i.status = 'open' AND (i.due_date::timestamp AT TIME ZONE 'UTC') < now())))) t
   WHERE $6::text IS NULL OR coalesce(t.trial_state, 'none') = $6
),
page AS (
  SELECT f.*,
         row_number() OVER (ORDER BY
           CASE WHEN $8::text = 'name_asc'                     THEN lower(f.name) END ASC  NULLS LAST,
           CASE WHEN $8::text = 'name_desc'                    THEN lower(f.name) END DESC NULLS LAST,
           CASE WHEN $8::text = 'created_at_asc'               THEN f.created_at END ASC  NULLS LAST,
           CASE WHEN $8::text = 'created_at_desc'              THEN f.created_at END DESC NULLS LAST,
           CASE WHEN $8::text = 'subscription_expires_at_asc'  THEN f.subscription_expires_at END ASC  NULLS LAST,
           CASE WHEN $8::text = 'subscription_expires_at_desc' THEN f.subscription_expires_at END DESC NULLS LAST,
           CASE WHEN $8::text = 'trial_end_asc'                THEN f.trial_end END ASC  NULLS LAST,
           CASE WHEN $8::text = 'trial_end_desc'               THEN f.trial_end END DESC NULLS LAST,
           f.id) AS ord
    FROM filtered f
   ORDER BY ord
   LIMIT $9::integer OFFSET $10::integer
),
invoice_figures AS (
  SELECT i.company_id,
         count(*) FILTER (WHERE i.status = 'open') AS open_invoices,
         count(*) FILTER (WHERE i.status = 'overdue'
                             OR (i.status = 'open' AND (i.due_date::timestamp AT TIME ZONE 'UTC') < now())) AS overdue_invoices,
         max(i.paid_at) FILTER (WHERE i.status = 'paid') AS last_payment_at
    FROM public.subscription_invoices i
   WHERE i.company_id IN (SELECT p.id FROM page p)
   GROUP BY i.company_id
),
user_counts AS (
  SELECT up.company_id, count(*) AS users
    FROM public.user_profiles up
   WHERE up.company_id IN (SELECT p.id FROM page p)
     AND NOT EXISTS (SELECT 1 FROM app_private.platform_staff s WHERE s.user_id = up.user_id)
   GROUP BY up.company_id
),
driver_counts AS (
  SELECT d.company_id, count(*) AS drivers
    FROM public.drivers d
   WHERE d.company_id IN (SELECT p.id FROM page p)
     AND d.status IS DISTINCT FROM 'inactive'
   GROUP BY d.company_id
),
vehicle_counts AS (
  SELECT v.company_id, count(*) AS vehicles
    FROM public.cars v
   WHERE v.company_id IN (SELECT p.id FROM page p)
     AND v.status IS DISTINCT FROM 'inactive'
   GROUP BY v.company_id
),
settings_figures AS (
  SELECT cs.company_id, max(cs.drivers_per_car_limit) AS drivers_per_car_limit
    FROM public.company_settings cs
   WHERE cs.company_id IN (SELECT p.id FROM page p)
   GROUP BY cs.company_id
)
SELECT jsonb_build_object(
  'total', (SELECT count(*) FROM filtered),
  'items', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'id',                         p.id,
             'name',                       p.name,
             'slug',                       p.slug,
             'status',                     p.status,
             'approval_status',            p.approval_status,
             'plan',                       p.plan,
             'billing_cycle',              p.billing_cycle,
             'subscription_car_limit',     p.subscription_car_limit,
             'subscription_status',        p.subscription_status,
             'subscription_started_at',    p.subscription_started_at,
             'subscription_expires_at',    p.subscription_expires_at,
             'subscription_duration_type', p.subscription_duration_type,
             'trial_start',                p.trial_start,
             'trial_end',                  p.trial_end,
             'trial_state',                p.trial_state,
             'created_at',                 p.created_at,
             'archived_at',                p.archived_at,
             'deleted_at',                 p.deleted_at,
             'open_invoice_count',         coalesce(fi.open_invoices, 0),
             'overdue_invoice_count',      coalesce(fi.overdue_invoices, 0),
             'last_payment_at',            fi.last_payment_at,
             'user_count',                 coalesce(uc.users, 0),
             'active_driver_count',        coalesce(dc.drivers, 0),
             'active_vehicle_count',       coalesce(vc.vehicles, 0),
             'drivers_per_car_limit',      sf.drivers_per_car_limit
           ) ORDER BY p.ord)
      FROM page p
      LEFT JOIN invoice_figures  fi ON fi.company_id = p.id
      LEFT JOIN user_counts      uc ON uc.company_id = p.id
      LEFT JOIN driver_counts    dc ON dc.company_id = p.id
      LEFT JOIN vehicle_counts   vc ON vc.company_id = p.id
      LEFT JOIN settings_figures sf ON sf.company_id = p.id
  ), '[]'::jsonb))
$sql$;
END;
$fn$;

-- ─── 3. Ownership and privileges ────────────────────────────────────────────

-- CREATE OR REPLACE keeps the owner and the grants 20260916140000 set; both are
-- restated so this file's self-check does not depend on that one.
ALTER FUNCTION app_private.platform_companies_list_statement() OWNER TO CURRENT_USER;
REVOKE ALL ON FUNCTION app_private.platform_companies_list_statement()
  FROM PUBLIC, anon, authenticated, service_role;

-- ─── 4. Self-check ──────────────────────────────────────────────────────────

DO $selfcheck$
DECLARE
  c_keys CONSTANT text[] := ARRAY[
    'id','name','slug','status','approval_status','plan','billing_cycle',
    'subscription_car_limit','subscription_status','subscription_started_at',
    'subscription_expires_at','subscription_duration_type','trial_start','trial_end',
    'trial_state','created_at','archived_at','deleted_at','open_invoice_count',
    'overdue_invoice_count','last_payment_at','user_count','active_driver_count',
    'active_vehicle_count','drivers_per_car_limit'];

  v_wrong   text;
  v_stmt    text;
  v_page    jsonb;
  v_item    jsonb;
  v_keys    text[];
  v_checked integer := 0;
BEGIN
  -- 1. company_settings: four policies, and its SELECT names no capability and
  --    no context helper — the tenant term is the whole predicate.
  SELECT string_agg(p.policyname || ' (' || p.cmd || ')', ', ' ORDER BY p.policyname) INTO v_wrong
    FROM pg_policies p
   WHERE p.schemaname = 'public' AND p.tablename = 'company_settings'
     AND p.policyname NOT IN ('company_settings_select', 'company_settings_insert',
                              'company_settings_update', 'company_settings_delete');

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '20260923100000 self-check: company_settings carries a policy outside the four canonical names: %', v_wrong;
  END IF;

  SELECT coalesce(p.qual, '') INTO v_wrong
    FROM pg_policies p
   WHERE p.schemaname = 'public' AND p.tablename = 'company_settings'
     AND p.policyname = 'company_settings_select';

  IF v_wrong IS NULL THEN
    RAISE EXCEPTION '20260923100000 self-check: company_settings_select is missing';
  END IF;

  IF v_wrong ~ 'platform_can\(' OR v_wrong ~ 'platform_reads_company_data' THEN
    RAISE EXCEPTION '20260923100000 self-check: company_settings_select still reads a platform capability: %', v_wrong;
  END IF;

  IF v_wrong !~ 'get_user_company_id\(\)' THEN
    RAISE EXCEPTION '20260923100000 self-check: company_settings_select does not read the tenant term: %', v_wrong;
  END IF;

  -- 2. 20260917140000's seams are still constants. Every business table's
  --    SELECT, and user_profiles', roles' and role_permissions', sit in an OR
  --    beside one of them, so a `true` here would reopen every one of them at
  --    once. This is the rule 3.13b was asked to establish; it is re-asserted
  --    rather than re-implemented.
  IF public.platform_reads_company_data() IS NOT FALSE THEN
    RAISE EXCEPTION '20260923100000 self-check: platform_reads_company_data() is not false — a staff role would read tenant data without a context';
  END IF;

  IF public.platform_writes_company_data() IS NOT FALSE THEN
    RAISE EXCEPTION '20260923100000 self-check: platform_writes_company_data() is not false';
  END IF;

  -- 3. …and the policies that must sit beside them still do. A migration that
  --    rebuilt one of these from a capability would pass check 2 and lose the
  --    rule anyway.
  SELECT string_agg(p.tablename || '.' || p.policyname, ', ' ORDER BY p.tablename) INTO v_wrong
    FROM pg_policies p
   WHERE p.schemaname = 'public'
     AND p.policyname IN ('user_profiles_select', 'roles_select', 'role_permissions_select',
                          'fahrtenbuch_trips_select', 'fahrtenbuch_imports_select',
                          'drivers_select', 'cars_select', 'receipts_select', 'salaries_select',
                          'cash_movements_select', 'salary_cash_receipts_select')
     AND coalesce(p.qual, '') !~ 'platform_reads_company_data';

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '20260923100000 self-check: a SELECT policy no longer reads the read seam: %', v_wrong;
  END IF;

  SELECT string_agg(p.tablename || '.' || p.policyname, ', ' ORDER BY p.tablename, p.policyname) INTO v_wrong
    FROM pg_policies p
   WHERE p.schemaname = 'public'
     AND p.policyname IN ('user_profiles_select', 'roles_select', 'role_permissions_select')
     AND coalesce(p.qual, '') ~ 'platform_can\(';

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '20260923100000 self-check: a profile or role SELECT policy names a capability: %', v_wrong;
  END IF;

  -- 4. What is left, printed rather than failed: open decision D14. These are
  --    the platform's own records about a customer, kept on companies.read by
  --    plan 3.A and recorded as a decision in tests/rls/matrix.sql. A new one
  --    does not fail a release, but it shows up on every run.
  SELECT string_agg(p.tablename || '.' || p.policyname, ', ' ORDER BY p.tablename, p.policyname) INTO v_wrong
    FROM pg_policies p
   WHERE p.schemaname = 'public'
     AND p.cmd IN ('SELECT', 'ALL')
     AND coalesce(p.qual, '') ~ 'platform_can\(';

  RAISE NOTICE '20260923100000: capability-only cross-tenant SELECT remains on: % (open decision D14)',
    coalesce(v_wrong, 'nothing');

  -- 5. The company list reads exactly one column of company_settings besides
  --    the id it groups on. Its statement text carries no comment, so this can
  --    only match code.
  v_stmt := app_private.platform_companies_list_statement();

  SELECT string_agg(DISTINCT m.ref[1] || '.' || m.ref[2], ', ') INTO v_wrong
    FROM regexp_matches(v_stmt, '\mcs\.([a-z_]+)', 'g') AS m(ref)
   WHERE m.ref[1] NOT IN ('company_id', 'drivers_per_car_limit');

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '20260923100000 self-check: the company list reads more of company_settings than the allowance: %', v_wrong;
  END IF;

  IF v_stmt ~ '(iban|bic|vat_id|tax_number|account_holder|commercial_register|fahrtenbuch_trips|receipts)' THEN
    RAISE EXCEPTION '20260923100000 self-check: the company list reads something the panel has no use for';
  END IF;

  -- 6. It still plans and runs, and every item carries exactly the documented
  --    keys — the twenty-four of 20260916140000 plus the one added here.
  EXECUTE 'EXPLAIN ' || v_stmt
    USING NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text,
          false, 'created_at_desc'::text, 50, 0;

  EXECUTE v_stmt INTO v_page
    USING NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text,
          false, 'created_at_desc'::text, 100, 0;

  IF v_page IS NULL OR jsonb_typeof(v_page -> 'items') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION '20260923100000 self-check: the company list does not answer {total, items}';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(v_page -> 'items') AS t(value) LOOP
    SELECT array_agg(k ORDER BY k) INTO v_keys FROM jsonb_object_keys(v_item) AS k;
    IF NOT (coalesce(v_keys, '{}'::text[]) @> c_keys AND coalesce(v_keys, '{}'::text[]) <@ c_keys) THEN
      RAISE EXCEPTION '20260923100000 self-check: an item carries % instead of the documented columns', v_keys;
    END IF;
    v_checked := v_checked + 1;
  END LOOP;

  IF v_checked = 0 THEN
    RAISE NOTICE '20260923100000 self-check: no companies here; the item columns are checked by tests/rls/platform-readmodels.sql';
  END IF;

  -- 7. The statement helper stays private and unprivileged.
  IF has_function_privilege('anon', 'app_private.platform_companies_list_statement()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'app_private.platform_companies_list_statement()', 'EXECUTE')
     OR has_function_privilege('service_role', 'app_private.platform_companies_list_statement()', 'EXECUTE') THEN
    RAISE EXCEPTION '20260923100000 self-check: an API role holds EXECUTE on platform_companies_list_statement()';
  END IF;
END
$selfcheck$;
