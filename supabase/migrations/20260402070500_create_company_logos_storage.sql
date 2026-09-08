/*
  # Create Company Logos Storage Bucket

  1. Storage
    - Create `company-logos` storage bucket
    - Make bucket private (only accessible with proper authentication)

  2. Security
    - Authenticated users can read logos
    - Only admin users can upload/update/delete logos

  3. Notes
    - Supports common image formats (jpg, png, svg, webp)
    - Logos are stored with unique names to prevent conflicts
*/

-- Create storage bucket for company logos
INSERT INTO storage.buckets (id, name, public)
VALUES ('company-logos', 'company-logos', false)
ON CONFLICT (id) DO NOTHING;

-- Policy: Authenticated users can read logos
CREATE POLICY "Authenticated users can read company logos"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (bucket_id = 'company-logos');

-- Policy: Admin users can upload logos
CREATE POLICY "Admin users can upload company logos"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'company-logos'
    AND EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
      AND user_profiles.role = 'admin'
    )
  );

-- Policy: Admin users can update logos
CREATE POLICY "Admin users can update company logos"
  ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'company-logos'
    AND EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
      AND user_profiles.role = 'admin'
    )
  )
  WITH CHECK (
    bucket_id = 'company-logos'
    AND EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
      AND user_profiles.role = 'admin'
    )
  );

-- Policy: Admin users can delete logos
CREATE POLICY "Admin users can delete company logos"
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'company-logos'
    AND EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
      AND user_profiles.role = 'admin'
    )
  );