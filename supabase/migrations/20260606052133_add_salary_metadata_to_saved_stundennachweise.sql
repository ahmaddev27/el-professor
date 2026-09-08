ALTER TABLE saved_stundennachweise
  ADD COLUMN IF NOT EXISTS target_salary      numeric        NULL,
  ADD COLUMN IF NOT EXISTS hourly_rate        numeric        NULL,
  ADD COLUMN IF NOT EXISTS calculated_salary  numeric        NULL,
  ADD COLUMN IF NOT EXISTS generation_mode    text           NULL,
  ADD COLUMN IF NOT EXISTS grundlohn_ratio    numeric        NULL,
  ADD COLUMN IF NOT EXISTS totals_target_json jsonb          NULL,
  ADD COLUMN IF NOT EXISTS work_window_json   jsonb          NULL;
