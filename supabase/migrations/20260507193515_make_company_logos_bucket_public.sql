/*
  # Make company-logos storage bucket public

  ## Problem
  The company-logos bucket was set to private (public = false).
  The code calls getPublicUrl() which generates a URL pointing to the
  /storage/v1/object/public/ endpoint. This endpoint returns 403 for
  private buckets, causing broken images everywhere.

  ## Fix
  Set the bucket to public so that getPublicUrl() URLs are actually
  accessible. Logos are not sensitive data — they are meant to be
  displayed in UI, PDFs, and documents.

  ## Security note
  Path-based RLS policies (upload/update/delete) still enforce that
  each company can only write to their own {companyId}/ subfolder.
  Making the bucket public only affects reads — any authenticated or
  anonymous user can read logo images by URL, which is the intended
  behavior for a company logo.
*/

UPDATE storage.buckets
SET public = true
WHERE id = 'company-logos';

-- Drop the restrictive read policy (bucket is now public, no policy needed for SELECT)
DROP POLICY IF EXISTS "Company users can read own company logos" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can read company logos" ON storage.objects;

-- Ensure write policies are still company-scoped
DROP POLICY IF EXISTS "Company admins can upload own company logo" ON storage.objects;
DROP POLICY IF EXISTS "Company admins can update own company logo" ON storage.objects;
DROP POLICY IF EXISTS "Company admins can delete own company logo" ON storage.objects;

CREATE POLICY "Company admins can upload own company logo"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'company-logos'
    AND (storage.foldername(name))[1] = (
      SELECT company_id::text FROM user_profiles WHERE user_id = auth.uid() LIMIT 1
    )
    AND EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_id = auth.uid() AND role IN ('admin', 'super_admin')
    )
  );

CREATE POLICY "Company admins can update own company logo"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'company-logos'
    AND (storage.foldername(name))[1] = (
      SELECT company_id::text FROM user_profiles WHERE user_id = auth.uid() LIMIT 1
    )
    AND EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_id = auth.uid() AND role IN ('admin', 'super_admin')
    )
  )
  WITH CHECK (
    bucket_id = 'company-logos'
    AND (storage.foldername(name))[1] = (
      SELECT company_id::text FROM user_profiles WHERE user_id = auth.uid() LIMIT 1
    )
    AND EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_id = auth.uid() AND role IN ('admin', 'super_admin')
    )
  );

CREATE POLICY "Company admins can delete own company logo"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'company-logos'
    AND (storage.foldername(name))[1] = (
      SELECT company_id::text FROM user_profiles WHERE user_id = auth.uid() LIMIT 1
    )
    AND EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_id = auth.uid() AND role IN ('admin', 'super_admin')
    )
  );
