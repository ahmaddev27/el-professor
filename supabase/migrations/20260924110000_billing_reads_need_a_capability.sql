/*
  # The money a platform account reads is audited, and it is billing's (decision D14)

  Owner's decision, 24.09.2026, the middle path. Builds on 20260916140000 (plan
  3.6b: the five audited read models and their helpers), 20260917130000 (plan
  3.3: one shape for every tenant policy, and these four tables' current
  predicates), 20260917140000 (plan 3.4a: the support context, both seams turned
  into constants) and 20260923100000 (plan 3.13b: company_settings read through
  the tenant term alone — the closest precedent, one day old).

  ## What was open

  After 3.13b five SELECT policies still answered a platform account with a
  capability and no company term, and wrote no audit row:

      companies, company_subscriptions, subscription_invoices,
      subscription_payment_audit, subscription_coverage   ->  companies.read

  `companies.read` is held by all four staff roles by plan 3.A's design, and
  since 20260923110000 all four roles can actually exist. So any active staff
  row — `read_only` included — read every customer's invoices, what they paid,
  when, and the billing address printed on the invoice, with no context, no
  reason recorded and no audit row, while the same account needed an audited
  call to see one driver's name.

  ## What the owner chose, exactly

  **`companies` stays as it is.** It is the list an operator picks a company
  from in order to open a context on it, so requiring a context to read it is
  circular, and an audited read model for it would write one row every time the
  panel's home is opened. Its policy is not touched here.

  **The other four move.** They carry a customer's billing address and what they
  paid, and nothing needs them in order to choose a company. Their SELECT
  becomes the tenant term alone — `company_id = get_user_company_id()`, the
  account-shell predicate they already carried, which since 20260917140000 also
  answers the open context's company for a platform account that has none of its
  own. So a platform account reads them inside a context, or through the two
  audited read models below, and nowhere else.

  ## Which capability the read models ask, and what it costs

  **`billing.manage`** — owner and billing, not support and not read_only.

  - It is already the capability that *writes* all four tables: every INSERT,
    UPDATE and DELETE policy 20260917130000 gave them names it, and so do the
    six audited write RPCs of 20260916130000 (set plan, assign a subscription,
    mark paid, mark unpaid, cancel, and the manual subscription edit). Reading
    the money and changing it being one capability is the smaller surprise.
  - There is no `billing.read` in `app_private.platform_capability_matrix()`,
    and inventing one is a change to that function. 20260923110000 names it
    untouched and two open decisions (D2, D3) are about its contents; adding a
    capability as a side effect of this slice would decide by accident.
  - `companies.read` is the capability that answers *which customers exist*. It
    is the wrong one for *what this customer paid*, and it is the breadth that
    made the asymmetry above.

  **The behaviour change, stated plainly:** a `support` or `read_only` account
  keeps `companies.read`, so it keeps the company list and every company's own
  `status`, `approval_status`, `plan`, `subscription_status`,
  `subscription_expires_at`, `trial_start` and `trial_end` — enough to answer
  "is this customer's access live, and until when". It loses the invoice list,
  the amounts, the payment trail and the coverage periods. Inside an open
  context it reads that company's rows again through the tenant term, as it does
  every other table of that company since 3.4a. `AdminSidebar` asks for
  `billing.manage` on /admin/billing from now on, and the page itself says
  "Keine Berechtigung" rather than showing an empty table, because an empty
  invoice list is a claim.

  ## What this adds: two audited read models, in 20260916140000's shape

  - `platform_invoices_list`      billing.manage   the invoice table, its
                                  filters and the screen's six figures
  - `platform_subscriptions_list` billing.manage   the subscription table and
                                  the per-plan active counts

  Both follow that file rule for rule: `authenticated` alone holds EXECUTE (anon
  and the service role have no auth.uid() to answer for); SECURITY DEFINER with
  a pinned search_path; VOLATILE, so supabase-js calls them with POST and the
  audit row can be written — a GET runs in a read-only transaction and would
  fail instead of reading unrecorded; arguments validated first, raising 22023
  with a fixed message before anything is read or recorded; then
  `platform_can('billing.manage')`; then exactly one `read` row per call through
  `app_private.platform_read_record`, in the same transaction. A refusal is a
  return value, `{"ok": false, "reason": "not_authorized"}`, never an exception,
  so the `denied` row survives; an account with no staff role gets the same
  answer and writes nothing. Pages are capped at 100 rows and the offset at
  10000 by the shared helpers. Each list's SQL lives in an
  `app_private.…_statement()` function, so the test EXPLAINs exactly what
  production runs.

  **They take no sort argument, and that is deliberate.** The billing screen has
  never had a sort control: invoices are shown newest period first (year, month,
  created_at) and subscriptions newest first, and those orders are now fixed in
  the statements. Carrying an unused sort whitelist would be a contract to keep
  in step with nothing; adding one when a screen grows a control is a smaller
  change than maintaining it unused.

  ## Columns, for the owner's data protection review

  Invoices (17): id, company_id, company_name, company_address,
             company_postal_code, company_city, plan_name, invoice_month,
             invoice_year, invoice_number, amount, status, due_date, paid_at,
             cash_received_amount, receipt_note, created_at.
             Left out: subscription_id, payment_method (no screen renders it —
             both the table and the detail dialog print "Barzahlung" as a
             literal), updated_at, and **paid_by and collected_by**, which are
             account ids: the PDF already passes collectedByName as null, so
             nothing showed them. The company's name and postal address are
             carried because the invoice PDF prints them and an audited read
             that cannot build the document would be useless; they are columns
             of `companies`, which this decision leaves readable, so carrying
             them widens nothing. The company's e-mail address was selected by
             the old query and rendered nowhere, so it is not carried, and
             neither is `country`, which no document prints.

             **The address is `companies.address`, one line, and finding out why
             cost a defect.** The screen this replaces asked PostgREST for
             `companies(name, email, street, house_number, postal_code, city)`
             and the detail dialog and the PDF composed `street` + `house_number`
             above `postal_code` + `city`. `public.companies` has no `street`
             and no `house_number` — it carries `address`, `city`, `postal_code`
             and `country`, which is what `platform_company_create` writes and
             what CompaniesPage edits; the two column names belong to
             `company_settings` (20260402053937). So that embedded select was
             answered with `42703 column companies.street does not exist`, and
             the page did `if (invRes.data) setInvoices(...)`, which on an error
             is `data: null` — so the Rechnungen tab has been showing "Keine
             Rechnungen" and five of its six figures as zero for as long as the
             query has read that way (since the baseline commit), and the detail
             dialog's address row never rendered. The first draft of this
             migration copied the two names into the read model, where they
             would have failed loudly instead: self-check 6 EXPLAINs the
             statement, so the release would have stopped here. The list carries
             `address` and the PDF composes `address` above `postal_code city`,
             the same two lines CompaniesPage already prints from.
  Subscriptions (9): id, company_id, company_name, plan_id, plan_name, status,
             starts_at, billing_day, monthly_price.
             Left out: ends_at, payment_method and created_at (rendered
             nowhere; created_at orders the list without being returned),
             updated_at, and **notes**, a free-text field that may hold
             anything.

  Adding a column to either list later is a data protection decision, not a
  convenience: `tests/rls/platform-readmodels.sql` pins both lists key by key
  and self-check 6 below fails a statement that answers anything else.

  ## The six figures, and the one thing that moves

  The screen computed them in the browser over every row it had loaded. They are
  now computed in SQL, over the same sets:

  - open_count            status 'open', every invoice
  - overdue_count         status 'open' whose due date has passed. The
                          comparison is 20260916140000's,
                          `(due_date::timestamp AT TIME ZONE 'UTC') < now()`,
                          which is what `new Date('YYYY-MM-DD') < now` did.
                          Note it does **not** count status 'overdue' — the
                          billing screen never did, unlike the companies list
  - paid_this_month_count status 'paid' in the current period
  - filtered_amount       sum of amount over the *filtered* set
  - filtered_collected    sum over the filtered, paid set of the cash received,
                          falling back to the amount. The browser wrote
                          `i.cash_received_amount || i.amount`, and JavaScript's
                          `||` takes 0 as absent, so a receipt of exactly 0,00 €
                          counted the full amount. The SQL reproduces that
                          rather than using coalesce, which would count 0
  - years                 the distinct invoice years, for the year picker

  **What moves:** "paid this month" was the operator's browser month and is now
  the current month in Europe/Berlin, the zone this product pins everywhere
  else. For an operator in Germany it is the same number.

  These three counts and the year list read the whole invoice table once each,
  because that is what the figures are — the screen loaded every row to compute
  them. That is one scan per figure set, never a subquery per company, and it
  replaces sending every invoice of every customer to a browser.

  ## generate_invoice_number had to move with them, or invoicing breaks silently

  `public.generate_invoice_number` (20260607125649) is SECURITY INVOKER and
  reads `subscription_invoices` under the caller's own RLS — 20260915120000 says
  so in as many words. Narrowing the SELECT policy would leave it reading zero
  rows for a platform account, so it would answer 'INV-<year>-0001' for every
  call; `invoice_number` is UNIQUE, so the insert would fail with 23505, which
  GenerateInvoicesModal maps to "skipped". Invoice generation would report
  every company as skipped and create nothing, with no error anywhere.

  It is therefore SECURITY DEFINER here, with the same body — the same MAX over
  the same SPLIT_PART, the same 'INV-' prefix and the same four digits — behind
  `platform_can('billing.manage')`, and it answers NULL to anyone else. The
  screen already treats a null number as a failure it names. Nothing else in the
  repository calls it; a company user calling it got a number computed from its
  own invoices, which was never a number it could use.

  ## What deliberately gets no read model

  `subscription_payment_audit` and `subscription_coverage`. Nothing in the
  product reads either across companies — the payment trail is written by the
  invoice RPCs and read by nobody, and the coverage table is read only by
  `app_private.recompute_company_subscription` and the invoice apply, both
  SECURITY DEFINER. Building a paged read model for a list no screen shows would
  be code with no caller, which this repository removes rather than adds. When a
  screen needs one it gets its own, in this shape.

  ## What this does not touch

  - `companies`, by the decision above.
  - `public.platform_invoice_seller()` (20260920130000), which stays on
    `companies.read`: it reads the `seller` *setting*, not a billing table, and
    it is what lets billing and support build an invoice PDF without holding
    settings.read. Self-check 7 re-asserts it.
  - The four `codes.manage` reads and the platform catalogues
    (`subscription_plans`, `document_categories`, `referrals`,
    `subscription_admin_actions`): none of them is a customer's money.
  - `app_private.platform_capability_matrix()`, `platform_can`,
    `platform_read_record` and the five read models of 20260916140000.

  ## Compatibility

  Backward compatible in the database; no SCHEMA_EPOCH bump, for the same reason
  20260923100000 needed none. **But state the rollback honestly:** the previous
  release's SubscriptionBillingPage reads these tables directly, so after a
  rollback a platform account sees an empty billing screen — no invoices, no
  subscriptions, every figure zero — until the release is applied again. Nothing
  is lost and nothing wrong is written: its "Rechnungen erzeugen" would compute
  'INV-<year>-0001', hit the UNIQUE on invoice_number and report every company as
  skipped, or, in a year with no invoices yet, produce exactly the number it
  would have produced anyway. A company reading its own billing rows, the
  activation flow and every write RPC are unaffected in both directions.
*/

-- ─── 1. The four tables are read through the tenant term alone ──────────────

/*
  The predicate is the one each policy already carried, minus its platform
  branch. `get_user_company_id()` stays rather than `get_active_company_id()`:
  this is the account shell (CLAUDE.md, "two company helpers"), and a suspended
  company's owner has to keep reading its own subscription and invoices, or
  /abo-aktivieren and /billing come up empty — which is the whole reason those
  pages are reachable in that state. Since 20260917140000 the same helper
  answers the open context's company for a platform account with none of its
  own, so writing a context helper beside it would say the same thing twice.
*/

DROP POLICY IF EXISTS company_subscriptions_select ON public.company_subscriptions;

CREATE POLICY company_subscriptions_select ON public.company_subscriptions
  FOR SELECT TO authenticated
  USING (company_id = (SELECT public.get_user_company_id()));

COMMENT ON POLICY company_subscriptions_select ON public.company_subscriptions IS
  'The caller''s own company, or for a company-less platform account the company '
  'its context names (20260917140000). Across companies a platform account reads '
  'this table through the audited platform_subscriptions_list, which asks '
  'billing.manage (decision D14, 24.09.2026).';

DROP POLICY IF EXISTS subscription_invoices_select ON public.subscription_invoices;

CREATE POLICY subscription_invoices_select ON public.subscription_invoices
  FOR SELECT TO authenticated
  USING (company_id = (SELECT public.get_user_company_id()));

COMMENT ON POLICY subscription_invoices_select ON public.subscription_invoices IS
  'The caller''s own company, or for a company-less platform account the company '
  'its context names. Across companies a platform account reads this table '
  'through the audited platform_invoices_list, which asks billing.manage '
  '(decision D14, 24.09.2026).';

DROP POLICY IF EXISTS subscription_payment_audit_select ON public.subscription_payment_audit;

CREATE POLICY subscription_payment_audit_select ON public.subscription_payment_audit
  FOR SELECT TO authenticated
  USING (company_id = (SELECT public.get_user_company_id()));

COMMENT ON POLICY subscription_payment_audit_select ON public.subscription_payment_audit IS
  'The caller''s own company, or for a company-less platform account the company '
  'its context names. No read model carries this table: nothing in the product '
  'reads the payment trail across companies (decision D14, 24.09.2026).';

DROP POLICY IF EXISTS subscription_coverage_select ON public.subscription_coverage;

CREATE POLICY subscription_coverage_select ON public.subscription_coverage
  FOR SELECT TO authenticated
  USING (company_id = (SELECT public.get_user_company_id()));

COMMENT ON POLICY subscription_coverage_select ON public.subscription_coverage IS
  'The caller''s own company, or for a company-less platform account the company '
  'its context names. No read model carries this table: the periods are read by '
  'app_private.recompute_company_subscription and the invoice apply, both '
  'SECURITY DEFINER (decision D14, 24.09.2026).';

-- ─── 2. The statements ──────────────────────────────────────────────────────

/*
  $1 company_id, $2 month, $3 year, $4 status, $5 search pattern, $6 limit,
  $7 offset. Returns one jsonb value: {"total": n, "summary": {...},
  "items": [...]}.

  The order is fixed: newest period first, exactly what the screen's three
  .order() calls asked PostgREST for, with the id as the final tiebreaker so a
  page boundary is stable.
*/
CREATE OR REPLACE FUNCTION app_private.platform_invoices_list_statement()
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  RETURN $sql$
WITH filtered AS (
  SELECT i.id, i.company_id, c.name AS company_name,
         c.address AS company_address,
         c.postal_code AS company_postal_code, c.city AS company_city,
         pl.name AS plan_name,
         i.invoice_month, i.invoice_year, i.invoice_number, i.amount, i.status,
         i.due_date, i.paid_at, i.cash_received_amount, i.receipt_note, i.created_at
    FROM public.subscription_invoices i
    LEFT JOIN public.companies c              ON c.id  = i.company_id
    LEFT JOIN public.company_subscriptions s  ON s.id  = i.subscription_id
    LEFT JOIN public.subscription_plans pl    ON pl.id = s.plan_id
   WHERE ($1::uuid    IS NULL OR i.company_id    = $1)
     AND ($2::integer IS NULL OR i.invoice_month = $2)
     AND ($3::integer IS NULL OR i.invoice_year  = $3)
     AND ($4::text    IS NULL OR i.status        = $4)
     AND ($5::text    IS NULL OR c.name ILIKE $5 OR i.invoice_number ILIKE $5)
),
page AS (
  SELECT f.*,
         row_number() OVER (ORDER BY f.invoice_year DESC, f.invoice_month DESC,
                                     f.created_at DESC, f.id) AS ord
    FROM filtered f
   ORDER BY ord
   LIMIT $6::integer OFFSET $7::integer
),
totals AS (
  SELECT count(*) FILTER (WHERE i.status = 'open') AS open_count,
         count(*) FILTER (WHERE i.status = 'open'
                            AND (i.due_date::timestamp AT TIME ZONE 'UTC') < now()) AS overdue_count,
         count(*) FILTER (WHERE i.status = 'paid'
                            AND i.invoice_month = EXTRACT(month FROM (now() AT TIME ZONE 'Europe/Berlin'))::integer
                            AND i.invoice_year  = EXTRACT(year  FROM (now() AT TIME ZONE 'Europe/Berlin'))::integer) AS paid_this_month_count
    FROM public.subscription_invoices i
),
sums AS (
  SELECT coalesce(sum(f.amount), 0) AS filtered_amount,
         coalesce(sum(CASE WHEN f.status = 'paid'
                           THEN CASE WHEN f.cash_received_amount IS NULL OR f.cash_received_amount = 0
                                     THEN f.amount ELSE f.cash_received_amount END
                      END), 0) AS filtered_collected
    FROM filtered f
)
SELECT jsonb_build_object(
  'total', (SELECT count(*) FROM filtered),
  'summary', (SELECT jsonb_build_object(
                'open_count',            t.open_count,
                'overdue_count',         t.overdue_count,
                'paid_this_month_count', t.paid_this_month_count,
                'filtered_amount',       s.filtered_amount,
                'filtered_collected',    s.filtered_collected,
                'years', coalesce((SELECT jsonb_agg(DISTINCT y.invoice_year)
                                     FROM public.subscription_invoices y), '[]'::jsonb))
                FROM totals t, sums s),
  'items', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'id',                    p.id,
             'company_id',            p.company_id,
             'company_name',          p.company_name,
             'company_address',       p.company_address,
             'company_postal_code',   p.company_postal_code,
             'company_city',          p.company_city,
             'plan_name',             p.plan_name,
             'invoice_month',         p.invoice_month,
             'invoice_year',          p.invoice_year,
             'invoice_number',        p.invoice_number,
             'amount',                p.amount,
             'status',                p.status,
             'due_date',              p.due_date,
             'paid_at',               p.paid_at,
             'cash_received_amount',  p.cash_received_amount,
             'receipt_note',          p.receipt_note,
             'created_at',            p.created_at
           ) ORDER BY p.ord)
      FROM page p
  ), '[]'::jsonb))
$sql$;
END;
$fn$;

/*
  $1 company_id, $2 status, $3 limit, $4 offset. Returns {"total": n,
  "summary": {...}, "items": [...]}.

  `active_by_plan` counts every active subscription, not the page's: the plans
  tab prints "n aktive Abonnements" under each plan card, and the browser used
  to count them from the whole list it had loaded.
*/
CREATE OR REPLACE FUNCTION app_private.platform_subscriptions_list_statement()
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  RETURN $sql$
WITH filtered AS (
  SELECT s.id, s.company_id, c.name AS company_name, s.plan_id, pl.name AS plan_name,
         s.status, s.starts_at, s.billing_day, s.monthly_price, s.created_at
    FROM public.company_subscriptions s
    LEFT JOIN public.companies c           ON c.id  = s.company_id
    LEFT JOIN public.subscription_plans pl ON pl.id = s.plan_id
   WHERE ($1::uuid IS NULL OR s.company_id = $1)
     AND ($2::text IS NULL OR s.status     = $2)
),
page AS (
  SELECT f.*,
         row_number() OVER (ORDER BY f.created_at DESC, f.id) AS ord
    FROM filtered f
   ORDER BY ord
   LIMIT $3::integer OFFSET $4::integer
),
active AS (
  SELECT s.plan_id, count(*) AS n
    FROM public.company_subscriptions s
   WHERE s.status = 'active'
   GROUP BY s.plan_id
)
SELECT jsonb_build_object(
  'total', (SELECT count(*) FROM filtered),
  'summary', jsonb_build_object(
     'active_count',   coalesce((SELECT sum(a.n) FROM active a), 0),
     'active_by_plan', coalesce((SELECT jsonb_object_agg(a.plan_id::text, a.n) FROM active a), '{}'::jsonb)),
  'items', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'id',            p.id,
             'company_id',    p.company_id,
             'company_name',  p.company_name,
             'plan_id',       p.plan_id,
             'plan_name',     p.plan_name,
             'status',        p.status,
             'starts_at',     p.starts_at,
             'billing_day',   p.billing_day,
             'monthly_price', p.monthly_price
           ) ORDER BY p.ord)
      FROM page p
  ), '[]'::jsonb))
$sql$;
END;
$fn$;

-- ─── 3. platform_invoices_list ──────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.platform_invoices_list(
  p_company_id uuid    DEFAULT NULL,
  p_month      integer DEFAULT NULL,
  p_year       integer DEFAULT NULL,
  p_status     text    DEFAULT NULL,
  p_search     text    DEFAULT NULL,
  p_limit      integer DEFAULT 50,
  p_offset     integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_action   CONSTANT text := 'platform_read.invoices_list';
  -- 2020 is subscription_invoices' own CHECK (20260607125649). There is no
  -- upper CHECK; 2100 is this contract's, so a picker sending a typo asks for
  -- nothing rather than scanning the table for a year that cannot exist.
  c_min_year CONSTANT integer := 2020;
  c_max_year CONSTANT integer := 2100;
  v_status  text;
  v_search  text;
  v_limit   integer;
  v_offset  integer;
  v_request jsonb;
  v_page    jsonb;
BEGIN
  v_status := app_private.platform_read_token(p_status);
  v_search := app_private.platform_read_search(p_search);
  v_limit  := app_private.platform_read_limit(p_limit);
  v_offset := app_private.platform_read_offset(p_offset);

  -- A month or a year outside its range is a broken contract, not an empty
  -- result: the screen sends NULL for "all", never 0.
  IF (p_month IS NOT NULL AND (p_month < 1 OR p_month > 12))
     OR (p_year IS NOT NULL AND (p_year < c_min_year OR p_year > c_max_year)) THEN
    RAISE EXCEPTION 'platform_invoices_list: invalid arguments' USING ERRCODE = '22023';
  END IF;

  v_request := jsonb_strip_nulls(jsonb_build_object(
    'company_id', p_company_id, 'month', p_month, 'year', p_year,
    'status', v_status, 'search', v_search, 'limit', v_limit, 'offset', v_offset));

  IF NOT coalesce(public.platform_can('billing.manage'), false) THEN
    PERFORM app_private.platform_read_record(c_action, 'denied', p_company_id, 'invoice',
                                             jsonb_build_object('request', v_request));
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
  END IF;

  EXECUTE app_private.platform_invoices_list_statement() INTO v_page
    USING p_company_id, p_month, p_year, v_status,
          app_private.platform_read_like(v_search), v_limit, v_offset;

  PERFORM app_private.platform_read_record(c_action, 'ok', p_company_id, 'invoice',
    jsonb_build_object('request', v_request,
                       'returned', jsonb_array_length(v_page -> 'items'),
                       'total', v_page -> 'total'));

  RETURN jsonb_build_object('ok', true, 'total', v_page -> 'total', 'limit', v_limit,
                            'offset', v_offset, 'items', v_page -> 'items',
                            'summary', v_page -> 'summary');
END;
$$;

-- ─── 4. platform_subscriptions_list ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.platform_subscriptions_list(
  p_company_id uuid    DEFAULT NULL,
  p_status     text    DEFAULT NULL,
  p_limit      integer DEFAULT 50,
  p_offset     integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_action CONSTANT text := 'platform_read.subscriptions_list';
  v_status  text;
  v_limit   integer;
  v_offset  integer;
  v_request jsonb;
  v_page    jsonb;
BEGIN
  v_status := app_private.platform_read_token(p_status);
  v_limit  := app_private.platform_read_limit(p_limit);
  v_offset := app_private.platform_read_offset(p_offset);

  v_request := jsonb_strip_nulls(jsonb_build_object(
    'company_id', p_company_id, 'status', v_status, 'limit', v_limit, 'offset', v_offset));

  IF NOT coalesce(public.platform_can('billing.manage'), false) THEN
    PERFORM app_private.platform_read_record(c_action, 'denied', p_company_id, 'subscription',
                                             jsonb_build_object('request', v_request));
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
  END IF;

  EXECUTE app_private.platform_subscriptions_list_statement() INTO v_page
    USING p_company_id, v_status, v_limit, v_offset;

  PERFORM app_private.platform_read_record(c_action, 'ok', p_company_id, 'subscription',
    jsonb_build_object('request', v_request,
                       'returned', jsonb_array_length(v_page -> 'items'),
                       'total', v_page -> 'total'));

  RETURN jsonb_build_object('ok', true, 'total', v_page -> 'total', 'limit', v_limit,
                            'offset', v_offset, 'items', v_page -> 'items',
                            'summary', v_page -> 'summary');
END;
$$;

-- ─── 5. generate_invoice_number reads past the narrowed policy ──────────────

/*
  20260607125649's body, unchanged except for schema qualification: the same
  MAX over SPLIT_PART(invoice_number, '-', 3), the same 'INV-' prefix, the same
  four digits. What changes is that it runs as its owner and asks for the
  capability that may raise an invoice, because as SECURITY INVOKER it would
  read nothing at all through the policy above (see the header).

  NULL rather than an exception: GenerateInvoicesModal already treats a missing
  number as a failure it names per company, and an exception there would abort a
  generation run halfway.
*/
CREATE OR REPLACE FUNCTION public.generate_invoice_number(p_year integer)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  next_seq   integer;
  inv_number text;
BEGIN
  IF NOT coalesce(public.platform_can('billing.manage'), false) THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(MAX(
    CAST(SPLIT_PART(invoice_number, '-', 3) AS integer)
  ), 0) + 1
  INTO next_seq
  FROM public.subscription_invoices
  WHERE invoice_year = p_year;

  inv_number := 'INV-' || p_year::text || '-' || LPAD(next_seq::text, 4, '0');
  RETURN inv_number;
END;
$$;

-- ─── 6. Ownership and privileges ────────────────────────────────────────────

/*
  Each SECURITY DEFINER function here reaches app_private, which only its owner
  or a superuser can (20260916110010, "Ownership"). generate_invoice_number
  predates this file and CREATE OR REPLACE keeps whatever owner it had, so it is
  given the migration role explicitly — as SECURITY DEFINER its owner is what
  decides whether it reads past RLS.
*/
ALTER FUNCTION public.platform_invoices_list(uuid, integer, integer, text, text, integer, integer) OWNER TO CURRENT_USER;
ALTER FUNCTION public.platform_subscriptions_list(uuid, text, integer, integer)                   OWNER TO CURRENT_USER;
ALTER FUNCTION public.generate_invoice_number(integer)                                            OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.platform_invoices_list_statement()                                     OWNER TO CURRENT_USER;
ALTER FUNCTION app_private.platform_subscriptions_list_statement()                                OWNER TO CURRENT_USER;

REVOKE ALL ON FUNCTION app_private.platform_invoices_list_statement()      FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.platform_subscriptions_list_statement() FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.platform_invoices_list(uuid, integer, integer, text, text, integer, integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_invoices_list(uuid, integer, integer, text, text, integer, integer)
  TO authenticated;

REVOKE ALL ON FUNCTION public.platform_subscriptions_list(uuid, text, integer, integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_subscriptions_list(uuid, text, integer, integer)
  TO authenticated;

-- 20260915120000's grants, restated so this file's self-check does not depend
-- on that one. The service role keeps EXECUTE and now gets NULL: it carries no
-- auth.uid(), so it holds no capability. Nothing calls it that way.
REVOKE ALL ON FUNCTION public.generate_invoice_number(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_invoice_number(integer) TO authenticated, service_role;

-- ─── 7. Self-check ──────────────────────────────────────────────────────────

DO $selfcheck$
DECLARE
  c_invoice_keys CONSTANT text[] := ARRAY[
    'id','company_id','company_name','company_address',
    'company_postal_code','company_city','plan_name','invoice_month','invoice_year',
    'invoice_number','amount','status','due_date','paid_at','cash_received_amount',
    'receipt_note','created_at'];
  c_sub_keys CONSTANT text[] := ARRAY[
    'id','company_id','company_name','plan_id','plan_name','status','starts_at',
    'billing_day','monthly_price'];
  c_invoice_summary CONSTANT text[] := ARRAY[
    'open_count','overdue_count','paid_this_month_count','filtered_amount',
    'filtered_collected','years'];
  c_sub_summary CONSTANT text[] := ARRAY['active_count','active_by_plan'];

  v_wrong   text;
  v_page    jsonb;
  v_item    jsonb;
  v_keys    text[];
  v_checked integer := 0;
BEGIN
  -- 1. The four tables' SELECT policies name no capability, and each still
  --    reads the tenant term. companies is deliberately not in this list.
  SELECT string_agg(p.tablename || '.' || p.policyname || ' (' || coalesce(p.qual, '') || ')', ', '
                    ORDER BY p.tablename) INTO v_wrong
    FROM pg_policies p
   WHERE p.schemaname = 'public'
     AND p.policyname IN ('company_subscriptions_select', 'subscription_invoices_select',
                          'subscription_payment_audit_select', 'subscription_coverage_select')
     AND (coalesce(p.qual, '') ~ 'platform_can\(' OR coalesce(p.qual, '') ~ 'platform_reads_company_data');

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '20260924110000 self-check: a billing SELECT policy still reads a platform capability: %', v_wrong;
  END IF;

  SELECT string_agg(v.name, ', ' ORDER BY v.name) INTO v_wrong
    FROM (VALUES ('company_subscriptions_select'), ('subscription_invoices_select'),
                 ('subscription_payment_audit_select'), ('subscription_coverage_select')) AS v(name)
   WHERE NOT EXISTS (SELECT 1 FROM pg_policies p
                      WHERE p.schemaname = 'public' AND p.policyname = v.name
                        AND coalesce(p.qual, '') ~ 'get_user_company_id\(\)');

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '20260924110000 self-check: a billing SELECT policy is missing or does not read the tenant term: %', v_wrong;
  END IF;

  -- 2. companies keeps its capability branch: that is the half of D14 the owner
  --    chose not to close, and losing it silently would make the panel's home
  --    unreachable rather than audited.
  IF NOT EXISTS (SELECT 1 FROM pg_policies p
                  WHERE p.schemaname = 'public' AND p.tablename = 'companies'
                    AND p.cmd IN ('SELECT', 'ALL')
                    AND coalesce(p.qual, '') ~ 'platform_can\(') THEN
    RAISE EXCEPTION '20260924110000 self-check: companies no longer answers a platform capability — D14 left that read open on purpose';
  END IF;

  -- 3. Both read models are SECURITY DEFINER, VOLATILE (so PostgREST posts and
  --    the audit row can be written), pin a search_path, belong to an owner that
  --    can reach app_private, and are executable by authenticated alone.
  --    generate_invoice_number joins them as a definer, and keeps service_role.
  SELECT string_agg(format('%s (%s)', f.sig, f.problem), '; ') INTO v_wrong
    FROM (
      SELECT v.sig, CASE
               WHEN to_regprocedure(v.sig) IS NULL THEN 'missing'
               WHEN (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure(v.sig)) IS DISTINCT FROM v.definer
                 THEN 'SECURITY DEFINER should be ' || v.definer
               WHEN v.volatile AND (SELECT p.provolatile FROM pg_proc p WHERE p.oid = to_regprocedure(v.sig)) <> 'v'
                 THEN 'must be VOLATILE'
               WHEN NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proconfig) c(setting)
                                 WHERE p.oid = to_regprocedure(v.sig) AND c.setting LIKE 'search_path=%')
                 THEN 'no pinned search_path'
               WHEN v.definer AND NOT EXISTS (
                      SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
                       WHERE p.oid = to_regprocedure(v.sig)
                         AND (r.rolsuper OR r.oid = (SELECT nspowner FROM pg_namespace WHERE nspname = 'app_private')))
                 THEN 'owner can call no app_private helper'
               WHEN has_function_privilege('anon', to_regprocedure(v.sig), 'EXECUTE')
                 THEN 'anon must not hold EXECUTE'
               WHEN has_function_privilege('authenticated', to_regprocedure(v.sig), 'EXECUTE') IS DISTINCT FROM v.authn
                 THEN 'authenticated EXECUTE should be ' || v.authn
               WHEN has_function_privilege('service_role', to_regprocedure(v.sig), 'EXECUTE') IS DISTINCT FROM v.svc
                 THEN 'service_role EXECUTE should be ' || v.svc
             END AS problem
        FROM (VALUES
          -- signature                                                                definer volatile authn  service_role
          ('public.platform_invoices_list(uuid,integer,integer,text,text,integer,integer)', true,  true,  true,  false),
          ('public.platform_subscriptions_list(uuid,text,integer,integer)',                 true,  true,  true,  false),
          ('public.generate_invoice_number(integer)',                                       true,  true,  true,  true),
          ('app_private.platform_invoices_list_statement()',                                false, false, false, false),
          ('app_private.platform_subscriptions_list_statement()',                           false, false, false, false)
        ) AS v(sig, definer, volatile, authn, svc)
    ) f
   WHERE f.problem IS NOT NULL;

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '20260924110000 self-check: %', v_wrong;
  END IF;

  -- 4. Each read model asks a capability the matrix knows, records through
  --    platform_read_record, and runs its own statement. generate_invoice_number
  --    asks the same capability.
  SELECT string_agg(v.fn, ', ') INTO v_wrong
    FROM (VALUES
      ('platform_invoices_list',      'billing.manage'),
      ('platform_subscriptions_list', 'billing.manage')
    ) AS v(fn, capability)
   WHERE NOT EXISTS (SELECT 1 FROM app_private.platform_capability_matrix() m WHERE m.capability = v.capability)
      OR NOT EXISTS (SELECT 1 FROM pg_proc p
                      WHERE p.pronamespace = 'public'::regnamespace
                        AND p.proname = v.fn
                        AND p.prosrc LIKE '%public.platform_can(''' || v.capability || ''')%'
                        AND p.prosrc LIKE '%app_private.platform_read_record(%'
                        AND p.prosrc LIKE '%app_private.' || v.fn || '_statement()%');

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '20260924110000 self-check: a read model does not check, record or run what it should: %', v_wrong;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.pronamespace = 'public'::regnamespace
                    AND p.proname = 'generate_invoice_number'
                    AND p.prosrc LIKE '%public.platform_can(''billing.manage'')%') THEN
    RAISE EXCEPTION '20260924110000 self-check: generate_invoice_number does not ask for billing.manage — it would hand a number to a caller who cannot raise an invoice';
  END IF;

  -- 5. No read model here reads a company's operational data.
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_wrong
    FROM pg_proc p
   WHERE p.pronamespace IN ('public'::regnamespace, 'app_private'::regnamespace)
     AND p.proname ~ '^platform_(invoices|subscriptions)_list(_statement)?$'
     AND p.prosrc ~ '(fahrtenbuch_trips|receipts|salaries|drivers|cars|company_settings)';

  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION '20260924110000 self-check: a billing read model reads tenant data: %', v_wrong;
  END IF;

  -- The columns the invoice list must not carry, whatever a later edit intends.
  -- c.street and c.house_number are on the list because the first draft of this
  -- file read them: they are columns of company_settings, not of companies (see
  -- the header), so naming them here is both a widening and a broken statement.
  IF app_private.platform_invoices_list_statement() ~ '\mi\.(paid_by|collected_by|payment_method|updated_at)\M'
     OR app_private.platform_invoices_list_statement() ~ '\mc\.(email|country|street|house_number)\M' THEN
    RAISE EXCEPTION '20260924110000 self-check: the invoice list reads an account id, a payment method, or a column of companies the screen does not show';
  END IF;

  IF app_private.platform_subscriptions_list_statement() ~ '\ms\.(notes|payment_method|updated_at|ends_at)\M' THEN
    RAISE EXCEPTION '20260924110000 self-check: the subscription list reads more of company_subscriptions than the documented columns';
  END IF;

  -- 6. Both statements plan, run, and answer exactly the documented keys.
  EXECUTE 'EXPLAIN ' || app_private.platform_invoices_list_statement()
    USING NULL::uuid, NULL::integer, NULL::integer, NULL::text, NULL::text, 50, 0;
  EXECUTE 'EXPLAIN ' || app_private.platform_subscriptions_list_statement()
    USING NULL::uuid, NULL::text, 50, 0;

  EXECUTE app_private.platform_invoices_list_statement() INTO v_page
    USING NULL::uuid, NULL::integer, NULL::integer, NULL::text, NULL::text, 100, 0;

  IF v_page IS NULL OR jsonb_typeof(v_page -> 'items') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION '20260924110000 self-check: the invoice list does not answer {total, summary, items}';
  END IF;

  SELECT array_agg(k ORDER BY k) INTO v_keys FROM jsonb_object_keys(v_page -> 'summary') AS k;
  IF NOT (coalesce(v_keys, '{}'::text[]) @> c_invoice_summary AND coalesce(v_keys, '{}'::text[]) <@ c_invoice_summary) THEN
    RAISE EXCEPTION '20260924110000 self-check: the invoice summary carries % instead of the six figures', v_keys;
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(v_page -> 'items') AS t(value) LOOP
    SELECT array_agg(k ORDER BY k) INTO v_keys FROM jsonb_object_keys(v_item) AS k;
    IF NOT (coalesce(v_keys, '{}'::text[]) @> c_invoice_keys AND coalesce(v_keys, '{}'::text[]) <@ c_invoice_keys) THEN
      RAISE EXCEPTION '20260924110000 self-check: an invoice carries % instead of the documented columns', v_keys;
    END IF;
    v_checked := v_checked + 1;
  END LOOP;

  EXECUTE app_private.platform_subscriptions_list_statement() INTO v_page
    USING NULL::uuid, NULL::text, 100, 0;

  IF v_page IS NULL OR jsonb_typeof(v_page -> 'items') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION '20260924110000 self-check: the subscription list does not answer {total, summary, items}';
  END IF;

  SELECT array_agg(k ORDER BY k) INTO v_keys FROM jsonb_object_keys(v_page -> 'summary') AS k;
  IF NOT (coalesce(v_keys, '{}'::text[]) @> c_sub_summary AND coalesce(v_keys, '{}'::text[]) <@ c_sub_summary) THEN
    RAISE EXCEPTION '20260924110000 self-check: the subscription summary carries % instead of the two figures', v_keys;
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(v_page -> 'items') AS t(value) LOOP
    SELECT array_agg(k ORDER BY k) INTO v_keys FROM jsonb_object_keys(v_item) AS k;
    IF NOT (coalesce(v_keys, '{}'::text[]) @> c_sub_keys AND coalesce(v_keys, '{}'::text[]) <@ c_sub_keys) THEN
      RAISE EXCEPTION '20260924110000 self-check: a subscription carries % instead of the documented columns', v_keys;
    END IF;
    v_checked := v_checked + 1;
  END LOOP;

  IF v_checked = 0 THEN
    RAISE NOTICE '20260924110000 self-check: no billing rows here; the item columns are checked by tests/rls/platform-readmodels.sql';
  END IF;

  -- 7. platform_invoice_seller stays on companies.read: it reads the seller
  --    setting, not a billing table, and it is what lets billing and support
  --    build an invoice PDF without holding settings.read.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.pronamespace = 'public'::regnamespace
                    AND p.proname = 'platform_invoice_seller'
                    AND p.prosrc LIKE '%companies.read%') THEN
    RAISE EXCEPTION '20260924110000 self-check: platform_invoice_seller no longer asks for companies.read';
  END IF;

  -- 8. What is left on a capability with no company term, printed rather than
  --    failed. After this file it should be `companies` and the four
  --    codes.manage tables; D14 answered the first deliberately and never
  --    covered the second.
  SELECT string_agg(p.tablename || '.' || p.policyname, ', ' ORDER BY p.tablename, p.policyname) INTO v_wrong
    FROM pg_policies p
   WHERE p.schemaname = 'public'
     AND p.cmd IN ('SELECT', 'ALL')
     AND coalesce(p.qual, '') ~ 'platform_can\(';

  RAISE NOTICE '20260924110000: capability-only cross-tenant SELECT remains on: % (D14 answered 24.09.2026: companies stays, the four billing tables moved)',
    coalesce(v_wrong, 'nothing');
END
$selfcheck$;
