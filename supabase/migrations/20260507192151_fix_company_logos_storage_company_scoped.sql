/*
  # Fix company-logos storage: company-scoped paths and RLS policies

  ## Problem
  The existing storage RLS policies for company-logos only check `role = 'admin'`
  but do not enforce that a company can only access its own logo path.
  The storage path was also flat (no company_id subfolder), meaning companies
  could overwrite each other's logos.

  ## Changes
  1. Drop all existing company-logos storage policies
  2. Add new policies that enforce path-based company isolation:
     - Upload path must start with the company's own company_id
     - Read/delete/update restricted to own company path or super admin
  3. Path format enforced: {companyId}/logo.{ext}
*/

-- Drop old flat policies
DROP POLICY IF EXISTS "Admin users can upload company logos" ON storage.objects;
DROP POLICY IF EXISTS "Admin users can update company logos" ON storage.objects;
DROP POLICY IF EXISTS "Admin users can delete company logos" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can read company logos" ON storage.objects;

-- SELECT: company users can only read their own company's logos
CREATE POLICY "Company users can read own company logos"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'company-logos'
    AND (
      -- path starts with own company_id/
      (storage.foldername(name))[1] = (
        SELECT company_id::text FROM user_profiles WHERE user_id = auth.uid() LIMIT 1
      )
      OR
      -- super admin can read any
      EXISTS (
        SELECT 1 FROM user_profiles
        WHERE user_id = auth.uid() AND role = 'super_admin'
      )
    )
  );

-- INSERT: company admins can only upload into their own company_id subfolder
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

-- UPDATE: company admins can only update their own company's logo
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

-- DELETE: company admins can only delete their own company's logo
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
