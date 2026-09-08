-- Add storage_path column to fahrtenbuch_imports
ALTER TABLE fahrtenbuch_imports ADD COLUMN IF NOT EXISTS storage_path text;

-- Create storage bucket for original XLSX files
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'fahrtenbuch-files',
  'fahrtenbuch-files',
  false,
  52428800,  -- 50 MB
  ARRAY['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/octet-stream']
)
ON CONFLICT (id) DO NOTHING;

-- Storage policies: only authenticated users of the same company can access
CREATE POLICY "fahrtenbuch_files_select"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'fahrtenbuch-files'
    AND (storage.foldername(name))[1] IN (
      SELECT company_id::text FROM user_profiles WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "fahrtenbuch_files_insert"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'fahrtenbuch-files'
    AND (storage.foldername(name))[1] IN (
      SELECT company_id::text FROM user_profiles WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "fahrtenbuch_files_delete"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'fahrtenbuch-files'
    AND (storage.foldername(name))[1] IN (
      SELECT company_id::text FROM user_profiles WHERE user_id = auth.uid()
    )
  );
