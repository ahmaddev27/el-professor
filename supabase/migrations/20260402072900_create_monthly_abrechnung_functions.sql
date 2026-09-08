/*
  # Create Monthly Abrechnung Functions

  1. Overview
    - Creates database functions for monthly settlement calculation
    - Monthly settlement aggregates all business weeks that belong to a month
    - A business week belongs to the month where its Monday is located

  2. Functions Created
    - `get_monthly_abrechnung(p_year, p_month)` - Get monthly settlement for all drivers
    - `get_driver_monthly_abrechnung(p_driver_name, p_year, p_month)` - Get monthly settlement for specific driver with weekly breakdown

  3. Business Logic
    - Monthly values are sums of all weekly values from business weeks in that month
    - Uses the existing `abrechnung_weekly` view as the data source
    - Bargeld (Monat) = sum of all cash revenue from business weeks
    - Belege (Monat) = sum of all Belege paid in cash from business weeks
    - Bar zurück (Monat) = Bargeld - Belege

  4. Security
    - Both functions use SECURITY DEFINER
    - Grant EXECUTE to authenticated users
*/

-- Function to get monthly abrechnung for all drivers
CREATE OR REPLACE FUNCTION get_monthly_abrechnung(
  p_year integer,
  p_month integer
)
RETURNS TABLE (
  year integer,
  month integer,
  driver_name text,
  anzahl_belege bigint,
  ausgegebene_bargeld numeric,
  bargeld numeric,
  bar_zuruck numeric,
  week_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    p_year as year,
    p_month as month,
    aw.driver_name,
    SUM(aw.anzahl_belege)::bigint as anzahl_belege,
    SUM(aw.ausgegebene_bargeld) as ausgegebene_bargeld,
    SUM(aw.bargeld) as bargeld,
    SUM(aw.bar_zuruck) as bar_zuruck,
    COUNT(DISTINCT aw.week_number)::integer as week_count
  FROM abrechnung_weekly aw
  WHERE aw.year = p_year AND aw.month = p_month
  GROUP BY aw.driver_name
  ORDER BY aw.driver_name;
END;
$$;

-- Function to get monthly abrechnung for specific driver with weekly breakdown
CREATE OR REPLACE FUNCTION get_driver_monthly_abrechnung(
  p_driver_name text,
  p_year integer,
  p_month integer
)
RETURNS TABLE (
  year integer,
  month integer,
  driver_name text,
  total_anzahl_belege bigint,
  total_ausgegebene_bargeld numeric,
  total_bargeld numeric,
  total_bar_zuruck numeric,
  week_count integer,
  weekly_breakdown jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_weeks jsonb;
BEGIN
  -- Build weekly breakdown as JSON array
  SELECT jsonb_agg(
    jsonb_build_object(
      'week_number', aw.week_number,
      'anzahl_belege', aw.anzahl_belege,
      'ausgegebene_bargeld', aw.ausgegebene_bargeld,
      'bargeld', aw.bargeld,
      'bar_zuruck', aw.bar_zuruck
    )
    ORDER BY aw.week_number
  )
  INTO v_weeks
  FROM abrechnung_weekly aw
  WHERE aw.driver_name = p_driver_name
    AND aw.year = p_year
    AND aw.month = p_month;

  -- Return aggregated monthly data with weekly breakdown
  RETURN QUERY
  SELECT
    p_year as year,
    p_month as month,
    p_driver_name as driver_name,
    SUM(aw.anzahl_belege)::bigint as total_anzahl_belege,
    SUM(aw.ausgegebene_bargeld) as total_ausgegebene_bargeld,
    SUM(aw.bargeld) as total_bargeld,
    SUM(aw.bar_zuruck) as total_bar_zuruck,
    COUNT(DISTINCT aw.week_number)::integer as week_count,
    v_weeks as weekly_breakdown
  FROM abrechnung_weekly aw
  WHERE aw.driver_name = p_driver_name
    AND aw.year = p_year
    AND aw.month = p_month
  GROUP BY aw.driver_name;
END;
$$;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION get_monthly_abrechnung(integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION get_driver_monthly_abrechnung(text, integer, integer) TO authenticated;
