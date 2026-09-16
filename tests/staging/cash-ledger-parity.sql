-- Bargeldbestand: the old figure against the ledger figure (slice 4.3b).
--
-- Before 4.3b the screen computed its balance itself:
--
--     Bargeld (income.type = 'bargeld')  −  Belege (receipts.expense)
--
-- and knew nothing of the cash a Gehaltsquittung takes out of the till. After
-- it, the same screen reads public.cash_movements as well:
--
--     Bargeld  −  Belege  −  (gehaltsquittung out − gehaltsquittung_storno in)
--
-- The two agree for every company and every month in which no Gehaltsquittung
-- was confirmed, which is every month before the feature shipped. This script
-- proves that on a real dataset, and names the months where it does not, so a
-- difference is read on purpose instead of discovered on a screen.
--
-- It writes nothing: BEGIN READ ONLY, and ROLLBACK even so. Run it against
-- staging only, and never against production:
--
--   ssh elprofessor 'docker exec -i ya-mobility-staging-db-1 \
--     psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f -' \
--     < tests/staging/cash-ledger-parity.sql
--
-- The output is deliberately a summary: counts, and one largest difference in
-- cents. No company id, no company name, no per-company amount. Cents are
-- exact — numeric(10,2) * 100 is a decimal multiplication, not a float one.

BEGIN READ ONLY;

WITH bargeld AS (
  SELECT company_id,
         date_trunc('month', date)::date        AS period,
         round(SUM(COALESCE(amount, 0)) * 100)::bigint AS cents
    FROM public.income
   WHERE type = 'bargeld'
     AND company_id IS NOT NULL
   GROUP BY 1, 2
),
belege AS (
  SELECT company_id,
         date_trunc('month', date)::date         AS period,
         round(SUM(COALESCE(expense, 0)) * 100)::bigint AS cents
    FROM public.receipts
   WHERE company_id IS NOT NULL
   GROUP BY 1, 2
),
movements AS (
  SELECT company_id,
         date_trunc('month', movement_date)::date AS period,
         round(SUM(CASE WHEN direction = 'in' THEN amount ELSE -amount END) * 100)::bigint AS cents
    FROM public.cash_movements
   WHERE source_type IN ('gehaltsquittung', 'gehaltsquittung_storno')
   GROUP BY 1, 2
),
keys AS (
  SELECT company_id, period FROM bargeld
  UNION
  SELECT company_id, period FROM belege
  UNION
  SELECT company_id, period FROM movements
),
compared AS (
  SELECT k.company_id,
         k.period,
         COALESCE(i.cents, 0) - COALESCE(b.cents, 0)                        AS old_cents,
         COALESCE(i.cents, 0) - COALESCE(b.cents, 0) + COALESCE(m.cents, 0) AS new_cents
    FROM keys k
    LEFT JOIN bargeld   i USING (company_id, period)
    LEFT JOIN belege    b USING (company_id, period)
    LEFT JOIN movements m USING (company_id, period)
)
SELECT 'per company and month'                                                AS scope,
       count(*)                                                               AS periods_compared,
       count(DISTINCT company_id)                                             AS companies_compared,
       count(*) FILTER (WHERE old_cents <> new_cents)                         AS periods_differing,
       count(DISTINCT company_id) FILTER (WHERE old_cents <> new_cents)       AS companies_differing,
       COALESCE(max(abs(new_cents - old_cents)), 0)                           AS max_abs_diff_cents
  FROM compared;

-- The same question without the month boundary, in case a movement lands in a
-- month that has no Bargeld and no Beleg at all.
WITH bargeld AS (
  SELECT company_id, round(SUM(COALESCE(amount, 0)) * 100)::bigint AS cents
    FROM public.income WHERE type = 'bargeld' AND company_id IS NOT NULL GROUP BY 1
),
belege AS (
  SELECT company_id, round(SUM(COALESCE(expense, 0)) * 100)::bigint AS cents
    FROM public.receipts WHERE company_id IS NOT NULL GROUP BY 1
),
movements AS (
  SELECT company_id,
         round(SUM(CASE WHEN direction = 'in' THEN amount ELSE -amount END) * 100)::bigint AS cents
    FROM public.cash_movements
   WHERE source_type IN ('gehaltsquittung', 'gehaltsquittung_storno')
   GROUP BY 1
),
keys AS (
  SELECT company_id FROM bargeld
  UNION SELECT company_id FROM belege
  UNION SELECT company_id FROM movements
),
compared AS (
  SELECT k.company_id,
         COALESCE(i.cents, 0) - COALESCE(b.cents, 0)                        AS old_cents,
         COALESCE(i.cents, 0) - COALESCE(b.cents, 0) + COALESCE(m.cents, 0) AS new_cents
    FROM keys k
    LEFT JOIN bargeld   i USING (company_id)
    LEFT JOIN belege    b USING (company_id)
    LEFT JOIN movements m USING (company_id)
)
SELECT 'per company, all time'                                          AS scope,
       count(*)                                                         AS companies_compared,
       count(*) FILTER (WHERE old_cents <> new_cents)                   AS companies_differing,
       COALESCE(max(abs(new_cents - old_cents)), 0)                     AS max_abs_diff_cents
  FROM compared;

-- What the ledger holds, with no company attached: every difference above has
-- to be explained by these rows and nothing else.
SELECT source_type,
       direction,
       count(*)                          AS rows,
       round(SUM(amount) * 100)::bigint  AS total_cents,
       min(movement_date)                AS first_movement,
       max(movement_date)                AS last_movement
  FROM public.cash_movements
 GROUP BY 1, 2
 ORDER BY 1, 2;

-- A movement whose source_type this screen does not read would silently sit
-- outside the balance. Today the CHECK constraint allows only the two above;
-- this fails loudly if that ever stops being true.
SELECT count(*) AS movements_with_unknown_source
  FROM public.cash_movements
 WHERE source_type NOT IN ('gehaltsquittung', 'gehaltsquittung_storno');

-- Sensitivity. While no company has confirmed a Gehaltsquittung yet, the
-- ledger term is 0 and the comparison above reports zero differences whatever
-- it computes — including if it computed nothing at all. So run it once more
-- against a hypothetical 300,00 € payout in every company-month, written
-- nowhere: periods_differing must then equal periods_compared, and
-- max_abs_diff_cents must be 30000. A zero here would mean the query, not the
-- data, is why the real answer was zero.
WITH bargeld AS (
  SELECT company_id, date_trunc('month', date)::date AS period,
         round(SUM(COALESCE(amount, 0)) * 100)::bigint AS cents
    FROM public.income WHERE type = 'bargeld' AND company_id IS NOT NULL GROUP BY 1, 2
),
belege AS (
  SELECT company_id, date_trunc('month', date)::date AS period,
         round(SUM(COALESCE(expense, 0)) * 100)::bigint AS cents
    FROM public.receipts WHERE company_id IS NOT NULL GROUP BY 1, 2
),
keys AS (
  SELECT company_id, period FROM bargeld
  UNION
  SELECT company_id, period FROM belege
),
hypothetical AS (
  -- What confirm_salary_cash_payment would have written: one 'out' row.
  SELECT company_id, period, -30000::bigint AS cents FROM keys
),
compared AS (
  SELECT k.company_id, k.period,
         COALESCE(i.cents, 0) - COALESCE(b.cents, 0)                        AS old_cents,
         COALESCE(i.cents, 0) - COALESCE(b.cents, 0) + COALESCE(h.cents, 0) AS new_cents
    FROM keys k
    LEFT JOIN bargeld      i USING (company_id, period)
    LEFT JOIN belege       b USING (company_id, period)
    LEFT JOIN hypothetical h USING (company_id, period)
)
SELECT 'sensitivity: one hypothetical payout per month' AS scope,
       count(*)                                          AS periods_compared,
       count(*) FILTER (WHERE old_cents <> new_cents)    AS periods_differing,
       COALESCE(max(abs(new_cents - old_cents)), 0)      AS max_abs_diff_cents
  FROM compared;

ROLLBACK;
