/*
  # Create Werkstatt Checks System

  1. New Tables
    - `werkstatt_checks`
      - `id` (uuid, primary key)
      - `car_id` (uuid, foreign key to cars)
      - `week_number` (integer) - ISO week number
      - `year` (integer) - year of the check
      - `check_date` (date) - date of the check
      - `status` (text) - 'positive', 'negative', 'repaired'
      - `notes` (text) - general notes about the check
      - `repair_notes` (text, nullable) - notes about repair after fixing
      - `oil_status` (text, nullable) - notes about oil status
      - `created_by` (uuid, references auth.users)
      - `created_at` (timestamptz)
      - `updated_at` (timestamptz)
      - UNIQUE constraint on (car_id, week_number, year)

  2. Security
    - Enable RLS on `werkstatt_checks` table
    - Add policies for authenticated users to manage checks
    - Support role can access all checks
    - Regular users can only access their own checks

  3. Indexes
    - Index on (week_number, year) for fast weekly queries
    - Index on status for filtering
    - Index on car_id for car-specific queries
*/

CREATE TABLE IF NOT EXISTS werkstatt_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  car_id uuid NOT NULL REFERENCES cars(id) ON DELETE CASCADE,
  week_number integer NOT NULL CHECK (week_number >= 1 AND week_number <= 53),
  year integer NOT NULL CHECK (year >= 2020 AND year <= 2100),
  check_date date NOT NULL DEFAULT CURRENT_DATE,
  status text NOT NULL DEFAULT 'positive' CHECK (status IN ('positive', 'negative', 'repaired')),
  notes text NOT NULL DEFAULT '',
  repair_notes text,
  oil_status text,
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(car_id, week_number, year)
);

CREATE INDEX IF NOT EXISTS idx_werkstatt_checks_week_year ON werkstatt_checks(week_number, year);
CREATE INDEX IF NOT EXISTS idx_werkstatt_checks_status ON werkstatt_checks(status);
CREATE INDEX IF NOT EXISTS idx_werkstatt_checks_car_id ON werkstatt_checks(car_id);
CREATE INDEX IF NOT EXISTS idx_werkstatt_checks_created_by ON werkstatt_checks(created_by);

ALTER TABLE werkstatt_checks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own werkstatt checks"
  ON werkstatt_checks FOR SELECT
  TO authenticated
  USING (
    created_by = auth.uid() OR
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
      AND user_profiles.role = 'support'
    )
  );

CREATE POLICY "Users can insert own werkstatt checks"
  ON werkstatt_checks FOR INSERT
  TO authenticated
  WITH CHECK (created_by = auth.uid());

CREATE POLICY "Users can update own werkstatt checks"
  ON werkstatt_checks FOR UPDATE
  TO authenticated
  USING (
    created_by = auth.uid() OR
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
      AND user_profiles.role = 'support'
    )
  )
  WITH CHECK (
    created_by = auth.uid() OR
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
      AND user_profiles.role = 'support'
    )
  );

CREATE POLICY "Users can delete own werkstatt checks"
  ON werkstatt_checks FOR DELETE
  TO authenticated
  USING (
    created_by = auth.uid() OR
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
      AND user_profiles.role = 'support'
    )
  );

CREATE OR REPLACE FUNCTION update_werkstatt_checks_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'werkstatt_checks_updated_at'
  ) THEN
    CREATE TRIGGER werkstatt_checks_updated_at
      BEFORE UPDATE ON werkstatt_checks
      FOR EACH ROW
      EXECUTE FUNCTION update_werkstatt_checks_updated_at();
  END IF;
END $$;
