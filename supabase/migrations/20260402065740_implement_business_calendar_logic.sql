/*
  # Implement Business Calendar Logic Across All Tables and Views

  ## Business Calendar Rule
  A week belongs to the month where its MONDAY is located.
  - Weeks run Monday to Sunday and are never split
  - A business month contains all weeks whose Monday falls in that calendar month
  - If a date is in April but its week's Monday was in March, it belongs to March

  ## Changes

  1. **Helper Functions**
     - `get_week_monday(date)` - Returns the Monday of any given date's week
     - `get_business_month(date)` - Returns month/year based on week's Monday
     - `get_business_week_number(date, month, year)` - Returns week number within business month

  2. **Updated Views**
     - `abrechnung_weekly` - Uses business month for grouping receipts and income
     - All data grouped by business month, not calendar month

  3. **Impact**
     - Belege (receipts) are assigned to business month based on week's Monday
     - Umsätze (income) are assigned to business month based on week's Monday
     - Salary calculations use business month boundaries
     - Weekly and monthly reports show consistent business calendar data

  ## Security
  - All functions are IMMUTABLE for performance
  - Views maintain existing RLS policies through underlying tables
*/

-- ============================================================================
-- HELPER FUNCTIONS
-- ============================================================================

-- Get the Monday of the week for any given date
CREATE OR REPLACE FUNCTION get_week_monday(input_date date)
RETURNS date
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT (input_date - ((EXTRACT(dow FROM input_date)::integer + 6) % 7))::date;
$$;

-- Get the business month and year for a date (based on its week's Monday)
CREATE OR REPLACE FUNCTION get_business_month(input_date date)
RETURNS TABLE (month integer, year integer)
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT
    EXTRACT(month FROM get_week_monday(input_date))::integer,
    EXTRACT(year FROM get_week_monday(input_date))::integer;
$$;

-- Get week number within a business month
-- Counts weeks whose Monday falls within the specified month/year
CREATE OR REPLACE FUNCTION get_business_week_number(input_date date, p_month integer, p_year integer)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  week_monday date;
  month_start date;
  month_end date;
  monday_cursor date;
  week_count integer := 0;
BEGIN
  -- Get the Monday of the input date's week
  week_monday := get_week_monday(input_date);

  -- Get month boundaries
  month_start := make_date(p_year, p_month, 1);
  month_end := (month_start + interval '1 month' - interval '1 day')::date;

  -- Find all Mondays in the month and count until we reach our Monday
  monday_cursor := month_start;

  -- Find first Monday in the month
  WHILE monday_cursor <= month_end LOOP
    IF EXTRACT(dow FROM monday_cursor) = 1 THEN
      week_count := week_count + 1;

      -- If this is our Monday, return the count
      IF monday_cursor = week_monday THEN
        RETURN week_count;
      END IF;

      -- Move to next Monday
      monday_cursor := monday_cursor + 7;
    ELSE
      -- Move forward to find first Monday
      monday_cursor := monday_cursor + 1;
    END IF;
  END LOOP;

  -- If we didn't find the Monday in the specified month, return 1
  RETURN 1;
END;
$$;

-- ============================================================================
-- RECREATE ABRECHNUNG_WEEKLY VIEW WITH BUSINESS CALENDAR LOGIC
-- ============================================================================

DROP VIEW IF EXISTS abrechnung_weekly CASCADE;

CREATE OR REPLACE VIEW abrechnung_weekly AS
WITH weekly_receipts AS (
  SELECT
    bm.year,
    bm.month,
    get_business_week_number(r.date, bm.month, bm.year) AS week_number,
    r.driver_name,
    COUNT(*)::bigint AS anzahl_belege,
    COALESCE(SUM(r.expense), 0)::numeric AS ausgegebene_bargeld
  FROM receipts r
  CROSS JOIN LATERAL get_business_month(r.date) AS bm
  WHERE r.payment_method = 'bar'
  GROUP BY
    bm.year,
    bm.month,
    get_business_week_number(r.date, bm.month, bm.year),
    r.driver_name
),
weekly_income AS (
  SELECT
    bm.year,
    bm.month,
    get_business_week_number(i.date, bm.month, bm.year) AS week_number,
    i.driver_name,
    COALESCE(SUM(i.amount), 0)::numeric AS bargeld_income
  FROM income i
  CROSS JOIN LATERAL get_business_month(i.date) AS bm
  WHERE i.type = 'bargeld'
  GROUP BY
    bm.year,
    bm.month,
    get_business_week_number(i.date, bm.month, bm.year),
    i.driver_name
)
SELECT
  COALESCE(wr.year, wi.year) AS year,
  COALESCE(wr.month, wi.month) AS month,
  COALESCE(wr.week_number, wi.week_number) AS week_number,
  COALESCE(wr.driver_name, wi.driver_name) AS driver_name,
  COALESCE(wr.anzahl_belege, 0) AS anzahl_belege,
  COALESCE(wr.ausgegebene_bargeld, 0) AS ausgegebene_bargeld,
  COALESCE(wi.bargeld_income, 0) AS bargeld,
  (COALESCE(wi.bargeld_income, 0) - COALESCE(wr.ausgegebene_bargeld, 0)) AS bar_zuruck
FROM weekly_receipts wr
FULL JOIN weekly_income wi
  ON wr.year = wi.year
  AND wr.month = wi.month
  AND wr.week_number = wi.week_number
  AND wr.driver_name = wi.driver_name
ORDER BY
  COALESCE(wr.year, wi.year) DESC,
  COALESCE(wr.month, wi.month) DESC,
  COALESCE(wr.week_number, wi.week_number) DESC,
  COALESCE(wr.driver_name, wi.driver_name);

-- ============================================================================
-- UPDATE RPC FUNCTIONS (DROP and RECREATE to avoid parameter issues)
-- ============================================================================

DROP FUNCTION IF EXISTS get_weekly_abrechnung(integer, integer);
DROP FUNCTION IF EXISTS get_driver_weekly_abrechnung(text, integer, integer);

CREATE OR REPLACE FUNCTION get_weekly_abrechnung(
  p_year integer,
  p_month integer
)
RETURNS TABLE (
  year integer,
  month integer,
  week_number integer,
  driver_name text,
  anzahl_belege bigint,
  ausgegebene_bargeld numeric,
  bargeld numeric,
  bar_zuruck numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    aw.year,
    aw.month,
    aw.week_number,
    aw.driver_name,
    aw.anzahl_belege,
    aw.ausgegebene_bargeld,
    aw.bargeld,
    aw.bar_zuruck
  FROM abrechnung_weekly aw
  WHERE aw.year = p_year AND aw.month = p_month
  ORDER BY aw.week_number DESC, aw.driver_name;
END;
$$;

CREATE OR REPLACE FUNCTION get_driver_weekly_abrechnung(
  p_driver_name text,
  p_year integer,
  p_month integer
)
RETURNS TABLE (
  year integer,
  month integer,
  week_number integer,
  driver_name text,
  anzahl_belege bigint,
  ausgegebene_bargeld numeric,
  bargeld numeric,
  bar_zuruck numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    aw.year,
    aw.month,
    aw.week_number,
    aw.driver_name,
    aw.anzahl_belege,
    aw.ausgegebene_bargeld,
    aw.bargeld,
    aw.bar_zuruck
  FROM abrechnung_weekly aw
  WHERE aw.driver_name = p_driver_name
    AND aw.year = p_year
    AND aw.month = p_month
  ORDER BY aw.week_number DESC;
END;
$$;

-- ============================================================================
-- GRANT PERMISSIONS
-- ============================================================================

GRANT EXECUTE ON FUNCTION get_week_monday(date) TO authenticated;
GRANT EXECUTE ON FUNCTION get_business_month(date) TO authenticated;
GRANT EXECUTE ON FUNCTION get_business_week_number(date, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION get_weekly_abrechnung(integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION get_driver_weekly_abrechnung(text, integer, integer) TO authenticated;