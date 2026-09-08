/*
# Add driver_hour_summary_json to historical_wh_saved_plans

## Purpose
Persists the per-driver working-hour breakdown (Arbeitsstunden je Fahrer) with each saved plan.
The summary is computed at save time from the final edited Fahrtenbuch and displayed in the
success popup and the saved-plan "Anzeigen" view.

## Changes
- `historical_wh_saved_plans`: new column `driver_hour_summary_json jsonb NOT NULL DEFAULT '[]'`
  Stores an array of DriverHourSummaryRow objects (one per driver).
*/

ALTER TABLE historical_wh_saved_plans
  ADD COLUMN IF NOT EXISTS driver_hour_summary_json jsonb NOT NULL DEFAULT '[]';
