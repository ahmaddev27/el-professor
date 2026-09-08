/*
# Create Cash-Only Subscription Billing System

## Overview
Implements a complete cash-only subscription billing system for platform owner/superadmin
to manage company subscriptions, generate monthly invoices, and track cash payments.

## New Tables

### subscription_plans
- id (uuid, PK) - plan identifier
- name (text) - plan display name
- monthly_price (numeric) - monthly cost
- included_cars (integer) - number of cars included
- drivers_per_car_limit (integer, default 4) - drivers per car
- features_json (jsonb) - additional feature flags
- is_active (boolean, default true) - whether plan is available
- created_at, updated_at (timestamptz)

### company_subscriptions
- id (uuid, PK) - subscription identifier
- company_id (uuid, FK → companies) - owning company
- plan_id (uuid, FK → subscription_plans) - active plan
- status (text) - active/paused/canceled/overdue
- starts_at (date) - subscription start
- ends_at (date, nullable) - subscription end
- billing_day (integer, default 1) - day of month for billing
- monthly_price (numeric) - locked-in price
- payment_method (text, default 'cash')
- notes (text, nullable)
- created_at, updated_at (timestamptz)

### subscription_invoices
- id (uuid, PK) - invoice identifier
- company_id (uuid, FK → companies)
- subscription_id (uuid, FK → company_subscriptions)
- invoice_month (integer) - 1-12
- invoice_year (integer)
- invoice_number (text, unique) - sequential invoice number
- amount (numeric) - invoice amount
- status (text) - open/paid/overdue/canceled
- payment_method (text, default 'cash')
- due_date (date)
- paid_at (timestamptz, nullable)
- paid_by (uuid, nullable) - who confirmed payment
- collected_by (uuid, nullable) - who collected cash
- cash_received_amount (numeric, nullable)
- receipt_note (text, nullable)
- created_at, updated_at (timestamptz)
- UNIQUE(company_id, invoice_month, invoice_year) prevents duplicates

### subscription_payment_audit
- id (uuid, PK)
- invoice_id (uuid, FK → subscription_invoices)
- company_id (uuid, FK → companies)
- action (text) - what happened
- old_status, new_status (text, nullable)
- amount (numeric, nullable)
- changed_by (uuid) - who made the change
- note (text, nullable)
- created_at (timestamptz)

## Security (RLS)
- subscription_plans: readable by all authenticated, writable only by superadmin
- company_subscriptions: company users read own, superadmin reads/writes all
- subscription_invoices: company users read own, superadmin reads/writes all
- subscription_payment_audit: company users read own, superadmin reads all, insert only by superadmin
- No update/delete on audit table

## Functions
- generate_invoice_number() - creates sequential invoice numbers like INV-2026-0001
- updated_at trigger on all mutable tables
*/

-- ============================================================
-- 1. subscription_plans
-- ============================================================
CREATE TABLE IF NOT EXISTS subscription_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  monthly_price numeric NOT NULL CHECK (monthly_price >= 0),
  included_cars integer NOT NULL CHECK (included_cars > 0),
  drivers_per_car_limit integer NOT NULL DEFAULT 4 CHECK (drivers_per_car_limit BETWEEN 1 AND 10),
  features_json jsonb DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE subscription_plans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authenticated_read_plans" ON subscription_plans;
CREATE POLICY "authenticated_read_plans" ON subscription_plans FOR SELECT
  TO authenticated USING (true);

DROP POLICY IF EXISTS "superadmin_insert_plans" ON subscription_plans;
CREATE POLICY "superadmin_insert_plans" ON subscription_plans FOR INSERT
  TO authenticated WITH CHECK (is_user_super_admin());

DROP POLICY IF EXISTS "superadmin_update_plans" ON subscription_plans;
CREATE POLICY "superadmin_update_plans" ON subscription_plans FOR UPDATE
  TO authenticated USING (is_user_super_admin()) WITH CHECK (is_user_super_admin());

DROP POLICY IF EXISTS "superadmin_delete_plans" ON subscription_plans;
CREATE POLICY "superadmin_delete_plans" ON subscription_plans FOR DELETE
  TO authenticated USING (is_user_super_admin());

-- ============================================================
-- 2. company_subscriptions
-- ============================================================
CREATE TABLE IF NOT EXISTS company_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES subscription_plans(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'canceled', 'overdue')),
  starts_at date NOT NULL DEFAULT CURRENT_DATE,
  ends_at date,
  billing_day integer NOT NULL DEFAULT 1 CHECK (billing_day BETWEEN 1 AND 28),
  monthly_price numeric NOT NULL CHECK (monthly_price >= 0),
  payment_method text NOT NULL DEFAULT 'cash',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_company_subscriptions_company_id ON company_subscriptions(company_id);
CREATE INDEX IF NOT EXISTS idx_company_subscriptions_status ON company_subscriptions(status);

ALTER TABLE company_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users_read_own_subscription" ON company_subscriptions;
CREATE POLICY "users_read_own_subscription" ON company_subscriptions FOR SELECT
  TO authenticated USING (company_id = get_user_company_id() OR is_user_super_admin());

DROP POLICY IF EXISTS "superadmin_insert_subscription" ON company_subscriptions;
CREATE POLICY "superadmin_insert_subscription" ON company_subscriptions FOR INSERT
  TO authenticated WITH CHECK (is_user_super_admin());

DROP POLICY IF EXISTS "superadmin_update_subscription" ON company_subscriptions;
CREATE POLICY "superadmin_update_subscription" ON company_subscriptions FOR UPDATE
  TO authenticated USING (is_user_super_admin()) WITH CHECK (is_user_super_admin());

DROP POLICY IF EXISTS "superadmin_delete_subscription" ON company_subscriptions;
CREATE POLICY "superadmin_delete_subscription" ON company_subscriptions FOR DELETE
  TO authenticated USING (is_user_super_admin());

-- ============================================================
-- 3. subscription_invoices
-- ============================================================
CREATE TABLE IF NOT EXISTS subscription_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  subscription_id uuid NOT NULL REFERENCES company_subscriptions(id) ON DELETE CASCADE,
  invoice_month integer NOT NULL CHECK (invoice_month BETWEEN 1 AND 12),
  invoice_year integer NOT NULL CHECK (invoice_year >= 2020),
  invoice_number text UNIQUE NOT NULL,
  amount numeric NOT NULL CHECK (amount >= 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'overdue', 'canceled')),
  payment_method text NOT NULL DEFAULT 'cash',
  due_date date NOT NULL,
  paid_at timestamptz,
  paid_by uuid REFERENCES auth.users(id),
  collected_by uuid REFERENCES auth.users(id),
  cash_received_amount numeric,
  receipt_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id, invoice_month, invoice_year)
);

CREATE INDEX IF NOT EXISTS idx_subscription_invoices_company_id ON subscription_invoices(company_id);
CREATE INDEX IF NOT EXISTS idx_subscription_invoices_status ON subscription_invoices(status);
CREATE INDEX IF NOT EXISTS idx_subscription_invoices_month_year ON subscription_invoices(invoice_year, invoice_month);

ALTER TABLE subscription_invoices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users_read_own_invoices" ON subscription_invoices;
CREATE POLICY "users_read_own_invoices" ON subscription_invoices FOR SELECT
  TO authenticated USING (company_id = get_user_company_id() OR is_user_super_admin());

DROP POLICY IF EXISTS "superadmin_insert_invoices" ON subscription_invoices;
CREATE POLICY "superadmin_insert_invoices" ON subscription_invoices FOR INSERT
  TO authenticated WITH CHECK (is_user_super_admin());

DROP POLICY IF EXISTS "superadmin_update_invoices" ON subscription_invoices;
CREATE POLICY "superadmin_update_invoices" ON subscription_invoices FOR UPDATE
  TO authenticated USING (is_user_super_admin()) WITH CHECK (is_user_super_admin());

DROP POLICY IF EXISTS "superadmin_delete_invoices" ON subscription_invoices;
CREATE POLICY "superadmin_delete_invoices" ON subscription_invoices FOR DELETE
  TO authenticated USING (is_user_super_admin());

-- ============================================================
-- 4. subscription_payment_audit
-- ============================================================
CREATE TABLE IF NOT EXISTS subscription_payment_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES subscription_invoices(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  action text NOT NULL,
  old_status text,
  new_status text,
  amount numeric,
  changed_by uuid NOT NULL REFERENCES auth.users(id),
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subscription_payment_audit_invoice_id ON subscription_payment_audit(invoice_id);
CREATE INDEX IF NOT EXISTS idx_subscription_payment_audit_company_id ON subscription_payment_audit(company_id);

ALTER TABLE subscription_payment_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users_read_own_audit" ON subscription_payment_audit;
CREATE POLICY "users_read_own_audit" ON subscription_payment_audit FOR SELECT
  TO authenticated USING (company_id = get_user_company_id() OR is_user_super_admin());

DROP POLICY IF EXISTS "superadmin_insert_audit" ON subscription_payment_audit;
CREATE POLICY "superadmin_insert_audit" ON subscription_payment_audit FOR INSERT
  TO authenticated WITH CHECK (is_user_super_admin());

-- No UPDATE or DELETE on audit - immutable

-- ============================================================
-- 5. Invoice number generator
-- ============================================================
CREATE OR REPLACE FUNCTION generate_invoice_number(p_year integer)
RETURNS text
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_catalog'
AS $$
DECLARE
  next_seq integer;
  inv_number text;
BEGIN
  SELECT COALESCE(MAX(
    CAST(SPLIT_PART(invoice_number, '-', 3) AS integer)
  ), 0) + 1
  INTO next_seq
  FROM subscription_invoices
  WHERE invoice_year = p_year;

  inv_number := 'INV-' || p_year::text || '-' || LPAD(next_seq::text, 4, '0');
  RETURN inv_number;
END;
$$;

-- ============================================================
-- 6. updated_at triggers
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_updated_at_subscription_plans ON subscription_plans;
CREATE TRIGGER set_updated_at_subscription_plans
  BEFORE UPDATE ON subscription_plans
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_updated_at_company_subscriptions ON company_subscriptions;
CREATE TRIGGER set_updated_at_company_subscriptions
  BEFORE UPDATE ON company_subscriptions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS set_updated_at_subscription_invoices ON subscription_invoices;
CREATE TRIGGER set_updated_at_subscription_invoices
  BEFORE UPDATE ON subscription_invoices
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
