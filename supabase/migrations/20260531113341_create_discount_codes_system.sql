/*
  # Create Discount Codes System

  ## Summary
  Full discount code system for subscription pricing with backend validation support.

  ## New Tables

  ### discount_codes
  Central table for all discount codes managed by SuperAdmins.
  - id: UUID primary key
  - code: unique, case-insensitive discount code string
  - description: optional human-readable description
  - discount_type: 'percentage' | 'fixed'
  - discount_value: numeric value (percent or EUR amount)
  - usage_mode: 'once' | 'monthly' — whether discount applies once or every billing period
  - audience_type: 'single' | 'multiple' — single company or many
  - max_redemptions: optional cap for multiple-audience codes
  - used_count: running redemption count
  - valid_from / valid_until: optional date window
  - active: boolean toggle
  - applies_to_plan: 'basic' | 'advanced' | 'premium' | 'all'
  - applies_to_billing_cycle: 'monthly' | 'yearly' | 'all'
  - min_cars / max_cars: optional fleet size constraints
  - assigned_company_id: optional — restricts single-audience code to specific company
  - created_by: UUID of SuperAdmin who created it

  ### discount_code_redemptions
  Audit log of every code application.
  - Links discount_code to company and user
  - Records pricing snapshot: original_price, discount_amount, final_price
  - usage_mode copied from code at time of redemption

  ## Company Columns (on companies table)
  - active_discount_code_id: FK to discount_codes
  - active_discount_usage_mode: 'once' | 'monthly'
  - active_discount_started_at: timestamp when code was applied

  ## Security
  - RLS enabled on both tables
  - SuperAdmins (is_super_admin=true) have full access
  - Authenticated users can only SELECT discount_codes (for validation)
  - Authenticated users can only INSERT redemptions (handled by edge function via service role)
*/

-- ── discount_codes ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS discount_codes (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                    text UNIQUE NOT NULL,
  description             text,
  discount_type           text NOT NULL CHECK (discount_type IN ('percentage', 'fixed')),
  discount_value          numeric NOT NULL CHECK (discount_value >= 0),
  usage_mode              text NOT NULL CHECK (usage_mode IN ('once', 'monthly')),
  audience_type           text NOT NULL CHECK (audience_type IN ('single', 'multiple')),
  max_redemptions         integer CHECK (max_redemptions IS NULL OR max_redemptions > 0),
  used_count              integer NOT NULL DEFAULT 0,
  valid_from              timestamptz,
  valid_until             timestamptz,
  active                  boolean NOT NULL DEFAULT true,
  applies_to_plan         text NOT NULL DEFAULT 'all' CHECK (applies_to_plan IN ('basic', 'advanced', 'premium', 'all')),
  applies_to_billing_cycle text NOT NULL DEFAULT 'all' CHECK (applies_to_billing_cycle IN ('monthly', 'yearly', 'all')),
  min_cars                integer CHECK (min_cars IS NULL OR min_cars >= 1),
  max_cars                integer CHECK (max_cars IS NULL OR max_cars >= 1),
  assigned_company_id     uuid REFERENCES companies(id) ON DELETE SET NULL,
  created_by              uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE discount_codes ENABLE ROW LEVEL SECURITY;

-- SuperAdmins can do everything
CREATE POLICY "SuperAdmins can manage discount codes"
  ON discount_codes FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
        AND user_profiles.is_super_admin = true
    )
  );

CREATE POLICY "SuperAdmins can insert discount codes"
  ON discount_codes FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
        AND user_profiles.is_super_admin = true
    )
  );

CREATE POLICY "SuperAdmins can update discount codes"
  ON discount_codes FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
        AND user_profiles.is_super_admin = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
        AND user_profiles.is_super_admin = true
    )
  );

CREATE POLICY "SuperAdmins can delete discount codes"
  ON discount_codes FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
        AND user_profiles.is_super_admin = true
    )
  );

-- Authenticated users can read active codes (needed for client-side UX, not security-critical since validation is in edge function)
CREATE POLICY "Authenticated users can view active discount codes"
  ON discount_codes FOR SELECT
  TO authenticated
  USING (active = true);

-- ── discount_code_redemptions ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS discount_code_redemptions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discount_code_id    uuid NOT NULL REFERENCES discount_codes(id) ON DELETE CASCADE,
  company_id          uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id             uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  plan                text NOT NULL,
  billing_cycle       text NOT NULL,
  car_limit           integer NOT NULL,
  original_price      numeric NOT NULL,
  discount_amount     numeric NOT NULL,
  final_price         numeric NOT NULL,
  usage_mode          text NOT NULL,
  redeemed_at         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE discount_code_redemptions ENABLE ROW LEVEL SECURITY;

-- SuperAdmins can see all redemptions
CREATE POLICY "SuperAdmins can view all redemptions"
  ON discount_code_redemptions FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
        AND user_profiles.is_super_admin = true
    )
  );

-- Company members can see their own redemptions
CREATE POLICY "Company members can view own redemptions"
  ON discount_code_redemptions FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.user_id = auth.uid()
        AND user_profiles.company_id = discount_code_redemptions.company_id
    )
  );

-- ── Add discount tracking columns to companies ────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'companies' AND column_name = 'active_discount_code_id'
  ) THEN
    ALTER TABLE companies ADD COLUMN active_discount_code_id uuid REFERENCES discount_codes(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'companies' AND column_name = 'active_discount_usage_mode'
  ) THEN
    ALTER TABLE companies ADD COLUMN active_discount_usage_mode text CHECK (active_discount_usage_mode IN ('once', 'monthly'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'companies' AND column_name = 'active_discount_started_at'
  ) THEN
    ALTER TABLE companies ADD COLUMN active_discount_started_at timestamptz;
  END IF;
END $$;

-- ── updated_at trigger ────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION update_discount_codes_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_discount_codes_updated_at ON discount_codes;
CREATE TRIGGER trg_discount_codes_updated_at
  BEFORE UPDATE ON discount_codes
  FOR EACH ROW EXECUTE FUNCTION update_discount_codes_updated_at();
