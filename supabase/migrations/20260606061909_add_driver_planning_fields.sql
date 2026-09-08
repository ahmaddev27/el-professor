ALTER TABLE drivers
  ADD COLUMN IF NOT EXISTS driver_usage_type    text      NOT NULL DEFAULT 'regular'  CHECK (driver_usage_type IN ('regular', 'coverage_only')),
  ADD COLUMN IF NOT EXISTS target_monthly_hours numeric   NULL,
  ADD COLUMN IF NOT EXISTS max_monthly_hours    numeric   NULL,
  ADD COLUMN IF NOT EXISTS planning_target_salary numeric NULL,
  ADD COLUMN IF NOT EXISTS planning_hourly_rate  numeric  NULL,
  ADD COLUMN IF NOT EXISTS planning_priority     integer  NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS planning_enabled      boolean  NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS allowed_weekdays      integer[] NULL,
  ADD COLUMN IF NOT EXISTS work_window_start     text     NULL,
  ADD COLUMN IF NOT EXISTS work_window_end       text     NULL;
