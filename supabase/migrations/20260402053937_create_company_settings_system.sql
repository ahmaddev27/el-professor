/*
  # Create Company Settings System

  1. New Tables
    - `company_settings`
      - `id` (uuid, primary key)
      - Company identity fields (name, logo, etc)
      - Contact information fields
      - Address fields
      - Management/ownership fields
      - Business/legal data fields
      - Banking information fields
      - Branding/document defaults

  2. Security
    - Enable RLS on `company_settings` table
    - All authenticated users can read settings
    - Only admin users can modify settings
    
  3. Notes
    - Single source of truth for company information
    - Used across the entire application
*/

-- Create company_settings table
CREATE TABLE IF NOT EXISTS company_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name text NOT NULL DEFAULT 'Y&A Mobility',
  legal_company_name text,
  slogan text,
  email text,
  phone text,
  mobile text,
  website text,
  support_email text,
  street text,
  house_number text,
  postal_code text,
  city text,
  state text,
  country text DEFAULT 'Deutschland',
  manager_name text,
  owner_name text,
  authorized_representative text,
  vat_id text,
  tax_number text,
  commercial_register text,
  court_of_registration text,
  bank_name text,
  iban text,
  bic text,
  account_holder text,
  logo_url text,
  favicon_url text,
  stamp_url text,
  header_logo_url text,
  footer_logo_url text,
  signature_image_url text,
  primary_color text DEFAULT '#2563eb',
  secondary_color text DEFAULT '#64748b',
  default_signature_city text,
  default_footer_text text,
  default_email_signature text,
  default_print_header text,
  default_print_footer text,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Enable RLS
ALTER TABLE company_settings ENABLE ROW LEVEL SECURITY;

-- Policy: All authenticated users can read company settings
CREATE POLICY "Authenticated users can read company settings"
  ON company_settings
  FOR SELECT
  TO authenticated
  USING (true);

-- Policy: Admin users can insert company settings
CREATE POLICY "Admin users can insert company settings"
  ON company_settings
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
      AND user_profiles.role = 'admin'
    )
  );

-- Policy: Admin users can update company settings
CREATE POLICY "Admin users can update company settings"
  ON company_settings
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
      AND user_profiles.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
      AND user_profiles.role = 'admin'
    )
  );

-- Create updated_at trigger
CREATE OR REPLACE FUNCTION update_company_settings_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_company_settings_updated_at
  BEFORE UPDATE ON company_settings
  FOR EACH ROW
  EXECUTE FUNCTION update_company_settings_updated_at();

-- Insert default company settings if none exist
INSERT INTO company_settings (
  company_name,
  city,
  country,
  primary_color,
  secondary_color
) 
SELECT 
  'Y&A Mobility',
  'Solingen',
  'Deutschland',
  '#2563eb',
  '#64748b'
WHERE NOT EXISTS (SELECT 1 FROM company_settings);
