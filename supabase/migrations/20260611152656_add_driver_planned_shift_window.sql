ALTER TABLE drivers
  ADD COLUMN IF NOT EXISTS planned_shift_start_time text NULL,
  ADD COLUMN IF NOT EXISTS planned_shift_end_time   text NULL,
  ADD COLUMN IF NOT EXISTS planned_working_days     text[] NOT NULL DEFAULT ARRAY['mon','tue','wed','thu','fri']::text[],
  ADD COLUMN IF NOT EXISTS allow_outside_shift_exceptions boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN drivers.planned_shift_start_time IS 'Planned shift start (HH:MM). If both start and end are set, planner enforces this window. Supports cross-midnight (start > end).';
COMMENT ON COLUMN drivers.planned_shift_end_time IS 'Planned shift end (HH:MM). Cross-midnight when start > end.';
COMMENT ON COLUMN drivers.planned_working_days IS 'Weekdays the driver is normally available. Codes: mon,tue,wed,thu,fri,sat,sun.';
COMMENT ON COLUMN drivers.allow_outside_shift_exceptions IS 'If true, planner may propose work outside the shift window as exceptions requiring user acceptance.';