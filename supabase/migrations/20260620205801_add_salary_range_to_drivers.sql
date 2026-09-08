-- Add salary range columns to drivers table
-- planning_target_salary remains for backward compatibility (acts as legacy fallback)
-- New: planning_min_salary and planning_max_salary define the allowed salary band

ALTER TABLE drivers
  ADD COLUMN IF NOT EXISTS planning_min_salary numeric(10,2) NULL,
  ADD COLUMN IF NOT EXISTS planning_max_salary numeric(10,2) NULL;

-- Backfill: if driver already has planning_target_salary, initialize both min and max from it
UPDATE drivers
SET
  planning_min_salary = planning_target_salary,
  planning_max_salary = planning_target_salary
WHERE
  planning_target_salary IS NOT NULL
  AND planning_min_salary IS NULL
  AND planning_max_salary IS NULL;
