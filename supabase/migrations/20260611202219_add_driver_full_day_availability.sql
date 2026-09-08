ALTER TABLE drivers
  ADD COLUMN IF NOT EXISTS is_full_day_available boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN drivers.is_full_day_available IS 'If true, the driver is available 24h on all allowed weekdays. Planner bypasses the work-time-window check while still enforcing weekday, daily/monthly limits, overlap, vehicle-switch buffer and notes.';
