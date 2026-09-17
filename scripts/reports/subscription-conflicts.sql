/*
  # Where the subscription models disagree (plan 3.F, step U0)

  Read-only. Lists every company whose subscription state is contradicted by
  another source, one result per conflict class. Step U1 replaces the four
  models below with one (`company_subscriptions` + `subscription_coverage`,
  written only by `recompute_company_subscription`) and refuses to migrate if
  any company's access would change; each class here is a case where "today's
  access" has more than one answer, so the owner has to pick the rule first.

  ## Run it

      docker exec -i -e PGOPTIONS='-c default_transaction_read_only=on' <db container> \
        psql -X -v ON_ERROR_STOP=1 -U supabase_admin -d postgres < scripts/reports/subscription-conflicts.sql

  Everything runs inside BEGIN READ ONLY ... ROLLBACK. With the psql variable
  `subscription_conflicts_nested` set, it runs inside the caller's transaction
  instead, in a read-only savepoint that is rolled back; that is how
  subscription-conflicts.test.sql seeds conflicts and still proves the report
  never writes.

  ## Output

  Every class prints `conflict | n | company_id | ref_id | evidence`, one row
  per finding, or a single row with n = 0. `ref_id` names the invoice, code or
  subscription row the finding is about. `evidence` carries plan, status, date
  and flag values only: no names, e-mail addresses, people or money amounts
  (a price difference is flagged, never printed). Classes overlap on purpose:
  one company can show up under several.

  ## The four models, and who reads or writes them (15.09.2026)

  1. companies.status (active | trial | suspended | inactive), trial_start,
     trial_end, plan, billing_cycle, subscription_car_limit.
     Written by signup_create_company (status trial, trial 14 days),
     CompaniesPage (create, edit, suspend, reactivate; its archive and delete
     write 'archived' / 'deleted', which the CHECK constraint rejects),
     SuperAdminDashboard (status, plan, cycle, car limit, trial_end + 7 days),
     AssignSubscriptionModal (car limit := plan.included_cars).
     Read by AuthContext.checkProfileAccess (sign-in refused for suspended and
     inactive), PlanContext (PlanGate), compute_plan_price and
     redeem_discount_code, the enforce_car_limit / enforce_driver_limit
     triggers, SuperAdminDashboard, CompaniesPage.

  2. companies.approval_status (pending | approved | rejected | suspended).
     Written by signup_create_company (pending) and SuperAdminDashboard
     (approve, reject, suspend). Read by AuthContext and App.tsx gate 3; the
     SubscriptionGuard only applies to approved companies.

  3. companies.subscription_status (inactive | active | expired | suspended),
     subscription_started_at, subscription_expires_at,
     subscription_duration_type, last_activation_code_id, plus
     activation_codes.applied_subscription_started_at / _expires_at.
     Written by redeem_activation_code (ActivationPage, extends from the
     current expiry), update_company_subscription_manual (ManualSubscriptionModal,
     audited in subscription_admin_actions), signup_create_company (inactive),
     the generate-activation-code function (codes) and migration
     20260621024101, which set every company then existing to active with no
     expiry. Read by AuthContext.isSubscriptionActive -> SubscriptionGuard
     (App.tsx gate 5), CompanyBillingPage, ActivationPage,
     ActivationCodesManagement, SuperAdminDashboard.

  4. subscription_plans, company_subscriptions (active | paused | canceled |
     overdue, starts_at, ends_at), subscription_invoices (open | paid |
     overdue | canceled, due_date, paid_at), subscription_payment_audit.
     Written by PlanManagementModal, AssignSubscriptionModal (inserts a row and
     never ends the previous one), GenerateInvoicesModal (every row whose
     status is active, without a date check), MarkPaidModal,
     SubscriptionBillingPage (mark unpaid; cancel keeps paid_at),
     generate_invoice_number. Read by SubscriptionBillingPage and
     InvoiceDetailModal only. No gate reads this model: paying an invoice
     grants nothing, and nothing ever writes the statuses paused or overdue.

  Nothing runs on a clock. No job moves subscription_status to expired or a
  company off trial; the browser derives both, and its two gates derive them
  from different columns:

    subscription gate   subscription_status = 'active'
                        AND (subscription_expires_at IS NULL OR > now())
                        (AuthContext.isSubscriptionActive)
    plan gate           status = 'active' OR (status = 'trial' AND trial_end > now())
                        (PlanContext buildPlanState, isActive)

  A company reaches its screens only when both allow it.

  ## Conventions

  "Today" and invoice months are Europe/Berlin. company_subscriptions.ends_at
  is the last day of the term, inclusive. A current subscription row is one
  that is not canceled and whose term includes today. The CTEs are written to
  be lifted into U1's migration check unchanged.
*/

\set ON_ERROR_STOP on

\if :{?subscription_conflicts_nested}
SAVEPOINT subscription_conflicts;
SET TRANSACTION READ ONLY;
\else
BEGIN READ ONLY;
\endif

-- The wrapper above is the promise that this file never writes; refuse to go
-- on if an edit ever loses it.
DO $$
BEGIN
  IF current_setting('transaction_read_only') <> 'on' THEN
    RAISE EXCEPTION 'subscription-conflicts: refusing to run outside a read-only transaction';
  END IF;
END $$;

PREPARE subscription_conflicts(text) AS
WITH
clock AS (
  SELECT now() AS at, (now() AT TIME ZONE 'Europe/Berlin')::date AS today
),

company AS (
  SELECT c.id AS company_id,
         c.status, c.approval_status, c.plan, c.billing_cycle, c.subscription_car_limit,
         c.subscription_status, c.subscription_started_at, c.subscription_expires_at,
         c.subscription_duration_type, c.last_activation_code_id,
         c.trial_start, c.trial_end,
         c.active_discount_code_id IS NOT NULL AS has_discount,
         (c.subscription_status = 'active'
          AND (c.subscription_expires_at IS NULL OR c.subscription_expires_at > k.at)) AS subscription_gate,
         (c.status = 'active'
          OR (c.status = 'trial' AND COALESCE(c.trial_end > k.at, false)))          AS plan_gate,
         'suspended' IN (c.status, c.approval_status, c.subscription_status)         AS any_suspended
    FROM companies c
   CROSS JOIN clock k
),

invoice AS (
  SELECT i.id AS invoice_id, i.company_id, i.subscription_id, i.invoice_year, i.invoice_month,
         i.status, i.due_date, i.paid_at,
         m.first_day,
         (m.first_day + interval '1 month')::date                      AS next_first_day,
         m.first_day::timestamp AT TIME ZONE 'Europe/Berlin'           AS period_start,
         (m.first_day + interval '1 month') AT TIME ZONE 'Europe/Berlin' AS period_end
    FROM subscription_invoices i
   CROSS JOIN LATERAL (SELECT make_date(i.invoice_year, i.invoice_month, 1) AS first_day) m
),

current_subscription AS (
  SELECT s.id AS subscription_id, s.company_id, s.plan_id, s.status, s.starts_at, s.ends_at,
         s.monthly_price
    FROM company_subscriptions s
   CROSS JOIN clock k
   WHERE s.status <> 'canceled'
     AND s.starts_at <= k.today
     AND (s.ends_at IS NULL OR s.ends_at >= k.today)
),

redemption AS (
  SELECT a.id AS code_id, a.used_company_id AS company_id, a.company_id AS issued_for_company_id,
         a.applied_subscription_started_at AS period_start,
         a.applied_subscription_expires_at AS period_end
    FROM activation_codes a
   WHERE a.status = 'used' AND a.used_company_id IS NOT NULL
),

-- Everything apart from companies.subscription_* that says a company holds a
-- subscription right now.
access_source AS (
  SELECT i.company_id, 'paid_invoice' AS source
    FROM invoice i CROSS JOIN clock k
   WHERE i.status = 'paid' AND i.period_start <= k.at AND k.at < i.period_end
  UNION
  SELECT r.company_id, 'activation_code'
    FROM redemption r CROSS JOIN clock k
   WHERE r.period_start <= k.at AND k.at < r.period_end
  UNION
  SELECT s.company_id, 'active_subscription_row'
    FROM current_subscription s
   WHERE s.status = 'active'
),
access_sources AS (
  SELECT company_id, array_agg(source ORDER BY source) AS sources
    FROM access_source
   GROUP BY company_id
),

-- The periods the access model recorded: the company's own dates (open-ended
-- for an active subscription without expiry) and each redemption.
recorded_period AS (
  SELECT c.company_id,
         COALESCE(c.subscription_started_at, '-infinity') AS period_start,
         COALESCE(c.subscription_expires_at, 'infinity')  AS period_end
    FROM company c
   WHERE c.subscription_expires_at IS NOT NULL OR c.subscription_status = 'active'
  UNION ALL
  SELECT r.company_id, r.period_start, r.period_end
    FROM redemption r
   WHERE r.period_start IS NOT NULL AND r.period_end IS NOT NULL
),

-- subscription_plans.name is free text; the tier is read from the words the
-- app itself uses, and a name without one is reported as unmapped.
subscription_terms AS (
  SELECT s.subscription_id, s.company_id, s.plan_id, s.status, s.starts_at, s.ends_at,
         s.monthly_price, p.included_cars,
         CASE WHEN p.name ~* '\mpremium\M'  THEN 'premium'
              WHEN p.name ~* '\madvanced\M' THEN 'advanced'
              WHEN p.name ~* '\mbasic\M'    THEN 'basic' END AS plan_tier
    FROM current_subscription s
    JOIN subscription_plans p ON p.id = s.plan_id
),

c01 AS (
  SELECT '01_plan_unknown' AS conflict, c.company_id, NULL::uuid AS ref_id,
         jsonb_build_object('plan', c.plan, 'status', c.status,
                            'subscription_status', c.subscription_status) AS evidence
    FROM company c
   WHERE c.plan NOT IN ('basic', 'advanced', 'premium')
),

c02 AS (
  SELECT '02_terms_differ_from_current_subscription' AS conflict, t.company_id, t.subscription_id AS ref_id,
         jsonb_build_object('differs', d.differs,
                            'companies_plan', c.plan,
                            'subscription_plan_id', t.plan_id,
                            'subscription_plan_tier', t.plan_tier,
                            'companies_car_limit', c.subscription_car_limit,
                            'plan_included_cars', t.included_cars,
                            'companies_billing_cycle', c.billing_cycle,
                            'has_discount', c.has_discount,
                            'subscription_row_status', t.status,
                            'starts_at', t.starts_at, 'ends_at', t.ends_at) AS evidence
    FROM subscription_terms t
    JOIN company c USING (company_id)
   CROSS JOIN LATERAL (
     SELECT array_remove(ARRAY[
              CASE WHEN t.plan_tier IS NULL THEN 'plan_unmapped'
                   WHEN t.plan_tier <> c.plan THEN 'plan' END,
              CASE WHEN t.included_cars <> c.subscription_car_limit THEN 'car_limit' END,
              -- the row carries a monthly price and is invoiced every month
              CASE WHEN c.billing_cycle <> 'monthly' THEN 'billing_cycle' END,
              CASE WHEN t.monthly_price
                        <> compute_plan_price(c.plan, c.subscription_car_limit, 'monthly') THEN 'price' END
            ], NULL) AS differs
   ) d
   WHERE cardinality(d.differs) > 0
),

c03 AS (
  SELECT '03_multiple_current_subscriptions' AS conflict, s.company_id, NULL::uuid AS ref_id,
         jsonb_build_object('rows', jsonb_agg(jsonb_build_object(
                              'subscription_id', s.subscription_id, 'plan_id', s.plan_id,
                              'status', s.status, 'starts_at', s.starts_at, 'ends_at', s.ends_at)
                            ORDER BY s.starts_at, s.subscription_id)) AS evidence
    FROM current_subscription s
   GROUP BY s.company_id
  HAVING count(*) > 1
),

c04 AS (
  SELECT '04_active_without_expiry' AS conflict, c.company_id, NULL::uuid AS ref_id,
         jsonb_build_object('subscription_status', c.subscription_status,
                            'subscription_started_at', c.subscription_started_at,
                            'subscription_duration_type', c.subscription_duration_type,
                            'status', c.status, 'approval_status', c.approval_status,
                            'plan', c.plan) AS evidence
    FROM company c
   WHERE c.subscription_status = 'active' AND c.subscription_expires_at IS NULL
),

c05 AS (
  SELECT '05_active_past_expiry' AS conflict, c.company_id, NULL::uuid AS ref_id,
         jsonb_build_object('subscription_status', c.subscription_status,
                            'subscription_started_at', c.subscription_started_at,
                            'subscription_expires_at', c.subscription_expires_at,
                            'status', c.status, 'approval_status', c.approval_status) AS evidence
    FROM company c
   CROSS JOIN clock k
   WHERE c.subscription_status = 'active' AND c.subscription_expires_at <= k.at
),

c06 AS (
  SELECT '06_access_blocked_but_covered' AS conflict, c.company_id, NULL::uuid AS ref_id,
         jsonb_build_object('covered_by', d.covered_by,
                            'subscription_status', c.subscription_status,
                            'subscription_expires_at', c.subscription_expires_at,
                            'status', c.status, 'approval_status', c.approval_status) AS evidence
    FROM company c
   CROSS JOIN clock k
    LEFT JOIN access_sources a USING (company_id)
   CROSS JOIN LATERAL (
     SELECT (CASE WHEN c.subscription_status IN ('inactive', 'expired')
                   AND c.subscription_expires_at > k.at
                  THEN ARRAY['expiry_in_future'] ELSE '{}' END)
            || COALESCE(a.sources, '{}') AS covered_by
   ) d
   WHERE NOT c.subscription_gate
     AND c.subscription_status <> 'suspended'
     AND cardinality(d.covered_by) > 0
),

c07 AS (
  SELECT '07_paid_invoice_without_period' AS conflict, i.company_id, i.invoice_id AS ref_id,
         jsonb_build_object('invoice_year', i.invoice_year, 'invoice_month', i.invoice_month,
                            'paid_at', i.paid_at,
                            'subscription_status', c.subscription_status,
                            'subscription_started_at', c.subscription_started_at,
                            'subscription_expires_at', c.subscription_expires_at) AS evidence
    FROM invoice i
    JOIN company c USING (company_id)
   WHERE i.status = 'paid'
     AND NOT EXISTS (SELECT 1
                       FROM recorded_period p
                      WHERE p.company_id = i.company_id
                        AND p.period_start < i.period_end
                        AND i.period_start < p.period_end)
),

c08 AS (
  SELECT '08_invoice_links_inconsistent' AS conflict, i.company_id, i.invoice_id AS ref_id,
         jsonb_build_object('reasons', d.reasons,
                            'invoice_year', i.invoice_year, 'invoice_month', i.invoice_month,
                            'invoice_status', i.status, 'paid_at', i.paid_at,
                            'subscription_id', i.subscription_id,
                            'subscription_company_id', s.company_id,
                            'subscription_row_status', s.status,
                            'starts_at', s.starts_at, 'ends_at', s.ends_at) AS evidence
    FROM invoice i
    JOIN company_subscriptions s ON s.id = i.subscription_id
   CROSS JOIN LATERAL (
     SELECT array_remove(ARRAY[
              CASE WHEN s.company_id <> i.company_id THEN 'subscription_of_other_company' END,
              CASE WHEN i.next_first_day <= s.starts_at OR i.first_day > s.ends_at
                   THEN 'outside_subscription_term' END,
              CASE WHEN i.status = 'paid' AND i.paid_at IS NULL THEN 'paid_without_paid_at' END,
              CASE WHEN i.status <> 'paid' AND i.paid_at IS NOT NULL THEN 'paid_at_but_not_paid' END
            ], NULL) AS reasons
   ) d
   WHERE cardinality(d.reasons) > 0
),

c09 AS (
  SELECT '09_past_due_while_access_active' AS conflict, i.company_id, i.invoice_id AS ref_id,
         jsonb_build_object('source', 'invoice',
                            'invoice_year', i.invoice_year, 'invoice_month', i.invoice_month,
                            'invoice_status', i.status, 'due_date', i.due_date,
                            'subscription_status', c.subscription_status,
                            'subscription_expires_at', c.subscription_expires_at) AS evidence
    FROM invoice i
    JOIN company c USING (company_id)
   CROSS JOIN clock k
   WHERE i.status IN ('open', 'overdue') AND i.due_date < k.today AND c.subscription_gate
  UNION ALL
  SELECT '09_past_due_while_access_active', s.company_id, s.subscription_id,
         jsonb_build_object('source', 'subscription_row',
                            'subscription_row_status', s.status,
                            'starts_at', s.starts_at, 'ends_at', s.ends_at,
                            'subscription_status', c.subscription_status,
                            'subscription_expires_at', c.subscription_expires_at)
    FROM current_subscription s
    JOIN company c USING (company_id)
   WHERE s.status = 'overdue' AND c.subscription_gate
),

c10 AS (
  SELECT '10_redemption_without_effect' AS conflict, r.company_id, r.code_id AS ref_id,
         jsonb_build_object('reasons', d.reasons,
                            'applied_started_at', r.period_start,
                            'applied_expires_at', r.period_end,
                            'issued_for_company_id', r.issued_for_company_id,
                            'subscription_status', c.subscription_status,
                            'subscription_expires_at', c.subscription_expires_at,
                            'last_activation_code_id', c.last_activation_code_id) AS evidence
    FROM redemption r
    JOIN company c USING (company_id)
   CROSS JOIN LATERAL (
     SELECT array_remove(ARRAY[
              CASE WHEN r.period_start IS NULL OR r.period_end IS NULL THEN 'period_unknown' END,
              CASE WHEN r.issued_for_company_id <> r.company_id THEN 'redeemed_by_other_company' END,
              -- the company now ends earlier than this code granted, unless it
              -- is an open-ended legacy subscription
              CASE WHEN r.period_end > COALESCE(c.subscription_expires_at, '-infinity')
                    AND NOT (c.subscription_status = 'active' AND c.subscription_expires_at IS NULL)
                   THEN 'shortened' END
            ], NULL) AS reasons
   ) d
   WHERE cardinality(d.reasons) > 0
  UNION ALL
  SELECT '10_redemption_without_effect', c.company_id, c.last_activation_code_id,
         jsonb_build_object('reasons', ARRAY['last_code_not_redeemed_here'],
                            'subscription_status', c.subscription_status,
                            'subscription_expires_at', c.subscription_expires_at,
                            'last_activation_code_id', c.last_activation_code_id)
    FROM company c
   WHERE c.last_activation_code_id IS NOT NULL
     AND NOT EXISTS (SELECT 1
                       FROM redemption r
                      WHERE r.code_id = c.last_activation_code_id
                        AND r.company_id = c.company_id)
),

c11 AS (
  SELECT '11_trial_flags_inconsistent' AS conflict, c.company_id, NULL::uuid AS ref_id,
         jsonb_build_object('reasons', d.reasons,
                            'status', c.status, 'plan', c.plan,
                            'trial_start', c.trial_start, 'trial_end', c.trial_end,
                            'subscription_status', c.subscription_status,
                            'subscription_expires_at', c.subscription_expires_at) AS evidence
    FROM company c
   CROSS JOIN clock k
   CROSS JOIN LATERAL (
     SELECT array_remove(ARRAY[
              CASE WHEN c.status = 'trial' AND c.trial_end IS NULL THEN 'trial_status_without_end' END,
              CASE WHEN c.status = 'trial' AND c.trial_end <= k.at THEN 'trial_status_after_end' END,
              -- PlanContext grants premium while trial_end is ahead, whatever the status
              CASE WHEN c.status <> 'trial' AND c.trial_end > k.at THEN 'trial_running_status_not_trial' END,
              CASE WHEN (c.trial_start IS NULL) <> (c.trial_end IS NULL) OR c.trial_start > c.trial_end
                   THEN 'trial_dates_out_of_order' END
            ], NULL) AS reasons
   ) d
   WHERE cardinality(d.reasons) > 0
),

-- Only where both gates are consulted: an approved company that may sign in.
c12 AS (
  SELECT '12_gates_disagree' AS conflict, c.company_id, NULL::uuid AS ref_id,
         jsonb_build_object('subscription_gate', CASE WHEN c.subscription_gate THEN 'allow' ELSE 'block' END,
                            'plan_gate',         CASE WHEN c.plan_gate THEN 'allow' ELSE 'block' END,
                            'status', c.status, 'trial_end', c.trial_end,
                            'subscription_status', c.subscription_status,
                            'subscription_expires_at', c.subscription_expires_at) AS evidence
    FROM company c
   WHERE c.approval_status = 'approved'
     AND c.status IN ('active', 'trial')
     AND c.subscription_gate <> c.plan_gate
),

c13 AS (
  SELECT '13_suspension_flags_disagree' AS conflict, c.company_id, NULL::uuid AS ref_id,
         jsonb_build_object('status', c.status, 'approval_status', c.approval_status,
                            'subscription_status', c.subscription_status) AS evidence
    FROM company c
   WHERE c.any_suspended
     AND NOT (c.status = 'suspended'
              AND c.approval_status = 'suspended'
              AND c.subscription_status = 'suspended')
),

c14 AS (
  SELECT '14_suspended_with_active_subscription' AS conflict, c.company_id, NULL::uuid AS ref_id,
         jsonb_build_object('active_by', d.active_by,
                            'status', c.status, 'approval_status', c.approval_status,
                            'subscription_status', c.subscription_status,
                            'subscription_expires_at', c.subscription_expires_at) AS evidence
    FROM company c
    LEFT JOIN access_sources a USING (company_id)
   CROSS JOIN LATERAL (
     SELECT (CASE WHEN c.subscription_gate THEN ARRAY['subscription_status'] ELSE '{}' END)
            || COALESCE(a.sources, '{}') AS active_by
   ) d
   WHERE c.any_suspended
     AND cardinality(d.active_by) > 0
),

c15 AS (
  SELECT '15_periods_out_of_order' AS conflict, c.company_id, NULL::uuid AS ref_id,
         jsonb_build_object('source', 'companies',
                            'starts', c.subscription_started_at,
                            'ends', c.subscription_expires_at) AS evidence
    FROM company c
   WHERE c.subscription_started_at > c.subscription_expires_at
  UNION ALL
  SELECT '15_periods_out_of_order', s.company_id, s.id,
         jsonb_build_object('source', 'company_subscriptions',
                            'starts', s.starts_at, 'ends', s.ends_at, 'status', s.status)
    FROM company_subscriptions s
   WHERE s.starts_at > s.ends_at
  UNION ALL
  SELECT '15_periods_out_of_order', r.company_id, r.code_id,
         jsonb_build_object('source', 'activation_codes',
                            'starts', r.period_start, 'ends', r.period_end)
    FROM redemption r
   WHERE r.period_start > r.period_end
),

class(conflict) AS (
  VALUES ('01_plan_unknown'),
         ('02_terms_differ_from_current_subscription'),
         ('03_multiple_current_subscriptions'),
         ('04_active_without_expiry'),
         ('05_active_past_expiry'),
         ('06_access_blocked_but_covered'),
         ('07_paid_invoice_without_period'),
         ('08_invoice_links_inconsistent'),
         ('09_past_due_while_access_active'),
         ('10_redemption_without_effect'),
         ('11_trial_flags_inconsistent'),
         ('12_gates_disagree'),
         ('13_suspension_flags_disagree'),
         ('14_suspended_with_active_subscription'),
         ('15_periods_out_of_order')
),

hit AS (
  SELECT * FROM c01 UNION ALL SELECT * FROM c02 UNION ALL SELECT * FROM c03
  UNION ALL SELECT * FROM c04 UNION ALL SELECT * FROM c05 UNION ALL SELECT * FROM c06
  UNION ALL SELECT * FROM c07 UNION ALL SELECT * FROM c08 UNION ALL SELECT * FROM c09
  UNION ALL SELECT * FROM c10 UNION ALL SELECT * FROM c11 UNION ALL SELECT * FROM c12
  UNION ALL SELECT * FROM c13 UNION ALL SELECT * FROM c14 UNION ALL SELECT * FROM c15
)

SELECT k.conflict,
       count(h.company_id) OVER () AS n,
       h.company_id,
       h.ref_id,
       h.evidence
  FROM class k
  LEFT JOIN hit h ON h.conflict = k.conflict
 WHERE k.conflict = $1
 ORDER BY h.company_id, h.ref_id;

\echo
\echo '01  companies.plan is not basic, advanced or premium; no CHECK constraint holds it'
EXECUTE subscription_conflicts('01_plan_unknown');

\echo
\echo '02  plan, car limit, billing cycle or price on companies differ from the current company_subscriptions row'
EXECUTE subscription_conflicts('02_terms_differ_from_current_subscription');

\echo
\echo '03  more than one current company_subscriptions row'
EXECUTE subscription_conflicts('03_multiple_current_subscriptions');

\echo
\echo '04  subscription_status active with no expiry: the gate lets it in for ever'
EXECUTE subscription_conflicts('04_active_without_expiry');

\echo
\echo '05  subscription_status still active after its expiry: the browser treats it as expired'
EXECUTE subscription_conflicts('05_active_past_expiry');

\echo
\echo '06  subscription gate blocks while an expiry, paid invoice, code or active row covers today'
EXECUTE subscription_conflicts('06_access_blocked_but_covered');

\echo
\echo '07  paid invoice whose month overlaps no period the access model recorded'
EXECUTE subscription_conflicts('07_paid_invoice_without_period');

\echo
\echo '08  invoice on another company row, outside its row term, or paid flags that disagree'
EXECUTE subscription_conflicts('08_invoice_links_inconsistent');

\echo
\echo '09  unpaid invoice past its due date, or an overdue row, while the subscription gate allows'
EXECUTE subscription_conflicts('09_past_due_while_access_active');

\echo
\echo '10  redeemed activation code whose period the company no longer reflects'
EXECUTE subscription_conflicts('10_redemption_without_effect');

\echo
\echo '11  companies.status and the trial dates disagree'
EXECUTE subscription_conflicts('11_trial_flags_inconsistent');

\echo
\echo '12  approved company: subscription gate and plan gate give different answers'
EXECUTE subscription_conflicts('12_gates_disagree');

\echo
\echo '13  the three suspension flags (status, approval_status, subscription_status) disagree'
EXECUTE subscription_conflicts('13_suspension_flags_disagree');

\echo
\echo '14  suspended by any flag while a subscription is active or covered'
EXECUTE subscription_conflicts('14_suspended_with_active_subscription');

\echo
\echo '15  a period that starts after it ends'
EXECUTE subscription_conflicts('15_periods_out_of_order');

DEALLOCATE subscription_conflicts;

\if :{?subscription_conflicts_nested}
ROLLBACK TO SAVEPOINT subscription_conflicts;
RELEASE SAVEPOINT subscription_conflicts;
\else
ROLLBACK;
\endif
