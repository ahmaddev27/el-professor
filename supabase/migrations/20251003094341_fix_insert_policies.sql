/*
  # Fix INSERT policies to allow authenticated users

  1. Changes
    - Update INSERT policies for drivers and receipts
    - Allow any authenticated user to INSERT
    - The user_id will be set by the application, not enforced by RLS
    
  2. Security
    - Still maintains view/edit/delete restrictions
    - Only authenticated users can insert
*/

-- Fix drivers INSERT policy
DROP POLICY IF EXISTS "Drivers can insert own" ON drivers;

CREATE POLICY "Drivers can insert"
  ON drivers
  FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- Fix receipts INSERT policy
DROP POLICY IF EXISTS "Receipts can insert own" ON receipts;

CREATE POLICY "Receipts can insert"
  ON receipts
  FOR INSERT
  TO authenticated
  WITH CHECK (true);
