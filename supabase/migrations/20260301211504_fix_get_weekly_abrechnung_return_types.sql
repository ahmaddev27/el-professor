/*
  # Fix get_weekly_abrechnung Function Return Types

  1. Changes
    - Update function to match the actual return types from the view
    - Change year and month from numeric to integer to match view output
    - This fixes the "Returned type integer does not match expected type numeric" error

  2. Impact
    - Abrechnung page will load correctly without type mismatch errors
*/

-- Drop and recreate the function with correct return types
DROP FUNCTION IF EXISTS get_weekly_abrechnung(integer, integer);

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
