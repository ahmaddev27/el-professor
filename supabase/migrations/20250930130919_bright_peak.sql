/*
  # Add created_by column to receipts table

  1. Changes
    - Add `created_by` column to `receipts` table to track who created each receipt
    - This enables role-based permissions for edit/delete operations
    - Only the creator or admin (support@yamobility.de) can edit/delete receipts

  2. Security
    - All users can view and add receipts
    - Only creator or admin can edit/delete receipts
*/

-- Add created_by column to track receipt creator
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'receipts' AND column_name = 'created_by'
  ) THEN
    ALTER TABLE receipts ADD COLUMN created_by text;
  END IF;
END $$;

-- Add index for better performance on created_by queries
CREATE INDEX IF NOT EXISTS idx_receipts_created_by ON receipts(created_by);