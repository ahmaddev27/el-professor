/*
  # Revert document archive metadata

  ## Summary
  Removes columns, index, and storage policies that were added solely to
  support the (now-removed) persistent generated-PDF archive feature.

  The product has decided to keep documents as on-demand generations from
  source data only. No PDFs are stored in Supabase Storage, and no archive
  rows are created for generated Trinkgeld / Stundennachweis exports.

  ## Changes
  1. Drops archive-only indexes:
     - `idx_documents_archive_unique`
     - `idx_documents_archive_lookup`
  2. Drops archive-only columns from `documents`:
     - `storage_path`
     - `file_name`
     - `year`
     - `month`
     - `document_type`
     - `driver_id`
  3. Removes the authenticated storage policies on the `documents` bucket
     that were introduced for archive uploads.

  ## Safety
  - Uses `IF EXISTS` everywhere.
  - Does NOT drop the `documents` table, unrelated columns, or the
    `documents` storage bucket itself (the bucket pre-existed and may still
    be used for manually uploaded documents unrelated to generated PDFs).
*/

-- 1. Drop archive-only indexes
DROP INDEX IF EXISTS idx_documents_archive_unique;
DROP INDEX IF EXISTS idx_documents_archive_lookup;

-- 2. Drop archive-only columns
ALTER TABLE documents DROP COLUMN IF EXISTS storage_path;
ALTER TABLE documents DROP COLUMN IF EXISTS file_name;
ALTER TABLE documents DROP COLUMN IF EXISTS year;
ALTER TABLE documents DROP COLUMN IF EXISTS month;
ALTER TABLE documents DROP COLUMN IF EXISTS document_type;
ALTER TABLE documents DROP COLUMN IF EXISTS driver_id;

-- 3. Drop archive-only storage policies
DROP POLICY IF EXISTS "Authenticated can read documents bucket"    ON storage.objects;
DROP POLICY IF EXISTS "Authenticated can upload to documents bucket" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated can update documents bucket"  ON storage.objects;
DROP POLICY IF EXISTS "Authenticated can delete from documents bucket" ON storage.objects;
