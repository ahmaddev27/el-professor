/*
  # Add Postal Code and City to Receipts

  1. Changes
    - Add `postal_code` column to receipts table (5-digit German postal code)
    - Add `city` column to receipts table (auto-detected from postal code)

  2. Notes
    - Postal code is a text field to preserve leading zeros
    - City is automatically filled based on the postal code entered
*/

-- Add postal_code and city columns to receipts table
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS postal_code text;
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS city text;
