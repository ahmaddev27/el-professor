/*
  # Add trip_count to income table

  ## Summary
  Adds an optional `trip_count` column to the `income` table so that the number
  of trips can be recorded alongside each income entry.

  ## Changes

  ### income table
  - `trip_count` (integer, nullable) — number of trips associated with the entry.
    Optional. Must be non-negative when provided. Shared across all rows created
    from one batch-submit (Netto-Fahrpreis, Aktionen, Trinkgeld, Bargeld).

  ## Notes
  - Existing rows get NULL (no data loss)
  - Non-negative enforced by CHECK constraint
  - Not required for any existing features; purely additive
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'income' AND column_name = 'trip_count'
  ) THEN
    ALTER TABLE income ADD COLUMN trip_count integer NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'income_trip_count_non_negative'
  ) THEN
    ALTER TABLE income ADD CONSTRAINT income_trip_count_non_negative
      CHECK (trip_count IS NULL OR trip_count >= 0);
  END IF;
END $$;
