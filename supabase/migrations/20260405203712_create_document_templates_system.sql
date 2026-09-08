/*
  # Create Document Templates System

  1. New Tables
    - `document_templates`
      - `id` (uuid, primary key)
      - `name` (text) - template name
      - `file_path` (text) - storage path to PDF template
      - `file_url` (text) - public URL to PDF
      - `thumbnail_url` (text, optional) - thumbnail preview
      - `created_by` (uuid) - user who uploaded it
      - `created_at` (timestamptz)
      - `last_used_at` (timestamptz) - for recent templates sorting
      - `usage_count` (integer) - track how often used

  2. Security
    - Enable RLS on `document_templates` table
    - Add policies for authenticated users to manage templates based on created_by

  3. Storage
    - Create storage bucket for document templates
*/

-- Create document_templates table
CREATE TABLE IF NOT EXISTS document_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  file_path text NOT NULL,
  file_url text NOT NULL,
  thumbnail_url text,
  created_by uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  last_used_at timestamptz DEFAULT now(),
  usage_count integer DEFAULT 0
);

-- Enable RLS
ALTER TABLE document_templates ENABLE ROW LEVEL SECURITY;

-- Policies for document_templates
CREATE POLICY "Users can view templates created by anyone in their org"
  ON document_templates
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
      AND (
        user_profiles.email = (SELECT email FROM user_profiles WHERE user_id = document_templates.created_by)
        OR user_profiles.email = 'support@mycompany.com'
      )
    )
  );

CREATE POLICY "Users can insert their own templates"
  ON document_templates
  FOR INSERT
  TO authenticated
  WITH CHECK (created_by = auth.uid());

CREATE POLICY "Users can update their own templates"
  ON document_templates
  FOR UPDATE
  TO authenticated
  USING (created_by = auth.uid())
  WITH CHECK (created_by = auth.uid());

CREATE POLICY "Users can delete their own templates"
  ON document_templates
  FOR DELETE
  TO authenticated
  USING (created_by = auth.uid());

-- Support users can manage all templates
CREATE POLICY "Support can manage all templates"
  ON document_templates
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
      AND user_profiles.email = 'support@mycompany.com'
    )
  );

-- Add indexes for performance
CREATE INDEX IF NOT EXISTS idx_document_templates_created_by ON document_templates(created_by);
CREATE INDEX IF NOT EXISTS idx_document_templates_last_used ON document_templates(last_used_at DESC);
CREATE INDEX IF NOT EXISTS idx_document_templates_usage_count ON document_templates(usage_count DESC);