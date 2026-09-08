-- Add canceled-trip support to fahrtenbuch_trips.
-- • source_status  – stores the raw Fahrtstatus value from the imported file
-- • is_canceled    – true when the trip was canceled/storniert in the source
-- • Allow NULL for start_time, end_time, duration_minutes on canceled rows only.
-- • Extend plausibility_status CHECK to include 'canceled'.
-- • Add is_canceled / source_status to the list of immutable fields
--   (they are set at import time and must not change).

-- 1. Add new columns
ALTER TABLE fahrtenbuch_trips
  ADD COLUMN IF NOT EXISTS source_status text,
  ADD COLUMN IF NOT EXISTS is_canceled   boolean NOT NULL DEFAULT false;

-- 2. Relax NOT NULL constraints so canceled rows may omit time fields
ALTER TABLE fahrtenbuch_trips
  ALTER COLUMN start_time       DROP NOT NULL,
  ALTER COLUMN end_time         DROP NOT NULL,
  ALTER COLUMN duration_minutes DROP NOT NULL;

-- 3. Replace the plausibility_status CHECK to allow 'canceled'
ALTER TABLE fahrtenbuch_trips
  DROP CONSTRAINT IF EXISTS fahrtenbuch_trips_plausibility_status_check;

ALTER TABLE fahrtenbuch_trips
  ADD CONSTRAINT fahrtenbuch_trips_plausibility_status_check
  CHECK (plausibility_status IN ('pending','ok','uncovered','overlap','canceled'));

-- 4. Extend the immutability trigger to also protect the new fields
CREATE OR REPLACE FUNCTION protect_fahrtenbuch_immutable_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (
    OLD.trip_date            IS DISTINCT FROM NEW.trip_date            OR
    OLD.start_time           IS DISTINCT FROM NEW.start_time           OR
    OLD.end_time             IS DISTINCT FROM NEW.end_time             OR
    OLD.duration_minutes     IS DISTINCT FROM NEW.duration_minutes     OR
    OLD.car_id               IS DISTINCT FROM NEW.car_id               OR
    OLD.car_identifier       IS DISTINCT FROM NEW.car_identifier       OR
    OLD.route_start          IS DISTINCT FROM NEW.route_start          OR
    OLD.route_end            IS DISTINCT FROM NEW.route_end            OR
    OLD.description          IS DISTINCT FROM NEW.description          OR
    OLD.price_amount         IS DISTINCT FROM NEW.price_amount         OR
    OLD.cash_amount          IS DISTINCT FROM NEW.cash_amount          OR
    OLD.online_amount        IS DISTINCT FROM NEW.online_amount        OR
    OLD.tip_amount           IS DISTINCT FROM NEW.tip_amount           OR
    OLD.action_amount        IS DISTINCT FROM NEW.action_amount        OR
    OLD.raw_data_json        IS DISTINCT FROM NEW.raw_data_json        OR
    OLD.original_driver_id   IS DISTINCT FROM NEW.original_driver_id   OR
    OLD.original_driver_name IS DISTINCT FROM NEW.original_driver_name OR
    OLD.import_id            IS DISTINCT FROM NEW.import_id            OR
    OLD.company_id           IS DISTINCT FROM NEW.company_id           OR
    OLD.source_status        IS DISTINCT FROM NEW.source_status        OR
    OLD.is_canceled          IS DISTINCT FROM NEW.is_canceled
  ) THEN
    RAISE EXCEPTION
      'fahrtenbuch_trips: immutable fields cannot be modified after insert.';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- Index for quick canceled filtering
CREATE INDEX IF NOT EXISTS idx_fahrtenbuch_trips_canceled
  ON fahrtenbuch_trips (company_id, is_canceled);
