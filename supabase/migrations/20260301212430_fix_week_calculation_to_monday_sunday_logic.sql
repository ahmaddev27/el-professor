/*
  # Fix Week Calculation to Use Monday-Sunday Logic

  1. Changes
    - Create a function `get_week_number_from_date` that calculates week numbers based on Mondays in the month
    - Week 1 starts from the first Monday and ends on Sunday
    - Week 2 starts from the second Monday and ends on Sunday, etc.
    - The last week always ends on its Sunday, even if that Sunday is in the next month
    - Update `abrechnung_weekly` view to use this function for receipts

  2. Impact
    - Week calculations will now be consistent between frontend and backend
    - Last week of the month will end on the Sunday of that week, not the last day of the month
    - Receipts and income will be grouped correctly by Monday-to-Sunday weeks
*/

-- Create function to calculate week number based on Monday-to-Sunday logic
CREATE OR REPLACE FUNCTION get_week_number_from_date(input_date date)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  month_start date;
  day_of_month integer;
  first_monday date;
  days_from_first_monday integer;
  week_num integer;
BEGIN
  -- Get the first day of the month
  month_start := date_trunc('month', input_date)::date;
  
  -- Get the day of month for input date
  day_of_month := EXTRACT(day FROM input_date)::integer;
  
  -- Find the first Monday of the month
  -- Loop through first 7 days to find Monday (day of week = 1)
  first_monday := NULL;
  FOR i IN 0..6 LOOP
    IF EXTRACT(dow FROM month_start + i) = 1 THEN
      first_monday := month_start + i;
      EXIT;
    END IF;
  END LOOP;
  
  -- If no Monday in the month, return 1
  IF first_monday IS NULL THEN
    RETURN 1;
  END IF;
  
  -- If the date is before the first Monday, it belongs to week 1
  IF input_date < first_monday THEN
    RETURN 1;
  END IF;
  
  -- Calculate how many days from the first Monday
  days_from_first_monday := input_date - first_monday;
  
  -- Calculate week number (each week is 7 days starting from Monday)
  week_num := (days_from_first_monday / 7) + 1;
  
  -- Ensure week number is between 1 and 5
  week_num := LEAST(week_num, 5);
  
  RETURN week_num;
END;
$$;

-- Drop the existing view
DROP VIEW IF EXISTS abrechnung_weekly;

-- Recreate the view using the new week calculation function
CREATE OR REPLACE VIEW abrechnung_weekly AS
WITH weekly_receipts AS (
  SELECT 
    EXTRACT(year FROM date)::integer AS year,
    EXTRACT(month FROM date)::integer AS month,
    get_week_number_from_date(date) AS week_number,
    driver_name,
    COUNT(*)::bigint AS anzahl_belege,
    COALESCE(SUM(expense), 0)::numeric AS ausgegebene_bargeld
  FROM receipts
  WHERE payment_method = 'bar'
  GROUP BY 
    EXTRACT(year FROM date),
    EXTRACT(month FROM date),
    get_week_number_from_date(date),
    driver_name
),
weekly_income AS (
  SELECT 
    EXTRACT(year FROM date)::integer AS year,
    EXTRACT(month FROM date)::integer AS month,
    week AS week_number,
    driver_name,
    COALESCE(SUM(amount), 0)::numeric AS bargeld_income
  FROM income
  WHERE type = 'bargeld' AND week IS NOT NULL
  GROUP BY 
    EXTRACT(year FROM date),
    EXTRACT(month FROM date),
    week,
    driver_name
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
