/*
  # Company lifecycle columns

  ## Summary
  Adds two nullable timestamp columns to the companies table to support the full
  super-admin lifecycle management: archive and soft-delete.

  ## New columns

  ### companies.archived_at (timestamptz, nullable)
  - NULL  → company is not archived
  - set   → company has been archived at that timestamp
  - The status column is also set to 'archived' when this is written so that
    existing status-based queries continue to work correctly.

  ### companies.deleted_at (timestamptz, nullable)
  - NULL  → company is not soft-deleted
  - set   → company has been soft-deleted at that timestamp
  - The status column is also set to 'deleted' when this is written.
  - Hard (permanent) deletion is a second deliberate step performed by the super
    admin only after a 30-day review window. Until then the row is recoverable.

  ## Notes
  - No existing rows are modified.
  - The change is fully additive and backwards-compatible.
  - RLS policies are unchanged; super-admin operations bypass RLS via the
    service-role key used in edge functions.
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'companies' AND column_name = 'archived_at'
  ) THEN
    ALTER TABLE companies ADD COLUMN archived_at timestamptz DEFAULT NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'companies' AND column_name = 'deleted_at'
  ) THEN
    ALTER TABLE companies ADD COLUMN deleted_at timestamptz DEFAULT NULL;
  END IF;
END $$;
