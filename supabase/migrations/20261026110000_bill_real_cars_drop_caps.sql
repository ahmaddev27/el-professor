/*
  Billing, never blocking: the two fleet caps come out, and the invoice is
  quoted on the fleet the company actually runs.

  Docs/design/plan-system.md sections 8 and 9. The owner's rule, stated three
  times and once more on 26.10.2026:

      "الأصل لو وصلت السيارات السقف يتم اضافة السيارة الجديدة والفاتورة تزيد
       والسيارات تزيد"

      A company at its limit adds the car anyway; the invoice goes up and the
      car count goes up.

  ─── Why one migration and not two ────────────────────────────────────────

  `companies.subscription_car_limit` did two jobs at once: it was the cap the
  triggers enforced AND the quantity every invoice charged. Removing the caps
  alone would leave the second job standing on a number nobody has a reason to
  keep accurate any more — the operator's incentive to type it correctly was
  the refusal. Measured on production 26.10.2026, that number is already wrong
  for 16 of 18 companies and wrong in one direction only, always too high:

    company                 plan      billed   active cars
    Customer B              advanced      10             2
    Customer E              premium        5             0
    Customer C              premium        5             4
    Customer H              premium        5             4
    Customer A              premium        5             5
    Customer G              premium        3             3
    (12 others)             —           1–8             0

  So the two halves ship together: the cap goes, and the quantity stops being a
  typed number and becomes a measurement.

  ─── What this is NOT ──────────────────────────────────────────────────────

  It does not write `companies.subscription_car_limit`, now or ever, and it
  stores no car count and no overage. The quote derives the quantity per call
  and keeps nothing. That is the design's §9.2 rule ("the overage is never
  stored", "nothing writes subscription_car_limit automatically") honoured by
  having nothing to write: where the design proposed an operator confirming a
  difference between a stored number and the fleet, there is no longer a
  difference to confirm.

  It does not touch one row of `subscription_invoices`. An invoice already
  issued is a document; `platform_invoice_quotes` only ever proposed what the
  next one would say, and an operator still presses the button that writes it.

  It does not change the formula. `app_private.invoice_amount_cents` and
  `app_private.price_book_price` are untouched, so every one of the 42 numbers
  the four parity gates pin is byte-identical. What moved is the argument.

  ─── Active cars, and why the domain is safe to read ──────────────────────

  The count is `status IS DISTINCT FROM 'inactive'`, which is the predicate the
  two triggers being dropped below counted with. So the billed quantity
  inherits the product's existing notion of a car in service; no new one is
  invented here.

  That predicate is safe because `public.cars.status` is constrained, measured
  on production 26.10.2026 — notwithstanding that the column has no CREATE
  TABLE anywhere in this chain:

    status text NOT NULL DEFAULT 'active'
    CONSTRAINT cars_status_check CHECK (status = ANY (ARRAY['active','inactive']))

  Two values, never NULL. All 18 production cars are 'active', so counting all
  cars and counting active cars give the same answer today; the predicate only
  starts to matter the first time a car is deactivated, and then a car out of
  service must not be billed.

  `IS DISTINCT FROM 'inactive'` rather than `= 'active'` is deliberate and is
  the conservative direction: if that CHECK is ever widened, a status this file
  has not heard of counts as billable rather than silently free. An unbilled car
  is money lost quietly; an over-billed one is a customer complaint, which is
  the failure that gets noticed and corrected.

  ─── The floor ────────────────────────────────────────────────────────────

  Unchanged, and it lives where it already lived: `greatest(coalesce(cars,1),1)`
  inside `app_private.price_book_price`, which is the single SQL site. A company
  with no cars is quoted one car, not 0,00 €. Twelve companies have no cars, so
  this is not hypothetical: Customer E goes from 350,00 € to 70,00 €, not to zero.
  This is NOT the 200 € minimum the owner rejected ("فش ارضيات، التسعير على
  الخطط التزم فيه") — that was a floor under the whole invoice; this is a guard
  against a zero quantity. The TypeScript twin gains the same guard in one named
  place in the same commit (src/utils/pricing.ts, `billedCars`), because it was
  missing from `calcPricing` and no gate caught it.

  ─── The two triggers ─────────────────────────────────────────────────────

  Both read live from the production catalogue on 26.10.2026, both tgenabled
  'O', both BEFORE INSERT OR UPDATE FOR EACH ROW:

    trg_enforce_car_limit    on public.cars    -> public.enforce_car_limit()
    trg_enforce_driver_limit on public.drivers -> public.enforce_driver_limit()

  `enforce_car_limit` compares active cars against
  `companies.subscription_car_limit`. `enforce_driver_limit` compares active
  drivers against that column times `company_settings.drivers_per_car_limit`
  (not `subscription_plans.drivers_per_car_limit`, which feeds nothing).

  Both functions are dropped with their triggers. The catalogue sweep for a
  function whose body names either returned zero rows, so nothing else calls
  them; self-check 1 re-states that from the catalogue rather than trusting the
  sweep.

  ONE CONSUMER THAT NO SWEEP CAN FIND, and it is the thing to remember from
  this file. `public.partner_drivers_import` and `public.partner_vehicles_import`
  (20261015110000) and `public.partner_earners_resolve` (20261016110000) do not
  CALL either trigger — they CATCH it, by the German text of its message:

      EXCEPTION WHEN SQLSTATE 'P0001' THEN
        IF SQLERRM LIKE 'Fahrerlimit%'   THEN v_reason := 'limit_reached';
        IF SQLERRM LIKE 'Fahrzeuglimit%' THEN v_reason := 'limit_reached';

  so the partner fleet import turned a cap into a per-row outcome. A dependency
  on a sentence is invisible to `prosrc LIKE '%enforce_car_limit%'`, to the
  design document's sweep for `subscription_plans`, and to self-check 1 of this
  file — all three ran and all three said nothing reads the triggers. What found
  it was `tests/rls/partner-fleet-import.sql`, whose probes 24, 26 and 35 moved.
  The RLS kit was the only gate that could have.

  The consequence is the owner's rule applied to the partner path: a partner's
  driver or vehicle that used to come back `limit_reached` is now created. Probe
  35 is the one worth reading — the cap was a BEFORE trigger and so spoke ahead
  of `cars_kennzeichen_key`, which means a plate another company already held
  was reported as a limit; with the cap gone the unique index speaks first and
  the row says `plate_unavailable`, which is what is actually wrong with it.

  `limit_reached` therefore becomes unreachable in three RPCs. The branches are
  left in place on purpose — they still re-raise every other P0001, and removing
  them would turn a future per-row refusal into a whole-batch failure — and the
  fact is recorded at each site. Retiring the reason code and its two dictionary
  entries is a follow-up.

  Two companies could not add a car before this file: Customer A (5
  active of 5) and Customer G (3 of 3). Their next INSERT raised P0001
  with a German sentence no screen explained — `DriversManagement.tsx` has
  carried a comment since 21.10.2026 saying the driver cap "lived ONLY here, in
  the browser: no policy, trigger or constraint enforced it", which was false
  the day it was written. That comment is corrected in the same commit.

  No column is dropped, so no SCHEMA_EPOCH bump: reverting is re-creating two
  triggers and restating one function body.

  `companies.subscription_car_limit` and `company_settings.drivers_per_car_limit`
  both SURVIVE this file, deliberately, and the reasoning is in the PR and in
  Docs/design/plan-system.md §8 and §12 question 6. The short form: the first is
  still what `platform_subscription_assign` records as the allowance of the plan
  an operator assigned, and dropping it is nine functions, two screens, eight
  kit files and an epoch bump — the design's slice 7, not this one. The second
  is an open question for the owner. What does change in this commit is every
  place a screen presented either of them as an enforced limit.
*/

-- ─── 1. The caps come out ───────────────────────────────────────────────────

DROP TRIGGER IF EXISTS trg_enforce_car_limit    ON public.cars;
DROP TRIGGER IF EXISTS trg_enforce_driver_limit ON public.drivers;

-- Plain DROP, not IF EXISTS with CASCADE: if anything did depend on these,
-- this release should fail here rather than silently take the dependent with
-- it. The catalogue says nothing does.
DROP FUNCTION IF EXISTS public.enforce_car_limit();
DROP FUNCTION IF EXISTS public.enforce_driver_limit();

-- ─── 2. The quote prices the fleet ──────────────────────────────────────────

/*
  20261015160000's body with the car count changed from a column to a count,
  and one field added. Everything else — the argument contract, the capability,
  the price-book guard, the audit row, the first-invoice rule, the ordering —
  is carried over unchanged.

  `car_limit` stays in the item and still carries `companies.subscription_car_limit`.
  It is no longer what the amount was computed from, and `active_cars` beside it
  is. Keeping both is the design's own rule (§9.3: "the quote will carry
  active_cars and billed_cars both, so the information is on the screen either
  way") — an operator looking at a stale allowance beside a live fleet can see
  that it is stale, which is exactly what nobody could see before.

  The count is ONE grouped query over `cars`, joined once, never a per-company
  subquery — the read-model rule of 20260916140000.
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
           -- The stored allowance. Informational since this file: it prices
           -- nothing and caps nothing.
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

-- ─── 3. Ownership and privileges, restated ──────────────────────────────────

-- CREATE OR REPLACE keeps the owner and the ACL, so these only re-assert what
-- 20261015160000 set. They are here because a restatement that silently lost
-- the owner would leave the function unable to reach app_private at all.
ALTER FUNCTION public.platform_invoice_quotes(integer, integer) OWNER TO CURRENT_USER;

REVOKE ALL ON FUNCTION public.platform_invoice_quotes(integer, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.platform_invoice_quotes(integer, integer) TO authenticated;

COMMENT ON FUNCTION public.platform_invoice_quotes(integer, integer) IS
  'For every active subscription: whether the invoice for this period is the company''s first, the fleet it runs, and what the invoice costs. Priced from the company''s count of cars not deactivated, never from companies.subscription_car_limit, which the item still carries as the plan allowance. One audited read row per call; billing.manage.';

-- ─── 4. Self-checks ─────────────────────────────────────────────────────────

DO $$
DECLARE
  v_left text;
  -- The production book as of 26.10.2026, inlined so self-check 7 measures the
  -- arithmetic and not whatever an operator has since saved.
  c_book CONSTANT jsonb :=
    '{"price_per_car_cents": {"basic": 2000, "advanced": 4000, "premium": 7000},
       "fleet_discount_tiers": [{"min_cars": 6, "percent": 5}, {"min_cars": 11, "percent": 10}],
       "yearly_discount_percent": 10, "first_month_cents": 20000}'::jsonb;
BEGIN
  -- 1. Both triggers and both functions are gone, and nothing was left behind
  --    that still names them. The second half is what catches a dependent this
  --    file did not know about: a surviving body naming a dropped function
  --    fails at call time with 42883, which is a defect discovered by a
  --    customer rather than by a release.
  SELECT string_agg(x.what, ', ') INTO v_left
    FROM (
      SELECT 'trigger ' || t.tgname AS what
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE NOT t.tgisinternal AND n.nspname = 'public'
         AND t.tgname IN ('trg_enforce_car_limit', 'trg_enforce_driver_limit')
      UNION ALL
      SELECT 'function ' || p.oid::regprocedure::text
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname IN ('public', 'app_private')
         AND p.proname IN ('enforce_car_limit', 'enforce_driver_limit')
      UNION ALL
      SELECT 'caller ' || p.oid::regprocedure::text
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname IN ('public', 'app_private')
         AND (p.prosrc LIKE '%enforce_car_limit%' OR p.prosrc LIKE '%enforce_driver_limit%')
      UNION ALL
      SELECT 'policy ' || pol.polname || ' on ' || pol.polrelid::regclass::text
        FROM pg_policy pol
       WHERE pg_get_expr(pol.polqual, pol.polrelid) LIKE '%enforce_car_limit%'
          OR pg_get_expr(pol.polwithcheck, pol.polrelid) LIKE '%enforce_driver_limit%'
          OR pg_get_expr(pol.polqual, pol.polrelid) LIKE '%enforce_driver_limit%'
          OR pg_get_expr(pol.polwithcheck, pol.polrelid) LIKE '%enforce_car_limit%'
    ) x;

  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION '20261026110000 self-check 1: the caps are not gone — %', v_left;
  END IF;

  -- 2. `cars` keeps the triggers that are NOT this file's business. Dropping a
  --    trigger by name is a precise act and this proves it was precise: the
  --    support-session pair must survive, or tenant writes stop being audited
  --    and tests/rls/support-write-audit.sql section 1 would be the only thing
  --    left to notice.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                  WHERE c.relname = 'cars' AND t.tgname = 'refuse_read_only_context_write')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                     WHERE c.relname = 'cars' AND t.tgname = 'record_support_write')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                     WHERE c.relname = 'drivers' AND t.tgname = 'refuse_read_only_context_write')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                     WHERE c.relname = 'drivers' AND t.tgname = 'record_support_write') THEN
    RAISE EXCEPTION '20261026110000 self-check 2: a support-session trigger on cars or drivers went with the caps';
  END IF;

  -- 3. The quote prices from the fleet and from nothing else. Each fragment is
  --    load-bearing: the grouped count, the count predicate, and the amount
  --    taking `q.active_cars` rather than `q.car_limit`. A restatement that
  --    reverted the argument would otherwise pass every other check in this
  --    file and quietly bill the typed number again.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = 'public.platform_invoice_quotes(integer,integer)'::regprocedure
                    AND p.prosrc LIKE '%FROM public.cars%'
                    AND p.prosrc LIKE '%status IS DISTINCT FROM ''inactive''%'
                    AND p.prosrc LIKE '%GROUP BY company_id%'
                    AND p.prosrc LIKE '%invoice_amount_cents(v_book, q.plan, q.active_cars, q.billing_cycle, q.first_invoice)%') THEN
    RAISE EXCEPTION '20261026110000 self-check 3: platform_invoice_quotes does not price the company''s fleet';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_proc p
              WHERE p.oid = 'public.platform_invoice_quotes(integer,integer)'::regprocedure
                AND p.prosrc LIKE '%invoice_amount_cents(v_book, q.plan, q.car_limit%') THEN
    RAISE EXCEPTION '20261026110000 self-check 3b: platform_invoice_quotes still prices the stored allowance';
  END IF;

  -- 4. Everything 20261015160000 asserted about this function still holds. Its
  --    own self-check ran once and will never run again (app_meta.schema_migrations),
  --    so a restatement inherits none of it and has to re-state it.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = 'public.platform_invoice_quotes(integer,integer)'::regprocedure
                    AND p.provolatile = 'v'
                    AND p.prosecdef
                    AND array_to_string(p.proconfig, E'\n') LIKE '%search_path=pg_catalog, public%'
                    AND p.prosrc LIKE '%public.platform_can(''billing.manage'')%'
                    AND p.prosrc LIKE '%app_private.platform_read_record(%'
                    AND p.prosrc LIKE '%ERRCODE = ''22023''%') THEN
    RAISE EXCEPTION '20261026110000 self-check 4: platform_invoice_quotes lost its contract, capability, audit row or pinned search_path';
  END IF;

  IF has_function_privilege('anon', 'public.platform_invoice_quotes(integer,integer)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.platform_invoice_quotes(integer,integer)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.platform_invoice_quotes(integer,integer)', 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                 WHERE p.oid = 'public.platform_invoice_quotes(integer,integer)'::regprocedure
                   AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
    RAISE EXCEPTION '20261026110000 self-check 5: platform_invoice_quotes is granted to the wrong roles';
  END IF;

  -- 6. The floor is still in app_private.price_book_price, which is the ONE
  --    SQL site for it, and the tier is still looked up on the UNFLOORED count.
  --    That asymmetry is the whole of it: a zero-car company is billed one car
  --    but does not thereby qualify for a fleet tier. src/utils/pricing.ts's
  --    `billedCars` is the twin, and it is the half that was missing.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = 'app_private.price_book_price(jsonb,text,integer,text,boolean)'::regprocedure
                    AND p.prosrc LIKE '%v_billed_cars integer := greatest(coalesce(p_car_limit, 1), 1)%'
                    AND p.prosrc LIKE '%v_tier_cars   integer := coalesce(p_car_limit, 1)%'
                    AND p.prosrc LIKE '%v_billed_cars%*%trim_scale(v_cents * 0.01)%') THEN
    RAISE EXCEPTION '20261026110000 self-check 6: the floor or the unfloored tier lookup left app_private.price_book_price';
  END IF;

  -- 6b. And no second SQL site grew one. The floor being in two places is how
  --     calcPricing came apart from it in the first place.
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_left
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('public', 'app_private')
     AND p.prosrc LIKE '%greatest(coalesce(p_car_limit, 1), 1)%'
     AND p.oid <> 'app_private.price_book_price(jsonb,text,integer,text,boolean)'::regprocedure;
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION '20261026110000 self-check 6b: a second SQL site floors the car count — %', v_left;
  END IF;

  -- 7. The quantity moved; the arithmetic did not. Six combinations against the
  --    book above, so a release where the car count argument stopped reaching
  --    the multiplication fails here rather than on an invoice: 70,00 at one
  --    car and at zero cars (the floor), 280,00 at four, 350,00 at five,
  --    80,00 for two cars on advanced, 252,00 for a yearly twelfth at four,
  --    and the first invoice flat at 200,00 whatever the fleet.
  IF app_private.invoice_amount_cents(c_book, 'premium',  1, 'monthly', false) IS DISTINCT FROM 7000
     OR app_private.invoice_amount_cents(c_book, 'premium',  0, 'monthly', false) IS DISTINCT FROM 7000
     OR app_private.invoice_amount_cents(c_book, 'premium',  4, 'monthly', false) IS DISTINCT FROM 28000
     OR app_private.invoice_amount_cents(c_book, 'premium',  5, 'monthly', false) IS DISTINCT FROM 35000
     OR app_private.invoice_amount_cents(c_book, 'advanced', 2, 'monthly', false) IS DISTINCT FROM 8000
     OR app_private.invoice_amount_cents(c_book, 'premium',  4, 'yearly',  false) IS DISTINCT FROM 25200
     OR app_private.invoice_amount_cents(c_book, 'premium',  1, 'monthly', true)  IS DISTINCT FROM 20000 THEN
    RAISE EXCEPTION '20261026110000 self-check 7: the amount no longer follows the car count';
  END IF;
END;
$$;
