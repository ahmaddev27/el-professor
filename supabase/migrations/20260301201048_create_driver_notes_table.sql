/*
  # Create Driver Notes Table

  1. New Tables
    - `driver_notes`
      - `id` (uuid, primary key)
      - `created_by` (uuid, references auth.users)
      - `driver_id` (uuid, references drivers)
      - `note_date` (timestamptz) - Date/time of the note (editable)
      - `note_text` (text) - The note content
      - `created_at` (timestamptz) - Record creation timestamp
      - `updated_at` (timestamptz) - Record update timestamp

  2. Security
    - Enable RLS on `driver_notes` table
    - Add policies for authenticated users to manage notes for their own drivers
    - Support role can view and manage all notes
*/

-- Create driver_notes table
CREATE TABLE IF NOT EXISTS driver_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  driver_id uuid REFERENCES drivers(id) ON DELETE CASCADE NOT NULL,
  note_date timestamptz NOT NULL DEFAULT now(),
  note_text text NOT NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Enable RLS
ALTER TABLE driver_notes ENABLE ROW LEVEL SECURITY;

-- Create index for better query performance
CREATE INDEX IF NOT EXISTS idx_driver_notes_driver_id ON driver_notes(driver_id);
CREATE INDEX IF NOT EXISTS idx_driver_notes_created_by ON driver_notes(created_by);
CREATE INDEX IF NOT EXISTS idx_driver_notes_note_date ON driver_notes(note_date DESC);

-- Update trigger for updated_at
CREATE OR REPLACE FUNCTION update_driver_notes_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_driver_notes_updated_at
  BEFORE UPDATE ON driver_notes
  FOR EACH ROW
  EXECUTE FUNCTION update_driver_notes_updated_at();

-- RLS Policies

-- Users can view notes for their own drivers
CREATE POLICY "Users can view notes for own drivers"
  ON driver_notes FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM drivers
      WHERE drivers.id = driver_notes.driver_id
      AND drivers.created_by = auth.uid()::text
    )
  );

-- Users can insert notes for their own drivers
CREATE POLICY "Users can insert notes for own drivers"
  ON driver_notes FOR INSERT
  TO authenticated
  WITH CHECK (
    created_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM drivers
      WHERE drivers.id = driver_notes.driver_id
      AND drivers.created_by = auth.uid()::text
    )
  );

-- Users can update their own notes
CREATE POLICY "Users can update own notes"
  ON driver_notes FOR UPDATE
  TO authenticated
  USING (created_by = auth.uid())
  WITH CHECK (created_by = auth.uid());

-- Users can delete their own notes
CREATE POLICY "Users can delete own notes"
  ON driver_notes FOR DELETE
  TO authenticated
  USING (created_by = auth.uid());

-- Support role policies (full access)
CREATE POLICY "Support can view all notes"
  ON driver_notes FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
      AND user_profiles.role = 'support'
    )
  );

CREATE POLICY "Support can insert notes for any driver"
  ON driver_notes FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
      AND user_profiles.role = 'support'
    )
  );

CREATE POLICY "Support can update any note"
  ON driver_notes FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
      AND user_profiles.role = 'support'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
      AND user_profiles.role = 'support'
    )
  );

CREATE POLICY "Support can delete any note"
  ON driver_notes FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
      AND user_profiles.role = 'support'
    )
  );
