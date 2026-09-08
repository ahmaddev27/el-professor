/*
  # Fix Abrechnung Weekly View to Use Correct Week Column

  1. Changes
    - Update `abrechnung_weekly` view to use `income.week` instead of `income.week_number`
    - The `week` column contains the correct week numbers calculated by the system
    - The `week_number` column was incorrectly all set to 1

  2. Impact
    - Weekly abrechnung will now show correct bargeld amounts per week
    - Fixes issue where all bargeld was being grouped into week 1
*/

-- Drop the existing view
DROP VIEW IF EXISTS abrechnung_weekly;

-- Recreate the view with the correct column reference
CREATE OR REPLACE VIEW abrechnung_weekly AS
WITH weekly_receipts AS (
  SELECT 
    EXTRACT(year FROM date)::integer AS year,
    EXTRACT(month FROM date)::integer AS month,
    CASE
      WHEN EXTRACT(day FROM date) <= 7 THEN 1
      WHEN EXTRACT(day FROM date) <= 14 THEN 2
      WHEN EXTRACT(day FROM date) <= 21 THEN 3
      WHEN EXTRACT(day FROM date) <= 28 THEN 4
      ELSE 5
    END AS week_number,
    driver_name,
    COUNT(*)::bigint AS anzahl_belege,
    COALESCE(SUM(expense), 0)::numeric AS ausgegebene_bargeld
  FROM receipts
  WHERE payment_method = 'bar'
  GROUP BY 
    EXTRACT(year FROM date),
    EXTRACT(month FROM date),
    CASE
      WHEN EXTRACT(day FROM date) <= 7 THEN 1
      WHEN EXTRACT(day FROM date) <= 14 THEN 2
      WHEN EXTRACT(day FROM date) <= 21 THEN 3
      WHEN EXTRACT(day FROM date) <= 28 THEN 4
      ELSE 5
    END,
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
