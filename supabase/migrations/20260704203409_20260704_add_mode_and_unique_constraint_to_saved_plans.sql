/*
# Add mode column and unique constraint to historical_wh_saved_plans

## Purpose
Enforce one saved plan per company/month/year/mode.
Adds the `mode` column (default 'historical_working_hours') and a unique index.

## Changes
- `historical_wh_saved_plans`: new column `mode text NOT NULL DEFAULT 'historical_working_hours'`
- Unique constraint: (company_id, month, year, mode) — one plan per company/month/year per flow mode

## Notes
1. Uses IF NOT EXISTS to be idempotent.
2. Unique index allows safe upsert semantics on conflict.
*/

ALTER TABLE historical_wh_saved_plans
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'historical_working_hours';

DROP INDEX IF EXISTS historical_wh_saved_plans_company_month_year_mode_key;
CREATE UNIQUE INDEX historical_wh_saved_plans_company_month_year_mode_key
  ON historical_wh_saved_plans(company_id, month, year, mode);
