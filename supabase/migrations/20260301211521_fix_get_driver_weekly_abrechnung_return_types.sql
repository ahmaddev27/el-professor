/*
  # Fix get_driver_weekly_abrechnung Function Return Types

  1. Changes
    - Update function to match the actual return types from the view
    - Change year and month from numeric to integer to match view output

  2. Impact
    - Ensures consistency across all abrechnung functions
*/

-- Drop and recreate the function with correct return types
DROP FUNCTION IF EXISTS get_driver_weekly_abrechnung(text, integer, integer);

CREATE OR REPLACE FUNCTION get_driver_weekly_abrechnung(
  p_driver_name text,
  p_year integer DEFAULT NULL,
  p_month integer DEFAULT NULL
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
    AND (p_year IS NULL OR aw.year = p_year)
    AND (p_month IS NULL OR aw.month = p_month)
  ORDER BY aw.year DESC, aw.month DESC, aw.week_number DESC;
END;
$$;
