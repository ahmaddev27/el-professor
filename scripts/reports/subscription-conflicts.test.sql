/*
  Proves that every class in subscription-conflicts.sql detects what it names,
  that a consistent company shows up in none, and that the report never writes.

  Runs only against the RLS kit database (the fixture, the migrations after it,
  tests/rls/roles-seed.sql and tests/rls/seed.sql), because it seeds companies.
  All of it happens in one transaction that is rolled back. The report runs
  nested, in a read-only savepoint: a write anywhere in it would fail the run.

      psql -X -v ON_ERROR_STOP=1 -U supabase_admin -d postgres \
           -f scripts/reports/subscription-conflicts.test.sql

  It is not part of npm run test:rls: the kit feeds each file to psql on stdin,
  and from there \ir cannot find the report. Run it with -f, from a copy of the
  repository inside the kit container.

  Ids: companies e5000000-..., plans e5100000-..., subscription rows
  e5200000-..., invoices e5300000-..., codes e5400000-.... The last two digits
  of a company id name the class it is built for; 00 is the control.
*/

\set ON_ERROR_STOP on
\set QUIET on

BEGIN;

-- ─── companies ──────────────────────────────────────────────────────────────

INSERT INTO companies (id, name, slug, status, approval_status, plan, billing_cycle,
                       subscription_car_limit, subscription_status,
                       subscription_started_at, subscription_expires_at, trial_start, trial_end)
SELECT v.id::uuid, 'Report test ' || v.tag, 'report-test-' || v.tag, v.status, v.approval, v.plan,
       'monthly', 3, v.sub_status, v.started, v.expires, v.trial_start, v.trial_end
  FROM (VALUES
    -- consistent in every model: must appear in no class
    ('e5000000-0000-4000-8000-000000000000', '00', 'active', 'approved', 'basic', 'active',
     now() - interval '10 days', now() + interval '20 days', NULL::timestamptz, NULL::timestamptz),
    ('e5000000-0000-4000-8000-000000000001', '01', 'active', 'approved', 'gold', 'active',
     now() - interval '10 days', now() + interval '20 days', NULL, NULL),
    ('e5000000-0000-4000-8000-000000000002', '02', 'active', 'approved', 'basic', 'active',
     now() - interval '10 days', now() + interval '20 days', NULL, NULL),
    ('e5000000-0000-4000-8000-000000000003', '03', 'active', 'approved', 'basic', 'active',
     now() - interval '10 days', now() + interval '20 days', NULL, NULL),
    ('e5000000-0000-4000-8000-000000000004', '04', 'active', 'approved', 'basic', 'active',
     NULL, NULL, NULL, NULL),
    ('e5000000-0000-4000-8000-000000000005', '05', 'active', 'approved', 'basic', 'active',
     now() - interval '40 days', now() - interval '2 days', NULL, NULL),
    ('e5000000-0000-4000-8000-000000000006', '06', 'active', 'approved', 'basic', 'expired',
     now() - interval '40 days', now() - interval '1 day', NULL, NULL),
    ('e5000000-0000-4000-8000-000000000007', '07', 'active', 'approved', 'basic', 'inactive',
     NULL, NULL, NULL, NULL),
    ('e5000000-0000-4000-8000-000000000008', '08', 'active', 'approved', 'basic', 'active',
     now() - interval '10 days', now() + interval '20 days', NULL, NULL),
    ('e5000000-0000-4000-8000-000000000009', '09', 'active', 'approved', 'basic', 'active',
     now() - interval '10 days', now() + interval '30 days', NULL, NULL),
    ('e5000000-0000-4000-8000-00000000000a', '0a', 'active', 'approved', 'basic', 'active',
     now() - interval '40 days', now() - interval '20 days', NULL, NULL),
    -- trial over, still status trial, paying: the plan gate locks it out
    ('e5000000-0000-4000-8000-00000000000b', '0b', 'trial', 'approved', 'basic', 'active',
     now() - interval '6 days', now() + interval '30 days', now() - interval '20 days', now() - interval '6 days'),
    -- trial running on an active company without a subscription: the subscription gate locks it out
    ('e5000000-0000-4000-8000-00000000000c', '0c', 'active', 'approved', 'basic', 'inactive',
     NULL, NULL, now() - interval '1 day', now() + interval '13 days'),
    ('e5000000-0000-4000-8000-00000000000d', '0d', 'suspended', 'approved', 'basic', 'active',
     now() - interval '10 days', now() + interval '20 days', NULL, NULL),
    -- all three flags agree, yet this month is paid
    ('e5000000-0000-4000-8000-00000000000e', '0e', 'suspended', 'suspended', 'basic', 'suspended',
     now() - interval '10 days', now() + interval '20 days', NULL, NULL),
    ('e5000000-0000-4000-8000-00000000000f', '0f', 'active', 'approved', 'basic', 'active',
     now() + interval '5 days', now() + interval '1 day', NULL, NULL),
    -- pending, so the gates are not compared
    ('e5000000-0000-4000-8000-000000000010', '10', 'trial', 'pending', 'basic', 'inactive',
     NULL, NULL, now() - interval '1 day', NULL)
  ) AS v(id, tag, status, approval, plan, sub_status, started, expires, trial_start, trial_end);

-- ─── cash billing: plans, rows, invoices ────────────────────────────────────

INSERT INTO subscription_plans (id, name, monthly_price, included_cars)
VALUES ('e5100000-0000-4000-8000-000000000001', 'Basic', 60, 3),
       ('e5100000-0000-4000-8000-000000000002', 'Premium', 210, 3),
       ('e5100000-0000-4000-8000-000000000003', 'Sonderangebot Herbst', 50, 3);

-- 60 is compute_plan_price('basic', 3, 'monthly'), so the control's row agrees on price.
WITH m AS (SELECT (now() AT TIME ZONE 'Europe/Berlin')::date AS today)
INSERT INTO company_subscriptions (id, company_id, plan_id, status, starts_at, ends_at, monthly_price)
SELECT v.id::uuid, v.company_id::uuid, v.plan_id::uuid, v.status, m.today - v.days_ago, NULL, v.price
  FROM m CROSS JOIN LATERAL (VALUES
    ('e5200000-0000-4000-8000-000000000000', 'e5000000-0000-4000-8000-000000000000', 'e5100000-0000-4000-8000-000000000001', 'active',    10,  60),
    ('e5200000-0000-4000-8000-000000000002', 'e5000000-0000-4000-8000-000000000002', 'e5100000-0000-4000-8000-000000000002', 'active',    10, 210),
    ('e5200000-0000-4000-8000-000000000003', 'e5000000-0000-4000-8000-000000000003', 'e5100000-0000-4000-8000-000000000001', 'active',    30,  60),
    ('e5200000-0000-4000-8000-000000000013', 'e5000000-0000-4000-8000-000000000003', 'e5100000-0000-4000-8000-000000000003', 'paused',     5,  50),
    ('e5200000-0000-4000-8000-000000000006', 'e5000000-0000-4000-8000-000000000006', 'e5100000-0000-4000-8000-000000000001', 'canceled',  60,  60),
    ('e5200000-0000-4000-8000-000000000007', 'e5000000-0000-4000-8000-000000000007', 'e5100000-0000-4000-8000-000000000001', 'canceled', 200,  60),
    ('e5200000-0000-4000-8000-000000000008', 'e5000000-0000-4000-8000-000000000008', 'e5100000-0000-4000-8000-000000000001', 'canceled', 200,  60),
    ('e5200000-0000-4000-8000-000000000009', 'e5000000-0000-4000-8000-000000000009', 'e5100000-0000-4000-8000-000000000001', 'active',    60,  60),
    ('e5200000-0000-4000-8000-00000000000e', 'e5000000-0000-4000-8000-00000000000e', 'e5100000-0000-4000-8000-000000000001', 'canceled',  60,  60)
  ) AS v(id, company_id, plan_id, status, days_ago, price);

WITH m AS (
  SELECT date_trunc('month', now() AT TIME ZONE 'Europe/Berlin')::date AS this_month,
         (now() AT TIME ZONE 'Europe/Berlin')::date                    AS today
)
INSERT INTO subscription_invoices (id, company_id, subscription_id, invoice_year, invoice_month,
                                   invoice_number, amount, status, due_date, paid_at)
SELECT v.id::uuid, v.company_id::uuid, v.subscription_id::uuid,
       extract(year FROM v.month)::int, extract(month FROM v.month)::int,
       'RPT-TEST-' || right(v.id, 2), 60, v.status, v.due_date, v.paid_at
  FROM m CROSS JOIN LATERAL (VALUES
    ('e5300000-0000-4000-8000-000000000000', 'e5000000-0000-4000-8000-000000000000', 'e5200000-0000-4000-8000-000000000000',
     m.this_month, 'paid', m.this_month, now() - interval '1 day'),
    ('e5300000-0000-4000-8000-000000000006', 'e5000000-0000-4000-8000-000000000006', 'e5200000-0000-4000-8000-000000000006',
     m.this_month, 'paid', m.this_month, now() - interval '1 day'),
    ('e5300000-0000-4000-8000-000000000007', 'e5000000-0000-4000-8000-000000000007', 'e5200000-0000-4000-8000-000000000007',
     (m.this_month - interval '3 months')::date, 'paid', (m.this_month - interval '3 months')::date, now() - interval '80 days'),
    -- billed on company 02's row
    ('e5300000-0000-4000-8000-000000000008', 'e5000000-0000-4000-8000-000000000008', 'e5200000-0000-4000-8000-000000000002',
     m.this_month, 'open', m.today + 20, NULL),
    -- canceled after it was paid: paid_at stays
    ('e5300000-0000-4000-8000-000000000018', 'e5000000-0000-4000-8000-000000000008', 'e5200000-0000-4000-8000-000000000008',
     (m.this_month - interval '2 months')::date, 'canceled', (m.this_month - interval '2 months')::date, now() - interval '50 days'),
    ('e5300000-0000-4000-8000-000000000009', 'e5000000-0000-4000-8000-000000000009', 'e5200000-0000-4000-8000-000000000009',
     (m.this_month - interval '1 month')::date, 'open', m.today - 10, NULL),
    ('e5300000-0000-4000-8000-00000000000e', 'e5000000-0000-4000-8000-00000000000e', 'e5200000-0000-4000-8000-00000000000e',
     m.this_month, 'paid', m.this_month, now() - interval '1 day')
  ) AS v(id, company_id, subscription_id, month, status, due_date, paid_at);

-- ─── activation codes ───────────────────────────────────────────────────────

INSERT INTO activation_codes (id, code_hash, duration_type, expires_at, created_by, status, used_at,
                              company_id, used_company_id,
                              applied_subscription_started_at, applied_subscription_expires_at)
VALUES
  -- the control's own period, identical to its companies row
  ('e5400000-0000-4000-8000-000000000000', 'report-test-00', '1_monat', now() - interval '10 days',
   '50000000-0000-4000-8000-000000000001', 'used', now() - interval '10 days',
   NULL, 'e5000000-0000-4000-8000-000000000000', now() - interval '10 days', now() + interval '20 days'),
  -- granted ten days more than company 0a has left
  ('e5400000-0000-4000-8000-00000000000a', 'report-test-0a', '1_monat', now() - interval '40 days',
   '50000000-0000-4000-8000-000000000001', 'used', now() - interval '40 days',
   NULL, 'e5000000-0000-4000-8000-00000000000a', now() - interval '40 days', now() - interval '10 days'),
  -- issued for company 01, redeemed by 0a, period never recorded
  ('e5400000-0000-4000-8000-00000000001a', 'report-test-1a', '1_monat', now() - interval '30 days',
   '50000000-0000-4000-8000-000000000001', 'used', now() - interval '30 days',
   'e5000000-0000-4000-8000-000000000001', 'e5000000-0000-4000-8000-00000000000a', NULL, NULL);

-- 0a points at a code the control redeemed
UPDATE companies
   SET last_activation_code_id = 'e5400000-0000-4000-8000-000000000000'
 WHERE id IN ('e5000000-0000-4000-8000-000000000000', 'e5000000-0000-4000-8000-00000000000a');

-- ─── run the report, nested and read-only, into a file ──────────────────────

\set subscription_conflicts_nested on
\pset format csv
\pset tuples_only on
\o /tmp/subscription-conflicts.test.csv
\ir subscription-conflicts.sql
\o
\pset tuples_only off
\pset format aligned
\unset subscription_conflicts_nested

CREATE TEMP TABLE report_row (
  conflict   text,
  n          bigint,
  company_id uuid,
  ref_id     uuid,
  evidence   jsonb
) ON COMMIT DROP;

\copy report_row FROM '/tmp/subscription-conflicts.test.csv' WITH (FORMAT csv)

-- ─── assertions ─────────────────────────────────────────────────────────────

DO $$
DECLARE
  c_classes CONSTANT text[] := ARRAY[
    '01_plan_unknown', '02_terms_differ_from_current_subscription', '03_multiple_current_subscriptions',
    '04_active_without_expiry', '05_active_past_expiry', '06_access_blocked_but_covered',
    '07_paid_invoice_without_period', '08_invoice_links_inconsistent', '09_past_due_while_access_active',
    '10_redemption_without_effect', '11_trial_flags_inconsistent', '12_gates_disagree',
    '13_suspension_flags_disagree', '14_suspended_with_active_subscription', '15_periods_out_of_order'];
  c_control CONSTANT uuid := 'e5000000-0000-4000-8000-000000000000';
  v_text    text;
  r         record;
BEGIN
  IF current_setting('transaction_read_only') <> 'off' THEN
    RAISE EXCEPTION 'FAIL: the report left the transaction read-only; its savepoint was not rolled back';
  END IF;

  SELECT string_agg(k, ', ') INTO v_text
    FROM unnest(c_classes) AS k
   WHERE NOT EXISTS (SELECT 1 FROM report_row x WHERE x.conflict = k);
  IF v_text IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: classes the report did not print: %', v_text;
  END IF;

  SELECT string_agg(DISTINCT x.conflict, ', ') INTO v_text
    FROM report_row x
   WHERE x.conflict <> ALL (c_classes);
  IF v_text IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: the report printed classes this test does not know: %', v_text;
  END IF;

  FOR r IN
    SELECT x.conflict, min(x.n) AS min_n, max(x.n) AS max_n, count(x.company_id) AS findings,
           count(*) FILTER (WHERE x.company_id IS NULL) AS empty_rows
      FROM report_row x
     GROUP BY x.conflict
  LOOP
    IF r.min_n <> r.max_n OR r.max_n <> r.findings
       OR (r.findings = 0 AND r.empty_rows <> 1)
       OR (r.findings > 0 AND r.empty_rows <> 0) THEN
      RAISE EXCEPTION 'FAIL: % prints n = %..% for % findings and % empty rows',
        r.conflict, r.min_n, r.max_n, r.findings, r.empty_rows;
    END IF;
  END LOOP;
  RAISE NOTICE 'ok  all 15 classes printed, each n matching its rows';

  SELECT string_agg(x.conflict, ', ') INTO v_text FROM report_row x WHERE x.company_id = c_control;
  IF v_text IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: the consistent control company was reported under %', v_text;
  END IF;
  RAISE NOTICE 'ok  the consistent control company is in no class';

  FOR r IN
    SELECT e.* FROM (VALUES
      ('01_plan_unknown',                            'e5000000-0000-4000-8000-000000000001'::uuid, NULL::uuid,                             NULL::text,          NULL::text),
      ('02_terms_differ_from_current_subscription',  'e5000000-0000-4000-8000-000000000002', 'e5200000-0000-4000-8000-000000000002', 'differs',           'plan'),
      ('02_terms_differ_from_current_subscription',  'e5000000-0000-4000-8000-000000000002', 'e5200000-0000-4000-8000-000000000002', 'differs',           'price'),
      ('02_terms_differ_from_current_subscription',  'e5000000-0000-4000-8000-000000000003', 'e5200000-0000-4000-8000-000000000013', 'differs',           'plan_unmapped'),
      ('03_multiple_current_subscriptions',          'e5000000-0000-4000-8000-000000000003', NULL,                                   NULL,                NULL),
      ('04_active_without_expiry',                   'e5000000-0000-4000-8000-000000000004', NULL,                                   NULL,                NULL),
      ('05_active_past_expiry',                      'e5000000-0000-4000-8000-000000000005', NULL,                                   NULL,                NULL),
      ('06_access_blocked_but_covered',              'e5000000-0000-4000-8000-000000000006', NULL,                                   'covered_by',        'paid_invoice'),
      ('07_paid_invoice_without_period',             'e5000000-0000-4000-8000-000000000007', 'e5300000-0000-4000-8000-000000000007', NULL,                NULL),
      ('08_invoice_links_inconsistent',              'e5000000-0000-4000-8000-000000000008', 'e5300000-0000-4000-8000-000000000008', 'reasons',           'subscription_of_other_company'),
      ('08_invoice_links_inconsistent',              'e5000000-0000-4000-8000-000000000008', 'e5300000-0000-4000-8000-000000000018', 'reasons',           'paid_at_but_not_paid'),
      ('09_past_due_while_access_active',            'e5000000-0000-4000-8000-000000000009', 'e5300000-0000-4000-8000-000000000009', 'source',            'invoice'),
      ('10_redemption_without_effect',               'e5000000-0000-4000-8000-00000000000a', 'e5400000-0000-4000-8000-00000000000a', 'reasons',           'shortened'),
      ('10_redemption_without_effect',               'e5000000-0000-4000-8000-00000000000a', 'e5400000-0000-4000-8000-00000000001a', 'reasons',           'period_unknown'),
      ('10_redemption_without_effect',               'e5000000-0000-4000-8000-00000000000a', 'e5400000-0000-4000-8000-00000000001a', 'reasons',           'redeemed_by_other_company'),
      ('10_redemption_without_effect',               'e5000000-0000-4000-8000-00000000000a', 'e5400000-0000-4000-8000-000000000000', 'reasons',           'last_code_not_redeemed_here'),
      ('11_trial_flags_inconsistent',                'e5000000-0000-4000-8000-00000000000b', NULL,                                   'reasons',           'trial_status_after_end'),
      ('11_trial_flags_inconsistent',                'e5000000-0000-4000-8000-00000000000c', NULL,                                   'reasons',           'trial_running_status_not_trial'),
      ('11_trial_flags_inconsistent',                'e5000000-0000-4000-8000-000000000010', NULL,                                   'reasons',           'trial_status_without_end'),
      ('11_trial_flags_inconsistent',                'e5000000-0000-4000-8000-000000000010', NULL,                                   'reasons',           'trial_dates_out_of_order'),
      ('12_gates_disagree',                          'e5000000-0000-4000-8000-00000000000b', NULL,                                   'plan_gate',         'block'),
      ('12_gates_disagree',                          'e5000000-0000-4000-8000-00000000000c', NULL,                                   'subscription_gate', 'block'),
      ('13_suspension_flags_disagree',               'e5000000-0000-4000-8000-00000000000d', NULL,                                   NULL,                NULL),
      ('14_suspended_with_active_subscription',      'e5000000-0000-4000-8000-00000000000d', NULL,                                   'active_by',         'subscription_status'),
      ('14_suspended_with_active_subscription',      'e5000000-0000-4000-8000-00000000000e', NULL,                                   'active_by',         'paid_invoice'),
      ('15_periods_out_of_order',                    'e5000000-0000-4000-8000-00000000000f', NULL,                                   'source',            'companies')
    ) AS e(conflict, company_id, ref_id, key, value)
  LOOP
    IF NOT EXISTS (SELECT 1
                     FROM report_row x
                    WHERE x.conflict = r.conflict
                      AND x.company_id = r.company_id
                      AND x.ref_id IS NOT DISTINCT FROM r.ref_id
                      AND (r.key IS NULL OR x.evidence -> r.key @> to_jsonb(r.value))) THEN
      RAISE EXCEPTION 'FAIL: % did not report company % (ref %, % = %)',
        r.conflict, r.company_id, r.ref_id, r.key, r.value;
    END IF;
    RAISE NOTICE 'ok  % reports %', r.conflict, COALESCE(r.key || ' ' || r.value, 'its company');
  END LOOP;

  FOR r IN
    SELECT e.* FROM (VALUES
      ('13_suspension_flags_disagree',  'e5000000-0000-4000-8000-00000000000e'::uuid, 'three agreeing suspension flags'),
      ('06_access_blocked_but_covered', 'e5000000-0000-4000-8000-00000000000e',       'a suspended subscription, which class 14 owns'),
      ('12_gates_disagree',             'e5000000-0000-4000-8000-000000000010',       'a company still pending approval')
    ) AS e(conflict, company_id, why)
  LOOP
    IF EXISTS (SELECT 1 FROM report_row x WHERE x.conflict = r.conflict AND x.company_id = r.company_id) THEN
      RAISE EXCEPTION 'FAIL: % reported %', r.conflict, r.why;
    END IF;
    RAISE NOTICE 'ok  % leaves out %', r.conflict, r.why;
  END LOOP;
END $$;

ROLLBACK;

\echo 'subscription-conflicts.test.sql passed'
