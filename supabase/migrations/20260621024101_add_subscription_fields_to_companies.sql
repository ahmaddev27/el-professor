-- ── Subscription fields on companies ─────────────────────────────────────────
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS subscription_status text NOT NULL DEFAULT 'inactive'
    CHECK (subscription_status IN ('inactive','active','expired','suspended')),
  ADD COLUMN IF NOT EXISTS subscription_started_at   timestamptz,
  ADD COLUMN IF NOT EXISTS subscription_expires_at   timestamptz,
  ADD COLUMN IF NOT EXISTS subscription_duration_type text,
  ADD COLUMN IF NOT EXISTS last_activation_code_id   uuid;

-- Backfill: all companies that currently exist get subscription_status = 'active'
-- so they are NOT locked out after this migration.
UPDATE companies SET subscription_status = 'active' WHERE subscription_status = 'inactive';

-- Indexes
CREATE INDEX IF NOT EXISTS idx_companies_subscription_status
  ON companies(subscription_status);
CREATE INDEX IF NOT EXISTS idx_companies_subscription_expires_at
  ON companies(subscription_expires_at);
