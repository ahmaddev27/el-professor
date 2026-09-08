/*
  # Add KM Stand to Werkstatt Checks

  1. Changes
    - Add `km_stand` column to `werkstatt_checks` table
      - Type: integer (odometer reading in kilometers)
      - Nullable: true (optional field)
      - Check constraint: value must be positive if provided

  2. Notes
    - This allows tracking the current kilometer reading of the car during weekly checks
    - The field is optional to maintain compatibility with existing checks
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'werkstatt_checks' AND column_name = 'km_stand'
  ) THEN
    ALTER TABLE werkstatt_checks
    ADD COLUMN km_stand integer CHECK (km_stand IS NULL OR km_stand >= 0);
  END IF;
END $$;
