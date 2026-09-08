-- Add extra-hours permission flags to drivers (for salary-first extension)
ALTER TABLE drivers
  ADD COLUMN IF NOT EXISTS allow_extra_hours_before_first_ride boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS allow_extra_hours_after_last_ride   boolean NOT NULL DEFAULT true;

-- Add structured metadata columns to saved_stundennachweise
ALTER TABLE saved_stundennachweise
  ADD COLUMN IF NOT EXISTS coverage_summary_json    jsonb NULL,
  ADD COLUMN IF NOT EXISTS generation_settings_json jsonb NULL;
