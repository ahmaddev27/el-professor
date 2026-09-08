/*
  # Add trial fields to companies + public signup support

  ## Summary
  Adds trial lifecycle fields to the companies table so new companies that
  self-register via the public signup flow get a 14-day free trial period
  tracked properly.

  ## Changes

  ### companies table
  - `trial_start` (timestamptz, nullable) — when the trial started
  - `trial_end`   (timestamptz, nullable) — when the trial expires (trial_start + 14 days)

  Both columns are NULL for companies that are not in or were not in a trial.

  ## Notes
  - Existing rows are left with NULL (they are already active, not in trial)
  - The signup edge function sets status = 'trial', trial_start = now(),
    trial_end = now() + 14 days when creating a new company
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'companies' AND column_name = 'trial_start'
  ) THEN
    ALTER TABLE companies ADD COLUMN trial_start timestamptz DEFAULT NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'companies' AND column_name = 'trial_end'
  ) THEN
    ALTER TABLE companies ADD COLUMN trial_end timestamptz DEFAULT NULL;
  END IF;
END $$;
