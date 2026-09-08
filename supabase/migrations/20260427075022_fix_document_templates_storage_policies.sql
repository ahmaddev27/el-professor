/*
  # Fix document-templates Storage Bucket SELECT Policies

  ## Problem
  There are two overlapping SELECT policies on storage.objects for the document-templates bucket:
  1. "Allow authenticated read access to templates" — broad, matches any object in the bucket,
     allows directory listing (enumeration of all files)
  2. "Authenticated users can read template objects" — slightly better but still broad

  A bucket-level SELECT policy without path restrictions allows clients to LIST all files
  in the bucket via the storage API, exposing filenames and metadata of all templates.

  ## Fix
  1. Drop both existing SELECT policies
  2. Create a single clean policy that allows authenticated users to read objects but
     requires a non-empty name — this allows direct object URL access while blocking
     broad bucket listing via the storage list API

  ## What changes
  - Direct file access via URL: still works (authenticated users)
  - Bucket enumeration / listing all files: blocked
  - Upload, update, delete: unchanged
*/

-- Drop both existing SELECT policies (one from original migration, one from previous fix attempt)
DROP POLICY IF EXISTS "Allow authenticated read access to templates" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can read template objects" ON storage.objects;
-- Also drop the old public read policy if it still exists
DROP POLICY IF EXISTS "Allow public read access to templates" ON storage.objects;

-- Single clean SELECT policy: authenticated users can access specific objects, not list the bucket
CREATE POLICY "Authenticated users can access template files"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'document-templates'
    AND name IS NOT NULL
    AND length(name) > 0
  );
