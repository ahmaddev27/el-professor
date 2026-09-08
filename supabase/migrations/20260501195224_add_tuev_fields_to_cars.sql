/*
  # Add TÜV / HU fields to cars table

  ## Summary
  Adds vehicle compliance date tracking to the cars table.

  ## New Columns
  - `tuev_gueltig_bis` (date, nullable) — TÜV / HU expiry date
  - `letzte_hu` (date, nullable) — Date of last HU (Hauptuntersuchung)

  ## Notes
  - Both columns are optional (nullable) so existing records are not affected
  - No RLS changes needed — existing car policies apply to these columns
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'cars' AND column_name = 'tuev_gueltig_bis'
  ) THEN
    ALTER TABLE cars ADD COLUMN tuev_gueltig_bis date;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'cars' AND column_name = 'letzte_hu'
  ) THEN
    ALTER TABLE cars ADD COLUMN letzte_hu date;
  END IF;
END $$;
