/*
  # Harden storage policies on document-templates bucket

  ## Summary
  The previous policies on the `document-templates` bucket allowed any
  authenticated user to upload to the bucket with no ownership constraint,
  and allowed any authenticated user to read every object in the bucket.

  Change:
    - INSERT: must set owner = auth.uid() (Supabase sets this automatically)
              AND restrict to bucket 'document-templates'.
    - SELECT: restrict reads to the authenticated owner. This matches the
              DELETE/UPDATE policies that already use owner = auth.uid().

  Existing owner-based DELETE / UPDATE policies are kept as-is.

  ## Safety
  - Only affects the `document-templates` bucket.
  - `company-logos` policies untouched.
  - No data is modified.
*/

DROP POLICY IF EXISTS "Allow authenticated users to upload templates" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can access template files" ON storage.objects;

CREATE POLICY "Owner can upload templates"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'document-templates'
    AND owner = auth.uid()
  );

CREATE POLICY "Owner can read templates"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'document-templates'
    AND owner = auth.uid()
  );
