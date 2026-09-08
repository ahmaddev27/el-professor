-- Create private storage bucket for Stundennachweis PDFs.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'stundennachweise-pdfs',
  'stundennachweise-pdfs',
  false,
  10485760,
  ARRAY['application/pdf']
)
ON CONFLICT (id) DO NOTHING;

-- Policies: users can manage files in their own company's folder.
-- Path format: {company_id}/{year}/{month}/{driver_id}.pdf

CREATE POLICY "stundennachweise_pdf_insert"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'stundennachweise-pdfs'
    AND (storage.foldername(name))[1] = (
      SELECT company_id::text FROM user_profiles WHERE user_id = auth.uid() LIMIT 1
    )
  );

CREATE POLICY "stundennachweise_pdf_update"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'stundennachweise-pdfs'
    AND (storage.foldername(name))[1] = (
      SELECT company_id::text FROM user_profiles WHERE user_id = auth.uid() LIMIT 1
    )
  );

CREATE POLICY "stundennachweise_pdf_select"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'stundennachweise-pdfs'
    AND (storage.foldername(name))[1] = (
      SELECT company_id::text FROM user_profiles WHERE user_id = auth.uid() LIMIT 1
    )
  );

CREATE POLICY "stundennachweise_pdf_delete"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'stundennachweise-pdfs'
    AND (storage.foldername(name))[1] = (
      SELECT company_id::text FROM user_profiles WHERE user_id = auth.uid() LIMIT 1
    )
  );
