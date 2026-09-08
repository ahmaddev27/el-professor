/*
  # Create Notification Settings System

  ## Summary
  Adds a dedicated table for per-company email notification preferences.
  Each row represents one notification type for one company, with an
  enabled/disabled flag. The table is pre-populated with sensible defaults
  when a company first saves their notification settings.

  ## New Tables

  ### `notification_settings`
  - `id` (uuid, primary key)
  - `company_id` (uuid, FK → companies) — one row per company per notification type
  - `notification_type` (text) — machine-readable key, e.g. 'tuev_bald_ablaufend'
  - `enabled` (boolean, default false) — whether this notification is active
  - `email_global_enabled` (boolean, default true) — master on/off for all email notifications of this company
  - `created_at`, `updated_at`

  ## Notification Types (v1)
  Company-level:
    - tuev_bald_ablaufend        — TÜV läuft bald ab (≤60 Tage)
    - tuev_abgelaufen            — TÜV bereits abgelaufen
    - trial_bald_ablaufend       — Trial läuft bald ab (≤7 Tage)
    - trial_abgelaufen           — Trial ist abgelaufen

  ## Security
  - RLS enabled
  - Authenticated users in the same company can SELECT
  - Only admins can INSERT / UPDATE
*/

CREATE TABLE IF NOT EXISTS notification_settings (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  notification_type     text NOT NULL,
  enabled               boolean NOT NULL DEFAULT false,
  email_global_enabled  boolean NOT NULL DEFAULT true,
  created_at            timestamptz DEFAULT now(),
  updated_at            timestamptz DEFAULT now(),
  UNIQUE (company_id, notification_type)
);

ALTER TABLE notification_settings ENABLE ROW LEVEL SECURITY;

-- Users in the same company can read notification settings
CREATE POLICY "Company members can read notification settings"
  ON notification_settings
  FOR SELECT
  TO authenticated
  USING (
    company_id IN (
      SELECT company_id FROM user_profiles
      WHERE user_id = auth.uid()
    )
  );

-- Only admins can insert notification settings for their own company
CREATE POLICY "Admins can insert notification settings"
  ON notification_settings
  FOR INSERT
  TO authenticated
  WITH CHECK (
    company_id IN (
      SELECT company_id FROM user_profiles
      WHERE user_id = auth.uid()
      AND role IN ('admin', 'support')
    )
  );

-- Only admins can update notification settings for their own company
CREATE POLICY "Admins can update notification settings"
  ON notification_settings
  FOR UPDATE
  TO authenticated
  USING (
    company_id IN (
      SELECT company_id FROM user_profiles
      WHERE user_id = auth.uid()
      AND role IN ('admin', 'support')
    )
  )
  WITH CHECK (
    company_id IN (
      SELECT company_id FROM user_profiles
      WHERE user_id = auth.uid()
      AND role IN ('admin', 'support')
    )
  );

-- Trigger to keep updated_at current
CREATE OR REPLACE FUNCTION update_notification_settings_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_notification_settings_updated_at
  BEFORE UPDATE ON notification_settings
  FOR EACH ROW
  EXECUTE FUNCTION update_notification_settings_updated_at();

-- Index for fast company lookups
CREATE INDEX IF NOT EXISTS idx_notification_settings_company_id
  ON notification_settings (company_id);
