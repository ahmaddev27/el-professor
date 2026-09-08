/*
  # Document archive metadata

  ## Summary
  Extends the `documents` table so generated PDFs (Trinkgeld Quittung,
  Stundennachweis) can be archived persistently with proper tenant + driver
  + period context, and ensures the storage bucket + policies are in place.

  ## Changes
  1. Adds columns to `documents`:
     - `driver_id`       (uuid, nullable) — link to driver if applicable
     - `document_type`   (text, nullable) — 'trinkgeld' | 'stundennachweis' | ...
     - `month`           (int, nullable)  — 1..12
     - `year`            (int, nullable)  — e.g. 2026
     - `file_name`       (text, nullable) — clean deterministic PDF name
     - `storage_path`    (text, nullable) — object path inside `documents` bucket
  2. Adds a partial unique index so the same (company, type, driver, month,
     year) combination results in ONE archive row (regenerating overwrites
     rather than duplicating).
  3. Ensures the `documents` storage bucket exists and that authenticated
     users can read/write objects scoped to their company folder.

  ## Security
  - RLS on `documents` table remains in place.
  - Storage policies restrict access to authenticated users (listing + read
    + write + delete on the `documents` bucket).
*/

-- 1. Columns --------------------------------------------------------------

ALTER TABLE documents ADD COLUMN IF NOT EXISTS driver_id     uuid REFERENCES drivers(id) ON DELETE SET NULL;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS document_type text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS month         int;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS year          int;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS file_name     text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS storage_path  text;

CREATE INDEX IF NOT EXISTS idx_documents_archive_lookup
  ON documents (company_id, document_type, year, month);

-- 2. Deduplication: one archive row per (company, type, driver, month, year).
-- Partial index: only enforced when all key columns are present (archive rows).
CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_archive_unique
  ON documents (company_id, document_type, driver_id, year, month)
  WHERE document_type IS NOT NULL
    AND year  IS NOT NULL
    AND month IS NOT NULL;

-- 3. Storage bucket + policies ------------------------------------------

INSERT INTO storage.buckets (id, name, public)
VALUES ('documents', 'documents', true)
ON CONFLICT (id) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename  = 'objects'
      AND policyname = 'Authenticated can read documents bucket'
  ) THEN
    CREATE POLICY "Authenticated can read documents bucket"
      ON storage.objects FOR SELECT
      TO authenticated
      USING (bucket_id = 'documents');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename  = 'objects'
      AND policyname = 'Authenticated can upload to documents bucket'
  ) THEN
    CREATE POLICY "Authenticated can upload to documents bucket"
      ON storage.objects FOR INSERT
      TO authenticated
      WITH CHECK (bucket_id = 'documents');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename  = 'objects'
      AND policyname = 'Authenticated can update documents bucket'
  ) THEN
    CREATE POLICY "Authenticated can update documents bucket"
      ON storage.objects FOR UPDATE
      TO authenticated
      USING (bucket_id = 'documents')
      WITH CHECK (bucket_id = 'documents');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename  = 'objects'
      AND policyname = 'Authenticated can delete from documents bucket'
  ) THEN
    CREATE POLICY "Authenticated can delete from documents bucket"
      ON storage.objects FOR DELETE
      TO authenticated
      USING (bucket_id = 'documents');
  END IF;
END $$;
