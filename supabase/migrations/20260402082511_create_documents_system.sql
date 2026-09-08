/*
  # Create comprehensive documents management system

  ## Overview
  This migration creates a complete document management and generation system
  to replace the simple "Drucken" module with a full-featured "Dokumente" system.

  ## New Tables

  ### 1. `documents`
  Main document table supporting uploaded files, templates, and generated documents.
  
  Fields:
  - `id` (uuid, primary key)
  - `title` (text) - Document title
  - `description` (text, nullable) - Document description
  - `category` (text) - Document category/type
  - `source_type` (text) - uploaded | template | generated
  - `status` (text) - draft | active | archived
  - `file_url` (text, nullable) - For uploaded files
  - `file_type` (text, nullable) - MIME type
  - `file_size` (bigint, nullable) - File size in bytes
  - `content` (jsonb, nullable) - For internal documents (blocks structure)
  - `include_header` (boolean) - Use header in output
  - `include_footer` (boolean) - Use footer in output
  - `include_signature` (boolean) - Use signature in output
  - `include_company_logo` (boolean) - Use company logo
  - `include_company_info` (boolean) - Use company info
  - `preview_image_url` (text, nullable) - Preview thumbnail
  - `is_pinned` (boolean) - Pinned/favorited
  - `parent_template_id` (uuid, nullable) - Reference to source template if generated
  - `created_by` (uuid) - User who created
  - `created_at` (timestamptz)
  - `updated_at` (timestamptz)

  ### 2. `document_variables`
  Dynamic variables/placeholders for templates and documents.
  
  Fields:
  - `id` (uuid, primary key)
  - `document_id` (uuid, foreign key)
  - `label` (text) - Display name
  - `key` (text) - Variable key (e.g., driver_name)
  - `variable_type` (text) - text | date | number | currency | boolean | email | phone
  - `source` (text) - manual | company | driver | payroll | vehicle | system
  - `required` (boolean) - Is required
  - `default_value` (text, nullable) - Default value
  - `value` (text, nullable) - Current value
  - `description` (text, nullable) - Help text
  - `order` (integer) - Display order
  - `created_at` (timestamptz)

  ### 3. `document_blocks`
  Content blocks for internal document builder.
  
  Fields:
  - `id` (uuid, primary key)
  - `document_id` (uuid, foreign key)
  - `block_type` (text) - title | paragraph | table | image | signature | etc.
  - `content` (jsonb) - Block content and settings
  - `order` (integer) - Display order
  - `created_at` (timestamptz)
  - `updated_at` (timestamptz)

  ### 4. `document_categories`
  Document categories for organization.
  
  Fields:
  - `id` (uuid, primary key)
  - `name` (text, unique) - Category name
  - `description` (text, nullable)
  - `icon` (text, nullable) - Icon name
  - `color` (text, nullable) - Color code
  - `order` (integer) - Display order
  - `created_at` (timestamptz)

  ## Security
  - Enable RLS on all tables
  - Authenticated users can view documents
  - Only creators or admins can edit/delete
  - Admin users have full access
*/

-- Create documents table
CREATE TABLE IF NOT EXISTS documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  description text,
  category text NOT NULL DEFAULT 'Allgemein',
  source_type text NOT NULL DEFAULT 'template' CHECK (source_type IN ('uploaded', 'template', 'generated')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'archived')),
  file_url text,
  file_type text,
  file_size bigint,
  content jsonb DEFAULT '[]'::jsonb,
  include_header boolean DEFAULT true,
  include_footer boolean DEFAULT true,
  include_signature boolean DEFAULT false,
  include_company_logo boolean DEFAULT true,
  include_company_info boolean DEFAULT true,
  preview_image_url text,
  is_pinned boolean DEFAULT false,
  parent_template_id uuid REFERENCES documents(id) ON DELETE SET NULL,
  created_by uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Create document_variables table
CREATE TABLE IF NOT EXISTS document_variables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid REFERENCES documents(id) ON DELETE CASCADE NOT NULL,
  label text NOT NULL,
  key text NOT NULL,
  variable_type text NOT NULL DEFAULT 'text' CHECK (variable_type IN ('text', 'multiline', 'date', 'number', 'currency', 'boolean', 'email', 'phone', 'signature')),
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'company', 'driver', 'payroll', 'vehicle', 'system')),
  required boolean DEFAULT false,
  default_value text,
  value text,
  description text,
  "order" integer DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  UNIQUE(document_id, key)
);

-- Create document_blocks table
CREATE TABLE IF NOT EXISTS document_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid REFERENCES documents(id) ON DELETE CASCADE NOT NULL,
  block_type text NOT NULL CHECK (block_type IN ('title', 'subtitle', 'paragraph', 'richtext', 'table', 'image', 'logo', 'spacer', 'divider', 'date_place', 'signature', 'header', 'footer')),
  content jsonb NOT NULL DEFAULT '{}'::jsonb,
  "order" integer DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Create document_categories table
CREATE TABLE IF NOT EXISTS document_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text UNIQUE NOT NULL,
  description text,
  icon text,
  color text,
  "order" integer DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_documents_created_by ON documents(created_by);
CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);
CREATE INDEX IF NOT EXISTS idx_documents_source_type ON documents(source_type);
CREATE INDEX IF NOT EXISTS idx_documents_category ON documents(category);
CREATE INDEX IF NOT EXISTS idx_documents_parent_template ON documents(parent_template_id);
CREATE INDEX IF NOT EXISTS idx_document_variables_document ON document_variables(document_id);
CREATE INDEX IF NOT EXISTS idx_document_blocks_document ON document_blocks(document_id);

-- Enable RLS
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_variables ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_categories ENABLE ROW LEVEL SECURITY;

-- RLS Policies for documents
CREATE POLICY "Users can view all documents"
  ON documents FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Users can insert own documents"
  ON documents FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = created_by);

CREATE POLICY "Users can update own documents"
  ON documents FOR UPDATE
  TO authenticated
  USING (
    auth.uid() = created_by OR
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

CREATE POLICY "Users can delete own documents"
  ON documents FOR DELETE
  TO authenticated
  USING (
    auth.uid() = created_by OR
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

-- RLS Policies for document_variables
CREATE POLICY "Users can view all document variables"
  ON document_variables FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Users can insert variables for own documents"
  ON document_variables FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM documents
      WHERE id = document_id AND created_by = auth.uid()
    )
  );

CREATE POLICY "Users can update variables for own documents"
  ON document_variables FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM documents
      WHERE id = document_id AND (created_by = auth.uid() OR EXISTS (
        SELECT 1 FROM user_profiles WHERE user_id = auth.uid() AND role = 'admin'
      ))
    )
  );

CREATE POLICY "Users can delete variables for own documents"
  ON document_variables FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM documents
      WHERE id = document_id AND (created_by = auth.uid() OR EXISTS (
        SELECT 1 FROM user_profiles WHERE user_id = auth.uid() AND role = 'admin'
      ))
    )
  );

-- RLS Policies for document_blocks
CREATE POLICY "Users can view all document blocks"
  ON document_blocks FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Users can insert blocks for own documents"
  ON document_blocks FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM documents
      WHERE id = document_id AND created_by = auth.uid()
    )
  );

CREATE POLICY "Users can update blocks for own documents"
  ON document_blocks FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM documents
      WHERE id = document_id AND (created_by = auth.uid() OR EXISTS (
        SELECT 1 FROM user_profiles WHERE user_id = auth.uid() AND role = 'admin'
      ))
    )
  );

CREATE POLICY "Users can delete blocks for own documents"
  ON document_blocks FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM documents
      WHERE id = document_id AND (created_by = auth.uid() OR EXISTS (
        SELECT 1 FROM user_profiles WHERE user_id = auth.uid() AND role = 'admin'
      ))
    )
  );

-- RLS Policies for document_categories
CREATE POLICY "Users can view all categories"
  ON document_categories FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Admins can insert categories"
  ON document_categories FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

CREATE POLICY "Admins can update categories"
  ON document_categories FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

CREATE POLICY "Admins can delete categories"
  ON document_categories FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

-- Insert default categories
INSERT INTO document_categories (name, description, icon, color, "order") VALUES
  ('Allgemein', 'Allgemeine Dokumente', 'file-text', '#64748b', 1),
  ('Vorlagen', 'Wiederverwendbare Vorlagen', 'layout-template', '#3b82f6', 2),
  ('Verträge', 'Verträge und Vereinbarungen', 'file-signature', '#8b5cf6', 3),
  ('Fahrer', 'Fahrerbezogene Dokumente', 'users', '#10b981', 4),
  ('Gehalt', 'Gehalts- und Lohndokumente', 'wallet', '#f59e0b', 5),
  ('Abrechnung', 'Abrechnungen', 'calculator', '#06b6d4', 6),
  ('Rechnung', 'Rechnungen', 'receipt', '#ef4444', 7),
  ('Bescheinigung', 'Bescheinigungen', 'award', '#14b8a6', 8),
  ('Intern', 'Interne Dokumente', 'building', '#6366f1', 9)
ON CONFLICT (name) DO NOTHING;

-- Create function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_documents_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create triggers
CREATE TRIGGER update_documents_timestamp
  BEFORE UPDATE ON documents
  FOR EACH ROW
  EXECUTE FUNCTION update_documents_updated_at();

CREATE TRIGGER update_document_blocks_timestamp
  BEFORE UPDATE ON document_blocks
  FOR EACH ROW
  EXECUTE FUNCTION update_documents_updated_at();
