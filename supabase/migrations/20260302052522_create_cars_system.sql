/*
  # Create Cars Management System

  ## Overview
  This migration creates a comprehensive cars (vehicles) management system that tracks:
  - Vehicle information (Kennzeichen/license plate)
  - Driver assignments (1-2 drivers per vehicle)
  - Vehicle notes/status

  ## New Tables
  
  ### `cars`
  - `id` (uuid, primary key) - Unique identifier for each vehicle
  - `kennzeichen` (text, unique, not null) - License plate number (must be unique)
  - `created_by` (uuid, not null) - User who created the vehicle record
  - `created_at` (timestamptz) - When the record was created
  - `updated_at` (timestamptz) - When the record was last updated

  ### `car_driver_assignments`
  - `id` (uuid, primary key) - Unique identifier
  - `car_id` (uuid, not null) - Reference to cars table
  - `driver_id` (uuid, not null) - Reference to drivers table
  - `assigned_at` (timestamptz) - When the assignment was made
  - `created_by` (uuid, not null) - User who made the assignment
  - Constraint: Maximum 2 drivers per car enforced by trigger

  ## Security
  - RLS enabled on all tables
  - Users can view cars they created or if they're support
  - Users can manage driver assignments for their cars
  - Support users have full access to all cars

  ## Features
  1. Each car has a unique Kennzeichen (license plate)
  2. Cars can be assigned 1-2 drivers maximum
  3. Track who created each car record
  4. Ready for future "Werkstatt" (workshop) notes feature
*/

-- Create cars table
CREATE TABLE IF NOT EXISTS cars (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kennzeichen text UNIQUE NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Create car_driver_assignments table
CREATE TABLE IF NOT EXISTS car_driver_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  car_id uuid NOT NULL REFERENCES cars(id) ON DELETE CASCADE,
  driver_id uuid NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  assigned_at timestamptz DEFAULT now(),
  created_by uuid NOT NULL,
  UNIQUE(car_id, driver_id)
);

-- Enable RLS
ALTER TABLE cars ENABLE ROW LEVEL SECURITY;
ALTER TABLE car_driver_assignments ENABLE ROW LEVEL SECURITY;

-- RLS Policies for cars table

-- SELECT: Users can view their own cars or support can view all
CREATE POLICY "Users can view own cars or support views all"
  ON cars FOR SELECT
  TO authenticated
  USING (
    created_by = auth.uid() OR
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
      AND user_profiles.role = 'support'
    )
  );

-- INSERT: Authenticated users can create cars
CREATE POLICY "Users can create cars"
  ON cars FOR INSERT
  TO authenticated
  WITH CHECK (created_by = auth.uid());

-- UPDATE: Users can update their own cars or support can update all
CREATE POLICY "Users can update own cars or support updates all"
  ON cars FOR UPDATE
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

-- DELETE: Users can delete their own cars or support can delete all
CREATE POLICY "Users can delete own cars or support deletes all"
  ON cars FOR DELETE
  TO authenticated
  USING (
    created_by = auth.uid() OR
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
      AND user_profiles.role = 'support'
    )
  );

-- RLS Policies for car_driver_assignments table

-- SELECT: Users can view assignments for cars they created or support views all
CREATE POLICY "Users can view own car assignments or support views all"
  ON car_driver_assignments FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM cars
      WHERE cars.id = car_driver_assignments.car_id
      AND cars.created_by = auth.uid()
    ) OR
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
      AND user_profiles.role = 'support'
    )
  );

-- INSERT: Users can create assignments for their own cars
CREATE POLICY "Users can create assignments for own cars"
  ON car_driver_assignments FOR INSERT
  TO authenticated
  WITH CHECK (
    created_by = auth.uid() AND
    (
      EXISTS (
        SELECT 1 FROM cars
        WHERE cars.id = car_driver_assignments.car_id
        AND cars.created_by = auth.uid()
      ) OR
      EXISTS (
        SELECT 1 FROM user_profiles
        WHERE user_profiles.user_id = auth.uid()
        AND user_profiles.role = 'support'
      )
    )
  );

-- DELETE: Users can delete assignments for their own cars or support can delete all
CREATE POLICY "Users can delete own car assignments or support deletes all"
  ON car_driver_assignments FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM cars
      WHERE cars.id = car_driver_assignments.car_id
      AND cars.created_by = auth.uid()
    ) OR
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
      AND user_profiles.role = 'support'
    )
  );

-- Create function to enforce maximum 2 drivers per car
CREATE OR REPLACE FUNCTION check_max_drivers_per_car()
RETURNS TRIGGER AS $$
BEGIN
  IF (
    SELECT COUNT(*)
    FROM car_driver_assignments
    WHERE car_id = NEW.car_id
  ) >= 2 THEN
    RAISE EXCEPTION 'A car can have maximum 2 drivers assigned';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to enforce the constraint
DROP TRIGGER IF EXISTS enforce_max_drivers_per_car ON car_driver_assignments;
CREATE TRIGGER enforce_max_drivers_per_car
  BEFORE INSERT ON car_driver_assignments
  FOR EACH ROW
  EXECUTE FUNCTION check_max_drivers_per_car();

-- Create updated_at trigger for cars
CREATE OR REPLACE FUNCTION update_cars_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_cars_updated_at ON cars;
CREATE TRIGGER update_cars_updated_at
  BEFORE UPDATE ON cars
  FOR EACH ROW
  EXECUTE FUNCTION update_cars_updated_at();

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_cars_created_by ON cars(created_by);
CREATE INDEX IF NOT EXISTS idx_cars_kennzeichen ON cars(kennzeichen);
CREATE INDEX IF NOT EXISTS idx_car_driver_assignments_car_id ON car_driver_assignments(car_id);
CREATE INDEX IF NOT EXISTS idx_car_driver_assignments_driver_id ON car_driver_assignments(driver_id);
