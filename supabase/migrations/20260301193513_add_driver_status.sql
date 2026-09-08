/*
  # Add driver status field

  1. Changes
    - Add `status` column to `drivers` table (active/inactive)
    - Default to 'active' for new drivers
    - Set all existing drivers to 'active'

  2. Notes
    - Inactive drivers will be hidden from dropdowns and forms
    - Inactive drivers remain visible in driver management page
*/

-- Add status column with default 'active'
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'drivers' AND column_name = 'status'
  ) THEN
    ALTER TABLE drivers ADD COLUMN status text DEFAULT 'active' NOT NULL;
  END IF;
END $$;

-- Add check constraint to ensure status is either 'active' or 'inactive'
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'drivers_status_check'
  ) THEN
    ALTER TABLE drivers ADD CONSTRAINT drivers_status_check 
    CHECK (status IN ('active', 'inactive'));
  END IF;
END $$;

-- Update existing drivers to be active if they have NULL status
UPDATE drivers SET status = 'active' WHERE status IS NULL;