
ALTER TABLE driver_notes
  ADD COLUMN IF NOT EXISTS start_date date,
  ADD COLUMN IF NOT EXISTS end_date date;

-- Backfill from existing note_date
UPDATE driver_notes
SET
  start_date = note_date::date,
  end_date   = note_date::date
WHERE start_date IS NULL;
